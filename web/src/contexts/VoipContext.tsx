import { createContext, useContext, useRef, useState, useEffect, useCallback } from "react";
import JsSIP from "jssip";
import { trpc } from "../lib/trpc";

export type CallStatus =
  | "idle"
  | "registering"
  | "registered"
  | "failed_register"
  | "connecting"
  | "ringing"
  | "in_call"
  | "ended";

interface VoipContextType {
  callStatus: CallStatus;
  setCallStatus: React.Dispatch<React.SetStateAction<CallStatus>>;
  sessionRef: React.MutableRefObject<any>;
  localStreamRef: React.MutableRefObject<MediaStream | null>;
  remoteAudioRef: React.MutableRefObject<HTMLAudioElement | null>;
  uaRef: React.MutableRefObject<any>;
  callSeconds: number;
  callSecondsRef: React.MutableRefObject<number>;
  startTimer: () => void;
  stopTimer: () => void;
  startRingback: (incoming: boolean) => void;
  stopRingback: () => void;
  incomingCallerInfo: string;
  isIncomingCall: boolean;
  setIsIncomingCall: React.Dispatch<React.SetStateAction<boolean>>;
  playRemoteStream: (stream: MediaStream) => void;
  atender: () => void;
  rejeitar: () => void;
  registrar: () => void;
  voipConfig: any;
  setOutgoingLigacaoId: (id: string) => void;
  activeDealId: string | null;
  primeAudio: () => void;
  ligar: (numero: string, did?: string, dealId?: string) => Promise<void>;
  micVolume: number;
  speakerVolume: number;
  setMicVolume: (v: number) => void;
  setSpeakerVolume: (v: number) => void;
  getMicStream: () => Promise<MediaStream>;
  stopLocalMicStream: () => void;
  activateMicVolumeChain: (session: any) => Promise<void>;
}

const VoipContext = createContext<VoipContextType | null>(null);

export function useVoip() {
  const ctx = useContext(VoipContext);
  if (!ctx) throw new Error("useVoip must be used inside VoipProvider");
  return ctx;
}

