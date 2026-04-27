import { useState, useEffect, useRef } from "react";
import { trpc } from "../lib/trpc";

type Conversa = {
  id: string;
  titulo: string;
  iaAtiva: boolean;
  iaStageChave: string | null;
  iaPersonaChave: string | null;
  ultimoContatoEm: string | null;
  contato: { id: string; nome: string; whatsapp: string | null } | null;
  mensagens: {
    id: string;
    direcao: string;
    conteudo: string | null;
    personaChave: string | null;
    enviadaEm: string;
  }[];
};

type Mensagem = {
  id: string;
  direcao: string;
  tipo: string;
  conteudo: string | null;
  personaChave: string | null;
  remetente: string | null;
  enviadaEm: string;
};

const PERSONA_COLORS: Record<string, string> = {
  assistente: "bg-blue-100 text-blue-800",
  advogado: "bg-purple-100 text-purple-800",
  closer: "bg-orange-100 text-orange-800",
};

const PERSONA_NAMES: Record<string, string> = {
  assistente: "Ana",
  advogado: "Dra. Daniela",
  closer: "Dra. Daniela (Closer)",
};

function formatTime(iso: string) {
  const d = new Date(iso);
  return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

function formatDate(iso: string | null) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

// Strip legacy "*Name *\n" prefix from messages stored before the backend fix.
// Only matches known persona names so it never strips real message content.
const PERSONA_PREFIX_RE = /^\*?(?:Ana|Dra\.?\s+Daniela(?:\s+\(Closer\))?)\s*\*?\s*[\n:]\s*/;

function formatWhatsApp(text: string, stripPrefix = false) {
  const cleaned = stripPrefix ? text.replace(PERSONA_PREFIX_RE, "") : text;
  // Convert *bold* to <strong>
  return cleaned
    .replace(/\*([^*]+)\*/g, "<strong>$1</strong>")
    .replace(/\n/g, "<br/>");
}

export default function WhatsappPage() {
  const [projetoId, setProjetoId] = useState<string | null>(null);
  const [dealId, setDealId] = useState<string | null>(null);
  const [manualMsg, setManualMsg] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  const projetos = trpc.ia.listProjetos.useQuery();
  const conversas = trpc.ia.listConversas.useQuery(
    { projetoId: projetoId ?? undefined },
    { refetchInterval: 10_000 }
  );
  const mensagens = trpc.ia.getMensagens.useQuery(
    { dealId: dealId ?? "" },
    { enabled: !!dealId, refetchInterval: 5_000 }
  );

  const togglePausa = trpc.ia.toggleIaPausa.useMutation({ onSuccess: () => conversas.refetch() });
  const sendManual = trpc.ia.sendMensagemManual.useMutation({
    onSuccess: () => {
      setManualMsg("");
      mensagens.refetch();
    },
  });

  const dealAtual = (conversas.data as unknown as Conversa[] | undefined)?.find((d) => d.id === dealId);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [mensagens.data]);

  // Auto-select first projeto
  useEffect(() => {
    const ps = projetos.data as { id: string }[] | undefined;
    if (!projetoId && ps?.[0]) {
      setProjetoId(ps[0].id);
    }
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

  return (
    <div className="flex h-screen bg-gray-50">
      {/* Sidebar — lista de conversas */}
      <div className="w-72 bg-white border-r flex flex-col">
        <div className="p-4 border-b">
          <h1 className="text-lg font-bold text-gray-800">WhatsApp IA</h1>

          {projetos.data && (projetos.data as { id: string; nome: string }[]).length > 1 && (
            <select
              value={projetoId ?? ""}
              onChange={(e) => { setProjetoId(e.target.value); setDealId(null); }}
              className="mt-2 w-full text-sm border rounded px-2 py-1"
            >
              {(projetos.data as { id: string; nome: string }[]).map((p) => (
                <option key={p.id} value={p.id}>{p.nome}</option>
              ))}
            </select>
          )}
        </div>

        <div className="flex-1 overflow-y-auto">
          {conversas.isLoading && (
            <p className="text-center text-gray-400 mt-8 text-sm">Carregando...</p>
          )}
          {conversas.data?.length === 0 && (
            <p className="text-center text-gray-400 mt-8 text-sm">Nenhuma conversa ainda</p>
          )}
          {(conversas.data as unknown as Conversa[] | undefined)?.map((deal) => {
            const ultima = deal.mensagens[0];
            return (
              <div
                key={deal.id}
                className={`relative border-b ${dealId === deal.id ? "bg-indigo-50 border-l-4 border-l-indigo-500" : ""}`}
              >
                <button
                  onClick={() => setDealId(deal.id)}
                  className="w-full text-left px-4 py-3 hover:bg-gray-50 transition-colors"
                >
                  <div className="flex justify-between items-start">
                    <p className="font-medium text-sm text-gray-800 truncate pr-8">{deal.contato?.nome ?? deal.titulo}</p>
                    <span className="text-xs text-gray-400 ml-2 flex-shrink-0">
                      {ultima ? formatTime(ultima.enviadaEm) : ""}
                    </span>
                  </div>
                  <div className="flex items-center gap-1 mt-0.5">
                    <span className={`text-xs px-1.5 py-0.5 rounded-full ${deal.iaAtiva ? "bg-green-100 text-green-700" : "bg-yellow-100 text-yellow-700"}`}>
                      {deal.iaAtiva ? "IA" : "Humano"}
                    </span>
                    {deal.iaStageChave && (
                      <span className="text-xs text-gray-400 truncate">{deal.iaStageChave.replace(/_/g, " ")}</span>
                    )}
                  </div>
                  {ultima && (
                    <p className="text-xs text-gray-500 mt-1 truncate">
                      {ultima.direcao === "out" ? "→ " : ""}{ultima.conteudo ?? ""}
                    </p>
                  )}
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    togglePausa.mutate({ dealId: deal.id, pausar: deal.iaAtiva });
                  }}
                  disabled={togglePausa.isLoading}
                  title={deal.iaAtiva ? "Assumir conversa" : "Devolver para IA"}
                  className={`absolute top-2 right-2 text-xs px-2 py-1 rounded font-medium transition-colors ${
                    deal.iaAtiva
                      ? "bg-yellow-100 text-yellow-800 hover:bg-yellow-200"
                      : "bg-green-100 text-green-800 hover:bg-green-200"
                  }`}
                >
                  {deal.iaAtiva ? "Assumir" : "↩ IA"}
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {/* Main — conversa */}
      {dealId && dealAtual ? (
        <div className="flex-1 flex flex-col">
          {/* Header */}
          <div className="bg-white border-b px-6 py-3 flex justify-between items-center">
            <div>
              <p className="font-semibold text-gray-800">{dealAtual.contato?.nome ?? dealAtual.titulo}</p>
              <div className="flex items-center gap-2 text-xs text-gray-500">
                <span>{dealAtual.contato?.whatsapp}</span>
                {dealAtual.iaStageChave && (
                  <>
                    <span>·</span>
                    <span className="capitalize">{dealAtual.iaStageChave.replace(/_/g, " ")}</span>
                  </>
                )}
                {dealAtual.iaPersonaChave && (
                  <>
                    <span>·</span>
                    <span className={`px-1.5 py-0.5 rounded-full text-xs font-medium ${PERSONA_COLORS[dealAtual.iaPersonaChave] ?? "bg-gray-100 text-gray-600"}`}>
                      {PERSONA_NAMES[dealAtual.iaPersonaChave] ?? dealAtual.iaPersonaChave}
                    </span>
                  </>
                )}
              </div>
            </div>

            <button
              onClick={handleTogglePausa}
              disabled={togglePausa.isLoading}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                dealAtual.iaAtiva
                  ? "bg-yellow-100 text-yellow-800 hover:bg-yellow-200"
                  : "bg-green-100 text-green-800 hover:bg-green-200"
              }`}
            >
              {dealAtual.iaAtiva ? "Assumir Conversa" : "Devolver para IA"}
            </button>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3">
            {mensagens.isLoading && <p className="text-center text-gray-400">Carregando...</p>}
            {(mensagens.data as Mensagem[] | undefined)?.map((msg) => {
              // Resolve sender label
              let senderLabel: string | null = null;
              if (msg.direcao === "out") {
                if (msg.remetente) {
                  senderLabel = msg.remetente;
                } else if (msg.personaChave) {
                  senderLabel = PERSONA_NAMES[msg.personaChave] ?? msg.personaChave;
                }
              } else {
                senderLabel = dealAtual?.contato?.nome ?? null;
              }

              return (
              <div
                key={msg.id}
                className={`flex ${msg.direcao === "out" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-xs lg:max-w-md px-4 py-2 rounded-2xl shadow-sm ${
                    msg.direcao === "out"
                      ? "bg-indigo-600 text-white rounded-br-sm"
                      : "bg-white text-gray-800 rounded-bl-sm border"
                  }`}
                >
                  {senderLabel && (
                    <p className={`text-xs font-semibold mb-1 ${msg.direcao === "out" ? "text-indigo-200" : "text-gray-400"}`}>
                      {senderLabel}
                    </p>
                  )}
                  <div
                    className="text-sm whitespace-pre-wrap"
                    dangerouslySetInnerHTML={{ __html: formatWhatsApp(msg.conteudo ?? "", msg.direcao === "out" && !!senderLabel) }}
                  />
                  <p className={`text-xs mt-1 ${msg.direcao === "out" ? "text-indigo-200" : "text-gray-400"}`}>
                    {formatTime(msg.enviadaEm)}
                  </p>
                </div>
              </div>
              );
            })}
            <div ref={bottomRef} />
          </div>

          {/* Input — only when IA is paused */}
          {!dealAtual.iaAtiva && (
            <form onSubmit={handleSend} className="bg-white border-t px-4 py-3 flex gap-2">
              <input
                value={manualMsg}
                onChange={(e) => setManualMsg(e.target.value)}
                placeholder="Mensagem como humano..."
                className="flex-1 border rounded-full px-4 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-300"
              />
              <button
                type="submit"
                disabled={sendManual.isLoading || !manualMsg.trim()}
                className="bg-indigo-600 text-white px-5 py-2 rounded-full text-sm font-medium hover:bg-indigo-700 disabled:opacity-50"
              >
                Enviar
              </button>
            </form>
          )}

          {dealAtual.iaAtiva && (
            <div className="bg-green-50 border-t border-green-100 px-4 py-2 text-xs text-center text-green-700">
              IA respondendo automaticamente · Clique em "Assumir Conversa" para intervir
            </div>
          )}
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center text-gray-400">
          <div className="text-center">
            <p className="text-5xl mb-3">💬</p>
            <p className="text-lg font-medium">Selecione uma conversa</p>
            <p className="text-sm mt-1">As conversas do WhatsApp aparecem aqui em tempo real</p>
          </div>
        </div>
      )}
    </div>
  );
}
