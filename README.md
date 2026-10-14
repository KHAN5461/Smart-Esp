# ESP32 Dual Relay & Environmental IoT Dashboard

An end-to-end IoT system connecting an **ESP32** microcontroller with a modern responsive **Tailwind CSS + Paho MQTT Dashboard** over the public HiveMQ MQTT broker.

---

## 🚀 Features

- **Dual Relay Control**: Active-LOW channel control for Relay 1 (GPIO 26) and Relay 2 (GPIO 27) with toggle & 1-second pulse actions.
- **Environmental Telemetry**: Real-time monitoring of:
  - **Temperature (°C / °F)** from DHT11 / DHT22 (GPIO 4)
  - **Relative Humidity (%)** with air comfort index
  - **Air Quality / Gas Detection** via MQ135 analog reading on ADC1 (GPIO 34) with automated hazard banner
- **Simulated 1602 I2C LCD Display**: Authentically mimics the physical 16x2 LCD display in real time:
  - **Line 1**: `R1:ON/OFF R2:ON/OFF`
  - **Line 2**: `T:XXC H:XX% G:XXXX`
- **Audio Feedback**: Synthetic mechanical relay click sound effects on switch toggles.
- **Wokwi Simulator Ready**: Includes complete `diagram.json` and `libraries.txt` to run directly in [Wokwi](https://wokwi.com).

---

## 📡 MQTT Topic Map

| Function | Topic | Direction | Payload Example |
| :--- | :--- | :--- | :--- |
| **Relay 1 Control** | `myhome123/relay1` | Web ➔ ESP32 | `"1"` (ON) / `"0"` (OFF) |
| **Relay 2 Control** | `myhome123/relay2` | Web ➔ ESP32 | `"1"` (ON) / `"0"` (OFF) |
| **Temperature** | `myhome123/temp` | ESP32 ➔ Web | `"24.5"` (°C) |
| **Humidity** | `myhome123/humidity` | ESP32 ➔ Web | `"52.0"` (%) |
| **MQ135 Gas / Smoke** | `myhome123/gas` | ESP32 ➔ Web | `"412"` (0-4095 ADC) |

> **Broker Details**:
> - ESP32: `broker.hivemq.com:1883` (TCP)
> - Web Browser: `broker.hivemq.com:8884/mqtt` (Secure WSS)

---

## 🔌 Hardware Pinout (ESP32)

| Component | ESP32 Pin | Logic / Note |
| :--- | :--- | :--- |
| **Relay Channel 1** | `GPIO 26` | Active-LOW (`LOW` = Relay ON) |
| **Relay Channel 2** | `GPIO 27` | Active-LOW (`LOW` = Relay ON) |
| **DHT11 / DHT22** | `GPIO 4` | Pull-up 10kΩ if using bare sensor |
| **MQ135 Gas Sensor** | `GPIO 34` | ADC1 (input-only, safe during Wi-Fi) |
| **I2C LCD 1602 SDA** | `GPIO 21` | Standard ESP32 I2C Data |
| **I2C LCD 1602 SCL** | `GPIO 22` | Standard ESP32 I2C Clock |
| **I2C Address** | `0x27` | Default PCF8574 backpack address |

---

## 📱 React PWA Web App (Material Design 3)

The project includes a **React.js Progressive Web App (PWA)** located in the [`webapp/`](file:///c:/Users/Admin/Documents/antigravity/modest-pythagoras/webapp) directory:

- **Material Design 3 (M3) UI/UX**: Tokenized color palette, authentic M3 surface elevations, switches with icon handles, and responsive thumb-zone ergonomics.
- **PWA & Web Notifications**:
  - Installable as a standalone app on Android, iOS, Windows, and macOS.
  - Critical **Gas Hazard Push Notifications** triggered when MQ-135 exceeds safety threshold.
  - Test Notification button to verify alert delivery.
  - Offline asset caching with Service Worker (`sw.js`).
- **Clean Interface**: Both the legacy LCD matrix and terminal traffic logger have been removed for an uncluttered, modern smart home experience.

### Running the React PWA

1. **Development Server**:
   ```bash
   cd webapp
   npm run dev
   ```
   Open `http://localhost:5173` in your browser.

2. **Production Build**:
   The production-ready build is compiled in [`webapp/dist`](file:///c:/Users/Admin/Documents/antigravity/modest-pythagoras/webapp/dist):
   ```bash
   cd webapp
   npm run preview
   ```
   You can deploy the [`webapp/dist`](file:///c:/Users/Admin/Documents/antigravity/modest-pythagoras/webapp/dist) folder directly to **Vercel**, **Netlify**, or **GitHub Pages**.

---

## 🛠️ Testing with Wokwi Simulation

1. Open [`sketch.ino`](file:///c:/Users/Admin/Documents/antigravity/modest-pythagoras/sketch.ino) and [`diagram.json`](file:///c:/Users/Admin/Documents/antigravity/modest-pythagoras/diagram.json) in [Wokwi](https://wokwi.com).
2. Start the simulation.
3. Open the React PWA in your browser.
4. Toggle relays or adjust the simulated MQ-135 potentiometer to observe live sensor updates and hazard alerts!

