import { useState, useEffect, useRef, useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import { trpc } from "../lib/trpc";
import { useVoip } from "../contexts/VoipContext";
import { DealModal, type Deal, type Stage } from "./Crm";
import { Avatar } from "../components/Avatar";
import { OrigemBadge, type DealOrigem } from "../components/OrigemLead";

type Conversa = {
  id: string;
  titulo: string;
  iaAtiva: boolean;
  iaStageChave: string | null;
  iaPersonaChave: string | null;
  ultimoContatoEm: string | null;
  sdrNome: string | null;
  contato: { id: string; nome: string; whatsapp: string | null; fotoPerfilUrl?: string | null; fotoPerfilEm?: string | null } | null;
  mensagens: {
    id: string;
    direcao: string;
    conteudo: string | null;
    personaChave: string | null;
    enviadaEm: string;
  }[];
} & DealOrigem;

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
};

type NotifLog = {
  id: string;
  evento: string;
  destino: string;
  mensagem: string;
  nomeLead: string | null;
  enviadaEm: string;
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

// O agente assina a mensagem com "*Nome*" na primeira linha, e a bolha já mostra
// o remetente à parte — repetir vira ruído. Antes a lista de nomes era fixa (só
// Ana e Dra. Daniela), então "Nelson" e "Isabella" apareciam soltos no texto.
// Casa qualquer nome curto em negrito seguido de quebra de linha ou dois-pontos.
const PERSONA_PREFIX_RE = /^\*[^*\n]{2,40}\*\s*[\n:]\s*/;

function formatWhatsApp(text: string, stripPrefix = false) {
  const cleaned = stripPrefix ? text.replace(PERSONA_PREFIX_RE, "") : text;
  return cleaned
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

function MessageBubble({ msg, senderLabel, isOut }: {
  msg: Mensagem; senderLabel: string | null; isOut: boolean;
}) {
  const tipo = msg.tipo;
  const conteudo = msg.conteudo ?? "";

  if (tipo === "audio") {
    const midiaUrl = (msg as any).midiaUrl ?? null;
    const token = localStorage.getItem("token") ?? "";
    const audioSrc = midiaUrl ? `${midiaUrl}?token=${encodeURIComponent(token)}` : null;
    return (
      <div className={`max-w-xs lg:max-w-md px-4 py-2 rounded-2xl shadow-sm ${isOut ? "bg-indigo-600 text-white rounded-br-sm" : "bg-white text-gray-800 rounded-bl-sm border"}`}>
        {senderLabel && <p className={`text-xs font-semibold mb-1 ${isOut ? "text-indigo-200" : "text-gray-400"}`}>{senderLabel}</p>}
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
        {src
          ? <a href={src} target="_blank" rel="noopener noreferrer" className="text-sm underline">{icon} {conteudo || "Arquivo"}</a>
          : <p className="text-sm">{icon} {conteudo || "Arquivo"}</p>}
      </div>
    );
  }

  return (
    <div className={`max-w-xs lg:max-w-md px-4 py-2 rounded-2xl shadow-sm ${isOut ? "bg-indigo-600 text-white rounded-br-sm" : "bg-white text-gray-800 rounded-bl-sm border"}`}>
      {senderLabel && <p className={`text-xs font-semibold mb-1 ${isOut ? "text-indigo-200" : "text-gray-400"}`}>{senderLabel}</p>}
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
  const [searchQuery, setSearchQuery] = useState("");
  const [buscaGlobal, setBuscaGlobal] = useState("");
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("conversas");
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessingAudio, setIsProcessingAudio] = useState(false);
  const [isSendingFile, setIsSendingFile] = useState(false);
  const [showNovaConversa, setShowNovaConversa] = useState(false);
  const [editDealOpen, setEditDealOpen] = useState(false);
  const { ligar, callStatus } = useVoip();
  const [novaConvForm, setNovaConvForm] = useState({ whatsapp: "", nome: "", mensagem: "" });
  const bottomRef = useRef<HTMLDivElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<BlobPart[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const projetos = trpc.ia.listProjetos.useQuery();
  const conversas = trpc.ia.listConversas.useQuery(
    {},
    { refetchInterval: 10_000 }
  );
  const buscaDebounced = useDebounced(buscaGlobal);
  const buscaAtiva = buscaDebounced.trim().length >= 2;
  const resultados = trpc.ia.buscarConversas.useQuery(
    { q: buscaDebounced.trim() },
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

  const togglePausa = trpc.ia.toggleIaPausa.useMutation({
    onSuccess: () => { conversas.refetch(); dealById.refetch(); },
  });
  const sendManual = trpc.ia.sendMensagemManual.useMutation({
    onSuccess: () => { setManualMsg(""); mensagens.refetch(); },
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

  const iniciarNovaConversa = trpc.ia.iniciarNovaConversa.useMutation({
    onSuccess: (res) => {
      setDealId(res.dealId);
      setSidebarTab("conversas");
      setShowNovaConversa(false);
      setNovaConvForm({ whatsapp: "", nome: "", mensagem: "" });
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
    sendManual.mutate({ dealId, conteudo: manualMsg.trim() });
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
      <div className="w-72 bg-white border-r flex flex-col">
        <div className="p-4 border-b">
          <div className="flex items-center justify-between">
            <h1 className="text-lg font-bold text-gray-800">WhatsApp IA</h1>
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
                          <Realce texto={deal.contato?.nome ?? deal.titulo} termo={buscaDebounced.trim()} />
                        </p>
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
                          <p className="font-medium text-sm text-gray-800 truncate pr-8">{deal.contato?.nome ?? deal.titulo}</p>
                          <span className="text-xs text-gray-400 ml-2 flex-shrink-0">{ultima ? formatTime(ultima.enviadaEm) : ""}</span>
                        </div>
                        <div className="flex items-center gap-1 mt-0.5">
                          <span className={`text-xs px-1.5 py-0.5 rounded-full ${deal.iaAtiva ? "bg-green-100 text-green-700" : "bg-yellow-100 text-yellow-700"}`}>
                            {deal.iaAtiva ? "IA" : (deal.sdrNome ? deal.sdrNome.split(" ")[0] : "Humano")}
                          </span>
                          {deal.iaStageChave && <span className="text-xs text-gray-400 truncate">{deal.iaStageChave.replace(/_/g, " ")}</span>}
                        </div>
                        {ultima && <p className="text-xs text-gray-500 mt-1 truncate">{ultima.direcao === "out" ? "→ " : ""}{ultima.conteudo ?? ""}</p>}
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
              <p className="font-semibold text-gray-800 truncate">{dealAtual.contato?.nome ?? dealAtual.titulo}</p>
              <div className="flex items-center gap-2 text-xs text-gray-500">
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
              return (
                <div key={msg.id} className={`flex ${isOut ? "justify-end" : "justify-start"}`}>
                  <div>
                    <MessageBubble msg={msg} senderLabel={senderLabel} isOut={isOut} />
                    <p className={`text-xs mt-1 ${isOut ? "text-right text-indigo-400" : "text-gray-400"}`}>{formatTime(msg.enviadaEm)}</p>
                  </div>
                </div>
              );
            })}
            <div ref={bottomRef} />
          </div>

          {!dealAtual.iaAtiva ? (
            <form onSubmit={handleSend} className="bg-white border-t px-4 py-3 flex gap-2 items-center">
              <input ref={fileInputRef} type="file" className="hidden"
                accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.txt"
                onChange={handleFileSelect} />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={isSendingFile || sendManual.isLoading}
                title="Enviar arquivo"
                className={`w-10 h-10 flex items-center justify-center rounded-full text-lg transition-all ${
                  isSendingFile ? "bg-gray-200 text-gray-400 cursor-not-allowed" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                }`}
              >
                {isSendingFile ? "⏳" : "📎"}
              </button>
              <input value={manualMsg} onChange={(e) => setManualMsg(e.target.value)} placeholder="Mensagem como humano..."
                className="flex-1 border rounded-full px-4 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-300" />
              <button
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
              </button>
              <button type="submit" disabled={(sendManual.isLoading || (sendManual as any).isPending) || !manualMsg.trim()}
                className="bg-indigo-600 text-white px-5 py-2 rounded-full text-sm font-medium hover:bg-indigo-700 disabled:opacity-50">
                {sendManual.isLoading ? "..." : "Enviar"}
              </button>
            </form>
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
                  <p className="text-xs mt-1 text-indigo-200">{formatTime(n.enviadaEm)}</p>
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
              <button onClick={() => { setShowNovaConversa(false); setNovaConvForm({ whatsapp: "", nome: "", mensagem: "" }); }}
                className="flex-1 border rounded-lg py-2 text-sm text-gray-600">
                Cancelar
              </button>
              <button
                onClick={() => {
                  if (!projetoId || !novaConvForm.whatsapp.trim() || !novaConvForm.mensagem.trim()) return;
                  iniciarNovaConversa.mutate({
                    projetoId,
                    whatsapp: novaConvForm.whatsapp.trim(),
                    nomeContato: novaConvForm.nome.trim() || undefined,
                    mensagem: novaConvForm.mensagem.trim(),
                  });
                }}
                disabled={!novaConvForm.whatsapp.trim() || !novaConvForm.mensagem.trim() || iniciarNovaConversa.isLoading}
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
