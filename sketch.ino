#include <WiFi.h>
#include <PubSubClient.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include <DHT.h>
#include <Preferences.h>

// ==========================================
// Wi-Fi Credentials
// ==========================================
const char* ssid = "Wokwi-GUEST";
const char* password = "";

// ==========================================
// MQTT Broker Settings
// ==========================================
const char* mqtt_server = "broker.hivemq.com";
const int mqtt_port = 1883;
const char* baseTopic = "myhome123";

// MQTT Topics
char topicRelay1[64];
char topicRelay2[64];
char topicTemp[64];
char topicHumidity[64];
char topicGas[64];
char topicAlert[64];
char topicKill[64];
char topicCondition[64];
char topicCfgTemp[64];
char topicCfgGas[64];
char topicCfgHyst[64];

// Pins
const int RELAY_1 = 26;
const int RELAY_2 = 27;
const int DHT_PIN = 4;
const int MQ135_PIN = 34;
const int BOOT_BUTTON = 0; // ESP32 built-in BOOT button

#define DHT_TYPE DHT11
DHT dht(DHT_PIN, DHT_TYPE);

#define RELAY_ON  LOW
#define RELAY_OFF HIGH

// Operational States
bool relay1State = false;
bool relay2State = false;
bool killSwitchActive = false;
bool gasHazard = false;

// Manual Override Cooldown Timers (prevents automation from immediately undoing user clicks)
unsigned long lastManualOverride1 = 0;
unsigned long lastManualOverride2 = 0;
const unsigned long MANUAL_OVERRIDE_HOLD = 15000; // 15 seconds manual priority

// Active Condition Selection:
// 1 = Run Temperature Condition Only (Relay 1 Fan)
// 2 = Run Gas Hazard Condition Only (Relay 2 Exhaust)
// 3 = Run Both Conditions
// 0 = Disabled (Manual control only)
int activeCondition = 3;

// Sensor Values
float temperature = 0.0;
float humidity = 0.0;
int gasRaw = 0;

// Configurable Thresholds (Persisted in Flash)
float tempThresholdOn = 29.0;
float tempHysteresis  = 1.0;  // Turns off at (tempThresholdOn - tempHysteresis)
int   gasHazardLimit   = 1800;
const int GAS_HYSTERESIS = 150; // Prevents relay chatter at gas boundary

unsigned long lastSensorPublish = 0;
const unsigned long SENSOR_INTERVAL = 2000;

WiFiClient espClient;
PubSubClient mqttClient(espClient);
LiquidCrystal_I2C lcd(0x27, 16, 2);
Preferences prefs;

void loadConfig() {
  prefs.begin("smarthome", false);
  tempThresholdOn = prefs.getFloat("tempThresh", 29.0);
  tempHysteresis  = prefs.getFloat("tempHyst", 1.0);
  gasHazardLimit  = prefs.getInt("gasThresh", 1800);
  activeCondition = prefs.getInt("activeCond", 3);
  prefs.end();
  Serial.printf("[Config] Loaded: Temp=%.1f C, Hyst=%.1f C, Gas=%d, Condition=%d\n", 
                tempThresholdOn, tempHysteresis, gasHazardLimit, activeCondition);
}

void saveConfig() {
  prefs.begin("smarthome", false);
  prefs.putFloat("tempThresh", tempThresholdOn);
  prefs.putFloat("tempHyst", tempHysteresis);
  prefs.putInt("gasThresh", gasHazardLimit);
  prefs.putInt("activeCond", activeCondition);
  prefs.end();
  Serial.println("[Config] Settings saved to Non-Volatile Flash.");
}

