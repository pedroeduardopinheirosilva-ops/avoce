import { useMemo, useState } from "react";
import { trpc } from "../lib/trpc";
import { exportarExcel } from "../lib/exportar";
import { FinAnexo, FinAnexoLink, type ValorAnexo } from "../components/FinAnexo";
import {
  BotoesExportar, Campo, Cabecalho, ErroBox, Modal, Pill, ROTULO_FORMA_PAGAMENTO, TabelaWrap,
  btnLink, btnLinkRed, btnPri, btnSec, centavos, dataInput, fmtBrl, fmtData, fmtMesStr, fmtNum, inputCls,
  mesInput, msgErro, nomeEmpresa, num, parseValor, hojeStr, td, th, useEmitenteFin, useFinPermissoes,
  valorInput, MESES_CURTOS, anoAtual, type RO,
} from "./Financeiro/fin-ui";

type ListaLanc = RO["financeiro"]["listar"];
type Lanc = ListaLanc["lancamentos"][number];
type ModoRateio = "percentual" | "valor";
type LinhaRateio = { fonteId: string; valor: string; percentual: string };

// ─── Rateio por fontes ──────────────────────────────────────────────────────

function EditorRateio({
  emitenteId, valorTotal, modo, setModo, linhas, setLinhas, obrigatorio,
}: {
  emitenteId: string;
  valorTotal: number | null;
  modo: ModoRateio;
  setModo: (m: ModoRateio) => void;
  linhas: LinhaRateio[];
  setLinhas: (l: LinhaRateio[]) => void;
  obrigatorio: boolean;
}) {
  const fontes = trpc.fin.fontes.listar.useQuery({ emitenteId, incluirInativas: true }, { enabled: !!emitenteId });
  const ativas = (fontes.data ?? []).filter((f) => f.ativo || linhas.some((l) => l.fonteId === f.id));
  const usadas = new Set(linhas.map((l) => l.fonteId));
  const st = statusRateio(modo, linhas, valorTotal, obrigatorio);

  function upd(i: number, campo: keyof LinhaRateio, v: string) {
    setLinhas(linhas.map((l, j) => (j === i ? { ...l, [campo]: v } : l)));
  }
  function trocarModo(m: ModoRateio) {
    if (m === modo) return;
    // converte os valores digitados para o outro modo
    const tot = valorTotal ?? 0;
    setLinhas(linhas.map((l) => {
      if (m === "percentual") {
        const v = parseValor(l.valor);
        return { ...l, percentual: v !== null && tot > 0 ? fmtNum((v / tot) * 100, 4).replace(/\./g, "") : "" };
      }
      const p = parseValor(l.percentual);
      return { ...l, valor: p !== null && tot > 0 ? valorInput(Math.round(tot * p) / 100) : "" };
    }));
    setModo(m);
  }
  function adicionar() {
    const livre = ativas.find((f) => f.ativo && !usadas.has(f.id));
    setLinhas([...linhas, { fonteId: livre?.id ?? "", valor: "", percentual: "" }]);
  }
  function preencherRestante(i: number) {
    if (modo === "percentual") {
      const outros = linhas.reduce((a, l, j) => (j === i ? a : a + (parseValor(l.percentual) ?? 0)), 0);
      upd(i, "percentual", fmtNum(Math.max(0, 100 - outros), 4).replace(/\./g, ""));
    } else if (valorTotal) {
      const outros = linhas.reduce((a, l, j) => (j === i ? a : a + centavos(parseValor(l.valor) ?? 0)), 0);
      upd(i, "valor", valorInput(Math.max(0, centavos(valorTotal) - outros) / 100));
    }
  }

  if (!emitenteId) return <p className="text-xs text-amber-700">Selecione a empresa para escolher a fonte do recurso.</p>;
  if (fontes.error) return <ErroBox erro={fontes.error} />;

  return (
    <div className="border rounded-lg p-3 space-y-2 bg-gray-50">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <span className="text-xs font-medium text-gray-600">Fonte do recurso {obrigatorio && <span className="text-red-500">*</span>}</span>
        <div className="flex rounded-lg border overflow-hidden text-xs">
          {(["percentual", "valor"] as const).map((m) => (
            <button key={m} type="button" onClick={() => trocarModo(m)}
              className={`px-2 py-1 ${modo === m ? "bg-indigo-600 text-white" : "bg-white text-gray-600"}`}>
              {m === "percentual" ? "Por %" : "Por valor"}
            </button>
          ))}
        </div>
      </div>
      {linhas.map((l, i) => (
        <div key={i} className="flex items-center gap-2">
          <select value={l.fonteId} onChange={(e) => upd(i, "fonteId", e.target.value)} className={`${inputCls} flex-1 min-w-0`}>
            <option value="">— fonte —</option>
            {ativas.map((f) => (
              <option key={f.id} value={f.id} disabled={usadas.has(f.id) && f.id !== l.fonteId}>
                {f.nome}{!f.ativo ? " (inativa)" : ""}
              </option>
            ))}
          </select>
          {modo === "percentual" ? (
            <input value={l.percentual} onChange={(e) => upd(i, "percentual", e.target.value)} placeholder="%" inputMode="decimal"
              className="w-20 border rounded-lg px-2 py-2 text-sm text-right" />
          ) : (
            <input value={l.valor} onChange={(e) => upd(i, "valor", e.target.value)} placeholder="R$" inputMode="decimal"
              className="w-28 border rounded-lg px-2 py-2 text-sm text-right" />
          )}
          <button type="button" onClick={() => preencherRestante(i)} className="text-[11px] text-indigo-600 hover:underline whitespace-nowrap" title="Completar com o restante">resto</button>
          {linhas.length > 1 && (
            <button type="button" onClick={() => setLinhas(linhas.filter((_, j) => j !== i))} className="text-red-500 text-sm px-1" title="Remover">×</button>
          )}
        </div>
      ))}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <button type="button" onClick={adicionar} className="text-xs text-indigo-600 hover:underline"
          disabled={!ativas.some((f) => f.ativo && !usadas.has(f.id))}>+ dividir com outra fonte</button>
        <span className={`text-xs ${st.ok ? "text-green-700" : "text-red-600"}`}>{st.msg}</span>
      </div>
    </div>
  );
}

