import { useState } from "react";
import { trpc } from "../../lib/trpc";
import { exportarExcel } from "../../lib/exportar";
import {
  BotoesExportar, Cabecalho, Campo, Card, ErroBox, ExigeEmitente, Kpi, Modal, Pill, TabelaWrap, Vazio,
  btnLink, btnLinkRed, btnPri, btnSec, dataInput, fmtBrl, fmtData, fmtMes, fmtMesStr, fmtNum, fmtPct, hojeStr, inputCls,
  mesAtualStr, msgErro, parseValor, td, th, useEmitenteFin, useFinPermissoes, valorInput, type RO,
} from "./fin-ui";

type AplLista = RO["fin"]["aplicacoes"]["listar"][number];
type AplDet = RO["fin"]["aplicacoes"]["obter"];
type MovApl = AplDet["movs"][number];
type TipoMovApl = "aplicacao" | "resgate" | "rendimento" | "ir";

const ROTULO_MOV: Record<string, string> = { aplicacao: "Aplicação", resgate: "Resgate", rendimento: "Rendimento", ir: "IR retido" };

function ultimoDiaMes(m: string): string {
  const [a, mm] = m.split("-").map(Number);
  const d = new Date(Date.UTC(a, mm, 0)).getUTCDate();
  return `${m}-${String(d).padStart(2, "0")}`;
}

function invalidarTudo(utils: ReturnType<typeof trpc.useUtils>) {
  utils.fin.aplicacoes.invalidate();
  utils.fin.relatorios.invalidate();
}

function ModalAplicacao({ emitenteId, apl, onClose, onSaved }: { emitenteId: string; apl?: AplDet; onClose: () => void; onSaved: (id: string) => void }) {
  const utils = trpc.useUtils();
  const [nome, setNome] = useState(apl?.nome ?? "");
  const [produto, setProduto] = useState(apl?.produto ?? "");
  const [indexador, setIndexador] = useState<"selic" | "cdi">((apl?.indexador as "selic" | "cdi") ?? "cdi");
  const [pct, setPct] = useState(apl ? valorInput(apl.percentualIndexador) : "100");
  const [ativo, setAtivo] = useState(apl?.ativo ?? true);
  const [obs, setObs] = useState(apl?.obs ?? "");
  const [erro, setErro] = useState<string | null>(null);
  const fim = (id: string) => { invalidarTudo(utils); onSaved(id); onClose(); };
  const criar = trpc.fin.aplicacoes.criar.useMutation({ onSuccess: (a) => fim(a.id), onError: (e) => setErro(msgErro(e)) });
  const atualizar = trpc.fin.aplicacoes.atualizar.useMutation({ onSuccess: (a) => fim(a.id), onError: (e) => setErro(msgErro(e)) });
  function salvar() {
    setErro(null);
    const p = parseValor(pct);
    if (p === null || p < 0) { setErro("Percentual do indexador inválido"); return; }
    const campos = { nome: nome.trim(), produto: produto.trim() || null, indexador, percentualIndexador: p, ativo, obs: obs.trim() || null };
    if (apl) atualizar.mutate({ id: apl.id, ...campos });
    else criar.mutate({ emitenteId, ...campos });
  }
  return (
    <Modal titulo={apl ? "Editar aplicação" : "Nova aplicação"} onClose={onClose}>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Campo rotulo="Nome *" className="sm:col-span-2"><input value={nome} onChange={(e) => setNome(e.target.value)} className={inputCls} placeholder="Ex.: CDB Banco X" /></Campo>
        <Campo rotulo="Produto"><input value={produto} onChange={(e) => setProduto(e.target.value)} className={inputCls} placeholder="CDB, LCI, Tesouro Selic…" /></Campo>
        <Campo rotulo="Indexador">
          <select value={indexador} onChange={(e) => setIndexador(e.target.value as "selic" | "cdi")} className={inputCls}>
            <option value="cdi">CDI</option><option value="selic">Selic</option>
          </select>
        </Campo>
        <Campo rotulo="% do indexador"><input value={pct} onChange={(e) => setPct(e.target.value)} inputMode="decimal" className={inputCls} /></Campo>
        <label className="flex items-center gap-2 text-sm text-gray-700 self-end pb-2"><input type="checkbox" checked={ativo} onChange={(e) => setAtivo(e.target.checked)} /> Ativa</label>
        <Campo rotulo="Observação" className="sm:col-span-2"><input value={obs} onChange={(e) => setObs(e.target.value)} className={inputCls} /></Campo>
      </div>
      {erro && <ErroBox erro={erro} />}
      <div className="flex justify-end gap-2">
        <button onClick={onClose} className={btnSec}>Cancelar</button>
        <button onClick={salvar} disabled={!nome.trim() || criar.isLoading || atualizar.isLoading} className={btnPri}>Salvar</button>
      </div>
    </Modal>
  );
}

