import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { trpc } from "../../lib/trpc";

export const BANK_METADATA = {
  SICOOB:   { name: "Sicoob",      code: "756" },
  BRADESCO: { name: "Bradesco",    code: "237" },
  INTER:    { name: "Inter",       code: "077" },
  BTG:      { name: "BTG Pactual", code: "208" },
} as const;

function fmtBrl(v: number) {
  return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function fmtDateTime(d: string | Date | null | undefined) {
  if (!d) return "-";
  return new Date(d).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

function credentialStatus(account: {
  credentialOk: boolean | null;
  credentialExpiresAt: string | Date | null;
  isActive: boolean;
}): { label: string; cls: string } {
  if (!account.isActive) {
    return { label: "Inativa", cls: "bg-gray-100 text-gray-500" };
  }
  if (!account.credentialOk) {
    return { label: "Sem credencial", cls: "bg-red-100 text-red-700" };
  }
  if (account.credentialExpiresAt) {
    const diff = new Date(account.credentialExpiresAt).getTime() - Date.now();
    const days = Math.ceil(diff / 86_400_000);
    if (days <= 0) {
      return { label: "Cert. expirado", cls: "bg-red-100 text-red-700" };
    }
    if (days <= 30) {
      return { label: `Cert. expirando (${days}d)`, cls: "bg-yellow-100 text-yellow-700" };
    }
  }
  return { label: "Ativa", cls: "bg-green-100 text-green-700" };
}

function Skeleton() {
  return (
    <div className="space-y-4">
      {[1, 2, 3].map((i) => (
        <div key={i} className="bg-white border border-gray-200 rounded-xl p-5 animate-pulse">
          <div className="flex items-center gap-4">
            <div className="h-10 w-10 bg-gray-200 rounded-lg" />
            <div className="flex-1 space-y-2">
              <div className="h-4 bg-gray-200 rounded w-1/3" />
              <div className="h-3 bg-gray-100 rounded w-1/4" />
            </div>
            <div className="h-8 w-24 bg-gray-200 rounded-lg" />
          </div>
        </div>
      ))}
    </div>
  );
}

export default function ContasBancarias() {
  const navigate = useNavigate();
  const utils = trpc.useUtils();

  const { data: empresas } = trpc.empresa.listar.useQuery();
  const [emitenteId, setEmitenteId] = useState(() => localStorage.getItem("avoce_emitenteId") ?? "");
  const [syncingAll, setSyncingAll] = useState(false);
  const [syncing, setSyncing] = useState<string | null>(null);

  const { data: accounts, isLoading } = trpc.banking.accounts.list.useQuery(
    { emitenteId },
    { enabled: !!emitenteId }
  );
  const { data: summary } = trpc.banking.accounts.summary.useQuery(
    { emitenteId },
    { enabled: !!emitenteId }
  );

  const syncMut = trpc.banking.statements.sync.useMutation({
    onSuccess: () => {
      utils.banking.accounts.list.invalidate({ emitenteId });
      utils.banking.accounts.summary.invalidate({ emitenteId });
    },
  });

  function handleEmitenteChange(id: string) {
    setEmitenteId(id);
    localStorage.setItem("avoce_emitenteId", id);
  }

  async function syncAccount(id: string) {
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - 30);
    setSyncing(id);
    try {
      await syncMut.mutateAsync({
        emitenteId,
        bankAccountId: id,
        startDate: start.toISOString(),
        endDate: end.toISOString(),
      });
    } finally {
      setSyncing(null);
    }
  }

  async function syncAll() {
    if (!accounts?.length) return;
    setSyncingAll(true);
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - 30);
    try {
      for (const acc of accounts) {
        await syncMut.mutateAsync({
          emitenteId,
          bankAccountId: acc.id,
          startDate: start.toISOString(),
          endDate: end.toISOString(),
        });
      }
    } finally {
      setSyncingAll(false);
    }
  }

  return (
    <div className="p-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Contas Bancárias</h1>
          <p className="text-sm text-gray-500 mt-1">Gerencie suas contas e sincronize extratos.</p>
        </div>
        <div className="flex items-center gap-3">
          <select
            value={emitenteId}
            onChange={(e) => handleEmitenteChange(e.target.value)}
            className="border rounded-lg px-3 py-2 text-sm"
          >
            <option value="">Selecione a empresa</option>
            {empresas?.map((e) => (
              <option key={e.id} value={e.id}>{e.nomeFantasia || e.nome}</option>
            ))}
          </select>
          {emitenteId && (
            <>
              <button
                onClick={syncAll}
                disabled={syncingAll || !accounts?.length}
                className="text-sm px-4 py-2 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 rounded-lg disabled:opacity-50 transition-colors"
              >
                {syncingAll ? "Sincronizando..." : "Sincronizar Todas"}
              </button>
              <button
                onClick={() => navigate(`/financeiro/contas/nova?emitenteId=${emitenteId}`)}
                className="text-sm px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg transition-colors"
              >
                + Nova Conta
              </button>
            </>
          )}
        </div>
      </div>

      {!emitenteId ? (
        <div className="bg-white border border-gray-200 rounded-xl p-12 text-center text-gray-400 text-sm">
          Selecione uma empresa para ver as contas bancárias.
        </div>
      ) : (
        <>
          {/* Summary card */}
          {summary && (
            <div className="grid grid-cols-3 gap-4 mb-6">
              <div className="bg-white border border-gray-200 rounded-xl p-5">
                <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Saldo Total</p>
                <p className="text-2xl font-bold text-gray-900">{fmtBrl(summary.totalBalance ?? 0)}</p>
                <p className="text-xs text-gray-400 mt-1">{summary.accounts?.length ?? 0} conta(s) ativa(s)</p>
              </div>
              <div className="bg-white border border-green-100 rounded-xl p-5">
                <p className="text-xs font-medium text-green-700 uppercase tracking-wide mb-1">Contas sincronizadas</p>
                <p className="text-2xl font-bold text-green-700">{summary.accounts?.filter((a: any) => a.lastSyncAt).length ?? 0}</p>
              </div>
              <div className="bg-white border border-red-100 rounded-xl p-5">
                <p className="text-xs font-medium text-red-700 uppercase tracking-wide mb-1">Com alerta</p>
                <p className="text-2xl font-bold text-red-700">{summary.accounts?.filter((a: any) => a.credentialOk === false).length ?? 0}</p>
              </div>
            </div>
          )}

          {/* Accounts grid */}
          {isLoading ? (
            <Skeleton />
          ) : !accounts?.length ? (
            <div className="bg-white border border-gray-200 rounded-xl p-12 text-center">
              <p className="text-gray-400 text-sm mb-4">Nenhuma conta bancária cadastrada.</p>
              <button
                onClick={() => navigate(`/financeiro/contas/nova?emitenteId=${emitenteId}`)}
                className="text-sm px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg"
              >
                + Adicionar Conta
              </button>
            </div>
          ) : (
            <div className="space-y-4">
              {accounts.map((acc) => {
                const provider = (acc as any).provider as keyof typeof BANK_METADATA;
                const meta = BANK_METADATA[provider];
                const status = credentialStatus(acc as any);
                const isSyncing = syncing === acc.id;
                return (
                  <div key={acc.id} className="bg-white border border-gray-200 rounded-xl p-5 flex items-center gap-5">
                    {/* Bank logo */}
                    <div className="flex-shrink-0">
                      <img
                        src={`/assets/banks/${provider?.toLowerCase()}.svg`}
                        alt={meta?.name ?? provider}
                        className="h-10 w-10 rounded-lg object-contain"
                        onError={(e) => {
                          (e.target as HTMLImageElement).style.display = "none";
                        }}
                      />
                      <div className="h-10 w-10 bg-indigo-100 rounded-lg flex items-center justify-center text-indigo-700 text-xs font-bold" style={{ display: "none" }}>
                        {meta?.code ?? "?"}
                      </div>
                    </div>

                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="font-semibold text-gray-900">{(acc as any).name}</p>
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${status.cls}`}>
                          {status.label}
                        </span>
                        {(acc as any).isDefault && (
                          <span className="text-xs px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700 font-medium">
                            Padrão
                          </span>
                        )}
                      </div>
                      <p className="text-sm text-gray-500 mt-0.5">
                        {meta?.name ?? provider} · Ag. {(acc as any).agency}{(acc as any).agencyDigit ? `-${(acc as any).agencyDigit}` : ""} · Cc. {(acc as any).account}{(acc as any).accountDigit ? `-${(acc as any).accountDigit}` : ""}
                      </p>
                      {(acc as any).lastSyncAt && (
                        <p className="text-xs text-gray-400 mt-0.5">
                          Última sincronização: {fmtDateTime((acc as any).lastSyncAt)}
                        </p>
                      )}
                    </div>

                    {/* Balance */}
                    <div className="text-right flex-shrink-0">
                      <p className="text-sm text-gray-400 mb-0.5">Saldo</p>
                      <p className="text-xl font-bold text-gray-900">{fmtBrl((acc as any).currentBalance ?? 0)}</p>
                    </div>

                    {/* Actions */}
                    <div className="flex gap-2 flex-shrink-0">
                      <button
                        onClick={() => syncAccount(acc.id)}
                        disabled={isSyncing || syncingAll}
                        className="text-xs px-3 py-1.5 bg-teal-50 hover:bg-teal-100 text-teal-700 rounded-lg disabled:opacity-50 transition-colors"
                      >
                        {isSyncing ? "..." : "Sincronizar"}
                      </button>
                      <Link
                        to={`/financeiro/contas/${acc.id}?emitenteId=${emitenteId}`}
                        className="text-xs px-3 py-1.5 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg transition-colors"
                      >
                        Editar
                      </Link>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
