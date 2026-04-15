import { useState } from "react";
import { trpc } from "../lib/trpc";

function fmt(centavos: number) {
  return (centavos / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}
function fmtData(iso: string) {
  if (!iso) return "-";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

// Status badge helpers
const PIX_LABEL: Record<string, string> = { PENDENTE: "PIX Pendente", PAGO: "PIX Pago", EXPIRADO: "PIX Expirado" };
const PIX_COLOR: Record<string, string> = { PENDENTE: "bg-yellow-100 text-yellow-800", PAGO: "bg-green-100 text-green-800", EXPIRADO: "bg-gray-100 text-gray-600" };
const BOL_LABEL: Record<string, string> = { AGUARDANDO: "Boleto Aguard.", PAGO: "Boleto Pago", VENCIDO: "Boleto Vencido", CANCELADO: "Cancelado" };
const BOL_COLOR: Record<string, string> = { AGUARDANDO: "bg-blue-100 text-blue-700", PAGO: "bg-green-100 text-green-800", VENCIDO: "bg-orange-100 text-orange-700", CANCELADO: "bg-gray-100 text-gray-500" };
const EFF_COLOR: Record<string, string> = { PAGO: "bg-green-100 text-green-800", VENCIDO: "bg-orange-100 text-orange-700", CANCELADO: "bg-gray-100 text-gray-500", PENDENTE: "bg-yellow-100 text-yellow-800" };

type Tab = "cobrancas" | "relatorio";

export default function Cobrancas() {
  const utils = trpc.useUtils();
  const [tab, setTab] = useState<Tab>("cobrancas");

  // Filtros relatório
  const [rfEmitente, setRfEmitente] = useState("");
  const [rfCompetencia, setRfCompetencia] = useState("");
  const [rfDataInicio, setRfDataInicio] = useState("");
  const [rfDataFim, setRfDataFim] = useState("");
  const [relFiltros, setRelFiltros] = useState<{ emitenteId?: string; competencia?: string; dataInicio?: string; dataFim?: string }>({});

  const { data, isLoading } = trpc.cobranca.listar.useQuery({ pageSize: 100 });
  const { data: relData, isLoading: relLoading } = trpc.cobranca.relatorio.useQuery(relFiltros);

  const excluir       = trpc.cobranca.excluir.useMutation({ onSuccess: () => { utils.cobranca.listar.invalidate(); utils.cobranca.relatorio.invalidate(); } });
  const reenviarEmail = trpc.cobranca.reenviarEmail.useMutation({
    onSuccess: () => alert("E-mail reenviado com sucesso!"),
    onError:   (e) => alert("Erro ao reenviar: " + e.message),
  });
  const consultarStatus = trpc.cobranca.consultarStatus.useMutation({
    onSuccess: (res) => {
      utils.cobranca.listar.invalidate();
      utils.cobranca.relatorio.invalidate();
      alert(`${res.atualizadas} cobranças verificadas na API Sicoob.`);
    },
    onError: (e) => alert("Erro: " + e.message),
  });

  function abrirCarta(id: string, temBoleto: boolean) {
    const token = localStorage.getItem("avoce_token");
    window.open(`/api/cobranca/${id}/html?token=${token}`, "_blank");
    if (temBoleto) {
      setTimeout(() => window.open(`/api/cobranca/${id}/boleto.pdf?token=${token}`, "_blank"), 300);
    }
  }

  const TABS: { key: Tab; label: string }[] = [
    { key: "cobrancas", label: "Cobranças" },
    { key: "relatorio", label: "Relatório" },
  ];

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Cobranças</h1>
        <div className="flex gap-2">
          {TABS.map(t => (
            <button key={t.key} onClick={() => setTab(t.key)}
              className={`text-sm px-4 py-2 rounded-lg transition-colors ${tab === t.key ? "bg-brand-600 text-white" : "bg-gray-100 text-gray-700 hover:bg-gray-200"}`}>
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Tab: Cobranças ── */}
      {tab === "cobrancas" && (
        <>
          <div className="flex justify-end mb-4">
            <button
              onClick={() => consultarStatus.mutate({})}
              disabled={consultarStatus.isPending}
              className="text-sm bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg disabled:opacity-50"
            >
              {consultarStatus.isPending ? "Consultando..." : "🔄 Atualizar Status Sicoob"}
            </button>
          </div>
          {isLoading ? (
            <div className="text-gray-500 text-sm">Carregando...</div>
          ) : (
            <div className="space-y-3">
              {data?.cobrancas.map(c => (
                <div key={c.id} className="bg-white border border-gray-200 rounded-xl p-5 flex items-start justify-between">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-semibold text-gray-900">{c.emitente.nome}</p>
                      <span className="text-gray-400">→</span>
                      <p className="text-gray-700">{c.contrato.tomador.nome}</p>
                      {/* PIX badge */}
                      {c.pixTxid && (
                        <span className={`text-xs px-2 py-0.5 rounded-full ${PIX_COLOR[c.pixStatus] ?? "bg-gray-100 text-gray-600"}`}>
                          {PIX_LABEL[c.pixStatus] ?? c.pixStatus}
                        </span>
                      )}
                      {/* Boleto badge */}
                      {c.boletoNossoNumero && (
                        <span className={`text-xs px-2 py-0.5 rounded-full ${BOL_COLOR[c.boletoStatus] ?? "bg-gray-100 text-gray-600"}`}>
                          {BOL_LABEL[c.boletoStatus] ?? c.boletoStatus} #{c.boletoNossoNumero}
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-gray-500 mt-1">
                      {c.contrato.nomeServico || c.contrato.descricaoServico.slice(0, 60)}
                    </p>
                    <p className="text-sm font-medium text-gray-800 mt-1">
                      {fmt(c.valor)} · Competência {c.competencia} · Vencto {fmtData(c.vencimento)}
                    </p>
                    {c.boletoStatus === "PAGO" && c.boletoPagoEm && (
                      <p className="text-xs text-green-700 mt-1">
                        Boleto pago em {fmtData(c.boletoPagoEm)}{c.boletoValorPago ? ` — ${fmt(c.boletoValorPago)}` : ""}
                      </p>
                    )}
                    {c.pixStatus === "PAGO" && (
                      <p className="text-xs text-green-700 mt-1">
                        PIX pago{(c as any).pixPagoEm ? ` em ${new Date((c as any).pixPagoEm).toLocaleDateString("pt-BR")}` : ""}
                        {(c as any).pixPagadorNome ? ` — ${(c as any).pixPagadorNome}` : ""}
                      </p>
                    )}
                    {c.boletoLinhaDigitavel && (
                      <p className="text-xs text-gray-400 mt-1 font-mono">{c.boletoLinhaDigitavel.slice(0, 50)}...</p>
                    )}
                  </div>
                  <div className="flex gap-2 flex-shrink-0 ml-4">
                    <button
                      onClick={() => consultarStatus.mutate({ id: c.id })}
                      disabled={consultarStatus.isPending}
                      className="text-xs bg-indigo-50 hover:bg-indigo-100 text-indigo-700 px-3 py-1.5 rounded-lg disabled:opacity-50"
                    >
                      🔄
                    </button>
                    <button onClick={() => abrirCarta(c.id, !!c.boletoNossoNumero)}
                      className="text-xs bg-teal-50 hover:bg-teal-100 text-teal-700 px-3 py-1.5 rounded-lg">
                      Abrir Carta
                    </button>
                    <button
                      onClick={() => { if (confirm("Reenviar e-mail de cobrança?")) reenviarEmail.mutate({ id: c.id }); }}
                      disabled={reenviarEmail.isPending}
                      className="text-xs bg-blue-50 hover:bg-blue-100 text-blue-700 px-3 py-1.5 rounded-lg disabled:opacity-50"
                    >
                      ✉ Reenviar
                    </button>
                    <button onClick={() => { if (confirm("Excluir cobrança?")) excluir.mutate({ id: c.id }); }}
                      className="text-xs bg-red-50 hover:bg-red-100 text-red-700 px-3 py-1.5 rounded-lg">
                      Excluir
                    </button>
                  </div>
                </div>
              ))}
              {!data?.cobrancas.length && (
                <p className="text-gray-500 text-sm">Nenhuma cobrança gerada. Use o botão "Cobrança" em um contrato.</p>
              )}
            </div>
          )}
        </>
      )}

      {/* ── Tab: Relatório ── */}
      {tab === "relatorio" && (
        <div>
          {/* Filtros */}
          <div className="bg-white border border-gray-200 rounded-xl p-4 mb-5 flex flex-wrap gap-3 items-end">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Competência</label>
              <input
                type="text" placeholder="MM/AAAA"
                value={rfCompetencia}
                onChange={e => setRfCompetencia(e.target.value)}
                className="border rounded-lg px-3 py-2 text-sm w-32"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Vencimento de</label>
              <input
                type="date" value={rfDataInicio}
                onChange={e => setRfDataInicio(e.target.value)}
                className="border rounded-lg px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Vencimento até</label>
              <input
                type="date" value={rfDataFim}
                onChange={e => setRfDataFim(e.target.value)}
                className="border rounded-lg px-3 py-2 text-sm"
              />
            </div>
            <button
              onClick={() => setRelFiltros({
                ...(rfCompetencia ? { competencia: rfCompetencia } : {}),
                ...(rfDataInicio  ? { dataInicio:  rfDataInicio  } : {}),
                ...(rfDataFim     ? { dataFim:     rfDataFim     } : {}),
              })}
              className="bg-brand-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-brand-700"
            >
              Filtrar
            </button>
            <button
              onClick={() => { setRfCompetencia(""); setRfDataInicio(""); setRfDataFim(""); setRelFiltros({}); }}
              className="bg-gray-100 text-gray-700 text-sm px-4 py-2 rounded-lg hover:bg-gray-200"
            >
              Limpar
            </button>
          </div>

          {relLoading ? (
            <div className="text-gray-500 text-sm">Carregando relatório...</div>
          ) : relData ? (
            <>
              {/* Cards totalizadores */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
                <div className="bg-white border border-gray-200 rounded-xl p-4">
                  <p className="text-xs text-gray-500 mb-1">Total a Cobrar</p>
                  <p className="text-xl font-bold text-gray-900">{fmt(relData.totais.totalValor)}</p>
                  <p className="text-xs text-gray-400 mt-1">{relData.totais.quantidade} cobranças</p>
                </div>
                <div className="bg-white border border-green-200 rounded-xl p-4">
                  <p className="text-xs text-gray-500 mb-1">Total Pago</p>
                  <p className="text-xl font-bold text-green-700">{fmt(relData.totais.totalPago)}</p>
                  <p className="text-xs text-gray-400 mt-1">
                    {relData.totais.qtdPagoBoleto} boleto · {relData.totais.qtdPagoPix} pix
                  </p>
                </div>
                <div className="bg-white border border-orange-200 rounded-xl p-4">
                  <p className="text-xs text-gray-500 mb-1">A Receber</p>
                  <p className="text-xl font-bold text-orange-700">{fmt(relData.totais.totalPendente)}</p>
                  <p className="text-xs text-gray-400 mt-1">
                    {relData.totais.qtdPendente} pendente · {relData.totais.qtdVencido} vencido
                  </p>
                </div>
                <div className="bg-white border border-gray-200 rounded-xl p-4">
                  <p className="text-xs text-gray-500 mb-1">Cancelados</p>
                  <p className="text-xl font-bold text-gray-600">{relData.totais.qtdCancelado}</p>
                  <p className="text-xs text-gray-400 mt-1">cobranças canceladas</p>
                </div>
              </div>

              {/* Tabela */}
              <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 border-b border-gray-200">
                    <tr>
                      <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Emitente → Tomador</th>
                      <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Serviço</th>
                      <th className="text-center px-4 py-3 text-xs font-medium text-gray-500 uppercase">Competência</th>
                      <th className="text-center px-4 py-3 text-xs font-medium text-gray-500 uppercase">Vencimento</th>
                      <th className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase">Valor</th>
                      <th className="text-center px-4 py-3 text-xs font-medium text-gray-500 uppercase">Status</th>
                      <th className="text-center px-4 py-3 text-xs font-medium text-gray-500 uppercase">Pago em</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {relData.cobrancas.map(c => (
                      <tr key={c.id} className="hover:bg-gray-50">
                        <td className="px-4 py-3">
                          <span className="font-medium text-gray-900">{c.emitente.nomeFantasia || c.emitente.nome}</span>
                          <span className="text-gray-400 mx-1">→</span>
                          <span className="text-gray-700">{c.contrato.tomador.nome}</span>
                        </td>
                        <td className="px-4 py-3 text-gray-600">{c.contrato.nomeServico || "-"}</td>
                        <td className="px-4 py-3 text-center text-gray-700">{c.competencia}</td>
                        <td className="px-4 py-3 text-center text-gray-700">{fmtData(c.vencimento)}</td>
                        <td className="px-4 py-3 text-right font-medium text-gray-900">{fmt(c.valor)}</td>
                        <td className="px-4 py-3 text-center">
                          <span className={`text-xs px-2 py-0.5 rounded-full ${EFF_COLOR[c.statusEfetivo] ?? "bg-gray-100 text-gray-600"}`}>
                            {c.statusEfetivo}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-center text-gray-500 text-xs">
                          {c.boletoPagoEm ? fmtData(c.boletoPagoEm) : "-"}
                          {c.boletoValorPago ? <span className="block text-green-700">{fmt(c.boletoValorPago)}</span> : null}
                        </td>
                      </tr>
                    ))}
                    {!relData.cobrancas.length && (
                      <tr><td colSpan={7} className="text-center text-gray-400 py-8">Nenhuma cobrança no período.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}
        </div>
      )}

    </div>
  );
}
