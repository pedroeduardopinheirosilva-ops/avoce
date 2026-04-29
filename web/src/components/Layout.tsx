import { Outlet, NavLink, useNavigate } from "react-router-dom";
import {
  LayoutDashboard,
  KanbanSquare,
  MessageSquare,
  RefreshCw,
  ArrowDownToLine,
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
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { AvoceLockup } from "./Logo";

type NavItem = { to: string; label: string; icon: LucideIcon; end?: boolean };
type NavGroup = { label: string; items: NavItem[] };

const groups: NavGroup[] = [
  {
    label: "",
    items: [
      { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
    ],
  },
  {
    label: "Comercial",
    items: [
      { to: "/crm",           label: "Funil CRM",     icon: KanbanSquare },
      { to: "/whatsapp",      label: "WhatsApp IA",   icon: MessageSquare },
      { to: "/reengajamento", label: "Reengajamento", icon: RefreshCw },
      { to: "/pipedrive",     label: "Pipedrive",     icon: ArrowDownToLine },
    ],
  },
  {
    label: "Jurídico",
    items: [
      { to: "/propostas",            label: "Propostas", icon: FileText },
      { to: "/contratos",            label: "Contratos", icon: ScrollText },
      { to: "/templates-documentos", label: "Templates", icon: FilePlus2 },
    ],
  },
  {
    label: "Fiscal",
    items: [
      { to: "/faturamento", label: "Faturamento",   icon: Zap },
      { to: "/notas",       label: "Notas Fiscais", icon: Receipt },
      { to: "/cobrancas",   label: "Cobranças",     icon: CreditCard },
    ],
  },
  {
    label: "Financeiro",
    items: [
      { to: "/financeiro",             label: "Lançamentos",    icon: BookOpen,   end: true },
      { to: "/financeiro/contas",      label: "Contas",         icon: Building2 },
      { to: "/financeiro/extrato",     label: "Extrato",        icon: AlignLeft },
      { to: "/financeiro/conciliacao", label: "Conciliação",    icon: Link2 },
      { to: "/financeiro/fluxo-caixa", label: "Fluxo de Caixa", icon: TrendingUp },
    ],
  },
  {
    label: "Cadastros",
    items: [
      { to: "/empresas",  label: "Empresas",  icon: Building },
      { to: "/tomadores", label: "Tomadores", icon: Users },
    ],
  },
  {
    label: "Sistema",
    items: [
      { to: "/config-ia", label: "Config IA", icon: Bot },
      { to: "/usuarios",  label: "Usuários",  icon: User },
    ],
  },
];

export default function Layout() {
  const navigate = useNavigate();

  function logout() {
    localStorage.removeItem("avoce_token");
    navigate("/login");
  }

  return (
    <div
      className="flex h-screen antialiased"
      style={{ background: "var(--avoce-cream)", color: "var(--avoce-navy)" }}
    >
      {/* Sidebar */}
      <aside
        className="flex flex-col flex-shrink-0 overflow-hidden"
        style={{
          width: "var(--avoce-sidebar-width)",
          background: "var(--avoce-navy)",
          borderRight: "1px solid rgba(11,37,69,0.2)",
        }}
      >
        {/* Lockup */}
        <div
          className="flex items-center"
          style={{
            height: "var(--avoce-topbar-height)",
            padding: "0 var(--avoce-space-6)",
            borderBottom: "1px solid rgba(255,255,255,0.08)",
            flexShrink: 0,
          }}
        >
          <AvoceLockup color="#F4F1EA" accent="#C9A961" scale={0.9} />
        </div>

        {/* Navigation */}
        <nav
          className="flex-1 overflow-y-auto"
          style={{ padding: "var(--avoce-space-3) 0" }}
        >
          {groups.map((group, gi) => (
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
                {group.items.map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.end !== undefined ? item.end : true}
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
                      </>
                    )}
                  </NavLink>
                ))}
              </div>
            </div>
          ))}
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

      {/* Main content */}
      <main className="flex-1 overflow-auto" style={{ background: "var(--avoce-cream)" }}>
        <Outlet />
      </main>
    </div>
  );
}
