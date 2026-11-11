import { useState, useRef, useEffect } from "react";
import { Link } from "react-router-dom";
import { trpc } from "../lib/trpc";
import RichEditor from "../components/RichEditor";
import OnlyOfficeEditor from "../components/OnlyOfficeEditor";
import type { RichEditorHandle } from "../components/RichEditor";

const VARIAVEIS_PROPOSTA = [
  { v: "{{emitente}}",         desc: "Nome do escritório" },
  { v: "{{cnpj}}",             desc: "CNPJ do escritório" },
  { v: "{{cidade}}",           desc: "Cidade do escritório" },
  { v: "{{endereco}}",         desc: "Endereço do escritório" },
  { v: "{{tomador}}",          desc: "Nome do cliente" },
  { v: "{{cpfCnpj}}",          desc: "CPF/CNPJ do cliente" },
  { v: "{{valor}}",            desc: "Valor fixo em R$" },
  { v: "{{honorariosExito}}",  desc: "Honorários de êxito (% sobre condenação)" },
  { v: "{{diaVencimento}}",    desc: "Dia de vencimento" },
  { v: "{{metodoPagamento}}", desc: "Método de pagamento" },
  { v: "{{dataAtual}}",        desc: "Data atual" },
  { v: "{{validadeAte}}",      desc: "Validade da proposta" },
  { v: "{{servico}}",          desc: "Descrição do serviço" },
];

// A declaração de hipossuficiência é cadastrada como tipo OUTRO — sem olhar o
// título, ela apareceria no menu como um "Doc" qualquer no meio da revisão.
const TIPO_DOC_LABEL = (tipo: string, titulo = "") =>
  tipo === "CONTRATO"   ? "Contrato" :
  tipo === "PROCURACAO" ? "Procuração" :
  /declara/i.test(titulo) ? "Declaração" : "Doc";

const TIPO_DOC_COR = (tipo: string) =>
  tipo === "CONTRATO"   ? "bg-blue-100 text-blue-700" :
  tipo === "PROCURACAO" ? "bg-purple-100 text-purple-700" :
  "bg-gray-100 text-gray-700";

