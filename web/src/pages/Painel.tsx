import { useEffect, useMemo, useState } from "react";
import { FunilSdrPainel } from "../components/FunilSdrPainel";
import { FollowupsDoDia } from "../components/FollowupsDoDia";
import { LigacoesPorUsuario } from "../components/LigacoesPorUsuario";
import { PrimeiraLigacaoPainel } from "../components/PrimeiraLigacaoPainel";
import { SdrFollowups } from "../components/SdrFollowups";
import { FunilQualificacaoPainel } from "../components/FunilQualificacaoPainel";
import { TurnosChegadaPainel } from "../components/TurnosChegadaPainel";
import { trpc } from "../lib/trpc";
import { OrigemBadge, PLATAFORMA_PAINEL, type DealOrigem } from "../components/OrigemLead";
import MetaCapiPainel from "../components/MetaCapiPainel";
import { PainelLeads } from "./PainelLeads";
import {
  BarChart3, UserPlus, CheckCircle2, FileCheck2, Settings2, Download,
  ChevronDown, ChevronRight, Loader2, MessageCircle, Megaphone, CalendarDays, List,
} from "lucide-react";

type Tipo = "novos" | "fechados" | "protocolados";

const TIPOS: { chave: Tipo; label: string; cor: string; corBg: string; corBorda: string; icon: typeof UserPlus }[] = [
  { chave: "novos",        label: "Contatos novos", cor: "text-blue-700",    corBg: "bg-blue-50",    corBorda: "border-blue-200",    icon: UserPlus },
  { chave: "fechados",     label: "Fechados",       cor: "text-emerald-700", corBg: "bg-emerald-50", corBorda: "border-emerald-200", icon: CheckCircle2 },
  { chave: "protocolados", label: "Protocolados",   cor: "text-violet-700",  corBg: "bg-violet-50",  corBorda: "border-violet-200",  icon: FileCheck2 },
];

// ── datas ────────────────────────────────────────────────────────────────────

const FUNIL_KEY = "painel:funil";

function slug(t: string) {
  return t.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function hojeISO() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
}
function somarDias(iso: string, dias: number) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}
function fmtDia(iso: string) {
  const [a, m, d] = iso.split("-");
  return `${d}/${m}/${a}`;
}
function diaSemana(iso: string) {
  return new Intl.DateTimeFormat("pt-BR", { weekday: "short", timeZone: "UTC" })
    .format(new Date(`${iso}T12:00:00Z`))
    .replace(".", "");
}
function ehFimDeSemana(iso: string) {
  const dow = new Date(`${iso}T12:00:00Z`).getUTCDay();
  return dow === 0 || dow === 6;
}
function fmtHora(v: string | Date | null) {
  if (!v) return "";
  return new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" })
    .format(new Date(v));
}
function soDigitos(tel: string) {
  return tel.replace(/\D/g, "");
}

// ── linha expansível do dia ──────────────────────────────────────────────────

