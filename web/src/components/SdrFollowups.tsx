import { useState } from "react";
import { trpc } from "../lib/trpc";

/**
 * Quem faz follow-up na empresa. SDR marcada fica com os follow-ups que ela mesma agenda;
 * o que for agendado por quem não é SDR (advogada, sócia) vai para a SDR padrão. Ao salvar,
 * os pendentes de quem não é SDR passam para a padrão.
 */
export function SdrFollowups() {
  const utils = trpc.useUtils();
  const q = trpc.painel.followupSdr.useQuery();
  const [edit, setEdit] = useState<{ padrao: string | null; sdrs: string[] } | null>(null);
  const [msg, setMsg] = useState("");
  const salvar = trpc.painel.salvarFollowupSdr.useMutation({
    onSuccess: (r) => {
      setMsg(r.transferidos ? `Salvo. ${r.transferidos} follow-up(s) de quem não é SDR passaram para a padrão.` : "Salvo.");
      setEdit(null);
      utils.painel.followupSdr.invalidate();
      utils.painel.followupsHoje.invalidate();
      utils.painel.followupsPendentes.invalidate();
    },
    onError: (e) => setMsg(e.message),
  });

  const atual = edit ?? { padrao: q.data?.padrao ?? null, sdrs: q.data?.sdrs ?? [] };
  const mudar = (v: { padrao: string | null; sdrs: string[] }) => { setEdit(v); setMsg(""); };
  const toggleSdr = (id: string) =>
    mudar({ ...atual, sdrs: atual.sdrs.includes(id) ? atual.sdrs.filter((x) => x !== id) : [...atual.sdrs, id] });

  return (
    <div className="pb-4 mb-4 border-b border-gray-100">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-gray-700 font-medium">Follow-ups</span>
        <span className="text-xs text-gray-500">SDR padrão:</span>
        <select
          value={atual.padrao ?? ""}
          onChange={(e) => {
            const padrao = e.target.value || null;
            mudar({ padrao, sdrs: padrao && !atual.sdrs.includes(padrao) ? [...atual.sdrs, padrao] : atual.sdrs });
          }}
          className="text-sm border border-gray-200 rounded-lg px-2 py-1"
        >
          <option value="">Nenhuma (fica com quem marcou)</option>
          {(q.data?.usuarios ?? []).map((u) => <option key={u.id} value={u.id}>{u.nome}</option>)}
        </select>
        {edit && (
          <button
            onClick={() => salvar.mutate({ padrao: atual.padrao, sdrs: atual.sdrs, transferirPendentes: true })}
            disabled={salvar.isPending}
            className="px-3 py-1 rounded-lg bg-gray-900 text-white text-xs font-medium hover:bg-black disabled:opacity-50"
          >
            {salvar.isPending ? "Salvando…" : "Salvar"}
          </button>
        )}
      </div>
      {atual.padrao && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-2">
          <span className="text-xs text-gray-500">Também são SDR (ficam com os próprios follow-ups):</span>
          {(q.data?.usuarios ?? []).filter((u) => u.id !== atual.padrao).map((u) => (
            <label key={u.id} className="flex items-center gap-1 text-xs text-gray-700">
              <input type="checkbox" className="rounded" checked={atual.sdrs.includes(u.id)} onChange={() => toggleSdr(u.id)} />
              {u.nome.split(" ")[0]}
            </label>
          ))}
        </div>
      )}
      <p className="text-xs text-gray-400 mt-1.5">
        {msg || "Quem é SDR fica com o follow-up que agenda. O que for agendado por outra pessoa vai para a SDR padrão."}
      </p>
    </div>
  );
}
