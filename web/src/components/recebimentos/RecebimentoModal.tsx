/**
 * Modal de um recebimento (parcela de acordo ou execução/sentença): dados previstos, baixa
 * (com cálculo de honorários/repasse devolvido pelo server), estorno, repasse ao cliente e NF.
 * Mutações exigem o módulo `financeiro_editar` (server: finEdicaoProc).
 */
import { useEffect, useState } from "react";
import { trpc } from "../../lib/trpc";
import { useAuth } from "../../lib/usePermission";
import { FinAnexo, FinAnexoLink } from "../FinAnexo";
import {
  NF, REPASSE, STATUS_REC, btnPerigo, btnPri, btnSec, fmtBrl, fmtData, hojeCal, inputCls, labelCls, parseValor, podeModulo,
  valorParaInput, type RO,
} from "../acordos/util";

type Rec = RO["recebimentos"]["obter"];
type Calculo = RO["recebimentos"]["baixar"]["calculo"];
type Aba = "baixa" | "repasse" | "nf" | "dados";

export default function RecebimentoModal({ id, onClose, abaInicial }: { id: string; onClose: () => void; abaInicial?: Aba }) {
  const { user } = useAuth();
  const pode = podeModulo(user, "financeiro_editar");
  const q = trpc.recebimentos.obter.useQuery({ id });
  const [aba, setAba] = useState<Aba>(abaInicial ?? "baixa");
  const r = q.data;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-2 sm:p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[95vh] overflow-y-auto">
        <div className="sticky top-0 bg-white border-b px-4 py-3 flex items-start gap-3 z-10">
          <div className="flex-1 min-w-0">
            <p className="text-[11px] uppercase tracking-wide text-gray-400">
              {r ? (r.tipo === "acordo" ? `Acordo · ${r.parcelaNumero === 0 ? "entrada" : r.parcelaNumero != null ? `parcela ${r.parcelaNumero}` : "parcela"}` : "Execução / sentença") : "Recebimento"}
            </p>
            <h2 className="text-base font-semibold text-gray-900 truncate">{r?.deal?.titulo ?? r?.descricao ?? (q.isLoading ? "Carregando…" : "—")}</h2>
            {r && <p className="text-xs text-gray-500 truncate">{r.deal?.contato?.nome ?? "—"}{r.deal?.empresaRe?.nome && <> × {r.deal.empresaRe.nome}</>} · {r.emitente?.nomeFantasia || r.emitente?.nome}</p>}
          </div>
          {r && <span className={`text-[11px] border rounded-full px-2 py-0.5 ${STATUS_REC[r.status]?.cor ?? ""}`}>{STATUS_REC[r.status]?.rotulo}</span>}
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-xl leading-none" aria-label="Fechar">×</button>
        </div>

        {q.error && <p className="p-4 text-sm text-red-600">{q.error.message}</p>}
        {r && (
          <div className="p-4 space-y-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 bg-gray-50 border border-gray-200 rounded-lg p-3 text-sm">
              <Info r="Vencimento" v={fmtData(r.vencimento)} />
              <Info r="Previsto" v={fmtBrl(r.valorPrevisto)} />
              <Info r="Recebido em" v={fmtData(r.dataRecebimento)} />
              <Info r="Bruto recebido" v={fmtBrl(r.valorBruto)} />
              <Info r="Honorários" v={`${fmtBrl(r.valorHonorarios)}${r.percHonorarios != null ? ` (${r.percHonorarios}%)` : ""}`} />
              <Info r="Sucumbência" v={fmtBrl(r.valorSucumbencia)} />
              <Info r="A repassar" v={fmtBrl(r.valorRepasse)} />
              <Info r="Receita do escritório" v={fmtBrl(r.receitaEscritorio)} />
            </div>

            <div className="flex gap-1 border-b">
              {(["baixa", "repasse", "nf", "dados"] as Aba[]).map((k) => (
                <button key={k} onClick={() => setAba(k)}
                  className={`px-3 py-1.5 text-xs border-b-2 -mb-px ${aba === k ? "border-brand-900 text-gray-900 font-semibold" : "border-transparent text-gray-500 hover:text-gray-800"}`}>
                  {{ baixa: "Baixa", repasse: `Repasse · ${REPASSE[r.repasseStatus] ?? r.repasseStatus}`, nf: `NF · ${NF[r.nfStatus] ?? r.nfStatus}`, dados: "Dados" }[k]}
                </button>
              ))}
            </div>
            {!pode && <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">Somente leitura — editar exige o módulo “financeiro (editar)”.</p>}

            {aba === "baixa" && <Baixa r={r} pode={pode} />}
            {aba === "repasse" && <Repasse r={r} pode={pode} />}
            {aba === "nf" && <NotaFiscal r={r} pode={pode} />}
            {aba === "dados" && <Dados r={r} pode={pode} onExcluido={onClose} />}
          </div>
        )}
      </div>
    </div>
  );
}

