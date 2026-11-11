/**
 * Lista analítica de leads do Painel Diário (sem kanban): um lead por linha,
 * com origem, etapa, mensagens, tempo de resposta, atendimento, valor e tags.
 * Filtros, ordenação, métricas e CSV são calculados no cliente sobre o período.
 */
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { trpc } from "../lib/trpc";
import { Avatar } from "../components/Avatar";
import { PLATAFORMA_PAINEL, type DealOrigem } from "../components/OrigemLead";
import { ArrowDown, ArrowUp, Download, Loader2, MessageCircle, Search } from "lucide-react";

type Lead = {
  dealId: string; titulo: string; entrada: string | Date; status: string;
  pipeline: string; pipelineId: string; stage: string; stageCor: string; stageChave: string; stageOrdem: number;
  contato: string | null; whatsapp: string | null; cidade: string | null;
  contatoRef: { id: string; fotoPerfilUrl: string | null; fotoPerfilEm: string | Date | null } | null;
  msgsIn: number; msgsOut: number; engajou: boolean; respostaMin: number | null;
  ultimaMsg: string | Date | null; diasNoFunil: number; atendimento: string;
  valorEstimado: number | null; valor: number | null; tags: { nome: string; cor: string }[];
  avancou: boolean; negativo: boolean; fechou: boolean; protocolou: boolean;
} & DealOrigem;

type SortKey = "entrada" | "contato" | "stageOrdem" | "msgsIn" | "respostaMin" | "ultimaMsg" | "diasNoFunil" | "valorEstimado";

