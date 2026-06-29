import { useState, useRef } from "react";
import { Phone, PhoneOff, PhoneCall, PhoneMissed, Clock, Mic, MicOff, Settings, User, Volume2 } from "lucide-react";
import { trpc } from "../lib/trpc";
import { useVoip } from "../contexts/VoipContext";

type Ligacao = {
  id: string;
  numeroOrigem: string;
  numeroDestino: string;
  status: string;
  duracao: number | null;
  iniciadaEm: string;
  encerradaEm: string | null;
  notas: string | null;
  resumo: string | null;
  transcricao?: string | null;
  contato?: { nome: string; whatsapp: string | null } | null;
};

function formatDuracao(seg: number | null | undefined) {
  if (seg == null) return "—";
  const m = Math.floor(seg / 60), s = seg % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

const STATUS_COLORS: Record<string, string> = {
  DISCANDO: "text-yellow-600",
  EM_ANDAMENTO: "text-green-600",
  ENCERRADA: "text-gray-500",
  FALHOU: "text-red-600",
  SEM_RESPOSTA: "text-orange-500",
  OCUPADO: "text-red-500",
};

const STATUS_LABELS: Record<string, string> = {
  DISCANDO: "Discando",
  EM_ANDAMENTO: "Em andamento",
  ENCERRADA: "Encerrada",
  FALHOU: "Falhou",
  SEM_RESPOSTA: "Sem resposta",
  OCUPADO: "Ocupado",
};

export default function TelefonePage() {
  const {
    callStatus, setCallStatus,
    uaRef, sessionRef, localStreamRef, remoteAudioRef,
    callSeconds, callSecondsRef, startTimer, stopTimer,
    startRingback, stopRingback,
    playRemoteStream, setIsIncomingCall,
    atender, rejeitar, registrar, primeAudio,
    voipConfig, setOutgoingLigacaoId,
    micVolume, speakerVolume, setMicVolume, setSpeakerVolume,
    getMicStream, stopLocalMicStream, activateMicVolumeChain,
  } = useVoip();

  const [numero, setNumero] = useState("");
  const [ligacaoId, setLigacaoId] = useState<string | null>(null);
  const ligacaoIdRef = useRef<string | null>(null);
  const [selectedDid, setSelectedDid] = useState<string>("1");
  const [isMuted, setIsMuted] = useState(false);
  const [selectedLigacao, setSelectedLigacao] = useState<Ligacao | null>(null);
  const [notasEdit, setNotasEdit] = useState("");
  const [showDialpad, setShowDialpad] = useState(true);
  const [dtmfBuffer, setDtmfBuffer] = useState("");
  const [sipLocalExt, setSipLocalExt] = useState("");
  const [sipLocalPass, setSipLocalPass] = useState("");
  const [showSipConfig, setShowSipConfig] = useState(false);
  const [sipLocalWss, setSipLocalWss] = useState("");

  const historico  = trpc.ligacoes.listarTodos.useQuery({ limit: 50 }, { refetchInterval: 15_000 });
  const iniciarMut  = trpc.ligacoes.iniciar.useMutation();
  const atualizarMut = trpc.ligacoes.atualizar.useMutation({ onSuccess: () => historico.refetch() });
  const getLigacao  = trpc.ligacoes.getLigacao.useQuery(
    { id: selectedLigacao?.id ?? "" },
    { enabled: !!selectedLigacao?.id, refetchInterval: selectedLigacao?.id ? 5_000 : false }
  );

  async function ligar(phoneOverride?: string, didOverride?: string) {
    if (!uaRef.current || callStatus !== "registered") {
      registrar();
      return;
    }
    const raw = (phoneOverride ?? numero).trim();
    if (!raw) return;

    setIsIncomingCall(false);

    const phone = raw.replace(/\D/g, "");
    const did = didOverride ?? selectedDid;
    const cfg = voipConfig;
    const wss = cfg?.voipAsteriskWss ?? localStorage.getItem("voip_wss") ?? "";
    const domain = cfg?.voipSipDomain ?? wss.replace(/wss?:\/\//, "").split("/")[0] ?? "";

    primeAudio();

    let stream: MediaStream;
    try {
      stream = await getMicStream();
    }
    catch { alert("Sem permissão para usar o microfone."); return; }
    localStreamRef.current = stream;

    const dialTarget = did === "2" ? `L2${phone}` : did === "3" ? `L3${phone}` : phone;
    const session = uaRef.current.call(`sip:${dialTarget}@${domain}`, {
      mediaConstraints: { audio: true, video: false },
      mediaStream: stream,
      pcConfig: {
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
        iceCandidatePoolSize: 2,
      },
    });
    sessionRef.current = session;
    setCallStatus("connecting");

    ligacaoIdRef.current = null;
    iniciarMut.mutate(
      { emitenteId: cfg?.emitenteId, numeroDestino: phone, did },
      { onSuccess: (res) => {
        ligacaoIdRef.current = res.ligacaoId;
        setLigacaoId(res.ligacaoId);
        setOutgoingLigacaoId(res.ligacaoId);
      }}
    );

    session.on("progress", () => { setCallStatus("ringing"); startRingback(false); });
    session.on("accepted", () => {
      stopRingback();
      setCallStatus("in_call");
      startTimer();
      if (ligacaoIdRef.current) atualizarMut.mutate({ id: ligacaoIdRef.current, status: "EM_ANDAMENTO" });
      setTimeout(() => {
        const conn = session.connection;
        if (!conn) return;
        // Force Opus bitrate after JsSIP re-offer may have reset the encoder
        conn.getSenders().forEach(async (sender: RTCRtpSender) => {
          if (sender.track?.kind !== "audio") return;
          try {
            const params = sender.getParameters();
            if (params.encodings?.length) {
              params.encodings[0].maxBitrate = 40000;
              await sender.setParameters(params);
            }
          } catch {}
        });
        // Fallback: if "track" event missed, pull audio from RTCRtpReceiver
        const rx = (conn.getReceivers() as RTCRtpReceiver[])
          .find(r => r.track?.kind === "audio" && r.track.readyState === "live");
        if (rx?.track) playRemoteStream(new MediaStream([rx.track]));
      }, 1000);
    });
    session.on("failed", (e: any) => {
      stopRingback();
      setCallStatus("ended");
      stopTimer();
      stream.getTracks().forEach(t => t.stop());
      stopLocalMicStream();
      const cause = e.cause ?? "FALHOU";
      const st = cause === "Busy" ? "OCUPADO" : cause === "No Answer" ? "SEM_RESPOSTA" : "FALHOU";
      if (ligacaoIdRef.current) atualizarMut.mutate({ id: ligacaoIdRef.current, status: st, duracao: callSecondsRef.current });
      setTimeout(() => setCallStatus(uaRef.current ? "registered" : "idle"), 3000);
    });
    session.on("ended", () => {
      stopRingback();
      setCallStatus("ended");
      stopTimer();
      stream.getTracks().forEach(t => t.stop());
      stopLocalMicStream();
      if (ligacaoIdRef.current) atualizarMut.mutate({ id: ligacaoIdRef.current, status: "ENCERRADA", duracao: callSecondsRef.current });
      setTimeout(() => setCallStatus(uaRef.current ? "registered" : "idle"), 2000);
    });
  }

  function desligar() {
    stopRingback();
    if (sessionRef.current) {
      try { sessionRef.current.terminate(); } catch {}
      sessionRef.current = null;
    }
    localStreamRef.current?.getTracks().forEach(t => t.stop());
    stopLocalMicStream();
    stopTimer();
    if (ligacaoIdRef.current) atualizarMut.mutate({ id: ligacaoIdRef.current, status: "ENCERRADA", duracao: callSecondsRef.current });
    setCallStatus(uaRef.current ? "registered" : "idle");
  }

  function toggleMute() {
    if (!sessionRef.current) return;
    const conn = sessionRef.current.connection;
    conn?.getSenders()?.forEach((s: any) => {
      if (s.track?.kind === "audio") s.track.enabled = isMuted;
    });
    setIsMuted(!isMuted);
  }

  function salvarSipConfig() {
    localStorage.setItem("voip_ext", sipLocalExt);
    localStorage.setItem("voip_pass", sipLocalPass);
    if (sipLocalWss) localStorage.setItem("voip_wss", sipLocalWss);
    setShowSipConfig(false);
    registrar();
  }

  const KEYPAD = ["1","2","3","4","5","6","7","8","9","*","0","#"] as const;

  function handleDialpadKey(k: string) {
    setNumero(prev => prev + k);
  }

  function handleDtmf(k: string) {
    try { sessionRef.current?.sendDTMF(k, { duration: 100, interToneGap: 70 }); } catch {}
    setDtmfBuffer(prev => (prev + k).slice(-12));
  }

  const isActive = callStatus === "connecting" || callStatus === "ringing" || callStatus === "in_call";
  const cfg = voipConfig;

  return (
    <div className="flex h-screen bg-gray-50">
      {/* Painel esquerdo — Discador */}
      <div className="w-80 bg-white border-r flex flex-col">
        <div className="p-5 border-b">
          <h1 className="text-lg font-bold text-gray-800 flex items-center gap-2">
            <Phone size={20} className="text-indigo-600" /> Telefone VoIP
          </h1>

          {/* Status de registro */}
          <div className={`mt-2 text-xs flex items-center gap-1 ${
            callStatus === "registered" ? "text-green-600" :
            callStatus === "registering" ? "text-yellow-500" :
            callStatus === "failed_register" ? "text-red-500" : "text-gray-400"
          }`}>
            <span className={`w-2 h-2 rounded-full ${
              callStatus === "registered" ? "bg-green-500" :
              callStatus === "registering" ? "bg-yellow-400 animate-pulse" :
              callStatus === "failed_register" ? "bg-red-500" : "bg-gray-300"
            }`} />
            {callStatus === "registered" ? "Registrado" :
             callStatus === "registering" ? "Conectando..." :
             callStatus === "failed_register" ? "Falha no registro" : "Desconectado"}
          </div>

          {(callStatus === "idle" || callStatus === "failed_register") && (
            <button onClick={registrar} className="mt-3 w-full text-xs bg-indigo-600 text-white py-1.5 rounded hover:bg-indigo-700">
              Conectar
            </button>
          )}
        </div>

        <div className="p-5 flex-1">
          {/* DIDs */}
          {cfg?.voipDid && (
            <div className="mb-4">
              <label className="text-xs text-gray-500 block mb-1">DID (Origem)</label>
              <div className="flex gap-1.5 flex-wrap">
                <button onClick={() => setSelectedDid("1")}
                  className={`flex-1 min-w-0 text-xs py-1.5 rounded border ${selectedDid === "1" ? "bg-indigo-50 border-indigo-400 text-indigo-700" : "border-gray-200 text-gray-600"}`}>
                  {cfg.voipDid1Label ?? cfg.voipDid}
                </button>
                {cfg.voipDid2 && (
                  <button onClick={() => setSelectedDid("2")}
                    className={`flex-1 min-w-0 text-xs py-1.5 rounded border ${selectedDid === "2" ? "bg-indigo-50 border-indigo-400 text-indigo-700" : "border-gray-200 text-gray-600"}`}>
                    {cfg.voipDid2Label ?? cfg.voipDid2}
                  </button>
                )}
                {cfg.voipDid3 && (
                  <button onClick={() => setSelectedDid("3")}
                    className={`flex-1 min-w-0 text-xs py-1.5 rounded border ${selectedDid === "3" ? "bg-indigo-50 border-indigo-400 text-indigo-700" : "border-gray-200 text-gray-600"}`}>
                    {cfg.voipDid3Label ?? cfg.voipDid3}
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Display / input de número */}
          <div className="flex gap-1 mb-2">
            <input
              value={numero}
              onChange={e => setNumero(e.target.value)}
              onKeyDown={e => e.key === "Enter" && !isActive && ligar()}
              placeholder="+55 (61) 9 9999-9999"
              disabled={isActive}
              className="flex-1 border rounded-lg px-3 py-2.5 text-sm font-mono outline-none focus:ring-2 focus:ring-indigo-300 disabled:bg-gray-50"
            />
            {!isActive && numero.length > 0 && (
              <button onClick={() => setNumero(p => p.slice(0,-1))}
                className="px-2.5 border rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-50">⌫</button>
            )}
            {!isActive && (
              <button onClick={() => setShowDialpad(p => !p)}
                title={showDialpad ? "Ocultar teclado" : "Abrir teclado"}
                className={`px-2.5 border rounded-lg text-sm transition-colors ${showDialpad ? "bg-indigo-100 border-indigo-300 text-indigo-700" : "bg-white border-gray-200 text-gray-400 hover:text-gray-700"}`}>
                ⌨
              </button>
            )}
          </div>

          {/* Teclado discador (estado idle) */}
          {!isActive && showDialpad && (
            <div className="grid grid-cols-3 gap-1.5 mb-3">
              {KEYPAD.map(k => (
                <button key={k} onClick={() => handleDialpadKey(k)}
                  className="py-3 rounded-xl bg-gray-50 border border-gray-200 text-base font-semibold text-gray-800 hover:bg-indigo-50 hover:border-indigo-200 active:bg-indigo-100 transition-colors select-none">
                  {k}
                </button>
              ))}
            </div>
          )}

          {/* Botões de chamada */}
          {!isActive ? (
            <button onClick={() => ligar()} disabled={!numero.trim() || callStatus === "registering"}
              className="w-full bg-green-500 text-white py-3 rounded-xl font-medium flex items-center justify-center gap-2 hover:bg-green-600 disabled:opacity-50">
              <Phone size={18} /> Ligar
            </button>
          ) : (
            <div className="space-y-2">
              {callStatus === "in_call" && (
                <div className="text-center text-sm font-mono text-green-700 bg-green-50 rounded-lg py-2">
                  {formatDuracao(callSeconds)}
                </div>
              )}
              {callStatus === "connecting" ? (
                <div className="space-y-2">
                  <div className="text-center text-xs text-blue-500 animate-pulse font-medium">Conectando...</div>
                  <button onClick={desligar}
                    className="w-full bg-gray-400 text-white py-2.5 rounded-xl font-medium flex items-center justify-center gap-2 hover:bg-gray-500">
                    <PhoneOff size={16} /> Cancelar
                  </button>
                </div>
              ) : callStatus === "ringing" && sessionRef.current?.direction === "incoming" ? (
                <div className="space-y-2">
                  <div className="text-center text-xs text-indigo-600 animate-pulse font-medium">Chamada recebida...</div>
                  <div className="flex gap-2">
                    <button onClick={atender}
                      className="flex-1 bg-green-500 text-white py-2.5 rounded-xl font-medium flex items-center justify-center gap-2 hover:bg-green-600">
                      <Phone size={16} /> Atender
                    </button>
                    <button onClick={rejeitar}
                      className="flex-1 bg-red-500 text-white py-2.5 rounded-xl flex items-center justify-center gap-2 hover:bg-red-600">
                      <PhoneOff size={16} /> Rejeitar
                    </button>
                  </div>
                </div>
              ) : callStatus === "ringing" ? (
                <div className="space-y-2">
                  <div className="text-center text-xs text-yellow-600 animate-pulse font-medium">Chamando...</div>
                  <button onClick={desligar}
                    className="w-full bg-gray-400 text-white py-2.5 rounded-xl font-medium flex items-center justify-center gap-2 hover:bg-gray-500">
                    <PhoneOff size={16} /> Desligar
                  </button>
                </div>
              ) : null}
              {callStatus === "in_call" && (
                <>
                  {/* DTMF keypad */}
                  <div className="bg-gray-50 rounded-xl border p-3">
                    <div className="mb-2 h-8 px-3 bg-white border border-gray-200 rounded-lg flex items-center">
                      {dtmfBuffer
                        ? <span className="font-mono text-sm tracking-widest text-gray-700">{dtmfBuffer}</span>
                        : <span className="text-xs text-gray-300">Teclado DTMF (URA / senhas)</span>}
                    </div>
                    <div className="grid grid-cols-3 gap-1.5">
                      {KEYPAD.map(k => (
                        <button key={k} onClick={() => handleDtmf(k)}
                          className="py-2.5 rounded-lg bg-white border border-gray-200 text-sm font-semibold text-gray-800 hover:bg-indigo-50 hover:border-indigo-200 active:bg-indigo-100 transition-colors select-none">
                          {k}
                        </button>
                      ))}
                    </div>
                  </div>
                  {/* Volume controls */}
                  <div className="bg-gray-50 rounded-xl border border-gray-200 p-3 space-y-2">
                    <div className="flex items-center gap-2">
                      <Mic size={13} className="text-gray-400 flex-shrink-0" />
                      <span className="text-xs text-gray-500 w-10">Mic</span>
                      <input
                        type="range" min="0" max="100" value={micVolume}
                        onChange={e => setMicVolume(Number(e.target.value))}
                        className="flex-1 accent-indigo-600 h-1.5"
                      />
                      <span className="text-xs text-gray-500 w-8 text-right">{micVolume}%</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Volume2 size={13} className="text-gray-400 flex-shrink-0" />
                      <span className="text-xs text-gray-500 w-10">Som</span>
                      <input
                        type="range" min="0" max="100" value={speakerVolume}
                        onChange={e => setSpeakerVolume(Number(e.target.value))}
                        className="flex-1 accent-indigo-600 h-1.5"
                      />
                      <span className="text-xs text-gray-500 w-8 text-right">{speakerVolume}%</span>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <button onClick={toggleMute}
                      className={`flex-1 py-2.5 rounded-xl border text-sm flex items-center justify-center gap-1 ${isMuted ? "bg-yellow-50 border-yellow-300 text-yellow-700" : "bg-gray-50 text-gray-600"}`}>
                      {isMuted ? <MicOff size={16} /> : <Mic size={16} />}
                      {isMuted ? "Ativar" : "Mudo"}
                    </button>
                    <button onClick={desligar}
                      className="flex-1 bg-red-500 text-white py-2.5 rounded-xl font-medium flex items-center justify-center gap-2 hover:bg-red-600">
                      <PhoneOff size={16} /> Desligar
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          <button onClick={() => setShowSipConfig(true)} className="mt-4 w-full text-xs text-gray-400 hover:text-gray-600 py-1">
            ⚙ Configurar SIP
          </button>
        </div>
      </div>

      {/* Painel direito — Histórico */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="bg-white border-b px-6 py-4">
          <h2 className="font-semibold text-gray-800">Histórico de Ligações</h2>
        </div>

        <div className="flex-1 overflow-auto">
          {historico.isLoading && <p className="text-center text-gray-400 mt-12">Carregando...</p>}
          {!historico.isLoading && (historico.data as Ligacao[] | undefined)?.length === 0 && (
            <div className="text-center text-gray-400 mt-16">
              <PhoneCall size={40} className="mx-auto mb-3 opacity-30" />
              <p>Nenhuma ligação registrada</p>
            </div>
          )}

          <div className="divide-y">
            {(historico.data as Ligacao[] | undefined)?.map(lig => {
              const phoneNum = lig.numeroDestino || lig.numeroOrigem;
              return (
              <div key={lig.id}
                className={`flex items-center gap-4 px-6 py-4 hover:bg-gray-50 ${selectedLigacao?.id === lig.id ? "bg-indigo-50" : ""}`}>
                <button onClick={() => { setSelectedLigacao(lig); setNotasEdit(lig.notas ?? ""); }}
                  className="flex items-center gap-4 flex-1 min-w-0 text-left">
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${
                    lig.status === "ENCERRADA" ? "bg-gray-100" :
                    lig.status === "EM_ANDAMENTO" ? "bg-green-100" :
                    lig.status === "FALHOU" || lig.status === "SEM_RESPOSTA" ? "bg-red-100" : "bg-yellow-100"
                  }`}>
                    {lig.status === "SEM_RESPOSTA" ? <PhoneMissed size={14} className="text-red-500" /> :
                     lig.status === "EM_ANDAMENTO" ? <Phone size={14} className="text-green-500" /> :
                     <Phone size={14} className="text-gray-500" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-sm text-gray-800 truncate">
                      {lig.contato?.nome ?? phoneNum}
                    </p>
                    <p className="text-xs text-gray-500 truncate font-mono">
                      {phoneNum}
                    </p>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <p className={`text-xs font-medium ${STATUS_COLORS[lig.status] ?? "text-gray-500"}`}>
                      {STATUS_LABELS[lig.status] ?? lig.status}
                    </p>
                    <div className="flex items-center gap-1 justify-end text-xs text-gray-400 mt-0.5">
                      <Clock size={10} />
                      {lig.duracao ? formatDuracao(lig.duracao) : formatTime(lig.iniciadaEm)}
                    </div>
                  </div>
                </button>
                {phoneNum && !isActive && callStatus === "registered" && (
                  <button
                    onClick={e => { e.stopPropagation(); setNumero(phoneNum); ligar(phoneNum); }}
                    title={`Ligar para ${phoneNum}`}
                    className="flex-shrink-0 w-8 h-8 rounded-full bg-green-50 border border-green-200 flex items-center justify-center text-green-600 hover:bg-green-100 active:bg-green-200 transition-colors">
                    <Phone size={13} />
                  </button>
                )}
              </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Painel de detalhes da ligação */}
      {selectedLigacao && (
        <div className="w-80 bg-white border-l flex flex-col">
          <div className="px-5 py-4 border-b flex justify-between items-center">
            <h3 className="font-semibold text-gray-800 text-sm">Detalhes</h3>
            <button onClick={() => setSelectedLigacao(null)} className="text-gray-400 hover:text-gray-600 text-lg">×</button>
          </div>
          <div className="p-5 flex-1 overflow-auto space-y-4">
            <div>
              <p className="text-xs text-gray-400 mb-1">Contato</p>
              <p className="text-sm font-medium text-gray-800 flex items-center gap-1">
                <User size={14} /> {selectedLigacao.contato?.nome ?? (selectedLigacao.numeroDestino || selectedLigacao.numeroOrigem)}
              </p>
              <p className="text-xs text-gray-500 font-mono">{selectedLigacao.numeroDestino || selectedLigacao.numeroOrigem}</p>
            </div>
            <div className="grid grid-cols-2 gap-3 text-xs">
              <div>
                <p className="text-gray-400">Status</p>
                <p className={`font-medium ${STATUS_COLORS[selectedLigacao.status] ?? ""}`}>
                  {STATUS_LABELS[selectedLigacao.status] ?? selectedLigacao.status}
                </p>
              </div>
              <div>
                <p className="text-gray-400">Duração</p>
                <p className="font-medium">{formatDuracao(selectedLigacao.duracao)}</p>
              </div>
              <div>
                <p className="text-gray-400">Iniciada</p>
                <p className="font-medium">{formatTime(selectedLigacao.iniciadaEm)}</p>
              </div>
              <div>
                <p className="text-gray-400">Origem</p>
                <p className="font-mono font-medium truncate">{selectedLigacao.numeroOrigem || "—"}</p>
              </div>
            </div>

            {(getLigacao.data?.resumo ?? selectedLigacao.resumo) && (
              <div>
                <p className="text-xs text-gray-400 mb-1">Resumo IA</p>
                <p className="text-xs text-gray-700 bg-indigo-50 border border-indigo-100 rounded p-2 leading-relaxed">
                  {getLigacao.data?.resumo ?? selectedLigacao.resumo}
                </p>
              </div>
            )}

            <div>
              <p className="text-xs text-gray-400 mb-1">Notas</p>
              <textarea
                value={notasEdit}
                onChange={e => setNotasEdit(e.target.value)}
                rows={3}
                className="w-full text-xs border rounded px-2 py-1.5 resize-none outline-none focus:ring-1 focus:ring-indigo-300"
                placeholder="Adicionar notas..."
              />
              <button
                onClick={() => {
                  atualizarMut.mutate({ id: selectedLigacao.id, notas: notasEdit });
                  setSelectedLigacao({ ...selectedLigacao, notas: notasEdit });
                }}
                className="mt-1 text-xs bg-indigo-600 text-white px-3 py-1 rounded hover:bg-indigo-700">
                Salvar
              </button>
            </div>

            {getLigacao.data?.transcricao && (
              <div>
                <p className="text-xs text-gray-400 mb-1">Transcrição</p>
                <p className="text-xs text-gray-700 bg-gray-50 rounded p-2 max-h-60 overflow-auto whitespace-pre-wrap leading-relaxed">
                  {getLigacao.data.transcricao}
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Modal config SIP */}
      {showSipConfig && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center">
          <div className="bg-white rounded-xl p-6 w-96 shadow-xl">
            <h3 className="font-semibold text-gray-800 mb-1 flex items-center gap-2">
              <Settings size={16} className="text-indigo-600" /> Configurar SIP
            </h3>
            <p className="text-xs text-gray-400 mb-4">Credenciais do ramal SIP para este navegador.</p>
            <div className="space-y-3">
              <div>
                <label className="text-xs text-gray-500 block mb-1">Ramal SIP (Extensão)</label>
                <input value={sipLocalExt} onChange={e => setSipLocalExt(e.target.value)}
                  placeholder="ex: 1001" className="w-full border rounded px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-300" />
              </div>
              <div>
                <label className="text-xs text-gray-500 block mb-1">Senha SIP</label>
                <input type="password" value={sipLocalPass} onChange={e => setSipLocalPass(e.target.value)}
                  placeholder="Senha do ramal" className="w-full border rounded px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-300" />
              </div>
              {cfg?.voipAsteriskWss ? (
                <p className="text-xs text-gray-400 bg-gray-50 rounded px-2 py-1.5 font-mono truncate">
                  {cfg.voipAsteriskWss}
                </p>
              ) : (
                <div>
                  <label className="text-xs text-gray-500 block mb-1">URL WebSocket (WSS)</label>
                  <input value={sipLocalWss} onChange={e => setSipLocalWss(e.target.value)}
                    placeholder="wss://avoce.capium.com.br/asterisk-ws"
                    className="w-full border rounded px-3 py-2 text-sm font-mono outline-none focus:ring-2 focus:ring-indigo-300" />
                  <p className="text-xs text-amber-600 mt-1">Configure a URL WSS nas configurações da empresa para pré-preencher automaticamente.</p>
                </div>
              )}
            </div>
            <div className="flex gap-2 mt-5">
              <button onClick={() => setShowSipConfig(false)} className="flex-1 border rounded-lg py-2 text-sm text-gray-600">Cancelar</button>
              <button onClick={salvarSipConfig}
                disabled={!sipLocalExt || !sipLocalPass || (!cfg?.voipAsteriskWss && !sipLocalWss)}
                className="flex-1 bg-indigo-600 text-white rounded-lg py-2 text-sm font-medium hover:bg-indigo-700 disabled:opacity-50">
                Conectar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