// setRelay with loop-prevention: publishMqtt is FALSE when triggered by an incoming MQTT command
void setRelay(int relayNum, bool state, bool publishMqtt = true) {
  if (killSwitchActive) return;

  if (relayNum == 1) {
    if (relay1State != state) {
      relay1State = state;
      digitalWrite(RELAY_1, relay1State ? RELAY_ON : RELAY_OFF);
      if (publishMqtt && mqttClient.connected()) {
        mqttClient.publish(topicRelay1, relay1State ? "1" : "0", true);
      }
    }
  } else if (relayNum == 2) {
    if (relay2State != state) {
      relay2State = state;
      digitalWrite(RELAY_2, relay2State ? RELAY_ON : RELAY_OFF);
      if (publishMqtt && mqttClient.connected()) {
        mqttClient.publish(topicRelay2, relay2State ? "1" : "0", true);
      }
    }
  }
}

void triggerKillSwitch(bool activate) {
  killSwitchActive = activate;
  if (killSwitchActive) {
    relay1State = false;
    relay2State = false;
    digitalWrite(RELAY_1, RELAY_OFF);
    digitalWrite(RELAY_2, RELAY_OFF);
    mqttClient.publish(topicRelay1, "0", true);
    mqttClient.publish(topicRelay2, "0", true);
    mqttClient.publish(topicAlert, "EMERGENCY: Kill Switch Activated!");
    mqttClient.publish(topicKill, "1", true);
  } else {
    mqttClient.publish(topicAlert, "System Normalized: Kill Switch Reset.");
    mqttClient.publish(topicKill, "0", true);
  }
}

// Flicker-free LCD Update (Overwrites exact 16 chars without lcd.clear())
void updateLcd() {
  char line1[17];
  char line2[17];

  if (killSwitchActive) {
    snprintf(line1, sizeof(line1), "** KILL SWITCH *");
    snprintf(line2, sizeof(line2), "ALL POWER CUT   ");
  } else if (gasHazard) {
    snprintf(line1, sizeof(line1), "! GAS HAZARD !  ");
    snprintf(line2, sizeof(line2), "G:%-4d >%-4d    ", gasRaw, gasHazardLimit);
  } else {
    const char* condStr = (activeCondition == 1) ? "[TEMP]" : 
                          (activeCondition == 2) ? "[GAS ]" : 
                          (activeCondition == 3) ? "[BOTH]" : "[OFF ]";
    snprintf(line1, sizeof(line1), "R1:%s R2:%s %s", 
             relay1State ? "ON " : "OFF", 
             relay2State ? "ON " : "OFF", 
             condStr);

    snprintf(line2, sizeof(line2), "T:%d/%dC G:%-4d ", 
             (int)temperature, (int)tempThresholdOn, gasRaw);
  }

  lcd.setCursor(0, 0);
  lcd.print(line1);
  lcd.setCursor(0, 1);
  lcd.print(line2);
}

// Executes ONLY the configured condition with hysteresis & manual cooldown protection
void processAutomationRules() {
  if (killSwitchActive || activeCondition == 0) return;

  unsigned long now = millis();

  // Condition 1: Temperature Trigger (Relay 1 Fan)
  if ((activeCondition == 1 || activeCondition == 3) && (now - lastManualOverride1 >= MANUAL_OVERRIDE_HOLD)) {
    float offThreshold = tempThresholdOn - tempHysteresis;
    
    // Only evaluate if sensor reading is valid
    if (temperature > 0.0) {
      if (temperature >= tempThresholdOn && !relay1State) {
        setRelay(1, true, true);
        char buf[64];
        snprintf(buf, sizeof(buf), "Auto: Fan ON (Temp %.1f >= %.1fC)", temperature, tempThresholdOn);
        mqttClient.publish(topicAlert, buf);
      } else if (temperature < offThreshold && relay1State) {
        setRelay(1, false, true);
        char buf[64];
        snprintf(buf, sizeof(buf), "Auto: Fan OFF (Temp %.1f < %.1fC)", temperature, offThreshold);
        mqttClient.publish(topicAlert, buf);
      }
    }
  }

  // Condition 2: Gas Hazard Trigger (Relay 2 Exhaust)
  if ((activeCondition == 2 || activeCondition == 3) && (now - lastManualOverride2 >= MANUAL_OVERRIDE_HOLD)) {
    int gasOffThreshold = gasHazardLimit - GAS_HYSTERESIS;
    if (gasOffThreshold < 100) gasOffThreshold = 100;

    if (gasRaw >= gasHazardLimit) {
      if (!gasHazard) {
        gasHazard = true;
        char buf[64];
        snprintf(buf, sizeof(buf), "CRITICAL: Gas Hazard! (%d >= %d)", gasRaw, gasHazardLimit);
        mqttClient.publish(topicAlert, buf);
      }
      if (!relay2State) {
        setRelay(2, true, true);
      }
    } else if (gasRaw < gasOffThreshold) {
      if (gasHazard) {
        gasHazard = false;
        mqttClient.publish(topicAlert, "Info: Gas cleared below hazard limit.");
        setRelay(2, false, true);
      }
    }
  }
}

