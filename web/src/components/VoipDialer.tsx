import { useState, useEffect, useImperativeHandle, forwardRef } from "react";
import { trpc } from "../lib/trpc";
import { useVoip } from "../contexts/VoipContext";

interface Props {
  dealId: string;
  contatoWhatsapp?: string | null;
  contatoTelefone?: string | null;
}

export interface VoipDialerHandle {
  setNumero: (n: string) => void;
}

const KEYPAD_KEYS = ["1","2","3","4","5","6","7","8","9","*","0","#"] as const;

const VoipDialer = forwardRef<VoipDialerHandle, Props>(function VoipDialer(
  { dealId, contatoWhatsapp, contatoTelefone }, ref
) {
  const [numero, setNumero]         = useState(contatoWhatsapp ?? contatoTelefone ?? "");
  const [did, setDid]               = useState<string>("1");
  const [erro, setErro]             = useState<string | null>(null);
  const [showDialpad, setShowDialpad] = useState(false);
  const [dtmfBuffer, setDtmfBuffer] = useState("");

  const { ligar, callStatus, activeDealId, callSeconds, sessionRef, primeAudio, playRemoteStream } = useVoip();
  const utils = trpc.useUtils();

  const { data: voipConfigDeal } = trpc.ligacoes.getVoipConfig.useQuery({ dealId });
  const { data: voipConfigGlobal } = trpc.ligacoes.getVoipConfigGlobal.useQuery(
    undefined,
    { enabled: voipConfigDeal !== undefined && !voipConfigDeal?.voipDid }
  );
  const voipConfig = voipConfigDeal?.voipDid ? voipConfigDeal : (voipConfigGlobal ?? voipConfigDeal);

  // Is this deal's call the active one?
  const isActive = activeDealId === dealId;

  useImperativeHandle(ref, () => ({
    setNumero: (n: string) => { setNumero(n); setErro(null); },
  }));

  // Invalidate call list when our call finishes
  useEffect(() => {
    if (isActive && (callStatus === "ended" || callStatus === "registered")) {
      utils.ligacoes.listar.invalidate({ dealId });
    }
  }, [callStatus, isActive]); // eslint-disable-line

  function formatTempo(s: number) {
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }

  function handleLigar() {
    if (!numero.trim()) return;
    setErro(null);
    ligar(numero.trim(), did, dealId);
  }

  function handleEncerrar() {
    try { sessionRef.current?.terminate(); } catch {}
  }

  function handleDtmf(digit: string) {
    try {
      sessionRef.current?.sendDTMF(digit, { duration: 100, interToneGap: 70 });
    } catch {}
    setDtmfBuffer(prev => (prev + digit).slice(-12));
  }

  function handleDialpadKey(digit: string) {
    setNumero(prev => prev + digit);
  }

  const temDid  = !!voipConfig?.voipDid;
  const temDid2 = !!voipConfig?.voipDid2;
  const temDid3 = !!voipConfig?.voipDid3;
  const temMultipleDid = temDid2 || temDid3;

  if (!temDid) {
    return (
      <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg">
        <p className="text-xs text-amber-700">
          VoIP não configurado — acesse <strong>Empresas → aba VoIP</strong> para cadastrar o número de origem e a URL do Asterisk.
        </p>
      </div>
    );
  }

  if (isActive && (callStatus === "ringing" || callStatus === "in_call")) {
    const inCall = callStatus === "in_call";
    return (
      <div className="flex flex-col gap-2 p-3 bg-green-50 rounded-lg border border-green-200">
        {/* Status + timer */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full animate-pulse ${inCall ? "bg-green-500" : "bg-yellow-400"}`} />
            <span className="text-sm text-green-800 font-medium">
              {inCall ? "Em ligação" : "Discando..."}
            </span>
          </div>
          <span className="text-sm font-mono text-green-700">{formatTempo(callSeconds)}</span>
        </div>
        <p className="text-xs text-green-600 truncate">{numero}</p>

        {/* DTMF keypad — shown during active call */}
        {inCall && (
          <div className="mt-1">
            {/* DTMF buffer display */}
            <div className="mb-1.5 h-7 px-2 bg-white border border-green-200 rounded text-sm font-mono text-gray-700 flex items-center">
              {dtmfBuffer
                ? <span className="tracking-widest">{dtmfBuffer}</span>
                : <span className="text-gray-300 text-xs">Teclado DTMF</span>}
            </div>
            {/* 3×4 keypad */}
            <div className="grid grid-cols-3 gap-1">
              {KEYPAD_KEYS.map(k => (
                <button
                  key={k}
                  onClick={() => handleDtmf(k)}
                  className="py-2 rounded bg-white border border-green-200 text-sm font-semibold text-gray-800 hover:bg-green-100 active:bg-green-200 transition-colors select-none"
                >
                  {k}
                </button>
              ))}
            </div>
          </div>
        )}

        {inCall && (
          <button
            onClick={() => {
              primeAudio();
              // Tentar reconectar o stream remoto ao AudioContext
              const conn = sessionRef.current?.connection;
              if (conn) {
                const rx = (conn.getReceivers() as RTCRtpReceiver[]).find(
                  (r: RTCRtpReceiver) => r.track?.kind === "audio" && r.track.readyState === "live"
                );
                if (rx?.track) playRemoteStream(new MediaStream([rx.track]));
              }
            }}
            className="flex items-center justify-center gap-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium py-1.5 rounded-lg transition-colors"
          >
            🔊 Ativar Áudio
          </button>
        )}
        <button
          onClick={handleEncerrar}
          className="mt-1 flex items-center justify-center gap-1.5 bg-red-600 hover:bg-red-700 text-white text-sm font-medium py-2 rounded-lg transition-colors"
        >
          🔴 Encerrar ligação
        </button>
      </div>
    );
  }

  if (isActive && callStatus === "ended") {
    return (
      <div className="flex flex-col gap-2 p-3 bg-gray-50 rounded-lg border border-gray-200">
        <span className="text-sm text-gray-600">Encerrada • {formatTempo(callSeconds)}</span>
        <p className="text-xs text-gray-400">Gravação sendo processada...</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 p-3 bg-gray-50 rounded-lg border border-gray-200">
      {/* Number input row */}
      <div className="flex gap-2">
        <input
          type="text"
          value={numero}
          onChange={e => setNumero(e.target.value)}
          onKeyDown={e => e.key === "Enter" && handleLigar()}
          placeholder="Número (ex: 5531...)"
          className="flex-1 text-sm border border-gray-300 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-indigo-500 font-mono"
        />
        {/* Backspace */}
        {numero.length > 0 && (
          <button
            onClick={() => setNumero(prev => prev.slice(0, -1))}
            title="Apagar"
            className="px-2 text-gray-400 hover:text-gray-700 border border-gray-300 rounded bg-white"
          >
            ⌫
          </button>
        )}
        {/* Toggle dialpad */}
        <button
          onClick={() => setShowDialpad(p => !p)}
          title={showDialpad ? "Ocultar discador" : "Abrir discador"}
          className={`px-2 border rounded text-sm transition-colors ${showDialpad ? "bg-indigo-100 border-indigo-300 text-indigo-700" : "bg-white border-gray-300 text-gray-500 hover:text-gray-700"}`}
        >
          ⌨
        </button>
        {temMultipleDid && (
          <select
            value={did}
            onChange={e => setDid(e.target.value)}
            className="text-xs border border-gray-300 rounded px-2 py-1.5 bg-white"
          >
            <option value="1">{voipConfig?.voipDid1Label ?? "Linha 1"}</option>
            {temDid2 && <option value="2">{voipConfig?.voipDid2Label ?? "Linha 2"}</option>}
            {temDid3 && <option value="3">{voipConfig?.voipDid3Label ?? "Linha 3"}</option>}
          </select>
        )}
      </div>

      {/* Dialpad (3×4) — shown when toggled */}
      {showDialpad && (
        <div className="grid grid-cols-3 gap-1">
          {KEYPAD_KEYS.map(k => (
            <button
              key={k}
              onClick={() => handleDialpadKey(k)}
              className="py-2 rounded bg-white border border-gray-300 text-sm font-semibold text-gray-800 hover:bg-gray-100 active:bg-gray-200 transition-colors select-none"
            >
              {k}
            </button>
          ))}
        </div>
      )}

      {temDid && !temMultipleDid && (
        <p className="text-xs text-gray-400">
          Origem: {voipConfig?.voipDid1Label ?? voipConfig?.voipDid}
        </p>
      )}
      {erro && <p className="text-xs text-red-500">{erro}</p>}
      <button
        onClick={handleLigar}
        disabled={!numero.trim() || (callStatus !== "registered" && callStatus !== "idle")}
        className="flex items-center justify-center gap-1.5 bg-green-600 hover:bg-green-700 disabled:bg-gray-300 text-white text-sm font-medium py-2 rounded-lg transition-colors"
      >
        📞 Ligar
      </button>
    </div>
  );
});

export default VoipDialer;
