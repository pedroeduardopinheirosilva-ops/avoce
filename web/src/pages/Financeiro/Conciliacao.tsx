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
  const [selectedCobranca, setSelectedCobranca] = useState<string>(
    suggestion?.cobrancaId ?? suggestion?.cobranca?.id ?? ""
  );

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
  const [tab, setTab] = useState<"pendentes" | "conciliados" | "semextrato">("pendentes");

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

  const { data: matched } = trpc.banking.reconciliation.matched.useQuery(
    { emitenteId, bankAccountId: bankAccountId || undefined },
    { enabled: !!emitenteId }
  );

  const { data: cobrancas } = trpc.cobranca.listar.useQuery({ pageSize: 500 }, { enabled: !!emitenteId });

  const runMut = trpc.banking.reconciliation.run.useMutation({
    onSuccess: (r: any) => {
      alert(`Conciliação concluída: ${r.matched ?? 0} de ${r.examined ?? 0} lançamentos conciliados automaticamente.`);
      invalidate();
    },
    onError: (e) => alert("Erro: " + e.message),
  });

  const applyAllMut = trpc.banking.reconciliation.applyAllSuggestions.useMutation({
    onSuccess: (r: any) => {
      alert(`${r.applied ?? 0} sugestões aplicadas.`);
      invalidate();
    },
    onError: (e) => alert("Erro: " + e.message),
  });

  const acceptMut = trpc.banking.reconciliation.applyMatch.useMutation({
    onSuccess: () => invalidate(),
    onError: (e) => alert("Erro: " + e.message),
  });

  const ignoreMut = trpc.banking.reconciliation.ignore.useMutation({
    onSuccess: () => invalidate(),
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
    utils.banking.reconciliation.matched.invalidate({ emitenteId });
  }

  function reconciledByLabel(by: string | null): { label: string; cls: string } {
    if (by === "auto-liquidacao") return { label: "Auto · Liquidação", cls: "bg-purple-100 text-purple-700" };
    if (by === "auto-sugestao")   return { label: "Auto · Sugestão",   cls: "bg-blue-100 text-blue-700" };
    if (by === "auto")            return { label: "Auto",              cls: "bg-green-100 text-green-700" };
    return { label: "Manual", cls: "bg-gray-100 text-gray-600" };
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

  const matchedCount = ((stats as any)?.matched ?? 0) + ((stats as any)?.manual ?? 0);
  const pct = stats ? Math.round((matchedCount / Math.max((stats as any).total ?? 0, 1)) * 100) : 0;

  // Sugestões de alta confiança (aplicáveis em lote) — 1 por lançamento
  const highConfidence = Object.values(suggMap).filter(
    (list) => (list[0]?.confidence ?? list[0]?.score ?? 0) >= 0.9
  ).length;

  return (
    <div className="p-4 md:p-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-6 gap-3">
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
            <>
              <button
                onClick={() => runMut.mutate({ emitenteId, bankAccountId })}
                disabled={runMut.isPending}
                className="text-sm px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg disabled:opacity-50 transition-colors"
              >
                {runMut.isPending ? "Rodando..." : "Rodar Conciliação Auto"}
              </button>
              {highConfidence > 0 && (
                <button
                  onClick={() => applyAllMut.mutate({ emitenteId, bankAccountId, minConfidence: 0.9 })}
                  disabled={applyAllMut.isPending}
                  className="text-sm px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg disabled:opacity-50 transition-colors"
                >
                  {applyAllMut.isPending ? "Aplicando..." : `Aceitar ${highConfidence} sugestões ≥90%`}
                </button>
              )}
            </>
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
              <div
                onClick={() => setTab("pendentes")}
                className={`bg-white border rounded-xl p-4 cursor-pointer transition-shadow hover:shadow-md ${tab === "pendentes" ? "border-yellow-400 ring-1 ring-yellow-200" : "border-gray-200"}`}
              >
                <p className="text-xs text-gray-500 mb-1">Pendentes</p>
                <p className="text-2xl font-bold text-yellow-600">{(stats as any).unmatched ?? 0}</p>
              </div>
              <div
                onClick={() => setTab("conciliados")}
                className={`bg-white border rounded-xl p-4 cursor-pointer transition-shadow hover:shadow-md ${tab === "conciliados" ? "border-green-400 ring-1 ring-green-200" : "border-gray-200"}`}
              >
                <p className="text-xs text-gray-500 mb-1">Conciliados</p>
                <p className="text-2xl font-bold text-green-700">{matchedCount}</p>
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

          {/* Abas */}
          <div className="flex gap-1 mb-4 bg-gray-100 rounded-xl p-1 w-fit">
            {([
              { key: "pendentes",   label: "Pendentes",             count: unmatchedList.length },
              { key: "conciliados", label: "Conciliados",           count: matched?.length ?? 0 },
              { key: "semextrato",  label: "Pagas sem entrada no banco", count: semExtrato.length },
            ] as const).map((t) => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={`px-4 py-2 text-sm rounded-lg transition-colors flex items-center gap-2 ${
                  tab === t.key ? "bg-white shadow-sm text-gray-900 font-medium" : "text-gray-500 hover:text-gray-800"
                }`}
              >
                {t.label}
                <span className={`text-xs px-1.5 py-0.5 rounded-full ${
                  tab === t.key ? "bg-indigo-100 text-indigo-700" : "bg-gray-200 text-gray-600"
                }`}>{t.count}</span>
              </button>
            ))}
          </div>

          {/* Pendentes: lançamentos sem conciliação */}
          {tab === "pendentes" && (
            <div className="max-w-4xl">
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
                                  const badge = confidenceBadge(s.confidence ?? s.score ?? 0);
                                  const cob = s.cobranca;
                                  return (
                                    <div key={i} className="flex items-center gap-2 text-xs">
                                      <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${badge.cls}`}>{badge.label}</span>
                                      <span className="text-gray-500 truncate">
                                        {cob?.tomadorNome ?? cob?.contrato?.tomador?.nome ?? s.cobrancaId}
                                        {cob?.valor != null && ` — ${fmtBrl(cob.valor / 100)}`}
                                        {cob?.vencimento && ` — vencto ${fmtDate(cob.vencimento)}`}
                                      </span>
                                      {cob?.emAberto && (
                                        <span className="px-1.5 py-0.5 rounded bg-orange-100 text-orange-700 font-medium flex-shrink-0">
                                          {cob.statusLabel ?? "Em aberto"}
                                        </span>
                                      )}
                                      <button
                                        onClick={() => acceptMut.mutate({ emitenteId, statementId: stmt.id, cobrancaId: s.cobrancaId })}
                                        disabled={acceptMut.isPending}
                                        className="px-2 py-0.5 bg-green-50 hover:bg-green-100 text-green-700 rounded font-medium transition-colors flex-shrink-0 disabled:opacity-50"
                                      >
                                        Aceitar
                                      </button>
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
                              onClick={() => { if (confirm("Ignorar este lançamento?")) ignoreMut.mutate({ emitenteId, statementId: stmt.id }); }}
                              disabled={ignoreMut.isPending}
                              className="text-xs px-2.5 py-1.5 bg-gray-100 hover:bg-gray-200 text-gray-600 rounded-lg transition-colors disabled:opacity-50"
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
          )}

          {/* Cobranças pagas sem entrada correspondente no extrato */}
          {tab === "semextrato" && (
            <div className="max-w-4xl">
              <p className="text-xs text-gray-500 mb-3">
                Cobranças marcadas como pagas (PIX, boleto ou baixa manual) cujo pagamento não foi
                encontrado em nenhum lançamento do extrato bancário — pagamento anterior ao período
                sincronizado, crédito agrupado ainda não conciliado, ou baixa dada sem o dinheiro
                ter entrado nesta conta.
              </p>
              {!semExtrato.length ? (
                <div className="bg-white border border-gray-200 rounded-xl p-8 text-center text-gray-400 text-sm">
                  Nenhuma cobrança paga sem entrada correspondente no banco.
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
                          Sem entrada no banco
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Conciliados — detalhe dos boletos/clientes liquidados em cada crédito */}
          {tab === "conciliados" && (
            <div className="max-w-4xl">
            {!matched?.length ? (
              <div className="bg-white border border-gray-200 rounded-xl p-8 text-center text-gray-400 text-sm">
                Nenhum lançamento conciliado ainda.
              </div>
            ) : (
              <div className="space-y-3">
                {matched.map((m: any) => {
                  const badge = reconciledByLabel(m.reconciledBy);
                  const somaCobrancas = m.cobrancas.reduce((s: number, c: any) => s + (c.valorPago ?? c.valor ?? 0), 0) / 100;
                  return (
                    <div key={m.id} className="bg-white border border-green-100 rounded-xl p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <p className="text-sm font-medium text-gray-900 truncate">{m.description}</p>
                            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${badge.cls}`}>{badge.label}</span>
                            {m.cobrancas.length > 1 && (
                              <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-purple-50 text-purple-700">
                                {m.cobrancas.length} boletos agrupados
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-gray-500 mt-0.5">
                            {fmtDate(m.entryDate)} · {fmtBrl(Math.abs(m.amount ?? 0))}
                            {m.cobrancas.length > 1 && ` · soma dos boletos ${fmtBrl(somaCobrancas)}`}
                          </p>

                          {/* Cobranças liquidadas neste crédito */}
                          <div className="mt-2 space-y-1">
                            {m.cobrancas.map((c: any) => (
                              <div key={c.id} className="flex items-center gap-2 text-xs">
                                <span className="w-1.5 h-1.5 rounded-full bg-green-500 flex-shrink-0" />
                                <span className="text-gray-700 font-medium truncate">{c.tomadorNome ?? "Cliente desconhecido"}</span>
                                <span className="text-gray-500 flex-shrink-0">{fmtBrl((c.valorPago ?? c.valor ?? 0) / 100)}</span>
                                {c.nossoNumero != null && (
                                  <span className="text-gray-400 flex-shrink-0">boleto {c.nossoNumero}</span>
                                )}
                                {c.competencia && (
                                  <span className="text-gray-400 flex-shrink-0">comp. {c.competencia}</span>
                                )}
                                {c.pagoEm && (
                                  <span className="text-gray-400 flex-shrink-0">pago em {fmtDate(c.pagoEm)}</span>
                                )}
                              </div>
                            ))}
                            {m.cobrancas.length === 0 && (
                              <p className="text-xs text-gray-400">Sem cobrança vinculada.</p>
                            )}
                          </div>
                        </div>

                        <button
                          onClick={() => { if (confirm("Desfazer esta conciliação?")) unmatchMut.mutate({ emitenteId, statementId: m.id }); }}
                          disabled={unmatchMut.isPending}
                          className="text-xs px-2.5 py-1.5 bg-gray-100 hover:bg-gray-200 text-gray-600 rounded-lg transition-colors flex-shrink-0 disabled:opacity-50"
                        >
                          Desfazer
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            </div>
          )}
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
