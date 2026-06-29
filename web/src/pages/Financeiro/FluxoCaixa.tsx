import { useState, useMemo } from "react";
import { trpc } from "../../lib/trpc";

const MESES = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];

function fmtBrl(v: number) {
  return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function fmtDate(d: string | Date | null | undefined) {
  if (!d) return "-";
  return new Date(d).toLocaleDateString("pt-BR");
}

// ─── Simple bar chart via CSS ────────────────────────────────────────────────

interface BarChartProps {
  data: { month: string; entradas: number; saidas: number }[];
}
function BarChart({ data }: BarChartProps) {
  const maxVal = Math.max(...data.flatMap((d) => [d.entradas, d.saidas]), 1);

  return (
    <div className="flex items-end gap-2 h-40">
      {data.map((d) => {
        const entH = Math.max(Math.round((d.entradas / maxVal) * 120), 2);
        const saiH = Math.max(Math.round((d.saidas / maxVal) * 120), 2);
        return (
          <div key={d.month} className="flex-1 flex flex-col items-center gap-1">
            <div className="flex items-end gap-0.5">
              <div
                className="w-4 bg-green-400 rounded-t"
                style={{ height: entH }}
                title={`Entradas: ${fmtBrl(d.entradas)}`}
              />
              <div
                className="w-4 bg-red-400 rounded-t"
                style={{ height: saiH }}
                title={`Saídas: ${fmtBrl(d.saidas)}`}
              />
            </div>
            <span className="text-[9px] text-gray-400">{d.month}</span>
          </div>
        );
      })}
    </div>
  );
}

// ─── Main page ───────────────────────────────────────────────────────────────

export default function FluxoCaixa() {
  const now = new Date();
  const [ano, setAno] = useState(now.getFullYear());

  const { data: empresas } = trpc.empresa.listar.useQuery();
  const [emitenteId, setEmitenteId] = useState(() => localStorage.getItem("avoce_emitenteId") ?? "");
  const [bankAccountId, setBankAccountId] = useState("");

  function handleEmitenteChange(id: string) {
    setEmitenteId(id);
    localStorage.setItem("avoce_emitenteId", id);
    setBankAccountId("");
  }

  const { data: accounts } = trpc.banking.accounts.list.useQuery(
    { emitenteId },
    { enabled: !!emitenteId }
  );

  // Load statements for full year
  const startIso = new Date(ano, 0, 1).toISOString();
  const endIso   = new Date(ano, 11, 31, 23, 59, 59).toISOString();

  const { data: statementsData, isLoading } = trpc.banking.statements.list.useQuery(
    {
      emitenteId,
      bankAccountId: bankAccountId || undefined,
      startDate: startIso,
      endDate: endIso,
      take: 2000,
      skip: 0,
    },
    { enabled: !!emitenteId }
  );

  const statements: any[] = useMemo(() => {
    return (statementsData as any)?.statements ?? (statementsData as any)?.items ?? [];
  }, [statementsData]);

  // Aggregate by month
  const byMonth = useMemo(() => {
    const map: Record<number, { entradas: number; saidas: number }> = {};
    for (let i = 1; i <= 12; i++) map[i] = { entradas: 0, saidas: 0 };
    for (const s of statements) {
      const m = new Date(s.entryDate).getMonth() + 1;
      if (!map[m]) continue;
      if (s.entryType === "CREDIT") map[m].entradas += s.amount ?? 0;
      else map[m].saidas += Math.abs(s.amount ?? 0);
    }
    return map;
  }, [statements]);

  const chartData = MESES.map((label, i) => ({
    month: label,
    entradas: byMonth[i + 1]?.entradas ?? 0,
    saidas:   byMonth[i + 1]?.saidas   ?? 0,
  }));

  const totalEntradas = chartData.reduce((a, d) => a + d.entradas, 0);
  const totalSaidas   = chartData.reduce((a, d) => a + d.saidas,   0);
  const saldoLiquido  = totalEntradas - totalSaidas;

  // Group by category for table
  const byCategory = useMemo(() => {
    const map: Record<string, { entradas: number; saidas: number; count: number }> = {};
    for (const s of statements) {
      const cat = s.category || "Sem categoria";
      if (!map[cat]) map[cat] = { entradas: 0, saidas: 0, count: 0 };
      map[cat].count++;
      if (s.entryType === "CREDIT") map[cat].entradas += s.amount ?? 0;
      else map[cat].saidas += Math.abs(s.amount ?? 0);
    }
    return Object.entries(map).sort((a, b) => (b[1].entradas + b[1].saidas) - (a[1].entradas + a[1].saidas));
  }, [statements]);

  return (
    <div className="p-4 md:p-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-6 gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Fluxo de Caixa</h1>
          <p className="text-sm text-gray-500 mt-1">Visão consolidada de entradas e saídas bancárias.</p>
        </div>
        <div className="flex items-center gap-3">
          <select value={emitenteId} onChange={(e) => handleEmitenteChange(e.target.value)}
            className="border rounded-lg px-3 py-2 text-sm">
            <option value="">Selecione a empresa</option>
            {empresas?.map((e) => <option key={e.id} value={e.id}>{(e as any).nomeFantasia || e.nome}</option>)}
          </select>
          {emitenteId && (
            <select value={bankAccountId} onChange={(e) => setBankAccountId(e.target.value)}
              className="border rounded-lg px-3 py-2 text-sm">
              <option value="">Todas as contas</option>
              {accounts?.map((a: any) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          )}
          <select value={ano} onChange={(e) => setAno(Number(e.target.value))}
            className="border rounded-lg px-3 py-2 text-sm">
            {[2023, 2024, 2025, 2026, 2027].map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </div>
      </div>

      {!emitenteId ? (
        <div className="bg-white border border-gray-200 rounded-xl p-12 text-center text-gray-400 text-sm">
          Selecione uma empresa para ver o fluxo de caixa.
        </div>
      ) : isLoading ? (
        <div className="bg-white border border-gray-200 rounded-xl p-12 text-center text-gray-400 text-sm animate-pulse">
          Carregando...
        </div>
      ) : (
        <>
          {/* KPIs */}
          <div className="grid grid-cols-3 gap-4 mb-6">
            <div className="bg-white border border-green-100 rounded-xl p-5">
              <p className="text-xs font-medium text-green-700 uppercase tracking-wide mb-1">Total Entradas</p>
              <p className="text-2xl font-bold text-green-700">{fmtBrl(totalEntradas)}</p>
              <p className="text-xs text-gray-400 mt-1">{statements.filter((s) => s.entryType === "CREDIT").length} créditos</p>
            </div>
            <div className="bg-white border border-red-100 rounded-xl p-5">
              <p className="text-xs font-medium text-red-700 uppercase tracking-wide mb-1">Total Saídas</p>
              <p className="text-2xl font-bold text-red-700">{fmtBrl(totalSaidas)}</p>
              <p className="text-xs text-gray-400 mt-1">{statements.filter((s) => s.entryType === "DEBIT").length} débitos</p>
            </div>
            <div className={`border rounded-xl p-5 ${saldoLiquido >= 0 ? "bg-indigo-50 border-indigo-100" : "bg-amber-50 border-amber-100"}`}>
              <p className={`text-xs font-medium uppercase tracking-wide mb-1 ${saldoLiquido >= 0 ? "text-indigo-700" : "text-amber-700"}`}>Saldo Líquido</p>
              <p className={`text-2xl font-bold ${saldoLiquido >= 0 ? "text-indigo-700" : "text-amber-700"}`}>{fmtBrl(saldoLiquido)}</p>
              <p className="text-xs text-gray-400 mt-1">{statements.length} lançamentos</p>
            </div>
          </div>

          {/* Bar chart */}
          <div className="bg-white border border-gray-200 rounded-xl p-6 mb-6">
            <h2 className="text-sm font-semibold text-gray-700 mb-4">Entradas vs Saídas — {ano}</h2>
            <BarChart data={chartData} />
            <div className="flex gap-4 mt-3">
              <span className="flex items-center gap-1.5 text-xs text-gray-500">
                <span className="h-2.5 w-2.5 bg-green-400 rounded" />Entradas
              </span>
              <span className="flex items-center gap-1.5 text-xs text-gray-500">
                <span className="h-2.5 w-2.5 bg-red-400 rounded" />Saídas
              </span>
            </div>
          </div>

          {/* Monthly table */}
          <div className="bg-white border border-gray-200 rounded-xl overflow-x-auto mb-6">
            <div className="px-5 py-3 border-b border-gray-100 bg-gray-50">
              <h2 className="text-sm font-semibold text-gray-700">Resumo Mensal {ano}</h2>
            </div>
            <table className="w-full text-sm min-w-[420px]">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Mês</th>
                  <th className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase">Entradas</th>
                  <th className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase">Saídas</th>
                  <th className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase">Saldo</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {chartData.map((d, i) => {
                  const saldo = d.entradas - d.saidas;
                  return (
                    <tr key={i} className="hover:bg-gray-50">
                      <td className="px-4 py-3 font-medium text-gray-800">{d.month}/{ano}</td>
                      <td className="px-4 py-3 text-right text-green-700 font-medium">{fmtBrl(d.entradas)}</td>
                      <td className="px-4 py-3 text-right text-red-700 font-medium">{fmtBrl(d.saidas)}</td>
                      <td className={`px-4 py-3 text-right font-semibold ${saldo >= 0 ? "text-indigo-700" : "text-amber-700"}`}>
                        {fmtBrl(saldo)}
                      </td>
                    </tr>
                  );
                })}
                <tr className="border-t-2 border-gray-200 bg-gray-50">
                  <td className="px-4 py-3 font-semibold text-gray-800">Total</td>
                  <td className="px-4 py-3 text-right font-bold text-green-700">{fmtBrl(totalEntradas)}</td>
                  <td className="px-4 py-3 text-right font-bold text-red-700">{fmtBrl(totalSaidas)}</td>
                  <td className={`px-4 py-3 text-right font-bold ${saldoLiquido >= 0 ? "text-indigo-700" : "text-amber-700"}`}>
                    {fmtBrl(saldoLiquido)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* Category table */}
          {byCategory.length > 0 && (
            <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
              <div className="px-5 py-3 border-b border-gray-100 bg-gray-50">
                <h2 className="text-sm font-semibold text-gray-700">Por Categoria</h2>
              </div>
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Categoria</th>
                    <th className="text-center px-4 py-3 text-xs font-medium text-gray-500 uppercase">Lançamentos</th>
                    <th className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase">Entradas</th>
                    <th className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase">Saídas</th>
                    <th className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase">Saldo</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {byCategory.map(([cat, vals]) => {
                    const saldo = vals.entradas - vals.saidas;
                    return (
                      <tr key={cat} className="hover:bg-gray-50">
                        <td className="px-4 py-3 font-medium text-gray-800">{cat}</td>
                        <td className="px-4 py-3 text-center text-gray-500">{vals.count}</td>
                        <td className="px-4 py-3 text-right text-green-700">{fmtBrl(vals.entradas)}</td>
                        <td className="px-4 py-3 text-right text-red-700">{fmtBrl(vals.saidas)}</td>
                        <td className={`px-4 py-3 text-right font-semibold ${saldo >= 0 ? "text-indigo-700" : "text-amber-700"}`}>
                          {fmtBrl(saldo)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
