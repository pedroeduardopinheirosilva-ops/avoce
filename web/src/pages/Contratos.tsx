import { useState, useRef } from "react";
import { trpc } from "../lib/trpc";

function competenciaAtual() {
  const d = new Date();
  return `${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
}

function ultimoDiaMes(ano: number, mes: number) {
  return new Date(ano, mes + 1, 0).getDate();
}

function vencimentoPadrao(diaVencimento: number) {
  const hoje = new Date();
  const ano  = hoje.getFullYear();
  const mes  = hoje.getMonth();
  const dia  = Math.min(diaVencimento, ultimoDiaMes(ano, mes));
  const d    = new Date(ano, mes, dia);
  if (d < hoje) {
    const proximo = mes + 1 > 11 ? 0 : mes + 1;
    const anoProx = mes + 1 > 11 ? ano + 1 : ano;
    d.setFullYear(anoProx, proximo, Math.min(diaVencimento, ultimoDiaMes(anoProx, proximo)));
  }
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

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkMetodo, setBulkMetodo] = useState<string>("BOLETO");

  const [cobForm, setCobForm] = useState<{ contratoId: string; diaVencimento: number; metodo: "PIX" | "BOLETO" | "AMBOS" } | null>(null);
  const [cobVencimento, setCobVencimento] = useState("");
  const [cobEnviarEmail, setCobEnviarEmail] = useState(true);
  const cobMetodoRef = useRef<"PIX" | "BOLETO" | "AMBOS">("AMBOS");

  const criar        = trpc.contrato.criar.useMutation({ onSuccess: () => { utils.contrato.listar.invalidate(); setForm(null); }, onError: (e) => alert(`Erro ao criar contrato: ${e.message}`) });
  const atualizar    = trpc.contrato.atualizar.useMutation({ onSuccess: () => { utils.contrato.listar.invalidate(); setForm(null); }, onError: (e) => alert(`Erro ao salvar contrato: ${e.message}`) });
  const toggleTipo   = trpc.contrato.atualizar.useMutation({ onSuccess: () => utils.contrato.listar.invalidate() });
  const excluir  = trpc.contrato.excluir.useMutation({ onSuccess: () => utils.contrato.listar.invalidate() });
  const reativar = trpc.contrato.reativar.useMutation({ onSuccess: () => utils.contrato.listar.invalidate() });
  const deletar  = trpc.contrato.deletar.useMutation({ onSuccess: () => utils.contrato.listar.invalidate(), onError: (e) => alert(e.message) });
  const atualizarEmMassa = trpc.contrato.atualizarMetodoEmMassa.useMutation({
    onSuccess: (res) => {
      utils.contrato.listar.invalidate();
      setSelectedIds(new Set());
      alert(`${res.count} contrato(s) atualizado(s).`);
    },
    onError: (e) => alert(`Erro: ${e.message}`),
  });
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
    if (!form.emitenteId) return alert("Selecione a empresa emitente.");
    if (!form.tomadorId)  return alert("Selecione o tomador.");
    if (!form.descricaoServico || form.descricaoServico.trim().length < 5) return alert("Discriminação dos serviços é obrigatória (mín. 5 caracteres).");
    const valorNum = parseFloat(form.valorStr ?? "0");
    if (!valorNum || valorNum <= 0) return alert("Informe um valor válido.");
    const tipoContrato  = form.tipoContrato ?? "RECORRENTE";
    const totalParcelas = tipoContrato === "PARCELADO" ? (parseInt(form.totalParcelasStr ?? "0") || null) : null;

    // Converte parcelas da UI para centavos
    const parcelasUI: any[] = form.parcelas ?? [];
    const parcelasValidas = parcelasUI.filter((p: any) => p.valorStr && p.dataVencimento);
    if (tipoContrato === "PARCELADO" && parcelasValidas.length > 0) {
      const invalida = parcelasValidas.find((p: any) => !/^\d{4}-\d{2}-\d{2}$/.test(p.dataVencimento));
      if (invalida) return alert(`Parcela ${invalida.numero}: data inválida.`);
    }
    const parcelas = tipoContrato === "PARCELADO" && parcelasValidas.length > 0
      ? parcelasValidas.map((p: any) => ({
          numero:         p.numero,
          valor:          Math.round(parseFloat(p.valorStr) * 100),
          dataVencimento: p.dataVencimento,
          processada:     p.processada ?? false,
        }))
      : undefined;

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
      nfseAoFaturar:     form.nfseAoFaturar !== false,
      tipoContrato,
      totalParcelas,
      observacoes:       form.observacoes || null,
      emailsCobranca:    form.emailsCobranca ?? [],
      parcelas,
    };
    if (form.id) atualizar.mutate({ id: form.id, ...data });
    else criar.mutate(data);
  }

  if (isLoading) return <div className="p-8 text-gray-500">Carregando...</div>;

  return (
    <div className="p-4 md:p-8">
      <div className="flex items-center justify-between mb-6 gap-3">
        <h1 className="text-2xl font-bold text-gray-900">Contratos</h1>
        <button onClick={() => setForm({ diaVencimento: 5, issRetido: false, emitirNfseAuto: false, gerarCobrancaAuto: true, metodoCobr: "PIX_BOLETO" })} className="bg-brand-600 hover:bg-brand-700 text-white px-4 py-2 rounded-lg text-sm font-medium flex-shrink-0">
          + Novo Contrato
        </button>
      </div>

      {/* Filtro por empresa */}
      {empresas && empresas.length > 1 && (
        <div className="mb-4">
          <select
            value={filterEmitenteId}
            onChange={e => setFilterEmitenteId(e.target.value)}
            className="border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white text-gray-700 w-full sm:w-auto sm:min-w-[220px]"
          >
            <option value="">Todas as empresas</option>
            {empresas.map(e => (
              <option key={e.id} value={e.id}>{e.nomeFantasia || e.nome}</option>
            ))}
          </select>
        </div>
      )}

      {/* Barra de ações em massa */}
      {selectedIds.size > 0 && (
        <div className="mb-4 flex items-center gap-3 bg-brand-50 border border-brand-200 rounded-xl px-4 py-3">
          <span className="text-sm font-medium text-brand-700">{selectedIds.size} selecionado(s)</span>
          <span className="text-gray-400">·</span>
          <span className="text-xs text-gray-600">Mudar método para:</span>
          <select
            value={bulkMetodo}
            onChange={e => setBulkMetodo(e.target.value)}
            className="border border-gray-200 rounded-lg px-2 py-1 text-sm bg-white"
          >
            <option value="BOLETO">Apenas Boleto</option>
            <option value="PIX">Apenas PIX</option>
            <option value="PIX_BOLETO">PIX + Boleto</option>
            <option value="NENHUM">Sem cobrança</option>
          </select>
          <button
            onClick={() => {
              if (confirm(`Alterar método de cobrança de ${selectedIds.size} contrato(s)?`))
                atualizarEmMassa.mutate({ ids: Array.from(selectedIds), metodoCobr: bulkMetodo as any });
            }}
            disabled={atualizarEmMassa.isPending}
            className="bg-brand-600 hover:bg-brand-700 text-white text-sm px-3 py-1.5 rounded-lg disabled:opacity-50"
          >
            {atualizarEmMassa.isPending ? "Salvando..." : "Aplicar"}
          </button>
          <button onClick={() => setSelectedIds(new Set())} className="text-sm text-gray-500 hover:text-gray-700 ml-auto">Desmarcar todos</button>
        </div>
      )}

      <div className="space-y-3">
        {/* Cabeçalho selecionar todos */}
        {contratos && contratos.length > 0 && (
          <div className="flex items-center gap-2 px-1 mb-1">
            <input
              type="checkbox"
              className="w-4 h-4 rounded accent-brand-600"
              checked={contratos.length > 0 && selectedIds.size === contratos.length}
              onChange={e => {
                if (e.target.checked) setSelectedIds(new Set(contratos.map(c => c.id)));
                else setSelectedIds(new Set());
              }}
            />
            <span className="text-xs text-gray-500">Selecionar todos ({contratos.length})</span>
          </div>
        )}
        {contratos?.map((c) => {
          const metodoCobr = (c as any).metodoCobr ?? "PIX_BOLETO";
          const isSelected = selectedIds.has(c.id);
          return (
          <div key={c.id} className={`bg-white border rounded-xl p-4 md:p-5 flex flex-col sm:flex-row sm:items-start gap-3 ${!c.ativo ? "opacity-50" : isSelected ? "border-brand-400 ring-1 ring-brand-200" : "border-gray-200"}`}>
            <div className="flex items-start gap-3 flex-1 min-w-0">
              <input
                type="checkbox"
                className="w-4 h-4 rounded accent-brand-600 mt-1 flex-shrink-0"
                checked={isSelected}
                onChange={e => {
                  setSelectedIds(prev => {
                    const next = new Set(prev);
                    if (e.target.checked) next.add(c.id);
                    else next.delete(c.id);
                    return next;
                  });
                }}
              />
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
                {(c as any).tipoContrato === "PARCELADO" && (() => {
                  const ps: any[] = (c as any).parcelasPersonalizadas ?? [];
                  if (ps.length > 0) {
                    const feitas = ps.filter((p: any) => p.processada).length;
                    return (
                      <span className="ml-2 text-xs bg-indigo-100 text-indigo-700 px-2 py-0.5 rounded-full font-medium">
                        {feitas}/{ps.length} parcelas
                      </span>
                    );
                  }
                  if ((c as any).totalParcelas) return (
                    <span className="ml-2 text-xs bg-indigo-100 text-indigo-700 px-2 py-0.5 rounded-full font-medium">
                      {(c as any).totalParcelas}x parcelas
                    </span>
                  );
                  return null;
                })()}
              </p>
            </div>
            <div className="flex gap-2 flex-wrap sm:flex-shrink-0 sm:ml-0">
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
              <button onClick={() => setForm({
                  ...c,
                  valorStr: (c.valor / 100).toFixed(2),
                  totalParcelasStr: (c as any).totalParcelas ? String((c as any).totalParcelas) : "",
                  parcelas: ((c as any).parcelasPersonalizadas ?? []).map((p: any) => ({
                    numero: p.numero, valorStr: (p.valor / 100).toFixed(2), dataVencimento: p.dataVencimento, processada: p.processada,
                  })),
                })}
                className="text-xs bg-blue-50 hover:bg-blue-100 text-blue-700 px-3 py-1.5 rounded-lg">Editar</button>
              {c.ativo ? (
                <button onClick={() => { if (confirm("Suspender contrato? O contrato ficará inativo e não gerará mais NFS-e automática.")) excluir.mutate({ id: c.id }); }}
                  className="text-xs bg-orange-50 hover:bg-orange-100 text-orange-700 px-3 py-1.5 rounded-lg">Suspender</button>
              ) : (
                <button onClick={() => { if (confirm("Reativar contrato?")) reativar.mutate({ id: c.id }); }}
                  disabled={reativar.isPending}
                  className="text-xs bg-green-50 hover:bg-green-100 text-green-700 px-3 py-1.5 rounded-lg disabled:opacity-50">Reativar</button>
              )}
              <button
                onClick={() => { if (confirm("Excluir contrato permanentemente? Esta ação não pode ser desfeita.")) deletar.mutate({ id: c.id }); }}
                disabled={deletar.isPending}
                className="text-xs bg-red-50 hover:bg-red-100 text-red-700 px-3 py-1.5 rounded-lg disabled:opacity-50"
              >Excluir</button>
            </div>
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
                <select value={form.tomadorId ?? ""} onChange={e => setForm((f: any) => ({ ...f, tomadorId: e.target.value, emailsCobranca: [] }))}
                  className="w-full border rounded-lg px-3 py-2 text-sm">
                  <option value="">Selecione...</option>
                  {tomadores?.map(t => (
                    <option key={t.id} value={t.id}>{t.nome}</option>
                  ))}
                </select>
              </div>
              {/* E-mails de cobrança/NFS-e */}
              {(() => {
                const tom = tomadores?.find(t => t.id === form.tomadorId);
                if (!tom) return null;
                const opts = [
                  { label: "Principal",   email: tom.email },
                  { label: "Financeiro",  email: tom.emailFinanceiro },
                  { label: "Geral",       email: tom.emailGeral },
                  { label: "Diretoria",   email: tom.emailDiretoria },
                ].filter(o => o.email);
                if (!opts.length) return null;
                const sel: string[] = form.emailsCobranca ?? [];
                const toggle = (email: string) => {
                  const next = sel.includes(email)
                    ? sel.filter((e: string) => e !== email)
                    : sel.length < 4 ? [...sel, email] : sel;
                  setForm((f: any) => ({ ...f, emailsCobranca: next }));
                };
                return (
                  <div className="bg-blue-50 border border-blue-100 rounded-xl p-3">
                    <p className="text-xs font-semibold text-blue-700 mb-2">E-mails para Cobrança e NFS-e <span className="font-normal text-blue-400">(selecione até 4)</span></p>
                    <div className="space-y-1.5">
                      {opts.map(o => (
                        <label key={o.email} className="flex items-center gap-2.5 cursor-pointer group">
                          <input type="checkbox"
                            checked={sel.includes(o.email!)}
                            onChange={() => toggle(o.email!)}
                            disabled={!sel.includes(o.email!) && sel.length >= 4}
                            className="w-4 h-4 accent-blue-600 flex-shrink-0"
                          />
                          <span className="text-xs text-gray-700">
                            <span className="font-medium text-gray-500 mr-1">{o.label}:</span>{o.email}
                          </span>
                        </label>
                      ))}
                    </div>
                    {sel.length === 0 && (
                      <p className="text-xs text-amber-600 mt-2">⚠ Nenhum e-mail selecionado — cobrança e NFS-e serão enviadas para o e-mail principal do tomador.</p>
                    )}
                  </div>
                );
              })()}
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
                  <input type="number" min="1" max="30"
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
                  <div className="mt-3 space-y-3">
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">Número de parcelas</label>
                      <input
                        type="number" min="1" max="360"
                        value={form.totalParcelasStr ?? ""}
                        onChange={e => setForm((f: any) => ({ ...f, totalParcelasStr: e.target.value }))}
                        placeholder="Ex: 12"
                        className="w-full border rounded-lg px-3 py-2 text-sm"
                      />
                      <p className="text-xs text-gray-400 mt-1">O contrato será suspenso após este número de faturamentos. Deixe vazio se usar tabela abaixo.</p>
                    </div>

                    {/* Tabela de parcelas personalizadas */}
                    <div className="border border-indigo-200 rounded-lg overflow-hidden">
                      <div className="bg-indigo-50 px-3 py-2 flex items-center justify-between">
                        <p className="text-xs font-semibold text-indigo-700">Parcelas com valores e datas específicas</p>
                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              const n = parseInt(form.totalParcelasStr ?? "0");
                              if (!n || n <= 0) return alert("Informe o número de parcelas acima primeiro.");
                              const valorBase = form.valorStr ? parseFloat(form.valorStr) : 0;
                              const dia = parseInt(form.diaVencimento ?? "5");
                              const hoje = new Date();
                              const parcelas = Array.from({ length: n }, (_, i) => {
                                const d = new Date(hoje.getFullYear(), hoje.getMonth() + 1 + i, dia);
                                return {
                                  numero: i + 1,
                                  valorStr: valorBase.toFixed(2),
                                  dataVencimento: d.toISOString().slice(0, 10),
                                  processada: false,
                                };
                              });
                              setForm((f: any) => ({ ...f, parcelas }));
                            }}
                            className="text-xs bg-indigo-100 hover:bg-indigo-200 text-indigo-700 px-2 py-1 rounded"
                          >Gerar automático</button>
                          <button
                            type="button"
                            onClick={() => setForm((f: any) => {
                              const ps = f.parcelas ?? [];
                              return { ...f, parcelas: [...ps, { numero: ps.length + 1, valorStr: f.valorStr ?? "0", dataVencimento: "", processada: false }] };
                            })}
                            className="text-xs bg-white border border-indigo-300 hover:bg-indigo-50 text-indigo-700 px-2 py-1 rounded"
                          >+ Parcela</button>
                        </div>
                      </div>
                      {(form.parcelas ?? []).length === 0 ? (
                        <p className="text-xs text-gray-400 text-center py-4">Nenhuma parcela cadastrada. Use "Gerar automático" ou "+ Parcela".</p>
                      ) : (
                        <div className="overflow-x-auto">
                          <table className="w-full text-xs">
                            <thead className="bg-gray-50">
                              <tr>
                                <th className="px-3 py-2 text-left text-gray-500 font-medium w-10">#</th>
                                <th className="px-3 py-2 text-left text-gray-500 font-medium">Valor (R$)</th>
                                <th className="px-3 py-2 text-left text-gray-500 font-medium">Vencimento</th>
                                <th className="px-3 py-2 text-center text-gray-500 font-medium w-16">Paga</th>
                                <th className="px-3 py-2 w-8"></th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-100">
                              {(form.parcelas ?? []).map((p: any, idx: number) => (
                                <tr key={idx} className={p.processada ? "bg-green-50" : "bg-white"}>
                                  <td className="px-3 py-1.5 text-gray-500">{p.numero}</td>
                                  <td className="px-3 py-1.5">
                                    <input
                                      type="number" step="0.01" min="0.01"
                                      value={p.valorStr}
                                      disabled={p.processada}
                                      onChange={e => setForm((f: any) => {
                                        const ps = [...(f.parcelas ?? [])];
                                        ps[idx] = { ...ps[idx], valorStr: e.target.value };
                                        return { ...f, parcelas: ps };
                                      })}
                                      className="w-28 border rounded px-2 py-1 text-xs disabled:bg-gray-50 disabled:text-gray-400"
                                    />
                                  </td>
                                  <td className="px-3 py-1.5">
                                    <input
                                      type="date"
                                      value={p.dataVencimento}
                                      disabled={p.processada}
                                      onChange={e => setForm((f: any) => {
                                        const ps = [...(f.parcelas ?? [])];
                                        ps[idx] = { ...ps[idx], dataVencimento: e.target.value };
                                        return { ...f, parcelas: ps };
                                      })}
                                      className="border rounded px-2 py-1 text-xs disabled:bg-gray-50 disabled:text-gray-400"
                                    />
                                  </td>
                                  <td className="px-3 py-1.5 text-center">
                                    {p.processada
                                      ? <span className="text-green-600 font-medium">✓</span>
                                      : <span className="text-gray-300">—</span>}
                                  </td>
                                  <td className="px-3 py-1.5">
                                    {!p.processada && (
                                      <button
                                        type="button"
                                        onClick={() => setForm((f: any) => {
                                          const ps = (f.parcelas ?? []).filter((_: any, i: number) => i !== idx)
                                            .map((pp: any, i: number) => ({ ...pp, numero: i + 1 }));
                                          return { ...f, parcelas: ps };
                                        })}
                                        className="text-red-400 hover:text-red-600"
                                      >✕</button>
                                    )}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                            <tfoot className="bg-gray-50">
                              <tr>
                                <td colSpan={2} className="px-3 py-1.5 text-xs text-gray-500 font-medium">
                                  Total: {(form.parcelas ?? []).reduce((s: number, p: any) => s + (parseFloat(p.valorStr) || 0), 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}
                                </td>
                                <td colSpan={3} className="px-3 py-1.5 text-xs text-gray-400 text-right">
                                  {(form.parcelas ?? []).filter((p: any) => p.processada).length}/{(form.parcelas ?? []).length} processadas
                                </td>
                              </tr>
                            </tfoot>
                          </table>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* Automação */}
              <div className="col-span-2 bg-gray-50 border border-gray-200 rounded-xl p-4">
                <p className="text-xs font-semibold text-gray-700 uppercase tracking-wide mb-3">Automação Mensal</p>
                <div className="grid grid-cols-2 gap-3">
                  <label className="flex items-start gap-3 p-3 bg-white border border-gray-200 rounded-lg cursor-pointer hover:border-brand-400 transition-colors">
                    <input type="checkbox" checked={form.emitirNfseAuto ?? false}
                      onChange={e => setForm((f: any) => ({ ...f, emitirNfseAuto: e.target.checked }))}
                      className="mt-0.5" />
                    <div>
                      <p className="text-sm font-medium text-gray-800">Faturamento automático (cron)</p>
                      <p className="text-xs text-gray-500">Participa da emissão automática diária (dia configurado em Faturamento)</p>
                    </div>
                  </label>
                  <label className="flex items-start gap-3 p-3 bg-white border border-gray-200 rounded-lg cursor-pointer hover:border-brand-400 transition-colors">
                    <input type="checkbox" checked={form.gerarCobrancaAuto ?? true}
                      onChange={e => setForm((f: any) => ({ ...f, gerarCobrancaAuto: e.target.checked }))}
                      className="mt-0.5" />
                    <div>
                      <p className="text-sm font-medium text-gray-800">Gerar Cobrança</p>
                      <p className="text-xs text-gray-500">PIX e/ou boleto ao faturar</p>
                    </div>
                  </label>
                  <label className="flex items-start gap-3 p-3 bg-white border border-gray-200 rounded-lg cursor-pointer hover:border-brand-400 transition-colors col-span-2">
                    <input type="checkbox" checked={form.nfseAoFaturar !== false}
                      onChange={e => setForm((f: any) => ({ ...f, nfseAoFaturar: e.target.checked }))}
                      className="mt-0.5" />
                    <div>
                      <p className="text-sm font-medium text-gray-800">Emitir NFS-e ao faturar</p>
                      <p className="text-xs text-gray-500">Desmarcado = gera apenas cobrança; NFS-e emitida manualmente após pagamento</p>
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
