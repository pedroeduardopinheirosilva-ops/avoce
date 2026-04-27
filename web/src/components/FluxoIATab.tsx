import { useState, useMemo } from "react";
import { trpc } from "../lib/trpc";

// ─── FASE CONFIG ──────────────────────────────────────────────────────────────
const FASE_ORDER = ["pre_vinculos", "vinculos_loop", "advogado", "pos_vinculos", "pos_vinculos_curto", "marketing"];

const FASE_META: Record<string, { label: string; desc: string; color: string; border: string; bg: string; badge: string }> = {
  pre_vinculos:       { label: "Pré-Vínculos",        desc: "triagem inicial",               color: "text-indigo-600",  border: "border-indigo-400",  bg: "bg-indigo-50",  badge: "bg-indigo-100 text-indigo-700" },
  vinculos_loop:      { label: "Coleta de Vínculos",   desc: "loop de empregos",              color: "text-purple-600",  border: "border-purple-400",  bg: "bg-purple-50",  badge: "bg-purple-100 text-purple-700" },
  advogado:           { label: "Fluxo Daniela",        desc: "qualificação e fechamento",     color: "text-pink-600",    border: "border-pink-400",    bg: "bg-pink-50",    badge: "bg-pink-100 text-pink-700" },
  pos_vinculos:       { label: "Pós-Vínculos Longo",   desc: "tempo de serviço > 18m",        color: "text-emerald-600", border: "border-emerald-400", bg: "bg-emerald-50", badge: "bg-emerald-100 text-emerald-700" },
  pos_vinculos_curto: { label: "Pós-Vínculos Curto",   desc: "tempo de serviço ≤ 18m",        color: "text-teal-600",    border: "border-teal-400",    bg: "bg-teal-50",    badge: "bg-teal-100 text-teal-700" },
  marketing:          { label: "Marketing",            desc: "origem do lead — não bloqueia", color: "text-rose-600",    border: "border-rose-300",    bg: "bg-rose-50",    badge: "bg-rose-100 text-rose-600" },
};

function faseMeta(fase: string) {
  return FASE_META[fase] ?? { label: fase, desc: "", color: "text-gray-600", border: "border-gray-300", bg: "bg-gray-50", badge: "bg-gray-100 text-gray-700" };
}

// ─── STEP TYPE CONFIG ─────────────────────────────────────────────────────────
const STEP_TYPE_META: Record<string, { label: string; badge: string }> = {
  saudacao: { label: "Saudação",     badge: "bg-orange-100 text-orange-700" },
  question: { label: "Pergunta",     badge: "bg-gray-100 text-gray-600" },
  gate:     { label: "Decisão",      badge: "bg-amber-100 text-amber-700" },
  document: { label: "Documento",    badge: "bg-teal-100 text-teal-700" },
  end:      { label: "Encerramento", badge: "bg-green-100 text-green-700" },
  notify:        { label: "Notificação",  badge: "bg-blue-100 text-blue-700" },
  llm_generated: { label: "Gerado por IA", badge: "bg-violet-100 text-violet-700" },
};

const ACTION_META: Record<string, { label: string; badge: string }> = {
  continue:   { label: "Continua",        badge: "bg-green-100 text-green-700" },
  repeat:     { label: "Repete",          badge: "bg-amber-100 text-amber-700" },
  end:        { label: "Encerra",         badge: "bg-red-100 text-red-600" },
  goto_agent: { label: "Muda fase",       badge: "bg-purple-100 text-purple-700" },
  goto_step:  { label: "Pula etapa",      badge: "bg-indigo-100 text-indigo-700" },
  notify:     { label: "Notifica equipe", badge: "bg-blue-100 text-blue-700" },
  wait:       { label: "Aguarda",         badge: "bg-gray-100 text-gray-600" },
  discard:    { label: "Ignora e segue",  badge: "bg-gray-100 text-gray-600" },
};

// ─── TYPES ────────────────────────────────────────────────────────────────────
type Persona = { id: string; chave: string; nomeExibicao: string; cor?: string | null; ativo?: boolean };
type Gate    = { id: string; condicao: string; actionType: string; actionValue?: string | null; label?: string | null; cor?: string | null; ordem: number };
type Step    = { id: string; personaChave: string; fase: string; chave: string; ordem: number; label: string; pergunta: string; stepType: string; campoColetar?: string | null; ativo: boolean; gates: Gate[] };
type NewStep = { label: string; pergunta: string; stepType: string; campoColetar: string };

