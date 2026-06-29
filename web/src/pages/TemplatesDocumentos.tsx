import { useState, useRef, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { trpc } from "../lib/trpc";
import RichEditor, { type RichEditorHandle } from "../components/RichEditor";

const TIPOS = [
  { value: "PROPOSTA",   label: "Proposta" },
  { value: "CONTRATO",   label: "Contrato" },
  { value: "PROCURACAO", label: "Procuração" },
  { value: "OUTRO",      label: "Outro" },
] as const;

const VARIAVEIS = [
  // Escritório
  { v: "{{emitente}}",        desc: "Nome do escritório" },
  { v: "{{cnpj}}",            desc: "CNPJ (com máscara)" },
  { v: "{{cidade}}",          desc: "Cidade do escritório" },
  { v: "{{endereco}}",        desc: "Endereço do escritório" },
  // Cliente (geral)
  { v: "{{tomador}}",         desc: "Nome do cliente" },
  { v: "{{cpfCnpj}}",         desc: "CPF/CNPJ do cliente" },
  { v: "{{enderecoTomador}}", desc: "Endereço do cliente" },
  { v: "{{emailTomador}}",    desc: "E-mail do cliente" },
  { v: "{{telefoneTomador}}", desc: "Telefone do cliente" },
  // Pessoa Física
  { v: "{{qualificacaoPF}}",       desc: "Qualificação completa PF (profissão, nacionalidade, estado civil + regime, nascimento, RG, CPF, endereço)" },
  { v: "{{rgTomador}}",            desc: "RG do cliente PF (ou número de identidade da CNH)" },
  { v: "{{orgaoEmissorRg}}",       desc: "Órgão expedidor do RG / CNH (ex: SSP/BA, PC/MG)" },
  { v: "{{estadoCivilTomador}}",   desc: "Estado civil + regime de bens (ex: casado(a) sob o regime de...)" },
  { v: "{{profissaoTomador}}",     desc: "Profissão do cliente PF" },
  { v: "{{nacionalidadeTomador}}", desc: "Nacionalidade do cliente PF" },
  { v: "{{naturalidadeTomador}}",  desc: "Naturalidade do cliente PF" },
  { v: "{{regimeCasamento}}",      desc: "Regime de bens do cliente PF (se casado/união estável)" },
  // Pessoa Jurídica
  { v: "{{qualificacaoPJ}}",       desc: "Qualificação completa PJ (razão social, CNPJ, tipo societário, capital, sede)" },
  { v: "{{tipoSocietario}}",       desc: "Tipo societário (LTDA, SA, MEI...)" },
  { v: "{{objetoSocial}}",         desc: "Objeto social da empresa" },
  { v: "{{capitalSocial}}",        desc: "Capital social em R$" },
  // Representante legal / administrador
  { v: "{{administrador}}",            desc: "Nome do 1º representante legal / administrador" },
  { v: "{{cpfAdministrador}}",         desc: "CPF do 1º representante legal" },
  { v: "{{cargoAdministrador}}",       desc: "Cargo do 1º representante legal" },
  { v: "{{qualificacaoAdministrador}}", desc: "Qualificação completa do 1º representante legal (inclui regime de bens se casado)" },
  { v: "{{enderecoAdministrador}}",    desc: "Endereço do 1º representante legal" },
  { v: "{{administradores}}",          desc: "Todos os representantes legais listados (nome + cargo + CPF)" },
  // Proposta / contrato
  { v: "{{valor}}",           desc: "Valor em R$" },
  { v: "{{diaVencimento}}",   desc: "Dia de vencimento" },
  { v: "{{metodoPagamento}}", desc: "Método de pagamento" },
  { v: "{{dataAtual}}",       desc: "Data atual" },
  { v: "{{validadeAte}}",     desc: "Validade da proposta (data formatada)" },
  { v: "{{servico}}",         desc: "Descrição do serviço (campo 'Descrição para NFS-e')" },
];

// Templates padrão — definidos localmente para não depender de fetch
const TPL_CONTRATO = {
  tipo: "CONTRATO" as const,
  titulo: "Contrato de Prestação de Serviços Advocatícios",
  textoHtml: `<h2>CONTRATO DE PRESTAÇÃO DE SERVIÇOS ADVOCATÍCIOS</h2><p>Pelo presente instrumento particular, as partes abaixo qualificadas celebram o presente <strong>Contrato de Prestação de Serviços Advocatícios</strong>, que se regerá pelas cláusulas e condições seguintes:</p><h3>PARTES</h3><p><strong>CONTRATADO:</strong> <strong>{{emitente}}</strong>, inscrito no CNPJ sob o nº <strong>{{cnpj}}</strong>, com endereço em {{endereco}}.</p><p><strong>CONTRATANTE:</strong> <strong>{{tomador}}</strong>, inscrito no CPF/CNPJ nº <strong>{{cpfCnpj}}</strong>, com endereço em {{enderecoTomador}}, e-mail: {{emailTomador}}.</p><h3>CLÁUSULA 1ª — DO OBJETO</h3><p>O presente contrato tem por objeto a prestação de serviços advocatícios pelo CONTRATADO ao CONTRATANTE, conforme proposta previamente apresentada e aceita pelas partes.</p><h3>CLÁUSULA 2ª — DOS HONORÁRIOS</h3><p>Pelos serviços contratados, o CONTRATANTE pagará ao CONTRATADO honorários mensais no valor de <strong>{{valor}}</strong>, com vencimento no dia <strong>{{diaVencimento}}</strong> de cada mês, mediante <strong>{{metodoPagamento}}</strong>.</p><h3>CLÁUSULA 3ª — DO PRAZO</h3><p>O presente contrato vigerá por prazo indeterminado, podendo ser rescindido por qualquer das partes mediante aviso prévio de 30 (trinta) dias.</p><h3>CLÁUSULA 4ª — DAS OBRIGAÇÕES DO CONTRATADO</h3><p>O CONTRATADO obriga-se a prestar os serviços com diligência, competência e sigilo profissional, observando o Código de Ética e Disciplina da OAB e a legislação aplicável.</p><h3>CLÁUSULA 5ª — DAS OBRIGAÇÕES DO CONTRATANTE</h3><p>O CONTRATANTE obriga-se a fornecer ao CONTRATADO todas as informações e documentos necessários à prestação dos serviços, bem como a efetuar o pagamento dos honorários nas datas convencionadas.</p><h3>CLÁUSULA 6ª — DO REAJUSTE</h3><p>Os honorários serão reajustados anualmente pelo IGP-M (FGV) ou índice oficial que o substitua.</p><h3>CLÁUSULA 7ª — DO FORO</h3><p>As partes elegem o foro da Comarca de {{cidade}} para dirimir quaisquer controvérsias oriundas do presente contrato.</p><p><br>{{cidade}}, {{dataAtual}}.</p><p><br></p><p>_____________________________ &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; _____________________________</p><p><strong>{{emitente}}</strong> (CONTRATADO) &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; <strong>{{tomador}}</strong> (CONTRATANTE)</p><p>CNPJ: {{cnpj}} &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; CPF/CNPJ: {{cpfCnpj}}</p>`,
};

const TPL_PROCURACAO = {
  tipo: "PROCURACAO" as const,
  titulo: "Procuração Ad Judicia",
  textoHtml: `<h2>PROCURAÇÃO AD JUDICIA ET EXTRA</h2><p><strong>OUTORGANTE:</strong> <strong>{{tomador}}</strong>, inscrito(a) no CPF/CNPJ nº <strong>{{cpfCnpj}}</strong>, com endereço em {{enderecoTomador}}, e-mail: {{emailTomador}}.</p><p><strong>OUTORGADO:</strong> Os advogados do escritório <strong>{{emitente}}</strong>, inscrito no CNPJ sob o nº <strong>{{cnpj}}</strong>, com endereço em {{endereco}}, e respectivos substabelecidos.</p><h3>PODERES</h3><p>Pelo presente instrumento, o OUTORGANTE nomeia e constitui como seus bastantes procuradores os advogados acima qualificados, conferindo-lhes amplos poderes para:</p><ul><li>representar o OUTORGANTE em todos os atos processuais, em qualquer instância judicial ou tribunal;</li><li>propor, contestar, reconvir, recorrer, transigir, desistir, confessar, receber e dar quitação;</li><li>assinar petições, contratos e demais documentos necessários;</li><li>praticar todos os demais atos necessários ao fiel cumprimento do presente mandato;</li><li>substabelecer com ou sem reserva de poderes.</li></ul><p>Esta procuração é outorgada para representação nos interesses do OUTORGANTE perante quaisquer órgãos públicos, autarquias, empresas públicas, Poder Judiciário, Ministério Público e quaisquer outras entidades, públicas ou privadas.</p><p><br>{{cidade}}, {{dataAtual}}.</p><p><br></p><p style="text-align:center">_____________________________</p><p style="text-align:center"><strong>{{tomador}}</strong><br>CPF/CNPJ: {{cpfCnpj}}<br>OUTORGANTE</p>`,
};

interface TemplateForm {
  id?: string;
  emitenteId: string;
  tipo: "PROPOSTA" | "CONTRATO" | "PROCURACAO" | "OUTRO";
  titulo: string;
  textoHtml: string;
  ativo: boolean;
  cabecalhoPath?: string | null;
}

function emptyForm(emitenteId = ""): TemplateForm {
  return { emitenteId, tipo: "PROPOSTA", titulo: "", textoHtml: "<p></p>", ativo: true };
}

export default function TemplatesDocumentos() {
  const utils = trpc.useUtils();
  const editorRef = useRef<RichEditorHandle>(null);
  const [searchParams] = useSearchParams();

  const { data: empresas } = trpc.empresa.listar.useQuery();
  const [filterEmitenteId, setFilterEmitenteId] = useState(searchParams.get("emitenteId") ?? "");
  const [filterTipo, setFilterTipo] = useState(searchParams.get("tipo") ?? "");

  // Se veio com ?tipo=PROPOSTA na URL, abrir form novo automaticamente
  useEffect(() => {
    const tipoParam = searchParams.get("tipo");
    const emitenteParam = searchParams.get("emitenteId");
    if (tipoParam === "PROPOSTA" && emitenteParam) {
      setForm({ emitenteId: emitenteParam, tipo: "PROPOSTA", titulo: "", textoHtml: "<p></p>", ativo: true });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { data: templates, isLoading } = trpc.templateDocumento.listar.useQuery({
    emitenteId: filterEmitenteId || undefined,
    tipo: filterTipo || undefined,
  });

  const criar     = trpc.templateDocumento.criar.useMutation({ onSuccess: () => utils.templateDocumento.listar.invalidate() });
  const atualizar = trpc.templateDocumento.atualizar.useMutation({ onSuccess: () => utils.templateDocumento.listar.invalidate() });
  const excluir   = trpc.templateDocumento.excluir.useMutation({ onSuccess: () => utils.templateDocumento.listar.invalidate() });

  const [form, setForm] = useState<TemplateForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploadingTimbrado, setUploadingTimbrado] = useState(false);

  function openNew() {
    const emitenteId = filterEmitenteId || empresas?.[0]?.id || "";
    setForm(emptyForm(emitenteId));
  }

  function openEdit(t: any) {
    setForm({ id: t.id, emitenteId: t.emitenteId, tipo: t.tipo, titulo: t.titulo, textoHtml: t.textoHtml, ativo: t.ativo, cabecalhoPath: t.cabecalhoPath });
  }

  function aplicarPadrao(tpl: typeof TPL_CONTRATO | typeof TPL_PROCURACAO) {
    if (!form) return;
    setForm({ ...form, tipo: tpl.tipo, titulo: tpl.titulo, textoHtml: tpl.textoHtml });
    // Aguardar re-render do RichEditor antes de chamar setContent
    setTimeout(() => editorRef.current?.setContent(tpl.textoHtml), 50);
  }

  function inserirVariavel(v: string) {
    editorRef.current?.insertText(v);
  }

  async function uploadTimbrado(file: File) {
    if (!form?.id) return;
    setUploadingTimbrado(true);
    try {
      const token = localStorage.getItem("avoce_token");
      const fd = new FormData();
      fd.append("timbrado", file);
      const res = await fetch(`/api/template-documento/${form.id}/timbrado`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: fd,
      });
      if (!res.ok) throw new Error((await res.json()).error || "Erro ao fazer upload");
      const { cabecalhoPath } = await res.json() as { cabecalhoPath: string };
      setForm({ ...form, cabecalhoPath });
      utils.templateDocumento.listar.invalidate();
    } catch (e: any) {
      alert(e.message);
    }
    setUploadingTimbrado(false);
  }

  async function removerTimbrado() {
    if (!form?.id || !confirm("Remover timbrado?")) return;
    const token = localStorage.getItem("avoce_token");
    await fetch(`/api/template-documento/${form.id}/timbrado`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    setForm({ ...form, cabecalhoPath: null });
    utils.templateDocumento.listar.invalidate();
  }

  async function salvar() {
    if (!form) return;
    setSaving(true);
    try {
      if (form.id) {
        await atualizar.mutateAsync({ id: form.id, titulo: form.titulo, textoHtml: form.textoHtml, tipo: form.tipo, ativo: form.ativo });
      } else {
        await criar.mutateAsync({ emitenteId: form.emitenteId, tipo: form.tipo, titulo: form.titulo, textoHtml: form.textoHtml });
      }
      setForm(null);
    } catch (e: any) {
      alert(e.message || "Erro ao salvar template");
    }
    setSaving(false);
  }

  async function remover(id: string, titulo: string) {
    if (!confirm(`Excluir template "${titulo}"?`)) return;
    await excluir.mutateAsync({ id });
  }

  const tipoLabel = (t: string) => TIPOS.find(x => x.value === t)?.label ?? t;

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Templates de Documentos</h1>
          <p className="text-sm text-gray-500 mt-1">Modelos de contrato e procuração gerados automaticamente ao aceitar uma proposta.</p>
        </div>
        <button onClick={openNew} className="bg-brand-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-brand-700">
          + Novo template
        </button>
      </div>

      {/* Filtros */}
      <div className="mb-4 flex gap-3 flex-wrap">
        <select
          value={filterEmitenteId}
          onChange={e => setFilterEmitenteId(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-brand-400 focus:outline-none"
        >
          <option value="">Todas as empresas</option>
          {empresas?.map(e => (
            <option key={e.id} value={e.id}>{(e as any).nomeFantasia || e.nome}</option>
          ))}
        </select>
        <select
          value={filterTipo}
          onChange={e => setFilterTipo(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-brand-400 focus:outline-none"
        >
          <option value="">Todos os tipos</option>
          {TIPOS.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
      </div>

      {/* Lista */}
      {isLoading ? (
        <p className="text-sm text-gray-400">Carregando...</p>
      ) : !templates?.length ? (
        <div className="bg-white border border-gray-200 rounded-xl p-8 text-center text-gray-400">
          <p className="text-4xl mb-3">📋</p>
          <p className="font-medium">Nenhum template configurado</p>
          <p className="text-sm mt-1">
            {filterTipo === "PROPOSTA"
              ? "Crie templates de corpo de proposta para usar no modal de nova proposta."
              : "Crie templates de contrato ou procuração para gerar automaticamente quando propostas forem aceitas."}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {templates.map((t: any) => (
            <div key={t.id} className="bg-white border border-gray-200 rounded-xl p-4 flex items-center justify-between gap-4">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                    t.tipo === "PROPOSTA"   ? "bg-brand-100 text-brand-700" :
                    t.tipo === "CONTRATO"   ? "bg-blue-100 text-blue-700" :
                    t.tipo === "PROCURACAO" ? "bg-purple-100 text-purple-700" :
                    "bg-gray-100 text-gray-700"
                  }`}>
                    {tipoLabel(t.tipo)}
                  </span>
                  {t.cabecalhoPath && <span className="text-xs text-green-600 bg-green-50 border border-green-200 px-2 py-0.5 rounded">🖼 Timbrado</span>}
                  {!t.ativo && <span className="text-xs text-gray-400 italic">Inativo</span>}
                </div>
                <p className="font-medium text-gray-900 text-sm">{t.titulo}</p>
                <p className="text-xs text-gray-400 mt-0.5">{t.emitente?.nomeFantasia || t.emitente?.nome}</p>
              </div>
              <div className="flex gap-2 flex-shrink-0">
                <button onClick={() => openEdit(t)} className="text-xs px-3 py-1.5 border border-gray-200 rounded-lg hover:bg-gray-50 text-gray-600">Editar</button>
                {t.ativo ? (
                  <button onClick={() => atualizar.mutateAsync({ id: t.id, ativo: false })} className="text-xs px-3 py-1.5 border border-yellow-200 rounded-lg hover:bg-yellow-50 text-yellow-700">Desativar</button>
                ) : (
                  <button onClick={() => atualizar.mutateAsync({ id: t.id, ativo: true })} className="text-xs px-3 py-1.5 border border-green-200 rounded-lg hover:bg-green-50 text-green-700">Ativar</button>
                )}
                <button onClick={() => remover(t.id, t.titulo)} className="text-xs px-3 py-1.5 border border-red-200 rounded-lg hover:bg-red-50 text-red-600">Excluir</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Modal de edição */}
      {form && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-start justify-center p-4 overflow-y-auto">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-4xl my-4">
            <div className="flex items-center justify-between px-6 py-4 border-b">
              <h2 className="text-lg font-semibold text-gray-900">{form.id ? "Editar template" : "Novo template"}</h2>
              <button onClick={() => setForm(null)} className="text-gray-400 hover:text-gray-600 text-2xl font-bold leading-none">×</button>
            </div>

            <div className="px-6 py-5 space-y-4 max-h-[85vh] overflow-y-auto">

              {/* Empresa (só no novo) */}
              {!form.id && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Empresa *</label>
                  <select
                    value={form.emitenteId}
                    onChange={e => setForm({ ...form, emitenteId: e.target.value })}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-brand-400 focus:outline-none"
                  >
                    <option value="">Selecione...</option>
                    {empresas?.map(e => (
                      <option key={e.id} value={e.id}>{(e as any).nomeFantasia || e.nome}</option>
                    ))}
                  </select>
                </div>
              )}

              {/* Tipo + modelo padrão */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Tipo *</label>
                  <select
                    value={form.tipo}
                    onChange={e => setForm({ ...form, tipo: e.target.value as any })}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-brand-400 focus:outline-none"
                  >
                    {TIPOS.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Carregar modelo padrão</label>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => aplicarPadrao(TPL_CONTRATO)}
                      className="flex-1 text-xs border border-blue-200 text-blue-700 rounded-lg px-3 py-2 hover:bg-blue-50 font-medium"
                    >
                      📄 Contrato
                    </button>
                    <button
                      type="button"
                      onClick={() => aplicarPadrao(TPL_PROCURACAO)}
                      className="flex-1 text-xs border border-purple-200 text-purple-700 rounded-lg px-3 py-2 hover:bg-purple-50 font-medium"
                    >
                      📜 Procuração
                    </button>
                  </div>
                </div>
              </div>

              {/* Título */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Título do documento *</label>
                <input
                  value={form.titulo}
                  onChange={e => setForm({ ...form, titulo: e.target.value })}
                  placeholder="Ex: Contrato de Prestação de Serviços Advocatícios"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-brand-400 focus:outline-none"
                />
              </div>

              {/* Inserir variável */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Inserir variável no texto</label>
                <div className="flex flex-wrap gap-1.5">
                  {VARIAVEIS.map(({ v, desc }) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => inserirVariavel(v)}
                      title={desc}
                      className="text-xs bg-brand-50 border border-brand-200 text-brand-700 hover:bg-brand-100 rounded px-2 py-1 font-mono transition-colors"
                    >
                      {v}
                    </button>
                  ))}
                </div>
                <p className="text-xs text-gray-400 mt-1">Clique em uma variável para inserir na posição do cursor.</p>
              </div>

              {/* Editor */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Conteúdo do documento *</label>
                <RichEditor
                  ref={editorRef}
                  value={form.textoHtml}
                  onChange={html => setForm(f => f ? { ...f, textoHtml: html } : f)}
                  minHeight="400px"
                />
              </div>

              {/* Timbrado */}
              <div className="border border-gray-200 rounded-xl p-4 bg-gray-50 space-y-3">
                <div>
                  <p className="text-sm font-medium text-gray-700">Timbrado (cabeçalho do documento)</p>
                  <p className="text-xs text-gray-500 mt-0.5">Imagem que aparece no topo de cada documento gerado. Substitui o cabeçalho padrão com o logo da empresa. Formatos: PNG, JPG. Tamanho recomendado: 800×150px.</p>
                </div>
                {form.cabecalhoPath ? (
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-green-700 bg-green-50 border border-green-200 px-3 py-1.5 rounded-lg">✓ Timbrado configurado</span>
                    <button
                      type="button"
                      onClick={removerTimbrado}
                      className="text-xs text-red-600 border border-red-200 rounded-lg px-3 py-1.5 hover:bg-red-50"
                    >
                      Remover
                    </button>
                    <label className="text-xs text-brand-700 border border-brand-200 rounded-lg px-3 py-1.5 hover:bg-brand-50 cursor-pointer">
                      Substituir
                      <input type="file" accept="image/png,image/jpeg,.docx" className="sr-only" onChange={e => { const f = e.target.files?.[0]; if (f) uploadTimbrado(f); }} />
                    </label>
                  </div>
                ) : (
                  <div>
                    {!form.id ? (
                      <p className="text-xs text-gray-400 italic">Salve o template primeiro para fazer upload do timbrado.</p>
                    ) : (
                      <label className={`inline-flex items-center gap-2 text-sm border-2 border-dashed border-gray-300 rounded-lg px-4 py-3 cursor-pointer hover:border-brand-400 hover:bg-brand-50/30 transition-colors ${uploadingTimbrado ? "opacity-50 pointer-events-none" : ""}`}>
                        <span className="text-gray-400">🖼</span>
                        <span className="text-gray-600 font-medium">{uploadingTimbrado ? "Enviando..." : "Clique para fazer upload do timbrado"}</span>
                        <input type="file" accept="image/png,image/jpeg,.docx" className="sr-only" onChange={e => { const f = e.target.files?.[0]; if (f) uploadTimbrado(f); }} disabled={uploadingTimbrado} />
                      </label>
                    )}
                  </div>
                )}
              </div>

            </div>

            <div className="flex justify-between gap-3 px-6 py-4 border-t bg-gray-50 rounded-b-xl">
              <div>
                {form.id && (
                  <a
                    href={`/api/template-documento/${form.id}/preview.pdf?token=${localStorage.getItem("avoce_token")}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-100 text-gray-700"
                  >
                    👁 Testar documento
                  </a>
                )}
              </div>
              <div className="flex gap-3">
                <button onClick={() => setForm(null)} className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-100">Cancelar</button>
                <button
                  onClick={salvar}
                  disabled={saving || !form.titulo || (!form.id && !form.emitenteId) || form.textoHtml === "<p></p>"}
                  className="px-5 py-2 text-sm bg-brand-600 text-white rounded-lg hover:bg-brand-700 disabled:opacity-50 font-medium"
                >
                  {saving ? "Salvando..." : form.id ? "Salvar alterações" : "Criar template"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
