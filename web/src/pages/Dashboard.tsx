import { trpc } from "../lib/trpc";

function fmt(centavos: number) {
  return (centavos / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

export default function Dashboard() {
  const stats = trpc.nota.dashboard.useQuery();

  const cards = [
    { label: "Total de Notas",   value: stats.data?.total      ?? "—", icon: "🧾", color: "bg-blue-50   border-blue-200" },
    { label: "Notas Emitidas",   value: stats.data?.emitidas   ?? "—", icon: "✅", color: "bg-green-50  border-green-200" },
    { label: "Com Erro",         value: stats.data?.erros      ?? "—", icon: "❌", color: "bg-red-50    border-red-200" },
    { label: "Valor Total Emitido", value: stats.data ? fmt(stats.data.valorTotal) : "—", icon: "💰", color: "bg-emerald-50 border-emerald-200" },
  ];

  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Dashboard</h1>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        {cards.map((c) => (
          <div key={c.label} className={`border rounded-xl p-5 ${c.color}`}>
            <div className="text-2xl mb-2">{c.icon}</div>
            <p className="text-2xl font-bold text-gray-900">{c.value}</p>
            <p className="text-sm text-gray-600 mt-1">{c.label}</p>
          </div>
        ))}
      </div>

      <div className="bg-white rounded-xl border border-gray-200 p-6">
        <h2 className="font-semibold text-gray-800 mb-3">ℹ️ Como funciona</h2>
        <ul className="space-y-2 text-sm text-gray-600 list-disc list-inside">
          <li>Cadastre as <strong>empresas emitentes</strong> com CNPJ, inscrição municipal e alíquota ISS</li>
          <li>Faça upload do <strong>certificado digital A1 (.p12)</strong> de cada empresa</li>
          <li>Cadastre os <strong>tomadores</strong> (clientes que receberão as notas)</li>
          <li>Crie <strong>contratos recorrentes</strong> com o dia do vencimento e o método de cobrança</li>
          <li>Use <strong>Faturamento</strong> para emitir NFS-e de vários contratos de uma vez, no mês que desejar</li>
          <li>Ative a emissão automática no contrato para o sistema faturar sozinho todo mês</li>
        </ul>
      </div>
    </div>
  );
}