function groupByFase(steps: Step[]) {
  const map = new Map<string, Step[]>();
  for (const s of steps) {
    if (!map.has(s.fase)) map.set(s.fase, []);
    map.get(s.fase)!.push(s);
  }
  for (const [, arr] of map) arr.sort((a, b) => a.ordem - b.ordem);
  const result: { fase: string; steps: Step[] }[] = [];
  for (const f of FASE_ORDER) if (map.has(f)) result.push({ fase: f, steps: map.get(f)! });
  for (const [f, arr] of map) if (!FASE_ORDER.includes(f)) result.push({ fase: f, steps: arr });
  return result;
}

function blankNew(): NewStep { return { label: "", pergunta: "", stepType: "question", campoColetar: "" }; }

// ─── GATE ROW ─────────────────────────────────────────────────────────────────
function GateRow({ gate, projetoId, onMutated }: { gate: Gate; projetoId: string; onMutated: () => void }) {
  const del = trpc.ia.deleteFlowGate.useMutation({ onSuccess: onMutated });
  const m   = ACTION_META[gate.actionType] ?? { label: gate.actionType, badge: "bg-gray-100 text-gray-600" };
  return (
    <div className="flex items-center gap-2 text-xs bg-white border rounded-lg px-3 py-2">
      <span className="flex-1 text-gray-600">{gate.condicao || "—"}</span>
      <span className={`px-1.5 py-0.5 rounded font-medium ${m.badge}`}>{gate.label ?? m.label}</span>
      {gate.actionValue && <span className="text-gray-400 font-mono max-w-[120px] truncate">{gate.actionValue}</span>}
      <button onClick={() => del.mutate({ id: gate.id, projetoId })} className="text-red-400 hover:text-red-600 ml-1">✕</button>
    </div>
  );
}

// ─── ADD GATE FORM ────────────────────────────────────────────────────────────
function AddGateForm({ stepId, projetoId, allSteps, gateCount, onDone }: {
  stepId: string; projetoId: string; allSteps: Step[]; gateCount: number; onDone: () => void;
}) {
  const [form, setForm] = useState({ condicao: "", actionType: "continue", label: "", actionValue: "" });
  const mut = trpc.ia.upsertFlowGate.useMutation({ onSuccess: () => { onDone(); } });
  const needsTarget = form.actionType === "goto_step" || form.actionType === "goto_agent";

  return (
    <div className="mt-2 border border-dashed border-gray-200 rounded-lg p-3 space-y-2 bg-gray-50">
      <p className="text-xs font-medium text-gray-500">Nova condição / gate</p>
      <input
        value={form.condicao}
        onChange={e => setForm(p => ({ ...p, condicao: e.target.value }))}
        placeholder="Condição (ex: Cliente recusa o processo)"
        className="w-full border rounded-md px-2.5 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-300"
      />
      <div className="flex gap-2">
        <select
          value={form.actionType}
          onChange={e => setForm(p => ({ ...p, actionType: e.target.value, actionValue: "" }))}
          className="flex-1 border rounded-md px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-300"
        >
          {Object.entries(ACTION_META).map(([v, m]) => <option key={v} value={v}>{m.label}</option>)}
        </select>
        <input
          value={form.label}
          onChange={e => setForm(p => ({ ...p, label: e.target.value }))}
          placeholder="Label (opcional)"
          className="flex-1 border rounded-md px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-300"
        />
      </div>
      {needsTarget && (
        form.actionType === "goto_step" ? (
          <select
            value={form.actionValue}
            onChange={e => setForm(p => ({ ...p, actionValue: e.target.value }))}
            className="w-full border rounded-md px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-300"
          >
            <option value="">— Selecione a etapa destino —</option>
            {[...allSteps].sort((a, b) => a.ordem - b.ordem).map(s => (
              <option key={s.id} value={s.chave}>{s.ordem}. {s.label} ({s.chave})</option>
            ))}
          </select>
        ) : (
          <input
            value={form.actionValue}
            onChange={e => setForm(p => ({ ...p, actionValue: e.target.value }))}
            placeholder="Fase destino (ex: pos_vinculos, pos_vinculos_curto)"
            className="w-full border rounded-md px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-300"
          />
        )
      )}
      {form.actionType === "end" && (
        <textarea
          value={form.actionValue}
          onChange={e => setForm(p => ({ ...p, actionValue: e.target.value }))}
          placeholder="Mensagem de encerramento (opcional)"
          rows={2}
          className="w-full border border-red-200 rounded-md px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-red-200 resize-none"
        />
      )}
      <div className="flex gap-2">
        <button onClick={onDone} className="flex-1 text-xs border rounded-md py-1.5 text-gray-500 hover:bg-gray-100">Cancelar</button>
        <button
          onClick={() => mut.mutate({ stepId, projetoId, condicao: form.condicao, actionType: form.actionType, actionValue: form.actionValue || null, label: form.label || null, cor: null, ordem: gateCount })}
          disabled={!form.condicao.trim()}
          className="flex-2 text-xs bg-indigo-600 text-white rounded-md py-1.5 px-4 hover:bg-indigo-700 disabled:opacity-40"
        >Adicionar</button>
      </div>
    </div>
  );
}

