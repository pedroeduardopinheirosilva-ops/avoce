import { useState } from "react";
import { trpc } from "../lib/trpc";

function competenciaAtual() {
  const d = new Date();
  return `${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
}

function mesesDisponiveis() {
  const meses = [];
  const d = new Date();
  for (let i = 0; i < 24; i++) {
    meses.push(`${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`);
    d.setMonth(d.getMonth() - 1);
  }
  return meses;
}

function fmt(centavos: number) {
  return (centavos / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

type ResultItem = {
  contratoId: string;
  tomador:    string;
  emitente:   string;
  valor:      number;
  status:     "EMITIDA" | "PULADO" | "ERRO";
  numero?:    string;
  erroMsg?:   string;
};

export default function Faturamento() {
  const utils = trpc.useUtils();
  const [competencia, setCompetencia]   = useState(competenciaAtual());
  const [selecionados, setSelecionados] = useState<Set<string>>(new Set());
  const [resultados, setResultados]     = useState<ResultItem[] | null>(null);
  const [processando, setProcessando]   = useState(false);

  const { data: contratos, isLoading } = trpc.contrato.listar.useQuery(
    { apenasAtivos: true },
    { select: (list) => list.filter((c) => (c as any).emitirNfseAuto) }
  );
  const { data: notasMes, refetch: refetchNotas } = trpc.nota.listar.useQuery(
    { competencia, pageSize: 500 },
    { enabled: !!competencia }
  );
  const { data: emitentes, refetch: refetchEmitentes } = trpc.empresa.listar.useQuery();
  const atualizarEmpresa = trpc.empresa.atualizar.useMutation({
    onSuccess: () => refetchEmitentes(),
  });

  const faturarLote = trpc.nota.faturarLote.useMutation();

  // Apenas EMITIDA/PENDENTE contam como "já faturado" — ERRO e CANCELADA permitem reemissão
  const notasPorContrato = new Map<string, { status: string; numero?: string | null; erroMsg?: string | null }>();
  const errosPorContrato = new Map<string, { erroMsg?: string | null }>();
  for (const n of notasMes?.notas ?? []) {
    if (!n.contratoId) continue;
    if (n.status === "EMITIDA" || n.status === "PENDENTE") {
      notasPorContrato.set(n.contratoId, { status: n.status, numero: n.numero });
    } else if (n.status === "ERRO") {
      errosPorContrato.set(n.contratoId, { erroMsg: (n as any).erroMsg });
    }
  }

  const pendentes  = (contratos ?? []).filter((c) => !notasPorContrato.has(c.id));
  const jaEmitidos = (contratos ?? []).filter((c) =>  notasPorContrato.has(c.id));

  function toggleTodos() {
    if (selecionados.size === pendentes.length) {
      setSelecionados(new Set());
    } else {
      setSelecionados(new Set(pendentes.map((c) => c.id)));
    }
  }

  function toggle(id: string) {
    setSelecionados((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  async function faturar() {
    if (!selecionados.size) return;
    setProcessando(true);
    setResultados(null);
    try {
      const res = await faturarLote.mutateAsync({
        competencia,
        contratoIds: [...selecionados],
      });
      setResultados(res);
      setSelecionados(new Set());
      utils.nota.listar.invalidate();
      refetchNotas();
    } finally {
      setProcessando(false);
    }
  }

  const valorSelecionado = [...selecionados]
    .map((id) => contratos?.find((c) => c.id === id)?.valor ?? 0)
    .reduce((a, b) => a + b, 0);

  return (
    <div className="p-8 max-w-5xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Faturamento</h1>
          <p className="text-sm text-gray-500 mt-1">Emita NFS-e de vários contratos de uma só vez para qualquer competência</p>
        </div>
      </div>

      {/* Configuração de faturamento automático por empresa */}
      {emitentes && emitentes.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-xl p-5 mb-6">
          <h2 className="text-sm font-semibold text-gray-800 mb-4">Faturamento Automático</h2>
          <p className="text-xs text-gray-500 mb-4">
            Quando ativo, o sistema emite NFS-e automaticamente no dia configurado para todos os contratos
            com "Faturamento automático" marcado.
          </p>
          <div className="space-y-3">
            {emitentes.filter(e => e.ativo).map((emp) => {
              const autoAtivo   = (emp as any).faturamentoAutoAtivo ?? false;
              const diaEmissao  = (emp as any).diaEmissaoNfse ?? "";
              return (
                <div key={emp.id} className="flex items-center gap-4 p-3 rounded-lg border border-gray-100 bg-gray-50">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">{emp.nomeFantasia || emp.nome}</p>
                    <p className="text-xs text-gray-400">{emp.cnpj}</p>
                  </div>
                  <div className="flex items-center gap-3 flex-shrink-0">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={autoAtivo}
                        onChange={(e) =>
                          atualizarEmpresa.mutate({ id: emp.id, faturamentoAutoAtivo: e.target.checked })
                        }
                        className="w-4 h-4 rounded accent-brand-600"
                      />
                      <span className={`text-xs font-medium ${autoAtivo ? "text-green-700" : "text-gray-400"}`}>
                        {autoAtivo ? "Ativo" : "Inativo"}
                      </span>
                    </label>
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs text-gray-500">Emitir no dia</span>
                      <input
                        type="number"
                        min={1}
                        max={28}
                        value={diaEmissao}
                        placeholder="—"
                        disabled={!autoAtivo}
                        onChange={(e) => {
                          const v = parseInt(e.target.value, 10);
                          atualizarEmpresa.mutate({
                            id: emp.id,
                            diaEmissaoNfse: isNaN(v) ? null : Math.min(28, Math.max(1, v)),
                          });
                        }}
                        className="w-16 border rounded-lg px-2 py-1 text-sm text-center disabled:opacity-40 disabled:bg-gray-100"
                      />
                      <span className="text-xs text-gray-500">de cada mês</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Seletor de competência */}
      <div className="bg-white border border-gray-200 rounded-xl p-5 mb-6 flex items-center gap-6">
        <div>
          <label className="block text-xs font-semibold text-gray-600 uppercase tracking-wide mb-1">Competência</label>
          <select
            value={competencia}
            onChange={(e) => { setCompetencia(e.target.value); setSelecionados(new Set()); setResultados(null); }}
            className="border rounded-lg px-3 py-2 text-sm bg-white font-medium min-w-[140px]"
          >
            {mesesDisponiveis().map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </div>
        <div className="text-sm text-gray-600">
          <span className="font-semibold text-green-700">{jaEmitidos.length}</span> já faturados ·{" "}
          <span className="font-semibold text-orange-600">{pendentes.length}</span> pendentes
        </div>
      </div>

      {/* Resultados do lote */}
      {resultados && (
        <div className="bg-white border border-gray-200 rounded-xl p-5 mb-6">
          <h2 className="font-semibold text-gray-800 mb-3">Resultado do Faturamento</h2>
          <div className="space-y-2">
            {resultados.map((r) => (
              <div key={r.contratoId} className={`flex items-center justify-between p-3 rounded-lg text-sm ${
                r.status === "EMITIDA" ? "bg-green-50 border border-green-200" :
                r.status === "PULADO"  ? "bg-gray-50  border border-gray-200"  :
                                         "bg-red-50   border border-red-200"
              }`}>
                <div className="flex items-center gap-3">
                  <span className="text-lg">
                    {r.status === "EMITIDA" ? "✅" : r.status === "PULADO" ? "⏭️" : "❌"}
                  </span>
                  <div>
                    <p className="font-medium text-gray-900">{r.tomador}</p>
                    <p className="text-xs text-gray-500">{r.emitente}</p>
                  </div>
                </div>
                <div className="text-right">
                  <p className="font-medium">{fmt(r.valor)}</p>
                  <p className="text-xs text-gray-500">
                    {r.status === "EMITIDA" ? `NFS-e #${r.numero}` :
                     r.status === "PULADO"  ? "Já faturado"         :
                     r.erroMsg?.slice(0, 60) ?? "Erro"}
                  </p>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-3 flex gap-4 text-sm">
            <span className="text-green-700 font-medium">{resultados.filter(r => r.status === "EMITIDA").length} emitidas</span>
            <span className="text-gray-500">{resultados.filter(r => r.status === "PULADO").length} puladas</span>
            <span className="text-red-600 font-medium">{resultados.filter(r => r.status === "ERRO").length} erros</span>
          </div>
        </div>
      )}

      {/* Contratos pendentes */}
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden mb-4">
        <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between bg-gray-50">
          <div className="flex items-center gap-3">
            <input
              type="checkbox"
              checked={selecionados.size === pendentes.length && pendentes.length > 0}
              onChange={toggleTodos}
              className="w-4 h-4 rounded"
            />
            <span className="text-sm font-semibold text-gray-700">
              Pendentes em {competencia}
              {selecionados.size > 0 && (
                <span className="ml-2 text-brand-600">({selecionados.size} selecionados · {fmt(valorSelecionado)})</span>
              )}
            </span>
          </div>
          <button
            onClick={faturar}
            disabled={!selecionados.size || processando}
            className="bg-brand-600 hover:bg-brand-700 disabled:opacity-40 text-white text-sm font-medium px-5 py-2 rounded-lg transition-colors"
          >
            {processando ? "Emitindo..." : `Emitir ${selecionados.size > 0 ? selecionados.size : ""} NFS-e`}
          </button>
        </div>

        {isLoading ? (
          <div className="p-6 text-sm text-gray-400">Carregando contratos...</div>
        ) : pendentes.length === 0 ? (
          <div className="p-6 text-sm text-gray-500 text-center">
            {contratos?.length === 0
              ? "Nenhum contrato com emissão automática ativo."
              : `Todos os contratos já foram faturados em ${competencia}. ✅`}
          </div>
        ) : (
          <div className="divide-y divide-gray-100">
            {pendentes.map((c) => {
              const erroAnterior = errosPorContrato.get(c.id);
              return (
              <label key={c.id} className={`flex items-center gap-4 px-5 py-3 hover:bg-gray-50 cursor-pointer ${erroAnterior ? "bg-red-50/50" : ""}`}>
                <input
                  type="checkbox"
                  checked={selecionados.has(c.id)}
                  onChange={() => toggle(c.id)}
                  className="w-4 h-4 rounded flex-shrink-0"
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-gray-900 truncate">{c.tomador.nome}</span>
                    <span className="text-gray-400 text-xs">←</span>
                    <span className="text-xs text-gray-500 truncate">{c.emitente.nome}</span>
                    {erroAnterior && (
                      <span className="text-xs bg-red-100 text-red-600 px-1.5 py-0.5 rounded font-medium">Erro anterior — retentar</span>
                    )}
                  </div>
                  {erroAnterior?.erroMsg && (
                    <p className="text-xs text-red-500 truncate mt-0.5">{erroAnterior.erroMsg.slice(0, 100)}</p>
                  )}
                  {!erroAnterior && <p className="text-xs text-gray-400 truncate mt-0.5">{c.descricaoServico?.slice(0, 80)}</p>}
                </div>
                <div className="text-right flex-shrink-0">
                  <p className="text-sm font-semibold text-gray-800">{fmt(c.valor)}</p>
                  <p className="text-xs text-gray-400">Vence dia {c.diaVencimento}</p>
                </div>
              </label>
              );
            })}
          </div>
        )}
      </div>

      {/* Contratos já emitidos neste mês */}
      {jaEmitidos.length > 0 && (
        <details className="bg-white border border-gray-200 rounded-xl overflow-hidden">
          <summary className="px-5 py-3 cursor-pointer text-sm font-semibold text-gray-500 hover:bg-gray-50 select-none">
            ✅ Já faturados em {competencia} ({jaEmitidos.length})
          </summary>
          <div className="divide-y divide-gray-100">
            {jaEmitidos.map((c) => {
              const nota = notasPorContrato.get(c.id);
              return (
                <div key={c.id} className="flex items-center gap-4 px-5 py-3 opacity-60">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-gray-900 truncate">{c.tomador.nome}</span>
                      <span className="text-gray-400 text-xs">←</span>
                      <span className="text-xs text-gray-500 truncate">{c.emitente.nome}</span>
                    </div>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <p className="text-sm font-semibold text-gray-800">{fmt(c.valor)}</p>
                    <p className="text-xs text-gray-400">
                      {nota?.status === "EMITIDA" ? `NFS-e #${nota.numero}` :
                       nota?.status === "ERRO"    ? "Erro na emissão"        : nota?.status}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </details>
      )}
    </div>
  );
}