function Info({ r, v }: { r: string; v: React.ReactNode }) {
  return <div><p className="text-[11px] text-gray-400">{r}</p><p className="text-gray-800">{v}</p></div>;
}

function useInvalidar() {
  const utils = trpc.useUtils();
  return () => { utils.recebimentos.invalidate(); utils.acordos.detalhe.invalidate(); utils.acordos.indicadores.invalidate(); };
}

// ── Baixa ────────────────────────────────────────────────────────────────────

function Baixa({ r, pode }: { r: Rec; pode: boolean }) {
  const invalidar = useInvalidar();
  const [f, setF] = useState(() => ({
    data: r.dataRecebimento ?? hojeCal(),
    bruto: valorParaInput(r.valorBruto ?? r.valorPrevisto),
    perc: r.percHonorarios != null ? String(r.percHonorarios) : "",
    honorarios: "",
    sucumbencia: valorParaInput(r.valorSucumbencia ?? 0),
    semRepasse: r.repasseStatus === "nao_aplicavel",
    comprovante: r.comprovantePath ? { path: r.comprovantePath, nome: r.comprovanteNome } : null as { path: string; nome: string | null } | null,
  }));
  const [calc, setCalc] = useState<Calculo | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  useEffect(() => { setCalc(null); }, [r.id]);

  const baixar = trpc.recebimentos.baixar.useMutation({
    onSuccess: (res) => { setErro(null); setCalc(res.calculo); invalidar(); },
    onError: (e) => setErro(e.message),
  });
  const estornar = trpc.recebimentos.estornarBaixa.useMutation({
    onSuccess: () => { setErro(null); setCalc(null); invalidar(); },
    onError: (e) => setErro(e.message),
  });

  // Prévia local (o valor final é o devolvido pelo server, em centavos exatos)
  const brutoN = parseValor(f.bruto) ?? 0;
  const percN = f.perc.trim() ? parseValor(f.perc) ?? 0 : 0;
  const honInf = f.honorarios.trim() ? parseValor(f.honorarios) : null;
  const sucN = parseValor(f.sucumbencia) ?? 0;
  const honPrev = f.semRepasse ? brutoN : honInf ?? Math.round(brutoN * percN) / 100;
  const repPrev = Math.max(0, brutoN - honPrev);

  function salvar() {
    const bruto = parseValor(f.bruto);
    if (bruto === null || bruto < 0) return setErro("Valor bruto inválido.");
    if (!f.data) return setErro("Informe a data do recebimento.");
    const perc = f.perc.trim() ? parseValor(f.perc) : null;
    if (f.perc.trim() && (perc === null || perc < 0 || perc > 100)) return setErro("% de honorários inválido.");
    if (f.honorarios.trim() && honInf === null) return setErro("Honorários inválidos.");
    baixar.mutate({
      id: r.id, dataRecebimento: f.data, valorBruto: bruto, percHonorarios: perc,
      honorarios: honInf, valorSucumbencia: sucN, semRepasse: f.semRepasse,
      comprovantePath: f.comprovante?.path ?? null, comprovanteNome: f.comprovante?.nome ?? null,
    });
  }

  const dis = !pode || r.repasseStatus === "realizado";
  return (
    <div className="space-y-3">
      {r.repasseStatus === "realizado" && <p className="text-xs text-gray-500">Repasse já realizado: para refazer a baixa, volte o repasse para pendente.</p>}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        <div><label className={labelCls}>Data do recebimento</label><input type="date" value={f.data} onChange={(e) => setF({ ...f, data: e.target.value })} disabled={dis} className={inputCls} /></div>
        <div><label className={labelCls}>Valor bruto recebido</label><input value={f.bruto} onChange={(e) => setF({ ...f, bruto: e.target.value })} disabled={dis} className={inputCls} inputMode="decimal" /></div>
        <div><label className={labelCls}>% honorários contratuais</label><input value={f.perc} onChange={(e) => setF({ ...f, perc: e.target.value })} disabled={dis || f.semRepasse} className={inputCls} inputMode="decimal" /></div>
        <div><label className={labelCls}>Honorários em valor (opcional)</label><input value={f.honorarios} onChange={(e) => setF({ ...f, honorarios: e.target.value })} disabled={dis || f.semRepasse} className={inputCls} inputMode="decimal" placeholder="prevalece sobre o %" /></div>
        <div><label className={labelCls}>Honorários sucumbenciais</label><input value={f.sucumbencia} onChange={(e) => setF({ ...f, sucumbencia: e.target.value })} disabled={dis} className={inputCls} inputMode="decimal" /></div>
        <div className="flex items-end">
          <label className="flex items-center gap-2 text-xs text-gray-700 pb-2">
            <input type="checkbox" checked={f.semRepasse} onChange={(e) => setF({ ...f, semRepasse: e.target.checked })} disabled={dis} /> Sem repasse (100% escritório)
          </label>
        </div>
      </div>
      <div>
        <label className={labelCls}>Comprovante</label>
        <FinAnexo emitenteId={r.emitenteId} valor={f.comprovante} onChange={(v) => setF({ ...f, comprovante: v })} desabilitado={dis} />
      </div>

      <div className="text-xs bg-gray-50 border border-gray-200 rounded-lg p-3 space-y-0.5">
        {calc ? (
          <>
            <p className="font-semibold text-gray-700">Cálculo gravado (servidor)</p>
            <p>Bruto {fmtBrl(calc.bruto)} − honorários {fmtBrl(calc.honorarios)} = <b>a repassar {fmtBrl(calc.repasse)}</b></p>
            <p>Sucumbência {fmtBrl(calc.sucumbencia)} (fica com o escritório, sem repasse)</p>
            <p>Receita do escritório = honorários + sucumbência = <b>{fmtBrl(calc.receitaEscritorio)}</b> · NF sugerida {fmtBrl(calc.nfValorSugerido)}</p>
          </>
        ) : (
          <>
            <p className="font-semibold text-gray-700">Prévia {pode && "(o valor final é calculado pelo servidor ao salvar)"}</p>
            <p>Bruto {fmtBrl(brutoN)} − honorários {fmtBrl(honPrev)}{!f.semRepasse && honInf === null && percN ? ` (${percN}%)` : ""} = <b>a repassar {fmtBrl(repPrev)}</b></p>
            <p>Sucumbência {fmtBrl(sucN)} · receita do escritório {fmtBrl(honPrev + sucN)}</p>
          </>
        )}
      </div>

      {pode && (
        <div className="flex flex-wrap gap-2">
          <button className={btnPri} onClick={salvar} disabled={dis || baixar.isLoading}>{baixar.isLoading ? "Gravando…" : r.dataRecebimento ? "Refazer baixa" : "Dar baixa"}</button>
          {r.dataRecebimento && (
            <button className={btnPerigo} disabled={estornar.isLoading}
              onClick={() => { if (confirm("Estornar a baixa? O recebimento volta a previsto/em atraso.")) estornar.mutate({ id: r.id }); }}>
              Estornar baixa
            </button>
          )}
        </div>
      )}
      {erro && <p className="text-xs text-red-600">{erro}</p>}
    </div>
  );
}