function ListaDoDia({ dia, tipo, pipelineIds }: { dia: string; tipo: Tipo; pipelineIds?: string[] }) {
  const q = trpc.painel.itensDia.useQuery({ dia, tipo, pipelineIds });

  if (q.isLoading) {
    return (
      <div className="flex items-center gap-2 px-4 py-3 text-sm text-gray-400">
        <Loader2 size={14} className="animate-spin" /> Carregando…
      </div>
    );
  }
  if (!q.data?.length) {
    return <div className="px-4 py-3 text-sm text-gray-400">Nenhum contato neste dia.</div>;
  }

  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-[11px] uppercase tracking-wide text-gray-400">
          <th className="text-left font-medium px-4 py-2 w-14">Hora</th>
          <th className="text-left font-medium px-2 py-2">Contato</th>
          <th className="text-left font-medium px-2 py-2">WhatsApp</th>
          <th className="text-left font-medium px-2 py-2">Captação</th>
          <th className="text-left font-medium px-2 py-2">Etapa</th>
          <th className="text-left font-medium px-2 py-2">Funil</th>
        </tr>
      </thead>
      <tbody>
        {q.data.map(item => (
          <tr key={item.dealId} className="border-t border-gray-100 hover:bg-white">
            <td className="px-4 py-2 text-gray-400 tabular-nums">{fmtHora(item.em as any)}</td>
            <td className="px-2 py-2">
              <span className="font-medium text-gray-800">{item.contato || item.titulo}</span>
              {item.cidade && <span className="text-gray-400"> · {item.cidade}</span>}
            </td>
            <td className="px-2 py-2">
              {item.whatsapp ? (
                <a
                  href={`https://wa.me/${soDigitos(item.whatsapp)}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-emerald-600 hover:text-emerald-800"
                >
                  <MessageCircle size={13} /> {item.whatsapp}
                </a>
              ) : (
                <span className="text-gray-300">—</span>
              )}
            </td>
            <td className="px-2 py-2 max-w-[260px]">
              {(item as DealOrigem).origemPlataforma
                ? <OrigemBadge deal={item as DealOrigem} />
                : <span className="text-gray-300 text-xs">não identificada</span>}
            </td>
            <td className="px-2 py-2">
              <span
                className="inline-block px-2 py-0.5 rounded-full text-[11px] font-medium"
                style={{ backgroundColor: `${item.stageCor}1a`, color: item.stageCor }}
              >
                {item.stage}
              </span>
            </td>
            <td className="px-2 py-2 text-gray-500">{item.pipeline}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ── página ───────────────────────────────────────────────────────────────────

export default function Painel() {
  const hoje = hojeISO();
  const [de, setDe]   = useState(somarDias(hoje, -29));
  const [ate, setAte] = useState(hoje);
  // O painel é sempre de UM funil: somar funis diferentes (carreteiros, ICMS, imports) não diz nada.
  const [funilId, setFunilId] = useState<string | null>(() => {
    try { return localStorage.getItem(FUNIL_KEY); } catch { return null; }
  });
  const [aberto, setAberto] = useState<{ dia: string; tipo: Tipo } | null>(null);
  const [configAberta, setConfigAberta] = useState(false);
  const [ocultarVazios, setOcultarVazios] = useState(false);
  const [visao, setVisao] = useState<"dias" | "leads">("dias");

  const utils  = trpc.useUtils();
  const config = trpc.painel.config.useQuery();

  // Funil salvo sumiu (ou nunca escolhido) → o que teve contato mais recente
  const funis = config.data?.pipelines ?? [];
  const funil = funis.find(p => p.id === funilId)
    ?? [...funis].sort((a, b) => (b.ultima ?? "").localeCompare(a.ultima ?? ""))[0];
  useEffect(() => {
    if (funil && funil.id !== funilId) setFunilId(funil.id);
  }, [funil, funilId]);
  function escolherFunil(id: string) {
    setFunilId(id);
    setAberto(null);
    setFechadoSel(null);
    setProtocoladoSel(null);
    try { localStorage.setItem(FUNIL_KEY, id); } catch { /* sem storage */ }
  }
  const pipesSel = funil ? [funil.id] : undefined;
  const temFunil = !!funil;

  const resumo = trpc.painel.resumo.useQuery({ de, ate, pipelineIds: pipesSel }, { enabled: temFunil });
  const origens = trpc.painel.origens.useQuery({ de, ate, pipelineIds: pipesSel }, { enabled: temFunil });
  const salvar = trpc.painel.salvarConfig.useMutation({
    onSuccess: () => { utils.painel.config.invalidate(); utils.painel.resumo.invalidate(); },
  });

  const [fechadoSel, setFechadoSel]         = useState<string[] | null>(null);
  const [protocoladoSel, setProtocoladoSel] = useState<string[] | null>(null);
  const fechado     = fechadoSel     ?? config.data?.fechado     ?? [];
  const protocolado = protocoladoSel ?? config.data?.protocolado ?? [];

  const linhas = resumo.data?.dias ?? [];
  const linhasVisiveis = useMemo(() => {
    const arr = [...linhas].reverse();          // mais recente primeiro
    return ocultarVazios
      ? arr.filter(l => l.novos || l.fechados || l.protocolados)
      : arr;
  }, [linhas, ocultarVazios]);
  const maxNovos = Math.max(1, ...linhas.map(l => l.novos));
  const diasComMovimento = linhas.filter(l => l.novos || l.fechados || l.protocolados).length;

  // Período coberto pelos funis selecionados
  const cobertura = useMemo(() => {
    if (!funil?.primeira) return null;
    return { de: funil.primeira, ate: funil.ultima ?? hoje };
  }, [funil, hoje]);

  function aplicarPreset(dias: number) {
    setAte(hoje);
    setDe(somarDias(hoje, -(dias - 1)));
    setOcultarVazios(dias > 60);
    setAberto(null);
  }

  function periodoCompleto() {
    if (!cobertura) return;
    setDe(cobertura.de);
    setAte(hoje > cobertura.ate ? hoje : cobertura.ate);
    setOcultarVazios(true);
    setAberto(null);
  }

  function toggle(lista: string[], id: string) {
    return lista.includes(id) ? lista.filter(x => x !== id) : [...lista, id];
  }

  function exportarCsv() {
    const plats = Object.keys(PLATAFORMA_PAINEL);
    const head = "Data;Contatos novos;Fechados;Protocolados;" + plats.map(k => PLATAFORMA_PAINEL[k].nome).join(";");
    const fonte = ocultarVazios
      ? linhas.filter(l => l.novos || l.fechados || l.protocolados)
      : linhas;
    const body = fonte.map(l => `${fmtDia(l.dia)};${l.novos};${l.fechados};${l.protocolados};` + plats.map(k => ((l as any).origens ?? {})[k] ?? 0).join(";")).join("\n");
    const totais = resumo.data?.totais;
    const rodape = totais ? `\nTOTAL;${totais.novos};${totais.fechados};${totais.protocolados}` : "";
    const blob = new Blob([`﻿${head}\n${body}${rodape}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `painel-${slug(funil?.nome ?? "funil")}-${de}_a_${ate}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="p-4 md:p-8 max-w-6xl mx-auto">

      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3 mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 tracking-tight flex items-center gap-2">
            <BarChart3 size={22} className="text-gray-400" /> Painel diário
          </h1>
          <p className="text-sm text-gray-400 mt-0.5">
            Contatos novos, fechados e protocolados por dia{funil ? <> — <b className="text-gray-600">{funil.nome}</b></> : null}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={exportarCsv}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-200 bg-white text-sm text-gray-600 hover:border-gray-300 hover:text-gray-900 transition-all shadow-sm"
          >
            <Download size={14} /> CSV
          </button>
          <button
            onClick={() => setConfigAberta(v => !v)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-200 bg-white text-sm text-gray-600 hover:border-gray-300 hover:text-gray-900 transition-all shadow-sm"
          >
            <Settings2 size={14} /> Etapas
          </button>
        </div>
      </div>

      {/* Filtros */}
      <div className="bg-white rounded-xl border border-gray-200 p-4 mb-4 flex flex-wrap items-end gap-4">
        <div>
          <label className="block text-[11px] uppercase tracking-wide text-gray-400 mb-1">De</label>
          <input
            type="date" value={de} max={ate}
            onChange={e => { setDe(e.target.value); setAberto(null); }}
            className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm"
          />
        </div>
        <div>
          <label className="block text-[11px] uppercase tracking-wide text-gray-400 mb-1">Até</label>
          <input
            type="date" value={ate} min={de}
            onChange={e => { setAte(e.target.value); setAberto(null); }}
            className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm"
          />
        </div>
        <div className="flex gap-1.5">
          {[7, 15, 30, 90].map(d => (
            <button
              key={d}
              onClick={() => aplicarPreset(d)}
              className="px-2.5 py-1.5 rounded-lg border border-gray-200 text-xs text-gray-600 hover:bg-gray-50"
            >
              {d}d
            </button>
          ))}
          <button
            onClick={periodoCompleto}
            disabled={!cobertura}
            title={cobertura ? `Desde ${fmtDia(cobertura.de)}` : undefined}
            className="px-2.5 py-1.5 rounded-lg border border-gray-300 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-40"
          >
            Todo o período
          </button>
        </div>
        <div className="flex-1 min-w-[220px]">
          <label className="block text-[11px] uppercase tracking-wide text-gray-400 mb-1">Funil</label>
          <div className="flex flex-wrap gap-1.5">
            {funis.map(p => {
              const on = p.id === funil?.id;
              return (
                <button
                  key={p.id}
                  onClick={() => escolherFunil(p.id)}
                  className={`px-2.5 py-1 rounded-full text-xs border transition-colors ${
                    on ? "text-white border-transparent" : "bg-white text-gray-600 border-gray-200 hover:border-gray-300"
                  }`}
                  style={on ? { backgroundColor: p.cor } : undefined}
                  title={p.primeira ? `${p.deals} contatos · ${fmtDia(p.primeira)} → ${fmtDia(p.ultima!)}` : "sem contatos"}
                >
                  {p.nome}
                  <span className={on ? "opacity-80" : "text-gray-400"}> · {p.deals}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Config de etapas */}
      {configAberta && (
        <div className="bg-white rounded-xl border border-gray-200 p-5 mb-4">
          <SdrFollowups />
          <p className="text-sm text-gray-600 mb-1">
            Marque quais etapas contam como <b>Fechado</b> e quais contam como <b>Protocolado</b>.
          </p>
          <p className="text-xs text-gray-400 mb-4">
            {config.data?.padrao
              ? "Usando a detecção automática pelo nome da etapa — salve para fixar sua escolha."
              : "Configuração salva por empresa."}
          </p>
          <div className="space-y-4 max-h-96 overflow-y-auto pr-1">
            {funis.filter(p => p.id === funil?.id).map(p => (
              <div key={p.id}>
                <p className="text-xs font-semibold text-gray-500 mb-1.5 flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full" style={{ backgroundColor: p.cor }} />
                  {p.nome}
                </p>
                <div className="space-y-1">
                  {p.stages.map(s => (
                    <div key={s.id} className="flex items-center justify-between text-sm py-1 px-2 rounded hover:bg-gray-50">
                      <span className="text-gray-700">{s.nome}</span>
                      <div className="flex items-center gap-4 text-xs">
                        <label className="flex items-center gap-1.5 text-emerald-700">
                          <input
                            type="checkbox"
                            checked={fechado.includes(s.id)}
                            onChange={() => setFechadoSel(toggle(fechado, s.id))}
                            className="rounded"
                          />
                          Fechado
                        </label>
                        <label className="flex items-center gap-1.5 text-violet-700">
                          <input
                            type="checkbox"
                            checked={protocolado.includes(s.id)}
                            onChange={() => setProtocoladoSel(toggle(protocolado, s.id))}
                            className="rounded"
                          />
                          Protocolado
                        </label>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div className="flex justify-end gap-2 mt-4 pt-3 border-t border-gray-100">
            <button
              onClick={() => { setFechadoSel(null); setProtocoladoSel(null); }}
              className="px-3 py-1.5 rounded-lg text-sm text-gray-500 hover:text-gray-800"
            >
              Descartar
            </button>
            <button
              onClick={() => salvar.mutate({ fechado, protocolado })}
              disabled={salvar.isPending}
              className="px-4 py-1.5 rounded-lg bg-gray-900 text-white text-sm font-medium hover:bg-black disabled:opacity-50"
            >
              {salvar.isPending ? "Salvando…" : "Salvar"}
            </button>
          </div>
        </div>
      )}

      <LigacoesPorUsuario />
      <FollowupsDoDia pipelineIds={pipesSel} />
      <FunilQualificacaoPainel de={de} ate={ate} pipelineIds={pipesSel} />
      <FunilSdrPainel de={de} ate={ate} pipelineIds={pipesSel} />
      <PrimeiraLigacaoPainel de={de} ate={ate} pipelineIds={pipesSel} />

      {/* KPIs */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-4">
        {TIPOS.map(t => {
          const total = resumo.data?.totais[t.chave] ?? null;
          const dias  = linhas.length || 1;
          return (
            <div key={t.chave} className={`rounded-xl border p-5 ${t.corBg} ${t.corBorda}`}>
              <div className="w-9 h-9 rounded-lg bg-white/70 flex items-center justify-center mb-4">
                <t.icon size={18} className={t.cor} strokeWidth={2} />
              </div>
              <p className={`text-2xl font-bold tracking-tight ${t.cor}`}>
                {resumo.isLoading ? "…" : total ?? 0}
              </p>
              <p className="text-sm text-gray-500 mt-1 font-medium">{t.label}</p>
              <p className="text-xs text-gray-400 mt-0.5">
                {((total ?? 0) / dias).toFixed(1).replace(".", ",")} por dia
              </p>
            </div>
          );
        })}
      </div>

      <TurnosChegadaPainel de={de} ate={ate} pipelineIds={pipesSel} />

      {/* Captação por origem */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden mb-4">
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-b border-gray-100">
          <div className="flex items-center gap-2">
            <Megaphone size={16} className="text-gray-400" />
            <span className="text-sm font-semibold text-gray-800">Captação por origem</span>
            <span className="text-xs text-gray-400">plataforma e anúncio da primeira mensagem, no período</span>
          </div>
          <div className="flex flex-wrap gap-3 text-[11px] text-gray-500">
            {Object.entries(PLATAFORMA_PAINEL).map(([k, p]) => (
              <span key={k} className="inline-flex items-center gap-1">
                <i className="inline-block w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: p.cor }} /> {p.nome}
              </span>
            ))}
          </div>
        </div>
        {origens.isLoading ? (
          <div className="p-6 text-center text-sm text-gray-400">Carregando…</div>
        ) : !origens.data?.grupos.length ? (
          <div className="p-6 text-center text-sm text-gray-400">Sem contatos novos no período.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[11px] uppercase tracking-wide text-gray-400">
                  <th className="text-left font-medium px-4 py-2">Origem</th>
                  <th className="text-right font-medium px-2 py-2">Leads</th>
                  <th className="text-left font-medium px-2 py-2 w-32">Participação</th>
                  <th className="text-right font-medium px-2 py-2">Engajaram</th>
                  <th className="text-right font-medium px-2 py-2" title="Chegaram a lead qualificado ou etapa posterior">Qualificados</th>
                  <th className="text-right font-medium px-2 py-2">Fechados</th>
                  <th className="text-right font-medium px-2 py-2">Protoc.</th>
                </tr>
              </thead>
              <tbody>
                {origens.data.grupos.map(g => {
                  const p = PLATAFORMA_PAINEL[g.plataforma] ?? PLATAFORMA_PAINEL.sem_origem;
                  const pct = origens.data!.total ? (g.leads / origens.data!.total) * 100 : 0;
                  const desc = g.tipo === "anuncio"
                    ? (g.anuncioTexto || g.anuncioTitulo || (g.anuncioId ? `anúncio ${g.anuncioId}` : "anúncio"))
                    : g.tipo === "link" ? "link wa.me (site / bio)" : g.tipo === "organico" ? (g.anuncioTitulo || "busca no WhatsApp / nº salvo") : "sem metadado na 1ª mensagem";
                  return (
                    <tr key={g.chave} className="border-t border-gray-100">
                      <td className="px-4 py-2 max-w-[420px]">
                        <div className="flex items-start gap-2">
                          <i className="mt-1.5 inline-block w-2.5 h-2.5 rounded-sm shrink-0" style={{ backgroundColor: p.cor }} />
                          <div className="min-w-0">
                            <div className="font-medium text-gray-800">{p.nome}{g.tipo === "anuncio" ? " · anúncio" : g.tipo === "organico" && g.plataforma !== "organico" ? " · orgânico" : ""}</div>
                            <div className="text-xs text-gray-500 truncate" title={desc}>{desc}</div>
                            {g.anuncioId && g.tipo !== "organico" && <div className="text-[11px] text-gray-400 font-mono">ID {g.anuncioId}</div>}
                          </div>
                        </div>
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums font-semibold text-gray-800">{g.leads}</td>
                      <td className="px-2 py-2">
                        <div className="flex items-center gap-2">
                          <span className="h-1.5 flex-1 rounded-full bg-gray-100 overflow-hidden"><i className="block h-full" style={{ width: `${pct}%`, backgroundColor: p.cor }} /></span>
                          <span className="text-xs text-gray-500 tabular-nums w-9 text-right">{pct.toFixed(0)}%</span>
                        </div>
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums text-gray-700">{g.engajaram} <span className="text-xs text-gray-400">({g.leads ? Math.round((g.engajaram / g.leads) * 100) : 0}%)</span></td>
                      <td className="px-2 py-2 text-right tabular-nums text-indigo-700">{g.qualificados} <span className="text-xs text-gray-400">({g.leads ? Math.round((g.qualificados / g.leads) * 100) : 0}%)</span></td>
                      <td className="px-2 py-2 text-right tabular-nums text-emerald-700">{g.fechados}</td>
                      <td className="px-2 py-2 text-right tabular-nums text-violet-700">{g.protocolados}</td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t border-gray-200 bg-gray-50 font-semibold text-gray-700">
                  <td className="px-4 py-2">Total</td>
                  <td className="px-2 py-2 text-right tabular-nums">{origens.data.total}</td>
                  <td></td>
                  <td className="px-2 py-2 text-right tabular-nums">{origens.data.grupos.reduce((a, g) => a + g.engajaram, 0)}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{origens.data.grupos.reduce((a, g) => a + g.qualificados, 0)}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{origens.data.grupos.reduce((a, g) => a + g.fechados, 0)}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{origens.data.grupos.reduce((a, g) => a + g.protocolados, 0)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>

      <MetaCapiPainel />

      {/* Alternância: por dia × lista de leads */}
      <div className="flex items-center gap-1 mb-3">
        {([["dias", "Por dia", CalendarDays], ["leads", "Lista de leads", List]] as const).map(([k, label, Icon]) => (
          <button key={k} onClick={() => setVisao(k)}
            className={`inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg border ${visao === k ? "bg-gray-900 text-white border-gray-900" : "bg-white text-gray-600 border-gray-200 hover:bg-gray-50"}`}>
            <Icon size={14} /> {label}
          </button>
        ))}
        {visao === "leads" && <span className="text-xs text-gray-400 ml-2">um lead por linha · clique para abrir a conversa</span>}
      </div>

      {visao === "leads" && <PainelLeads de={de} ate={ate} pipelineIds={pipesSel} />}

      {/* Tabela diária */}
      <div className={`bg-white rounded-xl border border-gray-200 overflow-hidden ${visao === "leads" ? "hidden" : ""}`}>
        <div className="flex items-center justify-between px-4 py-2 border-b border-gray-100">
          <span className="text-xs text-gray-400">
            {linhas.length} dias no período · {diasComMovimento} com movimento
          </span>
          <label className="flex items-center gap-1.5 text-xs text-gray-500 cursor-pointer">
            <input
              type="checkbox"
              checked={ocultarVazios}
              onChange={e => setOcultarVazios(e.target.checked)}
              className="rounded"
            />
            Ocultar dias sem movimento
          </label>
        </div>
        <div className="grid grid-cols-[1fr_repeat(3,minmax(72px,88px))] gap-2 px-4 py-2.5 border-b border-gray-100 text-[11px] uppercase tracking-wide text-gray-400">
          <span>Data</span>
          <span className="text-right">Novos</span>
          <span className="text-right">Fechados</span>
          <span className="text-right">Protoc.</span>
        </div>

        {resumo.isLoading ? (
          <div className="p-8 text-center text-sm text-gray-400">Carregando…</div>
        ) : linhasVisiveis.length === 0 ? (
          <div className="p-8 text-center text-sm text-gray-400">Sem dados no período.</div>
        ) : (
          linhasVisiveis.map(l => {
            const vazio = !l.novos && !l.fechados && !l.protocolados;
            return (
              <div key={l.dia} className="border-b border-gray-50 last:border-0">
                <div
                  className={`grid grid-cols-[1fr_repeat(3,minmax(72px,88px))] gap-2 px-4 py-2 items-center ${
                    ehFimDeSemana(l.dia) ? "bg-gray-50/60" : ""
                  }`}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-sm text-gray-800 tabular-nums">{fmtDia(l.dia)}</span>
                    <span className="text-xs text-gray-400 capitalize">{diaSemana(l.dia)}</span>
                    {l.novos > 0 && (
                      <span
                        className="hidden md:flex h-1.5 rounded-full overflow-hidden gap-px"
                        style={{ width: `${Math.round((l.novos / maxNovos) * 120)}px` }}
                        title={Object.entries((l as any).origens ?? {}).map(([k, v]) => `${PLATAFORMA_PAINEL[k]?.nome ?? k}: ${v}`).join(" · ")}
                      >
                        {Object.entries((l as any).origens ?? {}).map(([k, v]) => (
                          <i key={k} className="block h-full" style={{ width: `${(Number(v) / l.novos) * 100}%`, backgroundColor: PLATAFORMA_PAINEL[k]?.cor ?? "#d4d4d8" }} />
                        ))}
                      </span>
                    )}
                  </div>
                  {TIPOS.map(t => {
                    const v = l[t.chave];
                    const on = aberto?.dia === l.dia && aberto.tipo === t.chave;
                    return (
                      <button
                        key={t.chave}
                        disabled={!v}
                        onClick={() => setAberto(on ? null : { dia: l.dia, tipo: t.chave })}
                        className={`flex items-center justify-end gap-1 text-sm tabular-nums rounded px-1.5 py-0.5 transition-colors ${
                          !v ? "text-gray-300 cursor-default"
                             : on ? `${t.corBg} ${t.cor} font-semibold`
                                  : `${t.cor} hover:${t.corBg} font-medium`
                        }`}
                      >
                        {v > 0 && (on ? <ChevronDown size={12} /> : <ChevronRight size={12} />)}
                        {v}
                      </button>
                    );
                  })}
                </div>
                {aberto?.dia === l.dia && !vazio && (
                  <div className="bg-gray-50/70 border-t border-gray-100">
                    <ListaDoDia dia={l.dia} tipo={aberto.tipo} pipelineIds={pipesSel} />
                  </div>
                )}
              </div>
            );
          })
        )}

        {resumo.data && (
          <div className="grid grid-cols-[1fr_repeat(3,minmax(72px,88px))] gap-2 px-4 py-2.5 bg-gray-50 border-t border-gray-200 text-sm font-semibold text-gray-700">
            <span>Total</span>
            <span className="text-right tabular-nums">{resumo.data.totais.novos}</span>
            <span className="text-right tabular-nums">{resumo.data.totais.fechados}</span>
            <span className="text-right tabular-nums">{resumo.data.totais.protocolados}</span>
          </div>
        )}
      </div>

      <p className="text-xs text-gray-400 mt-3">
        “Novos” usa a data de entrada no funil — a criação do contato ou, se houver histórico
        de etapas anterior a ela (caso dos contatos importados), a primeira movimentação.
        “Fechados” e “Protocolados” contam a data em que o contato <b>entrou</b> na etapa.
      </p>
    </div>
  );
}
