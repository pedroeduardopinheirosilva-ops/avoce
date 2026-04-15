import { useState, useRef } from "react";
import { trpc } from "../lib/trpc";

function competenciaAtual() {
  const d = new Date();
  return `${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
}

function vencimentoPadrao(diaVencimento: number) {
  const d = new Date();
  d.setDate(diaVencimento);
  if (d < new Date()) d.setMonth(d.getMonth() + 1);
  return d.toISOString().slice(0, 10);
}

function fmt(centavos: number) {
  return (centavos / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

export default function Contratos() {
  const utils  = trpc.useUtils();
  const [filterEmitenteId, setFilterEmitenteId] = useState("");
  const { data: contratos, isLoading } = trpc.contrato.listar.useQuery({
    apenasAtivos: false,
    ...(filterEmitenteId ? { emitenteId: filterEmitenteId } : {}),
  });
  const { data: empresas }  = trpc.empresa.listar.useQuery();
  const { data: tomadores } = trpc.tomador.listar.useQuery({});
  const [form, setForm] = useState<any>(null);

  const [cobForm, setCobForm] = useState<{ contratoId: string; diaVencimento: number; metodo: "PIX" | "BOLETO" | "AMBOS" } | null>(null);
  const [cobVencimento, setCobVencimento] = useState("");
  const [cobEnviarEmail, setCobEnviarEmail] = useState(true);
  const cobMetodoRef = useRef<"PIX" | "BOLETO" | "AMBOS">("AMBOS");

  const criar        = trpc.contrato.criar.useMutation({ onSuccess: () => { utils.contrato.listar.invalidate(); setForm(null); } });
  const atualizar    = trpc.contrato.atualizar.useMutation({ onSuccess: () => { utils.contrato.listar.invalidate(); setForm(null); } });
  const toggleTipo   = trpc.contrato.atualizar.useMutation({ onSuccess: () => utils.contrato.listar.invalidate() });
  const excluir  = trpc.contrato.excluir.useMutation({ onSuccess: () => utils.contrato.listar.invalidate() });
  const emitir   = trpc.nota.emitir.useMutation({
    onSuccess: () => { alert("NFS-e emitida com sucesso!"); utils.nota.listar.invalidate(); },
    onError: (e) => alert(`Erro: ${e.message}`),
  });
  const gerarCobranca = trpc.cobranca.gerar.useMutation({
    onSuccess: (cob) => {
      setCobForm(null);
      const token = localStorage.getItem("avoce_token");
      const metodo = cobMetodoRef.current;
      // Carta (PIX): abrir quando há PIX
      if (metodo !== "BOLETO") {
        window.open(`/api/cobranca/${cob.id}/html?token=${token}`, "_blank");
      }
      // Boleto PDF: abrir quando há boleto
      if (metodo !== "PIX") {
        window.open(`/api/cobranca/${cob.id}/boleto.pdf?token=${token}`, "_blank");
      }
      utils.cobranca.listar.invalidate();
    },
    onError: (e) => alert(`Erro ao gerar cobrança: ${e.message}`),
  });

  function salvar() {
    if (!form) return;
    const tipoContrato  = form.tipoContrato ?? "RECORRENTE";
    const totalParcelas = tipoContrato === "PARCELADO" ? (parseInt(form.totalParcelasStr ?? "0") || null) : null;
    const data = {
      emitenteId:        form.emitenteId,
      tomadorId:         form.tomadorId,
      nomeServico:       form.nomeServico || null,
      descricaoServico:  form.descricaoServico,
      itemListaServico:  form.itemListaServico || null,
      codigoNbs:         form.codigoNbs || null,
      valor:             Math.round(parseFloat(form.valorStr ?? "0") * 100),
      diaVencimento:     parseInt(form.diaVencimento ?? "5"),
      issRetido:         form.issRetido ?? false,
      retirIr:           form.retirIr ?? false,
      retirCsll:         form.retirCsll ?? false,
      retirPis:          form.retirPis ?? false,
      retirCofins:       form.retirCofins ?? false,
      emitirNfseAuto:    form.emitirNfseAuto ?? true,
      gerarCobrancaAuto: form.gerarCobrancaAuto ?? true,
      metodoCobr:        form.gerarCobrancaAuto !== false ? (form.metodoCobr ?? "PIX_BOLETO") : "NENHUM",
      tipoContrato,
      totalParcelas,
      observacoes:       form.observacoes || null,
    };
    if (form.id) atualizar.mutate({ id: form.id, ...data });
    else criar.mutate(data);
  }

  if (isLoading) return <div className="p-8 text-gray-500">Carregando...</div>;

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Contratos</h1>
        <button onClick={() => setForm({ diaVencimento: 5, issRetido: false, emitirNfseAuto: true, gerarCobrancaAuto: true, metodoCobr: "PIX_BOLETO" })} className="bg-brand-600 hover:bg-brand-700 text-white px-4 py-2 rounded-lg text-sm font-medium">
          + Novo Contrato
        </button>
      </div>

      {/* Filtro por empresa */}
      {empresas && empresas.length > 1 && (
        <div className="mb-4">
          <select
            value={filterEmitenteId}
            onChange={e => setFilterEmitenteId(e.target.value)}
            className="border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white text-gray-700 min-w-[220px]"
          >
            <option value="">Todas as empresas</option>
            {empresas.map(e => (
              <option key={e.id} value={e.id}>{e.nomeFantasia || e.nome}</option>
            ))}
          </select>
        </div>
      )}

      <div className="space-y-3">
        {contratos?.map((c) => {
          const metodoCobr = (c as any).metodoCobr ?? "PIX_BOLETO";
          return (
          <div key={c.id} className={`bg-white border rounded-xl p-5 flex items-start justify-between ${!c.ativo ? "opacity-50" : "border-gray-200"}`}>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <p className="font-semibold text-gray-900 truncate">{c.emitente.nome}</p>
                <span className="text-gray-400">→</span>
                <p className="text-gray-700 truncate">{c.tomador.nome}</p>
                {!c.ativo && <span className="text-xs bg-orange-100 text-orange-600 px-2 py-0.5 rounded">Suspenso</span>}
                <button
                  title={(c as any).emitirNfseAuto ? "Clique para tornar eventual" : "Clique para tornar recorrente"}
                  onClick={() => toggleTipo.mutate({ id: c.id, emitirNfseAuto: !(c as any).emitirNfseAuto })}
                  className={`text-xs px-2 py-0.5 rounded font-medium border transition-colors ${
                    (c as any).emitirNfseAuto
                      ? "bg-brand-50 text-brand-700 border-brand-200 hover:bg-brand-100"
                      : "bg-gray-100 text-gray-500 border-gray-200 hover:bg-gray-200"
                  }`}
                >
                  {(c as any).emitirNfseAuto ? "🔄 Recorrente" : "📌 Eventual"}
                </button>
              </div>
              <p className="text-sm text-gray-500 mt-1 truncate">{c.descricaoServico}</p>
              <p className="text-sm font-medium text-gray-800 mt-1">
                {fmt(c.valor)} · Vence dia {c.diaVencimento} ·{" "}
                {metodoCobr === "PIX" ? "PIX" : metodoCobr === "BOLETO" ? "Boleto" : metodoCobr === "NENHUM" ? "Sem cobrança" : "PIX+Boleto"}
                {c.issRetido && " · ISS Retido"}
                {(c as any).tipoContrato === "PARCELADO" && (c as any).totalParcelas && (
                  <span className="ml-2 text-xs bg-indigo-100 text-indigo-700 px-2 py-0.5 rounded-full font-medium">
                    {(c as any).totalParcelas}x parcelas
                  </span>
                )}
              </p>
            </div>
            <div className="flex gap-2 flex-shrink-0 ml-4 flex-wrap justify-end">
              {c.ativo && (
                <>
                  <button
                    onClick={() => { setCobVencimento(vencimentoPadrao(c.diaVencimento)); setCobForm({ contratoId: c.id, diaVencimento: c.diaVencimento, metodo: "PIX" }); }}
                    className="text-xs bg-purple-50 hover:bg-purple-100 text-purple-700 px-3 py-1.5 rounded-lg"
                  >PIX</button>
                  <button
                    onClick={() => { setCobVencimento(vencimentoPadrao(c.diaVencimento)); setCobForm({ contratoId: c.id, diaVencimento: c.diaVencimento, metodo: "BOLETO" }); }}
                    className="text-xs bg-blue-50 hover:bg-blue-100 text-blue-700 px-3 py-1.5 rounded-lg"
                  >Boleto</button>
                  <button
                    onClick={() => { setCobVencimento(vencimentoPadrao(c.diaVencimento)); setCobForm({ contratoId: c.id, diaVencimento: c.diaVencimento, metodo: "AMBOS" }); }}
                    className="text-xs bg-teal-50 hover:bg-teal-100 text-teal-700 px-3 py-1.5 rounded-lg"
                  >PIX+Boleto</button>
                </>
              )}
              <button
                onClick={() => { if (confirm(`Emitir NFS-e para ${competenciaAtual()}?`)) emitir.mutate({ contratoId: c.id }); }}
                disabled={emitir.isPending}
                className="text-xs bg-green-50 hover:bg-green-100 text-green-700 px-3 py-1.5 rounded-lg disabled:opacity-50"
              >Emitir NFS-e</button>
              <button onClick={() => setForm({ ...c, valorStr: (c.valor / 100).toFixed(2), totalParcelasStr: (c as any).totalParcelas ? String((c as any).totalParcelas) : "" })}
                className="text-xs bg-blue-50 hover:bg-blue-100 text-blue-700 px-3 py-1.5 rounded-lg">Editar</button>
              {c.ativo && (
                <button onClick={() => { if (confirm("Suspender contrato? O contrato ficará inativo e não gerará mais NFS-e automática.")) excluir.mutate({ id: c.id }); }}
                  className="text-xs bg-orange-50 hover:bg-orange-100 text-orange-700 px-3 py-1.5 rounded-lg">Suspender</button>
              )}
            </div>
          </div>
          );
        })}
        {!contratos?.length && <p className="text-gray-500 text-sm">Nenhum contrato cadastrado.</p>}
      </div>

      {/* Modal Cobrança */}
      {cobForm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl p-6 w-full max-w-sm">
            <h2 className="text-lg font-bold mb-1">
              {cobForm.metodo === "PIX" ? "Emitir PIX" : cobForm.metodo === "BOLETO" ? "Emitir Boleto" : "Emitir PIX + Boleto"}
            </h2>
            <p className="text-xs text-gray-500 mb-4">Cobrança avulsa — fora do faturamento automático</p>
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Método</label>
                <select
                  value={cobForm.metodo}
                  onChange={e => setCobForm(f => f ? { ...f, metodo: e.target.value as any } : f)}
                  className="w-full border rounded-lg px-3 py-2 text-sm"
                >
                  <option value="PIX">PIX</option>
                  <option value="BOLETO">Boleto</option>
                  <option value="AMBOS">PIX + Boleto</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Competência</label>
                <input value={competenciaAtual()} readOnly className="w-full border rounded-lg px-3 py-2 text-sm bg-gray-50" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Vencimento *</label>
                <input type="date" value={cobVencimento} onChange={e => setCobVencimento(e.target.value)}
                  className="w-full border rounded-lg px-3 py-2 text-sm" />
              </div>
              <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={cobEnviarEmail}
                  onChange={e => setCobEnviarEmail(e.target.checked)}
                  className="w-4 h-4 rounded accent-teal-600"
                />
                Enviar e-mail ao destinatário
              </label>
            </div>
            <div className="flex justify-end gap-2 mt-5">
              <button onClick={() => setCobForm(null)} className="text-sm text-gray-600 px-4 py-2">Cancelar</button>
              <button
                onClick={() => {
                  cobMetodoRef.current = cobForm.metodo;
                  gerarCobranca.mutate({
                    contratoId: cobForm.contratoId,
                    competencia: competenciaAtual(),
                    vencimento: cobVencimento,
                    comPix:      cobForm.metodo !== "BOLETO",
                    comBoleto:   cobForm.metodo !== "PIX",
                    forcar:      true,
                    enviarEmail: cobEnviarEmail,
                  });
                }}
                disabled={!cobVencimento || gerarCobranca.isPending}
                className="bg-teal-600 hover:bg-teal-700 text-white text-sm px-4 py-2 rounded-lg disabled:opacity-50"
              >
                {gerarCobranca.isPending ? "Gerando..." : "Gerar e Abrir"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal Contrato */}
      {form && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto">
            <h2 className="text-lg font-bold mb-4">{form.id ? "Editar Contrato" : "Novo Contrato"}</h2>
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Empresa Emitente *</label>
                <select value={form.emitenteId ?? ""} onChange={e => setForm((f: any) => ({ ...f, emitenteId: e.target.value }))}
                  className="w-full border rounded-lg px-3 py-2 text-sm">
                  <option value="">Selecione...</option>
                  {empresas?.filter(e => e.ativo).map(e => (
                    <option key={e.id} value={e.id}>{e.nome}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Tomador *</label>
                <select value={form.tomadorId ?? ""} onChange={e => setForm((f: any) => ({ ...f, tomadorId: e.target.value }))}
                  className="w-full border rounded-lg px-3 py-2 text-sm">
                  <option value="">Selecione...</option>
                  {tomadores?.map(t => (
                    <option key={t.id} value={t.id}>{t.nome}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Serviço</label>
                <input value={form.nomeServico ?? ""} placeholder="Ex: Assessoria Jurídica Societária"
                  onChange={e => setForm((f: any) => ({ ...f, nomeServico: e.target.value }))}
                  className="w-full border rounded-lg px-3 py-2 text-sm" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Serviço Nacional (LC 116)</label>
                  <input value={form.itemListaServico ?? ""} placeholder="Ex: 1.01"
                    onChange={e => setForm((f: any) => ({ ...f, itemListaServico: e.target.value }))}
                    className="w-full border rounded-lg px-3 py-2 text-sm" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Serviço NBS</label>
                  <input value={form.codigoNbs ?? ""} placeholder="Ex: 1.0101.00.00"
                    onChange={e => setForm((f: any) => ({ ...f, codigoNbs: e.target.value }))}
                    className="w-full border rounded-lg px-3 py-2 text-sm" />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  Discriminação dos Serviços *
                  <span className="ml-2 text-gray-400 font-normal text-xs">Variáveis: {'{{mes_referencia}}'} {'{{vencimento}}'} {'{{valor}}'} {'{{tomador}}'}</span>
                </label>
                <textarea value={form.descricaoServico ?? ""} onChange={e => setForm((f: any) => ({ ...f, descricaoServico: e.target.value }))}
                  rows={4} className="w-full border rounded-lg px-3 py-2 text-sm font-mono" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Valor (R$) *</label>
                  <input type="number" step="0.01" min="0"
                    value={form.valorStr ?? ""}
                    onChange={e => setForm((f: any) => ({ ...f, valorStr: e.target.value }))}
                    className="w-full border rounded-lg px-3 py-2 text-sm" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Dia do Vencimento *</label>
                  <input type="number" min="1" max="28"
                    value={form.diaVencimento ?? 5}
                    onChange={e => setForm((f: any) => ({ ...f, diaVencimento: parseInt(e.target.value) }))}
                    className="w-full border rounded-lg px-3 py-2 text-sm" />
                </div>
              </div>
              {/* Tipo de contrato */}
              <div className="bg-gray-50 border border-gray-200 rounded-xl p-4">
                <p className="text-xs font-semibold text-gray-700 uppercase tracking-wide mb-3">Tipo de Contrato</p>
                <div className="grid grid-cols-2 gap-3">
                  <label className={`flex items-start gap-3 p-3 bg-white border rounded-lg cursor-pointer transition-colors ${(form.tipoContrato ?? "RECORRENTE") === "RECORRENTE" ? "border-brand-400 ring-1 ring-brand-400" : "border-gray-200 hover:border-gray-300"}`}>
                    <input type="radio" name="tipoContrato" value="RECORRENTE"
                      checked={(form.tipoContrato ?? "RECORRENTE") === "RECORRENTE"}
                      onChange={() => setForm((f: any) => ({ ...f, tipoContrato: "RECORRENTE", totalParcelasStr: "" }))}
                      className="mt-0.5" />
                    <div>
                      <p className="text-sm font-medium text-gray-800">🔄 Recorrente sem prazo</p>
                      <p className="text-xs text-gray-500">Faturamento mensal contínuo</p>
                    </div>
                  </label>
                  <label className={`flex items-start gap-3 p-3 bg-white border rounded-lg cursor-pointer transition-colors ${form.tipoContrato === "PARCELADO" ? "border-indigo-400 ring-1 ring-indigo-400" : "border-gray-200 hover:border-gray-300"}`}>
                    <input type="radio" name="tipoContrato" value="PARCELADO"
                      checked={form.tipoContrato === "PARCELADO"}
                      onChange={() => setForm((f: any) => ({ ...f, tipoContrato: "PARCELADO" }))}
                      className="mt-0.5" />
                    <div>
                      <p className="text-sm font-medium text-gray-800">📆 Parcelado / Prazo fixo</p>
                      <p className="text-xs text-gray-500">Encerra após N faturamentos</p>
                    </div>
                  </label>
                </div>
                {form.tipoContrato === "PARCELADO" && (
                  <div className="mt-3">
                    <label className="block text-xs font-medium text-gray-700 mb-1">Número de parcelas *</label>
                    <input
                      type="number" min="1" max="360"
                      value={form.totalParcelasStr ?? ""}
                      onChange={e => setForm((f: any) => ({ ...f, totalParcelasStr: e.target.value }))}
                      placeholder="Ex: 12"
                      className="w-full border rounded-lg px-3 py-2 text-sm"
                    />
                    <p className="text-xs text-gray-400 mt-1">O contrato será suspenso automaticamente após este número de faturamentos.</p>
                  </div>
                )}
              </div>

              {/* Automação */}
              <div className="col-span-2 bg-gray-50 border border-gray-200 rounded-xl p-4">
                <p className="text-xs font-semibold text-gray-700 uppercase tracking-wide mb-3">Automação Mensal</p>
                <div className="grid grid-cols-2 gap-3">
                  <label className="flex items-start gap-3 p-3 bg-white border border-gray-200 rounded-lg cursor-pointer hover:border-brand-400 transition-colors">
                    <input type="checkbox" checked={form.emitirNfseAuto ?? true}
                      onChange={e => setForm((f: any) => ({ ...f, emitirNfseAuto: e.target.checked }))}
                      className="mt-0.5" />
                    <div>
                      <p className="text-sm font-medium text-gray-800">Emitir NFS-e</p>
                      <p className="text-xs text-gray-500">Emissão automática no dia do vencimento</p>
                    </div>
                  </label>
                  <label className="flex items-start gap-3 p-3 bg-white border border-gray-200 rounded-lg cursor-pointer hover:border-brand-400 transition-colors">
                    <input type="checkbox" checked={form.gerarCobrancaAuto ?? true}
                      onChange={e => setForm((f: any) => ({ ...f, gerarCobrancaAuto: e.target.checked }))}
                      className="mt-0.5" />
                    <div>
                      <p className="text-sm font-medium text-gray-800">Gerar Cobrança</p>
                      <p className="text-xs text-gray-500">PIX e boleto ao emitir a NFS-e</p>
                    </div>
                  </label>
                </div>
                {(form.gerarCobrancaAuto ?? true) && (
                  <div className="mt-3">
                    <label className="block text-xs font-medium text-gray-700 mb-1">Método de Cobrança</label>
                    <select value={form.metodoCobr ?? "PIX_BOLETO"}
                      onChange={e => setForm((f: any) => ({ ...f, metodoCobr: e.target.value }))}
                      className="w-full border rounded-lg px-3 py-2 text-sm bg-white">
                      <option value="PIX_BOLETO">PIX + Boleto</option>
                      <option value="PIX">Apenas PIX</option>
                      <option value="BOLETO">Apenas Boleto</option>
                    </select>
                  </div>
                )}
              </div>
              <div>
                <p className="text-xs font-medium text-gray-700 mb-2">Retenções</p>
                <div className="grid grid-cols-2 gap-2">
                  <label className="flex items-center gap-2 text-sm text-gray-700">
                    <input type="checkbox" checked={form.issRetido ?? false}
                      onChange={e => setForm((f: any) => ({ ...f, issRetido: e.target.checked }))} />
                    ISS Retido
                  </label>
                  <label className="flex items-center gap-2 text-sm text-gray-700">
                    <input type="checkbox" checked={form.retirIr ?? false}
                      onChange={e => setForm((f: any) => ({ ...f, retirIr: e.target.checked }))} />
                    IR (1,5%)
                  </label>
                  <label className="flex items-center gap-2 text-sm text-gray-700">
                    <input type="checkbox" checked={form.retirCsll ?? false}
                      onChange={e => setForm((f: any) => ({ ...f, retirCsll: e.target.checked }))} />
                    CSLL (1,0%)
                  </label>
                  <label className="flex items-center gap-2 text-sm text-gray-700">
                    <input type="checkbox" checked={form.retirPis ?? false}
                      onChange={e => setForm((f: any) => ({ ...f, retirPis: e.target.checked }))} />
                    PIS (0,65%)
                  </label>
                  <label className="flex items-center gap-2 text-sm text-gray-700">
                    <input type="checkbox" checked={form.retirCofins ?? false}
                      onChange={e => setForm((f: any) => ({ ...f, retirCofins: e.target.checked }))} />
                    COFINS (3,0%)
                  </label>
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  Observação
                  <span className="ml-2 text-gray-400 font-normal text-xs">Suporta {'{{mes_referencia}}'} {'{{vencimento}}'} etc.</span>
                </label>
                <textarea value={form.observacoes ?? ""} onChange={e => setForm((f: any) => ({ ...f, observacoes: e.target.value }))}
                  rows={2} className="w-full border rounded-lg px-3 py-2 text-sm" />
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-5">
              <button onClick={() => setForm(null)} className="text-sm text-gray-600 px-4 py-2">Cancelar</button>
              <button onClick={salvar} disabled={criar.isPending || atualizar.isPending}
                className="bg-brand-600 hover:bg-brand-700 text-white text-sm px-4 py-2 rounded-lg disabled:opacity-50">
                {criar.isPending || atualizar.isPending ? "Salvando..." : "Salvar"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
