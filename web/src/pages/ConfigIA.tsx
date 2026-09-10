import { useState, useEffect, useRef } from "react";
import { trpc } from "../lib/trpc";
import { FluxoIATab } from "../components/FluxoIATab";

type Config = {
  id: string;
  chave: string;
  valor: string | null;
  descricao: string | null;
  tipo: string;
  categoria: string | null;
};

type Notificacao = {
  id: string;
  nome: string;
  evento: string;
  destino: string;
  mensagem: string;
  ativo: boolean;
};

const EVENTOS_SUGERIDOS = [
  { value: "qualificacao_completa",            label: "Lead qualificado (Ana concluiu coleta)" },
  { value: "fluxo_concluido",                  label: "Fluxo Daniela concluído (reunião agendada)" },
  { value: "documentos_pessoais",              label: "Cliente enviou documentos pessoais" },
  { value: "documentos_para_revisao",          label: "Documentos gerados — aguardando revisão" },
  { value: "proposta_aceita",                  label: "Proposta aceita / contrato assinado" },
  { value: "solicita_ligacao",                 label: "Lead pede ligação telefônica" },
  { value: "descarte_revisao_humana",          label: "Descarte — aguardando revisão do SDR" },
  { value: "stage_entrada:lead_qualificado",   label: "Entrada em: Lead Qualificado" },
  { value: "stage_entrada:com_closer",         label: "Entrada em: Com Closer" },
  { value: "stage_entrada:lead_sem_resposta",  label: "Entrada em: Sem Resposta" },
  { value: "stage_entrada:lead_indeciso",      label: "Entrada em: Lead Indeciso" },
  { value: "stage_entrada:FECHADO_GANHO",      label: "Entrada em: Fechado Ganho" },
  { value: "stage_entrada:FECHADO_PERDIDO",    label: "Entrada em: Fechado Perdido" },
];

type LlmProvedor = {
  id: string;
  ordem: number;
  provider: "anthropic" | "openai" | "groq" | "gemini" | "deepseek";
  modelo: string;
  apiKey: string;
  ativo: boolean;
};

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Anthropic (Claude)",
  openai:    "OpenAI (GPT)",
  groq:      "Groq (Llama/Mixtral)",
  gemini:    "Google (Gemini)",
  deepseek:  "DeepSeek",
};

const PROVIDER_MODELOS: Record<string, { value: string; label: string }[]> = {
  anthropic: [
    { value: "claude-haiku-4-5-20251001",   label: "Claude Haiku 4.5 (rápido/barato)" },
    { value: "claude-sonnet-4-5",            label: "Claude Sonnet 4.5" },
    { value: "claude-opus-4-5",              label: "Claude Opus 4.5 (mais capaz)" },
  ],
  openai: [
    { value: "gpt-4o-mini",  label: "GPT-4o Mini (rápido/barato)" },
    { value: "gpt-4o",       label: "GPT-4o" },
    { value: "gpt-4-turbo",  label: "GPT-4 Turbo" },
  ],
  groq: [
    { value: "llama-3.3-70b-versatile",     label: "Llama 3.3 70B Versatile" },
    { value: "llama-3.1-8b-instant",        label: "Llama 3.1 8B Instant (rápido)" },
    { value: "mixtral-8x7b-32768",          label: "Mixtral 8x7B" },
  ],
  gemini: [
    { value: "gemini-2.0-flash",             label: "Gemini 2.0 Flash (rápido/barato)" },
    { value: "gemini-2.5-pro-preview-03-25", label: "Gemini 2.5 Pro Preview" },
  ],
  deepseek: [
    { value: "deepseek-v4-pro",   label: "DeepSeek V4 Pro (mais capaz)" },
    { value: "deepseek-v4-flash", label: "DeepSeek V4 Flash (rápido/barato)" },
    { value: "deepseek-chat",     label: "DeepSeek V3" },
    { value: "deepseek-reasoner", label: "DeepSeek R1 (raciocínio)" },
  ],
};

type LlmForm = {
  id?: string;
  ordem: number;
  provider: "anthropic" | "openai" | "groq" | "gemini" | "deepseek";
  modelo: string;
  apiKey: string;
  ativo: boolean;
};

function blankLlmForm(ordem: number): LlmForm {
  return { ordem, provider: "anthropic", modelo: PROVIDER_MODELOS.anthropic[0].value, apiKey: "", ativo: true };
}

