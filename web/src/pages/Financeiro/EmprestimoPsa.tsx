import { useState } from "react";
import { trpc } from "../../lib/trpc";
import { exportarExcel } from "../../lib/exportar";
import {
  Abas, ABAS_EMPRESTIMOS, Avisos, BotoesExportar, Cabecalho, Card, ErroBox, ExigeEmitente, Kpi, Pill, TabelaWrap, Vazio,
  btnPri, btnSec, fmtBrl, fmtData, fmtMes, fmtPct, td, th, useEmitenteFin, useFinPermissoes, type RO,
} from "./fin-ui";
import {
  BotaoExcluirEmprestimo, ModalEmprestimo, ModalMov, ROTULO_MOV_EMP, SeletorEmprestimo, TabelaMovs, useEmprestimoSelecionado,
  type MovEmp, type TipoMovEmp,
} from "./emprestimo-comum";

type Extrato = RO["fin"]["emprestimos"]["extratoPsa"];
const TIPOS_PSA: TipoMovEmp[] = ["saldo_inicial", "aporte", "amortizacao", "devolucao", "pagamento_juros"];

function Detalhe({ emitenteId, id }: { emitenteId: string; id: string }) {
  const { podeEditar } = useFinPermissoes();
  const det = trpc.fin.emprestimos.obter.useQuery({ id });
  const [incluirPrevistos, setIncluirPrevistos] = useState(true);
  const ext = trpc.fin.emprestimos.extratoPsa.useQuery({ id, incluirPrevistos });
  const [modalMov, setModalMov] = useState<{ mov?: MovEmp; tipo?: TipoMovEmp } | null>(null);
  const [editar, setEditar] = useState(false);

  if (det.error) return <ErroBox erro={det.error} />;
  if (!det.data) return <div className="bg-white border rounded-xl p-8 text-center text-sm text-gray-400 animate-pulse">Carregando…</div>;
  const e = det.data;
  const temSaldoInicial = e.movs.some((m) => m.tipo === "saldo_inicial");

  async function exportar(x: Extrato) {
    await exportarExcel({
      nomeArquivo: `extrato-emprestimo-psa`,
      abas: [
        {
          nome: "Extrato mensal",
          colunas: [
            { chave: "mes", titulo: "Mês" }, { chave: "saldoAnterior", titulo: "Saldo anterior", tipo: "moeda" },
            { chave: "aportes", titulo: "Aportes", tipo: "moeda" }, { chave: "correcao", titulo: "Correção (Selic)", tipo: "moeda" },
            { chave: "amortizacoes", titulo: "Amortizações/devoluções", tipo: "moeda" }, { chave: "saldoAtual", titulo: "Saldo atual", tipo: "moeda" },
            { chave: "taxa", titulo: "Selic do mês (% a.m.)", tipo: "numero" }, { chave: "proj", titulo: "Taxa projetada" }, { chave: "prev", titulo: "Tem previsto" },
          ],
          linhas: x.linhas.map((l) => ({
            mes: fmtMes(l.ano, l.mes), saldoAnterior: l.saldoAnterior, aportes: l.aportes, correcao: l.correcao,
            amortizacoes: l.amortizacoes, saldoAtual: l.saldoAtual, taxa: l.taxaPct, proj: l.projetado ? "Sim" : "", prev: l.temPrevisto ? "Sim" : "",
          })),
        },
        {
          nome: "Por aporte (FIFO)",
          colunas: [
            { chave: "data", titulo: "Data", tipo: "data" }, { chave: "prev", titulo: "Previsto" }, { chave: "valorOriginal", titulo: "Valor original", tipo: "moeda" },
            { chave: "correcao", titulo: "Correção", tipo: "moeda" }, { chave: "amortizado", titulo: "Amortizado", tipo: "moeda" }, { chave: "saldo", titulo: "Saldo", tipo: "moeda" },
          ],
          linhas: x.lotes.map((l) => ({ ...l, prev: l.previsto ? "Sim" : "" })),
        },
        {
          nome: "Movimentos",
          colunas: [{ chave: "data", titulo: "Data", tipo: "data" }, { chave: "tipo", titulo: "Tipo" }, { chave: "valor", titulo: "Valor", tipo: "moeda" }, { chave: "prev", titulo: "Previsto" }, { chave: "obs", titulo: "Obs.", largura: 40 }],
          linhas: e.movs.map((m) => ({ data: m.data, tipo: ROTULO_MOV_EMP[m.tipo] ?? m.tipo, valor: m.valor, prev: m.previsto ? "Sim" : "", obs: m.obs })),
        },
      ],
    });
  }

  const x = ext.data;
  return (
    <div className="space-y-6">
      <div className="flex justify-between items-start gap-2 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">{e.nome} {!e.ativo && <Pill>inativo</Pill>}</h2>
          <p className="text-xs text-gray-500">Início {fmtData(e.dataContratacao as unknown as string)}{e.fonte ? ` · fonte: ${e.fonte.nome}` : ""}{e.obs ? ` · ${e.obs}` : ""}</p>
        </div>
        <div className="flex gap-2 flex-wrap items-center no-print">
          {x && <BotoesExportar onExcel={() => exportar(x)} tituloPdf={`Extrato ${e.nome}`} />}
          {podeEditar && (
            <>
              <button className={btnSec} onClick={() => setEditar(true)}>Editar</button>
              {!temSaldoInicial && <button className={btnSec} onClick={() => setModalMov({ tipo: "saldo_inicial" })}>Lançar saldo inicial</button>}
              <button className={btnSec} onClick={() => setModalMov({ tipo: "amortizacao" })}>Amortização / devolução</button>
              <button className={btnPri} onClick={() => setModalMov({ tipo: "aporte" })}>+ Aporte</button>
            </>
          )}
        </div>
      </div>

      {ext.error ? <ErroBox erro={ext.error} /> : !x ? <div className="text-sm text-gray-400 animate-pulse">Calculando extrato…</div> : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <Kpi rotulo={incluirPrevistos ? "Saldo final (com previstos)" : "Saldo devedor"} cor="red" valor={fmtBrl(x.saldoFinal)} />
            <Kpi rotulo="Total aportado" valor={fmtBrl(x.totalAportado)} />
            <Kpi rotulo="Correção acumulada" cor="amber" valor={fmtBrl(x.totalCorrecao)} />
            <Kpi rotulo="Amortizado / devolvido" cor="green" valor={fmtBrl(x.totalAmortizado)} />
          </div>
          <Avisos avisos={x.avisos} />
          <Card titulo="Extrato mês a mês" acoes={
            <label className="flex items-center gap-1.5 text-xs text-gray-600">
              <input type="checkbox" checked={incluirPrevistos} onChange={(ev) => setIncluirPrevistos(ev.target.checked)} /> incluir aportes previstos (projeção)
            </label>
          }>
            {!x.linhas.length ? <Vazio texto="Sem movimentos: lance o saldo inicial e os aportes." /> : (
              <TabelaWrap>
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 border-b"><tr>
                    <th className={`${th} text-left`}>Mês</th>
                    <th className={`${th} text-right`}>Saldo anterior</th><th className={`${th} text-right`}>Aportes</th>
                    <th className={`${th} text-right`}>Correção</th><th className={`${th} text-right`}>Amortizações</th>
                    <th className={`${th} text-right`}>Saldo atual</th><th className={`${th} text-right`}>Selic do mês</th>
                  </tr></thead>
                  <tbody className="divide-y divide-gray-100">
                    {x.linhas.map((l) => (
                      <tr key={`${l.ano}-${l.mes}`} className={l.projetado || l.temPrevisto ? "bg-amber-50/40" : ""}>
                        <td className={td}>{fmtMes(l.ano, l.mes)} {l.temPrevisto && <Pill cor="amber" title="Mês com aporte previsto">previsto</Pill>}</td>
                        <td className={`${td} text-right`}>{fmtBrl(l.saldoAnterior)}</td>
                        <td className={`${td} text-right`}>{l.aportes ? fmtBrl(l.aportes) : "—"}</td>
                        <td className={`${td} text-right text-amber-700`}>{l.correcao ? fmtBrl(l.correcao) : "—"}</td>
                        <td className={`${td} text-right text-green-700`}>{l.amortizacoes ? `−${fmtBrl(l.amortizacoes)}` : "—"}</td>
                        <td className={`${td} text-right font-semibold`}>{fmtBrl(l.saldoAtual)}</td>
                        <td className={`${td} text-right`}>
                          {fmtPct(l.taxaPct, 4)} {l.projetado && <Pill cor="amber" title="Selic do mês ainda não publicada: usada a última conhecida">projetada</Pill>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TabelaWrap>
            )}
          </Card>
          {x.lotes.length > 0 && (
            <Card titulo="Saldo por aporte (abatimento FIFO)">
              <TabelaWrap>
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 border-b"><tr>
                    <th className={`${th} text-left`}>Data</th><th className={`${th} text-right`}>Valor original</th><th className={`${th} text-right`}>Correção</th>
                    <th className={`${th} text-right`}>Amortizado</th><th className={`${th} text-right`}>Saldo</th>
                  </tr></thead>
                  <tbody className="divide-y divide-gray-100">
                    {x.lotes.map((l, i) => (
                      <tr key={i}>
                        <td className={td}>{fmtData(l.data)} {l.previsto && <Pill cor="amber">previsto</Pill>}</td>
                        <td className={`${td} text-right`}>{fmtBrl(l.valorOriginal)}</td>
                        <td className={`${td} text-right`}>{fmtBrl(l.correcao)}</td>
                        <td className={`${td} text-right`}>{fmtBrl(l.amortizado)}</td>
                        <td className={`${td} text-right font-medium`}>{fmtBrl(l.saldo)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TabelaWrap>
            </Card>
          )}
        </>
      )}

      <Card titulo="Movimentos">
        <TabelaMovs movs={e.movs} podeEditar={podeEditar} onEditar={(m) => setModalMov({ mov: m })} />
      </Card>
      {podeEditar && <div className="no-print"><BotaoExcluirEmprestimo emp={e} onExcluido={() => undefined} /></div>}

      {modalMov && (
        <ModalMov emprestimoId={e.id} tiposPermitidos={TIPOS_PSA} permitePrevisto mov={modalMov.mov} tipoPadrao={modalMov.tipo} onClose={() => setModalMov(null)} />
      )}
      {editar && <ModalEmprestimo emitenteId={emitenteId} tipo="psa" emp={e} onClose={() => setEditar(false)} onSaved={() => undefined} />}
    </div>
  );
}

function Conteudo({ emitenteId }: { emitenteId: string }) {
  const { podeEditar } = useFinPermissoes();
  const lista = trpc.fin.emprestimos.listar.useQuery({ emitenteId, tipo: "psa" });
  const { atual, setSel } = useEmprestimoSelecionado(lista.data);
  const [novo, setNovo] = useState(false);
  if (lista.error) return <ErroBox erro={lista.error} />;
  if (!lista.data) return <div className="bg-white border rounded-xl p-8 text-center text-sm text-gray-400 animate-pulse">Carregando…</div>;
  return (
    <div className="space-y-4">
      <div className="flex gap-2 items-center flex-wrap no-print">
        <SeletorEmprestimo lista={lista.data} atual={atual} onChange={setSel} />
        {podeEditar && <button className={btnSec} onClick={() => setNovo(true)}>+ Novo empréstimo PSA</button>}
      </div>
      {atual ? <Detalhe key={atual.id} emitenteId={emitenteId} id={atual.id} /> : (
        <Vazio texto={podeEditar ? "Nenhum empréstimo PSA cadastrado. Clique em “+ Novo empréstimo PSA”." : "Nenhum empréstimo PSA cadastrado."} />
      )}
      {novo && <ModalEmprestimo emitenteId={emitenteId} tipo="psa" onClose={() => setNovo(false)} onSaved={(id) => setSel(id)} />}
    </div>
  );
}

export default function EmprestimoPsa() {
  const emit = useEmitenteFin();
  return (
    <div className="p-4 md:p-6 space-y-6">
      <Cabecalho titulo="Empréstimos" subtitulo="Empréstimo PSA: cada aporte corrigido pela Selic desde a própria data (pro rata no 1º mês); amortizações abatem os aportes mais antigos." emitente={emit} />
      <Abas itens={ABAS_EMPRESTIMOS} />
      <ExigeEmitente ctl={emit}><Conteudo emitenteId={emit.emitenteId} /></ExigeEmitente>
    </div>
  );
}
