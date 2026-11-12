/**
 * Recebimentos (§1.6–1.9) — /recebimentos (rota usada no link da mensagem diária de alertas do server).
 *
 * Parcelas de acordo e recebimentos de execução/sentença: baixa, repasse ao cliente, NF, alertas,
 * valores de terceiros e relatório de receita por tipo. Leitura = `financeiro` ou `financeiro_editar`;
 * edição = `financeiro_editar`. Totais e relatório chegam do server em CENTAVOS.
 */
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { trpc } from "../lib/trpc";
import { useAuth } from "../lib/usePermission";
import { exportarExcel, imprimirPdf } from "../lib/exportar";
import RecebimentoModal from "../components/recebimentos/RecebimentoModal";
import DealPicker, { type DealEscolhido } from "../components/acordos/DealPicker";
import {
  NF, REPASSE, STATUS_REC, btnPri, btnSec, fmtBrl, fmtCent, fmtData, inputCls, labelCls, parseValor, podeModulo, type RO, type RI,
} from "../components/acordos/util";

type Filtros = Exclude<RI["recebimentos"]["listar"], void | undefined>;
type Totais = RO["recebimentos"]["listar"]["totais"];
type Item = RO["recebimentos"]["listar"]["itens"][number];

export default function Recebimentos() {
  const [sp, setSp] = useSearchParams();
  const aba = sp.get("aba") === "relatorio" ? "relatorio" : "lista";
  const setAba = (k: string) => { const n = new URLSearchParams(sp); n.set("aba", k); setSp(n, { replace: true }); };
  const [recId, setRecId] = useState<string | null>(sp.get("id"));
  const empresas = trpc.empresa.listar.useQuery();
  const [emitenteId, setEmitenteId] = useState("");

  return (
    <div className="p-4 md:p-8 space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Recebimentos</h1>
          <p className="text-sm text-gray-500 mt-1">Parcelas de acordo e recebimentos de execução/sentença — baixa, repasse ao cliente e NF.</p>
        </div>
        <div className="no-print">
          <label className={labelCls}>Empresa emissora</label>
          <select value={emitenteId} onChange={(e) => setEmitenteId(e.target.value)} className={inputCls}>
            <option value="">Todas</option>
            {(empresas.data ?? []).map((e: any) => <option key={e.id} value={e.id}>{e.nomeFantasia || e.nome}</option>)}
          </select>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2"><Alertas emitenteId={emitenteId} onAbrirRec={setRecId} /></div>
        <ValoresTerceiros emitenteId={emitenteId} onAbrirRec={setRecId} />
      </div>

      <div className="flex gap-1 border-b no-print">
        {[["lista", "Lançamentos"], ["relatorio", "Relatório de receita por tipo"]].map(([k, t]) => (
          <button key={k} onClick={() => setAba(k)}
            className={`px-4 py-2 text-sm border-b-2 -mb-px whitespace-nowrap ${aba === k ? "border-brand-900 text-gray-900 font-semibold" : "border-transparent text-gray-500 hover:text-gray-800"}`}>{t}</button>
        ))}
      </div>
      {aba === "lista" ? <Lista emitenteId={emitenteId} onAbrirRec={setRecId} /> : <Relatorio emitenteId={emitenteId} />}
      {recId && <RecebimentoModal id={recId} onClose={() => { setRecId(null); if (sp.get("id")) { const n = new URLSearchParams(sp); n.delete("id"); setSp(n, { replace: true }); } }} />}
    </div>
  );
}

// ── Alertas ──────────────────────────────────────────────────────────────────

