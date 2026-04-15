import { useState, useEffect } from "react";
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

// ── Types ─────────────────────────────────────────────────────────────────────

type Stage = {
  id: string; chave: string; nome: string; cor: string;
  ehGanho: boolean; requerAcaoHumana: boolean;
  deals: Deal[];
};
type Deal = {
  id: string; titulo: string; valor: string | null; urgencia: boolean;
  status: string; stageId: string; criadoEm: string;
  valorEstimado: string | null;
  contato: { id: string; nome: string; whatsapp: string | null; cidade: string | null } | null;
};
type Pipeline = {
  id: string; nome: string; tipo: string; cor: string;
};

// ── Card draggável ─────────────────────────────────────────────────────────────

function DealCard({
  deal, onOpen, overlay = false,
}: {
  deal: Deal; onOpen: (d: Deal) => void; overlay?: boolean;
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
      <p className="text-sm font-medium text-gray-800 leading-tight mb-1">{deal.titulo}</p>
      {deal.contato && (
        <p className="text-xs text-gray-500 mb-1">
          👤 {deal.contato.nome}
          {deal.contato.cidade ? ` · ${deal.contato.cidade}` : ""}
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
      <p className="text-xs text-gray-400 mt-1">
        {new Date(deal.criadoEm).toLocaleDateString("pt-BR")}
      </p>
    </div>
  );
}

// ── Coluna do kanban ──────────────────────────────────────────────────────────

function KanbanColumn({
  stage, onOpenDeal, onAddDeal,
}: {
  stage: Stage;
  onOpenDeal: (d: Deal) => void;
  onAddDeal: (stageId: string) => void;
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
            <DealCard key={deal.id} deal={deal} onOpen={onOpenDeal} />
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

function DealModal({
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
  const isNew = !deal?.id;
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

  const [confirmDelete, setConfirmDelete] = useState(false);

  const createMut = trpc.crm.createDeal.useMutation({
    onSuccess: () => { utils.crm.kanban.invalidate(); onSaved(); },
  });
  const updateMut = trpc.crm.updateDeal.useMutation({
    onSuccess: () => { utils.crm.kanban.invalidate(); onSaved(); },
  });
  const deleteMut = trpc.crm.deleteDeal.useMutation({
    onSuccess: () => { utils.crm.kanban.invalidate(); onSaved(); },
  });
  const addNotaMut = trpc.crm.addNota.useMutation({
    onSuccess: () => { utils.crm.getDeal.invalidate(); setNotaText(""); },
  });

  const { data: dealDetail } = trpc.crm.getDeal.useQuery(
    { id: deal?.id ?? "" },
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
            {isNew ? "Novo Deal" : "Editar Deal"}
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl">×</button>
        </div>

        <div className="p-5 space-y-4">
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

          {isNew && (
            <div className="border-t pt-4">
              <p className="text-xs font-semibold text-gray-500 uppercase mb-3">Contato</p>
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
            const waLink = (num: string) => {
              const n = num.replace(/\D/g, "");
              return `https://wa.me/${n.startsWith("55") ? n : "55" + n}`;
            };
            return (
              <>
                {(wa || tel || d.contato?.empresa || d.organizacao) && (
                  <div className="border-t pt-4">
                    <p className="text-xs font-semibold text-gray-500 uppercase mb-2">Contato</p>
                    <div className="text-xs text-gray-600 space-y-1.5">
                      {d.contato?.empresa && <p>🏢 {d.contato.empresa}</p>}
                      {d.organizacao && d.organizacao !== d.contato?.empresa && <p>🏢 {d.organizacao}</p>}
                      {wa && <p>📱 {wa}{" "}<a href={waLink(wa)} target="_blank" rel="noopener noreferrer" className="text-green-600 hover:text-green-700 font-medium underline">Abrir WhatsApp ↗</a></p>}
                      {tel && <p>📞 {tel}{" "}<a href={waLink(tel)} target="_blank" rel="noopener noreferrer" className="text-green-600 hover:text-green-700 font-medium underline">Abrir WhatsApp ↗</a></p>}
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
                {d.camposCustom && Object.keys(d.camposCustom).length > 0 && (
                  <div className="border-t pt-4">
                    <p className="text-xs font-semibold text-gray-500 uppercase mb-2">Campos personalizados</p>
                    <div className="text-xs text-gray-600 space-y-1">
                      {Object.entries(d.camposCustom as Record<string, string>).map(([k, v]) => (
                        <p key={k}><span className="font-medium">{k}:</span> {v}</p>
                      ))}
                    </div>
                  </div>
                )}
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
                  <span className="text-xs text-red-600">Confirmar exclusão?</span>
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

// ── Página principal ──────────────────────────────────────────────────────────

export default function CrmPage() {
  const [activePipelineId, setActivePipelineId] = useState<string | null>(null);
  const [activeDeal, setActiveDeal] = useState<Deal | null>(null);
  const [newDealStageId, setNewDealStageId] = useState<string | null>(null);
  const [draggingDeal, setDraggingDeal] = useState<Deal | null>(null);
  const [confirmDeletePipeline, setConfirmDeletePipeline] = useState<string | null>(null);
  const [busca, setBusca] = useState("");

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

  // Selecionar pipeline inicial automaticamente
  useEffect(() => {
    if (pipelines && pipelines.length > 0 && !activePipelineId) {
      setActivePipelineId(pipelines[0].id);
    }
  }, [pipelines, activePipelineId]);

  const [buscaDebounced, setBuscaDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setBuscaDebounced(busca), 400);
    return () => clearTimeout(t);
  }, [busca]);

  const { data: kanbanData, isLoading: loadingKanban } =
    trpc.crm.kanban.useQuery(
      { pipelineId: activePipelineId ?? "", busca: buscaDebounced || undefined },
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

  return (
    <div className="flex flex-col h-full">
      {/* Tabs de pipelines */}
      <div className="bg-white border-b border-gray-200 px-4 flex items-center gap-1 flex-shrink-0">
        {(pipelines as Pipeline[]).map((p) => (
          <div key={p.id} className="flex items-center">
            <button
              onClick={() => { setActivePipelineId(p.id); setLocalStages(null); setConfirmDeletePipeline(null); }}
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
                <button
                  onClick={() => setConfirmDeletePipeline(p.id)}
                  className="ml-1 text-gray-300 hover:text-red-400 text-xs px-1 py-0.5 rounded transition-colors"
                  title="Excluir funil"
                >
                  🗑
                </button>
              )
            )}
          </div>
        ))}
      </div>

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
    </div>
  );
}
