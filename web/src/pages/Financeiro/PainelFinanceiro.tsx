import { Link } from "react-router-dom";
import { trpc } from "../../lib/trpc";
import { exportarExcel } from "../../lib/exportar";
import {
  BotoesExportar, Cabecalho, Card, ErroBox, ExigeEmitente, Kpi, TabelaWrap, fmtBrl, fmtData, fmtMesStr, fmtPct,
  mesAtualStr, td, th, useEmitenteFin, type RO,
} from "./fin-ui";

type Painel = RO["fin"]["relatorios"]["painel"];
type Indic = RO["fin"]["aplicacoes"]["indicadores"];

function percConsumido(i: Indic | undefined): number | null {
  // calculado no cliente a partir dos valores em reais (ver relatório: percentualConsumido do server sai dividido por 100)
  const c = i?.consumoEmprestimoBancario;
  if (!c || !c.valorLiquidoRecebido) return null;
  return Math.round((c.resgatesParaFonte / c.valorLiquidoRecebido) * 10000) / 100;
}

function Conteudo({ emitenteId, nomeEmitente }: { emitenteId: string; nomeEmitente: string }) {
  const painel = trpc.fin.relatorios.painel.useQuery({ emitenteId });
  const indic = trpc.fin.aplicacoes.indicadores.useQuery({ emitenteId });
  const p = painel.data;
  const i = indic.data;
  const pct = percConsumido(i);

  async function exportar(d: Painel) {
    const linhas: Array<Record<string, unknown>> = [
      { item: "Saldo devedor — empréstimo PSA", valor: d.saldoDevedorPsa },
      { item: "Saldo devedor — empréstimo bancário", valor: d.saldoDevedorBanco },
      { item: "Saldo aplicado", valor: d.saldoAplicado },
      { item: "Saldo em contas bancárias", valor: d.saldoContas },
      { item: "(−) Valores de terceiros (repasse pendente)", valor: -d.valoresTerceiros },
      { item: "Caixa disponível", valor: d.caixaDisponivel },
      { item: "Caixa disponível + aplicações", valor: d.caixaDisponivelComAplicacoes },
      { item: "Recebimentos previstos a receber", valor: d.recebimentos.previstoAReceber },
      { item: `Recebimentos em atraso (${d.recebimentos.qtdEmAtraso})`, valor: d.recebimentos.emAtraso },
      { item: `Despesas do mês ${fmtMesStr(mesAtualStr())} (orçado)`, valor: d.mesAtual.orcado },
      { item: `Despesas do mês ${fmtMesStr(mesAtualStr())} (realizado)`, valor: d.mesAtual.despesas },
      { item: "Despesas do mês já pagas", valor: d.mesAtual.despesasPagas },
    ];
    if (i) {
      linhas.push(
        { item: "Juros incorridos (bancário)", valor: i.custoLiquido.jurosIncorridos },
        { item: "Rendimento líquido de IR (aplicações)", valor: i.custoLiquido.rendimentoLiquido },
        { item: "Custo líquido do empréstimo", valor: i.custoLiquido.custoLiquido },
        { item: "Empréstimo bancário — valor líquido recebido", valor: i.consumoEmprestimoBancario.valorLiquidoRecebido },
        { item: "Empréstimo bancário — consumido (resgates p/ a fonte)", valor: i.consumoEmprestimoBancario.resgatesParaFonte },
        { item: "Empréstimo bancário — % consumido", pct: pct },
      );
    }
    await exportarExcel({
      nomeArquivo: `painel-financeiro-${d.hoje}`,
      abas: [
        { nome: "Painel", colunas: [{ chave: "item", titulo: "Indicador", largura: 50 }, { chave: "valor", titulo: "Valor", tipo: "moeda" }, { chave: "pct", titulo: "%", tipo: "percentual" }], linhas },
        {
          nome: "Empréstimos",
          colunas: [{ chave: "nome", titulo: "Empréstimo", largura: 30 }, { chave: "tipo", titulo: "Tipo" }, { chave: "saldo", titulo: "Saldo devedor", tipo: "moeda" },
            { chave: "venc", titulo: "Próxima parcela", tipo: "data" }, { chave: "prest", titulo: "Valor da parcela", tipo: "moeda" }],
          linhas: d.emprestimos.map((e) => ({ nome: e.nome, tipo: e.tipo === "psa" ? "PSA" : "Bancário", saldo: e.saldoDevedor, venc: e.proximaParcela?.vencimento, prest: e.proximaParcela?.prestacao })),
        },
        {
          nome: "Contas",
          colunas: [{ chave: "nome", titulo: "Conta", largura: 30 }, { chave: "saldo", titulo: "Saldo", tipo: "moeda" }, { chave: "data", titulo: "Data do saldo", tipo: "data" }],
          linhas: d.contas.map((c) => ({ nome: c.name, saldo: c.currentBalance, data: c.balanceDate as unknown as string })),
        },
      ],
    });
  }

  if (painel.error) return <ErroBox erro={painel.error} />;
  if (!p) return <div className="bg-white border rounded-xl p-8 text-center text-sm text-gray-400 animate-pulse">Carregando…</div>;

  const orc = p.mesAtual.orcado;
  const real = p.mesAtual.despesas;
  const pctOrc = orc > 0 ? (real / orc) * 100 : null;

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center flex-wrap gap-2">
        <p className="text-xs text-gray-500">Posição em {fmtData(p.hoje)} · {nomeEmitente}</p>
        <BotoesExportar onExcel={() => exportar(p)} tituloPdf={`Painel financeiro ${p.hoje}`} />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Kpi rotulo="Caixa disponível" cor="indigo" valor={fmtBrl(p.caixaDisponivel)}
          detalhe={<>Contas {fmtBrl(p.saldoContas)} − terceiros {fmtBrl(p.valoresTerceiros)}<br />Com aplicações: {fmtBrl(p.caixaDisponivelComAplicacoes)}</>} />
        <Kpi rotulo="Valores de terceiros" cor="amber" valor={fmtBrl(p.valoresTerceiros)}
          detalhe="Repasses pendentes a clientes — não são do escritório (abatidos do caixa)" />
        <Kpi rotulo="Saldo aplicado" cor="blue" valor={fmtBrl(p.saldoAplicado)} detalhe={<Link to="/financeiro/aplicacoes" className="underline no-print">ver aplicações</Link>} />
        <Kpi rotulo="Saldo em contas" valor={fmtBrl(p.saldoContas)} detalhe={`${p.contas.length} conta(s) ativa(s)`} />
        <Kpi rotulo="Saldo devedor PSA" cor="red" valor={fmtBrl(p.saldoDevedorPsa)} detalhe={<Link to="/financeiro/emprestimos/psa" className="underline no-print">ver extrato</Link>} />
        <Kpi rotulo="Saldo devedor banco" cor="red" valor={fmtBrl(p.saldoDevedorBanco)} detalhe={<Link to="/financeiro/emprestimos/bancario" className="underline no-print">ver cronograma</Link>} />
        <Kpi rotulo="Recebimentos previstos" cor="green" valor={fmtBrl(p.recebimentos.previstoAReceber)}
          detalhe={p.recebimentos.qtdSemNf ? `${p.recebimentos.qtdSemNf} recebido(s) sem NF` : undefined} />
        <Kpi rotulo="Recebimentos em atraso" cor={p.recebimentos.emAtraso > 0 ? "red" : "gray"} valor={fmtBrl(p.recebimentos.emAtraso)}
          detalhe={`${p.recebimentos.qtdEmAtraso} parcela(s)`} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card titulo={`Mês atual (${fmtMesStr(mesAtualStr())}) — orçado × realizado`} acoes={<Link to="/financeiro/orcamento" className="text-xs text-indigo-600 hover:underline">detalhar</Link>}>
          <div className="p-4 space-y-3">
            <div className="grid grid-cols-3 gap-2 text-sm">
              <div><p className="text-xs text-gray-500">Orçado</p><p className="font-semibold">{fmtBrl(orc)}</p></div>
              <div><p className="text-xs text-gray-500">Realizado</p><p className={`font-semibold ${orc > 0 && real > orc ? "text-red-700" : ""}`}>{fmtBrl(real)}</p></div>
              <div><p className="text-xs text-gray-500">Já pago</p><p className="font-semibold">{fmtBrl(p.mesAtual.despesasPagas)}</p></div>
            </div>
            {pctOrc !== null ? (
              <div>
                <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                  <div className={`h-full ${pctOrc > 100 ? "bg-red-500" : "bg-indigo-500"}`} style={{ width: `${Math.min(100, pctOrc)}%` }} />
                </div>
                <p className="text-xs text-gray-500 mt-1">{fmtPct(pctOrc, 1)} do orçado{pctOrc > 100 ? " — estourado" : ""}</p>
              </div>
            ) : <p className="text-xs text-gray-400">Sem orçamento cadastrado para o mês.</p>}
          </div>
        </Card>

        <Card titulo="Empréstimo bancário — custo e consumo">
          <div className="p-4 space-y-3 text-sm">
            {indic.error ? <ErroBox erro={indic.error} /> : !i ? <p className="text-gray-400 animate-pulse">Carregando…</p> : (
              <>
                <div className="grid grid-cols-3 gap-2">
                  <div><p className="text-xs text-gray-500">Juros incorridos</p><p className="font-semibold">{fmtBrl(i.custoLiquido.jurosIncorridos)}</p></div>
                  <div><p className="text-xs text-gray-500">Rend. líquido aplic.</p><p className="font-semibold text-green-700">{fmtBrl(i.custoLiquido.rendimentoLiquido)}</p></div>
                  <div><p className="text-xs text-gray-500">Custo líquido</p><p className={`font-semibold ${i.custoLiquido.custoLiquido > 0 ? "text-red-700" : "text-green-700"}`}>{fmtBrl(i.custoLiquido.custoLiquido)}</p></div>
                </div>
                <div>
                  <div className="flex justify-between text-xs text-gray-500 mb-1">
                    <span>Consumido: {fmtBrl(i.consumoEmprestimoBancario.resgatesParaFonte)} de {fmtBrl(i.consumoEmprestimoBancario.valorLiquidoRecebido)} (líquido)</span>
                    <span>{pct !== null ? fmtPct(pct, 1) : "—"}</span>
                  </div>
                  <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                    <div className="h-full bg-amber-500" style={{ width: `${Math.min(100, Math.max(0, pct ?? 0))}%` }} />
                  </div>
                  <p className="text-xs text-gray-400 mt-1">
                    Não consumido: {fmtBrl(i.consumoEmprestimoBancario.saldoNaoConsumido)} · Despesas pagas pela fonte: {fmtBrl(i.consumoEmprestimoBancario.despesasPagasPelaFonte)}
                  </p>
                </div>
              </>
            )}
          </div>
        </Card>
      </div>

      {p.emprestimos.length > 0 && (
        <Card titulo="Empréstimos ativos">
          <TabelaWrap>
            <table className="w-full text-sm">
              <thead className="bg-gray-50"><tr>
                <th className={`${th} text-left`}>Empréstimo</th><th className={`${th} text-left`}>Tipo</th>
                <th className={`${th} text-right`}>Saldo devedor</th><th className={`${th} text-left`}>Próxima parcela</th>
              </tr></thead>
              <tbody className="divide-y divide-gray-100">
                {p.emprestimos.map((e) => (
                  <tr key={e.id}>
                    <td className={td}>{e.nome}</td>
                    <td className={td}>{e.tipo === "psa" ? "PSA" : "Bancário"}</td>
                    <td className={`${td} text-right font-medium`}>{fmtBrl(e.saldoDevedor)}</td>
                    <td className={td}>{e.proximaParcela ? `${fmtData(e.proximaParcela.vencimento)} · ${fmtBrl(e.proximaParcela.prestacao)}` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TabelaWrap>
        </Card>
      )}

      {p.contas.length > 0 && (
        <Card titulo="Contas bancárias">
          <TabelaWrap>
            <table className="w-full text-sm">
              <thead className="bg-gray-50"><tr>
                <th className={`${th} text-left`}>Conta</th><th className={`${th} text-right`}>Saldo</th><th className={`${th} text-left`}>Atualizado em</th>
              </tr></thead>
              <tbody className="divide-y divide-gray-100">
                {p.contas.map((c) => (
                  <tr key={c.id}>
                    <td className={td}>{c.name}{c.isDefault ? " ★" : ""}</td>
                    <td className={`${td} text-right`}>{fmtBrl(c.currentBalance)}</td>
                    <td className={td}>{c.balanceDate ? fmtData(c.balanceDate as unknown as string) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TabelaWrap>
        </Card>
      )}
    </div>
  );
}

export default function PainelFinanceiro() {
  const emit = useEmitenteFin();
  return (
    <div className="p-4 md:p-6 space-y-6">
      <Cabecalho titulo="Painel financeiro" subtitulo="Endividamento, caixa disponível (sem valores de terceiros), recebimentos e orçamento do mês." emitente={emit} />
      <ExigeEmitente ctl={emit}>
        <Conteudo emitenteId={emit.emitenteId} nomeEmitente={emit.emitente?.nome ?? ""} />
      </ExigeEmitente>
    </div>
  );
}