// ─── STEP CARD (FLOW VIEW) ────────────────────────────────────────────────────
function StepCard({ step, fase, isSelected, onSelect, editMode, onEditLabel, onEditPergunta, projetoId, onMutated, allSteps }: {
  step: Step; fase: string; isSelected: boolean; onSelect: () => void;
  editMode: boolean; onEditLabel: (v: string) => void; onEditPergunta: (v: string) => void;
  projetoId: string; onMutated: () => void; allSteps: Step[];
}) {
  const [addingGate, setAddingGate] = useState(false);
  const fm = faseMeta(fase);
  const tm = STEP_TYPE_META[step.stepType] ?? { label: step.stepType, badge: "bg-gray-100 text-gray-600" };
  const isEnd = step.stepType === "end";

  return (
    <div className="relative mb-2">
      <div
        onClick={onSelect}
        className={`border rounded-xl overflow-hidden cursor-pointer transition-shadow ${isSelected ? "shadow-md border-indigo-300" : "border-gray-200 hover:border-gray-300"}`}
      >
        {/* Header row */}
        <div className="flex items-start gap-3 px-4 py-3">
          <div className={`w-7 h-7 rounded-lg flex items-center justify-center text-xs font-bold flex-shrink-0 ${fm.badge}`}>
            {step.ordem}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap mb-1">
              <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${tm.badge}`}>{tm.label}</span>
              {editMode && isSelected ? (
                <input
                  value={step.label}
                  onChange={e => onEditLabel(e.target.value)}
                  onClick={e => e.stopPropagation()}
                  className="text-sm font-semibold text-gray-800 border-b border-indigo-300 bg-transparent focus:outline-none"
                />
              ) : (
                <span className="text-sm font-semibold text-gray-800">{step.label}</span>
              )}
              {step.campoColetar && (
                <code className="text-xs text-indigo-500 bg-indigo-50 px-1 rounded">→ {step.campoColetar}</code>
              )}
              {!step.ativo && <span className="text-xs text-red-400">inativo</span>}
            </div>
            {editMode && isSelected ? (
              <textarea
                value={step.pergunta}
                onChange={e => onEditPergunta(e.target.value)}
                onClick={e => e.stopPropagation()}
                rows={3}
                className="w-full border rounded-lg px-2 py-1.5 text-xs text-gray-600 focus:outline-none focus:ring-1 focus:ring-indigo-300 resize-y"
              />
            ) : (
              <p className={`text-xs text-gray-500 italic leading-relaxed ${isSelected ? "" : "truncate"}`}>
                "{step.pergunta}"
              </p>
            )}
          </div>
          <span className="text-gray-300 text-xs flex-shrink-0 mt-1">{isSelected ? "▲" : "▼"}</span>
        </div>

        {/* Gates — shown when expanded */}
        {isSelected && (
          <div className="border-t border-gray-100 bg-gray-50 px-4 py-3 space-y-2" onClick={e => e.stopPropagation()}>
            <p className="text-xs font-medium text-gray-400 uppercase tracking-wide">Condições / Gates</p>
            {[...step.gates].sort((a, b) => a.ordem - b.ordem).map(g => (
              <GateRow key={g.id} gate={g} projetoId={projetoId} onMutated={onMutated} />
            ))}
            {step.gates.length === 0 && (
              <p className="text-xs text-gray-400 italic">Sem gates — avança automaticamente para a próxima etapa</p>
            )}
            {addingGate ? (
              <AddGateForm stepId={step.id} projetoId={projetoId} allSteps={allSteps} gateCount={step.gates.length} onDone={() => { setAddingGate(false); onMutated(); }} />
            ) : (
              <button onClick={() => setAddingGate(true)} className="w-full text-xs border border-dashed border-gray-300 rounded-lg py-1.5 text-gray-400 hover:text-indigo-600 hover:border-indigo-300 transition-colors">
                + Adicionar gate / condição
              </button>
            )}
          </div>
        )}
      </div>

      {/* Connector line */}
      {!isEnd && (
        <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-px h-2 bg-gray-200" style={{ bottom: -8 }} />
      )}
    </div>
  );
}

// ─── FLOW TAB ─────────────────────────────────────────────────────────────────
function FlowTab({ steps, projetoId, onMutated }: { steps: Step[]; projetoId: string; onMutated: () => void }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editMode, setEditMode]     = useState(false);
  const [drafts, setDrafts]         = useState<Record<string, Partial<Step>>>({});
  const [saving, setSaving]         = useState(false);
  const upsert = trpc.ia.upsertFlowStep.useMutation({ onSuccess: () => { onMutated(); setSaving(false); setEditMode(false); setDrafts({}); } });

  const groups  = useMemo(() => groupByFase(steps), [steps]);
  const allFlat = useMemo(() => [...steps].sort((a, b) => a.ordem - b.ordem), [steps]);

  function getStep(s: Step): Step { const d = drafts[s.id]; return d ? { ...s, ...d } : s; }

  async function handleSave() {
    setSaving(true);
    for (const [id, ch] of Object.entries(drafts)) {
      const o = steps.find(x => x.id === id);
      if (!o) continue;
      await upsert.mutateAsync({ id, projetoId, personaChave: o.personaChave, fase: o.fase, chave: o.chave, ordem: o.ordem, label: ch.label ?? o.label, pergunta: ch.pergunta ?? o.pergunta, stepType: o.stepType, campoColetar: o.campoColetar ?? null, ativo: o.ativo });
    }
  }

  const hasDrafts = Object.keys(drafts).length > 0;

  return (
    <div>
      {/* Toolbar */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex gap-4 text-xs text-gray-500">
          <span><strong className="text-gray-700">{steps.length}</strong> etapas</span>
          <span><strong className="text-amber-600">{steps.filter(s => s.stepType === "gate").length}</strong> decisões</span>
          <span><strong className="text-emerald-600">{steps.filter(s => s.stepType === "question").length}</strong> perguntas</span>
          <span><strong className="text-gray-700">{groups.length}</strong> fluxos</span>
        </div>
        <div className="flex gap-2">
          {editMode ? (
            <>
              <button onClick={() => { setEditMode(false); setDrafts({}); }} className="text-xs px-3 py-1.5 border rounded-lg text-gray-500 hover:bg-gray-50">Cancelar</button>
              <button onClick={handleSave} disabled={saving || !hasDrafts} className="text-xs px-3 py-1.5 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-40">
                {saving ? "Salvando…" : "Salvar"}
              </button>
            </>
          ) : (
            <button onClick={() => setEditMode(true)} className="text-xs px-3 py-1.5 border border-indigo-200 text-indigo-600 rounded-lg hover:bg-indigo-50">✎ Editar textos</button>
          )}
        </div>
      </div>

      {/* Grouped flow */}
      {groups.map(({ fase, steps: faseSteps }) => {
        const fm = faseMeta(fase);
        return (
          <div key={fase} className="mb-8">
            {/* Phase header */}
            <div className={`flex items-center gap-3 mb-3 pb-2 border-b-2 ${fm.border}`}>
              <div>
                <span className={`text-sm font-semibold ${fm.color}`}>{fm.label}</span>
                {fm.desc && <span className="text-xs text-gray-400 ml-2">— {fm.desc}</span>}
              </div>
              <span className={`ml-auto text-xs px-2 py-0.5 rounded-full ${fm.badge}`}>{faseSteps.length} etapas</span>
            </div>

            <div className={`text-xs text-center font-medium mb-3 ${fm.color}`}>▼ INÍCIO</div>

            {faseSteps.map(orig => {
              const step = getStep(orig);
              return (
                <StepCard
                  key={step.id}
                  step={step}
                  fase={fase}
                  isSelected={selectedId === step.id}
                  onSelect={() => setSelectedId(selectedId === step.id ? null : step.id)}
                  editMode={editMode}
                  onEditLabel={v => setDrafts(p => ({ ...p, [orig.id]: { ...p[orig.id], label: v } }))}
                  onEditPergunta={v => setDrafts(p => ({ ...p, [orig.id]: { ...p[orig.id], pergunta: v } }))}
                  projetoId={projetoId}
                  onMutated={onMutated}
                  allSteps={allFlat}
                />
              );
            })}

            <div className={`text-xs text-center py-2 rounded-lg border ${fm.bg} ${fm.border} ${fm.color} font-medium`}>
              ✓ Fim — {fm.label}
            </div>
          </div>
        );
      })}

      {editMode && (
        <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mt-2">
          Modo edição: clique em uma etapa para editar label e texto. Use a aba <strong>Configurar</strong> para reordenar ou criar etapas.
        </p>
      )}
    </div>
  );
}

// ─── CONFIG TAB ───────────────────────────────────────────────────────────────
function ConfigTab({ steps, projetoId, personaChave, onMutated }: {
  steps: Step[]; projetoId: string; personaChave: string; onMutated: () => void;
}) {
  const groups = useMemo(() => groupByFase(steps), [steps]);

  const [drafts, setDrafts]     = useState<Record<string, Partial<Step>>>({});
  const [saving, setSaving]     = useState(false);
  const [saved, setSaved]       = useState(false);
  const [addingIn, setAddingIn] = useState<string | null>(null);
  const [newDraft, setNewDraft] = useState<NewStep>(blankNew());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const upsert   = trpc.ia.upsertFlowStep.useMutation({ onSuccess: () => { onMutated(); setSaving(false); setSaved(true); setTimeout(() => setSaved(false), 2500); setDrafts({}); } });
  const del      = trpc.ia.deleteFlowStep.useMutation({ onSuccess: onMutated });
  const reorder  = trpc.ia.reorderFlowSteps.useMutation({ onSuccess: onMutated });

  function getStep(s: Step): Step { const d = drafts[s.id]; return d ? { ...s, ...d } : s; }

  async function handleSave() {
    setSaving(true);
    for (const [id, ch] of Object.entries(drafts)) {
      const o = steps.find(x => x.id === id);
      if (!o) continue;
      await upsert.mutateAsync({ id, projetoId, personaChave: o.personaChave, fase: o.fase, chave: o.chave, ordem: ch.ordem ?? o.ordem, label: ch.label ?? o.label, pergunta: ch.pergunta ?? o.pergunta, stepType: ch.stepType ?? o.stepType, campoColetar: ch.campoColetar !== undefined ? ch.campoColetar : (o.campoColetar ?? null), ativo: o.ativo });
    }
  }

  function move(fase: string, id: string, dir: -1 | 1) {
    const arr = groups.find(g => g.fase === fase)?.steps ?? [];
    const i   = arr.findIndex(s => s.id === id);
    const j   = i + dir;
    if (i < 0 || j < 0 || j >= arr.length) return;
    reorder.mutate({ projetoId, items: [{ id: arr[i].id, ordem: arr[j].ordem }, { id: arr[j].id, ordem: arr[i].ordem }] });
  }

  function addStep(fase: string) {
    if (!newDraft.label.trim() || !newDraft.pergunta.trim()) return;
    const arr = groups.find(g => g.fase === fase)?.steps ?? [];
    const max = arr.length ? Math.max(...arr.map(s => s.ordem)) : 0;
    const chave = `s${Date.now().toString(36)}`;
    upsert.mutate({ projetoId, personaChave, fase, chave, ordem: max + 1, label: newDraft.label.trim(), pergunta: newDraft.pergunta.trim(), stepType: newDraft.stepType, campoColetar: newDraft.campoColetar.trim() || null, ativo: true },
      { onSuccess: () => { setAddingIn(null); setNewDraft(blankNew()); onMutated(); } }
    );
  }

  const hasDrafts = Object.keys(drafts).length > 0;

  return (
    <div className="space-y-4">
      {groups.map(({ fase, steps: faseSteps }) => {
        const fm          = faseMeta(fase);
        const isCollapsed = collapsed.has(fase);

        return (
          <div key={fase} className={`border rounded-xl overflow-hidden ${fm.border} border-l-4`}>
            {/* Fase header */}
            <button
              onClick={() => setCollapsed(p => { const n = new Set(p); n.has(fase) ? n.delete(fase) : n.add(fase); return n; })}
              className={`w-full flex items-center gap-3 px-4 py-3 text-left ${fm.bg} hover:brightness-95 transition-all`}
            >
              <span className={`text-sm font-semibold ${fm.color}`}>{fm.label}</span>
              {fm.desc && <span className="text-xs text-gray-500">— {fm.desc}</span>}
              <span className={`ml-auto text-xs px-2 py-0.5 rounded-full ${fm.badge}`}>{faseSteps.length} etapas</span>
              <span className="text-gray-400 text-xs ml-1">{isCollapsed ? "▶" : "▼"}</span>
            </button>

            {!isCollapsed && (
              <div className="divide-y divide-gray-100">
                {faseSteps.map((orig, i) => {
                  const step    = getStep(orig);
                  const tm      = STEP_TYPE_META[step.stepType] ?? { label: step.stepType, badge: "bg-gray-100 text-gray-600" };
                  const isFirst = i === 0;
                  const isLast  = i === faseSteps.length - 1;

                  return (
                    <div key={orig.id} className="px-4 py-3">
                      <div className="flex gap-3 items-start">
                        {/* Order + arrows */}
                        <div className="flex flex-col items-center gap-1 flex-shrink-0 pt-0.5">
                          <button
                            onClick={() => move(fase, orig.id, -1)}
                            disabled={isFirst || reorder.isPending}
                            className={`w-6 h-5 rounded text-xs border flex items-center justify-center transition-colors ${isFirst ? "border-gray-200 text-gray-300 cursor-default" : `border-gray-300 text-gray-500 hover:${fm.color} hover:border-current`}`}
                          >▲</button>
                          <div className={`w-6 h-6 rounded-md flex items-center justify-center text-xs font-bold ${fm.badge}`}>
                            {step.ordem}
                          </div>
                          <button
                            onClick={() => move(fase, orig.id, 1)}
                            disabled={isLast || reorder.isPending}
                            className={`w-6 h-5 rounded text-xs border flex items-center justify-center transition-colors ${isLast ? "border-gray-200 text-gray-300 cursor-default" : `border-gray-300 text-gray-500 hover:${fm.color} hover:border-current`}`}
                          >▼</button>
                        </div>

                        {/* Fields */}
                        <div className="flex-1 min-w-0 space-y-2">
                          <div className="flex gap-2 items-center">
                            <input
                              value={step.label}
                              onChange={e => setDrafts(p => ({ ...p, [orig.id]: { ...p[orig.id], label: e.target.value } }))}
                              className="flex-1 border rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-300"
                            />
                            <select
                              value={step.stepType}
                              onChange={e => setDrafts(p => ({ ...p, [orig.id]: { ...p[orig.id], stepType: e.target.value } }))}
                              className={`border rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-300 ${tm.badge}`}
                            >
                              {Object.entries(STEP_TYPE_META).map(([v, m]) => <option key={v} value={v}>{m.label}</option>)}
                            </select>
                            {step.stepType === "saudacao" && (
                              <span className="text-xs text-orange-600 bg-orange-50 border border-orange-200 rounded px-1.5 py-0.5">1ª msg</span>
                            )}
                          </div>
                          <textarea
                            value={step.pergunta}
                            onChange={e => setDrafts(p => ({ ...p, [orig.id]: { ...p[orig.id], pergunta: e.target.value } }))}
                            rows={2}
                            placeholder="Texto da pergunta / mensagem"
                            className="w-full border rounded-lg px-3 py-2 text-sm text-gray-600 focus:outline-none focus:ring-1 focus:ring-indigo-300 resize-y"
                          />
                          <input
                            value={step.campoColetar ?? ""}
                            onChange={e => setDrafts(p => ({ ...p, [orig.id]: { ...p[orig.id], campoColetar: e.target.value || null } }))}
                            placeholder="campoColetar (ex: nome, cidade) — vazio se não coletar dado"
                            className="w-full border rounded-lg px-3 py-1.5 text-xs text-gray-500 font-mono focus:outline-none focus:ring-1 focus:ring-indigo-300"
                          />
                        </div>

                        {/* Delete */}
                        <button
                          onClick={() => { if (confirm(`Excluir etapa "${orig.label}"?`)) del.mutate({ id: orig.id, projetoId }); }}
                          className="text-red-400 hover:text-red-600 text-lg leading-none flex-shrink-0 mt-1"
                          title="Excluir etapa"
                        >×</button>
                      </div>
                    </div>
                  );
                })}

                {/* Add step */}
                {addingIn === fase ? (
                  <div className="px-4 py-3 bg-indigo-50 border-t border-indigo-100">
                    <p className="text-xs font-semibold text-indigo-700 mb-2">Nova etapa em {faseMeta(fase).label}</p>
                    <div className="space-y-2">
                      <div className="flex gap-2">
                        <input
                          value={newDraft.label}
                          onChange={e => setNewDraft(p => ({ ...p, label: e.target.value }))}
                          placeholder="Label (ex: Confirmação de CLT)"
                          className="flex-1 border rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-300"
                        />
                        <select
                          value={newDraft.stepType}
                          onChange={e => setNewDraft(p => ({ ...p, stepType: e.target.value }))}
                          className="border rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-300"
                        >
                          {Object.entries(STEP_TYPE_META).map(([v, m]) => <option key={v} value={v}>{m.label}</option>)}
                        </select>
                      </div>
                      <textarea
                        value={newDraft.pergunta}
                        onChange={e => setNewDraft(p => ({ ...p, pergunta: e.target.value }))}
                        rows={2}
                        placeholder="Texto da pergunta que o agente vai enviar"
                        className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-300 resize-none"
                      />
                      <input
                        value={newDraft.campoColetar}
                        onChange={e => setNewDraft(p => ({ ...p, campoColetar: e.target.value }))}
                        placeholder="campoColetar (ex: cidade) — opcional"
                        className="w-full border rounded-lg px-3 py-1.5 text-xs font-mono text-gray-500 focus:outline-none focus:ring-1 focus:ring-indigo-300"
                      />
                      <div className="flex gap-2">
                        <button onClick={() => { setAddingIn(null); setNewDraft(blankNew()); }} className="flex-1 text-sm border rounded-lg py-1.5 text-gray-500 hover:bg-gray-50">Cancelar</button>
                        <button
                          onClick={() => addStep(fase)}
                          disabled={!newDraft.label.trim() || !newDraft.pergunta.trim()}
                          className="flex-2 text-sm bg-indigo-600 text-white rounded-lg py-1.5 px-5 hover:bg-indigo-700 disabled:opacity-40"
                        >+ Adicionar</button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="px-4 py-2">
                    <button
                      onClick={() => { setAddingIn(fase); setNewDraft(blankNew()); }}
                      className={`w-full text-xs border border-dashed rounded-lg py-2 transition-colors ${fm.color} border-current opacity-60 hover:opacity-100`}
                    >+ Adicionar etapa em {fm.label}</button>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}

      {/* Save bar */}
      <div className="sticky bottom-0 bg-white pt-3 pb-1 border-t border-gray-100">
        <button
          onClick={handleSave}
          disabled={saving || !hasDrafts}
          className={`w-full py-2.5 rounded-xl text-sm font-semibold transition-colors ${saved ? "bg-emerald-600 text-white" : hasDrafts ? "bg-indigo-600 hover:bg-indigo-700 text-white" : "bg-gray-100 text-gray-400 cursor-default"}`}
        >
          {saved ? "✓ Alterações salvas" : saving ? "Salvando…" : hasDrafts ? `Salvar alterações (${Object.keys(drafts).length})` : "Sem alterações pendentes"}
        </button>
        <p className="text-xs text-gray-400 text-center mt-1.5">↑↓ reordena · × exclui · + adiciona etapa ao final do fluxo</p>
      </div>
    </div>
  );
}

// ─── MAIN EXPORT ──────────────────────────────────────────────────────────────
export function FluxoIATab({ projetoId, personas }: { projetoId: string; personas: Persona[] }) {
  const activePersonas = personas.filter(p => p.ativo !== false);
  const [_sel, setSel]         = useState("");
  const [innerTab, setInnerTab] = useState<"flow" | "config">("flow");

  const selectedChave = _sel || activePersonas[0]?.chave || "";

  const flowStepsQ = trpc.ia.listFlowSteps.useQuery({ projetoId }, { enabled: !!projetoId });
  const seedMut    = trpc.ia.seedFlowSteps.useMutation({ onSuccess: () => flowStepsQ.refetch() });

  const allSteps = (flowStepsQ.data as unknown as Step[] | undefined) ?? [];

  const stepsForPersona = useMemo(
    () => allSteps.filter(s => s.personaChave === selectedChave),
    [allSteps, selectedChave],
  );

  return (
    <div className="space-y-4">
      {/* Inner tab bar */}
      <div className="flex items-center justify-between">
        <div className="flex gap-1 bg-gray-100 p-1 rounded-lg">
          {(["flow", "config"] as const).map(t => (
            <button
              key={t}
              onClick={() => setInnerTab(t)}
              className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${innerTab === t ? "bg-white shadow text-gray-800" : "text-gray-500 hover:text-gray-700"}`}
            >
              {t === "flow" ? "Visualizar fluxo" : "Configurar etapas"}
            </button>
          ))}
        </div>

        {allSteps.length > 0 && (
          <button
            onClick={() => { if (confirm("Re-popular etapas padrão? Upsert — existentes não serão apagadas.")) seedMut.mutate({ projetoId }); }}
            disabled={seedMut.isPending}
            className="text-xs text-gray-400 hover:text-gray-600 border border-gray-200 rounded-lg px-3 py-1.5 hover:bg-gray-50"
          >
            {seedMut.isPending ? "…" : "↺ Seed padrão"}
          </button>
        )}
      </div>

      {/* Persona selector */}
      <div className="flex gap-2">
        {activePersonas.map(p => {
          const active = p.chave === selectedChave;
          return (
            <button
              key={p.chave}
              onClick={() => { setSel(p.chave); setInnerTab("flow"); }}
              className={`flex-1 py-2.5 px-3 rounded-xl border text-sm font-medium transition-all ${active ? "border-indigo-300 bg-indigo-50 text-indigo-700 shadow-sm" : "border-gray-200 text-gray-500 hover:border-gray-300 hover:bg-gray-50"}`}
            >
              <div>{p.nomeExibicao}</div>
              <div className={`text-xs font-normal mt-0.5 ${active ? "text-indigo-400" : "text-gray-400"}`}>{p.chave}</div>
            </button>
          );
        })}
      </div>

      {/* Content */}
      {flowStepsQ.isLoading ? (
        <div className="text-center py-12 text-gray-400 text-sm">Carregando…</div>
      ) : stepsForPersona.length === 0 ? (
        <div className="text-center py-12 text-gray-400 text-sm">
          Nenhuma etapa configurada.{" "}
          <button onClick={() => !seedMut.isPending && seedMut.mutate({ projetoId })} className="text-indigo-600 hover:underline">
            {seedMut.isPending ? "Populando…" : "Usar seed padrão?"}
          </button>
        </div>
      ) : innerTab === "flow" ? (
        <FlowTab steps={stepsForPersona} projetoId={projetoId} onMutated={() => flowStepsQ.refetch()} />
      ) : (
        <ConfigTab steps={stepsForPersona} projetoId={projetoId} personaChave={selectedChave} onMutated={() => flowStepsQ.refetch()} />
      )}
    </div>
  );
}
