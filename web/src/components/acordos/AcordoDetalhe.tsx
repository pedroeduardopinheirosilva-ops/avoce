/**
 * Detalhe da negociação (drawer) — /acordos/:id.
 *
 * Dados da negociação, rodadas (proposta/contraproposta), saídas (§2.3): retornar ao fluxo normal,
 * firmar, homologar (gerador de parcelas com pré-visualização via acordos.simularParcelas),
 * envio para execução, parcelas geradas (atalho para a baixa) e histórico.
 */
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { trpc } from "../../lib/trpc";
import { useAuth } from "../../lib/usePermission";
import { FinAnexo } from "../FinAnexo";
import RecebimentoModal from "../recebimentos/RecebimentoModal";
import {
  FASES, MOTIVOS_SAIDA, NF, REPASSE, STATUS_ABERTOS, STATUS_ACORDO, STATUS_REC,
  btnPerigo, btnPri, btnSec, fmtBrl, fmtData, fmtDataHora, hojeCal, inputCls, labelCls, parseValor, podeModulo,
  rotuloFase, rotuloMotivoSaida, rotuloTipoAcordo, valorParaInput, type Fase, type RO,
} from "./util";

type Detalhe = RO["acordos"]["detalhe"];

export default function AcordoDetalhe({ id, onClose }: { id: string; onClose: () => void }) {
  const { user } = useAuth();
  const pode = podeModulo(user, "acordos");
  const podeFin = podeModulo(user, "financeiro", "financeiro_editar");
  const q = trpc.acordos.detalhe.useQuery({ id });
  const [recId, setRecId] = useState<string | null>(null);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape" && !recId) onClose(); };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose, recId]);

  const a = q.data;
  const aberto = !!a && STATUS_ABERTOS.includes(a.status);

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative w-full max-w-3xl h-full bg-white shadow-2xl overflow-y-auto">
        <div className="sticky top-0 z-10 bg-white border-b px-4 md:px-6 py-3 flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <p className="text-[11px] uppercase tracking-wide text-gray-400">Negociação de acordo</p>
            <h2 className="text-lg font-semibold text-gray-900 truncate">{a?.deal.titulo ?? (q.isLoading ? "Carregando…" : "—")}</h2>
            {a && (
              <p className="text-xs text-gray-500 truncate">
                {a.deal.contato?.nome ?? "—"} × {a.deal.empresaRe?.nome || "empresa não identificada"}
                {a.deal.numeroCnj && <> · {a.deal.numeroCnj}</>}
              </p>
            )}
          </div>
          {a && (
            <span className={`text-[11px] border rounded-full px-2 py-0.5 whitespace-nowrap ${STATUS_ACORDO[a.status]?.cor ?? ""}`}>
              {STATUS_ACORDO[a.status]?.rotulo ?? a.status}
            </span>
          )}
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-xl leading-none" aria-label="Fechar">×</button>
        </div>

        <div className="px-4 md:px-6 py-4 space-y-6">
          {q.error && <p className="text-sm text-red-600">{q.error.message}</p>}
          {a && (
            <>
              <Resumo a={a} />
              <Dados a={a} editavel={pode && aberto} />
              <Rodadas a={a} editavel={pode && aberto} />
              {pode && aberto && <Saidas a={a} />}
              {pode && (a.status === "firmado" || a.status === "aguardando_homologacao") && <Homologar a={a} />}
              {a.status === "homologado" && <EnvioExecucao a={a} pode={pode} />}
              <Parcelas a={a} podeFin={podeFin} onBaixa={setRecId} />
              <Historico a={a} />
            </>
          )}
        </div>
      </div>
      {recId && <RecebimentoModal id={recId} onClose={() => setRecId(null)} />}
    </div>
  );
}

function Secao({ titulo, children, extra }: { titulo: string; children: React.ReactNode; extra?: React.ReactNode }) {
  return (
    <section>
      <div className="flex items-center justify-between mb-2 gap-2">
        <h3 className="text-xs font-semibold text-gray-500 uppercase">{titulo}</h3>
        {extra}
      </div>
      {children}
    </section>
  );
}

function Resumo({ a }: { a: Detalhe }) {
  const item = (r: string, v: React.ReactNode) => (
    <div><p className="text-[11px] text-gray-400">{r}</p><p className="text-sm text-gray-800">{v}</p></div>
  );
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 bg-gray-50 border border-gray-200 rounded-lg p-3">
      {item("Tipo", rotuloTipoAcordo(a.tipo))}
      {item("Fase de origem", rotuloFase(a.faseOrigem))}
      {item("Valor da causa", fmtBrl(a.deal.valorCausa))}
      {item("Ajuizado em", fmtData(a.deal.ajuizadoEm))}
      {item("Funil / coluna", `${a.deal.pipeline?.nome ?? "—"} / ${a.deal.stage?.nome ?? "—"}`)}
      {item("Audiência", a.deal.audienciaEm ? fmtDataHora(a.deal.audienciaEm) : "—")}
      {item("Valor do acordo", fmtBrl(a.valorAcordo))}
      {item("Responsável", a.responsavelNome ?? "—")}
    </div>
  );
}

// ── Dados da negociação ──────────────────────────────────────────────────────

