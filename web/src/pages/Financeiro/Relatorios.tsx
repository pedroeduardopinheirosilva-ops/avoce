/** Relatórios gerenciais: Fluxo de caixa projetado, DRE gerencial e Consumo por fonte. */
import { Fragment, useMemo, useState, type ReactNode } from "react";
import { trpc } from "../../lib/trpc";
import { exportarExcel, type ColunaExport } from "../../lib/exportar";
import {
  Abas, ABAS_RELATORIOS, Avisos, BotoesExportar, Cabecalho, Card, ErroBox, ExigeEmitente, Kpi, Pill, SeletorAno, TabelaWrap, Vazio,
  ROTULO_TIPO_FONTE, addMesStr, anoAtual, fmtBrl, fmtMes, mesAtualStr, parseValor, useEmitenteFin, valorInput, type RO,
} from "./fin-ui";

const tdN = "px-2 py-1.5 text-right whitespace-nowrap";
const thN = "px-2 py-2 text-right font-medium text-gray-500 whitespace-nowrap text-xs";
const tdRot = "px-2 py-1.5 text-left whitespace-nowrap sticky left-0 bg-white z-10 min-w-[200px]";

function Carregando() {
  return <div className="bg-white border rounded-xl p-8 text-center text-sm text-gray-400 animate-pulse">Carregando…</div>;
}

function cor(v: number): string {
  return v < 0 ? "text-red-700" : v > 0 ? "text-gray-900" : "text-gray-400";
}

function v0(v: number): string {
  return v === 0 ? "—" : fmtBrl(v);
}

// ── Fluxo de caixa projetado ────────────────────────────────────────────────

type Fluxo = RO["fin"]["relatorios"]["fluxoCaixa"];
type LinhaFluxo = keyof Fluxo["totais"];

const LINHAS_ENTRADA: Array<[LinhaFluxo, string]> = [
  ["honorarios_recebimentos", "Honorários e sucumbência recebidos"],
  ["receitas_lancamentos", "Outras receitas (lançamentos)"],
  ["aportes_psa", "Aportes do empréstimo PSA"],
  ["emprestimo_bancario", "Liberação do empréstimo bancário"],
  ["rendimento_aplicacao", "Rendimento de aplicações (líq. IR)"],
];
const LINHAS_SAIDA: Array<[LinhaFluxo, string]> = [
  ["despesas", "Despesas lançadas"],
  ["despesas_recorrentes", "Despesas recorrentes (projeção)"],
  ["parcelas_emprestimo", "Parcelas do empréstimo bancário"],
  ["devolucoes_psa", "Devoluções ao empréstimo PSA"],
];
const LINHAS_TERCEIROS: Array<[LinhaFluxo, string]> = [
  ["terceiros_entrada", "Recebido de terceiros (parte do cliente)"],
  ["terceiros_saida", "Repasse a clientes"],
];

function CelFluxo({ r, p, sinal }: { r: number; p: number; sinal: 1 | -1 }) {
  if (!r && !p) return <td className={`${tdN} text-gray-300`}>—</td>;
  return (
    <td className={tdN} title={`Realizado ${fmtBrl(sinal * r)} · Projetado ${fmtBrl(sinal * p)}`}>
      {r !== 0 && <div className={sinal < 0 ? "text-red-700" : "text-gray-900"}>{fmtBrl(sinal * r)}</div>}
      {p !== 0 && <div className={`italic ${sinal < 0 ? "text-red-400" : "text-amber-700"}`}>{fmtBrl(sinal * p)}</div>}
    </td>
  );
}

export function FluxoProjetado() {
  const emit = useEmitenteFin();
  return (
    <div className="p-4 md:p-6 space-y-6">
      <Cabecalho titulo="Relatórios gerenciais" subtitulo="Fluxo de caixa realizado + projetado; valores de terceiros em linhas separadas." emitente={emit} />
      <Abas itens={ABAS_RELATORIOS} />
      <ExigeEmitente ctl={emit}><FluxoConteudo emitenteId={emit.emitenteId} /></ExigeEmitente>
    </div>
  );
}

