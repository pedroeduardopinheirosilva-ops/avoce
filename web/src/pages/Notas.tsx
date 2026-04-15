import { useState } from "react";
import { trpc } from "../lib/trpc";

interface NotaItem {
  id: string;
  numero?: string | null;
  status: string;
}

function fmt(centavos: number) {
  return (centavos / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  PENDENTE:  { label: "Pendente",  color: "bg-yellow-100 text-yellow-800" },
  EMITIDA:   { label: "Emitida",   color: "bg-green-100  text-green-800"  },
  ERRO:      { label: "Erro",      color: "bg-red-100    text-red-800"    },
  CANCELADA: { label: "Cancelada", color: "bg-gray-100   text-gray-800"   },
};

export default function Notas() {
  const utils  = trpc.useUtils();
  const [page, setPage]   = useState(1);
  const [filtroStatus, setFiltroStatus]       = useState("");
  const [filtroCompetencia, setFiltroCompetencia] = useState("");
  const [xmlModal, setXmlModal]         = useState<string | null>(null);
  const [cancelModal, setCancelModal]   = useState<NotaItem | null>(null);
  const [cancelErro, setCancelErro]     = useState<string | null>(null);

  const { data, isLoading } = trpc.nota.listar.useQuery({
    page,
    pageSize: 20,
    status:      filtroStatus      || undefined,
    competencia: filtroCompetencia || undefined,
  });

  const cancelar = trpc.nota.cancelar.useMutation({
    onSuccess: () => { utils.nota.listar.invalidate(); setCancelModal(null); setCancelErro(null); },
    onError:   (err) => setCancelErro(err.message),
  });
  const consultar = trpc.nota.consultar.useQuery;

  async function executarCron() {
    if (!confirm("Executar emissão do dia agora?")) return;
    await fetch("/api/cron/executar", {
      method: "POST",
      headers: { Authorization: `Bearer ${localStorage.getItem("avoce_token")}` },
    });
    setTimeout(() => utils.nota.listar.invalidate(), 3000);
    alert("Execução iniciada. Aguarde alguns segundos e recarregue.");
  }

  if (isLoading) return <div className="p-8 text-gray-500">Carregando...</div>;

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">NFS-e Emitidas</h1>
        <button onClick={executarCron} className="bg-amber-500 hover:bg-amber-600 text-white px-4 py-2 rounded-lg text-sm font-medium">
          ⚡ Emitir do Dia
        </button>
      </div>

      {/* Filtros */}
      <div className="flex gap-3 mb-4">
        <select value={filtroStatus} onChange={e => { setFiltroStatus(e.target.value); setPage(1); }}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm">
          <option value="">Todos os status</option>
          {Object.entries(STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
        <input value={filtroCompetencia} onChange={e => { setFiltroCompetencia(e.target.value); setPage(1); }}
          placeholder="MM/YYYY" className="border border-gray-300 rounded-lg px-3 py-2 text-sm w-28" />
      </div>

      <div className="bg-white rounded-xl border border-gray-200 overflow-x-auto">
        <table className="w-full text-sm min-w-[800px]">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="text-left px-4 py-3 font-medium text-gray-700">Nº NFS-e</th>
              <th className="text-left px-4 py-3 font-medium text-gray-700">Emitente</th>
              <th className="text-left px-4 py-3 font-medium text-gray-700">Tomador</th>
              <th className="text-left px-4 py-3 font-medium text-gray-700">Competência</th>
              <th className="text-right px-4 py-3 font-medium text-gray-700">Valor</th>
              <th className="text-left px-4 py-3 font-medium text-gray-700">Status</th>
              <th className="px-4 py-3 sticky right-0 bg-gray-50"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {data?.notas.map((n) => (
              <tr key={n.id} className="hover:bg-gray-50">
                <td className="px-4 py-3">
                  {n.numero ? (
                    n.linkNfse
                      ? <a href={n.linkNfse} target="_blank" rel="noreferrer" className="text-brand-600 hover:underline font-medium">{n.numero}</a>
                      : <span className="font-medium">{n.numero}</span>
                  ) : (
                    <span className="text-gray-400">—</span>
                  )}
                </td>
                <td className="px-4 py-3 text-gray-700">{n.emitente.nome}</td>
                <td className="px-4 py-3 text-gray-700">{n.contrato.tomador.nome}</td>
                <td className="px-4 py-3 text-gray-500">{n.competencia}</td>
                <td className="px-4 py-3 text-right font-medium">{fmt(n.valor)}</td>
                <td className="px-4 py-3">
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_LABELS[n.status]?.color ?? ""}`}>
                    {STATUS_LABELS[n.status]?.label ?? n.status}
                  </span>
                  {n.status === "ERRO" && n.erroMsg && (
                    <p className="text-xs text-red-500 mt-1 max-w-xs truncate" title={n.erroMsg}>{n.erroMsg}</p>
                  )}
                </td>
                <td className="px-4 py-3 text-right whitespace-nowrap sticky right-0 bg-white border-l border-gray-100">
                  {n.xmlRetorno && (
                    <>
                      <button onClick={() => setXmlModal(n.xmlRetorno!)}
                        className="text-xs text-gray-500 hover:text-gray-800 mr-1 px-2 py-1 border rounded">
                        XML
                      </button>
                      <a
                        href={`data:text/xml;charset=utf-8,${encodeURIComponent(n.xmlRetorno)}`}
                        download={`nfse-${n.numero ?? n.id}.xml`}
                        className="text-xs text-brand-600 hover:text-brand-800 mr-2 px-2 py-1 border border-brand-200 rounded"
                        title="Baixar XML"
                      >
                        ⬇ XML
                      </a>
                    </>
                  )}
                  {n.status === "EMITIDA" && (
                    <button
                      onClick={() => { setCancelErro(null); setCancelModal(n); }}
                      className="text-xs bg-red-50 hover:bg-red-100 text-red-700 border border-red-200 px-3 py-1.5 rounded-lg font-medium transition-colors"
                    >
                      ✕ Cancelar NFS-e
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {!data?.notas.length && (
              <tr><td colSpan={7} className="px-4 py-6 text-center text-gray-400">Nenhuma nota encontrada.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Paginação */}
      {(data?.pages ?? 0) > 1 && (
        <div className="flex gap-2 mt-4 justify-center">
          <button disabled={page <= 1} onClick={() => setPage(p => p - 1)}
            className="px-3 py-1.5 text-sm border rounded-lg disabled:opacity-40">Anterior</button>
          <span className="text-sm text-gray-600 self-center">{page} / {data?.pages}</span>
          <button disabled={page >= (data?.pages ?? 0)} onClick={() => setPage(p => p + 1)}
            className="px-3 py-1.5 text-sm border rounded-lg disabled:opacity-40">Próxima</button>
        </div>
      )}

      {/* Modal cancelamento NFS-e */}
      {cancelModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md">
            <div className="p-6">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 bg-red-100 rounded-full flex items-center justify-center text-red-600 text-lg font-bold flex-shrink-0">!</div>
                <div>
                  <h2 className="text-lg font-bold text-gray-900">Cancelar NFS-e</h2>
                  <p className="text-sm text-gray-500">Esta ação não pode ser desfeita</p>
                </div>
              </div>

              <div className="bg-gray-50 rounded-lg px-4 py-3 mb-4 text-sm text-gray-700">
                <p>Você está prestes a cancelar a <strong>NFS-e nº {cancelModal.numero}</strong> na prefeitura de Vitória da Conquista.</p>
              </div>

              {cancelErro && (
                <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 mb-4 text-sm text-red-700">
                  <strong>Erro:</strong> {cancelErro}
                </div>
              )}

              <div className="flex gap-3 justify-end">
                <button
                  onClick={() => { setCancelModal(null); setCancelErro(null); }}
                  disabled={cancelar.isPending}
                  className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50"
                >
                  Voltar
                </button>
                <button
                  onClick={() => cancelar.mutate({ id: cancelModal.id })}
                  disabled={cancelar.isPending}
                  className="px-4 py-2 text-sm bg-red-600 hover:bg-red-700 text-white rounded-lg font-medium disabled:opacity-50 flex items-center gap-2"
                >
                  {cancelar.isPending ? (
                    <><span className="animate-spin">⟳</span> Cancelando...</>
                  ) : (
                    "Confirmar cancelamento"
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Modal XML */}
      {xmlModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[80vh] flex flex-col">
            <div className="flex items-center justify-between p-4 border-b">
              <h2 className="font-bold">XML de Retorno</h2>
              <button onClick={() => setXmlModal(null)} className="text-gray-400 hover:text-gray-600 text-xl">×</button>
            </div>
            <pre className="flex-1 overflow-auto p-4 text-xs font-mono bg-gray-50 text-gray-800">
              {xmlModal}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
