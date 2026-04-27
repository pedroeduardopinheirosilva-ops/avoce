import { useState } from "react";
import { trpc } from "../../lib/trpc";

function fmtBrl(v: number) {
  return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}
function fmtDate(d: string | Date | null | undefined) {
  if (!d) return "-";
  return new Date(d).toLocaleDateString("pt-BR");
}

function confidenceBadge(score: number): { label: string; cls: string } {
  if (score >= 0.9)  return { label: `${Math.round(score * 100)}% — Auto`, cls: "bg-green-100 text-green-700" };
  if (score >= 0.75) return { label: `${Math.round(score * 100)}% — Revisar`, cls: "bg-yellow-100 text-yellow-700" };
  return { label: `${Math.round(score * 100)}% — Baixa`, cls: "bg-orange-100 text-orange-700" };
}

// ─── Confirm match modal ─────────────────────────────────────────────────────

interface ConfirmMatchProps {
  statement: any;
  suggestion: any | null;
  cobrancas: any[];
  emitenteId: string;
  onClose: () => void;
  onMatched: () => void;
}
function ConfirmMatchModal({ statement, suggestion, cobrancas, emitenteId, onClose, onMatched }: ConfirmMatchProps) {
  const [selectedCobranca, setSelectedCobranca] = useState<string>(suggestion?.cobranca?.id ?? "");

  const applyMatch = trpc.banking.reconciliation.applyMatch.useMutation({
    onSuccess: () => { onMatched(); onClose(); },
    onError: (e) => alert("Erro: " + e.message),
  });

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6 space-y-4">
        <h2 className="text-lg font-semibold text-gray-900">Confirmar Conciliação</h2>

        <div className="bg-gray-50 rounded-lg p-3 text-sm">
          <p className="font-medium text-gray-900">{statement.description}</p>
          <p className="text-gray-500">{fmtDate(statement.entryDate)} · {fmtBrl(Math.abs(statement.amount ?? 0))}</p>
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">
            Vincular à cobrança
          </label>
          <select
            value={selectedCobranca}
            onChange={(e) => setSelectedCobranca(e.target.value)}
            className="w-full border rounded-lg px-3 py-2 text-sm"
          >
            <option value="">Selecione uma cobrança...</option>
            {cobrancas.map((c: any) => (
              <option key={c.id} value={c.id}>
                {c.contrato?.tomador?.nome ?? c.id} — {fmtBrl(c.valor / 100)} — {fmtDate(c.vencimento)}
              </option>
            ))}
          </select>
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg">Cancelar</button>
          <button
            onClick={() => {
              if (!selectedCobranca) { alert("Selecione uma cobrança."); return; }
              applyMatch.mutate({ emitenteId, statementId: statement.id, cobrancaId: selectedCobranca });
            }}
            disabled={!selectedCobranca || applyMatch.isPending}
            className="px-4 py-2 bg-indigo-600 text-white text-sm rounded-lg hover:bg-indigo-700 disabled:opacity-50"
          >
            {applyMatch.isPending ? "Conciliando..." : "Conciliar"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Main page ───────────────────────────────────────────────────────────────

export default function Conciliacao() {
  const utils = trpc.useUtils();

  const { data: empresas } = trpc.empresa.listar.useQuery();
  const [emitenteId, setEmitenteId] = useState(() => localStorage.getItem("avoce_emitenteId") ?? "");
  const [bankAccountId, setBankAccountId] = useState("");
  const [matchModal, setMatchModal] = useState<{ statement: any; suggestion: any | null } | null>(null);

  function handleEmitenteChange(id: string) {
    setEmitenteId(id);
    localStorage.setItem("avoce_emitenteId", id);
    setBankAccountId("");
  }

  const { data: accounts } = trpc.banking.accounts.list.useQuery(
    { emitenteId },
    { enabled: !!emitenteId }
  );

  const { data: stats, isLoading: statsLoading } = trpc.banking.reconciliation.stats.useQuery(
    { emitenteId, bankAccountId: bankAccountId || undefined },
    { enabled: !!emitenteId }
  );

  const { data: unmatched, isLoading: unmatchedLoading } = trpc.banking.reconciliation.unmatched.useQuery(
    { emitenteId, bankAccountId: bankAccountId || undefined },
    { enabled: !!emitenteId }
  );

  const { data: suggestions } = trpc.banking.reconciliation.suggestions.useQuery(
    { emitenteId, bankAccountId: bankAccountId || emitenteId },
    { enabled: !!emitenteId && !!bankAccountId }
  );

  const { data: cobrancasSemExtrato } = trpc.banking.reconciliation.cobrancasSemExtrato.useQuery(
    { emitenteId },
    { enabled: !!emitenteId }
  );

  const { data: cobrancas } = trpc.cobranca.listar.useQuery({ pageSize: 500 }, { enabled: !!emitenteId });

  const runMut = trpc.banking.reconciliation.run.useMutation({
    onSuccess: (r: any) => {
      alert(`Conciliação concluída: ${r.matched ?? 0} lançamentos conciliados.`);
      invalidate();
    },
    onError: (e) => alert("Erro: " + e.message),
  });

  const unmatchMut = trpc.banking.reconciliation.unmatch.useMutation({
    onSuccess: () => invalidate(),
    onError: (e) => alert("Erro: " + e.message),
  });

  function invalidate() {
    utils.banking.reconciliation.stats.invalidate({ emitenteId });
    utils.banking.reconciliation.unmatched.invalidate({ emitenteId });
    utils.banking.reconciliation.suggestions.invalidate();
    utils.banking.reconciliation.cobrancasSemExtrato.invalidate({ emitenteId });
  }

  // Build suggestions map: statementId → suggestion[]
  const suggMap: Record<string, any[]> = {};
  if (Array.isArray(suggestions)) {
    for (const s of suggestions as any[]) {
      const key = s.statementId ?? s.bankStatementId;
      if (!key) continue;
      if (!suggMap[key]) suggMap[key] = [];
      suggMap[key].push(s);
    }
  }

  const unmatchedList: any[] = Array.isArray(unmatched) ? unmatched : (unmatched as any)?.items ?? [];
  const cobrancasList: any[] = cobrancas?.cobrancas ?? [];
  const semExtrato: any[] = Array.isArray(cobrancasSemExtrato) ? cobrancasSemExtrato : [];

  const pct = stats ? Math.round(((stats as any).matched / Math.max((stats as any).total, 1)) * 100) : 0;

  return (
    <div className="p-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Conciliação Bancária</h1>
          <p className="text-sm text-gray-500 mt-1">Vincule lançamentos do extrato às cobranças.</p>
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
          {emitenteId && bankAccountId && (
            <button
              onClick={() => runMut.mutate({ emitenteId, bankAccountId })}
              disabled={runMut.isPending}
              className="text-sm px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg disabled:opacity-50 transition-colors"
            >
              {runMut.isPending ? "Rodando..." : "Rodar Conciliação Auto"}
            </button>
          )}
        </div>
      </div>

      {!emitenteId ? (
        <div className="bg-white border border-gray-200 rounded-xl p-12 text-center text-gray-400 text-sm">
          Selecione uma empresa para iniciar a conciliação.
        </div>
      ) : (
        <>
          {/* Stats bar */}
          {stats && (
            <div className="grid grid-cols-4 gap-4 mb-6">
              <div className="bg-white border border-gray-200 rounded-xl p-4">
                <p className="text-xs text-gray-500 mb-1">Pendentes</p>
                <p className="text-2xl font-bold text-yellow-600">{(stats as any).unmatched ?? 0}</p>
              </div>
              <div className="bg-white border border-gray-200 rounded-xl p-4">
                <p className="text-xs text-gray-500 mb-1">Conciliados</p>
                <p className="text-2xl font-bold text-green-700">{(stats as any).matched ?? 0}</p>
              </div>
              <div className="bg-white border border-gray-200 rounded-xl p-4">
                <p className="text-xs text-gray-500 mb-1">% Conciliado</p>
                <p className="text-2xl font-bold text-indigo-700">{pct}%</p>
                <div className="mt-1 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                  <div className="h-full bg-indigo-500 rounded-full" style={{ width: `${pct}%` }} />
                </div>
              </div>
              <div className="bg-white border border-gray-200 rounded-xl p-4">
                <p className="text-xs text-gray-500 mb-1">Valor pendente</p>
                <p className="text-xl font-bold text-gray-800">{fmtBrl((stats as any).pendingAmount ?? 0)}</p>
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Left: unmatched statements */}
            <div>
              <h2 className="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-2">
                Lançamentos sem conciliação
                {unmatchedList.length > 0 && (
                  <span className="text-xs bg-yellow-100 text-yellow-700 px-2 py-0.5 rounded-full">{unmatchedList.length}</span>
                )}
              </h2>
              {unmatchedLoading ? (
                <div className="space-y-3">
                  {[1, 2, 3].map((i) => (
                    <div key={i} className="bg-white border border-gray-200 rounded-xl p-4 animate-pulse h-24" />
                  ))}
                </div>
              ) : !unmatchedList.length ? (
                <div className="bg-white border border-gray-200 rounded-xl p-8 text-center text-gray-400 text-sm">
                  Todos os lançamentos estão conciliados!
                </div>
              ) : (
                <div className="space-y-3">
                  {unmatchedList.map((stmt: any) => {
                    const stmtSuggs = suggMap[stmt.id] ?? [];
                    const topSugg = stmtSuggs[0];
                    return (
                      <div key={stmt.id} className="bg-white border border-gray-200 rounded-xl p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <p className="text-sm font-medium text-gray-900 truncate">{stmt.description ?? "-"}</p>
                              <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${stmt.entryType === "CREDIT" ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"}`}>
                                {stmt.entryType === "CREDIT" ? "Crédito" : "Débito"}
                              </span>
                            </div>
                            <p className="text-xs text-gray-500 mt-0.5">
                              {fmtDate(stmt.entryDate)} · {fmtBrl(Math.abs(stmt.amount ?? 0))}
                            </p>
                            {stmt.counterpartyName && (
                              <p className="text-xs text-gray-400 mt-0.5">{stmt.counterpartyName}</p>
                            )}

                            {/* Suggestions */}
                            {stmtSuggs.length > 0 && (
                              <div className="mt-2 space-y-1">
                                {stmtSuggs.slice(0, 2).map((s: any, i: number) => {
                                  const badge = confidenceBadge(s.score ?? s.confidence ?? 0);
                                  return (
                                    <div key={i} className="flex items-center gap-2 text-xs">
                                      <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${badge.cls}`}>{badge.label}</span>
                                      <span className="text-gray-500 truncate">
                                        {s.cobranca?.contrato?.tomador?.nome ?? s.cobrancaId}
                                        {s.cobranca?.valor && ` — ${fmtBrl(s.cobranca.valor / 100)}`}
                                      </span>
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                          </div>

                          <div className="flex gap-1.5 flex-shrink-0">
                            <button
                              onClick={() => setMatchModal({ statement: stmt, suggestion: topSugg ?? null })}
                              className="text-xs px-2.5 py-1.5 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 rounded-lg transition-colors"
                            >
                              Conciliar
                            </button>
                            <button
                              onClick={() => { if (confirm("Ignorar este lançamento?")) unmatchMut.mutate({ emitenteId, statementId: stmt.id }); }}
                              className="text-xs px-2.5 py-1.5 bg-gray-100 hover:bg-gray-200 text-gray-600 rounded-lg transition-colors"
                            >
                              Ignorar
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Right: cobranças sem extrato */}
            <div>
              <h2 className="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-2">
                Cobranças pagas sem extrato
                {semExtrato.length > 0 && (
                  <span className="text-xs bg-orange-100 text-orange-700 px-2 py-0.5 rounded-full">{semExtrato.length}</span>
                )}
              </h2>
              {!semExtrato.length ? (
                <div className="bg-white border border-gray-200 rounded-xl p-8 text-center text-gray-400 text-sm">
                  Nenhuma cobrança paga sem extrato correspondente.
                </div>
              ) : (
                <div className="space-y-3">
                  {semExtrato.map((c: any) => (
                    <div key={c.id} className="bg-white border border-orange-100 rounded-xl p-4">
                      <div className="flex items-start justify-between">
                        <div>
                          <p className="text-sm font-medium text-gray-900">
                            {c.contrato?.tomador?.nome ?? "Tomador desconhecido"}
                          </p>
                          <p className="text-xs text-gray-500 mt-0.5">
                            Vencto: {fmtDate(c.vencimento)} · {fmtBrl((c.valor ?? 0) / 100)}
                          </p>
                          {c.pixStatus === "PAGO" && (
                            <span className="text-xs text-green-700 mt-0.5 block">PIX pago</span>
                          )}
                          {c.boletoStatus === "PAGO" && (
                            <span className="text-xs text-green-700 mt-0.5 block">Boleto pago</span>
                          )}
                        </div>
                        <span className="text-xs bg-orange-100 text-orange-700 px-2 py-0.5 rounded-full font-medium">
                          Sem extrato
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {/* Confirm match modal */}
      {matchModal && (
        <ConfirmMatchModal
          statement={matchModal.statement}
          suggestion={matchModal.suggestion}
          cobrancas={cobrancasList}
          emitenteId={emitenteId}
          onClose={() => setMatchModal(null)}
          onMatched={invalidate}
        />
      )}
    </div>
  );
}
