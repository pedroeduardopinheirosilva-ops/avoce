import { trpc } from "../lib/trpc";

type Linha = {
  dia: string; chegaram: number; responderam: number; qualificaram: number; ligacoes: number;
  atendidas: number; agendaram: number; desqualificados: number; reunioes: number; noShows: number;
  ganhos: number; perdidos: number;
};

const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)}%` : "—");
const fmtDia = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;

/**
 * Funil do SDR (mentoria 12/09/2026): chegaram → responderam → qualificaram → ligação →
 * atenderam → agendaram, por dia de chegada; reuniões, no-show, ganhos e perdas pelo dia em
 * que aconteceram. Substitui o relatório diário que a SDR montava à mão.
 */
export function FunilSdrPainel({ de, ate, pipelineIds }: { de: string; ate: string; pipelineIds?: string[] }) {
  const q = trpc.painel.funilSdr.useQuery({ de, ate, pipelineIds }, { keepPreviousData: true });
  const dias = ((q.data?.dias ?? []) as Linha[]).slice().reverse();
  const t = dias.reduce<Omit<Linha, "dia">>((acc, l) => {
    (Object.keys(acc) as (keyof typeof acc)[]).forEach((k) => { acc[k] += l[k]; });
    return acc;
  }, { chegaram: 0, responderam: 0, qualificaram: 0, ligacoes: 0, atendidas: 0, agendaram: 0, desqualificados: 0, reunioes: 0, noShows: 0, ganhos: 0, perdidos: 0 });

  const etapas: { rotulo: string; valor: number; base: number; dica: string }[] = [
    { rotulo: "Chegaram", valor: t.chegaram, base: t.chegaram, dica: "Leads que entraram no período" },
    { rotulo: "Responderam", valor: t.responderam, base: t.chegaram, dica: "Mandaram mais que a mensagem do anúncio" },
    { rotulo: "Qualificaram", valor: t.qualificaram, base: t.responderam, dica: "Chegaram a Lead Qualificado (ou além)" },
    { rotulo: "Ligação feita", valor: t.ligacoes, base: t.qualificaram, dica: "Registrada no Chat (📞) ou pelo telefone do Avoce" },
    { rotulo: "Atenderam", valor: t.atendidas, base: t.ligacoes, dica: "Ligação com resultado 'atendeu'" },
    { rotulo: "Agendaram", valor: t.agendaram, base: t.qualificaram, dica: "Passaram por etapa de reunião" },
  ];
  const colunas: [keyof Omit<Linha, "dia">, string][] = [
    ["chegaram", "Cheg."], ["responderam", "Resp."], ["qualificaram", "Qualif."], ["ligacoes", "Lig."],
    ["atendidas", "Atend."], ["agendaram", "Agend."], ["desqualificados", "Desq."],
    ["reunioes", "Reun."], ["noShows", "No-show"], ["ganhos", "Ganhos"], ["perdidos", "Perdas"],
  ];

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4 mb-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-3">
        <h2 className="text-sm font-semibold text-gray-800">Funil do SDR</h2>
        <p className="text-[11px] text-gray-400">
          Etapas contadas pelo dia em que o lead chegou · reuniões, no-show, ganhos e perdas pelo dia em que aconteceram
        </p>
      </div>

      <div className="grid grid-cols-3 md:grid-cols-6 gap-2 mb-4">
        {etapas.map((e, i) => (
          <div key={e.rotulo} className="border border-gray-100 rounded-lg p-2.5" title={e.dica}>
            <p className="text-[11px] text-gray-400">{e.rotulo}</p>
            <p className="text-xl font-semibold text-gray-900 tabular-nums">{e.valor}</p>
            {i > 0 && <p className="text-[11px] text-indigo-600 tabular-nums">{pct(e.valor, e.base)}</p>}
          </div>
        ))}
      </div>

      <div className="flex flex-wrap gap-4 text-xs text-gray-600 mb-3">
        <span>Reuniões realizadas: <b className="tabular-nums">{t.reunioes}</b></span>
        <span>No-show: <b className="tabular-nums">{t.noShows}</b> ({pct(t.noShows, t.reunioes + t.noShows)})</span>
        <span>Ganhos: <b className="tabular-nums text-green-700">{t.ganhos}</b> ({pct(t.ganhos, t.reunioes)} das reuniões)</span>
        <span>Desqualificados: <b className="tabular-nums">{t.desqualificados}</b></span>
        <span>Perdas: <b className="tabular-nums text-red-600">{t.perdidos}</b></span>
      </div>

      {!!q.data?.motivosPerda.length && (
        <div className="flex flex-wrap gap-1.5 mb-3">
          {q.data.motivosPerda.map((m) => (
            <span key={m.motivo} className="text-[11px] px-2 py-0.5 rounded-full bg-red-50 text-red-700 border border-red-100">
              {m.motivo} · {m.qtd}
            </span>
          ))}
        </div>
      )}

      <div className="overflow-x-auto max-h-80 overflow-y-auto">
        <table className="w-full text-xs tabular-nums">
          <thead className="sticky top-0 bg-white">
            <tr className="text-gray-400 border-b">
              <th className="text-left font-medium py-1.5 pr-2">Dia</th>
              {colunas.map(([, r]) => <th key={r} className="text-right font-medium py-1.5 px-1.5">{r}</th>)}
            </tr>
          </thead>
          <tbody>
            {dias.filter((l) => colunas.some(([k]) => l[k] > 0)).map((l) => (
              <tr key={l.dia} className="border-b border-gray-50">
                <td className="py-1 pr-2 text-gray-500">{fmtDia(l.dia)}</td>
                {colunas.map(([k]) => (
                  <td key={k} className={`text-right py-1 px-1.5 ${l[k] ? "text-gray-800" : "text-gray-300"}`}>{l[k]}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {q.isLoading && <p className="text-xs text-gray-400 py-3">Carregando…</p>}
      </div>
    </div>
  );
}
