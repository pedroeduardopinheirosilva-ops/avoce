import { useState } from "react";
import { trpc } from "../lib/trpc";

type Campanha = {
  id: string;
  nome: string;
  mensagem: string;
  diasSemContato: number;
  ativa: boolean;
  totalEnviados: number;
  ultimoDisparo: string | Date | null;
  stageIds: string[];
  projeto: { id: string; nome: string } | null;
};

function Modal({
  campanha,
  onClose,
  onSaved,
}: {
  campanha: Partial<Campanha> | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { data: projetos } = trpc.ia.listProjetos.useQuery();
  const { data: pipelines } = trpc.crm.listPipelines.useQuery();
  const [pipelineId, setPipelineId] = useState<string>(campanha?.stageIds?.[0] ? "" : "");
  const { data: stages } = trpc.crm.listStages.useQuery(
    { pipelineId },
    { enabled: !!pipelineId }
  );

  const [nome, setNome] = useState(campanha?.nome ?? "");
  const [mensagem, setMensagem] = useState(campanha?.mensagem ?? "");
  const [dias, setDias] = useState(campanha?.diasSemContato ?? 7);
  const [projetoId, setProjetoId] = useState(campanha?.projeto?.id ?? "");
  const [stageIds, setStageIds] = useState<string[]>(campanha?.stageIds ?? []);

  const criar = trpc.reengajamento.criar.useMutation({ onSuccess: () => { onSaved(); onClose(); } });
  const atualizar = trpc.reengajamento.atualizar.useMutation({ onSuccess: () => { onSaved(); onClose(); } });

  const isEdit = !!campanha?.id;

  function toggleStage(id: string) {
    setStageIds(prev => prev.includes(id) ? prev.filter(s => s !== id) : [...prev, id]);
  }

  function save() {
    const data = { nome, mensagem, diasSemContato: dias, projetoId: projetoId || undefined, stageIds };
    if (isEdit) atualizar.mutate({ id: campanha!.id!, ...data });
    else criar.mutate(data);
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg space-y-4 p-6">
        <h2 className="text-lg font-semibold text-gray-900">{isEdit ? "Editar campanha" : "Nova campanha"}</h2>

        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Nome</label>
            <input value={nome} onChange={e => setNome(e.target.value)} className="w-full border rounded-lg px-3 py-2 text-sm" />
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Projeto IA (Evolution API)</label>
            <select value={projetoId} onChange={e => setProjetoId(e.target.value)} className="w-full border rounded-lg px-3 py-2 text-sm">
              <option value="">— sem projeto —</option>
              {projetos?.map(p => <option key={p.id} value={p.id}>{p.nome}</option>)}
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Pipeline</label>
            <select value={pipelineId} onChange={e => { setPipelineId(e.target.value); setStageIds([]); }} className="w-full border rounded-lg px-3 py-2 text-sm">
              <option value="">Selecione...</option>
              {pipelines?.map(p => <option key={p.id} value={p.id}>{p.nome}</option>)}
            </select>
          </div>

          {stages && stages.length > 0 && (
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Stages alvo</label>
              <div className="border rounded-lg p-2 space-y-1 max-h-36 overflow-y-auto">
                {stages.map(s => (
                  <label key={s.id} className="flex items-center gap-2 cursor-pointer hover:bg-gray-50 px-2 py-1 rounded">
                    <input type="checkbox" checked={stageIds.includes(s.id)} onChange={() => toggleStage(s.id)} className="rounded" />
                    <span className="text-sm">{s.nome}</span>
                  </label>
                ))}
              </div>
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Dias sem contato</label>
            <input type="number" min={1} value={dias} onChange={e => setDias(Number(e.target.value))} className="w-full border rounded-lg px-3 py-2 text-sm" />
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">
              Mensagem — use <code className="bg-gray-100 px-1 rounded">{"{{nome}}"}</code> para o nome do contato
            </label>
            <textarea rows={4} value={mensagem} onChange={e => setMensagem(e.target.value)} className="w-full border rounded-lg px-3 py-2 text-sm" />
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg">Cancelar</button>
          <button
            onClick={save}
            disabled={!nome || !mensagem || stageIds.length === 0 || criar.isPending || atualizar.isPending}
            className="px-4 py-2 bg-indigo-600 text-white text-sm rounded-lg hover:bg-indigo-700 disabled:opacity-50"
          >
            Salvar
          </button>
        </div>
      </div>
    </div>
  );
}

export default function Reengajamento() {
  const [modal, setModal] = useState<{ campanha: Partial<Campanha> | null } | null>(null);
  const [disparandoId, setDisparandoId] = useState<string | null>(null);
  const [dispResult, setDispResult] = useState<Record<string, { enviados: number; erros: string[] }>>({});

  const utils = trpc.useUtils();
  const { data: campanhas, isLoading } = trpc.reengajamento.listar.useQuery();

  const deletar = trpc.reengajamento.deletar.useMutation({ onSuccess: () => utils.reengajamento.listar.invalidate() });
  const toggleAtiva = trpc.reengajamento.atualizar.useMutation({ onSuccess: () => utils.reengajamento.listar.invalidate() });
  const disparar = trpc.reengajamento.disparar.useMutation({
    onSuccess: (data, vars) => {
      if ("enviados" in data) {
        setDispResult(prev => ({ ...prev, [vars.id]: { enviados: data.enviados, erros: data.erros } }));
      }
      setDisparandoId(null);
      utils.reengajamento.listar.invalidate();
    },
    onError: (e, vars) => {
      setDispResult(prev => ({ ...prev, [vars.id]: { enviados: 0, erros: [e.message] } }));
      setDisparandoId(null);
    },
  });

  function fmt(d: string | Date | null) {
    if (!d) return "—";
    return new Date(d).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Reengajamento</h1>
          <p className="text-sm text-gray-500 mt-1">Campanhas automáticas para reativar leads silenciosos via WhatsApp.</p>
        </div>
        <button
          onClick={() => setModal({ campanha: null })}
          className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700"
        >
          + Nova campanha
        </button>
      </div>

      {isLoading && <p className="text-sm text-gray-400">Carregando...</p>}

      {!isLoading && (!campanhas || campanhas.length === 0) && (
        <div className="bg-white rounded-xl border border-dashed border-gray-300 p-12 text-center">
          <p className="text-gray-400 text-sm">Nenhuma campanha criada ainda.</p>
        </div>
      )}

      <div className="space-y-3">
        {campanhas?.map(c => (
          <div key={c.id} className={`bg-white rounded-xl border p-4 space-y-3 ${c.ativa ? "border-gray-200" : "border-gray-100 opacity-60"}`}>
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className={`h-2 w-2 rounded-full flex-shrink-0 ${c.ativa ? "bg-green-500" : "bg-gray-400"}`} />
                  <p className="font-medium text-gray-900">{c.nome}</p>
                  {c.projeto && <span className="text-xs text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded-full">{c.projeto.nome}</span>}
                </div>
                <p className="text-sm text-gray-500 mt-1 line-clamp-2">{c.mensagem}</p>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <button
                  onClick={() => toggleAtiva.mutate({ id: c.id, ativa: !c.ativa })}
                  className="text-xs text-gray-500 hover:text-gray-700 px-2 py-1 border rounded"
                >
                  {c.ativa ? "Pausar" : "Ativar"}
                </button>
                <button onClick={() => setModal({ campanha: c })} className="text-xs text-indigo-600 hover:underline px-2">Editar</button>
                <button onClick={() => deletar.mutate({ id: c.id })} className="text-xs text-red-500 hover:underline px-2">Excluir</button>
              </div>
            </div>

            <div className="flex items-center gap-4 text-xs text-gray-500">
              <span>⏳ {c.diasSemContato} dias sem contato</span>
              <span>📤 {c.totalEnviados} enviados</span>
              <span>🕒 Último disparo: {fmt(c.ultimoDisparo)}</span>
            </div>

            {dispResult[c.id] && (
              <div className={`text-xs rounded-lg px-3 py-2 ${dispResult[c.id].erros.length ? "bg-red-50 text-red-700" : "bg-green-50 text-green-700"}`}>
                ✓ {dispResult[c.id].enviados} mensagens enviadas
                {dispResult[c.id].erros.length > 0 && ` | ${dispResult[c.id].erros.length} erros`}
              </div>
            )}

            <button
              onClick={() => { setDisparandoId(c.id); disparar.mutate({ id: c.id }); }}
              disabled={disparandoId === c.id}
              className="px-3 py-1.5 bg-green-600 text-white text-xs font-medium rounded-lg hover:bg-green-700 disabled:opacity-50"
            >
              {disparandoId === c.id ? "Disparando..." : "▶ Disparar agora"}
            </button>
          </div>
        ))}
      </div>

      {modal !== null && (
        <Modal
          campanha={modal.campanha}
          onClose={() => setModal(null)}
          onSaved={() => utils.reengajamento.listar.invalidate()}
        />
      )}
    </div>
  );
}