function LlmProvedoresCard({ projetoId }: { projetoId: string }) {
  const [isOpen, setIsOpen] = useState(false);
  const [form, setForm] = useState<LlmForm>(blankLlmForm(1));

  const llmProvedores = trpc.ia.listLlmProvedores.useQuery({ projetoId });
  const upsertLlm = trpc.ia.upsertLlmProvedor.useMutation({
    onSuccess: async (_, vars) => {
      const result = await llmProvedores.refetch();
      if (!vars.id) {
        // New entry saved → open fresh form for the next provider
        const nextOrdem = (result.data?.length ?? 0) + 1;
        setForm(blankLlmForm(nextOrdem));
        // keep isOpen = true so user can keep adding
      } else {
        setIsOpen(false);
      }
    },
  });
  const deleteLlm = trpc.ia.deleteLlmProvedor.useMutation({
    onSuccess: () => llmProvedores.refetch(),
  });

  function openNew() {
    const nextOrdem = (llmProvedores.data?.length ?? 0) + 1;
    setForm(blankLlmForm(nextOrdem));
    setIsOpen(true);
  }

  function openEdit(p: LlmProvedor) {
    setForm({ id: p.id, ordem: p.ordem, provider: p.provider, modelo: p.modelo, apiKey: p.apiKey, ativo: p.ativo });
    setIsOpen(true);
  }

  function handleProviderChange(provider: LlmForm["provider"]) {
    const firstModel = PROVIDER_MODELOS[provider]?.[0]?.value ?? "";
    setForm((f) => ({ ...f, provider, modelo: firstModel }));
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    upsertLlm.mutate({
      id:        form.id,
      projetoId,
      ordem:     form.ordem,
      provider:  form.provider,
      modelo:    form.modelo,
      apiKey:    form.apiKey,
      ativo:     form.ativo,
    });
  }

  const provedores = (llmProvedores.data as unknown as LlmProvedor[] | undefined) ?? [];

  return (
    <div className="bg-white border rounded-xl p-5">
      <div className="flex justify-between items-center mb-4">
        <div>
          <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wider">Modelos LLM — Ordem de Preferência</h3>
          <p className="text-xs text-gray-400 mt-0.5">O sistema tenta cada provedor em ordem. Se falhar por crédito/cota, passa pro próximo automaticamente.</p>
        </div>
        {!isOpen && (
          <button
            onClick={openNew}
            className="bg-indigo-600 text-white px-3 py-1.5 rounded-lg text-sm font-medium hover:bg-indigo-700 flex-shrink-0 ml-4"
          >
            + Adicionar
          </button>
        )}
      </div>

      {isOpen && (
        <form onSubmit={handleSubmit} className="bg-gray-50 border rounded-xl p-4 space-y-3 mb-4">
          <div className="flex justify-between items-center">
            <span className="text-sm font-medium text-gray-700">{form.id ? "Editar provedor" : `Novo provedor (ordem ${form.ordem})`}</span>
            <button type="button" onClick={() => setIsOpen(false)} className="text-gray-400 hover:text-gray-600 text-lg leading-none">✕</button>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Ordem (1 = prioridade máxima)</label>
              <input
                type="number" min={1} value={form.ordem}
                onChange={(e) => setForm((f) => ({ ...f, ordem: Number(e.target.value) }))}
                className="w-full border rounded-lg px-3 py-2 text-sm"
                required
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Provedor</label>
              <select
                value={form.provider}
                onChange={(e) => handleProviderChange(e.target.value as LlmForm["provider"])}
                className="w-full border rounded-lg px-3 py-2 text-sm bg-white"
              >
                {Object.entries(PROVIDER_LABELS).map(([v, label]) => (
                  <option key={v} value={v}>{label}</option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Modelo</label>
            <select
              value={form.modelo}
              onChange={(e) => setForm((f) => ({ ...f, modelo: e.target.value }))}
              className="w-full border rounded-lg px-3 py-2 text-sm bg-white"
              required
            >
              {(PROVIDER_MODELOS[form.provider] ?? []).map((m) => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">API Key</label>
            <input
              type="password" value={form.apiKey}
              onChange={(e) => setForm((f) => ({ ...f, apiKey: e.target.value }))}
              placeholder="sk-ant-... / sk-... / gsk_... / AIza..."
              className="w-full border rounded-lg px-3 py-2 text-sm font-mono"
              required
            />
          </div>
          <div className="flex items-center gap-2">
            <input
              type="checkbox" id="llm-ativo" checked={form.ativo}
              onChange={(e) => setForm((f) => ({ ...f, ativo: e.target.checked }))}
              className="rounded"
            />
            <label htmlFor="llm-ativo" className="text-sm text-gray-700">Ativo</label>
          </div>
          <div className="flex gap-2">
            <button
              type="submit" disabled={upsertLlm.isPending}
              className="bg-indigo-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:opacity-50"
            >
              {upsertLlm.isPending ? "Salvando..." : "Salvar"}
            </button>
            <button type="button" onClick={() => setIsOpen(false)} className="border px-4 py-2 rounded-lg text-sm text-gray-600 hover:bg-gray-50">
              Cancelar
            </button>
          </div>
        </form>
      )}

      {provedores.length === 0 && !isOpen && (
        <p className="text-sm text-gray-400 text-center py-4">Nenhum provedor configurado. Clique em + Adicionar para configurar.</p>
      )}

      <div className="space-y-2">
        {provedores.map((p, idx) => {
          const emUso = p.ativo && provedores.slice(0, idx).every(x => !x.ativo);
          const modelLabel = PROVIDER_MODELOS[p.provider]?.find(m => m.value === p.modelo)?.label ?? p.modelo;
          return (
            <div key={p.id} className={`flex items-center gap-3 border rounded-lg px-4 py-3 ${emUso ? "bg-indigo-50 border-indigo-300" : "bg-gray-50"}`}>
              <div className={`w-7 h-7 rounded-full flex items-center justify-center font-bold text-xs flex-shrink-0 ${emUso ? "bg-indigo-600 text-white" : "bg-indigo-100 text-indigo-700"}`}>
                {p.ordem}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium text-gray-800 text-sm">{PROVIDER_LABELS[p.provider] ?? p.provider}</span>
                  {emUso && (
                    <span className="text-xs px-2 py-0.5 rounded-full bg-indigo-600 text-white font-semibold">em uso</span>
                  )}
                  <span className={`text-xs px-2 py-0.5 rounded-full ${p.ativo ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-400"}`}>
                    {p.ativo ? "ativo" : "inativo"}
                  </span>
                </div>
                <p className="text-xs text-gray-600 font-medium mt-0.5">{modelLabel}</p>
                {modelLabel !== p.modelo && <p className="text-xs text-gray-400">{p.modelo}</p>}
              </div>
              <div className="flex gap-2 flex-shrink-0">
                <button onClick={() => openEdit(p)} className="text-xs text-indigo-600 hover:underline">Editar</button>
                <button
                  onClick={() => { if (confirm("Remover este provedor?")) deleteLlm.mutate({ id: p.id, projetoId }); }}
                  className="text-xs text-red-500 hover:underline"
                >
                  Remover
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

type Persona = {
  id: string;
  chave: string;
  nomeExibicao: string;
  systemPrompt: string;
  descricaoPapel: string | null;
  tom: string;
  ordem: number;
  ttsVoiceId: string | null;
  llmProviderChave: string | null;
  midiaApresentacaoPath: string | null;
  midiaApresentacaoTipo: string | null;
  proximaPersonaChave: string | null;
  usarAudio: boolean;
  farewellTexto: string | null;
  ativo: boolean;
};

const CATEGORIA_LABELS: Record<string, string> = {
  llm: "LLM / Claude",
  whatsapp: "WhatsApp (Evolution API)",
  audio: "Áudio (Transcrição)",
  tts: "TTS — Voz (ElevenLabs)",
  ocr: "OCR (Documentos e Imagens)",
  comportamento: "Comportamento",
  pakt: "PAKT (Assinatura)",
  coleta_docs: "Coleta de Documentos",
};

function WhatsappPanel({ projetoId }: { projetoId: string }) {
  const [showQr, setShowQr] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const utils = trpc.useUtils();

  const status = trpc.ia.whatsappStatus.useQuery(
    { projetoId },
    { refetchInterval: showQr ? 4000 : 15000, refetchIntervalInBackground: true }
  );
  const qr = trpc.ia.whatsappQr.useQuery(
    { projetoId },
    { enabled: showQr, refetchInterval: 12000, refetchIntervalInBackground: true, staleTime: 0, gcTime: 0 }
  );
  const desconectar = trpc.ia.whatsappDesconectar.useMutation({
    onSuccess: () => { status.refetch(); setShowQr(false); },
  });

  const isConnected = status.data?.state === "open";
  const isLoading   = status.isLoading;

  useEffect(() => {
    if (isConnected) { setShowQr(false); utils.ia.whatsappStatus.invalidate(); }
  }, [isConnected]);

  const stateLabel: Record<string, { label: string; color: string }> = {
    open:            { label: "Conectado",        color: "text-green-700 bg-green-100" },
    connecting:      { label: "Conectando…",      color: "text-yellow-700 bg-yellow-100" },
    close:           { label: "Desconectado",     color: "text-red-700 bg-red-100" },
    not_configured:  { label: "Não configurado",  color: "text-gray-500 bg-gray-100" },
    error:           { label: "Erro",             color: "text-red-700 bg-red-100" },
    unknown:         { label: "Desconhecido",     color: "text-gray-500 bg-gray-100" },
  };
  const st = stateLabel[status.data?.state ?? "unknown"] ?? stateLabel.unknown;

  return (
    <div className="mt-4 border-t pt-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-gray-700">Status WhatsApp</span>
          {isLoading
            ? <span className="text-xs text-gray-400">verificando…</span>
            : <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${st.color}`}>{st.label}</span>
          }
          {status.data?.instancia && (
            <span className="text-xs text-gray-400">({status.data.instancia})</span>
          )}
        </div>
        <div className="flex gap-2">
          {!isConnected && (
            <button
              onClick={() => setShowQr(v => !v)}
              className="text-xs px-3 py-1.5 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700"
            >
              {showQr ? "Ocultar QR" : "Conectar via QR"}
            </button>
          )}
          {isConnected && (
            <button
              onClick={() => desconectar.mutate({ projetoId })}
              disabled={desconectar.isPending}
              className="text-xs px-3 py-1.5 border border-red-300 text-red-600 rounded-lg hover:bg-red-50 disabled:opacity-50"
            >
              Desconectar
            </button>
          )}
          <button onClick={() => status.refetch()} className="text-xs text-gray-400 hover:text-gray-600">↻</button>
        </div>
      </div>

      {showQr && !isConnected && (
        <div className="flex flex-col items-center gap-3 py-4">
          {qr.isLoading && <p className="text-sm text-gray-400">Gerando QR code…</p>}
          {"error" in (qr.data ?? {}) && <p className="text-sm text-red-500">{(qr.data as any)?.error}</p>}
          {qr.data?.qrcode && (
            <>
              <img
                key={qr.dataUpdatedAt}
                src={qr.data.qrcode}
                alt="QR Code WhatsApp"
                className="w-56 h-56 border rounded-xl shadow"
              />
              <p className="text-xs text-gray-500">Abra o WhatsApp → Dispositivos vinculados → Vincular dispositivo</p>
              <button
                onClick={() => qr.refetch()}
                className="text-xs px-3 py-1 bg-gray-100 rounded-lg hover:bg-gray-200"
              >
                ↻ Atualizar QR agora
              </button>
              <p className="text-xs text-gray-400">Atualiza sozinho a cada 12s. Se falhar, toque em Atualizar e escaneie na hora.</p>
            </>
          )}
        </div>
      )}
    </div>
  );
}

type Pergunta = {
  id: string;
  chave: string;
  perguntaContexto: string;
  exemploAbordagem: string | null;
  tipoDado: string;
  obrigatorio: boolean;
  ordem: number;
  stageColeta: string | null;
  dependeDe: string | null;
  ativaSeResposta: string | null;
};

type Regra = {
  id: string;
  stageOrigemChave: string | null;
  stageDestinoChave: string;
  condicao: string;
  acaoAdicional: string | null;
  parametros: Record<string, unknown> | null;
  ordem: number;
  requerPrescricaoAtiva: boolean;
};

const BLANK_PERGUNTA = (): Partial<Pergunta> => ({
  chave: "", perguntaContexto: "", exemploAbordagem: "", tipoDado: "texto",
  obrigatorio: true, ordem: 99, stageColeta: "lead_carreteiro",
  dependeDe: "", ativaSeResposta: "",
});

const BLANK_REGRA = (): Partial<Regra> => ({
  stageOrigemChave: "", stageDestinoChave: "", condicao: "", acaoAdicional: "",
  parametros: null, ordem: 0, requerPrescricaoAtiva: false,
});

import ConfigAudiencias from "../components/ConfigAudiencias";

export default function ConfigIAPage() {
  const [projetoId, setProjetoId] = useState<string | null>(null);
  const [tab, setTab] = useState<"configs" | "personas" | "fases" | "notificacoes" | "qualificacao" | "transicoes" | "proposta" | "fluxo" | "followup" | "desqualificacao" | "audiencias">("configs");
  const [followUpExpanded, setFollowUpExpanded] = useState(false);
  const [followUpMsgExpanded, setFollowUpMsgExpanded] = useState(false);
  const [stageFollowExpanded, setStageFollowExpanded] = useState<Record<string, boolean>>({});
  const [editando, setEditando] = useState<Record<string, string>>({});
  const [editPersona, setEditPersona] = useState<Persona | null>(null);
  const [editNotif, setEditNotif] = useState<Partial<Notificacao> | null>(null);
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [editPergunta, setEditPergunta] = useState<Partial<Pergunta> | null>(null);
  const [editRegra, setEditRegra] = useState<Partial<Regra> | null>(null);
  const [palavrasLigacaoEdit, setPalavrasLigacaoEdit] = useState<string | null>(null);
  const [lembretesEdit, setLembretesEdit] = useState<{ horas: number; texto: string }[] | null>(null);
  const [midiaUploading, setMidiaUploading] = useState<string | null>(null); // personaId being uploaded

  const projetos = trpc.ia.listProjetos.useQuery();
  const configs = trpc.ia.listConfigs.useQuery(
    { projetoId: projetoId ?? "" },
    { enabled: !!projetoId }
  );
  const personas = trpc.ia.listPersonas.useQuery(
    { projetoId: projetoId ?? "" },
    { enabled: !!projetoId }
  );
  const llmProvedoresPage = trpc.ia.listLlmProvedores.useQuery(
    { projetoId: projetoId ?? "" },
    { enabled: !!projetoId }
  );
  const provedoresPage = (llmProvedoresPage.data as unknown as LlmProvedor[] | undefined) ?? [];
  const fases = trpc.ia.listFases.useQuery(
    { projetoId: projetoId ?? "" },
    { enabled: !!projetoId }
  );
  const notificacoes = trpc.ia.listNotificacoes.useQuery(
    { projetoId: projetoId ?? "" },
    { enabled: !!projetoId }
  );

  const perguntas = trpc.ia.listPerguntas.useQuery(
    { projetoId: projetoId ?? "" },
    { enabled: !!projetoId }
  );
  const regras = trpc.ia.listRegras.useQuery(
    { projetoId: projetoId ?? "" },
    { enabled: !!projetoId }
  );



  const empresas = trpc.empresa.listar.useQuery(undefined, { enabled: tab === "proposta" });
  const seedPropostaConfigs = trpc.ia.seedPropostaConfigs.useMutation({ onSuccess: () => configs.refetch() });

  // Proposta tab: load templates when emitenteId is known
  const propostaEmitenteId = (configs.data as unknown as Config[] | undefined)?.find(c => c.chave === "proposta_emitente_id")?.valor ?? "";
  const templatesContrato   = trpc.templateDocumento.listar.useQuery(
    { emitenteId: propostaEmitenteId || undefined, tipo: "CONTRATO" },
    { enabled: tab === "proposta" && !!projetoId }
  );
  const templatesProcuracao = trpc.templateDocumento.listar.useQuery(
    { emitenteId: propostaEmitenteId || undefined, tipo: "PROCURACAO" },
    { enabled: tab === "proposta" && !!projetoId }
  );
  const templatesProposta   = trpc.templateDocumento.listar.useQuery(
    { emitenteId: propostaEmitenteId || undefined, tipo: "PROPOSTA" },
    { enabled: tab === "proposta" && !!projetoId }
  );

  const upsertConfig = trpc.ia.upsertConfig.useMutation({
    onSuccess: () => configs.refetch(),
  });
  const setPersonaAtiva = trpc.ia.setPersonaAtiva.useMutation({
    onSuccess: () => personas.refetch(),
  });
  const upsertPersona = trpc.ia.upsertPersona.useMutation({
    onSuccess: () => {
      personas.refetch();
      setEditPersona(null);
    },
  });
  const clearPersonaMidia = trpc.ia.clearPersonaMidia.useMutation({
    onSuccess: () => personas.refetch(),
  });

  async function uploadPersonaMidia(personaId: string, file: File) {
    setMidiaUploading(personaId);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const token = localStorage.getItem("avoce_token");
      const res = await fetch(`/api/ia-persona-midia/${personaId}`, {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: fd,
      });
      if (!res.ok) throw new Error(await res.text());
      personas.refetch();
    } catch (e) {
      alert("Erro ao enviar mídia: " + (e instanceof Error ? e.message : e));
    } finally {
      setMidiaUploading(null);
    }
  }
  const seedCarreteiros = trpc.ia.seedCarreteiros.useMutation({
    onSuccess: (data) => {
      setProjetoId(data.projetoId);
      projetos.refetch();
    },
  });
  const seedCarreteiro3 = trpc.ia.seedCarreteiro3.useMutation({
    onSuccess: (data) => {
      setProjetoId(data.projetoId);
      projetos.refetch();
    },
  });
  const seedAudio = trpc.ia.seedAudioConfigs.useMutation({
    onSuccess: () => configs.refetch(),
  });
  const seedTts = trpc.ia.seedTtsConfigs.useMutation({
    onSuccess: () => configs.refetch(),
  });
  const upsertNotif = trpc.ia.upsertNotificacao.useMutation({
    onSuccess: () => { notificacoes.refetch(); setEditNotif(null); },
  });
  const deleteNotif = trpc.ia.deleteNotificacao.useMutation({
    onSuccess: () => notificacoes.refetch(),
  });
  const upsertPergunta = trpc.ia.upsertPergunta.useMutation({
    onSuccess: () => { perguntas.refetch(); setEditPergunta(null); },
  });
  const deletePergunta = trpc.ia.deletePergunta.useMutation({
    onSuccess: () => perguntas.refetch(),
  });
  const upsertRegra = trpc.ia.upsertRegra.useMutation({
    onSuccess: () => { regras.refetch(); setEditRegra(null); },
  });
  const deleteRegra = trpc.ia.deleteRegra.useMutation({
    onSuccess: () => regras.refetch(),
  });

  // Follow-up PAKT
  const followUpConfigs = trpc.ia.getFollowUpConfigs.useQuery(
    { projetoId: projetoId ?? "" },
    { enabled: !!projetoId && tab === "followup" }
  );
  const saveFollowUpConfig = trpc.ia.saveFollowUpConfig.useMutation({
    onSuccess: () => followUpConfigs.refetch(),
  });

  // Stage follow-up (per-persona)
  const STAGE_FOLLOWUP_DEFS = [
    { stageChave: "lead_carreteiro",          label: "Ana SDR — Qualificação",      persona: "assistente", cor: "blue",   desc: "Lead para de responder durante a qualificação" },
    { stageChave: "lead_qualificado",         label: "Dra. Daniela — Fechamento",   persona: "advogado",   cor: "purple", desc: "Lead qualificado não agenda/avança para contrato" },
    { stageChave: "aguardando_reuniao",       label: "Lembrete de Reunião",          persona: "advogado",   cor: "green",  desc: "Confirmações e lembretes de reunião agendada" },
    { stageChave: "aguardando_docs_pessoais", label: "Ana Coleta — Documentos",      persona: "advogado",   cor: "orange", desc: "Lead para de enviar documentos durante a coleta" },
    { stageChave: "aguardando_assinatura",    label: "Assinatura — Contrato",        persona: "advogado",   cor: "red",    desc: "Contrato enviado mas não assinado (reengajamento)" },
  ] as const;

  // Load all stage follow-up configs at once when on follow-up tab
  const stageFollowUpQueries = STAGE_FOLLOWUP_DEFS.map(def =>
    // eslint-disable-next-line react-hooks/rules-of-hooks
    trpc.ia.getStageFollowUp.useQuery(
      { projetoId: projetoId ?? "", stageChave: def.stageChave },
      { enabled: !!projetoId && tab === "followup" }
    )
  );
  const saveStageFollowUp = trpc.ia.saveStageFollowUp.useMutation();

  // Local state for stage follow-up editing
  const [stageFollowLocal, setStageFollowLocal] = useState<Record<string, { ativo: boolean; mensagens: { delayHoras: number; template: string }[] }>>({});

  // Auto-select first projeto
  useEffect(() => {
    if (!projetoId && projetos.data?.[0]) {
      setProjetoId(projetos.data[0].id);
    }
  }, [projetos.data]);

  // Initialize editable values
  useEffect(() => {
    if (configs.data) {
      const vals: Record<string, string> = {};
      for (const c of (configs.data as unknown as Config[])) {
        vals[c.chave] = c.valor ?? "";
      }
      setEditando(vals);
    }
  }, [configs.data]);

  async function saveConfig(chave: string) {
    if (!projetoId) return;
    setSaving((s) => ({ ...s, [chave]: true }));
    try {
      const cfg = (configs.data as unknown as Config[]).find((c) => c.chave === chave);
      await upsertConfig.mutateAsync({
        projetoId,
        chave,
        valor: editando[chave] ?? "",
        tipo: cfg?.tipo,
        categoria: cfg?.categoria ?? undefined,
        descricao: cfg?.descricao ?? undefined,
      });
    } finally {
      setSaving((s) => ({ ...s, [chave]: false }));
    }
  }

  function savePersona(e: React.FormEvent) {
    e.preventDefault();
    if (!projetoId || !editPersona) return;
    upsertPersona.mutate({
      projetoId,
      chave: editPersona.chave,
      nomeExibicao: editPersona.nomeExibicao,
      systemPrompt: editPersona.systemPrompt,
      descricaoPapel: editPersona.descricaoPapel ?? undefined,
      tom: editPersona.tom,
      ordem: editPersona.ordem,
      ttsVoiceId: editPersona.ttsVoiceId || undefined,
      llmProviderChave: editPersona.llmProviderChave || null,
      proximaPersonaChave: editPersona.proximaPersonaChave || null,
      usarAudio: editPersona.usarAudio ?? false,
      farewellTexto: editPersona.farewellTexto || null,
    });
  }

  // Group configs by category — exclude managed categories that have dedicated UI sections
  const EXCLUDED_CATS = new Set(["llm", "tts", "proposta", "follow_up", "reuniao", "coleta_docs", "integracao"]);
  const configsByCategory: Record<string, Config[]> = {};
  for (const c of (configs.data as unknown as Config[]) ?? []) {
    const cat = c.categoria ?? "outros";
    if (EXCLUDED_CATS.has(cat)) continue;
    if (!configsByCategory[cat]) configsByCategory[cat] = [];
    configsByCategory[cat].push(c);
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">Configurações IA</h1>
          <p className="text-gray-500 text-sm mt-1">Agente WhatsApp autônomo</p>
        </div>

        <div className="flex items-center gap-3">
          {projetos.data && (
            <select
              value={projetoId ?? ""}
              onChange={(e) => setProjetoId(e.target.value)}
              className="border rounded-lg px-3 py-2 text-sm"
            >
              {projetos.data.length === 0 && <option value="">Nenhum projeto</option>}
              {projetos.data.map((p) => (
                <option key={p.id} value={p.id}>{p.nome}</option>
              ))}
            </select>
          )}

          {projetos.data?.length === 0 && (
            <button
              onClick={() => seedCarreteiros.mutate()}
              disabled={seedCarreteiros.isLoading}
              className="bg-indigo-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:opacity-50"
            >
              {seedCarreteiros.isLoading ? "Criando..." : "+ Projeto Carreteiros"}
            </button>
          )}
        </div>
      </div>

      {!projetoId ? (
        <div className="text-center py-16 text-gray-400">
          <p className="text-4xl mb-3">🤖</p>
          <p className="font-medium">Nenhum projeto configurado</p>
          <p className="text-sm mt-1">Clique em "+ Projeto Carreteiros" para criar o seed inicial</p>
        </div>
      ) : (
        <>
          {/* Tabs */}
          <div className="flex flex-wrap gap-1 mb-6 bg-gray-100 p-1 rounded-lg w-fit">
            {([
              ["configs", "Configurações"],
              ["personas", "Personas"],
              ["fases", "Fases"],
              ["qualificacao", "Qualificação"],
              ["fluxo", "Fluxo IA"],
              ["transicoes", "Transições"],
              ["notificacoes", "Notificações"],
              ["proposta", "Proposta"],
              ["followup", "Follow-up"],
              ["desqualificacao", "🚫 Desqualificação"],
              ["audiencias", "⚖️ Audiências"],
            ] as const).map(([t, label]) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
                  tab === t ? "bg-white shadow text-gray-800" : "text-gray-500 hover:text-gray-700"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {tab === "audiencias" && projetoId && <ConfigAudiencias projetoId={projetoId} />}

          {/* Configs tab */}
          {tab === "configs" && (
            <div className="space-y-6">
              {!configsByCategory.audio && projetoId && (
                <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-amber-800">Configuração de áudio não encontrada</p>
                    <p className="text-xs text-amber-600 mt-0.5">Adicione as configs de transcrição de áudio (Groq / OpenAI Whisper)</p>
                  </div>
                  <button
                    onClick={() => projetoId && seedAudio.mutate({ projetoId })}
                    disabled={seedAudio.isPending}
                    className="text-sm px-4 py-2 bg-amber-600 text-white rounded-lg hover:bg-amber-700 disabled:opacity-50 flex-shrink-0 ml-4"
                  >
                    {seedAudio.isPending ? "Adicionando..." : "+ Configurar Áudio"}
                  </button>
                </div>
              )}
              {Object.entries(configsByCategory as Record<string, Config[]>).map(([cat, items]) => (
                <div key={cat} className="bg-white border rounded-xl p-5">
                  <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-4">
                    {CATEGORIA_LABELS[cat] ?? cat}
                  </h3>
                  <div className="space-y-4">
                    {items.map((cfg) => (
                      <div key={cfg.chave}>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          {cfg.descricao ?? cfg.chave}
                          {cfg.tipo === "senha" && (
                            <span className="ml-2 text-xs bg-yellow-100 text-yellow-700 px-1.5 py-0.5 rounded">secret</span>
                          )}
                        </label>
                        <div className="flex gap-2">
                          {cfg.chave === "audio_provider" ? (
                            <select
                              value={editando[cfg.chave] ?? "groq"}
                              onChange={(e) => setEditando((prev) => ({ ...prev, [cfg.chave]: e.target.value }))}
                              className="flex-1 border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
                            >
                              <option value="groq">Groq (whisper-large-v3-turbo, gratuito)</option>
                              <option value="openai">OpenAI (whisper-1, $0.006/min)</option>
                            </select>
                          ) : cfg.chave === "audio_model" ? (
                            <select
                              value={editando[cfg.chave] ?? "whisper-large-v3-turbo"}
                              onChange={(e) => setEditando((prev) => ({ ...prev, [cfg.chave]: e.target.value }))}
                              className="flex-1 border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
                            >
                              <option value="whisper-large-v3-turbo">whisper-large-v3-turbo (rápido)</option>
                              <option value="whisper-large-v3">whisper-large-v3 (máxima precisão)</option>
                              <option value="whisper-1">whisper-1 (OpenAI)</option>
                            </select>
                          ) : (
                            <input
                              type={cfg.tipo === "senha" ? "password" : "text"}
                              value={editando[cfg.chave] ?? ""}
                              onChange={(e) =>
                                setEditando((prev) => ({ ...prev, [cfg.chave]: e.target.value }))
                              }
                              onKeyDown={(e) => e.key === "Enter" && saveConfig(cfg.chave)}
                              placeholder={cfg.tipo === "senha" ? "••••••••" : ""}
                              className="flex-1 border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
                            />
                          )}
                          <button
                            onClick={() => saveConfig(cfg.chave)}
                            disabled={saving[cfg.chave]}
                            className="bg-indigo-600 text-white px-3 py-2 rounded-lg text-sm hover:bg-indigo-700 disabled:opacity-50"
                          >
                            {saving[cfg.chave] ? "..." : "Salvar"}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                  {cat === "whatsapp" && projetoId && (
                    <WhatsappPanel projetoId={projetoId} />
                  )}
                </div>
              ))}

              {/* LLM Provedores — inside Configs tab */}
              {projetoId && <LlmProvedoresCard projetoId={projetoId} />}

              {/* TTS — Voz (ElevenLabs) */}
              {projetoId && (() => {
                const cfgData = (configs.data as unknown as Config[] | undefined) ?? [];
                const ttsApiKey = cfgData.find(c => c.chave === "tts_api_key");
                const ttsModel  = cfgData.find(c => c.chave === "tts_model");
                const ttsMoments = cfgData.find(c => c.categoria === "tts" && c.chave === "tts_momentos_audio");

                if (!ttsApiKey) {
                  return (
                    <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex items-center justify-between">
                      <div>
                        <p className="text-sm font-medium text-amber-800">TTS (ElevenLabs) não configurado</p>
                        <p className="text-xs text-amber-600 mt-0.5">Adicione as configurações de voz para enviar áudios via ElevenLabs</p>
                      </div>
                      <button
                        onClick={() => seedTts.mutate({ projetoId: projetoId! })}
                        disabled={seedTts.isPending}
                        className="text-sm px-4 py-2 bg-amber-600 text-white rounded-lg hover:bg-amber-700 disabled:opacity-50 flex-shrink-0 ml-4"
                      >
                        {seedTts.isPending ? "Adicionando..." : "+ Configurar TTS"}
                      </button>
                    </div>
                  );
                }

                const MOMENTOS_DISPONIVEIS = [
                  { key: "primeira_mensagem",  label: "Primeira mensagem (novo lead)" },
                  { key: "parecer",            label: "Parecer com valor estimado (Dra. Daniela)" },
                  { key: "closer_tentativa_1", label: "Closer: lembrete de prescrição" },
                  { key: "closer_tentativa_2", label: "Closer: segunda tentativa" },
                ];
                const momentosAtivos = (ttsMoments?.valor ?? "").split(",").map((m: string) => m.trim()).filter(Boolean);
                const toggleMomento = (key: string) => {
                  const atuais = (ttsMoments?.valor ?? "").split(",").map((m: string) => m.trim()).filter(Boolean);
                  const novos = atuais.includes(key) ? atuais.filter((m: string) => m !== key) : [...atuais, key];
                  upsertConfig.mutate({ projetoId: projetoId!, chave: "tts_momentos_audio", valor: novos.join(","), tipo: "texto", categoria: "tts", descricao: "Momentos para envio de áudio TTS" }, { onSuccess: () => configs.refetch() });
                };

                return (
                  <div className="bg-white border rounded-xl p-5 space-y-5">
                    <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wider">TTS — Voz (ElevenLabs)</h3>

                    {/* API Key */}
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        API Key ElevenLabs
                        <span className="ml-2 text-xs bg-yellow-100 text-yellow-700 px-1.5 py-0.5 rounded">secret</span>
                      </label>
                      <div className="flex gap-2">
                        <input
                          type="password"
                          value={editando["tts_api_key"] ?? ""}
                          onChange={(e) => setEditando(prev => ({ ...prev, tts_api_key: e.target.value }))}
                          onKeyDown={(e) => e.key === "Enter" && saveConfig("tts_api_key")}
                          placeholder="••••••••"
                          className="flex-1 border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
                        />
                        <button onClick={() => saveConfig("tts_api_key")} disabled={saving["tts_api_key"]} className="bg-indigo-600 text-white px-3 py-2 rounded-lg text-sm hover:bg-indigo-700 disabled:opacity-50">
                          {saving["tts_api_key"] ? "..." : "Salvar"}
                        </button>
                      </div>
                    </div>

                    {/* Modelo */}
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Modelo TTS</label>
                      <div className="flex gap-2">
                        <select
                          value={editando["tts_model"] ?? ttsModel?.valor ?? "eleven_multilingual_v2"}
                          onChange={(e) => setEditando(prev => ({ ...prev, tts_model: e.target.value }))}
                          className="flex-1 border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
                        >
                          <option value="eleven_multilingual_v2">eleven_multilingual_v2 (qualidade, multilíngue)</option>
                          <option value="eleven_turbo_v2_5">eleven_turbo_v2_5 (rápido, baixa latência)</option>
                          <option value="eleven_flash_v2_5">eleven_flash_v2_5 (ultra-rápido)</option>
                        </select>
                        <button onClick={() => saveConfig("tts_model")} disabled={saving["tts_model"]} className="bg-indigo-600 text-white px-3 py-2 rounded-lg text-sm hover:bg-indigo-700 disabled:opacity-50">
                          {saving["tts_model"] ? "..." : "Salvar"}
                        </button>
                      </div>
                    </div>

                    {/* Momentos de Áudio */}
                    <div>
                      <p className="text-sm font-medium text-gray-700 mb-1">Momentos de envio de áudio</p>
                      <p className="text-xs text-gray-500 mb-3">
                        Nesses momentos a persona envia um PTT (bolha de voz) em vez de texto. O Voice ID é configurado em cada persona.
                      </p>
                      <div className="space-y-2">
                        {MOMENTOS_DISPONIVEIS.map((m) => (
                          <label key={m.key} className="flex items-center gap-3 cursor-pointer select-none">
                            <input type="checkbox" checked={momentosAtivos.includes(m.key)} onChange={() => toggleMomento(m.key)} className="rounded w-4 h-4 accent-indigo-600" />
                            <span className="text-sm text-gray-700">{m.label}</span>
                            <code className="text-xs text-gray-400 bg-gray-50 px-1.5 py-0.5 rounded">{m.key}</code>
                          </label>
                        ))}
                      </div>
                    </div>
                  </div>
                );
              })()}

              {/* Horário Comercial */}
              {projetoId && (() => {
                const cfgIni = (configs.data as unknown as Config[] | undefined)?.find(
                  (c) => c.categoria === "comportamento" && c.chave === "horario_ini"
                );
                const cfgFim = (configs.data as unknown as Config[] | undefined)?.find(
                  (c) => c.categoria === "comportamento" && c.chave === "horario_fim"
                );
                const iniVal = cfgIni?.valor ?? "6";
                const fimVal = cfgFim?.valor ?? "22";
                return (
                  <div className="bg-white border rounded-xl p-5">
                    <div className="mb-4">
                      <h3 className="font-semibold text-gray-800 text-sm">Horário Comercial</h3>
                      <p className="text-xs text-gray-500 mt-1">
                        Mensagens proativas do cron (Closer, follow-ups, intro Daniela) só são enviadas dentro deste horário.
                        Respostas a mensagens recebidas <strong>não são afetadas</strong>.
                      </p>
                    </div>
                    <div className="flex gap-4 items-end">
                      {([
                        { chave: "horario_ini", label: "Início (h)", defaultVal: "6", currentVal: iniVal },
                        { chave: "horario_fim", label: "Fim (h)", defaultVal: "22", currentVal: fimVal },
                      ] as const).map(({ chave, label, defaultVal, currentVal }) => (
                        <div key={chave} className="flex-1">
                          <label className="block text-xs font-medium text-gray-600 mb-1">{label}</label>
                          <input
                            type="number"
                            min={0}
                            max={23}
                            defaultValue={currentVal}
                            onBlur={(e) => {
                              const v = Math.max(0, Math.min(23, parseInt(e.target.value, 10) || parseInt(defaultVal, 10)));
                              e.target.value = String(v);
                              upsertConfig.mutate({
                                projetoId: projetoId!,
                                chave,
                                valor: String(v),
                                tipo: "numero",
                                categoria: "comportamento",
                                descricao: chave === "horario_ini"
                                  ? "Hora de início do horário comercial (0–23, Brasília)"
                                  : "Hora de fim do horário comercial (0–23, Brasília)",
                              }, { onSuccess: () => configs.refetch() });
                            }}
                            className="w-full border rounded-lg px-3 py-2 text-sm text-center"
                          />
                        </div>
                      ))}
                      <div className="flex-1 text-xs text-gray-400 pb-2">
                        Fuso: <span className="font-mono">America/Sao_Paulo</span>
                      </div>
                    </div>
                  </div>
                );
              })()}


              {/* ── Coleta de Documentos (coleta_docs) ────────────────────── */}
              {projetoId && (() => {
                const cfgs = (configs.data as unknown as Config[] | undefined) ?? [];
                const get = (k: string) => cfgs.find(c => c.chave === k)?.valor ?? "";
                const lerTranscricao   = get("coleta_docs_ler_transcricao")   || "true";
                const lerPastaDocs     = get("coleta_docs_ler_pasta_docs")     || "true";
                const docsObrig        = get("coleta_docs_docs_obrigatorios")  || "cnh,comprovante_endereco";
                const confirmacao      = get("coleta_docs_confirmacao_usuario")|| "true";
                const docOpcional      = get("coleta_docs_doc_opcional")       || "false";
                const docRecusaResp    = get("coleta_docs_doc_recusa_resposta")|| "";

                const toggle = (chave: string, valor: string, descricao: string) =>
                  upsertConfig.mutate({ projetoId: projetoId!, chave, valor, tipo: "booleano", categoria: "coleta_docs", descricao },
                    { onSuccess: () => configs.refetch() });

                return (
                  <div className="bg-white border rounded-xl p-5">
                    <div className="mb-4">
                      <h3 className="font-semibold text-gray-800 text-sm">Coleta de Documentos (Ana → coleta_docs)</h3>
                      <p className="text-xs text-gray-500 mt-1">
                        Quando o fluxo <code className="bg-gray-100 px-1 rounded">coleta_docs</code> inicia, a Ana lê automaticamente
                        a transcrição da reunião e a pasta de documentos para pré-preencher os dados do cliente —
                        apenas campos ainda não coletados são perguntados.
                      </p>
                    </div>

                    <div className="space-y-4">
                      {/* Ler transcrição */}
                      <label className="flex items-start gap-3 cursor-pointer">
                        <input type="checkbox" checked={lerTranscricao === "true"}
                          onChange={(e) => toggle("coleta_docs_ler_transcricao", e.target.checked ? "true" : "false",
                            "Ler transcrição da reunião (parcial e finalizada) para pré-preencher dados do cliente")}
                          className="mt-0.5 h-4 w-4 rounded text-indigo-600" />
                        <div>
                          <p className="text-sm font-medium text-gray-700">Ler transcrição da reunião</p>
                          <p className="text-xs text-gray-500">
                            Lê transcrições parciais (em andamento) e finalizadas. O closer pode
                            adicionar notas em tempo real durante a reunião e a Ana já usa esse conteúdo
                            para pré-preencher nome, CPF, endereço, etc.
                          </p>
                        </div>
                      </label>

                      {/* Ler pasta de documentos */}
                      <label className="flex items-start gap-3 cursor-pointer">
                        <input type="checkbox" checked={lerPastaDocs === "true"}
                          onChange={(e) => toggle("coleta_docs_ler_pasta_docs", e.target.checked ? "true" : "false",
                            "Ler pasta de documentos do deal para detectar CNH e comprovante já recebidos")}
                          className="mt-0.5 h-4 w-4 rounded text-indigo-600" />
                        <div>
                          <p className="text-sm font-medium text-gray-700">Ler pasta de documentos</p>
                          <p className="text-xs text-gray-500">
                            Detecta CNH, RG e comprovante de endereço já recebidos. Se presentes,
                            os passos de solicitação desses documentos são pulados automaticamente.
                            Campos extraídos pelo OCR (nome, CPF, RG) também são aproveitados.
                          </p>
                        </div>
                      </label>

                      {/* Documentos obrigatórios */}
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          Documentos obrigatórios
                        </label>
                        <input
                          defaultValue={docsObrig}
                          onBlur={(e) =>
                            upsertConfig.mutate({
                              projetoId: projetoId!,
                              chave: "coleta_docs_docs_obrigatorios",
                              valor: e.target.value.trim() || "cnh,comprovante_endereco",
                              tipo: "texto",
                              categoria: "coleta_docs",
                              descricao: "Documentos obrigatórios separados por vírgula: cnh, comprovante_endereco",
                            }, { onSuccess: () => configs.refetch() })
                          }
                          placeholder="cnh,comprovante_endereco"
                          className="w-full border rounded-lg px-3 py-2 text-sm font-mono"
                        />
                        <p className="text-xs text-gray-400 mt-1">
                          Valores possíveis: <code className="bg-gray-100 px-1 rounded">cnh</code>,{" "}
                          <code className="bg-gray-100 px-1 rounded">comprovante_endereco</code>.
                          Remova um valor para não exigi-lo.
                        </p>
                      </div>

                      {/* Confirmar antes de gerar */}
                      <label className="flex items-start gap-3 cursor-pointer">
                        <input type="checkbox" checked={confirmacao === "true"}
                          onChange={(e) => toggle("coleta_docs_confirmacao_usuario", e.target.checked ? "true" : "false",
                            "Exigir confirmação do cliente antes de gerar contrato e procuração")}
                          className="mt-0.5 h-4 w-4 rounded text-indigo-600" />
                        <div>
                          <p className="text-sm font-medium text-gray-700">Confirmar dados antes de gerar documentos</p>
                          <p className="text-xs text-gray-500">
                            A Ana exibe um resumo de todos os dados coletados e aguarda o cliente confirmar
                            antes de gerar contrato e procuração. Se desmarcado, os documentos são gerados
                            automaticamente assim que todos os dados forem coletados.
                          </p>
                        </div>
                      </label>

                      {/* Documentos opcionais */}
                      <label className="flex items-start gap-3 cursor-pointer">
                        <input type="checkbox" checked={docOpcional === "true"}
                          onChange={(e) => toggle("coleta_docs_doc_opcional", e.target.checked ? "true" : "false",
                            "Se true, o lead pode recusar o envio de documentos sem travar o fluxo")}
                          className="mt-0.5 h-4 w-4 rounded text-indigo-600" />
                        <div>
                          <p className="text-sm font-medium text-gray-700">Fotos de documentos são opcionais</p>
                          <p className="text-xs text-gray-500">
                            Se habilitado, quando o lead recusar enviar a foto da CNH ou comprovante de endereço,
                            a Ana avança o fluxo e gera contrato/procuração com os dados textuais já coletados.
                          </p>
                        </div>
                      </label>

                      {docOpcional === "true" && (
                        <div className="space-y-1">
                          <label className="block text-sm font-medium text-gray-700">
                            Mensagem ao recusar documento
                          </label>
                          <textarea
                            rows={3}
                            defaultValue={docRecusaResp || "Tudo bem! Vou precisar dessa documentação para finalizar o contrato, mas já vou avançar com os dados que você informou. O contrato e a procuração serão gerados com as informações fornecidas."}
                            onBlur={(e) => {
                              if (!projetoId) return;
                              upsertConfig.mutate({
                                projetoId, chave: "coleta_docs_doc_recusa_resposta",
                                valor: e.target.value, tipo: "string", categoria: "coleta_docs",
                                descricao: "Mensagem enviada quando o lead recusa enviar foto de documento",
                              }, { onSuccess: () => configs.refetch() });
                            }}
                            className="w-full border rounded-lg px-3 py-2 text-sm resize-none"
                            placeholder="Tudo bem! Vou precisar dessa documentação futuramente..."
                          />
                          <p className="text-xs text-gray-400">
                            Salvo automaticamente ao sair do campo.
                          </p>
                        </div>
                      )}

                      <div className="mt-2 p-3 bg-indigo-50 border border-indigo-200 rounded-lg text-xs text-indigo-800 space-y-1">
                        <p><strong>Fluxo completo:</strong></p>
                        <ol className="list-decimal list-inside space-y-0.5 ml-1">
                          <li>Ana entra na fase <code className="bg-indigo-100 px-1 rounded">coleta_docs</code></li>
                          <li>Lê transcrição + pasta de docs → pré-preenche dados e detecta documentos</li>
                          <li>Pergunta apenas o que ainda falta (nome, CPF, RG, endereço…)</li>
                          <li>Se CNH não recebida → solicita foto da CNH</li>
                          <li>Se comprovante não recebido → solicita comprovante</li>
                          <li>Exibe resumo dos dados → aguarda confirmação do cliente (se habilitado)</li>
                          <li>Gera contrato + procuração automaticamente</li>
                        </ol>
                      </div>
                    </div>
                  </div>
                );
              })()}


            </div>
          )}

          {/* Personas tab */}
          {tab === "personas" && (
            <div>
              {editPersona ? (
                <form onSubmit={savePersona} className="bg-white border rounded-xl p-5">
                  <div className="flex justify-between items-center mb-4">
                    <h3 className="font-semibold text-gray-800">Editando: {editPersona.nomeExibicao}</h3>
                    <button type="button" onClick={() => setEditPersona(null)} className="text-gray-400 hover:text-gray-600">✕</button>
                  </div>
                  <div className="space-y-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Nome de Exibição</label>
                      <input
                        value={editPersona.nomeExibicao}
                        onChange={(e) => setEditPersona((p) => p ? { ...p, nomeExibicao: e.target.value } : p)}
                        className="w-full border rounded-lg px-3 py-2 text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">System Prompt</label>
                      <textarea
                        value={editPersona.systemPrompt}
                        onChange={(e) => setEditPersona((p) => p ? { ...p, systemPrompt: e.target.value } : p)}
                        rows={15}
                        className="w-full border rounded-lg px-3 py-2 text-sm font-mono text-xs"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Provedor LLM
                        <span className="ml-2 text-xs font-normal text-gray-400">Deixe vazio para usar a ordem padrão do projeto</span>
                      </label>
                      <select
                        value={editPersona.llmProviderChave ?? ""}
                        onChange={(e) => setEditPersona((p) => p ? { ...p, llmProviderChave: e.target.value || null } : p)}
                        className="w-full border rounded-lg px-3 py-2 text-sm"
                      >
                        <option value="">— Padrão do projeto —</option>
                        {provedoresPage.map((prov) => (
                          <option key={prov.id} value={prov.provider}>
                            {prov.provider} / {prov.modelo}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Voice ID — ElevenLabs
                        <span className="ml-2 text-xs font-normal text-gray-400">Deixe vazio para desativar TTS nesta persona</span>
                      </label>
                      <input
                        value={editPersona.ttsVoiceId ?? ""}
                        onChange={(e) => setEditPersona((p) => p ? { ...p, ttsVoiceId: e.target.value } : p)}
                        placeholder="Ex: pNInz6obpgDQGcFmaJgB"
                        className="w-full border rounded-lg px-3 py-2 text-sm font-mono"
                      />
                      <p className="text-xs text-gray-400 mt-1">
                        Encontre o ID em{" "}
                        <span className="font-mono bg-gray-100 px-1 rounded">elevenlabs.io → Voices → clique na voz → copy ID</span>
                      </p>
                    </div>
                  </div>

                  {/* Fluxo IA — próxima persona e áudio */}
                  <div className="border-t pt-4 mt-2 space-y-4">
                    <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Fluxo IA</p>

                    <div className="flex items-center gap-3">
                      <input
                        type="checkbox"
                        id="usarAudio"
                        checked={editPersona.usarAudio ?? false}
                        onChange={(e) => setEditPersona((p) => p ? { ...p, usarAudio: e.target.checked } : p)}
                        className="rounded"
                      />
                      <label htmlFor="usarAudio" className="text-sm font-medium text-gray-700 cursor-pointer">
                        Enviar respostas como áudio (ElevenLabs)
                        <span className="ml-2 text-xs font-normal text-gray-400">Requer Voice ID preenchido acima</span>
                      </label>
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Próxima persona após concluir
                        <span className="ml-2 text-xs font-normal text-gray-400">Persona que assume quando esta termina o flow</span>
                      </label>
                      <select
                        value={editPersona.proximaPersonaChave ?? ""}
                        onChange={(e) => setEditPersona((p) => p ? { ...p, proximaPersonaChave: e.target.value || null } : p)}
                        className="w-full border rounded-lg px-3 py-2 text-sm bg-white"
                      >
                        <option value="">— nenhuma (encerrar) —</option>
                        {(personas.data as unknown as Persona[] | undefined)
                          ?.filter((p) => p.chave !== editPersona.chave)
                          .map((p) => (
                            <option key={p.chave} value={p.chave}>
                              {p.nomeExibicao} ({p.chave})
                            </option>
                          ))}
                      </select>
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Mensagem de despedida (farewell)
                        <span className="ml-2 text-xs font-normal text-gray-400">Enviada ao lead ao passar para a próxima persona. Deixe vazio para usar o padrão.</span>
                      </label>
                      <textarea
                        value={editPersona.farewellTexto ?? ""}
                        onChange={(e) => setEditPersona((p) => p ? { ...p, farewellTexto: e.target.value } : p)}
                        rows={3}
                        placeholder="Ex: Registrei tudo! Vou te passar agora para nossa secretária que vai confirmar o horário da reunião."
                        className="w-full border rounded-lg px-3 py-2 text-sm resize-none"
                      />
                    </div>
                  </div>

                  <div className="flex gap-2 mt-4">
                    <button type="submit" disabled={upsertPersona.isLoading} className="bg-indigo-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:opacity-50">
                      {upsertPersona.isLoading ? "Salvando..." : "Salvar"}
                    </button>
                    <button type="button" onClick={() => setEditPersona(null)} className="border px-4 py-2 rounded-lg text-sm text-gray-600 hover:bg-gray-50">
                      Cancelar
                    </button>
                  </div>
                </form>
              ) : (
                <div className="space-y-3">
                  {(personas.data as unknown as Persona[] | undefined)?.map((p) => (
                    <div key={p.id} className="bg-white border rounded-xl p-5">
                      <div className="flex justify-between items-start">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className={`font-semibold ${p.ativo === false ? "text-gray-400 line-through" : "text-gray-800"}`}>
                              {p.nomeExibicao}
                            </span>
                            <span className="text-xs bg-indigo-100 text-indigo-700 px-2 py-0.5 rounded-full">{p.chave}</span>
                            {p.ativo === false && (
                              <span className="text-xs bg-gray-200 text-gray-600 px-2 py-0.5 rounded-full">desativada</span>
                            )}
                            {p.llmProviderChave && (
                              <span className="text-xs bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded-full">{p.llmProviderChave}</span>
                            )}
                          </div>
                          {p.descricaoPapel && <p className="text-sm text-gray-500 mt-1">{p.descricaoPapel}</p>}
                          <p className="text-xs text-gray-400 mt-2 line-clamp-2">{p.systemPrompt.slice(0, 120)}...</p>
                        </div>
                        <div className="ml-4 flex items-center gap-3 flex-shrink-0">
                          <label className="flex items-center gap-1.5 cursor-pointer select-none" title="Desativada, esta persona não responde nem envia mensagem proativa em nenhum deal">
                            <input
                              type="checkbox"
                              checked={p.ativo !== false}
                              disabled={setPersonaAtiva.isLoading}
                              onChange={(e) => projetoId && setPersonaAtiva.mutate({
                                projetoId, chave: p.chave, ativo: e.target.checked,
                              })}
                              className="w-4 h-4 rounded border-gray-300 text-brand-600"
                            />
                            <span className={`text-xs font-medium ${p.ativo !== false ? "text-green-600" : "text-gray-400"}`}>
                              {p.ativo !== false ? "Ativa" : "Desativada"}
                            </span>
                          </label>
                          <button
                            onClick={() => setEditPersona(p)}
                            className="text-sm text-indigo-600 hover:underline"
                          >
                            Editar
                          </button>
                        </div>
                      </div>

                      {/* Mídia de apresentação */}
                      <div className="mt-3 pt-3 border-t flex items-center gap-3">
                        <span className="text-xs font-medium text-gray-500 w-28 flex-shrink-0">Foto/vídeo intro</span>
                        {p.midiaApresentacaoPath ? (
                          <>
                            {p.midiaApresentacaoTipo === "video" ? (
                              <video
                                src={`/api/ia-persona-midia/${p.id}?t=${Date.now()}`}
                                className="h-12 w-20 object-cover rounded border"
                                muted
                              />
                            ) : (
                              <img
                                src={`/api/ia-persona-midia/${p.id}?t=${Date.now()}`}
                                className="h-12 w-12 object-cover rounded border"
                                alt="intro"
                              />
                            )}
                            <span className="text-xs text-emerald-600 font-medium">
                              {p.midiaApresentacaoTipo === "video" ? "Vídeo" : "Foto"} configurada
                            </span>
                            <button
                              onClick={() => clearPersonaMidia.mutate({ personaId: p.id })}
                              className="text-xs text-red-500 hover:underline"
                            >
                              Remover
                            </button>
                          </>
                        ) : (
                          <span className="text-xs text-gray-400">Nenhuma mídia — será enviada ao lead na apresentação</span>
                        )}
                        <label className="ml-auto cursor-pointer">
                          <span className={`text-xs px-3 py-1.5 rounded-lg border font-medium ${midiaUploading === p.id ? "opacity-50 cursor-not-allowed bg-gray-50 text-gray-400" : "bg-white text-indigo-600 border-indigo-300 hover:bg-indigo-50"}`}>
                            {midiaUploading === p.id ? "Enviando..." : p.midiaApresentacaoPath ? "Trocar" : "Enviar mídia"}
                          </span>
                          <input
                            type="file"
                            accept="image/*,video/*"
                            className="hidden"
                            disabled={midiaUploading === p.id}
                            onChange={(e) => {
                              const f = e.target.files?.[0];
                              if (f) uploadPersonaMidia(p.id, f);
                              e.target.value = "";
                            }}
                          />
                        </label>
                      </div>
                    </div>
                  ))}
                  {!personas.data?.length && (
                    <p className="text-center text-gray-400 py-8">Nenhuma persona configurada</p>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Notificações tab */}
          {tab === "notificacoes" && (
            <div className="space-y-6">

              {/* Pedido de ligação — palavras-chave */}
              {(() => {
                const DEFAULT_PALAVRAS = "me liga,pode ligar,ligue pra mim,ligue para mim,quero ligacao,quero uma ligacao,preciso de ligacao,prefiro falar por telefone,falar por telefone,quando voces ligam,quando vocês ligam,aguardando a ligacao,espero a ligacao,manda o telefone,qual o telefone,numero de telefone";
                const cfgLigacao = (configs.data as unknown as Config[] | undefined)?.find(
                  (c) => c.categoria === "comportamento" && c.chave === "solicita_ligacao_palavras"
                );
                const valor = palavrasLigacaoEdit ?? cfgLigacao?.valor ?? DEFAULT_PALAVRAS;
                return (
                  <div className="bg-white border rounded-xl p-5">
                    <div className="mb-3">
                      <h3 className="font-semibold text-gray-800 text-sm">Palavras-chave — Lead pede ligação telefônica</h3>
                      <p className="text-xs text-gray-500 mt-0.5">
                        Quando o cliente usar alguma dessas frases, o sistema dispara o evento{" "}
                        <code className="bg-gray-100 px-1 rounded">solicita_ligacao</code> e notifica o SDR/Closer cadastrado abaixo.
                        Separe por vírgula. Acentos são opcionais — o sistema normaliza automaticamente.
                      </p>
                    </div>
                    <textarea
                      value={valor}
                      onChange={(e) => setPalavrasLigacaoEdit(e.target.value)}
                      rows={3}
                      className="w-full border rounded-lg px-3 py-2 text-sm font-mono"
                    />
                    <div className="flex justify-end mt-2">
                      <button
                        disabled={upsertConfig.isLoading || palavrasLigacaoEdit === null}
                        onClick={() => {
                          if (!projetoId || palavrasLigacaoEdit === null) return;
                          upsertConfig.mutate({
                            projetoId,
                            chave: "solicita_ligacao_palavras",
                            valor: palavrasLigacaoEdit,
                            tipo: "texto",
                            categoria: "comportamento",
                            descricao: "Frases que ativam notificação de pedido de ligação (separadas por vírgula)",
                          }, { onSuccess: () => { configs.refetch(); setPalavrasLigacaoEdit(null); } });
                        }}
                        className="bg-indigo-600 text-white px-4 py-1.5 rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:opacity-40"
                      >
                        {upsertConfig.isLoading ? "Salvando..." : "Salvar palavras-chave"}
                      </button>
                    </div>
                  </div>
                );
              })()}

              {/* Lembretes de Reunião */}
              {(() => {
                const DEFAULT_LEMBRETES = [
                  { horas: 24, texto: "Oi {nome}! Aqui é a Ana, do escritório da Dra. Daniela. Só lembrando que sua reunião é *amanhã às {horario}h*. Acesse pelo link: {link} Qualquer dúvida me chama!" },
                  { horas: 1,  texto: "Oi {nome}! Reunião com a Dra. Daniela em *1 hora* ({horario}h). Acesse pelo link: {link} Até já!" },
                ];
                const cfgData = configs.data as unknown as Config[] | undefined;
                const cfgRaw = cfgData?.find(c => c.chave === "reuniao_lembretes")?.valor;
                let saved: { horas: number; texto: string }[] = DEFAULT_LEMBRETES;
                try { if (cfgRaw) saved = JSON.parse(cfgRaw); } catch {}
                const lembretes = lembretesEdit ?? saved;
                const setL = (fn: (prev: { horas: number; texto: string }[]) => { horas: number; texto: string }[]) =>
                  setLembretesEdit(prev => fn(prev ?? saved));
                return (
                  <div className="bg-white border rounded-xl p-5 space-y-4">
                    <div className="flex items-start justify-between">
                      <div>
                        <h3 className="font-semibold text-gray-800 text-sm">Lembretes de Reunião — Ana</h3>
                        <p className="text-xs text-gray-500 mt-0.5">
                          Enviados automaticamente antes da reunião. Variáveis:{" "}
                          <code className="bg-gray-100 px-1 rounded">{"{nome}"}</code>{" "}
                          <code className="bg-gray-100 px-1 rounded">{"{horario}"}</code>{" "}
                          <code className="bg-gray-100 px-1 rounded">{"{link}"}</code>
                        </p>
                      </div>
                      <button
                        onClick={() => setL(prev => [...prev, { horas: 48, texto: "Oi {nome}! Lembrete: sua reunião é em {horario}h. Link: {link}" }])}
                        className="flex items-center gap-1 text-xs text-indigo-600 border border-indigo-200 rounded-lg px-2 py-1 hover:bg-indigo-50 flex-shrink-0 ml-3"
                      >
                        + Lembrete
                      </button>
                    </div>
                    {lembretes.map((l, idx) => (
                      <div key={idx} className="border rounded-lg p-3 space-y-2 bg-gray-50">
                        <div className="flex items-center gap-2">
                          <label className="text-xs text-gray-500 flex-shrink-0">Horas antes:</label>
                          <input
                            type="number" min={1} max={168} value={l.horas}
                            onChange={e => setL(prev => prev.map((x, i) => i === idx ? { ...x, horas: Number(e.target.value) } : x))}
                            className="w-20 border rounded px-2 py-1 text-sm outline-none focus:ring-2 focus:ring-indigo-300"
                          />
                          <span className="text-xs text-gray-400">h</span>
                          <button
                            onClick={() => setL(prev => prev.filter((_, i) => i !== idx))}
                            className="ml-auto text-red-400 hover:text-red-600 text-xs"
                          >✕ remover</button>
                        </div>
                        <textarea
                          value={l.texto}
                          onChange={e => setL(prev => prev.map((x, i) => i === idx ? { ...x, texto: e.target.value } : x))}
                          rows={2}
                          className="w-full border rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-300"
                        />
                      </div>
                    ))}
                    <div className="flex items-center justify-end gap-3">
                      {lembretesEdit !== null && (
                        <span className="text-xs text-amber-600">● alterações não salvas</span>
                      )}
                      <button
                        disabled={upsertConfig.isLoading || !projetoId}
                        onClick={() => {
                          if (!projetoId) return;
                          const toSave = lembretesEdit ?? saved;
                          upsertConfig.mutate({ projetoId, chave: "reuniao_lembretes", valor: JSON.stringify(toSave), tipo: "json", categoria: "reuniao", descricao: "Lista de lembretes de reunião (JSON)" }, {
                            onSuccess: () => { configs.refetch(); setLembretesEdit(null); },
                          });
                        }}
                        className="bg-indigo-600 text-white px-4 py-1.5 rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:opacity-40"
                      >
                        {upsertConfig.isLoading ? "Salvando..." : "Salvar lembretes"}
                      </button>
                    </div>
                  </div>
                );
              })()}

              {editNotif ? (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!projetoId || !editNotif.evento || !editNotif.destino || !editNotif.mensagem) return;
                    upsertNotif.mutate({
                      id:        editNotif.id,
                      projetoId,
                      nome:      editNotif.nome ?? editNotif.evento,
                      evento:    editNotif.evento,
                      destino:   editNotif.destino,
                      mensagem:  editNotif.mensagem,
                      ativo:     editNotif.ativo ?? true,
                    });
                  }}
                  className="bg-white border rounded-xl p-5 space-y-4"
                >
                  <div className="flex justify-between items-center">
                    <h3 className="font-semibold text-gray-800">{editNotif.id ? "Editar notificação" : "Nova notificação"}</h3>
                    <button type="button" onClick={() => setEditNotif(null)} className="text-gray-400 hover:text-gray-600">✕</button>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Nome (identificação)</label>
                    <input
                      value={editNotif.nome ?? ""}
                      onChange={(e) => setEditNotif((n) => ({ ...n, nome: e.target.value }))}
                      placeholder="Ex: Lead qualificado para o grupo"
                      className="w-full border rounded-lg px-3 py-2 text-sm"
                      required
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Evento</label>
                    <input
                      list="eventos-sugeridos"
                      value={editNotif.evento ?? ""}
                      onChange={(e) => setEditNotif((n) => ({ ...n, evento: e.target.value }))}
                      placeholder="qualificacao_completa | stage_entrada:com_closer | ..."
                      className="w-full border rounded-lg px-3 py-2 text-sm font-mono"
                      required
                    />
                    <datalist id="eventos-sugeridos">
                      {EVENTOS_SUGERIDOS.map((ev) => (
                        <option key={ev.value} value={ev.value}>{ev.label}</option>
                      ))}
                    </datalist>
                    <p className="text-xs text-gray-400 mt-1">
                      Use <code>stage_entrada:chave_do_stage</code> para qualquer stage.{" "}
                      Variáveis: {'{{nome}}'} {'{{cidade}}'} {'{{telefone}}'} {'{{stage}}'} {'{{cpf}}'}{" "}
                      — <code>proposta_aceita</code>: {'{{valor}}'} — <code>solicita_ligacao</code>: {'{{empresa}}'} {'{{mensagem}}'}
                    </p>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Destino (número WhatsApp)</label>
                    <input
                      value={editNotif.destino ?? ""}
                      onChange={(e) => setEditNotif((n) => ({ ...n, destino: e.target.value }))}
                      placeholder="5577988887777 ou JID do grupo"
                      className="w-full border rounded-lg px-3 py-2 text-sm font-mono"
                      required
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Mensagem</label>
                    <textarea
                      value={editNotif.mensagem ?? ""}
                      onChange={(e) => setEditNotif((n) => ({ ...n, mensagem: e.target.value }))}
                      placeholder={"*Lead qualificado!*\n\nNome: {{nome}}\nCidade: {{cidade}}\nTelefone: {{telefone}}"}
                      rows={5}
                      className="w-full border rounded-lg px-3 py-2 text-sm font-mono"
                      required
                    />
                  </div>

                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      id="notif-ativo"
                      checked={editNotif.ativo ?? true}
                      onChange={(e) => setEditNotif((n) => ({ ...n, ativo: e.target.checked }))}
                      className="rounded"
                    />
                    <label htmlFor="notif-ativo" className="text-sm text-gray-700">Ativo</label>
                  </div>

                  <div className="flex gap-2">
                    <button
                      type="submit"
                      disabled={upsertNotif.isLoading}
                      className="bg-indigo-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:opacity-50"
                    >
                      {upsertNotif.isLoading ? "Salvando..." : "Salvar"}
                    </button>
                    <button type="button" onClick={() => setEditNotif(null)} className="border px-4 py-2 rounded-lg text-sm text-gray-600 hover:bg-gray-50">
                      Cancelar
                    </button>
                  </div>
                </form>
              ) : (
                <div>
                  <div className="flex justify-between items-center mb-4">
                    <p className="text-sm text-gray-500">Mensagens enviadas automaticamente pelo WhatsApp quando eventos ocorrem no funil.</p>
                    <button
                      onClick={() => setEditNotif({ ativo: true })}
                      className="bg-indigo-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-indigo-700"
                    >
                      + Nova notificação
                    </button>
                  </div>

                  {notificacoes.data?.length === 0 && (
                    <div className="text-center py-12 text-gray-400 bg-white border rounded-xl">
                      <p className="text-3xl mb-2">🔔</p>
                      <p className="font-medium">Nenhuma notificação configurada</p>
                      <p className="text-sm mt-1">Crie uma notificação para receber alertas quando leads qualificam, mudam de stage, etc.</p>
                    </div>
                  )}

                  <div className="space-y-3">
                    {(notificacoes.data as unknown as Notificacao[] | undefined)?.map((n) => (
                      <div key={n.id} className="bg-white border rounded-xl px-5 py-4 flex items-start justify-between gap-4">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-medium text-gray-800 text-sm">{n.nome}</span>
                            <span className={`text-xs px-2 py-0.5 rounded-full ${n.ativo ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"}`}>
                              {n.ativo ? "ativo" : "inativo"}
                            </span>
                          </div>
                          <div className="flex items-center gap-3 mt-1 flex-wrap">
                            <code className="text-xs bg-indigo-50 text-indigo-700 px-2 py-0.5 rounded">{n.evento}</code>
                            <span className="text-xs text-gray-400">→ {n.destino}</span>
                          </div>
                          <p className="text-xs text-gray-500 mt-1.5 truncate">{n.mensagem.slice(0, 100)}{n.mensagem.length > 100 ? "…" : ""}</p>
                        </div>
                        <div className="flex gap-2 flex-shrink-0">
                          <button
                            onClick={() => setEditNotif(n)}
                            className="text-sm text-indigo-600 hover:underline"
                          >
                            Editar
                          </button>
                          <button
                            onClick={() => { if (confirm("Excluir esta notificação?")) deleteNotif.mutate({ id: n.id }); }}
                            className="text-sm text-red-500 hover:underline"
                          >
                            Excluir
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Proposta tab */}
          {tab === "proposta" && (() => {
            const cfgs = (configs.data as unknown as Config[] | undefined) ?? [];
            const get  = (k: string) => editando[k] ?? cfgs.find(c => c.chave === k)?.valor ?? "";
            const hasProposta = cfgs.some(c => c.categoria === "proposta");

            const saveSelect = (chave: string, valor: string, extra?: Partial<Config>) => {
              if (!projetoId) return;
              setEditando(prev => ({ ...prev, [chave]: valor }));
              upsertConfig.mutate({ projetoId, chave, valor, tipo: extra?.tipo ?? "texto", categoria: extra?.categoria ?? "proposta", descricao: extra?.descricao ?? undefined });
            };

            const METODOS = [
              { v: "PIX_BOLETO", l: "PIX ou Boleto" },
              { v: "PIX",        l: "PIX" },
              { v: "BOLETO",     l: "Boleto Bancário" },
              { v: "NENHUM",     l: "A combinar" },
              { v: "ALVARA",     l: "Transferência por Alvará Judicial" },
            ];
            const TIPOS_CONTRATO = [
              { v: "RECORRENTE", l: "Recorrente (mensal)" },
              { v: "PARCELADO",  l: "Parcelado" },
              { v: "EVENTUAL",   l: "Eventual (sem recorrência)" },
            ];
            const MOMENTOS = [
              { v: "dados_coletados",       l: "Dados coletados — Daniela (advogado) ou Ana (coleta_docs)" },
              { v: "parecer_enviado",       l: "Após enviar o parecer (Dra. Daniela)" },
              { v: "qualificacao_completa", l: "Lead qualificado (Ana assistente)" },
              { v: "documentos_pessoais",   l: "Após o cliente enviar documentos pessoais" },
              { v: "manual",                l: "Apenas manual (não automático)" },
            ];

            return (
              <div className="space-y-5">
                {!hasProposta && (
                  <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium text-amber-800">Configurações de proposta não encontradas</p>
                      <p className="text-xs text-amber-600 mt-0.5">Clique para criar as configurações de proposta automática</p>
                    </div>
                    <button
                      onClick={() => projetoId && seedPropostaConfigs.mutate({ projetoId })}
                      disabled={seedPropostaConfigs.isPending}
                      className="text-sm px-4 py-2 bg-amber-600 text-white rounded-lg hover:bg-amber-700 disabled:opacity-50 flex-shrink-0 ml-4"
                    >
                      {seedPropostaConfigs.isPending ? "Criando..." : "Criar configs"}
                    </button>
                  </div>
                )}

                {/* Ativar / Empresa */}
                <div className="bg-white border border-gray-200 rounded-xl p-5 space-y-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <h3 className="font-semibold text-gray-800 text-sm">Proposta Automática</h3>
                      <p className="text-xs text-gray-500 mt-0.5">A IA cria e envia a proposta no momento configurado</p>
                    </div>
                    <label className="flex items-center gap-2 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={get("proposta_ativo") === "true"}
                        onChange={e => saveSelect("proposta_ativo", e.target.checked ? "true" : "false")}
                        className="w-4 h-4 rounded border-gray-300 text-brand-600"
                      />
                      <span className={`text-sm font-medium ${get("proposta_ativo") === "true" ? "text-green-600" : "text-gray-400"}`}>
                        {get("proposta_ativo") === "true" ? "✓ Ativa" : "Marcar para ativar"}
                      </span>
                    </label>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">Empresa emissora</label>
                      <select
                        value={get("proposta_emitente_id")}
                        onChange={e => saveSelect("proposta_emitente_id", e.target.value, { descricao: "ID da empresa emissora das propostas" })}
                        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                      >
                        <option value="">Selecione...</option>
                        {empresas.data?.map((e: any) => (
                          <option key={e.id} value={e.id}>{e.nomeFantasia || e.nome}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">Momento de disparo</label>
                      <select
                        value={get("proposta_momento")}
                        onChange={e => saveSelect("proposta_momento", e.target.value, { descricao: "Momento de disparo da proposta" })}
                        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                      >
                        {MOMENTOS.map(m => <option key={m.v} value={m.v}>{m.l}</option>)}
                      </select>
                    </div>
                  </div>
                </div>

                {/* Revisão antes do envio */}
                <div className="bg-white border border-gray-200 rounded-xl p-5 space-y-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <h3 className="font-semibold text-gray-800 text-sm">Revisar antes de enviar</h3>
                      <p className="text-xs text-gray-500 mt-0.5">
                        Ligado: a IA gera contrato, procuração e declaração e para. Os documentos ficam em
                        <strong> Propostas</strong> com o selo “Em revisão” até alguém clicar em
                        <strong> Liberar para assinatura</strong>. Desligado: vai direto para o cliente.
                      </p>
                    </div>
                    <label className="flex items-center gap-2 cursor-pointer select-none flex-shrink-0 ml-4">
                      <input
                        type="checkbox"
                        checked={get("proposta_revisao_manual") !== "false"}
                        onChange={e => saveSelect("proposta_revisao_manual", e.target.checked ? "true" : "false", { descricao: "Revisar os documentos antes de enviar para assinatura" })}
                        className="w-4 h-4 rounded border-gray-300 text-brand-600"
                      />
                      <span className={`text-sm font-medium ${get("proposta_revisao_manual") !== "false" ? "text-green-600" : "text-gray-400"}`}>
                        {get("proposta_revisao_manual") !== "false" ? "✓ Com revisão" : "Sem revisão"}
                      </span>
                    </label>
                  </div>
                  {get("proposta_revisao_manual") !== "false" && (
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">
                        Mensagem ao cliente enquanto a revisão não sai <span className="text-gray-400">({'{{nome}}'} = primeiro nome; vazio = texto padrão)</span>
                      </label>
                      <textarea
                        rows={3}
                        value={get("proposta_msg_revisao")}
                        onChange={e => setEditando(prev => ({ ...prev, proposta_msg_revisao: e.target.value }))}
                        onBlur={() => saveSelect("proposta_msg_revisao", get("proposta_msg_revisao"), { descricao: "Mensagem ao cliente enquanto os documentos estão em revisão" })}
                        placeholder="Perfeito, {{nome}}! Recebi tudo o que precisava. Seus documentos já estão sendo preparados e passam por uma conferência final da nossa equipe. Assim que estiverem prontos eu te envio aqui os links para assinatura."
                        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                      />
                    </div>
                  )}
                </div>

                {/* Templates */}
                <div className="bg-white border border-gray-200 rounded-xl p-5 space-y-4">
                  <h3 className="font-semibold text-gray-800 text-sm">Templates</h3>
                  {!propostaEmitenteId && (
                    <p className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                      Selecione a empresa emissora acima para ver os templates disponíveis.
                    </p>
                  )}
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">Corpo da proposta</label>
                      <select
                        value={get("proposta_template_corpo_id")}
                        onChange={e => saveSelect("proposta_template_corpo_id", e.target.value, { descricao: "Template do corpo da proposta" })}
                        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                        disabled={!propostaEmitenteId}
                      >
                        <option value="">Padrão (hardcoded)</option>
                        {templatesProposta.data?.map((t: any) => (
                          <option key={t.id} value={t.id}>{t.titulo}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">Contrato (ao aceitar)</label>
                      <select
                        value={get("proposta_template_contrato_id")}
                        onChange={e => saveSelect("proposta_template_contrato_id", e.target.value, { descricao: "Template de contrato ao aceitar" })}
                        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                        disabled={!propostaEmitenteId}
                      >
                        <option value="">Nenhum</option>
                        {templatesContrato.data?.map((t: any) => (
                          <option key={t.id} value={t.id}>{t.titulo}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">Procuração (ao aceitar)</label>
                      <select
                        value={get("proposta_template_procuracao_id")}
                        onChange={e => saveSelect("proposta_template_procuracao_id", e.target.value, { descricao: "Template de procuração ao aceitar" })}
                        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                        disabled={!propostaEmitenteId}
                      >
                        <option value="">Nenhuma</option>
                        {templatesProcuracao.data?.map((t: any) => (
                          <option key={t.id} value={t.id}>{t.titulo}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <p className="text-xs text-gray-400">
                    Gerencie os templates em{" "}
                    <a href="/templates-documentos" target="_blank" className="text-brand-600 underline">Templates de Documentos</a>.
                  </p>
                </div>

                {/* Parâmetros do contrato */}
                <div className="bg-white border border-gray-200 rounded-xl p-5 space-y-4">
                  <h3 className="font-semibold text-gray-800 text-sm">Parâmetros do Contrato</h3>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">Dia de vencimento</label>
                      <input
                        type="number" min="1" max="28"
                        value={get("proposta_dia_vencimento")}
                        onChange={e => setEditando(prev => ({ ...prev, proposta_dia_vencimento: e.target.value }))}
                        onBlur={() => saveSelect("proposta_dia_vencimento", get("proposta_dia_vencimento"), { tipo: "numero" as any, descricao: "Dia de vencimento" })}
                        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">Validade (dias)</label>
                      <input
                        type="number" min="1"
                        value={get("proposta_validade_dias")}
                        onChange={e => setEditando(prev => ({ ...prev, proposta_validade_dias: e.target.value }))}
                        onBlur={() => saveSelect("proposta_validade_dias", get("proposta_validade_dias"), { tipo: "numero" as any, descricao: "Validade em dias" })}
                        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">Método de cobrança</label>
                      <select
                        value={get("proposta_metodo_cobr")}
                        onChange={e => saveSelect("proposta_metodo_cobr", e.target.value, { descricao: "Método de cobrança" })}
                        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                      >
                        {METODOS.map(m => <option key={m.v} value={m.v}>{m.l}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">Tipo de contrato</label>
                      <select
                        value={get("proposta_tipo_contrato")}
                        onChange={e => saveSelect("proposta_tipo_contrato", e.target.value, { descricao: "Tipo de contrato" })}
                        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                      >
                        {TIPOS_CONTRATO.map(t => <option key={t.v} value={t.v}>{t.l}</option>)}
                      </select>
                    </div>
                  </div>

                  {/* Signatários do contrato — cliente + RAP + 2 testemunhas */}
                  <div className="border-t border-gray-200 pt-4 space-y-3">
                    <div>
                      <h4 className="font-semibold text-gray-800 text-sm">Signatários do contrato</h4>
                      <p className="text-xs text-gray-500 mt-0.5">
                        Além do cliente, o <strong>contrato</strong> vai para estas pessoas — cada uma recebe só o
                        próprio link, no próprio WhatsApp. Procuração e declaração continuam apenas com o cliente.
                        Deixe em branco para o contrato ir só com o cliente.
                      </p>
                      <p className="text-xs text-gray-400 mt-1">
                        Formato: <code>Nome|email|whatsapp</code> — ex.:{" "}
                        <code>Maria Souza|maria@rap.adv.br|5577999998888</code>
                      </p>
                    </div>
                    {([
                      ["proposta_rap_signatario", "Assina pela RAP"],
                      ["proposta_testemunha_1",   "Testemunha 1"],
                      ["proposta_testemunha_2",   "Testemunha 2"],
                    ] as const).map(([chave, rotulo]) => (
                      <div key={chave}>
                        <label className="block text-xs font-medium text-gray-600 mb-1">{rotulo}</label>
                        <input
                          type="text"
                          value={get(chave)}
                          onChange={e => setEditando(prev => ({ ...prev, [chave]: e.target.value }))}
                          onBlur={() => saveSelect(chave, get(chave), { descricao: `${rotulo} — Nome|email|whatsapp` })}
                          placeholder="Nome|email|whatsapp"
                          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono"
                        />
                      </div>
                    ))}
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Descrição do serviço (campo {"{{servico}}"} no template)</label>
                    <input
                      type="text"
                      value={get("proposta_descricao_servico")}
                      onChange={e => setEditando(prev => ({ ...prev, proposta_descricao_servico: e.target.value }))}
                      onBlur={() => saveSelect("proposta_descricao_servico", get("proposta_descricao_servico"), { descricao: "Descrição do serviço" })}
                      placeholder="Ex: Recuperação de direitos trabalhistas — RAP"
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">Tipo de honorários</label>
                      <select
                        value={get("proposta_honorarios_tipo")}
                        onChange={e => saveSelect("proposta_honorarios_tipo", e.target.value, { descricao: "Tipo de honorários" })}
                        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                      >
                        <option value="exito">Honorários de êxito (% do valor recuperado)</option>
                        <option value="fixo">Honorários fixos</option>
                        <option value="misto">Misto (fixo + êxito)</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">% de honorários de êxito</label>
                      <input
                        type="number" min="1" max="100"
                        value={get("proposta_honorarios_perc")}
                        onChange={e => setEditando(prev => ({ ...prev, proposta_honorarios_perc: e.target.value }))}
                        onBlur={() => {
                          if (!projetoId) return;
                          upsertConfig.mutate({ projetoId, chave: "proposta_honorarios_perc", valor: get("proposta_honorarios_perc"), tipo: "numero", categoria: "proposta", descricao: "% de honorários de êxito (ex: 30)" });
                        }}
                        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                        placeholder="Ex: 30"
                      />
                    </div>
                  </div>
                </div>
              </div>
            );
          })()}

          {/* Qualificação tab */}
          {tab === "qualificacao" && (
            <div>
              <div className="flex justify-between items-center mb-4">
                <div>
                  <h3 className="text-base font-semibold text-gray-800">Perguntas de Qualificação</h3>
                  <p className="text-xs text-gray-500 mt-0.5">
                    Campos coletados pela IA durante a conversa. Use <code className="bg-gray-100 px-1 rounded">dependeDe</code> + <code className="bg-gray-100 px-1 rounded">ativaSeResposta</code> para perguntas condicionais.
                  </p>
                </div>
                <button
                  onClick={() => setEditPergunta(BLANK_PERGUNTA())}
                  className="bg-indigo-600 text-white text-sm px-3 py-1.5 rounded-lg hover:bg-indigo-700"
                >
                  + Nova pergunta
                </button>
              </div>

              {/* Modal */}
              {editPergunta && (
                <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (!projetoId || !editPergunta) return;
                      upsertPergunta.mutate({
                        id: editPergunta.id,
                        projetoId,
                        chave: editPergunta.chave!,
                        perguntaContexto: editPergunta.perguntaContexto!,
                        exemploAbordagem: editPergunta.exemploAbordagem || undefined,
                        tipoDado: (editPergunta.tipoDado as any) ?? "texto",
                        obrigatorio: editPergunta.obrigatorio ?? true,
                        ordem: editPergunta.ordem ?? 99,
                        stageColeta: editPergunta.stageColeta || undefined,
                        dependeDe: editPergunta.dependeDe || undefined,
                        ativaSeResposta: editPergunta.ativaSeResposta || undefined,
                      });
                    }}
                    className="bg-white rounded-xl shadow-xl p-6 w-full max-w-lg space-y-4"
                  >
                    <h3 className="font-semibold text-gray-800">{editPergunta.id ? "Editar pergunta" : "Nova pergunta"}</h3>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="text-xs font-medium text-gray-600">Chave (identificador)</label>
                        <input className="w-full border rounded-lg px-3 py-2 text-sm mt-1" value={editPergunta.chave ?? ""} required
                          onChange={(e) => setEditPergunta((p) => ({ ...p!, chave: e.target.value }))} />
                      </div>
                      <div>
                        <label className="text-xs font-medium text-gray-600">Stage coleta</label>
                        <input className="w-full border rounded-lg px-3 py-2 text-sm mt-1" value={editPergunta.stageColeta ?? ""} placeholder="ex: lead_carreteiro"
                          onChange={(e) => setEditPergunta((p) => ({ ...p!, stageColeta: e.target.value }))} />
                      </div>
                    </div>
                    <div>
                      <label className="text-xs font-medium text-gray-600">Contexto da pergunta (instrução para a IA)</label>
                      <textarea className="w-full border rounded-lg px-3 py-2 text-sm mt-1" rows={2} value={editPergunta.perguntaContexto ?? ""} required
                        onChange={(e) => setEditPergunta((p) => ({ ...p!, perguntaContexto: e.target.value }))} />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-gray-600">Exemplo de abordagem</label>
                      <input className="w-full border rounded-lg px-3 py-2 text-sm mt-1" value={editPergunta.exemploAbordagem ?? ""}
                        onChange={(e) => setEditPergunta((p) => ({ ...p!, exemploAbordagem: e.target.value }))} />
                    </div>
                    <div className="grid grid-cols-3 gap-3">
                      <div>
                        <label className="text-xs font-medium text-gray-600">Tipo de dado</label>
                        <select className="w-full border rounded-lg px-3 py-2 text-sm mt-1" value={editPergunta.tipoDado ?? "texto"}
                          onChange={(e) => setEditPergunta((p) => ({ ...p!, tipoDado: e.target.value }))}>
                          <option value="texto">Texto</option>
                          <option value="booleano">Booleano</option>
                          <option value="numero">Número</option>
                          <option value="data">Data</option>
                        </select>
                      </div>
                      <div>
                        <label className="text-xs font-medium text-gray-600">Ordem</label>
                        <input type="number" className="w-full border rounded-lg px-3 py-2 text-sm mt-1" value={editPergunta.ordem ?? 99}
                          onChange={(e) => setEditPergunta((p) => ({ ...p!, ordem: Number(e.target.value) }))} />
                      </div>
                      <div className="flex flex-col justify-end pb-2">
                        <label className="flex items-center gap-2 text-sm cursor-pointer">
                          <input type="checkbox" checked={editPergunta.obrigatorio ?? true}
                            onChange={(e) => setEditPergunta((p) => ({ ...p!, obrigatorio: e.target.checked }))} />
                          Obrigatória
                        </label>
                      </div>
                    </div>
                    <div className="border-t pt-3">
                      <p className="text-xs font-semibold text-gray-500 uppercase mb-2">Ativação condicional</p>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="text-xs font-medium text-gray-600">Depende da chave</label>
                          <input className="w-full border rounded-lg px-3 py-2 text-sm mt-1" value={editPergunta.dependeDe ?? ""} placeholder="ex: emprego_anterior_prazo"
                            onChange={(e) => setEditPergunta((p) => ({ ...p!, dependeDe: e.target.value }))} />
                        </div>
                        <div>
                          <label className="text-xs font-medium text-gray-600">Ativa quando resposta contém (regex)</label>
                          <input className="w-full border rounded-lg px-3 py-2 text-sm mt-1" value={editPergunta.ativaSeResposta ?? ""} placeholder="ex: sim|yes|trab"
                            onChange={(e) => setEditPergunta((p) => ({ ...p!, ativaSeResposta: e.target.value }))} />
                        </div>
                      </div>
                      <p className="text-xs text-gray-400 mt-1">Quando preenchido, esta pergunta se torna obrigatória se o campo pai corresponder ao padrão.</p>
                    </div>
                    <div className="flex gap-2 justify-end pt-2">
                      <button type="button" onClick={() => setEditPergunta(null)} className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">Cancelar</button>
                      <button type="submit" disabled={upsertPergunta.isLoading} className="px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50">
                        {upsertPergunta.isLoading ? "Salvando..." : "Salvar"}
                      </button>
                    </div>
                  </form>
                </div>
              )}

              {/* Table */}
              <div className="bg-white border rounded-xl overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 text-xs text-gray-500 uppercase">
                    <tr>
                      <th className="px-4 py-3 text-left">Ord</th>
                      <th className="px-4 py-3 text-left">Chave</th>
                      <th className="px-4 py-3 text-left">Contexto</th>
                      <th className="px-4 py-3 text-left">Stage</th>
                      <th className="px-4 py-3 text-left">Depende de</th>
                      <th className="px-4 py-3 text-center">Obrig.</th>
                      <th className="px-4 py-3" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {(perguntas.data ?? []).map((p: any) => (
                      <tr key={p.id} className="hover:bg-gray-50">
                        <td className="px-4 py-2 text-gray-400">{p.ordem}</td>
                        <td className="px-4 py-2"><code className="text-xs text-indigo-600">{p.chave}</code></td>
                        <td className="px-4 py-2 text-gray-700 max-w-xs truncate">{p.perguntaContexto}</td>
                        <td className="px-4 py-2 text-gray-400 text-xs">{p.stageColeta ?? "—"}</td>
                        <td className="px-4 py-2">
                          {p.dependeDe ? (
                            <span className="text-xs text-amber-600">
                              {p.dependeDe} <span className="text-gray-400">/{p.ativaSeResposta}/</span>
                            </span>
                          ) : "—"}
                        </td>
                        <td className="px-4 py-2 text-center">
                          {p.obrigatorio
                            ? <span className="text-xs bg-indigo-100 text-indigo-700 px-1.5 rounded">sim</span>
                            : <span className="text-xs text-gray-400">não</span>}
                        </td>
                        <td className="px-4 py-2 text-right">
                          <button onClick={() => setEditPergunta(p)} className="text-xs text-indigo-600 hover:underline mr-3">Editar</button>
                          <button onClick={() => { if (confirm("Remover?")) deletePergunta.mutate({ id: p.id }); }} className="text-xs text-red-500 hover:underline">Remover</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {(perguntas.data ?? []).length === 0 && (
                  <p className="text-sm text-gray-400 text-center py-8">Nenhuma pergunta configurada.</p>
                )}
              </div>
            </div>
          )}

          {/* Transições tab */}
          {tab === "transicoes" && (
            <div>
              <div className="flex justify-between items-center mb-4">
                <div>
                  <h3 className="text-base font-semibold text-gray-800">Regras de Transição</h3>
                  <p className="text-xs text-gray-500 mt-0.5">
                    Define quando e como o deal muda de stage. <code className="bg-gray-100 px-1 rounded">requerPrescricaoAtiva</code> só dispara se a rescisão estiver dentro do prazo de 2 anos.
                  </p>
                </div>
                <button
                  onClick={() => setEditRegra(BLANK_REGRA())}
                  className="bg-indigo-600 text-white text-sm px-3 py-1.5 rounded-lg hover:bg-indigo-700"
                >
                  + Nova regra
                </button>
              </div>

              {/* Modal */}
              {editRegra && (
                <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (!projetoId || !editRegra) return;
                      upsertRegra.mutate({
                        id: editRegra.id,
                        projetoId,
                        stageOrigemChave: editRegra.stageOrigemChave || undefined,
                        stageDestinoChave: editRegra.stageDestinoChave!,
                        condicao: editRegra.condicao!,
                        acaoAdicional: editRegra.acaoAdicional || undefined,
                        parametros: editRegra.parametros ?? undefined,
                        ordem: editRegra.ordem ?? 0,
                        requerPrescricaoAtiva: editRegra.requerPrescricaoAtiva ?? false,
                      });
                    }}
                    className="bg-white rounded-xl shadow-xl p-6 w-full max-w-lg space-y-4"
                  >
                    <h3 className="font-semibold text-gray-800">{editRegra.id ? "Editar regra" : "Nova regra"}</h3>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="text-xs font-medium text-gray-600">Stage origem (vazio = qualquer)</label>
                        <input className="w-full border rounded-lg px-3 py-2 text-sm mt-1" value={editRegra.stageOrigemChave ?? ""}
                          placeholder="ex: lead_carreteiro"
                          onChange={(e) => setEditRegra((r) => ({ ...r!, stageOrigemChave: e.target.value }))} />
                      </div>
                      <div>
                        <label className="text-xs font-medium text-gray-600">Stage destino</label>
                        <input className="w-full border rounded-lg px-3 py-2 text-sm mt-1" value={editRegra.stageDestinoChave ?? ""} required
                          placeholder="ex: lead_qualificado"
                          onChange={(e) => setEditRegra((r) => ({ ...r!, stageDestinoChave: e.target.value }))} />
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="text-xs font-medium text-gray-600">Condição</label>
                        <input className="w-full border rounded-lg px-3 py-2 text-sm mt-1" value={editRegra.condicao ?? ""} required
                          placeholder="ex: qualificacao_completa"
                          onChange={(e) => setEditRegra((r) => ({ ...r!, condicao: e.target.value }))} />
                      </div>
                      <div>
                        <label className="text-xs font-medium text-gray-600">Ação adicional</label>
                        <input className="w-full border rounded-lg px-3 py-2 text-sm mt-1" value={editRegra.acaoAdicional ?? ""}
                          placeholder="ex: trocar_persona:closer"
                          onChange={(e) => setEditRegra((r) => ({ ...r!, acaoAdicional: e.target.value }))} />
                      </div>
                    </div>
                    {(editRegra.condicao === "sem_resposta_Xhoras" || editRegra.condicao === "follow_up_timed") && (
                      <div>
                        <label className="text-xs font-medium text-gray-600">
                          {editRegra.condicao === "sem_resposta_Xhoras" ? "Horas de silêncio antes de disparar" : "Horas de espera antes do follow-up"}
                        </label>
                        <input
                          type="number"
                          min={1}
                          className="w-full border rounded-lg px-3 py-2 text-sm mt-1"
                          value={(editRegra.parametros as any)?.horas ?? ""}
                          placeholder="ex: 24"
                          onChange={(e) => setEditRegra((r) => ({
                            ...r!,
                            parametros: { ...(r?.parametros ?? {}), horas: Number(e.target.value) },
                          }))}
                        />
                        <p className="text-xs text-gray-400 mt-0.5">
                          {editRegra.condicao === "sem_resposta_Xhoras"
                            ? "Depois desse tempo sem resposta do lead, a transição é executada."
                            : "Depois desse tempo sem resposta, o follow-up proativo é enviado (sem mudar de stage)."}
                        </p>
                      </div>
                    )}
                    <div className="grid grid-cols-2 gap-3 items-end">
                      <div>
                        <label className="text-xs font-medium text-gray-600">Ordem</label>
                        <input type="number" className="w-full border rounded-lg px-3 py-2 text-sm mt-1" value={editRegra.ordem ?? 0}
                          onChange={(e) => setEditRegra((r) => ({ ...r!, ordem: Number(e.target.value) }))} />
                      </div>
                      <div className="pb-2">
                        <label className="flex items-center gap-2 text-sm cursor-pointer">
                          <input type="checkbox" checked={editRegra.requerPrescricaoAtiva ?? false}
                            onChange={(e) => setEditRegra((r) => ({ ...r!, requerPrescricaoAtiva: e.target.checked }))} />
                          <span>Requer prescrição ativa (2 anos)</span>
                        </label>
                        <p className="text-xs text-gray-400 mt-0.5 ml-5">Só dispara quando o prazo prescricional estiver vigente.</p>
                      </div>
                    </div>
                    <div className="flex gap-2 justify-end pt-2">
                      <button type="button" onClick={() => setEditRegra(null)} className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">Cancelar</button>
                      <button type="submit" disabled={upsertRegra.isLoading} className="px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50">
                        {upsertRegra.isLoading ? "Salvando..." : "Salvar"}
                      </button>
                    </div>
                  </form>
                </div>
              )}

              {/* Table */}
              <div className="bg-white border rounded-xl overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 text-xs text-gray-500 uppercase">
                    <tr>
                      <th className="px-4 py-3 text-left">Origem</th>
                      <th className="px-4 py-3 text-left">Condição</th>
                      <th className="px-4 py-3 text-left">Destino</th>
                      <th className="px-4 py-3 text-left">Ação</th>
                      <th className="px-4 py-3 text-center">Prescrição</th>
                      <th className="px-4 py-3" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {(regras.data ?? []).map((r: any) => (
                      <tr key={r.id} className="hover:bg-gray-50">
                        <td className="px-4 py-2"><code className="text-xs text-gray-500">{r.stageOrigemChave ?? "*"}</code></td>
                        <td className="px-4 py-2">
                          <code className="text-xs text-indigo-600">{r.condicao}</code>
                          {(r.condicao === "sem_resposta_Xhoras" || r.condicao === "follow_up_timed") && r.parametros?.horas && (
                            <span className="ml-1 text-xs text-gray-400">({r.parametros.horas}h)</span>
                          )}
                        </td>
                        <td className="px-4 py-2"><code className="text-xs text-green-600">{r.stageDestinoChave}</code></td>
                        <td className="px-4 py-2 text-xs text-gray-500">{r.acaoAdicional ?? "—"}</td>
                        <td className="px-4 py-2 text-center">
                          {r.requerPrescricaoAtiva
                            ? <span className="text-xs bg-amber-100 text-amber-700 px-1.5 rounded">ativa</span>
                            : <span className="text-xs text-gray-300">—</span>}
                        </td>
                        <td className="px-4 py-2 text-right">
                          <button onClick={() => setEditRegra(r)} className="text-xs text-indigo-600 hover:underline mr-3">Editar</button>
                          <button onClick={() => { if (confirm("Remover regra?")) deleteRegra.mutate({ id: r.id }); }} className="text-xs text-red-500 hover:underline">Remover</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {(regras.data ?? []).length === 0 && (
                  <p className="text-sm text-gray-400 text-center py-8">Nenhuma regra configurada.</p>
                )}
              </div>
            </div>
          )}

          {/* Fases tab */}
          {tab === "fases" && (
            <div>
              {["comercial", "processual"].map((tipo) => {
                const fasesTipo = (fases.data ?? []).filter((f: any) => f.pipelineTipo === tipo);
                return (
                  <div key={tipo} className="mb-6">
                    <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-3 capitalize">
                      Funil {tipo}
                    </h3>
                    <div className="space-y-2">
                      {fasesTipo.map((f: any) => (
                        <div key={f.id} className="bg-white border rounded-lg px-4 py-3 flex items-center gap-3">
                          <span
                            className="w-3 h-3 rounded-full flex-shrink-0"
                            style={{ backgroundColor: f.cor }}
                          />
                          <div className="flex-1">
                            <span className="text-sm font-medium text-gray-800">{f.nomeExibicao}</span>
                            <div className="flex gap-2 mt-0.5">
                              <code className="text-xs text-gray-400">{f.chave}</code>
                              {f.personaChave && (
                                <span className="text-xs text-indigo-600">{f.personaChave}</span>
                              )}
                              {f.requerAcaoHumana && (
                                <span className="text-xs bg-yellow-100 text-yellow-700 px-1.5 rounded">humano</span>
                              )}
                              {f.ehEntrada && (
                                <span className="text-xs bg-green-100 text-green-700 px-1.5 rounded">entrada</span>
                              )}
                              {f.ehGanho && (
                                <span className="text-xs bg-blue-100 text-blue-700 px-1.5 rounded">ganho</span>
                              )}
                            </div>
                          </div>
                        </div>
                      ))}
                      {fasesTipo.length === 0 && (
                        <p className="text-sm text-gray-400 pl-4">Nenhuma fase {tipo}</p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Fluxo IA tab — unified flowchart */}
          {tab === "fluxo" && projetoId && (
            <FluxoIATab
              projetoId={projetoId}
              personas={(personas.data as unknown as { id: string; chave: string; nomeExibicao: string; cor?: string | null }[] | undefined) ?? []}
            />
          )}

          {/* Follow-up tab */}
          {tab === "followup" && projetoId && (() => {
            const cfg = followUpConfigs.data ?? {};
            const fuAtivo         = cfg["follow_up_ativo"] === "true";
            const fuIntervalo     = cfg["follow_up_intervalo_dias"] ?? "1";
            const fuMaxTentativas = cfg["follow_up_max_tentativas"] ?? "0";
            const fuValidade      = cfg["follow_up_validade_meses"] ?? "24";
            function saveFu(chave: string, valor: string) {
              saveFollowUpConfig.mutate({ projetoId: projetoId!, chave, valor });
            }
            const stageCorMap: Record<string, string> = {
              blue:   "bg-blue-500",
              purple: "bg-purple-500",
              green:  "bg-green-500",
              orange: "bg-orange-500",
              red:    "bg-red-500",
            };
            return (
              <div className="space-y-6">

                {/* Section header */}
                <div className="flex items-center gap-3">
                  <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider">Follow-up Automático</h2>
                  <div className="flex-1 border-t border-gray-200" />
                </div>

                {/* PAKT Signature Follow-up */}
                <div className="bg-white border rounded-xl overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setFollowUpExpanded(v => !v)}
                    className="w-full flex items-center justify-between px-5 py-4 text-left hover:bg-gray-50 transition-colors"
                  >
                    <div className="flex items-center gap-3">
                      <span className="w-2.5 h-2.5 rounded-full bg-indigo-500" />
                      <div>
                        <h3 className="font-semibold text-gray-800 text-sm">Assinatura PAKT — Lembretes de Contrato</h3>
                        <p className="text-xs text-gray-500 mt-0.5">Lembrete diário para leads com links não assinados — tom escalante até a assinatura</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 ml-4">
                      {fuAtivo && <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full">ativo</span>}
                      <span className="text-gray-400 text-sm">{followUpExpanded ? "▲" : "▼"}</span>
                    </div>
                  </button>

                  {followUpExpanded && (
                    <div className="border-t px-5 py-4 space-y-5">
                      <label className="flex items-start gap-3 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={fuAtivo}
                          onChange={(e) => saveFu("follow_up_ativo", e.target.checked ? "true" : "false")}
                          className="mt-0.5 h-4 w-4 rounded text-indigo-600"
                        />
                        <div>
                          <p className="text-sm font-medium text-gray-700">Ativar follow-up automático</p>
                          <p className="text-xs text-gray-500">O sistema enviará mensagens diárias (às 9h) para leads com proposta aceita e links PAKT não assinados.</p>
                        </div>
                      </label>

                      <div className="grid grid-cols-3 gap-4">
                        <div>
                          <label className="block text-xs font-medium text-gray-600 mb-1">Intervalo entre mensagens (dias)</label>
                          <input type="number" min={1} defaultValue={fuIntervalo}
                            onBlur={(e) => saveFu("follow_up_intervalo_dias", String(Math.max(1, parseInt(e.target.value, 10) || 1)))}
                            className="w-full border rounded-lg px-3 py-2 text-sm text-center" />
                          <p className="text-xs text-gray-400 mt-1">Mínimo: 1 dia</p>
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-gray-600 mb-1">Máximo de tentativas (0 = ilimitado)</label>
                          <input type="number" min={0} defaultValue={fuMaxTentativas}
                            onBlur={(e) => saveFu("follow_up_max_tentativas", String(Math.max(0, parseInt(e.target.value, 10) || 0)))}
                            className="w-full border rounded-lg px-3 py-2 text-sm text-center" />
                          <p className="text-xs text-gray-400 mt-1">0 = sem limite</p>
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-gray-600 mb-1">Validade dos links PAKT (meses)</label>
                          <input type="number" min={1} defaultValue={fuValidade}
                            onBlur={(e) => saveFu("follow_up_validade_meses", String(Math.max(1, parseInt(e.target.value, 10) || 24)))}
                            className="w-full border rounded-lg px-3 py-2 text-sm text-center" />
                          <p className="text-xs text-gray-400 mt-1">Links expirados são renovados</p>
                        </div>
                      </div>

                      <div>
                        <button type="button" onClick={() => setFollowUpMsgExpanded(v => !v)}
                          className="flex items-center gap-2 text-sm font-medium text-indigo-600 hover:text-indigo-800">
                          <span>{followUpMsgExpanded ? "▲" : "▼"}</span>
                          Mensagens personalizadas (opcional)
                        </button>
                        <p className="text-xs text-gray-400 mt-1">
                          Deixe em branco para usar os padrões. Use <code className="bg-gray-100 px-1 rounded">{"{{nome}}"}</code> e{" "}
                          <code className="bg-gray-100 px-1 rounded">{"{{links}}"}</code> como variáveis.
                        </p>
                        {followUpMsgExpanded && (
                          <div className="mt-3 space-y-4">
                            {[1, 2, 3, 4, 5].map((n) => {
                              const chave = `follow_up_msg_${n}`;
                              const labels = ["Mensagem dia 1 — Lembrete gentil", "Mensagem dia 2 — Reforço", "Mensagem dia 3 — Prazo prescricional", "Mensagem dia 4 — Urgência", "Mensagem dia 5+ — Última chamada"];
                              return (
                                <div key={chave}>
                                  <label className="block text-xs font-medium text-gray-600 mb-1">{labels[n - 1]}</label>
                                  <textarea rows={3} defaultValue={cfg[chave] ?? ""}
                                    onBlur={(e) => { if (e.target.value !== (cfg[chave] ?? "")) saveFu(chave, e.target.value); }}
                                    placeholder={`Deixe em branco para usar a mensagem padrão do dia ${n}...`}
                                    className="w-full border rounded-lg px-3 py-2 text-sm resize-none font-mono text-xs" />
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>

                      <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg text-xs text-blue-800 space-y-1">
                        <p><strong>Como funciona:</strong></p>
                        <ol className="list-decimal list-inside space-y-0.5 ml-1">
                          <li>Todo dia às 9h o cron verifica propostas aceitas com links PAKT não assinados</li>
                          <li>Consulta a API PAKT — se já assinou, marca como concluído e para</li>
                          <li>Se o link expirou, renova automaticamente via API PAKT antes de enviar</li>
                          <li>Envia mensagem pelo WhatsApp com tom escalante (dia 1 → gentil, dia 5+ → urgente)</li>
                        </ol>
                      </div>
                    </div>
                  )}
                </div>

                {/* Per-stage section header */}
                <div className="flex items-center gap-3">
                  <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider">Follow-up por Etapa do Funil</h2>
                  <div className="flex-1 border-t border-gray-200" />
                </div>
                <p className="text-xs text-gray-500 -mt-4">
                  Configure mensagens proativas por etapa. O cron roda a cada 15 minutos e dispara quando o lead fica em silêncio pelo tempo configurado.
                  Use <code className="bg-gray-100 px-1 rounded">{"{{nome}}"}</code> para o nome do cliente.
                </p>

                {/* Stage follow-up cards */}
                {STAGE_FOLLOWUP_DEFS.map((def, idx) => {
                  const query = stageFollowUpQueries[idx];
                  const serverData = query.data as { ativo: boolean; mensagens: { delayHoras: number; template: string }[] } | undefined;
                  const local = stageFollowLocal[def.stageChave];
                  const defaultMsgs = [{ delayHoras: 24, template: "" }, { delayHoras: 48, template: "" }, { delayHoras: 72, template: "" }];
                  const data = local ?? serverData ?? { ativo: false, mensagens: defaultMsgs };
                  const expanded = stageFollowExpanded[def.stageChave] ?? false;
                  const hasUnsaved = !!local;
                  const dotCls = stageCorMap[def.cor] ?? "bg-gray-400";

                  return (
                    <div key={def.stageChave} className="bg-white border rounded-xl overflow-hidden">
                      <button
                        type="button"
                        onClick={() => setStageFollowExpanded(v => ({ ...v, [def.stageChave]: !v[def.stageChave] }))}
                        className="w-full flex items-center justify-between px-5 py-4 text-left hover:bg-gray-50"
                      >
                        <div className="flex items-center gap-3">
                          <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${dotCls}`} />
                          <div>
                            <h3 className="font-semibold text-gray-800 text-sm">{def.label}</h3>
                            <p className="text-xs text-gray-500 mt-0.5">{def.desc}</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 ml-4 shrink-0">
                          {query.isLoading && <span className="text-xs text-gray-400">carregando…</span>}
                          {data.ativo && <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full">ativo</span>}
                          {hasUnsaved && <span className="text-xs bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full">não salvo</span>}
                          <span className="text-gray-400 text-sm">{expanded ? "▲" : "▼"}</span>
                        </div>
                      </button>

                      {expanded && (
                        <div className="border-t px-5 py-4 space-y-4">
                          <label className="flex items-start gap-3 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={data.ativo}
                              onChange={(e) => setStageFollowLocal(v => ({ ...v, [def.stageChave]: { ...data, ativo: e.target.checked } }))}
                              className="mt-0.5 h-4 w-4 rounded text-indigo-600"
                            />
                            <div>
                              <p className="text-sm font-medium text-gray-700">Ativar follow-up nesta etapa</p>
                              <p className="text-xs text-gray-500">Quando o lead fica em silêncio, o agente retoma o contato com mensagens escalantes.</p>
                            </div>
                          </label>

                          <div className="space-y-3">
                            {data.mensagens.map((msg, mIdx) => (
                              <div key={mIdx} className="border rounded-lg p-3 space-y-2">
                                <div className="flex items-center gap-2">
                                  <span className="text-xs font-medium text-gray-500 w-16 shrink-0">Mensagem {mIdx + 1}</span>
                                  <input
                                    type="number"
                                    min={1}
                                    value={msg.delayHoras}
                                    onChange={(e) => {
                                      const newMsgs = data.mensagens.map((m, i) =>
                                        i === mIdx ? { ...m, delayHoras: parseInt(e.target.value) || 24 } : m
                                      );
                                      setStageFollowLocal(v => ({ ...v, [def.stageChave]: { ...data, mensagens: newMsgs } }));
                                    }}
                                    className="w-16 border rounded px-2 py-1 text-sm text-center"
                                  />
                                  <span className="text-xs text-gray-500">horas após silêncio</span>
                                  {data.mensagens.length > 1 && (
                                    <button
                                      type="button"
                                      onClick={() => {
                                        const newMsgs = data.mensagens.filter((_, i) => i !== mIdx);
                                        setStageFollowLocal(v => ({ ...v, [def.stageChave]: { ...data, mensagens: newMsgs } }));
                                      }}
                                      className="ml-auto text-xs text-red-400 hover:text-red-600"
                                    >✕</button>
                                  )}
                                </div>
                                <textarea
                                  rows={3}
                                  value={msg.template}
                                  onChange={(e) => {
                                    const newMsgs = data.mensagens.map((m, i) =>
                                      i === mIdx ? { ...m, template: e.target.value } : m
                                    );
                                    setStageFollowLocal(v => ({ ...v, [def.stageChave]: { ...data, mensagens: newMsgs } }));
                                  }}
                                  placeholder={`Template da mensagem ${mIdx + 1}… Use {{nome}} para o nome do cliente.`}
                                  className="w-full border rounded-lg px-3 py-2 text-sm resize-none font-mono text-xs"
                                />
                              </div>
                            ))}

                            <button
                              type="button"
                              onClick={() => {
                                const lastDelay = data.mensagens[data.mensagens.length - 1]?.delayHoras ?? 24;
                                const newMsgs = [...data.mensagens, { delayHoras: lastDelay + 24, template: "" }];
                                setStageFollowLocal(v => ({ ...v, [def.stageChave]: { ...data, mensagens: newMsgs } }));
                              }}
                              className="text-xs text-indigo-600 hover:text-indigo-800"
                            >+ Adicionar mensagem</button>
                          </div>

                          <div className="flex justify-end">
                            <button
                              type="button"
                              disabled={saveStageFollowUp.isPending}
                              onClick={() => {
                                if (!projetoId) return;
                                saveStageFollowUp.mutate(
                                  { projetoId, stageChave: def.stageChave, ativo: data.ativo, mensagens: data.mensagens },
                                  {
                                    onSuccess: () => {
                                      setStageFollowLocal(v => { const n = { ...v }; delete n[def.stageChave]; return n; });
                                      query.refetch();
                                    },
                                  }
                                );
                              }}
                              className="px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50"
                            >
                              {saveStageFollowUp.isPending ? "Salvando…" : "Salvar"}
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })()}

          {/* ── Desqualificação tab ─────────────────────────────────────────── */}
          {tab === "desqualificacao" && projetoId && (
            <DesqualificacaoTab projetoId={projetoId} />
          )}

        </>
      )}
    </div>
  );
}

// ── DesqualificacaoTab ────────────────────────────────────────────────────────

const TIPOS_GATE: Record<string, string> = {
  prescricao:       "Prescrição 2 anos",
  empresa_bloqueada: "Empresa bloqueada",
  vinculo_invalido: "Vínculo inválido",
  nao_carreteiro:   "Não carreteiro",
  tempo_minimo:     "Tempo mínimo",
  campo_booleano:   "Campo booleano",
};

function DesqualificacaoTab({ projetoId }: { projetoId: string }) {
  const [novaEmpresa, setNovaEmpresa] = useState("");
  const [editingGateId, setEditingGateId] = useState<string | null>(null);
  const [editingGateMsg, setEditingGateMsg] = useState("");
  const [editingMesesMin, setEditingMesesMin] = useState<number>(2);
  const utils = trpc.useUtils();

  const gates = trpc.ia.listGatesSdr.useQuery({ projetoId });
  const empresas = trpc.ia.listEmpresasBloqueadas.useQuery({ projetoId });

  const toggleGate = trpc.ia.toggleGateSdr.useMutation({
    onSuccess: () => utils.ia.listGatesSdr.invalidate(),
  });
  const deleteGate = trpc.ia.deleteGateSdr.useMutation({
    onSuccess: () => { utils.ia.listGatesSdr.invalidate(); },
  });
  const updateGate = trpc.ia.updateGateSdr.useMutation({
    onSuccess: () => { utils.ia.listGatesSdr.invalidate(); setEditingGateId(null); },
  });
  const criarEmpresa = trpc.ia.criarEmpresaBloqueada.useMutation({
    onSuccess: () => { utils.ia.listEmpresasBloqueadas.invalidate(); setNovaEmpresa(""); },
  });
  const toggleEmpresa = trpc.ia.toggleEmpresaBloqueada.useMutation({
    onSuccess: () => utils.ia.listEmpresasBloqueadas.invalidate(),
  });
  const deleteEmpresa = trpc.ia.deleteEmpresaBloqueada.useMutation({
    onSuccess: () => utils.ia.listEmpresasBloqueadas.invalidate(),
  });

  const gatesList = (gates.data as any[] | undefined) ?? [];
  const empresasList = (empresas.data as any[] | undefined) ?? [];

  return (
    <div className="space-y-6">
      {/* Gates */}
      <div className="bg-white border rounded-xl p-5">
        <div className="mb-4">
          <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wider">Gates de Desqualificação</h3>
          <p className="text-xs text-gray-400 mt-0.5">
            Verificados automaticamente após cada campo coletado. Quando disparado, encerra a conversa e move para lead_desqualificado.
          </p>
        </div>
        {gatesList.length === 0 && (
          <p className="text-sm text-gray-400 text-center py-4">Nenhum gate configurado.</p>
        )}
        <div className="space-y-2">
          {gatesList.map((g: any) => (
            <div key={g.id} className={`flex items-start gap-3 border rounded-lg px-4 py-3 ${!g.ativo ? "opacity-50 bg-gray-50" : "bg-white"}`}>
              <div className="w-7 h-7 rounded-full flex items-center justify-center font-bold text-xs flex-shrink-0 bg-indigo-100 text-indigo-700">
                {g.ordem}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium text-gray-800 text-sm">{g.nome}</span>
                  <span className="text-xs px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700">
                    {TIPOS_GATE[g.tipo] ?? g.tipo}
                  </span>
                  {g.campoGatilho && (
                    <span className="text-xs text-gray-400 font-mono">→ {g.campoGatilho}</span>
                  )}
                  <span className={`text-xs px-2 py-0.5 rounded-full ${g.ativo ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-400"}`}>
                    {g.ativo ? "ativo" : "inativo"}
                  </span>
                </div>
                {editingGateId === g.id ? (
                  <div className="mt-2 space-y-2">
                    {g.tipo === "tempo_minimo" && (
                      <div className="flex items-center gap-2">
                        <label className="text-xs text-gray-600 whitespace-nowrap">Mínimo de meses:</label>
                        <input
                          type="number"
                          min={1}
                          max={24}
                          value={editingMesesMin}
                          onChange={e => setEditingMesesMin(Number(e.target.value))}
                          className="w-20 border rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
                        />
                        <span className="text-xs text-gray-400">mês(es) — vínculos abaixo disso pulam para emprego anterior</span>
                      </div>
                    )}
                    <textarea
                      rows={4}
                      value={editingGateMsg}
                      onChange={e => setEditingGateMsg(e.target.value)}
                      className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300 resize-none"
                    />
                    <div className="flex gap-2">
                      <button
                        onClick={() => updateGate.mutate({
                          id: g.id,
                          mensagemLead: editingGateMsg,
                          ...(g.tipo === "tempo_minimo" ? { mesesMin: editingMesesMin } : {}),
                        })}
                        disabled={updateGate.isLoading}
                        className="bg-indigo-600 text-white px-3 py-1 rounded text-xs font-medium hover:bg-indigo-700 disabled:opacity-50"
                      >
                        {updateGate.isLoading ? "..." : "Salvar"}
                      </button>
                      <button
                        onClick={() => setEditingGateId(null)}
                        className="text-xs text-gray-500 hover:underline"
                      >
                        Cancelar
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="mt-1">
                    {g.tipo === "tempo_minimo" && (
                      <p className="text-xs text-blue-600 font-medium mb-0.5">
                        Mínimo: {(g.condicaoJson as any)?.mesesMin ?? 2} mês(es)
                      </p>
                    )}
                    <p className="text-xs text-gray-500 line-clamp-2">{g.mensagemLead}</p>
                  </div>
                )}
              </div>
              <div className="flex gap-2 flex-shrink-0">
                <button
                  onClick={() => {
                    setEditingGateId(g.id);
                    setEditingGateMsg(g.mensagemLead);
                    setEditingMesesMin((g.condicaoJson as any)?.mesesMin ?? 2);
                  }}
                  className="text-xs text-indigo-600 hover:underline"
                >
                  Editar
                </button>
                <button
                  onClick={() => toggleGate.mutate({ id: g.id, ativo: !g.ativo })}
                  className="text-xs text-gray-500 hover:underline"
                >
                  {g.ativo ? "Desativar" : "Ativar"}
                </button>
                <button
                  onClick={() => { if (confirm(`Remover gate "${g.nome}"?`)) deleteGate.mutate({ id: g.id }); }}
                  className="text-xs text-red-500 hover:underline"
                >
                  Remover
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Empresas Bloqueadas */}
      <div className="bg-white border rounded-xl p-5">
        <div className="mb-4">
          <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wider">Empresas Bloqueadas</h3>
          <p className="text-xs text-gray-400 mt-0.5">
            Quando o lead informa o nome de uma empresa bloqueada, o gate "Empresa bloqueada" é disparado automaticamente.
          </p>
        </div>
        {empresasList.length === 0 && (
          <p className="text-sm text-gray-400 text-center py-3">Nenhuma empresa bloqueada.</p>
        )}
        <div className="space-y-1.5 mb-4">
          {empresasList.map((e: any) => (
            <div key={e.id} className={`flex items-center gap-3 border rounded-lg px-4 py-2.5 ${!e.ativo ? "opacity-50 bg-gray-50" : "bg-white"}`}>
              <div className="flex-1">
                <span className="text-sm text-gray-800">{e.nome}</span>
                <span className="ml-2 text-xs text-gray-400 font-mono">({e.nomeNorm})</span>
              </div>
              <span className={`text-xs px-2 py-0.5 rounded-full ${e.ativo ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-400"}`}>
                {e.ativo ? "ativa" : "inativa"}
              </span>
              <button
                onClick={() => toggleEmpresa.mutate({ id: e.id, ativo: !e.ativo })}
                className="text-xs text-indigo-600 hover:underline"
              >
                {e.ativo ? "Desativar" : "Ativar"}
              </button>
              <button
                onClick={() => { if (confirm(`Remover "${e.nome}"?`)) deleteEmpresa.mutate({ id: e.id }); }}
                className="text-xs text-red-500 hover:underline"
              >
                Remover
              </button>
            </div>
          ))}
        </div>
        <div className="flex gap-2">
          <input
            type="text"
            value={novaEmpresa}
            onChange={e => setNovaEmpresa(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter" && novaEmpresa.trim()) criarEmpresa.mutate({ projetoId, nome: novaEmpresa.trim() }); }}
            placeholder="Nome da empresa..."
            className="flex-1 border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
          />
          <button
            onClick={() => { if (novaEmpresa.trim()) criarEmpresa.mutate({ projetoId, nome: novaEmpresa.trim() }); }}
            disabled={criarEmpresa.isLoading || !novaEmpresa.trim()}
            className="bg-indigo-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:opacity-50"
          >
            {criarEmpresa.isLoading ? "..." : "+ Adicionar"}
          </button>
        </div>

      </div>
    </div>
  );
}

// ── FlowStepCard ───────────────────────────────────────────────────────────────

function FlowStepCard({
  step, idx, total, actionColors, stepTypeBadge, projetoId,
  onEdit, onDelete, onAddGate, onEditGate, onDeleteGate,
}: {
  step: any; idx: number; total: number;
  actionColors: Record<string, string>; stepTypeBadge: Record<string, string>;
  projetoId: string;
  onEdit: () => void; onDelete: () => void;
  onAddGate: () => void; onEditGate: (g: any) => void; onDeleteGate: (g: any) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="bg-white border rounded-lg overflow-hidden">
      {/* Step header */}
      <div
        className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-gray-50"
        onClick={() => setExpanded(e => !e)}
      >
        <span className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 ${stepTypeBadge[step.stepType] ?? "bg-gray-100 text-gray-600"}`}>
          {step.ordem}
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-gray-800 text-sm">{step.label}</span>
            <span className={`text-xs px-1.5 py-0.5 rounded font-mono ${stepTypeBadge[step.stepType] ?? "bg-gray-100 text-gray-500"}`}>{step.stepType}</span>
            {step.fase && <span className="text-xs text-gray-400 font-mono">{step.fase}</span>}
            {!step.ativo && <span className="text-xs text-red-400">inativo</span>}
          </div>
          <p className="text-xs text-gray-500 italic mt-0.5 truncate">{step.pergunta}</p>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0" onClick={e => e.stopPropagation()}>
          <button onClick={onEdit} className="text-xs text-indigo-600 hover:underline px-2 py-1">✎</button>
          <button onClick={onDelete} className="text-xs text-red-500 hover:underline px-2 py-1">✕</button>
          <span className="text-gray-300 ml-1">{expanded ? "▲" : "▼"}</span>
        </div>
      </div>

      {/* Expanded: full question + gates */}
      {expanded && (
        <div className="border-t bg-gray-50 px-4 py-3 space-y-3">
          <div>
            <p className="text-xs font-medium text-gray-500 mb-1">Pergunta completa</p>
            <p className="text-sm text-gray-700 bg-white border rounded p-2">{step.pergunta}</p>
          </div>

          {step.campoColetar && (
            <p className="text-xs text-gray-500">Campo coletado: <code className="bg-white border px-1 rounded">{step.campoColetar}</code></p>
          )}

          {/* Gates */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-medium text-gray-500">Gates ({step.gates?.length ?? 0})</p>
              <button onClick={onAddGate} className="text-xs text-indigo-600 hover:underline">+ Gate</button>
            </div>
            {(step.gates ?? []).length === 0 ? (
              <p className="text-xs text-gray-400 italic">Nenhum gate — etapa avança automaticamente (continue)</p>
            ) : (
              <div className="space-y-1.5">
                {(step.gates ?? []).map((g: any) => (
                  <div key={g.id} className="flex items-center gap-2 bg-white border rounded px-3 py-2">
                    <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: g.cor ?? "#6b7280" }} />
                    <span className="text-xs text-gray-700 flex-1">{g.condicao}</span>
                    <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${actionColors[g.actionType] ?? "bg-gray-100 text-gray-500"}`}>{g.actionType}</span>
                    {g.actionValue && <span className="text-xs text-gray-400 font-mono max-w-[120px] truncate">{g.actionValue}</span>}
                    <button onClick={() => onEditGate(g)} className="text-xs text-indigo-500 hover:underline ml-1">✎</button>
                    <button onClick={() => onDeleteGate(g)} className="text-xs text-red-400 hover:underline">✕</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