// ── Repasse ──────────────────────────────────────────────────────────────────

function Repasse({ r, pode }: { r: Rec; pode: boolean }) {
  const invalidar = useInvalidar();
  const [status, setStatus] = useState<"pendente" | "realizado" | "nao_aplicavel">(r.repasseStatus as any);
  const [data, setData] = useState(r.repasseData ?? hojeCal());
  const [comp, setComp] = useState<{ path: string; nome: string | null } | null>(r.repasseComprovantePath ? { path: r.repasseComprovantePath, nome: r.repasseComprovanteNome } : null);
  const [erro, setErro] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const mut = trpc.recebimentos.repasse.useMutation({
    onSuccess: () => { setErro(null); setOk(true); setTimeout(() => setOk(false), 2000); invalidar(); },
    onError: (e) => setErro(e.message),
  });
  return (
    <div className="space-y-3">
      <p className="text-xs text-gray-600">
        Valor a repassar ao cliente: <b>{fmtBrl(r.valorRepasse)}</b>. Enquanto pendente, é <b>valor de terceiros</b> (não é receita nem caixa do escritório).
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <div>
          <label className={labelCls}>Status</label>
          <select value={status} onChange={(e) => setStatus(e.target.value as any)} disabled={!pode} className={inputCls}>
            <option value="pendente">Pendente</option><option value="realizado">Realizado</option><option value="nao_aplicavel">Não se aplica</option>
          </select>
        </div>
        {status === "realizado" && (
          <div><label className={labelCls}>Data do repasse</label><input type="date" value={data} onChange={(e) => setData(e.target.value)} disabled={!pode} className={inputCls} /></div>
        )}
      </div>
      {status === "realizado" && (
        <div>
          <label className={labelCls}>Comprovante do repasse</label>
          <FinAnexo emitenteId={r.emitenteId} valor={comp} onChange={setComp} desabilitado={!pode} />
        </div>
      )}
      {pode && (
        <button className={btnPri} disabled={mut.isLoading} onClick={() => mut.mutate({
          id: r.id, status, data: status === "realizado" ? data : null,
          ...(status === "realizado" ? { comprovantePath: comp?.path ?? null, comprovanteNome: comp?.nome ?? null } : {}),
        })}>{mut.isLoading ? "Gravando…" : "Salvar repasse"}</button>
      )}
      {ok && <span className="text-xs text-green-700 ml-2">Salvo ✓</span>}
      {erro && <p className="text-xs text-red-600">{erro}</p>}
    </div>
  );
}

