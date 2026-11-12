/**
 * Decisão obrigatória da avaliação prévia (§2.1): "Tentar acordo prévio" ou "Não tentar",
 * sempre com justificativa curta (3–500 caracteres, regra do server).
 */
import { useState } from "react";
import { trpc } from "../../lib/trpc";
import { btnPri, btnSec, inputCls, labelCls } from "./util";

export default function AvaliacaoDecidir({ avaliacaoId, dealId, onDone, onCancel }: {
  avaliacaoId: string;
  dealId: string;
  onDone?: (r: { acordoId: string | null }) => void;
  onCancel?: () => void;
}) {
  const utils = trpc.useUtils();
  const [decisao, setDecisao] = useState<"tentar" | "nao_tentar" | "">("");
  const [justificativa, setJustificativa] = useState("");
  const [responsavelId, setResponsavelId] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const responsaveis = trpc.acordos.responsaveis.useQuery({ dealId }, { enabled: decisao === "tentar" });

  const mut = trpc.acordos.decidirAvaliacao.useMutation({
    onSuccess: (r) => {
      setErro(null);
      utils.acordos.invalidate();
      utils.recebimentos.alertas.invalidate();
      onDone?.({ acordoId: r.acordoId });
    },
    onError: (e) => setErro(e.message),
  });

  function salvar() {
    if (!decisao) return setErro("Escolha a decisão.");
    if (justificativa.trim().length < 3) return setErro("Escreva uma justificativa curta (mín. 3 caracteres).");
    mut.mutate({ avaliacaoId, decisao, justificativa: justificativa.trim(), responsavelId: responsavelId || undefined });
  }

  return (
    <div className="space-y-2 bg-white border border-gray-200 rounded-lg p-3">
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => setDecisao("tentar")}
          className={`px-3 py-1.5 text-xs rounded-lg border ${decisao === "tentar" ? "bg-green-600 text-white border-green-600" : "border-green-300 text-green-700 hover:bg-green-50"}`}>
          🤝 Tentar acordo prévio
        </button>
        <button type="button" onClick={() => setDecisao("nao_tentar")}
          className={`px-3 py-1.5 text-xs rounded-lg border ${decisao === "nao_tentar" ? "bg-gray-700 text-white border-gray-700" : "border-gray-300 text-gray-700 hover:bg-gray-50"}`}>
          Não tentar
        </button>
      </div>
      <div>
        <label className={labelCls}>Justificativa (obrigatória)</label>
        <input value={justificativa} onChange={(e) => setJustificativa(e.target.value)} maxLength={500} className={inputCls}
          placeholder={decisao === "nao_tentar" ? "Ex.: empresa nunca faz acordo antes da audiência" : "Ex.: empresa costuma acordar; cliente precisa de liquidez"} />
      </div>
      {decisao === "tentar" && (
        <div>
          <label className={labelCls}>Responsável pela negociação</label>
          <select value={responsavelId} onChange={(e) => setResponsavelId(e.target.value)} className={inputCls}>
            <option value="">Responsável da avaliação</option>
            {(responsaveis.data ?? []).map((u: any) => <option key={u.id} value={u.id}>{u.nome}</option>)}
          </select>
        </div>
      )}
      {erro && <p className="text-xs text-red-600">{erro}</p>}
      <div className="flex gap-2">
        <button type="button" onClick={salvar} disabled={mut.isLoading} className={btnPri}>{mut.isLoading ? "Salvando…" : "Registrar decisão"}</button>
        {onCancel && <button type="button" onClick={onCancel} className={btnSec}>Cancelar</button>}
      </div>
    </div>
  );
}
