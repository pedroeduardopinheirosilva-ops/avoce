import { useState } from "react";
import { trpc } from "../lib/trpc";
import { DisparosSegmentados } from "../components/DisparosSegmentados";
import {
  Send, RefreshCw, Edit2, Check, X, ChevronLeft, ChevronRight,
  Users, MessageSquare, CheckCircle, ArrowRight, Search, Loader2,
} from "lucide-react";

const CAMPANHA_ID = "campanha_reeng_c3_2026";
const PROJETO_ID  = "cmnvy47x3000wrmmamnsrhgj9";

const STAGE_LABELS: Record<string, { label: string; color: string }> = {
  reeng_sem_resposta: { label: "Frio / Sem Qual.",        color: "bg-gray-100 text-gray-600" },
  reeng_carreteiro:   { label: "Confirmou Carreteiro",    color: "bg-blue-100 text-blue-700" },
  reeng_qualificado:  { label: "Qualificado",             color: "bg-purple-100 text-purple-700" },
  reeng_agendamento:  { label: "Tinha Agendamento",       color: "bg-green-100 text-green-700" },
};

const DEST_LABELS: Record<string, { label: string; color: string }> = {
  lead_nao_motorista: { label: "→ Triagem",        color: "bg-slate-100 text-slate-600" },
  lead_carreteiro:    { label: "→ Carreteiro CLT", color: "bg-indigo-100 text-indigo-700" },
};

type Filtro = "todos" | "com_mensagem" | "sem_mensagem" | "enviados" | "migrados";

