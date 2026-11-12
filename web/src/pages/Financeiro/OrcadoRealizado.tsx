import { useState } from "react";
import { trpc } from "../../lib/trpc";
import { exportarExcel } from "../../lib/exportar";
import {
  BotoesExportar, Cabecalho, ErroBox, ExigeEmitente, SeletorAno, TabelaWrap, anoAtual, fmtBrl, fmtMes, fmtPct,
  msgErro, parseValor, useEmitenteFin, useFinPermissoes, valorInput, type RO,
} from "./fin-ui";

type Dados = RO["fin"]["orcamento"]["orcadoRealizado"];
type Celula = Dados["total"];

function corCelula(c: Celula): string {
  if (c.orcado <= 0) return c.realizado > 0 ? "text-amber-700" : "text-gray-400";
  if (c.realizado > c.orcado) return "text-red-700 font-semibold";
  return "text-green-700";
}

function CelulaEditavel({ valor, podeEditar, onSalvar }: { valor: number; podeEditar: boolean; onSalvar: (v: number) => Promise<void> }) {
  const [texto, setTexto] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState(false);
  if (!podeEditar) return <span>{valor ? fmtBrl(valor) : "—"}</span>;
  const exibido = texto ?? (valor ? valorInput(valor) : "");
  async function confirmar() {
    if (texto === null) return;
    const v = texto.trim() === "" ? 0 : parseValor(texto);
    if (v === null || v < 0) { setErro(true); return; }
    if (Math.round(v * 100) === Math.round(valor * 100)) { setTexto(null); return; }
    setSalvando(true);
    try { await onSalvar(v); setTexto(null); setErro(false); } catch { setErro(true); } finally { setSalvando(false); }
  }
  return (
    <input
      value={exibido}
      onChange={(e) => { setTexto(e.target.value); setErro(false); }}
      onBlur={confirmar}
      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setTexto(null); }}
      placeholder="—"
      inputMode="decimal"
      disabled={salvando}
      title="Orçado (Enter para salvar)"
      className={`w-24 text-right border rounded px-1 py-0.5 text-xs bg-white ${erro ? "border-red-400" : "border-gray-200"} ${salvando ? "opacity-50" : ""}`}
    />
  );
}

