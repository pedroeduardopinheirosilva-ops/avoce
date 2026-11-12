import { useState, useEffect, useRef } from "react";
import { Avatar } from "../components/Avatar";
import AudienciaLead from "../components/AudienciaLead";
import AcordoDeal from "../components/acordos/AcordoDeal";
import MotorColeta from "../components/MotorColeta";
import { OrigemBadge, OrigemDetalhe, type DealOrigem } from "../components/OrigemLead";
import { useNavigate } from "react-router-dom";
import {
  DndContext,
  DragEndEvent,
  DragOverEvent,
  DragOverlay,
  DragStartEvent,
  PointerSensor,
  useSensor,
  useSensors,
  closestCorners,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { trpc } from "../lib/trpc";
import { BotaoAgendarReuniao, ReunioesDoLead } from "../components/AgendarReuniao";
import VoipDialer, { VoipDialerHandle } from "../components/VoipDialer";
import { useVoip } from "../contexts/VoipContext";

// ── Types ─────────────────────────────────────────────────────────────────────

export type Stage = {
  id: string; chave: string; nome: string; cor: string;
  ehGanho: boolean; requerAcaoHumana: boolean;
  deals: Deal[];
};
export type Deal = {
  id: string; titulo: string; valor: string | null; urgencia: boolean;
  status: string; stageId: string; criadoEm: string; followupEm?: string | null;
  valorEstimado: string | null; iaAtiva: boolean | null; iaPausadaPor: string | null;
  contato: {
    id: string; nome: string; whatsapp: string | null; cidade: string | null; fotoPerfilUrl?: string | null; fotoPerfilEm?: string | null;
    instagramId?: string | null; messengerId?: string | null;
  } | null;
  tags?: { id: string; nome: string; cor: string }[];
} & DealOrigem;
type Pipeline = {
  id: string; nome: string; tipo: string; cor: string;
};

// ── Card draggável ─────────────────────────────────────────────────────────────

/** Tem conversa para abrir no Chat: número de WhatsApp ou lead do Direct/Messenger. */
const temConversa = (d: Deal) => !!(d.contato?.whatsapp || d.contato?.instagramId || d.contato?.messengerId);

// ── camposCustom ───────────────────────────────────────────────────────────────
// O JSON de camposCustom vem de integrações (importações, robôs de prospecção) e
// pode conter booleanos, listas e objetos aninhados. Jogar isso direto no JSX
// derruba o render inteiro ("Objects are not valid as a React child"), então todo
// valor passa por aqui antes de virar texto.

const ROTULOS_CAMPO: Record<string, string> = {
  cnpj: "CNPJ",
  ie: "IE",
  inscricao_estadual: "Inscrição estadual",
  crc: "CRC",
  uf: "UF",
  cnae: "CNAE",
};

function rotuloCampo(chave: string): string {
  if (ROTULOS_CAMPO[chave]) return ROTULOS_CAMPO[chave];
  const t = chave.replace(/_/g, " ").trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function valorCampo(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "boolean") return v ? "sim" : "não";
  if (Array.isArray(v)) return v.map(valorCampo).filter(Boolean).join(" · ");
  if (typeof v === "object") {
    return Object.entries(v as Record<string, unknown>)
      .filter(([, x]) => x !== null && x !== undefined && x !== "")
      .map(([k, x]) => `${rotuloCampo(k)}: ${valorCampo(x)}`)
      .join(" | ");
  }
  return String(v);
}

function DealCard({
  deal, onOpen, onWhatsApp, onCriarReuniao, overlay = false,
}: {
  deal: Deal; onOpen: (d: Deal) => void; onWhatsApp?: (d: Deal) => void; onCriarReuniao?: (d: Deal) => void; overlay?: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: deal.id, data: { type: "deal", deal } });

  const style = overlay ? undefined : {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.3 : 1,
  };

  return (
    <div
      ref={overlay ? undefined : setNodeRef}
      style={style}
      {...(!overlay ? { ...attributes, ...listeners } : {})}
      className={`bg-white border border-gray-200 rounded-lg p-3 cursor-grab active:cursor-grabbing shadow-sm hover:shadow-md transition-shadow ${deal.urgencia ? "border-l-4 border-l-red-500" : ""} ${overlay ? "rotate-2 shadow-xl" : ""}`}
      onClick={(e) => {
        // só abre se não foi drag
        if ((e.target as HTMLElement).closest("[data-no-open]")) return;
        onOpen(deal);
      }}
    >
      {deal.urgencia && (
        <span className="text-xs text-red-600 font-semibold mb-1 block">🔴 Urgente</span>
      )}
      <div className="flex items-center gap-2 mb-1">
        <Avatar contato={deal.contato} nome={deal.contato?.nome ?? deal.titulo} size={28} />
        <p className="text-sm font-medium text-gray-800 leading-tight min-w-0 truncate">
          {(() => {
            const words = (deal.contato?.nome ?? deal.titulo).trim().split(/\s+/).filter(Boolean);
            const label = words.slice(0, 2).join(" ");
            const last4 = deal.contato?.whatsapp?.slice(-4);
            return last4 ? `${label} - ${last4}` : label;
          })()}
        </p>
      </div>
      {deal.origemPlataforma && (
        <div className="mb-1 flex"><OrigemBadge deal={deal} /></div>
      )}
      {deal.contato && (
        <p className="text-xs text-gray-500 mb-1">
          {deal.contato.cidade ? `📍 ${deal.contato.cidade}` : ""}
        </p>
      )}
      {deal.valorEstimado && (
        <p className="text-xs font-semibold text-indigo-700">
          ⚖️ {Number(deal.valorEstimado).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}
        </p>
      )}
      {deal.valor && !deal.valorEstimado && (
        <p className="text-xs font-semibold text-green-700">
          {Number(deal.valor).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}
        </p>
      )}
      {deal.tags && deal.tags.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1.5">
          {deal.tags.slice(0, 3).map(tag => (
            <span key={tag.id} className="inline-flex items-center text-[10px] font-medium px-1.5 py-0.5 rounded-full text-white" style={{ backgroundColor: tag.cor }}>
              {tag.nome}
            </span>
          ))}
          {deal.tags.length > 3 && (
            <span className="inline-flex items-center text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-gray-200 text-gray-600">
              +{deal.tags.length - 3}
            </span>
          )}
        </div>
      )}
      <div className="flex items-center justify-between mt-1">
        <p className="text-xs text-gray-400">
          {!deal.followupEm && Date.now() - new Date(deal.criadoEm).getTime() < 24 * 3_600_000 && (
            <span className="mr-1.5 text-[10px] font-bold text-white bg-rose-500 px-1.5 py-0.5 rounded" title="Chegou nas últimas 24h e ainda não teve follow-up">
              NOVO
            </span>
          )}
          {new Date(deal.criadoEm).toLocaleDateString("pt-BR")}
          {Date.now() - new Date(deal.criadoEm).getTime() < 24 * 3_600_000 && (
            <span className="ml-1">{new Date(deal.criadoEm).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}</span>
          )}
          {deal.followupEm && (
            <span className="ml-1.5 text-[10px] text-emerald-700 bg-emerald-50 px-1 rounded" title={`Follow-up feito em ${new Date(deal.followupEm).toLocaleString("pt-BR")} — vai para o fim da coluna`}>
              ✓ FU {new Date(deal.followupEm).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })}
            </span>
          )}
        </p>
        <div className="flex items-center gap-1">
          {deal.iaAtiva === false && (
            <span className="text-xs bg-yellow-100 text-yellow-700 px-1.5 py-0.5 rounded-full font-medium">SDR</span>
          )}
          {deal.contato && onWhatsApp && (
            <button
              data-no-open
              onClick={(e) => { e.stopPropagation(); if (temConversa(deal)) onWhatsApp(deal); else onOpen(deal); }}
              className={`p-1 rounded-full transition-colors ${temConversa(deal) ? "text-indigo-500 hover:text-indigo-700 hover:bg-indigo-50" : "text-gray-300 hover:text-gray-500 hover:bg-gray-50"}`}
              title={
                deal.contato.whatsapp ? "Atender no Chat (WhatsApp)"
                : deal.contato.instagramId ? "Abrir a conversa do Instagram no Chat"
                : deal.contato.messengerId ? "Abrir a conversa do Messenger no Chat"
                : "Sem WhatsApp cadastrado — abra o card e preencha o número"
              }
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"/></svg>
            </button>
          )}
          {onCriarReuniao && (
            <button
              data-no-open
              onClick={(e) => { e.stopPropagation(); onCriarReuniao(deal); }}
              className="text-purple-500 hover:text-purple-700 hover:bg-purple-50 p-1 rounded-full transition-colors"
              title="Iniciar videochamada"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M15 10l4.553-2.276A1 1 0 0121 8.723v6.554a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Coluna do kanban ──────────────────────────────────────────────────────────

function KanbanColumn({
  stage, onOpenDeal, onAddDeal, onWhatsApp, onCriarReuniao,
}: {
  stage: Stage;
  onOpenDeal: (d: Deal) => void;
  onAddDeal: (stageId: string) => void;
  onWhatsApp: (d: Deal) => void;
  onCriarReuniao: (d: Deal) => void;
}) {
  const { setNodeRef } = useSortable({ id: stage.id, data: { type: "stage" } });
  return (
    <div className="flex-shrink-0 w-64 flex flex-col bg-gray-50 rounded-xl border border-gray-200">
      {/* Header */}
      <div
        className="px-3 py-2 rounded-t-xl flex items-center justify-between"
        style={{ backgroundColor: stage.cor + "22", borderBottom: `2px solid ${stage.cor}` }}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span
            className="w-2.5 h-2.5 rounded-full flex-shrink-0"
            style={{ backgroundColor: stage.cor }}
          />
          <span className="text-xs font-semibold text-gray-700 truncate">{stage.nome}</span>
          {stage.requerAcaoHumana && <span title="Requer ação humana">👤</span>}
          {stage.ehGanho && <span title="Estágio de ganho">🏆</span>}
        </div>
        <span className="text-xs font-bold text-gray-500 ml-1 flex-shrink-0">
          {stage.deals.length}
        </span>
      </div>

      {/* Cards */}
      <div
        ref={setNodeRef}
        className="flex-1 p-2 space-y-2 min-h-[120px] overflow-y-auto max-h-[calc(100vh-220px)]"
      >
        <SortableContext
          items={stage.deals.map((d) => d.id)}
          strategy={verticalListSortingStrategy}
        >
          {stage.deals.map((deal) => (
            <DealCard key={deal.id} deal={deal} onOpen={onOpenDeal} onWhatsApp={onWhatsApp} onCriarReuniao={onCriarReuniao} />
          ))}
        </SortableContext>
      </div>

      {/* Add button */}
      <div className="p-2 border-t border-gray-200">
        <button
          onClick={() => onAddDeal(stage.id)}
          className="w-full text-xs text-gray-400 hover:text-gray-700 hover:bg-white rounded-md py-1.5 transition-colors flex items-center justify-center gap-1"
        >
          <span className="text-base leading-none">+</span> Adicionar
        </button>
      </div>
    </div>
  );
}

// ── Modal de deal ─────────────────────────────────────────────────────────────

export function DealModal({
  deal,
  stages,
  pipelineId,
  onClose,
  onSaved,
}: {
  deal: Deal | null;
  stages: Stage[];
  pipelineId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const navigate = useNavigate();
  const { ligar } = useVoip();
  const isNew = !deal?.id;
  const dialerRef = useRef<VoipDialerHandle>(null);
  const dialerDivRef = useRef<HTMLDivElement>(null);

  function discaNumero(num: string) {
    ligar(num);
  }

  const [titulo, setTitulo] = useState(deal?.titulo ?? "");
  const [descricao, setDescricao] = useState((deal as any)?.descricao ?? "");
  const [valor, setValor] = useState(deal?.valor ?? "");
  const [urgencia, setUrgencia] = useState(deal?.urgencia ?? false);
  const [valorEstimado, setValorEstimado] = useState((deal as any)?.valorEstimado ?? "");
  const [valorCausaAjuizada, setValorCausaAjuizada] = useState((deal as any)?.valorCausaAjuizada ?? "");
  const [valorCondenacao, setValorCondenacao] = useState((deal as any)?.valorCondenacao ?? "");
  const [valorAcordo, setValorAcordo] = useState((deal as any)?.valorAcordo ?? "");
  const [stageId, setStageId] = useState(deal?.stageId ?? stages[0]?.id ?? "");
  const [notaText, setNotaText] = useState("");
  // contato inline
  const [contatoNome, setContatoNome] = useState(deal?.contato?.nome ?? "");
  const [contatoWa, setContatoWa] = useState(deal?.contato?.whatsapp ?? "");
  const [contatoCidade, setContatoCidade] = useState(deal?.contato?.cidade ?? "");

  const utils = trpc.useUtils();

  // Só as tags do funil deste deal + as gerais: tag de outro funil não se aplica aqui.
  const { data: allTags } = trpc.crm.listTags.useQuery(pipelineId ? { pipelineId } : undefined);
  const [dealTagIds, setDealTagIds] = useState<string[]>((deal as any)?.tags?.map((t: any) => t.id) ?? []);
  // Liga/desliga uma tag por vez — regravar a lista inteira apagava a tag que a IA
  // tivesse aplicado depois que a modal abriu.
  const toggleDealTagMut = trpc.crm.toggleDealTag.useMutation({
    onSuccess: (res) => {
      setDealTagIds(res.tags.map((t) => t.id));
      utils.crm.kanban.invalidate();
      utils.ia.listConversas.invalidate();
      utils.ia.resumoConversas.invalidate();
    },
  });
  function toggleDealTag(tagId: string) {
    const ativo = !dealTagIds.includes(tagId);
    setDealTagIds(ativo ? [...dealTagIds, tagId] : dealTagIds.filter(id => id !== tagId));
    if (deal?.id) toggleDealTagMut.mutate({ dealId: deal.id, tagId, ativo });
  }

  const [confirmDelete, setConfirmDelete] = useState(false);

  const createMut = trpc.crm.createDeal.useMutation({
    onSuccess: () => { utils.crm.kanban.invalidate(); onSaved(); },
  });
  const updateMut = trpc.crm.updateDeal.useMutation({
    onSuccess: () => { utils.crm.kanban.invalidate(); onSaved(); },
  });
  const updateContatoMut = trpc.crm.updateContato.useMutation({
    onSuccess: () => { utils.crm.kanban.invalidate(); },
  });
  const [erroExclusao, setErroExclusao] = useState<string | null>(null);
  const deleteMut = trpc.crm.deleteDeal.useMutation({
    onSuccess: () => { setErroExclusao(null); utils.crm.kanban.invalidate(); onSaved(); },
    onError: (e) => setErroExclusao(e.message),
  });
  const addNotaMut = trpc.crm.addNota.useMutation({
    onSuccess: () => { utils.crm.getDeal.invalidate(); setNotaText(""); },
  });

  const [reuniaoResult, setReuniaoResult] = useState<{ jitsiUrl: string; linkConvidado: string; titulo: string } | null>(null);
  const criarReuniaoMut = trpc.reunioes.criarInstantanea.useMutation({
    onSuccess: (data) => {
      setReuniaoResult(data);
      utils.reunioes.listar.invalidate({ dealId: deal?.id });
    },
  });
  const { data: reunioesDoDeal } = trpc.reunioes.listar.useQuery(
    { dealId: deal?.id ?? "" },
    { enabled: !!deal?.id }
  );

  // Agendar reunião manualmente (SDR humana)
  const [agendarForm, setAgendarForm] = useState({ show: false, usuarioId: "", agendadaPara: "" });
  const [agendarResult, setAgendarResult] = useState<{ jitsiUrl: string; linkConvidado: string; titulo: string } | null>(null);
  const { data: usuariosList } = trpc.reunioes.listarUsuarios.useQuery(
    undefined,
    { enabled: !isNew }
  );
  const criarAgendadaMut = trpc.reunioes.criarAgendada.useMutation({
    onSuccess: (data) => {
      setAgendarResult(data);
      setAgendarForm({ show: false, usuarioId: "", agendadaPara: "" });
      utils.reunioes.listar.invalidate({ dealId: deal?.id });
      utils.crm.kanban.invalidate();
    },
  });

  const { data: dealDetail } = trpc.crm.getDeal.useQuery(
    { id: deal?.id ?? "" },
    { enabled: !!deal?.id }
  );

  const [coletaDocsOk, setColetaDocsOk] = useState(false);
  const dispararColetaMut = trpc.ia.dispararFluxoColetaDocs.useMutation({
    onSuccess: () => { setColetaDocsOk(true); utils.crm.getDeal.invalidate({ id: deal?.id ?? "" }); },
  });

  const [marcarReuniaoOk, setMarcarReuniaoOk] = useState(false);
  const dispararReuniaoMut = trpc.ia.dispararFluxoMarcarReuniao.useMutation({
    onSuccess: () => { setMarcarReuniaoOk(true); utils.crm.getDeal.invalidate({ id: deal?.id ?? "" }); },
  });

  // Mover para funil
  const [moverPipelineId, setMoverPipelineId] = useState("");
  const [moverStageId, setMoverStageId] = useState("");
  const todosOsPipelines = trpc.crm.listPipelines.useQuery(undefined, { enabled: !isNew });
  const stagesMoverPipeline = trpc.crm.listStages.useQuery(
    { pipelineId: moverPipelineId },
    { enabled: !!moverPipelineId }
  );
  const moverDealMut = trpc.crm.moveDeal.useMutation({
    onSuccess: () => { utils.crm.kanban.invalidate(); onSaved(); },
  });

  const { data: anexosDeal, refetch: refetchAnexos } = trpc.ia.listarAnexosDeal.useQuery(
    { dealId: deal?.id ?? "" },
    { enabled: !!deal?.id }
  );
  const [selectedAnexos, setSelectedAnexos] = useState<Set<string>>(new Set());
  const [downloadingZip, setDownloadingZip] = useState(false);
  const [uploadingFile, setUploadingFile] = useState(false);
  const [deletingAnexoId, setDeletingAnexoId] = useState<string | null>(null);

  function toggleAnexo(id: string) {
    setSelectedAnexos(prev => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s; });
  }
  function toggleAllAnexos() {
    if (!anexosDeal) return;
    if (selectedAnexos.size === anexosDeal.length) { setSelectedAnexos(new Set()); }
    else { setSelectedAnexos(new Set(anexosDeal.map((a: any) => a.id))); }
  }

  async function downloadSelecionados() {
    if (!anexosDeal || selectedAnexos.size === 0) return;
    const token = localStorage.getItem("avoce_token") ?? "";
    if (selectedAnexos.size === 1) {
      const id = [...selectedAnexos][0];
      const a = document.createElement("a");
      a.href = `/api/deal-anexos/${id}/download`;
      const headers = new Headers({ Authorization: `Bearer ${token}` });
      const res = await fetch(a.href, { headers });
      if (!res.ok) return;
      const blob = await res.blob();
      const nome = anexosDeal.find((x: any) => x.id === id)?.nomeArquivo ?? "documento";
      const url = URL.createObjectURL(blob);
      a.href = url; a.download = nome; a.click(); URL.revokeObjectURL(url);
    } else {
      setDownloadingZip(true);
      try {
        const res = await fetch("/api/deal-anexos/download-zip", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ ids: [...selectedAnexos] }),
        });
        if (!res.ok) return;
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a"); a.href = url; a.download = "documentos.zip"; a.click(); URL.revokeObjectURL(url);
      } finally { setDownloadingZip(false); }
    }
  }

  async function uploadAnexo(file: File) {
    if (!deal?.id) return;
    const token = localStorage.getItem("avoce_token") ?? "";
    setUploadingFile(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch(`/api/deal-anexos/${deal.id}/upload`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });
      if (res.ok) refetchAnexos();
    } finally {
      setUploadingFile(false);
    }
  }

  async function deletarAnexo(id: string) {
    const token = localStorage.getItem("avoce_token") ?? "";
    setDeletingAnexoId(id);
    try {
      const res = await fetch(`/api/deal-anexos/${id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        setSelectedAnexos(prev => { const s = new Set(prev); s.delete(id); return s; });
        refetchAnexos();
      }
    } finally {
      setDeletingAnexoId(null);
    }
  }

  const { data: ligacoes } = trpc.ligacoes.listar.useQuery(
    { dealId: deal?.id ?? "" },
    { enabled: !!deal?.id }
  );

  function handleSave() {
    const valorNum = valor ? parseFloat(String(valor)) : undefined;
    if (isNew) {
      createMut.mutate({
        titulo,
        pipelineId,
        stageId,
        valor: valorNum,
        descricao,
        urgencia,
        contato: contatoNome ? { nome: contatoNome, whatsapp: contatoWa || undefined, cidade: contatoCidade || undefined } : undefined,
      });
    } else {
      updateMut.mutate({
        id: deal!.id,
        titulo,
        descricao,
        valor: valorNum ?? null,
        urgencia,
        valorEstimado:      valorEstimado      ? parseFloat(String(valorEstimado).replace(/\./g, "").replace(",", "."))      : null,
        valorCausaAjuizada: valorCausaAjuizada ? parseFloat(String(valorCausaAjuizada).replace(/\./g, "").replace(",", ".")) : null,
        valorCondenacao:    valorCondenacao    ? parseFloat(String(valorCondenacao).replace(/\./g, "").replace(",", "."))    : null,
        valorAcordo:        valorAcordo        ? parseFloat(String(valorAcordo).replace(/\./g, "").replace(",", "."))        : null,
      });
      // O card do funil mostra o nome do CONTATO (não o título do deal) quando
      // há contato vinculado — sem isso, editar o "nome" aqui não refletia no board.
      if (deal?.contato?.id) {
        updateContatoMut.mutate({
          id: deal.contato.id,
          nome: contatoNome,
          whatsapp: contatoWa || null,
          cidade: contatoCidade || null,
        });
      }
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-5 border-b border-gray-100 flex items-center justify-between">
          <h2 className="text-lg font-bold text-gray-800">
            {isNew ? "Novo Lead" : "Editar Lead"}
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl">×</button>
        </div>

        <div className="p-5 space-y-4">
          {!isNew && <OrigemDetalhe deal={deal as DealOrigem | null} />}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Título *</label>
            <input
              value={titulo}
              onChange={(e) => setTitulo(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
              placeholder="Nome do deal"
            />
          </div>

          {isNew && (
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Stage inicial</label>
              <select
                value={stageId}
                onChange={(e) => setStageId(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
              >
                {stages.map((s) => (
                  <option key={s.id} value={s.id}>{s.nome}</option>
                ))}
              </select>
            </div>
          )}

          {/* Mover para outro funil */}
          {!isNew && (
            <div className="border-t pt-4">
              <p className="text-xs font-semibold text-gray-500 uppercase mb-2">Mover para outro funil</p>
              <div className="flex gap-2 items-center">
                <select
                  value={moverPipelineId}
                  onChange={(e) => { setMoverPipelineId(e.target.value); setMoverStageId(""); }}
                  className="flex-1 border border-gray-300 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-brand-500"
                >
                  <option value="">Selecionar funil...</option>
                  {(todosOsPipelines.data as any[] | undefined)
                    ?.filter((p: any) => p.id !== pipelineId)
                    .map((p: any) => <option key={p.id} value={p.id}>{p.nome}</option>)}
                </select>
                {moverPipelineId && (
                  <select
                    value={moverStageId}
                    onChange={(e) => setMoverStageId(e.target.value)}
                    className="flex-1 border border-gray-300 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-brand-500"
                  >
                    <option value="">Etapa...</option>
                    {(stagesMoverPipeline.data as any[] | undefined)?.map((s: any) => (
                      <option key={s.id} value={s.id}>{s.nome}</option>
                    ))}
                  </select>
                )}
                <button
                  type="button"
                  disabled={!moverStageId || moverDealMut.isPending}
                  onClick={() => deal?.id && moverStageId && moverDealMut.mutate({ dealId: deal.id, stageId: moverStageId })}
                  className="px-3 py-1.5 text-xs bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-40"
                >
                  Mover
                </button>
              </div>
            </div>
          )}

          {/* Valores financeiros */}
          {!isNew && (
            <div className="border-t pt-4">
              <p className="text-xs font-semibold text-gray-500 uppercase mb-3">Avaliação Jurídica — Valores</p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">⚖️ Estimativa IA (R$)</label>
                  <input
                    type="number"
                    value={valorEstimado}
                    onChange={(e) => setValorEstimado(e.target.value)}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                    placeholder="0,00"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">📋 Causa ajuizada (R$)</label>
                  <input
                    type="number"
                    value={valorCausaAjuizada}
                    onChange={(e) => setValorCausaAjuizada(e.target.value)}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                    placeholder="0,00"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">🏛️ Condenação (R$)</label>
                  <input
                    type="number"
                    value={valorCondenacao}
                    onChange={(e) => setValorCondenacao(e.target.value)}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                    placeholder="0,00"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">🤝 Acordo (R$)</label>
                  <input
                    type="number"
                    value={valorAcordo}
                    onChange={(e) => setValorAcordo(e.target.value)}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                    placeholder="0,00"
                  />
                </div>
              </div>
            </div>
          )}

          {/* Audiência designada + mensagem ao cliente */}
          {!isNew && deal?.id && <AudienciaLead dealId={deal.id} />}

          {/* Acordo — registro paralelo ao funil (não mexe em coluna/prazo/audiência) */}
          {!isNew && deal?.id && <AcordoDeal dealId={deal.id} />}

          {/* Parecer — exibido quando preenchido pela IA */}
          {!isNew && dealDetail && (dealDetail as any).parecer && (
            <div className="border-t pt-4">
              <p className="text-xs font-semibold text-gray-500 uppercase mb-2">Parecer — Dra. Daniela</p>
              <div className="bg-indigo-50 border border-indigo-200 rounded-lg p-3 text-xs text-gray-700 whitespace-pre-wrap max-h-48 overflow-y-auto">
                {(dealDetail as any).parecer}
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Valor (R$)</label>
              <input
                type="number"
                value={valor}
                onChange={(e) => setValor(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                placeholder="0,00"
              />
            </div>
            <div className="flex items-end pb-2">
              <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={urgencia}
                  onChange={(e) => setUrgencia(e.target.checked)}
                  className="rounded"
                />
                🔴 Urgente
              </label>
            </div>
          </div>

          {!isNew && (
            <div>
              <label className="text-xs font-medium text-gray-500 uppercase tracking-wider block mb-1.5">Tags</label>
              <div className="flex flex-wrap gap-1.5">
                {allTags?.map(tag => {
                  const active = dealTagIds.includes(tag.id);
                  return (
                    <button
                      key={tag.id}
                      type="button"
                      onClick={() => toggleDealTag(tag.id)}
                      className={`inline-flex items-center text-xs font-medium px-2 py-1 rounded-full border-2 transition-all ${active ? "text-white border-transparent" : "text-gray-600 bg-white border-gray-200 hover:border-gray-400"}`}
                      style={active ? { backgroundColor: tag.cor, borderColor: tag.cor } : {}}
                    >
                      {tag.nome}
                    </button>
                  );
                })}
                {(!allTags || allTags.length === 0) && (
                  <p className="text-xs text-gray-400">Nenhuma tag criada. Crie tags no funil.</p>
                )}
              </div>
            </div>
          )}

          {(isNew || deal?.contato) && (
            <div className="border-t pt-4">
              <p className="text-xs font-semibold text-gray-500 uppercase mb-1">Contato</p>
              {!isNew && (
                <p className="text-[11px] text-gray-400 mb-2">
                  O card do funil mostra este nome, não o "Título" acima.
                </p>
              )}
              <div className="space-y-2">
                <input
                  value={contatoNome}
                  onChange={(e) => setContatoNome(e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                  placeholder="Nome do contato"
                />
                <div className="grid grid-cols-2 gap-2">
                  <input
                    value={contatoWa}
                    onChange={(e) => setContatoWa(e.target.value)}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                    placeholder="WhatsApp"
                  />
                  <input
                    value={contatoCidade}
                    onChange={(e) => setContatoCidade(e.target.value)}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                    placeholder="Cidade"
                  />
                </div>
              </div>
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Observações</label>
            <textarea
              value={descricao}
              onChange={(e) => setDescricao(e.target.value)}
              rows={3}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
              placeholder="Notas, observações..."
            />
          </div>

          {/* Campos detalhados — carregados via getDeal */}
          {!isNew && dealDetail && (() => {
            const d = dealDetail as any;
            const wa = d.contato?.whatsapp;
            const tel = d.contato?.telefone;
            const social = !wa && (d.contato?.instagramId ? "Instagram" : d.contato?.messengerId ? "Messenger" : null);
            return (
              <>
                {(wa || tel || social || d.contato?.empresa || d.organizacao) && (
                  <div className="border-t pt-4">
                    <p className="text-xs font-semibold text-gray-500 uppercase mb-2">Contato</p>
                    <div className="text-xs text-gray-600 space-y-1.5">
                      {d.contato?.empresa && <p>🏢 {d.contato.empresa}</p>}
                      {d.organizacao && d.organizacao !== d.contato?.empresa && <p>🏢 {d.organizacao}</p>}
                      {wa && (
                        <p>📱{" "}
                          <button onClick={() => discaNumero(wa)} className="underline text-green-700 hover:text-green-900 font-medium">{wa}</button>
                          {" "}
                          <button
                            onClick={() => { onClose(); navigate(`/whatsapp?dealId=${deal?.id}`); }}
                            className="text-indigo-600 hover:text-indigo-700 font-medium underline"
                          >
                            Atender no Chat ↗
                          </button>
                        </p>
                      )}
                      {social && (
                        <p>💬 {social}{d.contato?.instagramUsername ? ` @${d.contato.instagramUsername}` : ""}{" "}
                          <button
                            onClick={() => { onClose(); navigate(`/whatsapp?dealId=${deal?.id}`); }}
                            className="text-indigo-600 hover:text-indigo-700 font-medium underline"
                          >
                            Abrir conversa no Chat ↗
                          </button>
                        </p>
                      )}
                      {tel && <p>📞{" "}<button onClick={() => discaNumero(tel)} className="underline text-green-700 hover:text-green-900 font-medium">{tel}</button></p>}
                    </div>
                  </div>
                )}
                {(d.probabilidade || d.moeda || d.rotulo || d.dataFechamentoEsperada || d.motivoPerda) && (
                  <div className="border-t pt-4">
                    <p className="text-xs font-semibold text-gray-500 uppercase mb-2">Detalhes</p>
                    <div className="text-xs text-gray-600 space-y-1">
                      {d.probabilidade != null && <p>📊 Probabilidade: {d.probabilidade}%</p>}
                      {d.moeda && d.moeda !== "BRL" && <p>💱 Moeda: {d.moeda}</p>}
                      {d.rotulo && <p>🏷 Rótulo: {d.rotulo}</p>}
                      {d.dataFechamentoEsperada && <p>📅 Fechamento esperado: {new Date(d.dataFechamentoEsperada).toLocaleDateString("pt-BR")}</p>}
                      {d.motivoPerda && <p>❌ Motivo perda: {d.motivoPerda}</p>}
                    </div>
                  </div>
                )}
                {d.camposCustom && Object.keys(d.camposCustom).length > 0 && (() => {
                  const campos = Object.entries(d.camposCustom as Record<string, unknown>)
                    .filter(([, v]) => v !== null && v !== undefined && v !== "" &&
                                       !(Array.isArray(v) && v.length === 0));
                  // Um valor pode ser objeto ou lista de objetos (integrações gravam
                  // estruturas aqui). Renderizar objeto direto quebra o React, então as
                  // listas de objetos saem em bloco próprio e o resto vira texto.
                  const ehListaDeObjetos = (v: unknown) =>
                    Array.isArray(v) && v.some((x) => x !== null && typeof x === "object");
                  const simples = campos.filter(([, v]) => !ehListaDeObjetos(v));
                  const listas = campos.filter(([, v]) => ehListaDeObjetos(v));
                  return (
                    <div className="border-t pt-4">
                      <p className="text-xs font-semibold text-gray-500 uppercase mb-2">Campos personalizados</p>
                      <div className="text-xs text-gray-600 space-y-1">
                        {simples.map(([k, v]) => (
                          <p key={k}><span className="font-medium">{rotuloCampo(k)}:</span> {valorCampo(v)}</p>
                        ))}
                      </div>
                      {listas.map(([k, v]) => {
                        const itens = v as Record<string, unknown>[];
                        return (
                          <details key={k} className="mt-3">
                            <summary className="text-xs font-semibold text-gray-500 uppercase cursor-pointer hover:text-gray-700">
                              {rotuloCampo(k)} ({itens.length})
                            </summary>
                            <ul className="mt-1.5 space-y-1 text-xs text-gray-600">
                              {itens.map((item, i) => (
                                <li key={i} className="border-l-2 border-gray-200 pl-2">
                                  {valorCampo(item)}
                                </li>
                              ))}
                            </ul>
                          </details>
                        );
                      })}
                    </div>
                  );
                })()}
              </>
            );
          })()}

          {/* Histórico de etapas */}
          {!isNew && dealDetail?.stageLog && dealDetail.stageLog.length > 0 && (
            <div className="border-t pt-4">
              <p className="text-xs font-semibold text-gray-500 uppercase mb-3">
                Histórico de etapas ({dealDetail.stageLog.length})
              </p>
              <div className="relative pl-4">
                <div className="absolute left-1.5 top-0 bottom-0 w-px bg-gray-200" />
                <div className="space-y-2">
                  {dealDetail.stageLog.map((log: any) => {
                    const stagesMap = (dealDetail as any).pipeline?.stages ?? [];
                    const anterior = stagesMap.find((s: any) => s.id === log.stageAnteriorId);
                    const novo = stagesMap.find((s: any) => s.id === log.stageNovoId);
                    return (
                      <div key={log.id} className="flex items-start gap-2">
                        <div
                          className="w-3 h-3 rounded-full border-2 border-white flex-shrink-0 mt-0.5 -ml-1.5"
                          style={{ backgroundColor: novo?.cor ?? "#6b7280" }}
                        />
                        <div className="min-w-0">
                          <p className="text-xs text-gray-700">
                            {anterior ? (
                              <><span className="text-gray-400">{anterior.nome}</span> → <span className="font-medium">{novo?.nome ?? log.stageNovoId}</span></>
                            ) : (
                              <span className="font-medium">{novo?.nome ?? log.stageNovoId}</span>
                            )}
                          </p>
                          <p className="text-xs text-gray-400">
                            {new Date(log.criadoEm).toLocaleString("pt-BR")}
                          </p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {/* Ligações VoIP */}
          {!isNew && (
            <div ref={dialerDivRef} className="border-t pt-4">
              <p className="text-xs font-semibold text-gray-500 uppercase mb-3">
                Ligações ({ligacoes?.length ?? 0})
              </p>
              <VoipDialer
                ref={dialerRef}
                dealId={deal!.id}
                contatoWhatsapp={(dealDetail as any)?.contato?.whatsapp}
                contatoTelefone={(dealDetail as any)?.contato?.telefone}
              />
              {ligacoes && ligacoes.length > 0 && (
                <div className="mt-3 space-y-2 max-h-48 overflow-y-auto">
                  {ligacoes.map((l: any) => (
                    <div key={l.id} className="bg-gray-50 border border-gray-200 rounded-lg p-2.5">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs font-medium text-gray-700">
                          📞{" "}<button onClick={() => discaNumero(l.numeroDestino)} className="underline text-green-700 hover:text-green-900">{l.numeroDestino}</button>
                        </span>
                        <span className={`text-xs px-1.5 py-0.5 rounded-full ${
                          l.status === "ENCERRADA"     ? "bg-green-100 text-green-700" :
                          l.status === "EM_ANDAMENTO"  ? "bg-blue-100 text-blue-700" :
                          l.status === "DISCANDO"      ? "bg-yellow-100 text-yellow-700" :
                          "bg-red-100 text-red-700"
                        }`}>
                          {l.status === "ENCERRADA"    ? "encerrada" :
                           l.status === "EM_ANDAMENTO" ? "em ligação" :
                           l.status === "DISCANDO"     ? "discando" :
                           l.status.toLowerCase()}
                        </span>
                      </div>
                      <p className="text-xs text-gray-400">
                        {new Date(l.iniciadaEm).toLocaleString("pt-BR")}
                        {l.duracao ? ` • ${Math.floor(l.duracao / 60)}min ${l.duracao % 60}s` : ""}
                      </p>
                      {l.resumo && (
                        <p className="text-xs text-gray-600 mt-1 whitespace-pre-wrap">{l.resumo}</p>
                      )}
                      {!l.resumo && l.transcricao && (
                        <details className="mt-1">
                          <summary className="text-xs text-indigo-600 cursor-pointer">Ver transcrição</summary>
                          <p className="text-xs text-gray-600 mt-1 whitespace-pre-wrap">{l.transcricao}</p>
                        </details>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Videochamada */}
          {!isNew && (
            <div className="border-t pt-4">
              <div className="flex items-center justify-between mb-3">
                <p className="text-xs font-semibold text-gray-500 uppercase">
                  Videochamada ({reunioesDoDeal?.length ?? 0})
                </p>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => criarReuniaoMut.mutate({ dealId: deal!.id })}
                    disabled={criarReuniaoMut.isPending}
                    className="text-xs bg-indigo-600 text-white px-3 py-1.5 rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition-colors"
                  >
                    {criarReuniaoMut.isPending ? "Criando..." : "📹 Agora"}
                  </button>
                  <BotaoAgendarReuniao dealId={deal!.id}
                    onSalvo={() => { utils.reunioes.listar.invalidate({ dealId: deal?.id }); utils.crm.kanban.invalidate(); }}
                    className="text-xs bg-emerald-600 text-white px-3 py-1.5 rounded-lg hover:bg-emerald-700 transition-colors" />
                </div>
              </div>

              {(reuniaoResult || agendarResult) && (() => {
                const r = agendarResult ?? reuniaoResult!;
                const isAgendada = !!agendarResult;
                return (
                  <div className={`border rounded-lg p-3 mb-3 space-y-2 ${isAgendada ? "bg-emerald-50 border-emerald-200" : "bg-indigo-50 border-indigo-200"}`}>
                    <p className={`text-xs font-semibold ${isAgendada ? "text-emerald-700" : "text-indigo-700"}`}>
                      {isAgendada ? "Reunião agendada — confirmação e lembretes enviados por WhatsApp" : "Reunião criada — link enviado por WhatsApp"}
                    </p>
                    <div className="flex items-center gap-2">
                      <a
                        href={r.jitsiUrl}
                        target="_blank"
                        rel="noreferrer"
                        className={`text-xs text-white px-3 py-1.5 rounded-lg inline-block ${isAgendada ? "bg-emerald-600 hover:bg-emerald-700" : "bg-indigo-600 hover:bg-indigo-700"}`}
                      >
                        Entrar na sala (advogado)
                      </a>
                      <button
                        onClick={() => { navigator.clipboard.writeText(r.linkConvidado); }}
                        className={`text-xs border px-3 py-1.5 rounded-lg ${isAgendada ? "border-emerald-300 text-emerald-700 hover:bg-emerald-100" : "border-indigo-300 text-indigo-700 hover:bg-indigo-100"}`}
                      >
                        Copiar link cliente
                      </button>
                    </div>
                    <p className={`text-xs break-all ${isAgendada ? "text-emerald-500" : "text-indigo-500"}`}>{r.linkConvidado}</p>
                  </div>
                );
              })()}

              <ReunioesDoLead dealId={deal!.id} onChange={() => utils.crm.kanban.invalidate()} />
            </div>
          )}

          {/* Marcar reunião via Ana */}
          {!isNew && (
            <div className="border-t pt-4">
              <div className="flex items-center justify-between mb-3">
                <p className="text-xs font-semibold text-gray-500 uppercase">Agendar Reunião (Ana)</p>
                <button
                  onClick={() => dispararReuniaoMut.mutate({ dealId: deal!.id })}
                  disabled={dispararReuniaoMut.isPending || marcarReuniaoOk}
                  className="text-xs bg-violet-600 text-white px-3 py-1.5 rounded-lg hover:bg-violet-700 disabled:opacity-50 transition-colors"
                >
                  {dispararReuniaoMut.isPending ? "Enviando..." : marcarReuniaoOk ? "Agendamento iniciado!" : "📅 Marcar reunião"}
                </button>
              </div>
              {marcarReuniaoOk && (
                <p className="text-xs text-violet-700 bg-violet-50 border border-violet-200 rounded-lg p-2">
                  Ana entrará em contato pelo WhatsApp para agendar a consulta com a Dra. Daniela.
                </p>
              )}
            </div>
          )}

          {/* Coleta de Documentos pós-reunião */}
          {!isNew && (
            <div className="border-t pt-4">
              <div className="flex items-center justify-between mb-3">
                <p className="text-xs font-semibold text-gray-500 uppercase">Coleta de Docs (pós-reunião)</p>
                <button
                  onClick={() => dispararColetaMut.mutate({ dealId: deal!.id })}
                  disabled={dispararColetaMut.isPending || coletaDocsOk}
                  className="text-xs bg-emerald-600 text-white px-3 py-1.5 rounded-lg hover:bg-emerald-700 disabled:opacity-50 transition-colors"
                >
                  {dispararColetaMut.isPending ? "Iniciando..." : coletaDocsOk ? "Fluxo iniciado!" : "Iniciar coleta"}
                </button>
              </div>
              {coletaDocsOk && (
                <p className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg p-2">
                  Ana iniciará a coleta de dados pelo WhatsApp. Acompanhe a conversa para verificar o progresso.
                </p>
              )}
            </div>
          )}

          {/* Pasta de documentos do deal */}
          {!isNew && (
            <div className="border-t pt-4">
              <div className="flex items-center justify-between mb-3">
                <p className="text-xs font-semibold text-gray-500 uppercase">
                  Documentos ({anexosDeal?.length ?? 0})
                </p>
                <div className="flex items-center gap-2">
                  {anexosDeal && anexosDeal.length > 0 && (
                    <>
                      <label className="flex items-center gap-1 cursor-pointer text-xs text-gray-500">
                        <input
                          type="checkbox"
                          checked={selectedAnexos.size === anexosDeal.length}
                          onChange={toggleAllAnexos}
                          className="rounded"
                        />
                        todos
                      </label>
                      {selectedAnexos.size > 0 && (
                        <button
                          onClick={downloadSelecionados}
                          disabled={downloadingZip}
                          className="text-xs bg-gray-700 text-white px-2.5 py-1 rounded-lg hover:bg-gray-900 disabled:opacity-50 transition-colors"
                        >
                          {downloadingZip ? "Preparando..." : selectedAnexos.size === 1 ? "Baixar" : `Baixar ZIP (${selectedAnexos.size})`}
                        </button>
                      )}
                    </>
                  )}
                  <label className={`text-xs px-2.5 py-1 rounded-lg border border-gray-300 cursor-pointer transition-colors ${uploadingFile ? "opacity-50 cursor-not-allowed" : "hover:bg-gray-50"}`}>
                    {uploadingFile ? "Enviando..." : "+ Anexar"}
                    <input
                      type="file"
                      className="hidden"
                      disabled={uploadingFile}
                      onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadAnexo(f); e.target.value = ""; }}
                    />
                  </label>
                </div>
              </div>
              {anexosDeal && anexosDeal.length > 0 && (
                <div className="space-y-2 max-h-56 overflow-y-auto">
                  {anexosDeal.map((a: any) => (
                    <div
                      key={a.id}
                      onClick={() => toggleAnexo(a.id)}
                      className={`cursor-pointer border rounded-lg p-2.5 transition-colors ${selectedAnexos.has(a.id) ? "bg-blue-50 border-blue-300" : "bg-gray-50 border-gray-200 hover:border-gray-300"}`}
                    >
                      <div className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={selectedAnexos.has(a.id)}
                          onChange={() => toggleAnexo(a.id)}
                          onClick={e => e.stopPropagation()}
                          className="rounded flex-shrink-0"
                        />
                        <span className="text-xs font-medium text-gray-700 truncate flex-1">{a.nomeArquivo}</span>
                        {a.tipoDocumento && a.tipoDocumento !== "OUTRO" && (
                          <span className={`text-xs px-1.5 py-0.5 rounded-full flex-shrink-0 ${
                            a.tipoDocumento === "TRANSCRICAO" ? "bg-purple-100 text-purple-700" : "bg-blue-100 text-blue-700"
                          }`}>
                            {a.tipoDocumento === "TRANSCRICAO" ? "Transcrição" : a.tipoDocumento}
                          </span>
                        )}
                        <button
                          onClick={(e) => { e.stopPropagation(); deletarAnexo(a.id); }}
                          disabled={deletingAnexoId === a.id}
                          className="text-red-400 hover:text-red-600 text-xs flex-shrink-0 disabled:opacity-50 px-1"
                          title="Excluir documento"
                        >
                          {deletingAnexoId === a.id ? "..." : "✕"}
                        </button>
                      </div>
                      {a.ocrTexto && (
                        <p className="text-xs text-gray-400 mt-1 line-clamp-2 pl-5">
                          {a.ocrTexto.replace(/^\[Documento recebido — dados extraídos\]\n/, "").slice(0, 120)}...
                        </p>
                      )}
                      <p className="text-xs text-gray-400 mt-1 pl-5">{new Date(a.criadoEm).toLocaleString("pt-BR")}</p>
                    </div>
                  ))}
                </div>
              )}
              {(!anexosDeal || anexosDeal.length === 0) && (
                <p className="text-xs text-gray-400">Nenhum documento enviado ainda.</p>
              )}
            </div>
          )}

          {/* Notas do deal (só quando editando) */}
          {!isNew && (
            <div className="border-t pt-4">
              <p className="text-xs font-semibold text-gray-500 uppercase mb-3">
                Notas internas ({dealDetail?.notas?.length ?? 0})
              </p>
              <div className="space-y-2 mb-3 max-h-32 overflow-y-auto">
                {dealDetail?.notas?.map((n) => (
                  <div key={n.id} className="bg-yellow-50 border border-yellow-200 rounded-lg p-2.5">
                    <p className="text-xs text-gray-700 whitespace-pre-wrap">{n.conteudo}</p>
                    <p className="text-xs text-gray-400 mt-1">
                      {new Date(n.criadoEm).toLocaleString("pt-BR")}
                    </p>
                  </div>
                ))}
              </div>
              <div className="flex gap-2">
                <input
                  value={notaText}
                  onChange={(e) => setNotaText(e.target.value)}
                  className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                  placeholder="Adicionar nota..."
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && notaText.trim()) {
                      addNotaMut.mutate({ dealId: deal!.id, conteudo: notaText });
                    }
                  }}
                />
                <button
                  disabled={!notaText.trim() || addNotaMut.isPending}
                  onClick={() => addNotaMut.mutate({ dealId: deal!.id, conteudo: notaText })}
                  className="bg-brand-600 text-white text-sm px-3 rounded-lg hover:bg-brand-700 disabled:opacity-50"
                >
                  +
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="p-5 border-t border-gray-100 flex justify-between items-center gap-2">
          <div>
            {!isNew && (
              confirmDelete ? (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-red-600">{erroExclusao ?? "Confirmar exclusão?"}</span>
                  <button
                    onClick={() => deleteMut.mutate({ id: deal!.id })}
                    disabled={deleteMut.isPending}
                    className="px-3 py-1.5 text-xs bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50"
                  >
                    {deleteMut.isPending ? "Excluindo..." : "Excluir"}
                  </button>
                  <button
                    onClick={() => setConfirmDelete(false)}
                    className="px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-100 rounded-lg"
                  >
                    Cancelar
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setConfirmDelete(true)}
                  className="px-3 py-1.5 text-xs text-red-500 hover:bg-red-50 rounded-lg border border-red-200 transition-colors"
                >
                  🗑 Excluir deal
                </button>
              )
            )}
          </div>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
            >
              Cancelar
            </button>
            <button
              onClick={handleSave}
              disabled={!titulo.trim() || createMut.isPending || updateMut.isPending}
              className="px-4 py-2 text-sm bg-brand-600 text-white rounded-lg hover:bg-brand-700 disabled:opacity-50 transition-colors"
            >
              {createMut.isPending || updateMut.isPending ? "Salvando..." : "Salvar"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Gerenciador de pipeline/etapas ────────────────────────────────────────────

const STAGE_COLORS = [
  "#6366f1","#3b82f6","#06b6d4","#10b981","#f59e0b",
  "#f97316","#ef4444","#8b5cf6","#6b7280","#ec4899",
];

type StageRow = {
  id: string; chave: string; nome: string; cor: string; ordem: number;
  ehEntrada: boolean; ehGanho: boolean; ehEncerramento: boolean; requerAcaoHumana: boolean;
};

function PipelineManagerModal({ pipelineId, pipelineName: initialName, onClose }: {
  pipelineId: string;
  pipelineName: string;
  onClose: () => void;
}) {
  const utils = trpc.useUtils();
  const [pipelineName, setPipelineName] = useState(initialName);
  const [nameEdited, setNameEdited] = useState(false);
  const [rows, setRows] = useState<StageRow[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [colorPickerId, setColorPickerId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [newChave, setNewChave] = useState("");
  const [newCor, setNewCor] = useState(STAGE_COLORS[0]);
  const [dirty, setDirty] = useState(false);

  const { data: stagesData, isLoading } = trpc.crm.listStages.useQuery({ pipelineId });

  useEffect(() => {
    if (stagesData) setRows(stagesData as unknown as StageRow[]);
  }, [stagesData]);

  const updatePipelineMut = trpc.crm.updatePipeline.useMutation({
    onSuccess: () => utils.crm.listPipelines.invalidate(),
  });
  const updateStageMut = trpc.crm.updateStage.useMutation({
    onSuccess: () => utils.crm.listStages.invalidate({ pipelineId }),
  });
  const createStageMut = trpc.crm.createStage.useMutation({
    onSuccess: () => {
      setNewName(""); setNewChave(""); setNewCor(STAGE_COLORS[0]);
      utils.crm.listStages.invalidate({ pipelineId });
      utils.crm.kanban.invalidate();
    },
  });
  const deleteStageMut = trpc.crm.deleteStage.useMutation({
    onSuccess: () => {
      setConfirmDeleteId(null);
      utils.crm.listStages.invalidate({ pipelineId });
      utils.crm.kanban.invalidate();
    },
  });
  const reorderMut = trpc.crm.reorderStages.useMutation({
    onSuccess: () => utils.crm.listStages.invalidate({ pipelineId }),
  });

  function move(idx: number, dir: -1 | 1) {
    const next = [...rows];
    const target = idx + dir;
    if (target < 0 || target >= next.length) return;
    [next[idx], next[target]] = [next[target], next[idx]];
    setRows(next);
    setDirty(true);
    reorderMut.mutate({ pipelineId, stageIds: next.map((r) => r.id) });
  }

  function saveFlag(id: string, field: keyof StageRow, val: boolean) {
    setRows((prev) => prev.map((r) => r.id === id ? { ...r, [field]: val } : r));
    updateStageMut.mutate({ id, [field]: val });
  }

  function saveName(id: string) {
    if (!editingName.trim()) return;
    setRows((prev) => prev.map((r) => r.id === id ? { ...r, nome: editingName.trim() } : r));
    updateStageMut.mutate({ id, nome: editingName.trim() });
    setEditingId(null);
  }

  function saveColor(id: string, cor: string) {
    setRows((prev) => prev.map((r) => r.id === id ? { ...r, cor } : r));
    updateStageMut.mutate({ id, cor });
    setColorPickerId(null);
  }

  function addStage() {
    const chave = newChave.trim() || newName.trim().toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
    if (!newName.trim() || !chave) return;
    createStageMut.mutate({ pipelineId, nome: newName.trim(), chave, cor: newCor });
  }

  const FLAG_LABELS: { field: keyof StageRow; label: string; color: string }[] = [
    { field: "ehEntrada",       label: "entrada",  color: "bg-green-100 text-green-700 border-green-200" },
    { field: "ehGanho",         label: "ganho",    color: "bg-blue-100 text-blue-700 border-blue-200" },
    { field: "ehEncerramento",  label: "encerra",  color: "bg-gray-100 text-gray-600 border-gray-200" },
    { field: "requerAcaoHumana",label: "humano",   color: "bg-yellow-100 text-yellow-700 border-yellow-200" },
  ];

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h2 className="text-base font-semibold text-gray-800">Configurar funil</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">✕</button>
        </div>

        <div className="overflow-y-auto flex-1 px-6 py-4 space-y-6">
          {/* Nome do pipeline */}
          <div>
            <label className="text-xs font-medium text-gray-500 uppercase tracking-wider block mb-1.5">Nome do funil</label>
            <div className="flex gap-2">
              <input
                value={pipelineName}
                onChange={(e) => { setPipelineName(e.target.value); setNameEdited(true); }}
                className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
              />
              <button
                onClick={() => { updatePipelineMut.mutate({ id: pipelineId, nome: pipelineName }); setNameEdited(false); }}
                disabled={!nameEdited || updatePipelineMut.isPending}
                className="px-3 py-2 bg-indigo-600 text-white text-sm rounded-lg hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Salvar
              </button>
            </div>
          </div>

          {/* Etapas */}
          <div>
            <label className="text-xs font-medium text-gray-500 uppercase tracking-wider block mb-3">Etapas</label>

            {isLoading ? (
              <p className="text-sm text-gray-400">Carregando...</p>
            ) : (
              <div className="space-y-1.5">
                {rows.map((row, idx) => (
                  <div key={row.id} className="flex items-center gap-2 bg-gray-50 rounded-lg px-3 py-2 group">
                    {/* Reorder */}
                    <div className="flex flex-col gap-0.5">
                      <button onClick={() => move(idx, -1)} disabled={idx === 0} className="text-gray-300 hover:text-gray-500 disabled:opacity-20 leading-none text-xs">▲</button>
                      <button onClick={() => move(idx, 1)} disabled={idx === rows.length - 1} className="text-gray-300 hover:text-gray-500 disabled:opacity-20 leading-none text-xs">▼</button>
                    </div>

                    {/* Color swatch */}
                    <div className="relative flex-shrink-0">
                      <button
                        className="w-5 h-5 rounded-full border-2 border-white shadow"
                        style={{ backgroundColor: row.cor }}
                        onClick={() => setColorPickerId(colorPickerId === row.id ? null : row.id)}
                      />
                      {colorPickerId === row.id && (
                        <div className="absolute left-0 top-7 z-10 bg-white border border-gray-200 rounded-lg shadow-lg p-2 flex flex-wrap gap-1.5 w-40">
                          {STAGE_COLORS.map((c) => (
                            <button
                              key={c}
                              className={`w-6 h-6 rounded-full border-2 transition-transform hover:scale-110 ${row.cor === c ? "border-gray-700 scale-110" : "border-white"}`}
                              style={{ backgroundColor: c }}
                              onClick={() => saveColor(row.id, c)}
                            />
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Name */}
                    <div className="flex-1 min-w-0">
                      {editingId === row.id ? (
                        <input
                          autoFocus
                          value={editingName}
                          onChange={(e) => setEditingName(e.target.value)}
                          onBlur={() => saveName(row.id)}
                          onKeyDown={(e) => { if (e.key === "Enter") saveName(row.id); if (e.key === "Escape") setEditingId(null); }}
                          className="w-full text-sm border-b border-indigo-400 bg-transparent focus:outline-none"
                        />
                      ) : (
                        <button
                          className="text-sm text-gray-800 text-left w-full truncate hover:text-indigo-600"
                          onClick={() => { setEditingId(row.id); setEditingName(row.nome); }}
                        >
                          {row.nome}
                        </button>
                      )}
                      <span className="text-xs text-gray-400 font-mono">{row.chave}</span>
                    </div>

                    {/* Flags */}
                    <div className="flex gap-1 flex-shrink-0">
                      {FLAG_LABELS.map(({ field, label, color }) => (
                        <button
                          key={field}
                          onClick={() => saveFlag(row.id, field, !row[field])}
                          className={`text-xs px-1.5 py-0.5 rounded border transition-opacity ${row[field] ? color : "bg-white text-gray-300 border-gray-200 opacity-60"}`}
                          title={field}
                        >
                          {label}
                        </button>
                      ))}
                    </div>

                    {/* Delete */}
                    {confirmDeleteId === row.id ? (
                      <div className="flex items-center gap-1 ml-1">
                        <button
                          onClick={() => deleteStageMut.mutate({ id: row.id })}
                          disabled={deleteStageMut.isPending}
                          className="text-xs bg-red-500 text-white px-2 py-0.5 rounded hover:bg-red-600 disabled:opacity-50"
                        >
                          Excluir
                        </button>
                        <button onClick={() => setConfirmDeleteId(null)} className="text-xs text-gray-400 hover:text-gray-600">✕</button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setConfirmDeleteId(row.id)}
                        className="text-gray-200 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity ml-1 text-sm"
                      >
                        ✕
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Add stage */}
            <div className="mt-4 border border-dashed border-gray-200 rounded-xl p-3 bg-gray-50">
              <p className="text-xs font-medium text-gray-500 mb-2">Nova etapa</p>
              <div className="flex gap-2 flex-wrap">
                <input
                  placeholder="Nome da etapa"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && addStage()}
                  className="flex-1 min-w-32 border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
                />
                <input
                  placeholder="chave_unica (opcional)"
                  value={newChave}
                  onChange={(e) => setNewChave(e.target.value)}
                  className="flex-1 min-w-28 border border-gray-200 rounded-lg px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-400"
                />
                {/* color picker */}
                <div className="flex gap-1 items-center">
                  {STAGE_COLORS.slice(0, 5).map((c) => (
                    <button
                      key={c}
                      className={`w-5 h-5 rounded-full border-2 transition-transform hover:scale-110 ${newCor === c ? "border-gray-600 scale-110" : "border-white shadow"}`}
                      style={{ backgroundColor: c }}
                      onClick={() => setNewCor(c)}
                    />
                  ))}
                </div>
                <button
                  onClick={addStage}
                  disabled={!newName.trim() || createStageMut.isPending}
                  className="px-4 py-1.5 bg-indigo-600 text-white text-sm rounded-lg hover:bg-indigo-700 disabled:opacity-40"
                >
                  {createStageMut.isPending ? "..." : "+ Adicionar"}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Página principal ──────────────────────────────────────────────────────────

const PIPELINE_STORAGE_KEY = "avoce_crm_pipeline";

export default function CrmPage() {
  const navigate = useNavigate();
  const [activePipelineId, setActivePipelineId] = useState<string | null>(
    () => localStorage.getItem(PIPELINE_STORAGE_KEY),
  );
  const [activeDeal, setActiveDeal] = useState<Deal | null>(null);
  const [newDealStageId, setNewDealStageId] = useState<string | null>(null);
  const [draggingDeal, setDraggingDeal] = useState<Deal | null>(null);
  const [confirmDeletePipeline, setConfirmDeletePipeline] = useState<string | null>(null);
  const [managingPipelineId, setManagingPipelineId] = useState<string | null>(null);
  const [showCreatePipeline, setShowCreatePipeline] = useState(false);
  const [newPipelineName, setNewPipelineName] = useState("");
  const [newPipelineTipo, setNewPipelineTipo] = useState<"comercial" | "processual">("comercial");
  const [busca, setBusca] = useState("");
  const [filterTagIds, setFilterTagIds] = useState<string[]>([]);
  const [showTagManager, setShowTagManager] = useState(false);
  const [newTagName, setNewTagName] = useState("");
  const [newTagCor, setNewTagCor] = useState("#6366f1");
  const [editingTag, setEditingTag] = useState<{ id: string; nome: string; cor: string } | null>(null);

  // Otimismo local de drag-and-drop
  const [localStages, setLocalStages] = useState<Stage[] | null>(null);

  const utils = trpc.useUtils();

  const { data: pipelines, isLoading: loadingPipelines } =
    trpc.crm.listPipelines.useQuery();

  const seedMut = trpc.crm.seedCarreteiros.useMutation({
    onSuccess: () => utils.crm.listPipelines.invalidate(),
  });
  const deletePipelineMut = trpc.crm.deletePipeline.useMutation({
    onSuccess: () => {
      setConfirmDeletePipeline(null);
      setActivePipelineId(null);
      utils.crm.listPipelines.invalidate();
    },
  });

  const createPipelineMut = trpc.crm.createPipeline.useMutation({
    onSuccess: (data) => {
      setShowCreatePipeline(false);
      setNewPipelineName("");
      setActivePipelineId(data.id);
      utils.crm.listPipelines.invalidate();
    },
  });

  // Tags do funil aberto + gerais — é isso que aparece no filtro e no gerenciador.
  const { data: allTags, refetch: refetchTags } = trpc.crm.listTags.useQuery(
    activePipelineId ? { pipelineId: activePipelineId } : undefined,
  );
  const [newTagDoFunil, setNewTagDoFunil] = useState(true);
  const createTagMut = trpc.crm.createTag.useMutation({ onSuccess: () => { refetchTags(); setNewTagName(""); } });
  const updateTagMut = trpc.crm.updateTag.useMutation({ onSuccess: () => { refetchTags(); setEditingTag(null); } });
  const deleteTagMut = trpc.crm.deleteTag.useMutation({ onSuccess: () => { refetchTags(); } });

  // Selecionar pipeline inicial automaticamente: mantém o último funil aberto e só
  // cai no primeiro se ele não existir mais.
  useEffect(() => {
    if (!pipelines || pipelines.length === 0) return;
    const existe = (pipelines as Pipeline[]).some((p) => p.id === activePipelineId);
    if (!existe) setActivePipelineId(pipelines[0].id);
  }, [pipelines, activePipelineId]);

  useEffect(() => {
    if (activePipelineId) localStorage.setItem(PIPELINE_STORAGE_KEY, activePipelineId);
  }, [activePipelineId]);

  // Filtro por tag de outro funil esvaziaria o Kanban sem motivo aparente.
  useEffect(() => {
    if (!allTags) return;
    const validas = new Set(allTags.map((t) => t.id));
    setFilterTagIds((prev) => (prev.every((id) => validas.has(id)) ? prev : prev.filter((id) => validas.has(id))));
  }, [allTags]);

  const [buscaDebounced, setBuscaDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setBuscaDebounced(busca), 400);
    return () => clearTimeout(t);
  }, [busca]);

  const { data: kanbanData, isLoading: loadingKanban } =
    trpc.crm.kanban.useQuery(
      { pipelineId: activePipelineId ?? "", busca: buscaDebounced || undefined, tagIds: filterTagIds.length > 0 ? filterTagIds : undefined },
      { enabled: !!activePipelineId, staleTime: 30_000 }
    );

  // Sincronizar stages locais
  useEffect(() => {
    if (kanbanData?.stages) setLocalStages(kanbanData.stages as unknown as Stage[]);
  }, [kanbanData]);

  const moveMut = trpc.crm.moveDeal.useMutation({
    onError: () => {
      // rollback — recarregar do servidor
      if (activePipelineId) utils.crm.kanban.invalidate({ pipelineId: activePipelineId });
    },
    onSuccess: () => {
      if (activePipelineId) utils.crm.kanban.invalidate({ pipelineId: activePipelineId });
    },
  });

  const togglePausaMut = trpc.ia.toggleIaPausa.useMutation({
    onSuccess: () => {
      if (activePipelineId) utils.crm.kanban.invalidate({ pipelineId: activePipelineId });
    },
  });

  function handleWhatsApp(deal: Deal) {
    if (!temConversa(deal)) return;
    // Direct/Messenger já é atendimento humano; só a IA do WhatsApp precisa pausar.
    if (deal.contato?.whatsapp && deal.iaAtiva !== false) {
      togglePausaMut.mutate({ dealId: deal.id, pausar: true });
    }
    navigate(`/whatsapp?dealId=${deal.id}`);
  }

  const [reuniaoToast, setReuniaoToast] = useState<{ jitsiUrl: string; linkConvidado: string; titulo: string } | null>(null);
  const criarReuniaoRapidaMut = trpc.reunioes.criarInstantanea.useMutation({
    onSuccess: (data) => {
      setReuniaoToast(data);
      setTimeout(() => setReuniaoToast(null), 15_000);
    },
  });

  function handleCriarReuniao(deal: Deal) {
    criarReuniaoRapidaMut.mutate({ dealId: deal.id });
  }

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } })
  );

  function handleDragStart({ active }: DragStartEvent) {
    const deal = active.data.current?.deal as Deal | undefined;
    if (deal) setDraggingDeal(deal);
  }

  function handleDragOver({ active, over }: DragOverEvent) {
    if (!over || !localStages) return;
    const activeId = active.id as string;
    const overId = over.id as string;

    // Encontrar onde está o card ativo e para onde está indo
    const fromStage = localStages.find((s) => s.deals.some((d) => d.id === activeId));
    const toStage = localStages.find((s) => s.id === overId || s.deals.some((d) => d.id === overId));

    if (!fromStage || !toStage || fromStage.id === toStage.id) return;

    // Mover otimisticamente
    const deal = fromStage.deals.find((d) => d.id === activeId)!;
    setLocalStages((prev) =>
      prev!.map((s) => {
        if (s.id === fromStage.id) return { ...s, deals: s.deals.filter((d) => d.id !== activeId) };
        if (s.id === toStage.id)  return { ...s, deals: [...s.deals, { ...deal, stageId: s.id }] };
        return s;
      })
    );
  }

  function handleDragEnd({ active, over }: DragEndEvent) {
    setDraggingDeal(null);
    if (!over || !localStages) return;

    const activeId = active.id as string;
    const overId = over.id as string;

    const toStage = localStages.find(
      (s) => s.id === overId || s.deals.some((d) => d.id === overId)
    );
    if (!toStage) return;

    // Verificar se realmente mudou de stage
    const rawStages = (kanbanData?.stages ?? []) as unknown as Stage[];
    const currentDeal = rawStages.flatMap((s) => s.deals).find((d) => d.id === activeId);

    if (currentDeal && currentDeal.stageId !== toStage.id) {
      moveMut.mutate({ dealId: activeId, stageId: toStage.id });
    }
  }

  const stages = localStages ?? (kanbanData?.stages as unknown as Stage[] | undefined) ?? [];

  // ── Render ──────────────────────────────────────────────────────────────────

  if (loadingPipelines) {
    return (
      <div className="flex items-center justify-center h-full text-gray-400">
        Carregando...
      </div>
    );
  }

  if (!pipelines || pipelines.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4">
        <p className="text-gray-500">Nenhum funil configurado.</p>
        <button
          onClick={() => seedMut.mutate()}
          disabled={seedMut.isPending}
          className="bg-brand-600 text-white px-5 py-2 rounded-lg hover:bg-brand-700 text-sm disabled:opacity-50"
        >
          {seedMut.isPending ? "Criando..." : "Criar funis carreteiros"}
        </button>
      </div>
    );
  }

  const managingPipeline = managingPipelineId
    ? (pipelines as Pipeline[]).find((p) => p.id === managingPipelineId)
    : null;

  return (
    <div className="flex flex-col h-full">
      {/* Modal de gerenciamento de funil */}
      {managingPipeline && (
        <PipelineManagerModal
          pipelineId={managingPipeline.id}
          pipelineName={managingPipeline.nome}
          onClose={() => {
            setManagingPipelineId(null);
            utils.crm.kanban.invalidate();
          }}
        />
      )}

      {/* Tabs de pipelines */}
      <div className="bg-white border-b border-gray-200 px-4 flex items-center gap-1 flex-shrink-0 overflow-x-auto">
        {(pipelines as Pipeline[]).map((p) => (
          <div key={p.id} className="flex items-center flex-shrink-0">
            <button
              onClick={() => { setActivePipelineId(p.id); setLocalStages(null); setConfirmDeletePipeline(null); setShowCreatePipeline(false); }}
              className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
                activePipelineId === p.id
                  ? "border-brand-600 text-brand-700"
                  : "border-transparent text-gray-500 hover:text-gray-700"
              }`}
            >
              <span
                className="inline-block w-2 h-2 rounded-full mr-2"
                style={{ backgroundColor: p.cor }}
              />
              {p.nome}
              <span className="ml-2 text-xs bg-gray-100 rounded-full px-2 py-0.5">
                {(p as any)._count?.deals ?? 0}
              </span>
            </button>
            {activePipelineId === p.id && (
              confirmDeletePipeline === p.id ? (
                <div className="flex items-center gap-1 ml-1 bg-red-50 border border-red-200 rounded-lg px-2 py-1">
                  <span className="text-xs text-red-600">Excluir funil e todos os deals?</span>
                  <button
                    onClick={() => deletePipelineMut.mutate({ id: p.id })}
                    disabled={deletePipelineMut.isPending}
                    className="text-xs bg-red-600 text-white px-2 py-0.5 rounded hover:bg-red-700 disabled:opacity-50"
                  >
                    {deletePipelineMut.isPending ? "..." : "Excluir"}
                  </button>
                  <button
                    onClick={() => setConfirmDeletePipeline(null)}
                    className="text-xs text-gray-500 hover:text-gray-700 px-1"
                  >
                    ✕
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-0.5 ml-1">
                  <button
                    onClick={() => { setManagingPipelineId(p.id); setConfirmDeletePipeline(null); }}
                    className="text-gray-300 hover:text-indigo-500 text-sm px-1 py-0.5 rounded transition-colors"
                    title="Configurar etapas"
                  >
                    ✏
                  </button>
                  <button
                    onClick={() => setConfirmDeletePipeline(p.id)}
                    className="text-gray-300 hover:text-red-400 text-xs px-1 py-0.5 rounded transition-colors"
                    title="Excluir funil"
                  >
                    🗑
                  </button>
                </div>
              )
            )}
          </div>
        ))}

        {/* Novo funil */}
        <div className="ml-2 flex-shrink-0">
          {showCreatePipeline ? (
            <div className="flex items-center gap-1.5 bg-indigo-50 border border-indigo-200 rounded-lg px-2 py-1.5 my-1">
              <input
                autoFocus
                placeholder="Nome do funil"
                value={newPipelineName}
                onChange={(e) => setNewPipelineName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && newPipelineName.trim()) createPipelineMut.mutate({ nome: newPipelineName.trim(), tipo: newPipelineTipo });
                  if (e.key === "Escape") { setShowCreatePipeline(false); setNewPipelineName(""); }
                }}
                className="text-sm border border-indigo-300 rounded px-2 py-0.5 w-36 focus:outline-none focus:ring-1 focus:ring-indigo-400"
              />
              <select
                value={newPipelineTipo}
                onChange={(e) => setNewPipelineTipo(e.target.value as "comercial" | "processual")}
                className="text-xs border border-indigo-300 rounded px-1 py-0.5 focus:outline-none"
              >
                <option value="comercial">Comercial</option>
                <option value="processual">Processual</option>
              </select>
              <button
                onClick={() => newPipelineName.trim() && createPipelineMut.mutate({ nome: newPipelineName.trim(), tipo: newPipelineTipo })}
                disabled={!newPipelineName.trim() || createPipelineMut.isPending}
                className="text-xs bg-indigo-600 text-white px-2 py-0.5 rounded hover:bg-indigo-700 disabled:opacity-50"
              >
                {createPipelineMut.isPending ? "..." : "Criar"}
              </button>
              <button onClick={() => { setShowCreatePipeline(false); setNewPipelineName(""); }} className="text-gray-400 hover:text-gray-600 text-xs px-1">✕</button>
            </div>
          ) : (
            <button
              onClick={() => setShowCreatePipeline(true)}
              className="text-gray-400 hover:text-indigo-600 text-sm px-2 py-1 rounded transition-colors"
              title="Novo funil"
            >
              + funil
            </button>
          )}
        </div>
      </div>

      {/* Motores de coleta que alimentam este funil */}
      <MotorColeta pipelineId={activePipelineId ?? ""} />

      {/* Busca */}
      <div className="bg-white border-b border-gray-100 px-4 py-2 flex-shrink-0">
        <input
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
          placeholder="Buscar deal, contato ou WhatsApp..."
          className="w-full max-w-sm border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400"
        />
        {busca && (
          <button
            onClick={() => setBusca("")}
            className="ml-2 text-xs text-gray-400 hover:text-gray-600"
          >
            ✕ limpar
          </button>
        )}

        {/* Tag filters */}
        {allTags && allTags.length > 0 && (
          <div className="flex items-center gap-1.5 flex-wrap mt-2">
            <span className="text-xs text-gray-400 font-medium">Tags:</span>
            {allTags.map((tag: any) => {
              const active = filterTagIds.includes(tag.id);
              return (
                <button
                  key={tag.id}
                  onClick={() => setFilterTagIds(prev => active ? prev.filter(id => id !== tag.id) : [...prev, tag.id])}
                  className={`inline-flex items-center text-xs font-medium px-2 py-0.5 rounded-full border transition-all ${active ? "text-white border-transparent" : "bg-white border-gray-200 text-gray-600 hover:border-gray-400"}`}
                  style={active ? { backgroundColor: tag.cor, borderColor: tag.cor } : {}}
                >
                  {tag.nome}
                </button>
              );
            })}
            {filterTagIds.length > 0 && (
              <button onClick={() => setFilterTagIds([])} className="text-xs text-gray-400 hover:text-gray-600 underline">limpar</button>
            )}
            <button onClick={() => setShowTagManager(v => !v)} className="text-gray-300 hover:text-indigo-500 text-sm ml-1" title="Gerenciar tags">🏷</button>
          </div>
        )}
        {allTags && allTags.length === 0 && (
          <div className="mt-2">
            <button onClick={() => setShowTagManager(v => !v)} className="text-xs text-gray-400 hover:text-indigo-500 flex items-center gap-1">🏷 Criar tags</button>
          </div>
        )}

        {/* Tag manager panel */}
        {showTagManager && (
          <div className="mt-2 p-3 bg-white border border-gray-200 rounded-xl shadow-sm">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold text-gray-700">Gerenciar Tags</span>
              <button onClick={() => setShowTagManager(false)} className="text-gray-400 hover:text-gray-600 text-sm">✕</button>
            </div>
            <div className="space-y-1.5 mb-3">
              {allTags?.map((tag: any) => (
                <div key={tag.id} className="flex items-center gap-2">
                  {editingTag && editingTag.id === tag.id ? (
                    <>
                      <input value={editingTag.nome} onChange={e => setEditingTag(t => t ? { ...t, nome: e.target.value } : t)}
                        className="flex-1 border border-gray-200 rounded px-2 py-0.5 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-400" />
                      <input type="color" value={editingTag.cor} onChange={e => setEditingTag(t => t ? { ...t, cor: e.target.value } : t)}
                        className="w-6 h-6 rounded cursor-pointer border-0" />
                      <button onClick={() => updateTagMut.mutate({ id: editingTag.id, nome: editingTag.nome, cor: editingTag.cor })}
                        className="text-xs text-indigo-600 hover:text-indigo-800 font-medium">OK</button>
                      <button onClick={() => setEditingTag(null)} className="text-xs text-gray-400 hover:text-gray-600">✕</button>
                    </>
                  ) : (
                    <>
                      <span className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: tag.cor }} />
                      <span className="flex-1 text-xs text-gray-700">{tag.nome}</span>
                      <span className={`text-[10px] ${tag.pipelineId ? "text-indigo-400" : "text-gray-400"}`}>
                        {tag.pipelineId ? "deste funil" : "geral"}
                      </span>
                      <button onClick={() => setEditingTag(tag)} className="text-xs text-gray-400 hover:text-indigo-500">✏</button>
                      <button onClick={() => deleteTagMut.mutate({ id: tag.id })} className="text-xs text-gray-400 hover:text-red-500">🗑</button>
                    </>
                  )}
                </div>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <input value={newTagName} onChange={e => setNewTagName(e.target.value)} placeholder="Nova tag..."
                className="flex-1 border border-gray-200 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-400"
                onKeyDown={e => { if (e.key === "Enter" && newTagName.trim()) createTagMut.mutate({ nome: newTagName.trim(), cor: newTagCor, pipelineId: newTagDoFunil ? activePipelineId : null }); }} />
              <input type="color" value={newTagCor} onChange={e => setNewTagCor(e.target.value)}
                className="w-7 h-7 rounded cursor-pointer border border-gray-200" />
              <button
                onClick={() => newTagName.trim() && createTagMut.mutate({ nome: newTagName.trim(), cor: newTagCor, pipelineId: newTagDoFunil ? activePipelineId : null })}
                className="text-xs bg-indigo-600 text-white px-2 py-1 rounded hover:bg-indigo-700 disabled:opacity-40"
                disabled={!newTagName.trim()}
              >+ Criar</button>
            </div>
            <label className="flex items-center gap-1.5 mt-2 text-[11px] text-gray-500">
              <input type="checkbox" checked={newTagDoFunil} onChange={e => setNewTagDoFunil(e.target.checked)} className="accent-indigo-600" />
              Só deste funil (desmarque para tag geral, usada em todos)
            </label>
          </div>
        )}
      </div>

      {/* Kanban */}
      <div className="flex-1 overflow-hidden p-4">
        {loadingKanban ? (
          <div className="flex items-center justify-center h-full text-gray-400">
            Carregando funil...
          </div>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCorners}
            onDragStart={handleDragStart}
            onDragOver={handleDragOver}
            onDragEnd={handleDragEnd}
          >
            <div className="flex gap-3 h-full overflow-x-auto pb-2">
              <SortableContext items={stages.map((s) => s.id)}>
                {stages.map((stage) => (
                  <KanbanColumn
                    key={stage.id}
                    stage={stage}
                    onOpenDeal={setActiveDeal}
                    onAddDeal={(sid) => setNewDealStageId(sid)}
                    onWhatsApp={handleWhatsApp}
                    onCriarReuniao={handleCriarReuniao}
                  />
                ))}
              </SortableContext>
            </div>

            <DragOverlay>
              {draggingDeal && (
                <DealCard deal={draggingDeal} onOpen={() => {}} overlay />
              )}
            </DragOverlay>
          </DndContext>
        )}
      </div>

      {/* Modal editar deal */}
      {activeDeal && (
        <DealModal
          deal={activeDeal}
          stages={stages}
          pipelineId={activePipelineId ?? ""}
          onClose={() => setActiveDeal(null)}
          onSaved={() => setActiveDeal(null)}
        />
      )}

      {/* Modal novo deal */}
      {newDealStageId && (
        <DealModal
          deal={null}
          stages={stages}
          pipelineId={activePipelineId ?? ""}
          onClose={() => setNewDealStageId(null)}
          onSaved={() => setNewDealStageId(null)}
        />
      )}

      {/* Toast reunião criada */}
      {(reuniaoToast || criarReuniaoRapidaMut.isPending) && (
        <div className="fixed bottom-6 right-6 z-50 bg-white border border-purple-200 rounded-2xl shadow-2xl p-4 w-80 space-y-3">
          {criarReuniaoRapidaMut.isPending ? (
            <p className="text-sm font-semibold text-purple-700">Criando videochamada...</p>
          ) : reuniaoToast && (
            <>
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold text-purple-700">📹 Reunião criada!</p>
                <button onClick={() => setReuniaoToast(null)} className="text-gray-400 hover:text-gray-600 text-lg leading-none">×</button>
              </div>
              <p className="text-xs text-gray-500 truncate">{reuniaoToast.titulo}</p>
              <p className="text-xs text-green-600">Link enviado por WhatsApp</p>
              <div className="flex gap-2">
                <a
                  href={reuniaoToast.jitsiUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="flex-1 text-center text-xs bg-purple-600 text-white px-3 py-2 rounded-lg hover:bg-purple-700"
                >
                  Entrar na sala
                </a>
                <button
                  onClick={() => { navigator.clipboard.writeText(reuniaoToast!.linkConvidado); }}
                  className="flex-1 text-xs border border-purple-300 text-purple-700 px-3 py-2 rounded-lg hover:bg-purple-50"
                >
                  Copiar link
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