// ── NF ───────────────────────────────────────────────────────────────────────

function NotaFiscal({ r, pode }: { r: Rec; pode: boolean }) {
  const invalidar = useInvalidar();
  const [status, setStatus] = useState<"a_emitir" | "emitida" | "nao_aplicavel">(r.nfStatus as any);
  const [valor, setValor] = useState(valorParaInput(r.nfValor));
  const [numero, setNumero] = useState(r.nfNumero ?? "");
  const [data, setData] = useState(r.nfData ?? "");
  const [anexo, setAnexo] = useState<{ path: string; nome: string | null } | null>(r.nfAnexoPath ? { path: r.nfAnexoPath, nome: r.nfAnexoNome } : null);
  const [notaId, setNotaId] = useState(r.notaFiscalId ?? "");
  const [busca, setBusca] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const notas = trpc.recebimentos.notasDisponiveis.useQuery({ emitenteId: r.emitenteId, busca: busca.trim() || undefined }, { enabled: status === "emitida" });
  const mut = trpc.recebimentos.nf.useMutation({
    onSuccess: () => { setErro(null); setOk(true); setTimeout(() => setOk(false), 2000); invalidar(); },
    onError: (e) => setErro(e.message),
  });

  function salvar() {
    const v = valor.trim() ? parseValor(valor) : null;
    if (valor.trim() && v === null) return setErro("Valor inválido.");
    const vinculou = (notaId || null) !== (r.notaFiscalId ?? null);
    mut.mutate({
      id: r.id, status,
      // ao vincular uma nota existente sem mexer nos campos, número/data/valor vêm dela (server)
      ...(vinculou && numero === (r.nfNumero ?? "") ? {} : { numero: numero.trim() || null }),
      ...(vinculou && data === (r.nfData ?? "") ? {} : { data: data || null }),
      ...(vinculou && valor === valorParaInput(r.nfValor) ? {} : { valor: v }),
      anexoPath: anexo?.path ?? null, anexoNome: anexo?.nome ?? null,
      notaFiscalId: notaId || null,
    });
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-gray-600">A NF é só sobre o que é do escritório (honorários + sucumbência) — nunca sobre o valor repassado ao cliente.</p>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <div>
          <label className={labelCls}>Status</label>
          <select value={status} onChange={(e) => setStatus(e.target.value as any)} disabled={!pode} className={inputCls}>
            <option value="a_emitir">A emitir</option><option value="emitida">Emitida</option><option value="nao_aplicavel">Não se aplica</option>
          </select>
        </div>
        <div><label className={labelCls}>Valor (honorários)</label><input value={valor} onChange={(e) => setValor(e.target.value)} disabled={!pode} className={inputCls} inputMode="decimal" /></div>
        <div><label className={labelCls}>Número</label><input value={numero} onChange={(e) => setNumero(e.target.value)} disabled={!pode} className={inputCls} /></div>
        <div><label className={labelCls}>Data</label><input type="date" value={data} onChange={(e) => setData(e.target.value)} disabled={!pode} className={inputCls} /></div>
      </div>
      <div>
        <label className={labelCls}>Anexo da NF</label>
        <FinAnexo emitenteId={r.emitenteId} valor={anexo} onChange={setAnexo} desabilitado={!pode} />
      </div>
      {status === "emitida" && (
        <div className="border border-gray-200 rounded-lg p-2 space-y-2">
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex-1 min-w-[160px]">
              <label className={labelCls}>Vincular a uma nota já emitida no Avoce (opcional)</label>
              <input value={busca} onChange={(e) => setBusca(e.target.value)} className={inputCls} placeholder="buscar por número ou competência" />
            </div>
            {notaId && <button className="text-xs text-gray-500 underline pb-2" onClick={() => setNotaId("")} disabled={!pode}>desvincular</button>}
          </div>
          {notas.error && <p className="text-xs text-red-600">{notas.error.message}</p>}
          <div className="max-h-40 overflow-y-auto divide-y">
            {(notas.data ?? []).map((n) => (
              <label key={n.id} className="flex items-center gap-2 px-1 py-1 text-xs cursor-pointer hover:bg-gray-50">
                <input type="radio" name="nota" checked={notaId === n.id} onChange={() => setNotaId(n.id)} disabled={!pode} />
                <span className="font-mono">{n.numero ?? "(sem nº)"}</span>
                <span className="text-gray-500">{n.competencia}</span>
                <span>{fmtBrl(n.valor)}</span>
                <span className="text-gray-400">{fmtData(n.emitidoEm)} · {n.status}</span>
              </label>
            ))}
            {notas.data && !notas.data.length && <p className="text-xs text-gray-400 p-1">Nenhuma nota encontrada para esta empresa.</p>}
          </div>
        </div>
      )}
      {pode && <button className={btnPri} onClick={salvar} disabled={mut.isLoading}>{mut.isLoading ? "Gravando…" : "Salvar NF"}</button>}
      {ok && <span className="text-xs text-green-700 ml-2">Salvo ✓</span>}
      {erro && <p className="text-xs text-red-600">{erro}</p>}
    </div>
  );
}

