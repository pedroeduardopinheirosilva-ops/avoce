import { useState, useEffect, useRef, useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import { trpc } from "../lib/trpc";
import { useVoip } from "../contexts/VoipContext";
import { DealModal, type Deal, type Stage } from "./Crm";
import { Avatar } from "../components/Avatar";
import { OrigemBadge, type DealOrigem } from "../components/OrigemLead";
import { SdrAcoes } from "../components/SdrAcoes";

type Conversa = {
  id: string;
  titulo: string;
  iaAtiva: boolean;
  iaStageChave: string | null;
  iaPersonaChave: string | null;
  ultimoContatoEm: string | null;
  sdrNome: string | null;
  pipelineId?: string;
  status?: string;
  motivoPerda?: string | null;
  proximoContatoEm?: string | null;
  pipeline?: { id: string; nome: string; cor: string } | null;
  tags?: TagMini[];
  contato: {
    id: string; nome: string; whatsapp: string | null; fotoPerfilUrl?: string | null; fotoPerfilEm?: string | null;
    instagramId?: string | null; instagramUsername?: string | null; messengerId?: string | null;
  } | null;
  mensagens: {
    id: string;
    direcao: string;
    canal?: string;
    conteudo: string | null;
    personaChave: string | null;
    enviadaEm: string;
  }[];
} & DealOrigem;

/** Canal da conversa: o da última mensagem; sem mensagem, o id que o contato tiver. */
function canalDaConversa(d: Pick<Conversa, "contato" | "mensagens">): "whatsapp" | "instagram" | "messenger" {
  const c = d.mensagens?.[0]?.canal;
  if (c === "instagram" || c === "messenger") return c;
  if (d.contato?.whatsapp) return "whatsapp";
  if (d.contato?.instagramId) return "instagram";
  if (d.contato?.messengerId) return "messenger";
  return "whatsapp";
}

function SeloCanal({ canal }: { canal: "whatsapp" | "instagram" | "messenger" }) {
  if (canal === "whatsapp") return null;
  const ig = canal === "instagram";
  return (
    <span
      title={ig ? "Instagram Direct" : "Messenger (Facebook)"}
      className={`inline-flex items-center px-1.5 rounded text-[10px] font-semibold text-white ${ig ? "bg-gradient-to-r from-fuchsia-500 to-orange-400" : "bg-blue-600"}`}
    >
      {ig ? "IG" : "FB"}
    </span>
  );
}

type TagMini = { id: string; nome: string; cor: string; pipelineId?: string | null };

type Filtros = {
  pipelineId: string | null;
  tagIds: string[];
  semTag: boolean;
  atendimento: "ia" | "humano" | null;
  aguardando: boolean;
  followup: boolean;
  semComentarios: boolean;
};

const FILTROS_VAZIOS: Filtros = { pipelineId: null, tagIds: [], semTag: false, atendimento: null, aguardando: false, followup: false, semComentarios: false };
const FILTROS_STORAGE_KEY = "avoce_whatsapp_filtros";

function lerFiltrosSalvos(): Filtros {
  try {
    const raw = localStorage.getItem(FILTROS_STORAGE_KEY);
    return raw ? { ...FILTROS_VAZIOS, ...JSON.parse(raw) } : FILTROS_VAZIOS;
  } catch {
    return FILTROS_VAZIOS;
  }
}

/** Filtros no formato do tRPC (sem os campos vazios). */
function filtrosParaQuery(f: Filtros) {
  return {
    ...(f.pipelineId ? { pipelineId: f.pipelineId } : {}),
    ...(f.tagIds.length ? { tagIds: f.tagIds } : f.semTag ? { semTag: true } : {}),
    ...(f.atendimento ? { atendimento: f.atendimento } : {}),
    ...(f.aguardando ? { aguardando: true } : {}),
    ...(f.followup ? { followup: true } : {}),
    ...(f.semComentarios ? { semComentarios: true } : {}),
  };
}

/** Chip de tag: cor de fundo clara com texto na cor da tag, legível em qualquer cor. */
function TagChip({ tag, onRemove, small }: { tag: TagMini; onRemove?: () => void; small?: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full font-medium border whitespace-nowrap ${small ? "text-[10px] px-1.5 py-0" : "text-xs px-2 py-0.5"}`}
      style={{ backgroundColor: tag.cor + "1f", color: tag.cor, borderColor: tag.cor + "55" }}
    >
      {tag.nome}
      {onRemove && (
        <button onClick={onRemove} className="hover:opacity-60 leading-none" title={`Remover "${tag.nome}"`}>×</button>
      )}
    </span>
  );
}

const CORES_TAG = ["#6366f1", "#10b981", "#f59e0b", "#ef4444", "#06b6d4", "#8b5cf6", "#ec4899", "#64748b"];

/**
 * Tags da conversa aberta: mostra as do deal e abre um seletor com as tags do
 * funil do deal + as gerais, com criação rápida já vinculada ao funil.
 */
function DealTagsEditor({ dealId, pipelineId, pipelineNome, tags, onChange }: {
  dealId: string;
  pipelineId: string | undefined;
  pipelineNome: string | undefined;
  tags: TagMini[];
  onChange: () => void;
}) {
  const [aberto, setAberto] = useState(false);
  const [novaTag, setNovaTag] = useState("");
  const [novaCor, setNovaCor] = useState(CORES_TAG[0]);
  const [doFunil, setDoFunil] = useState(true);
  const boxRef = useRef<HTMLDivElement>(null);
  const disponiveis = trpc.crm.listTags.useQuery(
    pipelineId ? { pipelineId } : undefined,
    { enabled: aberto, staleTime: 30_000 },
  );
  const utils = trpc.useUtils();
  const toggle = trpc.crm.toggleDealTag.useMutation({ onSuccess: onChange });
  const criar = trpc.crm.createTag.useMutation({
    onSuccess: (tag) => {
      setNovaTag("");
      utils.crm.listTags.invalidate();
      toggle.mutate({ dealId, tagId: tag.id, ativo: true });
    },
    onError: (err) => alert("Erro ao criar tag: " + err.message),
  });

  useEffect(() => {
    if (!aberto) return;
    const fechar = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setAberto(false);
    };
    document.addEventListener("mousedown", fechar);
    return () => document.removeEventListener("mousedown", fechar);
  }, [aberto]);

  const ativas = new Set(tags.map((t) => t.id));
  const lista = (disponiveis.data ?? []) as TagMini[];
  const gerais = lista.filter((t) => !t.pipelineId);
  const doFunilLista = lista.filter((t) => t.pipelineId);

  const item = (t: TagMini) => (
    <label key={t.id} className="flex items-center gap-2 px-2 py-1 rounded hover:bg-gray-50 cursor-pointer text-sm">
      <input
        type="checkbox"
        checked={ativas.has(t.id)}
        onChange={(e) => toggle.mutate({ dealId, tagId: t.id, ativo: e.target.checked })}
        className="accent-indigo-600"
      />
      <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: t.cor }} />
      <span className="truncate text-gray-700">{t.nome}</span>
    </label>
  );

  return (
    <div className="relative flex items-center gap-1 flex-wrap" ref={boxRef}>
      {tags.map((t) => (
        <TagChip key={t.id} tag={t} onRemove={() => toggle.mutate({ dealId, tagId: t.id, ativo: false })} />
      ))}
      <button
        onClick={() => setAberto((v) => !v)}
        className="text-xs px-2 py-0.5 rounded-full border border-dashed border-gray-300 text-gray-500 hover:border-indigo-400 hover:text-indigo-600"
      >
        + tag
      </button>
      {aberto && (
        <div className="absolute top-full left-0 mt-1 w-64 bg-white border rounded-xl shadow-lg z-30 p-2">
          {disponiveis.isLoading && <p className="text-xs text-gray-400 p-2">Carregando…</p>}
          {doFunilLista.length > 0 && (
            <>
              <p className="text-[10px] uppercase tracking-wide text-gray-400 px-2 pt-1">Funil {pipelineNome ?? ""}</p>
              {doFunilLista.map(item)}
            </>
          )}
          {gerais.length > 0 && (
            <>
              <p className="text-[10px] uppercase tracking-wide text-gray-400 px-2 pt-2">Gerais</p>
              {gerais.map(item)}
            </>
          )}
          {!disponiveis.isLoading && lista.length === 0 && (
            <p className="text-xs text-gray-400 px-2 py-1">Nenhuma tag ainda.</p>
          )}
          <form
            className="border-t mt-2 pt-2 space-y-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              if (!novaTag.trim()) return;
              criar.mutate({ nome: novaTag.trim(), cor: novaCor, pipelineId: doFunil && pipelineId ? pipelineId : null });
            }}
          >
            <input
              value={novaTag}
              onChange={(e) => setNovaTag(e.target.value)}
              placeholder="Nova tag…"
              className="w-full border rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-400"
            />
            <div className="flex items-center gap-1">
              {CORES_TAG.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setNovaCor(c)}
                  className={`w-4 h-4 rounded-full ${novaCor === c ? "ring-2 ring-offset-1 ring-gray-400" : ""}`}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
            {pipelineId && (
              <label className="flex items-center gap-1.5 text-[11px] text-gray-500">
                <input type="checkbox" checked={doFunil} onChange={(e) => setDoFunil(e.target.checked)} className="accent-indigo-600" />
                Só deste funil{pipelineNome ? ` (${pipelineNome})` : ""}
              </label>
            )}
            <button
              type="submit"
              disabled={!novaTag.trim() || criar.isLoading}
              className="w-full text-xs bg-indigo-600 text-white py-1 rounded hover:bg-indigo-700 disabled:opacity-40"
            >
              Criar e aplicar
            </button>
          </form>
        </div>
      )}
    </div>
  );
}

type Mensagem = {
  id: string;
  direcao: string;
  tipo: string;
  conteudo: string | null;
  personaChave: string | null;
  remetente: string | null;
  enviadaEm: string;
  midiaUrl?: string | null;
  evolutionMessageId?: string | null;
  canal?: string;
  citacaoEvolutionId?: string | null;
  citacaoTexto?: string | null;
};

/** Texto de uma mensagem para a citação: sem o "*Nome*" que abre a mensagem do atendente. */
function textoParaCitacao(m: Pick<Mensagem, "conteudo" | "tipo">): string {
  const t = (m.conteudo ?? "").replace(/^\*[^*\n]{1,60}\*\n/, "").trim();
  if (t) return t;
  return ({ image: "📷 Imagem", audio: "🎤 Áudio", video: "🎥 Vídeo", document: "📎 Arquivo" } as Record<string, string>)[m.tipo] ?? "Mensagem";
}

/** Bloco da mensagem citada (igual ao "Responder" do WhatsApp). */
function BlocoCitacao({ autor, texto, isOut, onClick, onClose }: {
  autor: string; texto: string; isOut: boolean; onClick?: () => void; onClose?: () => void;
}) {
  return (
    <div
      onClick={onClick}
      className={`flex items-start gap-2 rounded-lg border-l-4 px-2 py-1 mb-1 text-xs ${onClick ? "cursor-pointer" : ""} ${
        isOut ? "bg-indigo-500/60 border-indigo-200 text-indigo-50" : "bg-gray-100 border-emerald-500 text-gray-600"
      }`}
    >
      <div className="min-w-0 flex-1">
        <p className={`font-semibold ${isOut ? "text-indigo-100" : "text-emerald-700"}`}>{autor}</p>
        <p className="line-clamp-3 whitespace-pre-wrap break-words">{texto}</p>
      </div>
      {onClose && (
        <button type="button" onClick={(e) => { e.stopPropagation(); onClose(); }}
          title="Cancelar resposta" className="text-gray-400 hover:text-gray-700 text-sm leading-none">✕</button>
      )}
    </div>
  );
}

type NotifLog = {
  id: string;
  evento: string;
  destino: string;
  mensagem: string;
  nomeLead: string | null;
  enviadaEm: string;
};

// Nome do lead + código dos 4 últimos dígitos do WhatsApp ("João Silva - 1234"), o mesmo
// do card do Funil CRM: distingue homônimos e permite achar o lead pelo número.
const nomeComCodigo = (deal: { titulo: string; contato?: { nome: string; whatsapp: string | null } | null }): string => {
  const nome = deal.contato?.nome ?? deal.titulo;
  const last4 = deal.contato?.whatsapp?.replace(/\D/g, "").slice(-4);
  return last4 && !nome.endsWith(last4) ? `${nome} - ${last4}` : nome;
};

const PERSONA_COLORS: Record<string, string> = {
  assistente: "bg-blue-100 text-blue-800",
  advogado: "bg-purple-100 text-purple-800",
  closer: "bg-orange-100 text-orange-800",
};

// Último recurso, só para chave sem persona cadastrada. Os nomes de verdade vêm
// do banco (ia.listPersonas): este mapa ficou anos desatualizado — mostrava "Ana"
// onde a persona já se chamava Isabella, e não conhecia coleta_docs nem secretaria.
const PERSONA_NAMES_FALLBACK: Record<string, string> = {
  assistente: "Assistente",
  advogado: "Advogada",
  closer: "Closer",
};

const EVENTO_LABELS: Record<string, string> = {
  qualificacao_completa: "Qualificação",
  solicita_ligacao: "Ligação",
  descarte_revisao_humana: "Descarte",
  documentos_pessoais: "Documentos",
  fluxo_concluido: "Concluído",
};

function formatTime(iso: string) {
  const d = new Date(iso);
  return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

/** Data + hora sob cada mensagem da conversa ("10/11/2026 14:32"). */
function formatDataHoraCompleta(iso: string) {
  const d = new Date(iso);
  return `${d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" })} ${d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`;
}

// O agente assina a mensagem com "*Nome*" na primeira linha, e a bolha já mostra
// o remetente à parte — repetir vira ruído. Antes a lista de nomes era fixa (só
// Ana e Dra. Daniela), então "Nelson" e "Isabella" apareciam soltos no texto.
// Casa qualquer nome curto em negrito seguido de quebra de linha ou dois-pontos.
const PERSONA_PREFIX_RE = /^\*[^*\n]{2,40}\*\s*[\n:]\s*/;

function formatWhatsApp(text: string, stripPrefix = false) {
  const cleaned = stripPrefix ? text.replace(PERSONA_PREFIX_RE, "") : text;
  // O texto vem do lead (terceiro): escapa ANTES de virar HTML no dangerouslySetInnerHTML
  return cleaned
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;")
    // Links clicáveis (ex.: post de origem do comentário). Já escapado: não fecha o atributo.
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer" class="underline break-all">$1</a>')
    .replace(/\*([^*]+)\*/g, "<strong>$1</strong>")
    .replace(/\n/g, "<br/>");
}

/** Data curta + hora — a lista de busca cruza conversas de meses diferentes. */
function formatDataHora(iso: string) {
  const d = new Date(iso);
  const hoje = new Date();
  const mesmoDia = d.toDateString() === hoje.toDateString();
  return mesmoDia
    ? d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "2-digit" });
}

/** Atrasa o valor para não disparar uma busca por tecla digitada. */
function useDebounced<T>(valor: T, ms = 350): T {
  const [v, setV] = useState(valor);
  useEffect(() => {
    const t = setTimeout(() => setV(valor), ms);
    return () => clearTimeout(t);
  }, [valor, ms]);
  return v;
}

/** Marca o termo buscado dentro do trecho. */
function Realce({ texto, termo }: { texto: string; termo: string }) {
  const t = termo.trim();
  if (!t) return <>{texto}</>;
  const i = texto.toLowerCase().indexOf(t.toLowerCase());
  if (i < 0) return <>{texto}</>;
  return (
    <>
      {texto.slice(0, i)}
      <mark className="bg-yellow-200 text-gray-900 rounded px-0.5">{texto.slice(i, i + t.length)}</mark>
      {texto.slice(i + t.length)}
    </>
  );
}

type SidebarTab = "conversas" | "notificacoes";

type ConversaBusca = Conversa & {
  match: { tipo: "mensagem" | "contato"; trecho: string; direcao: string; enviadaEm: string | null; total: number };
};

function MessageBubble({ msg, senderLabel, isOut, citacao }: {
  msg: Mensagem; senderLabel: string | null; isOut: boolean; citacao?: React.ReactNode;
}) {
  const tipo = msg.tipo;
  const conteudo = msg.conteudo ?? "";

  if (tipo === "audio") {
    const midiaUrl = (msg as any).midiaUrl ?? null;
    const token = localStorage.getItem("avoce_token") ?? "";
    const audioSrc = midiaUrl ? `${midiaUrl}?token=${encodeURIComponent(token)}` : null;
    return (
      <div className={`max-w-xs lg:max-w-md px-4 py-2 rounded-2xl shadow-sm ${isOut ? "bg-indigo-600 text-white rounded-br-sm" : "bg-white text-gray-800 rounded-bl-sm border"}`}>
        {senderLabel && <p className={`text-xs font-semibold mb-1 ${isOut ? "text-indigo-200" : "text-gray-400"}`}>{senderLabel}</p>}
        {citacao}
        {audioSrc ? (
          <audio controls src={audioSrc} className="w-full max-w-[240px] my-1" style={{ height: 32 }} />
        ) : (
          <p className={`text-xs opacity-75 mb-1 ${isOut ? "text-indigo-200" : "text-gray-400"}`}>{isOut ? "🔊 Áudio enviado" : "🎤 Áudio"}</p>
        )}
        {conteudo && <div className={`text-sm whitespace-pre-wrap mt-1 ${isOut ? "text-indigo-100" : "text-gray-600"} italic`} dangerouslySetInnerHTML={{ __html: formatWhatsApp(conteudo, false) }} />}
      </div>
    );
  }

  if (tipo === "image") {
    const src = (msg as any).midiaUrl ?? null;
    return (
      <div className={`max-w-xs lg:max-w-md px-4 py-2 rounded-2xl shadow-sm ${isOut ? "bg-indigo-600 text-white rounded-br-sm" : "bg-white text-gray-800 rounded-bl-sm border"}`}>
        {senderLabel && <p className={`text-xs font-semibold mb-1 ${isOut ? "text-indigo-200" : "text-gray-400"}`}>{senderLabel}</p>}
        {citacao}
        {src
          ? <img src={src} alt="imagem" className="rounded max-w-full max-h-52 object-contain" />
          : <p className="text-sm">🖼️ {conteudo || "Imagem"}</p>}
      </div>
    );
  }

  if (tipo === "document" || tipo === "video") {
    const icon = tipo === "video" ? "🎥" : "📎";
    const src = (msg as any).midiaUrl ?? null;
    return (
      <div className={`max-w-xs lg:max-w-md px-4 py-2 rounded-2xl shadow-sm ${isOut ? "bg-indigo-600 text-white rounded-br-sm" : "bg-white text-gray-800 rounded-bl-sm border"}`}>
        {senderLabel && <p className={`text-xs font-semibold mb-1 ${isOut ? "text-indigo-200" : "text-gray-400"}`}>{senderLabel}</p>}
        {citacao}
        {src
          ? <a href={src} target="_blank" rel="noopener noreferrer" className="text-sm underline">{icon} {conteudo || "Arquivo"}</a>
          : <p className="text-sm">{icon} {conteudo || "Arquivo"}</p>}
      </div>
    );
  }

  return (
    <div className={`max-w-xs lg:max-w-md px-4 py-2 rounded-2xl shadow-sm ${isOut ? "bg-indigo-600 text-white rounded-br-sm" : "bg-white text-gray-800 rounded-bl-sm border"}`}>
      {senderLabel && <p className={`text-xs font-semibold mb-1 ${isOut ? "text-indigo-200" : "text-gray-400"}`}>{senderLabel}</p>}
        {citacao}
      <div className="text-sm whitespace-pre-wrap" dangerouslySetInnerHTML={{ __html: formatWhatsApp(conteudo, isOut && !!senderLabel) }} />
    </div>
  );
}

export default function WhatsappPage() {
  const [searchParams] = useSearchParams();
  const [projetoId, setProjetoId] = useState<string | null>(null);
  const [dealId, setDealId] = useState<string | null>(searchParams.get("dealId"));
  const [notifDestino, setNotifDestino] = useState<string | null>(null);
  const [manualMsg, setManualMsg] = useState("");
  const [respondendoA, setRespondendoA] = useState<Mensagem | null>(null);
  const inputMsgRef = useRef<HTMLInputElement>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [buscaGlobal, setBuscaGlobal] = useState("");
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("conversas");
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessingAudio, setIsProcessingAudio] = useState(false);
  const [isSendingFile, setIsSendingFile] = useState(false);
  const [showNovaConversa, setShowNovaConversa] = useState(false);
  const [editDealOpen, setEditDealOpen] = useState(false);
  const [filtros, setFiltros] = useState<Filtros>(lerFiltrosSalvos);
  const [mostrarTodasTags, setMostrarTodasTags] = useState(false);
  const { ligar, callStatus } = useVoip();
  const [novaConvForm, setNovaConvForm] = useState({ whatsapp: "", nome: "", mensagem: "" });
  // Projeto (= número/instância) por onde a conversa nova sai. Vazio até o operador escolher:
  // antes ia sempre pelo primeiro projeto (Carreteiros → número da RAP).
  const [novaConvProjetoId, setNovaConvProjetoId] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<BlobPart[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const projetos = trpc.ia.listProjetos.useQuery();
  const filtrosQuery = filtrosParaQuery(filtros);
  const conversas = trpc.ia.listConversas.useQuery(
    filtrosQuery,
    { refetchInterval: 10_000, keepPreviousData: true }
  );
  const resumo = trpc.ia.resumoConversas.useQuery(
    {
      ...(filtros.pipelineId ? { pipelineId: filtros.pipelineId } : {}),
      ...(filtros.semComentarios ? { semComentarios: true } : {}),
    },
    { refetchInterval: 30_000, keepPreviousData: true }
  );
  const filtrosAtivos =
    !!filtros.pipelineId || filtros.tagIds.length > 0 || filtros.semTag || !!filtros.atendimento || filtros.aguardando || filtros.followup || filtros.semComentarios;

  useEffect(() => {
    try { localStorage.setItem(FILTROS_STORAGE_KEY, JSON.stringify(filtros)); } catch { /* modo privado */ }
  }, [filtros]);

  // Funil salvo que sumiu (desativado, outro escritório) não pode deixar a caixa vazia sem motivo.
  useEffect(() => {
    if (!filtros.pipelineId || !resumo.data) return;
    if (!resumo.data.pipelines.some((p) => p.id === filtros.pipelineId)) setFiltros(FILTROS_VAZIOS);
  }, [resumo.data, filtros.pipelineId]);

  function escolherFunil(pipelineId: string | null) {
    // Tag de outro funil não faz sentido no funil novo; as gerais continuam valendo.
    const tagsValidas = new Set(
      (resumo.data?.tags ?? []).filter((t) => !t.pipelineId || t.pipelineId === pipelineId).map((t) => t.id),
    );
    setFiltros((f) => ({ ...f, pipelineId, tagIds: pipelineId ? f.tagIds.filter((id) => tagsValidas.has(id)) : f.tagIds }));
  }

  function alternarTag(tagId: string) {
    setFiltros((f) => ({
      ...f,
      semTag: false,
      tagIds: f.tagIds.includes(tagId) ? f.tagIds.filter((id) => id !== tagId) : [...f.tagIds, tagId],
    }));
  }
  const buscaDebounced = useDebounced(buscaGlobal);
  const buscaAtiva = buscaDebounced.trim().length >= 2;
  const resultados = trpc.ia.buscarConversas.useQuery(
    { q: buscaDebounced.trim(), ...filtrosQuery },
    { enabled: buscaAtiva && sidebarTab === "conversas", keepPreviousData: true }
  );
  // Com termo na busca da conversa, o servidor procura no histórico inteiro do
  // deal (não só nas 100 últimas, que era tudo que o filtro client-side via).
  const msgQuery = useDebounced(searchQuery);
  const mensagens = trpc.ia.getMensagens.useQuery(
    { dealId: dealId ?? "", ...(msgQuery.trim().length >= 2 ? { q: msgQuery.trim() } : {}) },
    { enabled: !!dealId, refetchInterval: msgQuery.trim().length >= 2 ? false : 5_000 }
  );
  const notifLogs = trpc.ia.listNotificacaoLogs.useQuery(
    { projetoId: projetoId ?? "" },
    { enabled: !!projetoId && sidebarTab === "notificacoes", refetchInterval: 15_000 }
  );

  const personas = trpc.ia.listPersonas.useQuery(
    { projetoId: projetoId ?? "" },
    { enabled: !!projetoId, staleTime: 5 * 60_000 },
  );
  /** Nome de exibição da persona, como cadastrado no projeto. */
  const nomePersona = (chave: string | null | undefined): string => {
    if (!chave) return "";
    const p = (personas.data as Array<{ chave: string; nomeExibicao: string }> | undefined)
      ?.find(x => x.chave === chave);
    return p?.nomeExibicao || PERSONA_NAMES_FALLBACK[chave] || chave;
  };

  const dealDaLista =
    (conversas.data as unknown as Conversa[] | undefined)?.find((d) => d.id === dealId) ??
    (resultados.data as unknown as ConversaBusca[] | undefined)?.find((d) => d.id === dealId);
  // Fallback: fetch deal directly when navigated from CRM (deal may have no messages yet)
  const dealById = trpc.crm.getDeal.useQuery(
    { id: dealId ?? "" },
    { enabled: !!dealId && !dealDaLista && conversas.isFetched }
  );
  const dealAtual = dealDaLista ?? (dealById.data as unknown as Conversa | undefined);
  const canalAtual = dealAtual ? canalDaConversa(dealAtual) : "whatsapp";

  const togglePausa = trpc.ia.toggleIaPausa.useMutation({
    onSuccess: () => { conversas.refetch(); dealById.refetch(); },
  });
  const [menuApagarId, setMenuApagarId] = useState<string | null>(null);
  const utilsApagar = trpc.useUtils();
  const apagarMensagem = trpc.ia.apagarMensagem.useMutation({
    onSuccess: () => { setMenuApagarId(null); mensagens.refetch(); utilsApagar.ia.listConversas.invalidate(); },
    onError: (e) => { setMenuApagarId(null); window.alert(e.message); },
  });
  const sendManual = trpc.ia.sendMensagemManual.useMutation({
    onSuccess: () => { setManualMsg(""); setRespondendoA(null); mensagens.refetch(); },
    onError: (err) => alert("Erro ao enviar: " + err.message),
  });

  const sendAudio = trpc.ia.sendAudioManual.useMutation({
    onSuccess: () => mensagens.refetch(),
    onError: (err) => alert("Erro ao enviar áudio: " + err.message),
    onSettled: () => setIsProcessingAudio(false),
  });

  const sendArquivo = trpc.ia.sendArquivoManual.useMutation({
    onSuccess: () => mensagens.refetch(),
    onSettled: () => setIsSendingFile(false),
    onError: (err) => alert("Erro ao enviar arquivo: " + err.message),
  });

  const canaisNovaConversa = trpc.ia.listCanaisNovaConversa.useQuery(undefined, {
    enabled: showNovaConversa, staleTime: 60_000,
  });
  useEffect(() => {
    const cs = canaisNovaConversa.data;
    if (showNovaConversa && cs?.length === 1 && !novaConvProjetoId) setNovaConvProjetoId(cs[0].projetoId);
  }, [showNovaConversa, canaisNovaConversa.data, novaConvProjetoId]);
  function fecharNovaConversa() {
    setShowNovaConversa(false);
    setNovaConvForm({ whatsapp: "", nome: "", mensagem: "" });
    setNovaConvProjetoId("");
    iniciarNovaConversa.reset();
  }

  const iniciarNovaConversa = trpc.ia.iniciarNovaConversa.useMutation({
    onSuccess: (res) => {
      setDealId(res.dealId);
      setSidebarTab("conversas");
      fecharNovaConversa();
      conversas.refetch();
    },
  });
  const dealPipelineId = (dealAtual as any)?.stage?.pipelineId as string | undefined;
  const editStages = trpc.crm.listStages.useQuery(
    { pipelineId: dealPipelineId ?? "" },
    { enabled: editDealOpen && !!dealPipelineId }
  );

  // Agrupar logs por destinatário
  const allLogs = (notifLogs.data as unknown as NotifLog[] | undefined) ?? [];
  const destinosMap = allLogs.reduce<Record<string, NotifLog[]>>((acc, n) => {
    if (!acc[n.destino]) acc[n.destino] = [];
    acc[n.destino].push(n);
    return acc;
  }, {});
  const destinos = Object.entries(destinosMap).sort(([, a], [, b]) =>
    new Date(b[0].enviadaEm).getTime() - new Date(a[0].enviadaEm).getTime()
  );
  const notifConversa = notifDestino ? (destinosMap[notifDestino] ?? []).slice().reverse() : [];

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [mensagens.data, notifConversa.length]);

  useEffect(() => {
    const ps = projetos.data as { id: string }[] | undefined;
    if (!projetoId && ps?.[0]) setProjetoId(ps[0].id);
  }, [projetos.data, projetoId]);

  function handleTogglePausa() {
    if (!dealId || !dealAtual) return;
    togglePausa.mutate({ dealId, pausar: !!dealAtual.iaAtiva });
  }

  function handleSend(e: React.FormEvent) {
    e.preventDefault();
    if (!dealId || !manualMsg.trim()) return;
    sendManual.mutate({ dealId, conteudo: manualMsg.trim(), ...(respondendoA ? { respondeAId: respondendoA.id } : {}) });
  }

  // Trocar de conversa descarta a resposta em andamento.
  useEffect(() => { setRespondendoA(null); }, [dealId]);

  function autorDaMensagem(m: Mensagem): string {
    if (m.direcao === "out") return m.remetente ?? (m.personaChave ? nomePersona(m.personaChave) : null) ?? "Você";
    return dealAtual?.contato?.nome ?? "Contato";
  }

  function irParaMensagem(evolutionId: string) {
    const el = document.getElementById(`msg-${evolutionId}`);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("ring-2", "ring-yellow-300", "rounded-2xl");
    setTimeout(() => el.classList.remove("ring-2", "ring-yellow-300", "rounded-2xl"), 1500);
  }

  async function toggleRecording() {
    if (isRecording) {
      mediaRecorderRef.current?.stop();
      mediaRecorderRef.current = null;
      setIsRecording(false);
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      alert("Gravação de áudio não suportada neste navegador. Use Chrome ou Firefox.");
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      alert("Sem permissão para gravar áudio. Verifique as permissões do navegador.");
      return;
    }
    try {
      const mr = new MediaRecorder(stream);
      const mimeType = mr.mimeType;
      audioChunksRef.current = [];
      mr.ondataavailable = (e) => { if (e.data.size > 0) audioChunksRef.current.push(e.data); };
      mr.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        if (!dealId) return;
        const blob = new Blob(audioChunksRef.current, { type: mimeType || "audio/webm" });
        try {
          const base64 = await new Promise<string>((res, rej) => {
            const reader = new FileReader();
            reader.onloadend = () => res((reader.result as string).split(",")[1]);
            reader.onerror = rej;
            reader.readAsDataURL(blob);
          });
          setIsProcessingAudio(true);
          const clean = (mimeType || "audio/webm").split(";")[0];
          sendAudio.mutate({ dealId, audioBase64: base64, mimeType: clean });
        } catch (e2) {
          console.error("Erro ao processar áudio:", e2);
          alert("Erro ao processar áudio.");
        }
      };
      mr.start();
      mediaRecorderRef.current = mr;
      setIsRecording(true);
    } catch (e) {
      stream.getTracks().forEach((t) => t.stop());
      console.error("Erro ao iniciar gravação:", e);
      alert("Erro ao iniciar gravação: " + (e instanceof Error ? e.message : String(e)));
    }
  }

  const handleFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!dealId || !e.target.files?.[0]) return;
    const file = e.target.files[0];
    e.target.value = "";
    const MAX = 20 * 1024 * 1024;
    if (file.size > MAX) { alert("Arquivo muito grande (máx 20 MB)."); return; }
    try {
      const base64 = await new Promise<string>((res, rej) => {
        const reader = new FileReader();
        reader.onloadend = () => res((reader.result as string).split(",")[1]);
        reader.onerror = rej;
        reader.readAsDataURL(file);
      });
      setIsSendingFile(true);
      sendArquivo.mutate({ dealId, arquivoBase64: base64, mimeType: file.type, fileName: file.name });
    } catch { alert("Erro ao ler arquivo."); }
  }, [dealId, sendArquivo]);

  // Ao trocar de aba, limpa seleção do outro tipo
  function handleTabChange(tab: SidebarTab) {
    setSidebarTab(tab);
    if (tab === "notificacoes") { setDealId(null); }
    else { setNotifDestino(null); }
  }

  const showNotifConv = sidebarTab === "notificacoes" && !!notifDestino;
  const isLoadingDeal = sidebarTab === "conversas" && !!dealId && !dealAtual && (dealById.isLoading || conversas.isLoading || conversas.isFetching);
  const showLeadConv = sidebarTab === "conversas" && !!dealId && !!dealAtual;

  return (
    <div className="flex h-screen bg-gray-50">
      {/* Sidebar */}
      <div className="w-80 bg-white border-r flex flex-col">
        <div className="p-4 border-b">
          <div className="flex items-center justify-between">
            <h1 className="text-lg font-bold text-gray-800">Chat</h1>
            {projetoId && (
              <button onClick={() => setShowNovaConversa(true)}
                title="Nova Conversa"
                className="w-7 h-7 flex items-center justify-center rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 text-lg leading-none">
                +
              </button>
            )}
          </div>

          <div className="flex mt-3 gap-1">
            <button
              onClick={() => handleTabChange("conversas")}
              className={`flex-1 text-xs py-1.5 rounded-lg font-medium transition-colors ${
                sidebarTab === "conversas" ? "bg-indigo-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
              }`}
            >
              Conversas
            </button>
            <button
              onClick={() => handleTabChange("notificacoes")}
              className={`flex-1 text-xs py-1.5 rounded-lg font-medium transition-colors ${
                sidebarTab === "notificacoes" ? "bg-indigo-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
              }`}
            >
              Notificações
            </button>
          </div>

          {sidebarTab === "conversas" && (
            <div className="relative flex items-center mt-2">
              <input
                type="text"
                value={buscaGlobal}
                onChange={(e) => setBuscaGlobal(e.target.value)}
                placeholder="Buscar nome, número ou palavra…"
                className="w-full pl-8 pr-7 py-1.5 text-sm border rounded-lg bg-gray-50 focus:outline-none focus:ring-2 focus:ring-indigo-300"
              />
              <span className="absolute left-2 text-gray-400 text-xs">🔍</span>
              {buscaGlobal && (
                <button
                  onClick={() => setBuscaGlobal("")}
                  className="absolute right-2 text-gray-400 hover:text-gray-600 text-xs"
                >
                  ✕
                </button>
              )}
            </div>
          )}

          {sidebarTab === "conversas" && (
            <div className="mt-2 space-y-2">
              {/* Funis */}
              <div className="flex gap-1 overflow-x-auto pb-1 -mx-1 px-1" style={{ scrollbarWidth: "thin" }}>
                <button
                  onClick={() => escolherFunil(null)}
                  className={`flex-shrink-0 text-xs px-2.5 py-1 rounded-full border font-medium ${
                    !filtros.pipelineId ? "bg-gray-800 text-white border-gray-800" : "bg-white text-gray-600 border-gray-200 hover:border-gray-400"
                  }`}
                >
                  Todos{resumo.data ? ` · ${resumo.data.total}` : ""}
                </button>
                {resumo.data?.pipelines.map((p) => {
                  const ativo = filtros.pipelineId === p.id;
                  return (
                    <button
                      key={p.id}
                      onClick={() => escolherFunil(ativo ? null : p.id)}
                      title={p.nome}
                      className={`flex-shrink-0 flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full border font-medium max-w-[11rem] ${
                        ativo ? "text-white" : "bg-white text-gray-600 border-gray-200 hover:border-gray-400"
                      }`}
                      style={ativo ? { backgroundColor: p.cor, borderColor: p.cor } : {}}
                    >
                      {!ativo && <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: p.cor }} />}
                      <span className="truncate">{p.nome}</span>
                      <span className={ativo ? "opacity-80" : "text-gray-400"}>{p.conversas}</span>
                    </button>
                  );
                })}
              </div>

              {/* Atendimento + aguardando */}
              <div className="flex items-center gap-1">
                {([
                  [null, "Todas"],
                  ["ia", "🤖 IA"],
                  ["humano", "👤 Humano"],
                ] as const).map(([v, label]) => (
                  <button
                    key={label}
                    onClick={() => setFiltros((f) => ({ ...f, atendimento: v }))}
                    className={`text-xs px-2 py-1 rounded-md ${
                      filtros.atendimento === v ? "bg-indigo-100 text-indigo-700 font-medium" : "text-gray-500 hover:bg-gray-100"
                    }`}
                  >
                    {label}
                  </button>
                ))}
                <button
                  onClick={() => setFiltros((f) => ({ ...f, aguardando: !f.aguardando }))}
                  title="Última mensagem é do lead — ninguém respondeu"
                  className={`ml-auto text-xs px-2 py-1 rounded-md ${
                    filtros.aguardando ? "bg-red-100 text-red-700 font-medium" : "text-gray-500 hover:bg-gray-100"
                  }`}
                >
                  ● Sem resposta
                </button>
                <button
                  onClick={() => setFiltros((f) => ({ ...f, followup: !f.followup }))}
                  title="Próximo follow-up vence hoje ou está atrasado"
                  className={`text-xs px-2 py-1 rounded-md ${
                    filtros.followup ? "bg-indigo-100 text-indigo-700 font-medium" : "text-gray-500 hover:bg-gray-100"
                  }`}
                >
                  📅 {resumo.data?.followupPendentes ?? 0}
                </button>
              </div>

              <button
                onClick={() => setFiltros((f) => ({ ...f, semComentarios: !f.semComentarios }))}
                aria-pressed={filtros.semComentarios}
                title="Esconde as conversas abertas por comentário ou Live no Instagram/Facebook"
                className={`text-xs px-2 py-1 rounded-md ${
                  filtros.semComentarios ? "bg-indigo-100 text-indigo-700 font-medium" : "text-gray-500 hover:bg-gray-100"
                }`}
              >
                🚫 Ocultar comentários IG/FB{resumo.data ? ` · ${resumo.data.comentarios}` : ""}
              </button>

              {/* Tags do funil em foco + gerais */}
              {!!resumo.data?.tags.length && (() => {
                const tags = resumo.data.tags
                  .filter((t) => t.conversas > 0 || filtros.tagIds.includes(t.id))
                  .sort((a, b) => b.conversas - a.conversas);
                const LIMITE = 8;
                const visiveis = mostrarTodasTags ? tags : tags.slice(0, LIMITE);
                return (
                  <div className="flex flex-wrap gap-1">
                    {visiveis.map((t) => {
                      const ativo = filtros.tagIds.includes(t.id);
                      return (
                        <button
                          key={t.id}
                          onClick={() => alternarTag(t.id)}
                          title={t.pipelineId ? "Tag do funil" : "Tag geral"}
                          className="text-[11px] px-2 py-0.5 rounded-full border font-medium transition-colors"
                          style={ativo
                            ? { backgroundColor: t.cor, borderColor: t.cor, color: "#fff" }
                            : { backgroundColor: t.cor + "14", borderColor: t.cor + "40", color: t.cor }}
                        >
                          {t.nome} <span className="opacity-70">{t.conversas}</span>
                        </button>
                      );
                    })}
                    <button
                      onClick={() => setFiltros((f) => ({ ...f, tagIds: [], semTag: !f.semTag }))}
                      className={`text-[11px] px-2 py-0.5 rounded-full border ${
                        filtros.semTag ? "bg-gray-700 text-white border-gray-700" : "text-gray-500 border-gray-200 hover:border-gray-400"
                      }`}
                    >
                      sem tag <span className="opacity-70">{resumo.data.semTag}</span>
                    </button>
                    {tags.length > LIMITE && (
                      <button onClick={() => setMostrarTodasTags((v) => !v)} className="text-[11px] text-indigo-500 hover:underline px-1">
                        {mostrarTodasTags ? "menos" : `+${tags.length - LIMITE}`}
                      </button>
                    )}
                  </div>
                );
              })()}

              {filtrosAtivos && (
                <div className="flex items-center justify-between text-[11px] text-gray-400">
                  <span>{(conversas.data as unknown as Conversa[] | undefined)?.length ?? 0} conversa(s) no filtro</span>
                  <button onClick={() => setFiltros(FILTROS_VAZIOS)} className="hover:text-gray-600 underline">limpar filtros</button>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto">
          {/* Conversas */}
          {/* Resultados da busca global — nome, número (ou parte) e texto das mensagens */}
          {sidebarTab === "conversas" && buscaAtiva && (
            <>
              {resultados.isLoading && <p className="text-center text-gray-400 mt-8 text-sm">Buscando...</p>}
              {!resultados.isLoading && (resultados.data as unknown as ConversaBusca[] | undefined)?.length === 0 && (
                <p className="text-center text-gray-400 mt-8 text-sm px-4">
                  Nada encontrado para "{buscaDebounced.trim()}"
                </p>
              )}
              {!!(resultados.data as unknown as ConversaBusca[] | undefined)?.length && (
                <p className="px-4 py-2 text-xs text-gray-400 border-b bg-gray-50">
                  {(resultados.data as unknown as ConversaBusca[]).length} conversa(s)
                </p>
              )}
              {(resultados.data as unknown as ConversaBusca[] | undefined)?.map((deal) => {
                const ultima = deal.mensagens[0];
                const m = deal.match;
                const quando = m.enviadaEm ?? ultima?.enviadaEm ?? deal.ultimoContatoEm;
                return (
                  <button
                    key={deal.id}
                    onClick={() => {
                      setDealId(deal.id);
                      // Achou por texto → já abre a conversa filtrada no mesmo termo.
                      setSearchQuery(m.tipo === "mensagem" ? buscaDebounced.trim() : "");
                    }}
                    className={`w-full text-left px-4 py-3 border-b hover:bg-gray-50 ${
                      dealId === deal.id ? "bg-indigo-50 border-l-4 border-l-indigo-500" : ""
                    }`}
                  >
                    <div className="flex justify-between items-start gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <Avatar contato={deal.contato} nome={deal.contato?.nome ?? deal.titulo} size={32} />
                        <p className="font-medium text-sm text-gray-800 truncate">
                          <Realce texto={nomeComCodigo(deal)} termo={buscaDebounced.trim()} />
                        </p>
                        <SeloCanal canal={canalDaConversa(deal)} />
                      </div>
                      <span className="text-xs text-gray-400 flex-shrink-0">
                        {quando ? formatDataHora(quando) : ""}
                      </span>
                    </div>
                    {deal.contato?.whatsapp && (
                      <p className="text-xs text-gray-400 mt-0.5">
                        <Realce texto={deal.contato.whatsapp} termo={buscaDebounced.replace(/\D/g, "")} />
                      </p>
                    )}
                    {m.tipo === "mensagem" ? (
                      <>
                        <p className="text-xs text-gray-600 mt-1 line-clamp-2">
                          {m.direcao === "out" ? "→ " : ""}
                          <Realce texto={m.trecho} termo={buscaDebounced.trim()} />
                        </p>
                        {m.total > 1 && (
                          <span className="text-xs text-indigo-500">{m.total} mensagens</span>
                        )}
                      </>
                    ) : (
                      <p className="text-xs text-gray-400 mt-1 truncate">
                        {ultima ? `${ultima.direcao === "out" ? "→ " : ""}${ultima.conteudo ?? ""}` : "sem mensagens"}
                      </p>
                    )}
                  </button>
                );
              })}
            </>
          )}

          {sidebarTab === "conversas" && !buscaAtiva && (
            <>
              {conversas.isLoading && <p className="text-center text-gray-400 mt-8 text-sm">Carregando...</p>}
              {conversas.data?.length === 0 && <p className="text-center text-gray-400 mt-8 text-sm">Nenhuma conversa</p>}
              {(conversas.data as unknown as Conversa[] | undefined)?.map((deal) => {
                const ultima = deal.mensagens[0];
                return (
                  <div key={deal.id} className={`relative border-b ${dealId === deal.id ? "bg-indigo-50 border-l-4 border-l-indigo-500" : ""}`}>
                    <button onClick={() => setDealId(deal.id)} className="w-full text-left px-3 py-3 hover:bg-gray-50 flex items-start gap-3">
                      <Avatar contato={deal.contato} nome={deal.contato?.nome ?? deal.titulo} size={40} />
                      <div className="flex-1 min-w-0">
                        <div className="flex justify-between items-start">
                          <p className="font-medium text-sm text-gray-800 truncate pr-8">{nomeComCodigo(deal)}</p>
                          <span className="text-xs text-gray-400 ml-2 flex-shrink-0">{ultima ? formatTime(ultima.enviadaEm) : ""}</span>
                        </div>
                        <div className="flex items-center gap-1 mt-0.5 min-w-0">
                          <SeloCanal canal={canalDaConversa(deal)} />
                          <span className={`text-xs px-1.5 py-0.5 rounded-full flex-shrink-0 ${deal.iaAtiva ? "bg-green-100 text-green-700" : "bg-yellow-100 text-yellow-700"}`}>
                            {deal.iaAtiva ? "IA" : (deal.sdrNome ? deal.sdrNome.split(" ")[0] : "Humano")}
                          </span>
                          {!filtros.pipelineId && deal.pipeline && (
                            <span className="flex items-center gap-1 text-[11px] text-gray-500 truncate flex-shrink min-w-0" title={`Funil ${deal.pipeline.nome}`}>
                              <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: deal.pipeline.cor }} />
                              <span className="truncate">{deal.pipeline.nome}</span>
                            </span>
                          )}
                          {filtros.pipelineId && deal.iaStageChave && <span className="text-xs text-gray-400 truncate">{deal.iaStageChave.replace(/_/g, " ")}</span>}
                          {deal.status && deal.status !== "aberto" && (
                            <span className={`text-[10px] px-1.5 rounded-full flex-shrink-0 ${deal.status === "ganho" ? "bg-green-100 text-green-700" : "bg-red-100 text-red-600"}`}>{deal.status}</span>
                          )}
                          {deal.status === "aberto" && deal.proximoContatoEm && new Date(deal.proximoContatoEm).getTime() < Date.now() + 86400_000 && (
                            <span className="text-[10px] flex-shrink-0" title={`Follow-up: ${new Date(deal.proximoContatoEm).toLocaleDateString("pt-BR")}`}>
                              {new Date(deal.proximoContatoEm).getTime() < new Date().setHours(0, 0, 0, 0) ? "📅❗" : "📅"}
                            </span>
                          )}
                        </div>
                        {ultima && (
                          <p className={`text-xs mt-1 truncate ${ultima.direcao === "in" ? "text-gray-800 font-medium" : "text-gray-500"}`}>
                            {ultima.direcao === "in" && <span className="inline-block w-1.5 h-1.5 rounded-full bg-red-500 mr-1 align-middle" title="Aguardando resposta" />}
                            {ultima.direcao === "out" ? "→ " : ""}{ultima.conteudo ?? ""}
                          </p>
                        )}
                        {!!deal.tags?.length && (
                          <div className="flex gap-1 mt-1 overflow-hidden">
                            {deal.tags.slice(0, 3).map((t) => <TagChip key={t.id} tag={t} small />)}
                            {deal.tags.length > 3 && <span className="text-[10px] text-gray-400">+{deal.tags.length - 3}</span>}
                          </div>
                        )}
                      </div>
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); togglePausa.mutate({ dealId: deal.id, pausar: deal.iaAtiva }); }}
                      disabled={togglePausa.isLoading}
                      className={`absolute top-2 right-2 text-xs px-2 py-1 rounded font-medium ${deal.iaAtiva ? "bg-yellow-100 text-yellow-800 hover:bg-yellow-200" : "bg-green-100 text-green-800 hover:bg-green-200"}`}
                    >
                      {deal.iaAtiva ? "Assumir" : "↩ IA"}
                    </button>
                  </div>
                );
              })}
            </>
          )}

          {/* Notificações — lista de destinatários */}
          {sidebarTab === "notificacoes" && (
            <>
              {notifLogs.isLoading && <p className="text-center text-gray-400 mt-8 text-sm">Carregando...</p>}
              {destinos.length === 0 && !notifLogs.isLoading && (
                <p className="text-center text-gray-400 mt-8 text-sm">Nenhuma notificação enviada</p>
              )}
              {destinos.map(([destino, logs]) => {
                const ultima = logs[0];
                return (
                  <button
                    key={destino}
                    onClick={() => setNotifDestino(destino)}
                    className={`w-full text-left px-4 py-3 border-b hover:bg-gray-50 ${notifDestino === destino ? "bg-indigo-50 border-l-4 border-l-indigo-500" : ""}`}
                  >
                    <div className="flex justify-between items-start">
                      <p className="font-medium text-sm text-gray-800">{destino}</p>
                      <span className="text-xs text-gray-400">{formatTime(ultima.enviadaEm)}</span>
                    </div>
                    <p className="text-xs text-gray-500 mt-1 truncate">→ {ultima.mensagem.replace(/\n/g, " ")}</p>
                    <span className="text-xs text-indigo-500">{logs.length} mensagem{logs.length !== 1 ? "s" : ""}</span>
                  </button>
                );
              })}
            </>
          )}
        </div>
      </div>

      {/* Main — conversa com lead */}
      {showLeadConv && (
        <div className="flex-1 flex flex-col">
          <div className="bg-white border-b px-6 py-3 flex justify-between items-center">
            <div className="flex items-center gap-3 min-w-0">
              <Avatar contato={dealAtual.contato} nome={dealAtual.contato?.nome ?? dealAtual.titulo} size={44} />
              <div className="min-w-0">
              <p className="font-semibold text-gray-800 truncate">{nomeComCodigo(dealAtual)}</p>
              <div className="flex items-center gap-2 text-xs text-gray-500">
                {canalAtual !== "whatsapp" && (
                  <span className="flex items-center gap-1">
                    <SeloCanal canal={canalAtual} />
                    {dealAtual.contato?.instagramUsername ? `@${dealAtual.contato.instagramUsername}` : canalAtual === "instagram" ? "Instagram Direct" : "Messenger"}
                  </span>
                )}
                {dealAtual.contato?.whatsapp && (
                  <button
                    onClick={() => ligar(dealAtual.contato!.whatsapp!)}
                    className="underline text-green-400 hover:text-green-200 font-medium"
                    title="Ligar via VoIP"
                  >
                    📞 {dealAtual.contato.whatsapp}
                    {callStatus === "ringing" || callStatus === "in_call" ? " 🔔" : ""}
                  </button>
                )}
                {dealAtual.iaStageChave && <><span>·</span><span className="capitalize">{dealAtual.iaStageChave.replace(/_/g, " ")}</span></>}
                {dealAtual.iaPersonaChave && (
                  <><span>·</span>
                  <span className={`px-1.5 py-0.5 rounded-full text-xs font-medium ${PERSONA_COLORS[dealAtual.iaPersonaChave] ?? "bg-gray-100 text-gray-600"}`}>
                    {nomePersona(dealAtual.iaPersonaChave)}
                  </span></>
                )}
                {dealAtual.origemPlataforma && <><span>·</span><OrigemBadge deal={dealAtual} /></>}
              </div>
              <div className="flex items-center gap-2 mt-1">
                {dealAtual.pipeline && (
                  <span
                    className="text-[11px] font-medium px-2 py-0.5 rounded-md text-white flex-shrink-0"
                    style={{ backgroundColor: dealAtual.pipeline.cor }}
                    title="Funil"
                  >
                    {dealAtual.pipeline.nome}
                  </span>
                )}
                <DealTagsEditor
                  dealId={dealAtual.id}
                  pipelineId={dealAtual.pipelineId ?? dealAtual.pipeline?.id}
                  pipelineNome={dealAtual.pipeline?.nome}
                  tags={dealAtual.tags ?? []}
                  onChange={() => { conversas.refetch(); resumo.refetch(); dealById.refetch(); }}
                />
              </div>
              <SdrAcoes
                dealId={dealAtual.id}
                status={dealAtual.status}
                motivoPerda={dealAtual.motivoPerda}
                proximoContatoEm={dealAtual.proximoContatoEm}
                onChange={() => { conversas.refetch(); resumo.refetch(); dealById.refetch(); }}
              />
              </div>
            </div>
            <div className="flex items-center gap-2">
              {!dealAtual.iaAtiva && dealAtual.sdrNome && (
                <span className="text-xs text-yellow-700 bg-yellow-50 border border-yellow-200 px-2 py-1 rounded-lg">
                  Assumido por <strong>{dealAtual.sdrNome}</strong>
                </span>
              )}
              <div className="relative flex items-center">
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Buscar nesta conversa..."
                  className="pl-8 pr-3 py-1.5 text-sm border rounded-lg bg-gray-50 focus:outline-none focus:ring-2 focus:ring-indigo-300 w-44"
                />
                <span className="absolute left-2 text-gray-400 text-xs">🔍</span>
                {searchQuery && (
                  <button onClick={() => setSearchQuery("")} className="absolute right-2 text-gray-400 hover:text-gray-600 text-xs">✕</button>
                )}
              </div>
              <button
                onClick={() => setEditDealOpen(true)}
                title="Editar Lead"
                className="px-3 py-2 rounded-lg text-sm font-medium bg-gray-100 text-gray-700 hover:bg-gray-200"
              >
                ✏️ Editar Deal
              </button>
              <button
                onClick={handleTogglePausa}
                disabled={togglePausa.isLoading}
                className={`px-4 py-2 rounded-lg text-sm font-medium ${dealAtual.iaAtiva ? "bg-yellow-100 text-yellow-800 hover:bg-yellow-200" : "bg-green-100 text-green-800 hover:bg-green-200"}`}
              >
                {dealAtual.iaAtiva ? "Assumir Conversa" : "Devolver para IA"}
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3">
            {mensagens.isLoading && <p className="text-center text-gray-400">Carregando...</p>}
            {searchQuery && (
              <p className="text-xs text-center text-gray-400 py-1">
                {(mensagens.data as Mensagem[] | undefined)?.filter(m => (m.conteudo ?? "").toLowerCase().includes(searchQuery.toLowerCase())).length ?? 0} resultado(s) no histórico para "{searchQuery}"
              </p>
            )}
            {(mensagens.data as Mensagem[] | undefined)
              ?.filter(msg => !searchQuery || (msg.conteudo ?? "").toLowerCase().includes(searchQuery.toLowerCase()))
              .map((msg) => {
              const isOut = msg.direcao === "out";
              let senderLabel: string | null = null;
              if (isOut) {
                senderLabel = msg.remetente ?? (msg.personaChave ? nomePersona(msg.personaChave) : null);
              } else {
                senderLabel = dealAtual?.contato?.nome ?? null;
              }
              const lista = mensagens.data as Mensagem[] | undefined;
              const original = msg.citacaoEvolutionId
                ? lista?.find((m) => m.evolutionMessageId === msg.citacaoEvolutionId)
                : undefined;
              const temCitacao = !!(msg.citacaoEvolutionId || msg.citacaoTexto);
              return (
                <div key={msg.id} className={`group flex ${isOut ? "justify-end" : "justify-start"}`}>
                  <div className="relative" id={msg.evolutionMessageId ? `msg-${msg.evolutionMessageId}` : undefined}>
                    <MessageBubble msg={msg} senderLabel={senderLabel} isOut={isOut}
                      citacao={temCitacao ? (
                        <BlocoCitacao
                          isOut={isOut}
                          autor={original ? autorDaMensagem(original) : "Mensagem citada"}
                          texto={original ? textoParaCitacao(original) : (msg.citacaoTexto ?? "…")}
                          onClick={original && msg.citacaoEvolutionId ? () => irParaMensagem(msg.citacaoEvolutionId!) : undefined}
                        />
                      ) : undefined}
                    />
                    <div className={`flex items-center gap-2 mt-1 ${isOut ? "justify-end" : ""}`}>
                      <p className={`text-xs ${isOut ? "text-indigo-400" : "text-gray-400"}`}>{formatDataHoraCompleta(msg.enviadaEm)}</p>
                      {!dealAtual.iaAtiva && (
                        <button
                          type="button"
                          title="Responder esta mensagem"
                          onClick={() => { setRespondendoA(msg); inputMsgRef.current?.focus(); }}
                          className="text-xs text-gray-400 hover:text-indigo-600 hover:underline"
                        >↩ Responder</button>
                      )}
                      <button
                        type="button"
                        title="Apagar mensagem"
                        onClick={() => setMenuApagarId(menuApagarId === msg.id ? null : msg.id)}
                        className={`text-xs hover:text-red-600 hover:underline ${menuApagarId === msg.id ? "text-red-600" : "text-gray-400"}`}
                      >🗑 Apagar</button>
                    </div>
                    {menuApagarId === msg.id && (
                      <div className={`absolute z-20 mt-1 ${isOut ? "right-0" : "left-0"} bg-white border rounded-lg shadow-lg py-1 text-sm w-56`}>
                        {isOut && (msg.canal ?? "whatsapp") === "whatsapp" && msg.evolutionMessageId && (
                          <button type="button" disabled={apagarMensagem.isLoading}
                            onClick={() => apagarMensagem.mutate({ mensagemId: msg.id, paraTodos: true })}
                            className="block w-full text-left px-3 py-2 hover:bg-red-50 text-red-700 disabled:opacity-50">
                            Apagar para todos
                            <span className="block text-[11px] text-gray-400">some do WhatsApp do lead e do Avoce</span>
                          </button>
                        )}
                        <button type="button" disabled={apagarMensagem.isLoading}
                          onClick={() => apagarMensagem.mutate({ mensagemId: msg.id, paraTodos: false })}
                          className="block w-full text-left px-3 py-2 hover:bg-red-50 text-red-700 disabled:opacity-50">
                          Apagar só no Avoce
                          <span className="block text-[11px] text-gray-400">{isOut ? "o lead continua vendo no WhatsApp" : "o WhatsApp do lead não é afetado"}</span>
                        </button>
                        <button type="button" onClick={() => setMenuApagarId(null)}
                          className="block w-full text-left px-3 py-2 hover:bg-gray-50 text-gray-500">Cancelar</button>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
            <div ref={bottomRef} />
          </div>

          {!dealAtual.iaAtiva ? (
            <div className="bg-white border-t">
            {respondendoA && (
              <div className="px-4 pt-2">
                <BlocoCitacao
                  isOut={false}
                  autor={`Respondendo a ${autorDaMensagem(respondendoA)}`}
                  texto={textoParaCitacao(respondendoA)}
                  onClick={respondendoA.evolutionMessageId ? () => irParaMensagem(respondendoA.evolutionMessageId!) : undefined}
                  onClose={() => setRespondendoA(null)}
                />
              </div>
            )}
            <form onSubmit={handleSend} className="px-4 py-3 flex gap-2 items-center">
              <input ref={fileInputRef} type="file" className="hidden"
                accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.txt"
                onChange={handleFileSelect} />
              {canalAtual === "whatsapp" && <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={isSendingFile || sendManual.isLoading}
                title="Enviar arquivo"
                className={`w-10 h-10 flex items-center justify-center rounded-full text-lg transition-all ${
                  isSendingFile ? "bg-gray-200 text-gray-400 cursor-not-allowed" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                }`}
              >
                {isSendingFile ? "⏳" : "📎"}
              </button>}
              <input ref={inputMsgRef} value={manualMsg} onChange={(e) => setManualMsg(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Escape" && respondendoA) { e.preventDefault(); setRespondendoA(null); } }}
                placeholder={canalAtual === "whatsapp" ? "Mensagem como humano..." : `Responder no ${canalAtual === "instagram" ? "Direct" : "Messenger"} (até 24h após a última mensagem do lead)`}
                className="flex-1 border rounded-full px-4 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-300" />
              {canalAtual === "whatsapp" && <button
                type="button"
                onClick={toggleRecording}
                disabled={isProcessingAudio || sendManual.isLoading}
                title={isRecording ? "Parar e enviar áudio" : "Gravar áudio"}
                className={`w-10 h-10 flex items-center justify-center rounded-full text-lg transition-all ${
                  isRecording
                    ? "bg-red-500 text-white animate-pulse shadow-lg"
                    : isProcessingAudio
                    ? "bg-gray-200 text-gray-400 cursor-not-allowed"
                    : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                }`}
              >
                {isProcessingAudio ? "⏳" : isRecording ? "⏹" : "🎤"}
              </button>}
              <button type="submit" disabled={(sendManual.isLoading || (sendManual as any).isPending) || !manualMsg.trim()}
                className="bg-indigo-600 text-white px-5 py-2 rounded-full text-sm font-medium hover:bg-indigo-700 disabled:opacity-50">
                {sendManual.isLoading ? "..." : "Enviar"}
              </button>
            </form>
            </div>
          ) : (
            <div className="bg-green-50 border-t border-green-100 px-4 py-2 text-xs text-center text-green-700">
              IA respondendo automaticamente · Clique em "Assumir Conversa" para intervir
            </div>
          )}
        </div>
      )}

      {/* Main — conversa de notificações com destinatário */}
      {showNotifConv && (
        <div className="flex-1 flex flex-col">
          <div className="bg-white border-b px-6 py-3">
            <p className="font-semibold text-gray-800">{notifDestino}</p>
            <p className="text-xs text-gray-500">Notificações enviadas para este número</p>
          </div>

          <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3">
            {notifConversa.map((n) => (
              <div key={n.id} className="flex justify-end">
                <div className="max-w-xs lg:max-w-md px-4 py-2 rounded-2xl shadow-sm bg-indigo-600 text-white rounded-br-sm">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs bg-indigo-500 px-1.5 py-0.5 rounded text-indigo-100">
                      {EVENTO_LABELS[n.evento] ?? n.evento}
                    </span>
                    {n.nomeLead && <span className="text-xs text-indigo-200">{n.nomeLead}</span>}
                  </div>
                  <p className="text-sm whitespace-pre-wrap">{n.mensagem}</p>
                  <p className="text-xs mt-1 text-indigo-200">{formatDataHoraCompleta(n.enviadaEm)}</p>
                </div>
              </div>
            ))}
            <div ref={bottomRef} />
          </div>
        </div>
      )}

      {/* Loading deal */}
      {isLoadingDeal && !showLeadConv && !showNotifConv && (
        <div className="flex-1 flex items-center justify-center text-gray-400">
          <p className="text-sm">Carregando conversa...</p>
        </div>
      )}

      {/* Empty state */}
      {!showLeadConv && !showNotifConv && !isLoadingDeal && (
        <div className="flex-1 flex items-center justify-center text-gray-400">
          <div className="text-center">
            <p className="text-5xl mb-3">💬</p>
            <p className="text-lg font-medium">Selecione uma conversa</p>
            <p className="text-sm mt-1">Conversas e notificações do WhatsApp aparecem aqui</p>
            {projetoId && (
              <button onClick={() => setShowNovaConversa(true)}
                className="mt-4 text-sm bg-indigo-600 text-white px-5 py-2 rounded-full hover:bg-indigo-700">
                + Nova Conversa
              </button>
            )}
          </div>
        </div>
      )}

      {/* Modal editar deal */}
      {editDealOpen && dealAtual && dealPipelineId && (
        <DealModal
          deal={dealAtual as unknown as Deal}
          stages={(editStages.data as unknown as Stage[]) ?? []}
          pipelineId={dealPipelineId}
          onClose={() => setEditDealOpen(false)}
          onSaved={() => { setEditDealOpen(false); conversas.refetch(); }}
        />
      )}

      {/* Modal nova conversa */}
      {showNovaConversa && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center">
          <div className="bg-white rounded-xl p-6 w-96 shadow-xl">
            <h3 className="font-semibold text-gray-800 mb-4">Nova Conversa</h3>
            <div className="space-y-3">
              <div>
                <label className="text-xs text-gray-500 block mb-1">Enviar pelo número *</label>
                <select
                  value={novaConvProjetoId}
                  onChange={e => setNovaConvProjetoId(e.target.value)}
                  className="w-full border rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-300 bg-white"
                >
                  <option value="" disabled>
                    {canaisNovaConversa.isLoading ? "Carregando números…" : "Escolha o número / funil"}
                  </option>
                  {Object.entries(
                    (canaisNovaConversa.data ?? []).reduce<Record<string, NonNullable<typeof canaisNovaConversa.data>>>((g, c) => {
                      const tel = c.telefone
                        ? `+${c.telefone.slice(0, 2)} (${c.telefone.slice(2, 4)}) ${c.telefone.slice(4, -4)}-${c.telefone.slice(-4)}`
                        : c.instancia!;
                      const k = `${c.perfil ?? c.empresaNome ?? c.instancia} · ${tel}${c.conectado === false ? " (desconectado)" : ""}`;
                      (g[k] ??= []).push(c);
                      return g;
                    }, {}),
                  ).map(([grupo, cs]) => (
                    <optgroup key={grupo} label={grupo}>
                      {cs.map(c => <option key={c.projetoId} value={c.projetoId}>{c.projetoNome}</option>)}
                    </optgroup>
                  ))}
                </select>
                <p className="text-[11px] text-gray-400 mt-1">O funil escolhido define o número que envia e onde o deal é criado.</p>
              </div>
              <div>
                <label className="text-xs text-gray-500 block mb-1">WhatsApp (com código do país) *</label>
                <input
                  value={novaConvForm.whatsapp}
                  onChange={e => setNovaConvForm(f => ({ ...f, whatsapp: e.target.value }))}
                  placeholder="5561999999999"
                  className="w-full border rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-300"
                />
              </div>
              <div>
                <label className="text-xs text-gray-500 block mb-1">Nome do contato (opcional)</label>
                <input
                  value={novaConvForm.nome}
                  onChange={e => setNovaConvForm(f => ({ ...f, nome: e.target.value }))}
                  placeholder="Ex: João Silva"
                  className="w-full border rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-300"
                />
              </div>
              <div>
                <label className="text-xs text-gray-500 block mb-1">Mensagem inicial *</label>
                <textarea
                  value={novaConvForm.mensagem}
                  onChange={e => setNovaConvForm(f => ({ ...f, mensagem: e.target.value }))}
                  rows={3}
                  placeholder="Olá! Meu nome é..."
                  className="w-full border rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-300 resize-none"
                />
              </div>
            </div>
            <div className="flex gap-2 mt-5">
              <button onClick={fecharNovaConversa}
                className="flex-1 border rounded-lg py-2 text-sm text-gray-600">
                Cancelar
              </button>
              <button
                onClick={() => {
                  if (!novaConvProjetoId || !novaConvForm.whatsapp.trim() || !novaConvForm.mensagem.trim()) return;
                  iniciarNovaConversa.mutate({
                    projetoId: novaConvProjetoId,
                    whatsapp: novaConvForm.whatsapp.trim(),
                    nomeContato: novaConvForm.nome.trim() || undefined,
                    mensagem: novaConvForm.mensagem.trim(),
                  });
                }}
                disabled={!novaConvProjetoId || !novaConvForm.whatsapp.trim() || !novaConvForm.mensagem.trim() || iniciarNovaConversa.isLoading}
                className="flex-1 bg-indigo-600 text-white rounded-lg py-2 text-sm font-medium hover:bg-indigo-700 disabled:opacity-50">
                {iniciarNovaConversa.isLoading ? "Enviando..." : "Enviar"}
              </button>
            </div>
            {iniciarNovaConversa.error && (
              <p className="text-xs text-red-600 mt-2">{(iniciarNovaConversa.error as any)?.message}</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