function statusRateio(modo: ModoRateio, linhas: LinhaRateio[], valorTotal: number | null, obrigatorio: boolean): { ok: boolean; msg: string; vazio: boolean } {
  const preenchidas = linhas.filter((l) => l.fonteId);
  if (!preenchidas.length) return { ok: !obrigatorio, msg: obrigatorio ? "Informe a fonte do recurso" : "Sem fonte informada", vazio: true };
  if (linhas.some((l) => !l.fonteId)) return { ok: false, msg: "Escolha a fonte em todas as linhas", vazio: false };
  if (modo === "percentual") {
    const vals = preenchidas.map((l) => parseValor(l.percentual));
    if (vals.some((v) => v === null || v <= 0 || v > 100)) return { ok: false, msg: "Percentual entre 0 e 100 em cada fonte", vazio: false };
    const soma = vals.reduce((a: number, v) => a + (v ?? 0), 0);
    const ok = Math.abs(soma - 100) < 0.0001;
    return { ok, msg: ok ? "Soma: 100% ✓" : `Soma: ${fmtNum(soma, 2)}% (falta ${fmtNum(100 - soma, 2)}%)`, vazio: false };
  }
  if (!valorTotal) return { ok: false, msg: "Informe o valor do lançamento", vazio: false };
  const vals = preenchidas.map((l) => parseValor(l.valor));
  if (vals.some((v) => v === null || v <= 0)) return { ok: false, msg: "Valor positivo em cada fonte", vazio: false };
  const soma = vals.reduce((a: number, v) => a + centavos(v ?? 0), 0);
  const tot = centavos(valorTotal);
  const ok = soma === tot;
  return { ok, msg: ok ? `Soma: ${fmtBrl(soma / 100)} ✓` : `Soma: ${fmtBrl(soma / 100)} — ${soma < tot ? "falta" : "excede"} ${fmtBrl(Math.abs(tot - soma) / 100)}`, vazio: false };
}

// ─── Modal de lançamento ────────────────────────────────────────────────────

