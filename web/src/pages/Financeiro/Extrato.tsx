import { useState, useRef } from "react";
import { trpc } from "../../lib/trpc";

function fmtBrl(v: number) {
  return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}
function fmtDate(d: string | Date | null | undefined) {
  if (!d) return "-";
  return new Date(d).toLocaleDateString("pt-BR");
}
function fmtDateTime(d: string | Date | null | undefined) {
  if (!d) return "-";
  return new Date(d).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

const RECON_COLORS: Record<string, string> = {
  MATCHED:   "bg-green-100 text-green-700",
  IGNORED:   "bg-gray-100 text-gray-500",
  UNMATCHED: "bg-yellow-100 text-yellow-700",
};
const RECON_LABELS: Record<string, string> = {
  MATCHED:   "Conciliado",
  IGNORED:   "Ignorado",
  UNMATCHED: "Pendente",
};
const FONTE_COLORS: Record<string, string> = {
  MANUAL: "bg-purple-100 text-purple-700",
  OFX:    "bg-blue-100 text-blue-700",
  API:    "bg-teal-100 text-teal-700",
};

// ─── Manual statement modal ──────────────────────────────────────────────────

interface ManualModalProps {
  emitenteId: string;
  bankAccountId: string;
  onClose: () => void;
  onSaved: () => void;
}
function ManualStatementModal({ emitenteId, bankAccountId, onClose, onSaved }: ManualModalProps) {
  const [entryDate, setEntryDate] = useState(new Date().toISOString().slice(0, 10));
  const [valor, setValor] = useState("");
  const [entryType, setEntryType] = useState<"CREDIT" | "DEBIT">("CREDIT");
  const [description, setDescription] = useState("");
  const [documentNumber, setDocumentNumber] = useState("");
  const [counterpartyName, setCounterpartyName] = useState("");
  const [counterpartyDocument, setCounterpartyDocument] = useState("");
  const [category, setCategory] = useState("");

  const createMut = trpc.banking.statements.createManual.useMutation({
    onSuccess: () => { onSaved(); onClose(); },
    onError: (e) => alert("Erro: " + e.message),
  });

  function handleSave() {
    const amount = parseFloat(valor);
    if (!amount || amount <= 0) { alert("Informe um valor válido."); return; }
    if (!description.trim()) { alert("Informe a descrição."); return; }
    const date = new Date(entryDate + "T12:00:00");
    createMut.mutate({
      emitenteId,
      bankAccountId,
      entryDate: date.toISOString(),
      amount,
      entryType,
      description: description.trim(),
      documentNumber: documentNumber || undefined,
      counterpartyName: counterpartyName || undefined,
      counterpartyDocument: counterpartyDocument || undefined,
      category: category || undefined,
    });
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6 space-y-4">
        <h2 className="text-lg font-semibold text-gray-900">Lançamento Manual</h2>

        <div className="flex rounded-lg border overflow-hidden">
          {(["CREDIT", "DEBIT"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setEntryType(t)}
              className={`flex-1 py-2 text-sm font-medium transition-colors ${
                entryType === t
                  ? t === "CREDIT" ? "bg-green-600 text-white" : "bg-red-600 text-white"
                  : "text-gray-600 hover:bg-gray-50"
              }`}
            >
              {t === "CREDIT" ? "Crédito" : "Débito"}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Data</label>
            <input type="date" value={entryDate} onChange={(e) => setEntryDate(e.target.value)}
              className="w-full border rounded-lg px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Valor (R$)</label>
            <input type="number" step="0.01" min="0" value={valor} onChange={(e) => setValor(e.target.value)}
              className="w-full border rounded-lg px-3 py-2 text-sm" placeholder="0,00" />
          </div>
          <div className="col-span-2">
            <label className="block text-xs font-medium text-gray-600 mb-1">Descrição</label>
            <input type="text" value={description} onChange={(e) => setDescription(e.target.value)}
              className="w-full border rounded-lg px-3 py-2 text-sm" placeholder="Descrição do lançamento" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Nº Documento</label>
            <input type="text" value={documentNumber} onChange={(e) => setDocumentNumber(e.target.value)}
              className="w-full border rounded-lg px-3 py-2 text-sm" placeholder="NF-001" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Categoria</label>
            <input type="text" value={category} onChange={(e) => setCategory(e.target.value)}
              className="w-full border rounded-lg px-3 py-2 text-sm" placeholder="Honorários, aluguel..." />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Contrapartida</label>
            <input type="text" value={counterpartyName} onChange={(e) => setCounterpartyName(e.target.value)}
              className="w-full border rounded-lg px-3 py-2 text-sm" placeholder="Nome" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">CPF/CNPJ</label>
            <input type="text" value={counterpartyDocument} onChange={(e) => setCounterpartyDocument(e.target.value)}
              className="w-full border rounded-lg px-3 py-2 text-sm" placeholder="000.000.000-00" />
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg">Cancelar</button>
          <button
            onClick={handleSave}
            disabled={createMut.isPending}
            className="px-4 py-2 bg-indigo-600 text-white text-sm rounded-lg hover:bg-indigo-700 disabled:opacity-50"
          >
            {createMut.isPending ? "Salvando..." : "Salvar"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Import modal ────────────────────────────────────────────────────────────

interface ImportModalProps {
  emitenteId: string;
  bankAccountId: string;
  onClose: () => void;
  onImported: () => void;
}
function ImportStatementModal({ emitenteId, bankAccountId, onClose, onImported }: ImportModalProps) {
  const [tab, setTab] = useState<"OFX" | "CSV">("OFX");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string[][]>([]);
  const [csvMapping, setCsvMapping] = useState<Record<string, string>>({});
  const [importResult, setImportResult] = useState<{ imported: number; duplicates: number } | null>(null);
  const [loading, setLoading] = useState(false);

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setFile(f);
    setImportResult(null);

    if (tab === "CSV") {
      const reader = new FileReader();
      reader.onload = (ev) => {
        const text = ev.target?.result as string;
        const lines = text.split("\n").slice(0, 11).map((l) => l.split(","));
        setPreview(lines);
      };
      reader.readAsText(f);
    }
  }

  async function handleImport() {
    if (!file) return;
    setLoading(true);
    try {
      const token = localStorage.getItem("avoce_token");
      const formData = new FormData();
      formData.append("file", file);
      formData.append("emitenteId", emitenteId);
      formData.append("bankAccountId", bankAccountId);
      if (tab === "CSV") formData.append("mapping", JSON.stringify(csvMapping));

      const endpoint = tab === "OFX" ? "/api/banking/import/ofx" : "/api/banking/import/csv";
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message ?? "Erro ao importar");
      setImportResult({ imported: json.imported ?? 0, duplicates: json.duplicates ?? 0 });
      onImported();
    } catch (err: any) {
      alert("Erro ao importar: " + err.message);
    } finally {
      setLoading(false);
    }
  }

  const csvHeaders = preview[0] ?? [];

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg p-6 space-y-4">
        <h2 className="text-lg font-semibold text-gray-900">Importar Extrato</h2>

        {/* Tabs */}
        <div className="flex border rounded-lg overflow-hidden">
          {(["OFX", "CSV"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => { setTab(t); setFile(null); setPreview([]); setImportResult(null); }}
              className={`flex-1 py-2 text-sm font-medium transition-colors ${
                tab === t ? "bg-indigo-600 text-white" : "text-gray-600 hover:bg-gray-50"
              }`}
            >
              {t}
            </button>
          ))}
        </div>

        {tab === "OFX" ? (
          <div className="space-y-3">
            <p className="text-xs text-gray-500">Arquivo OFX exportado do seu Internet Banking.</p>
            <input type="file" accept=".ofx,.qfx" onChange={handleFileChange}
              className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 file:mr-3 file:py-1 file:px-3 file:rounded file:border-0 file:text-xs file:bg-indigo-50 file:text-indigo-700 hover:file:bg-indigo-100" />
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-gray-500">Arquivo CSV com cabeçalho. Mapeie as colunas após selecionar o arquivo.</p>
            <input type="file" accept=".csv,.txt" onChange={handleFileChange}
              className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 file:mr-3 file:py-1 file:px-3 file:rounded file:border-0 file:text-xs file:bg-indigo-50 file:text-indigo-700 hover:file:bg-indigo-100" />

            {preview.length > 0 && (
              <>
                <div className="overflow-x-auto border rounded-lg">
                  <table className="w-full text-xs">
                    <thead className="bg-gray-50">
                      <tr>{csvHeaders.map((h, i) => <th key={i} className="px-2 py-1 text-left font-medium text-gray-500">{h}</th>)}</tr>
                    </thead>
                    <tbody>
                      {preview.slice(1, 5).map((row, i) => (
                        <tr key={i} className="border-t">
                          {row.map((cell, j) => <td key={j} className="px-2 py-1 text-gray-700">{cell}</td>)}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {["data", "descricao", "valor", "tipo"].map((field) => (
                    <div key={field}>
                      <label className="block text-xs font-medium text-gray-600 mb-1 capitalize">{field}</label>
                      <select
                        value={csvMapping[field] ?? ""}
                        onChange={(e) => setCsvMapping((p) => ({ ...p, [field]: e.target.value }))}
                        className="w-full border rounded-lg px-2 py-1 text-xs"
                      >
                        <option value="">— coluna —</option>
                        {csvHeaders.map((h, i) => <option key={i} value={h}>{h}</option>)}
                      </select>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {importResult && (
          <div className="bg-green-50 border border-green-200 rounded-lg px-3 py-2 text-sm text-green-800">
            {importResult.imported} importados, {importResult.duplicates} duplicatas ignoradas.
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg">Fechar</button>
          <button
            onClick={handleImport}
            disabled={!file || loading}
            className="px-4 py-2 bg-indigo-600 text-white text-sm rounded-lg hover:bg-indigo-700 disabled:opacity-50"
          >
            {loading ? "Importando..." : "Importar"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Main page ───────────────────────────────────────────────────────────────

export default function Extrato() {
  const utils = trpc.useUtils();

  const { data: empresas } = trpc.empresa.listar.useQuery();
  const [emitenteId, setEmitenteId] = useState(() => localStorage.getItem("avoce_emitenteId") ?? "");
  const [bankAccountId, setBankAccountId] = useState("");

  const today = new Date();
  const firstOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
  const [startDate, setStartDate] = useState(firstOfMonth.toISOString().slice(0, 10));
  const [endDate, setEndDate] = useState(today.toISOString().slice(0, 10));
  const [tipoFilter, setTipoFilter] = useState<"" | "CREDIT" | "DEBIT">("");
  const [reconFilter, setReconFilter] = useState("");
  const [search, setSearch] = useState("");
  const [skip, setSkip] = useState(0);
  const TAKE = 50;

  const [showManualModal, setShowManualModal] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);

  function handleEmitenteChange(id: string) {
    setEmitenteId(id);
    localStorage.setItem("avoce_emitenteId", id);
    setBankAccountId("");
  }

  const { data: accounts } = trpc.banking.accounts.list.useQuery(
    { emitenteId },
    { enabled: !!emitenteId }
  );

  const startIso = startDate ? new Date(startDate + "T00:00:00").toISOString() : undefined;
  const endIso   = endDate   ? new Date(endDate   + "T23:59:59").toISOString() : undefined;

  const { data: statementsData, isLoading } = trpc.banking.statements.list.useQuery(
    {
      emitenteId,
      bankAccountId: bankAccountId || undefined,
      startDate: startIso,
      endDate: endIso,
      reconciliationStatus: reconFilter || undefined,
      skip,
      take: TAKE,
    },
    { enabled: !!emitenteId }
  );

  const { data: syncLogs } = trpc.banking.statements.syncLogs.useQuery(
    { emitenteId, bankAccountId: bankAccountId || undefined, limit: 1 },
    { enabled: !!emitenteId }
  );

  function invalidate() {
    utils.banking.statements.list.invalidate({ emitenteId });
    utils.banking.statements.syncLogs.invalidate({ emitenteId });
  }

  const statements = (statementsData as any)?.statements ?? (statementsData as any)?.items ?? [];
  const total = (statementsData as any)?.total ?? statements.length;

  const filtered = statements.filter((s: any) => {
    if (tipoFilter && s.entryType !== tipoFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      if (!s.description?.toLowerCase().includes(q) && !s.counterpartyName?.toLowerCase().includes(q)) return false;
    }
    return true;
  });

  function exportCsv() {
    const rows = [
      ["Data", "Descrição", "Contrapartida", "Tipo", "Valor", "Saldo", "Status", "Fonte"],
      ...filtered.map((s: any) => [
        fmtDate(s.entryDate),
        s.description ?? "",
        s.counterpartyName ?? "",
        s.entryType === "CREDIT" ? "Crédito" : "Débito",
        (s.amount ?? 0).toFixed(2).replace(".", ","),
        (s.runningBalance ?? 0).toFixed(2).replace(".", ","),
        RECON_LABELS[s.reconciliationStatus] ?? s.reconciliationStatus,
        s.source ?? "",
      ]),
    ];
    const csv = rows.map((r: string[]) => r.map((c: string) => `"${c}"`).join(";")).join("\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `extrato_${startDate}_${endDate}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const lastSync = syncLogs?.[0];

  return (
    <div className="p-4 md:p-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-6 gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Extrato Bancário</h1>
          {lastSync && (
            <p className="text-xs text-gray-400 mt-1">
              Última sincronização: {fmtDateTime((lastSync as any).createdAt)}
            </p>
          )}
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setShowManualModal(true)}
            disabled={!bankAccountId}
            className="text-sm px-3 py-2 bg-green-50 hover:bg-green-100 text-green-700 rounded-lg disabled:opacity-50 transition-colors"
          >
            + Lançamento Manual
          </button>
          <button
            onClick={() => setShowImportModal(true)}
            disabled={!bankAccountId}
            className="text-sm px-3 py-2 bg-blue-50 hover:bg-blue-100 text-blue-700 rounded-lg disabled:opacity-50 transition-colors"
          >
            Importar OFX/CSV
          </button>
          <button
            onClick={exportCsv}
            disabled={!filtered.length}
            className="text-sm px-3 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg disabled:opacity-50 transition-colors"
          >
            Exportar CSV
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="bg-white border border-gray-200 rounded-xl p-4 mb-5 flex flex-wrap gap-3 items-end">
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Empresa</label>
          <select value={emitenteId} onChange={(e) => handleEmitenteChange(e.target.value)}
            className="border rounded-lg px-3 py-2 text-sm">
            <option value="">Selecione...</option>
            {empresas?.map((e) => <option key={e.id} value={e.id}>{e.nomeFantasia || e.nome}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Conta</label>
          <select value={bankAccountId} onChange={(e) => setBankAccountId(e.target.value)}
            className="border rounded-lg px-3 py-2 text-sm">
            <option value="">Todas as contas</option>
            {accounts?.map((a: any) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">De</label>
          <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)}
            className="border rounded-lg px-3 py-2 text-sm" />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Até</label>
          <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)}
            className="border rounded-lg px-3 py-2 text-sm" />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Tipo</label>
          <select value={tipoFilter} onChange={(e) => setTipoFilter(e.target.value as any)}
            className="border rounded-lg px-3 py-2 text-sm">
            <option value="">Todos</option>
            <option value="CREDIT">Crédito</option>
            <option value="DEBIT">Débito</option>
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Conciliação</label>
          <select value={reconFilter} onChange={(e) => setReconFilter(e.target.value)}
            className="border rounded-lg px-3 py-2 text-sm">
            <option value="">Todos</option>
            <option value="MATCHED">Conciliados</option>
            <option value="UNMATCHED">Pendentes</option>
            <option value="IGNORED">Ignorados</option>
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Busca</label>
          <input type="text" value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder="Descrição ou contrapartida..."
            className="border rounded-lg px-3 py-2 text-sm w-48" />
        </div>
      </div>

      {/* Table */}
      {!emitenteId ? (
        <div className="bg-white border border-gray-200 rounded-xl p-12 text-center text-gray-400 text-sm">
          Selecione uma empresa para ver o extrato.
        </div>
      ) : isLoading ? (
        <div className="bg-white border border-gray-200 rounded-xl p-8 text-center text-gray-400 text-sm animate-pulse">
          Carregando...
        </div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-xl overflow-x-auto">
          <table className="w-full text-sm min-w-[560px]">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Data</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Descrição</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Contrapartida</th>
                <th className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase">Valor</th>
                <th className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase">Saldo</th>
                <th className="text-center px-4 py-3 text-xs font-medium text-gray-500 uppercase">Status</th>
                <th className="text-center px-4 py-3 text-xs font-medium text-gray-500 uppercase">Fonte</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filtered.map((s: any) => (
                <tr key={s.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 text-gray-600 whitespace-nowrap">{fmtDate(s.entryDate)}</td>
                  <td className="px-4 py-3 text-gray-900 max-w-xs truncate">{s.description ?? "-"}</td>
                  <td className="px-4 py-3 text-gray-500 text-xs">
                    {s.counterpartyName && <p className="font-medium text-gray-700">{s.counterpartyName}</p>}
                    {s.counterpartyDocument && <p className="text-gray-400">{s.counterpartyDocument}</p>}
                  </td>
                  <td className={`px-4 py-3 text-right font-semibold whitespace-nowrap ${s.entryType === "CREDIT" ? "text-green-700" : "text-red-700"}`}>
                    {s.entryType === "CREDIT" ? "+" : "−"}{fmtBrl(Math.abs(s.amount ?? 0))}
                  </td>
                  <td className="px-4 py-3 text-right text-gray-700 whitespace-nowrap">
                    {s.runningBalance != null ? fmtBrl(s.runningBalance) : "-"}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${RECON_COLORS[s.reconciliationStatus] ?? "bg-gray-100 text-gray-500"}`}>
                      {RECON_LABELS[s.reconciliationStatus] ?? s.reconciliationStatus ?? "-"}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-center">
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${FONTE_COLORS[s.source] ?? "bg-gray-100 text-gray-500"}`}>
                      {s.source ?? "-"}
                    </span>
                  </td>
                </tr>
              ))}
              {!filtered.length && (
                <tr>
                  <td colSpan={7} className="text-center text-gray-400 py-10">
                    Nenhum lançamento encontrado no período.
                  </td>
                </tr>
              )}
            </tbody>
          </table>

          {/* Pagination */}
          {total > TAKE && (
            <div className="flex items-center justify-between px-4 py-3 border-t border-gray-100 bg-gray-50">
              <p className="text-xs text-gray-500">
                {skip + 1}–{Math.min(skip + TAKE, total)} de {total}
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => setSkip(Math.max(0, skip - TAKE))}
                  disabled={skip === 0}
                  className="text-xs px-3 py-1.5 bg-white border border-gray-200 rounded-lg disabled:opacity-40 hover:bg-gray-50"
                >
                  ← Anterior
                </button>
                <button
                  onClick={() => setSkip(skip + TAKE)}
                  disabled={skip + TAKE >= total}
                  className="text-xs px-3 py-1.5 bg-white border border-gray-200 rounded-lg disabled:opacity-40 hover:bg-gray-50"
                >
                  Próxima →
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Modals */}
      {showManualModal && bankAccountId && (
        <ManualStatementModal
          emitenteId={emitenteId}
          bankAccountId={bankAccountId}
          onClose={() => setShowManualModal(false)}
          onSaved={invalidate}
        />
      )}
      {showImportModal && bankAccountId && (
        <ImportStatementModal
          emitenteId={emitenteId}
          bankAccountId={bankAccountId}
          onClose={() => setShowImportModal(false)}
          onImported={invalidate}
        />
      )}
    </div>
  );
}
