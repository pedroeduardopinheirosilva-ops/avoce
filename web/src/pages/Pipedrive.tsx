import { useState, useEffect, useRef } from "react";
import { trpc } from "../lib/trpc";

const SUPABASE_URL  = "https://jruettethcumobyessqu.supabase.co";
const SUPABASE_TOKEN = "REMOVED_ROTATE_TOKEN";

export default function Pipedrive() {
  const [tokenInput, setTokenInput] = useState("");
  const [importing, setImporting] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [overwrite, setOverwrite] = useState(false);
  const [importarPerdidos, setImportarPerdidos] = useState(false);

  // Bot RAP
  const [botOverwrite, setBotOverwrite] = useState(false);
  const [botApenasQualificados, setBotApenasQualificados] = useState(false);
  const [botLog, setBotLog] = useState<string[]>([]);

  // Análise IA
  const [analisando, setAnalisando] = useState(false);
  const analisarRef = useRef(false);

  const utils = trpc.useUtils();
  const { data: config, isLoading: loadingConfig } = trpc.pipedrive.getConfig.useQuery();
  const { data: conexao, refetch: retestConn } = trpc.pipedrive.testarConexao.useQuery(undefined, { enabled: false });
  const { data: preview, refetch: fetchPreview, isFetching: loadingPreview } = trpc.pipedrive.preview.useQuery(undefined, { enabled: false });

  // Projetos IA para seleção
  const { data: projetos } = trpc.ia.listProjetos.useQuery();
  const [projetoIdAnalise, setProjetoIdAnalise] = useState("");
  useEffect(() => {
    if (projetos?.[0] && !projetoIdAnalise) setProjetoIdAnalise(projetos[0].id);
  }, [projetos]);

  // Pipelines para selector
  const { data: pipelines } = trpc.crm.listPipelines.useQuery();
  const [pipelineIdAnalise, setPipelineIdAnalise] = useState<string>(""); // "" = todos

  // Progresso da análise (generalizado)
  const { data: progresso, refetch: refetchProgresso } = trpc.reengajamento.progressoAnaliseGeral.useQuery(
    { pipelineId: pipelineIdAnalise || undefined },
    { refetchInterval: analisando ? 3000 : false }
  );

  const saveToken = trpc.pipedrive.saveToken.useMutation({
    onSuccess: () => {
      utils.pipedrive.getConfig.invalidate();
      setTokenInput("");
    },
  });

  const importarMutation = trpc.pipedrive.importar.useMutation({
    onSuccess: (data) => {
      setLog(data.log);
      utils.pipedrive.getConfig.invalidate();
      setImporting(false);
    },
    onError: (e) => {
      setLog([`Erro: ${e.message}`]);
      setImporting(false);
    },
  });

  async function handleImport() {
    setImporting(true);
    setLog([]);
    importarMutation.mutate({ overwrite, importarPerdidos });
  }

  const botMutation = trpc.reengajamento.importarBot.useMutation({
    onSuccess: (data) => setBotLog(data.log),
    onError: (e) => setBotLog([`Erro: ${e.message}`]),
  });

  const analisarMutation = trpc.reengajamento.analisarLeadsGeral.useMutation();

  async function handleAnalisar() {
    if (!projetoIdAnalise) return;
    analisarRef.current = true;
    setAnalisando(true);
    refetchProgresso();

    while (analisarRef.current) {
      const result = await analisarMutation.mutateAsync({
        projetoId: projetoIdAnalise,
        pipelineId: pipelineIdAnalise || undefined,
        batchSize: 20,
      });
      refetchProgresso();
      if (!("pendentes" in result) || result.pendentes === 0) {
        analisarRef.current = false;
        break;
      }
      // pausa entre lotes para não sobrecarregar
      await new Promise(r => setTimeout(r, 500));
    }

    setAnalisando(false);
  }

  function handlePararAnalise() {
    analisarRef.current = false;
    setAnalisando(false);
  }

  return (
    <div className="p-6 max-w-2xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Pipedrive — Importação</h1>
        <p className="text-sm text-gray-500 mt-1">Configure seu token e importe pipelines, contatos e deals do Pipedrive.</p>
      </div>

      {/* Token */}
      <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-4">
        <h2 className="font-semibold text-gray-800">Credencial</h2>
        {loadingConfig ? (
          <p className="text-sm text-gray-400">Carregando...</p>
        ) : config?.hasToken ? (
          <div className="flex items-center gap-3">
            <span className="inline-flex items-center gap-1 text-sm text-green-700 bg-green-50 border border-green-200 rounded-full px-3 py-1">
              ✓ Token configurado ({config.token})
            </span>
            <button
              onClick={() => retestConn()}
              className="text-xs text-indigo-600 hover:underline"
            >
              Testar conexão
            </button>
          </div>
        ) : (
          <p className="text-sm text-amber-600">Nenhum token salvo.</p>
        )}

        {conexao && (
          <p className={`text-sm ${conexao.ok ? "text-green-700" : "text-red-600"}`}>
            {conexao.ok ? `✓ Conectado — empresa: ${conexao.companyDomain}` : `✗ ${conexao.error}`}
          </p>
        )}

        <div className="flex gap-2">
          <input
            type="password"
            value={tokenInput}
            onChange={(e) => setTokenInput(e.target.value)}
            placeholder="Cole aqui o API Token do Pipedrive"
            className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none"
          />
          <button
            onClick={() => saveToken.mutate({ token: tokenInput })}
            disabled={!tokenInput || saveToken.isPending}
            className="px-4 py-2 bg-indigo-600 text-white text-sm rounded-lg hover:bg-indigo-700 disabled:opacity-50"
          >
            Salvar
          </button>
        </div>
      </div>

      {/* Preview */}
      {config?.hasToken && (
        <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold text-gray-800">Preview da importação</h2>
            <button
              onClick={() => fetchPreview()}
              disabled={loadingPreview}
              className="text-sm text-indigo-600 hover:underline disabled:opacity-50"
            >
              {loadingPreview ? "Carregando..." : "Buscar dados do Pipedrive"}
            </button>
          </div>

          {preview && (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {[
                { label: "Pipelines", value: preview.pipelines },
                { label: "Stages", value: preview.stages },
                { label: "Contatos", value: preview.contatos },
                { label: "Deals (total)", value: preview.deals },
                { label: "Abertos", value: preview.dealsOpen },
                { label: "Ganhos", value: preview.dealsWon },
              ].map((item) => (
                <div key={item.label} className="bg-gray-50 rounded-lg p-3 text-center">
                  <p className="text-2xl font-bold text-gray-900">{item.value}</p>
                  <p className="text-xs text-gray-500 mt-0.5">{item.label}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Import options */}
      {config?.hasToken && (
        <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-4">
          <h2 className="font-semibold text-gray-800">Opções</h2>

          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={overwrite}
              onChange={(e) => setOverwrite(e.target.checked)}
              className="rounded"
            />
            <span className="text-sm text-gray-700">Sobrescrever dados já importados (nome, stage, valor)</span>
          </label>

          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={importarPerdidos}
              onChange={(e) => setImportarPerdidos(e.target.checked)}
              className="rounded"
            />
            <span className="text-sm text-gray-700">Importar deals perdidos</span>
          </label>

          <button
            onClick={handleImport}
            disabled={importing || importarMutation.isPending}
            className="w-full py-2.5 bg-indigo-600 text-white font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition-colors"
          >
            {importing ? "Importando..." : "Executar importação"}
          </button>

          {log.length > 0 && (
            <div className="bg-gray-900 rounded-lg p-4 space-y-1">
              {log.map((line, i) => (
                <p key={i} className="text-sm font-mono text-green-400">{line}</p>
              ))}
            </div>
          )}
        </div>
      )}
      {/* Bot RAP — Importação Supabase */}
      <div className="bg-white rounded-xl border border-orange-200 p-5 space-y-4">
        <div>
          <h2 className="font-semibold text-gray-800">Bot RAP — Importar histórico WhatsApp</h2>
          <p className="text-xs text-gray-500 mt-1">
            Importa 4.570 contatos do bot RAP Advogados (Supabase) para o funil <strong>Bot RAP — Reengajamento</strong>,
            cruzando com contatos já importados do Pipedrive.
          </p>
          <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-gray-600">
            <span>✅ 517 carreteiros qualificados (dados de emprego)</span>
            <span>📅 116 com agendamento original</span>
            <span>💬 4.570 com histórico de conversa</span>
            <span>📋 Etapas mapeadas automaticamente</span>
          </div>
        </div>

        <div className="space-y-2">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={botApenasQualificados}
              onChange={(e) => setBotApenasQualificados(e.target.checked)}
              className="rounded"
            />
            <span className="text-sm text-gray-700">
              Importar apenas os 517 qualificados (com dados de emprego confirmados)
            </span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={botOverwrite}
              onChange={(e) => setBotOverwrite(e.target.checked)}
              className="rounded"
            />
            <span className="text-sm text-gray-700">Sobrescrever dados já importados</span>
          </label>
        </div>

        <button
          onClick={() => {
            setBotLog([]);
            botMutation.mutate({
              supabaseUrl: SUPABASE_URL,
              supabaseToken: SUPABASE_TOKEN,
              overwrite: botOverwrite,
              apenasQualificados: botApenasQualificados,
            });
          }}
          disabled={botMutation.isPending}
          className="w-full py-2.5 bg-orange-600 text-white font-medium rounded-lg hover:bg-orange-700 disabled:opacity-50 transition-colors"
        >
          {botMutation.isPending ? "Importando... (pode demorar alguns minutos)" : "Importar histórico Bot RAP"}
        </button>

        {botLog.length > 0 && (
          <div className="bg-gray-900 rounded-lg p-4 space-y-1">
            {botLog.map((line, i) => (
              <p key={i} className="text-sm font-mono text-green-400">{line}</p>
            ))}
          </div>
        )}
      </div>

      {/* Análise IA em Batch */}
      <div className="bg-white rounded-xl border border-purple-200 p-5 space-y-4">
        <div>
          <h2 className="font-semibold text-gray-800">Análise IA — Classificação e Abordagem</h2>
          <p className="text-xs text-gray-500 mt-1">
            Usa Claude Haiku para analisar o histórico de cada lead e classificar automaticamente:
            tom, qualificação, objeções, ângulo de reativação e primeira mensagem personalizada.
            Leads já ajuizados, com contrato ou reunião realizada são identificados como "sem abordagem" sem consumir créditos.
          </p>
          <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-gray-600">
            <span>🎯 Todos os funis ou funil específico</span>
            <span>✉️ Gera mensagem personalizada por lead</span>
            <span>🔄 Retoma de onde parou (idempotente)</span>
            <span>⚡ Leads encerrados marcados sem API call</span>
          </div>
        </div>

        {/* Seletores */}
        <div className="flex flex-wrap items-center gap-3">
          {/* Funil */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500 font-medium whitespace-nowrap">Funil:</span>
            <select
              value={pipelineIdAnalise}
              onChange={e => { setPipelineIdAnalise(e.target.value); refetchProgresso(); }}
              className="border border-gray-300 rounded-md px-2 py-1 text-sm text-gray-700 focus:outline-none"
              disabled={analisando}
            >
              <option value="">Todos os funis</option>
              {pipelines?.map((p: any) => (
                <option key={p.id} value={p.id}>{p.nome} ({p._count?.deals ?? 0})</option>
              ))}
            </select>
          </div>

          {/* Projeto IA */}
          {projetos && projetos.length > 0 && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-500 font-medium whitespace-nowrap">Projeto IA:</span>
              <select
                value={projetoIdAnalise}
                onChange={e => setProjetoIdAnalise(e.target.value)}
                className="border border-gray-300 rounded-md px-2 py-1 text-sm text-gray-700 focus:outline-none"
                disabled={analisando}
              >
                {projetos.map((p: any) => (
                  <option key={p.id} value={p.id}>{p.nome}</option>
                ))}
              </select>
            </div>
          )}
        </div>

        {/* Progresso */}
        {progresso && progresso.total > 0 && (
          <div className="space-y-2">
            <div className="flex justify-between text-xs text-gray-600">
              <span>{progresso.analisados} de {progresso.total} leads analisados</span>
              <span>{Math.round((progresso.analisados / progresso.total) * 100)}%</span>
            </div>
            <div className="w-full bg-gray-100 rounded-full h-2.5">
              <div
                className="bg-purple-600 h-2.5 rounded-full transition-all duration-500"
                style={{ width: `${Math.round((progresso.analisados / progresso.total) * 100)}%` }}
              />
            </div>
            <div className="flex gap-4 text-xs flex-wrap">
              <span className="text-green-600">✓ {progresso.analisados} analisados</span>
              <span className="text-gray-500">⏳ {progresso.pendentes} pendentes</span>
            </div>
            {progresso.pendentes === 0 && (
              <p className="text-sm text-green-700 font-medium">✅ Análise completa! Todos os leads foram classificados.</p>
            )}
          </div>
        )}

        <div className="flex gap-3">
          <button
            onClick={handleAnalisar}
            disabled={analisando || !projetoIdAnalise || progresso?.pendentes === 0}
            className="flex-1 py-2.5 bg-purple-600 text-white font-medium rounded-lg hover:bg-purple-700 disabled:opacity-50 transition-colors"
          >
            {analisando
              ? `Analisando... (${progresso?.analisados ?? 0}/${progresso?.total ?? "?"})`
              : progresso?.pendentes === 0 && progresso.total > 0
              ? "✅ Análise completa"
              : "Iniciar Análise IA"}
          </button>
          {analisando && (
            <button
              onClick={handlePararAnalise}
              className="px-4 py-2.5 border border-red-300 text-red-600 font-medium rounded-lg hover:bg-red-50 transition-colors"
            >
              Pausar
            </button>
          )}
        </div>

        <p className="text-xs text-gray-400">
          O processo pode ser pausado e retomado — cada lote de 20 leads leva ~3s. Custo estimado: $0.001 por lead.
        </p>
      </div>
    </div>
  );
}
