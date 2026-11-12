/**
 * Escolha de um processo (CrmDeal) — usa acordos.buscarDeals: busca por título, nome do cliente ou
 * número CNJ (com ou sem pontuação), INCLUI processos encerrados (ganho/perdido), isolada por tenant.
 * O funil é filtro opcional ("Todos os funis" por padrão). Usado em "nova avaliação prévia" e
 * "novo recebimento avulso".
 */
import { useEffect, useMemo, useState } from "react";
import { trpc } from "../../lib/trpc";
import { inputCls, labelCls } from "./util";

export type DealEscolhido = { id: string; titulo: string; cliente: string | null };

const STATUS_ROTULO: Record<string, string> = { aberto: "aberto", ganho: "encerrado (ganho)", perdido: "encerrado (perdido)" };

export default function DealPicker({ value, onChange, somenteProcessual = true }: {
  value: DealEscolhido | null;
  onChange: (d: DealEscolhido | null) => void;
  somenteProcessual?: boolean;
}) {
  const pipelines = trpc.crm.listPipelines.useQuery();
  const lista = useMemo(() => {
    const ps = (pipelines.data ?? []) as Array<{ id: string; nome: string; tipo?: string | null }>;
    return somenteProcessual ? ps.filter((p) => p.tipo === "processual") : ps;
  }, [pipelines.data, somenteProcessual]);
  const [pipelineId, setPipelineId] = useState(""); // "" = todos os funis
  const [busca, setBusca] = useState("");
  const [buscaDeb, setBuscaDeb] = useState("");

  useEffect(() => {
    if (pipelineId && !lista.some((p) => p.id === pipelineId)) setPipelineId("");
  }, [lista, pipelineId]);
  useEffect(() => {
    const t = setTimeout(() => setBuscaDeb(busca.trim()), 350);
    return () => clearTimeout(t);
  }, [busca]);

  const busq = trpc.acordos.buscarDeals.useQuery(
    { busca: buscaDeb, limite: 30, pipelineId: pipelineId || undefined, somenteProcessual },
    { enabled: buscaDeb.length >= 2 },
  );
  const deals = busq.data ?? [];

  if (value) {
    return (
      <div className="flex items-center gap-2 border border-gray-200 rounded-lg px-3 py-2 bg-gray-50">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-gray-800 truncate">{value.titulo}</p>
          {value.cliente && <p className="text-xs text-gray-500 truncate">{value.cliente}</p>}
        </div>
        <button type="button" onClick={() => onChange(null)} className="text-xs text-gray-500 hover:text-gray-800">trocar</button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <div>
          <label className={labelCls}>Funil</label>
          <select value={pipelineId} onChange={(e) => setPipelineId(e.target.value)} className={inputCls}>
            <option value="">{pipelines.isLoading ? "Carregando…" : somenteProcessual ? "Todos os funis processuais" : "Todos os funis"}</option>
            {lista.map((p) => <option key={p.id} value={p.id}>{p.nome}</option>)}
          </select>
        </div>
        <div>
          <label className={labelCls}>Buscar processo (título, cliente ou nº CNJ)</label>
          <input value={busca} onChange={(e) => setBusca(e.target.value)} className={inputCls} placeholder="mín. 2 caracteres" />
        </div>
      </div>
      {buscaDeb.length >= 2 && (
        <div className="border border-gray-200 rounded-lg max-h-56 overflow-y-auto divide-y">
          {busq.isLoading && <p className="p-3 text-xs text-gray-400">Buscando…</p>}
          {busq.error && <p className="p-3 text-xs text-red-600">{busq.error.message}</p>}
          {!busq.isLoading && !deals.length && !busq.error && <p className="p-3 text-xs text-gray-400">Nenhum processo encontrado.</p>}
          {deals.map((d) => (
            <button key={d.id} type="button" onClick={() => onChange({ id: d.id, titulo: d.titulo, cliente: d.cliente })}
              className="w-full text-left px-3 py-2 hover:bg-gray-50">
              <p className="text-sm text-gray-800 truncate">{d.titulo}</p>
              <p className="text-[11px] text-gray-500 truncate">
                {d.cliente ?? "—"}{d.numeroCnj ? ` · ${d.numeroCnj}` : ""} · {d.pipeline ?? "—"} / {d.stage ?? "—"}
                {d.status !== "aberto" ? ` · ${STATUS_ROTULO[d.status] ?? d.status}` : ""}
              </p>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
