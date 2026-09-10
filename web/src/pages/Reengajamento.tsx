import { useState, useRef } from "react";
import { trpc } from "../lib/trpc";

// ── Modal de importar JSON ──────────────────────────────────────────────────

function ImportJsonModal({ onClose }: { onClose: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [projetoId, setProjetoId] = useState("");
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<{
    ok: boolean;
    totalNoJson?: number;
    contatosCriados?: number;
    dealsCriados?: number;
    dealsPulados?: number;
    erros?: number;
    error?: string;
  } | null>(null);

  const { data: projetos } = trpc.ia.listProjetos.useQuery();
  const utils = trpc.useUtils();
  const dispatch = trpc.reengajamento.dispararImportados.useMutation({
    onSuccess: () => utils.reengajamento.statusImportados.invalidate(),
  });
  const { data: statusImportados, refetch: refetchStatus } = trpc.reengajamento.statusImportados.useQuery(
    { projetoId: projetoId || undefined },
    { enabled: false },
  );

  async function handleImport() {
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    setImporting(true);
    setResult(null);

    try {
      const token = localStorage.getItem("avoce_token");
      const form = new FormData();
      form.append("file", file);
      if (projetoId) form.append("projetoId", projetoId);

      const resp = await fetch("/api/reengajamento/importar-json", {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: form,
      });

      const data = await resp.json();
      setResult(data);
      if (data.ok) {
        refetchStatus();
      }
    } catch (e: any) {
      setResult({ ok: false, error: e.message });
    } finally {
      setImporting(false);
    }
  }

  function handleDisparar() {
    if (!projetoId) return;
    dispatch.mutate({ projetoId, maxDeals: 500 });
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg space-y-4 p-6">
        <h2 className="text-lg font-semibold text-gray-900">Importar leads do funil RAP</h2>
        <p className="text-sm text-gray-500">
          Selecione o arquivo JSON exportado do funil de reengajamento. Os leads serão importados no pipeline "Reengajamento RAP" e ativados para a IA.
        </p>

        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Projeto IA (para Evolution API e persona)</label>
            <select value={projetoId} onChange={e => setProjetoId(e.target.value)} className="w-full border rounded-lg px-3 py-2 text-sm">
              <option value="">Selecione um projeto...</option>
              {projetos?.map(p => <option key={p.id} value={p.id}>{p.nome}</option>)}
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Arquivo JSON</label>
            <input
              ref={fileRef}
              type="file"
              accept=".json"
              className="w-full border rounded-lg px-3 py-2 text-sm file:mr-3 file:py-1 file:px-3 file:border-0 file:bg-indigo-50 file:text-indigo-700 file:text-sm file:rounded-md hover:file:bg-indigo-100"
            />
          </div>

          {statusImportados && statusImportados.total > 0 && (
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-sm text-blue-800">
              <p className="font-medium mb-1">Leads já importados anteriormente:</p>
              <p>{statusImportados.total} no total · {statusImportados.enviados} com mensagem enviada · {statusImportados.pendentes} pendentes</p>
              {statusImportados.stages.length > 0 && (
                <div className="mt-1 space-y-0.5">
                  {statusImportados.stages.map(s => (
                    <p key={s.chave} className="text-xs">
                      {s.nome}: {s.total} ({s.enviados} enviados)
                    </p>
                  ))}
                </div>
              )}
            </div>
          )}

          {result && (
            <div className={`rounded-lg p-3 text-sm ${result.ok ? "bg-green-50 text-green-800 border border-green-200" : "bg-red-50 text-red-800 border border-red-200"}`}>
              {result.ok ? (
                <div className="space-y-1">
                  <p className="font-medium">✓ Importação concluída</p>
                  <p>{result.totalNoJson} leads no JSON</p>
                  <p>{result.contatosCriados} contatos criados</p>
                  <p>{result.dealsCriados} leads criados no funil</p>
                  <p>{result.dealsPulados} leads pulados (já existiam)</p>
                  {result.erros ? <p className="text-red-600">{result.erros} erros</p> : null}
                </div>
              ) : (
                <p>Erro: {result.error}</p>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between pt-2">
          <div className="flex gap-2">
            {result?.ok && projetoId && (
              <button
                onClick={handleDisparar}
                disabled={dispatch.isPending}
                className="px-4 py-2 bg-green-600 text-white text-sm font-medium rounded-lg hover:bg-green-700 disabled:opacity-50"
              >
                {dispatch.isPending ? "Disparando..." : "▶ Disparar mensagens personalizadas"}
              </button>
            )}
          </div>
          <div className="flex gap-2 ml-auto">
            <button
              onClick={handleImport}
              disabled={importing}
              className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-50"
            >
              {importing ? "Importando..." : "Importar"}
            </button>
            <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg">
              Fechar
            </button>
          </div>
        </div>

        {dispatch.data && (() => {
          const d = dispatch.data as Record<string, any>;
          return (
            <div className={`rounded-lg p-3 text-sm ${d.ok ? "bg-green-50 text-green-800 border border-green-200" : "bg-red-50 text-red-800 border border-red-200"}`}>
              {d.ok ? (
                <p>✓ {d.enviados} mensagens enviadas · {d.semMensagem} sem mensagem personalizada</p>
              ) : (
                <p>Erro: {d.error || d.msg}</p>
              )}
              {d.erros?.length ? (
                <p className="text-xs mt-1 text-red-500">{d.erros.length} erros no disparo</p>
              ) : null}
            </div>
          );
        })()}
      </div>
    </div>
  );
}

// ── Funil Dashboard ─────────────────────────────────────────────────────────

const SPEED_OPTIONS = [
  { label: "Lento (3s)", value: 3000 },
  { label: "Normal (1s)", value: 1000 },
  { label: "Rápido (500ms)", value: 500 },
  { label: "Turbo (100ms)", value: 100 },
];

function FunnelDashboard({
  status,
}: {
  status: {
    pipelineId: string;
    total: number;
    stages: { chave: string; nome: string; total: number; enviados: number }[];
    enviados: number;
    pendentes: number;
  } | undefined;
}) {
  if (!status || status.total === 0) {
    return (
      <div className="bg-white rounded-xl border border-dashed border-gray-300 p-12 text-center">
        <p className="text-gray-400 text-sm">Nenhum lead importado ainda. Importe um JSON para ver o funil.</p>
      </div>
    );
  }

  const maxCount = Math.max(...status.stages.map(s => s.total), 1);

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-gray-900">📊 Funil Reengajamento RAP</h2>
        <a
          href={`/crm?pipelineId=${status.pipelineId}`}
          className="text-sm text-indigo-600 hover:text-indigo-800 font-medium"
        >
          Ver no Kanban →
        </a>
      </div>

      <div className="space-y-3">
        {status.stages.map(stage => {
          const pct = Math.round((stage.total / maxCount) * 100);
          return (
            <div key={stage.chave}>
              <div className="flex items-center justify-between text-sm mb-1">
                <span className="text-gray-700 font-medium">{stage.nome}</span>
                <div className="flex items-center gap-3">
                  <span className="text-gray-900 font-semibold">{stage.total}</span>
                  {stage.total > 0 && stage.enviados > 0 && (
                    <span className="text-xs text-green-600">{stage.enviados} enviados</span>
                  )}
                </div>
              </div>
              <div className="h-3 bg-gray-100 rounded-full overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-indigo-500 to-indigo-400 rounded-full transition-all"
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex items-center gap-4 text-sm text-gray-500 pt-2 border-t border-gray-100">
        <span>Total: <strong className="text-gray-900">{status.total}</strong></span>
        <span>Enviados: <strong className="text-green-700">{status.enviados}</strong></span>
        <span>Pendentes: <strong className="text-amber-700">{status.pendentes}</strong></span>
      </div>
    </div>
  );
}

// ── Página principal ────────────────────────────────────────────────────────

export default function Reengajamento() {
  const [importModal, setImportModal] = useState(false);
  const [projetoId, setProjetoId] = useState("");
  const [stageChaves, setStageChaves] = useState<string[]>(["reeng_importado"]);
  const [maxDeals, setMaxDeals] = useState(200);
  const [delayMs, setDelayMs] = useState(1000);

  const { data: projetos } = trpc.ia.listProjetos.useQuery();
  const utils = trpc.useUtils();
  const { data: status, isLoading: statusLoading } = trpc.reengajamento.statusImportados.useQuery(
    { projetoId: projetoId || undefined },
    { enabled: !!projetoId },
  );

  const dispatch = trpc.reengajamento.dispararImportados.useMutation({
    onSuccess: () => {
      utils.reengajamento.statusImportados.invalidate();
    },
  });

  function toggleStage(chave: string) {
    setStageChaves(prev =>
      prev.includes(chave) ? prev.filter(c => c !== chave) : [...prev, chave]
    );
  }

  function handleDispatch() {
    if (!projetoId || stageChaves.length === 0) return;
    dispatch.mutate({ projetoId, stageChaves, maxDeals, delayMs });
  }

  return (
    <div className="p-4 md:p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Reengajamento</h1>
          <p className="text-sm text-gray-500 mt-1">
            Importe leads do funil RAP, acompanhe o progresso e dispare mensagens personalizadas via WhatsApp.
          </p>
        </div>
        <button
          onClick={() => setImportModal(true)}
          className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700"
        >
          + Importar JSON
        </button>
      </div>

      {/* Seção A: Status da importação */}
      <div className="bg-white rounded-xl border border-gray-200 p-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-lg bg-indigo-100 flex items-center justify-center text-lg">📥</div>
            <div>
              <h2 className="font-semibold text-gray-900">Importação</h2>
              <p className="text-sm text-gray-500">
                {status
                  ? `${status.total} leads importados no pipeline`
                  : projetoId
                    ? "Carregando..."
                    : "Selecione um projeto IA abaixo para ver o status"}
              </p>
            </div>
          </div>
          {status && status.total > 0 && (
            <div className="text-right text-xs text-gray-500">
              <p>{status.enviados} já receberam mensagem</p>
              <p>{status.pendentes} pendentes</p>
            </div>
          )}
        </div>
      </div>

      {/* Seção B: Funil Dashboard */}
      <FunnelDashboard status={status} />

      {/* Seção C: Disparo */}
      <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-5">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-lg bg-green-100 flex items-center justify-center text-lg">🚀</div>
          <div>
            <h2 className="font-semibold text-gray-900">Disparar mensagens</h2>
            <p className="text-sm text-gray-500">Selecione o projeto, os estágios alvo e configure a velocidade do disparo.</p>
          </div>
        </div>

        {/* Projeto IA */}
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Projeto IA</label>
          <select
            value={projetoId}
            onChange={e => { setProjetoId(e.target.value); setStageChaves(["reeng_importado"]); }}
            className="w-full max-w-md border rounded-lg px-3 py-2 text-sm"
          >
            <option value="">Selecione um projeto...</option>
            {projetos?.map(p => (
              <option key={p.id} value={p.id}>{p.nome}</option>
            ))}
          </select>
        </div>

        {/* Estágios alvo */}
        {status && status.stages.length > 0 && (
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1.5">Estágios alvo do disparo</label>
            <div className="flex flex-wrap gap-2">
              {status.stages.map(s => (
                <label
                  key={s.chave}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-sm cursor-pointer transition-colors ${
                    stageChaves.includes(s.chave)
                      ? "bg-indigo-50 border-indigo-300 text-indigo-700"
                      : "bg-gray-50 border-gray-200 text-gray-600 hover:bg-gray-100"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={stageChaves.includes(s.chave)}
                    onChange={() => toggleStage(s.chave)}
                    className="rounded text-indigo-600"
                  />
                  <span>{s.nome}</span>
                  <span className="text-xs text-gray-400 ml-0.5">({s.total} leads)</span>
                </label>
              ))}
            </div>
          </div>
        )}

        {/* Configurações avançadas */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">
              Máximo de disparos: <strong>{maxDeals}</strong>
            </label>
            <input
              type="range"
              min={1}
              max={2000}
              value={maxDeals}
              onChange={e => setMaxDeals(Number(e.target.value))}
              className="w-full max-w-xs accent-indigo-600"
            />
            <div className="flex justify-between text-[10px] text-gray-400 max-w-xs">
              <span>1</span>
              <span>500</span>
              <span>1000</span>
              <span>2000</span>
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Velocidade</label>
            <select
              value={delayMs}
              onChange={e => setDelayMs(Number(e.target.value))}
              className="w-full max-w-xs border rounded-lg px-3 py-2 text-sm"
            >
              {SPEED_OPTIONS.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Botão disparar */}
        <div className="flex items-center gap-3">
          <button
            onClick={handleDispatch}
            disabled={!projetoId || stageChaves.length === 0 || dispatch.isPending}
            className="px-6 py-2.5 bg-green-600 text-white text-sm font-medium rounded-lg hover:bg-green-700 disabled:opacity-50 flex items-center gap-2"
          >
            {dispatch.isPending ? (
              <>⏳ Disparando...</>
            ) : (
              <>▶ Disparar mensagens personalizadas</>
            )}
          </button>
          {dispatch.isPending && (
            <span className="text-xs text-gray-400 animate-pulse">
              Enviando {maxDeals} mensagens com delay de {delayMs}ms...
            </span>
          )}
        </div>

        {/* Resultado do disparo */}
        {dispatch.data && (() => {
          const d = dispatch.data as Record<string, any>;
          return (
            <div className={`rounded-lg p-4 text-sm space-y-1 ${
              d.ok
                ? "bg-green-50 text-green-800 border border-green-200"
                : "bg-red-50 text-red-800 border border-red-200"
            }`}>
              {d.ok ? (
                <>
                  <p className="font-medium">✓ Disparo concluído</p>
                  <p>{d.enviados} mensagens enviadas</p>
                  <p>{d.semMensagem} leads sem mensagem personalizada</p>
                  {d.total && <p className="text-xs text-gray-500">{d.total} leads processados</p>}
                  {d.erros?.length > 0 && (
                    <p className="text-xs text-red-600 mt-1">{d.erros.length} erros no disparo</p>
                  )}
                </>
              ) : (
                <p>Erro: {d.error || d.msg}</p>
              )}
            </div>
          );
        })()}

        {dispatch.error && (
          <div className="rounded-lg p-4 text-sm bg-red-50 text-red-800 border border-red-200">
            <p className="font-medium">Erro no disparo</p>
            <p>{dispatch.error.message}</p>
          </div>
        )}
      </div>

      {/* Modal de import */}
      {importModal && (
        <ImportJsonModal onClose={() => { setImportModal(false); utils.reengajamento.statusImportados.invalidate(); }} />
      )}
    </div>
  );
}