function FluxoConteudo({ emitenteId }: { emitenteId: string }) {
  const [de, setDe] = useState(mesAtualStr());
  const [meses, setMeses] = useState(12);
  const [saldoTxt, setSaldoTxt] = useState("");
  const [saldoAplicado, setSaldoAplicado] = useState<number | undefined>(undefined);
  const painel = trpc.fin.relatorios.painel.useQuery({ emitenteId });
  const q = trpc.fin.relatorios.fluxoCaixa.useQuery({ emitenteId, de, meses, saldoInicial: saldoAplicado });

  function aplicarSaldo() {
    const v = saldoTxt.trim() ? parseValor(saldoTxt) : null;
    setSaldoAplicado(v === null ? undefined : v);
  }

  async function exportar(f: Fluxo) {
    const colunas: ColunaExport[] = [
      { chave: "linha", titulo: "Linha", largura: 40 },
      ...f.meses.flatMap((m, i) => [
        { chave: `r${i}`, titulo: `${fmtMes(m.ano, m.mes)} realizado`, tipo: "moeda" as const },
        { chave: `p${i}`, titulo: `${fmtMes(m.ano, m.mes)} projetado`, tipo: "moeda" as const },
      ]),
      { chave: "tr", titulo: "Total realizado", tipo: "moeda" },
      { chave: "tp", titulo: "Total projetado", tipo: "moeda" },
    ];
    const linhaRP = (rot: string, k: LinhaFluxo, sinal: 1 | -1) => {
      const o: Record<string, unknown> = { linha: rot, tr: sinal * f.totais[k].realizado, tp: sinal * f.totais[k].projetado };
      f.meses.forEach((m, i) => { o[`r${i}`] = sinal * m.linhas[k].realizado; o[`p${i}`] = sinal * m.linhas[k].projetado; });
      return o;
    };
    const linhaTot = (rot: string, sel: (m: Fluxo["meses"][number]) => number) => {
      const o: Record<string, unknown> = { linha: rot };
      f.meses.forEach((m, i) => { o[`r${i}`] = sel(m); });
      return o;
    };
    await exportarExcel({
      nomeArquivo: `fluxo-caixa-projetado-${de}`,
      abas: [{
        nome: "Fluxo projetado",
        colunas,
        linhas: [
          linhaTot("Saldo inicial", (m) => m.saldoInicial),
          ...LINHAS_ENTRADA.map(([k, r]) => linhaRP(r, k, 1)),
          ...LINHAS_SAIDA.map(([k, r]) => linhaRP(r, k, -1)),
          linhaTot("Entradas do escritório", (m) => m.entradas),
          linhaTot("Saídas do escritório", (m) => -m.saidas),
          linhaTot("Líquido do escritório", (m) => m.liquidoEscritorio),
          ...LINHAS_TERCEIROS.map(([k, r]) => linhaRP(r, k, k === "terceiros_saida" ? -1 : 1)),
          linhaTot("Líquido de terceiros", (m) => m.liquidoTerceiros),
          linhaTot("Atrasados (vencidos não realizados)", (m) => m.atrasados),
          linhaTot("Saldo final", (m) => m.saldoFinal),
        ],
      }],
    });
  }

  const f = q.data;
  return (
    <div className="space-y-4">
      <div className="flex items-end gap-3 flex-wrap no-print">
        <label className="text-xs text-gray-600">A partir de<br /><input type="month" value={de} onChange={(e) => setDe(e.target.value || mesAtualStr())} className="border rounded-lg px-2 py-1.5 text-sm bg-white" /></label>
        <label className="text-xs text-gray-600">Horizonte<br />
          <select value={meses} onChange={(e) => setMeses(Number(e.target.value))} className="border rounded-lg px-2 py-1.5 text-sm bg-white">
            {[6, 12, 18, 24].map((n) => <option key={n} value={n}>{n} meses</option>)}
          </select>
        </label>
        <label className="text-xs text-gray-600">Saldo inicial (R$)<br />
          <input value={saldoTxt} onChange={(e) => setSaldoTxt(e.target.value)} onBlur={aplicarSaldo} onKeyDown={(e) => { if (e.key === "Enter") aplicarSaldo(); }}
            placeholder="0,00" inputMode="decimal" className="border rounded-lg px-2 py-1.5 text-sm w-32 text-right bg-white" />
        </label>
        {painel.data && (
          <button className="text-xs text-indigo-600 hover:underline pb-2" onClick={() => {
            const v = painel.data.saldoContas + painel.data.saldoAplicado;
            setSaldoTxt(valorInput(v)); setSaldoAplicado(v);
          }} title="Contas bancárias + aplicações">usar saldo atual ({fmtBrl(painel.data.saldoContas + painel.data.saldoAplicado)})</button>
        )}
        <button className="text-xs text-gray-500 hover:underline pb-2" onClick={() => setDe(addMesStr(de, -12))}>← 12 meses antes</button>
        {f && <span className="ml-auto"><BotoesExportar onExcel={() => exportar(f)} tituloPdf={`Fluxo de caixa projetado ${de}`} /></span>}
      </div>

      {q.error ? <ErroBox erro={q.error} /> : !f ? <Carregando /> : (
        <>
          <Avisos avisos={f.avisos} />
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <Kpi rotulo="Saldo inicial" valor={fmtBrl(f.meses[0]?.saldoInicial ?? 0)} />
            <Kpi rotulo="Saldo final projetado" cor={(f.meses[f.meses.length - 1]?.saldoFinal ?? 0) < 0 ? "red" : "indigo"} valor={fmtBrl(f.meses[f.meses.length - 1]?.saldoFinal ?? 0)} />
            <Kpi rotulo="Menor saldo no período" cor="amber" valor={fmtBrl(Math.min(...f.meses.map((m) => m.saldoFinal)))} />
            <Kpi rotulo="Atrasados no mês corrente" cor={f.meses.some((m) => m.atrasados > 0) ? "red" : "gray"} valor={fmtBrl(f.meses.reduce((a, m) => a + m.atrasados, 0))} detalhe="previstos vencidos ainda não realizados" />
          </div>
          <div className="bg-white border border-gray-200 rounded-xl">
            <TabelaWrap>
              <table className="text-xs min-w-full">
                <thead className="bg-gray-50 border-b">
                  <tr>
                    <th className="px-2 py-2 text-left font-medium text-gray-500 sticky left-0 bg-gray-50 z-10">Linha</th>
                    {f.meses.map((m) => (
                      <th key={`${m.ano}-${m.mes}`} className={`${thN} ${m.situacao === "corrente" ? "bg-indigo-50 text-indigo-700" : m.situacao === "futuro" ? "text-amber-700" : ""}`}>
                        {fmtMes(m.ano, m.mes)}<div className="font-normal text-[10px]">{m.situacao === "passado" ? "realizado" : m.situacao === "corrente" ? "mês atual" : "projetado"}</div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  <tr className="bg-gray-50 font-medium"><td className={`${tdRot} bg-gray-50`}>Saldo inicial</td>{f.meses.map((m, i) => <td key={i} className={`${tdN} ${cor(m.saldoInicial)}`}>{fmtBrl(m.saldoInicial)}</td>)}</tr>
                  <tr><td colSpan={f.meses.length + 1} className="px-2 pt-2 text-[10px] uppercase tracking-wide text-gray-400">Entradas</td></tr>
                  {LINHAS_ENTRADA.map(([k, r]) => <tr key={k}><td className={tdRot}>{r}</td>{f.meses.map((m, i) => <CelFluxo key={i} r={m.linhas[k].realizado} p={m.linhas[k].projetado} sinal={1} />)}</tr>)}
                  <tr><td colSpan={f.meses.length + 1} className="px-2 pt-2 text-[10px] uppercase tracking-wide text-gray-400">Saídas</td></tr>
                  {LINHAS_SAIDA.map(([k, r]) => <tr key={k}><td className={tdRot}>{r}</td>{f.meses.map((m, i) => <CelFluxo key={i} r={m.linhas[k].realizado} p={m.linhas[k].projetado} sinal={-1} />)}</tr>)}
                  <tr className="font-semibold bg-gray-50"><td className={`${tdRot} bg-gray-50`}>Líquido do escritório</td>{f.meses.map((m, i) => <td key={i} className={`${tdN} ${cor(m.liquidoEscritorio)}`} title={`Entradas ${fmtBrl(m.entradas)} · Saídas ${fmtBrl(m.saidas)}`}>{fmtBrl(m.liquidoEscritorio)}</td>)}</tr>
                  <tr><td colSpan={f.meses.length + 1} className="px-2 pt-2 text-[10px] uppercase tracking-wide text-amber-600">Valores de terceiros (não são receita do escritório)</td></tr>
                  {LINHAS_TERCEIROS.map(([k, r]) => <tr key={k} className="bg-amber-50/40"><td className={`${tdRot} bg-amber-50`}>{r}</td>{f.meses.map((m, i) => <CelFluxo key={i} r={m.linhas[k].realizado} p={m.linhas[k].projetado} sinal={k === "terceiros_saida" ? -1 : 1} />)}</tr>)}
                  <tr className="bg-amber-50/40"><td className={`${tdRot} bg-amber-50`}>Líquido de terceiros</td>{f.meses.map((m, i) => <td key={i} className={`${tdN} ${cor(m.liquidoTerceiros)}`}>{v0(m.liquidoTerceiros)}</td>)}</tr>
                  <tr><td className={tdRot}>Atrasados (vencidos não realizados)</td>{f.meses.map((m, i) => <td key={i} className={`${tdN} ${m.atrasados ? "text-red-600 font-medium" : "text-gray-300"}`}>{v0(m.atrasados)}</td>)}</tr>
                  <tr className="bg-indigo-50 font-bold"><td className={`${tdRot} bg-indigo-50`}>Saldo final</td>{f.meses.map((m, i) => <td key={i} className={`${tdN} ${m.saldoFinal < 0 ? "text-red-700" : "text-indigo-900"}`}>{fmtBrl(m.saldoFinal)}</td>)}</tr>
                </tbody>
              </table>
            </TabelaWrap>
          </div>
          <p className="text-xs text-gray-500">
            Em cada célula: valor <b>realizado</b> (normal) e <i className="text-amber-700">projetado</i> (itálico). Aplicação/resgate são transferências internas (caixa + aplicações) e não aparecem.
            Previstos vencidos e não realizados entram no mês atual e somam em “Atrasados”. {f.ignorados ? `${f.ignorados} evento(s) fora do horizonte ignorado(s).` : ""}
          </p>
        </>
      )}
    </div>
  );
}

// ── DRE gerencial ───────────────────────────────────────────────────────────

type DreT = RO["fin"]["relatorios"]["dre"];
type LinhaCat = DreT["receitas"][number];

function SecaoDre({ titulo, linhas, total, n, sinal = 1 }: { titulo: string; linhas: LinhaCat[]; total: number[]; n: number; sinal?: 1 | -1 }) {
  const somaTot = total.reduce((a, b) => a + b, 0);
  return (
    <>
      <tr className="bg-gray-50"><td className={`${tdRot} bg-gray-50 font-semibold`}>{titulo}</td>{total.map((v, i) => <td key={i} className={`${tdN} font-semibold ${cor(sinal * v)}`}>{fmtBrl(sinal * v)}</td>)}<td className={`${tdN} font-semibold`}>{fmtBrl(sinal * somaTot)}</td></tr>
      {!linhas.length && <tr><td className={`${tdRot} text-gray-400`} colSpan={n + 2}>—</td></tr>}
      {linhas.map((l) => (
        <tr key={l.categoria}>
          <td className={`${tdRot} pl-5 text-gray-700`}>{l.categoria}</td>
          {l.valores.map((v, i) => <td key={i} className={`${tdN} ${v ? "" : "text-gray-300"}`}>{v ? fmtBrl(sinal * v) : "—"}</td>)}
          <td className={`${tdN} font-medium`}>{fmtBrl(sinal * l.total)}</td>
        </tr>
      ))}
    </>
  );
}

export function Dre() {
  const emit = useEmitenteFin();
  const [ano, setAno] = useState(anoAtual());
  return (
    <div className="p-4 md:p-6 space-y-6">
      <Cabecalho titulo="Relatórios gerenciais" subtitulo="DRE gerencial mensal por competência. Receita = honorários + sucumbência (nunca valores de terceiros)." emitente={emit}>
        <SeletorAno ano={ano} onChange={setAno} />
      </Cabecalho>
      <Abas itens={ABAS_RELATORIOS} />
      <ExigeEmitente ctl={emit}><DreConteudo emitenteId={emit.emitenteId} ano={ano} /></ExigeEmitente>
    </div>
  );
}

function DreConteudo({ emitenteId, ano }: { emitenteId: string; ano: number }) {
  const q = trpc.fin.relatorios.dre.useQuery({ emitenteId, ano });
  const d = q.data;

  async function exportar(x: DreT) {
    const colunas: ColunaExport[] = [
      { chave: "grupo", titulo: "Grupo", largura: 22 }, { chave: "linha", titulo: "Linha", largura: 36 },
      ...x.meses.map((m, i) => ({ chave: `m${i}`, titulo: fmtMes(m.ano, m.mes), tipo: "moeda" as const })),
      { chave: "total", titulo: "Total", tipo: "moeda" },
    ];
    const lin = (grupo: string, linha: string, vals: number[], total: number, s = 1) => {
      const o: Record<string, unknown> = { grupo, linha, total: s * total };
      vals.forEach((v, i) => { o[`m${i}`] = s * v; });
      return o;
    };
    const soma = (a: number[]) => a.reduce((p, c) => p + c, 0);
    await exportarExcel({
      nomeArquivo: `dre-gerencial-${ano}`,
      abas: [{
        nome: `DRE ${ano}`,
        colunas,
        linhas: [
          ...x.receitas.map((l) => lin("Receitas", l.categoria, l.valores, l.total)),
          lin("Receitas", "TOTAL RECEITAS", x.totalReceitas, soma(x.totalReceitas)),
          ...x.despesas.map((l) => lin("Despesas", l.categoria, l.valores, l.total, -1)),
          lin("Despesas", "TOTAL DESPESAS", x.totalDespesas, soma(x.totalDespesas), -1),
          lin("Resultado", "RESULTADO OPERACIONAL", x.resultadoOperacional, soma(x.resultadoOperacional)),
          ...x.financeiro.map((l) => lin("Financeiro", l.categoria, l.valores, l.total)),
          lin("Financeiro", "RESULTADO FINANCEIRO", x.resultadoFinanceiro, soma(x.resultadoFinanceiro)),
          lin("Resultado", "RESULTADO LÍQUIDO", x.resultadoLiquido, soma(x.resultadoLiquido)),
        ],
      }],
    });
  }

  if (q.error) return <ErroBox erro={q.error} />;
  if (!d) return <Carregando />;
  const n = d.meses.length;
  const soma = (a: number[]) => a.reduce((p, c) => p + c, 0);
  const linhaRes = (rot: string, vals: number[], destaque: string) => (
    <tr className={`${destaque} font-bold`}>
      <td className={`${tdRot} ${destaque}`}>{rot}</td>
      {vals.map((v, i) => <td key={i} className={`${tdN} ${cor(v)}`}>{fmtBrl(v)}</td>)}
      <td className={`${tdN} ${cor(soma(vals))}`}>{fmtBrl(soma(vals))}</td>
    </tr>
  );
  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center gap-2 flex-wrap no-print">
        <div className="grid grid-cols-3 gap-3 flex-1 min-w-[280px]">
          <Kpi rotulo={`Receitas ${ano}`} cor="green" valor={fmtBrl(soma(d.totalReceitas))} />
          <Kpi rotulo={`Despesas ${ano}`} cor="red" valor={fmtBrl(soma(d.totalDespesas))} />
          <Kpi rotulo="Resultado líquido" cor={soma(d.resultadoLiquido) < 0 ? "red" : "indigo"} valor={fmtBrl(soma(d.resultadoLiquido))} />
        </div>
        <BotoesExportar onExcel={() => exportar(d)} tituloPdf={`DRE gerencial ${ano}`} />
      </div>
      <div className="bg-white border border-gray-200 rounded-xl">
        <TabelaWrap>
          <table className="text-xs min-w-full">
            <thead className="bg-gray-50 border-b"><tr>
              <th className="px-2 py-2 text-left font-medium text-gray-500 sticky left-0 bg-gray-50 z-10">Linha</th>
              {d.meses.map((m) => <th key={`${m.ano}-${m.mes}`} className={thN}>{fmtMes(m.ano, m.mes)}</th>)}
              <th className={`${thN} text-gray-700`}>Total</th>
            </tr></thead>
            <tbody className="divide-y divide-gray-100">
              <SecaoDre titulo="Receitas do escritório" linhas={d.receitas} total={d.totalReceitas} n={n} />
              <SecaoDre titulo="(−) Despesas" linhas={d.despesas} total={d.totalDespesas} n={n} sinal={-1} />
              {linhaRes("Resultado operacional", d.resultadoOperacional, "bg-indigo-50")}
              <SecaoDre titulo="Resultado financeiro" linhas={d.financeiro} total={d.resultadoFinanceiro} n={n} />
              {linhaRes("Resultado líquido", d.resultadoLiquido, "bg-indigo-100")}
            </tbody>
          </table>
        </TabelaWrap>
      </div>
      <p className="text-xs text-gray-500">Despesas pela competência (sem competência, pela data); honorários pela data do recebimento. Financeiro: juros do bancário (por vencimento), IOF/tarifas, correção do PSA, rendimento e IR das aplicações.</p>
    </div>
  );
}

// ── Consumo por fonte ───────────────────────────────────────────────────────

type Consumo = RO["fin"]["relatorios"]["consumoPorFonte"];

export function ConsumoFonte() {
  const emit = useEmitenteFin();
  const [ano, setAno] = useState(anoAtual());
  return (
    <div className="p-4 md:p-6 space-y-6">
      <Cabecalho titulo="Relatórios gerenciais" subtitulo="Quanto cada fonte de recursos pagou, por categoria de despesa (competência)." emitente={emit}>
        <SeletorAno ano={ano} onChange={setAno} />
      </Cabecalho>
      <Abas itens={ABAS_RELATORIOS} />
      <ExigeEmitente ctl={emit}><ConsumoConteudo emitenteId={emit.emitenteId} ano={ano} /></ExigeEmitente>
    </div>
  );
}

function ConsumoConteudo({ emitenteId, ano }: { emitenteId: string; ano: number }) {
  const q = trpc.fin.relatorios.consumoPorFonte.useQuery({ emitenteId, de: `${ano}-01`, ate: `${ano}-12` });
  const [abertas, setAbertas] = useState<Set<string>>(new Set());
  const c = q.data;

  const matriz = useMemo(() => {
    if (!c) return null;
    const cats: string[] = [];
    for (const f of c.fontes) for (const l of f.categorias) if (!cats.includes(l.categoria)) cats.push(l.categoria);
    cats.sort((a, b) => a.localeCompare(b, "pt-BR"));
    const val = (fonteId: string, cat: string) => c.fontes.find((f) => f.fonteId === fonteId)?.categorias.find((l) => l.categoria === cat)?.total ?? 0;
    return { cats, val };
  }, [c]);

  async function exportar(x: Consumo) {
    if (!matriz) return;
    const colA: ColunaExport[] = [
      { chave: "categoria", titulo: "Categoria", largura: 26 },
      ...x.fontes.map((f, i) => ({ chave: `f${i}`, titulo: f.nome, tipo: "moeda" as const })),
      { chave: "total", titulo: "Total", tipo: "moeda" },
    ];
    const linA = matriz.cats.map((cat) => {
      const o: Record<string, unknown> = { categoria: cat };
      let t = 0;
      x.fontes.forEach((f, i) => { const v = matriz.val(f.fonteId, cat); o[`f${i}`] = v; t += v; });
      o.total = t;
      return o;
    });
    const tot: Record<string, unknown> = { categoria: "TOTAL", total: x.total };
    x.fontes.forEach((f, i) => { tot[`f${i}`] = f.total; });
    const colB: ColunaExport[] = [
      { chave: "fonte", titulo: "Fonte", largura: 28 }, { chave: "categoria", titulo: "Categoria", largura: 24 },
      ...x.meses.map((m, i) => ({ chave: `m${i}`, titulo: fmtMes(m.ano, m.mes), tipo: "moeda" as const })),
      { chave: "total", titulo: "Total", tipo: "moeda" },
    ];
    const linB: Array<Record<string, unknown>> = [];
    for (const f of x.fontes) {
      const o: Record<string, unknown> = { fonte: f.nome, categoria: "(todas)", total: f.total };
      f.porMes.forEach((v, i) => { o[`m${i}`] = v; });
      linB.push(o);
      for (const l of f.categorias) {
        const r: Record<string, unknown> = { fonte: f.nome, categoria: l.categoria, total: l.total };
        l.valores.forEach((v, i) => { r[`m${i}`] = v; });
        linB.push(r);
      }
    }
    await exportarExcel({
      nomeArquivo: `consumo-por-fonte-${ano}`,
      abas: [
        { nome: "Fonte x categoria", colunas: colA, linhas: [...linA, tot] },
        { nome: "Por mês", colunas: colB, linhas: linB },
      ],
    });
  }

  if (q.error) return <ErroBox erro={q.error} />;
  if (!c || !matriz) return <Carregando />;
  if (!c.fontes.length) return <Vazio texto={`Nenhuma despesa em ${ano}.`} />;

  const toggle = (id: string) => { const s = new Set(abertas); if (s.has(id)) s.delete(id); else s.add(id); setAbertas(s); };
  const rotFonte = (f: Consumo["fontes"][number]): ReactNode => (
    <>{f.nome} {f.tipo && <Pill>{ROTULO_TIPO_FONTE[f.tipo] ?? f.tipo}</Pill>} {f.fonteId === "sem_fonte" && <Pill cor="amber">sem rateio</Pill>}</>
  );

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center gap-2 flex-wrap no-print">
        <div className="flex gap-3 flex-wrap">
          {c.fontes.map((f) => (
            <div key={f.fonteId} className="bg-white border rounded-xl px-4 py-2">
              <p className="text-xs text-gray-500">{f.nome}</p>
              <p className="font-bold">{fmtBrl(f.total)}</p>
              <p className="text-[11px] text-gray-400">{c.total ? `${Math.round((f.total / c.total) * 1000) / 10}%` : ""}</p>
            </div>
          ))}
        </div>
        <BotoesExportar onExcel={() => exportar(c)} tituloPdf={`Consumo por fonte ${ano}`} />
      </div>

      <Card titulo={`Acumulado ${ano}: fonte × categoria`}>
        <TabelaWrap>
          <table className="text-xs min-w-full">
            <thead className="bg-gray-50 border-b"><tr>
              <th className="px-2 py-2 text-left font-medium text-gray-500 sticky left-0 bg-gray-50 z-10">Categoria</th>
              {c.fontes.map((f) => <th key={f.fonteId} className={thN}>{f.nome}</th>)}
              <th className={`${thN} text-gray-700`}>Total</th>
            </tr></thead>
            <tbody className="divide-y divide-gray-100">
              {matriz.cats.map((cat) => {
                const vals = c.fontes.map((f) => matriz.val(f.fonteId, cat));
                return (
                  <tr key={cat}>
                    <td className={tdRot}>{cat}</td>
                    {vals.map((v, i) => <td key={i} className={`${tdN} ${v ? "" : "text-gray-300"}`}>{v0(v)}</td>)}
                    <td className={`${tdN} font-medium`}>{fmtBrl(vals.reduce((a, b) => a + b, 0))}</td>
                  </tr>
                );
              })}
              <tr className="bg-gray-100 font-semibold">
                <td className={`${tdRot} bg-gray-100`}>Total</td>
                {c.fontes.map((f) => <td key={f.fonteId} className={tdN}>{fmtBrl(f.total)}</td>)}
                <td className={tdN}>{fmtBrl(c.total)}</td>
              </tr>
            </tbody>
          </table>
        </TabelaWrap>
      </Card>

      <Card titulo="Por mês (clique na fonte para abrir as categorias)">
        <TabelaWrap>
          <table className="text-xs min-w-full">
            <thead className="bg-gray-50 border-b"><tr>
              <th className="px-2 py-2 text-left font-medium text-gray-500 sticky left-0 bg-gray-50 z-10">Fonte</th>
              {c.meses.map((m) => <th key={`${m.ano}-${m.mes}`} className={thN}>{fmtMes(m.ano, m.mes)}</th>)}
              <th className={`${thN} text-gray-700`}>Total</th>
            </tr></thead>
            <tbody className="divide-y divide-gray-100">
              {c.fontes.map((f) => (
                <Fragment key={f.fonteId}>
                  <tr className="cursor-pointer hover:bg-gray-50 font-medium" onClick={() => toggle(f.fonteId)}>
                    <td className={tdRot}>{abertas.has(f.fonteId) ? "▾" : "▸"} {rotFonte(f)}</td>
                    {f.porMes.map((v, i) => <td key={i} className={`${tdN} ${v ? "" : "text-gray-300"}`}>{v0(v)}</td>)}
                    <td className={`${tdN} font-semibold`}>{fmtBrl(f.total)}</td>
                  </tr>
                  {abertas.has(f.fonteId) && f.categorias.map((l) => (
                    <tr key={`${f.fonteId}-${l.categoria}`} className="text-gray-600">
                      <td className={`${tdRot} pl-6`}>{l.categoria}</td>
                      {l.valores.map((v, i) => <td key={i} className={`${tdN} ${v ? "" : "text-gray-300"}`}>{v0(v)}</td>)}
                      <td className={tdN}>{fmtBrl(l.total)}</td>
                    </tr>
                  ))}
                </Fragment>
              ))}
              <tr className="bg-gray-100 font-semibold">
                <td className={`${tdRot} bg-gray-100`}>Total</td>
                {c.totalPorMes.map((v, i) => <td key={i} className={tdN}>{fmtBrl(v)}</td>)}
                <td className={tdN}>{fmtBrl(c.total)}</td>
              </tr>
            </tbody>
          </table>
        </TabelaWrap>
      </Card>
    </div>
  );
}