function ModalMovApl({ emitenteId, apl, mov, tipoPadrao, onClose }: { emitenteId: string; apl: AplDet; mov?: MovApl; tipoPadrao?: TipoMovApl; onClose: () => void }) {
  const utils = trpc.useUtils();
  const fontes = trpc.fin.fontes.listar.useQuery({ emitenteId });
  const [tipo, setTipo] = useState<TipoMovApl>((mov?.tipo as TipoMovApl) ?? tipoPadrao ?? "aplicacao");
  const [data, setData] = useState(mov ? dataInput(mov.data as unknown as string) : hojeStr());
  const [valor, setValor] = useState(mov ? valorInput(mov.valor) : "");
  const [fonteId, setFonteId] = useState(mov?.fonteId ?? "");
  const [obs, setObs] = useState(mov?.obs ?? "");
  const [competencia, setCompetencia] = useState(mov ? (dataInput(mov.data as unknown as string).slice(0, 7)) : mesAtualStr());
  const [lancarIr, setLancarIr] = useState(false);
  const [irValor, setIrValor] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const sug = trpc.fin.aplicacoes.rendimentoSugerido.useQuery({ aplicacaoId: apl.id, competencia }, { enabled: tipo === "rendimento" && !!competencia });
  const criar = trpc.fin.aplicacoes.criarMov.useMutation();
  const atualizar = trpc.fin.aplicacoes.atualizarMov.useMutation();
  const fonteBanco = (fontes.data ?? []).find((f) => f.tipo === "emprestimo_bancario");
  const salvando = criar.isLoading || atualizar.isLoading;

  function usarSugestao() {
    if (!sug.data) return;
    setValor(valorInput(sug.data.valor));
    setData(ultimoDiaMes(competencia));
    setIrValor(valorInput(sug.data.irSugerido));
  }

  async function salvar() {
    setErro(null);
    const v = parseValor(valor);
    if (!v || v <= 0) { setErro("Informe um valor positivo"); return; }
    if (!data) { setErro("Informe a data"); return; }
    if (tipo === "resgate" && !fonteId && !fonteBanco) { setErro("Resgate exige a fonte que recebe o dinheiro"); return; }
    const campos = { tipo, data, valor: v, fonteId: tipo === "resgate" ? (fonteId || fonteBanco?.id || null) : (fonteId || null), obs: obs.trim() || null };
    try {
      if (mov) await atualizar.mutateAsync({ id: mov.id, ...campos });
      else {
        await criar.mutateAsync({ aplicacaoId: apl.id, ...campos });
        const ir = parseValor(irValor);
        if (tipo === "rendimento" && lancarIr && ir && ir > 0) {
          await criar.mutateAsync({ aplicacaoId: apl.id, tipo: "ir", data, valor: ir, obs: `IR sobre rendimento de ${fmtMesStr(competencia)}` });
        }
      }
      invalidarTudo(utils);
      onClose();
    } catch (e) {
      setErro(msgErro(e));
    }
  }

  return (
    <Modal titulo={mov ? "Editar movimento" : "Novo movimento"} onClose={onClose}>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Campo rotulo="Tipo">
          <select value={tipo} onChange={(e) => setTipo(e.target.value as TipoMovApl)} className={inputCls}>
            {(["aplicacao", "resgate", "rendimento", "ir"] as const).map((t) => <option key={t} value={t}>{ROTULO_MOV[t]}</option>)}
          </select>
        </Campo>
        <Campo rotulo="Data *"><input type="date" value={data} onChange={(e) => setData(e.target.value)} className={inputCls} /></Campo>

        {tipo === "rendimento" && (
          <div className="sm:col-span-2 border rounded-lg p-3 bg-gray-50 space-y-2">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs text-gray-600">Sugestão do mês</span>
              <input type="month" value={competencia} onChange={(e) => setCompetencia(e.target.value)} className="border rounded px-2 py-1 text-sm" />
              <button type="button" onClick={usarSugestao} disabled={!sug.data} className={btnLink}>usar sugestão</button>
            </div>
            {sug.error ? <ErroBox erro={sug.error} /> : !sug.data ? <p className="text-xs text-gray-400">Calculando…</p> : (
              <p className="text-xs text-gray-600">
                Saldo no início do mês {fmtBrl(sug.data.saldoBase)} × {fmtPct(sug.data.taxaPct, 4)}
                {sug.data.projetado && <> <Pill cor="amber">taxa projetada</Pill></>} = <b>{fmtBrl(sug.data.valor)}</b>.
                IR sugerido ({fmtNum(sug.data.aliquotaIr, 1)}% · {sug.data.prazoDias} dias): <b>{fmtBrl(sug.data.irSugerido)}</b> → líquido {fmtBrl(sug.data.rendimentoLiquido)}
              </p>
            )}
          </div>
        )}

        <Campo rotulo="Valor (R$) *"><input value={valor} onChange={(e) => setValor(e.target.value)} inputMode="decimal" className={inputCls} /></Campo>
        <Campo rotulo={tipo === "resgate" ? "Fonte que recebe o resgate *" : "Fonte (opcional)"} dica={tipo === "resgate" ? "Padrão: empréstimo bancário (conta como consumo do empréstimo)" : undefined}>
          <select value={fonteId} onChange={(e) => setFonteId(e.target.value)} className={inputCls}>
            <option value="">{tipo === "resgate" ? `(padrão: ${fonteBanco?.nome ?? "empréstimo bancário"})` : "—"}</option>
            {(fontes.data ?? []).map((f) => <option key={f.id} value={f.id}>{f.nome}</option>)}
          </select>
        </Campo>
        {tipo === "rendimento" && !mov && (
          <div className="sm:col-span-2 flex items-center gap-2 flex-wrap">
            <label className="flex items-center gap-2 text-sm text-gray-700"><input type="checkbox" checked={lancarIr} onChange={(e) => setLancarIr(e.target.checked)} /> lançar também o IR retido</label>
            {lancarIr && <input value={irValor} onChange={(e) => setIrValor(e.target.value)} inputMode="decimal" placeholder="IR R$" className="w-28 border rounded-lg px-2 py-1 text-sm text-right" />}
          </div>
        )}
        <Campo rotulo="Observação" className="sm:col-span-2"><input value={obs} onChange={(e) => setObs(e.target.value)} className={inputCls} /></Campo>
      </div>
      {erro && <ErroBox erro={erro} />}
      <div className="flex justify-end gap-2">
        <button onClick={onClose} className={btnSec}>Cancelar</button>
        <button onClick={salvar} disabled={salvando} className={btnPri}>{salvando ? "Salvando…" : "Salvar"}</button>
      </div>
    </Modal>
  );
}