function ModalLancamento({
  initial, emitentePadrao, onClose, onSaved,
}: {
  initial?: Lanc;
  emitentePadrao: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { data: empresas } = trpc.empresa.listar.useQuery();
  const { data: cats } = trpc.financeiro.categorias.useQuery();
  const [tipo, setTipo] = useState<"receita" | "despesa">((initial?.tipo as "receita" | "despesa") ?? "despesa");
  const [descricao, setDescricao] = useState(initial?.descricao ?? "");
  const [categoria, setCategoria] = useState(initial?.categoria ?? "");
  const [valor, setValor] = useState(initial ? valorInput(initial.valor) : "");
  const [data, setData] = useState(initial ? dataInput(initial.data as unknown as string) : hojeStr());
  const [competencia, setCompetencia] = useState(initial?.competencia ? mesInput(initial.competencia as unknown as string) : "");
  const [emitenteId, setEmitenteId] = useState(initial ? (initial.emitenteId ?? "") : emitentePadrao);
  const [pago, setPago] = useState(initial?.pago ?? true);
  const [obs, setObs] = useState(initial?.obs ?? "");
  const [fornecedor, setFornecedor] = useState(initial?.fornecedor ?? "");
  const [formaPagamento, setFormaPagamento] = useState(initial?.formaPagamento ?? "");
  const [recorrente, setRecorrente] = useState(initial?.recorrente ?? false);
  const [recorrenciaFim, setRecorrenciaFim] = useState(initial?.recorrenciaFimEm ? mesInput(initial.recorrenciaFimEm as unknown as string) : "");
  const [anexo, setAnexo] = useState<ValorAnexo | null>(initial?.comprovantePath ? { path: initial.comprovantePath, nome: initial.comprovanteNome ?? null } : null);
  const fontesIniciais: LinhaRateio[] = initial?.fontes?.length
    ? initial.fontes.map((f) => ({ fonteId: f.fonteId, valor: valorInput(f.valor), percentual: f.percentual != null ? valorInput(f.percentual).replace(/,00$/, "") : "" }))
    : [];
  const [modoRateio, setModoRateio] = useState<ModoRateio>(initial?.fontes?.length ? "valor" : "percentual");
  const [linhasRateio, setLinhasRateio] = useState<LinhaRateio[]>(fontesIniciais);
  const [erro, setErro] = useState<string | null>(null);

  const fontesQ = trpc.fin.fontes.listar.useQuery({ emitenteId }, { enabled: !!emitenteId && tipo === "despesa" });
  // despesa nova: começa com a primeira fonte ativa a 100%
  const [semeado, setSemeado] = useState(!!initial);
  if (!semeado && fontesQ.data && tipo === "despesa" && linhasRateio.length === 0) {
    setSemeado(true);
    setLinhasRateio([{ fonteId: fontesQ.data[0]?.id ?? "", valor: "", percentual: "100" }]);
  }

  const ok = () => { onSaved(); onClose(); };
  const criar = trpc.financeiro.criar.useMutation({ onSuccess: ok, onError: (e) => setErro(msgErro(e)) });
  const atualizar = trpc.financeiro.atualizar.useMutation({ onSuccess: ok, onError: (e) => setErro(msgErro(e)) });

  const valorNum = parseValor(valor);
  const ehNova = !initial;
  const legadoSemFonte = !!initial && !initial.fontes?.length;
  const rateioObrigatorio = tipo === "despesa" && (ehNova || !legadoSemFonte || linhasRateio.some((l) => l.fonteId));
  const st = statusRateio(modoRateio, linhasRateio, valorNum, rateioObrigatorio);

  const categorias = useMemo(() => {
    const base = tipo === "receita" ? (cats?.receita ?? []) : (cats?.despesa ?? []);
    return categoria && !base.includes(categoria) ? [...base, categoria] : base;
  }, [cats, tipo, categoria]);

  const legadoMapa = cats?.mapaDespesaLegado as Record<string, string> | undefined;

  function save() {
    setErro(null);
    if (!valorNum || valorNum <= 0) { setErro("Informe um valor positivo"); return; }
    if (tipo === "despesa" && !st.ok) { setErro(st.msg); return; }
    let fontes: Array<{ fonteId: string; valor?: number; percentual?: number }> | undefined;
    if (tipo === "despesa" && !st.vazio) {
      fontes = linhasRateio.filter((l) => l.fonteId).map((l) =>
        modoRateio === "percentual"
          ? { fonteId: l.fonteId, percentual: parseValor(l.percentual) ?? 0 }
          : { fonteId: l.fonteId, valor: parseValor(l.valor) ?? 0 });
    } else if (tipo === "receita" && initial?.fontes?.length) {
      fontes = []; // receita não usa rateio
    }
    const comuns = {
      tipo,
      descricao: descricao.trim(),
      categoria: categoria || undefined,
      valor: valorNum,
      data,
      pago,
      competencia: competencia || null,
      fornecedor: fornecedor.trim() || null,
      formaPagamento: (formaPagamento || null) as "pix" | "boleto" | "cartao" | "transferencia" | "dinheiro" | "debito_automatico" | "outro" | null,
      recorrente,
      recorrenciaFimEm: recorrente && recorrenciaFim ? recorrenciaFim : null,
      comprovantePath: anexo?.path ?? null,
      comprovanteNome: anexo?.nome ?? null,
      fontes,
    };
    if (initial) atualizar.mutate({ id: initial.id, ...comuns, obs });
    else criar.mutate({ ...comuns, emitenteId: emitenteId || undefined, obs: obs || undefined });
  }

  const salvando = criar.isLoading || atualizar.isLoading;

  return (
    <Modal titulo={initial ? "Editar lançamento" : "Novo lançamento"} onClose={onClose} largura="max-w-2xl">
      <div className="flex rounded-lg border overflow-hidden">
        {(["receita", "despesa"] as const).map((t) => (
          <button key={t} type="button"
            onClick={() => { setTipo(t); if (t !== tipo) setCategoria(""); }}
            className={`flex-1 py-2 text-sm font-medium transition-colors ${tipo === t ? (t === "receita" ? "bg-green-600 text-white" : "bg-red-600 text-white") : "text-gray-600 hover:bg-gray-50"}`}>
            {t === "receita" ? "Receita" : "Despesa"}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Campo rotulo="Descrição *" className="sm:col-span-2">
          <input value={descricao} onChange={(e) => setDescricao(e.target.value)} className={inputCls} />
        </Campo>
        <Campo rotulo={tipo === "despesa" ? "Fornecedor / beneficiário" : "Pagador"} className="sm:col-span-2">
          <input value={fornecedor} onChange={(e) => setFornecedor(e.target.value)} className={inputCls} />
        </Campo>
        <Campo rotulo="Categoria" dica={categoria && legadoMapa?.[categoria] ? `Categoria antiga — nos relatórios conta como "${legadoMapa[categoria]}"` : undefined}>
          <select value={categoria} onChange={(e) => setCategoria(e.target.value)} className={inputCls}>
            <option value="">—</option>
            {categorias.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </Campo>
        <Campo rotulo="Valor (R$) *">
          <input value={valor} onChange={(e) => setValor(e.target.value)} inputMode="decimal" placeholder="0,00" className={inputCls} />
        </Campo>
        <Campo rotulo={tipo === "despesa" ? "Data de pagamento *" : "Data de recebimento *"}>
          <input type="date" value={data} onChange={(e) => setData(e.target.value)} className={inputCls} />
        </Campo>
        <Campo rotulo="Competência" dica="Mês a que a despesa se refere (vazio = mês da data)">
          <input type="month" value={competencia} onChange={(e) => setCompetencia(e.target.value)} className={inputCls} />
        </Campo>
        <Campo rotulo="Forma de pagamento">
          <select value={formaPagamento} onChange={(e) => setFormaPagamento(e.target.value)} className={inputCls}>
            <option value="">—</option>
            {(cats?.formasPagamento ?? []).map((f) => <option key={f} value={f}>{ROTULO_FORMA_PAGAMENTO[f] ?? f}</option>)}
          </select>
        </Campo>
        <Campo rotulo="Empresa">
          <select value={emitenteId} onChange={(e) => { setEmitenteId(e.target.value); setLinhasRateio([]); setSemeado(false); }} className={inputCls} disabled={!!initial}>
            <option value="">—</option>
            {empresas?.map((e) => <option key={e.id} value={e.id}>{nomeEmpresa(e)}</option>)}
          </select>
        </Campo>

        {tipo === "despesa" && (
          <div className="sm:col-span-2">
            <EditorRateio emitenteId={emitenteId} valorTotal={valorNum} modo={modoRateio} setModo={setModoRateio}
              linhas={linhasRateio} setLinhas={setLinhasRateio} obrigatorio={rateioObrigatorio} />
            {legadoSemFonte && !linhasRateio.length && (
              <button type="button" className="text-xs text-indigo-600 hover:underline mt-1"
                onClick={() => setLinhasRateio([{ fonteId: fontesQ.data?.[0]?.id ?? "", valor: "", percentual: "100" }])}>
                Lançamento antigo sem fonte — informar a fonte
              </button>
            )}
          </div>
        )}

        <Campo rotulo="Comprovante" className="sm:col-span-2">
          <FinAnexo emitenteId={emitenteId} valor={anexo} onChange={setAnexo} />
        </Campo>

        <div className="sm:col-span-2 flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={pago} onChange={(e) => setPago(e.target.checked)} className="rounded" />
            <span className="text-sm text-gray-700">Já pago / recebido</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={recorrente} onChange={(e) => setRecorrente(e.target.checked)} className="rounded" disabled={!!initial?.recorrenciaOrigemId} />
            <span className="text-sm text-gray-700">Recorrente (mensal)</span>
          </label>
          {recorrente && (
            <span className="flex items-center gap-2 text-sm text-gray-600">
              até
              <input type="month" value={recorrenciaFim} onChange={(e) => setRecorrenciaFim(e.target.value)} className="border rounded-lg px-2 py-1 text-sm" />
              <span className="text-xs text-gray-400">(vazio = sem fim)</span>
            </span>
          )}
        </div>
        {initial?.recorrenciaOrigemId && <p className="sm:col-span-2 text-xs text-gray-500">Gerado de uma série recorrente.</p>}

        <Campo rotulo="Observação" className="sm:col-span-2">
          <input value={obs} onChange={(e) => setObs(e.target.value)} className={inputCls} />
        </Campo>
      </div>

      {erro && <ErroBox erro={erro} titulo="Não foi possível salvar" />}

      <div className="flex justify-end gap-2 pt-1">
        <button onClick={onClose} className={btnSec}>Cancelar</button>
        <button onClick={save} disabled={!descricao.trim() || !valor || !data || salvando || (tipo === "despesa" && !st.ok)} className={btnPri}>
          {salvando ? "Salvando…" : "Salvar"}
        </button>
      </div>
    </Modal>
  );
}

// ─── Lançar recorrências do mês ─────────────────────────────────────────────

function ModalRecorrencias({ emitenteId, competencia, onClose, onDone }: { emitenteId: string; competencia: string; onClose: () => void; onDone: () => void }) {
  const proj = trpc.fin.despesas.projecaoRecorrentes.useQuery({ emitenteId, de: competencia, ate: competencia });
  const [sel, setSel] = useState<Set<string> | null>(null);
  const [resultado, setResultado] = useState<number | null>(null);
  const lancar = trpc.fin.despesas.lancarRecorrencias.useMutation({
    onSuccess: (r) => { setResultado(r.criados); onDone(); },
  });
  const itens = proj.data ?? [];
  const marcados = sel ?? new Set(itens.map((i) => i.origemId));

  return (
    <Modal titulo={`Lançar recorrências — ${fmtMesStr(competencia)}`} onClose={onClose} largura="max-w-2xl">
      {proj.error ? <ErroBox erro={proj.error} /> : !proj.data ? <p className="text-sm text-gray-400">Carregando…</p> : resultado !== null ? (
        <p className="text-sm text-green-700">{resultado} lançamento(s) criado(s) como pendentes. Confira e marque como pago quando quitar.</p>
      ) : !itens.length ? (
        <p className="text-sm text-gray-500">Nenhuma recorrência pendente para este mês (todas já lançadas ou nenhuma série ativa).</p>
      ) : (
        <>
          <p className="text-xs text-gray-500">Serão criados como <b>pendentes</b>, com o mesmo rateio de fontes da série. Lançamentos já existentes no mês não são duplicados.</p>
          <TabelaWrap>
            <table className="w-full text-sm">
              <thead className="bg-gray-50"><tr>
                <th className={th} /><th className={`${th} text-left`}>Descrição</th><th className={`${th} text-left`}>Categoria</th>
                <th className={`${th} text-left`}>Data prevista</th><th className={`${th} text-right`}>Valor</th>
              </tr></thead>
              <tbody className="divide-y divide-gray-100">
                {itens.map((o) => (
                  <tr key={o.origemId}>
                    <td className={td}>
                      <input type="checkbox" checked={marcados.has(o.origemId)} onChange={() => {
                        const s = new Set(marcados);
                        if (s.has(o.origemId)) s.delete(o.origemId); else s.add(o.origemId);
                        setSel(s);
                      }} />
                    </td>
                    <td className={td}>{o.descricao} {o.tipo === "receita" && <Pill cor="green">receita</Pill>}</td>
                    <td className={td}>{o.categoria ?? "—"}</td>
                    <td className={td}>{fmtData(o.data)}</td>
                    <td className={`${td} text-right`}>{fmtBrl(o.valor)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TabelaWrap>
          {lancar.error && <ErroBox erro={lancar.error} />}
          <div className="flex justify-end gap-2">
            <button onClick={onClose} className={btnSec}>Cancelar</button>
            <button className={btnPri} disabled={!marcados.size || lancar.isLoading}
              onClick={() => lancar.mutate({ emitenteId, competencia, origemIds: [...marcados] })}>
              {lancar.isLoading ? "Lançando…" : `Lançar ${marcados.size}`}
            </button>
          </div>
        </>
      )}
      {resultado !== null && <div className="flex justify-end"><button onClick={onClose} className={btnPri}>Fechar</button></div>}
    </Modal>
  );
}

// ─── Página ─────────────────────────────────────────────────────────────────

function nomesFontes(l: Lanc): string {
  if (!l.fontes?.length) return "";
  return l.fontes.map((f) => `${f.fonte?.nome ?? "?"}${l.fontes.length > 1 ? ` (${fmtBrl(f.valor)})` : ""}`).join(" + ");
}

export default function Financeiro() {
  const emit = useEmitenteFin();
  const { podeLancar, podeEditar } = useFinPermissoes();
  const [mes, setMes] = useState(Number(hojeStr().slice(5, 7)));
  const [ano, setAno] = useState(anoAtual());
  const [tipoFiltro, setTipoFiltro] = useState<"receita" | "despesa" | "">("");
  const [todasEmpresas, setTodasEmpresas] = useState(false);
  const [categoria, setCategoria] = useState("");
  const [fonteId, setFonteId] = useState("");
  const [recorrente, setRecorrente] = useState<"" | "sim" | "nao">("");
  const [porCompetencia, setPorCompetencia] = useState(false);
  const [modal, setModal] = useState<{ lancamento?: Lanc } | null>(null);
  const [modalRec, setModalRec] = useState(false);
  const [erroAcao, setErroAcao] = useState<string | null>(null);

  const emitenteFiltro = todasEmpresas ? undefined : emit.emitenteId || undefined;
  const utils = trpc.useUtils();
  const { data: cats } = trpc.financeiro.categorias.useQuery();
  const fontes = trpc.fin.fontes.listar.useQuery({ emitenteId: emit.emitenteId, incluirInativas: true }, { enabled: !!emit.emitenteId && !todasEmpresas });
  const q = trpc.financeiro.listar.useQuery({
    mes, ano,
    tipo: tipoFiltro || undefined,
    emitenteId: emitenteFiltro,
    categoria: categoria || undefined,
    fonteId: !todasEmpresas && fonteId ? fonteId : undefined,
    recorrente: recorrente === "" ? undefined : recorrente === "sim",
    porCompetencia: porCompetencia || undefined,
  }, { enabled: todasEmpresas || !!emit.emitenteId || (!emit.carregando && !emit.empresas.length) });
  const { data: resumoAnual } = trpc.financeiro.resumoAnual.useQuery({ ano });

  const deletar = trpc.financeiro.deletar.useMutation({
    onSuccess: () => invalidate(),
    onError: (e) => setErroAcao(msgErro(e)),
  });
  const marcarPago = trpc.financeiro.atualizar.useMutation({
    onSuccess: () => invalidate(),
    onError: (e) => setErroAcao(msgErro(e)),
  });

  function invalidate() {
    utils.financeiro.listar.invalidate();
    utils.financeiro.resumoAnual.invalidate();
    utils.fin.relatorios.invalidate();
    utils.fin.orcamento.orcadoRealizado.invalidate();
    utils.fin.despesas.projecaoRecorrentes.invalidate();
  }

  const todasCategorias = useMemo(() => {
    const s = new Set<string>([...(cats?.despesa ?? []), ...(cats?.receita ?? []), ...(cats?.despesaLegado ?? [])]);
    return [...s];
  }, [cats]);

  const competenciaAtual = `${ano}-${String(mes).padStart(2, "0")}`;
  const lancs = q.data?.lancamentos ?? [];

  async function exportar() {
    await exportarExcel({
      nomeArquivo: `lancamentos-${competenciaAtual}`,
      abas: [{
        nome: `Lançamentos ${competenciaAtual}`,
        colunas: [
          { chave: "data", titulo: "Data pagamento", tipo: "data" },
          { chave: "competencia", titulo: "Competência", tipo: "texto" },
          { chave: "tipo", titulo: "Tipo" },
          { chave: "descricao", titulo: "Descrição", largura: 40 },
          { chave: "fornecedor", titulo: "Fornecedor / beneficiário", largura: 30 },
          { chave: "categoria", titulo: "Categoria" },
          { chave: "fontes", titulo: "Fonte(s)", largura: 36 },
          { chave: "forma", titulo: "Forma de pagamento" },
          { chave: "valor", titulo: "Valor", tipo: "moeda" },
          { chave: "status", titulo: "Status" },
          { chave: "recorrente", titulo: "Recorrente" },
          { chave: "empresa", titulo: "Empresa" },
          { chave: "comprovante", titulo: "Comprovante" },
          { chave: "obs", titulo: "Observação", largura: 30 },
        ],
        linhas: lancs.map((l) => ({
          data: l.data,
          competencia: l.competencia ? fmtMesStr(mesInput(l.competencia as unknown as string)) : "",
          tipo: l.tipo === "receita" ? "Receita" : "Despesa",
          descricao: l.descricao,
          fornecedor: l.fornecedor,
          categoria: l.categoria,
          fontes: l.fontes?.length ? nomesFontes(l) : (l.tipo === "despesa" ? "Sem fonte" : ""),
          forma: l.formaPagamento ? ROTULO_FORMA_PAGAMENTO[l.formaPagamento] ?? l.formaPagamento : "",
          valor: l.tipo === "despesa" ? -num(l.valor) : num(l.valor),
          status: l.pago ? "Pago" : "Pendente",
          recorrente: l.recorrente ? "Sim" : l.recorrenciaOrigemId ? "Da série" : "",
          empresa: l.emitente?.nome ?? "",
          comprovante: l.comprovanteNome ?? (l.comprovantePath ? "sim" : ""),
          obs: l.obs,
        })),
      }],
    });
  }

  return (
    <div className="p-4 md:p-6 space-y-6">
      <Cabecalho titulo="Lançamentos" subtitulo="Receitas e despesas: competência, fornecedor, fonte do recurso (rateio), comprovante e recorrência." emitente={emit}>
        {podeEditar && emit.emitenteId && !todasEmpresas && (
          <button onClick={() => setModalRec(true)} className={btnSec} title="Cria os lançamentos do mês das despesas recorrentes">
            Lançar recorrências de {MESES_CURTOS[mes - 1]}/{String(ano).slice(2)}
          </button>
        )}
        <BotoesExportar onExcel={exportar} tituloPdf={`Lançamentos ${competenciaAtual}`} desabilitado={!lancs.length} />
        {podeLancar && <button onClick={() => setModal({})} className={btnPri}>+ Lançamento</button>}
      </Cabecalho>

      {q.data && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="bg-green-50 border border-green-200 rounded-xl p-4">
            <p className="text-xs font-medium text-green-700 uppercase tracking-wide">Receitas</p>
            <p className="text-2xl font-bold text-green-800 mt-1">{fmtBrl(q.data.totalReceita)}</p>
          </div>
          <div className="bg-red-50 border border-red-200 rounded-xl p-4">
            <p className="text-xs font-medium text-red-700 uppercase tracking-wide">Despesas</p>
            <p className="text-2xl font-bold text-red-800 mt-1">{fmtBrl(q.data.totalDespesa)}</p>
          </div>
          <div className={`border rounded-xl p-4 ${q.data.saldo >= 0 ? "bg-indigo-50 border-indigo-200" : "bg-amber-50 border-amber-200"}`}>
            <p className={`text-xs font-medium uppercase tracking-wide ${q.data.saldo >= 0 ? "text-indigo-700" : "text-amber-700"}`}>Saldo</p>
            <p className={`text-2xl font-bold mt-1 ${q.data.saldo >= 0 ? "text-indigo-800" : "text-amber-800"}`}>{fmtBrl(q.data.saldo)}</p>
          </div>
        </div>
      )}

      {resumoAnual && (
        <div className="bg-white rounded-xl border border-gray-200 p-5 no-print">
          <h2 className="text-sm font-semibold text-gray-700 mb-4">Evolução anual {ano} <span className="text-xs font-normal text-gray-400">(todas as empresas)</span></h2>
          <div className="flex items-end gap-1 h-24">
            {resumoAnual.map((m) => {
              const maxVal = Math.max(...resumoAnual.map((r) => Math.max(r.receita, r.despesa)), 1);
              const recH = Math.round((m.receita / maxVal) * 80);
              const despH = Math.round((m.despesa / maxVal) * 80);
              return (
                <div key={m.mes} className="flex-1 flex flex-col items-center gap-0.5">
                  <div className="flex items-end gap-0.5 h-20">
                    <div className="w-2 bg-green-400 rounded-t" style={{ height: recH || 2 }} title={`Receita: ${fmtBrl(m.receita)}`} />
                    <div className="w-2 bg-red-400 rounded-t" style={{ height: despH || 2 }} title={`Despesa: ${fmtBrl(m.despesa)}`} />
                  </div>
                  <span className="text-[9px] text-gray-400">{MESES_CURTOS[m.mes - 1]}</span>
                </div>
              );
            })}
          </div>
          <div className="flex gap-4 mt-2">
            <span className="flex items-center gap-1 text-xs text-gray-500"><span className="h-2 w-2 bg-green-400 rounded" />Receita</span>
            <span className="flex items-center gap-1 text-xs text-gray-500"><span className="h-2 w-2 bg-red-400 rounded" />Despesa</span>
          </div>
        </div>
      )}

      {/* Filtros */}
      <div className="flex items-center gap-2 flex-wrap no-print">
        <select value={mes} onChange={(e) => setMes(Number(e.target.value))} className="border rounded-lg px-3 py-2 text-sm bg-white">
          {MESES_CURTOS.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
        </select>
        <select value={ano} onChange={(e) => setAno(Number(e.target.value))} className="border rounded-lg px-3 py-2 text-sm bg-white">
          {Array.from({ length: 6 }, (_, i) => anoAtual() - 3 + i).map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
        <select value={tipoFiltro} onChange={(e) => setTipoFiltro(e.target.value as "" | "receita" | "despesa")} className="border rounded-lg px-3 py-2 text-sm bg-white">
          <option value="">Receitas e despesas</option>
          <option value="receita">Receitas</option>
          <option value="despesa">Despesas</option>
        </select>
        <select value={categoria} onChange={(e) => setCategoria(e.target.value)} className="border rounded-lg px-3 py-2 text-sm bg-white">
          <option value="">Todas as categorias</option>
          {todasCategorias.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        {!todasEmpresas && (
          <select value={fonteId} onChange={(e) => setFonteId(e.target.value)} className="border rounded-lg px-3 py-2 text-sm bg-white">
            <option value="">Todas as fontes</option>
            <option value="sem_fonte">Sem fonte informada</option>
            {(fontes.data ?? []).map((f) => <option key={f.id} value={f.id}>{f.nome}{!f.ativo ? " (inativa)" : ""}</option>)}
          </select>
        )}
        <select value={recorrente} onChange={(e) => setRecorrente(e.target.value as "" | "sim" | "nao")} className="border rounded-lg px-3 py-2 text-sm bg-white">
          <option value="">Recorrentes e avulsos</option>
          <option value="sim">Só séries recorrentes</option>
          <option value="nao">Não recorrentes</option>
        </select>
        <label className="flex items-center gap-1.5 text-sm text-gray-600">
          <input type="checkbox" checked={porCompetencia} onChange={(e) => setPorCompetencia(e.target.checked)} /> por competência
        </label>
        {emit.empresas.length > 1 && (
          <label className="flex items-center gap-1.5 text-sm text-gray-600">
            <input type="checkbox" checked={todasEmpresas} onChange={(e) => { setTodasEmpresas(e.target.checked); setFonteId(""); }} /> todas as empresas
          </label>
        )}
      </div>

      {erroAcao && <ErroBox erro={erroAcao} />}

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {q.error ? (
          <div className="p-4"><ErroBox erro={q.error} /></div>
        ) : !q.data ? (
          <p className="p-6 text-sm text-gray-400 animate-pulse">Carregando…</p>
        ) : !lancs.length ? (
          <p className="p-6 text-sm text-gray-400 text-center">Nenhum lançamento neste período.</p>
        ) : (
          <TabelaWrap>
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b">
                <tr>
                  <th className={`${th} text-left`}>Pagamento</th>
                  <th className={`${th} text-left`}>Comp.</th>
                  <th className={`${th} text-left`}>Descrição</th>
                  <th className={`${th} text-left`}>Categoria</th>
                  <th className={`${th} text-left`}>Fonte</th>
                  <th className={`${th} text-left`}>Forma</th>
                  <th className={`${th} text-right`}>Valor</th>
                  <th className={`${th} text-center`}>Status</th>
                  <th className={`${th} no-print`} />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {lancs.map((l) => (
                  <tr key={l.id} className="hover:bg-gray-50 align-top">
                    <td className={`${td} text-gray-600`}>{fmtData(l.data as unknown as string)}</td>
                    <td className={`${td} text-gray-500`}>{l.competencia ? fmtMesStr(mesInput(l.competencia as unknown as string)) : "—"}</td>
                    <td className="px-3 py-2 min-w-[200px]">
                      <div className="font-medium text-gray-900">
                        {l.descricao}
                        {l.recorrente && <span className="ml-1"><Pill cor="indigo" title={l.recorrenciaFimEm ? `até ${fmtMesStr(mesInput(l.recorrenciaFimEm as unknown as string))}` : "sem fim"}>recorrente</Pill></span>}
                        {l.recorrenciaOrigemId && <span className="ml-1"><Pill cor="blue">da série</Pill></span>}
                      </div>
                      {(l.fornecedor || l.emitente) && (
                        <div className="text-xs text-gray-400">
                          {l.fornecedor}{l.fornecedor && l.emitente && todasEmpresas ? " · " : ""}{todasEmpresas && l.emitente ? l.emitente.nome : ""}
                        </div>
                      )}
                      {l.comprovantePath && <FinAnexoLink path={l.comprovantePath} nome={l.comprovanteNome} />}
                    </td>
                    <td className={`${td} text-gray-500`}>{l.categoria ?? "—"}</td>
                    <td className="px-3 py-2 text-xs text-gray-600 min-w-[140px]">
                      {l.fontes?.length ? nomesFontes(l) : l.tipo === "despesa" ? <span className="text-amber-600">sem fonte</span> : "—"}
                    </td>
                    <td className={`${td} text-xs text-gray-500`}>{l.formaPagamento ? ROTULO_FORMA_PAGAMENTO[l.formaPagamento] ?? l.formaPagamento : "—"}</td>
                    <td className={`${td} text-right font-semibold ${l.tipo === "receita" ? "text-green-700" : "text-red-700"}`}>
                      {l.tipo === "despesa" ? "−" : "+"}{fmtBrl(l.valor)}
                    </td>
                    <td className={`${td} text-center`}>
                      <button
                        disabled={!podeLancar || marcarPago.isLoading}
                        onClick={() => marcarPago.mutate({ id: l.id, pago: !l.pago })}
                        title={podeLancar ? "Clique para alternar" : undefined}
                        className={`text-xs px-2 py-0.5 rounded-full ${l.pago ? "bg-green-100 text-green-700" : "bg-amber-100 text-amber-700"} disabled:cursor-default`}>
                        {l.pago ? "Pago" : "Pendente"}
                      </button>
                    </td>
                    <td className={`${td} text-right no-print`}>
                      {podeLancar && (
                        <>
                          <button onClick={() => setModal({ lancamento: l })} className={`${btnLink} mr-2`}>Editar</button>
                          <button onClick={() => { if (confirm("Excluir este lançamento?")) { setErroAcao(null); deletar.mutate({ id: l.id }); } }} className={btnLinkRed}>Excluir</button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TabelaWrap>
        )}
      </div>

      {modal !== null && (
        <ModalLancamento initial={modal.lancamento} emitentePadrao={emit.emitenteId} onClose={() => setModal(null)} onSaved={invalidate} />
      )}
      {modalRec && emit.emitenteId && (
        <ModalRecorrencias emitenteId={emit.emitenteId} competencia={competenciaAtual} onClose={() => setModalRec(false)} onDone={invalidate} />
      )}
    </div>
  );
}
