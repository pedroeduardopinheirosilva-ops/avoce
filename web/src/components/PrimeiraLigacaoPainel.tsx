import { useState } from "react";
import { PhoneOutgoing } from "lucide-react";
import { trpc } from "../lib/trpc";

type Base = "util" | "corrido";

const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)}%` : "—");
const fmtDiaCurto = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;

/** 7 → "7 min" · 95 → "1h35" · 1600 → "26h40" */
function fmtMin(m: number | null | undefined): string {
  if (m === null || m === undefined) return "—";
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h}h${String(r).padStart(2, "0")}` : `${h}h`;
}

/** Cor pela meta: até 15 min verde, até 1h âmbar, acima vermelho. */
const corMin = (m: number | null) =>
  m === null ? "text-gray-400" : m <= 15 ? "text-emerald-700" : m <= 60 ? "text-amber-700" : "text-red-700";
const barraMin = (m: number | null) =>
  m === null ? "bg-gray-200" : m <= 15 ? "bg-emerald-500" : m <= 60 ? "bg-amber-400" : "bg-red-500";

/**
 * Tempo da entrada do lead no funil até a 1ª ligação de saída (baixa no CRM ou discador VoIP).
 * "Horário comercial" conta só seg–sex 8h–18h, para não punir a SDR pelo lead que chega de madrugada.
 */
export function PrimeiraLigacaoPainel({ de, ate, pipelineIds }: { de: string; ate: string; pipelineIds?: string[] }) {
  const [base, setBase] = useState<Base>("util");
  const q = trpc.painel.primeiraLigacao.useQuery({ de, ate, pipelineIds }, { enabled: !!pipelineIds?.length, keepPreviousData: true });
  const d = q.data;
  const r = d?.[base];
  const chaveMediana = base === "util" ? "medianaUtil" : "medianaCorrido";
  const dias = d?.dias ?? [];
  const maxDia = Math.max(1, ...dias.map(x => x[chaveMediana] ?? 0));

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4 mb-4">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <div className="flex items-center gap-2">
          <PhoneOutgoing size={16} className="text-gray-400" />
          <h2 className="text-sm font-semibold text-gray-800">Tempo até a 1ª ligação</h2>
          <span className="text-xs text-gray-400">da entrada do lead no funil até a SDR ligar</span>
        </div>
        <div className="flex gap-1">
          {([["util", "Horário comercial"], ["corrido", "Corrido (24h)"]] as [Base, string][]).map(([k, rot]) => (
            <button
              key={k}
              onClick={() => setBase(k)}
              title={k === "util" ? "Conta só seg–sex, 8h–18h (Brasília)" : "Relógio corrido, inclui noite e fim de semana"}
              className={`px-2.5 py-1 rounded-full text-xs border transition-colors ${
                base === k ? "bg-gray-900 text-white border-gray-900" : "bg-white text-gray-600 border-gray-200 hover:border-gray-300"
              }`}
            >
              {rot}
            </button>
          ))}
        </div>
      </div>

      {q.isLoading ? (
        <p className="text-sm text-gray-400 py-6 text-center">Carregando…</p>
      ) : !d || d.leads === 0 ? (
        <p className="text-sm text-gray-400 py-6 text-center">Nenhum lead no período.</p>
      ) : d.ligados === 0 ? (
        <p className="text-sm text-gray-400 py-6 text-center">
          {d.leads} leads no período, nenhum com ligação registrada neste funil.
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            <div className="rounded-lg border border-gray-100 bg-gray-50 p-3">
              <p className={`text-2xl font-bold tracking-tight ${corMin(r!.mediana)}`}>{fmtMin(r!.mediana)}</p>
              <p className="text-xs text-gray-500 font-medium mt-0.5">Mediana</p>
            </div>
            <div className="rounded-lg border border-gray-100 bg-gray-50 p-3">
              <p className={`text-2xl font-bold tracking-tight ${corMin(r!.media)}`}>{fmtMin(r!.media)}</p>
              <p className="text-xs text-gray-500 font-medium mt-0.5">Média</p>
            </div>
            <div className="rounded-lg border border-gray-100 bg-gray-50 p-3">
              <p className="text-2xl font-bold tracking-tight text-gray-800">{pct(r!.ate15min, d.ligados)}</p>
              <p className="text-xs text-gray-500 font-medium mt-0.5">ligados em até 15 min</p>
              <p className="text-[11px] text-gray-400">≤5 min {pct(r!.ate5min, d.ligados)} · ≤1h {pct(r!.ate1h, d.ligados)}</p>
            </div>
            <div className="rounded-lg border border-gray-100 bg-gray-50 p-3">
              <p className="text-2xl font-bold tracking-tight text-gray-800">
                {d.ligados}<span className="text-base font-medium text-gray-400">/{d.leads}</span>
              </p>
              <p className="text-xs text-gray-500 font-medium mt-0.5">leads com ligação</p>
              <p className="text-[11px] text-gray-400">{d.leads - d.ligados} ainda sem ligação (fora da conta)</p>
            </div>
          </div>

          <p className="text-xs font-medium text-gray-500 mb-1.5">Mediana por dia de entrada</p>
          <div className="flex items-end gap-[3px] h-28 mb-1">
            {dias.map(x => {
              const v = x[chaveMediana];
              return (
                <div
                  key={x.dia}
                  className="flex-1 flex flex-col justify-end h-full group relative"
                  title={`${fmtDiaCurto(x.dia)} — mediana ${fmtMin(v)} · ${x.ligados}/${x.leads} ligados`}
                >
                  <div className={`w-full rounded-t ${barraMin(v)}`} style={{ height: v === null ? 2 : `${Math.max(3, (v / maxDia) * 100)}%` }} />
                </div>
              );
            })}
          </div>
          <div className="flex justify-between text-[10px] text-gray-400 mb-4">
            <span>{dias[0] && fmtDiaCurto(dias[0].dia)}</span>
            <span>verde ≤15 min · âmbar ≤1h · vermelho &gt;1h · cinza sem ligação</span>
            <span>{dias.length > 0 && fmtDiaCurto(dias[dias.length - 1].dia)}</span>
          </div>

          {d.usuarios.length > 0 && (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-gray-400 border-b border-gray-100">
                  <th className="text-left font-medium py-1.5">Quem fez a 1ª ligação</th>
                  <th className="text-right font-medium py-1.5">Leads</th>
                  <th className="text-right font-medium py-1.5">Mediana</th>
                </tr>
              </thead>
              <tbody>
                {d.usuarios.map(u => (
                  <tr key={u.usuarioId ?? "-"} className="border-b border-gray-50 last:border-0">
                    <td className="py-1.5 text-gray-700">{u.nome}</td>
                    <td className="py-1.5 text-right text-gray-600 tabular-nums">{u.ligados}</td>
                    <td className={`py-1.5 text-right font-medium tabular-nums ${corMin(u[chaveMediana])}`}>{fmtMin(u[chaveMediana])}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}