function fmtDataHora(v: string | Date | null | undefined) {
  if (!v) return "—";
  const d = new Date(v);
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" }) + " " + d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}
function fmtMin(m: number | null) {
  if (m == null) return "—";
  if (m < 1) return "<1 min";
  if (m < 60) return `${m} min`;
  if (m < 60 * 24) return `${Math.round(m / 60)} h`;
  return `${Math.round(m / 1440)} d`;
}
function fmtBRL(v: number | null) {
  return v == null ? "—" : v.toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
}
function origemChave(l: Lead) {
  const p = l.origemPlataforma;
  if (!p) return "sem_origem";
  if (p === "facebook" || p === "instagram" || p === "meta" || p === "site") return p;
  return "organico";
}
/** Rótulo do anúncio: texto do criativo, senão título, senão ID. Link wa.me e orgânico têm rótulo próprio. */
function anuncioDe(l: Lead): string {
  if (l.origemTipo === "anuncio") return (l.origemAnuncioTexto?.trim() || l.origemAnuncioTitulo?.trim() || (l.origemAnuncioId ? `anúncio ${l.origemAnuncioId}` : "anúncio"));
  if (l.origemTipo === "link") return "link wa.me (site / bio)";
  if (l.origemTipo === "organico") return "busca no WhatsApp / nº salvo";
  return "";
}
function anuncioChave(l: Lead): string {
  if (l.origemTipo === "anuncio") return l.origemAnuncioId ?? anuncioDe(l);
  return l.origemTipo ?? "";
}
function media(xs: number[]) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null; }
function mediana(xs: number[]) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function PainelLeads({ de, ate, pipelineIds }: { de: string; ate: string; pipelineIds?: string[] }) {
  const navigate = useNavigate();
  const q = trpc.painel.leads.useQuery({ de, ate, pipelineIds });
  const leads = (q.data ?? []) as unknown as Lead[];

  const [busca, setBusca] = useState("");
  const [origem, setOrigem] = useState<string>("");
  const [etapa, setEtapa] = useState<string>("");
  const [anuncio, setAnuncio] = useState<string>("");
  const [engaj, setEngaj] = useState<"" | "sim" | "nao">("");
  const [atend, setAtend] = useState<string>("");
  const [sort, setSort] = useState<{ k: SortKey; dir: "asc" | "desc" }>({ k: "entrada", dir: "desc" });

  const etapas = useMemo(() => {
    const m = new Map<string, { nome: string; cor: string; ordem: number; n: number }>();
    for (const l of leads) {
      const e = m.get(l.stage) ?? { nome: l.stage, cor: l.stageCor, ordem: l.stageOrdem, n: 0 };
      e.n++; m.set(l.stage, e);
    }
    return [...m.values()].sort((a, b) => a.ordem - b.ordem);
  }, [leads]);
  const atendimentos = useMemo(() => [...new Set(leads.map(l => l.atendimento))].sort(), [leads]);
  const anuncios = useMemo(() => {
    const m = new Map<string, { rotulo: string; n: number }>();
    for (const l of leads) {
      const k = anuncioChave(l); if (!k) continue;
      const e = m.get(k) ?? { rotulo: anuncioDe(l), n: 0 }; e.n++; m.set(k, e);
    }
    return [...m.entries()].sort((a, b) => b[1].n - a[1].n);
  }, [leads]);

  const filtrados = useMemo(() => {
    const b = busca.trim().toLowerCase(); const bd = b.replace(/\D/g, "");
    let arr = leads.filter(l =>
      (!origem || origemChave(l) === origem) &&
      (!etapa || l.stage === etapa) &&
      (!anuncio || anuncioChave(l) === anuncio) &&
      (!engaj || (engaj === "sim") === l.engajou) &&
      (!atend || l.atendimento === atend) &&
      (!b || (l.contato ?? l.titulo).toLowerCase().includes(b) || (l.cidade ?? "").toLowerCase().includes(b) ||
        (bd.length >= 3 && (l.whatsapp ?? "").replace(/\D/g, "").includes(bd)) ||
        (l.origemAnuncioTexto ?? "").toLowerCase().includes(b) || l.tags.some(t => t.nome.toLowerCase().includes(b)))
    );
    const dir = sort.dir === "asc" ? 1 : -1;
    const val = (l: Lead): number | string => {
      switch (sort.k) {
        case "entrada": return new Date(l.entrada).getTime();
        case "ultimaMsg": return l.ultimaMsg ? new Date(l.ultimaMsg).getTime() : 0;
        case "contato": return (l.contato ?? l.titulo).toLowerCase();
        case "respostaMin": return l.respostaMin ?? Number.POSITIVE_INFINITY;
        case "valorEstimado": return l.valorEstimado ?? -1;
        default: return l[sort.k] as number;
      }
    };
    arr = [...arr].sort((a, b) => { const x = val(a), y = val(b); return x < y ? -dir : x > y ? dir : 0; });
    return arr;
  }, [leads, busca, origem, etapa, anuncio, engaj, atend, sort]);

  const m = useMemo(() => {
    const n = filtrados.length;
    const eng = filtrados.filter(l => l.engajou).length;
    const so1 = filtrados.filter(l => l.msgsIn <= 1).length;
    const av = filtrados.filter(l => l.avancou).length;
    const neg = filtrados.filter(l => l.negativo).length;
    const fech = filtrados.filter(l => l.fechou).length;
    const prot = filtrados.filter(l => l.protocolou).length;
    const resp = filtrados.map(l => l.respostaMin).filter((x): x is number => x != null);
    const ia = filtrados.filter(l => l.atendimento === "IA").length;
    const valores = filtrados.map(l => l.valorEstimado).filter((x): x is number => x != null);
    return { n, eng, so1, av, neg, fech, prot, ia, respMed: mediana(resp), respMedia: media(resp), valorTotal: valores.reduce((a, b) => a + b, 0), comValor: valores.length };
  }, [filtrados]);

  function th(label: string, k?: SortKey, extra = "") {
    const on = k && sort.k === k;
    return (
      <th
        className={`text-left font-medium px-2 py-2 whitespace-nowrap ${k ? "cursor-pointer select-none hover:text-gray-600" : ""} ${extra}`}
        onClick={() => k && setSort(s => ({ k, dir: s.k === k && s.dir === "desc" ? "asc" : "desc" }))}
      >
        <span className="inline-flex items-center gap-1">{label}{on && (sort.dir === "asc" ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}</span>
      </th>
    );
  }
  const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0) + "%";

  function exportarCsv() {
    const head = ["Contato", "WhatsApp", "Cidade", "Entrada", "Origem", "Anúncio", "ID anúncio", "Funil", "Etapa", "Msgs recebidas", "Msgs enviadas", "Engajou", "1ª resposta (min)", "Última mensagem", "Dias no funil", "Atendimento", "Valor estimado", "Tags", "Fechado", "Protocolado"];
    const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const body = filtrados.map(l => [
      l.contato ?? l.titulo, l.whatsapp, l.cidade, fmtDataHora(l.entrada), PLATAFORMA_PAINEL[origemChave(l)]?.nome,
      anuncioDe(l), l.origemAnuncioId, l.pipeline, l.stage,
      l.msgsIn, l.msgsOut, l.engajou ? "sim" : "não", l.respostaMin ?? "", fmtDataHora(l.ultimaMsg), l.diasNoFunil, l.atendimento,
      l.valorEstimado ?? "", l.tags.map(t => t.nome).join(", "), l.fechou ? "sim" : "não", l.protocolou ? "sim" : "não",
    ].map(esc).join(";")).join("\n");
    const blob = new Blob([`﻿${head.join(";")}\n${body}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `leads-${de}_a_${ate}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      {/* filtros */}
      <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-gray-100">
        <div className="relative">
          <Search size={13} className="absolute left-2.5 top-2.5 text-gray-400" />
          <input value={busca} onChange={e => setBusca(e.target.value)} placeholder="Nome, telefone, cidade, tag, anúncio…"
            className="pl-8 pr-3 py-1.5 text-sm border border-gray-200 rounded-lg w-64 focus:outline-none focus:ring-2 focus:ring-indigo-200" />
        </div>
        <select value={origem} onChange={e => setOrigem(e.target.value)} className="text-sm border border-gray-200 rounded-lg px-2 py-1.5">
          <option value="">Todas as origens</option>
          {Object.entries(PLATAFORMA_PAINEL).map(([k, p]) => <option key={k} value={k}>{p.nome}</option>)}
        </select>
        <select value={anuncio} onChange={e => setAnuncio(e.target.value)} className="text-sm border border-gray-200 rounded-lg px-2 py-1.5 max-w-[260px]">
          <option value="">Todos os anúncios</option>
          {anuncios.map(([k, a]) => <option key={k} value={k}>{a.rotulo.length > 48 ? a.rotulo.slice(0, 46) + "…" : a.rotulo} ({a.n})</option>)}
        </select>
        <select value={etapa} onChange={e => setEtapa(e.target.value)} className="text-sm border border-gray-200 rounded-lg px-2 py-1.5 max-w-[220px]">
          <option value="">Todas as etapas</option>
          {etapas.map(e => <option key={e.nome} value={e.nome}>{e.nome} ({e.n})</option>)}
        </select>
        <select value={engaj} onChange={e => setEngaj(e.target.value as any)} className="text-sm border border-gray-200 rounded-lg px-2 py-1.5">
          <option value="">Engajou: todos</option>
          <option value="sim">Engajou (2+ msgs)</option>
          <option value="nao">Só 1 mensagem</option>
        </select>
        <select value={atend} onChange={e => setAtend(e.target.value)} className="text-sm border border-gray-200 rounded-lg px-2 py-1.5">
          <option value="">Atendimento: todos</option>
          {atendimentos.map(a => <option key={a} value={a}>{a}</option>)}
        </select>
        {(busca || origem || etapa || anuncio || engaj || atend) && (
          <button onClick={() => { setBusca(""); setOrigem(""); setEtapa(""); setAnuncio(""); setEngaj(""); setAtend(""); }} className="text-xs text-gray-500 underline">limpar</button>
        )}
        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs text-gray-400">{filtrados.length} de {leads.length} leads</span>
          <button onClick={exportarCsv} disabled={!filtrados.length} className="inline-flex items-center gap-1.5 text-xs border border-gray-200 rounded-lg px-2.5 py-1.5 hover:bg-gray-50 disabled:opacity-40">
            <Download size={13} /> CSV
          </button>
        </div>
      </div>

      {/* métricas do recorte */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-px bg-gray-100 border-b border-gray-100">
        {[
          { l: "Leads", v: m.n, s: "no recorte" },
          { l: "Engajaram", v: pct(m.eng, m.n), s: `${m.eng} responderam além da 1ª msg` },
          { l: "Só 1 mensagem", v: pct(m.so1, m.n), s: `${m.so1} sumiram após a 1ª msg` },
          { l: "Avançaram", v: pct(m.av, m.n), s: `${m.av} saíram da etapa inicial` },
          { l: "Desqualif./perdidos", v: pct(m.neg, m.n), s: `${m.neg} leads` },
          { l: "1ª resposta (mediana)", v: fmtMin(m.respMed == null ? null : Math.round(m.respMed)), s: `média ${fmtMin(m.respMedia == null ? null : Math.round(m.respMedia))}` },
          { l: "Fechados · Protoc.", v: `${m.fech} · ${m.prot}`, s: `${pct(m.fech, m.n)} · ${pct(m.prot, m.n)}` },
          { l: "Valor estimado", v: fmtBRL(m.valorTotal || null), s: `${m.comValor} com estimativa · IA em ${pct(m.ia, m.n)}` },
        ].map(k => (
          <div key={k.l} className="bg-white px-3 py-2.5">
            <p className="text-[11px] uppercase tracking-wide text-gray-400">{k.l}</p>
            <p className="text-lg font-semibold text-gray-800 tabular-nums leading-tight">{k.v}</p>
            <p className="text-[11px] text-gray-400 truncate" title={k.s}>{k.s}</p>
          </div>
        ))}
      </div>

      {q.isLoading ? (
        <div className="flex items-center gap-2 px-4 py-6 text-sm text-gray-400"><Loader2 size={14} className="animate-spin" /> Carregando leads…</div>
      ) : filtrados.length === 0 ? (
        <div className="px-4 py-6 text-sm text-gray-400">Nenhum lead no recorte.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[11px] uppercase tracking-wide text-gray-400 bg-gray-50/60">
                {th("Lead", "contato", "pl-4")}
                {th("Entrada", "entrada")}
                {th("Plataforma")}
                {th("Anúncio")}
                {th("Etapa", "stageOrdem")}
                {th("Msgs", "msgsIn", "text-right")}
                {th("1ª resp.", "respostaMin")}
                {th("Última msg", "ultimaMsg")}
                {th("Dias", "diasNoFunil", "text-right")}
                {th("Atend.")}
                {th("Valor est.", "valorEstimado", "text-right")}
                {th("Tags")}
              </tr>
            </thead>
            <tbody>
              {filtrados.map(l => (
                <tr key={l.dealId} className="border-t border-gray-100 hover:bg-indigo-50/40 cursor-pointer" onClick={() => navigate(`/whatsapp?dealId=${l.dealId}`)} title="Abrir conversa">
                  <td className="pl-4 pr-2 py-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <Avatar contato={l.contatoRef as any} nome={l.contato ?? l.titulo} size={28} />
                      <div className="min-w-0">
                        <div className="font-medium text-gray-800 truncate max-w-[180px]">{l.contato ?? l.titulo}</div>
                        <div className="text-[11px] text-gray-400 flex items-center gap-1">
                          {l.whatsapp && <><MessageCircle size={10} className="text-emerald-500" /> {l.whatsapp}</>}
                          {l.cidade && <span>· {l.cidade}</span>}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="px-2 py-2 text-gray-600 tabular-nums whitespace-nowrap">{fmtDataHora(l.entrada)}</td>
                  <td className="px-2 py-2 whitespace-nowrap">
                    {(() => { const k = origemChave(l); const p = PLATAFORMA_PAINEL[k];
                      return k === "sem_origem"
                        ? <span className="text-xs text-gray-300">—</span>
                        : <span className="inline-flex items-center gap-1.5 text-xs text-gray-700"><i className="inline-block w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: p.cor }} />{p.nome}</span>; })()}
                  </td>
                  <td className="px-2 py-2 max-w-[260px]">
                    {l.origemTipo ? (
                      <div className="min-w-0">
                        <div className="text-xs text-gray-700 truncate" title={anuncioDe(l)}>{anuncioDe(l)}</div>
                        {l.origemAnuncioId && <div className="text-[10px] text-gray-400 font-mono">ID {l.origemAnuncioId}</div>}
                      </div>
                    ) : <span className="text-xs text-gray-300">não identificado</span>}
                  </td>
                  <td className="px-2 py-2">
                    <span className="inline-block px-2 py-0.5 rounded-full text-[11px] font-medium whitespace-nowrap" style={{ backgroundColor: `${l.stageCor}1a`, color: l.stageCor }}>{l.stage}</span>
                    {(l.fechou || l.protocolou) && <span className="ml-1 text-[10px] text-violet-600">{l.protocolou ? "protocolado" : "fechado"}</span>}
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums whitespace-nowrap">
                    <span className={l.engajou ? "text-gray-800" : "text-amber-600"} title="recebidas / enviadas">{l.msgsIn}</span>
                    <span className="text-gray-300"> / {l.msgsOut}</span>
                  </td>
                  <td className="px-2 py-2 text-gray-600 tabular-nums whitespace-nowrap">{fmtMin(l.respostaMin)}</td>
                  <td className="px-2 py-2 text-gray-500 tabular-nums whitespace-nowrap">{fmtDataHora(l.ultimaMsg)}</td>
                  <td className="px-2 py-2 text-right text-gray-600 tabular-nums">{l.diasNoFunil}</td>
                  <td className="px-2 py-2">
                    <span className={`text-[11px] px-1.5 py-0.5 rounded ${l.atendimento === "IA" ? "bg-green-50 text-green-700" : "bg-yellow-50 text-yellow-700"}`}>{l.atendimento}</span>
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums text-gray-700 whitespace-nowrap">{fmtBRL(l.valorEstimado)}</td>
                  <td className="px-2 py-2">
                    <div className="flex flex-wrap gap-1 max-w-[180px]">
                      {l.tags.slice(0, 3).map(t => <span key={t.nome} className="text-[10px] px-1.5 py-0.5 rounded-full" style={{ backgroundColor: `${t.cor}22`, color: t.cor }}>{t.nome}</span>)}
                      {l.tags.length > 3 && <span className="text-[10px] text-gray-400">+{l.tags.length - 3}</span>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