// Componente que carrega e exibe os documentos gerados de uma proposta
function DocsBotoes({ propostaId, onGerar, onEdit }: {
  propostaId: string;
  onGerar: () => void;
  onEdit: (doc: any) => void;
}) {
  const { data: docs } = trpc.templateDocumento.listarDocumentosProposta.useQuery({ propostaId });

  async function baixar(docId: string, titulo: string, tipo: string, formato: "pdf" | "docx" = "pdf") {
    const token = localStorage.getItem("avoce_token");
    const res = await fetch(`/api/documento-gerado/${docId}/${formato}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) { alert(`${formato.toUpperCase()} não disponível`); return; }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${tipo}-${titulo.replace(/[^a-zA-Z0-9]/g, "-")}.${formato}`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (!docs) {
    return <p className="px-3 py-2 text-xs text-gray-400">Carregando...</p>;
  }

  if (docs.length === 0) {
    return (
      <button
        onClick={() => onGerar()}
        className="w-full text-left flex items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
      >
        📋 Gerar documentos
      </button>
    );
  }

  const tipoLabel = TIPO_DOC_LABEL;
  const tipoCor   = TIPO_DOC_COR;

  return (
    <>
      {(docs as any[]).map((doc: any) => (
        <div key={doc.id} className={`flex items-center gap-2 px-3 py-2 hover:bg-gray-50 ${doc.semDadosDoCliente ? "bg-amber-50" : ""}`}>
          <span className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] font-semibold ${tipoCor(doc.tipo)}`}>
            {tipoLabel(doc.tipo, doc.titulo)}
          </span>
          {doc.semDadosDoCliente && (
            <span
              className="shrink-0 text-amber-600 cursor-help"
              title="Este documento não menciona o cliente da proposta — provavelmente o template tem texto de outro cliente. Confira antes de enviar."
            >
              ⚠️
            </span>
          )}
          <span className="flex-1 text-xs text-gray-600 truncate min-w-0" title={doc.titulo}>
            {doc.titulo}
          </span>
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={() => baixar(doc.id, doc.titulo, doc.tipo, "pdf")}
              className="px-1.5 py-0.5 rounded text-[10px] font-medium text-gray-600 hover:bg-gray-200"
              title="Baixar PDF"
            >
              PDF
            </button>
            {doc.docxPath && (
              <button
                onClick={() => baixar(doc.id, doc.titulo, doc.tipo, "docx")}
                className="px-1.5 py-0.5 rounded text-[10px] font-medium text-gray-600 hover:bg-gray-200"
                title="Baixar DOCX"
              >
                DOCX
              </button>
            )}
            <button
              onClick={() => { if (doc.htmlEditado) onEdit(doc); }}
              disabled={!doc.htmlEditado}
              title={doc.htmlEditado ? "Editar texto" : "Regenere para habilitar edição"}
              className={`px-1 py-0.5 rounded text-xs ${
                doc.htmlEditado ? "text-gray-500 hover:bg-gray-200" : "text-gray-300 cursor-not-allowed"
              }`}
            >
              ✏️
            </button>
          </div>
        </div>
      ))}
      <button
        onClick={() => { if (confirm("Regenerar todos os documentos desta proposta?")) onGerar(); }}
        className="w-full text-left flex items-center gap-2 px-3 py-1.5 text-xs text-gray-500 hover:bg-gray-50"
        title="Apaga e recria todos os documentos"
      >
        🔄 Regenerar documentos
      </button>
    </>
  );
}

// Painel de revisão: os documentos que a IA gerou (contrato, procuração,
// declaração) antes de qualquer coisa sair para o cliente. O PDF é buscado com
// o token e exibido por blob — o endpoint exige Authorization, então <iframe
// src="/api/..."> mostraria só um 401.
function RevisaoDocs({ propostaId, onEdit, onAbrirOO, onRegerar, regerando }: {
  propostaId: string;
  onEdit: (doc: any) => void;
  onAbrirOO: (doc: any) => void;
  onRegerar: () => void;
  regerando: boolean;
}) {
  const { data: docs, isLoading } = trpc.templateDocumento.listarDocumentosProposta.useQuery({ propostaId });
  const [selId, setSelId] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [erroPreview, setErroPreview] = useState<string | null>(null);

  const selecionado = (docs as any[] | undefined)?.find(d => d.id === selId) ?? (docs as any[] | undefined)?.[0] ?? null;

  useEffect(() => {
    if (!selecionado) return;
    let revogar: string | null = null;
    let cancelado = false;
    setErroPreview(null);
    (async () => {
      const token = localStorage.getItem("avoce_token");
      const res = await fetch(`/api/documento-gerado/${selecionado.id}/pdf`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) { if (!cancelado) setErroPreview("PDF não disponível — regenere os documentos."); return; }
      const url = URL.createObjectURL(await res.blob());
      if (cancelado) { URL.revokeObjectURL(url); return; }
      revogar = url;
      setPreviewUrl(url);
    })().catch(() => { if (!cancelado) setErroPreview("Falha ao carregar o PDF."); });
    return () => { cancelado = true; if (revogar) URL.revokeObjectURL(revogar); };
    // htmlEditado entra nas dependências porque `criadoEm` e `id` não mudam quando
    // alguém corrige o texto: sem ele, o preview continuaria mostrando o PDF antigo.
  }, [selecionado?.id, selecionado?.htmlEditado, selecionado?.atualizadoEm]);

  async function baixar(doc: any, formato: "pdf" | "docx") {
    const token = localStorage.getItem("avoce_token");
    const res = await fetch(`/api/documento-gerado/${doc.id}/${formato}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) { alert(`${formato.toUpperCase()} não disponível`); return; }
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement("a");
    a.href = url;
    a.download = `${doc.tipo}-${doc.titulo.replace(/[^a-zA-Z0-9]/g, "-")}.${formato}`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (isLoading) return <p className="text-sm text-gray-400 p-6">Carregando documentos...</p>;

  if (!docs || docs.length === 0) {
    return (
      <div className="p-6 text-center">
        <p className="text-sm text-gray-500 mb-3">Nenhum documento gerado para esta proposta.</p>
        <button onClick={onRegerar} disabled={regerando} className="btn-secondary">
          {regerando ? "Gerando..." : "📋 Gerar documentos"}
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col md:flex-row gap-4 p-4 min-h-0">
      {/* Lista */}
      <div className="md:w-64 flex-shrink-0 space-y-2">
        {(docs as any[]).map(doc => (
          <button
            key={doc.id}
            onClick={() => setSelId(doc.id)}
            className={`w-full text-left border rounded-lg px-3 py-2 transition-colors ${
              selecionado?.id === doc.id ? "border-brand-400 bg-brand-50" : "border-gray-200 hover:bg-gray-50"
            }`}
          >
            <div className="flex items-center gap-2">
              <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${TIPO_DOC_COR(doc.tipo)}`}>
                {TIPO_DOC_LABEL(doc.tipo, doc.titulo)}
              </span>
              {doc.semDadosDoCliente && <span className="text-amber-600" title="Documento não menciona o cliente — confira o template">⚠️</span>}
            </div>
            <p className="text-xs text-gray-700 mt-1 leading-snug">{doc.titulo}</p>
          </button>
        ))}
        <button onClick={onRegerar} disabled={regerando}
          className="w-full text-xs text-gray-500 hover:text-gray-700 border border-dashed border-gray-300 rounded-lg px-3 py-2">
          {regerando ? "Regenerando..." : "🔄 Regenerar todos"}
        </button>
      </div>

      {/* Preview */}
      <div className="flex-1 min-w-0 flex flex-col">
        {selecionado && (
          <div className="flex items-center gap-2 mb-2 flex-wrap">
            <span className="text-sm font-medium text-gray-800 truncate flex-1 min-w-0">{selecionado.titulo}</span>
            <button onClick={() => baixar(selecionado, "pdf")} className="text-xs px-2 py-1 rounded border border-gray-200 hover:bg-gray-50">PDF</button>
            {selecionado.docxPath && (
              <button onClick={() => baixar(selecionado, "docx")} className="text-xs px-2 py-1 rounded border border-gray-200 hover:bg-gray-50">DOCX</button>
            )}
            <button
              onClick={() => selecionado.docxPath && onAbrirOO(selecionado)}
              disabled={!selecionado.docxPath}
              title={selecionado.docxPath
                ? "Abrir o DOCX timbrado no editor OnlyOffice"
                : "Sem DOCX — regenere os documentos para habilitar o editor"}
              className={`text-xs px-2 py-1 rounded border ${selecionado.docxPath ? "border-brand-400 bg-brand-50 text-brand-700 hover:bg-brand-100 font-medium" : "border-gray-200 text-gray-300 cursor-not-allowed"}`}
            >
              ✏️ Editar no OnlyOffice
            </button>
            {/* Editor de HTML antigo: só serve para documento sem DOCX (timbrado não-docx) */}
            {!selecionado.docxPath && selecionado.htmlEditado && (
              <button
                onClick={() => onEdit(selecionado)}
                title="Corrigir o texto e regerar o PDF"
                className="text-xs px-2 py-1 rounded border border-gray-300 text-gray-600 hover:bg-gray-50"
              >
                Editar texto
              </button>
            )}
          </div>
        )}
        {erroPreview
          ? <div className="flex-1 flex items-center justify-center text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg">{erroPreview}</div>
          : previewUrl
            ? <iframe src={previewUrl} title="Documento" className="flex-1 w-full min-h-[420px] border border-gray-200 rounded-lg bg-gray-50" />
            : <div className="flex-1 flex items-center justify-center text-sm text-gray-400 border border-gray-200 rounded-lg">Carregando PDF...</div>}
      </div>
    </div>
  );
}

function fmt(centavos: number) {
  return (centavos / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

const STATUS_LABEL: Record<string, { label: string; color: string }> = {
  RASCUNHO:      { label: "Rascunho",       color: "bg-gray-100 text-gray-700" },
  ENVIADA:       { label: "Enviada",         color: "bg-blue-100 text-blue-700" },
  EM_NEGOCIACAO: { label: "Em negociação",   color: "bg-yellow-100 text-yellow-700" },
  ACEITA:        { label: "Aceita",          color: "bg-green-100 text-green-700" },
  RECUSADA:      { label: "Recusada",        color: "bg-red-100 text-red-700" },
};

function StatusBadge({ status }: { status: string }) {
  const s = STATUS_LABEL[status] ?? { label: status, color: "bg-gray-100 text-gray-700" };
  return <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${s.color}`}>{s.label}</span>;
}

interface PropostaForm {
  id?: string;
  emitenteId: string;
  tomadorId:  string;
  titulo:     string;
  textoHtml:  string;
  valorStr:   string;
  validadeAte: string;
  paktSignUrl: string;
  // parâmetros do contrato
  contratoDiaVencimento:     string;
  contratoMetodoCobr:        string;
  contratoTipoContrato:      string;
  contratoTotalParcelas:     string;
  contratoEmitirNfseAuto:    boolean;
  contratoGerarCobrancaAuto: boolean;
  contratoIssRetido:         boolean;
  contratoDescricao:         string;
  // templates a gerar ao aceitar
  templatesGerar: string[];
  honorariosExitoPercStr: string;
}

function emptyForm(): PropostaForm {
  return {
    emitenteId: "", tomadorId: "", titulo: "", textoHtml: "<p></p>",
    valorStr: "", validadeAte: "", paktSignUrl: "",
    contratoDiaVencimento: "5", contratoMetodoCobr: "PIX_BOLETO",
    contratoTipoContrato: "RECORRENTE", contratoTotalParcelas: "",
    contratoEmitirNfseAuto: true, contratoGerarCobrancaAuto: true,
    contratoIssRetido: false, contratoDescricao: "",
    templatesGerar: [],
    honorariosExitoPercStr: "",
  };
}

export default function Propostas() {
  const utils = trpc.useUtils();

  const { data: empresas  } = trpc.empresa.listar.useQuery();
  const { data: tomadores } = trpc.tomador.listar.useQuery({});
  const [emitenteIdParaTemplates, setEmitenteIdParaTemplates] = useState("");
  const { data: templatesDoc } = trpc.templateDocumento.listar.useQuery(
    { emitenteId: emitenteIdParaTemplates || undefined },
    { enabled: !!emitenteIdParaTemplates },
  );
  // Templates de proposta: sempre carregados da página Templates, sem fallback hardcoded
  // Filtrados pela empresa emitente selecionada — evita aplicar modelo de outro escritório
  const { data: templatesProposta } = trpc.templateDocumento.listar.useQuery(
    { tipo: "PROPOSTA", emitenteId: emitenteIdParaTemplates || undefined },
  );

  const [page, setPage] = useState(1);
  const [filterStatus, setFilterStatus] = useState("");
  const [soRevisao, setSoRevisao] = useState(false);
  const [filterEmitenteId, setFilterEmitenteId] = useState("");
  const { data, isLoading } = trpc.proposta.listar.useQuery({
    status: filterStatus || undefined,
    emitenteId: filterEmitenteId || undefined,
    revisao: soRevisao ? "PENDENTE" as const : undefined,
    page,
    pageSize: 20,
  });
  const { data: qtdRevisao } = trpc.proposta.pendentesDeRevisao.useQuery();

  const criar       = trpc.proposta.criar.useMutation({
    onSuccess: () => { utils.proposta.listar.invalidate(); setForm(null); },
    onError:   (e) => {
      console.error("[criar proposta] erro completo:", e);
      // tenta extrair mensagem legível do erro Zod
      let msg = e.message;
      try {
        const issues = JSON.parse(e.message) as Array<{ path: string[]; message: string }>;
        if (Array.isArray(issues)) {
          msg = issues.map(i => `• ${i.path.join(".") || "campo"}: ${i.message}`).join("\n");
        }
      } catch { /* não é JSON */ }
      alert(`Erro ao criar proposta:\n${msg}`);
    },
  });
  const atualizar   = trpc.proposta.atualizar.useMutation({
    onSuccess: () => { utils.proposta.listar.invalidate(); setForm(null); },
    onError:   (e) => {
      console.error("[atualizar proposta] erro completo:", e);
      let msg = e.message;
      try {
        const issues = JSON.parse(e.message) as Array<{ path: string[]; message: string }>;
        if (Array.isArray(issues)) {
          msg = issues.map(i => `• ${i.path.join(".") || "campo"}: ${i.message}`).join("\n");
        }
      } catch { /* não é JSON */ }
      alert(`Erro ao salvar proposta:\n${msg}`);
    },
  });
  const excluir     = trpc.proposta.excluir.useMutation({ onSuccess: () => utils.proposta.listar.invalidate() });
  const enviarEmail = trpc.proposta.enviarEmail.useMutation({
    onSuccess: (r) => {
      alert(r.usandoPakt ? "E-mail enviado com link de assinatura PAKT!" : "E-mail enviado com link de aceite.");
      utils.proposta.listar.invalidate();
    },
    onError: (e) => alert(`Erro: ${e.message}`),
  });
  const enviarWA = trpc.proposta.enviarWhatsApp.useMutation({
    onSuccess: () => alert("Mensagem enviada via WhatsApp!"),
    onError:   (e) => alert(`Erro ao enviar WhatsApp: ${e.message}`),
  });
  const converter = trpc.proposta.converterEmContrato.useMutation({
    onSuccess: () => { alert("Proposta convertida em contrato!"); utils.proposta.listar.invalidate(); setConverterModal(null); },
    onError:   (e) => alert(`Erro: ${e.message}`),
  });
  const gerarDocumentos = trpc.templateDocumento.gerarDocumentos.useMutation({
    onSuccess: (docs) => {
      alert(`${docs.length} documento(s) gerado(s) com sucesso!`);
      utils.templateDocumento.listarDocumentosProposta.invalidate();
    },
    onError: (e) => alert(`Erro: ${e.message}`),
  });
  const liberar = trpc.proposta.liberarParaAssinatura.useMutation({
    onSuccess: (r) => {
      alert(r.enviado
        ? `Liberado! ${r.paktDocs} documento(s) enviados para assinatura pelo WhatsApp do cliente.`
        : `Documentos liberados e envelopes criados (${r.paktDocs}), mas nada foi enviado pelo WhatsApp — confira o telefone do cliente e reenvie pelo menu.`);
      utils.proposta.listar.invalidate();
      utils.proposta.pendentesDeRevisao.invalidate();
      setRevisaoModal(null);
    },
    onError: (e) => alert(`Erro ao liberar: ${e.message}`),
  });
  const atualizarDocGerado = trpc.templateDocumento.atualizarDocumentoGerado.useMutation({
    onSuccess: () => {
      utils.templateDocumento.listarDocumentosProposta.invalidate();
      setEditDocModal(null);
    },
    onError: (e) => alert(`Erro: ${e.message}`),
  });



  const editorRef = useRef<RichEditorHandle>(null);
  const editDocEditorRef = useRef<RichEditorHandle>(null);
  const [form, setForm]               = useState<PropostaForm | null>(null);
  const [converterModal, setConverterModal] = useState<any | null>(null);
  const [negociacaoModal, setNegociacaoModal] = useState<any | null>(null);
  const [negociacaoObs, setNegociacaoObs]     = useState("");
  const [activeTemplateId, setActiveTemplateId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [revisaoModal, setRevisaoModal] = useState<any | null>(null);
  const [ooDoc, setOoDoc] = useState<any | null>(null);
  const [editDocModal, setEditDocModal] = useState<any | null>(null);
  const [editDocHtml, setEditDocHtml]   = useState("");
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [menuPos, setMenuPos] = useState<{ top?: number; bottom?: number; right: number }>({ right: 0 });

  function abrirWhatsApp(p: any) {
    const nome    = p.tomador.nome.split(" ")[0];
    const rawFone = (p.tomador as any).telefone ?? "";
    const fone    = rawFone.replace(/\D/g, "");
    const phone   = fone ? (fone.startsWith("55") ? fone : `55${fone}`) : "";

    const link = (p as any).paktSignUrl
      ? (p as any).paktSignUrl
      : `${window.location.origin}/api/proposta/${p.tokenAceite}`;

    const hasDocs = !!(p as any).paktSignUrl;
    const msg = hasDocs
      ? `Olá, ${nome}! Segue o link para assinar o contrato e a procuração:\n\n${link}\n\nQualquer dúvida é só falar. 👍`
      : `Olá, ${nome}! Segue o link da sua proposta para aprovação:\n\n${link}\n\nQualquer dúvida é só falar. 👍`;

    const waUrl = `https://wa.me/${phone}?text=${encodeURIComponent(msg)}`;
    window.open(waUrl, "_blank");

    navigator.clipboard.writeText(waUrl).then(() => {
      setCopiedId(p.id);
      setTimeout(() => setCopiedId(null), 2000);
    }).catch(() => {});
  }

  function abrirNovo() {
    setForm(emptyForm());
    setEmitenteIdParaTemplates("");
  }

  function abrirEditar(p: any) {
    let templatesGerar: string[] = [];
    try { if (p.templatesGerar) templatesGerar = JSON.parse(p.templatesGerar); } catch {}
    setForm({
      id: p.id,
      emitenteId: p.emitenteId, tomadorId: p.tomadorId,
      titulo: p.titulo, textoHtml: p.textoHtml,
      valorStr: p.valorEstimado ? String(p.valorEstimado / 100) : "",
      validadeAte: p.validadeAte ? p.validadeAte.slice(0, 10) : "",
      paktSignUrl: p.paktSignUrl ?? "",
      contratoDiaVencimento:     String(p.contratoDiaVencimento ?? "5"),
      contratoMetodoCobr:        p.contratoMetodoCobr ?? "PIX_BOLETO",
      contratoTipoContrato:      p.contratoTipoContrato ?? "RECORRENTE",
      contratoTotalParcelas:     String(p.contratoTotalParcelas ?? ""),
      contratoEmitirNfseAuto:    p.contratoEmitirNfseAuto ?? true,
      contratoGerarCobrancaAuto: p.contratoGerarCobrancaAuto ?? true,
      contratoIssRetido:         p.contratoIssRetido ?? false,
      contratoDescricao:         p.contratoDescricao ?? "",
      templatesGerar,
      honorariosExitoPercStr:    p.honorariosExitoPerc ? String(p.honorariosExitoPerc) : "",
    });
    setEmitenteIdParaTemplates(p.emitenteId);
  }

  function aplicarTemplate(id: string) {
    const t = templatesProposta?.find((x: any) => x.id === id);
    if (!t || !form) return;
    const emitente = empresas?.find(e => e.id === form.emitenteId);
    const tomador  = tomadores?.find((t2: any) => t2.id === form.tomadorId);

    const metodosLabel: Record<string, string> = {
      PIX_BOLETO: "PIX ou Boleto", PIX: "PIX", BOLETO: "Boleto Bancário", NENHUM: "a combinar", ALVARA: "Alvará Judicial",
    };
    const localidade = [emitente?.cidade, emitente?.uf].filter(Boolean).join("/");
    const endEmitente = [
      emitente?.endereco && emitente?.numero ? `${emitente.endereco}, ${emitente.numero}` : emitente?.endereco,
      emitente?.complemento, emitente?.bairro, localidade,
      emitente?.cep ? `CEP ${emitente.cep.replace(/(\d{5})(\d{3})/, "$1-$2")}` : null,
    ].filter(Boolean).join(", ");
    const endTomador = [
      (tomador as any)?.endereco && (tomador as any)?.numero ? `${(tomador as any).endereco}, ${(tomador as any).numero}` : (tomador as any)?.endereco,
      (tomador as any)?.complemento, (tomador as any)?.bairro,
      [(tomador as any)?.cidade, (tomador as any)?.uf].filter(Boolean).join("/"),
      (tomador as any)?.cep ? `CEP ${(tomador as any).cep.replace(/(\d{5})(\d{3})/, "$1-$2")}` : null,
    ].filter(Boolean).join(", ");
    const fmtCnpj = (v: string) => {
      const d = v?.replace(/\D/g, "") ?? "";
      if (d.length === 14) return `${d.slice(0,2)}.${d.slice(2,5)}.${d.slice(5,8)}/${d.slice(8,12)}-${d.slice(12)}`;
      if (d.length === 11) return `${d.slice(0,3)}.${d.slice(3,6)}.${d.slice(6,9)}-${d.slice(9)}`;
      return v ?? "";
    };
    const valorNum = form.valorStr ? parseFloat(form.valorStr) : null;
    const valorFmt = valorNum ? valorNum.toLocaleString("pt-BR", { style: "currency", currency: "BRL" }) : "";

    const honorariosExitoNum = form.honorariosExitoPercStr ? parseFloat(form.honorariosExitoPercStr.replace(",", ".")) : null;
    const vars: Record<string, string> = {
      emitente:          emitente?.nomeFantasia ?? emitente?.nome ?? "",
      cnpj:              fmtCnpj(emitente?.cnpj ?? ""),
      tomador:           (tomador as any)?.nome ?? "",
      cpfCnpj:           fmtCnpj((tomador as any)?.cpfCnpj ?? ""),
      enderecoTomador:   endTomador,
      emailTomador:      (tomador as any)?.email ?? "",
      telefoneTomador:   (tomador as any)?.telefone ?? "",
      valor:             valorFmt,
      honorariosExito:   honorariosExitoNum ? `${honorariosExitoNum.toLocaleString("pt-BR", { maximumFractionDigits: 2 })}%` : "",
      diaVencimento:     form.contratoDiaVencimento || "",
      metodoPagamento:   metodosLabel[form.contratoMetodoCobr] ?? "",
      dataAtual:         new Date().toLocaleDateString("pt-BR"),
      cidade:            localidade,
      endereco:          endEmitente,
      servico:           form.contratoDescricao || "",
      validadeAte:       form.validadeAte ? form.validadeAte.split("-").reverse().join("/") : "",
    };

    const html = Object.entries(vars).reduce(
      (acc, [k, v]) => acc.replace(new RegExp(`\\{\\{${k}\\}\\}`, "gi"), v),
      (t as any).html ?? (t as any).textoHtml ?? "",
    );
    setForm({ ...form, titulo: t.titulo, textoHtml: html });
    setActiveTemplateId(id);
  }

  function salvar() {
    if (!form) return;
    if (!form.emitenteId) { alert("Selecione a empresa emitente."); return; }
    if (!form.tomadorId)  { alert("Selecione o tomador / cliente."); return; }
    if (form.titulo.trim().length < 3) { alert("O título deve ter pelo menos 3 caracteres."); return; }
    const htmlSemTags = form.textoHtml.replace(/<[^>]+>/g, "").trim();
    if (htmlSemTags.length < 5) { alert("O texto da proposta está vazio. Escreva o conteúdo ou aplique um template."); return; }
    const valorEstimado = form.valorStr ? Math.round(parseFloat(form.valorStr) * 100) : null;
    const diaVenc = parseInt(form.contratoDiaVencimento) || null;
    const honorariosExitoPerc = form.honorariosExitoPercStr ? parseFloat(form.honorariosExitoPercStr.replace(",", ".")) : null;
    console.log("[salvar proposta] data:", { emitenteId: form.emitenteId, tomadorId: form.tomadorId, titulo: form.titulo, textoHtmlLen: form.textoHtml?.length, paktSignUrl: form.paktSignUrl });
    const data = {
      emitenteId: form.emitenteId, tomadorId: form.tomadorId,
      titulo: form.titulo, textoHtml: form.textoHtml,
      valorEstimado: valorEstimado || null,
      validadeAte: form.validadeAte ? `${form.validadeAte}T12:00:00` : null,
      paktSignUrl: form.paktSignUrl || null,
      contratoDiaVencimento:     diaVenc,
      contratoMetodoCobr:        form.contratoMetodoCobr as any,
      contratoTipoContrato:      form.contratoTipoContrato as any,
      contratoTotalParcelas:     form.contratoTipoContrato === "PARCELADO" ? (parseInt(form.contratoTotalParcelas) || null) : null,
      contratoEmitirNfseAuto:    form.contratoEmitirNfseAuto,
      contratoGerarCobrancaAuto: form.contratoGerarCobrancaAuto,
      contratoIssRetido:         form.contratoIssRetido,
      contratoDescricao:         form.contratoDescricao || null,
      templatesGerar:            form.templatesGerar.length > 0 ? form.templatesGerar : null,
      honorariosExitoPerc:       honorariosExitoPerc,
    };
    if (form.id) {
      atualizar.mutate({ id: form.id, ...data });
    } else {
      criar.mutate(data);
    }
  }

  useEffect(() => {
    if (!openMenuId) return;
    const close = () => setOpenMenuId(null);
    window.addEventListener("scroll", close, { passive: true });
    return () => window.removeEventListener("scroll", close);
  }, [openMenuId]);

  function handleMenuToggle(e: React.MouseEvent<HTMLButtonElement>, id: string) {
    e.stopPropagation();
    if (openMenuId === id) { setOpenMenuId(null); return; }
    const rect = e.currentTarget.getBoundingClientRect();
    const right = window.innerWidth - rect.right;
    const spaceBelow = window.innerHeight - rect.bottom;
    if (spaceBelow < 300) {
      setMenuPos({ bottom: window.innerHeight - rect.top + 4, right });
    } else {
      setMenuPos({ top: rect.bottom + 4, right });
    }
    setOpenMenuId(id);
  }

  function abrirNegociacao(p: any) {
    setNegociacaoModal(p);
    setNegociacaoObs("");
  }

  function salvarNegociacao() {
    if (!negociacaoModal) return;
    atualizar.mutate({
      id:     negociacaoModal.id,
      status: "EM_NEGOCIACAO" as any,
      ...(negociacaoObs ? { contratoDescricao: negociacaoObs } : {}),
    }, {
      onSuccess: () => {
        utils.proposta.listar.invalidate();
        setNegociacaoModal(null);
        // Abrir edição para ajustar valores/texto
        abrirEditar({ ...negociacaoModal, status: "EM_NEGOCIACAO", contratoDescricao: negociacaoObs });
      },
    });
  }

  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Propostas</h1>
          <p className="text-sm text-gray-500 mt-0.5">Gerencie propostas de serviços e contratos</p>
        </div>
        <button onClick={abrirNovo} className="btn-primary">+ Nova Proposta</button>
      </div>

      {/* Filtros */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-4 mb-4 space-y-3">
        <div className="flex gap-2 flex-wrap">
          {["", "RASCUNHO", "ENVIADA", "EM_NEGOCIACAO", "ACEITA", "RECUSADA"].map(s => (
            <button key={s} onClick={() => { setFilterStatus(s); setSoRevisao(false); setPage(1); }}
              className={`px-3 py-1.5 rounded-md text-sm font-medium border transition-colors ${
                !soRevisao && filterStatus === s ? "bg-brand-600 text-white border-brand-600" : "border-gray-300 text-gray-600 hover:border-brand-400"
              }`}>
              {s === "" ? "Todas" : STATUS_LABEL[s]?.label ?? s}
            </button>
          ))}
          <button
            onClick={() => { setSoRevisao(v => !v); setFilterStatus(""); setPage(1); }}
            className={`px-3 py-1.5 rounded-md text-sm font-medium border transition-colors ${
              soRevisao ? "bg-amber-500 text-white border-amber-500" : "border-amber-300 text-amber-700 hover:bg-amber-50"
            }`}>
            🔍 Aguardando revisão{qtdRevisao ? ` (${qtdRevisao})` : ""}
          </button>
        </div>
        {empresas && empresas.length > 1 && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500 font-medium">Empresa:</span>
            <select
              value={filterEmitenteId}
              onChange={e => { setFilterEmitenteId(e.target.value); setPage(1); }}
              className="border border-gray-300 rounded-md px-2 py-1 text-sm text-gray-700 focus:outline-none focus:ring-1 focus:ring-brand-400"
            >
              <option value="">Todas</option>
              {empresas.map((e: any) => (
                <option key={e.id} value={e.id}>{e.nomeFantasia || e.nome}</option>
              ))}
            </select>
          </div>
        )}
      </div>

      {/* Tabela */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-x-auto">
        <table className="w-full text-sm min-w-[860px]">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200">
              <th className="px-4 py-3 text-left font-semibold text-gray-600 min-w-[260px]">Título</th>
              <th className="px-4 py-3 text-left font-semibold text-gray-600 min-w-[180px]">Tomador</th>
              {!filterEmitenteId && <th className="px-4 py-3 text-left font-semibold text-gray-600 min-w-[150px]">Empresa</th>}
              <th className="px-4 py-3 text-left font-semibold text-gray-600 min-w-[100px] whitespace-nowrap">Valor</th>
              <th className="px-4 py-3 text-left font-semibold text-gray-600 min-w-[90px] whitespace-nowrap">Validade</th>
              <th className="px-4 py-3 text-left font-semibold text-gray-600 min-w-[120px]">Status</th>
              <th className="px-4 py-3 sticky right-0 bg-gray-50"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {isLoading && <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-400">Carregando...</td></tr>}
            {!isLoading && !data?.propostas.length && <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-400">Nenhuma proposta encontrada</td></tr>}
            {data?.propostas.map(p => (
              <tr
                key={p.id}
                className="hover:bg-gray-50 transition-colors cursor-pointer group"
                onClick={() => {
                  if ((p as any).revisaoStatus === "PENDENTE") setRevisaoModal(p);
                  else if (p.status === "RASCUNHO" || p.status === "EM_NEGOCIACAO") abrirEditar(p);
                  else window.open(`/api/proposta/${p.tokenAceite}`, "_blank");
                }}
              >
                <td className="px-4 py-3 min-w-[260px] max-w-[340px]">
                  <span className="font-medium text-gray-800 group-hover:text-brand-700 transition-colors block truncate">
                    {p.titulo}
                  </span>
                  {(p as any).contratoDiaVencimento && (
                    <span className="text-xs bg-brand-50 text-brand-700 px-1.5 py-0.5 rounded">Auto</span>
                  )}
                </td>
                <td className="px-4 py-3 text-gray-600 max-w-[220px] truncate">{p.tomador.nome}</td>
                {!filterEmitenteId && (
                  <td className="px-4 py-3 text-xs text-gray-500 max-w-[180px] truncate">
                    {(p as any).emitente?.nomeFantasia || (p as any).emitente?.nome || "—"}
                  </td>
                )}
                <td className="px-4 py-3 text-gray-700 whitespace-nowrap">{p.valorEstimado ? fmt(p.valorEstimado) : "—"}</td>
                <td className="px-4 py-3 text-gray-500 text-xs whitespace-nowrap">
                  {p.validadeAte ? p.validadeAte.slice(0, 10).split("-").reverse().join("/") : "—"}
                </td>
                <td className="px-4 py-3">
                  {(p as any).revisaoStatus === "PENDENTE" ? (
                    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-800"
                      title="Documentos gerados pela IA, aguardando conferência — nada foi enviado ao cliente">
                      🔍 Em revisão
                    </span>
                  ) : (
                    <StatusBadge status={p.status} />
                  )}
                  {(p as any).contratoId && (
                    <span className="ml-1.5 text-green-600 text-xs font-bold" title="Contrato gerado">✓</span>
                  )}
                </td>

                {/* Coluna de ações: apenas ⋮ */}
                <td className="px-3 py-3 sticky right-0 bg-white group-hover:bg-gray-50 border-l border-gray-100 transition-colors"
                  onClick={(e) => e.stopPropagation()}
                >
                  <button
                    onClick={(e) => handleMenuToggle(e, p.id)}
                    className="w-7 h-7 flex items-center justify-center rounded text-gray-400 hover:bg-gray-200 hover:text-gray-700 border border-gray-200 leading-none"
                    title="Ações"
                  >
                    ⋮
                  </button>

                  {openMenuId === p.id && (
                    <>
                      <div className="fixed inset-0 z-10" onClick={() => setOpenMenuId(null)} />
                      <div
                        className="fixed bg-white border border-gray-200 rounded-xl shadow-xl z-20 w-56 py-1.5 overflow-y-auto"
                        style={{ top: menuPos.top, bottom: menuPos.bottom, right: menuPos.right, maxHeight: "min(480px, 85vh)" }}
                        onClick={(e) => e.stopPropagation()}
                      >
                        {/* Revisão pendente: o menu começa por ela */}
                        {(p as any).revisaoStatus === "PENDENTE" && (
                          <>
                            <button onClick={() => { setRevisaoModal(p); setOpenMenuId(null); }}
                              className="w-full text-left flex items-center gap-2 px-3 py-2 text-sm text-amber-700 hover:bg-amber-50 font-medium">
                              🔍 Revisar documentos
                            </button>
                            <button
                              onClick={() => {
                                if (confirm(`Liberar os documentos de ${p.tomador.nome} para assinatura?\n\nOs links serão criados no PAKT e enviados ao cliente pelo WhatsApp.`))
                                  liberar.mutate({ id: p.id });
                                setOpenMenuId(null);
                              }}
                              disabled={liberar.isPending}
                              className="w-full text-left flex items-center gap-2 px-3 py-2 text-sm text-green-700 hover:bg-green-50 font-medium disabled:opacity-50">
                              ✅ Liberar para assinatura
                            </button>
                            <div className="border-t border-gray-100 mt-1" />
                          </>
                        )}

                        {/* Abrir */}
                        {(p.status === "RASCUNHO" || p.status === "EM_NEGOCIACAO") ? (
                          <button onClick={() => { abrirEditar(p); setOpenMenuId(null); }}
                            className="w-full text-left flex items-center gap-2 px-3 py-2 text-sm text-brand-600 hover:bg-brand-50 font-medium">
                            ✏️ Editar proposta
                          </button>
                        ) : (
                          <a href={`/api/proposta/${p.tokenAceite}`} target="_blank" rel="noopener noreferrer"
                            className="flex items-center gap-2 px-3 py-2 text-sm text-brand-600 hover:bg-brand-50 font-medium"
                            onClick={() => setOpenMenuId(null)}>
                            🔗 Ver proposta
                          </a>
                        )}

                        {/* ── Envio ──────────────────────────────────── */}
                        {/* Em revisão o envio some: o caminho é liberar, que já manda os links */}
                        <div className={`border-t border-gray-100 pt-1 mt-1 ${(p as any).revisaoStatus === "PENDENTE" ? "hidden" : ""}`}>
                          <p className="px-3 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-gray-400">Envio</p>
                          <button
                            onClick={() => {
                              if (confirm(`${p.status === "RASCUNHO" ? "Enviar" : "Reenviar"} e-mail para ${p.tomador.email || p.tomador.nome}?`))
                                enviarEmail.mutate({ id: p.id });
                              setOpenMenuId(null);
                            }}
                            disabled={enviarEmail.isPending}
                            className="w-full text-left flex items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                          >
                            ✉️ {p.status === "RASCUNHO" ? "Enviar por E-mail" : "Reenviar E-mail"}
                          </button>
                          {/* WhatsApp vale também para rascunho: gera documentos/PAKT como o e-mail */}
                          <button
                            onClick={() => {
                              if (confirm(`${p.status === "RASCUNHO" ? "Enviar" : "Reenviar"} via WhatsApp para ${p.tomador.telefone || p.tomador.nome}?`))
                                enviarWA.mutate({ id: p.id });
                              setOpenMenuId(null);
                            }}
                            disabled={enviarWA.isPending}
                            className="w-full text-left flex items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                          >
                            📱 {p.status === "RASCUNHO" ? "Enviar via WhatsApp" : "Reenviar via WhatsApp"}
                          </button>
                          <button
                            onClick={() => { abrirWhatsApp(p); setOpenMenuId(null); }}
                            className="w-full text-left flex items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
                          >
                            💬 Copiar link WhatsApp
                            {copiedId === p.id && <span className="text-xs text-green-600 ml-auto">✓ copiado</span>}
                          </button>
                        </div>

                        {/* ── Fluxo ──────────────────────────────────── */}
                        {(p.status === "ENVIADA" || p.status === "RASCUNHO" ||
                          (p.status === "ACEITA" && !(p as any).contratoId && !(p as any).contratoDiaVencimento)) && (
                          <div className="border-t border-gray-100 pt-1 mt-1">
                            <p className="px-3 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-gray-400">Fluxo</p>
                            {(p.status === "ENVIADA" || p.status === "RASCUNHO") && (
                              <button
                                onClick={() => { abrirNegociacao(p); setOpenMenuId(null); }}
                                className="w-full text-left flex items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
                              >
                                📋 Marcar Em Negociação
                              </button>
                            )}
                            {p.status === "ACEITA" && !(p as any).contratoId && !(p as any).contratoDiaVencimento && (
                              <button
                                onClick={() => { setConverterModal(p); setOpenMenuId(null); }}
                                className="w-full text-left flex items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
                              >
                                🤝 Converter em Contrato
                              </button>
                            )}
                          </div>
                        )}

                        {/* ── Documentos ─────────────────────────────── */}
                        <div className="border-t border-gray-100 pt-1 mt-1">
                          <p className="px-3 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-gray-400">Documentos</p>
                          {p.status === "ACEITA" && (p as any).paktSignedPdfPath && (
                            <button
                              onClick={async () => {
                                const token = localStorage.getItem("avoce_token");
                                const res = await fetch(`/api/proposta/${p.id}/pdf-assinado`, {
                                  headers: { Authorization: `Bearer ${token}` },
                                });
                                if (!res.ok) { alert("PDF ainda não disponível"); return; }
                                const blob = await res.blob();
                                const url = URL.createObjectURL(blob);
                                const a = document.createElement("a");
                                a.href = url;
                                a.download = `Proposta-Assinada-${p.titulo.replace(/[^a-zA-Z0-9]/g, "-")}.pdf`;
                                a.click();
                                URL.revokeObjectURL(url);
                                setOpenMenuId(null);
                              }}
                              className="w-full text-left flex items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
                            >
                              📄 PDF Assinado
                            </button>
                          )}
                          <DocsBotoes
                            propostaId={p.id}
                            onGerar={() => { gerarDocumentos.mutate({ propostaId: p.id }); setOpenMenuId(null); }}
                            onEdit={(doc) => { setEditDocModal(doc); setEditDocHtml(doc.htmlEditado ?? ""); setOpenMenuId(null); }}
                          />
                        </div>

                        {/* ── Danger ─────────────────────────────────── */}
                        {p.status === "RASCUNHO" && (
                          <>
                            <div className="border-t border-gray-100 mt-1" />
                            <button
                              onClick={() => { if (confirm("Excluir esta proposta?")) { excluir.mutate({ id: p.id }); setOpenMenuId(null); } }}
                              className="w-full text-left flex items-center gap-2 px-3 py-2 text-sm text-red-600 hover:bg-red-50"
                            >
                              🗑️ Excluir proposta
                            </button>
                          </>
                        )}
                      </div>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Paginação */}
      {data && data.pages > 1 && (
        <div className="flex justify-center gap-2 mt-4">
          {Array.from({ length: data.pages }, (_, i) => i + 1).map(n => (
            <button key={n} onClick={() => setPage(n)}
              className={`w-8 h-8 rounded text-sm ${page === n ? "bg-brand-600 text-white" : "border border-gray-300 hover:bg-gray-50"}`}>
              {n}
            </button>
          ))}
        </div>
      )}

      {/* ── Editor OnlyOffice (por cima da revisão) ─────────────────────────── */}
      {ooDoc && (
        <OnlyOfficeEditor
          docId={ooDoc.id}
          titulo={ooDoc.titulo}
          onClose={() => {
            setOoDoc(null);
            // O PDF só é regerado depois do callback do Document Server
            utils.templateDocumento.listarDocumentosProposta.invalidate();
          }}
        />
      )}

      {/* ── Modal Revisão de Documentos ──────────────────────────────────────── */}
      {revisaoModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-5xl max-h-[92vh] flex flex-col">
            <div className="px-6 py-4 border-b border-gray-200 flex items-start justify-between gap-4">
              <div className="min-w-0">
                <h2 className="text-lg font-bold text-gray-900 truncate">Revisão — {revisaoModal.tomador.nome}</h2>
                <p className="text-xs text-gray-500 mt-0.5 truncate">
                  {revisaoModal.titulo} · {(revisaoModal as any).emitente?.nomeFantasia || (revisaoModal as any).emitente?.nome || ""}
                </p>
              </div>
              <button onClick={() => setRevisaoModal(null)} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
            </div>

            <div className="px-6 pt-3">
              <p className="text-xs bg-amber-50 border border-amber-200 text-amber-800 rounded-lg px-3 py-2">
                A coleta terminou e a IA gerou estes documentos. <strong>Nada foi enviado ao cliente ainda.</strong>{" "}
                Confira, corrija o que precisar e só então libere para assinatura.
              </p>
            </div>

            <div className="flex-1 overflow-y-auto min-h-0">
              <RevisaoDocs
                propostaId={revisaoModal.id}
                regerando={gerarDocumentos.isPending}
                onRegerar={() => { if (confirm("Regenerar todos os documentos desta proposta?")) gerarDocumentos.mutate({ propostaId: revisaoModal.id }); }}
                onEdit={(doc) => { setEditDocModal(doc); setEditDocHtml(doc.htmlEditado ?? ""); }}
                onAbrirOO={(doc) => setOoDoc(doc)}
              />
            </div>

            <div className="px-6 py-4 border-t border-gray-200 flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs text-gray-500">
                Ao liberar: os PDFs viram envelopes no PAKT e os links vão para o cliente
                {(revisaoModal as any).envioTelefone ? ` (${(revisaoModal as any).envioTelefone})` : ""} e para as testemunhas.
              </p>
              <div className="flex gap-3 ml-auto">
                <button onClick={() => setRevisaoModal(null)} className="btn-secondary">Fechar</button>
                <button
                  onClick={() => {
                    if (confirm(`Liberar os documentos de ${revisaoModal.tomador.nome} para assinatura?`))
                      liberar.mutate({ id: revisaoModal.id });
                  }}
                  disabled={liberar.isPending}
                  className="btn-primary"
                >
                  {liberar.isPending ? "Enviando..." : "✅ Liberar para assinatura"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Modal Em Negociação ──────────────────────────────────────────────── */}
      {negociacaoModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md">
            <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
              <h2 className="text-lg font-bold text-gray-900">Registrar Negociação</h2>
              <button onClick={() => setNegociacaoModal(null)} className="text-gray-400 hover:text-gray-600 text-xl">×</button>
            </div>
            <div className="p-6 space-y-4">
              <p className="text-sm text-gray-600">
                A proposta <strong>"{negociacaoModal.titulo}"</strong> será marcada como <strong>Em Negociação</strong>.
                Em seguida você poderá editar o texto, valores e reenviar ao cliente.
              </p>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Observação interna (opcional)</label>
                <textarea
                  rows={3}
                  value={negociacaoObs}
                  onChange={e => setNegociacaoObs(e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                  placeholder="Ex: Cliente solicitou redução de 10% no valor..."
                />
              </div>
            </div>
            <div className="px-6 py-4 border-t border-gray-200 flex justify-end gap-3">
              <button onClick={() => setNegociacaoModal(null)} className="btn-secondary">Cancelar</button>
              <button onClick={salvarNegociacao} disabled={atualizar.isPending} className="btn-primary">
                {atualizar.isPending ? "Salvando..." : "Registrar e Editar"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Modal Criar/Editar ──────────────────────────────────────────────── */}
      {form && (
        <div className="fixed inset-0 bg-black/50 flex items-start justify-center z-50 p-4 overflow-y-auto">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-4xl my-8">
            <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
              <h2 className="text-lg font-bold text-gray-900">{form.id ? "Editar Proposta" : "Nova Proposta"}</h2>
              <button onClick={() => setForm(null)} className="text-gray-400 hover:text-gray-600 text-xl">×</button>
            </div>
            <div className="p-6 space-y-4">
              {/* Empresa / Tomador */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Empresa *</label>
                  <select value={form.emitenteId} onChange={e => { setForm({ ...form, emitenteId: e.target.value, templatesGerar: [] }); setEmitenteIdParaTemplates(e.target.value); }}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-brand-500">
                    <option value="">Selecione...</option>
                    {empresas?.map(e => <option key={e.id} value={e.id}>{e.nomeFantasia || e.nome}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Tomador / Cliente *</label>
                  <select value={form.tomadorId} onChange={e => setForm({ ...form, tomadorId: e.target.value })}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-brand-500">
                    <option value="">Selecione...</option>
                    {tomadores?.map(t => <option key={t.id} value={t.id}>{t.nome}</option>)}
                  </select>
                </div>
              </div>

              {/* Template — busca da página Templates */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Template de proposta
                  <span className="ml-2 text-xs font-normal text-gray-400">
                    — gerencie na página{" "}
                    <Link to="/templates-documentos" target="_blank" className="text-brand-600 hover:underline">Templates</Link>
                  </span>
                </label>
                {!templatesProposta || templatesProposta.length === 0 ? (
                  <p className="text-sm text-gray-400 border border-dashed border-gray-300 rounded-lg px-3 py-2">
                    Nenhum template de proposta cadastrado.{" "}
                    <Link to="/templates-documentos" target="_blank" className="text-brand-600 hover:underline">Criar na página Templates →</Link>
                  </p>
                ) : (
                  <select defaultValue="" onChange={e => { if (e.target.value) aplicarTemplate(e.target.value); e.target.value = ""; }}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-brand-500">
                    <option value="">Selecione um template para preencher o texto...</option>
                    {templatesProposta.map((t: any) => (
                      <option key={t.id} value={t.id}>{t.titulo}{t.emitente ? ` — ${t.emitente.nomeFantasia || t.emitente.nome}` : ""}</option>
                    ))}
                  </select>
                )}
              </div>

              {/* Título + Descrição do Serviço */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Título *</label>
                  <input type="text" value={form.titulo} onChange={e => setForm({ ...form, titulo: e.target.value })}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-brand-500"
                    placeholder="Ex: Proposta de Assessoria Jurídica" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Descrição do Serviço
                    <span className="ml-1.5 text-xs font-normal text-gray-400 font-mono">{"{{servico}}"}</span>
                  </label>
                  <input type="text" value={form.contratoDescricao}
                    onChange={e => setForm({ ...form, contratoDescricao: e.target.value })}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-brand-500"
                    placeholder="Ex: Assessoria Jurídica Trabalhista — usada em contratos, procurações e NFS-e" />
                </div>
              </div>

              {/* Editor */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Texto da Proposta *</label>
                <div className="mb-2 flex flex-wrap gap-1">
                  {VARIAVEIS_PROPOSTA.map(({ v, desc }) => (
                    <button key={v} type="button" title={desc}
                      onClick={() => editorRef.current?.insertText(v)}
                      className="text-xs bg-brand-50 border border-brand-200 text-brand-700 hover:bg-brand-100 rounded px-2 py-0.5 font-mono transition-colors">
                      {v}
                    </button>
                  ))}
                </div>
                <RichEditor ref={editorRef} value={form.textoHtml} onChange={html => setForm({ ...form, textoHtml: html })} minHeight="320px" />
              </div>

              {/* Valor / Honorários / Validade */}
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Valor Fixo (R$)</label>
                  <input type="number" step="0.01" value={form.valorStr} onChange={e => setForm({ ...form, valorStr: e.target.value })}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-brand-500" placeholder="0,00" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Honorários de Êxito (%)</label>
                  <input type="number" step="0.5" min="0.01" max="100" value={form.honorariosExitoPercStr}
                    onChange={e => setForm({ ...form, honorariosExitoPercStr: e.target.value })}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-brand-500"
                    placeholder="Ex: 30 ou 12.5" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Validade da Proposta</label>
                  <input type="date" value={form.validadeAte} onChange={e => setForm({ ...form, validadeAte: e.target.value })}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-brand-500" />
                </div>
              </div>

              {/* ── Parâmetros do Contrato ─────────────────────────────────────── */}
              <div className="border border-brand-100 rounded-xl bg-brand-50/40 p-4 space-y-4">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-brand-800">Parâmetros do Contrato</span>
                  <span className="text-xs text-brand-600 bg-brand-100 px-2 py-0.5 rounded">Auto-conversão ao aceitar</span>
                </div>
                <p className="text-xs text-gray-500 -mt-2">
                  Se preenchidos, o contrato será criado automaticamente quando o cliente aceitar a proposta.
                </p>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Dia de Vencimento *</label>
                    <input type="number" min={1} max={30} value={form.contratoDiaVencimento}
                      onChange={e => setForm({ ...form, contratoDiaVencimento: e.target.value })}
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                      placeholder="Ex: 5" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Método de Cobrança</label>
                    <select value={form.contratoMetodoCobr} onChange={e => setForm({ ...form, contratoMetodoCobr: e.target.value })}
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm">
                      <option value="PIX_BOLETO">PIX + Boleto</option>
                      <option value="PIX">Apenas PIX</option>
                      <option value="BOLETO">Apenas Boleto</option>
                      <option value="NENHUM">Nenhum (manual)</option>
                      <option value="ALVARA">Transferência por Alvará Judicial</option>
                    </select>
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Tipo de Contrato</label>
                  <div className="flex gap-4">
                    {[["RECORRENTE","Recorrente (sem prazo)"],["PARCELADO","Parcelado (prazo determinado)"],["EVENTUAL","Eventual (sem recorrência)"]].map(([v,l]) => (
                      <label key={v} className="flex items-center gap-2 text-sm cursor-pointer">
                        <input type="radio" name="tipoContrato" value={v}
                          checked={form.contratoTipoContrato === v}
                          onChange={() => setForm({ ...form, contratoTipoContrato: v })} />
                        {l}
                      </label>
                    ))}
                  </div>
                  {form.contratoTipoContrato === "PARCELADO" && (
                    <div className="mt-2">
                      <label className="block text-sm font-medium text-gray-700 mb-1">Número de parcelas</label>
                      <input type="number" min={2} value={form.contratoTotalParcelas}
                        onChange={e => setForm({ ...form, contratoTotalParcelas: e.target.value })}
                        className="w-32 border border-gray-300 rounded-lg px-3 py-2 text-sm" />
                    </div>
                  )}
                </div>
                <div className="flex gap-4 flex-wrap">
                  {[
                    ["contratoEmitirNfseAuto",    "Emitir NFS-e automático"],
                    ["contratoGerarCobrancaAuto", "Gerar cobrança automático"],
                    ["contratoIssRetido",         "ISS Retido"],
                  ].map(([field, label]) => (
                    <label key={field} className="flex items-center gap-2 text-sm cursor-pointer">
                      <input type="checkbox" checked={(form as any)[field]}
                        onChange={e => setForm({ ...form, [field]: e.target.checked })} className="rounded" />
                      {label}
                    </label>
                  ))}
                </div>
              </div>

              {/* ── Documentos a gerar ao aceitar ───────────────────────────── */}
              {form.emitenteId && (
                <div className="border border-green-100 rounded-xl bg-green-50/40 p-4 space-y-3">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-green-800">Documentos a gerar ao aceitar</span>
                    <span className="text-xs text-green-600 bg-green-100 px-2 py-0.5 rounded">Contrato / Procuração</span>
                  </div>
                  {!templatesDoc ? (
                    <p className="text-xs text-gray-400">Carregando templates...</p>
                  ) : templatesDoc.length === 0 ? (
                    <p className="text-xs text-gray-500">
                      Nenhum template configurado para esta empresa.{" "}
                      <a href="/templates-documentos" target="_blank" className="text-brand-600 underline hover:text-brand-700">
                        Criar templates →
                      </a>
                    </p>
                  ) : (
                    <>
                      <p className="text-xs text-gray-500">Selecione quais documentos serão gerados automaticamente quando o cliente assinar/aceitar esta proposta.</p>
                      <div className="flex flex-col gap-2">
                        {(templatesDoc as any[]).map((t: any) => (
                          <label key={t.id} className="flex items-center gap-3 cursor-pointer bg-white rounded-lg px-3 py-2 border border-green-100 hover:border-green-300">
                            <input
                              type="checkbox"
                              checked={form.templatesGerar.includes(t.id)}
                              onChange={e => setForm({
                                ...form,
                                templatesGerar: e.target.checked
                                  ? [...form.templatesGerar, t.id]
                                  : form.templatesGerar.filter(id => id !== t.id),
                              })}
                              className="rounded text-green-600"
                            />
                            <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                              t.tipo === "CONTRATO"   ? "bg-blue-100 text-blue-700" :
                              t.tipo === "PROCURACAO" ? "bg-purple-100 text-purple-700" :
                              "bg-gray-100 text-gray-700"
                            }`}>
                              {t.tipo === "CONTRATO" ? "Contrato" : t.tipo === "PROCURACAO" ? "Procuração" : "Doc"}
                            </span>
                            <span className="text-sm text-gray-700">{t.titulo}</span>
                          </label>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              )}

              {/* PAKT */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Link PAKT manual (opcional)</label>
                <input type="url" value={form.paktSignUrl} onChange={e => setForm({ ...form, paktSignUrl: e.target.value })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-brand-500"
                  placeholder="Preenchido automaticamente ao enviar" />
              </div>
            </div>
            <div className="px-6 py-4 border-t border-gray-200 flex justify-end gap-3">
              <button onClick={() => setForm(null)} className="btn-secondary">Cancelar</button>
              <button onClick={salvar} disabled={criar.isPending || atualizar.isPending} className="btn-primary">
                {(criar.isPending || atualizar.isPending) ? "Salvando..." : "Salvar"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Modal Editar Documento Gerado ───────────────────────────────────── */}
      {editDocModal && (
        <div className="fixed inset-0 bg-black/50 flex items-start justify-center z-50 p-4 overflow-y-auto">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-4xl my-8">
            <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
              <div>
                <h2 className="text-lg font-bold text-gray-900">Editar Documento</h2>
                <p className="text-sm text-gray-500 mt-0.5">{editDocModal.titulo}</p>
              </div>
              <button onClick={() => setEditDocModal(null)} className="text-gray-400 hover:text-gray-600 text-xl">×</button>
            </div>
            <div className="p-6">
              <p className="text-xs text-gray-400 mb-3">
                Edite o texto do documento. Ao salvar, o PDF (e DOCX, se houver) será regenerado automaticamente.
              </p>
              <RichEditor
                ref={editDocEditorRef}
                value={editDocHtml}
                onChange={html => setEditDocHtml(html)}
                minHeight="500px"
              />
            </div>
            <div className="px-6 py-4 border-t border-gray-200 flex justify-end gap-3">
              <button onClick={() => setEditDocModal(null)} className="btn-secondary">Cancelar</button>
              <button
                onClick={() => atualizarDocGerado.mutate({ id: editDocModal.id, textoHtml: editDocHtml })}
                disabled={atualizarDocGerado.isPending}
                className="btn-primary"
              >
                {atualizarDocGerado.isPending ? "Salvando e gerando PDF..." : "Salvar e Regenerar PDF"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Modal Converter Manual ───────────────────────────────────────────── */}
      {converterModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg">
            <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
              <h2 className="text-lg font-bold text-gray-900">Converter em Contrato</h2>
              <button onClick={() => setConverterModal(null)} className="text-gray-400 hover:text-gray-600 text-xl">×</button>
            </div>
            <div className="p-6">
              <p className="text-sm text-gray-500 mb-4">
                Esta proposta não tinha parâmetros de contrato preenchidos. Preencha abaixo para criar o contrato manualmente.
              </p>
              <button onClick={() => { setConverterModal(null); abrirEditar(converterModal); }}
                className="w-full btn-primary">
                Editar proposta e preencher parâmetros
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