void readSensors() {
  float t = dht.readTemperature();
  float h = dht.readHumidity();

  if (!isnan(t) && t > 0.0) temperature = t;
  if (!isnan(h) && h > 0.0) humidity = h;

  gasRaw = analogRead(MQ135_PIN);
}

void mqttCallback(char* topic, byte* payload, unsigned int length) {
  String message = "";
  for (unsigned int i = 0; i < length; i++) {
    message += (char)payload[i];
  }
  message.trim();

  // Condition Selector: 1=Temp, 2=Gas, 3=Both, 0=None
  if (String(topic) == topicCondition) {
    int cond = message.toInt();
    if (message.equalsIgnoreCase("TEMP")) cond = 1;
    else if (message.equalsIgnoreCase("GAS")) cond = 2;
    else if (message.equalsIgnoreCase("BOTH")) cond = 3;
    else if (message.equalsIgnoreCase("NONE") || message.equalsIgnoreCase("OFF")) cond = 0;

    activeCondition = cond;
    saveConfig();
    processAutomationRules();
    updateLcd();
    return;
  }

  // Threshold Updates
  if (String(topic) == topicCfgTemp) {
    float val = message.toFloat();
    if (val > 0) {
      tempThresholdOn = val;
      saveConfig();
      processAutomationRules();
      updateLcd();
    }
    return;
  }

  if (String(topic) == topicCfgHyst) {
    float val = message.toFloat();
    if (val >= 0.2) {
      tempHysteresis = val;
      saveConfig();
      processAutomationRules();
    }
    return;
  }

  if (String(topic) == topicCfgGas) {
    int val = message.toInt();
    if (val > 0) {
      gasHazardLimit = val;
      saveConfig();
      processAutomationRules();
      updateLcd();
    }
    return;
  }

  // Kill Switch
  if (String(topic) == topicKill) {
    if (message == "1" || message.equalsIgnoreCase("KILL")) {
      triggerKillSwitch(true);
    } else if (message == "0" || message.equalsIgnoreCase("RESET")) {
      triggerKillSwitch(false);
    }
    updateLcd();
    return;
  }

  // Manual Relay Control from Web
  // Set publishMqtt = false so we NEVER echo back to MQTT broker and create an infinite chatter loop!
  if (String(topic) == topicRelay1) {
    bool targetState = (message == "1" || message.equalsIgnoreCase("ON"));
    lastManualOverride1 = millis(); // Set manual override cooldown
    setRelay(1, targetState, false);
    updateLcd();
  } else if (String(topic) == topicRelay2) {
    bool targetState = (message == "1" || message.equalsIgnoreCase("ON"));
    lastManualOverride2 = millis(); // Set manual override cooldown
    setRelay(2, targetState, false);
    updateLcd();
  }
}

