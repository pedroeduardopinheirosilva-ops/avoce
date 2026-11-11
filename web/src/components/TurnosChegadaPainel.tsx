import { useState } from "react";
import { Clock, AlertTriangle } from "lucide-react";
import { trpc } from "../lib/trpc";

type Recorte = "todos" | "uteis" | "fimDeSemana";

const TURNOS = [
  { chave: "madrugada", rotulo: "Madrugada", faixa: "0h–6h",   de: 0,  ate: 6,  cor: "bg-indigo-400",  texto: "text-indigo-700" },
  { chave: "manha",     rotulo: "Manhã",     faixa: "6h–12h",  de: 6,  ate: 12, cor: "bg-amber-400",   texto: "text-amber-700" },
  { chave: "tarde",     rotulo: "Tarde",     faixa: "12h–18h", de: 12, ate: 18, cor: "bg-orange-500",  texto: "text-orange-700" },
  { chave: "noite",     rotulo: "Noite",     faixa: "18h–24h", de: 18, ate: 24, cor: "bg-sky-600",     texto: "text-sky-700" },
] as const;

const pct = (a: number, b: number) => (b > 0 ? `${((a / b) * 100).toFixed(1).replace(".", ",")}%` : "—");
const fmtDia = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;

/**
 * Horário de chegada dos leads do funil no período: % por turno e distribuição hora a hora,
 * com recorte dias úteis × fim de semana. Serve para casar horário de anúncio e escala da SDR
 * com a hora em que o lead realmente chega.
 */
export function TurnosChegadaPainel({ de, ate, pipelineIds }: { de: string; ate: string; pipelineIds?: string[] }) {
  const [recorte, setRecorte] = useState<Recorte>("todos");
  const q = trpc.painel.turnos.useQuery({ de, ate, pipelineIds }, { enabled: !!pipelineIds?.length, keepPreviousData: true });

  const horas = (q.data?.horas ?? []).map(h => ({
    hora: h.hora,
    qtd: recorte === "todos" ? h.uteis + h.fimDeSemana : h[recorte],
  }));
  const total = horas.reduce((a, h) => a + h.qtd, 0);
  const porTurno = TURNOS.map(t => ({
    ...t,
    qtd: horas.filter(h => h.hora >= t.de && h.hora < t.ate).reduce((a, h) => a + h.qtd, 0),
  }));
  const maxHora = Math.max(1, ...horas.map(h => h.qtd));
  const corDaHora = (hora: number) => TURNOS.find(t => hora >= t.de && hora < t.ate)!.cor;

  // Funil carregado em lote: quase tudo num dia só, com a hora da carga
  const pico = q.data?.picoDia;
  const emLote = !!pico && (q.data?.total ?? 0) >= 20 && pico.qtd / (q.data?.total ?? 1) >= 0.5;

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4 mb-4">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <div className="flex items-center gap-2">
          <Clock size={16} className="text-gray-400" />
          <h2 className="text-sm font-semibold text-gray-800">Chegada por turno</h2>
          <span className="text-xs text-gray-400">hora de entrada do lead no funil (Brasília)</span>
        </div>
        <div className="flex gap-1">
          {([["todos", "Todos os dias"], ["uteis", "Dias úteis"], ["fimDeSemana", "Fim de semana"]] as [Recorte, string][]).map(([k, r]) => (
            <button
              key={k}
              onClick={() => setRecorte(k)}
              className={`px-2.5 py-1 rounded-full text-xs border transition-colors ${
                recorte === k ? "bg-gray-900 text-white border-gray-900" : "bg-white text-gray-600 border-gray-200 hover:border-gray-300"
              }`}
            >
              {r}
            </button>
          ))}
        </div>
      </div>

      {emLote && (
        <div className="flex items-start gap-2 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-3">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span>
            {pico!.qtd} dos {q.data!.total} leads do período entraram em {fmtDia(pico!.dia)} — parece carga em lote
            (import ou lista de prospecção). Nesses, a hora é a da carga, não a da chegada do lead.
          </span>
        </div>
      )}

      {q.isLoading ? (
        <p className="text-sm text-gray-400 py-6 text-center">Carregando…</p>
      ) : total === 0 ? (
        <p className="text-sm text-gray-400 py-6 text-center">Nenhum lead no período.</p>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-3">
            {porTurno.map(t => (
              <div key={t.chave} className="border border-gray-100 rounded-lg p-2.5">
                <p className="text-[11px] text-gray-400 flex items-center gap-1.5">
                  <span className={`w-2 h-2 rounded-full ${t.cor}`} /> {t.rotulo} · {t.faixa}
                </p>
                <p className={`text-xl font-semibold tabular-nums ${t.texto}`}>{pct(t.qtd, total)}</p>
                <p className="text-[11px] text-gray-400 tabular-nums">{t.qtd} leads</p>
              </div>
            ))}
          </div>

          {/* barra empilhada dos turnos */}
          <div className="flex h-2 rounded-full overflow-hidden mb-4">
            {porTurno.map(t => (
              <div key={t.chave} className={t.cor} style={{ width: `${(t.qtd / total) * 100}%` }} title={`${t.rotulo}: ${pct(t.qtd, total)}`} />
            ))}
          </div>

          {/* hora a hora */}
          <div className="flex items-end gap-[3px] h-24">
            {horas.map(h => (
              <div key={h.hora} className="flex-1 h-full flex flex-col justify-end" title={`${h.hora}h–${h.hora + 1}h: ${h.qtd} leads (${pct(h.qtd, total)})`}>
                <div className={`${corDaHora(h.hora)} rounded-t-sm opacity-80 hover:opacity-100`} style={{ height: `${(h.qtd / maxHora) * 100}%`, minHeight: h.qtd ? 2 : 0 }} />
              </div>
            ))}
          </div>
          <div className="flex gap-[3px] mt-1">
            {horas.map(h => (
              <span key={h.hora} className="flex-1 text-center text-[10px] text-gray-400 tabular-nums">
                {h.hora % 3 === 0 ? h.hora : ""}
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
