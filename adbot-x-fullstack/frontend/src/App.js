import React, { useState, useEffect, useRef, useCallback } from 'react';
import { SimliClient } from 'simli-client';
import PerceptionService from './perception';

const BACKEND_URL_STORAGE_KEY = 'adbotx.backend_url';
const DEFAULT_CLOUD_BACKEND_URL = 'https://adbotx-cloud-render.onrender.com';
const CONFIG_RETRY_INTERVAL_MS = 8000;

const normalizeBackendUrl = (value) => {
  const raw = (value || '').trim();
  if (!raw) return '';
  const withoutTrailingSlash = raw.replace(/\/+$/, '');
  return withoutTrailingSlash.replace(/\/api$/i, '');
};

const readStoredBackendUrl = () => {
  try {
    return normalizeBackendUrl(window.localStorage.getItem(BACKEND_URL_STORAGE_KEY) || '');
  } catch {
    return '';
  }
};

const resolveBackendUrl = () => {
  if (typeof window !== 'undefined') {
    try {
      const query = new URLSearchParams(window.location.search).get('backend');
      const normalizedQuery = normalizeBackendUrl(query || '');
      if (normalizedQuery) return normalizedQuery;
    } catch {
      // Ignore malformed query params
    }

    const stored = readStoredBackendUrl();
    if (stored) {
      const lower = stored.toLowerCase();
      const isLocalStored =
        lower.includes('://localhost') ||
        lower.includes('://127.0.0.1') ||
        lower.startsWith('capacitor://');
      if (!isLocalStored) {
        return stored;
      }
    }
  }

  const configured = (process.env.REACT_APP_BACKEND_URL || '').trim();
  if (configured) {
    return normalizeBackendUrl(configured);
  }

  if (typeof window !== 'undefined' && window.location?.origin) {
    const origin = window.location.origin;
    const lower = origin.toLowerCase();
    const isLocalWebview =
      lower.includes('://localhost') ||
      lower.includes('://127.0.0.1') ||
      lower.startsWith('capacitor://');
    if (!isLocalWebview) {
      return normalizeBackendUrl(origin);
    }
  }

  return normalizeBackendUrl(DEFAULT_CLOUD_BACKEND_URL);
};

const isMobileDevice = () => {
  if (typeof navigator === 'undefined') return false;
  const userAgent = navigator.userAgent || '';
  return /Android|iPhone|iPad|iPod|Mobile/i.test(userAgent) || navigator.maxTouchPoints > 1;
};

const isLowPowerDevice = () => {
  if (typeof navigator === 'undefined') return false;
  const cores = navigator.hardwareConcurrency || 8;
  const lowMemory = typeof navigator.deviceMemory === 'number' && navigator.deviceMemory <= 4;
  return cores <= 4 || lowMemory || isMobileDevice();
};

const pickAudioMimeType = () => {
  if (typeof MediaRecorder === 'undefined') return '';
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/ogg;codecs=opus',
  ];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || '';
};

const INITIAL_BACKEND_URL = resolveBackendUrl();

const STATES = {
  IDLE: 'idle',
  LISTENING: 'listening',
  THINKING: 'thinking',
  SPEAKING: 'speaking',
};

const createSessionId = () => {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  const now = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2);
  return `sess_${now}_${rand}`;
};