function EditModal({
  deal,
  onSave,
  onClose,
}: {
  deal: { id: string; nome: string; mensagem?: string };
  onSave: () => void;
  onClose: () => void;
}) {
  const [texto, setTexto] = useState(deal.mensagem ?? "");
  const edit = trpc.reengajamento.editarMensagemCampanha.useMutation({
    onSuccess: () => { onSave(); onClose(); },
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg">
        <div className="flex items-center justify-between px-5 py-4 border-b">
          <div>
            <p className="font-semibold text-gray-900">Editar mensagem</p>
            <p className="text-xs text-gray-400">{deal.nome}</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700"><X size={18} /></button>
        </div>
        <div className="p-5">
          <textarea
            value={texto}
            onChange={e => setTexto(e.target.value)}
            rows={8}
            className="w-full border border-gray-200 rounded-lg p-3 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none"
            placeholder="Mensagem personalizada..."
          />
          <p className="text-xs text-gray-400 mt-1">{texto.length} caracteres</p>
        </div>
        <div className="flex justify-end gap-2 px-5 py-3 border-t bg-gray-50 rounded-b-xl">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg">
            Cancelar
          </button>
          <button
            onClick={() => edit.mutate({ dealId: deal.id, mensagem: texto })}
            disabled={!texto.trim() || edit.isPending}
            className="px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 flex items-center gap-2"
          >
            {edit.isPending ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
            Salvar
          </button>
        </div>
      </div>
    </div>
  );
}

function StatusCard({ label, value, icon: Icon, color }: {
  label: string; value: number | string; icon: React.ElementType; color: string;
}) {
  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4 flex items-center gap-4">
      <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${color}`}>
        <Icon size={18} />
      </div>
      <div>
        <p className="text-2xl font-bold text-gray-900">{value}</p>
        <p className="text-xs text-gray-500">{label}</p>
      </div>
    </div>
  );
}

export default function CampanhaAtiva() {
  const utils = trpc.useUtils();
  const [filtro, setFiltro] = useState<Filtro>("todos");
  const [pagina, setPagina] = useState(1);
  const [busca, setBusca] = useState("");
  const [buscaInput, setBuscaInput] = useState("");
  const [editDeal, setEditDeal] = useState<{ id: string; nome: string; mensagem?: string } | null>(null);
  const [maxGerar, setMaxGerar] = useState(200);
  const [maxDisparar, setMaxDisparar] = useState(100);
  const [delayMs, setDelayMs] = useState(3000);
  const [dryRun, setDryRun] = useState(false);

  const invalidate = () => {
    utils.reengajamento.statusCampanhaAtiva.invalidate({ campanhaId: CAMPANHA_ID });
    utils.reengajamento.listarLeadsCampanha.invalidate();
  };

  const { data: status, isLoading: statusLoading, refetch: refetchStatus } =
    trpc.reengajamento.statusCampanhaAtiva.useQuery({ campanhaId: CAMPANHA_ID });

  const { data: leads, isLoading: leadsLoading } =
    trpc.reengajamento.listarLeadsCampanha.useQuery({
      campanhaId: CAMPANHA_ID,
      pagina,
      porPagina: 30,
      filtro,
      busca: busca || undefined,
    });

  const gerar = trpc.reengajamento.gerarMensagensPersonalizadas.useMutation({
    onSuccess: invalidate,
  });

  const disparar = trpc.reengajamento.dispararImportados.useMutation({
    onSuccess: invalidate,
  });

  const handleBusca = () => { setBusca(buscaInput); setPagina(1); };

  const filtros: { key: Filtro; label: string; count?: number }[] = [
    { key: "todos",        label: "Todos",            count: status?.total },
    { key: "com_mensagem", label: "Mensagem gerada",  count: status?.comMensagem },
    { key: "sem_mensagem", label: "Sem mensagem",     count: status ? status.total - status.comMensagem : undefined },
    { key: "enviados",     label: "Enviados" },
    { key: "migrados",     label: "Migrados",         count: status?.migrados },
  ];

  return (
    <div className="max-w-7xl mx-auto px-4 py-6 space-y-6">
      <DisparosSegmentados />

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Campanha Ativa — Bot RAP → Carreteiros 3.0</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Reengajamento personalizado via IA · leads migram automaticamente ao responder
          </p>
        </div>
        <button
          onClick={() => { refetchStatus(); invalidate(); }}
          className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-900 border border-gray-200 rounded-lg px-3 py-1.5 hover:bg-gray-50"
        >
          <RefreshCw size={13} /> Atualizar
        </button>
      </div>

      {/* Stats */}
      {statusLoading ? (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 animate-pulse">
          {[...Array(4)].map((_, i) => <div key={i} className="h-20 bg-gray-100 rounded-xl" />)}
        </div>
      ) : status && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatusCard label="Total de leads" value={status.total.toLocaleString("pt-BR")}
            icon={Users} color="bg-blue-50 text-blue-600" />
          <StatusCard label="Mensagem gerada" value={status.comMensagem.toLocaleString("pt-BR")}
            icon={MessageSquare} color="bg-amber-50 text-amber-600" />
          <StatusCard label="Sem mensagem" value={(status.total - status.comMensagem).toLocaleString("pt-BR")}
            icon={X} color="bg-gray-50 text-gray-500" />
          <StatusCard label="Migrados p/ C3" value={status.migrados.toLocaleString("pt-BR")}
            icon={CheckCircle} color="bg-green-50 text-green-600" />
        </div>
      )}

      {/* Ações */}
      <div className="grid sm:grid-cols-2 gap-4">
        {/* Gerar mensagens */}
        <div className="bg-white border border-gray-200 rounded-xl p-4 space-y-3">
          <div>
            <p className="font-medium text-gray-900 text-sm">1. Gerar mensagens personalizadas</p>
            <p className="text-xs text-gray-400 mt-0.5">IA escreve mensagem individual para cada lead com base no histórico</p>
          </div>
          <div className="flex items-center gap-3">
            <div>
              <label className="text-xs text-gray-500">Lote</label>
              <input type="number" value={maxGerar} onChange={e => setMaxGerar(Number(e.target.value))}
                className="block w-24 border border-gray-200 rounded-lg px-2 py-1 text-sm mt-0.5" min={1} max={2000} />
            </div>
            <label className="flex items-center gap-2 text-xs text-gray-600 mt-4 cursor-pointer">
              <input type="checkbox" checked={dryRun} onChange={e => setDryRun(e.target.checked)}
                className="rounded" />
              Dry-run (simular)
            </label>
          </div>
          <button
            onClick={() => gerar.mutate({ campanhaId: CAMPANHA_ID, maxDeals: maxGerar, dryRun })}
            disabled={gerar.isPending}
            className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-amber-500 hover:bg-amber-600 text-white text-sm font-medium rounded-lg disabled:opacity-50 transition-colors"
          >
            {gerar.isPending ? <Loader2 size={14} className="animate-spin" /> : <MessageSquare size={14} />}
            {gerar.isPending ? "Gerando..." : `Gerar ${maxGerar} mensagens`}
          </button>
          {gerar.data && (() => {
            const d = gerar.data as any;
            return (
              <div className={`text-xs rounded-lg p-2 ${d.ok ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"}`}>
                {d.ok ? `✓ ${d.gerados} mensagens geradas de ${d.total} leads${dryRun ? " (simulado)" : ""}` : `Erro: ${d.error}`}
                {d.erros?.length > 0 && <p className="mt-1 opacity-70">{d.erros.length} erros</p>}
              </div>
            );
          })()}
        </div>

        {/* Disparar */}
        <div className="bg-white border border-gray-200 rounded-xl p-4 space-y-3">
          <div>
            <p className="font-medium text-gray-900 text-sm">2. Disparar mensagens</p>
            <p className="text-xs text-gray-400 mt-0.5">Envia via WhatsApp para leads que têm mensagem gerada e ainda não foram disparados</p>
          </div>
          <div className="flex items-center gap-3">
            <div>
              <label className="text-xs text-gray-500">Lote</label>
              <input type="number" value={maxDisparar} onChange={e => setMaxDisparar(Number(e.target.value))}
                className="block w-24 border border-gray-200 rounded-lg px-2 py-1 text-sm mt-0.5" min={1} max={500} />
            </div>
            <div>
              <label className="text-xs text-gray-500">Delay (ms)</label>
              <input type="number" value={delayMs} onChange={e => setDelayMs(Number(e.target.value))}
                className="block w-28 border border-gray-200 rounded-lg px-2 py-1 text-sm mt-0.5" min={500} max={30000} step={500} />
            </div>
          </div>
          <button
            onClick={() => disparar.mutate({ projetoId: PROJETO_ID, maxDeals: maxDisparar, delayMs })}
            disabled={disparar.isPending}
            className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-700 text-white text-sm font-medium rounded-lg disabled:opacity-50 transition-colors"
          >
            {disparar.isPending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
            {disparar.isPending ? "Disparando..." : `Disparar ${maxDisparar} mensagens`}
          </button>
          {disparar.data && (() => {
            const d = disparar.data as any;
            return (
              <div className={`text-xs rounded-lg p-2 ${d.ok ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"}`}>
                {d.ok ? `✓ ${d.enviados} enviados · ${d.semMensagem ?? 0} sem mensagem` : `Erro: ${d.error || d.msg}`}
              </div>
            );
          })()}
        </div>
      </div>

      {/* Tabela de leads */}
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        {/* Filtros + busca */}
        <div className="px-4 pt-4 pb-0 border-b">
          <div className="flex items-center justify-between gap-3 pb-3">
            <div className="flex items-center gap-1 flex-wrap">
              {filtros.map(f => (
                <button
                  key={f.key}
                  onClick={() => { setFiltro(f.key); setPagina(1); }}
                  className={`px-3 py-1 text-xs rounded-full font-medium transition-colors ${
                    filtro === f.key
                      ? "bg-indigo-600 text-white"
                      : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                  }`}
                >
                  {f.label}
                  {f.count !== undefined && (
                    <span className={`ml-1.5 ${filtro === f.key ? "opacity-80" : "opacity-60"}`}>
                      {f.count.toLocaleString("pt-BR")}
                    </span>
                  )}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <input
                value={buscaInput}
                onChange={e => setBuscaInput(e.target.value)}
                onKeyDown={e => e.key === "Enter" && handleBusca()}
                placeholder="Buscar lead..."
                className="border border-gray-200 rounded-lg px-3 py-1.5 text-xs w-44 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
              <button onClick={handleBusca}
                className="p-1.5 border border-gray-200 rounded-lg hover:bg-gray-50 text-gray-500">
                <Search size={13} />
              </button>
            </div>
          </div>
        </div>

        {/* Header tabela */}
        <div className="grid grid-cols-[2fr_1.2fr_1fr_3fr_80px] gap-3 px-4 py-2 bg-gray-50 text-xs font-medium text-gray-500 border-b">
          <span>Lead</span>
          <span>Stage origem</span>
          <span>Destino no C3</span>
          <span>Mensagem gerada</span>
          <span></span>
        </div>

        {/* Linhas */}
        {leadsLoading ? (
          <div className="flex items-center justify-center py-16 text-gray-400">
            <Loader2 size={20} className="animate-spin mr-2" /> Carregando...
          </div>
        ) : !leads?.deals.length ? (
          <div className="flex flex-col items-center justify-center py-16 text-gray-400 gap-2">
            <Users size={32} className="opacity-30" />
            <p className="text-sm">Nenhum lead encontrado</p>
          </div>
        ) : (
          <div className="divide-y divide-gray-100">
            {leads.deals.map(deal => {
              const stageInfo = STAGE_LABELS[deal.stageOrigem];
              const destInfo = DEST_LABELS[deal.destChave];
              return (
                <div key={deal.id}
                  className="grid grid-cols-[2fr_1.2fr_1fr_3fr_80px] gap-3 px-4 py-3 items-start hover:bg-gray-50 transition-colors">
                  {/* Nome + telefone */}
                  <div>
                    <p className="text-sm font-medium text-gray-900 truncate">{deal.nome}</p>
                    <p className="text-xs text-gray-400 font-mono">{deal.whatsapp ?? "—"}</p>
                    {deal.migrado && (
                      <span className="inline-flex items-center gap-1 text-[10px] bg-green-100 text-green-700 px-1.5 py-0.5 rounded-full mt-1">
                        <CheckCircle size={9} /> Migrado
                      </span>
                    )}
                    {deal.enviado && !deal.migrado && (
                      <span className="inline-flex items-center gap-1 text-[10px] bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded-full mt-1">
                        <Send size={9} /> Enviado
                      </span>
                    )}
                  </div>

                  {/* Stage origem */}
                  <div className="pt-0.5">
                    {stageInfo ? (
                      <span className={`inline-flex text-[10px] font-medium px-2 py-1 rounded-full ${stageInfo.color}`}>
                        {stageInfo.label}
                      </span>
                    ) : (
                      <span className="text-xs text-gray-400">{deal.stageOrigem || "—"}</span>
                    )}
                  </div>

                  {/* Destino */}
                  <div className="pt-0.5">
                    {destInfo ? (
                      <span className={`inline-flex items-center gap-1 text-[10px] font-medium px-2 py-1 rounded-full ${destInfo.color}`}>
                        <ArrowRight size={9} /> {destInfo.label.replace("→ ", "")}
                      </span>
                    ) : (
                      <span className="text-xs text-gray-400">{deal.destChave}</span>
                    )}
                  </div>

                  {/* Mensagem */}
                  <div className="pt-0.5">
                    {deal.mensagem ? (
                      <p className="text-xs text-gray-600 line-clamp-3 leading-relaxed">
                        {deal.mensagem}
                      </p>
                    ) : (
                      <p className="text-xs text-gray-300 italic">Mensagem não gerada ainda</p>
                    )}
                  </div>

                  {/* Ação editar */}
                  <div className="flex justify-end pt-0.5">
                    <button
                      onClick={() => setEditDeal({ id: deal.id, nome: deal.nome, mensagem: deal.mensagem })}
                      className="flex items-center gap-1 text-xs text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 px-2 py-1 rounded-lg transition-colors"
                    >
                      <Edit2 size={12} /> Editar
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Paginação */}
        {leads && leads.paginas > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t bg-gray-50 text-xs text-gray-500">
            <span>{leads.total.toLocaleString("pt-BR")} leads · pág. {pagina}/{leads.paginas}</span>
            <div className="flex gap-1">
              <button onClick={() => setPagina(p => Math.max(1, p - 1))} disabled={pagina === 1}
                className="p-1.5 rounded hover:bg-gray-200 disabled:opacity-30">
                <ChevronLeft size={14} />
              </button>
              <button onClick={() => setPagina(p => Math.min(leads.paginas, p + 1))} disabled={pagina === leads.paginas}
                className="p-1.5 rounded hover:bg-gray-200 disabled:opacity-30">
                <ChevronRight size={14} />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Modal edição */}
      {editDeal && (
        <EditModal
          deal={editDeal}
          onSave={() => { utils.reengajamento.listarLeadsCampanha.invalidate(); }}
          onClose={() => setEditDeal(null)}
        />
      )}
    </div>
  );
}