export function VoipProvider({ children }: { children: React.ReactNode }) {
  const [callStatus, setCallStatusState] = useState<CallStatus>("idle");
  // wrap setter so callStatusRef stays in sync
  const setCallStatus = (v: CallStatus | ((p: CallStatus) => CallStatus)) => {
    setCallStatusState(prev => {
      const next = typeof v === "function" ? v(prev) : v;
      callStatusRef.current = next;
      return next;
    });
  };
  const [callSeconds, setCallSeconds] = useState(0);
  const [incomingCallerInfo, setIncomingCallerInfo] = useState("");
  const [isIncomingCall, setIsIncomingCall] = useState(false);
  const [activeDealId, setActiveDealId] = useState<string | null>(null);

  const uaRef = useRef<any>(null);
  const wsRef = useRef<any>(null);
  const reconnectTimerRef = useRef<NodeJS.Timeout | null>(null);
  const callStatusRef = useRef<CallStatus>("idle");
  const sessionRef = useRef<any>(null);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const ringbackCtxRef = useRef<AudioContext | null>(null);
  const ringbackTimerRef = useRef<NodeJS.Timeout | null>(null);
  const callSecondsRef = useRef(0);
  const remoteAudioCtxRef = useRef<AudioContext | null>(null);
  const remoteSourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);

  const [micVolume, setMicVolumeState] = useState(100);
  const [speakerVolume, setSpeakerVolumeState] = useState(100);
  const micVolumeRef = useRef(100);
  const speakerVolumeRef = useRef(100);
  const micGainNodeRef = useRef<GainNode | null>(null);
  const speakerGainNodeRef = useRef<GainNode | null>(null);
  const rawLocalStreamRef = useRef<MediaStream | null>(null);

  // Incoming call tracking
  const incomingLigacaoIdRef = useRef<string | null>(null);
  const incomingCallerNumberRef = useRef<string>("");

  // Recording
  const recordingLigacaoIdRef = useRef<string | null>(null);
  const pendingRemoteStreamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);

  const voipConfig = trpc.ligacoes.getVoipConfigGlobal.useQuery();
  const registrarEntranteMut = trpc.ligacoes.registrarEntrante.useMutation();
  const atualizarLigacaoMut = trpc.ligacoes.atualizar.useMutation();
  const iniciarSaidaMut = trpc.ligacoes.iniciar.useMutation();

  const registrarRef = useRef<() => void>(() => {});
  const registrarEntranteMutRef = useRef(registrarEntranteMut.mutate);
  const atualizarLigacaoMutRef = useRef(atualizarLigacaoMut.mutate);
  const iniciarSaidaMutRef = useRef(iniciarSaidaMut.mutate);
  registrarEntranteMutRef.current = registrarEntranteMut.mutate;
  atualizarLigacaoMutRef.current = atualizarLigacaoMut.mutate;
  iniciarSaidaMutRef.current = iniciarSaidaMut.mutate;

  function stopRingback() {
    if (ringbackTimerRef.current) { clearInterval(ringbackTimerRef.current); ringbackTimerRef.current = null; }
    // Don't close if it's the shared remote audio context
    if (ringbackCtxRef.current && ringbackCtxRef.current !== remoteAudioCtxRef.current) {
      ringbackCtxRef.current.close().catch(() => {});
    }
    ringbackCtxRef.current = null;
  }

  function startRingback(incoming: boolean) {
    stopRingback();
    try {
      // Prefer the pre-warmed remote audio context to avoid autoplay blocking
      const shared = remoteAudioCtxRef.current;
      const ctx = (shared && shared.state !== "closed") ? shared : new AudioContext();
      ringbackCtxRef.current = ctx;
      const freq = incoming ? 480 : 425;
      const period = incoming ? 3000 : 5000;
      function beep() {
        if (!ringbackCtxRef.current) return;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        gain.gain.value = 0.15;
        osc.type = "sine"; osc.frequency.value = freq;
        osc.connect(gain); gain.connect(ctx.destination);
        osc.start(); osc.stop(ctx.currentTime + 1.0);
      }
      ctx.resume().then(beep).catch(() => {});
      ringbackTimerRef.current = setInterval(() => { if (ctx.state === "running") beep(); }, period);
    } catch {}
  }

  function startTimer() {
    callSecondsRef.current = 0;
    setCallSeconds(0);
    timerRef.current = setInterval(() => {
      callSecondsRef.current += 1;
      setCallSeconds(callSecondsRef.current);
    }, 1000);
  }

  function stopTimer() {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
  }

  // ── Recording ────────────────────────────────────────────────────────────────

  function startCallRecording(stream: MediaStream) {
    console.log("[VoIP] startCallRecording called, already recording:", !!mediaRecorderRef.current, "tracks:", stream.getAudioTracks().length, "trackStates:", stream.getAudioTracks().map(t => t.readyState));
    if (mediaRecorderRef.current) return;
    recordedChunksRef.current = [];
    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : MediaRecorder.isTypeSupported("audio/webm")
        ? "audio/webm"
        : "";
    if (!mimeType) {
      console.warn("[VoIP] MediaRecorder: unsupported format");
      return;
    }
    if (!stream.getAudioTracks().length) {
      console.warn("[VoIP] MediaRecorder: no audio tracks");
      return;
    }
    try {
      const recorder = new MediaRecorder(stream, { mimeType });
      recorder.ondataavailable = (e) => {
        console.log("[VoIP] data available:", e.data.size, "bytes");
        if (e.data.size > 0) recordedChunksRef.current.push(e.data);
      };
      recorder.onerror = (e) => console.error("[VoIP] MediaRecorder error:", e);
      recorder.start(3000);
      mediaRecorderRef.current = recorder;
      console.log("[VoIP] Recording started OK, mimeType:", mimeType);
    } catch (e) {
      console.error("[VoIP] MediaRecorder start failed:", e);
    }
  }

  function stopAndUploadRecording() {
    const recorder = mediaRecorderRef.current;
    const ligacaoId = recordingLigacaoIdRef.current;
    if (!recorder || recorder.state === "inactive") {
      mediaRecorderRef.current = null;
      return;
    }
    recorder.addEventListener("stop", () => {
      if (!ligacaoId) return;
      const chunks = recordedChunksRef.current;
      recordedChunksRef.current = [];
      if (!chunks.length) return;
      const blob = new Blob(chunks, { type: "audio/webm" });
      if (blob.size < 2000) return;
      const token = localStorage.getItem("avoce_token");
      if (!token) return;
      const form = new FormData();
      form.append("audio", blob, "call.webm");
      fetch(`/api/ligacao/${ligacaoId}/audio`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      }).catch(() => {});
    }, { once: true });
    recorder.stop();
    mediaRecorderRef.current = null;
    recordingLigacaoIdRef.current = null;
    pendingRemoteStreamRef.current = null;
  }

  // ── Audio playback ───────────────────────────────────────────────────────────

  function playRemoteStream(stream: MediaStream) {
    pendingRemoteStreamRef.current = stream;
    console.log("[VoIP] playRemoteStream called, tracks:", stream.getAudioTracks().length, "recordingLigacaoId:", recordingLigacaoIdRef.current, "alreadyRecording:", !!mediaRecorderRef.current);
    // Auto-start recording when stream arrives if ligacaoId is ready
    if (recordingLigacaoIdRef.current && !mediaRecorderRef.current) {
      startCallRecording(stream);
    }
    // Play via HTMLMediaElement only — using AudioContext here would double-play the remote audio,
    // confusing Chrome's AEC into suppressing the outgoing mic signal.
    if (remoteAudioRef.current) {
      remoteAudioRef.current.volume = speakerVolumeRef.current / 100;
      remoteAudioRef.current.srcObject = stream;
      remoteAudioRef.current.muted = false;
      remoteAudioRef.current.play().catch(() => {
        if (!remoteAudioRef.current) return;
        remoteAudioRef.current.muted = true;
        remoteAudioRef.current.play()
          .then(() => { if (remoteAudioRef.current) remoteAudioRef.current.muted = false; })
          .catch(() => {});
      });
    }
  }

  // Called by Telefone.tsx when the outgoing call ligacaoId is known
  function setOutgoingLigacaoId(id: string) {
    recordingLigacaoIdRef.current = id;
    console.log("[VoIP] setOutgoingLigacaoId called, id:", id, "pendingStream:", !!pendingRemoteStreamRef.current, "alreadyRecording:", !!mediaRecorderRef.current);
    if (pendingRemoteStreamRef.current && !mediaRecorderRef.current) {
      startCallRecording(pendingRemoteStreamRef.current);
    }
  }

  function stopRemoteAudio() {
    try { remoteSourceNodeRef.current?.disconnect(); } catch {}
    remoteSourceNodeRef.current = null;
    remoteAudioCtxRef.current?.close().catch(() => {});
    remoteAudioCtxRef.current = null;
    if (remoteAudioRef.current) remoteAudioRef.current.srcObject = null;
  }

  function attachTrackToAudio(e: RTCTrackEvent) {
    if (e.track.kind !== "audio") return;
    const stream = (e.streams && e.streams.length > 0) ? e.streams[0] : new MediaStream([e.track]);
    playRemoteStream(stream);
  }

  const setupUA = useCallback((ua: any) => {
    ua.on("registered", () => { if (uaRef.current === ua) setCallStatus("registered"); });
    ua.on("registrationFailed", () => { if (uaRef.current === ua) setCallStatus("failed_register"); });
    ua.on("disconnected", () => {
      if (uaRef.current !== ua) return; // UA antigo — ignorar evento stale
      setCallStatus(prev => (prev === "in_call" || prev === "ringing") ? prev : "idle");
      // Se JsSIP não reconectar sozinho em 15s, forçar novo registro
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = setTimeout(() => {
        if (uaRef.current === ua) {
          try { ua.stop(); } catch {}
          uaRef.current = null;
          registrarRef.current();
        }
      }, 15000);
    });
    ua.on("newRTCSession", ({ session }: any) => {
      setIsIncomingCall(false);
      session.on("peerconnection", (data: any) => {
        data.peerconnection.addEventListener("track", attachTrackToAudio);
      });
      if (session.direction === "incoming") {
        sessionRef.current = session;
        incomingLigacaoIdRef.current = null;

        const callerUser = session.remote_identity?.uri?.user ?? "";
        const callerName = session.remote_identity?.display_name ?? "";
        const isAnonymous = !callerUser || callerUser === "anonymous" || callerUser === "unknown";
        incomingCallerNumberRef.current = isAnonymous ? "" : callerUser;

        const displayText = isAnonymous
          ? "Número privado"
          : callerName
            ? `${callerName} (${callerUser})`
            : callerUser;
        setIncomingCallerInfo(displayText);
        setIsIncomingCall(true);
        setCallStatus("ringing");
        startRingback(true);

        session.on("ended", () => {
          stopAndUploadRecording();
          const lid = incomingLigacaoIdRef.current;
          if (lid) {
            atualizarLigacaoMutRef.current({ id: lid, status: "ENCERRADA", duracao: callSecondsRef.current });
          } else {
            const num = incomingCallerNumberRef.current;
            if (num) registrarEntranteMutRef.current({ numeroOrigem: num, status: "SEM_RESPOSTA" });
          }
          stopTimer(); stopRingback(); stopRemoteAudio(); stopLocalMicStream();
          setIncomingCallerInfo(""); setIsIncomingCall(false);
          incomingLigacaoIdRef.current = null;
          setCallStatus("registered");
        });
        session.on("failed", () => {
          stopAndUploadRecording();
          const lid = incomingLigacaoIdRef.current;
          if (lid) {
            atualizarLigacaoMutRef.current({ id: lid, status: "SEM_RESPOSTA", duracao: callSecondsRef.current });
          } else {
            const num = incomingCallerNumberRef.current;
            if (num) registrarEntranteMutRef.current({ numeroOrigem: num, status: "SEM_RESPOSTA" });
          }
          stopTimer(); stopRingback(); stopRemoteAudio(); stopLocalMicStream();
          setIncomingCallerInfo(""); setIsIncomingCall(false);
          incomingLigacaoIdRef.current = null;
          setCallStatus("registered");
        });
      } else {
        session.on("ended", () => {
          stopAndUploadRecording();
          stopRemoteAudio();
        });
        session.on("failed", () => {
          stopAndUploadRecording();
          stopRemoteAudio();
        });
      }
    });
    ua.start();
    uaRef.current = ua;
    setCallStatus("registering");
  }, []); // eslint-disable-line

  const registrar = useCallback(() => {
    const cfg = voipConfig.data;
    const wss = cfg?.voipAsteriskWss ?? localStorage.getItem("voip_wss") ?? "";
    const ext = cfg?.voipSipExtension ?? localStorage.getItem("voip_ext") ?? "";
    const pass = cfg?.voipSipPassword ?? localStorage.getItem("voip_pass") ?? "";
    const domain = cfg?.voipSipDomain ?? wss.replace(/wss?:\/\//, "").split("/")[0] ?? "";
    if (!wss || !ext || !pass || !domain) return;

    if (uaRef.current) { try { uaRef.current.stop(); } catch {} uaRef.current = null; }

    const socket = new JsSIP.WebSocketInterface(wss);
    wsRef.current = socket;
    const ua = new JsSIP.UA({
      sockets: [socket],
      uri: `sip:${ext}@${domain}`,
      password: pass,
      register: true,
      register_expires: 300,
      connection_recovery_min_interval: 2,
      connection_recovery_max_interval: 30,
    });
    setupUA(ua);
  }, [voipConfig.data, setupUA]);

  // Keep ref updated so reconnect timer in setupUA always calls the latest version
  registrarRef.current = registrar;

  useEffect(() => {
    if (!uaRef.current) {
      registrar();
    }
  }, [voipConfig.data]); // eslint-disable-line

  // Reconectar ao VoIP quando usuário volta à aba após estar ausente
  useEffect(() => {
    function handleVisibility() {
      if (document.visibilityState === "visible") {
        const status = callStatus;
        if (status === "idle" || status === "failed_register") {
          registrarRef.current();
        }
      }
    }
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, [callStatus]);

  // Warm AudioContext on any user click — ensures ring sound works on incoming calls (browser autoplay policy)
  useEffect(() => {
    function warmAudio() {
      try {
        if (!remoteAudioCtxRef.current || remoteAudioCtxRef.current.state === "closed") {
          remoteAudioCtxRef.current = new AudioContext();
        }
        remoteAudioCtxRef.current.resume().catch(() => {});
      } catch {}
    }
    document.addEventListener("click", warmAudio, { passive: true });
    return () => document.removeEventListener("click", warmAudio);
  }, []);

  // Keepalive + health-check: CRLF a cada 20s; tenta reconectar se ficar idle/failed por >60s
  useEffect(() => {
    let idleSince: number | null = null;
    const interval = setInterval(() => {
      // Keepalive WebSocket
      const ws = wsRef.current?._ws;
      if (ws?.readyState === 1) {
        try { ws.send('\r\n'); } catch {}
      }
      // Health-check: se não está registrado, reagendar após 60s sem UA
      const status = callStatusRef.current;
      if (status === "idle" || status === "failed_register") {
        if (idleSince === null) { idleSince = Date.now(); }
        else if (Date.now() - idleSince > 60_000) {
          idleSince = null;
          registrarRef.current();
        }
      } else {
        idleSince = null;
      }
    }, 20000);
    return () => clearInterval(interval);
  }, []);

  function primeAudio() {
    try {
      if (!remoteAudioCtxRef.current || remoteAudioCtxRef.current.state === "closed") {
        remoteAudioCtxRef.current = new AudioContext();
      }
      remoteAudioCtxRef.current.resume().catch(() => {});
    } catch {}
  }

  async function getMicStream(): Promise<MediaStream> {
    const raw = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: true },
      video: false,
    });
    rawLocalStreamRef.current = raw;
    // Return raw stream directly — processed chain is applied via replaceTrack after call connects
    // (avoids Chrome "muted track" issue when createMediaStreamDestination track hasn't started yet)
    return raw;
  }

  async function activateMicVolumeChain(session: any) {
    const raw = rawLocalStreamRef.current;
    if (!raw) return;
    let ctx = remoteAudioCtxRef.current;
    if (!ctx || ctx.state === "closed") {
      ctx = new AudioContext();
      remoteAudioCtxRef.current = ctx;
    }
    await ctx.resume().catch(() => {});
    const source = ctx.createMediaStreamSource(raw);
    const gain = ctx.createGain();
    gain.gain.value = micVolumeRef.current / 100;
    micGainNodeRef.current = gain;
    const dest = ctx.createMediaStreamDestination();
    source.connect(gain);
    gain.connect(dest);
    // Wait for AudioContext to produce audio frames before replacing track
    await new Promise<void>(resolve => setTimeout(resolve, 100));
    const processed = dest.stream.getAudioTracks()[0];
    if (!processed) return;
    const conn: RTCPeerConnection | undefined = session?.connection;
    if (!conn) return;
    for (const sender of conn.getSenders()) {
      if (sender.track?.kind === "audio") {
        try { await sender.replaceTrack(processed); } catch {}
      }
    }
  }

  function stopLocalMicStream() {
    rawLocalStreamRef.current?.getTracks().forEach(t => t.stop());
    rawLocalStreamRef.current = null;
    micGainNodeRef.current = null;
  }

  function setMicVolume(v: number) {
    micVolumeRef.current = v;
    setMicVolumeState(v);
    if (micGainNodeRef.current) micGainNodeRef.current.gain.value = v / 100;
  }

  function setSpeakerVolume(v: number) {
    speakerVolumeRef.current = v;
    setSpeakerVolumeState(v);
    if (speakerGainNodeRef.current) speakerGainNodeRef.current.gain.value = v / 100;
    if (remoteAudioRef.current) remoteAudioRef.current.volume = v / 100;
  }

  async function ligar(numero: string, did = "1", dealId?: string) {
    if (!uaRef.current || callStatus !== "registered") {
      registrar();
      return;
    }
    const phone = numero.replace(/\D/g, "");
    if (!phone) return;

    const cfg = voipConfig.data;
    const wss = cfg?.voipAsteriskWss ?? localStorage.getItem("voip_wss") ?? "";
    const domain = cfg?.voipSipDomain ?? wss.replace(/wss?:\/\//, "").split("/")[0] ?? "";

    // Pré-criar AudioContext durante gesto do usuário — evita autoplay blocked
    try {
      if (!remoteAudioCtxRef.current || remoteAudioCtxRef.current.state === "closed") {
        remoteAudioCtxRef.current = new AudioContext();
      }
      await remoteAudioCtxRef.current.resume();
    } catch {}

    let stream: MediaStream;
    try {
      stream = await getMicStream();
    }
    catch { alert("Sem permissão para usar o microfone."); return; }
    localStreamRef.current = stream;

    setActiveDealId(dealId ?? null);
    setIsIncomingCall(false);
    const dialTarget = did === "2" ? `L2${phone}` : did === "3" ? `L3${phone}` : phone;
    const session = uaRef.current.call(`sip:${dialTarget}@${domain}`, {
      mediaConstraints: { audio: true, video: false },
      mediaStream: stream,
      extraHeaders: [],
      pcConfig: {
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
        iceCandidatePoolSize: 2,
      },
      sessionDescriptionHandlerOptions: {
        constraints: { audio: true, video: false },
      },
    });
    sessionRef.current = session;
    setCallStatus("connecting");

    const ligacaoIdRef = { current: null as string | null };
    iniciarSaidaMutRef.current(
      { emitenteId: cfg?.emitenteId, numeroDestino: phone, did, dealId },
      { onSuccess: (res) => {
        ligacaoIdRef.current = res.ligacaoId;
        recordingLigacaoIdRef.current = res.ligacaoId;
        setOutgoingLigacaoId(res.ligacaoId);
      }}
    );

    session.on("progress", () => { setCallStatus("ringing"); startRingback(false); });
    session.on("accepted", () => {
      stopRingback();
      setCallStatus("in_call");
      startTimer();
      if (ligacaoIdRef.current) atualizarLigacaoMutRef.current({ id: ligacaoIdRef.current, status: "EM_ANDAMENTO" });
      // Tocar stream pendente (track pode ter chegado antes do accepted)
      if (pendingRemoteStreamRef.current) {
        playRemoteStream(pendingRemoteStreamRef.current);
      }
      // Otimizar bitrate Opus para voz (24kbps — excelente qualidade com baixa latência)
      const conn = session.connection as RTCPeerConnection | undefined;
      if (conn) {
        conn.getSenders().forEach(async (sender) => {
          if (sender.track?.kind !== "audio") return;
          try {
            const params = sender.getParameters();
            if (params.encodings?.length) {
              params.encodings[0].maxBitrate = 24000;
              await sender.setParameters(params);
            }
          } catch {}
        });
      }
      // Fallback via RTCRtpReceiver
      setTimeout(() => {
        if (!conn) return;
        const rx = (conn.getReceivers() as RTCRtpReceiver[]).find(r => r.track?.kind === "audio" && r.track.readyState === "live");
        if (rx?.track) playRemoteStream(new MediaStream([rx.track]));
      }, 1000);
    });
    session.on("failed", (e: any) => {
      stopRingback(); setCallStatus("ended"); stopTimer();
      stream.getTracks().forEach(t => t.stop());
      stopLocalMicStream();
      setActiveDealId(null);
      const cause = e.cause ?? "FALHOU";
      const st = cause === "Busy" ? "OCUPADO" : cause === "No Answer" ? "SEM_RESPOSTA" : "FALHOU";
      if (ligacaoIdRef.current) atualizarLigacaoMutRef.current({ id: ligacaoIdRef.current, status: st, duracao: callSecondsRef.current });
      setTimeout(() => setCallStatus(uaRef.current ? "registered" : "idle"), 3000);
    });
    session.on("ended", () => {
      stopRingback(); setCallStatus("ended"); stopTimer();
      stream.getTracks().forEach(t => t.stop());
      stopLocalMicStream();
      setActiveDealId(null);
      if (ligacaoIdRef.current) atualizarLigacaoMutRef.current({ id: ligacaoIdRef.current, status: "ENCERRADA", duracao: callSecondsRef.current });
      setTimeout(() => setCallStatus(uaRef.current ? "registered" : "idle"), 2000);
    });
  }

  async function atender() {
    const session = sessionRef.current;
    if (!session || session.direction !== "incoming") return;
    stopRingback();
    setIsIncomingCall(false);

    // Pré-criar AudioContext durante gesto do usuário (clique em Atender)
    // O track event pode ter chegado antes do clique — o contexto ficava suspended
    try {
      if (!remoteAudioCtxRef.current || remoteAudioCtxRef.current.state === "closed") {
        remoteAudioCtxRef.current = new AudioContext();
      }
      remoteAudioCtxRef.current.resume().catch(() => {});
    } catch {}

    // Se já há stream pendente (track chegou antes do atender), tocar imediatamente
    if (pendingRemoteStreamRef.current) {
      playRemoteStream(pendingRemoteStreamRef.current);
    }

    let micStream: MediaStream | undefined;
    try { micStream = await getMicStream(); } catch {}

    const answerOpts: any = {
      pcConfig: {
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
        iceCandidatePoolSize: 2,
      },
    };
    if (micStream) {
      answerOpts.mediaStream = micStream;
    } else {
      answerOpts.mediaConstraints = { audio: true, video: false };
    }
    session.answer(answerOpts);
    setCallStatus("in_call");
    startTimer();

    registrarEntranteMut.mutate(
      { numeroOrigem: incomingCallerNumberRef.current || "Desconhecido", status: "EM_ANDAMENTO" },
      { onSuccess: (res) => {
        incomingLigacaoIdRef.current = res.ligacaoId;
        recordingLigacaoIdRef.current = res.ligacaoId;
        if (pendingRemoteStreamRef.current && !mediaRecorderRef.current) {
          startCallRecording(pendingRemoteStreamRef.current);
        }
      }}
    );

    // Fallback: se o track ainda não chegou, buscar via RTCRtpReceiver
    setTimeout(() => {
      const conn = session.connection;
      if (!conn) return;
      const rx = (conn.getReceivers() as RTCRtpReceiver[]).find(r => r.track?.kind === "audio" && r.track.readyState === "live");
      if (rx?.track) playRemoteStream(new MediaStream([rx.track]));
    }, 1000);
  }

  function rejeitar() {
    stopRingback();
    setIsIncomingCall(false);
    const num = incomingCallerNumberRef.current;
    if (num) registrarEntranteMut.mutate({ numeroOrigem: num, status: "SEM_RESPOSTA" });
    sessionRef.current?.terminate({ status_code: 486 });
    sessionRef.current = null;
    setIncomingCallerInfo("");
    incomingLigacaoIdRef.current = null;
    setCallStatus("registered");
  }

  return (
    <VoipContext.Provider value={{
      callStatus, setCallStatus,
      sessionRef, localStreamRef, remoteAudioRef, uaRef,
      callSeconds, callSecondsRef, startTimer, stopTimer,
      startRingback, stopRingback,
      incomingCallerInfo, isIncomingCall, setIsIncomingCall, playRemoteStream,
      atender, rejeitar, registrar, ligar, primeAudio,
      voipConfig: voipConfig.data,
      setOutgoingLigacaoId,
      activeDealId,
      micVolume, speakerVolume, setMicVolume, setSpeakerVolume,
      getMicStream, stopLocalMicStream, activateMicVolumeChain,
    }}>
      <audio ref={remoteAudioRef} autoPlay playsInline style={{ display: "none" }} />
      {children}
    </VoipContext.Provider>
  );
}
