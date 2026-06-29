import { NavLink } from "react-router-dom";
import { trpc } from "../lib/trpc";
import { useAuth, hasFullAccess } from "../lib/usePermission";
import {
  DollarSign,
  Receipt,
  AlertCircle,
  KanbanSquare,
  FileText,
  ScrollText,
  Zap,
  Users,
  ArrowRight,
  Building,
  Bot,
  CreditCard,
} from "lucide-react";

function fmtBRL(centavos: number) {
  return (centavos / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function fmtDate() {
  return new Intl.DateTimeFormat("pt-BR", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date());
}

function StatCard({
  label,
  value,
  icon: Icon,
  iconColor,
  iconBg,
  borderColor,
  bg,
}: {
  label: string;
  value: string | number;
  icon: typeof DollarSign;
  iconColor: string;
  iconBg: string;
  borderColor: string;
  bg: string;
}) {
  return (
    <div className={`rounded-xl border p-5 ${bg} ${borderColor}`}>
      <div className={`w-9 h-9 rounded-lg flex items-center justify-center mb-4 ${iconBg}`}>
        <Icon size={18} className={iconColor} strokeWidth={2} />
      </div>
      <p className={`text-2xl font-bold tracking-tight ${iconColor}`}>{value}</p>
      <p className="text-sm text-gray-500 mt-1 font-medium">{label}</p>
    </div>
  );
}

export default function Dashboard() {
  const { user }    = useAuth();
  const fullAccess  = hasFullAccess(user);
  const notaStats   = trpc.nota.dashboard.useQuery(undefined, { enabled: fullAccess });
  const pipelines   = trpc.crm.listPipelines.useQuery();
  const propostas   = trpc.proposta.listar.useQuery({ pageSize: 1 });
  const contratos   = trpc.contrato.listar.useQuery({}, { enabled: fullAccess });

  const totalLeads = pipelines.data?.reduce((acc, p) => acc + (p._count?.deals ?? 0), 0) ?? null;

  const quickActions = [
    { label: "Nova Proposta",  to: "/propostas",    icon: FileText,   color: "bg-blue-600  hover:bg-blue-700",   finance: false },
    { label: "Emitir Notas",   to: "/faturamento",  icon: Zap,        color: "bg-emerald-600 hover:bg-emerald-700", finance: true },
    { label: "Novo Tomador",   to: "/tomadores",    icon: Users,      color: "bg-violet-600 hover:bg-violet-700", finance: false },
    { label: "Nova Cobrança",  to: "/cobrancas",    icon: CreditCard, color: "bg-orange-500 hover:bg-orange-600", finance: true },
  ].filter(a => fullAccess || !a.finance);

  const guideSteps = [
    { step: "1", text: "Cadastre as empresas emitentes com CNPJ, inscrição municipal e alíquota ISS",      to: "/empresas"    },
    { step: "2", text: "Faça upload do certificado digital A1 (.p12) de cada empresa",                      to: "/empresas"    },
    { step: "3", text: "Cadastre os tomadores (clientes que receberão as notas)",                            to: "/tomadores"   },
    { step: "4", text: "Crie contratos recorrentes com dia de vencimento e método de cobrança",              to: "/contratos"   },
    { step: "5", text: "Use Faturamento para emitir NFS-e de vários contratos de uma vez",                  to: "/faturamento" },
    { step: "6", text: "Ative emissão automática no contrato para faturamento mensal sem intervenção",       to: "/contratos"   },
  ];

  return (
    <div className="p-4 md:p-8 max-w-6xl mx-auto">

      {/* Header */}
      <div className="flex items-start justify-between mb-8">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 tracking-tight">Visão Geral</h1>
          <p className="text-sm text-gray-400 mt-0.5 capitalize">{fmtDate()}</p>
        </div>
        <NavLink
          to="/config-ia"
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-gray-200 bg-white text-sm text-gray-600 hover:border-gray-300 hover:text-gray-900 transition-all shadow-sm"
        >
          <Bot size={14} />
          Config IA
        </NavLink>
      </div>

      {/* KPI Cards — acesso integral apenas */}
      {fullAccess && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          <StatCard
            label="Valor Emitido"
            value={notaStats.data ? fmtBRL(notaStats.data.valorTotal) : "—"}
            icon={DollarSign}
            iconColor="text-emerald-700"
            iconBg="bg-emerald-100"
            borderColor="border-emerald-200"
            bg="bg-emerald-50"
          />
          <StatCard
            label="Notas Emitidas"
            value={notaStats.data?.emitidas ?? "—"}
            icon={Receipt}
            iconColor="text-blue-700"
            iconBg="bg-blue-100"
            borderColor="border-blue-200"
            bg="bg-blue-50"
          />
          <StatCard
            label="Contratos Ativos"
            value={contratos.data?.length ?? "—"}
            icon={ScrollText}
            iconColor="text-violet-700"
            iconBg="bg-violet-100"
            borderColor="border-violet-200"
            bg="bg-violet-50"
          />
          <StatCard
            label="Erros NFS-e"
            value={notaStats.data?.erros ?? "—"}
            icon={AlertCircle}
            iconColor={notaStats.data?.erros ? "text-red-700" : "text-gray-500"}
            iconBg={notaStats.data?.erros ? "bg-red-100" : "bg-gray-100"}
            borderColor={notaStats.data?.erros ? "border-red-200" : "border-gray-200"}
            bg={notaStats.data?.erros ? "bg-red-50" : "bg-gray-50"}
          />
        </div>
      )}

      {/* Second row: stats + quick actions */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-4">

        {/* CRM Pipelines */}
        <div className="lg:col-span-2 bg-white rounded-xl border border-gray-200 p-6">
          <div className="flex items-center justify-between mb-5">
            <div className="flex items-center gap-2">
              <KanbanSquare size={16} className="text-gray-400" />
              <h2 className="text-sm font-semibold text-gray-800">Funis CRM</h2>
            </div>
            <NavLink
              to="/crm"
              className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800 font-medium transition-colors"
            >
              Abrir CRM <ArrowRight size={12} />
            </NavLink>
          </div>

          {pipelines.isLoading ? (
            <div className="space-y-2">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-11 bg-gray-100 rounded-lg animate-pulse" />
              ))}
            </div>
          ) : !pipelines.data?.length ? (
            <div className="py-8 text-center text-sm text-gray-400">
              Nenhum funil cadastrado.
            </div>
          ) : (
            <div className="space-y-2">
              {pipelines.data.map((pipeline) => (
                <div
                  key={pipeline.id}
                  className="flex items-center justify-between px-4 py-3 bg-gray-50 rounded-lg hover:bg-gray-100 transition-colors"
                >
                  <div className="flex items-center gap-3">
                    <span
                      className="w-2 h-2 rounded-full flex-shrink-0"
                      style={{ backgroundColor: pipeline.cor ?? "#6366f1" }}
                    />
                    <span className="text-sm font-medium text-gray-800">{pipeline.nome}</span>
                  </div>
                  <span className="text-xs font-medium text-gray-500 bg-white border border-gray-200 rounded-full px-2.5 py-1">
                    {pipeline._count?.deals ?? 0} leads
                  </span>
                </div>
              ))}
              {totalLeads !== null && (
                <div className="pt-2 mt-2 border-t border-gray-100 flex justify-between items-center px-1">
                  <span className="text-xs text-gray-400">Total de leads abertos</span>
                  <span className="text-sm font-semibold text-gray-700">{totalLeads}</span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Quick Actions */}
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <div className="flex items-center gap-2 mb-5">
            <Zap size={16} className="text-gray-400" />
            <h2 className="text-sm font-semibold text-gray-800">Ações Rápidas</h2>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {quickActions.map((a) => (
              <NavLink
                key={a.to}
                to={a.to}
                className={`flex flex-col items-center justify-center gap-2 p-4 rounded-xl text-white text-xs font-semibold transition-all active:scale-95 ${a.color}`}
              >
                <a.icon size={20} strokeWidth={2} />
                <span className="text-center leading-tight">{a.label}</span>
              </NavLink>
            ))}
          </div>

          {/* Proposals stat */}
          <div className="mt-4 pt-4 border-t border-gray-100">
            <NavLink
              to="/propostas"
              className="flex items-center justify-between group"
            >
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-blue-50 flex items-center justify-center">
                  <FileText size={15} className="text-blue-600" />
                </div>
                <div>
                  <p className="text-xs text-gray-500">Propostas</p>
                  <p className="text-sm font-semibold text-gray-800">
                    {propostas.data?.total ?? "—"} total
                  </p>
                </div>
              </div>
              <ArrowRight size={14} className="text-gray-300 group-hover:text-gray-500 transition-colors" />
            </NavLink>
          </div>
        </div>
      </div>

      {/* Getting started guide */}
      <div className="bg-white rounded-xl border border-gray-200 p-6">
        <div className="flex items-center gap-2 mb-5">
          <div className="w-5 h-5 rounded-full bg-brand-600 flex items-center justify-center">
            <span className="text-white text-[10px] font-bold">i</span>
          </div>
          <h2 className="text-sm font-semibold text-gray-800">Como começar</h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          {guideSteps.map((item) => (
            <NavLink
              key={item.step}
              to={item.to}
              className="flex items-start gap-3 p-3 rounded-lg hover:bg-gray-50 group transition-colors"
            >
              <span className="w-6 h-6 rounded-full bg-brand-600 text-white text-[11px] font-bold flex-shrink-0 flex items-center justify-center mt-0.5">
                {item.step}
              </span>
              <p className="text-sm text-gray-500 group-hover:text-gray-800 transition-colors leading-relaxed">
                {item.text}
              </p>
            </NavLink>
          ))}
        </div>
      </div>

    </div>
  );
}
