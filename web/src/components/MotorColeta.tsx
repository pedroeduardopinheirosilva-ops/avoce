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

function brl(v: number) {
  return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

/**
 * Disparo de e-mail (pelo PSA-MT) só dos autos que ainda não foram comunicados.
 * Dois passos: o clique abre a prévia (o script monta a fila sem enviar) e só o
 * "Confirmar" dispara. O envio leva ~1 min por e-mail, então roda em segundo plano
 * e a barra acompanha pelo estado que o script grava.
 */
function EmailsNovos({ motorId, coletando }: { motorId: string; coletando: boolean }) {
  const [previa, setPrevia] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const utils = trpc.useUtils();

  const st = trpc.motores.emailsStatus.useQuery({ motorId }, { refetchOnWindowFocus: false });
  const enviando = !!st.data?.rodando;
  useEffect(() => {
    if (!enviando) return;
    const t = setInterval(() => { void st.refetch(); }, 5000);
    return () => clearInterval(t);
  }, [enviando, st.refetch]);
  // terminou o envio → o funil mudou (deals foram para "E-mail enviado")
  const [antes, setAntes] = useState(enviando);
  useEffect(() => {
    if (antes && !enviando) void utils.crm.invalidate();
    setAntes(enviando);
  }, [enviando]); // eslint-disable-line react-hooks/exhaustive-deps

  const pv = trpc.motores.emailsPrevia.useQuery({ motorId }, {
    enabled: previa, refetchOnWindowFocus: false, staleTime: 0, retry: false,
  });

  const disparar = trpc.motores.emailsDisparar.useMutation({
    onSuccess: () => { setErro(null); setPrevia(false); setTimeout(() => void st.refetch(), 1500); },
    onError: (e) => setErro(e.message),
  });

  const n = pv.data?.emails.length ?? 0;
  const limite = pv.data?.limite ?? 50;

  return (
    <>
      <button
        onClick={() => { setErro(null); setPrevia((v) => !v); }}
        disabled={enviando || coletando}
        title={coletando ? "espere a coleta terminar" : "Prévia dos e-mails dos autos ainda não comunicados"}
        className="text-xs font-medium px-3 py-1 rounded-lg border border-brand-600 text-brand-700 bg-white hover:bg-brand-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {enviando ? "enviando e-mails…" : "✉ Disparar e-mails dos autos novos"}
      </button>

      {(previa || enviando || st.data?.status || erro) && (
        <div className="basis-full mt-2 text-xs">
          {erro && <div className="text-red-600 mb-1">{erro}</div>}

          {!previa && st.data?.status && (
            <div className="opacity-80">
              ✉ {enviando ? "disparo em andamento" : `último disparo: ${st.data.resultado ?? st.data.status}`}
              {st.data.fim && !enviando && <> · {quando(st.data.fim)}</>}
              {enviando && st.data.log && (
                <pre className="text-[11px] leading-snug bg-white/70 border border-current/10 rounded-lg p-2 mt-1 max-h-40 overflow-auto whitespace-pre-wrap text-gray-700">
                  {st.data.log.trim()}
                </pre>
              )}
            </div>
          )}

          {previa && (
            <div className="bg-white border border-gray-200 rounded-lg p-2 text-gray-700">
              {pv.isLoading && <div>montando a prévia…</div>}
              {pv.error && <div className="text-red-600">{pv.error.message}</div>}
              {pv.data && (
                <>
                  <div className="font-medium mb-1">
                    {n === 0
                      ? "Nenhum auto novo para comunicar."
                      : `${n} e-mail(s) · ${pv.data.n_autos} auto(s) novo(s) — pela conta pedroeduardo@ do PSA-MT`}
                  </div>
                  {n > 0 && (
                    <div className="max-h-56 overflow-auto border-t border-gray-100">
                      {pv.data.emails.map((e) => (
                        <div key={e.para} className="py-1 border-b border-gray-50">
                          <span className="font-medium">{e.para}</span>
                          <span className="opacity-60"> · {e.via}</span>
                          {e.total > 0 && <span className="float-right">{brl(e.total)}</span>}
                          <div className="opacity-70 truncate">{e.empresas.join(" · ")} — {e.autos.join(", ")}</div>
                        </div>
                      ))}
                    </div>
                  )}
                  {pv.data.fora.length > 0 && (
                    <details className="mt-1">
                      <summary className="cursor-pointer opacity-70">{pv.data.fora.length} auto(s) novo(s) sem envio</summary>
                      {pv.data.fora.map((f) => (
                        <div key={f.deal_id} className="opacity-70">{f.razao} ({f.autos.join(", ")}) — {f.motivo}</div>
                      ))}
                    </details>
                  )}
                  <div className="flex gap-2 justify-end mt-2">
                    {n > limite && <span className="opacity-70 mr-auto">sairão os {limite} maiores agora; o resto no próximo disparo</span>}
                    <button onClick={() => setPrevia(false)} className="px-2 py-1 rounded-lg border border-gray-200 hover:bg-gray-50">cancelar</button>
                    {n > 0 && (
                      <button
                        onClick={() => disparar.mutate({ motorId, limite })}
                        disabled={disparar.isPending}
                        className="px-3 py-1 rounded-lg bg-brand-600 text-white font-medium hover:bg-brand-700 disabled:opacity-50"
                      >
                        {disparar.isPending ? "disparando…" : `Confirmar envio de ${Math.min(n, limite)} e-mail(s)`}
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </>
  );
}

function Painel({ motorId, nome, descricao, emails }: { motorId: string; nome: string; descricao: string; emails?: boolean }) {
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
        {emails && <EmailsNovos motorId={motorId} coletando={rodando} />}
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
        <Painel key={m.id} motorId={m.id} nome={m.nome} descricao={m.descricao} emails={m.emails} />
      ))}
    </div>
  );
}
