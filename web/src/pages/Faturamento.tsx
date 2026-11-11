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

type NfseStatus = "EMITIDA" | "PULADA" | "ERRO" | "NAO_APLICAVEL";
type CobStatus  = "GERADA"  | "PULADA" | "ERRO";
type ResultItem = {
  contratoId:  string;
  tomador:     string;
  emitente:    string;
  valor:       number;
  nfseStatus:  NfseStatus;
  cobStatus:   CobStatus;
  nfseNumero?: string;
  erroNfse?:   string;
  erroCob?:    string;
};

export default function Faturamento() {
  const utils = trpc.useUtils();
  const [competencia, setCompetencia]   = useState(competenciaAtual());
  const [selecionados, setSelecionados] = useState<Set<string>>(new Set());
  const [resultados, setResultados]     = useState<ResultItem[] | null>(null);
  const [processando, setProcessando]   = useState(false);

  // Todos os contratos ativos que têm cobrança ou NFS-e configurada
  const { data: contratos, isLoading } = trpc.contrato.listar.useQuery(
    { apenasAtivos: true },
    {
      select: (list) => list.filter((c) => {
        const metodoCobr    = (c as any).metodoCobr    as string ?? "PIX_BOLETO";
        const gerarCob      = (c as any).gerarCobrancaAuto !== false;
        const nfseAoFaturar = (c as any).nfseAoFaturar !== false;
        return gerarCob && metodoCobr !== "NENHUM" && metodoCobr !== "ALVARA" || nfseAoFaturar;
      }),
    }
  );

  const { data: cobrancasMes, refetch: refetchCobrancas } = trpc.cobranca.listar.useQuery(
    { competencia, pageSize: 500 },
    { enabled: !!competencia }
  );

  const { data: emitentes, refetch: refetchEmitentes } = trpc.empresa.listar.useQuery();
  const atualizarEmpresa = trpc.empresa.atualizar.useMutation({
    onSuccess: () => refetchEmitentes(),
  });

  const faturarLote = trpc.nota.faturarLote.useMutation();

  const { data: notasMes, refetch: refetchNotas } = trpc.nota.listar.useQuery(
    { competencia, pageSize: 500 },
    { enabled: !!competencia }
  );

  const cobPorContrato = new Set<string>(
    (cobrancasMes?.cobrancas ?? [])
      .filter(c => c.contrato?.id)
      .map(c => c.contrato!.id)
  );

  // Nota que falhou (ERRO) não conta: o contrato volta para pendente só da NFS-e.
  // faturarLote pula a cobrança quando ela já existe, então o boleto não duplica.
  const notaOkPorContrato = new Set<string>(
    (notasMes?.notas ?? [])
      .filter(n => n.status === "EMITIDA" || n.status === "PENDENTE")
      .map(n => n.contratoId)
  );
  const faltaNota = (c: any) => c.nfseAoFaturar !== false && !notaOkPorContrato.has(c.id);

  // Contrato faturado = tem cobrança neste mês e, se emite NFS-e, nota emitida
  const pendentes   = (contratos ?? []).filter((c) => !cobPorContrato.has(c.id) || faltaNota(c));
  const jaFaturados = (contratos ?? []).filter((c) =>  cobPorContrato.has(c.id) && !faltaNota(c));

  function toggleTodos() {
    if (selecionados.size === pendentes.length) setSelecionados(new Set());
    else setSelecionados(new Set(pendentes.map((c) => c.id)));
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
      const res = await faturarLote.mutateAsync({ competencia, contratoIds: [...selecionados] });
      setResultados(res as ResultItem[]);
      setSelecionados(new Set());
      utils.nota.listar.invalidate();
      utils.cobranca.listar.invalidate();
      refetchCobrancas();
      refetchNotas();
    } finally {
      setProcessando(false);
    }
  }

  const valorSelecionado = [...selecionados]
    .map((id) => contratos?.find((c) => c.id === id)?.valor ?? 0)
    .reduce((a, b) => a + b, 0);

  function ModoBadge({ c }: { c: any }) {
    const nfse = c.nfseAoFaturar !== false;
    if (nfse)
      return <span className="text-xs bg-indigo-50 text-indigo-600 border border-indigo-200 px-2 py-0.5 rounded-full font-medium">NFS-e + Cobrança</span>;
    return <span className="text-xs bg-teal-50 text-teal-600 border border-teal-200 px-2 py-0.5 rounded-full font-medium">Só Cobrança</span>;
  }

  return (
    <div className="p-4 md:p-8 max-w-5xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Faturar</h1>
          <p className="text-sm text-gray-500 mt-1">
            Emite NFS-e e gera cobrança (PIX/Boleto) em lote — ou apenas cobrança, conforme o modo do contrato
          </p>
        </div>
      </div>

      {/* Faturamento automático por empresa */}
      {emitentes && emitentes.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-xl p-5 mb-6">
          <h2 className="text-sm font-semibold text-gray-800 mb-1">Faturamento Automático (cron diário)</h2>
          <p className="text-xs text-gray-500 mb-4">
            Quando ativo, emite NFS-e automaticamente no dia configurado para contratos com "Faturamento automático" marcado.
          </p>
          <div className="space-y-3">
            {emitentes.filter(e => e.ativo).map((emp) => {
              const autoAtivo  = (emp as any).faturamentoAutoAtivo ?? false;
              const diaEmissao = (emp as any).diaEmissaoNfse ?? "";
              return (
                <div key={emp.id} className="flex items-center gap-4 p-3 rounded-lg border border-gray-100 bg-gray-50">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">{emp.nomeFantasia || emp.nome}</p>
                    <p className="text-xs text-gray-400">{emp.cnpj}</p>
                  </div>
                  <div className="flex items-center gap-3 flex-shrink-0">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input type="checkbox" checked={autoAtivo}
                        onChange={(e) => atualizarEmpresa.mutate({ id: emp.id, faturamentoAutoAtivo: e.target.checked })}
                        className="w-4 h-4 rounded accent-brand-600" />
                      <span className={`text-xs font-medium ${autoAtivo ? "text-green-700" : "text-gray-400"}`}>
                        {autoAtivo ? "Ativo" : "Inativo"}
                      </span>
                    </label>
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs text-gray-500">Emitir no dia</span>
                      <input type="number" min={1} max={28} value={diaEmissao} placeholder="—"
                        disabled={!autoAtivo}
                        onChange={(e) => {
                          const v = parseInt(e.target.value, 10);
                          atualizarEmpresa.mutate({ id: emp.id, diaEmissaoNfse: isNaN(v) ? null : Math.min(28, Math.max(1, v)) });
                        }}
                        className="w-16 border rounded-lg px-2 py-1 text-sm text-center disabled:opacity-40 disabled:bg-gray-100" />
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
      <div className="bg-white border border-gray-200 rounded-xl p-4 md:p-5 mb-6 flex flex-wrap items-center gap-4 md:gap-6">
        <div>
          <label className="block text-xs font-semibold text-gray-600 uppercase tracking-wide mb-1">Competência</label>
          <select value={competencia}
            onChange={(e) => { setCompetencia(e.target.value); setSelecionados(new Set()); setResultados(null); }}
            className="border rounded-lg px-3 py-2 text-sm bg-white font-medium w-full sm:w-auto sm:min-w-[140px]">
            {mesesDisponiveis().map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>
        <div className="text-sm text-gray-600">
          <span className="font-semibold text-green-700">{jaFaturados.length}</span> já faturados ·{" "}
          <span className="font-semibold text-orange-600">{pendentes.length}</span> pendentes
        </div>
      </div>

      {/* Resultado do lote */}
      {resultados && (
        <div className="bg-white border border-gray-200 rounded-xl p-5 mb-6">
          <h2 className="font-semibold text-gray-800 mb-3">Resultado do Faturamento</h2>
          <div className="space-y-2">
            {resultados.map((r) => {
              const ok = r.cobStatus === "GERADA" || r.nfseStatus === "EMITIDA";
              const errAny = r.nfseStatus === "ERRO" || r.cobStatus === "ERRO";
              return (
                <div key={r.contratoId} className={`flex items-start justify-between p-3 rounded-lg text-sm gap-4 ${
                  errAny ? "bg-red-50 border border-red-200" : ok ? "bg-green-50 border border-green-200" : "bg-gray-50 border border-gray-200"
                }`}>
                  <div className="flex items-start gap-3 flex-1 min-w-0">
                    <span className="text-lg mt-0.5">{errAny ? "❌" : ok ? "✅" : "⏭️"}</span>
                    <div className="min-w-0">
                      <p className="font-medium text-gray-900 truncate">{r.tomador}</p>
                      <p className="text-xs text-gray-500">{r.emitente}</p>
                    </div>
                  </div>
                  <div className="text-right flex-shrink-0 space-y-1">
                    <p className="font-medium">{fmt(r.valor)}</p>
                    {r.nfseStatus !== "NAO_APLICAVEL" && (
                      <p className={`text-xs ${r.nfseStatus === "ERRO" ? "text-red-600" : "text-gray-500"}`}>
                        {r.nfseStatus === "EMITIDA" ? `NFS-e #${r.nfseNumero}` :
                         r.nfseStatus === "PULADA"  ? "NFS-e já emitida" :
                         r.nfseStatus === "ERRO"    ? (r.erroNfse?.slice(0, 50) ?? "Erro NFS-e") : ""}
                      </p>
                    )}
                    <p className={`text-xs ${r.cobStatus === "ERRO" ? "text-red-600" : "text-gray-500"}`}>
                      {r.cobStatus === "GERADA" ? "Cobrança gerada" :
                       r.cobStatus === "PULADA" ? "Cobrança já existe" :
                       r.erroCob?.slice(0, 50) ?? "Erro cobrança"}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="mt-3 flex gap-4 text-sm flex-wrap">
            <span className="text-green-700 font-medium">{resultados.filter(r => r.nfseStatus === "EMITIDA").length} NFS-e emitidas</span>
            <span className="text-teal-700 font-medium">{resultados.filter(r => r.cobStatus === "GERADA").length} cobranças geradas</span>
            <span className="text-gray-500">{resultados.filter(r => r.nfseStatus === "PULADA").length} NFS-e puladas</span>
            <span className="text-red-600 font-medium">
              {resultados.filter(r => r.nfseStatus === "ERRO" || r.cobStatus === "ERRO").length} erros
            </span>
          </div>
        </div>
      )}

      {/* Contratos pendentes */}
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden mb-4">
        <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between bg-gray-50">
          <div className="flex items-center gap-3">
            <input type="checkbox"
              checked={selecionados.size === pendentes.length && pendentes.length > 0}
              onChange={toggleTodos}
              className="w-4 h-4 rounded" />
            <span className="text-sm font-semibold text-gray-700">
              Pendentes em {competencia}
              {selecionados.size > 0 && (
                <span className="ml-2 text-brand-600">({selecionados.size} selecionados · {fmt(valorSelecionado)})</span>
              )}
            </span>
          </div>
          <button onClick={faturar} disabled={!selecionados.size || processando}
            className="bg-brand-600 hover:bg-brand-700 disabled:opacity-40 text-white text-sm font-medium px-5 py-2 rounded-lg transition-colors">
            {processando ? "Faturando..." : selecionados.size > 0 ? `Faturar ${selecionados.size}` : "Faturar"}
          </button>
        </div>

        {isLoading ? (
          <div className="p-6 text-sm text-gray-400">Carregando contratos...</div>
        ) : pendentes.length === 0 ? (
          <div className="p-6 text-sm text-gray-500 text-center">
            {contratos?.length === 0
              ? "Nenhum contrato com cobrança ativo."
              : `Todos os contratos já foram faturados em ${competencia}. ✅`}
          </div>
        ) : (
          <div className="divide-y divide-gray-100">
            {pendentes.map((c) => (
              <label key={c.id} className="flex items-center gap-4 px-5 py-3 hover:bg-gray-50 cursor-pointer">
                <input type="checkbox" checked={selecionados.has(c.id)} onChange={() => toggle(c.id)}
                  className="w-4 h-4 rounded flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-gray-900 truncate">{c.tomador.nome}</span>
                    <span className="text-gray-400 text-xs">←</span>
                    <span className="text-xs text-gray-500 truncate">{c.emitente.nome}</span>
                    <ModoBadge c={c} />
                    {cobPorContrato.has(c.id) && (
                      <span className="text-xs bg-amber-50 text-amber-700 border border-amber-200 px-2 py-0.5 rounded-full font-medium">Só NFS-e · cobrança já gerada</span>
                    )}
                  </div>
                  <p className="text-xs text-gray-400 truncate mt-0.5">{c.descricaoServico?.slice(0, 80)}</p>
                </div>
                <div className="text-right flex-shrink-0">
                  <p className="text-sm font-semibold text-gray-800">{fmt(c.valor)}</p>
                  <p className="text-xs text-gray-400">Vence dia {c.diaVencimento}</p>
                </div>
              </label>
            ))}
          </div>
        )}
      </div>

      {/* Já faturados */}
      {jaFaturados.length > 0 && (
        <details className="bg-white border border-gray-200 rounded-xl overflow-hidden">
          <summary className="px-5 py-3 cursor-pointer text-sm font-semibold text-gray-500 hover:bg-gray-50 select-none">
            ✅ Já faturados em {competencia} ({jaFaturados.length})
          </summary>
          <div className="divide-y divide-gray-100">
            {jaFaturados.map((c) => (
              <div key={c.id} className="flex items-center gap-4 px-5 py-3 opacity-60">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-gray-900 truncate">{c.tomador.nome}</span>
                    <span className="text-gray-400 text-xs">←</span>
                    <span className="text-xs text-gray-500 truncate">{c.emitente.nome}</span>
                    <ModoBadge c={c} />
                  </div>
                </div>
                <div className="text-right flex-shrink-0">
                  <p className="text-sm font-semibold text-gray-800">{fmt(c.valor)}</p>
                  <p className="text-xs text-gray-400">Vence dia {c.diaVencimento}</p>
                </div>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