function Dados({ a, editavel }: { a: Detalhe; editavel: boolean }) {
  const utils = trpc.useUtils();
  const responsaveis = trpc.acordos.responsaveis.useQuery({ dealId: a.dealId }, { enabled: editavel });
  const [f, setF] = useState(() => inicial(a));
  const [erro, setErro] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  useEffect(() => { setF(inicial(a)); }, [a.id, a.atualizadoEm]);

  const mut = trpc.acordos.atualizar.useMutation({
    onSuccess: () => { setErro(null); setOk(true); setTimeout(() => setOk(false), 2000); utils.acordos.invalidate(); },
    onError: (e) => setErro(e.message),
  });

  const emitenteAnexo = f.emitenteId || a.emitentesOpcoes.sugerido || null;

  function salvar() {
    if (f.motivo.trim().length < 3) return setErro("Motivo: mín. 3 caracteres.");
    const est = parseValor(f.estimativa);
    const min = parseValor(f.minimo);
    if (f.estimativa.trim() && est === null) return setErro("Estimativa de condenação inválida.");
    if (f.minimo.trim() && min === null) return setErro("Valor mínimo autorizado inválido.");
    mut.mutate({
      id: a.id,
      motivo: f.motivo.trim(),
      faseOrigem: f.faseOrigem as Fase,
      tipo: f.tipo as "previo" | "posterior",
      responsavelId: f.responsavelId || null,
      contatoEmpresaNome: f.contatoNome || null,
      contatoEmpresaPapel: (f.contatoPapel || null) as "preposto" | "advogado" | null,
      contatoEmpresaFone: f.contatoFone || null,
      estimativaCondenacao: est,
      valorMinimoAutorizado: min,
      autorizacaoRegistro: f.autorizacaoRegistro || null,
      autorizacaoAnexoPath: f.anexoPath,
      autorizacaoAnexoNome: f.anexoNome,
      proximoFollowupEm: f.followup || null,
      emitenteId: f.emitenteId || null,
    });
  }

  const set = <K extends keyof ReturnType<typeof inicial>>(k: K, v: ReturnType<typeof inicial>[K]) => setF((x) => ({ ...x, [k]: v }));
  const dis = !editavel;

  return (
    <Secao titulo="Dados da negociação">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="sm:col-span-2">
          <label className={labelCls}>Motivo</label>
          <textarea value={f.motivo} onChange={(e) => set("motivo", e.target.value)} rows={2} disabled={dis} className={inputCls} />
        </div>
        <div>
          <label className={labelCls}>Fase de origem</label>
          <select value={f.faseOrigem} onChange={(e) => set("faseOrigem", e.target.value)} disabled={dis} className={inputCls}>
            {FASES.map((x) => <option key={x.valor} value={x.valor}>{x.rotulo}</option>)}
          </select>
        </div>
        <div>
          <label className={labelCls}>Tipo</label>
          <select value={f.tipo} onChange={(e) => set("tipo", e.target.value)} disabled={dis} className={inputCls}>
            <option value="previo">Prévio</option>
            <option value="posterior">Posterior</option>
          </select>
        </div>
        <div>
          <label className={labelCls}>Responsável</label>
          <select value={f.responsavelId} onChange={(e) => set("responsavelId", e.target.value)} disabled={dis} className={inputCls}>
            <option value="">—</option>
            {a.responsavelId && !(responsaveis.data ?? []).some((u) => u.id === a.responsavelId) && (
              <option value={a.responsavelId}>{a.responsavelNome ?? "(atual)"}</option>
            )}
            {(responsaveis.data ?? []).map((u) => <option key={u.id} value={u.id}>{u.nome}</option>)}
          </select>
        </div>
        <div>
          <label className={labelCls}>Próximo follow-up</label>
          <input type="date" value={f.followup} onChange={(e) => set("followup", e.target.value)} disabled={dis}
            className={`${inputCls} ${a.followupVencido ? "border-red-400 text-red-700" : ""}`} />
          {a.followupVencido && <p className="text-[11px] text-red-600 mt-0.5">Follow-up vencido</p>}
        </div>
        <div>
          <label className={labelCls}>Contato do lado da empresa</label>
          <input value={f.contatoNome} onChange={(e) => set("contatoNome", e.target.value)} disabled={dis} className={inputCls} placeholder="Nome" />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className={labelCls}>Papel</label>
            <select value={f.contatoPapel} onChange={(e) => set("contatoPapel", e.target.value)} disabled={dis} className={inputCls}>
              <option value="">—</option>
              <option value="preposto">Preposto</option>
              <option value="advogado">Advogado</option>
            </select>
          </div>
          <div>
            <label className={labelCls}>Telefone</label>
            <input value={f.contatoFone} onChange={(e) => set("contatoFone", e.target.value)} disabled={dis} className={inputCls} />
          </div>
        </div>
        <div>
          <label className={labelCls}>Estimativa de condenação (R$)</label>
          <input value={f.estimativa} onChange={(e) => set("estimativa", e.target.value)} disabled={dis} className={inputCls} inputMode="decimal" placeholder="0,00" />
        </div>
        <div>
          <label className={labelCls}>Valor mínimo autorizado pelo cliente (R$)</label>
          <input value={f.minimo} onChange={(e) => set("minimo", e.target.value)} disabled={dis} className={inputCls} inputMode="decimal" placeholder="0,00" />
        </div>
        <div className="sm:col-span-2">
          <label className={labelCls}>Registro da autorização do cliente</label>
          <textarea value={f.autorizacaoRegistro} onChange={(e) => set("autorizacaoRegistro", e.target.value)} rows={2} disabled={dis} className={inputCls}
            placeholder="Ex.: cliente autorizou por WhatsApp em 10/11, mínimo de R$ 8.000" />
        </div>
        <div>
          <label className={labelCls}>Empresa emissora (para anexos e parcelas)</label>
          <select value={f.emitenteId} onChange={(e) => set("emitenteId", e.target.value)} disabled={dis} className={inputCls}>
            <option value="">{a.emitentesOpcoes.sugerido ? "Automática (única)" : "—"}</option>
            {a.emitentesOpcoes.emitentes.map((e) => <option key={e.id} value={e.id}>{e.nomeFantasia || e.nome}</option>)}
          </select>
        </div>
        <div>
          <label className={labelCls}>Anexo da autorização</label>
          <FinAnexo emitenteId={emitenteAnexo} valor={f.anexoPath ? { path: f.anexoPath, nome: f.anexoNome } : null} desabilitado={dis}
            onChange={(v) => setF((x) => ({ ...x, anexoPath: v?.path ?? null, anexoNome: v?.nome ?? null }))} />
          {!dis && !emitenteAnexo && <p className="text-[11px] text-amber-700 mt-0.5">Escolha a empresa emissora para anexar.</p>}
        </div>
      </div>
      {editavel && (
        <div className="flex items-center gap-2 mt-3">
          <button type="button" onClick={salvar} disabled={mut.isLoading} className={btnPri}>{mut.isLoading ? "Salvando…" : "Salvar dados"}</button>
          {ok && <span className="text-xs text-green-700">Salvo ✓</span>}
          {erro && <span className="text-xs text-red-600">{erro}</span>}
        </div>
      )}
    </Secao>
  );
}

