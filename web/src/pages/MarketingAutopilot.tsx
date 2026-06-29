import { useState, useEffect } from "react";
import {
  BarChart2, Settings, FileVideo, Calendar, ScrollText,
  RefreshCw, Play, Pause, Zap, ChevronDown, ChevronUp,
  Copy, RotateCcw, AlertTriangle, CheckCircle, XCircle,
  Plus, Trash2, Image, Info, ExternalLink,
} from "lucide-react";
import { trpc } from "../lib/trpc";

// ─── tipos locais ─────────────────────────────────────────────────────────────

type Tab = "dashboard" | "campanhas" | "conteudo" | "configuracoes" | "log";

type Campanha = {
  id: string; nome: string; plataforma: string; status: string;
  orcamentoDiario: number | null; cpaMeta: number | null; roasMeta: number | null;
  autonomia: string; impressoes: number; cliques: number; gastoTotal: number;
  cpaAtual: number | null; roasAtual: number | null; ctrAtual: number | null;
  kpiVioladoCount: number; ultimaSincEm: string | null;
  criativos: { id: string; nome: string; status: string; ctr: number | null; cpc: number | null; pausadoPorIa: boolean }[];
};

type Roteiro = {
  id: string; advogadoNome: string; areaDireito: string; tema: string; formato: string;
  titulo: string; caption: string; hashtags: string[]; dicasGravacao: string[];
  status: string; criadoEm: string;
  cenas: { ordem: number; descricao: string; duracao: string; textoNarrado: string; dicaGravacao: string }[];
};

type Publicacao = {
  id: string; titulo: string; legenda: string; hashtags: string[]; urlMidia: string | null;
  status: string; agendadoPara: string | null; publicadoEm: string | null; idPostIg: string | null;
  alcance: number | null; likes: number | null; plays: number | null;
  roteiro: { titulo: string; advogadoNome: string } | null;
};

type LogAcao = {
  id: string; tipo: string; entidadeTipo: string; motivoIa: string | null;
  revertivel: boolean; revertido: boolean; ok: boolean; erroDetalhe: string | null;
  valorAntes: any; valorDepois: any; criadoEm: string;
};

// ─── helpers ─────────────────────────────────────────────────────────────────

const STATUS_BADGE: Record<string, { bg: string; color: string; label: string }> = {
  ATIVA:       { bg: "#d1fae5", color: "#065f46", label: "Ativa" },
  PAUSADA:     { bg: "#fef3c7", color: "#92400e", label: "Pausada" },
  ARQUIVADA:   { bg: "#f3f4f6", color: "#6b7280", label: "Arquivada" },
  RASCUNHO:    { bg: "#e0e7ff", color: "#3730a3", label: "Rascunho" },
  AGENDADO:    { bg: "#dbeafe", color: "#1e40af", label: "Agendado" },
  PUBLICADO:   { bg: "#d1fae5", color: "#065f46", label: "Publicado" },
  FALHOU:      { bg: "#fee2e2", color: "#991b1b", label: "Falhou" },
  PROCESSANDO_CONTAINER: { bg: "#fef3c7", color: "#92400e", label: "Processando..." },
  AGUARDANDO_MIDIA:      { bg: "#e0e7ff", color: "#3730a3", label: "Aguard. mídia" },
  GERADO:   { bg: "#dbeafe", color: "#1e40af", label: "Gerado" },
  GRAVADO:  { bg: "#fef3c7", color: "#92400e", label: "Gravado" },
  EDITADO:  { bg: "#e0e7ff", color: "#3730a3", label: "Editado" },
  APROVADO: { bg: "#d1fae5", color: "#065f46", label: "Aprovado" },
};

function Badge({ status }: { status: string }) {
  const s = STATUS_BADGE[status] ?? { bg: "#f3f4f6", color: "#374151", label: status };
  return (
    <span style={{
      background: s.bg, color: s.color,
      fontSize: 11, fontWeight: 600, padding: "2px 8px",
      fontFamily: "var(--avoce-font-mono)", letterSpacing: "0.05em",
    }}>
      {s.label}
    </span>
  );
}

function Kicker({ children }: { children: React.ReactNode }) {
  return (
    <p style={{
      fontFamily: "var(--avoce-font-mono)", fontSize: 10, fontWeight: 600,
      letterSpacing: "var(--avoce-tracking-kicker)", textTransform: "uppercase",
      color: "var(--avoce-mute)", marginBottom: "var(--avoce-space-2)",
    }}>
      {children}
    </p>
  );
}

function Card({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{
      background: "var(--avoce-paper)", border: "var(--avoce-border)",
      padding: "var(--avoce-space-5)", ...style,
    }}>
      {children}
    </div>
  );
}

function MetricCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <Card>
      <Kicker>{label}</Kicker>
      <p style={{ fontFamily: "var(--avoce-font-mono)", fontSize: 28, fontWeight: 700, color: "var(--avoce-navy)", lineHeight: 1 }}>
        {value}
      </p>
      {sub && <p style={{ fontSize: 12, color: "var(--avoce-mute)", marginTop: 4 }}>{sub}</p>}
    </Card>
  );
}

function Btn({
  onClick, disabled, children, variant = "primary", size = "md",
}: {
  onClick?: () => void; disabled?: boolean; children: React.ReactNode;
  variant?: "primary" | "secondary" | "danger" | "ghost"; size?: "sm" | "md";
}) {
  const styles: Record<string, React.CSSProperties> = {
    primary:   { background: "var(--avoce-navy)", color: "var(--avoce-cream)", border: "none" },
    secondary: { background: "transparent", color: "var(--avoce-navy)", border: "var(--avoce-border)" },
    danger:    { background: "#fee2e2", color: "#991b1b", border: "1px solid #fca5a5" },
    ghost:     { background: "transparent", color: "var(--avoce-mute)", border: "none" },
  };
  const sizes: Record<string, React.CSSProperties> = {
    sm: { fontSize: 12, padding: "4px 10px" },
    md: { fontSize: 13, padding: "7px 16px" },
  };
  return (
    <button
      onClick={onClick} disabled={disabled}
      style={{ ...styles[variant], ...sizes[size], cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.5 : 1, fontFamily: "var(--avoce-font-sans)", fontWeight: 500, display: "inline-flex", alignItems: "center", gap: 6 } as React.CSSProperties}
    >
      {children}
    </button>
  );
}

function Input({ label, value, onChange, type = "text", placeholder }: {
  label?: string; value: string; onChange: (v: string) => void;
  type?: string; placeholder?: string;
}) {
  return (
    <div style={{ marginBottom: "var(--avoce-space-4)" }}>
      {label && <Kicker>{label}</Kicker>}
      <input
        type={type} value={value} onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={{
          width: "100%", padding: "8px 12px", fontSize: 13,
          border: "var(--avoce-border)", background: "var(--avoce-cream)",
          fontFamily: "var(--avoce-font-sans)", color: "var(--avoce-navy)",
          outline: "none", boxSizing: "border-box",
        }}
      />
    </div>
  );
}

