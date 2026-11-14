import { useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { trpc } from "../../lib/trpc";
import { card, btn, COR_CAT, fmtDur, fmtHora, hojeStr, segDoDia, somarDias, type Cat } from "./util";

type Bloco = { inicio: Date | string; fim: Date | string; categoria: Cat | "pausa"; chave: string; titulos: string[] };

const LISTAS: { cat: Cat; titulo: string }[] = [
  { cat: "trabalho", titulo: "Trabalho" },
  { cat: "pessoal", titulo: "Pessoal" },
  { cat: "neutro", titulo: "Neutro" },
];

export default function Pessoa({ usuarioId, setUsuarioId, dia, setDia }: {
  usuarioId: string | null; setUsuarioId: (id: string | null) => void; dia: string; setDia: (d: string) => void;
}) {
  const [sel, setSel] = useState<number | null>(null);
  const pessoas = trpc.produtividade.pessoas.listar.useQuery();
  const q = trpc.produtividade.pessoa.useQuery({ usuarioId: usuarioId ?? "", data: dia }, { enabled: !!usuarioId });

  const dados = q.data as undefined | {
    blocos?: Bloco[];
    top?: Record<Cat, { chave: string; seg: number }[]>;
    primeiroEvento?: Date | string | null;
    ultimoEvento?: Date | string | null;
  };
  const blocos = dados?.blocos ?? [];
  const pessoa = pessoas.data?.find((p) => p.id === usuarioId);
  const exp = pessoa?.expediente as { dias: number[]; inicio: string; fim: string } | null | undefined;
  const expPadrao = exp ?? { dias: [1, 2, 3, 4, 5], inicio: "08:00", fim: "18:00" };
  const dow = new Date(`${dia}T00:00:00Z`).getUTCDay();
  const hm = (s: string) => Number(s.slice(0, 2)) * 3600 + Number(s.slice(3, 5)) * 60;
  const mostraExp = expPadrao.dias.includes(dow);
  const blocoSel = sel !== null ? blocos[sel] : undefined;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <select value={usuarioId ?? ""} onChange={(e) => { setUsuarioId(e.target.value || null); setSel(null); }} className="border border-gray-300 rounded-md px-2 py-1 text-sm bg-white">
          <option value="">Escolha uma pessoa...</option>
          {pessoas.data?.map((p) => <option key={p.id} value={p.id}>{p.nome}</option>)}
        </select>
        <div className="flex items-center gap-1">
          <button className={btn} onClick={() => { setDia(somarDias(dia, -1)); setSel(null); }} aria-label="Dia anterior"><ChevronLeft size={14} /></button>
          <input type="date" value={dia} max={hojeStr()} onChange={(e) => { if (e.target.value) { setDia(e.target.value); setSel(null); } }} className="border border-gray-300 rounded-md px-2 py-1 text-sm" />
          <button className={btn} onClick={() => { setDia(somarDias(dia, 1)); setSel(null); }} aria-label="Próximo dia"><ChevronRight size={14} /></button>
        </div>
        {dados && <span className="text-xs text-gray-500">Primeiro evento {fmtHora(dados.primeiroEvento)} · último {fmtHora(dados.ultimoEvento)}</span>}
      </div>

      {!usuarioId && <p className="text-sm text-gray-500">Escolha uma pessoa ou clique numa linha da aba Equipe.</p>}
      {q.isLoading && usuarioId && <p className="text-sm text-gray-400">Carregando...</p>}
      {q.error && <p className="text-sm text-red-600">{q.error.message}</p>}

      {dados && (
        <>
          <div className={`${card} p-4`}>
            <div className="relative h-10 rounded overflow-hidden" style={{ background: "var(--avoce-paper-deep)" }}>
              {mostraExp && (
                <div className="absolute top-0 bottom-0" style={{
                  left: `${(hm(expPadrao.inicio) / 86400) * 100}%`,
                  width: `${((hm(expPadrao.fim) - hm(expPadrao.inicio)) / 86400) * 100}%`,
                  background: "rgba(201,169,97,0.25)",
                }} title={`Expediente ${expPadrao.inicio}–${expPadrao.fim}`} />
              )}
              {blocos.map((b, i) => {
                const ini = segDoDia(b.inicio);
                const dur = Math.max((new Date(b.fim).getTime() - new Date(b.inicio).getTime()) / 1000, 0);
                return (
                  <button key={i} onClick={() => setSel(i)}
                    className="absolute top-1 bottom-1 rounded-sm"
                    style={{
                      left: `${(ini / 86400) * 100}%`,
                      width: `max(${(dur / 86400) * 100}%, 2px)`,
                      background: COR_CAT[b.categoria],
                      outline: sel === i ? "2px solid var(--avoce-navy)" : "none",
                    }}
                    title={`${fmtHora(b.inicio)}–${fmtHora(b.fim)} · ${b.categoria === "pausa" ? "pausa" : b.chave}`} />
                );
              })}
            </div>
            <div className="relative h-4 mt-1 text-[10px] text-gray-500">
              {Array.from({ length: 13 }, (_, i) => i * 2).map((h) => (
                <span key={h} className="absolute -translate-x-1/2" style={{ left: `${(h / 24) * 100}%` }}>{String(h).padStart(2, "0")}h</span>
              ))}
            </div>
            <div className="flex flex-wrap gap-4 mt-3 text-xs text-gray-500">
              {(["trabalho", "pessoal", "neutro", "pausa"] as const).map((c) => (
                <span key={c} className="flex items-center gap-1"><i className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: COR_CAT[c] }} />{c}</span>
              ))}
              {mostraExp && <span className="flex items-center gap-1"><i className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: "rgba(201,169,97,0.4)" }} />expediente</span>}
            </div>
            {blocos.length === 0 && <p className="text-sm text-gray-400 mt-3">Sem atividade registrada neste dia.</p>}
            {blocoSel && (
              <div className="mt-3 p-3 rounded-md border border-gray-200 text-sm" style={{ background: "var(--avoce-paper)" }}>
                <div className="font-medium">{blocoSel.categoria === "pausa" ? "Pausa" : blocoSel.chave} <span className="text-xs text-gray-500">({blocoSel.categoria}) {fmtHora(blocoSel.inicio)}–{fmtHora(blocoSel.fim)}</span></div>
                {blocoSel.titulos.length > 0 && (
                  <ul className="mt-1 text-xs text-gray-600 list-disc pl-4 space-y-0.5">
                    {blocoSel.titulos.map((t, i) => <li key={i} className="break-all">{t}</li>)}
                  </ul>
                )}
              </div>
            )}
          </div>

          <div className="grid md:grid-cols-3 gap-4">
            {LISTAS.map(({ cat, titulo }) => (
              <div key={cat} className={`${card} p-3`}>
                <h3 className="text-xs font-semibold mb-2 flex items-center gap-1.5" style={{ color: "var(--avoce-navy)" }}>
                  <i className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: COR_CAT[cat] }} />Top 10 · {titulo}
                </h3>
                <ol className="text-sm space-y-1">
                  {(dados.top?.[cat] ?? []).slice(0, 10).map((it) => (
                    <li key={it.chave} className="flex justify-between gap-2"><span className="truncate" title={it.chave}>{it.chave}</span><span className="text-gray-500 shrink-0">{fmtDur(it.seg)}</span></li>
                  ))}
                  {!(dados.top?.[cat]?.length) && <li className="text-xs text-gray-400">Nada registrado</li>}
                </ol>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