function Alertas({ emitenteId, onAbrirRec }: { emitenteId: string; onAbrirRec: (id: string) => void }) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const podeEditar = podeModulo(user, "financeiro_editar");
  const utils = trpc.useUtils();
  const cfg = trpc.recebimentos.configAlertas.useQuery();
  const q = trpc.recebimentos.alertas.useQuery({ emitenteId: emitenteId || undefined, limite: 50 });
  const [aberto, setAberto] = useState<string | null>(null);
  const [editDias, setEditDias] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const salvar = trpc.recebimentos.salvarConfigAlertas.useMutation({
    onSuccess: () => { setErro(null); setEditDias(null); utils.recebimentos.configAlertas.invalidate(); utils.recebimentos.alertas.invalidate(); },
    onError: (e) => setErro(e.message),
  });
  const a = q.data;
  const grupos = a ? [
    { k: "parcelasVencidas", t: "Parcelas vencidas", n: a.contagens.parcelasVencidas, itens: a.parcelasVencidas, tipo: "rec" as const, cor: "red" },
    { k: "repassesPendentes", t: `Repasses pendentes há +${a.diasRepasse} dias`, n: a.contagens.repassesPendentes, itens: a.repassesPendentes, tipo: "rec" as const, cor: "amber" },
    { k: "semNf", t: "Recebidos sem NF", n: a.contagens.semNf, itens: a.semNf, tipo: "rec" as const, cor: "amber" },
    { k: "followupsVencidos", t: "Follow-ups de acordo vencidos", n: a.contagens.followupsVencidos, itens: a.followupsVencidos, tipo: "acordo" as const, cor: "red" },
    { k: "avaliacoesAtrasadas", t: "Avaliações prévias atrasadas", n: a.contagens.avaliacoesAtrasadas, itens: a.avaliacoesAtrasadas, tipo: "avaliacao" as const, cor: "red" },
  ] : [];

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4 h-full">
      <div className="flex items-center justify-between gap-2 mb-3">
        <p className="text-sm font-semibold text-gray-800">Alertas {a && a.contagens.total > 0 && <span className="ml-1 text-xs bg-red-600 text-white rounded-full px-2 py-0.5">{a.contagens.total}</span>}</p>
        <div className="text-xs text-gray-500 flex items-center gap-1 no-print">
          {editDias !== null ? (
            <>
              repasse pendente há mais de
              <input type="number" min={0} max={365} value={editDias} onChange={(e) => setEditDias(e.target.value)} className="w-14 border rounded px-1 py-0.5" /> dias
              <button className="text-blue-700" disabled={salvar.isLoading} onClick={() => salvar.mutate({ diasRepasse: Math.max(0, Math.min(365, Number(editDias) || 0)) })}>salvar</button>
              <button className="text-gray-400" onClick={() => setEditDias(null)}>×</button>
            </>
          ) : (
            <>
              X = {cfg.data?.diasRepasse ?? "…"} dias
              {podeEditar && <button className="text-gray-400 hover:text-gray-700" title="Configurar X" onClick={() => setEditDias(String(cfg.data?.diasRepasse ?? 5))}>✎</button>}
            </>
          )}
        </div>
      </div>
      {erro && <p className="text-xs text-red-600 mb-2">{erro}</p>}
      {q.isLoading && <p className="text-xs text-gray-400">Carregando…</p>}
      {q.error && <p className="text-xs text-red-600">{q.error.message}</p>}
      {a && a.contagens.total === 0 && <p className="text-xs text-green-700">Nenhum alerta. ✓</p>}
      <div className="space-y-1.5">
        {grupos.filter((g) => g.n > 0).map((g) => (
          <div key={g.k}>
            <button onClick={() => setAberto(aberto === g.k ? null : g.k)}
              className={`w-full flex items-center justify-between text-left text-xs rounded-lg px-3 py-2 border ${g.cor === "red" ? "bg-red-50 border-red-200 text-red-800" : "bg-amber-50 border-amber-200 text-amber-800"}`}>
              <span className="font-medium">{g.t}</span><span className="font-bold">{g.n} {aberto === g.k ? "▲" : "▼"}</span>
            </button>
            {aberto === g.k && (
              <ul className="border border-t-0 border-gray-200 rounded-b-lg divide-y max-h-60 overflow-y-auto">
                {g.itens.map((i) => (
                  <li key={i.id}>
                    <button className="w-full text-left px-3 py-1.5 text-xs hover:bg-gray-50 flex flex-wrap gap-x-2"
                      onClick={() => {
                        if (g.tipo === "rec") onAbrirRec(i.id);
                        else if (g.tipo === "acordo" && i.acordoId) navigate(`/acordos/${i.acordoId}`);
                        else navigate("/acordos?aba=avaliacao");
                      }}>
                      <span className="text-gray-800">{i.cliente ?? i.titulo}</span>
                      {i.parcelaNumero != null && <span className="text-gray-500">parcela {i.parcelaNumero === 0 ? "entrada" : i.parcelaNumero}</span>}
                      <span className="text-gray-500">{fmtData(i.data)}</span>
                      {i.dias > 0 && <span className="text-red-600">{i.dias}d</span>}
                      {i.valor !== null && <span className="ml-auto">{fmtBrl(i.valor)}</span>}
                    </button>
                  </li>
                ))}
                {g.n > g.itens.length && <li className="px-3 py-1.5 text-[11px] text-gray-400">… e mais {g.n - g.itens.length}</li>}
              </ul>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Valores de terceiros ─────────────────────────────────────────────────────

function ValoresTerceiros({ emitenteId, onAbrirRec }: { emitenteId: string; onAbrirRec: (id: string) => void }) {
  const q = trpc.recebimentos.valoresTerceiros.useQuery({ emitenteId: emitenteId || undefined });
  const [ver, setVer] = useState(false);
  return (
    <div className="bg-white border-2 border-dashed border-amber-300 rounded-xl p-4">
      <p className="text-[11px] font-medium text-amber-800 uppercase tracking-wide">Valores de terceiros</p>
      <p className="text-2xl font-bold text-amber-900 mt-1">{q.data ? fmtBrl(q.data.total) : q.isLoading ? "…" : "—"}</p>
      <p className="text-xs text-gray-600 mt-1">
        Dinheiro de clientes em trânsito: já recebido, ainda não repassado ({q.data?.qtd ?? 0} recebimento(s)).
        <b> Não é receita nem caixa do escritório</b> — é passivo e sai do caixa disponível.
      </p>
      {q.error && <p className="text-xs text-red-600 mt-1">{q.error.message}</p>}
      {!!q.data?.itens.length && (
        <>
          <button className="text-xs text-blue-700 mt-2 no-print" onClick={() => setVer(!ver)}>{ver ? "ocultar" : "ver lista"}</button>
          {ver && (
            <ul className="mt-2 divide-y max-h-56 overflow-y-auto text-xs">
              {q.data.itens.map((r) => (
                <li key={r.id}>
                  <button className="w-full text-left py-1 hover:bg-gray-50 flex gap-2" onClick={() => onAbrirRec(r.id)}>
                    <span className="truncate flex-1">{r.deal?.contato?.nome ?? r.deal?.titulo ?? r.descricao}</span>
                    <span className="text-gray-500">{fmtData(r.dataRecebimento)}</span>
                    <span className="font-medium">{fmtBrl(r.valorRepasse)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

// ── Lista ────────────────────────────────────────────────────────────────────

function BlocoTotais({ t, titulo }: { t: Totais; titulo: string }) {
  return (
    <div className="bg-white border border-gray-200 rounded-xl p-3">
      <p className="text-xs font-semibold text-gray-700 mb-2">{titulo} <span className="text-gray-400 font-normal">({t.qtd})</span></p>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
        <span className="text-gray-500">A receber</span><span className="text-right">{fmtCent(t.previstoAReceber)}</span>
        <span className="text-red-600">Em atraso ({t.qtdEmAtraso})</span><span className="text-right text-red-700">{fmtCent(t.emAtraso)}</span>
        <span className="text-gray-500">Recebido bruto ({t.qtdRecebidas})</span><span className="text-right">{fmtCent(t.recebidoBruto)}</span>
        <span className="text-gray-500">Receita do escritório</span><span className="text-right font-semibold text-green-700">{fmtCent(t.receitaEscritorio)}</span>
        <span className="text-gray-500">Repasse pendente</span><span className="text-right text-amber-700">{fmtCent(t.repassePendente)}</span>
        <span className="text-gray-500">Repasse realizado</span><span className="text-right">{fmtCent(t.repasseRealizado)}</span>
        <span className="text-gray-500">Sem NF</span><span className="text-right">{t.qtdSemNf}</span>
      </div>
    </div>
  );
}

function Lista({ emitenteId, onAbrirRec }: { emitenteId: string; onAbrirRec: (id: string) => void }) {
  const [sp] = useSearchParams();
  const { user } = useAuth();
  const podeEditar = podeModulo(user, "financeiro_editar");
  const [f, setF] = useState<Omit<Filtros, "emitenteId" | "limite">>(() => ({
    campoData: "vencimento",
    acordoId: sp.get("acordoId") ?? undefined,
    dealId: sp.get("dealId") ?? undefined,
  }));
  const [busca, setBusca] = useState("");
  useEffect(() => { const t = setTimeout(() => setF((x) => ({ ...x, busca: busca.trim() || undefined })), 350); return () => clearTimeout(t); }, [busca]);
  const q = trpc.recebimentos.listar.useQuery({ ...f, emitenteId: emitenteId || undefined, limite: 1000 }, { keepPreviousData: true });
  const [novo, setNovo] = useState(false);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));

  function exportar() {
    if (!q.data) return;
    void exportarExcel({
      nomeArquivo: `recebimentos-${f.de ?? "inicio"}-${f.ate ?? "hoje"}`,
      abas: [{
        nome: "Recebimentos",
        colunas: [
          { chave: "tipo", titulo: "Tipo" }, { chave: "processo", titulo: "Processo", largura: 40 }, { chave: "cnj", titulo: "CNJ" },
          { chave: "cliente", titulo: "Cliente" }, { chave: "empresaRe", titulo: "Empresa ré" }, { chave: "parcela", titulo: "Parcela" },
          { chave: "vencimento", titulo: "Vencimento", tipo: "data" }, { chave: "previsto", titulo: "Previsto", tipo: "moeda" },
          { chave: "status", titulo: "Status" }, { chave: "recebidoEm", titulo: "Recebido em", tipo: "data" }, { chave: "bruto", titulo: "Bruto", tipo: "moeda" },
          { chave: "honorarios", titulo: "Honorários", tipo: "moeda" }, { chave: "sucumbencia", titulo: "Sucumbência", tipo: "moeda" },
          { chave: "repasse", titulo: "A repassar", tipo: "moeda" }, { chave: "repasseStatus", titulo: "Repasse" }, { chave: "repasseData", titulo: "Repassado em", tipo: "data" },
          { chave: "nfStatus", titulo: "NF" }, { chave: "nfNumero", titulo: "Nº NF" }, { chave: "nfValor", titulo: "Valor NF", tipo: "moeda" },
          { chave: "emitente", titulo: "Empresa emissora" },
        ],
        linhas: q.data.itens.map((r) => ({
          tipo: r.tipo === "acordo" ? "Acordo" : "Execução/sentença", processo: r.deal?.titulo ?? r.descricao, cnj: r.deal?.numeroCnj,
          cliente: r.deal?.contato?.nome, empresaRe: r.deal?.empresaRe?.nome, parcela: r.parcelaNumero === 0 ? "Entrada" : r.parcelaNumero,
          vencimento: r.vencimento, previsto: r.valorPrevisto, status: STATUS_REC[r.status]?.rotulo ?? r.status, recebidoEm: r.dataRecebimento,
          bruto: r.valorBruto, honorarios: r.valorHonorarios, sucumbencia: r.valorSucumbencia, repasse: r.valorRepasse,
          repasseStatus: REPASSE[r.repasseStatus] ?? r.repasseStatus, repasseData: r.repasseData, nfStatus: NF[r.nfStatus] ?? r.nfStatus,
          nfNumero: r.nfNumero, nfValor: r.nfValor, emitente: r.emitente?.nomeFantasia || r.emitente?.nome,
        })),
      }],
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3 no-print">
        <div className="min-w-[180px]"><label className={labelCls}>Processo</label><input value={busca} onChange={(e) => setBusca(e.target.value)} className={inputCls} placeholder="título, CNJ, cliente, nº NF" /></div>
        <div>
          <label className={labelCls}>Tipo</label>
          <select value={f.tipo ?? ""} onChange={(e) => set("tipo", (e.target.value || undefined) as Filtros["tipo"])} className={inputCls}>
            <option value="">Todos</option><option value="acordo">Acordo</option><option value="execucao">Execução/sentença</option>
          </select>
        </div>
        <div>
          <label className={labelCls}>Status</label>
          <select value={f.status ?? ""} onChange={(e) => set("status", (e.target.value || undefined) as Filtros["status"])} className={inputCls}>
            <option value="">Todos</option><option value="prevista">Prevista</option><option value="recebida">Recebida</option><option value="em_atraso">Em atraso</option>
          </select>
        </div>
        <div>
          <label className={labelCls}>Repasse</label>
          <select value={f.repasseStatus ?? ""} onChange={(e) => set("repasseStatus", (e.target.value || undefined) as Filtros["repasseStatus"])} className={inputCls}>
            <option value="">Todos</option><option value="pendente">Pendente</option><option value="realizado">Realizado</option><option value="nao_aplicavel">Não se aplica</option>
          </select>
        </div>
        <div>
          <label className={labelCls}>NF</label>
          <select value={f.nfStatus ?? ""} onChange={(e) => set("nfStatus", (e.target.value || undefined) as Filtros["nfStatus"])} className={inputCls}>
            <option value="">Todas</option><option value="a_emitir">A emitir</option><option value="emitida">Emitida</option><option value="nao_aplicavel">Não se aplica</option>
          </select>
        </div>
        <div>
          <label className={labelCls}>Período por</label>
          <select value={f.campoData ?? "vencimento"} onChange={(e) => set("campoData", e.target.value as Filtros["campoData"])} className={inputCls}>
            <option value="vencimento">Vencimento</option><option value="recebimento">Recebimento</option><option value="repasse">Repasse</option><option value="nf">Data da NF</option>
          </select>
        </div>
        <div><label className={labelCls}>De</label><input type="date" value={f.de ?? ""} onChange={(e) => set("de", e.target.value || undefined)} className={inputCls} /></div>
        <div><label className={labelCls}>Até</label><input type="date" value={f.ate ?? ""} onChange={(e) => set("ate", e.target.value || undefined)} className={inputCls} /></div>
        <div className="flex-1" />
        <button className={btnSec} onClick={exportar} disabled={!q.data?.itens.length}>Exportar Excel</button>
        <button className={btnSec} onClick={() => imprimirPdf("Recebimentos")}>PDF</button>
        {podeEditar && <button className={btnPri} onClick={() => setNovo(true)}>+ Recebimento avulso</button>}
      </div>
      {(f.acordoId || f.dealId) && (
        <p className="text-xs text-blue-800 bg-blue-50 border border-blue-200 rounded-lg px-3 py-1.5 inline-flex gap-2 items-center">
          Filtrado por {f.acordoId ? "acordo" : "processo"}
          <button className="underline" onClick={() => setF((x) => ({ ...x, acordoId: undefined, dealId: undefined }))}>limpar</button>
        </p>
      )}

      {q.data && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <BlocoTotais t={q.data.totais} titulo="Total do filtro" />
          <BlocoTotais t={q.data.totaisPorTipo.acordo} titulo="Acordos" />
          <BlocoTotais t={q.data.totaisPorTipo.execucao} titulo="Execução / sentença" />
        </div>
      )}

      {q.isLoading && <div className="bg-white border border-gray-200 rounded-xl p-10 text-center text-sm text-gray-400 animate-pulse">Carregando…</div>}
      {q.error && <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-700">{q.error.message}</div>}
      {q.data && !q.data.itens.length && <div className="bg-white border border-gray-200 rounded-xl p-10 text-center text-sm text-gray-400">Nenhum recebimento neste filtro.</div>}
      {q.data && q.data.itens.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-xl overflow-x-auto">
          <table className="w-full text-sm min-w-[1100px]">
            <thead className="bg-gray-50 text-[11px] uppercase text-gray-500">
              <tr>
                <th className="text-left px-3 py-2">Processo</th><th className="text-left px-3 py-2">Tipo</th><th className="text-left px-3 py-2">Vencimento</th>
                <th className="text-right px-3 py-2">Previsto</th><th className="text-left px-3 py-2">Status</th><th className="text-right px-3 py-2">Recebido</th>
                <th className="text-right px-3 py-2">Honorários</th><th className="text-right px-3 py-2">A repassar</th><th className="text-left px-3 py-2">Repasse</th><th className="text-left px-3 py-2">NF</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {q.data.itens.map((r) => <Linha key={r.id} r={r} onOpen={() => onAbrirRec(r.id)} />)}
            </tbody>
          </table>
          {q.data.total > q.data.itens.length && <p className="text-xs text-gray-500 px-3 py-2">Mostrando {q.data.itens.length} de {q.data.total} — refine os filtros. Os totais consideram todos.</p>}
        </div>
      )}
      {novo && <NovoRecebimento onClose={() => setNovo(false)} onCriado={(id) => { setNovo(false); onAbrirRec(id); }} />}
    </div>
  );
}

function Linha({ r, onOpen }: { r: Item; onOpen: () => void }) {
  return (
    <tr className={`hover:bg-gray-50 cursor-pointer ${r.status === "em_atraso" ? "bg-red-50/40" : ""}`} onClick={onOpen}>
      <td className="px-3 py-2">
        <p className="text-gray-800 truncate max-w-[280px]">{r.deal?.titulo ?? r.descricao ?? "—"}</p>
        <p className="text-[11px] text-gray-500 truncate max-w-[280px]">{r.deal?.contato?.nome ?? ""}{r.deal?.empresaRe?.nome && ` × ${r.deal.empresaRe.nome}`}</p>
      </td>
      <td className="px-3 py-2 text-xs whitespace-nowrap">
        {r.tipo === "acordo" ? `Acordo${r.parcelaNumero != null ? ` · ${r.parcelaNumero === 0 ? "entrada" : `p. ${r.parcelaNumero}`}` : ""}` : "Execução"}
      </td>
      <td className="px-3 py-2 text-xs whitespace-nowrap">{fmtData(r.vencimento)}</td>
      <td className="px-3 py-2 text-right whitespace-nowrap">{fmtBrl(r.valorPrevisto)}</td>
      <td className="px-3 py-2 text-xs whitespace-nowrap">
        <span className={`border rounded-full px-2 py-0.5 ${STATUS_REC[r.status]?.cor ?? ""}`}>{STATUS_REC[r.status]?.rotulo ?? r.status}</span>
        {r.diasAtraso > 0 && <span className="text-red-600 ml-1">{r.diasAtraso}d</span>}
      </td>
      <td className="px-3 py-2 text-right whitespace-nowrap">{r.dataRecebimento ? <>{fmtBrl(r.valorBruto)}<p className="text-[10px] text-gray-400">{fmtData(r.dataRecebimento)}</p></> : "—"}</td>
      <td className="px-3 py-2 text-right whitespace-nowrap">{fmtBrl(r.valorHonorarios)}</td>
      <td className="px-3 py-2 text-right whitespace-nowrap">{r.repasseStatus === "nao_aplicavel" ? "—" : fmtBrl(r.valorRepasse)}</td>
      <td className={`px-3 py-2 text-xs whitespace-nowrap ${r.repasseStatus === "pendente" && r.dataRecebimento ? "text-amber-700 font-medium" : ""}`}>{REPASSE[r.repasseStatus] ?? r.repasseStatus}{r.repasseData && <p className="text-[10px] text-gray-400">{fmtData(r.repasseData)}</p>}</td>
      <td className={`px-3 py-2 text-xs whitespace-nowrap ${r.nfStatus === "a_emitir" && r.dataRecebimento ? "text-amber-700 font-medium" : ""}`}>{NF[r.nfStatus] ?? r.nfStatus}{r.nfNumero && <p className="text-[10px] text-gray-400">nº {r.nfNumero}</p>}</td>
    </tr>
  );
}

// ── Novo recebimento avulso ──────────────────────────────────────────────────

function NovoRecebimento({ onClose, onCriado }: { onClose: () => void; onCriado: (id: string) => void }) {
  const utils = trpc.useUtils();
  const [deal, setDeal] = useState<DealEscolhido | null>(null);
  const [todosFunis, setTodosFunis] = useState(false);
  const emit = trpc.acordos.emitentesDoDeal.useQuery({ dealId: deal?.id ?? "" }, { enabled: !!deal });
  const [f, setF] = useState({ emitenteId: "", tipo: "execucao" as "execucao" | "acordo", descricao: "", vencimento: "", previsto: "", perc: "30", semRepasse: false, obs: "" });
  const [erro, setErro] = useState<string | null>(null);
  useEffect(() => { if (emit.data?.sugerido) setF((x) => ({ ...x, emitenteId: x.emitenteId || emit.data!.sugerido! })); }, [emit.data?.sugerido]);
  const criar = trpc.recebimentos.criar.useMutation({
    onSuccess: (r) => { utils.recebimentos.invalidate(); onCriado(r.id); },
    onError: (e) => setErro(e.message),
  });
  function salvar() {
    if (!deal) return setErro("Escolha o processo.");
    const prev = f.previsto.trim() ? parseValor(f.previsto) : null;
    if (f.previsto.trim() && prev === null) return setErro("Valor previsto inválido.");
    const perc = f.perc.trim() ? parseValor(f.perc) : null;
    if (f.perc.trim() && (perc === null || perc < 0 || perc > 100)) return setErro("% inválido.");
    criar.mutate({
      dealId: deal.id, emitenteId: f.emitenteId || undefined, tipo: f.tipo, descricao: f.descricao || null,
      vencimento: f.vencimento || null, valorPrevisto: prev, percHonorarios: f.semRepasse ? null : perc, semRepasse: f.semRepasse, obs: f.obs || null,
    });
  }
  const emitentes = useMemo(() => emit.data?.emitentes ?? [], [emit.data]);
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-2 sm:p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-xl max-h-[95vh] overflow-y-auto p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-gray-900">Novo recebimento avulso</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-xl leading-none">×</button>
        </div>
        <label className="flex items-center gap-2 text-xs text-gray-600">
          <input type="checkbox" checked={todosFunis} onChange={(e) => { setTodosFunis(e.target.checked); setDeal(null); }} /> Mostrar também funis não processuais
        </label>
        <DealPicker value={deal} onChange={(d) => { setDeal(d); setF((x) => ({ ...x, emitenteId: "" })); }} somenteProcessual={!todosFunis} />
        {deal && (
          <div className="grid grid-cols-2 gap-2">
            <div className="col-span-2">
              <label className={labelCls}>Empresa emissora</label>
              <select value={f.emitenteId} onChange={(e) => setF({ ...f, emitenteId: e.target.value })} className={inputCls}>
                <option value="">{emit.isLoading ? "Carregando…" : "Selecione…"}</option>
                {emitentes.map((e) => <option key={e.id} value={e.id}>{e.nomeFantasia || e.nome}</option>)}
              </select>
              {emit.error && <p className="text-xs text-red-600">{emit.error.message}</p>}
            </div>
            <div>
              <label className={labelCls}>Tipo</label>
              <select value={f.tipo} onChange={(e) => setF({ ...f, tipo: e.target.value as any })} className={inputCls}>
                <option value="execucao">Execução / sentença</option><option value="acordo">Acordo (avulso)</option>
              </select>
            </div>
            <div><label className={labelCls}>Vencimento previsto</label><input type="date" value={f.vencimento} onChange={(e) => setF({ ...f, vencimento: e.target.value })} className={inputCls} /></div>
            <div className="col-span-2"><label className={labelCls}>Descrição</label><input value={f.descricao} onChange={(e) => setF({ ...f, descricao: e.target.value })} className={inputCls} placeholder="Ex.: alvará de levantamento" /></div>
            <div><label className={labelCls}>Valor previsto</label><input value={f.previsto} onChange={(e) => setF({ ...f, previsto: e.target.value })} className={inputCls} inputMode="decimal" /></div>
            <div><label className={labelCls}>% honorários contratuais</label><input value={f.perc} onChange={(e) => setF({ ...f, perc: e.target.value })} disabled={f.semRepasse} className={inputCls} inputMode="decimal" /></div>
            <label className="col-span-2 flex items-center gap-2 text-xs text-gray-700">
              <input type="checkbox" checked={f.semRepasse} onChange={(e) => setF({ ...f, semRepasse: e.target.checked })} /> Sem repasse (ex.: sucumbência / honorário puro)
            </label>
            <div className="col-span-2"><label className={labelCls}>Observação</label><input value={f.obs} onChange={(e) => setF({ ...f, obs: e.target.value })} className={inputCls} /></div>
          </div>
        )}
        {erro && <p className="text-xs text-red-600">{erro}</p>}
        <div className="flex gap-2">
          <button className={btnPri} onClick={salvar} disabled={criar.isLoading || !deal}>{criar.isLoading ? "Criando…" : "Criar"}</button>
          <button className={btnSec} onClick={onClose}>Cancelar</button>
        </div>
      </div>
    </div>
  );
}

// ── Relatório de receita por tipo ────────────────────────────────────────────

function Relatorio({ emitenteId }: { emitenteId: string }) {
  const [de, setDe] = useState("");
  const [ate, setAte] = useState("");
  const q = trpc.recebimentos.relatorio.useQuery({ de: de || undefined, ate: ate || undefined, emitenteId: emitenteId || undefined });
  const d = q.data;
  const tipos = d ? ([["acordo", "Acordo"], ["execucao", "Execução / sentença"], ["total", "Total"]] as const) : [];

  function exportar() {
    if (!d) return;
    const c = (x: number) => x / 100;
    void exportarExcel({
      nomeArquivo: `receita-por-tipo-${de || "inicio"}-${ate || "hoje"}`,
      abas: [
        {
          nome: "Receita por tipo",
          colunas: [
            { chave: "tipo", titulo: "Tipo" }, { chave: "qtdRec", titulo: "Recebimentos", tipo: "numero" }, { chave: "qtdProc", titulo: "Processos", tipo: "numero" },
            { chave: "bruto", titulo: "Bruto recebido", tipo: "moeda" }, { chave: "receita", titulo: "Receita do escritório", tipo: "moeda" },
            { chave: "ticketRec", titulo: "Ticket médio / recebimento", tipo: "moeda" }, { chave: "ticketProc", titulo: "Ticket médio / processo", tipo: "moeda" },
            { chave: "tempo", titulo: "Tempo médio ajuizamento → recebimento (dias)", tipo: "numero" },
          ],
          linhas: tipos.map(([k, t]) => {
            const b = d.receitaPorTipo[k];
            return { tipo: t, qtdRec: b.qtdRecebimentos, qtdProc: b.qtdProcessos, bruto: c(b.bruto), receita: c(b.receitaEscritorio), ticketRec: c(b.ticketMedioPorRecebimento), ticketProc: c(b.ticketMedioPorProcesso), tempo: b.tempoMedioAjuizamentoRecebimentoDias };
          }),
        },
        {
          nome: "Acordo x execução",
          colunas: [
            { chave: "tipo", titulo: "Tipo" }, { chave: "previsto", titulo: "A receber", tipo: "moeda" }, { chave: "atraso", titulo: "Em atraso", tipo: "moeda" },
            { chave: "bruto", titulo: "Recebido bruto", tipo: "moeda" }, { chave: "receita", titulo: "Receita escritório", tipo: "moeda" },
            { chave: "repPend", titulo: "Repasse pendente", tipo: "moeda" }, { chave: "repReal", titulo: "Repasse realizado", tipo: "moeda" }, { chave: "semNf", titulo: "Sem NF", tipo: "numero" },
          ],
          linhas: ([["Acordo", d.acordo], ["Execução / sentença", d.execucao], ["Geral", d.geral]] as const).map(([t, x]) => ({
            tipo: t, previsto: c(x.previstoAReceber), atraso: c(x.emAtraso), bruto: c(x.recebidoBruto), receita: c(x.receitaEscritorio),
            repPend: c(x.repassePendente), repReal: c(x.repasseRealizado), semNf: x.qtdSemNf,
          })),
        },
      ],
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3 no-print">
        <div><label className={labelCls}>De</label><input type="date" value={de} onChange={(e) => setDe(e.target.value)} className={inputCls} /></div>
        <div><label className={labelCls}>Até</label><input type="date" value={ate} onChange={(e) => setAte(e.target.value)} className={inputCls} /></div>
        <p className="text-[11px] text-gray-500 pb-2">Período pela data do recebimento (previstos: pelo vencimento).</p>
        <div className="flex-1" />
        <button className={btnSec} onClick={exportar} disabled={!d}>Exportar Excel</button>
        <button className={btnSec} onClick={() => imprimirPdf("Receita por tipo")} disabled={!d}>PDF</button>
      </div>
      {q.isLoading && <div className="bg-white border border-gray-200 rounded-xl p-10 text-center text-sm text-gray-400 animate-pulse">Carregando…</div>}
      {q.error && <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-700">{q.error.message}</div>}
      {d && (
        <>
          <div className="bg-white border border-gray-200 rounded-xl overflow-x-auto">
            <div className="px-4 py-2 border-b bg-gray-50 text-sm font-semibold text-gray-800">Receita do escritório por tipo</div>
            <table className="w-full text-sm min-w-[820px]">
              <thead className="text-[11px] uppercase text-gray-500">
                <tr>
                  <th className="text-left px-3 py-2">Tipo</th><th className="text-right px-3 py-2">Recebimentos</th><th className="text-right px-3 py-2">Processos</th>
                  <th className="text-right px-3 py-2">Bruto</th><th className="text-right px-3 py-2">Receita escritório</th>
                  <th className="text-right px-3 py-2">Ticket / receb.</th><th className="text-right px-3 py-2">Ticket / processo</th><th className="text-right px-3 py-2">Ajuizamento → receb.</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {tipos.map(([k, t]) => {
                  const b = d.receitaPorTipo[k];
                  return (
                    <tr key={k} className={k === "total" ? "font-semibold bg-gray-50" : ""}>
                      <td className="px-3 py-2">{t}</td>
                      <td className="px-3 py-2 text-right">{b.qtdRecebimentos}</td>
                      <td className="px-3 py-2 text-right">{b.qtdProcessos}</td>
                      <td className="px-3 py-2 text-right">{fmtCent(b.bruto)}</td>
                      <td className="px-3 py-2 text-right text-green-700">{fmtCent(b.receitaEscritorio)}</td>
                      <td className="px-3 py-2 text-right">{fmtCent(b.ticketMedioPorRecebimento)}</td>
                      <td className="px-3 py-2 text-right">{fmtCent(b.ticketMedioPorProcesso)}</td>
                      <td className="px-3 py-2 text-right">{b.tempoMedioAjuizamentoRecebimentoDias != null ? `${b.tempoMedioAjuizamentoRecebimentoDias.toLocaleString("pt-BR")} dias` : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="text-[11px] text-gray-500 px-3 py-2">Receita do escritório = honorários contratuais + sucumbência. O valor repassado ao cliente não entra.</p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <BlocoTotais t={d.acordo} titulo="Acordos" />
            <BlocoTotais t={d.execucao} titulo="Execução / sentença" />
            <BlocoTotais t={d.geral} titulo="Geral" />
          </div>
        </>
      )}
    </div>
  );
}