function Select({ label, value, onChange, options }: {
  label?: string; value: string; onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div style={{ marginBottom: "var(--avoce-space-4)" }}>
      {label && <Kicker>{label}</Kicker>}
      <select
        value={value} onChange={(e) => onChange(e.target.value)}
        style={{
          width: "100%", padding: "8px 12px", fontSize: 13,
          border: "var(--avoce-border)", background: "var(--avoce-cream)",
          fontFamily: "var(--avoce-font-sans)", color: "var(--avoce-navy)",
          outline: "none",
        }}
      >
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}

// ─── Resultado da análise Claude ─────────────────────────────────────────────

type AcaoResultado = { tipo: string; entidadeId: string; entidadeTipo: string; valorNovo?: number; motivo: string };

const ACAO_COR: Record<string, { bg: string; border: string; color: string; icon: string }> = {
  pausar_campanha:   { bg: "#fee2e2", border: "#fca5a5", color: "#991b1b", icon: "⏸" },
  pausar_criativo:   { bg: "#fef3c7", border: "#fde68a", color: "#92400e", icon: "⏸" },
  ajustar_orcamento: { bg: "#dbeafe", border: "#93c5fd", color: "#1e40af", icon: "📉" },
  escalar_orcamento: { bg: "#d1fae5", border: "#6ee7b7", color: "#065f46", icon: "📈" },
  alerta:            { bg: "#fef3c7", border: "#fde68a", color: "#92400e", icon: "⚠️" },
};

function ResultadoClaude({ acoes }: { acoes: AcaoResultado[] }) {
  if (acoes.length === 0) {
    return (
      <div style={{ padding: "10px 14px", background: "#f0fdf4", border: "1px solid #86efac", fontSize: 13, color: "#166534", display: "flex", alignItems: "center", gap: 8 }}>
        <CheckCircle size={14} color="#166534" />
        Claude analisou e não encontrou ações necessárias no momento.
      </div>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--avoce-space-2)" }}>
      <p style={{ fontFamily: "var(--avoce-font-mono)", fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--avoce-mute)", marginBottom: 2 }}>
        Relatório Claude — {acoes.length} ação(ões)
      </p>
      {acoes.map((a, i) => {
        const s = ACAO_COR[a.tipo] ?? { bg: "#f3f4f6", border: "#d1d5db", color: "#374151", icon: "ℹ️" };
        return (
          <div key={i} style={{ padding: "10px 14px", background: s.bg, border: `1px solid ${s.border}`, display: "flex", gap: 10, alignItems: "flex-start" }}>
            <span style={{ fontSize: 16, lineHeight: 1.2, flexShrink: 0 }}>{s.icon}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <span style={{ fontFamily: "var(--avoce-font-mono)", fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: s.color }}>
                {a.tipo.replace(/_/g, " ")}
                {a.valorNovo != null && ` → R$ ${a.valorNovo.toFixed(2)}`}
              </span>
              <p style={{ margin: "2px 0 0", fontSize: 13, color: s.color, lineHeight: 1.5 }}>{a.motivo}</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Tab: Dashboard ───────────────────────────────────────────────────────────

function TabDashboard({ projetoId }: { projetoId: string }) {
  const { data: campanhas } = trpc.mkt.listCampanhas.useQuery({ projetoId });
  const { data: publicacoes } = trpc.mkt.listPublicacoes.useQuery({ projetoId });
  const { data: logs } = trpc.mkt.listLogs.useQuery({ projetoId, limit: 6 });
  const { data: tokenStatus } = trpc.mkt.getTokenStatus.useQuery({ projetoId });

  const utils = trpc.useUtils();
  const syncMut = trpc.mkt.syncCampanhas.useMutation({
    onSuccess: () => utils.mkt.listCampanhas.invalidate({ projetoId }),
  });
  const analisarMut = trpc.mkt.analisarComClaude.useMutation({
    onSuccess: () => {
      utils.mkt.listCampanhas.invalidate({ projetoId });
      utils.mkt.listLogs.invalidate({ projetoId });
    },
  });

  const gastoTotal = campanhas?.reduce((s, c) => s + c.gastoTotal, 0) ?? 0;
  const campanhasAtivas = campanhas?.filter((c) => c.status === "ATIVA").length ?? 0;
  const postsPublicados = publicacoes?.filter((p) => p.status === "PUBLICADO").length ?? 0;
  const aguardandoAprovacao = publicacoes?.filter((p) => p.status === "RASCUNHO") ?? [];

  const diasMeta = tokenStatus?.metaDiasRestantes;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--avoce-space-6)" }}>
      {/* Token alert */}
      {diasMeta !== null && diasMeta !== undefined && diasMeta <= 30 && (
        <div style={{
          background: diasMeta <= 7 ? "#fee2e2" : "#fef3c7",
          border: `1px solid ${diasMeta <= 7 ? "#fca5a5" : "#fde68a"}`,
          padding: "var(--avoce-space-3) var(--avoce-space-4)",
          display: "flex", alignItems: "center", gap: "var(--avoce-space-3)",
        }}>
          <AlertTriangle size={16} color={diasMeta <= 7 ? "#991b1b" : "#92400e"} />
          <span style={{ fontSize: 13, color: diasMeta <= 7 ? "#991b1b" : "#92400e" }}>
            Token Meta expira em <strong>{diasMeta} dias</strong>. Reconecte a conta em Configurações.
          </span>
        </div>
      )}

      {/* Métricas */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "var(--avoce-space-4)" }}>
        <MetricCard label="Gasto Total" value={`R$ ${gastoTotal.toFixed(2)}`} sub="últimos 7 dias (Meta)" />
        <MetricCard label="Campanhas Ativas" value={campanhasAtivas} />
        <MetricCard label="Posts Publicados" value={postsPublicados} />
        <MetricCard label="Token Meta" value={diasMeta != null ? `${diasMeta}d` : "—"} sub="dias até expirar" />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--avoce-space-6)" }}>
        {/* Ações rápidas */}
        <Card>
          <Kicker>Ações rápidas</Kicker>
          <div style={{ display: "flex", gap: "var(--avoce-space-3)", flexWrap: "wrap" }}>
            <Btn onClick={() => syncMut.mutate({ projetoId })} disabled={syncMut.isPending}>
              <RefreshCw size={13} />
              {syncMut.isPending ? "Sincronizando..." : "Sincronizar campanhas"}
            </Btn>
            <Btn variant="secondary" onClick={() => analisarMut.mutate({ projetoId })} disabled={analisarMut.isPending}>
              <Zap size={13} />
              {analisarMut.isPending ? "Analisando..." : "Analisar com Claude"}
            </Btn>
          </div>
          {analisarMut.isError && (
            <div style={{ marginTop: "var(--avoce-space-3)", padding: "10px 14px", background: "#fee2e2", border: "1px solid #fca5a5", fontSize: 13, color: "#991b1b" }}>
              Erro na análise: {analisarMut.error?.message}
            </div>
          )}
          {analisarMut.data && (
            <div style={{ marginTop: "var(--avoce-space-4)" }}>
              <ResultadoClaude acoes={analisarMut.data.acoes} />
            </div>
          )}
        </Card>

        {/* Posts aguardando aprovação */}
        <Card>
          <Kicker>Aguardando aprovação ({aguardandoAprovacao.length})</Kicker>
          {aguardandoAprovacao.length === 0 ? (
            <p style={{ fontSize: 13, color: "var(--avoce-mute)" }}>Nenhum post pendente.</p>
          ) : (
            aguardandoAprovacao.slice(0, 4).map((p) => (
              <div key={p.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", borderBottom: "var(--avoce-border-soft)" }}>
                <span style={{ fontSize: 13, color: "var(--avoce-navy)" }}>{p.titulo}</span>
                <Badge status={p.status} />
              </div>
            ))
          )}
        </Card>
      </div>

      {/* Últimas ações do log */}
      <Card>
        <Kicker>Últimas ações automatizadas</Kicker>
        {!logs?.length ? (
          <p style={{ fontSize: 13, color: "var(--avoce-mute)" }}>Nenhuma ação registrada ainda.</p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <tbody>
              {logs.map((l) => (
                <tr key={l.id} style={{ borderBottom: "var(--avoce-border-soft)" }}>
                  <td style={{ padding: "8px 0", width: 20 }}>
                    {l.ok ? <CheckCircle size={14} color="#065f46" /> : <XCircle size={14} color="#991b1b" />}
                  </td>
                  <td style={{ padding: "8px 12px", color: "var(--avoce-navy)", fontWeight: 500 }}>{l.tipo.replace(/_/g, " ")}</td>
                  <td style={{ padding: "8px 0", color: "var(--avoce-mute)", maxWidth: 300 }}>{l.motivoIa?.slice(0, 80)}</td>
                  <td style={{ padding: "8px 0 8px 12px", color: "var(--avoce-mute-soft)", fontFamily: "var(--avoce-font-mono)", fontSize: 11, whiteSpace: "nowrap" }}>
                    {new Date(l.criadoEm).toLocaleString("pt-BR")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

// ─── Tab: Campanhas ───────────────────────────────────────────────────────────

function TabCampanhas({ projetoId }: { projetoId: string }) {
  const { data: campanhas, isLoading } = trpc.mkt.listCampanhas.useQuery({ projetoId });
  const utils = trpc.useUtils();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [kpiEdit, setKpiEdit] = useState<Record<string, { cpaMeta: string; roasMeta: string; autonomia: string }>>({});

  const syncMut = trpc.mkt.syncCampanhas.useMutation({ onSuccess: () => utils.mkt.listCampanhas.invalidate({ projetoId }) });
  const pausarMut = trpc.mkt.pausarCampanha.useMutation({ onSuccess: () => utils.mkt.listCampanhas.invalidate({ projetoId }) });
  const ativarMut = trpc.mkt.ativarCampanha.useMutation({ onSuccess: () => utils.mkt.listCampanhas.invalidate({ projetoId }) });
  const kpiMut = trpc.mkt.updateCampanhaKpis.useMutation({ onSuccess: () => utils.mkt.listCampanhas.invalidate({ projetoId }) });
  const analisarMut = trpc.mkt.analisarComClaude.useMutation({ onSuccess: () => { utils.mkt.listCampanhas.invalidate({ projetoId }); utils.mkt.listLogs.invalidate({ projetoId }); } });

  function getKpi(c: Campanha) {
    return kpiEdit[c.id] ?? { cpaMeta: c.cpaMeta?.toString() ?? "", roasMeta: c.roasMeta?.toString() ?? "", autonomia: c.autonomia };
  }

  function saveKpis(id: string) {
    const kpi = kpiEdit[id];
    if (!kpi) return;
    kpiMut.mutate({
      id,
      cpaMeta: kpi.cpaMeta ? parseFloat(kpi.cpaMeta) : null,
      roasMeta: kpi.roasMeta ? parseFloat(kpi.roasMeta) : null,
      autonomia: kpi.autonomia as any,
    });
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--avoce-space-4)" }}>
      <div style={{ display: "flex", gap: "var(--avoce-space-3)" }}>
        <Btn onClick={() => syncMut.mutate({ projetoId })} disabled={syncMut.isPending}>
          <RefreshCw size={13} />{syncMut.isPending ? "Sincronizando..." : "Sincronizar agora"}
        </Btn>
        <Btn variant="secondary" onClick={() => analisarMut.mutate({ projetoId })} disabled={analisarMut.isPending}>
          <Zap size={13} />{analisarMut.isPending ? "Analisando com Claude..." : "Analisar com Claude"}
        </Btn>
      </div>

      {syncMut.data && !syncMut.data.ok && (
        <div style={{ background: "#fee2e2", padding: "var(--avoce-space-3)", fontSize: 13, color: "#991b1b" }}>
          Erros na sincronização: {syncMut.data.erros.join(" | ")}
        </div>
      )}
      {analisarMut.isError && (
        <div style={{ padding: "10px 14px", background: "#fee2e2", border: "1px solid #fca5a5", fontSize: 13, color: "#991b1b" }}>
          Erro na análise: {analisarMut.error?.message}
        </div>
      )}
      {analisarMut.data && <ResultadoClaude acoes={analisarMut.data.acoes} />}

      {isLoading ? (
        <p style={{ color: "var(--avoce-mute)", fontSize: 13 }}>Carregando campanhas...</p>
      ) : !campanhas?.length ? (
        <Card><p style={{ fontSize: 13, color: "var(--avoce-mute)" }}>Nenhuma campanha sincronizada. Clique em "Sincronizar agora" para importar do Meta/Google.</p></Card>
      ) : (
        campanhas.map((c) => {
          const kpi = getKpi(c);
          const isOpen = expanded === c.id;
          return (
            <Card key={c.id}>
              {/* Cabeçalho */}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "var(--avoce-space-4)" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "var(--avoce-space-2)", marginBottom: 4 }}>
                    <Badge status={c.status} />
                    <span style={{ fontFamily: "var(--avoce-font-mono)", fontSize: 10, color: "var(--avoce-mute)", letterSpacing: "0.05em" }}>
                      {c.plataforma}
                    </span>
                  </div>
                  <p style={{ fontWeight: 600, fontSize: 14, color: "var(--avoce-navy)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {c.nome}
                  </p>
                </div>

                {/* Métricas inline */}
                <div style={{ display: "flex", gap: "var(--avoce-space-6)", flexShrink: 0 }}>
                  {[
                    { label: "Gasto", val: `R$ ${c.gastoTotal.toFixed(2)}` },
                    { label: "CPA", val: c.cpaAtual ? `R$ ${c.cpaAtual.toFixed(2)}` : "—" },
                    { label: "ROAS", val: c.roasAtual?.toFixed(2) ?? "—" },
                    { label: "CTR", val: c.ctrAtual ? `${(c.ctrAtual * 100).toFixed(2)}%` : "—" },
                  ].map((m) => (
                    <div key={m.label} style={{ textAlign: "right" }}>
                      <p style={{ fontFamily: "var(--avoce-font-mono)", fontSize: 10, color: "var(--avoce-mute)", letterSpacing: "0.05em" }}>{m.label}</p>
                      <p style={{ fontFamily: "var(--avoce-font-mono)", fontSize: 14, fontWeight: 600, color: "var(--avoce-navy)" }}>{m.val}</p>
                    </div>
                  ))}
                </div>

                {/* Ações */}
                <div style={{ display: "flex", gap: "var(--avoce-space-2)", flexShrink: 0 }}>
                  {c.status === "ATIVA" ? (
                    <Btn size="sm" variant="secondary" onClick={() => pausarMut.mutate({ id: c.id })} disabled={pausarMut.isPending}>
                      <Pause size={12} /> Pausar
                    </Btn>
                  ) : (
                    <Btn size="sm" variant="secondary" onClick={() => ativarMut.mutate({ id: c.id })} disabled={ativarMut.isPending}>
                      <Play size={12} /> Ativar
                    </Btn>
                  )}
                  <button
                    onClick={() => setExpanded(isOpen ? null : c.id)}
                    style={{ background: "transparent", border: "none", cursor: "pointer", color: "var(--avoce-mute)" }}
                  >
                    {isOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                  </button>
                </div>
              </div>

              {/* Painel expandido — KPIs + criativos */}
              {isOpen && (
                <div style={{ marginTop: "var(--avoce-space-5)", borderTop: "var(--avoce-border-soft)", paddingTop: "var(--avoce-space-5)" }}>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "var(--avoce-space-4)", marginBottom: "var(--avoce-space-4)" }}>
                    <div>
                      <Kicker>CPA máximo (R$)</Kicker>
                      <input
                        type="number" value={kpi.cpaMeta}
                        onChange={(e) => setKpiEdit((prev) => ({ ...prev, [c.id]: { ...getKpi(c), cpaMeta: e.target.value } }))}
                        style={{ width: "100%", padding: "7px 10px", border: "var(--avoce-border)", background: "var(--avoce-cream)", fontFamily: "var(--avoce-font-mono)", fontSize: 13 }}
                      />
                    </div>
                    <div>
                      <Kicker>ROAS mínimo</Kicker>
                      <input
                        type="number" value={kpi.roasMeta}
                        onChange={(e) => setKpiEdit((prev) => ({ ...prev, [c.id]: { ...getKpi(c), roasMeta: e.target.value } }))}
                        style={{ width: "100%", padding: "7px 10px", border: "var(--avoce-border)", background: "var(--avoce-cream)", fontFamily: "var(--avoce-font-mono)", fontSize: 13 }}
                      />
                    </div>
                    <div>
                      <Kicker>Autonomia</Kicker>
                      <select
                        value={kpi.autonomia}
                        onChange={(e) => setKpiEdit((prev) => ({ ...prev, [c.id]: { ...getKpi(c), autonomia: e.target.value } }))}
                        style={{ width: "100%", padding: "7px 10px", border: "var(--avoce-border)", background: "var(--avoce-cream)", fontFamily: "var(--avoce-font-sans)", fontSize: 13 }}
                      >
                        <option value="TOTAL">Total — age sozinho</option>
                        <option value="NOTIFICAR">Notificar antes de agir</option>
                        <option value="SUGERIR">Apenas sugerir</option>
                      </select>
                    </div>
                  </div>
                  <Btn size="sm" onClick={() => saveKpis(c.id)} disabled={kpiMut.isPending}>
                    {kpiMut.isPending ? "Salvando..." : "Salvar KPIs"}
                  </Btn>

                  {c.criativos.length > 0 && (
                    <div style={{ marginTop: "var(--avoce-space-5)" }}>
                      <Kicker>Criativos ({c.criativos.length})</Kicker>
                      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                        <thead>
                          <tr style={{ borderBottom: "var(--avoce-border)" }}>
                            {["Nome", "Status", "CTR", "CPC"].map((h) => (
                              <th key={h} style={{ padding: "6px 8px", textAlign: "left", fontFamily: "var(--avoce-font-mono)", fontSize: 10, color: "var(--avoce-mute)", fontWeight: 600, letterSpacing: "0.08em" }}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {c.criativos.map((cr) => (
                            <tr key={cr.id} style={{ borderBottom: "var(--avoce-border-soft)" }}>
                              <td style={{ padding: "6px 8px", color: "var(--avoce-navy)" }}>{cr.nome}</td>
                              <td style={{ padding: "6px 8px" }}>
                                <Badge status={cr.status} />
                                {cr.pausadoPorIa && <span style={{ marginLeft: 4, fontSize: 10, color: "var(--avoce-mute)" }}>(IA)</span>}
                              </td>
                              <td style={{ padding: "6px 8px", fontFamily: "var(--avoce-font-mono)" }}>{cr.ctr != null ? `${(cr.ctr * 100).toFixed(2)}%` : "—"}</td>
                              <td style={{ padding: "6px 8px", fontFamily: "var(--avoce-font-mono)" }}>{cr.cpc != null ? `R$ ${cr.cpc.toFixed(2)}` : "—"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </Card>
          );
        })
      )}
    </div>
  );
}

// ─── Tab: Conteúdo ────────────────────────────────────────────────────────────

function TabConteudo({ projetoId }: { projetoId: string }) {
  const [subTab, setSubTab] = useState<"roteiros" | "calendario">("roteiros");

  return (
    <div>
      <div style={{ display: "flex", gap: 0, marginBottom: "var(--avoce-space-6)", borderBottom: "var(--avoce-border)" }}>
        {(["roteiros", "calendario"] as const).map((t) => (
          <button key={t} onClick={() => setSubTab(t)} style={{
            padding: "10px 20px", border: "none", background: "transparent", cursor: "pointer",
            fontSize: 13, fontWeight: subTab === t ? 600 : 400,
            color: subTab === t ? "var(--avoce-navy)" : "var(--avoce-mute)",
            borderBottom: subTab === t ? "2px solid var(--avoce-navy)" : "2px solid transparent",
            fontFamily: "var(--avoce-font-sans)",
          }}>
            {t === "roteiros" ? "Roteiros IA" : "Calendário Editorial"}
          </button>
        ))}
      </div>
      {subTab === "roteiros" ? <SubTabRoteiros projetoId={projetoId} /> : <SubTabCalendario projetoId={projetoId} />}
    </div>
  );
}

function SubTabRoteiros({ projetoId }: { projetoId: string }) {
  const utils = trpc.useUtils();
  const { data: roteiros } = trpc.mkt.listRoteiros.useQuery({ projetoId });
  const gerarMut = trpc.mkt.gerarRoteiro.useMutation({ onSuccess: () => utils.mkt.listRoteiros.invalidate({ projetoId }) });
  const [expanded, setExpanded] = useState<string | null>(null);
  const [form, setForm] = useState({
    advogadoNome: "", areaDireito: "", tema: "", formato: "REEL", tom: "profissional",
    publicoAlvo: "", cta: "", observacoes: "",
  });

  function up(field: string, val: string) {
    setForm((f) => ({ ...f, [field]: val }));
  }

  async function gerar() {
    if (!form.advogadoNome || !form.tema) return;
    await gerarMut.mutateAsync({ projetoId, ...form, formato: form.formato as any });
    setForm((f) => ({ ...f, tema: "" }));
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--avoce-space-6)" }}>
      {/* Formulário */}
      <Card>
        <Kicker>Gerar novo roteiro</Kicker>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 var(--avoce-space-5)" }}>
          <Input label="Advogado" value={form.advogadoNome} onChange={(v) => up("advogadoNome", v)} placeholder="Ex: Dr. Carlos" />
          <Input label="Área do Direito" value={form.areaDireito} onChange={(v) => up("areaDireito", v)} placeholder="Ex: Direito Trabalhista" />
          <Input label="Tema" value={form.tema} onChange={(v) => up("tema", v)} placeholder="Ex: Horas extras não pagas" />
          <Select label="Formato" value={form.formato} onChange={(v) => up("formato", v)} options={[
            { value: "REEL", label: "Reel (vídeo curto)" },
            { value: "CARROSSEL", label: "Carrossel" },
            { value: "POST", label: "Post simples" },
            { value: "STORY", label: "Story" },
          ]} />
          <Select label="Tom" value={form.tom} onChange={(v) => up("tom", v)} options={[
            { value: "profissional", label: "Profissional" },
            { value: "didático", label: "Didático" },
            { value: "empático", label: "Empático" },
            { value: "urgente", label: "Urgente" },
          ]} />
          <Input label="Público-alvo (opcional)" value={form.publicoAlvo} onChange={(v) => up("publicoAlvo", v)} placeholder="Ex: Trabalhadores CLT" />
          <Input label="CTA (opcional)" value={form.cta} onChange={(v) => up("cta", v)} placeholder="Ex: Chame no WhatsApp agora" />
          <Input label="Observações (opcional)" value={form.observacoes} onChange={(v) => up("observacoes", v)} />
        </div>
        <Btn onClick={gerar} disabled={gerarMut.isPending || !form.advogadoNome || !form.tema}>
          <FileVideo size={13} />
          {gerarMut.isPending ? "Gerando roteiro..." : "Gerar com DeepSeek"}
        </Btn>
        {gerarMut.isError && <p style={{ fontSize: 12, color: "#991b1b", marginTop: 8 }}>Erro: {gerarMut.error.message}</p>}
      </Card>

      {/* Lista de roteiros */}
      {!roteiros?.length ? (
        <p style={{ fontSize: 13, color: "var(--avoce-mute)" }}>Nenhum roteiro gerado ainda.</p>
      ) : (
        roteiros.map((r) => {
          const isOpen = expanded === r.id;
          const cenas = r.cenas as any[];
          return (
            <Card key={r.id}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <div style={{ display: "flex", gap: "var(--avoce-space-2)", marginBottom: 4 }}>
                    <Badge status={r.status} />
                    <span style={{ fontFamily: "var(--avoce-font-mono)", fontSize: 10, color: "var(--avoce-mute)", letterSpacing: "0.05em" }}>{r.formato}</span>
                    <span style={{ fontFamily: "var(--avoce-font-mono)", fontSize: 10, color: "var(--avoce-mute)" }}>{r.advogadoNome}</span>
                  </div>
                  <p style={{ fontWeight: 600, fontSize: 14 }}>{r.titulo}</p>
                  <p style={{ fontSize: 12, color: "var(--avoce-mute)" }}>{r.areaDireito} · {r.tema}</p>
                </div>
                <button onClick={() => setExpanded(isOpen ? null : r.id)} style={{ background: "transparent", border: "none", cursor: "pointer", color: "var(--avoce-mute)" }}>
                  {isOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                </button>
              </div>

              {isOpen && (
                <div style={{ marginTop: "var(--avoce-space-5)", borderTop: "var(--avoce-border-soft)", paddingTop: "var(--avoce-space-5)" }}>
                  {/* Cenas */}
                  <Kicker>Cenas ({cenas.length})</Kicker>
                  <div style={{ display: "flex", flexDirection: "column", gap: "var(--avoce-space-3)", marginBottom: "var(--avoce-space-5)" }}>
                    {cenas.map((cena: any, i: number) => (
                      <div key={i} style={{ background: "var(--avoce-paper-deep)", padding: "var(--avoce-space-4)", display: "grid", gridTemplateColumns: "auto 1fr", gap: "var(--avoce-space-4)" }}>
                        <div style={{ fontFamily: "var(--avoce-font-mono)", fontSize: 22, fontWeight: 700, color: "var(--avoce-gold)", lineHeight: 1 }}>{cena.ordem}</div>
                        <div>
                          <p style={{ fontSize: 11, color: "var(--avoce-mute)", fontFamily: "var(--avoce-font-mono)", marginBottom: 4 }}>{cena.duracao}</p>
                          <p style={{ fontSize: 13, fontWeight: 500, color: "var(--avoce-navy)", marginBottom: 4 }}>{cena.textoNarrado}</p>
                          <p style={{ fontSize: 12, color: "var(--avoce-mute)" }}>{cena.descricao}</p>
                          {cena.dicaGravacao && <p style={{ fontSize: 11, color: "var(--avoce-gold)", marginTop: 4 }}>💡 {cena.dicaGravacao}</p>}
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* Caption */}
                  <Kicker>Caption</Kicker>
                  <div style={{ position: "relative", marginBottom: "var(--avoce-space-5)" }}>
                    <pre style={{ background: "var(--avoce-paper-deep)", padding: "var(--avoce-space-4)", fontSize: 13, whiteSpace: "pre-wrap", fontFamily: "var(--avoce-font-sans)", color: "var(--avoce-navy)", margin: 0 }}>
                      {r.caption}
                    </pre>
                    <button
                      onClick={() => navigator.clipboard.writeText(r.caption)}
                      style={{ position: "absolute", top: 8, right: 8, background: "transparent", border: "none", cursor: "pointer", color: "var(--avoce-mute)" }}
                      title="Copiar caption"
                    >
                      <Copy size={14} />
                    </button>
                  </div>

                  {/* Hashtags */}
                  <Kicker>Hashtags</Kicker>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--avoce-space-2)", marginBottom: "var(--avoce-space-5)" }}>
                    {r.hashtags.map((h, i) => (
                      <span key={i} style={{ background: "var(--avoce-paper-deep)", padding: "3px 10px", fontSize: 12, fontFamily: "var(--avoce-font-mono)", color: "var(--avoce-navy-soft)" }}>
                        #{h}
                      </span>
                    ))}
                    <button onClick={() => navigator.clipboard.writeText(r.hashtags.map((h) => `#${h}`).join(" "))} style={{ background: "transparent", border: "none", cursor: "pointer", color: "var(--avoce-mute)", padding: "3px 6px" }}>
                      <Copy size={12} />
                    </button>
                  </div>

                  {/* Dicas de gravação */}
                  {r.dicasGravacao.length > 0 && (
                    <>
                      <Kicker>Dicas de gravação</Kicker>
                      <ul style={{ margin: 0, paddingLeft: "var(--avoce-space-5)", fontSize: 13, color: "var(--avoce-navy)", lineHeight: 1.7 }}>
                        {r.dicasGravacao.map((d, i) => <li key={i}>{d}</li>)}
                      </ul>
                    </>
                  )}
                </div>
              )}
            </Card>
          );
        })
      )}
    </div>
  );
}

function SubTabCalendario({ projetoId }: { projetoId: string }) {
  const utils = trpc.useUtils();
  const { data: publicacoes } = trpc.mkt.listPublicacoes.useQuery({ projetoId });
  const criarMut = trpc.mkt.createPublicacao.useMutation({ onSuccess: () => utils.mkt.listPublicacoes.invalidate({ projetoId }) });
  const aprovarMut = trpc.mkt.aprovarPublicacao.useMutation({ onSuccess: () => utils.mkt.listPublicacoes.invalidate({ projetoId }) });

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ titulo: "", legenda: "", urlMidia: "", agendadoPara: "" });

  function up(f: string, v: string) { setForm((p) => ({ ...p, [f]: v })); }

  async function criar() {
    await criarMut.mutateAsync({ projetoId, ...form });
    setForm({ titulo: "", legenda: "", urlMidia: "", agendadoPara: "" });
    setShowForm(false);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--avoce-space-4)" }}>
      <div>
        <Btn onClick={() => setShowForm((v) => !v)}>
          <Plus size={13} />{showForm ? "Cancelar" : "Agendar publicação"}
        </Btn>
      </div>

      {showForm && (
        <Card>
          <Kicker>Nova publicação</Kicker>
          <Input label="Título" value={form.titulo} onChange={(v) => up("titulo", v)} />
          <div style={{ marginBottom: "var(--avoce-space-4)" }}>
            <Kicker>Legenda</Kicker>
            <textarea
              value={form.legenda} onChange={(e) => up("legenda", e.target.value)}
              rows={4}
              style={{ width: "100%", padding: "8px 12px", fontSize: 13, border: "var(--avoce-border)", background: "var(--avoce-cream)", fontFamily: "var(--avoce-font-sans)", resize: "vertical", outline: "none", boxSizing: "border-box" }}
            />
          </div>
          <Input label="URL da mídia (imagem ou vídeo)" value={form.urlMidia} onChange={(v) => up("urlMidia", v)} placeholder="https://..." />
          <Input label="Agendar para" value={form.agendadoPara} onChange={(v) => up("agendadoPara", v)} type="datetime-local" />
          <Btn onClick={criar} disabled={criarMut.isPending || !form.titulo}>
            <Calendar size={13} />{criarMut.isPending ? "Salvando..." : "Salvar publicação"}
          </Btn>
        </Card>
      )}

      {!publicacoes?.length ? (
        <p style={{ fontSize: 13, color: "var(--avoce-mute)" }}>Nenhuma publicação no calendário.</p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: "var(--avoce-border)" }}>
              {["Título", "Status", "Agendado para", "Publicado em", "Alcance", "Likes", "Ação"].map((h) => (
                <th key={h} style={{ padding: "8px 12px", textAlign: "left", fontFamily: "var(--avoce-font-mono)", fontSize: 10, color: "var(--avoce-mute)", fontWeight: 600, letterSpacing: "0.08em" }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {publicacoes.map((p) => (
              <tr key={p.id} style={{ borderBottom: "var(--avoce-border-soft)" }}>
                <td style={{ padding: "10px 12px", color: "var(--avoce-navy)", fontWeight: 500, maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.titulo}</td>
                <td style={{ padding: "10px 12px" }}><Badge status={p.status} /></td>
                <td style={{ padding: "10px 12px", fontFamily: "var(--avoce-font-mono)", fontSize: 12, color: "var(--avoce-mute)" }}>
                  {p.agendadoPara ? new Date(p.agendadoPara).toLocaleString("pt-BR") : "—"}
                </td>
                <td style={{ padding: "10px 12px", fontFamily: "var(--avoce-font-mono)", fontSize: 12, color: "var(--avoce-mute)" }}>
                  {p.publicadoEm ? new Date(p.publicadoEm).toLocaleString("pt-BR") : "—"}
                </td>
                <td style={{ padding: "10px 12px", fontFamily: "var(--avoce-font-mono)", fontSize: 12 }}>{p.alcance ?? "—"}</td>
                <td style={{ padding: "10px 12px", fontFamily: "var(--avoce-font-mono)", fontSize: 12 }}>{p.likes ?? "—"}</td>
                <td style={{ padding: "10px 12px" }}>
                  {p.status === "RASCUNHO" && (
                    <Btn size="sm" variant="secondary" onClick={() => {
                      const dt = prompt("Data/hora para publicar (ISO):", new Date().toISOString().slice(0, 16));
                      if (dt) aprovarMut.mutate({ id: p.id, agendadoPara: dt });
                    }}>
                      Aprovar
                    </Btn>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ─── Tab: Configurações ───────────────────────────────────────────────────────

type ConfigDef = {
  categoria: string;
  chave: string;
  label: string;
  tipo: "texto" | "senha";
  placeholder?: string;
  hint: string;
  link?: { label: string; url: string };
};

const CONFIGS_DEFS: ConfigDef[] = [
  {
    categoria: "meta", chave: "meta_app_id", label: "App ID", tipo: "texto",
    placeholder: "Ex: 123456789012345",
    hint: "ID do seu app no Meta for Developers. Acesse developers.facebook.com → Meus Apps → selecione o app → o App ID aparece no topo do painel.",
    link: { label: "Abrir Meta for Developers", url: "https://developers.facebook.com/apps" },
  },
  {
    categoria: "meta", chave: "meta_app_secret", label: "App Secret", tipo: "senha",
    placeholder: "cole o App Secret aqui",
    hint: "Segredo do app. No painel do app: Configurações → Básico → App Secret. Clique em 'Mostrar' para copiar. Nunca compartilhe este valor.",
  },
  {
    categoria: "meta", chave: "meta_access_token", label: "Access Token", tipo: "senha",
    placeholder: "EAAxxxxxx...",
    hint: "Token de acesso de longa duração (válido ~60 dias). Passo a passo: (1) No Graph API Explorer, selecione seu app e gere um token de usuário com as permissões ads_management, pages_manage_posts e instagram_basic. (2) Troque pelo long-lived token: abra a URL /oauth/access_token?grant_type=fb_exchange_token&client_id=APP_ID&client_secret=APP_SECRET&fb_exchange_token=TOKEN_CURTO.",
    link: { label: "Abrir Graph API Explorer", url: "https://developers.facebook.com/tools/explorer" },
  },
  {
    categoria: "meta", chave: "meta_token_expira", label: "Token expira em", tipo: "texto",
    placeholder: "Ex: 2026-07-06",
    hint: "Data de expiração do token no formato YYYY-MM-DD. O sistema alertará automaticamente 30 dias antes. O long-lived token dura ~60 dias — renove-o antes de expirar trocando pelo novo token gerado com o mesmo processo acima.",
  },
  {
    categoria: "meta", chave: "meta_ad_account_id", label: "Ad Account ID", tipo: "texto",
    placeholder: "Ex: 1234567890",
    hint: "ID da conta de anúncios. No Gerenciador de Anúncios (business.facebook.com/adsmanager), clique no nome da conta no topo — o ID aparece como act_XXXXXXXXXX. Informe somente os números (sem o prefixo 'act_').",
    link: { label: "Abrir Gerenciador de Anúncios", url: "https://business.facebook.com/adsmanager" },
  },
  {
    categoria: "meta", chave: "meta_ig_account_id", label: "IG Account ID", tipo: "texto",
    placeholder: "Ex: 9876543210",
    hint: "ID numérico do perfil do Instagram usado para publicar posts. Acesse Meta Business Suite → Configurações → Contas do Instagram → clique na conta → copie o número exibido como 'ID da conta'.",
    link: { label: "Abrir Meta Business Suite", url: "https://business.facebook.com/settings/instagram-accounts" },
  },
  {
    categoria: "google", chave: "google_client_id", label: "Client ID", tipo: "texto",
    placeholder: "XXXXXXXXXX-xxxx.apps.googleusercontent.com",
    hint: "ID do cliente OAuth 2.0. No Google Cloud Console: Credenciais → Criar credencial → ID de cliente OAuth 2.0 → selecione 'Aplicativo da Web'. Adicione o domínio avoce.capium.com.br como origem autorizada.",
    link: { label: "Abrir Google Cloud Credentials", url: "https://console.cloud.google.com/apis/credentials" },
  },
  {
    categoria: "google", chave: "google_client_secret", label: "Client Secret", tipo: "senha",
    placeholder: "GOCSPX-xxxx",
    hint: "Segredo gerado junto com o Client ID OAuth 2.0. Visível na tela de detalhes da credencial no Google Cloud Console. Copie e guarde com segurança.",
  },
  {
    categoria: "google", chave: "google_refresh_token", label: "Refresh Token", tipo: "senha",
    placeholder: "1//04xxxx",
    hint: "Token de longa duração para renovar o acesso sem reautenticar. Obtenha via Google OAuth Playground: (1) Acesse o link abaixo, (2) selecione o escopo https://www.googleapis.com/auth/adwords, (3) insira suas credenciais OAuth, (4) autorize e copie o Refresh Token gerado.",
    link: { label: "Abrir OAuth Playground", url: "https://developers.google.com/oauthplayground" },
  },
  {
    categoria: "google", chave: "google_dev_token", label: "Developer Token", tipo: "senha",
    placeholder: "xxxxxxxxxxxxxxxxxxxx",
    hint: "Token de desenvolvedor da API Google Ads — necessário para fazer qualquer chamada à API. Solicite em Google Ads API Center dentro da sua conta Google Ads (Ferramentas → API Center). A aprovação em nível básico pode ser imediata; aprovação padrão leva alguns dias.",
    link: { label: "Solicitar Developer Token", url: "https://developers.google.com/google-ads/api/docs/get-started/dev-token" },
  },
  {
    categoria: "google", chave: "google_customer_id", label: "Customer ID", tipo: "texto",
    placeholder: "Ex: 1234567890",
    hint: "ID da conta Google Ads — visível no canto superior direito do Gerenciador de Anúncios no formato 123-456-7890. Informe somente os dígitos, sem hífens.",
    link: { label: "Abrir Google Ads", url: "https://ads.google.com" },
  },
  {
    categoria: "ia", chave: "claude_api_key", label: "API Key Claude (Anthropic)", tipo: "senha",
    placeholder: "sk-ant-xxxxxxxxxxxxxxxxxxxx",
    hint: "Chave de API da Anthropic — usada para analisar métricas de campanhas, recomendar pausas/ajustes de orçamento e gerar roteiros. Crie em console.anthropic.com → API Keys. Modelo utilizado: claude-sonnet-4-6.",
    link: { label: "Abrir Anthropic Console", url: "https://console.anthropic.com/settings/keys" },
  },
  {
    categoria: "ia", chave: "deepseek_api_key", label: "API Key DeepSeek (alternativa)", tipo: "senha",
    placeholder: "sk-xxxxxxxxxxxxxxxxxxxx",
    hint: "Chave de API do DeepSeek — alternativa mais econômica ao Claude para análise de campanhas e geração de roteiros. Crie em platform.deepseek.com → API Keys → Create new secret key. Modelo: deepseek-chat.",
    link: { label: "Abrir DeepSeek Platform", url: "https://platform.deepseek.com/api_keys" },
  },
  {
    categoria: "imagem", chave: "image_provider", label: "Provider de Imagens", tipo: "texto",
    placeholder: "openai  |  stability  |  (em branco = desativado)",
    hint: "Provedor para geração automática de imagens em posts e criativos. Opções: 'openai' usa DALL-E 3 (melhor qualidade), 'stability' usa Stable Diffusion (mais barato). Deixe em branco para desativar a geração de imagens.",
  },
  {
    categoria: "imagem", chave: "image_api_key", label: "API Key de Imagens", tipo: "senha",
    placeholder: "sk-xxxx (OpenAI) ou sk-xxxx (Stability)",
    hint: "Chave de API do provedor escolhido acima. Para OpenAI: platform.openai.com/api-keys → Create new secret key. Para Stability AI: platform.stability.ai/account/keys.",
    link: { label: "Abrir OpenAI API Keys", url: "https://platform.openai.com/api-keys" },
  },
];

const CATEGORIA_LABELS: Record<string, string> = {
  meta: "Meta Ads + Instagram",
  google: "Google Ads",
  ia: "IA — análise e roteiros",
  imagem: "Geração de Imagens",
};

const CATEGORIA_INTRO: Record<string, string> = {
  meta:   "Conecte sua conta Meta para sincronizar campanhas, controlar orçamentos e publicar no Instagram automaticamente.",
  google: "Integre o Google Ads para monitorar e otimizar campanhas de pesquisa e display.",
  ia:     "Configure a IA para analisar métricas em tempo real, recomendar pausas/ajustes de orçamento e gerar roteiros. Claude (Anthropic) é o padrão — DeepSeek é a alternativa econômica.",
  imagem: "Configure um provedor de imagens para gerar criativos e thumbnails de posts automaticamente.",
};

function TabConfiguracoes({ projetoId }: { projetoId: string }) {
  const utils = trpc.useUtils();
  const { data: configs } = trpc.mkt.listConfigs.useQuery({ projetoId });
  const upsertMut = trpc.mkt.upsertConfig.useMutation({ onSuccess: () => utils.mkt.listConfigs.invalidate({ projetoId }) });
  const [values, setValues] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<Record<string, boolean>>({});

  function getValor(chave: string): string {
    if (values[chave] !== undefined) return values[chave];
    const cfg = configs?.find((c) => c.chave === chave);
    if (!cfg) return "";
    return cfg.valor ?? "";
  }

  async function salvar(chave: string, tipo: string, categoria: string) {
    const val = values[chave];
    if (val === undefined) return;
    await upsertMut.mutateAsync({ projetoId, chave, valor: val, tipo, categoria });
    setSaved((p) => ({ ...p, [chave]: true }));
    setTimeout(() => setSaved((p) => ({ ...p, [chave]: false })), 2000);
  }

  const categorias = [...new Set(CONFIGS_DEFS.map((d) => d.categoria))];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--avoce-space-8)" }}>
      {categorias.map((cat) => (
        <div key={cat}>
          {/* Cabeçalho da categoria */}
          <div style={{ marginBottom: "var(--avoce-space-5)" }}>
            <Kicker>{CATEGORIA_LABELS[cat] ?? cat}</Kicker>
            {CATEGORIA_INTRO[cat] && (
              <div style={{ display: "flex", gap: "var(--avoce-space-2)", alignItems: "flex-start" }}>
                <Info size={13} color="var(--avoce-navy)" style={{ marginTop: 2, flexShrink: 0 }} />
                <p style={{ fontSize: 13, color: "var(--avoce-navy)", margin: 0, lineHeight: 1.6 }}>{CATEGORIA_INTRO[cat]}</p>
              </div>
            )}
          </div>

          {/* Botão OAuth Meta */}
          {cat === "meta" && (
            <div style={{ marginBottom: "var(--avoce-space-5)" }}>
              <Card style={{ padding: "var(--avoce-space-4) var(--avoce-space-5)", background: "#f0f4ff", border: "1.5px solid #c7d2fe" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--avoce-space-4)", flexWrap: "wrap" }}>
                  <div>
                    <p style={{ fontFamily: "var(--avoce-font-mono)", fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "#3730a3", marginBottom: 4 }}>
                      Conexão OAuth (recomendado)
                    </p>
                    <p style={{ fontSize: 12, color: "#4338ca", margin: 0, lineHeight: 1.6 }}>
                      Configure o <strong>App ID</strong> e o <strong>App Secret</strong> abaixo, depois clique para autorizar automaticamente. O token de longa duração (~60 dias) será salvo sem precisar copiar/colar.
                    </p>
                  </div>
                  <button
                    onClick={() => window.open(`/api/meta/oauth/start?projetoId=${encodeURIComponent(projetoId)}`, "meta_oauth", "width=600,height=700,left=200,top=100")}
                    style={{
                      display: "flex", alignItems: "center", gap: 8,
                      padding: "10px 20px", background: "#1877f2", color: "white",
                      border: "none", borderRadius: 8, fontFamily: "var(--avoce-font-sans)",
                      fontSize: 13, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0,
                    }}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="white"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>
                    Conectar com Meta
                  </button>
                </div>
              </Card>
            </div>
          )}

          {/* Campos */}
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--avoce-space-5)" }}>
            {CONFIGS_DEFS.filter((d) => d.categoria === cat).map((def) => {
              const isSenha = def.tipo === "senha";
              const atual = getValor(def.chave);
              const isConfigurado = !!configs?.find((c) => c.chave === def.chave && c.valor);
              const inputPlaceholder = (isSenha && isConfigurado && atual.startsWith("••••"))
                ? "já configurado — deixe em branco para manter"
                : (def.placeholder ?? "");

              return (
                <Card key={def.chave} style={{ padding: "var(--avoce-space-4) var(--avoce-space-5)" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "var(--avoce-space-6)", flexWrap: "wrap" }}>
                    {/* Lado esquerdo: label + hint */}
                    <div style={{ flex: "1 1 300px", minWidth: 0 }}>
                      <p style={{ fontFamily: "var(--avoce-font-mono)", fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--avoce-navy)", marginBottom: "var(--avoce-space-1)" }}>
                        {def.label}
                        {isConfigurado && (
                          <span style={{ marginLeft: 8, color: "#065f46", fontFamily: "var(--avoce-font-mono)", fontSize: 10, fontWeight: 600 }}>✓ configurado</span>
                        )}
                      </p>
                      <p style={{ fontSize: 12, color: "var(--avoce-mute)", lineHeight: 1.7, margin: 0 }}>
                        {def.hint}
                        {def.link && (
                          <>
                            {" "}
                            <a
                              href={def.link.url} target="_blank" rel="noopener noreferrer"
                              style={{ color: "var(--avoce-navy)", textDecoration: "underline", display: "inline-flex", alignItems: "center", gap: 2, fontWeight: 500 }}
                            >
                              {def.link.label} <ExternalLink size={10} />
                            </a>
                          </>
                        )}
                      </p>
                    </div>

                    {/* Lado direito: input + botão */}
                    <div style={{ flex: "0 0 320px", display: "flex", gap: "var(--avoce-space-2)", alignItems: "flex-start" }}>
                      <input
                        type={isSenha ? "password" : "text"}
                        value={atual.startsWith("••••") ? "" : atual}
                        placeholder={inputPlaceholder}
                        onChange={(e) => setValues((p) => ({ ...p, [def.chave]: e.target.value }))}
                        style={{
                          flex: 1, padding: "8px 10px", fontSize: 13,
                          border: "var(--avoce-border)", background: "var(--avoce-cream)",
                          fontFamily: isSenha ? "var(--avoce-font-mono)" : "var(--avoce-font-sans)",
                          color: "var(--avoce-navy)", outline: "none", minWidth: 0,
                        }}
                      />
                      <Btn
                        size="sm"
                        onClick={() => salvar(def.chave, def.tipo, cat)}
                        disabled={upsertMut.isPending || values[def.chave] === undefined}
                      >
                        {saved[def.chave] ? <CheckCircle size={12} /> : "Salvar"}
                      </Btn>
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Tab: Log ─────────────────────────────────────────────────────────────────

function TabLog({ projetoId }: { projetoId: string }) {
  const [tipoFiltro, setTipoFiltro] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const utils = trpc.useUtils();
  const { data: logs } = trpc.mkt.listLogs.useQuery({ projetoId, tipo: tipoFiltro || undefined, limit: 100 });
  const reverterMut = trpc.mkt.reverterAcao.useMutation({ onSuccess: () => utils.mkt.listLogs.invalidate({ projetoId }) });

  const TIPOS = ["", "campanha_pausada", "campanha_ativada", "criativo_pausado", "orcamento_ajustado", "post_publicado", "alerta", "token_alerta"];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--avoce-space-4)" }}>
      <div>
        <Kicker>Filtrar por tipo</Kicker>
        <select
          value={tipoFiltro} onChange={(e) => setTipoFiltro(e.target.value)}
          style={{ padding: "7px 12px", fontSize: 13, border: "var(--avoce-border)", background: "var(--avoce-cream)", fontFamily: "var(--avoce-font-sans)" }}
        >
          {TIPOS.map((t) => <option key={t} value={t}>{t || "Todos"}</option>)}
        </select>
      </div>

      {!logs?.length ? (
        <p style={{ fontSize: 13, color: "var(--avoce-mute)" }}>Nenhuma ação registrada.</p>
      ) : (
        logs.map((l) => {
          const isOpen = expanded === l.id;
          return (
            <Card key={l.id} style={{ padding: "var(--avoce-space-4)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "var(--avoce-space-4)" }}>
                <div style={{ display: "flex", gap: "var(--avoce-space-3)", flex: 1 }}>
                  <div style={{ marginTop: 2, flexShrink: 0 }}>
                    {l.ok ? <CheckCircle size={15} color="#065f46" /> : <XCircle size={15} color="#991b1b" />}
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: "flex", gap: "var(--avoce-space-2)", marginBottom: 4, flexWrap: "wrap" }}>
                      <span style={{ fontFamily: "var(--avoce-font-mono)", fontSize: 11, fontWeight: 600, color: "var(--avoce-navy)", letterSpacing: "0.05em" }}>
                        {l.tipo.replace(/_/g, " ").toUpperCase()}
                      </span>
                      <span style={{ fontFamily: "var(--avoce-font-mono)", fontSize: 10, color: "var(--avoce-mute)" }}>{l.entidadeTipo}</span>
                    </div>
                    {l.motivoIa && <p style={{ fontSize: 13, color: "var(--avoce-navy)", marginBottom: 2 }}>{l.motivoIa}</p>}
                    {l.erroDetalhe && <p style={{ fontSize: 12, color: "#991b1b" }}>{l.erroDetalhe}</p>}
                  </div>
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: "var(--avoce-space-3)", flexShrink: 0 }}>
                  <span style={{ fontFamily: "var(--avoce-font-mono)", fontSize: 11, color: "var(--avoce-mute-soft)" }}>
                    {new Date(l.criadoEm).toLocaleString("pt-BR")}
                  </span>
                  {(l.valorAntes || l.valorDepois) && (
                    <button onClick={() => setExpanded(isOpen ? null : l.id)} style={{ background: "transparent", border: "none", cursor: "pointer", color: "var(--avoce-mute)" }}>
                      {isOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                    </button>
                  )}
                  {l.revertivel && !l.revertido && (
                    <Btn size="sm" variant="danger" onClick={() => {
                      if (confirm("Reverter esta ação?")) reverterMut.mutate({ id: l.id });
                    }} disabled={reverterMut.isPending}>
                      <RotateCcw size={12} /> Reverter
                    </Btn>
                  )}
                  {l.revertido && <span style={{ fontSize: 11, color: "var(--avoce-mute)", fontFamily: "var(--avoce-font-mono)" }}>revertido</span>}
                </div>
              </div>

              {isOpen && (
                <div style={{ marginTop: "var(--avoce-space-4)", display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--avoce-space-4)" }}>
                  {l.valorAntes && (
                    <div>
                      <Kicker>Antes</Kicker>
                      <pre style={{ background: "#fee2e2", padding: "var(--avoce-space-3)", fontSize: 12, margin: 0, overflow: "auto", color: "#991b1b", fontFamily: "var(--avoce-font-mono)" }}>
                        {JSON.stringify(l.valorAntes, null, 2)}
                      </pre>
                    </div>
                  )}
                  {l.valorDepois && (
                    <div>
                      <Kicker>Depois</Kicker>
                      <pre style={{ background: "#d1fae5", padding: "var(--avoce-space-3)", fontSize: 12, margin: 0, overflow: "auto", color: "#065f46", fontFamily: "var(--avoce-font-mono)" }}>
                        {JSON.stringify(l.valorDepois, null, 2)}
                      </pre>
                    </div>
                  )}
                </div>
              )}
            </Card>
          );
        })
      )}
    </div>
  );
}

// ─── Página principal ─────────────────────────────────────────────────────────

export default function MarketingAutopilot() {
  const [tab, setTab] = useState<Tab>("dashboard");
  const [emitenteId, setEmitenteId] = useState(() => localStorage.getItem("avoce_emitenteId") ?? "");
  const [projetoId, setProjetoId] = useState("");
  const [showNovoProjeto, setShowNovoProjeto] = useState(false);
  const [nomeNovoProjeto, setNomeNovoProjeto] = useState("");
  const [metaOAuthMsg, setMetaOAuthMsg] = useState<{ tipo: "ok" | "erro"; texto: string } | null>(null);

  // Detecta retorno do OAuth Meta
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.has("mkt_meta_ok")) {
      setMetaOAuthMsg({ tipo: "ok", texto: "Meta conectado com sucesso! Token salvo automaticamente." });
      const projeto = params.get("projeto");
      if (projeto) { setProjetoId(projeto); setTab("config"); }
      window.history.replaceState({}, "", window.location.pathname);
    } else if (params.has("mkt_meta_erro")) {
      setMetaOAuthMsg({ tipo: "erro", texto: `Erro ao conectar Meta: ${params.get("mkt_meta_erro")}` });
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

  const utils = trpc.useUtils();
  const { data: empresas } = trpc.empresa.listar.useQuery();
  const { data: projetos, isLoading: loadingProjetos } = trpc.mkt.listProjetos.useQuery(
    { emitenteId },
    { enabled: !!emitenteId },
  );
  const criarProjetoMut = trpc.mkt.createProjeto.useMutation({
    onSuccess: (novo) => {
      utils.mkt.listProjetos.invalidate({ emitenteId });
      setProjetoId(novo.id);
      setShowNovoProjeto(false);
      setNomeNovoProjeto("");
    },
  });

  function handleEmitenteChange(id: string) {
    setEmitenteId(id);
    setProjetoId("");
    localStorage.setItem("avoce_emitenteId", id);
  }

  const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: "dashboard",     label: "Dashboard",      icon: <BarChart2 size={14} /> },
    { id: "campanhas",     label: "Campanhas",      icon: <TrendingUp size={14} /> },
    { id: "conteudo",      label: "Conteúdo",       icon: <FileVideo size={14} /> },
    { id: "configuracoes", label: "Configurações",  icon: <Settings size={14} /> },
    { id: "log",           label: "Log",            icon: <ScrollText size={14} /> },
  ];

  return (
    <div style={{ padding: "var(--avoce-space-8)", maxWidth: 1200, margin: "0 auto" }}>
      {/* Cabeçalho */}
      <div style={{ marginBottom: "var(--avoce-space-8)" }}>
        <h1 style={{ fontFamily: "var(--avoce-font-serif)", fontSize: 28, fontWeight: 400, color: "var(--avoce-navy)", letterSpacing: "var(--avoce-tracking-display)", marginBottom: "var(--avoce-space-6)" }}>
          Marketing Autopilot
        </h1>

        {/* Seletor de empresa + projeto */}
        <div style={{ display: "flex", gap: "var(--avoce-space-4)", alignItems: "flex-end", flexWrap: "wrap" }}>
          <div>
            <Kicker>Empresa emissora</Kicker>
            <select
              value={emitenteId} onChange={(e) => handleEmitenteChange(e.target.value)}
              style={{ padding: "8px 12px", fontSize: 13, border: "var(--avoce-border)", background: "var(--avoce-cream)", fontFamily: "var(--avoce-font-sans)", minWidth: 220 }}
            >
              <option value="">Selecionar empresa...</option>
              {empresas?.map((e: any) => (
                <option key={e.id} value={e.id}>{e.nome}</option>
              ))}
            </select>
          </div>

          {emitenteId && (
            <div>
              <Kicker>Projeto de marketing</Kicker>
              <div style={{ display: "flex", gap: "var(--avoce-space-2)" }}>
                <select
                  value={projetoId} onChange={(e) => setProjetoId(e.target.value)}
                  style={{ padding: "8px 12px", fontSize: 13, border: "var(--avoce-border)", background: "var(--avoce-cream)", fontFamily: "var(--avoce-font-sans)", minWidth: 220 }}
                >
                  <option value="">Selecionar projeto...</option>
                  {projetos?.map((p) => <option key={p.id} value={p.id}>{p.nome}</option>)}
                </select>
                <Btn size="sm" variant="secondary" onClick={() => setShowNovoProjeto((v) => !v)}>
                  <Plus size={12} /> Novo projeto
                </Btn>
              </div>
            </div>
          )}
        </div>

        {/* Banner retorno OAuth Meta */}
        {metaOAuthMsg && (
          <div style={{
            marginTop: "var(--avoce-space-4)", padding: "12px 16px", borderRadius: 8,
            background: metaOAuthMsg.tipo === "ok" ? "#d1fae5" : "#fee2e2",
            border: `1.5px solid ${metaOAuthMsg.tipo === "ok" ? "#6ee7b7" : "#fca5a5"}`,
            display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
          }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: metaOAuthMsg.tipo === "ok" ? "#065f46" : "#991b1b" }}>
              {metaOAuthMsg.tipo === "ok" ? "✅" : "❌"} {metaOAuthMsg.texto}
            </span>
            <button onClick={() => setMetaOAuthMsg(null)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 16, color: "#6b7280" }}>✕</button>
          </div>
        )}

        {/* Criar novo projeto */}
        {showNovoProjeto && emitenteId && (
          <div style={{ marginTop: "var(--avoce-space-4)", display: "flex", gap: "var(--avoce-space-3)", alignItems: "flex-end" }}>
            <div style={{ flex: 1, maxWidth: 300 }}>
              <Kicker>Nome do novo projeto</Kicker>
              <input
                value={nomeNovoProjeto} onChange={(e) => setNomeNovoProjeto(e.target.value)}
                placeholder="Ex: Marketing Q2 2025"
                style={{ width: "100%", padding: "8px 12px", fontSize: 13, border: "var(--avoce-border)", background: "var(--avoce-cream)", fontFamily: "var(--avoce-font-sans)", boxSizing: "border-box" }}
              />
            </div>
            <Btn onClick={() => criarProjetoMut.mutate({ emitenteId, nome: nomeNovoProjeto })} disabled={!nomeNovoProjeto || criarProjetoMut.isPending}>
              {criarProjetoMut.isPending ? "Criando..." : "Criar"}
            </Btn>
          </div>
        )}
      </div>

      {!emitenteId ? (
        <Card>
          <p style={{ fontSize: 13, color: "var(--avoce-mute)" }}>Selecione uma empresa emissora para começar.</p>
        </Card>
      ) : !projetoId ? (
        <Card>
          {loadingProjetos ? (
            <p style={{ fontSize: 13, color: "var(--avoce-mute)" }}>Carregando projetos...</p>
          ) : projetos?.length === 0 ? (
            <div>
              <p style={{ fontSize: 13, color: "var(--avoce-navy)", fontWeight: 500, marginBottom: "var(--avoce-space-3)" }}>
                Nenhum projeto criado ainda. Crie o primeiro projeto para começar.
              </p>
              <div style={{ display: "flex", gap: "var(--avoce-space-3)", alignItems: "flex-end" }}>
                <div style={{ flex: 1, maxWidth: 320 }}>
                  <Kicker>Nome do projeto</Kicker>
                  <input
                    value={nomeNovoProjeto}
                    onChange={(e) => setNomeNovoProjeto(e.target.value)}
                    placeholder="Ex: Marketing Q2 2025"
                    autoFocus
                    style={{ width: "100%", padding: "8px 12px", fontSize: 13, border: "var(--avoce-border)", background: "var(--avoce-cream)", fontFamily: "var(--avoce-font-sans)", boxSizing: "border-box" as const }}
                  />
                </div>
                <Btn
                  onClick={() => criarProjetoMut.mutate({ emitenteId, nome: nomeNovoProjeto })}
                  disabled={!nomeNovoProjeto || criarProjetoMut.isPending}
                >
                  {criarProjetoMut.isPending ? "Criando..." : <><Plus size={13} /> Criar projeto</>}
                </Btn>
              </div>
            </div>
          ) : (
            <p style={{ fontSize: 13, color: "var(--avoce-mute)" }}>Selecione um projeto de marketing para continuar.</p>
          )}
        </Card>
      ) : (
        <>
          {/* Tabs */}
          <div style={{ display: "flex", borderBottom: "var(--avoce-border)", marginBottom: "var(--avoce-space-8)" }}>
            {TABS.map((t) => (
              <button key={t.id} onClick={() => setTab(t.id)} style={{
                display: "flex", alignItems: "center", gap: 6,
                padding: "10px 20px", border: "none", background: "transparent", cursor: "pointer",
                fontSize: 13, fontWeight: tab === t.id ? 600 : 400,
                color: tab === t.id ? "var(--avoce-navy)" : "var(--avoce-mute)",
                borderBottom: tab === t.id ? "2px solid var(--avoce-gold)" : "2px solid transparent",
                fontFamily: "var(--avoce-font-sans)",
              }}>
                {t.icon}{t.label}
              </button>
            ))}
          </div>

          {/* Conteúdo da tab ativa */}
          {tab === "dashboard"     && <TabDashboard     projetoId={projetoId} />}
          {tab === "campanhas"     && <TabCampanhas     projetoId={projetoId} />}
          {tab === "conteudo"      && <TabConteudo      projetoId={projetoId} />}
          {tab === "configuracoes" && <TabConfiguracoes projetoId={projetoId} />}
          {tab === "log"           && <TabLog           projetoId={projetoId} />}
        </>
      )}
    </div>
  );
}

// necessário para compatibilidade de import do ícone TrendingUp usado inline
function TrendingUp({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <polyline points="22 7 13.5 15.5 8.5 10.5 2 17" />
      <polyline points="16 7 22 7 22 13" />
    </svg>
  );
}
