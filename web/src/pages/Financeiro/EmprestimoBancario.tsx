import { useState } from "react";
import { trpc } from "../../lib/trpc";
import { exportarExcel } from "../../lib/exportar";
import {
  Abas, ABAS_EMPRESTIMOS, Avisos, BotoesExportar, Cabecalho, Card, ErroBox, ExigeEmitente, Kpi, Pill, TabelaWrap, Vazio,
  btnPri, btnSec, fmtBrl, fmtData, fmtMes, fmtNum, fmtPct, num, td, th, useEmitenteFin, useFinPermissoes, type RO,
} from "./fin-ui";
import {
  BotaoExcluirEmprestimo, ModalEmprestimo, ModalMov, ROTULO_MOV_EMP, SeletorEmprestimo, TabelaMovs, useEmprestimoSelecionado,
  type MovEmp, type TipoMovEmp,
} from "./emprestimo-comum";

type Cron = RO["fin"]["emprestimos"]["cronogramaBancario"];
const TIPOS_PAG: TipoMovEmp[] = ["pagamento_parcela", "pagamento_juros", "amortizacao", "devolucao"];
const PAGAMENTO = new Set<string>(TIPOS_PAG);

function Parametros({ e }: { e: RO["fin"]["emprestimos"]["obter"] }) {
  const itens: Array<[string, string]> = [
    ["Contratação", fmtData(e.dataContratacao as unknown as string)],
    ["Valor contratado", fmtBrl(e.valor)],
    ["Carência", `${e.carenciaMeses} mês(es)${e.carenciaMeses ? ` — juros ${e.carenciaModo === "capitalizados" ? "capitalizados" : "pagos"}` : ""}`],
    ["Taxa", `Selic + ${fmtNum(e.spreadAnual, 2)}% a.a.`],
    ["Parcelas", e.numParcelas ? `${e.numParcelas} (${e.sistema === "price" ? "Price" : "SAC"})` : "—"],
    ["IOF", fmtBrl(e.iof)],
    ["Tarifas", fmtBrl(e.tarifas)],
    ["Fonte", e.fonte?.nome ?? "(padrão)"],
  ];
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-2 p-4 text-sm">
      {itens.map(([k, v]) => (
        <div key={k}><p className="text-xs text-gray-500">{k}</p><p className="font-medium text-gray-800">{v}</p></div>
      ))}
    </div>
  );
}

