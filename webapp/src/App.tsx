import { useState, useEffect, useRef, useCallback } from 'react';
import mqtt from 'mqtt';
type MqttClient = ReturnType<typeof mqtt.connect>;
import {
  Zap,
  Flame,
  Thermometer,
  Droplets,
  Bell,
  BellOff,
  BellRing,
  Download,
  Settings,
  RefreshCw,
  Volume2,
  VolumeX,
  AlertTriangle,
  Check,
  X,
  Sliders,
  Timer,
  PowerOff,
  RotateCcw,
  Cpu,
  Save,
  Share2,
  Eye,
  EyeOff,
  WifiOff,
  Activity,
  Home,
  CheckCircle2
} from 'lucide-react';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export default function App() {
  // Mobile Bottom Navigation Tab ('controls' | 'telemetry' | 'rules')
  const [activeTab, setActiveTab] = useState<'controls' | 'telemetry' | 'rules'>('controls');

  // MQTT & Topic State
  const [baseTopic, setBaseTopic] = useState<string>('myhome123');
  const [connectionStatus, setConnectionStatus] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');
  const clientRef = useRef<MqttClient | null>(null);

  // Hardware State
  const [relay1, setRelay1] = useState<boolean>(false);
  const [relay2, setRelay2] = useState<boolean>(false);
  const [killSwitchActive, setKillSwitchActive] = useState<boolean>(false);
  const [temperature, setTemperature] = useState<number | null>(null);
  const [humidity, setHumidity] = useState<number | null>(null);
  const [gasRaw, setGasRaw] = useState<number | null>(null);
  const [lastTelemetryTime, setLastTelemetryTime] = useState<string | null>(null);
  const [latestAlert, setLatestAlert] = useState<string | null>(null);

  // Active Condition to Run:
  // 1 = Temp Only, 2 = Gas Only, 3 = Both, 0 = Disabled
  const [activeCondition, setActiveCondition] = useState<number>(3);

  // Configurable Thresholds (Persisted in ESP32 Flash Preferences)
  const [tempThresh, setTempThresh] = useState<number>(29.0);
  const [tempHyst, setTempHyst] = useState<number>(1.0);
  const [gasThresh, setGasThresh] = useState<number>(1800);

  // Local draft inputs for Rule Editor
  const [draftTemp, setDraftTemp] = useState<number>(29.0);
  const [draftHyst, setDraftHyst] = useState<number>(1.0);
  const [draftGas, setDraftGas] = useState<number>(1800);
  const [configSaveNotice, setConfigSaveNotice] = useState<string | null>(null);

  // Mobile Hardware Features (Haptics, Wake Lock, Online/Offline)
  const [wakeLockActive, setWakeLockActive] = useState<boolean>(false);
  const [isOnline, setIsOnline] = useState<boolean>(navigator.onLine);
  const wakeLockSentinelRef = useRef<WakeLockSentinel | null>(null);

  // Preferences & Modals
  const [isFahrenheit, setIsFahrenheit] = useState<boolean>(false);
  const [soundEnabled, setSoundEnabled] = useState<boolean>(true);
  const [hapticsEnabled, setHapticsEnabled] = useState<boolean>(true);
  const [settingsOpen, setSettingsOpen] = useState<boolean>(false);
  const [tempTopicInput, setTempTopicInput] = useState<string>('myhome123');

  // PWA & Notification State
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission>('default');
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [isStandalone, setIsStandalone] = useState<boolean>(false);
  const lastAlertTimeRef = useRef<number>(0);

  // Audio Context
  const audioCtxRef = useRef<AudioContext | null>(null);

  // Mobile Haptic Feedback Helper
  const triggerHaptic = useCallback((pattern: number | number[]) => {
    if (!hapticsEnabled) return;
    if (typeof window !== 'undefined' && 'vibrate' in navigator) {
      try {
        navigator.vibrate(pattern);
      } catch {
        // Haptics unsupported or blocked
      }
    }
  }, [hapticsEnabled]);

  const playClickSound = useCallback((state: boolean) => {
    if (!soundEnabled) return;
    try {
      if (!audioCtxRef.current) {
        audioCtxRef.current = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
      }
      if (audioCtxRef.current.state === 'suspended') {
        audioCtxRef.current.resume();
      }
      const osc = audioCtxRef.current.createOscillator();
      const gain = audioCtxRef.current.createGain();
      osc.type = state ? 'triangle' : 'sine';
      osc.frequency.setValueAtTime(state ? 520 : 340, audioCtxRef.current.currentTime);
      osc.frequency.exponentialRampToValueAtTime(90, audioCtxRef.current.currentTime + 0.05);

      gain.gain.setValueAtTime(0.15, audioCtxRef.current.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtxRef.current.currentTime + 0.05);

      osc.connect(gain);
      gain.connect(audioCtxRef.current.destination);
      osc.start();
      osc.stop(audioCtxRef.current.currentTime + 0.06);
    } catch {
      // Audio not permitted
    }
  }, [soundEnabled]);

  // Screen Wake Lock API
  const toggleWakeLock = async () => {
    if (!('wakeLock' in navigator)) {
      alert('Screen Wake Lock is not supported on this browser/device.');
      return;
    }
    try {
      if (wakeLockActive && wakeLockSentinelRef.current) {
        await wakeLockSentinelRef.current.release();
        wakeLockSentinelRef.current = null;
        setWakeLockActive(false);
      } else {
        const sentinel = await navigator.wakeLock.request('screen');
        wakeLockSentinelRef.current = sentinel;
        setWakeLockActive(true);
        sentinel.addEventListener('release', () => {
          setWakeLockActive(false);
          wakeLockSentinelRef.current = null;
        });
      }
    } catch (err) {
      console.error('Wake lock error:', err);
    }
  };

  // Online / Offline Status
  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  // Web Share API
  const shareStatusReport = async () => {
    if (!navigator.share) {
      alert('Web Share API is not supported in this browser.');
      return;
    }
    try {
      const condText = activeCondition === 1 ? 'Temp Only' : activeCondition === 2 ? 'Gas Only' : activeCondition === 3 ? 'Both Active' : 'Off';
      await navigator.share({
        title: 'SmartHome Telemetry Report',
        text: `SmartHome Hub Status (${new Date().toLocaleTimeString()}):\n- Temp: ${temperature ?? '--'}°C\n- Humidity: ${humidity ?? '--'}%\n- Gas Level: ${gasRaw ?? '--'} ADC\n- Fan (R1): ${relay1 ? 'ON' : 'OFF'}\n- Exhaust (R2): ${relay2 ? 'ON' : 'OFF'}\n- Condition Mode: ${condText}`,
        url: window.location.href,
      });
      triggerHaptic(30);
    } catch {
      // User cancelled share
    }
  };

  // PWA Install prompt detection & Standalone check
  useEffect(() => {
    if (window.matchMedia('(display-mode: standalone)').matches || (window.navigator as unknown as { standalone?: boolean }).standalone) {
      setIsStandalone(true);
    }

    const handleBeforeInstall = (e: Event) => {
      e.preventDefault();
      setInstallPrompt(e as BeforeInstallPromptEvent);
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstall);
    return () => window.removeEventListener('beforeinstallprompt', handleBeforeInstall);
  }, []);

  // Notifications API permission initialization
  useEffect(() => {
    if ('Notification' in window) {
      setNotificationPermission(Notification.permission);
    }
  }, []);

  const requestNotificationAccess = async () => {
    if (!('Notification' in window)) {
      alert('This browser does not support desktop/push notifications.');
      return;
    }
    const perm = await Notification.requestPermission();
    setNotificationPermission(perm);
    if (perm === 'granted') {
      sendSystemNotification('Notifications Enabled', 'You will receive alerts for critical gas levels and device automation.');
      triggerHaptic([40, 60, 40]);
    }
  };

  const sendSystemNotification = useCallback((title: string, body: string, isHazard = false) => {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;

    if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
      navigator.serviceWorker.ready.then((registration) => {
        registration.showNotification(title, {
          body,
          icon: '/icon-192.svg',
          badge: '/icon-192.svg',
          vibrate: isHazard ? [200, 100, 200, 100, 400] : [100],
          tag: isHazard ? 'gas-hazard' : 'smartesp-info',
          requireInteraction: isHazard,
          actions: isHazard ? [
            { action: 'exhaust', title: 'Start Exhaust' },
            { action: 'kill', title: 'Emergency Kill All' },
          ] : undefined,
        } as NotificationOptions);
      });
    } else {
      new Notification(title, {
        body,
        icon: '/icon-192.svg',
        tag: isHazard ? 'gas-hazard' : 'smartesp-info',
      });
    }
  }, []);

  const handleInstallApp = async () => {
    if (!installPrompt) return;
    await installPrompt.prompt();
    const { outcome } = await installPrompt.userChoice;
    if (outcome === 'accepted') {
      setInstallPrompt(null);
    }
  };

  // Relay command publisher
  const publishRelay = useCallback((relayNum: 1 | 2, targetState: boolean) => {
    if (!clientRef.current || connectionStatus !== 'connected' || killSwitchActive) return;
    const topic = `${baseTopic}/relay${relayNum}`;
    const payload = targetState ? '1' : '0';
    clientRef.current.publish(topic, payload, { retain: true });
    playClickSound(targetState);
    triggerHaptic(targetState ? 35 : 20);

    if (relayNum === 1) setRelay1(targetState);
    if (relayNum === 2) setRelay2(targetState);
  }, [baseTopic, connectionStatus, killSwitchActive, playClickSound, triggerHaptic]);

  const pulseRelay = useCallback((relayNum: 1 | 2) => {
    if (killSwitchActive) return;
    publishRelay(relayNum, true);
    triggerHaptic([30, 40, 30]);
    setTimeout(() => {
      publishRelay(relayNum, false);
    }, 1000);
  }, [killSwitchActive, publishRelay, triggerHaptic]);

  // Kill switch publisher
  const toggleKillSwitch = useCallback(() => {
    if (!clientRef.current || connectionStatus !== 'connected') return;
    const target = !killSwitchActive;
    clientRef.current.publish(`${baseTopic}/kill`, target ? '1' : '0', { retain: true });
    setKillSwitchActive(target);
    playClickSound(false);
    triggerHaptic([100, 50, 100, 50, 200]);
  }, [baseTopic, connectionStatus, killSwitchActive, playClickSound, triggerHaptic]);

  // Condition Selector: Choose WHICH condition runs
  const setConditionFilter = useCallback((condValue: number) => {
    if (!clientRef.current || connectionStatus !== 'connected') return;
    setActiveCondition(condValue);
    clientRef.current.publish(`${baseTopic}/config/condition`, String(condValue), { retain: true });
    triggerHaptic(30);
    const names = ['Disabled', 'Temperature Condition Only', 'Gas Condition Only', 'Both Conditions'];
    setConfigSaveNotice(`Active Rule: ${names[condValue]}`);
    setTimeout(() => setConfigSaveNotice(null), 3000);
  }, [baseTopic, connectionStatus, triggerHaptic]);

  // Dynamic Rule Threshold Publisher
  const publishConfigSetting = useCallback((subtopic: 'temp_thresh' | 'hysteresis' | 'gas_thresh', value: number) => {
    if (!clientRef.current || connectionStatus !== 'connected') return;
    const topic = `${baseTopic}/config/${subtopic}`;
    clientRef.current.publish(topic, String(value), { retain: true });
    setConfigSaveNotice(`Saved ${subtopic.replace('_', ' ')}: ${value}`);
    triggerHaptic(40);
    setTimeout(() => setConfigSaveNotice(null), 3500);
  }, [baseTopic, connectionStatus, triggerHaptic]);

  // Handle URL App Shortcuts
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const action = params.get('action');
    if (action === 'toggle1') {
      publishRelay(1, !relay1);
    } else if (action === 'toggle2') {
      publishRelay(2, !relay2);
    } else if (action === 'kill') {
      toggleKillSwitch();
    }
  }, [publishRelay, relay1, relay2, toggleKillSwitch]);

  // Handle Action Messages from Service Worker Notification Clicks
  useEffect(() => {
    const handleSWMessage = (event: MessageEvent) => {
      if (event.data && event.data.type === 'PWA_NOTIFICATION_ACTION') {
        if (event.data.action === 'kill') {
          toggleKillSwitch();
        } else if (event.data.action === 'exhaust') {
          publishRelay(2, true);
        }
      }
    };
    navigator.serviceWorker?.addEventListener('message', handleSWMessage);
    return () => navigator.serviceWorker?.removeEventListener('message', handleSWMessage);
  }, [publishRelay, toggleKillSwitch]);

  // MQTT Connection Management
  useEffect(() => {
    setConnectionStatus('connecting');
    const brokerUrl = 'wss://broker.hivemq.com:8884/mqtt';
    const clientId = 'SmartESP_M3_' + Math.random().toString(16).substring(2, 10);

    const client = mqtt.connect(brokerUrl, {
      clientId,
      clean: true,
      reconnectPeriod: 3000,
    });

    clientRef.current = client;

    client.on('connect', () => {
      setConnectionStatus('connected');
      const topics = [
        `${baseTopic}/relay1`,
        `${baseTopic}/relay2`,
        `${baseTopic}/temp`,
        `${baseTopic}/humidity`,
        `${baseTopic}/gas`,
        `${baseTopic}/alert`,
        `${baseTopic}/kill`,
        `${baseTopic}/config/condition`,
        `${baseTopic}/config/temp_thresh`,
        `${baseTopic}/config/gas_thresh`,
        `${baseTopic}/config/hysteresis`,
      ];
      client.subscribe(topics, (err) => {
        if (err) console.error('Subscription error:', err);
      });
    });

    client.on('reconnect', () => {
      setConnectionStatus('connecting');
    });

    client.on('close', () => {
      setConnectionStatus('disconnected');
    });

    client.on('error', (err) => {
      console.error('MQTT connection error:', err);
      setConnectionStatus('disconnected');
    });

    client.on('message', (topic, payloadBuffer) => {
      const payload = payloadBuffer.toString().trim();
      setLastTelemetryTime(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));

      if (topic === `${baseTopic}/relay1`) {
        const state = payload === '1' || payload.toUpperCase() === 'ON';
        setRelay1(state);
      } else if (topic === `${baseTopic}/relay2`) {
        const state = payload === '1' || payload.toUpperCase() === 'ON';
        setRelay2(state);
      } else if (topic === `${baseTopic}/temp`) {
        const val = parseFloat(payload);
        if (!isNaN(val)) setTemperature(val);
      } else if (topic === `${baseTopic}/humidity`) {
        const val = parseFloat(payload);
        if (!isNaN(val)) setHumidity(val);
      } else if (topic === `${baseTopic}/gas`) {
        const val = parseInt(payload, 10);
        if (!isNaN(val)) {
          setGasRaw(val);
          if (val >= gasThresh) {
            const now = Date.now();
            if (now - lastAlertTimeRef.current > 60000) {
              lastAlertTimeRef.current = now;
              triggerHaptic([200, 100, 200, 100, 400]);
              sendSystemNotification(
                '🚨 CRITICAL GAS HAZARD!',
                `MQ-135 reading is ${val} ADC (Hazard limit: ${gasThresh}). Exhaust activated!`,
                true
              );
            }
          }
        }
      } else if (topic === `${baseTopic}/kill`) {
        const isKill = payload === '1' || payload.toUpperCase() === 'KILL';
        setKillSwitchActive(isKill);
      } else if (topic === `${baseTopic}/config/condition`) {
        const cond = parseInt(payload, 10);
        if (!isNaN(cond)) setActiveCondition(cond);
      } else if (topic === `${baseTopic}/alert`) {
        setLatestAlert(payload);
        setTimeout(() => setLatestAlert((prev) => (prev === payload ? null : prev)), 8000);
      } else if (topic === `${baseTopic}/config/temp_thresh`) {
        const val = parseFloat(payload);
        if (!isNaN(val)) {
          setTempThresh(val);
          setDraftTemp(val);
        }
      } else if (topic === `${baseTopic}/config/hysteresis`) {
        const val = parseFloat(payload);
        if (!isNaN(val)) {
          setTempHyst(val);
          setDraftHyst(val);
        }
      } else if (topic === `${baseTopic}/config/gas_thresh`) {
        const val = parseInt(payload, 10);
        if (!isNaN(val)) {
          setGasThresh(val);
          setDraftGas(val);
        }
      }
    });

    return () => {
      if (client) {
        client.end(true);
      }
    };
  }, [baseTopic, gasThresh, sendSystemNotification, triggerHaptic]);

  const handleApplyTopic = () => {
    const trimmed = tempTopicInput.trim();
    if (!trimmed || trimmed === baseTopic) {
      setSettingsOpen(false);
      return;
    }
    setBaseTopic(trimmed);
    setSettingsOpen(false);
    triggerHaptic(30);
  };

  const displayTemperature = temperature !== null
    ? (isFahrenheit ? (temperature * 9 / 5 + 32).toFixed(1) : temperature.toFixed(1))
    : '--.-';

  const isGasHazard = gasRaw !== null && gasRaw >= gasThresh;

  return (
    <div className="min-h-screen bg-m3-surface text-m3-onSurface flex flex-col font-sans pb-24 sm:pb-12 select-none">
      
      {/* ===================== MOBILE OFFLINE DETECTOR BANNER ===================== */}
      {!isOnline && (
        <div className="bg-amber-500 text-black px-4 py-2 text-xs font-bold flex items-center justify-center gap-2 shadow-md">
          <WifiOff className="w-4 h-4 shrink-0" />
          <span>You are currently offline. Running on cached PWA data.</span>
        </div>
      )}

      {/* ===================== MATERIAL 3 TOP APP BAR ===================== */}
      <header className="sticky top-0 z-40 bg-m3-surfaceContainer/90 backdrop-blur-md border-b border-m3-outlineVariant/30 px-4 sm:px-8 py-3.5 transition-colors">
        <div className="max-w-5xl mx-auto flex items-center justify-between gap-3">
          
          {/* Logo & Headline */}
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 sm:w-10 sm:h-10 rounded-2xl bg-m3-primaryContainer text-m3-onPrimaryContainer flex items-center justify-center shadow-sm">
              <Cpu className="w-5 h-5 text-m3-primary" />
            </div>
            <div>
              <div className="flex items-center gap-1.5">
                <h1 className="text-base sm:text-lg font-bold tracking-tight text-m3-onSurface">SmartHome</h1>
                {isStandalone && (
                  <span className="text-[10px] font-medium uppercase tracking-wider bg-m3-surfaceContainerHighest px-2 py-0.2 rounded-full text-m3-primary">
                    PWA
                  </span>
                )}
              </div>
              <p className="text-[11px] text-m3-outline font-mono">Topic: {baseTopic}</p>
            </div>
          </div>

          {/* Action Chips */}
          <div className="flex items-center gap-2">
            
            {/* Screen Wake Lock Button */}
            <button
              onClick={toggleWakeLock}
              className={`p-2 rounded-full border transition active:scale-95 ${
                wakeLockActive
                  ? 'bg-amber-950/60 text-amber-300 border-amber-500/40 shadow-sm'
                  : 'bg-m3-surfaceContainerHigh text-m3-outline border-transparent'
              }`}
              title={wakeLockActive ? 'Display Wake Lock is Active (Screen stays on)' : 'Keep Screen Awake'}
              aria-label="Toggle Screen Wake Lock"
            >
              {wakeLockActive ? <Eye className="w-4 h-4 text-amber-300" /> : <EyeOff className="w-4 h-4" />}
            </button>

            {/* Install PWA Button */}
            {installPrompt && (
              <button
                onClick={handleInstallApp}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-full text-xs font-medium bg-m3-primary text-m3-onPrimary hover:opacity-95 active:scale-95 transition shadow-sm"
              >
                <Download className="w-3.5 h-3.5" />
                <span className="hidden xs:inline">Install</span>
              </button>
            )}

            {/* Notification Permission Chip */}
            <button
              onClick={requestNotificationAccess}
              className={`flex items-center gap-1.5 p-2 sm:px-3 sm:py-1.5 rounded-full text-xs font-medium transition border ${
                notificationPermission === 'granted'
                  ? 'bg-m3-primaryContainer/60 text-m3-onPrimaryContainer border-m3-primary/30'
                  : 'bg-m3-surfaceContainerHigh text-m3-outline border-m3-outlineVariant'
              }`}
              title={notificationPermission === 'granted' ? 'Notifications active' : 'Enable system notifications'}
              aria-label="Notification Permission"
            >
              {notificationPermission === 'granted' ? (
                <>
                  <BellRing className="w-3.5 h-3.5 text-m3-primary" />
                  <span className="hidden md:inline">Alerts On</span>
                </>
              ) : notificationPermission === 'denied' ? (
                <>
                  <BellOff className="w-3.5 h-3.5 text-m3-error" />
                  <span className="hidden md:inline">Blocked</span>
                </>
              ) : (
                <>
                  <Bell className="w-3.5 h-3.5" />
                  <span className="hidden md:inline">Alerts</span>
                </>
              )}
            </button>

            {/* Settings Dialog Trigger */}
            <button
              onClick={() => {
                setTempTopicInput(baseTopic);
                setSettingsOpen(true);
              }}
              className="p-2 rounded-full bg-m3-surfaceContainerHigh hover:bg-m3-surfaceContainerHighest text-m3-onSurface transition active:scale-95"
              title="Settings"
              aria-label="Settings"
            >
              <Settings className="w-4 h-4" />
            </button>
          </div>
        </div>
      </header>

      {/* ===================== HARDWARE KILL SWITCH BANNER ===================== */}
      {killSwitchActive && (
        <div className="bg-rose-950 text-rose-200 border-b-2 border-rose-500 px-4 py-3 shadow-2xl animate-pulse">
          <div className="max-w-5xl mx-auto flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <PowerOff className="w-6 h-6 text-rose-400 shrink-0" />
              <div>
                <h4 className="font-extrabold text-sm sm:text-base text-white tracking-wide">
                  KILL SWITCH ACTIVATED!
                </h4>
                <p className="text-xs text-rose-300">
                  Firmware interlock has cut all relay circuits.
                </p>
              </div>
            </div>
            <button
              onClick={toggleKillSwitch}
              className="px-4 py-2 rounded-full text-xs font-bold bg-rose-500 hover:bg-rose-400 text-white shadow-lg active:scale-95 transition shrink-0 flex items-center gap-1.5"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>RESET</span>
            </button>
          </div>
        </div>
      )}

      {/* ===================== CRITICAL GAS HAZARD BANNER ===================== */}
      {isGasHazard && !killSwitchActive && (
        <div className="bg-m3-errorContainer text-m3-onErrorContainer border-b border-m3-error/40 px-4 py-3 shadow-lg animate-pulse">
          <div className="max-w-5xl mx-auto flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <AlertTriangle className="w-6 h-6 text-m3-error shrink-0" />
              <div>
                <h4 className="font-bold text-sm leading-snug">ELEVATED GAS / SMOKE LEVEL DETECTED!</h4>
                <p className="text-xs opacity-90">
                  MQ-135 reading is <strong className="underline">{gasRaw} ADC</strong> (Hazard Limit: {gasThresh}). Exhaust activated!
                </p>
              </div>
            </div>
            <span className="text-[11px] font-mono font-bold bg-m3-onError text-m3-error px-2 py-1 rounded">
              CRITICAL
            </span>
          </div>
        </div>
      )}

      {/* ===================== REAL-TIME FIRMWARE ALERT TOAST ===================== */}
      {latestAlert && (
        <div className="bg-indigo-950/90 text-indigo-200 border-b border-indigo-500/40 px-4 py-2 text-xs flex items-center justify-between max-w-5xl mx-auto w-full">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-indigo-400 animate-ping" />
            <span className="font-mono">{latestAlert}</span>
          </div>
          <button onClick={() => setLatestAlert(null)} className="text-slate-400 hover:text-white">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* ===================== MAIN CONTENT WRAPPER ===================== */}
      <main className="max-w-5xl mx-auto w-full px-4 sm:px-8 pt-6 space-y-8 flex-1">
        
        {/* ===================== VIEW 1: APPLIANCE CONTROLLERS ===================== */}
        {(activeTab === 'controls' || window.innerWidth >= 768) && (
          <section className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-bold tracking-tight text-m3-onSurface">Appliance Control</h2>
                <p className="text-xs text-m3-outline">Active-LOW Dual Relay outputs on ESP32</p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={toggleKillSwitch}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold transition shadow-sm ${
                    killSwitchActive
                      ? 'bg-rose-500 text-white animate-pulse'
                      : 'bg-rose-950/60 text-rose-300 border border-rose-500/40 hover:bg-rose-900'
                  }`}
                  title="Emergency power cutoff for all appliances"
                >
                  <PowerOff className="w-3.5 h-3.5" />
                  <span>{killSwitchActive ? 'RESET' : 'KILL SWITCH'}</span>
                </button>

                <button
                  onClick={() => setSoundEnabled(!soundEnabled)}
                  className={`p-2 rounded-full border transition ${
                    soundEnabled
                      ? 'bg-m3-surfaceContainerHigh text-m3-primary border-m3-outlineVariant'
                      : 'bg-m3-surfaceContainer text-m3-outline border-transparent'
                  }`}
                  title={soundEnabled ? 'Relay audio click enabled' : 'Relay audio muted'}
                  aria-label="Toggle Sound"
                >
                  {soundEnabled ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              
              {/* RELAY 1 CARD (Fan / Cooling) */}
              <div
                className={`rounded-[28px] p-6 transition-all duration-300 border relative overflow-hidden ${
                  killSwitchActive
                    ? 'bg-m3-surfaceContainer opacity-60 border-rose-500/30'
                    : relay1
                    ? 'bg-m3-surfaceContainerHigh border-m3-primary/40 shadow-lg shadow-m3-primaryContainer/15'
                    : 'bg-m3-surfaceContainer border-m3-outlineVariant/30'
                }`}
              >
                <div className="flex items-start justify-between">
                  <div>
                    <span className="text-[11px] font-mono uppercase tracking-wider text-m3-primary font-semibold">
                      GPIO 26 &bull; Channel 1 (Fan)
                    </span>
                    <h3 className="text-xl font-bold text-m3-onSurface mt-0.5">Appliance 1 / Fan</h3>
                    <p className="text-xs text-m3-outline mt-0.5">Topic: {baseTopic}/relay1</p>
                  </div>

                  <span
                    className={`text-xs font-bold px-3 py-1 rounded-full uppercase tracking-wider transition ${
                      killSwitchActive
                        ? 'bg-rose-950 text-rose-400'
                        : relay1
                        ? 'bg-m3-primary text-m3-onPrimary shadow-sm'
                        : 'bg-m3-surfaceContainerHighest text-m3-outline'
                    }`}
                  >
                    {killSwitchActive ? 'KILLED' : relay1 ? 'ACTIVE' : 'STANDBY'}
                  </span>
                </div>

                <div className="mt-8 flex items-center justify-between pt-2">
                  <div className="flex items-center gap-3">
                    <div
                      className={`w-12 h-12 rounded-2xl flex items-center justify-center transition-colors ${
                        relay1
                          ? 'bg-m3-primaryContainer text-m3-onPrimaryContainer'
                          : 'bg-m3-surfaceContainerHighest text-m3-outline'
                      }`}
                    >
                      <Zap className={`w-6 h-6 ${relay1 ? 'text-amber-300 fill-amber-300' : ''}`} />
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-m3-onSurface">{relay1 ? 'Power ON' : 'Power OFF'}</p>
                      <p className="text-xs text-m3-outline font-mono">Payload: "{relay1 ? '1' : '0'}"</p>
                    </div>
                  </div>

                  {/* Authentic Material 3 Switch */}
                  <button
                    type="button"
                    role="switch"
                    aria-checked={relay1}
                    disabled={killSwitchActive}
                    onClick={() => publishRelay(1, !relay1)}
                    className={`relative inline-flex h-8 w-14 shrink-0 cursor-pointer rounded-full p-1 transition-colors duration-200 ease-in-out focus:outline-none focus-visible:ring-2 focus-visible:ring-m3-primary ${
                      killSwitchActive
                        ? 'bg-slate-800 cursor-not-allowed opacity-40'
                        : relay1
                        ? 'bg-m3-primary'
                        : 'bg-m3-surfaceContainerHighest border border-m3-outline'
                    }`}
                  >
                    <span
                      className={`pointer-events-none flex h-6 w-6 transform items-center justify-center rounded-full shadow-md transition duration-200 ease-in-out ${
                        relay1
                          ? 'translate-x-6 bg-m3-onPrimary text-m3-primary'
                          : 'translate-x-0 bg-m3-outline text-m3-surfaceContainerHighest'
                      }`}
                    >
                      {relay1 ? <Check className="w-3.5 h-3.5 stroke-[3]" /> : <X className="w-3.5 h-3.5 stroke-[3]" />}
                    </span>
                  </button>
                </div>

                <div className="mt-6 pt-4 border-t border-m3-outlineVariant/30 flex items-center justify-between text-xs">
                  <span className="text-m3-outline">Momentary trigger:</span>
                  <button
                    disabled={killSwitchActive}
                    onClick={() => pulseRelay(1)}
                    className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-full font-medium bg-m3-surfaceContainerHighest hover:bg-m3-primaryContainer hover:text-m3-onPrimaryContainer text-m3-onSurface active:scale-95 transition disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <Timer className="w-3.5 h-3.5" />
                    <span>1s Pulse</span>
                  </button>
                </div>
              </div>

              {/* RELAY 2 CARD (Exhaust / Appliance 2) */}
              <div
                className={`rounded-[28px] p-6 transition-all duration-300 border relative overflow-hidden ${
                  killSwitchActive
                    ? 'bg-m3-surfaceContainer opacity-60 border-rose-500/30'
                    : relay2
                    ? 'bg-m3-surfaceContainerHigh border-m3-primary/40 shadow-lg shadow-m3-primaryContainer/15'
                    : 'bg-m3-surfaceContainer border-m3-outlineVariant/30'
                }`}
              >
                <div className="flex items-start justify-between">
                  <div>
                    <span className="text-[11px] font-mono uppercase tracking-wider text-m3-primary font-semibold">
                      GPIO 27 &bull; Channel 2 (Exhaust)
                    </span>
                    <h3 className="text-xl font-bold text-m3-onSurface mt-0.5">Appliance 2 / Exhaust</h3>
                    <p className="text-xs text-m3-outline mt-0.5">Topic: {baseTopic}/relay2</p>
                  </div>

                  <span
                    className={`text-xs font-bold px-3 py-1 rounded-full uppercase tracking-wider transition ${
                      killSwitchActive
                        ? 'bg-rose-950 text-rose-400'
                        : relay2
                        ? 'bg-m3-primary text-m3-onPrimary shadow-sm'
                        : 'bg-m3-surfaceContainerHighest text-m3-outline'
                    }`}
                  >
                    {killSwitchActive ? 'KILLED' : relay2 ? 'ACTIVE' : 'STANDBY'}
                  </span>
                </div>

                <div className="mt-8 flex items-center justify-between pt-2">
                  <div className="flex items-center gap-3">
                    <div
                      className={`w-12 h-12 rounded-2xl flex items-center justify-center transition-colors ${
                        relay2
                          ? 'bg-m3-primaryContainer text-m3-onPrimaryContainer'
                          : 'bg-m3-surfaceContainerHighest text-m3-outline'
                      }`}
                    >
                      <Zap className={`w-6 h-6 ${relay2 ? 'text-amber-300 fill-amber-300' : ''}`} />
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-m3-onSurface">{relay2 ? 'Power ON' : 'Power OFF'}</p>
                      <p className="text-xs text-m3-outline font-mono">Payload: "{relay2 ? '1' : '0'}"</p>
                    </div>
                  </div>

                  {/* Authentic Material 3 Switch */}
                  <button
                    type="button"
                    role="switch"
                    aria-checked={relay2}
                    disabled={killSwitchActive}
                    onClick={() => publishRelay(2, !relay2)}
                    className={`relative inline-flex h-8 w-14 shrink-0 cursor-pointer rounded-full p-1 transition-colors duration-200 ease-in-out focus:outline-none focus-visible:ring-2 focus-visible:ring-m3-primary ${
                      killSwitchActive
                        ? 'bg-slate-800 cursor-not-allowed opacity-40'
                        : relay2
                        ? 'bg-m3-primary'
                        : 'bg-m3-surfaceContainerHighest border border-m3-outline'
                    }`}
                  >
                    <span
                      className={`pointer-events-none flex h-6 w-6 transform items-center justify-center rounded-full shadow-md transition duration-200 ease-in-out ${
                        relay2
                          ? 'translate-x-6 bg-m3-onPrimary text-m3-primary'
                          : 'translate-x-0 bg-m3-outline text-m3-surfaceContainerHighest'
                      }`}
                    >
                      {relay2 ? <Check className="w-3.5 h-3.5 stroke-[3]" /> : <X className="w-3.5 h-3.5 stroke-[3]" />}
                    </span>
                  </button>
                </div>

                <div className="mt-6 pt-4 border-t border-m3-outlineVariant/30 flex items-center justify-between text-xs">
                  <span className="text-m3-outline">Momentary trigger:</span>
                  <button
                    disabled={killSwitchActive}
                    onClick={() => pulseRelay(2)}
                    className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-full font-medium bg-m3-surfaceContainerHighest hover:bg-m3-primaryContainer hover:text-m3-onPrimaryContainer text-m3-onSurface active:scale-95 transition disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <Timer className="w-3.5 h-3.5" />
                    <span>1s Pulse</span>
                  </button>
                </div>
              </div>

            </div>
          </section>
        )}

        {/* ===================== VIEW 2: ENVIRONMENTAL TELEMETRY ===================== */}
        {(activeTab === 'telemetry' || window.innerWidth >= 768) && (
          <section className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-bold tracking-tight text-m3-onSurface">Environmental Telemetry</h2>
                <p className="text-xs text-m3-outline">Real-time DHT11 & MQ-135 sensor readings</p>
              </div>
              <div className="flex items-center gap-2">
                {navigator.share && (
                  <button
                    onClick={shareStatusReport}
                    className="p-2 rounded-full bg-m3-surfaceContainerHigh hover:bg-m3-surfaceContainerHighest text-m3-onSurface transition"
                    title="Share Sensor Status Report"
                  >
                    <Share2 className="w-4 h-4 text-m3-primary" />
                  </button>
                )}
                {lastTelemetryTime && (
                  <span className="text-xs font-mono text-m3-outline bg-m3-surfaceContainer px-2.5 py-1 rounded-full border border-m3-outlineVariant/30">
                    {lastTelemetryTime}
                  </span>
                )}
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
              
              {/* TEMPERATURE CARD */}
              <div className="rounded-[28px] bg-m3-surfaceContainer p-5 border border-m3-outlineVariant/30 shadow-sm flex flex-col justify-between">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <div className="w-10 h-10 rounded-2xl bg-cyan-950/60 text-cyan-400 flex items-center justify-center">
                      <Thermometer className="w-5 h-5" />
                    </div>
                    <div>
                      <h4 className="text-sm font-semibold text-m3-onSurface">Temperature</h4>
                      <p className="text-[10px] text-m3-outline font-mono">DHT11 &bull; GPIO 4</p>
                    </div>
                  </div>

                  <button
                    onClick={() => setIsFahrenheit(!isFahrenheit)}
                    className="text-xs font-mono font-bold px-2 py-0.5 rounded-lg bg-m3-surfaceContainerHighest text-m3-primary hover:bg-m3-primaryContainer hover:text-m3-onPrimaryContainer transition"
                  >
                    {isFahrenheit ? '°F' : '°C'}
                  </button>
                </div>

                <div className="my-5 flex items-baseline justify-between">
                  <div className="flex items-baseline gap-1">
                    <span className="text-4xl font-extrabold tracking-tight font-mono text-m3-onSurface">
                      {displayTemperature}
                    </span>
                    <span className="text-lg font-medium text-cyan-400">{isFahrenheit ? '°F' : '°C'}</span>
                  </div>

                  <span
                    className={`text-[11px] font-semibold px-2.5 py-0.5 rounded-full border ${
                      temperature !== null && temperature >= tempThresh
                        ? 'bg-amber-950/40 text-amber-300 border-amber-500/30'
                        : 'bg-cyan-950/40 text-cyan-300 border-cyan-500/30'
                    }`}
                  >
                    {temperature === null ? 'Waiting...' : temperature >= tempThresh ? 'High (Fan ON)' : 'Comfortable'}
                  </span>
                </div>

                <div className="w-full bg-m3-surfaceContainerHighest rounded-full h-2 overflow-hidden">
                  <div
                    className="bg-gradient-to-r from-cyan-400 to-indigo-400 h-2 rounded-full transition-all duration-500"
                    style={{ width: `${Math.min(Math.max(((temperature || 20) / 45) * 100, 5), 100)}%` }}
                  />
                </div>
              </div>

              {/* HUMIDITY CARD */}
              <div className="rounded-[28px] bg-m3-surfaceContainer p-5 border border-m3-outlineVariant/30 shadow-sm flex flex-col justify-between">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <div className="w-10 h-10 rounded-2xl bg-blue-950/60 text-blue-400 flex items-center justify-center">
                      <Droplets className="w-5 h-5" />
                    </div>
                    <div>
                      <h4 className="text-sm font-semibold text-m3-onSurface">Humidity</h4>
                      <p className="text-[10px] text-m3-outline font-mono">DHT11 &bull; GPIO 4</p>
                    </div>
                  </div>
                  <span className="text-xs text-m3-outline font-mono">RH</span>
                </div>

                <div className="my-5 flex items-baseline justify-between">
                  <div className="flex items-baseline gap-1">
                    <span className="text-4xl font-extrabold tracking-tight font-mono text-m3-onSurface">
                      {humidity !== null ? humidity.toFixed(1) : '--.-'}
                    </span>
                    <span className="text-lg font-medium text-blue-400">%</span>
                  </div>

                  <span className="text-[11px] font-semibold px-2.5 py-0.5 rounded-full border bg-blue-950/40 text-blue-300 border-blue-500/30">
                    {humidity === null ? 'Waiting...' : humidity < 35 ? 'Dry' : humidity <= 65 ? 'Ideal' : 'Humid'}
                  </span>
                </div>

                <div className="w-full bg-m3-surfaceContainerHighest rounded-full h-2 overflow-hidden">
                  <div
                    className="bg-gradient-to-r from-blue-400 to-indigo-500 h-2 rounded-full transition-all duration-500"
                    style={{ width: `${Math.min(Math.max(humidity || 50, 5), 100)}%` }}
                  />
                </div>
              </div>

              {/* AIR QUALITY / MQ135 GAS CARD */}
              <div className="rounded-[28px] bg-m3-surfaceContainer p-5 border border-m3-outlineVariant/30 shadow-sm flex flex-col justify-between">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <div
                      className={`w-10 h-10 rounded-2xl flex items-center justify-center transition-colors ${
                        isGasHazard
                          ? 'bg-rose-950 text-rose-400 animate-bounce'
                          : 'bg-emerald-950/60 text-emerald-400'
                      }`}
                    >
                      <Flame className="w-5 h-5" />
                    </div>
                    <div>
                      <h4 className="text-sm font-semibold text-m3-onSurface">Air Quality / Gas</h4>
                      <p className="text-[10px] text-m3-outline font-mono">MQ-135 &bull; GPIO 34</p>
                    </div>
                  </div>
                  <span className="text-[10px] text-m3-outline font-mono">ADC1</span>
                </div>

                <div className="my-5 flex items-baseline justify-between">
                  <div className="flex items-baseline gap-1">
                    <span className="text-4xl font-extrabold tracking-tight font-mono text-m3-onSurface">
                      {gasRaw !== null ? gasRaw : '----'}
                    </span>
                    <span className="text-xs text-m3-outline font-mono ml-1">/ 4095</span>
                  </div>

                  <span
                    className={`text-[11px] font-semibold px-2.5 py-0.5 rounded-full border ${
                      isGasHazard
                        ? 'bg-rose-950/80 text-rose-300 border-rose-500 font-bold animate-pulse'
                        : gasRaw !== null && gasRaw > 800
                        ? 'bg-amber-950/40 text-amber-300 border-amber-500/30'
                        : 'bg-emerald-950/40 text-emerald-300 border-emerald-500/30'
                    }`}
                  >
                    {gasRaw === null ? 'Waiting...' : isGasHazard ? 'Hazard!' : gasRaw > 800 ? 'Moderate' : 'Clean'}
                  </span>
                </div>

                <div className="w-full bg-m3-surfaceContainerHighest rounded-full h-2 overflow-hidden">
                  <div
                    className={`h-2 rounded-full transition-all duration-500 ${
                      isGasHazard
                        ? 'bg-rose-500'
                        : 'bg-gradient-to-r from-emerald-400 via-amber-400 to-rose-500'
                    }`}
                    style={{ width: `${Math.min(Math.max(((gasRaw || 300) / 4095) * 100, 4), 100)}%` }}
                  />
                </div>
              </div>

            </div>
          </section>
        )}

        {/* ===================== VIEW 3: DYNAMIC RULE CONFIGURATOR ===================== */}
        {(activeTab === 'rules' || window.innerWidth >= 768) && (
          <section className="bg-m3-surfaceContainer rounded-[28px] p-6 border border-m3-outlineVariant/30 shadow-md space-y-6">
            
            {/* Header & Save Notice */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-2xl bg-indigo-950/60 text-indigo-400 flex items-center justify-center">
                  <Sliders className="w-5 h-5 text-indigo-400" />
                </div>
                <div>
                  <h2 className="text-base font-bold tracking-tight text-m3-onSurface">Rule Threshold Configurator</h2>
                  <p className="text-xs text-m3-outline">Saved to ESP32 Flash Memory (<code className="text-indigo-300 font-mono">Preferences.h</code>)</p>
                </div>
              </div>

              {configSaveNotice && (
                <span className="text-xs font-semibold px-3 py-1 rounded-full bg-emerald-950/60 text-emerald-300 border border-emerald-500/30 flex items-center gap-1.5 self-start sm:self-auto">
                  <Check className="w-3.5 h-3.5" />
                  <span>{configSaveNotice}</span>
                </span>
              )}
            </div>

            {/* NEW: Condition Selector (Run That Condition Only) */}
            <div className="bg-m3-surfaceContainerHigh p-4 rounded-2xl border border-m3-outlineVariant/30 space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <h4 className="text-sm font-bold text-m3-onSurface">Active Trigger Condition</h4>
                  <p className="text-xs text-m3-outline">Select which automation condition the ESP32 should execute</p>
                </div>
                <span className="text-xs font-mono font-semibold px-2.5 py-1 rounded-full bg-m3-primaryContainer text-m3-onPrimaryContainer">
                  {activeCondition === 1 ? 'Temp Only' : activeCondition === 2 ? 'Gas Only' : activeCondition === 3 ? 'Both Active' : 'Off'}
                </span>
              </div>

              {/* Segmented Condition Selector Chips */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-1">
                
                {/* 1: Temp Only */}
                <button
                  onClick={() => setConditionFilter(1)}
                  className={`p-3 rounded-xl border text-left transition active:scale-95 flex flex-col justify-between ${
                    activeCondition === 1
                      ? 'bg-m3-primaryContainer text-m3-onPrimaryContainer border-m3-primary shadow-sm'
                      : 'bg-m3-surfaceContainerHighest text-m3-outline hover:text-m3-onSurface border-transparent'
                  }`}
                >
                  <div className="flex items-center justify-between w-full mb-1">
                    <Thermometer className="w-4 h-4 text-cyan-400" />
                    {activeCondition === 1 && <CheckCircle2 className="w-3.5 h-3.5 text-m3-primary" />}
                  </div>
                  <span className="text-xs font-bold leading-tight">Temp Only</span>
                  <span className="text-[10px] opacity-80 mt-0.5">Fan trigger only</span>
                </button>

                {/* 2: Gas Only */}
                <button
                  onClick={() => setConditionFilter(2)}
                  className={`p-3 rounded-xl border text-left transition active:scale-95 flex flex-col justify-between ${
                    activeCondition === 2
                      ? 'bg-m3-primaryContainer text-m3-onPrimaryContainer border-m3-primary shadow-sm'
                      : 'bg-m3-surfaceContainerHighest text-m3-outline hover:text-m3-onSurface border-transparent'
                  }`}
                >
                  <div className="flex items-center justify-between w-full mb-1">
                    <Flame className="w-4 h-4 text-rose-400" />
                    {activeCondition === 2 && <CheckCircle2 className="w-3.5 h-3.5 text-m3-primary" />}
                  </div>
                  <span className="text-xs font-bold leading-tight">Gas Only</span>
                  <span className="text-[10px] opacity-80 mt-0.5">Exhaust trigger only</span>
                </button>

                {/* 3: Both Conditions */}
                <button
                  onClick={() => setConditionFilter(3)}
                  className={`p-3 rounded-xl border text-left transition active:scale-95 flex flex-col justify-between ${
                    activeCondition === 3
                      ? 'bg-m3-primaryContainer text-m3-onPrimaryContainer border-m3-primary shadow-sm'
                      : 'bg-m3-surfaceContainerHighest text-m3-outline hover:text-m3-onSurface border-transparent'
                  }`}
                >
                  <div className="flex items-center justify-between w-full mb-1">
                    <Zap className="w-4 h-4 text-amber-400" />
                    {activeCondition === 3 && <CheckCircle2 className="w-3.5 h-3.5 text-m3-primary" />}
                  </div>
                  <span className="text-xs font-bold leading-tight">Both Active</span>
                  <span className="text-[10px] opacity-80 mt-0.5">Temp + Gas rules</span>
                </button>

                {/* 0: Disabled / Off */}
                <button
                  onClick={() => setConditionFilter(0)}
                  className={`p-3 rounded-xl border text-left transition active:scale-95 flex flex-col justify-between ${
                    activeCondition === 0
                      ? 'bg-m3-primaryContainer text-m3-onPrimaryContainer border-m3-primary shadow-sm'
                      : 'bg-m3-surfaceContainerHighest text-m3-outline hover:text-m3-onSurface border-transparent'
                  }`}
                >
                  <div className="flex items-center justify-between w-full mb-1">
                    <PowerOff className="w-4 h-4 text-slate-400" />
                    {activeCondition === 0 && <CheckCircle2 className="w-3.5 h-3.5 text-m3-primary" />}
                  </div>
                  <span className="text-xs font-bold leading-tight">Disabled</span>
                  <span className="text-[10px] opacity-80 mt-0.5">Manual control only</span>
                </button>

              </div>
            </div>

            {/* Threshold Inputs */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
              
              {/* Fan Trigger Temp Threshold */}
              <div className="bg-m3-surfaceContainerHigh p-4 rounded-2xl border border-m3-outlineVariant/30 flex flex-col justify-between">
                <div>
                  <label className="block text-xs font-semibold text-m3-onSurface mb-1">
                    Fan ON Temp Threshold (°C)
                  </label>
                  <p className="text-[11px] text-m3-outline mb-2.5">
                    Turns Fan (Relay 1) ON when temperature meets or exceeds this value.
                  </p>
                </div>
                <div className="flex items-center gap-2 mt-auto">
                  <input
                    type="number"
                    step="0.5"
                    value={draftTemp}
                    onChange={(e) => setDraftTemp(parseFloat(e.target.value) || 0)}
                    className="w-full bg-m3-surfaceContainerHighest border border-m3-outlineVariant rounded-xl px-3 py-2 text-sm font-mono text-amber-300 focus:outline-none focus:ring-2 focus:ring-m3-primary"
                  />
                  <button
                    onClick={() => publishConfigSetting('temp_thresh', draftTemp)}
                    className="px-3.5 py-2 bg-m3-primary text-m3-onPrimary rounded-xl text-xs font-bold hover:opacity-95 active:scale-95 transition shadow-sm flex items-center gap-1 shrink-0"
                  >
                    <Save className="w-3.5 h-3.5" />
                    <span>Set</span>
                  </button>
                </div>
                <span className="text-[10px] text-m3-outline font-mono mt-1.5 block">
                  Active in Flash: <strong>{tempThresh.toFixed(1)}°C</strong>
                </span>
              </div>

              {/* Temp Hysteresis Buffer */}
              <div className="bg-m3-surfaceContainerHigh p-4 rounded-2xl border border-m3-outlineVariant/30 flex flex-col justify-between">
                <div>
                  <label className="block text-xs font-semibold text-m3-onSurface mb-1">
                    Hysteresis Buffer (°C)
                  </label>
                  <p className="text-[11px] text-m3-outline mb-2.5">
                    Prevents rapid switching. Fan turns OFF at (Threshold - Buffer).
                  </p>
                </div>
                <div className="flex items-center gap-2 mt-auto">
                  <input
                    type="number"
                    step="0.1"
                    value={draftHyst}
                    onChange={(e) => setDraftHyst(parseFloat(e.target.value) || 0)}
                    className="w-full bg-m3-surfaceContainerHighest border border-m3-outlineVariant rounded-xl px-3 py-2 text-sm font-mono text-indigo-300 focus:outline-none focus:ring-2 focus:ring-m3-primary"
                  />
                  <button
                    onClick={() => publishConfigSetting('hysteresis', draftHyst)}
                    className="px-3.5 py-2 bg-m3-primary text-m3-onPrimary rounded-xl text-xs font-bold hover:opacity-95 active:scale-95 transition shadow-sm flex items-center gap-1 shrink-0"
                  >
                    <Save className="w-3.5 h-3.5" />
                    <span>Set</span>
                  </button>
                </div>
                <span className="text-[10px] text-m3-outline font-mono mt-1.5 block">
                  Turns OFF at: <strong>{(tempThresh - tempHyst).toFixed(1)}°C</strong> (Buffer: {tempHyst.toFixed(1)}°C)
                </span>
              </div>

              {/* Gas Hazard Limit */}
              <div className="bg-m3-surfaceContainerHigh p-4 rounded-2xl border border-m3-outlineVariant/30 flex flex-col justify-between">
                <div>
                  <label className="block text-xs font-semibold text-m3-onSurface mb-1">
                    Gas Hazard Limit (MQ-135 ADC)
                  </label>
                  <p className="text-[11px] text-m3-outline mb-2.5">
                    Triggers Exhaust (Relay 2) & emergency alert immediately.
                  </p>
                </div>
                <div className="flex items-center gap-2 mt-auto">
                  <input
                    type="number"
                    step="50"
                    value={draftGas}
                    onChange={(e) => setDraftGas(parseInt(e.target.value, 10) || 0)}
                    className="w-full bg-m3-surfaceContainerHighest border border-m3-outlineVariant rounded-xl px-3 py-2 text-sm font-mono text-emerald-300 focus:outline-none focus:ring-2 focus:ring-m3-primary"
                  />
                  <button
                    onClick={() => publishConfigSetting('gas_thresh', draftGas)}
                    className="px-3.5 py-2 bg-m3-primary text-m3-onPrimary rounded-xl text-xs font-bold hover:opacity-95 active:scale-95 transition shadow-sm flex items-center gap-1 shrink-0"
                  >
                    <Save className="w-3.5 h-3.5" />
                    <span>Set</span>
                  </button>
                </div>
                <span className="text-[10px] text-m3-outline font-mono mt-1.5 block">
                  Active in Flash: <strong>{gasThresh} ADC</strong>
                </span>
              </div>

            </div>
          </section>
        )}

      </main>

      {/* ===================== MATERIAL 3 MOBILE BOTTOM NAVIGATION BAR ===================== */}
      <nav className="fixed bottom-0 left-0 right-0 z-40 bg-m3-surfaceContainer/95 backdrop-blur-lg border-t border-m3-outlineVariant/30 px-6 py-2 sm:hidden flex items-center justify-around">
        <button
          onClick={() => {
            setActiveTab('controls');
            triggerHaptic(20);
          }}
          className={`flex flex-col items-center gap-1 transition ${
            activeTab === 'controls' ? 'text-m3-primary font-bold' : 'text-m3-outline'
          }`}
        >
          <div className={`p-1 rounded-full ${activeTab === 'controls' ? 'bg-m3-primaryContainer text-m3-onPrimaryContainer px-4' : ''}`}>
            <Home className="w-5 h-5" />
          </div>
          <span className="text-[11px]">Controls</span>
        </button>

        <button
          onClick={() => {
            setActiveTab('telemetry');
            triggerHaptic(20);
          }}
          className={`flex flex-col items-center gap-1 transition ${
            activeTab === 'telemetry' ? 'text-m3-primary font-bold' : 'text-m3-outline'
          }`}
        >
          <div className={`p-1 rounded-full ${activeTab === 'telemetry' ? 'bg-m3-primaryContainer text-m3-onPrimaryContainer px-4' : ''}`}>
            <Activity className="w-5 h-5" />
          </div>
          <span className="text-[11px]">Sensors</span>
        </button>

        <button
          onClick={() => {
            setActiveTab('rules');
            triggerHaptic(20);
          }}
          className={`flex flex-col items-center gap-1 transition ${
            activeTab === 'rules' ? 'text-m3-primary font-bold' : 'text-m3-outline'
          }`}
        >
          <div className={`p-1 rounded-full ${activeTab === 'rules' ? 'bg-m3-primaryContainer text-m3-onPrimaryContainer px-4' : ''}`}>
            <Sliders className="w-5 h-5" />
          </div>
          <span className="text-[11px]">Rules</span>
        </button>
      </nav>

      {/* ===================== MATERIAL 3 SETTINGS DIALOG / MODAL ===================== */}
      {settingsOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in">
          <div className="bg-m3-surfaceContainerHigh text-m3-onSurface border border-m3-outlineVariant rounded-[32px] p-6 max-w-md w-full shadow-2xl space-y-6">
            
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-xl bg-m3-primaryContainer text-m3-onPrimaryContainer flex items-center justify-center">
                  <Sliders className="w-4 h-4 text-m3-primary" />
                </div>
                <h3 className="text-lg font-bold">App & Preferences</h3>
              </div>
              <button
                onClick={() => setSettingsOpen(false)}
                className="p-1.5 rounded-full hover:bg-m3-surfaceContainerHighest text-m3-outline hover:text-m3-onSurface transition"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-4">
              
              {/* MQTT Base Topic Input */}
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-m3-outline mb-1.5">
                  MQTT Base Topic
                </label>
                <input
                  type="text"
                  value={tempTopicInput}
                  onChange={(e) => setTempTopicInput(e.target.value)}
                  className="w-full bg-m3-surfaceContainer border border-m3-outlineVariant rounded-xl px-3.5 py-2.5 text-sm font-mono text-m3-primary focus:outline-none focus:ring-2 focus:ring-m3-primary transition"
                  placeholder="e.g. myhome123"
                />
                <p className="text-[11px] text-m3-outline mt-1">
                  Topic root configured on ESP32
                </p>
              </div>

              {/* Mobile Toggles: Haptics & Sound */}
              <div className="p-3.5 rounded-2xl bg-m3-surfaceContainer border border-m3-outlineVariant/30 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium">Haptic Vibration:</span>
                  <button
                    onClick={() => {
                      setHapticsEnabled(!hapticsEnabled);
                      if (!hapticsEnabled) triggerHaptic(30);
                    }}
                    className={`px-3 py-1 rounded-full text-xs font-bold transition ${
                      hapticsEnabled ? 'bg-m3-primary text-m3-onPrimary' : 'bg-m3-surfaceContainerHighest text-m3-outline'
                    }`}
                  >
                    {hapticsEnabled ? 'ENABLED' : 'MUTED'}
                  </button>
                </div>

                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium">Audio Click Sound:</span>
                  <button
                    onClick={() => setSoundEnabled(!soundEnabled)}
                    className={`px-3 py-1 rounded-full text-xs font-bold transition ${
                      soundEnabled ? 'bg-m3-primary text-m3-onPrimary' : 'bg-m3-surfaceContainerHighest text-m3-outline'
                    }`}
                  >
                    {soundEnabled ? 'ENABLED' : 'MUTED'}
                  </button>
                </div>

                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium">Screen Wake Lock:</span>
                  <button
                    onClick={toggleWakeLock}
                    className={`px-3 py-1 rounded-full text-xs font-bold transition ${
                      wakeLockActive ? 'bg-amber-400 text-black' : 'bg-m3-surfaceContainerHighest text-m3-outline'
                    }`}
                  >
                    {wakeLockActive ? 'ACTIVE' : 'OFF'}
                  </button>
                </div>
              </div>

            </div>

            {/* Modal Actions */}
            <div className="flex items-center justify-end gap-2.5 pt-2">
              <button
                onClick={() => setSettingsOpen(false)}
                className="px-4 py-2 rounded-full text-xs font-semibold text-m3-outline hover:text-m3-onSurface transition"
              >
                Close
              </button>
              <button
                onClick={handleApplyTopic}
                className="px-5 py-2 rounded-full text-xs font-semibold bg-m3-primary text-m3-onPrimary hover:opacity-95 active:scale-95 transition shadow-sm"
              >
                Save & Connect
              </button>
            </div>

          </div>
        </div>
      )}

      {/* ===================== FOOTER ===================== */}
      <footer className="mt-auto border-t border-m3-outlineVariant/20 py-4 px-4 text-center text-xs text-m3-outline hidden sm:block">
        <div className="max-w-5xl mx-auto flex items-center justify-between gap-2">
          <span>SmartHome Hub Mobile PWA &bull; Material 3 Design</span>
          <div className="flex items-center gap-4">
            <span className="font-mono text-[11px]">Broker: HiveMQ Public WSS</span>
            <button
              onClick={() => clientRef.current?.reconnect()}
              className="text-m3-primary hover:underline flex items-center gap-1 font-medium"
            >
              <RefreshCw className="w-3 h-3" />
              <span>Reconnect</span>
            </button>
          </div>
        </div>
      </footer>

    </div>
  );
}
