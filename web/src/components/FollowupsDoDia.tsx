import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { trpc } from "../lib/trpc";
import { RegistrarLigacao } from "./RegistrarLigacao";

const ROTULO: Record<string, string> = {
  atendeu: "atendeu", nao_atendeu: "não atendeu", recusou: "recusou", pediu_retorno: "pediu retorno",
  numero_errado: "número errado", agendada: "reunião agendada", realizada: "reunião feita",
  no_show: "não compareceu à reunião", remarcada: "reunião remarcada", cancelada: "reunião cancelada", ganho: "ganho", perdido: "perdido",
};

const SEM_DONO = "__sem__";

const inicioHojeSP = (hoje: string) => new Date(`${hoje}T00:00:00-03:00`).getTime();
const hhmm = (s: string | Date) => new Date(s).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
const ddmm = (s: string | Date) => new Date(s).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });

/**
 * Ligações de follow-up do dia (rotina diária do SDR): atrasadas primeiro, depois as de hoje.
 * Dar baixa = registrar a ligação E escolher o próximo passo (nova data ou encerrar) — só então
 * o lead sai da lista.
 */
export function FollowupsDoDia({ pipelineIds }: { pipelineIds?: string[] }) {
  const navigate = useNavigate();
  const utils = trpc.useUtils();
  const q = trpc.painel.followupsHoje.useQuery({ pipelineIds }, { refetchInterval: 60_000, keepPreviousData: true });
  const aoRegistrar = () => {
    utils.painel.followupsHoje.invalidate();
    utils.painel.followupsPendentes.invalidate();
    utils.painel.funilSdr.invalidate();
  };

  const hoje = q.data?.hoje ?? "";
  const pendentes = (q.data?.pendentes ?? []) as any[];
  const feitas = (q.data?.feitasHoje ?? []) as any[];
  const corte = hoje ? inicioHojeSP(hoje) : 0;
  const atrasadas = pendentes.filter((d) => new Date(d.proximoContatoEm).getTime() < corte);
  const deHoje = pendentes.filter((d) => new Date(d.proximoContatoEm).getTime() >= corte);

  // Fila por usuário: o follow-up é de quem marcou a data. O usuário logado vem primeiro,
  // os demais por nome e, por último, os sem dono (datas marcadas antes de existir o vínculo).
  // As SDRs configuradas sempre aparecem, mesmo sem nada no dia; senão, com um dono só, a
  // separação sumia e a lista parecia de todo mundo.
  const sdrQ = trpc.painel.followupSdr.useQuery(undefined, { staleTime: 300_000 });
  const sdrs: string[] = (sdrQ.data as any)?.sdrs ?? [];
  const eu: string | null = (q.data as any)?.eu ?? null;
  const nomes = new Map<string, string>([
    ...((sdrQ.data as any)?.usuarios ?? []).map((u: any) => [u.id, u.nome] as [string, string]),
    ...((q.data as any)?.usuarios ?? []).map((u: any) => [u.id, u.nome] as [string, string]),
  ]);
  const nomeDe = (id: string) => id === SEM_DONO ? "Sem responsável" : nomes.get(id) ?? "(usuário removido)";
  const donos = [...new Set([
    ...sdrs,
    ...pendentes.map((d) => d.proximoContatoPor ?? SEM_DONO),
    ...feitas.map((a) => a.usuarioId ?? SEM_DONO),
  ])].sort((a, b) =>
    a === eu ? -1 : b === eu ? 1 : a === SEM_DONO ? 1 : b === SEM_DONO ? -1 : nomeDe(a).localeCompare(nomeDe(b), "pt-BR"));
  // undefined = ainda não escolheu: abre na fila de quem está logado, se ele tiver fila.
  const [filtroEscolhido, setFiltro] = useState<string | null | undefined>(undefined);
  const filtro = filtroEscolhido === undefined ? (eu && donos.includes(eu) ? eu : null) : filtroEscolhido;
  const visiveis = filtro && donos.includes(filtro) ? [filtro] : donos;
  const contas = (id: string) => ({
    atrasadas: atrasadas.filter((d) => (d.proximoContatoPor ?? SEM_DONO) === id).length,
    hoje: deHoje.filter((d) => (d.proximoContatoPor ?? SEM_DONO) === id).length,
    feitas: feitas.filter((a) => (a.usuarioId ?? SEM_DONO) === id).length,
  });

  const linha = (d: any, atrasada: boolean) => {
    const dias = Math.floor((corte - new Date(d.proximoContatoEm).getTime()) / 86400_000) + 1;
    const ult = d.atividades?.[0];
    const fone: string = d.contato?.whatsapp ?? "";
    return (
      <li key={d.id} className="flex items-start gap-3 py-2 border-b border-gray-50 last:border-0">
        <span className={`mt-1.5 w-2 h-2 rounded-full flex-shrink-0 ${atrasada ? "bg-red-500" : "bg-indigo-500"}`} />
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <button onClick={() => navigate(`/whatsapp?dealId=${d.id}`)} className="text-sm font-medium text-gray-900 hover:underline truncate max-w-[16rem]">
              {d.contato?.nome ?? d.titulo}
            </button>
            {d.pipeline && (
              <span className="text-[11px] text-gray-500 flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: d.pipeline.cor }} />
                {d.pipeline.nome}
              </span>
            )}
            {d.stage && <span className="text-[11px] text-gray-400">· {d.stage.nome}</span>}
            <span className={`text-[11px] font-medium ${atrasada ? "text-red-600" : "text-indigo-600"}`}>
              {atrasada ? `atrasado ${dias}d (${ddmm(d.proximoContatoEm)})` : "hoje"}
            </span>
          </div>
          {ult && (
            <p className="text-xs text-gray-500 truncate">
              Última: {ROTULO[ult.resultado] ?? ult.resultado} em {ddmm(ult.criadoEm)} {hhmm(ult.criadoEm)}
              {ult.nota ? ` — ${ult.nota}` : ""}
            </p>
          )}
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {fone && (
            <a
              href={`whatsapp://send?phone=${fone}`}
              title="Abrir a conversa no WhatsApp do computador para ligar"
              className="text-xs px-2 py-1 rounded-md border bg-white hover:bg-green-50 text-green-700"
            >
              WhatsApp
            </a>
          )}
          <RegistrarLigacao dealId={d.id} atividades={d.atividades ?? []} onSalvo={aoRegistrar} modoBaixa rotulo="✓ Dar baixa" alinharDireita />
        </div>
      </li>
    );
  };

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4 mb-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-2">
        <h2 className="text-sm font-semibold text-gray-800">
          Ligações de follow-up · hoje
          <span className="ml-2 text-xs font-normal text-gray-500">
            {atrasadas.length > 0 && <span className="text-red-600">{atrasadas.length} atrasada(s) · </span>}
            {deHoje.length} para hoje · {feitas.length} feita(s)
          </span>
        </h2>
        <p className="text-[11px] text-gray-400">Dar baixa registra a ligação e pede o próximo passo; o lead sai da lista.</p>
      </div>

      {q.isLoading && <p className="text-xs text-gray-400 py-2">Carregando…</p>}
      {!q.isLoading && pendentes.length === 0 && (
        <p className="text-sm text-gray-500 py-2">
          Nenhuma ligação pendente. Os leads entram aqui quando alguém marca o próximo follow-up (📅) na conversa ou ao registrar uma ligação.
        </p>
      )}

      {donos.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          <button onClick={() => setFiltro(null)} className={`text-xs px-2 py-0.5 rounded-full border ${!filtro ? "bg-indigo-600 text-white border-indigo-600" : "bg-white text-gray-600 hover:bg-gray-50"}`}>
            Todos
          </button>
          {donos.map((id) => {
            const c = contas(id);
            return (
              <button key={id} onClick={() => setFiltro(filtro === id ? null : id)}
                className={`text-xs px-2 py-0.5 rounded-full border ${filtro === id ? "bg-indigo-600 text-white border-indigo-600" : "bg-white text-gray-600 hover:bg-gray-50"}`}>
                {nomeDe(id)}{id === eu ? " (eu)" : ""} · {c.atrasadas > 0 && <span className={filtro === id ? "" : "text-red-600"}>{c.atrasadas}❗ </span>}{c.hoje} · ✓{c.feitas}
              </button>
            );
          })}
        </div>
      )}

      {visiveis.map((id) => {
        const doDono = (d: any) => (d.proximoContatoPor ?? SEM_DONO) === id;
        const atr = atrasadas.filter(doDono);
        const hj = deHoje.filter(doDono);
        const fts = feitas.filter((a) => (a.usuarioId ?? SEM_DONO) === id);
        return (
          <section key={id} className="mt-2 first:mt-0">
            {(
              <h3 className="text-xs font-semibold text-gray-700 border-b border-gray-100 pb-1 mb-1 flex flex-wrap gap-x-2">
                <span>👤 {nomeDe(id)}{id === eu ? " (eu)" : ""}</span>
                <span className="font-normal text-gray-500">
                  {atr.length > 0 && <span className="text-red-600">{atr.length} atrasada(s) · </span>}
                  {hj.length} para hoje · {fts.length} feita(s)
                </span>
              </h3>
            )}
            {atr.length + hj.length > 0 ? (
              <ul className="max-h-96 overflow-y-auto pr-1">
                {atr.map((d) => linha(d, true))}
                {hj.map((d) => linha(d, false))}
              </ul>
            ) : (
              <p className="text-xs text-gray-400 py-1">Nada pendente.</p>
            )}
            {fts.length > 0 && (
              <details className="mt-1 mb-2">
                <summary className="text-xs text-gray-500 cursor-pointer select-none">✓ Feitas hoje ({fts.length})</summary>
                <ul className="mt-1.5 space-y-1">
                  {fts.map((a) => (
                    <li key={a.id} className="text-xs text-gray-600 flex gap-2">
                      <span className="text-green-600">✓</span>
                      <span className="text-gray-400 tabular-nums">{hhmm(a.criadoEm)}</span>
                      <button onClick={() => navigate(`/whatsapp?dealId=${a.deal.id}`)} className="font-medium hover:underline">
                        {a.deal.contato?.nome ?? a.deal.titulo}
                      </button>
                      <span>{ROTULO[a.resultado] ?? a.resultado}{a.origem === "automatica" ? " 🤖" : ""}</span>
                      {a.deal.proximoContatoEm && <span className="text-gray-400">→ próximo {ddmm(a.deal.proximoContatoEm)}</span>}
                      {a.nota && <span className="text-gray-400 truncate">— {a.nota}</span>}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </section>
        );
      })}
    </div>
  );
}
