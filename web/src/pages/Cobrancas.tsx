import { useMemo, useState } from "react";
import { trpc } from "../lib/trpc";

interface AlterarValorState {
  cobrancaId: string;
  valorAtual: number;
  vencimentoAtual: string;
}

interface BaixaManualState {
  cobrancaId: string;
  valorCobranca: number;
}

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

// ── Classificação por status efetivo (mesma regra do relatório) ──────────────
type StatusEfetivo = "PAGO" | "PENDENTE" | "VENCIDO" | "CANCELADO";
type StatusFiltro = "TODOS" | StatusEfetivo;

function statusEfetivo(c: any): StatusEfetivo {
  if (c.boletoStatus === "PAGO" || c.pixStatus === "PAGO" || c.baixaManualStatus === "PAGO") return "PAGO";
  if (c.boletoStatus === "CANCELADO") return "CANCELADO";
  const hoje = new Date().toISOString().slice(0, 10);
  if (c.vencimento && c.vencimento < hoje) return "VENCIDO";
  return "PENDENTE";
}
function valorEfetivoPago(c: any): number {
  if (c.boletoStatus === "PAGO") return c.boletoValorPago ?? c.valor;
  if (c.baixaManualStatus === "PAGO") return c.baixaManualValorPago ?? c.valor;
  return c.valor; // PIX pago = valor cheio
}

const STATUS_TABS: { key: StatusFiltro; label: string }[] = [
  { key: "TODOS",     label: "Todos" },
  { key: "PAGO",      label: "Pagos" },
  { key: "PENDENTE",  label: "Pendentes" },
  { key: "VENCIDO",   label: "Vencidos" },
  { key: "CANCELADO", label: "Cancelados" },
];
const STATUS_CHIP_ATIVO: Record<StatusFiltro, string> = {
  TODOS:     "bg-gray-800 text-white",
  PAGO:      "bg-green-600 text-white",
  PENDENTE:  "bg-yellow-500 text-white",
  VENCIDO:   "bg-orange-600 text-white",
  CANCELADO: "bg-gray-500 text-white",
};

type Tab = "cobrancas" | "relatorio" | "saude";

