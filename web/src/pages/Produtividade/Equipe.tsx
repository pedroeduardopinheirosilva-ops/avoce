import { useState } from "react";
import { ChevronLeft, ChevronRight, AlertTriangle } from "lucide-react";
import { trpc } from "../../lib/trpc";
import { card, btn, COR_CAT, fmtData, fmtDur, fmtHora, hojeStr, somarDias } from "./util";

type Periodo = "dia" | "semana" | "mes";

function intervalo(dia: string, p: Periodo): { de: string; ate: string } {
  if (p === "dia") return { de: dia, ate: dia };
  if (p === "semana") {
    const dow = new Date(`${dia}T00:00:00Z`).getUTCDay();
    const seg = somarDias(dia, dow === 0 ? -6 : 1 - dow);
    return { de: seg, ate: somarDias(seg, 6) };
  }
  return { de: `${dia.slice(0, 7)}-01`, ate: `${dia.slice(0, 7)}-31` };
}

function passo(dia: string, p: Periodo, dir: 1 | -1): string {
  if (p === "dia") return somarDias(dia, dir);
  if (p === "semana") return somarDias(dia, 7 * dir);
  const t = new Date(`${dia.slice(0, 7)}-01T00:00:00Z`);
  t.setUTCMonth(t.getUTCMonth() + dir);
  return t.toISOString().slice(0, 10);
}

export default function Equipe({ dia, setDia, onAbrir }: { dia: string; setDia: (d: string) => void; onAbrir: (id: string, d?: string) => void }) {
  const [periodo, setPeriodo] = useState<Periodo>("dia");
  const { de, ate } = intervalo(dia, periodo);
  const q = trpc.produtividade.equipe.useQuery({ de, ate });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1">
          <button className={btn} onClick={() => setDia(passo(dia, periodo, -1))} aria-label="Anterior"><ChevronLeft size={14} /></button>
          <input type="date" value={dia} max={hojeStr()} onChange={(e) => e.target.value && setDia(e.target.value)} className="border border-gray-300 rounded-md px-2 py-1 text-sm" />
          <button className={btn} onClick={() => setDia(passo(dia, periodo, 1))} aria-label="Próximo"><ChevronRight size={14} /></button>
        </div>
        <div className="flex rounded-md overflow-hidden border border-gray-300">
          {(["dia", "semana", "mes"] as Periodo[]).map((p) => (
            <button key={p} onClick={() => setPeriodo(p)} className="px-3 py-1 text-xs"
              style={{ background: periodo === p ? "var(--avoce-navy)" : "white", color: periodo === p ? "white" : "var(--avoce-ink)" }}>
              {p === "dia" ? "Dia" : p === "semana" ? "Semana" : "Mês"}
            </button>
          ))}
        </div>
        <span className="text-xs text-gray-500">{fmtData(de)}{de !== ate && ` a ${fmtData(ate)}`}</span>
        <span className="ml-auto flex gap-3 text-xs text-gray-500">
          {(["trabalho", "pessoal", "neutro"] as const).map((c) => (
            <span key={c} className="flex items-center gap-1"><i className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: COR_CAT[c] }} />{c}</span>
          ))}
        </span>
      </div>

      <div className={`${card} overflow-x-auto`}>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-gray-500" style={{ background: "var(--avoce-paper-deep)" }}>
              <th className="px-3 py-2">Pessoa</th>
              <th className="px-3 py-2">Ativo no expediente</th>
              <th className="px-3 py-2">Ativo fora</th>
              <th className="px-3 py-2">Início</th>
              <th className="px-3 py-2">Fim</th>
              <th className="px-3 py-2 w-64">Trabalho / pessoal / neutro</th>
              <th className="px-3 py-2">% pessoal</th>
            </tr>
          </thead>
          <tbody>
            {q.isLoading && <tr><td colSpan={7} className="px-3 py-6 text-center text-gray-400">Carregando...</td></tr>}
            {q.error && <tr><td colSpan={7} className="px-3 py-6 text-center text-red-600">{q.error.message}</td></tr>}
            {q.data?.length === 0 && <tr><td colSpan={7} className="px-3 py-6 text-center text-gray-400">Nenhuma pessoa monitorada. Cadastre na aba Dispositivos.</td></tr>}
            {q.data?.map((p) => {
              const { dentro, fora } = p.soma;
              const total = dentro.trabalho + dentro.pessoal + dentro.neutro;
              const pctPessoal = total > 0 ? (dentro.pessoal / total) * 100 : 0;
              const inicios = p.dias.map((d) => d.primeiroEvento).filter(Boolean).map((v) => new Date(v as Date | string).getTime());
              const fins = p.dias.map((d) => d.ultimoEvento).filter(Boolean).map((v) => new Date(v as Date | string).getTime());
              const inicio = inicios.length ? new Date(Math.min(...inicios)) : null;
              const fim = fins.length ? new Date(Math.max(...fins)) : null;
              const alerta = pctPessoal >= 25;
              const parado = p.coletorParadoHa !== null && p.coletorParadoHa >= 24;
              return (
                <tr key={p.usuarioId} className="border-t border-gray-100 hover:bg-gray-50 cursor-pointer" onClick={() => onAbrir(p.usuarioId, dia)}>
                  <td className="px-3 py-2">
                    <div className="font-medium">{p.nome}</div>
                    {p.cargo && <div className="text-xs text-gray-500">{p.cargo}</div>}
                    {parado && <div className="text-xs flex items-center gap-1" style={{ color: "var(--avoce-warn)" }}><AlertTriangle size={12} /> coletor parado há {Math.floor(p.coletorParadoHa as number)} h</div>}
                  </td>
                  <td className="px-3 py-2">{fmtDur(dentro.ativo)}</td>
                  <td className="px-3 py-2">{fmtDur(fora.ativo)}</td>
                  <td className="px-3 py-2">{periodo === "dia" ? fmtHora(inicio) : "—"}</td>
                  <td className="px-3 py-2">{periodo === "dia" ? fmtHora(fim) : "—"}</td>
                  <td className="px-3 py-2">
                    <div className="flex h-3 rounded overflow-hidden" style={{ background: "var(--avoce-hair-soft)" }}>
                      {total > 0 && (["trabalho", "pessoal", "neutro"] as const).map((c) => (
                        <div key={c} title={`${c}: ${fmtDur(dentro[c])}`} style={{ width: `${(dentro[c] / total) * 100}%`, background: COR_CAT[c] }} />
                      ))}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <span className="flex items-center gap-1" style={{ color: alerta ? "var(--avoce-warn)" : undefined, fontWeight: alerta ? 600 : 400 }}>
                      {alerta && <AlertTriangle size={13} />}{pctPessoal.toFixed(0)}%
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-gray-500">Totais consideram o tempo ativo dentro do expediente. Clique numa linha para ver o dia da pessoa.</p>
    </div>
  );
}
