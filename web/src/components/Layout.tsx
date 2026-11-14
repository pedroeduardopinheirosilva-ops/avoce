import { useState } from "react";
import { trpc } from "../lib/trpc";
import { Outlet, NavLink, useNavigate } from "react-router-dom";
import { Activity,
  CalendarDays,
  LayoutDashboard,
  BarChart3,
  KanbanSquare,
  MessageSquare,
  FileText,
  ScrollText,
  FilePlus2,
  Zap,
  Receipt,
  CreditCard,
  BookOpen,
  Building2,
  AlignLeft,
  Link2,
  TrendingUp,
  Building,
  Users,
  Bot,
  User,
  LogOut,
  Menu,
  X,
  Video,
  Phone,
  PhoneOff,
  PhoneCall,
  Shield,
  PenLine,
  Send,
  Handshake,
  HandCoins,
  Gauge,
  Target,
  Wallet,
  Landmark,
  PiggyBank,
  Percent,
  ChartColumn,
  History,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { AvoceLockup } from "./Logo";
import { useAuth, hasModulo } from "../lib/usePermission";
import { useVoip } from "../contexts/VoipContext";

type NavItem = { to: string; label: string; icon: LucideIcon; moduloChave: string; end?: boolean; adminOnly?: boolean };
type NavGroup = { label: string; items: NavItem[] };

const groups: NavGroup[] = [
  {
    label: "",
    items: [
      { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard, moduloChave: "dashboard" },
    ],
  },
  {
    label: "Comercial",
    items: [
      { to: "/painel",        label: "Painel Diário", icon: BarChart3,     moduloChave: "painel" },
      { to: "/crm",           label: "Funil CRM",     icon: KanbanSquare,  moduloChave: "crm" },
      { to: "/whatsapp",      label: "Chat",          icon: MessageSquare, moduloChave: "whatsapp" },
      { to: "/agenda",        label: "Agenda",        icon: CalendarDays,   moduloChave: "reunioes" },
      { to: "/reunioes",      label: "Reuniões",      icon: Video,          moduloChave: "reunioes" },
      { to: "/telefone",      label: "Telefone",      icon: Phone,          moduloChave: "telefone" },
      { to: "/disparos",      label: "Disparos",      icon: Send,           moduloChave: "crm" },
    ],
  },
  {
    label: "Jurídico",
    items: [
      { to: "/propostas",            label: "Propostas", icon: FileText,   moduloChave: "propostas" },
      { to: "/contratos",            label: "Contratos", icon: ScrollText, moduloChave: "contratos" },
      { to: "/templates-documentos", label: "Templates", icon: FilePlus2,  moduloChave: "templates_documentos" },
      { to: "/assinaturas",          label: "Assinaturas", icon: PenLine, moduloChave: "assinaturas" },
      { to: "/acordos",              label: "Acordos",     icon: Handshake, moduloChave: "acordos", end: false },
    ],
  },
  {
    label: "Fiscal",
    items: [
      { to: "/faturamento", label: "Faturamento",   icon: Zap,        moduloChave: "faturamento" },
      { to: "/notas",       label: "Notas Fiscais", icon: Receipt,    moduloChave: "notas" },
      { to: "/cobrancas",   label: "Cobranças",     icon: CreditCard, moduloChave: "cobrancas" },
    ],
  },
  {
    label: "Financeiro",
    items: [
      { to: "/financeiro/painel",      label: "Painel financeiro", icon: Gauge,    moduloChave: "financeiro" },
      { to: "/financeiro",             label: "Lançamentos",    icon: BookOpen,    moduloChave: "financeiro", end: true },
      { to: "/financeiro/contas",      label: "Contas",         icon: Building2,   moduloChave: "financeiro" },
      { to: "/financeiro/extrato",     label: "Extrato",        icon: AlignLeft,   moduloChave: "financeiro" },
      { to: "/financeiro/conciliacao", label: "Conciliação",    icon: Link2,       moduloChave: "financeiro" },
      { to: "/financeiro/fluxo-caixa", label: "Fluxo de Caixa", icon: TrendingUp,  moduloChave: "financeiro" },
      { to: "/recebimentos",           label: "Recebimentos",   icon: HandCoins,   moduloChave: "financeiro" },
    ],
  },
  {
    label: "Gestão financeira",
    items: [
      { to: "/financeiro/orcamento",   label: "Orçado × Realizado", icon: Target,      moduloChave: "financeiro" },
      { to: "/financeiro/fontes",      label: "Fontes de recursos", icon: Wallet,      moduloChave: "financeiro" },
      { to: "/financeiro/emprestimos", label: "Empréstimos",        icon: Landmark,    moduloChave: "financeiro", end: false },
      { to: "/financeiro/aplicacoes",  label: "Aplicações",         icon: PiggyBank,   moduloChave: "financeiro" },
      { to: "/financeiro/indices",     label: "Índices Selic/CDI",  icon: Percent,     moduloChave: "financeiro" },
      { to: "/financeiro/relatorios",  label: "Relatórios (fluxo, DRE)", icon: ChartColumn, moduloChave: "financeiro", end: false },
      { to: "/financeiro/log",         label: "Log de alterações",  icon: History,     moduloChave: "financeiro" },
    ],
  },
  {
    label: "Cadastros",
    items: [
      { to: "/empresas",  label: "Empresas",  icon: Building, moduloChave: "empresas" },
      { to: "/tomadores", label: "Tomadores", icon: Users,    moduloChave: "tomadores" },
    ],
  },
  {
    label: "Sistema",
    items: [
      { to: "/config-ia",          label: "Config IA",       icon: Bot,    moduloChave: "config_ia" },
      { to: "/assistente-interno", label: "Assistente Int.", icon: Zap,    moduloChave: "assistente_interno" },
      { to: "/usuarios",           label: "Usuários",        icon: User,   moduloChave: "usuarios" },
      { to: "/produtividade",      label: "Produtividade",   icon: Activity, moduloChave: "produtividade", end: false },
      { to: "/tenants",            label: "Tenants",         icon: Shield, moduloChave: "tenants", adminOnly: true },
    ],
  },
];

function IncomingCallOverlay() {
  const { isIncomingCall, incomingCallerInfo, atender, rejeitar } = useVoip();
  const navigate = useNavigate();

  if (!isIncomingCall) return null;

  function handleAtender() {
    atender();
    navigate("/telefone");
  }

  return (
    <div className="fixed bottom-6 right-6 z-50 w-72 bg-white rounded-2xl shadow-2xl border border-gray-200 overflow-hidden animate-bounce-in">
      <div className="bg-indigo-600 px-4 py-3 flex items-center gap-2">
        <PhoneCall size={18} className="text-white animate-pulse" />
        <span className="text-white font-semibold text-sm">Chamada recebida</span>
      </div>
      <div className="px-4 py-3">
        <p className="text-xs text-gray-500 mb-0.5">De:</p>
        <p className="text-sm font-mono text-gray-800 truncate">{incomingCallerInfo || "Desconhecido"}</p>
      </div>
      <div className="px-4 pb-4 flex gap-3">
        <button
          onClick={handleAtender}
          className="flex-1 flex items-center justify-center gap-1.5 bg-green-500 hover:bg-green-600 text-white text-sm font-medium py-2.5 rounded-xl transition-colors"
        >
          <Phone size={16} /> Atender
        </button>
        <button
          onClick={rejeitar}
          className="flex-1 flex items-center justify-center gap-1.5 bg-red-500 hover:bg-red-600 text-white text-sm font-medium py-2.5 rounded-xl transition-colors"
        >
          <PhoneOff size={16} /> Rejeitar
        </button>
      </div>
    </div>
  );
}

function ActiveCallOverlay() {
  const { callStatus, callSeconds, isIncomingCall, sessionRef } = useVoip();

  // Only for outgoing calls in progress
  if (isIncomingCall || (callStatus !== "ringing" && callStatus !== "in_call")) return null;

  const mins = Math.floor(callSeconds / 60);
  const secs = String(callSeconds % 60).padStart(2, "0");

  function encerrar() {
    try { sessionRef.current?.terminate(); } catch {}
  }

  return (
    <div className="fixed bottom-6 left-6 z-50 w-64 bg-white rounded-2xl shadow-2xl border border-gray-200 overflow-hidden">
      <div className="bg-green-600 px-4 py-3 flex items-center gap-2">
        <PhoneCall size={16} className="text-white animate-pulse" />
        <span className="text-white font-semibold text-sm flex-1">
          {callStatus === "ringing" ? "Discando..." : "Em ligação"}
        </span>
        <span className="text-white text-sm font-mono">{mins}:{secs}</span>
      </div>
      <div className="px-4 py-3">
        <button
          onClick={encerrar}
          className="w-full flex items-center justify-center gap-1.5 bg-red-500 hover:bg-red-600 text-white text-sm font-medium py-2.5 rounded-xl transition-colors"
        >
          <PhoneOff size={15} /> Encerrar ligação
        </button>
      </div>
    </div>
  );
}

export default function Layout() {
  // Ligações de follow-up vencendo hoje/atrasadas — número ao lado do "Painel Diário".
  const followups = trpc.painel.followupsPendentes.useQuery(undefined, { refetchInterval: 5 * 60_000, retry: false });
  const navigate = useNavigate();
  const { user } = useAuth();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  function logout() {
    localStorage.removeItem("avoce_token");
    navigate("/login");
  }

  function closeSidebar() {
    setSidebarOpen(false);
  }

  return (
    <div
      className="flex h-screen antialiased"
      style={{ background: "var(--avoce-cream)", color: "var(--avoce-navy)" }}
    >
      {/* Mobile backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-30 md:hidden"
          onClick={closeSidebar}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`fixed inset-y-0 left-0 z-40 flex flex-col flex-shrink-0 overflow-hidden transition-transform duration-200 md:static md:translate-x-0 ${sidebarOpen ? "translate-x-0" : "-translate-x-full"}`}
        style={{
          width: "var(--avoce-sidebar-width)",
          background: "var(--avoce-navy)",
          borderRight: "1px solid rgba(11,37,69,0.2)",
        }}
      >
        {/* Lockup */}
        <div
          className="flex items-center justify-between"
          style={{
            height: "var(--avoce-topbar-height)",
            padding: "0 var(--avoce-space-6)",
            borderBottom: "1px solid rgba(255,255,255,0.08)",
            flexShrink: 0,
          }}
        >
          <AvoceLockup color="#F4F1EA" accent="#C9A961" scale={0.9} />
          <button
            onClick={closeSidebar}
            className="md:hidden text-white/50 hover:text-white p-1 -mr-1"
          >
            <X size={18} />
          </button>
        </div>

        {/* Navigation */}
        <nav
          className="flex-1 overflow-y-auto"
          style={{ padding: "var(--avoce-space-3) 0" }}
        >
          {groups.map((group, gi) => {
            const isGlobalAdmin = user?.role === "admin" && !user?.empresaId;
          const visibleItems = user ? group.items.filter(item => {
            if (item.adminOnly && !isGlobalAdmin) return false;
            // Produtividade: só com a flag explícita (admin/permissoes=null não liberam).
            if (item.moduloChave === "produtividade") return user.verProdutividade === true;
            // financeiro_editar inclui a leitura: quem só tem ele também enxerga o menu.
            return hasModulo(user, item.moduloChave)
              || (item.moduloChave === "financeiro" && hasModulo(user, "financeiro_editar"));
          }) : group.items;
            if (visibleItems.length === 0) return null;
            return (
            <div key={gi} style={{ marginTop: gi > 0 ? "var(--avoce-space-4)" : 0 }}>
              {group.label && (
                <p
                  style={{
                    fontFamily: "var(--avoce-font-mono)",
                    fontSize: 10,
                    letterSpacing: "var(--avoce-tracking-kicker)",
                    textTransform: "uppercase",
                    color: "rgba(255,255,255,0.28)",
                    padding: "0 var(--avoce-space-6)",
                    marginBottom: "var(--avoce-space-1)",
                    userSelect: "none",
                  }}
                >
                  {group.label}
                </p>
              )}
              <div style={{ padding: "0 var(--avoce-space-3)" }}>
                {visibleItems.map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.end !== undefined ? item.end : true}
                    onClick={closeSidebar}
                    style={({ isActive }) => ({
                      display: "flex",
                      alignItems: "center",
                      gap: "var(--avoce-space-3)",
                      padding: "var(--avoce-space-2) var(--avoce-space-3)",
                      fontSize: 13,
                      fontWeight: isActive ? 600 : 500,
                      fontFamily: "var(--avoce-font-sans)",
                      color: isActive ? "var(--avoce-navy)" : "rgba(255,255,255,0.55)",
                      background: isActive ? "var(--avoce-cream)" : "transparent",
                      borderRadius: 0,
                      textDecoration: "none",
                      transition: "var(--avoce-transition)",
                      marginBottom: 1,
                    })}
                    className={({ isActive }) => isActive ? "" : "nav-item-hover"}
                  >
                    {({ isActive }) => (
                      <>
                        <item.icon
                          size={14}
                          strokeWidth={isActive ? 2.5 : 1.75}
                          style={{ flexShrink: 0, color: isActive ? "var(--avoce-navy)" : undefined }}
                        />
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", lineHeight: 1 }}>
                          {item.label}
                        </span>
                        {item.to === "/painel" && !!followups.data && (
                          <span
                            title={`${followups.data} ligação(ões) de follow-up para hoje/atrasadas`}
                            style={{ marginLeft: "auto", background: "#dc2626", color: "#fff", fontSize: 10, fontWeight: 700, borderRadius: 9, padding: "1px 6px", lineHeight: "14px" }}
                          >
                            {followups.data}
                          </span>
                        )}
                      </>
                    )}
                  </NavLink>
                ))}
              </div>
            </div>
            );
          })}
        </nav>

        {/* Footer / Logout */}
        <div
          style={{
            padding: "var(--avoce-space-3)",
            borderTop: "1px solid rgba(255,255,255,0.08)",
          }}
        >
          <button
            onClick={logout}
            style={{
              width: "100%",
              display: "flex",
              alignItems: "center",
              gap: "var(--avoce-space-3)",
              padding: "var(--avoce-space-2) var(--avoce-space-3)",
              fontSize: 13,
              fontWeight: 500,
              color: "rgba(255,255,255,0.35)",
              background: "transparent",
              border: "none",
              cursor: "pointer",
              transition: "var(--avoce-transition)",
              fontFamily: "var(--avoce-font-sans)",
              borderRadius: 0,
            }}
            className="nav-item-hover-logout"
          >
            <LogOut size={14} strokeWidth={1.75} />
            Sair
          </button>
        </div>
      </aside>

      {/* Main content area */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden" style={{ background: "var(--avoce-cream)" }}>
        {/* Mobile topbar */}
        <header
          className="md:hidden flex items-center gap-3 px-4 flex-shrink-0 bg-white border-b border-gray-200"
          style={{ height: "var(--avoce-topbar-height)" }}
        >
          <button
            onClick={() => setSidebarOpen(true)}
            className="p-1 text-gray-600 hover:text-gray-900"
            aria-label="Abrir menu"
          >
            <Menu size={20} />
          </button>
          <AvoceLockup color="#0B2545" accent="#C9A961" scale={0.8} />
        </header>

        <main className="flex-1 overflow-auto">
          <Outlet />
        </main>
      </div>
      <IncomingCallOverlay />
      <ActiveCallOverlay />
    </div>
  );
}