void connectMqtt() {
  while (!mqttClient.connected()) {
    Serial.print("Connecting to MQTT...");
    String clientId = "ESP32_SmartHome_" + String(random(0xffff), HEX);

    if (mqttClient.connect(clientId.c_str())) {
      Serial.println("Connected!");
      mqttClient.subscribe(topicRelay1);
      mqttClient.subscribe(topicRelay2);
      mqttClient.subscribe(topicKill);
      mqttClient.subscribe(topicCondition);
      mqttClient.subscribe(topicCfgTemp);
      mqttClient.subscribe(topicCfgGas);
      mqttClient.subscribe(topicCfgHyst);

      // Publish initial settings to sync dashboard
      char buf[16];
      dtostrf(tempThresholdOn, 1, 1, buf);
      mqttClient.publish(topicCfgTemp, buf, true);
      dtostrf(tempHysteresis, 1, 1, buf);
      mqttClient.publish(topicCfgHyst, buf, true);
      snprintf(buf, sizeof(buf), "%d", gasHazardLimit);
      mqttClient.publish(topicCfgGas, buf, true);
      snprintf(buf, sizeof(buf), "%d", activeCondition);
      mqttClient.publish(topicCondition, buf, true);
    } else {
      delay(2000);
    }
  }
}

void setup() {
  Serial.begin(115200);

  pinMode(RELAY_1, OUTPUT);
  pinMode(RELAY_2, OUTPUT);
  digitalWrite(RELAY_1, RELAY_OFF);
  digitalWrite(RELAY_2, RELAY_OFF);

  pinMode(BOOT_BUTTON, INPUT_PULLUP);

  loadConfig();

  dht.begin();
  pinMode(MQ135_PIN, INPUT);

  Wire.begin(21, 22);
  lcd.init();
  lcd.backlight();
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print("Smart Home Hub  ");
  lcd.setCursor(0, 1);
  lcd.print("Connecting WiFi ");

  snprintf(topicRelay1, sizeof(topicRelay1), "%s/relay1", baseTopic);
  snprintf(topicRelay2, sizeof(topicRelay2), "%s/relay2", baseTopic);
  snprintf(topicTemp, sizeof(topicTemp), "%s/temp", baseTopic);
  snprintf(topicHumidity, sizeof(topicHumidity), "%s/humidity", baseTopic);
  snprintf(topicGas, sizeof(topicGas), "%s/gas", baseTopic);
  snprintf(topicAlert, sizeof(topicAlert), "%s/alert", baseTopic);
  snprintf(topicKill, sizeof(topicKill), "%s/kill", baseTopic);
  snprintf(topicCondition, sizeof(topicCondition), "%s/config/condition", baseTopic);
  snprintf(topicCfgTemp, sizeof(topicCfgTemp), "%s/config/temp_thresh", baseTopic);
  snprintf(topicCfgGas, sizeof(topicCfgGas), "%s/config/gas_thresh", baseTopic);
  snprintf(topicCfgHyst, sizeof(topicCfgHyst), "%s/config/hysteresis", baseTopic);

  WiFi.begin(ssid, password);
  while (WiFi.status() != WL_CONNECTED) {
    delay(300);
    Serial.print(".");
  }

  mqttClient.setServer(mqtt_server, mqtt_port);
  mqttClient.setCallback(mqttCallback);

  readSensors();
  updateLcd();
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    WiFi.reconnect();
    delay(500);
    return;
  }

  if (!mqttClient.connected()) {
    connectMqtt();
  }
  mqttClient.loop();

  // Debounced BOOT Button Toggle
  static unsigned long lastBtnPress = 0;
  static bool lastBtnState = HIGH;
  bool btnState = digitalRead(BOOT_BUTTON);
  if (lastBtnState == HIGH && btnState == LOW && (millis() - lastBtnPress > 400)) {
    lastBtnPress = millis();
    triggerKillSwitch(!killSwitchActive);
    updateLcd();
  }
  lastBtnState = btnState;

  unsigned long currentMillis = millis();
  if (currentMillis - lastSensorPublish >= SENSOR_INTERVAL) {
    lastSensorPublish = currentMillis;

    readSensors();
    processAutomationRules();
    updateLcd();

    char tempStr[8], humStr[8], gasStr[8];
    dtostrf(temperature, 1, 1, tempStr);
    dtostrf(humidity, 1, 1, humStr);
    snprintf(gasStr, sizeof(gasStr), "%d", gasRaw);

    mqttClient.publish(topicTemp, tempStr);
    mqttClient.publish(topicHumidity, humStr);
    mqttClient.publish(topicGas, gasStr);
  }
}
