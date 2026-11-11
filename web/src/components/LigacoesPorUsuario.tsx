import { useState } from "react";
import { Phone, ChevronLeft, ChevronRight } from "lucide-react";
import { trpc } from "../lib/trpc";

const hojeSP = () => new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
const somarDias = (iso: string, n: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const fmtDia = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;

/**
 * Ligações do dia por usuário (todos os funis): registradas no CRM + feitas pelo discador VoIP,
 * na conta de quem estava logado. "Pelo discador" mostra quantas do total vieram do VoIP.
 */
export function LigacoesPorUsuario() {
  const hoje = hojeSP();
  const [dia, setDia] = useState(hoje);
  const q = trpc.painel.ligacoesPorUsuario.useQuery({ dia }, { refetchInterval: 60_000, keepPreviousData: true });
  const linhas = q.data?.usuarios ?? [];
  const soma = linhas.reduce(
    (a, l) => ({ total: a.total + l.total, atendeu: a.atendeu + l.atendeu, naoAtendeu: a.naoAtendeu + l.naoAtendeu, outros: a.outros + l.outros, discador: a.discador + l.discador }),
    { total: 0, atendeu: 0, naoAtendeu: 0, outros: 0, discador: 0 },
  );
  const temDiscador = soma.discador > 0;

  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden mb-4">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-b border-gray-100">
        <div className="flex items-center gap-2">
          <Phone size={16} className="text-gray-400" />
          <span className="text-sm font-semibold text-gray-800">Ligações por usuário</span>
          <span className="text-xs text-gray-400">todos os funis</span>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={() => setDia(somarDias(dia, -1))} className="p-1 rounded hover:bg-gray-100 text-gray-500" title="Dia anterior">
            <ChevronLeft size={16} />
          </button>
          <button
            onClick={() => setDia(hoje)}
            className="px-2.5 py-1 rounded-lg border border-gray-200 text-xs text-gray-700 hover:bg-gray-50 min-w-[92px]"
          >
            {dia === hoje ? "Hoje" : fmtDia(dia)}
          </button>
          <button
            onClick={() => setDia(somarDias(dia, 1))}
            disabled={dia >= hoje}
            className="p-1 rounded hover:bg-gray-100 text-gray-500 disabled:opacity-30"
            title="Próximo dia"
          >
            <ChevronRight size={16} />
          </button>
        </div>
      </div>

      {q.isLoading ? (
        <p className="px-4 py-6 text-sm text-gray-400">Carregando…</p>
      ) : linhas.length === 0 ? (
        <p className="px-4 py-6 text-sm text-gray-400">Nenhuma ligação registrada {dia === hoje ? "hoje" : `em ${fmtDia(dia)}`}.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[11px] uppercase tracking-wide text-gray-400 border-b border-gray-100">
                <th className="text-left font-medium px-4 py-2">Usuário</th>
                <th className="text-right font-medium px-3 py-2">Ligações</th>
                <th className="text-right font-medium px-3 py-2">Atendeu</th>
                <th className="text-right font-medium px-3 py-2">Não atendeu</th>
                <th className="text-right font-medium px-3 py-2">Outros</th>
                {temDiscador && <th className="text-right font-medium px-4 py-2" title="Quantas do total foram feitas pelo discador VoIP do sistema">Pelo discador</th>}
              </tr>
            </thead>
            <tbody>
              {linhas.map(l => (
                <tr key={l.usuarioId ?? "-"} className="border-b border-gray-50 last:border-0">
                  <td className="px-4 py-2 text-gray-800">{l.nome}</td>
                  <td className="px-3 py-2 text-right font-semibold text-gray-900 tabular-nums">{l.total}</td>
                  <td className="px-3 py-2 text-right text-emerald-700 tabular-nums">{l.atendeu}</td>
                  <td className="px-3 py-2 text-right text-gray-500 tabular-nums">{l.naoAtendeu}</td>
                  <td className="px-3 py-2 text-right text-gray-500 tabular-nums" title="Recusou, pediu retorno, número errado…">{l.outros}</td>
                  {temDiscador && <td className="px-4 py-2 text-right text-gray-500 tabular-nums">{l.discador}</td>}
                </tr>
              ))}
            </tbody>
            {linhas.length > 1 && (
              <tfoot>
                <tr className="bg-gray-50 text-gray-700">
                  <td className="px-4 py-2 font-medium">Total</td>
                  <td className="px-3 py-2 text-right font-semibold tabular-nums">{soma.total}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{soma.atendeu}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{soma.naoAtendeu}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{soma.outros}</td>
                  {temDiscador && <td className="px-4 py-2 text-right tabular-nums">{soma.discador}</td>}
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
    </div>
  );
}
