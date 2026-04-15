import { Outlet, NavLink, useNavigate } from "react-router-dom";

const nav = [
  { to: "/crm",                  label: "Funil CRM",      icon: "⚖️"  },
  { to: "/whatsapp",             label: "WhatsApp IA",    icon: "💬"  },
  { to: "/reengajamento",        label: "Reengajamento",  icon: "🔄"  },
  { to: "/config-ia",            label: "Config IA",      icon: "🤖"  },
  { to: "/usuarios",             label: "Usuários",       icon: "👤"  },
  { to: "/financeiro",           label: "Financeiro",     icon: "💰"  },
  { to: "/dashboard",            label: "Dashboard",      icon: "📊"  },
  { to: "/empresas",             label: "Empresas",       icon: "🏢"  },
  { to: "/tomadores",            label: "Tomadores",      icon: "👥"  },
  { to: "/propostas",            label: "Propostas",      icon: "📝"  },
  { to: "/templates-documentos", label: "Templates Doc",  icon: "📋"  },
  { to: "/contratos",            label: "Contratos",      icon: "📄"  },
  { to: "/faturamento",          label: "Faturamento",    icon: "🚀"  },
  { to: "/notas",                label: "Notas Fiscais",  icon: "🧾"  },
  { to: "/cobrancas",            label: "Cobranças",      icon: "💳"  },
  { to: "/pipedrive",            label: "Pipedrive",      icon: "📥"  },
];

export default function Layout() {
  const navigate = useNavigate();

  function logout() {
    localStorage.removeItem("avoce_token");
    navigate("/login");
  }

  return (
    <div className="flex h-screen bg-gray-50">
      {/* Sidebar */}
      <aside className="w-56 bg-brand-900 flex flex-col">
        <div className="px-4 py-5 border-b border-brand-700">
          <p className="text-white font-bold text-lg leading-none">Avoce</p>
          <p className="text-brand-100 text-xs mt-1">Plataforma Jurídica</p>
        </div>
        <nav className="flex-1 py-4 space-y-1 px-2">
          {nav.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                  isActive
                    ? "bg-brand-600 text-white"
                    : "text-brand-100 hover:bg-brand-700 hover:text-white"
                }`
              }
            >
              <span>{item.icon}</span>
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="p-4 border-t border-brand-700">
          <button
            onClick={logout}
            className="w-full text-left text-brand-100 hover:text-white text-sm px-3 py-2 rounded-md hover:bg-brand-700 transition-colors"
          >
            ↩ Sair
          </button>
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}