function Detalhe({ emitenteId, id }: { emitenteId: string; id: string }) {
  const { podeEditar } = useFinPermissoes();
  const utils = trpc.useUtils();
  const det = trpc.fin.aplicacoes.obter.useQuery({ id });
  const ext = trpc.fin.aplicacoes.extrato.useQuery({ aplicacaoId: id });
  const fontes = trpc.fin.fontes.listar.useQuery({ emitenteId, incluirInativas: true });
  const [modal, setModal] = useState<{ mov?: MovApl; tipo?: TipoMovApl } | null>(null);
  const [editar, setEditar] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const excluirMov = trpc.fin.aplicacoes.excluirMov.useMutation({ onSuccess: () => invalidarTudo(utils), onError: (e) => setErro(msgErro(e)) });
  const excluir = trpc.fin.aplicacoes.excluir.useMutation({ onSuccess: () => invalidarTudo(utils), onError: (e) => setErro(msgErro(e)) });

  if (det.error) return <ErroBox erro={det.error} />;
  if (!det.data) return <div className="bg-white border rounded-xl p-8 text-center text-sm text-gray-400 animate-pulse">Carregando…</div>;
  const a = det.data;
  const nomeFonte = (fid: string | null) => (fid ? fontes.data?.find((f) => f.id === fid)?.nome ?? "?" : "");
  const x = ext.data;

  async function exportar() {
    await exportarExcel({
      nomeArquivo: `aplicacao-${a.nome}`,
      abas: [
        {
          nome: "Extrato mensal",
          colunas: [
            { chave: "mes", titulo: "Mês" }, { chave: "saldoAnterior", titulo: "Saldo anterior", tipo: "moeda" }, { chave: "aplicacoes", titulo: "Aplicações", tipo: "moeda" },
            { chave: "resgates", titulo: "Resgates", tipo: "moeda" }, { chave: "rendimentos", titulo: "Rendimentos", tipo: "moeda" }, { chave: "ir", titulo: "IR", tipo: "moeda" },
            { chave: "saldoAtual", titulo: "Saldo atual", tipo: "moeda" },
          ],
          linhas: (x?.linhas ?? []).map((l) => ({ ...l, mes: fmtMes(l.ano, l.mes) })),
        },
        {
          nome: "Movimentos",
          colunas: [{ chave: "data", titulo: "Data", tipo: "data" }, { chave: "tipo", titulo: "Tipo" }, { chave: "valor", titulo: "Valor", tipo: "moeda" }, { chave: "fonte", titulo: "Fonte" }, { chave: "obs", titulo: "Obs.", largura: 40 }],
          linhas: a.movs.map((m) => ({ data: m.data, tipo: ROTULO_MOV[m.tipo] ?? m.tipo, valor: m.valor, fonte: nomeFonte(m.fonteId), obs: m.obs })),
        },
      ],
    });
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-start gap-2 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">{a.nome} {!a.ativo && <Pill>inativa</Pill>}</h2>
          <p className="text-xs text-gray-500">{a.produto ? `${a.produto} · ` : ""}{fmtNum(a.percentualIndexador, 2)}% do {a.indexador === "selic" ? "Selic" : "CDI"}{a.obs ? ` · ${a.obs}` : ""}</p>
        </div>
        <div className="flex gap-2 flex-wrap items-center no-print">
          <BotoesExportar onExcel={exportar} tituloPdf={`Aplicação ${a.nome}`} />
          {podeEditar && (
            <>
              <button className={btnSec} onClick={() => setEditar(true)}>Editar</button>
              <button className={btnSec} onClick={() => setModal({ tipo: "rendimento" })}>+ Rendimento</button>
              <button className={btnSec} onClick={() => setModal({ tipo: "resgate" })}>+ Resgate</button>
              <button className={btnPri} onClick={() => setModal({ tipo: "aplicacao" })}>+ Aplicação</button>
            </>
          )}
        </div>
      </div>
      {erro && <ErroBox erro={erro} />}
      {x && (
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
          <Kpi rotulo="Saldo" cor="blue" valor={fmtBrl(x.saldo.saldo)} />
          <Kpi rotulo="Aplicado" valor={fmtBrl(x.saldo.aplicado)} />
          <Kpi rotulo="Resgatado" valor={fmtBrl(x.saldo.resgatado)} />
          <Kpi rotulo="Rendimento bruto" cor="green" valor={fmtBrl(x.saldo.rendimentoBruto)} />
          <Kpi rotulo="IR / líquido" valor={fmtBrl(x.saldo.ir)} detalhe={`líquido ${fmtBrl(x.saldo.rendimentoLiquido)}`} />
        </div>
      )}
      <Card titulo="Extrato mensal">
        {ext.error ? <div className="p-3"><ErroBox erro={ext.error} /></div> : !x ? <p className="p-4 text-sm text-gray-400">Carregando…</p> : !x.linhas.length ? <Vazio texto="Sem movimentos." /> : (
          <TabelaWrap>
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b"><tr>
                <th className={`${th} text-left`}>Mês</th><th className={`${th} text-right`}>Saldo anterior</th><th className={`${th} text-right`}>Aplicações</th>
                <th className={`${th} text-right`}>Resgates</th><th className={`${th} text-right`}>Rendimentos</th><th className={`${th} text-right`}>IR</th><th className={`${th} text-right`}>Saldo atual</th>
              </tr></thead>
              <tbody className="divide-y divide-gray-100">
                {x.linhas.map((l) => (
                  <tr key={`${l.ano}-${l.mes}`}>
                    <td className={td}>{fmtMes(l.ano, l.mes)}</td>
                    <td className={`${td} text-right`}>{fmtBrl(l.saldoAnterior)}</td>
                    <td className={`${td} text-right`}>{l.aplicacoes ? fmtBrl(l.aplicacoes) : "—"}</td>
                    <td className={`${td} text-right`}>{l.resgates ? `−${fmtBrl(l.resgates)}` : "—"}</td>
                    <td className={`${td} text-right text-green-700`}>{l.rendimentos ? fmtBrl(l.rendimentos) : "—"}</td>
                    <td className={`${td} text-right text-red-600`}>{l.ir ? `−${fmtBrl(l.ir)}` : "—"}</td>
                    <td className={`${td} text-right font-semibold`}>{fmtBrl(l.saldoAtual)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TabelaWrap>
        )}
      </Card>
      <Card titulo="Movimentos">
        <TabelaWrap>
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b"><tr>
              <th className={`${th} text-left`}>Data</th><th className={`${th} text-left`}>Tipo</th><th className={`${th} text-right`}>Valor</th>
              <th className={`${th} text-left`}>Fonte</th><th className={`${th} text-left`}>Obs.</th><th className={`${th} no-print`} />
            </tr></thead>
            <tbody className="divide-y divide-gray-100">
              {!a.movs.length && <tr><td colSpan={6} className="p-6 text-center text-gray-400">Nenhum movimento.</td></tr>}
              {a.movs.map((m) => (
                <tr key={m.id}>
                  <td className={td}>{fmtData(m.data as unknown as string)}</td>
                  <td className={td}>{ROTULO_MOV[m.tipo] ?? m.tipo}</td>
                  <td className={`${td} text-right ${m.tipo === "resgate" || m.tipo === "ir" ? "text-red-600" : "text-gray-900"}`}>{m.tipo === "resgate" || m.tipo === "ir" ? "−" : ""}{fmtBrl(m.valor)}</td>
                  <td className={`${td} text-xs`}>{nomeFonte(m.fonteId)}</td>
                  <td className="px-3 py-2 text-xs text-gray-500">{m.obs ?? ""}</td>
                  <td className={`${td} text-right no-print`}>
                    {podeEditar && (
                      <span className="inline-flex gap-3">
                        <button className={btnLink} onClick={() => setModal({ mov: m })}>Editar</button>
                        <button className={btnLinkRed} disabled={excluirMov.isLoading} onClick={() => { if (confirm("Excluir este movimento?")) { setErro(null); excluirMov.mutate({ id: m.id }); } }}>Excluir</button>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TabelaWrap>
      </Card>
      {podeEditar && (
        <div className="no-print">
          <button className={btnLinkRed} disabled={excluir.isLoading}
            onClick={() => { if (confirm(`Excluir "${a.nome}" e TODOS os movimentos?`)) excluir.mutate({ id: a.id }); }}>Excluir aplicação</button>
        </div>
      )}
      {modal && <ModalMovApl emitenteId={emitenteId} apl={a} mov={modal.mov} tipoPadrao={modal.tipo} onClose={() => setModal(null)} />}
      {editar && <ModalAplicacao emitenteId={emitenteId} apl={a} onClose={() => setEditar(false)} onSaved={() => undefined} />}
    </div>
  );
}

function Indicadores({ emitenteId }: { emitenteId: string }) {
  const q = trpc.fin.aplicacoes.indicadores.useQuery({ emitenteId });
  if (q.error) return <ErroBox erro={q.error} />;
  if (!q.data) return null;
  const c = q.data.consumoEmprestimoBancario;
  const pct = c.valorLiquidoRecebido ? Math.round((c.resgatesParaFonte / c.valorLiquidoRecebido) * 10000) / 100 : null;
  const k = q.data.custoLiquido;
  return (
    <Card titulo="Indicadores (desde o início até hoje)">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 p-4 text-sm">
        <div><p className="text-xs text-gray-500">Juros incorridos (bancário)</p><p className="font-semibold">{fmtBrl(k.jurosIncorridos)}</p></div>
        <div><p className="text-xs text-gray-500">Rendimento líquido de IR</p><p className="font-semibold text-green-700">{fmtBrl(k.rendimentoLiquido)}</p><p className="text-[11px] text-gray-400">bruto {fmtBrl(k.rendimentoBruto)} − IR {fmtBrl(k.ir)}</p></div>
        <div><p className="text-xs text-gray-500">Custo líquido do empréstimo</p><p className={`font-semibold ${k.custoLiquido > 0 ? "text-red-700" : "text-green-700"}`}>{fmtBrl(k.custoLiquido)}</p></div>
        <div>
          <p className="text-xs text-gray-500">Empréstimo bancário consumido</p>
          <p className="font-semibold">{pct !== null ? fmtPct(pct, 1) : "—"}</p>
          <p className="text-[11px] text-gray-400">{fmtBrl(c.resgatesParaFonte)} de {fmtBrl(c.valorLiquidoRecebido)} · resta {fmtBrl(c.saldoNaoConsumido)}</p>
        </div>
      </div>
    </Card>
  );
}

function Conteudo({ emitenteId }: { emitenteId: string }) {
  const { podeEditar } = useFinPermissoes();
  const lista = trpc.fin.aplicacoes.listar.useQuery({ emitenteId });
  const [sel, setSel] = useState("");
  const [nova, setNova] = useState(false);
  if (lista.error) return <ErroBox erro={lista.error} />;
  if (!lista.data) return <div className="bg-white border rounded-xl p-8 text-center text-sm text-gray-400 animate-pulse">Carregando…</div>;
  const l = lista.data;
  const atual: AplLista | null = l.find((a) => a.id === sel) ?? l.find((a) => a.ativo) ?? l[0] ?? null;
  const total = l.reduce((s, a) => s + a.resumo.saldo, 0);
  return (
    <div className="space-y-4">
      <Indicadores emitenteId={emitenteId} />
      <Card titulo={`Aplicações — saldo total ${fmtBrl(total)}`} acoes={podeEditar && <button className={btnSec} onClick={() => setNova(true)}>+ Nova aplicação</button>}>
        {!l.length ? <Vazio texto="Nenhuma aplicação cadastrada." /> : (
          <TabelaWrap>
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b"><tr>
                <th className={`${th} text-left`}>Aplicação</th><th className={`${th} text-left`}>Indexador</th><th className={`${th} text-right`}>Saldo</th>
                <th className={`${th} text-right`}>Rend. bruto</th><th className={`${th} text-right`}>IR</th>
              </tr></thead>
              <tbody className="divide-y divide-gray-100">
                {l.map((a) => (
                  <tr key={a.id} onClick={() => setSel(a.id)} className={`cursor-pointer hover:bg-gray-50 ${atual?.id === a.id ? "bg-indigo-50" : ""} ${a.ativo ? "" : "opacity-60"}`}>
                    <td className={`${td} font-medium`}>{a.nome}</td>
                    <td className={td}>{fmtNum(a.percentualIndexador, 0)}% {a.indexador.toUpperCase()}</td>
                    <td className={`${td} text-right font-semibold`}>{fmtBrl(a.resumo.saldo)}</td>
                    <td className={`${td} text-right`}>{fmtBrl(a.resumo.rendimentoBruto)}</td>
                    <td className={`${td} text-right`}>{fmtBrl(a.resumo.ir)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TabelaWrap>
        )}
      </Card>
      {atual && <Detalhe key={atual.id} emitenteId={emitenteId} id={atual.id} />}
      {nova && <ModalAplicacao emitenteId={emitenteId} onClose={() => setNova(false)} onSaved={(id) => setSel(id)} />}
    </div>
  );
}

export default function Aplicacoes() {
  const emit = useEmitenteFin();
  return (
    <div className="p-4 md:p-6 space-y-6">
      <Cabecalho titulo="Aplicações" subtitulo="Aplicações financeiras: aplicação, resgate (com a fonte que recebe), rendimento sugerido pelo índice do mês e IR." emitente={emit} />
      <ExigeEmitente ctl={emit}><Conteudo emitenteId={emit.emitenteId} /></ExigeEmitente>
    </div>
  );
}