function inicial(a: Detalhe) {
  return {
    motivo: a.motivo ?? "",
    faseOrigem: a.faseOrigem ?? "previo",
    tipo: a.tipo ?? "previo",
    responsavelId: a.responsavelId ?? "",
    contatoNome: a.contatoEmpresaNome ?? "",
    contatoPapel: a.contatoEmpresaPapel ?? "",
    contatoFone: a.contatoEmpresaFone ?? "",
    estimativa: valorParaInput(a.estimativaCondenacao),
    minimo: valorParaInput(a.valorMinimoAutorizado),
    autorizacaoRegistro: a.autorizacaoRegistro ?? "",
    anexoPath: a.autorizacaoAnexoPath as string | null,
    anexoNome: a.autorizacaoAnexoNome as string | null,
    followup: a.proximoFollowupEm ?? "",
    emitenteId: a.emitenteId ?? "",
  };
}

// ── Rodadas ──────────────────────────────────────────────────────────────────

function Rodadas({ a, editavel }: { a: Detalhe; editavel: boolean }) {
  const utils = trpc.useUtils();
  const [novo, setNovo] = useState({ data: hojeCal(), autor: "empresa" as "empresa" | "escritorio", valor: "", obs: "" });
  const [editId, setEditId] = useState<string | null>(null);
  const [ed, setEd] = useState({ data: "", autor: "empresa" as "empresa" | "escritorio", valor: "", obs: "" });
  const [erro, setErro] = useState<string | null>(null);
  const onError = (e: { message: string }) => setErro(e.message);
  const ok = () => { setErro(null); utils.acordos.invalidate(); };
  const criar = trpc.acordos.rodadaCriar.useMutation({ onSuccess: () => { ok(); setNovo((n) => ({ ...n, valor: "", obs: "" })); }, onError });
  const atualizar = trpc.acordos.rodadaAtualizar.useMutation({ onSuccess: () => { ok(); setEditId(null); }, onError });
  const excluir = trpc.acordos.rodadaExcluir.useMutation({ onSuccess: ok, onError });

  function add() {
    const v = parseValor(novo.valor);
    if (novo.valor.trim() && v === null) return setErro("Valor inválido.");
    criar.mutate({ acordoId: a.id, data: novo.data, autor: novo.autor, valor: v, obs: novo.obs || null });
  }

  return (
    <Secao titulo={`Rodadas (${a.rodadas.length})`}>
      <div className="overflow-x-auto border border-gray-200 rounded-lg">
        <table className="w-full text-sm min-w-[560px]">
          <thead className="bg-gray-50 text-[11px] text-gray-500 uppercase">
            <tr><th className="text-left px-3 py-2">Data</th><th className="text-left px-3 py-2">Autor</th><th className="text-right px-3 py-2">Valor</th><th className="text-left px-3 py-2">Obs.</th><th className="px-3 py-2" /></tr>
          </thead>
          <tbody className="divide-y">
            {!a.rodadas.length && <tr><td colSpan={5} className="px-3 py-3 text-xs text-gray-400">Nenhuma rodada registrada.</td></tr>}
            {a.rodadas.map((r) => editId === r.id ? (
              <tr key={r.id} className="bg-yellow-50/40">
                <td className="px-2 py-1"><input type="date" value={ed.data} onChange={(e) => setEd({ ...ed, data: e.target.value })} className={inputCls} /></td>
                <td className="px-2 py-1">
                  <select value={ed.autor} onChange={(e) => setEd({ ...ed, autor: e.target.value as any })} className={inputCls}>
                    <option value="empresa">Empresa</option><option value="escritorio">Escritório</option>
                  </select>
                </td>
                <td className="px-2 py-1"><input value={ed.valor} onChange={(e) => setEd({ ...ed, valor: e.target.value })} className={`${inputCls} text-right`} /></td>
                <td className="px-2 py-1"><input value={ed.obs} onChange={(e) => setEd({ ...ed, obs: e.target.value })} className={inputCls} /></td>
                <td className="px-2 py-1 whitespace-nowrap">
                  <button className={btnPri} disabled={atualizar.isLoading} onClick={() => {
                    const v = parseValor(ed.valor);
                    if (ed.valor.trim() && v === null) return setErro("Valor inválido.");
                    atualizar.mutate({ id: r.id, data: ed.data, autor: ed.autor, valor: v, obs: ed.obs || null });
                  }}>OK</button>{" "}
                  <button className={btnSec} onClick={() => setEditId(null)}>×</button>
                </td>
              </tr>
            ) : (
              <tr key={r.id}>
                <td className="px-3 py-2 whitespace-nowrap">{fmtData(r.data)}</td>
                <td className="px-3 py-2">{r.autor === "empresa" ? "Empresa" : "Escritório"}</td>
                <td className="px-3 py-2 text-right whitespace-nowrap">{fmtBrl(r.valor)}</td>
                <td className="px-3 py-2 text-xs text-gray-600">{r.obs}{r.criadoPorNome && <span className="text-gray-400"> · {r.criadoPorNome}</span>}</td>
                <td className="px-3 py-2 whitespace-nowrap text-right">
                  {editavel && (
                    <>
                      <button className="text-xs text-gray-500 hover:text-gray-800" onClick={() => { setEditId(r.id); setEd({ data: r.data ?? hojeCal(), autor: r.autor as any, valor: valorParaInput(r.valor), obs: r.obs ?? "" }); }}>editar</button>{" · "}
                      <button className="text-xs text-red-500 hover:text-red-700" onClick={() => { if (confirm("Excluir esta rodada?")) excluir.mutate({ id: r.id }); }}>excluir</button>
                    </>
                  )}
                </td>
              </tr>
            ))}
            {editavel && (
              <tr className="bg-gray-50/60">
                <td className="px-2 py-1"><input type="date" value={novo.data} onChange={(e) => setNovo({ ...novo, data: e.target.value })} className={inputCls} /></td>
                <td className="px-2 py-1">
                  <select value={novo.autor} onChange={(e) => setNovo({ ...novo, autor: e.target.value as any })} className={inputCls}>
                    <option value="empresa">Empresa (proposta)</option><option value="escritorio">Escritório (contraproposta)</option>
                  </select>
                </td>
                <td className="px-2 py-1"><input value={novo.valor} onChange={(e) => setNovo({ ...novo, valor: e.target.value })} className={`${inputCls} text-right`} placeholder="R$" inputMode="decimal" /></td>
                <td className="px-2 py-1"><input value={novo.obs} onChange={(e) => setNovo({ ...novo, obs: e.target.value })} className={inputCls} placeholder="Observação" /></td>
                <td className="px-2 py-1"><button className={btnPri} onClick={add} disabled={criar.isLoading}>+ Rodada</button></td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {a.valorMinimoAutorizado !== null && a.ultimaRodada?.valor != null && a.ultimaRodada.autor === "empresa" && a.ultimaRodada.valor < a.valorMinimoAutorizado && (
        <p className="text-[11px] text-amber-700 mt-1">Última proposta da empresa está abaixo do mínimo autorizado ({fmtBrl(a.valorMinimoAutorizado)}).</p>
      )}
      {erro && <p className="text-xs text-red-600 mt-1">{erro}</p>}
    </Secao>
  );
}

// ── Saídas ───────────────────────────────────────────────────────────────────

function Saidas({ a }: { a: Detalhe }) {
  const utils = trpc.useUtils();
  const [modo, setModo] = useState<"" | "sem_acordo" | "firmar">("");
  const [erro, setErro] = useState<string | null>(null);
  const onError = (e: { message: string }) => setErro(e.message);
  const ok = () => { setErro(null); setModo(""); utils.acordos.invalidate(); utils.recebimentos.invalidate(); };

  // sem acordo
  const [motivoSaida, setMotivoSaida] = useState<(typeof MOTIVOS_SAIDA)[number]["valor"] | "">("");
  const [obsSaida, setObsSaida] = useState("");
  const encerrar = trpc.acordos.encerrarSemAcordo.useMutation({ onSuccess: ok, onError });

  // firmar
  const ultimo = a.ultimaRodada?.valor ?? null;
  const [fm, setFm] = useState({
    valor: valorParaInput(a.valorAcordo ?? ultimo), parcelas: "1", perc: a.percHonorarios != null ? String(a.percHonorarios) : "30",
    multa: valorParaInput(a.multaInadimplemento), multaTipo: (a.multaTipo ?? "percentual") as "percentual" | "valor",
    firmadoEm: hojeCal(), aguardar: true, temEntrada: false, entradaValor: "", entradaVenc: hojeCal(), primeiroVenc: "",
  });
  const firmar = trpc.acordos.firmar.useMutation({ onSuccess: ok, onError });

  function doFirmar() {
    const v = parseValor(fm.valor);
    if (!v || v <= 0) return setErro("Informe o valor do acordo.");
    const n = Number(fm.parcelas);
    if (!Number.isInteger(n) || n < 0) return setErro("Número de parcelas inválido.");
    const perc = fm.perc.trim() ? parseValor(fm.perc) : null;
    if (fm.perc.trim() && (perc === null || perc < 0 || perc > 100)) return setErro("% de honorários inválido.");
    const multa = fm.multa.trim() ? parseValor(fm.multa) : null;
    if (fm.multa.trim() && multa === null) return setErro("Multa inválida.");
    const entrada = fm.temEntrada ? parseValor(fm.entradaValor) : null;
    if (fm.temEntrada && (entrada === null || entrada <= 0)) return setErro("Valor da entrada inválido.");
    firmar.mutate({
      id: a.id, valorAcordo: v, numParcelas: n, percHonorarios: perc,
      multaInadimplemento: multa, multaTipo: multa === null ? null : fm.multaTipo,
      firmadoEm: fm.firmadoEm || undefined, aguardarHomologacao: fm.aguardar,
      entrada: fm.temEntrada && entrada ? { valor: entrada, vencimento: fm.entradaVenc } : null,
      primeiroVencimento: fm.primeiroVenc || null,
    });
  }

  return (
    <Secao titulo="Saídas">
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => setModo(modo === "firmar" ? "" : "firmar")} className={btnPri}>
          {a.status === "em_negociacao" ? "Firmar acordo" : "Corrigir dados do acordo firmado"}
        </button>
        <button type="button" onClick={() => setModo(modo === "sem_acordo" ? "" : "sem_acordo")} className={btnPerigo}>Retornar ao fluxo normal (sem acordo)</button>
      </div>

      {modo === "sem_acordo" && (
        <div className="mt-3 bg-gray-50 border border-gray-200 rounded-lg p-3 space-y-2">
          <div>
            <label className={labelCls}>Motivo *</label>
            <select value={motivoSaida} onChange={(e) => setMotivoSaida(e.target.value as any)} className={inputCls}>
              <option value="">Selecione…</option>
              {MOTIVOS_SAIDA.map((m) => <option key={m.valor} value={m.valor}>{m.rotulo}</option>)}
            </select>
          </div>
          <div>
            <label className={labelCls}>Observação</label>
            <input value={obsSaida} onChange={(e) => setObsSaida(e.target.value)} className={inputCls} />
          </div>
          <p className="text-[11px] text-gray-500">O histórico fica guardado; uma nova tentativa pode ser aberta depois.</p>
          <button type="button" className={btnPerigo} disabled={encerrar.isLoading}
            onClick={() => motivoSaida ? encerrar.mutate({ id: a.id, motivoSaida, obsSaida: obsSaida || null }) : setErro("Escolha o motivo.")}>
            Confirmar retorno ao fluxo normal
          </button>
        </div>
      )}

      {modo === "firmar" && (
        <div className="mt-3 bg-gray-50 border border-gray-200 rounded-lg p-3 space-y-3">
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            <div><label className={labelCls}>Valor do acordo (R$) *</label><input value={fm.valor} onChange={(e) => setFm({ ...fm, valor: e.target.value })} className={inputCls} inputMode="decimal" /></div>
            <div><label className={labelCls}>Nº de parcelas</label><input type="number" min={0} value={fm.parcelas} onChange={(e) => setFm({ ...fm, parcelas: e.target.value })} className={inputCls} /></div>
            <div><label className={labelCls}>% honorários</label><input value={fm.perc} onChange={(e) => setFm({ ...fm, perc: e.target.value })} className={inputCls} inputMode="decimal" /></div>
            <div><label className={labelCls}>Multa / cláusula penal</label><input value={fm.multa} onChange={(e) => setFm({ ...fm, multa: e.target.value })} className={inputCls} inputMode="decimal" /></div>
            <div>
              <label className={labelCls}>Tipo da multa</label>
              <select value={fm.multaTipo} onChange={(e) => setFm({ ...fm, multaTipo: e.target.value as any })} className={inputCls}>
                <option value="percentual">% sobre o saldo</option><option value="valor">Valor fixo (R$)</option>
              </select>
            </div>
            <div><label className={labelCls}>Firmado em</label><input type="date" value={fm.firmadoEm} onChange={(e) => setFm({ ...fm, firmadoEm: e.target.value })} className={inputCls} /></div>
            <div><label className={labelCls}>1º vencimento (previsto)</label><input type="date" value={fm.primeiroVenc} onChange={(e) => setFm({ ...fm, primeiroVenc: e.target.value })} className={inputCls} /></div>
          </div>
          <label className="flex items-center gap-2 text-xs text-gray-700">
            <input type="checkbox" checked={fm.temEntrada} onChange={(e) => setFm({ ...fm, temEntrada: e.target.checked })} /> Tem entrada
          </label>
          {fm.temEntrada && (
            <div className="grid grid-cols-2 gap-2">
              <div><label className={labelCls}>Valor da entrada</label><input value={fm.entradaValor} onChange={(e) => setFm({ ...fm, entradaValor: e.target.value })} className={inputCls} inputMode="decimal" /></div>
              <div><label className={labelCls}>Vencimento da entrada</label><input type="date" value={fm.entradaVenc} onChange={(e) => setFm({ ...fm, entradaVenc: e.target.value })} className={inputCls} /></div>
            </div>
          )}
          <label className="flex items-center gap-2 text-xs text-gray-700">
            <input type="checkbox" checked={fm.aguardar} onChange={(e) => setFm({ ...fm, aguardar: e.target.checked })} /> Aguardar homologação judicial
          </label>
          <p className="text-[11px] text-gray-500">O plano de parcelas informado aqui pré-preenche a homologação, onde as parcelas são geradas.</p>
          <button type="button" className={btnPri} onClick={doFirmar} disabled={firmar.isLoading}>{firmar.isLoading ? "Gravando…" : "Confirmar acordo firmado"}</button>
        </div>
      )}
      {erro && <p className="text-xs text-red-600 mt-2">{erro}</p>}
    </Secao>
  );
}

// ── Homologação (gerador de parcelas) ────────────────────────────────────────

function useDebounced<T>(v: T, ms = 400): T {
  const [d, setD] = useState(v);
  useEffect(() => { const t = setTimeout(() => setD(v), ms); return () => clearTimeout(t); }, [JSON.stringify(v), ms]);
  return d;
}

function Homologar({ a }: { a: Detalhe }) {
  const utils = trpc.useUtils();
  const plano = (a.planoFirmado ?? {}) as { numParcelas?: number; entrada?: { valor: number; vencimento: string } | null; primeiroVencimento?: string | null };
  const stages = trpc.crm.listStages.useQuery({ pipelineId: a.deal.pipeline?.id ?? "" }, { enabled: !!a.deal.pipeline?.id });
  const [h, setH] = useState(() => ({
    valor: valorParaInput(a.valorAcordo),
    perc: a.percHonorarios != null ? String(a.percHonorarios) : "",
    numParcelas: String(plano.numParcelas ?? 1),
    primeiroVenc: plano.primeiroVencimento ?? "",
    intervalo: "1",
    temEntrada: !!plano.entrada,
    entradaValor: valorParaInput(plano.entrada?.valor ?? null),
    entradaVenc: plano.entrada?.vencimento ?? hojeCal(),
    semRepasse: false,
    emitenteId: a.emitenteId ?? a.emitentesOpcoes.sugerido ?? "",
    homologadoEm: hojeCal(),
    moverPara: "",
  }));
  const [valoresEd, setValoresEd] = useState<Record<number, string>>({});
  const [vencEd, setVencEd] = useState<Record<number, string>>({});
  const [erro, setErro] = useState<string | null>(null);
  const [aberto, setAberto] = useState(false);

  const n = Math.max(0, Math.min(360, Number(h.numParcelas) || 0));
  const valor = parseValor(h.valor);
  const perc = h.perc.trim() ? parseValor(h.perc) : null;
  const entradaV = h.temEntrada ? parseValor(h.entradaValor) : null;
  const valores = useMemo(() => {
    const arr = Array.from({ length: n }, (_, i) => { const s = valoresEd[i + 1]; return s && s.trim() ? parseValor(s) : null; });
    return arr.some((x) => x !== null) ? arr : undefined;
  }, [n, valoresEd]);
  const vencimentos = useMemo(() => {
    const arr = Array.from({ length: n }, (_, i) => vencEd[i + 1] || null);
    return arr.some((x) => x !== null) ? arr : undefined;
  }, [n, vencEd]);

  const paramsAtuais = {
    valorAcordo: valor ?? 0, percHonorarios: perc, numParcelas: n, primeiroVencimento: h.primeiroVenc,
    intervaloMeses: Math.max(1, Math.min(12, Number(h.intervalo) || 1)),
    entrada: h.temEntrada && entradaV ? { valor: entradaV, vencimento: h.entradaVenc } : null,
    valores, vencimentos,
  };
  const params = useDebounced(paramsAtuais);
  const pronto = aberto && !!params.primeiroVencimento && params.valorAcordo > 0;
  const sim = trpc.acordos.simularParcelas.useQuery(params, { enabled: pronto, keepPreviousData: true });

  const homologar = trpc.acordos.homologar.useMutation({
    onSuccess: () => { setErro(null); utils.acordos.invalidate(); utils.recebimentos.invalidate(); utils.crm.invalidate(); },
    onError: (e) => setErro(e.message),
  });

  function confirmar() {
    if (!valor || valor <= 0) return setErro("Valor do acordo inválido.");
    if (!h.primeiroVenc) return setErro("Informe o primeiro vencimento.");
    if (!h.emitenteId) return setErro("Escolha a empresa emissora das parcelas.");
    if (sim.data && !sim.data.ok) return setErro(sim.data.erro);
    homologar.mutate({
      id: a.id, emitenteId: h.emitenteId, homologadoEm: h.homologadoEm || undefined,
      ...paramsAtuais, valorAcordo: valor, percHonorarios: perc,
      semRepasse: h.semRepasse, moverParaStageId: h.moverPara || undefined,
    });
  }

  if (!aberto) {
    return (
      <Secao titulo="Homologação">
        <p className="text-xs text-gray-500 mb-2">
          Acordo firmado em {fmtData(a.firmadoEm)} por {fmtBrl(a.valorAcordo)}
          {a.percHonorarios != null && <> · honorários {a.percHonorarios}%</>}
          {a.multaInadimplemento != null && <> · multa {a.multaTipo === "valor" ? fmtBrl(a.multaInadimplemento) : `${a.multaInadimplemento}%`}</>}.
        </p>
        <button type="button" onClick={() => setAberto(true)} className={btnPri}>Homologar e gerar parcelas</button>
      </Secao>
    );
  }

  return (
    <Secao titulo="Homologação — gerador de parcelas">
      <div className="bg-gray-50 border border-gray-200 rounded-lg p-3 space-y-3">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <div><label className={labelCls}>Valor do acordo</label><input value={h.valor} onChange={(e) => setH({ ...h, valor: e.target.value })} className={inputCls} inputMode="decimal" /></div>
          <div><label className={labelCls}>% honorários</label><input value={h.perc} onChange={(e) => setH({ ...h, perc: e.target.value })} className={inputCls} inputMode="decimal" disabled={h.semRepasse} /></div>
          <div><label className={labelCls}>Nº de parcelas</label><input type="number" min={0} max={360} value={h.numParcelas} onChange={(e) => setH({ ...h, numParcelas: e.target.value })} className={inputCls} /></div>
          <div><label className={labelCls}>Intervalo (meses)</label><input type="number" min={1} max={12} value={h.intervalo} onChange={(e) => setH({ ...h, intervalo: e.target.value })} className={inputCls} /></div>
          <div><label className={labelCls}>1º vencimento *</label><input type="date" value={h.primeiroVenc} onChange={(e) => setH({ ...h, primeiroVenc: e.target.value })} className={inputCls} /></div>
          <div><label className={labelCls}>Homologado em</label><input type="date" value={h.homologadoEm} onChange={(e) => setH({ ...h, homologadoEm: e.target.value })} className={inputCls} /></div>
          <div className="col-span-2">
            <label className={labelCls}>Empresa emissora *</label>
            <select value={h.emitenteId} onChange={(e) => setH({ ...h, emitenteId: e.target.value })} className={inputCls}>
              <option value="">Selecione…</option>
              {a.emitentesOpcoes.emitentes.map((e) => <option key={e.id} value={e.id}>{e.nomeFantasia || e.nome}</option>)}
            </select>
          </div>
        </div>
        <div className="flex flex-wrap gap-4">
          <label className="flex items-center gap-2 text-xs text-gray-700">
            <input type="checkbox" checked={h.temEntrada} onChange={(e) => setH({ ...h, temEntrada: e.target.checked })} /> Entrada
          </label>
          <label className="flex items-center gap-2 text-xs text-gray-700">
            <input type="checkbox" checked={h.semRepasse} onChange={(e) => setH({ ...h, semRepasse: e.target.checked })} /> Sem repasse (tudo do escritório)
          </label>
        </div>
        {h.temEntrada && (
          <div className="grid grid-cols-2 gap-2">
            <div><label className={labelCls}>Valor da entrada</label><input value={h.entradaValor} onChange={(e) => setH({ ...h, entradaValor: e.target.value })} className={inputCls} inputMode="decimal" /></div>
            <div><label className={labelCls}>Vencimento da entrada</label><input type="date" value={h.entradaVenc} onChange={(e) => setH({ ...h, entradaVenc: e.target.value })} className={inputCls} /></div>
          </div>
        )}
        <div>
          <label className={labelCls}>Mover o card do processo para (opcional)</label>
          <select value={h.moverPara} onChange={(e) => setH({ ...h, moverPara: e.target.value })} className={inputCls}>
            <option value="">Não mover (coluna atual: {a.deal.stage?.nome ?? "—"})</option>
            {(stages.data ?? []).filter((s) => s.id !== a.deal.stage?.id).map((s) => <option key={s.id} value={s.id}>{s.nome}</option>)}
          </select>
        </div>

        {/* Pré-visualização */}
        <div>
          <p className="text-xs font-medium text-gray-600 mb-1">Pré-visualização {sim.isFetching && <span className="text-gray-400">(calculando…)</span>}</p>
          {!pronto && <p className="text-xs text-gray-400">Informe valor e 1º vencimento.</p>}
          {pronto && sim.error && <p className="text-xs text-red-600">{sim.error.message}</p>}
          {pronto && sim.data && !sim.data.ok && <p className="text-xs text-red-600">{sim.data.erro}</p>}
          {pronto && sim.data?.ok && (
            <div className="overflow-x-auto border border-gray-200 rounded-lg bg-white">
              <table className="w-full text-sm min-w-[560px]">
                <thead className="bg-gray-50 text-[11px] text-gray-500 uppercase">
                  <tr><th className="text-left px-2 py-1.5">Parcela</th><th className="text-left px-2 py-1.5">Vencimento</th><th className="text-right px-2 py-1.5">Valor</th><th className="text-right px-2 py-1.5">Honorários</th><th className="text-right px-2 py-1.5">Repasse</th></tr>
                </thead>
                <tbody className="divide-y">
                  {sim.data.parcelas.map((p) => (
                    <tr key={p.numero}>
                      <td className="px-2 py-1">{p.numero === 0 ? "Entrada" : `${p.numero}/${n}`}{p.manual && <span className="text-[10px] text-amber-600"> manual</span>}</td>
                      <td className="px-2 py-1">
                        {p.numero === 0 ? fmtData(p.vencimento) : (
                          <input type="date" value={vencEd[p.numero] ?? p.vencimento} onChange={(e) => setVencEd({ ...vencEd, [p.numero]: e.target.value })}
                            className="border border-gray-200 rounded px-1 py-0.5 text-xs" />
                        )}
                      </td>
                      <td className="px-2 py-1 text-right">
                        {p.numero === 0 ? fmtBrl(p.valor) : (
                          <input value={valoresEd[p.numero] ?? ""} placeholder={valorParaInput(p.valor)}
                            onChange={(e) => setValoresEd({ ...valoresEd, [p.numero]: e.target.value })}
                            className="border border-gray-200 rounded px-1 py-0.5 text-xs text-right w-28" inputMode="decimal" />
                        )}
                      </td>
                      <td className="px-2 py-1 text-right text-xs">{fmtBrl(h.semRepasse ? p.valor : p.honorarios)}</td>
                      <td className="px-2 py-1 text-right text-xs">{fmtBrl(h.semRepasse ? 0 : p.repasse)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-gray-50 text-xs font-semibold">
                  <tr>
                    <td className="px-2 py-1.5" colSpan={2}>Total</td>
                    <td className="px-2 py-1.5 text-right">{fmtBrl(sim.data.total)}</td>
                    <td className="px-2 py-1.5 text-right">{fmtBrl(h.semRepasse ? sim.data.total : sim.data.totalHonorarios)}</td>
                    <td className="px-2 py-1.5 text-right">{fmtBrl(h.semRepasse ? 0 : sim.data.totalRepasse)}</td>
                  </tr>
                </tfoot>
              </table>
              <p className="text-[11px] text-gray-500 px-2 py-1">
                Deixe o valor da parcela em branco para cálculo automático; as demais se ajustam para fechar o total.
                {(Object.keys(valoresEd).length > 0 || Object.keys(vencEd).length > 0) && (
                  <button type="button" className="ml-2 underline" onClick={() => { setValoresEd({}); setVencEd({}); }}>limpar ajustes</button>
                )}
              </p>
            </div>
          )}
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={confirmar} disabled={homologar.isLoading || (pronto && sim.data?.ok === false)} className={btnPri}>
            {homologar.isLoading ? "Gerando…" : "Confirmar homologação"}
          </button>
          <button type="button" onClick={() => setAberto(false)} className={btnSec}>Cancelar</button>
        </div>
        {erro && <p className="text-xs text-red-600">{erro}</p>}
      </div>
    </Secao>
  );
}

// ── Envio para execução ──────────────────────────────────────────────────────

function EnvioExecucao({ a, pode }: { a: Detalhe; pode: boolean }) {
  const utils = trpc.useUtils();
  const [data, setData] = useState(a.enviadoExecucaoEm ?? hojeCal());
  const [erro, setErro] = useState<string | null>(null);
  const mut = trpc.acordos.marcarEnviadoExecucao.useMutation({
    onSuccess: () => { setErro(null); utils.acordos.invalidate(); },
    onError: (e) => setErro(e.message),
  });
  return (
    <Secao titulo="Envio para execução">
      <div className="flex flex-wrap items-end gap-2">
        <p className="text-sm text-gray-700 mr-2">
          {a.enviadoExecucaoEm ? <>Enviado para execução em <b>{fmtData(a.enviadoExecucaoEm)}</b></> : "Não enviado para execução."}
        </p>
        {pode && (
          <>
            <input type="date" value={data} onChange={(e) => setData(e.target.value)} className="border border-gray-300 rounded-lg px-2 py-1 text-xs" />
            <button className={btnSec} disabled={mut.isLoading} onClick={() => mut.mutate({ id: a.id, data })}>
              {a.enviadoExecucaoEm ? "Alterar data" : "Marcar como enviado"}
            </button>
            {a.enviadoExecucaoEm && <button className="text-xs text-gray-500 underline" onClick={() => mut.mutate({ id: a.id, data: null })}>desmarcar</button>}
          </>
        )}
      </div>
      {erro && <p className="text-xs text-red-600 mt-1">{erro}</p>}
    </Secao>
  );
}

// ── Parcelas geradas ─────────────────────────────────────────────────────────

function Parcelas({ a, podeFin, onBaixa }: { a: Detalhe; podeFin: boolean; onBaixa: (id: string) => void }) {
  const navigate = useNavigate();
  if (!a.parcelas.length) return null;
  const total = a.parcelas.reduce((s, p) => s + (p.valorPrevisto ?? 0), 0);
  const recebido = a.parcelas.reduce((s, p) => s + (p.status === "recebida" ? p.valorBruto ?? p.valorPrevisto ?? 0 : 0), 0);
  return (
    <Secao titulo={`Parcelas (${a.parcelas.length})`} extra={podeFin && (
      <button className="text-xs text-blue-700 hover:underline" onClick={() => navigate(`/recebimentos?acordoId=${a.id}`)}>ver em Recebimentos →</button>
    )}>
      <p className="text-xs text-gray-500 mb-1">Total {fmtBrl(total)} · recebido {fmtBrl(recebido)}</p>
      <div className="overflow-x-auto border border-gray-200 rounded-lg">
        <table className="w-full text-sm min-w-[640px]">
          <thead className="bg-gray-50 text-[11px] text-gray-500 uppercase">
            <tr>
              <th className="text-left px-2 py-1.5">Parcela</th><th className="text-left px-2 py-1.5">Vencimento</th><th className="text-right px-2 py-1.5">Valor</th>
              <th className="text-left px-2 py-1.5">Status</th><th className="text-left px-2 py-1.5">Repasse</th><th className="text-left px-2 py-1.5">NF</th><th className="px-2 py-1.5" />
            </tr>
          </thead>
          <tbody className="divide-y">
            {a.parcelas.map((p) => (
              <tr key={p.id}>
                <td className="px-2 py-1.5">{p.parcelaNumero === 0 ? "Entrada" : p.parcelaNumero ?? "—"}</td>
                <td className="px-2 py-1.5">{fmtData(p.vencimento)}</td>
                <td className="px-2 py-1.5 text-right">{fmtBrl(p.valorPrevisto)}</td>
                <td className="px-2 py-1.5">
                  <span className={`text-[11px] border rounded-full px-2 py-0.5 ${STATUS_REC[p.status]?.cor ?? ""}`}>{STATUS_REC[p.status]?.rotulo ?? p.status}</span>
                  {p.diasAtraso > 0 && <span className="text-[11px] text-red-600 ml-1">{p.diasAtraso}d</span>}
                  {p.dataRecebimento && <span className="text-[11px] text-gray-500 ml-1">{fmtData(p.dataRecebimento)}</span>}
                </td>
                <td className="px-2 py-1.5 text-xs">{REPASSE[p.repasseStatus] ?? p.repasseStatus}</td>
                <td className="px-2 py-1.5 text-xs">{NF[p.nfStatus] ?? p.nfStatus}</td>
                <td className="px-2 py-1.5 text-right">
                  {podeFin && <button className="text-xs text-blue-700 hover:underline" onClick={() => onBaixa(p.id)}>{p.status === "recebida" ? "abrir" : "dar baixa"}</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Secao>
  );
}

// ── Histórico ────────────────────────────────────────────────────────────────

function Historico({ a }: { a: Detalhe }) {
  const eventos: Array<{ quando: string; texto: string }> = [];
  eventos.push({ quando: fmtDataHora(a.criadoEm), texto: `Tentativa aberta (${rotuloTipoAcordo(a.tipo).toLowerCase()}, ${rotuloFase(a.faseOrigem).toLowerCase()}) — ${a.motivo}` });
  if (a.avaliacao?.decisao) eventos.push({ quando: fmtDataHora(a.avaliacao.decididoEm), texto: `Avaliação prévia: ${a.avaliacao.decisao === "tentar" ? "tentar" : "não tentar"} — ${a.avaliacao.justificativa ?? ""}` });
  for (const r of a.rodadas) eventos.push({ quando: fmtData(r.data), texto: `Rodada — ${r.autor === "empresa" ? "empresa" : "escritório"} ${fmtBrl(r.valor)}${r.obs ? ` (${r.obs})` : ""}` });
  if (a.firmadoEm) eventos.push({ quando: fmtData(a.firmadoEm), texto: `Acordo firmado — ${fmtBrl(a.valorAcordo)}` });
  if (a.homologadoEm) eventos.push({ quando: fmtData(a.homologadoEm), texto: `Homologado — ${a.parcelas.length} parcela(s) gerada(s)` });
  if (a.enviadoExecucaoEm) eventos.push({ quando: fmtData(a.enviadoExecucaoEm), texto: "Enviado para execução" });
  if (a.status === "sem_acordo") eventos.push({ quando: fmtData(a.encerradoEm), texto: `Retorno ao fluxo normal — ${rotuloMotivoSaida(a.motivoSaida)}${a.obsSaida ? ` (${a.obsSaida})` : ""}` });
  return (
    <Secao titulo="Histórico">
      <ul className="space-y-1">
        {eventos.map((e, i) => (
          <li key={i} className="text-xs text-gray-600 flex gap-2"><span className="text-gray-400 whitespace-nowrap w-32 flex-shrink-0">{e.quando}</span><span>{e.texto}</span></li>
        ))}
      </ul>
    </Secao>
  );
}
