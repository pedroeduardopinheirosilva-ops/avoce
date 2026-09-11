import { useEffect, useState } from "react";
import { trpc } from "../lib/trpc";

/**
 * Barra de controle dos motores de coleta que alimentam um funil.
 *
 * Aparece só nos funis que têm motor. Enquanto está rodando, faz poll de 5s —
 * o robô leva minutos e o usuário precisa ver que a coisa anda.
 */

function quando(iso?: string | null) {
  if (!iso) return "—";
  const d = new Date(iso);
  const dif = Math.round((Date.now() - d.getTime()) / 1000);
  if (dif >= 0 && dif < 60) return "agora há pouco";
  if (dif >= 0 && dif < 3600) return `há ${Math.round(dif / 60)} min`;
  if (dif >= 0 && dif < 86400) return `há ${Math.round(dif / 3600)} h`;
  if (dif < 0 && dif > -3600) return `em ${Math.round(-dif / 60)} min`;
  if (dif < 0 && dif > -86400) return `em ${Math.round(-dif / 3600)} h`;
  return d.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

function Painel({ motorId, nome, descricao }: { motorId: string; nome: string; descricao: string }) {
  const [aberto, setAberto] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const utils = trpc.useUtils();

  const { data, refetch } = trpc.motores.status.useQuery({ motorId }, { refetchOnWindowFocus: false });
  const rodando = !!data?.rodando;

  useEffect(() => {
    if (!rodando) return;
    const t = setInterval(() => { void refetch(); }, 5000);
    return () => clearInterval(t);
  }, [rodando, refetch]);

  const disparar = trpc.motores.disparar.useMutation({
    onSuccess: () => { setErro(null); setAberto(true); setTimeout(() => void refetch(), 1200); },
    onError: (e) => setErro(e.message),
    onSettled: () => { void utils.crm.invalidate(); },
  });

  const cor = rodando
    ? "bg-blue-50 border-blue-200 text-blue-700"
    : data?.status === "ok"
      ? "bg-emerald-50 border-emerald-200 text-emerald-700"
      : data?.status === "parcial"
        ? "bg-amber-50 border-amber-200 text-amber-800"
        : data?.status
          ? "bg-red-50 border-red-200 text-red-700"
          : "bg-gray-50 border-gray-200 text-gray-600";

  const rotulo = rodando
    ? "coletando…"
    : data?.status === "ok"
      ? "última coleta ok"
      : data?.status === "parcial"
        ? "última coleta parcial"
        : data?.status
          ? "última coleta com erro"
          : "nunca rodou";

  return (
    <div className={`rounded-xl border px-3 py-2 ${cor}`}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm">{rodando ? "⏳" : "🤖"}</span>
        <span className="text-sm font-medium">{nome}</span>

        <span className="inline-flex items-center gap-1 text-xs">
          <span className={`w-1.5 h-1.5 rounded-full ${rodando ? "bg-blue-500 animate-pulse" : "bg-current opacity-50"}`} />
          {rotulo}
          {data?.fim && !rodando && <span className="opacity-70"> · {quando(data.fim)}</span>}
          {data?.duracaoSeg && !rodando ? <span className="opacity-70"> · {data.duracaoSeg}s</span> : null}
        </span>

        {data?.proximaExecucao && !rodando && (
          <span className="text-xs opacity-70">· próxima automática {quando(data.proximaExecucao)}</span>
        )}

        <div className="flex-1" />

        <button
          onClick={() => setAberto((v) => !v)}
          className="text-xs px-2 py-1 rounded-lg border border-current/20 hover:bg-white/60 transition-colors"
        >
          {aberto ? "ocultar detalhes" : "detalhes"}
        </button>
        <button
          onClick={() => disparar.mutate({ motorId })}
          disabled={rodando || disparar.isPending}
          title={rodando ? "já está rodando" : descricao}
          className="text-xs font-medium px-3 py-1 rounded-lg bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {rodando ? "rodando…" : disparar.isPending ? "disparando…" : "▶ Buscar autos agora"}
        </button>
      </div>

      {data?.resumo && !rodando && (
        <div className="text-xs opacity-80 mt-1">{data.resumo}</div>
      )}
      {erro && <div className="text-xs text-red-600 mt-1">{erro}</div>}

      {aberto && (
        <div className="mt-2">
          <div className="text-[11px] opacity-70 mb-1">
            {descricao}
            {data?.gatilho && <> · disparo: {data.gatilho}</>}
            {data?.inicio && <> · início {new Date(data.inicio).toLocaleString("pt-BR")}</>}
          </div>
          <pre className="text-[11px] leading-snug bg-white/70 border border-current/10 rounded-lg p-2 max-h-64 overflow-auto whitespace-pre-wrap text-gray-700">
            {data?.log?.trim() || "sem log ainda"}
          </pre>
        </div>
      )}
    </div>
  );
}

export default function MotorColeta({ pipelineId }: { pipelineId: string }) {
  const { data: motores } = trpc.motores.doPipeline.useQuery(
    { pipelineId },
    { enabled: !!pipelineId, refetchOnWindowFocus: false },
  );
  if (!motores || motores.length === 0) return null;
  return (
    <div className="bg-white border-b border-gray-100 px-4 py-2 flex-shrink-0 space-y-2">
      {motores.map((m) => (
        <Painel key={m.id} motorId={m.id} nome={m.nome} descricao={m.descricao} />
      ))}
    </div>
  );
}
