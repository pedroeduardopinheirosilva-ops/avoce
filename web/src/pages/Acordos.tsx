/**
 * Funil de acordos (§2 do documento de ajustes) — /acordos e /acordos/:id (detalhe em drawer).
 *
 * Abas: Avaliação prévia (§2.1) · Quadro por status · Follow-ups · Indicadores (§2.4).
 * Leitura = acesso ao processo; ações = módulo `acordos`.
 */
import { Fragment, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { trpc } from "../lib/trpc";
import { useAuth } from "../lib/usePermission";
import { exportarExcel, imprimirPdf } from "../lib/exportar";
import AcordoDetalhe from "../components/acordos/AcordoDetalhe";
import AvaliacaoDecidir from "../components/acordos/AvaliacaoDecidir";
import DealPicker, { type DealEscolhido } from "../components/acordos/DealPicker";
import {
  FASES, STATUS_ACORDO, btnPri, btnSec, fmtBrl, fmtCent, fmtData, fmtDataHora, fmtPct, inputCls, labelCls, podeModulo,
  rotuloFase, rotuloTipoAcordo, type RO,
} from "../components/acordos/util";

type Aba = "avaliacao" | "quadro" | "followups" | "indicadores";
const ABAS: Array<{ k: Aba; rotulo: string }> = [
  { k: "avaliacao", rotulo: "Avaliação prévia" },
  { k: "quadro", rotulo: "Quadro" },
  { k: "followups", rotulo: "Follow-ups" },
  { k: "indicadores", rotulo: "Indicadores" },
];

export default function Acordos() {
  const { id } = useParams<{ id?: string }>();
  const [sp, setSp] = useSearchParams();
  const navigate = useNavigate();
  const aba = (ABAS.some((a) => a.k === sp.get("aba")) ? sp.get("aba") : "quadro") as Aba;
  const setAba = (k: Aba) => { const n = new URLSearchParams(sp); n.set("aba", k); setSp(n, { replace: true }); };
  const abrir = (acordoId: string) => navigate({ pathname: `/acordos/${acordoId}`, search: sp.toString() });
  const fechar = () => navigate({ pathname: "/acordos", search: sp.toString() });

  return (
    <div className="p-4 md:p-8">
      <div className="mb-5 no-print">
        <h1 className="text-2xl font-bold text-gray-900">Acordos</h1>
        <p className="text-sm text-gray-500 mt-1">Funil de negociação paralelo ao processo — não altera colunas, prazos nem audiências do CRM.</p>
      </div>
      <div className="flex gap-1 border-b mb-5 overflow-x-auto no-print">
        {ABAS.map((a) => (
          <button key={a.k} onClick={() => setAba(a.k)}
            className={`px-4 py-2 text-sm border-b-2 -mb-px whitespace-nowrap ${aba === a.k ? "border-brand-900 text-gray-900 font-semibold" : "border-transparent text-gray-500 hover:text-gray-800"}`}>
            {a.rotulo}
          </button>
        ))}
      </div>
      {aba === "avaliacao" && <AbaAvaliacao abrir={abrir} />}
      {aba === "quadro" && <AbaQuadro abrir={abrir} />}
      {aba === "followups" && <AbaFollowups abrir={abrir} />}
      {aba === "indicadores" && <AbaIndicadores />}
      {id && <AcordoDetalhe id={id} onClose={fechar} />}
    </div>
  );
}

function Estado({ isLoading, error, vazio, msgVazio }: { isLoading: boolean; error: { message: string } | null; vazio: boolean; msgVazio: string }) {
  if (isLoading) return <div className="bg-white border border-gray-200 rounded-xl p-10 text-center text-sm text-gray-400 animate-pulse">Carregando…</div>;
  if (error) return <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-700">{error.message}</div>;
  if (vazio) return <div className="bg-white border border-gray-200 rounded-xl p-10 text-center text-sm text-gray-400">{msgVazio}</div>;
  return null;
}

// ── Avaliação prévia ─────────────────────────────────────────────────────────

function AbaAvaliacao({ abrir }: { abrir: (id: string) => void }) {
  const { user } = useAuth();
  const pode = podeModulo(user, "acordos");
  const utils = trpc.useUtils();
  const [escopo, setEscopo] = useState<"minhas" | "todas">("todas");
  const [situacao, setSituacao] = useState<"pendentes" | "decididas" | "todas">("pendentes");
  const q = trpc.acordos.avaliacoes.useQuery({ escopo, situacao });
  const [decidindo, setDecidindo] = useState<string | null>(null);
  const [ajustando, setAjustando] = useState<{ dealId: string; data: string } | null>(null);
  const [nova, setNova] = useState(false);
  const [dealNovo, setDealNovo] = useState<DealEscolhido | null>(null);
  const [ajuizNovo, setAjuizNovo] = useState("");
  const [erro, setErro] = useState<string | null>(null);

  const ajuiz = trpc.acordos.definirAjuizadoEm.useMutation({
    onSuccess: () => { setErro(null); setAjustando(null); utils.acordos.invalidate(); },
    onError: (e) => setErro(e.message),
  });
  const criar = trpc.acordos.criarAvaliacao.useMutation({
    onError: (e) => setErro(e.message),
  });

  async function criarNova() {
    if (!dealNovo) return setErro("Escolha o processo.");
    setErro(null);
    try {
      await criar.mutateAsync({ dealId: dealNovo.id });
      if (ajuizNovo) await ajuiz.mutateAsync({ dealId: dealNovo.id, data: ajuizNovo });
      setNova(false); setDealNovo(null); setAjuizNovo("");
      utils.acordos.invalidate();
    } catch { /* erro já exibido */ }
  }

  const itens = q.data ?? [];
  const atrasadas = itens.filter((x) => x.atrasada).length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3 no-print">
        <div>
          <label className={labelCls}>Tarefas</label>
          <select value={escopo} onChange={(e) => setEscopo(e.target.value as any)} className={inputCls}>
            <option value="todas">Todas</option><option value="minhas">Minhas</option>
          </select>
        </div>
        <div>
          <label className={labelCls}>Situação</label>
          <select value={situacao} onChange={(e) => setSituacao(e.target.value as any)} className={inputCls}>
            <option value="pendentes">Pendentes</option><option value="decididas">Decididas</option><option value="todas">Todas</option>
          </select>
        </div>
        <div className="flex-1" />
        {pode && <button className={btnPri} onClick={() => setNova(!nova)}>+ Avaliação para processo já ajuizado</button>}
      </div>

      {nova && (
        <div className="bg-white border border-gray-200 rounded-xl p-4 space-y-3 max-w-2xl">
          <p className="text-sm font-semibold text-gray-800">Nova tarefa de avaliação prévia</p>
          <DealPicker value={dealNovo} onChange={setDealNovo} />
          <div className="max-w-xs">
            <label className={labelCls}>Data do ajuizamento (opcional — vazio usa hoje se o processo não tiver)</label>
            <input type="date" value={ajuizNovo} onChange={(e) => setAjuizNovo(e.target.value)} className={inputCls} />
          </div>
          <div className="flex gap-2">
            <button className={btnPri} onClick={criarNova} disabled={criar.isLoading || ajuiz.isLoading}>Criar tarefa</button>
            <button className={btnSec} onClick={() => setNova(false)}>Cancelar</button>
          </div>
        </div>
      )}
      {erro && <p className="text-sm text-red-600">{erro}</p>}
      {situacao !== "decididas" && atrasadas > 0 && (
        <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{atrasadas} avaliação(ões) com prazo vencido.</p>
      )}

      <Estado isLoading={q.isLoading} error={q.error} vazio={!itens.length} msgVazio="Nenhuma avaliação prévia nesta seleção." />
      {itens.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-xl overflow-x-auto">
          <table className="w-full text-sm min-w-[860px]">
            <thead className="bg-gray-50 text-[11px] uppercase text-gray-500">
              <tr>
                <th className="text-left px-3 py-2">Processo</th><th className="text-left px-3 py-2">Empresa ré</th><th className="text-left px-3 py-2">Responsável</th>
                <th className="text-left px-3 py-2">Ajuizado</th><th className="text-left px-3 py-2">Audiência</th><th className="text-left px-3 py-2">Prazo</th><th className="text-left px-3 py-2">Decisão</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {itens.map((v) => (
                <Fragment key={v.id}>
                  <tr className={v.atrasada ? "bg-red-50/60" : v.venceHoje ? "bg-amber-50/60" : ""}>
                    <td className="px-3 py-2">
                      <p className="font-medium text-gray-800">{v.deal.titulo}</p>
                      <p className="text-[11px] text-gray-500">{v.deal.contato?.nome ?? "—"}{v.deal.numeroCnj && <> · {v.deal.numeroCnj}</>}</p>
                    </td>
                    <td className="px-3 py-2 text-xs">{v.deal.empresaRe?.nome || "—"}</td>
                    <td className="px-3 py-2 text-xs">{v.responsavelNome ?? "—"}</td>
                    <td className="px-3 py-2 text-xs whitespace-nowrap">
                      {ajustando?.dealId === v.dealId ? (
                        <span className="flex gap-1 items-center">
                          <input type="date" value={ajustando.data} onChange={(e) => setAjustando({ ...ajustando, data: e.target.value })} className="border rounded px-1 py-0.5 text-xs" />
                          <button className="text-xs text-blue-700" disabled={ajuiz.isLoading} onClick={() => ajuiz.mutate({ dealId: v.dealId, data: ajustando.data || null })}>ok</button>
                          <button className="text-xs text-gray-400" onClick={() => setAjustando(null)}>×</button>
                        </span>
                      ) : (
                        <>
                          {fmtData(v.deal.ajuizadoEm)}
                          {pode && !v.decisao && <button className="ml-1 text-[11px] text-gray-400 hover:text-gray-700" title="Ajustar data do ajuizamento" onClick={() => setAjustando({ dealId: v.dealId, data: v.deal.ajuizadoEm ?? "" })}>✎</button>}
                        </>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs whitespace-nowrap">{v.deal.audienciaEm ? fmtDataHora(v.deal.audienciaEm) : "—"}</td>
                    <td className={`px-3 py-2 text-xs whitespace-nowrap ${v.atrasada ? "text-red-700 font-semibold" : v.venceHoje ? "text-amber-700 font-semibold" : ""}`}>
                      {fmtData(v.prazoEm)}{v.atrasada && " · atrasada"}{v.venceHoje && " · hoje"}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {v.decisao ? (
                        <div>
                          <p className={v.decisao === "tentar" ? "text-green-700 font-medium" : "text-gray-700 font-medium"}>{v.decisao === "tentar" ? "Tentar acordo" : "Não tentar"}</p>
                          <p className="text-gray-500">{v.justificativa}</p>
                          <p className="text-gray-400">{v.decididoPorNome ?? ""} {fmtDataHora(v.decididoEm, false)}</p>
                          {v.acordoId && <button className="text-blue-700 hover:underline" onClick={() => abrir(v.acordoId!)}>abrir negociação →</button>}
                        </div>
                      ) : pode ? (
                        <button className={btnSec} onClick={() => setDecidindo(decidindo === v.id ? null : v.id)}>Decidir</button>
                      ) : <span className="text-gray-400">pendente</span>}
                    </td>
                  </tr>
                  {decidindo === v.id && (
                    <tr>
                      <td colSpan={7} className="px-3 py-2 bg-gray-50">
                        <AvaliacaoDecidir avaliacaoId={v.id} dealId={v.dealId} onCancel={() => setDecidindo(null)}
                          onDone={(r) => { setDecidindo(null); if (r.acordoId) abrir(r.acordoId); }} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Quadro ───────────────────────────────────────────────────────────────────

type ItemQuadro = RO["acordos"]["quadro"]["colunas"][number]["itens"][number];

function CartaoAcordo({ a, onOpen }: { a: ItemQuadro; onOpen: () => void }) {
  return (
    <button onClick={onOpen} className={`w-full text-left bg-white border rounded-lg p-3 hover:shadow-sm ${a.followupVencido ? "border-red-300" : "border-gray-200"}`}>
      <p className="text-sm font-medium text-gray-800 line-clamp-2">{a.deal.titulo}</p>
      <p className="text-[11px] text-gray-500 truncate">{a.deal.contato?.nome ?? "—"}</p>
      <p className="text-[11px] text-gray-500 truncate">× {a.deal.empresaRe?.nome || "empresa não identificada"}</p>
      {a.deal.numeroCnj && <p className="text-[10px] text-gray-400 font-mono truncate">{a.deal.numeroCnj}</p>}
      <div className="flex flex-wrap gap-1 mt-1.5">
        <span className={`text-[10px] rounded px-1.5 py-0.5 ${a.tipo === "previo" ? "bg-purple-50 text-purple-700" : "bg-sky-50 text-sky-700"}`}>{rotuloTipoAcordo(a.tipo)}</span>
        {a.valorAcordo !== null && <span className="text-[10px] rounded px-1.5 py-0.5 bg-green-50 text-green-700">{fmtBrl(a.valorAcordo)}</span>}
      </div>
      {a.ultimaRodada && (
        <p className="text-[11px] text-gray-600 mt-1">Última rodada {fmtData(a.ultimaRodada.data)} · {a.ultimaRodada.autor === "empresa" ? "empresa" : "escritório"} {fmtBrl(a.ultimaRodada.valor)}</p>
      )}
      {a.proximoFollowupEm && (
        <p className={`text-[11px] mt-0.5 ${a.followupVencido ? "text-red-600 font-semibold" : "text-gray-500"}`}>
          Follow-up {fmtData(a.proximoFollowupEm)}{a.followupVencido && " · vencido"}
        </p>
      )}
      {a.responsavelNome && <p className="text-[10px] text-gray-400 mt-0.5">{a.responsavelNome}</p>}
    </button>
  );
}

function AbaQuadro({ abrir }: { abrir: (id: string) => void }) {
  const pipelines = trpc.crm.listPipelines.useQuery();
  const empresas = trpc.empresa.listar.useQuery();
  const [pipelineId, setPipelineId] = useState("");
  const [emitenteId, setEmitenteId] = useState("");
  const [tipo, setTipo] = useState<"" | "previo" | "posterior">("");
  const [responsavelId, setResponsavelId] = useState("");
  const [busca, setBusca] = useState("");
  const [dias, setDias] = useState(90);
  const q = trpc.acordos.quadro.useQuery({
    pipelineId: pipelineId || undefined, emitenteId: emitenteId || undefined, tipo: tipo || undefined,
    responsavelId: responsavelId || undefined, busca: busca.trim() || undefined, diasEncerrados: dias,
  }, { keepPreviousData: true });

  const responsaveis = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of q.data?.colunas ?? []) for (const a of c.itens) if (a.responsavelId) m.set(a.responsavelId, a.responsavelNome ?? a.responsavelId);
    return [...m.entries()].sort((x, y) => x[1].localeCompare(y[1]));
  }, [q.data]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3 no-print">
        <div className="min-w-[180px]">
          <label className={labelCls}>Buscar</label>
          <input value={busca} onChange={(e) => setBusca(e.target.value)} className={inputCls} placeholder="título, CNJ ou cliente" />
        </div>
        <div>
          <label className={labelCls}>Funil</label>
          <select value={pipelineId} onChange={(e) => setPipelineId(e.target.value)} className={inputCls}>
            <option value="">Todos</option>
            {((pipelines.data ?? []) as Array<{ id: string; nome: string }>).map((p) => <option key={p.id} value={p.id}>{p.nome}</option>)}
          </select>
        </div>
        <div>
          <label className={labelCls}>Empresa emissora</label>
          <select value={emitenteId} onChange={(e) => setEmitenteId(e.target.value)} className={inputCls}>
            <option value="">Todas</option>
            {(empresas.data ?? []).map((e: any) => <option key={e.id} value={e.id}>{e.nomeFantasia || e.nome}</option>)}
          </select>
        </div>
        <div>
          <label className={labelCls}>Tipo</label>
          <select value={tipo} onChange={(e) => setTipo(e.target.value as any)} className={inputCls}>
            <option value="">Prévio e posterior</option><option value="previo">Prévio</option><option value="posterior">Posterior</option>
          </select>
        </div>
        <div>
          <label className={labelCls}>Responsável</label>
          <select value={responsavelId} onChange={(e) => setResponsavelId(e.target.value)} className={inputCls}>
            <option value="">Todos</option>
            {responsaveis.map(([id, nome]) => <option key={id} value={id}>{nome}</option>)}
          </select>
        </div>
        <div>
          <label className={labelCls}>Encerrados dos últimos</label>
          <select value={dias} onChange={(e) => setDias(Number(e.target.value))} className={inputCls}>
            <option value={30}>30 dias</option><option value={90}>90 dias</option><option value={365}>1 ano</option><option value={3650}>tudo</option>
          </select>
        </div>
      </div>
      <Estado isLoading={q.isLoading} error={q.error} vazio={!!q.data && q.data.total === 0}
        msgVazio="Nenhuma negociação. Abra uma pelo botão “Tentar acordo” no card do processo (CRM) ou decida uma avaliação prévia." />
      {q.data && q.data.total > 0 && (
        <div className="flex gap-3 overflow-x-auto pb-2">
          {q.data.colunas.map((c) => (
            <div key={c.status} className="w-72 flex-shrink-0 bg-gray-50 border border-gray-200 rounded-xl p-2">
              <div className="flex items-center justify-between px-1 mb-2">
                <span className={`text-[11px] border rounded-full px-2 py-0.5 ${STATUS_ACORDO[c.status]?.cor ?? ""}`}>{STATUS_ACORDO[c.status]?.rotulo ?? c.status}</span>
                <span className="text-xs text-gray-500">{c.itens.length}</span>
              </div>
              <div className="space-y-2 max-h-[70vh] overflow-y-auto">
                {c.itens.map((a) => <CartaoAcordo key={a.id} a={a} onOpen={() => abrir(a.id)} />)}
                {!c.itens.length && <p className="text-xs text-gray-400 px-1 py-4 text-center">—</p>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Follow-ups ───────────────────────────────────────────────────────────────

function AbaFollowups({ abrir }: { abrir: (id: string) => void }) {
  const [dias, setDias] = useState(7);
  const [escopo, setEscopo] = useState<"minhas" | "todas">("todas");
  const q = trpc.acordos.followups.useQuery({ dias, escopo });
  const grupos: Array<{ titulo: string; cor: string; itens: ItemQuadro[] }> = q.data ? [
    { titulo: "Vencidos", cor: "text-red-700", itens: q.data.vencidos },
    { titulo: "Hoje", cor: "text-amber-700", itens: q.data.hoje },
    { titulo: `Próximos ${dias} dias`, cor: "text-gray-700", itens: q.data.proximos },
  ] : [];
  const total = grupos.reduce((s, g) => s + g.itens.length, 0);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3 no-print">
        <div>
          <label className={labelCls}>Negociações</label>
          <select value={escopo} onChange={(e) => setEscopo(e.target.value as any)} className={inputCls}>
            <option value="todas">Todas</option><option value="minhas">Minhas</option>
          </select>
        </div>
        <div>
          <label className={labelCls}>Janela</label>
          <select value={dias} onChange={(e) => setDias(Number(e.target.value))} className={inputCls}>
            <option value={3}>3 dias</option><option value={7}>7 dias</option><option value={15}>15 dias</option><option value={30}>30 dias</option>
          </select>
        </div>
      </div>
      <Estado isLoading={q.isLoading} error={q.error} vazio={!!q.data && total === 0} msgVazio="Nenhum follow-up de acordo nesta janela." />
      {q.data && total > 0 && grupos.map((g) => g.itens.length > 0 && (
        <div key={g.titulo}>
          <p className={`text-sm font-semibold mb-2 ${g.cor}`}>{g.titulo} ({g.itens.length})</p>
          <div className="bg-white border border-gray-200 rounded-xl overflow-x-auto">
            <table className="w-full text-sm min-w-[720px]">
              <tbody className="divide-y">
                {g.itens.map((a) => (
                  <tr key={a.id} className="hover:bg-gray-50 cursor-pointer" onClick={() => abrir(a.id)}>
                    <td className={`px-3 py-2 whitespace-nowrap text-xs ${a.followupVencido ? "text-red-700 font-semibold" : ""}`}>{fmtData(a.proximoFollowupEm)}</td>
                    <td className="px-3 py-2"><p className="font-medium text-gray-800">{a.deal.titulo}</p><p className="text-[11px] text-gray-500">{a.deal.contato?.nome ?? "—"}</p></td>
                    <td className="px-3 py-2 text-xs">{a.deal.empresaRe?.nome || "—"}</td>
                    <td className="px-3 py-2 text-xs"><span className={`border rounded-full px-2 py-0.5 ${STATUS_ACORDO[a.status]?.cor ?? ""}`}>{STATUS_ACORDO[a.status]?.rotulo}</span></td>
                    <td className="px-3 py-2 text-xs">{a.contatoEmpresaNome ? `${a.contatoEmpresaNome}${a.contatoEmpresaPapel ? ` (${a.contatoEmpresaPapel})` : ""}${a.contatoEmpresaFone ? ` · ${a.contatoEmpresaFone}` : ""}` : "—"}</td>
                    <td className="px-3 py-2 text-xs">{a.responsavelNome ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Indicadores (§2.4) ───────────────────────────────────────────────────────

type Bloco = RO["acordos"]["indicadores"]["geral"];
type LinhaEmpresa = RO["acordos"]["indicadores"]["porEmpresa"][number];
type ColEmp = "nome" | "total" | "fechados" | "taxa" | "valor" | "causa" | "tempo" | "inad";

function Kpi({ r, v, sub }: { r: string; v: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4">
      <p className="text-[11px] font-medium text-gray-500 uppercase tracking-wide">{r}</p>
      <p className="text-xl font-bold text-gray-900 mt-1">{v}</p>
      {sub && <p className="text-[11px] text-gray-500 mt-0.5">{sub}</p>}
    </div>
  );
}

function AbaIndicadores() {
  const pipelines = trpc.crm.listPipelines.useQuery();
  const empresas = trpc.empresa.listar.useQuery();
  const [de, setDe] = useState("");
  const [ate, setAte] = useState("");
  const [pipelineId, setPipelineId] = useState("");
  const [emitenteId, setEmitenteId] = useState("");
  const [ord, setOrd] = useState<{ col: ColEmp; desc: boolean }>({ col: "total", desc: true });
  const q = trpc.acordos.indicadores.useQuery({ de: de || undefined, ate: ate || undefined, pipelineId: pipelineId || undefined, emitenteId: emitenteId || undefined });
  const d = q.data;

  const chave = (l: LinhaEmpresa, c: ColEmp): number | string => {
    const i = l.indicadores;
    switch (c) {
      case "nome": return l.nome.toLowerCase();
      case "total": return i.total;
      case "fechados": return i.fechados;
      case "taxa": return i.taxaConversao ?? -1;
      case "valor": return i.valorTotalAcordos;
      case "causa": return i.acordoSobreCausa.agregada ?? -1;
      case "tempo": return i.tempoMedioDias ?? -1;
      case "inad": return i.inadimplencia.taxaParcelas ?? -1;
    }
  };
  const linhas = useMemo(() => {
    const l = [...(d?.porEmpresa ?? [])];
    l.sort((a, b) => { const x = chave(a, ord.col), y = chave(b, ord.col); const r = x < y ? -1 : x > y ? 1 : 0; return ord.desc ? -r : r; });
    return l;
  }, [d, ord]);
  const th = (c: ColEmp, t: string, right = true) => (
    <th className={`px-3 py-2 cursor-pointer select-none whitespace-nowrap ${right ? "text-right" : "text-left"}`}
      onClick={() => setOrd((o) => ({ col: c, desc: o.col === c ? !o.desc : c !== "nome" }))}>
      {t}{ord.col === c ? (ord.desc ? " ▼" : " ▲") : ""}
    </th>
  );

  function exportar() {
    if (!d) return;
    const g = d.geral;
    const pct = (x: number | null) => (x === null ? null : Math.round(x * 10000) / 100);
    const resumo = [
      { k: "Negociações no período", v: g.total },
      { k: "Fechadas (firmado/homologado)", v: g.fechados },
      { k: "Sem acordo", v: g.semAcordo },
      { k: "Conversão geral (%)", v: pct(g.taxaConversao) },
      ...Object.entries(g.porTipo).map(([t, x]) => ({ k: `Conversão ${rotuloTipoAcordo(t)} (%)`, v: pct(x.taxaConversao) })),
      { k: "Valor total dos acordos (R$)", v: g.valorTotalAcordos / 100 },
      { k: "Acordo / valor da causa — agregado (%)", v: pct(g.acordoSobreCausa.agregada) },
      { k: "Acordo / estimativa de condenação — agregado (%)", v: pct(g.acordoSobreEstimativa.agregada) },
      { k: "Tempo médio ajuizamento → acordo (dias)", v: g.tempoMedioDias },
      { k: "Inadimplência — parcelas em atraso / vencidas (%)", v: pct(g.inadimplencia.taxaParcelas) },
      { k: "Êxito judicial (sem encerrados por acordo) (%)", v: pct(d.exito.taxaExito) },
      { k: "Processos excluídos do êxito por acordo", v: d.exito.excluidosPorAcordo },
    ];
    void exportarExcel({
      nomeArquivo: `indicadores-acordos-${de || "inicio"}-${ate || "hoje"}`,
      abas: [
        { nome: "Resumo", colunas: [{ chave: "k", titulo: "Indicador", largura: 50 }, { chave: "v", titulo: "Valor", tipo: "numero" }], linhas: resumo },
        { nome: "Por fase", colunas: [{ chave: "fase", titulo: "Fase" }, { chave: "qtd", titulo: "Acordos fechados", tipo: "numero" }],
          linhas: Object.entries(g.porFase).map(([f, n]) => ({ fase: rotuloFase(f), qtd: n })) },
        {
          nome: "Por empresa ré",
          colunas: [
            { chave: "nome", titulo: "Empresa ré", largura: 40 }, { chave: "cnpj", titulo: "CNPJ" }, { chave: "total", titulo: "Negociações", tipo: "numero" },
            { chave: "fechados", titulo: "Fechados", tipo: "numero" }, { chave: "taxa", titulo: "Conversão", tipo: "percentual" },
            { chave: "valor", titulo: "Valor acordos", tipo: "moeda" }, { chave: "causa", titulo: "Acordo/causa", tipo: "percentual" },
            { chave: "est", titulo: "Acordo/estimativa", tipo: "percentual" }, { chave: "tempo", titulo: "Tempo médio (dias)", tipo: "numero" },
            { chave: "inad", titulo: "Inadimplência (parcelas)", tipo: "percentual" },
          ],
          linhas: linhas.map((l) => ({
            nome: l.nome, cnpj: l.cnpj, total: l.indicadores.total, fechados: l.indicadores.fechados, taxa: pct(l.indicadores.taxaConversao),
            valor: l.indicadores.valorTotalAcordos / 100, causa: pct(l.indicadores.acordoSobreCausa.agregada), est: pct(l.indicadores.acordoSobreEstimativa.agregada),
            tempo: l.indicadores.tempoMedioDias, inad: pct(l.indicadores.inadimplencia.taxaParcelas),
          })),
        },
      ],
    });
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end gap-3 no-print">
        <div><label className={labelCls}>De (abertura)</label><input type="date" value={de} onChange={(e) => setDe(e.target.value)} className={inputCls} /></div>
        <div><label className={labelCls}>Até</label><input type="date" value={ate} onChange={(e) => setAte(e.target.value)} className={inputCls} /></div>
        <div>
          <label className={labelCls}>Funil</label>
          <select value={pipelineId} onChange={(e) => setPipelineId(e.target.value)} className={inputCls}>
            <option value="">Todos</option>
            {((pipelines.data ?? []) as Array<{ id: string; nome: string }>).map((p) => <option key={p.id} value={p.id}>{p.nome}</option>)}
          </select>
        </div>
        <div>
          <label className={labelCls}>Empresa emissora</label>
          <select value={emitenteId} onChange={(e) => setEmitenteId(e.target.value)} className={inputCls}>
            <option value="">Todas</option>
            {(empresas.data ?? []).map((e: any) => <option key={e.id} value={e.id}>{e.nomeFantasia || e.nome}</option>)}
          </select>
        </div>
        <div className="flex-1" />
        <button className={btnSec} onClick={exportar} disabled={!d}>Exportar Excel</button>
        <button className={btnSec} onClick={() => imprimirPdf("Indicadores de acordos")} disabled={!d}>PDF</button>
      </div>
      <p className="text-[11px] text-gray-500">Período = data de abertura da negociação; no bloco de êxito, data do ajuizamento.</p>

      <Estado isLoading={q.isLoading} error={q.error} vazio={false} msgVazio="" />
      {d && <BlocoGeral g={d.geral} av={d.avaliacoesPrevias} />}

      {d && (
        <div className="bg-white border border-gray-200 rounded-xl p-4">
          <p className="text-sm font-semibold text-gray-800">Êxito judicial</p>
          <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1 my-2">
            Este bloco <b>exclui os processos encerrados por acordo</b> ({d.exito.excluidosPorAcordo} no período): acordo não conta como êxito nem como
            improcedência, e não entra na relação condenação / valor da causa.
          </p>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3 text-sm">
            <div><p className="text-[11px] text-gray-400">Com resultado</p><p className="font-semibold">{d.exito.comResultado}</p></div>
            <div><p className="text-[11px] text-gray-400">Êxitos</p><p className="font-semibold">{d.exito.exitos}</p></div>
            <div><p className="text-[11px] text-gray-400">Improcedentes</p><p className="font-semibold">{d.exito.improcedentes}</p></div>
            <div><p className="text-[11px] text-gray-400">% de êxito</p><p className="font-semibold">{fmtPct(d.exito.taxaExito)}</p></div>
            <div><p className="text-[11px] text-gray-400">Condenação / causa</p><p className="font-semibold">{fmtPct(d.exito.condenacaoSobreCausa.agregada)}</p>
              <p className="text-[10px] text-gray-400">total {fmtCent(d.exito.valorTotalCondenacoes)}</p></div>
          </div>
        </div>
      )}

      {d && (
        <div className="bg-white border border-gray-200 rounded-xl overflow-x-auto">
          <div className="px-4 py-2 border-b bg-gray-50 text-sm font-semibold text-gray-800">Por empresa ré ({linhas.length})</div>
          {!linhas.length ? <p className="p-4 text-xs text-gray-400">Sem negociações no período.</p> : (
            <table className="w-full text-sm min-w-[900px]">
              <thead className="text-[11px] uppercase text-gray-500">
                <tr>
                  {th("nome", "Empresa ré", false)}{th("total", "Negociações")}{th("fechados", "Fechados")}{th("taxa", "Conversão")}
                  {th("valor", "Valor acordos")}{th("causa", "Acordo/causa")}<th className="px-3 py-2 text-right">Acordo/estim.</th>{th("tempo", "Tempo médio")}{th("inad", "Inadimpl.")}
                </tr>
              </thead>
              <tbody className="divide-y">
                {linhas.map((l) => (
                  <tr key={l.chave}>
                    <td className="px-3 py-2"><p className="text-gray-800">{l.nome || "(sem empresa)"}</p>{l.cnpj && <p className="text-[10px] text-gray-400 font-mono">{l.cnpj}</p>}</td>
                    <td className="px-3 py-2 text-right">{l.indicadores.total}</td>
                    <td className="px-3 py-2 text-right">{l.indicadores.fechados}</td>
                    <td className="px-3 py-2 text-right">{fmtPct(l.indicadores.taxaConversao)}</td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">{fmtCent(l.indicadores.valorTotalAcordos)}</td>
                    <td className="px-3 py-2 text-right">{fmtPct(l.indicadores.acordoSobreCausa.agregada)}</td>
                    <td className="px-3 py-2 text-right">{fmtPct(l.indicadores.acordoSobreEstimativa.agregada)}</td>
                    <td className="px-3 py-2 text-right">{l.indicadores.tempoMedioDias != null ? `${Math.round(l.indicadores.tempoMedioDias)} d` : "—"}</td>
                    <td className="px-3 py-2 text-right">{fmtPct(l.indicadores.inadimplencia.taxaParcelas)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

function BlocoGeral({ g, av }: { g: Bloco; av: RO["acordos"]["indicadores"]["avaliacoesPrevias"] }) {
  const previo = g.porTipo["previo"];
  const posterior = g.porTipo["posterior"];
  const fases = FASES.map((f) => ({ ...f, n: g.porFase[f.valor] ?? 0 }));
  const maxFase = Math.max(1, ...fases.map((f) => f.n));
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi r="Negociações" v={g.total} sub={`${g.fechados} fechadas · ${g.semAcordo} sem acordo`} />
        <Kpi r="Conversão geral" v={fmtPct(g.taxaConversao)} sub="fechadas / (fechadas + sem acordo)" />
        <Kpi r="Conversão prévio" v={fmtPct(previo?.taxaConversao ?? null)} sub={`${previo?.fechados ?? 0} de ${previo?.total ?? 0}`} />
        <Kpi r="Conversão posterior" v={fmtPct(posterior?.taxaConversao ?? null)} sub={`${posterior?.fechados ?? 0} de ${posterior?.total ?? 0}`} />
        <Kpi r="Valor total dos acordos" v={fmtCent(g.valorTotalAcordos)} />
        <Kpi r="Acordo / valor da causa" v={fmtPct(g.acordoSobreCausa.agregada)} sub={`média por processo ${fmtPct(g.acordoSobreCausa.media)} · ${g.acordoSobreCausa.qtd} proc.`} />
        <Kpi r="Acordo / estimativa" v={fmtPct(g.acordoSobreEstimativa.agregada)} sub={`média ${fmtPct(g.acordoSobreEstimativa.media)} · ${g.acordoSobreEstimativa.qtd} proc.`} />
        <Kpi r="Tempo médio até o acordo" v={g.tempoMedioDias != null ? `${Math.round(g.tempoMedioDias)} dias` : "—"} sub="do ajuizamento ao firmado/homologado" />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div className="bg-white border border-gray-200 rounded-xl p-4">
          <p className="text-sm font-semibold text-gray-800 mb-2">Fase em que o acordo ocorreu</p>
          <div className="space-y-1.5">
            {fases.map((f) => (
              <div key={f.valor} className="flex items-center gap-2 text-xs">
                <span className="w-40 truncate text-gray-600" title={f.rotulo}>{f.rotulo}</span>
                <div className="flex-1 bg-gray-100 rounded h-3"><div className="bg-brand-700 h-3 rounded" style={{ width: `${(f.n / maxFase) * 100}%` }} /></div>
                <span className="w-6 text-right text-gray-700">{f.n}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="bg-white border border-gray-200 rounded-xl p-4 text-sm">
          <p className="font-semibold text-gray-800 mb-2">Inadimplência dos acordos</p>
          <p>Parcelas em atraso: <b>{g.inadimplencia.parcelasEmAtraso}</b> de {g.inadimplencia.parcelasVencidas} vencidas ({fmtPct(g.inadimplencia.taxaParcelas)})</p>
          <p>Valor em atraso: <b>{fmtCent(g.inadimplencia.valorEmAtraso)}</b> de {fmtCent(g.inadimplencia.valorVencido)} ({fmtPct(g.inadimplencia.taxaValor)})</p>
          <p>Acordos inadimplentes: <b>{g.inadimplencia.acordosInadimplentes}</b> de {g.inadimplencia.acordosComParcelas} ({fmtPct(g.inadimplencia.taxaAcordos)})</p>
        </div>
        <div className="bg-white border border-gray-200 rounded-xl p-4 text-sm">
          <p className="font-semibold text-gray-800 mb-2">Avaliações prévias</p>
          <p>Total: <b>{av.total}</b> · pendentes {av.pendentes}{av.atrasadas > 0 && <span className="text-red-600"> ({av.atrasadas} atrasadas)</span>}</p>
          <p>Decidiu tentar: <b>{av.tentar}</b> · não tentar: {av.naoTentar}</p>
        </div>
      </div>
    </div>
  );
}