function Cronograma({ c }: { c: Cron }) {
  return (
    <TabelaWrap>
      <table className="w-full text-sm">
        <thead className="bg-gray-50 border-b"><tr>
          <th className={`${th} text-left`}>#</th><th className={`${th} text-left`}>Vencimento</th><th className={`${th} text-left`}>Fase</th>
          <th className={`${th} text-right`}>Taxa do mês</th><th className={`${th} text-right`}>Saldo inicial</th>
          <th className={`${th} text-right`}>Juros</th><th className={`${th} text-right`}>Amortização</th>
          <th className={`${th} text-right`}>Prestação</th><th className={`${th} text-right`}>Saldo final</th>
          <th className={`${th} text-right`}>Pago (real)</th><th className={`${th} text-right`}>Diferença</th>
        </tr></thead>
        <tbody className="divide-y divide-gray-100">
          {c.linhas.map((l) => (
            <tr key={l.numero} className={l.projetado ? "bg-amber-50/40" : l.vencida ? "" : "bg-blue-50/30"}>
              <td className={td}>{l.numero}{l.parcelaAmortizacao ? <span className="text-xs text-gray-400"> ({l.parcelaAmortizacao})</span> : ""}</td>
              <td className={td}>{fmtData(l.vencimento)}</td>
              <td className={td}>{l.fase === "carencia" ? <Pill cor="blue">carência</Pill> : "amortização"}</td>
              <td className={`${td} text-right`} title={`Selic ${fmtMes(l.refAno, l.refMes)}: ${fmtPct(l.selicPct, 4)}`}>
                {fmtPct(l.taxaMensalPct, 4)} {l.projetado && <Pill cor="amber" title="Selic projetada (mês sem taxa publicada)">proj.</Pill>}
              </td>
              <td className={`${td} text-right`}>{fmtBrl(l.saldoInicial)}</td>
              <td className={`${td} text-right`}>
                {fmtBrl(l.juros)}
                {l.jurosCapitalizados > 0 && <div className="text-[10px] text-amber-700">capitalizado {fmtBrl(l.jurosCapitalizados)}</div>}
              </td>
              <td className={`${td} text-right`}>{fmtBrl(l.amortizacao)}</td>
              <td className={`${td} text-right font-semibold`}>{fmtBrl(l.prestacao)}</td>
              <td className={`${td} text-right`}>{fmtBrl(l.saldoFinal)}</td>
              <td className={`${td} text-right`}>{l.vencida ? fmtBrl(l.pagoReal) : <span className="text-gray-400">a vencer</span>}</td>
              <td className={`${td} text-right ${l.diferenca > 0 ? "text-red-600 font-medium" : l.diferenca < 0 ? "text-blue-700" : "text-gray-400"}`}>
                {l.vencida ? (l.diferenca === 0 ? "ok" : fmtBrl(l.diferenca)) : "—"}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot className="bg-gray-100 font-semibold text-sm">
          <tr>
            <td className={td} colSpan={5}>Totais</td>
            <td className={`${td} text-right`}>{fmtBrl(c.totalJuros)}</td>
            <td className={`${td} text-right`}>{fmtBrl(c.totalAmortizado)}</td>
            <td className={`${td} text-right`}>{fmtBrl(c.totalPago)}</td>
            <td className={td} />
            <td className={`${td} text-right`}>{fmtBrl(c.totalPagoReal)}</td>
            <td className={td} />
          </tr>
        </tfoot>
      </table>
    </TabelaWrap>
  );
}

function Detalhe({ emitenteId, id }: { emitenteId: string; id: string }) {
  const { podeEditar } = useFinPermissoes();
  const det = trpc.fin.emprestimos.obter.useQuery({ id });
  const cron = trpc.fin.emprestimos.cronogramaBancario.useQuery({ id }, { retry: false });
  const [modalMov, setModalMov] = useState<{ mov?: MovEmp } | null>(null);
  const [editar, setEditar] = useState(false);

  if (det.error) return <ErroBox erro={det.error} />;
  if (!det.data) return <div className="bg-white border rounded-xl p-8 text-center text-sm text-gray-400 animate-pulse">Carregando…</div>;
  const e = det.data;

  async function exportar(c: Cron) {
    await exportarExcel({
      nomeArquivo: `cronograma-${e.nome}`,
      abas: [
        {
          nome: "Cronograma",
          colunas: [
            { chave: "numero", titulo: "#", tipo: "numero" }, { chave: "parcela", titulo: "Parcela", tipo: "numero" },
            { chave: "vencimento", titulo: "Vencimento", tipo: "data" }, { chave: "fase", titulo: "Fase" },
            { chave: "selic", titulo: "Selic do mês (% a.m.)", tipo: "numero" }, { chave: "taxa", titulo: "Taxa do mês (% a.m.)", tipo: "numero" },
            { chave: "proj", titulo: "Projetado" }, { chave: "saldoInicial", titulo: "Saldo inicial", tipo: "moeda" },
            { chave: "juros", titulo: "Juros", tipo: "moeda" }, { chave: "jurosCap", titulo: "Juros capitalizados", tipo: "moeda" },
            { chave: "amortizacao", titulo: "Amortização", tipo: "moeda" }, { chave: "prestacao", titulo: "Prestação", tipo: "moeda" },
            { chave: "saldoFinal", titulo: "Saldo final", tipo: "moeda" }, { chave: "pago", titulo: "Pago (real)", tipo: "moeda" },
            { chave: "dif", titulo: "Diferença", tipo: "moeda" },
          ],
          linhas: c.linhas.map((l) => ({
            numero: l.numero, parcela: l.parcelaAmortizacao, vencimento: l.vencimento, fase: l.fase === "carencia" ? "Carência" : "Amortização",
            selic: l.selicPct, taxa: l.taxaMensalPct, proj: l.projetado ? "Sim" : "", saldoInicial: l.saldoInicial, juros: l.juros,
            jurosCap: l.jurosCapitalizados, amortizacao: l.amortizacao, prestacao: l.prestacao, saldoFinal: l.saldoFinal,
            pago: l.vencida ? l.pagoReal : null, dif: l.vencida ? l.diferenca : null,
          })),
        },
        {
          nome: "Resumo",
          colunas: [{ chave: "k", titulo: "Item", largura: 40 }, { chave: "v", titulo: "Valor", tipo: "moeda" }],
          linhas: [
            { k: "Valor contratado", v: num(e.valor) }, { k: "Custo de contratação (IOF + tarifas)", v: c.custoContratacao },
            { k: "Valor líquido recebido", v: c.valorLiquidoRecebido }, { k: "Saldo no fim da carência", v: c.saldoFimCarencia },
            { k: "Total de juros (previsto)", v: c.totalJuros }, { k: "Custo total (juros + IOF + tarifas)", v: c.custoTotal },
            { k: "Total pago (real)", v: c.totalPagoReal }, { k: "Juros incorridos até hoje", v: c.jurosIncorridosAteHoje },
            { k: "Saldo devedor contratual hoje", v: c.saldoContratualHoje },
          ],
        },
        {
          nome: "Pagamentos",
          colunas: [{ chave: "data", titulo: "Data", tipo: "data" }, { chave: "tipo", titulo: "Tipo" }, { chave: "valor", titulo: "Valor", tipo: "moeda" }, { chave: "obs", titulo: "Obs.", largura: 40 }],
          linhas: c.pagamentosReais.map((p) => ({ data: p.data, tipo: ROTULO_MOV_EMP[p.tipo] ?? p.tipo, valor: p.valor, obs: p.obs })),
        },
      ],
    });
  }

  const c = cron.data;
  return (
    <div className="space-y-6">
      <div className="flex justify-between items-start gap-2 flex-wrap">
        <h2 className="text-lg font-semibold text-gray-900">{e.nome} {!e.ativo && <Pill>inativo</Pill>}</h2>
        <div className="flex gap-2 flex-wrap items-center no-print">
          {c && <BotoesExportar onExcel={() => exportar(c)} tituloPdf={`Cronograma ${e.nome}`} />}
          {podeEditar && (
            <>
              <button className={btnSec} onClick={() => setEditar(true)}>Editar parâmetros</button>
              <button className={btnPri} onClick={() => setModalMov({})}>+ Registrar pagamento</button>
            </>
          )}
        </div>
      </div>

      <Card titulo="Parâmetros"><Parametros e={e} /></Card>

      {cron.error ? <ErroBox erro={cron.error} titulo="Cronograma indisponível" /> : !c ? <div className="text-sm text-gray-400 animate-pulse">Calculando cronograma…</div> : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <Kpi rotulo="Saldo devedor hoje" cor="red" valor={fmtBrl(c.saldoContratualHoje)} detalhe="contratual (cronograma)" />
            <Kpi rotulo="Próxima parcela" valor={c.proximaParcela ? fmtBrl(c.proximaParcela.prestacao) : "—"}
              detalhe={c.proximaParcela ? <>{fmtData(c.proximaParcela.vencimento)}{c.proximaParcela.projetado ? " · taxa projetada" : ""}</> : undefined} />
            <Kpi rotulo="Juros incorridos até hoje" cor="amber" valor={fmtBrl(c.jurosIncorridosAteHoje)} />
            <Kpi rotulo="Custo total previsto" valor={fmtBrl(c.custoTotal)} detalhe={`IOF+tarifas ${fmtBrl(c.custoContratacao)} · líquido recebido ${fmtBrl(c.valorLiquidoRecebido)}`} />
          </div>
          <Avisos avisos={c.avisos} />
          {c.pagamentosForaDoCronograma.length > 0 && (
            <Avisos avisos={[`${c.pagamentosForaDoCronograma.length} pagamento(s) registrado(s) em mês sem parcela no cronograma: ${c.pagamentosForaDoCronograma.map((p) => `${fmtData(p.data)} ${fmtBrl(p.valor)}`).join(", ")}`]} />
          )}
          <Card titulo="Cronograma (real × projetado)" acoes={
            <span className="flex gap-3 text-xs text-gray-500">
              <span><span className="inline-block w-3 h-3 bg-amber-100 align-middle mr-1" />Selic projetada</span>
              <span><span className="inline-block w-3 h-3 bg-blue-50 align-middle mr-1" />a vencer</span>
            </span>
          }>
            <Cronograma c={c} />
          </Card>
        </>
      )}

      <Card titulo="Pagamentos registrados (reais)">
        <TabelaMovs movs={e.movs} podeEditar={podeEditar} onEditar={(m) => setModalMov({ mov: m })} filtro={(m) => PAGAMENTO.has(m.tipo)} />
      </Card>
      {podeEditar && <div className="no-print"><BotaoExcluirEmprestimo emp={e} onExcluido={() => undefined} /></div>}

      {modalMov && (
        <ModalMov emprestimoId={e.id} tiposPermitidos={TIPOS_PAG} permitePrevisto={false} mov={modalMov.mov} tipoPadrao="pagamento_parcela" onClose={() => setModalMov(null)} />
      )}
      {editar && <ModalEmprestimo emitenteId={emitenteId} tipo="bancario" emp={e} onClose={() => setEditar(false)} onSaved={() => undefined} />}
    </div>
  );
}

function Conteudo({ emitenteId }: { emitenteId: string }) {
  const { podeEditar } = useFinPermissoes();
  const lista = trpc.fin.emprestimos.listar.useQuery({ emitenteId, tipo: "bancario" });
  const { atual, setSel } = useEmprestimoSelecionado(lista.data);
  const [novo, setNovo] = useState(false);
  if (lista.error) return <ErroBox erro={lista.error} />;
  if (!lista.data) return <div className="bg-white border rounded-xl p-8 text-center text-sm text-gray-400 animate-pulse">Carregando…</div>;
  return (
    <div className="space-y-4">
      <div className="flex gap-2 items-center flex-wrap no-print">
        <SeletorEmprestimo lista={lista.data} atual={atual} onChange={setSel} />
        {podeEditar && <button className={btnSec} onClick={() => setNovo(true)}>+ Novo empréstimo bancário</button>}
      </div>
      {atual ? <Detalhe key={atual.id} emitenteId={emitenteId} id={atual.id} /> : (
        <Vazio texto={podeEditar ? "Nenhum empréstimo bancário cadastrado. Clique em “+ Novo empréstimo bancário”." : "Nenhum empréstimo bancário cadastrado."} />
      )}
      {novo && <ModalEmprestimo emitenteId={emitenteId} tipo="bancario" onClose={() => setNovo(false)} onSaved={(id) => setSel(id)} />}
    </div>
  );
}

export default function EmprestimoBancario() {
  const emit = useEmitenteFin();
  return (
    <div className="p-4 md:p-6 space-y-6">
      <Cabecalho titulo="Empréstimos" subtitulo="Empréstimo bancário: juros do mês = (1 + Selic do mês) × (1 + spread)^(1/12) − 1; meses passados com Selic real, futuros projetados." emitente={emit} />
      <Abas itens={ABAS_EMPRESTIMOS} />
      <ExigeEmitente ctl={emit}><Conteudo emitenteId={emit.emitenteId} /></ExigeEmitente>
    </div>
  );
}