function App() {
  const [state, setState] = useState(STATES.IDLE);
  const [transcript, setTranscript] = useState('');
  const [interimTranscript, setInterimTranscript] = useState('');
  const [response, setResponse] = useState('');
  const [sessionId] = useState(() => createSessionId());
  const [config, setConfig] = useState(null);
  const [error, setError] = useState(null);
  const [backendUrl, setBackendUrl] = useState(INITIAL_BACKEND_URL);
  const [backendInput, setBackendInput] = useState(INITIAL_BACKEND_URL);
  const [showBackendEditor, setShowBackendEditor] = useState(!INITIAL_BACKEND_URL);
  const [simliReady, setSimliReady] = useState(false);
  const [micActive, setMicActive] = useState(false);
  const [perception, setPerception] = useState(null);
  const [activeAvatar, setActiveAvatar] = useState('');
  const [avatarFullscreen, setAvatarFullscreen] = useState(false);
  const [deviceProfile] = useState(() => ({
    isMobile: isMobileDevice(),
    isLowPower: isLowPowerDevice(),
  }));
  const [lowPowerMode, setLowPowerMode] = useState(deviceProfile.isLowPower);
  const [perceptionEnabled, setPerceptionEnabled] = useState(!deviceProfile.isMobile);
  const API = backendUrl ? `${backendUrl}/api` : '';
  
  // Refs
  const wsRef = useRef(null);
  const deepgramWsRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const streamRef = useRef(null);
  const simliClientRef = useRef(null);
  const videoRef = useRef(null);
  const audioRef = useRef(null);
  const perceptionVideoRef = useRef(null);
  const perceptionServiceRef = useRef(null);
  const audioContextRef = useRef(null);
  const canvasRef = useRef(null);
  const particlesRef = useRef([]);
  const animationRef = useRef(null);
  const mousePos = useRef({ x: -1000, y: -1000 });
  const silenceTimeoutRef = useRef(null);
  const awaitingAudioRef = useRef(false);
  const resumeSafetyTimeoutRef = useRef(null);
  const configLoadingRef = useRef(false);
  const didAutoFallbackRef = useRef(false);
  const micEnabledRef = useRef(false);
  const perceptionEnabledRef = useRef(perceptionEnabled);
  const currentFaceIdRef = useRef(null);
  const activeAvatarRef = useRef(activeAvatar);
  const perceptionStateRef = useRef(perception);
  const backendUrlRef = useRef(backendUrl);
  
  // CRITICAL: Lock to prevent multiple responses
  const isProcessingRef = useRef(false);
  const currentStateRef = useRef(STATES.IDLE);
  
  useEffect(() => {
    currentStateRef.current = state;
  }, [state]);

  useEffect(() => {
    perceptionEnabledRef.current = perceptionEnabled;
  }, [perceptionEnabled]);

  useEffect(() => {
    activeAvatarRef.current = activeAvatar;
  }, [activeAvatar]);

  useEffect(() => {
    perceptionStateRef.current = perception;
  }, [perception]);

  useEffect(() => {
    backendUrlRef.current = backendUrl;
  }, [backendUrl]);

  useEffect(() => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
  }, [backendUrl]);

  useEffect(() => {
    if (!backendUrl && micEnabledRef.current) {
      disableMic();
    }
  }, [backendUrl]);

  useEffect(() => {
    if (wsRef.current?.readyState !== WebSocket.OPEN || !activeAvatar) return;
    const latestPerception = perceptionStateRef.current;
    const payload = {
      type: 'perception',
      active_avatar: activeAvatar,
      emotion: latestPerception?.emotion || 'neutral',
      confidence: latestPerception?.confidence || 0,
      ts: Math.floor(Date.now() / 1000),
    };
    wsRef.current.send(JSON.stringify(payload));
  }, [activeAvatar]);

  useEffect(() => {
    setBackendInput(backendUrl);
  }, [backendUrl]);

  const fetchConfig = useCallback(async () => {
    if (!API || configLoadingRef.current) {
      if (!API) {
        setConfig(null);
      }
      return;
    }

    configLoadingRef.current = true;
    try {
      const res = await fetch(`${API}/config`);
      if (!res.ok) {
        throw new Error(`config_http_${res.status}`);
      }
      const data = await res.json();
      setConfig(data);
      const profileNames = Object.keys(data?.avatar_profiles || {});
      if (profileNames.length > 0) {
        setActiveAvatar((prev) => prev || profileNames[0]);
      }
      didAutoFallbackRef.current = false;
      setError(null);
    } catch (err) {
      setConfig(null);
      const normalizedCurrent = normalizeBackendUrl(backendUrl);
      const normalizedDefault = normalizeBackendUrl(DEFAULT_CLOUD_BACKEND_URL);
      if (
        !didAutoFallbackRef.current &&
        normalizedCurrent &&
        normalizedCurrent !== normalizedDefault
      ) {
        didAutoFallbackRef.current = true;
        try {
          window.localStorage.setItem(BACKEND_URL_STORAGE_KEY, normalizedDefault);
        } catch {
          // Ignore storage errors and continue.
        }
        setBackendInput(normalizedDefault);
        setBackendUrl(normalizedDefault);
        setError('Backend URL varsayılana alındı, tekrar bağlanılıyor...');
        return;
      }
      setError('Sunucuya bağlanılamadı. Otomatik yeniden deneniyor...');
    } finally {
      configLoadingRef.current = false;
    }
  }, [API, backendUrl]);

  // Fetch config when backend changes
  useEffect(() => {
    if (!backendUrl) {
      setConfig(null);
      setError('Cloud backend URL girmen gerekiyor');
      return;
    }
    void fetchConfig();
  }, [backendUrl, fetchConfig]);

  // Retry config fetch while backend exists but config is missing.
  useEffect(() => {
    if (!backendUrl || config) return;
    const retryId = setInterval(() => {
      void fetchConfig();
    }, CONFIG_RETRY_INTERVAL_MS);
    return () => clearInterval(retryId);
  }, [backendUrl, config, fetchConfig]);
  
  // Auto-start services when config is ready
  useEffect(() => {
    if (config && videoRef.current && audioRef.current) {
      connectWebSocket();
    }
  }, [config]);

  const handlePerceptionSignal = useCallback((signal) => {
    const payload = activeAvatar ? { ...signal, active_avatar: activeAvatar } : signal;
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(payload));
    }
    perceptionStateRef.current = payload;
    setPerception(payload);
  }, [activeAvatar]);

  const startPerception = useCallback(async () => {
    if (!perceptionEnabledRef.current || !perceptionVideoRef.current) return;
    if (!perceptionServiceRef.current) {
      perceptionServiceRef.current = new PerceptionService({
        videoEl: perceptionVideoRef.current,
        onSignal: handlePerceptionSignal,
        onError: (err) => console.warn('Perception disabled:', err),
        intervalMs: lowPowerMode ? 650 : 400,
        maxWidth: lowPowerMode ? 480 : 640,
        maxHeight: lowPowerMode ? 360 : 480,
        smoothingWindow: lowPowerMode ? 4 : 5,
        maxSendIntervalMs: lowPowerMode ? 1400 : 1000,
      });
    }
    if (!perceptionServiceRef.current.isRunning()) {
      try {
        await perceptionServiceRef.current.start();
      } catch (err) {
        console.warn('Perception disabled:', err);
      }
    }
  }, [handlePerceptionSignal, lowPowerMode]);

  const stopPerception = useCallback(() => {
    perceptionServiceRef.current?.stop();
  }, []);

  useEffect(() => {
    if (perceptionEnabled) {
      if (micEnabledRef.current) {
        startPerception().catch((err) => console.warn('Perception disabled:', err));
      }
      return;
    }

    stopPerception();
    perceptionServiceRef.current = null;
    setPerception(null);
  }, [perceptionEnabled, startPerception, stopPerception]);

  useEffect(() => {
    if (!perceptionServiceRef.current) return;
    const wasRunning = perceptionServiceRef.current.isRunning();
    perceptionServiceRef.current.stop();
    perceptionServiceRef.current = null;
    if (wasRunning && micEnabledRef.current && perceptionEnabledRef.current) {
      startPerception().catch((err) => console.warn('Perception disabled:', err));
    }
  }, [lowPowerMode, startPerception]);
  
  // Particle system
  const initParticles = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return () => {};

    const ctx = canvas.getContext('2d');
    if (!ctx) return () => {};

    const resizeCanvas = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);

    const particleCount = lowPowerMode ? 36 : 100;
    const maxDist = lowPowerMode ? 110 : 150;
    const speedLimit = lowPowerMode ? 0.18 : 0.3;
    particlesRef.current = [];
    for (let i = 0; i < particleCount; i++) {
      particlesRef.current.push({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        size: Math.random() * 1.5 + 0.3,
        speedX: (Math.random() - 0.5) * speedLimit,
        speedY: (Math.random() - 0.5) * speedLimit,
        opacity: Math.random() * 0.5 + 0.2,
      });
    }

    const color2 = { r: 195, g: 20, b: 77 };

    const animate = () => {
      ctx.fillStyle = lowPowerMode ? 'rgba(0, 0, 0, 0.16)' : 'rgba(0, 0, 0, 0.1)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      particlesRef.current.forEach((p) => {
        p.x += p.speedX;
        p.y += p.speedY;

        if (p.x < 0) p.x = canvas.width;
        if (p.x > canvas.width) p.x = 0;
        if (p.y < 0) p.y = canvas.height;
        if (p.y > canvas.height) p.y = 0;

        const dx = mousePos.current.x - p.x;
        const dy = mousePos.current.y - p.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        let particleColor;
        if (dist < maxDist && mousePos.current.x > 0) {
          const t = 1 - (dist / maxDist);
          const r = Math.round(255 * (1 - t) + color2.r * t);
          const g = Math.round(255 * (1 - t) + color2.g * t);
          const b = Math.round(255 * (1 - t) + color2.b * t);
          particleColor = `rgba(${r}, ${g}, ${b}, ${p.opacity + t * 0.3})`;
          p.x -= dx * 0.01;
          p.y -= dy * 0.01;
        } else {
          particleColor = `rgba(255, 255, 255, ${p.opacity})`;
        }

        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fillStyle = particleColor;
        ctx.fill();
      });

      animationRef.current = requestAnimationFrame(animate);
    };

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    animate();

    return () => {
      window.removeEventListener('resize', resizeCanvas);
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [lowPowerMode]);

  useEffect(() => {
    const cleanupParticles = initParticles();
    return cleanupParticles;
  }, [initParticles]);
  
  const getAvatarFaceId = useCallback((avatarName) => {
    const profile = config?.avatar_profiles?.[avatarName];
    return profile?.simli_face_id || config?.simli_face_id || '';
  }, [config]);

  // Simli initialization
  const initSimli = async (faceId) => {
    if (!config?.simli_api_key || !faceId) return;
    if (simliClientRef.current && currentFaceIdRef.current === faceId) return;

    try {
      if (simliClientRef.current) {
        simliClientRef.current.close();
        simliClientRef.current = null;
        setSimliReady(false);
      }
      if (audioRef.current) {
        audioRef.current.muted = true;
        audioRef.current.volume = 0;
      }
      const simliClient = new SimliClient();

      simliClient.Initialize({
        apiKey: config.simli_api_key,
        faceID: faceId,
        handleSilence: true,
        maxSessionLength: 3600,
        maxIdleTime: 600,
        videoRef: videoRef.current,
        audioRef: audioRef.current,
      });

      simliClient.on('connected', () => setSimliReady(true));
      simliClient.on('disconnected', () => setSimliReady(false));

      simliClientRef.current = simliClient;
      currentFaceIdRef.current = faceId;
      await simliClient.start();
    } catch (err) {
      console.error('Simli error:', err);
    }
  };

  useEffect(() => {
    if (!config || !videoRef.current || !audioRef.current) return;
    const faceId = getAvatarFaceId(activeAvatar);
    if (faceId) {
      initSimli(faceId);
    }
  }, [activeAvatar, config, getAvatarFaceId]);
  
  // Pause/Resume microphone
  const pauseMic = () => {
    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.stop();
    }
  };
  
  const openDeepgramSocket = async () => {
    if (!config?.deepgram_api_key) return;
    if (deepgramWsRef.current?.readyState === WebSocket.OPEN) return;
    
    const deepgramUrl = `wss://api.deepgram.com/v1/listen?model=nova-2&language=tr&punctuate=true&interim_results=true&vad_events=true&endpointing=300`;
    const ws = new WebSocket(deepgramUrl, ['token', config.deepgram_api_key]);
    deepgramWsRef.current = ws;
    
    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      
      // CRITICAL: Ignore if processing or speaking
      if (isProcessingRef.current || currentStateRef.current === STATES.THINKING || currentStateRef.current === STATES.SPEAKING) {
        return;
      }
      
      if (data.type === 'Results') {
        const result = data.channel?.alternatives?.[0];
        if (result?.transcript && result.transcript.trim()) {
          if (data.is_final) {
            const finalText = result.transcript;
            setTranscript(prev => {
              const newTranscript = prev + (prev ? ' ' : '') + finalText;
              
              // Clear previous timeout
              if (silenceTimeoutRef.current) {
                clearTimeout(silenceTimeoutRef.current);
              }
              
              // Set timeout to send after silence
              silenceTimeoutRef.current = setTimeout(() => {
                if (!isProcessingRef.current) {
                  sendTranscript(newTranscript);
                }
              }, 800);
              
              return newTranscript;
            });
            setInterimTranscript('');
          } else {
            setInterimTranscript(result.transcript);
            if (currentStateRef.current === STATES.IDLE) {
              setState(STATES.LISTENING);
            }
          }
        }
      }
    };
    
    ws.onerror = () => {
      setError('Ses tanıma bağlantı hatası');
    };
    
    ws.onclose = () => {
      if (deepgramWsRef.current === ws) {
        deepgramWsRef.current = null;
      }
    };
    
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      setTimeout(reject, 5000);
    });
  };
  
  const resumeMic = async () => {
    if (!micEnabledRef.current) return;
    
    try {
      if (!deepgramWsRef.current || deepgramWsRef.current.readyState !== WebSocket.OPEN) {
        await openDeepgramSocket();
      }
      
      if (!mediaRecorderRef.current || mediaRecorderRef.current.state === 'inactive') {
        await startRecorder();
      }
    } catch (err) {
      console.error('Mic resume error:', err);
    }
  };
  
  const startRecorder = async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('media_devices_unavailable');
    }
    if (typeof MediaRecorder === 'undefined') {
      throw new Error('media_recorder_not_supported');
    }

    const stream = streamRef.current || await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
    
    streamRef.current = stream;
    const mimeType = pickAudioMimeType();
    const mediaRecorder = mimeType
      ? new MediaRecorder(stream, { mimeType })
      : new MediaRecorder(stream);
    mediaRecorderRef.current = mediaRecorder;
    
    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0 && 
          deepgramWsRef.current?.readyState === WebSocket.OPEN && 
          !isProcessingRef.current &&
          mediaRecorder.state === 'recording') {
        deepgramWsRef.current.send(event.data);
      }
    };
    
    mediaRecorder.start(lowPowerMode ? 350 : 250);
  };
  
  const enableMic = async () => {
    try {
      if (!backendUrl) {
        throw new Error('backend_url_missing');
      }
      const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
      if (!window.isSecureContext && !isLocalhost) {
        throw new Error('secure_context_required');
      }

      micEnabledRef.current = true;
      setMicActive(true);
      setState(STATES.LISTENING);
      await openDeepgramSocket();
      await startRecorder();
      if (perceptionEnabledRef.current) {
        await startPerception();
      }
      setError(null);
    } catch (err) {
      console.error('Mic error:', err);
      if (err?.message === 'secure_context_required') {
        setError('Mikrofon ve kamera için HTTPS gerekli');
      } else if (err?.message === 'backend_url_missing') {
        setError('Önce cloud backend URL gir');
      } else if (
        err?.message === 'media_devices_unavailable' ||
        err?.message === 'media_recorder_not_supported'
      ) {
        setError('Bu cihazda canlı ses kaydı desteklenmiyor');
      } else {
        setError('Mikrofon erişimi reddedildi');
      }
      micEnabledRef.current = false;
      setMicActive(false);
    }
  };
  
  const disableMic = () => {
    micEnabledRef.current = false;
    stopPerception();
    
    mediaRecorderRef.current?.stop();
    streamRef.current?.getTracks().forEach(track => track.stop());
    deepgramWsRef.current?.close();
    
    mediaRecorderRef.current = null;
    deepgramWsRef.current = null;
    streamRef.current = null;
    
    setPerception(null);
    setMicActive(false);
    setState(STATES.IDLE);
  };

  // Send audio to Simli and play ElevenLabs audio
  const sendAudioToSimli = async (base64Audio) => {
    try {
      const binaryString = atob(base64Audio);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      
      let resumeCalled = false;
      const finishPlayback = () => {
        if (resumeCalled) return;
        resumeCalled = true;
        isProcessingRef.current = false;
        awaitingAudioRef.current = false;
        setState(STATES.IDLE);
        resumeMic();
      };
      const blob = new Blob([bytes], { type: 'audio/mpeg' });
      const audioUrl = URL.createObjectURL(blob);
      const directAudio = new Audio(audioUrl);
      directAudio.onended = finishPlayback;
      directAudio.onerror = finishPlayback;
      directAudio.play().catch(e => console.log('Direct audio play error:', e));
      
      // Also send to Simli for lip-sync if available
      if (simliClientRef.current) {
        if (!audioContextRef.current) {
          audioContextRef.current = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
        }
        
        const audioBuffer = await audioContextRef.current.decodeAudioData(bytes.buffer.slice(0));
        const channelData = audioBuffer.getChannelData(0);
        
        let resampledData;
        if (audioBuffer.sampleRate !== 16000) {
          const ratio = 16000 / audioBuffer.sampleRate;
          const newLength = Math.floor(channelData.length * ratio);
          resampledData = new Float32Array(newLength);
          for (let i = 0; i < newLength; i++) {
            const srcIndex = i / ratio;
            const srcIndexFloor = Math.floor(srcIndex);
            const srcIndexCeil = Math.min(srcIndexFloor + 1, channelData.length - 1);
            const t = srcIndex - srcIndexFloor;
            resampledData[i] = channelData[srcIndexFloor] * (1 - t) + channelData[srcIndexCeil] * t;
          }
        } else {
          resampledData = channelData;
        }
        
        const pcm16Data = new Int16Array(resampledData.length);
        for (let i = 0; i < resampledData.length; i++) {
          const sample = Math.max(-1, Math.min(1, resampledData[i]));
          pcm16Data[i] = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
        }
        
        const chunkSize = 6000;
        const uint8Data = new Uint8Array(pcm16Data.buffer);
        
        for (let i = 0; i < uint8Data.length; i += chunkSize) {
          const chunk = uint8Data.slice(i, i + chunkSize);
          simliClientRef.current.sendAudioData(chunk);
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        
        // Wait for audio to finish then resume listening
        const audioDuration = Math.min(audioBuffer.duration * 1000 + 500, 25000);
        setTimeout(finishPlayback, audioDuration);
      } else {
        // No Simli, just wait for direct audio
      }
      
    } catch (err) {
      console.error('Audio error:', err);
      isProcessingRef.current = false;
      setState(STATES.IDLE);
      resumeMic();
    }
  };
  
  // WebSocket connection
  const connectWebSocket = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;
    if (!backendUrl) return;

    const wsBase = backendUrl;
    const wsUrl = wsBase.replace('https://', 'wss://').replace('http://', 'ws://');
    wsRef.current = new WebSocket(`${wsUrl}/api/ws/${sessionId}`);
    
    wsRef.current.onopen = () => {
      console.log('Backend connected');
      const latestPerception = perceptionStateRef.current;
      const payload = {
        type: 'perception',
        active_avatar: activeAvatarRef.current || 'unknown',
        emotion: latestPerception?.emotion || 'neutral',
        confidence: latestPerception?.confidence || 0,
        ts: Math.floor(Date.now() / 1000),
      };
      wsRef.current.send(JSON.stringify(payload));
    };
    
    wsRef.current.onmessage = async (event) => {
      const data = JSON.parse(event.data);
      
      switch (data.type) {
        case 'response_chunk':
          setResponse(prev => prev + data.text);
          break;
        case 'response_complete':
          setResponse(data.text);
          if (awaitingAudioRef.current) {
            if (resumeSafetyTimeoutRef.current) {
              clearTimeout(resumeSafetyTimeoutRef.current);
            }
            resumeSafetyTimeoutRef.current = setTimeout(() => {
              if (awaitingAudioRef.current) {
                isProcessingRef.current = false;
                setState(STATES.IDLE);
                awaitingAudioRef.current = false;
                resumeMic();
              }
            }, 1500);
          }
          break;
        case 'audio':
          awaitingAudioRef.current = false;
          if (resumeSafetyTimeoutRef.current) {
            clearTimeout(resumeSafetyTimeoutRef.current);
            resumeSafetyTimeoutRef.current = null;
          }
          setState(STATES.SPEAKING);
          await sendAudioToSimli(data.data);
          break;
        case 'state': {
          const stateValue = data.state;
          if (stateValue === 'idle') {
            if (!isProcessingRef.current) {
              setState(STATES.IDLE);
            }
          } else if (stateValue === 'thinking') {
            setState(STATES.THINKING);
          } else if (stateValue === 'speaking') {
            setState(STATES.SPEAKING);
          } else if (stateValue === 'listening') {
            setState(STATES.LISTENING);
          }
          break;
        }
        case 'barge_in':
          break;
        default:
          break;
      }
    };
    
    wsRef.current.onclose = () => {
      setTimeout(() => {
        if (backendUrlRef.current) {
          connectWebSocket();
        }
      }, 2000);
    };
  }, [backendUrl, sessionId]);
  
  // Send transcript to backend
  const sendTranscript = useCallback((text) => {
    if (!text.trim() || isProcessingRef.current || wsRef.current?.readyState !== WebSocket.OPEN) {
      return;
    }
    
    isProcessingRef.current = true;
    awaitingAudioRef.current = true;
    if (resumeSafetyTimeoutRef.current) {
      clearTimeout(resumeSafetyTimeoutRef.current);
      resumeSafetyTimeoutRef.current = null;
    }
    setState(STATES.THINKING);
    setResponse('');
    
    wsRef.current.send(JSON.stringify({ type: 'transcript', text: text.trim() }));
    setTranscript('');
    setInterimTranscript('');
  }, []);
  
  // Toggle microphone - single click
  const toggleMic = async () => {
    if (micEnabledRef.current) {
      disableMic();
    } else {
      await enableMic();
    }
  };

  const applyBackendUrl = () => {
    const normalized = normalizeBackendUrl(backendInput);
    if (!normalized || !/^https?:\/\//i.test(normalized)) {
      setError('Geçerli bir backend URL gir. Örnek: https://api.domain.com');
      return;
    }

    try {
      window.localStorage.setItem(BACKEND_URL_STORAGE_KEY, normalized);
    } catch {
      // Best effort, continue with in-memory value.
    }

    if (micEnabledRef.current) {
      disableMic();
    }
    wsRef.current?.close();
    setConfig(null);
    setBackendUrl(normalized);
    setShowBackendEditor(false);
    setError(null);
  };

  const clearBackendUrl = () => {
    try {
      window.localStorage.removeItem(BACKEND_URL_STORAGE_KEY);
    } catch {
      // Ignore storage errors
    }
    if (micEnabledRef.current) {
      disableMic();
    }
    wsRef.current?.close();
    setConfig(null);
    setBackendUrl('');
    setBackendInput('');
    setShowBackendEditor(true);
    setError('Cloud backend URL girmen gerekiyor');
  };

  const toggleAvatarFullscreen = async () => {
    if (avatarFullscreen) {
      if (document.fullscreenElement && document.exitFullscreen) {
        await document.exitFullscreen().catch(() => undefined);
      }
      setAvatarFullscreen(false);
      return;
    }

    setAvatarFullscreen(true);
    const rootEl = document.documentElement;
    if (rootEl?.requestFullscreen) {
      await rootEl.requestFullscreen().catch(() => undefined);
    }
  };

  useEffect(() => {
    const onFullscreenChange = () => {
      if (!document.fullscreenElement) {
        setAvatarFullscreen(false);
      }
    };
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, []);

  const handlePointerMove = (event) => {
    const point = event.touches?.[0] || event;
    if (!point) return;
    mousePos.current = { x: point.clientX, y: point.clientY };
  };

  const handlePointerLeave = () => {
    mousePos.current = { x: -1000, y: -1000 };
  };
  
  useEffect(() => {
    return () => {
      if (silenceTimeoutRef.current) {
        clearTimeout(silenceTimeoutRef.current);
      }
      if (resumeSafetyTimeoutRef.current) {
        clearTimeout(resumeSafetyTimeoutRef.current);
      }
      stopPerception();
      mediaRecorderRef.current?.stop();
      streamRef.current?.getTracks().forEach((track) => track.stop());
      deepgramWsRef.current?.close();
      wsRef.current?.close();
      simliClientRef.current?.close();
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [stopPerception]);
  
  // Get state text
  const getStateText = () => {
    switch (state) {
      case STATES.LISTENING:
        return 'DİNLİYOR...';
      case STATES.THINKING:
        return 'DÜŞÜNÜYOR...';
      case STATES.SPEAKING:
        return 'KONUŞUYOR...';
      default:
        return micActive ? 'DİNLEMEYE HAZIR' : 'BAŞLATMAK İÇİN TIKLAYIN';
    }
  };

  const getPerceptionText = () => {
    if (!perception?.emotion) return null;
    const labels = {
      happy: 'mutlu',
      angry: 'kızgın',
      sad: 'üzgün',
      neutral: 'nötr',
      stressed: 'stresli',
    };
    const label = labels[perception.emotion] || perception.emotion;
    return `Yüz algılandı: ${label}`;
  };
  
  return (
    <div 
      className="fixed inset-0 bg-black overflow-hidden touch-pan-y"
      onMouseMove={handlePointerMove}
      onMouseLeave={handlePointerLeave}
      onTouchMove={handlePointerMove}
      onTouchEnd={handlePointerLeave}
    >
      {/* Particle Canvas */}
      <canvas ref={canvasRef} className="absolute inset-0 z-0" />

      <button
        type="button"
        onClick={toggleAvatarFullscreen}
        className="absolute right-3 top-3 z-20 rounded-full border border-white/30 bg-black/60 px-3 py-1 text-[10px] uppercase tracking-widest text-white/80"
      >
        {avatarFullscreen ? 'Tam Ekrandan Çık' : 'Tam Ekran'}
      </button>
      
      {/* Main Content */}
      <div
        className={`relative z-10 min-h-[100dvh] w-full flex flex-col items-center ${
          avatarFullscreen ? 'justify-center px-0 py-0' : 'justify-between px-4 py-4 md:py-8'
        }`}
      >
        {!avatarFullscreen && (
          <div className="text-center">
            <h1 className="text-white/30 text-xs font-extralight tracking-[0.3em]">ANOMAL.HOUSE</h1>
            <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
              <button
                type="button"
                onClick={() => setShowBackendEditor((prev) => !prev)}
                className={`px-3 py-1 rounded-full border text-[10px] uppercase tracking-widest transition-colors ${
                  backendUrl
                    ? 'border-emerald-400/70 text-emerald-300 bg-emerald-500/10'
                    : 'border-amber-400/70 text-amber-300 bg-amber-500/10'
                }`}
              >
                {backendUrl ? 'Backend Hazır' : 'Backend Ayarla'}
              </button>
              {backendUrl && (
                <button
                  type="button"
                  onClick={clearBackendUrl}
                  className="px-3 py-1 rounded-full border border-white/20 text-[10px] uppercase tracking-widest text-white/60 hover:text-white/80 hover:border-white/40"
                >
                  URL Temizle
                </button>
              )}
            </div>
            {showBackendEditor && (
              <div className="mt-3 mx-auto w-full max-w-lg rounded-lg border border-white/15 bg-black/45 p-3">
                <input
                  value={backendInput}
                  onChange={(event) => setBackendInput(event.target.value)}
                  placeholder="https://adbotx-cloud-render.onrender.com"
                  className="w-full rounded bg-black/60 border border-white/20 px-3 py-2 text-xs text-white outline-none focus:border-[#c3144d]"
                />
                <div className="mt-2 flex justify-center gap-2">
                  <button
                    type="button"
                    onClick={applyBackendUrl}
                    className="px-3 py-1 rounded border border-[#c3144d] text-[#c3144d] bg-[#c3144d]/10 text-[10px] uppercase tracking-widest"
                  >
                    URL Kaydet
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowBackendEditor(false)}
                    className="px-3 py-1 rounded border border-white/20 text-white/60 text-[10px] uppercase tracking-widest hover:text-white/80 hover:border-white/40"
                  >
                    Kapat
                  </button>
                </div>
              </div>
            )}
            {backendUrl ? (
              <p className="mt-2 text-[10px] tracking-wide text-white/35 break-all">
                {backendUrl}
              </p>
            ) : (
              <p className="mt-2 text-[10px] tracking-wide text-amber-300/70">
                Cloud backend URL zorunlu
              </p>
            )}
            {backendUrl && !config && (
              <div className="mt-2">
                <button
                  type="button"
                  onClick={() => void fetchConfig()}
                  className="px-3 py-1 rounded-full border border-cyan-400/70 text-[10px] uppercase tracking-widest text-cyan-300 bg-cyan-400/10"
                >
                  Yeniden Dene
                </button>
              </div>
            )}
            {Object.keys(config?.avatar_profiles || {}).length > 0 && (
              <div className="mt-3">
                <p className="mb-2 text-[10px] uppercase tracking-widest text-white/40">Kişi Seç</p>
                <div className="flex flex-wrap items-center justify-center gap-2">
                  {Object.keys(config.avatar_profiles).map((avatarName) => {
                    const isActive = activeAvatar === avatarName;
                    return (
                      <button
                        key={avatarName}
                        type="button"
                        onClick={() => setActiveAvatar(avatarName)}
                        className={`px-3 py-1 rounded-full border text-[10px] uppercase tracking-widest transition-colors ${
                          isActive
                            ? 'border-[#c3144d] text-[#c3144d] bg-[#c3144d]/10'
                            : 'border-white/20 text-white/50 hover:text-white/80 hover:border-white/40'
                        }`}
                      >
                        {avatarName}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
              <button
                type="button"
                onClick={() => setLowPowerMode((prev) => !prev)}
                className={`px-3 py-1 rounded-full border text-[10px] uppercase tracking-widest transition-colors ${
                  lowPowerMode
                    ? 'border-[#c3144d] text-[#c3144d] bg-[#c3144d]/10'
                    : 'border-white/20 text-white/50 hover:text-white/80 hover:border-white/40'
                }`}
              >
                {lowPowerMode ? 'Düşük Güç' : 'Tam Güç'}
              </button>
              <button
                type="button"
                onClick={() => setPerceptionEnabled((prev) => !prev)}
                className={`px-3 py-1 rounded-full border text-[10px] uppercase tracking-widest transition-colors ${
                  perceptionEnabled
                    ? 'border-cyan-400/70 text-cyan-300 bg-cyan-400/10'
                    : 'border-white/20 text-white/50 hover:text-white/80 hover:border-white/40'
                }`}
              >
                {perceptionEnabled ? 'Yüz Algısı Açık' : 'Yüz Algısı Kapalı'}
              </button>
            </div>
          </div>
        )}
        
        {/* Center - Avatar */}
        <div
          className={`flex-1 flex flex-col items-center justify-center ${
            avatarFullscreen ? 'w-full h-[100dvh]' : ''
          }`}
        >
          {perception && !avatarFullscreen && (
            <div className="mb-3 text-xs font-extralight tracking-wider text-cyan-400/70">
              {getPerceptionText()}
            </div>
          )}
          <div className="relative">
            {/* Tech frame */}
            {!avatarFullscreen && (
              <div className="absolute -inset-4 border border-white/10 rounded-lg">
                <div className="absolute top-0 left-0 w-3 h-3 border-t border-l border-[#c3144d]/30" />
                <div className="absolute top-0 right-0 w-3 h-3 border-t border-r border-[#c3144d]/30" />
                <div className="absolute bottom-0 left-0 w-3 h-3 border-b border-l border-[#c3144d]/30" />
                <div className="absolute bottom-0 right-0 w-3 h-3 border-b border-r border-[#c3144d]/30" />
              </div>
            )}
            
            {/* Video container */}
            <div
              className={`relative overflow-hidden ${
                avatarFullscreen
                  ? 'w-[100vw] h-[100dvh] rounded-none bg-black'
                  : 'w-56 h-56 sm:w-64 sm:h-64 md:w-80 md:h-80 bg-black/50 rounded'
              }`}
            >
              <video
                ref={videoRef}
                autoPlay
                playsInline
                className={`w-full h-full object-cover ${simliReady ? 'opacity-100' : 'opacity-0'}`}
              />
              <audio ref={audioRef} autoPlay playsInline />
              <video ref={perceptionVideoRef} muted playsInline className="hidden" />
              
              {!simliReady && (
                <div className="absolute inset-0 flex items-center justify-center">
                  <div className="w-8 h-8 border border-white/30 border-t-white rounded-full animate-spin" />
                </div>
              )}
            </div>
          </div>
          
          {!avatarFullscreen && (
            <>
              {/* Name & Title - below avatar */}
              <div className="mt-6 text-center">
                <div className="text-white/80 font-light text-lg tracking-wide">
                  {activeAvatar || config?.character_name || 'AI'}
                </div>
                <div className="text-white/50 text-xs font-extralight tracking-widest mt-1">
                  ALGORITMA KIRICI
                </div>
              </div>

              {/* Response text - below name */}
              {response && (
                <div className="mt-6 max-w-lg px-4">
                  <p className="text-white/70 text-sm font-light text-center leading-relaxed">
                    "{response}"
                  </p>
                </div>
              )}
            </>
          )}
        </div>
        
        {/* Bottom - Microphone & Status */}
        {!avatarFullscreen && (
          <div className="w-full max-w-md px-2 sm:px-4 space-y-4">
          {deviceProfile.isMobile && !perceptionEnabled && (
            <p className="text-center text-[10px] text-white/35 tracking-wide">
              Mobil profil: yüz algısı batarya ve performans için kapalı.
            </p>
          )}
          
          {/* Current transcript */}
          {(transcript || interimTranscript) && (
            <div className="text-center">
              <p className="text-cyan-400/60 text-sm font-light">
                {transcript}<span className="text-cyan-400/30 italic">{interimTranscript}</span>
              </p>
            </div>
          )}
          
          {/* Microphone button - single click toggle */}
          <div className="flex justify-center">
            <button
              onClick={toggleMic}
              disabled={state === STATES.THINKING || state === STATES.SPEAKING || !config}
              className={`relative w-20 h-20 rounded-full border-2 transition-all duration-300 flex items-center justify-center
                ${micActive 
                  ? 'bg-[#c3144d]/20 border-[#c3144d]' 
                  : 'bg-white/5 border-white/20 hover:border-[#c3144d]/50 hover:bg-white/10'}
                ${(state === STATES.THINKING || state === STATES.SPEAKING) ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
              `}
            >
              {/* Pulse ring when active */}
              {micActive && state === STATES.LISTENING && (
                <div className="absolute inset-0 rounded-full border-2 border-[#c3144d] animate-ping opacity-20" />
              )}
              
              {/* Mic icon */}
              <svg 
                viewBox="0 0 24 24" 
                className={`w-8 h-8 transition-colors duration-300 ${micActive ? 'text-[#c3144d]' : 'text-white/60'}`} 
                fill="currentColor"
              >
                <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/>
                <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/>
              </svg>
            </button>
          </div>
          
          {/* State text */}
          <p className={`text-center text-xs font-extralight tracking-wider ${
            state === STATES.LISTENING ? 'text-cyan-400/80' :
            state === STATES.THINKING ? 'text-yellow-400/80' :
            state === STATES.SPEAKING ? 'text-purple-400/80' :
            micActive ? 'text-[#c3144d]/60' : 'text-white/30'
          }`}>
            {getStateText()}
          </p>
          
          {/* Error display */}
          {error && (
            <div className="text-center text-red-400/80 text-xs font-light">{error}</div>
          )}
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