function Grade({ emitenteId, ano }: { emitenteId: string; ano: number }) {
  const { podeEditar } = useFinPermissoes();
  const utils = trpc.useUtils();
  const q = trpc.fin.orcamento.orcadoRealizado.useQuery({ emitenteId, ano });
  const salvar = trpc.fin.orcamento.salvar.useMutation();
  const lote = trpc.fin.orcamento.salvarLote.useMutation();
  const [erro, setErro] = useState<string | null>(null);
  const [novaCat, setNovaCat] = useState("");
  const [extras, setExtras] = useState<string[]>([]);

  async function salvarCelula(categoria: string, mes: number, valor: number) {
    setErro(null);
    try {
      await salvar.mutateAsync({ emitenteId, categoria, ano, mes, valor });
      await utils.fin.orcamento.orcadoRealizado.invalidate({ emitenteId, ano });
      utils.fin.relatorios.painel.invalidate();
    } catch (e) {
      setErro(msgErro(e));
      throw e;
    }
  }

  async function replicar(categoria: string, valor: number) {
    if (!confirm(`Aplicar ${fmtBrl(valor)} em todos os meses de ${ano} para "${categoria}"?`)) return;
    setErro(null);
    try {
      await lote.mutateAsync({ emitenteId, itens: Array.from({ length: 12 }, (_, i) => ({ categoria, ano, mes: i + 1, valor })) });
      await utils.fin.orcamento.orcadoRealizado.invalidate({ emitenteId, ano });
    } catch (e) { setErro(msgErro(e)); }
  }

  if (q.error) return <ErroBox erro={q.error} />;
  if (!q.data) return <div className="bg-white border rounded-xl p-8 text-center text-sm text-gray-400 animate-pulse">Carregando…</div>;
  const d = q.data;
  const linhas = [
    ...d.linhas,
    ...extras.filter((c) => !d.linhas.some((l) => l.categoria === c)).map((categoria) => ({
      categoria,
      meses: d.meses.map(() => ({ orcado: 0, realizado: 0, diferenca: 0, percentual: null as number | null })),
      total: { orcado: 0, realizado: 0, diferenca: 0, percentual: null as number | null },
    })),
  ];

  async function exportar() {
    const colunas = [
      { chave: "categoria", titulo: "Categoria", largura: 26 },
      ...d.meses.flatMap((m, i) => [
        { chave: `o${i}`, titulo: `${fmtMes(m.ano, m.mes)} orçado`, tipo: "moeda" as const },
        { chave: `r${i}`, titulo: `${fmtMes(m.ano, m.mes)} realizado`, tipo: "moeda" as const },
      ]),
      { chave: "to", titulo: "Total orçado", tipo: "moeda" as const },
      { chave: "tr", titulo: "Total realizado", tipo: "moeda" as const },
      { chave: "td", titulo: "Diferença (orç. − real.)", tipo: "moeda" as const },
      { chave: "tp", titulo: "% realizado", tipo: "percentual" as const },
    ];
    const linhaX = (categoria: string, meses: Celula[], total: Celula) => {
      const r: Record<string, unknown> = { categoria, to: total.orcado, tr: total.realizado, td: total.diferenca, tp: total.percentual };
      meses.forEach((c, i) => { r[`o${i}`] = c.orcado; r[`r${i}`] = c.realizado; });
      return r;
    };
    await exportarExcel({
      nomeArquivo: `orcado-realizado-${ano}`,
      abas: [{ nome: `Orçado x realizado ${ano}`, colunas, linhas: [...d.linhas.map((l) => linhaX(l.categoria, l.meses, l.total)), linhaX("TOTAL", d.totais, d.total)] }],
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap no-print">
        <p className="text-xs text-gray-500">
          Realizado = despesas (pagas ou não) pela competência; sem competência, pela data. Categorias antigas contam na nova equivalente.
          {podeEditar && " Clique no valor orçado para editar (Enter salva)."}
        </p>
        <BotoesExportar onExcel={exportar} tituloPdf={`Orçado x realizado ${ano}`} />
      </div>
      {erro && <ErroBox erro={erro} titulo="Não foi possível salvar" />}
      <div className="bg-white border border-gray-200 rounded-xl">
        <TabelaWrap>
          <table className="text-xs min-w-full">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="px-2 py-2 text-left font-medium text-gray-500 sticky left-0 bg-gray-50 z-10 min-w-[150px]">Categoria</th>
                {d.meses.map((m) => <th key={`${m.ano}-${m.mes}`} className="px-2 py-2 text-right font-medium text-gray-500 whitespace-nowrap">{fmtMes(m.ano, m.mes)}</th>)}
                <th className="px-2 py-2 text-right font-medium text-gray-700 whitespace-nowrap">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {linhas.map((l) => (
                <tr key={l.categoria} className="hover:bg-gray-50 align-top">
                  <td className="px-2 py-1.5 font-medium text-gray-800 sticky left-0 bg-white z-10">
                    {l.categoria}
                    {podeEditar && l.meses.some((c) => c.orcado > 0) && (
                      <button className="block text-[10px] text-indigo-600 hover:underline no-print"
                        onClick={() => replicar(l.categoria, l.meses.find((c) => c.orcado > 0)!.orcado)}>
                        replicar 1º valor no ano
                      </button>
                    )}
                  </td>
                  {l.meses.map((c, i) => (
                    <td key={i} className="px-2 py-1.5 text-right whitespace-nowrap">
                      <CelulaEditavel valor={c.orcado} podeEditar={podeEditar} onSalvar={(v) => salvarCelula(l.categoria, d.meses[i].mes, v)} />
                      <div className={`mt-0.5 ${corCelula(c)}`} title={c.percentual !== null ? `${fmtPct(c.percentual, 1)} do orçado` : "sem orçamento"}>
                        {c.realizado ? fmtBrl(c.realizado) : "—"}
                      </div>
                    </td>
                  ))}
                  <td className="px-2 py-1.5 text-right whitespace-nowrap bg-gray-50">
                    <div className="text-gray-600">{fmtBrl(l.total.orcado)}</div>
                    <div className={corCelula(l.total)}>{fmtBrl(l.total.realizado)}</div>
                    {l.total.percentual !== null && <div className="text-[10px] text-gray-400">{fmtPct(l.total.percentual, 0)}</div>}
                  </td>
                </tr>
              ))}
              <tr className="bg-gray-100 font-semibold">
                <td className="px-2 py-2 sticky left-0 bg-gray-100 z-10">Total</td>
                {d.totais.map((c, i) => (
                  <td key={i} className="px-2 py-2 text-right whitespace-nowrap">
                    <div className="text-gray-600">{fmtBrl(c.orcado)}</div>
                    <div className={corCelula(c)}>{fmtBrl(c.realizado)}</div>
                  </td>
                ))}
                <td className="px-2 py-2 text-right whitespace-nowrap">
                  <div className="text-gray-600">{fmtBrl(d.total.orcado)}</div>
                  <div className={corCelula(d.total)}>{fmtBrl(d.total.realizado)}</div>
                  <div className={`text-[10px] ${d.total.diferenca < 0 ? "text-red-600" : "text-gray-500"}`}>dif. {fmtBrl(d.total.diferenca)}</div>
                </td>
              </tr>
            </tbody>
          </table>
        </TabelaWrap>
      </div>
      <div className="flex items-center gap-4 text-xs text-gray-500 flex-wrap">
        <span>Em cada célula: <b>orçado</b> (em cima) e <b>realizado</b> (embaixo).</span>
        <span className="text-green-700">● dentro do orçado</span>
        <span className="text-red-700">● acima do orçado</span>
        <span className="text-amber-700">● gasto sem orçamento</span>
      </div>
      {podeEditar && (
        <div className="flex items-center gap-2 no-print">
          <input value={novaCat} onChange={(e) => setNovaCat(e.target.value)} placeholder="Outra categoria para orçar" className="border rounded-lg px-3 py-1.5 text-sm" />
          <button className="text-sm text-indigo-600 hover:underline disabled:opacity-40" disabled={!novaCat.trim()}
            onClick={() => { setExtras([...extras, novaCat.trim()]); setNovaCat(""); }}>+ adicionar linha</button>
        </div>
      )}
    </div>
  );
}

export default function OrcadoRealizado() {
  const emit = useEmitenteFin();
  const [ano, setAno] = useState(anoAtual());
  return (
    <div className="p-4 md:p-6 space-y-6">
      <Cabecalho titulo="Orçado × Realizado" subtitulo="Orçamento mensal de despesas por categoria comparado ao realizado." emitente={emit}>
        <SeletorAno ano={ano} onChange={setAno} />
      </Cabecalho>
      <ExigeEmitente ctl={emit}>
        <Grade emitenteId={emit.emitenteId} ano={ano} />
      </ExigeEmitente>
    </div>
  );
}

