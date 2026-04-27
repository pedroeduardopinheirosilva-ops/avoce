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
  Scale,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

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
    <div className="flex h-screen bg-gray-50 font-sans antialiased">
      {/* Sidebar */}
      <aside className="w-56 bg-brand-900 flex flex-col flex-shrink-0">
        {/* Logo */}
        <div className="px-4 py-4 border-b border-white/10 flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-lg bg-white/15 flex items-center justify-center flex-shrink-0">
            <Scale size={14} className="text-white" />
          </div>
          <div>
            <p className="text-white font-semibold text-sm leading-tight tracking-tight">Avoce</p>
            <p className="text-blue-300/60 text-[10px] leading-tight">Plataforma Jurídica</p>
          </div>
        </div>

        {/* Navigation */}
        <nav className="flex-1 py-2 overflow-y-auto">
          {groups.map((group, gi) => (
            <div key={gi} className={gi > 0 ? "mt-0.5" : ""}>
              {group.label && (
                <p className="px-4 pt-3 pb-1 text-[10px] font-semibold text-white/30 uppercase tracking-widest select-none">
                  {group.label}
                </p>
              )}
              <div className="px-2 space-y-0.5">
                {group.items.map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.end !== undefined ? item.end : true}
                    className={({ isActive }) =>
                      `flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-all ${
                        isActive
                          ? "bg-white text-brand-900 font-semibold shadow-sm"
                          : "text-white/60 hover:text-white hover:bg-white/10 font-medium"
                      }`
                    }
                  >
                    {({ isActive }) => (
                      <>
                        <item.icon
                          size={15}
                          className={isActive ? "text-brand-700" : ""}
                          strokeWidth={isActive ? 2.5 : 1.75}
                        />
                        <span className="truncate leading-none">{item.label}</span>
                      </>
                    )}
                  </NavLink>
                ))}
              </div>
            </div>
          ))}
        </nav>

        {/* Footer / Logout */}
        <div className="p-3 border-t border-white/10">
          <button
            onClick={logout}
            className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium text-white/40 hover:text-white hover:bg-white/10 transition-all"
          >
            <LogOut size={15} strokeWidth={1.75} />
            Sair
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}