// ── Dados previstos / exclusão ───────────────────────────────────────────────

function Dados({ r, pode, onExcluido }: { r: Rec; pode: boolean; onExcluido: () => void }) {
  const invalidar = useInvalidar();
  const [f, setF] = useState(() => ({
    descricao: r.descricao ?? "", vencimento: r.vencimento ?? "", previsto: valorParaInput(r.valorPrevisto),
    perc: r.percHonorarios != null ? String(r.percHonorarios) : "", sucumbencia: valorParaInput(r.valorSucumbencia ?? 0), obs: r.obs ?? "",
  }));
  const [erro, setErro] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const mut = trpc.recebimentos.atualizar.useMutation({
    onSuccess: () => { setErro(null); setOk(true); setTimeout(() => setOk(false), 2000); invalidar(); },
    onError: (e) => setErro(e.message),
  });
  const excluir = trpc.recebimentos.excluir.useMutation({
    onSuccess: () => { invalidar(); onExcluido(); },
    onError: (e) => setErro(e.message),
  });
  function salvar() {
    const prev = f.previsto.trim() ? parseValor(f.previsto) : null;
    if (f.previsto.trim() && prev === null) return setErro("Valor previsto inválido.");
    const perc = f.perc.trim() ? parseValor(f.perc) : null;
    if (f.perc.trim() && (perc === null || perc < 0 || perc > 100)) return setErro("% inválido.");
    const suc = parseValor(f.sucumbencia) ?? 0;
    mut.mutate({ id: r.id, descricao: f.descricao || null, vencimento: f.vencimento || null, valorPrevisto: prev, percHonorarios: perc, valorSucumbencia: suc, obs: f.obs || null });
  }
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        <div className="col-span-2 sm:col-span-3"><label className={labelCls}>Descrição</label><input value={f.descricao} onChange={(e) => setF({ ...f, descricao: e.target.value })} disabled={!pode} className={inputCls} /></div>
        <div><label className={labelCls}>Vencimento</label><input type="date" value={f.vencimento} onChange={(e) => setF({ ...f, vencimento: e.target.value })} disabled={!pode} className={inputCls} /></div>
        <div><label className={labelCls}>Valor previsto</label><input value={f.previsto} onChange={(e) => setF({ ...f, previsto: e.target.value })} disabled={!pode} className={inputCls} inputMode="decimal" /></div>
        <div><label className={labelCls}>% honorários</label><input value={f.perc} onChange={(e) => setF({ ...f, perc: e.target.value })} disabled={!pode} className={inputCls} inputMode="decimal" /></div>
        <div><label className={labelCls}>Sucumbência</label><input value={f.sucumbencia} onChange={(e) => setF({ ...f, sucumbencia: e.target.value })} disabled={!pode} className={inputCls} inputMode="decimal" /></div>
        <div className="col-span-2"><label className={labelCls}>Observação</label><input value={f.obs} onChange={(e) => setF({ ...f, obs: e.target.value })} disabled={!pode} className={inputCls} /></div>
      </div>
      {r.comprovantePath && <p className="text-xs">Comprovante da baixa: <FinAnexoLink path={r.comprovantePath} nome={r.comprovanteNome} /></p>}
      {pode && (
        <div className="flex flex-wrap gap-2">
          <button className={btnPri} onClick={salvar} disabled={mut.isLoading}>{mut.isLoading ? "Salvando…" : "Salvar"}</button>
          <button className={btnPerigo} disabled={excluir.isLoading || !!r.dataRecebimento || r.nfStatus === "emitida"}
            title={r.dataRecebimento ? "Estorne a baixa antes de excluir" : r.nfStatus === "emitida" ? "Há NF emitida" : ""}
            onClick={() => { if (confirm("Excluir este recebimento?")) excluir.mutate({ id: r.id }); }}>Excluir</button>
          <button className={btnSec} onClick={() => setF({ descricao: r.descricao ?? "", vencimento: r.vencimento ?? "", previsto: valorParaInput(r.valorPrevisto), perc: r.percHonorarios != null ? String(r.percHonorarios) : "", sucumbencia: valorParaInput(r.valorSucumbencia ?? 0), obs: r.obs ?? "" })}>Desfazer</button>
        </div>
      )}
      {ok && <span className="text-xs text-green-700">Salvo ✓</span>}
      {erro && <p className="text-xs text-red-600">{erro}</p>}
    </div>
  );
}