export default function Cobrancas() {
  const utils = trpc.useUtils();
  const [tab, setTab] = useState<Tab>("cobrancas");

  // Estado do modal alterar valor
  const [alterarModal, setAlterarModal] = useState<AlterarValorState | null>(null);
  const [novoValorStr, setNovoValorStr] = useState("");
  const [novoVencimento, setNovoVencimento] = useState("");
  const [alterarEnviarEmail, setAlterarEnviarEmail] = useState(true);

  // Estado modal baixa manual
  const [baixaModal, setBaixaModal] = useState<BaixaManualState | null>(null);
  const [bmForma, setBmForma] = useState<"PIX" | "DEPOSITO" | "TRANSFERENCIA" | "OUTRO">("PIX");
  const [bmValorStr, setBmValorStr] = useState("");
  const [bmData, setBmData] = useState("");
  const [bmPagadorNome, setBmPagadorNome] = useState("");
  const [bmPagadorDoc, setBmPagadorDoc] = useState("");
  const [bmBanco, setBmBanco] = useState("");
  const [bmObs, setBmObs] = useState("");

  // Estado modal log
  const [logCobrancaId, setLogCobrancaId] = useState<string | null>(null);

  // Filtros relatório
  const [rfEmitente, setRfEmitente] = useState("");
  const [rfCompetencia, setRfCompetencia] = useState("");
  const [rfDataInicio, setRfDataInicio] = useState("");
  const [rfDataFim, setRfDataFim] = useState("");
  const [relFiltros, setRelFiltros] = useState<{ emitenteId?: string; competencia?: string; dataInicio?: string; dataFim?: string }>({});

  const [saudeExpand, setSaudeExpand] = useState<string | null>(null);

  // Filtros da aba Cobranças (client-side sobre a lista carregada)
  const [fBusca, setFBusca]             = useState("");
  const [fCompetencia, setFCompetencia] = useState("");
  const [fCliente, setFCliente]         = useState("");
  const [fEmitente, setFEmitente]       = useState("");
  const [fStatus, setFStatus]           = useState<StatusFiltro>("TODOS");
  const [ordenar, setOrdenar]           = useState<"venc_desc" | "venc_asc" | "valor_desc" | "cliente">("venc_desc");

  const { data, isLoading } = trpc.cobranca.listar.useQuery({ pageSize: 1000 });
  const saudeQ = trpc.cobranca.saudeEmails.useQuery(undefined, { enabled: tab === "saude" });
  const falhasQ = trpc.cobranca.falhasEmail.useQuery(
    { competencia: saudeExpand ?? undefined },
    { enabled: tab === "saude" && !!saudeExpand },
  );
  const reenviarFalhas = trpc.cobranca.reenviarFalhas.useMutation({
    onSuccess: (r) => {
      alert(`${r.total} e-mail(s) sendo reenviados em segundo plano. Atualize em alguns minutos para ver o resultado.`);
      setTimeout(() => { utils.cobranca.saudeEmails.invalidate(); utils.cobranca.falhasEmail.invalidate(); }, 8000);
    },
  });
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

  const cancelarBoleto = trpc.cobranca.cancelarBoleto.useMutation({
    onSuccess: () => {
      utils.cobranca.listar.invalidate();
      utils.cobranca.relatorio.invalidate();
      alert("Boleto cancelado no Sicoob.");
    },
    onError: (e) => alert("Erro ao cancelar boleto: " + e.message),
  });

  const alterarValor = trpc.cobranca.alterarValor.useMutation({
    onSuccess: () => {
      utils.cobranca.listar.invalidate();
      utils.cobranca.relatorio.invalidate();
      setAlterarModal(null);
      alert("Valor alterado e novo boleto emitido com sucesso!");
    },
    onError: (e) => alert("Erro: " + e.message),
  });

  const baixaManualMut = trpc.cobranca.baixaManual.useMutation({
    onSuccess: () => {
      utils.cobranca.listar.invalidate();
      utils.cobranca.relatorio.invalidate();
      fecharBaixaModal();
    },
    onError: (e) => alert("Erro ao registrar baixa: " + e.message),
  });

  const estornarBaixaMut = trpc.cobranca.estornarBaixaManual.useMutation({
    onSuccess: () => {
      utils.cobranca.listar.invalidate();
      utils.cobranca.relatorio.invalidate();
    },
    onError: (e) => alert("Erro ao estornar: " + e.message),
  });

  const { data: logData, isLoading: logLoading } = trpc.cobranca.historicoBaixa.useQuery(
    { id: logCobrancaId! },
    { enabled: !!logCobrancaId }
  );

  // ── Dados derivados dos filtros (client-side) ──────────────────────────────
  const lista = data?.cobrancas ?? [];
  const comStatus = useMemo(
    () => lista.map(c => ({ ...c, _status: statusEfetivo(c) })),
    [lista],
  );

  const competencias = useMemo(() => {
    const s = new Set<string>();
    comStatus.forEach(c => c.competencia && s.add(c.competencia));
    return [...s].sort((a, b) => {
      const [ma, ya] = a.split("/").map(Number);
      const [mb, yb] = b.split("/").map(Number);
      return (yb - ya) || (mb - ma);
    });
  }, [comStatus]);

  const clientes = useMemo(() => {
    const s = new Set<string>();
    comStatus.forEach(c => c.contrato?.tomador?.nome && s.add(c.contrato.tomador.nome));
    return [...s].sort((a, b) => a.localeCompare(b, "pt-BR"));
  }, [comStatus]);

  const emitentes = useMemo(() => {
    const s = new Set<string>();
    comStatus.forEach(c => c.emitente?.nome && s.add(c.emitente.nome));
    return [...s].sort((a, b) => a.localeCompare(b, "pt-BR"));
  }, [comStatus]);

  // Aplica todos os filtros EXCETO status — base para contar os chips ao vivo
  const semStatus = useMemo(() => comStatus.filter(c => {
    if (fCompetencia && c.competencia !== fCompetencia) return false;
    if (fCliente && c.contrato?.tomador?.nome !== fCliente) return false;
    if (fEmitente && c.emitente?.nome !== fEmitente) return false;
    if (fBusca.trim()) {
      const q = fBusca.trim().toLowerCase();
      const hay = `${c.contrato?.tomador?.nome ?? ""} ${c.emitente?.nome ?? ""} ${c.contrato?.nomeServico ?? ""} ${c.competencia ?? ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }), [comStatus, fCompetencia, fCliente, fEmitente, fBusca]);

  const counts = useMemo(() => {
    const c: Record<StatusFiltro, number> = { TODOS: semStatus.length, PAGO: 0, PENDENTE: 0, VENCIDO: 0, CANCELADO: 0 };
    semStatus.forEach(x => { c[x._status] += 1; });
    return c;
  }, [semStatus]);

  const filtradas = useMemo(() => {
    const arr = fStatus === "TODOS" ? semStatus : semStatus.filter(c => c._status === fStatus);
    return [...arr].sort((a, b) => {
      if (ordenar === "venc_desc")  return (b.vencimento ?? "").localeCompare(a.vencimento ?? "");
      if (ordenar === "venc_asc")   return (a.vencimento ?? "").localeCompare(b.vencimento ?? "");
      if (ordenar === "valor_desc") return b.valor - a.valor;
      return (a.contrato?.tomador?.nome ?? "").localeCompare(b.contrato?.tomador?.nome ?? "", "pt-BR");
    });
  }, [semStatus, fStatus, ordenar]);

  const resumo = useMemo(() => {
    let totalGeral = 0, totalPago = 0, totalAberto = 0, qtdVencido = 0;
    filtradas.forEach(c => {
      totalGeral += c.valor;
      if (c._status === "PAGO") totalPago += valorEfetivoPago(c);
      else if (c._status === "PENDENTE" || c._status === "VENCIDO") {
        totalAberto += c.valor;
        if (c._status === "VENCIDO") qtdVencido += 1;
      }
    });
    return { totalGeral, totalPago, totalAberto, qtdVencido, qtd: filtradas.length };
  }, [filtradas]);

  const filtrosAtivos = !!(fBusca || fCompetencia || fCliente || fEmitente || fStatus !== "TODOS");
  function limparFiltros() {
    setFBusca(""); setFCompetencia(""); setFCliente(""); setFEmitente(""); setFStatus("TODOS");
  }

  function abrirBaixaModal(cobrancaId: string, valorCobranca: number) {
    setBmForma("PIX");
    setBmValorStr((valorCobranca / 100).toFixed(2).replace(".", ","));
    setBmData(new Date().toISOString().slice(0, 10));
    setBmPagadorNome("");
    setBmPagadorDoc("");
    setBmBanco("");
    setBmObs("");
    setBaixaModal({ cobrancaId, valorCobranca });
  }

  function fecharBaixaModal() {
    setBaixaModal(null);
  }

  function confirmarBaixaManual() {
    if (!baixaModal) return;
    const valorParsed = parseFloat(bmValorStr.replace(",", "."));
    if (isNaN(valorParsed) || valorParsed <= 0) { alert("Valor inválido."); return; }
    if (!bmData) { alert("Informe a data do recebimento."); return; }
    baixaManualMut.mutate({
      id:              baixaModal.cobrancaId,
      formaPagamento:  bmForma,
      valorPago:       Math.round(valorParsed * 100),
      dataRecebimento: bmData,
      pagadorNome:     bmPagadorNome || undefined,
      pagadorDoc:      bmPagadorDoc  || undefined,
      banco:           bmBanco       || undefined,
      obs:             bmObs         || undefined,
    });
  }

  function abrirModalAlterar(cobrancaId: string, valorAtual: number, vencimentoAtual: string) {
    setNovoValorStr((valorAtual / 100).toFixed(2).replace(".", ","));
    setNovoVencimento(vencimentoAtual);
    setAlterarEnviarEmail(true);
    setAlterarModal({ cobrancaId, valorAtual, vencimentoAtual });
  }

  function confirmarAlterarValor() {
    if (!alterarModal) return;
    const valorParsed = parseFloat(novoValorStr.replace(",", "."));
    if (isNaN(valorParsed) || valorParsed <= 0) {
      alert("Valor inválido.");
      return;
    }
    const novoValorCentavos = Math.round(valorParsed * 100);
    alterarValor.mutate({
      id: alterarModal.cobrancaId,
      novoValor: novoValorCentavos,
      novoVencimento: novoVencimento || undefined,
      enviarEmail: alterarEnviarEmail,
    });
  }

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
    { key: "saude",     label: "📧 Saúde dos E-mails" },
  ];

  return (
    <div className="p-4 md:p-8">
      <div className="flex flex-col sm:flex-row sm:items-center gap-3 mb-6">
        <h1 className="text-2xl font-bold text-gray-900 flex-1">Cobranças</h1>
        <div className="flex gap-2 flex-wrap">
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
          {/* Toolbar: filtros + ação */}
          <div className="bg-white border border-gray-200 rounded-xl p-4 mb-4 space-y-3">
            <div className="flex flex-wrap gap-3 items-end">
              <div className="flex-1 min-w-[180px]">
                <label className="block text-xs font-medium text-gray-600 mb-1">Buscar</label>
                <input
                  type="text" value={fBusca} onChange={e => setFBusca(e.target.value)}
                  placeholder="Cliente, emitente, serviço..."
                  className="w-full border rounded-lg px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Mês (competência)</label>
                <select value={fCompetencia} onChange={e => setFCompetencia(e.target.value)}
                  className="border rounded-lg px-3 py-2 text-sm w-40">
                  <option value="">Todos os meses</option>
                  {competencias.map(comp => <option key={comp} value={comp}>{comp}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Cliente</label>
                <select value={fCliente} onChange={e => setFCliente(e.target.value)}
                  className="border rounded-lg px-3 py-2 text-sm max-w-[220px]">
                  <option value="">Todos os clientes</option>
                  {clientes.map(nome => <option key={nome} value={nome}>{nome}</option>)}
                </select>
              </div>
              {emitentes.length > 1 && (
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Emitente</label>
                  <select value={fEmitente} onChange={e => setFEmitente(e.target.value)}
                    className="border rounded-lg px-3 py-2 text-sm max-w-[200px]">
                    <option value="">Todos</option>
                    {emitentes.map(nome => <option key={nome} value={nome}>{nome}</option>)}
                  </select>
                </div>
              )}
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Ordenar por</label>
                <select value={ordenar} onChange={e => setOrdenar(e.target.value as typeof ordenar)}
                  className="border rounded-lg px-3 py-2 text-sm">
                  <option value="venc_desc">Vencimento ↓</option>
                  <option value="venc_asc">Vencimento ↑</option>
                  <option value="valor_desc">Maior valor</option>
                  <option value="cliente">Cliente (A-Z)</option>
                </select>
              </div>
              <button
                onClick={() => consultarStatus.mutate({})}
                disabled={consultarStatus.isPending}
                className="text-sm bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg disabled:opacity-50 ml-auto"
              >
                {consultarStatus.isPending ? "Consultando..." : "🔄 Atualizar Status Sicoob"}
              </button>
            </div>

            {/* Chips de classificação por status (com contagem ao vivo) */}
            <div className="flex flex-wrap gap-2 items-center">
              {STATUS_TABS.map(t => (
                <button key={t.key} onClick={() => setFStatus(t.key)}
                  className={`text-xs px-3 py-1.5 rounded-full transition-colors ${fStatus === t.key ? STATUS_CHIP_ATIVO[t.key] : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}>
                  {t.label} <span className="opacity-70">({counts[t.key]})</span>
                </button>
              ))}
              {filtrosAtivos && (
                <button onClick={limparFiltros}
                  className="text-xs px-3 py-1.5 rounded-full bg-red-50 text-red-600 hover:bg-red-100 ml-1">
                  ✕ Limpar filtros
                </button>
              )}
            </div>
          </div>

          {/* Resumo do conjunto filtrado */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
            <div className="bg-white border border-gray-200 rounded-xl px-4 py-3">
              <p className="text-xs text-gray-500">Exibindo</p>
              <p className="text-lg font-bold text-gray-900">{resumo.qtd} <span className="text-xs font-normal text-gray-400">de {comStatus.length}</span></p>
            </div>
            <div className="bg-white border border-gray-200 rounded-xl px-4 py-3">
              <p className="text-xs text-gray-500">Valor total</p>
              <p className="text-lg font-bold text-gray-900">{fmt(resumo.totalGeral)}</p>
            </div>
            <div className="bg-white border border-green-200 rounded-xl px-4 py-3">
              <p className="text-xs text-gray-500">Recebido</p>
              <p className="text-lg font-bold text-green-700">{fmt(resumo.totalPago)}</p>
            </div>
            <div className="bg-white border border-orange-200 rounded-xl px-4 py-3">
              <p className="text-xs text-gray-500">Em aberto</p>
              <p className="text-lg font-bold text-orange-700">{fmt(resumo.totalAberto)}</p>
              {resumo.qtdVencido > 0 && <p className="text-xs text-orange-500 mt-0.5">{resumo.qtdVencido} vencido(s)</p>}
            </div>
          </div>

          {isLoading ? (
            <div className="text-gray-500 text-sm">Carregando...</div>
          ) : (
            <div className="space-y-3">
              {filtradas.map(c => (
                <div key={c.id} className="bg-white border border-gray-200 rounded-xl p-4 md:p-5 flex flex-col sm:flex-row sm:items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-semibold text-gray-900">{c.emitente.nome}</p>
                      <span className="text-gray-400">→</span>
                      <p className="text-gray-700">{c.contrato.tomador.nome}</p>
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${EFF_COLOR[(c as any)._status] ?? "bg-gray-100 text-gray-600"}`}>
                        {(c as any)._status}
                      </span>
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
                    {(c as any).baixaManualStatus === "PAGO" && (
                      <div className="mt-1 text-xs text-emerald-700 bg-emerald-50 rounded-lg px-2 py-1 inline-block">
                        <span className="font-semibold">Baixa manual:</span>{" "}
                        {(c as any).baixaManualFormaPagamento}{" "}
                        {(c as any).baixaManualDataRecebimento ? `· Recebido em ${fmtData((c as any).baixaManualDataRecebimento)}` : ""}{" "}
                        {(c as any).baixaManualValorPago ? `· ${fmt((c as any).baixaManualValorPago)}` : ""}
                        {(c as any).baixaManualPagadorNome ? ` · ${(c as any).baixaManualPagadorNome}` : ""}
                        {(c as any).baixaManualBanco ? ` · ${(c as any).baixaManualBanco}` : ""}
                        {(c as any).baixaManualObs ? ` · ${(c as any).baixaManualObs}` : ""}
                        {(c as any).baixaManualPorNome ? (
                          <span className="text-emerald-500 ml-1">(por {(c as any).baixaManualPorNome})</span>
                        ) : null}
                      </div>
                    )}
                    {c.boletoLinhaDigitavel && (
                      <p className="text-xs text-gray-400 mt-1 font-mono">{c.boletoLinhaDigitavel.slice(0, 50)}...</p>
                    )}
                  </div>
                  <div className="flex gap-2 flex-wrap sm:flex-shrink-0">
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
                    {c.boletoNossoNumero && c.boletoStatus !== "PAGO" && c.boletoStatus !== "CANCELADO" && (
                      <button
                        onClick={() => {
                          if (confirm(`Cancelar boleto #${c.boletoNossoNumero} no Sicoob?`))
                            cancelarBoleto.mutate({ id: c.id });
                        }}
                        disabled={cancelarBoleto.isPending}
                        className="text-xs bg-orange-50 hover:bg-orange-100 text-orange-700 px-3 py-1.5 rounded-lg disabled:opacity-50"
                      >
                        Cancelar Boleto
                      </button>
                    )}
                    {c.boletoStatus !== "PAGO" && (
                      <button
                        onClick={() => abrirModalAlterar(c.id, c.valor, c.vencimento)}
                        className="text-xs bg-purple-50 hover:bg-purple-100 text-purple-700 px-3 py-1.5 rounded-lg"
                      >
                        Alterar Valor
                      </button>
                    )}
                    {/* Baixa Manual / Estorno */}
                    {(c as any).baixaManualStatus === "PAGO" ? (
                      <button
                        onClick={() => {
                          if (confirm("Estornar baixa manual? A cobrança voltará a aparecer como pendente."))
                            estornarBaixaMut.mutate({ id: c.id });
                        }}
                        disabled={estornarBaixaMut.isPending}
                        className="text-xs bg-amber-50 hover:bg-amber-100 text-amber-700 px-3 py-1.5 rounded-lg disabled:opacity-50"
                      >
                        Estornar Baixa
                      </button>
                    ) : (
                      c.pixStatus !== "PAGO" && c.boletoStatus !== "PAGO" && (
                        <button
                          onClick={() => abrirBaixaModal(c.id, c.valor)}
                          className="text-xs bg-emerald-50 hover:bg-emerald-100 text-emerald-700 px-3 py-1.5 rounded-lg font-medium"
                        >
                          Baixa Manual
                        </button>
                      )
                    )}
                    <button
                      onClick={() => setLogCobrancaId(c.id)}
                      className="text-xs bg-gray-50 hover:bg-gray-100 text-gray-500 px-3 py-1.5 rounded-lg"
                      title="Ver log de baixas manuais"
                    >
                      Log
                    </button>
                    <button onClick={() => { if (confirm("Excluir cobrança?")) excluir.mutate({ id: c.id }); }}
                      className="text-xs bg-red-50 hover:bg-red-100 text-red-700 px-3 py-1.5 rounded-lg">
                      Excluir
                    </button>
                  </div>
                </div>
              ))}
              {!filtradas.length && (
                <p className="text-gray-500 text-sm">
                  {comStatus.length === 0
                    ? 'Nenhuma cobrança gerada. Use o botão "Cobrança" em um contrato.'
                    : "Nenhuma cobrança corresponde aos filtros selecionados."}
                </p>
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
              <div className="bg-white border border-gray-200 rounded-xl overflow-x-auto">
                <table className="w-full text-sm min-w-[640px]">
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

      {/* ── Tab: Saúde dos E-mails ── */}
      {tab === "saude" && (
        <div className="space-y-4">
          <p className="text-sm text-gray-500">
            Acompanhe, mês a mês, se todos os clientes receberam a Nota de Honorários + boleto por e-mail.
            E-mails que falharem são reenviados automaticamente pelo sistema a cada 30 min (até 6 tentativas);
            você também pode reenviar manualmente abaixo.
          </p>

          {saudeQ.isLoading ? (
            <div className="text-gray-500 text-sm">Carregando...</div>
          ) : !saudeQ.data?.length ? (
            <div className="text-gray-400 text-sm py-8 text-center">Nenhuma cobrança registrada ainda.</div>
          ) : (
            <div className="space-y-3">
              {saudeQ.data.map(m => {
                const tudoOk = m.falhas === 0 && m.pendentes === 0;
                const aberto = saudeExpand === m.competencia;
                return (
                  <div key={m.competencia} className="bg-white border border-gray-200 rounded-xl overflow-hidden">
                    <div className="p-4 md:p-5 flex flex-col sm:flex-row sm:items-center gap-3">
                      <div className="flex items-center gap-3 flex-1 min-w-0">
                        <span className={`text-2xl ${tudoOk ? "" : "animate-pulse"}`}>{tudoOk ? "✅" : "⚠️"}</span>
                        <div>
                          <p className="font-semibold text-gray-900">Competência {m.competencia}</p>
                          <p className="text-xs text-gray-500">
                            {m.enviados}/{m.total} enviados
                            {m.ultimoEnvio ? ` · último envio ${new Date(m.ultimoEnvio).toLocaleString("pt-BR")}` : ""}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700">{m.enviados} enviados</span>
                        {m.falhas > 0 &&    <span className="text-xs px-2 py-0.5 rounded-full bg-red-100 text-red-700">{m.falhas} falha(s)</span>}
                        {m.pendentes > 0 && <span className="text-xs px-2 py-0.5 rounded-full bg-yellow-100 text-yellow-700">{m.pendentes} pendente(s)</span>}
                        {!tudoOk && (
                          <>
                            <button
                              onClick={() => setSaudeExpand(aberto ? null : m.competencia)}
                              className="text-xs px-3 py-1.5 rounded-lg bg-gray-100 text-gray-700 hover:bg-gray-200">
                              {aberto ? "Ocultar" : "Ver detalhes"}
                            </button>
                            <button
                              onClick={() => { if (confirm(`Reenviar ${m.falhas + m.pendentes} e-mail(s) da competência ${m.competencia}? As notas e boletos já emitidos serão reaproveitados (nada é reemitido).`)) reenviarFalhas.mutate({ competencia: m.competencia }); }}
                              disabled={reenviarFalhas.isPending}
                              className="text-xs px-3 py-1.5 rounded-lg bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50">
                              {reenviarFalhas.isPending ? "Reenviando..." : "↻ Reenviar falhas"}
                            </button>
                          </>
                        )}
                      </div>
                    </div>

                    {aberto && (
                      <div className="border-t border-gray-100 bg-gray-50 px-4 py-3">
                        {falhasQ.isLoading ? (
                          <div className="text-gray-500 text-sm py-2">Carregando...</div>
                        ) : !falhasQ.data?.length ? (
                          <div className="text-gray-400 text-sm py-2">Nenhuma falha nesta competência.</div>
                        ) : (
                          <div className="space-y-2">
                            {falhasQ.data.map(f => (
                              <div key={f.id} className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-3 text-sm bg-white border border-gray-200 rounded-lg px-3 py-2">
                                <div className="flex-1 min-w-0">
                                  <span className="font-medium text-gray-800">{f.contrato.tomador.nome}</span>
                                  <span className="text-gray-400 text-xs ml-2">{f.contrato.tomador.email || "sem e-mail"}</span>
                                </div>
                                <span className={`text-xs px-2 py-0.5 rounded-full ${f.emailStatus === "FALHA" ? "bg-red-100 text-red-700" : "bg-yellow-100 text-yellow-700"}`}>
                                  {f.emailStatus} ({f.emailTentativas}x)
                                </span>
                                <span className="text-xs text-gray-500 truncate max-w-[280px]" title={f.emailErro || ""}>{f.emailErro || "—"}</span>
                                <button
                                  onClick={() => reenviarEmail.mutate({ id: f.id })}
                                  disabled={reenviarEmail.isPending}
                                  className="text-xs px-2 py-1 rounded bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50">
                                  ↻ Reenviar
                                </button>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ── Modal Baixa Manual ── */}
      {baixaModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-xl p-6 w-full max-w-md">
            <h2 className="text-lg font-bold text-gray-900 mb-1">Registrar Baixa Manual</h2>
            <p className="text-xs text-gray-500 mb-5">
              Registre o pagamento recebido por depósito ou PIX avulso. Um log de auditoria será criado com seu usuário.
            </p>

            <div className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Forma de pagamento</label>
                <select
                  value={bmForma}
                  onChange={e => setBmForma(e.target.value as typeof bmForma)}
                  className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                >
                  <option value="PIX">PIX avulso</option>
                  <option value="DEPOSITO">Depósito bancário</option>
                  <option value="TRANSFERENCIA">Transferência (TED/DOC)</option>
                  <option value="OUTRO">Outro</option>
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Valor recebido (R$)</label>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={bmValorStr}
                    onChange={e => setBmValorStr(e.target.value)}
                    className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                    placeholder="Ex: 1500,00"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Data do recebimento</label>
                  <input
                    type="date"
                    value={bmData}
                    onChange={e => setBmData(e.target.value)}
                    className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Nome do pagador <span className="text-gray-400">(opcional)</span></label>
                  <input
                    type="text"
                    value={bmPagadorNome}
                    onChange={e => setBmPagadorNome(e.target.value)}
                    className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                    placeholder="Nome completo"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">CPF/CNPJ do pagador <span className="text-gray-400">(opcional)</span></label>
                  <input
                    type="text"
                    value={bmPagadorDoc}
                    onChange={e => setBmPagadorDoc(e.target.value)}
                    className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                    placeholder="000.000.000-00"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Banco / Origem <span className="text-gray-400">(opcional)</span></label>
                <input
                  type="text"
                  value={bmBanco}
                  onChange={e => setBmBanco(e.target.value)}
                  className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  placeholder="Ex: Sicoob, Nubank, Bradesco..."
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Observações <span className="text-gray-400">(opcional)</span></label>
                <textarea
                  value={bmObs}
                  onChange={e => setBmObs(e.target.value)}
                  rows={2}
                  className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 resize-none"
                  placeholder="Ex: comprovante enviado por WhatsApp, referência ao nosso número..."
                />
              </div>
            </div>

            <div className="flex gap-3 mt-6">
              <button
                onClick={confirmarBaixaManual}
                disabled={baixaManualMut.isPending}
                className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium py-2 rounded-lg disabled:opacity-50"
              >
                {baixaManualMut.isPending ? "Registrando..." : "Confirmar Baixa"}
              </button>
              <button
                onClick={fecharBaixaModal}
                disabled={baixaManualMut.isPending}
                className="flex-1 bg-gray-100 hover:bg-gray-200 text-gray-700 text-sm font-medium py-2 rounded-lg disabled:opacity-50"
              >
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Modal Log de Baixas ── */}
      {logCobrancaId && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-xl p-6 w-full max-w-lg">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-bold text-gray-900">Log de Baixas Manuais</h2>
              <button onClick={() => setLogCobrancaId(null)} className="text-gray-400 hover:text-gray-600 text-xl leading-none">&times;</button>
            </div>

            {logLoading ? (
              <p className="text-sm text-gray-400">Carregando...</p>
            ) : !logData?.length ? (
              <p className="text-sm text-gray-400 py-4 text-center">Nenhum registro de baixa manual para esta cobrança.</p>
            ) : (
              <div className="space-y-3 max-h-96 overflow-y-auto pr-1">
                {logData.map(log => (
                  <div key={log.id} className={`rounded-xl border p-3 text-xs ${log.acao === "BAIXA_MANUAL" ? "border-emerald-200 bg-emerald-50" : "border-amber-200 bg-amber-50"}`}>
                    <div className="flex items-center justify-between mb-1">
                      <span className={`font-semibold ${log.acao === "BAIXA_MANUAL" ? "text-emerald-700" : "text-amber-700"}`}>
                        {log.acao === "BAIXA_MANUAL" ? "Baixa Manual" : "Estorno de Baixa"}
                      </span>
                      <span className="text-gray-400">{new Date(log.criadoEm).toLocaleString("pt-BR")}</span>
                    </div>
                    <p className="text-gray-700 font-medium">Por: {log.usuarioNome} ({log.usuarioEmail})</p>
                    {log.formaPagamento && (
                      <p className="text-gray-600 mt-1">
                        {log.formaPagamento}
                        {log.valorPago ? ` · ${fmt(log.valorPago)}` : ""}
                        {log.dataRecebimento ? ` · Recebido em ${fmtData(log.dataRecebimento)}` : ""}
                      </p>
                    )}
                    {log.pagadorNome && <p className="text-gray-600">Pagador: {log.pagadorNome}{log.pagadorDoc ? ` — ${log.pagadorDoc}` : ""}</p>}
                    {log.banco       && <p className="text-gray-600">Banco: {log.banco}</p>}
                    {log.obs         && <p className="text-gray-500 italic mt-0.5">{log.obs}</p>}
                  </div>
                ))}
              </div>
            )}

            <button
              onClick={() => setLogCobrancaId(null)}
              className="mt-5 w-full bg-gray-100 hover:bg-gray-200 text-gray-700 text-sm font-medium py-2 rounded-lg"
            >
              Fechar
            </button>
          </div>
        </div>
      )}

      {/* ── Modal Alterar Valor ── */}
      {alterarModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-xl p-6 w-full max-w-sm">
            <h2 className="text-lg font-bold text-gray-900 mb-1">Alterar Valor do Boleto</h2>
            <p className="text-xs text-gray-500 mb-4">
              O boleto atual será cancelado no Sicoob e um novo será emitido com o valor informado.
            </p>

            <div className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Novo valor (R$)</label>
                <input
                  type="text"
                  inputMode="decimal"
                  value={novoValorStr}
                  onChange={e => setNovoValorStr(e.target.value)}
                  className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
                  placeholder="Ex: 1500,00"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  Novo vencimento <span className="text-gray-400">(opcional)</span>
                </label>
                <input
                  type="date"
                  value={novoVencimento}
                  onChange={e => setNovoVencimento(e.target.value)}
                  className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
                />
              </div>
              <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={alterarEnviarEmail}
                  onChange={e => setAlterarEnviarEmail(e.target.checked)}
                  className="rounded"
                />
                Reenviar e-mail ao cliente com novo boleto
              </label>
            </div>

            <div className="flex gap-3 mt-6">
              <button
                onClick={confirmarAlterarValor}
                disabled={alterarValor.isPending}
                className="flex-1 bg-purple-600 hover:bg-purple-700 text-white text-sm font-medium py-2 rounded-lg disabled:opacity-50"
              >
                {alterarValor.isPending ? "Processando..." : "Confirmar"}
              </button>
              <button
                onClick={() => setAlterarModal(null)}
                disabled={alterarValor.isPending}
                className="flex-1 bg-gray-100 hover:bg-gray-200 text-gray-700 text-sm font-medium py-2 rounded-lg disabled:opacity-50"
              >
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
