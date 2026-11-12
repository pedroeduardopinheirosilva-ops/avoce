/**
 * Seção "🤝 Acordo" do modal do deal (Crm.tsx). Registro paralelo ao funil: nada aqui mexe em
 * coluna, prazo ou audiência do deal (decisão 11 do plano).
 *
 *  - situação atual (acordos.doDeal): acordo aberto, histórico, avaliação prévia pendente
 *    (decidir aqui mesmo), "encerrado por acordo";
 *  - botão "Tentar acordo" em qualquer fase (motivo e fase de origem obrigatórios);
 *  - link para o detalhe da negociação (/acordos/:id).
 */
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { trpc } from "../../lib/trpc";
import { useAuth } from "../../lib/usePermission";
import AvaliacaoDecidir from "./AvaliacaoDecidir";
import {
  FASES, STATUS_ACORDO, btnPri, btnSec, fmtBrl, fmtData, inputCls, labelCls, podeModulo, rotuloFase, rotuloTipoAcordo,
  type Fase,
} from "./util";

export default function AcordoDeal({ dealId }: { dealId: string }) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const podeEditar = podeModulo(user, "acordos");
  const utils = trpc.useUtils();
  const q = trpc.acordos.doDeal.useQuery({ dealId }, { enabled: !!dealId });
  const [abrindo, setAbrindo] = useState(false);
  const [decidindo, setDecidindo] = useState(false);
  const [motivo, setMotivo] = useState("");
  const [fase, setFase] = useState<Fase | "">("");
  const [responsavelId, setResponsavelId] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const responsaveis = trpc.acordos.responsaveis.useQuery({ dealId }, { enabled: abrindo });

  const abrirMut = trpc.acordos.abrir.useMutation({
    onSuccess: (a) => {
      setErro(null);
      setAbrindo(false);
      setMotivo("");
      setFase("");
      utils.acordos.invalidate();
      navigate(`/acordos/${a.id}`);
    },
    onError: (e) => setErro(e.message),
  });
  const criarAvMut = trpc.acordos.criarAvaliacao.useMutation({
    onSuccess: () => { setErro(null); utils.acordos.doDeal.invalidate({ dealId }); utils.acordos.avaliacoes.invalidate(); },
    onError: (e) => setErro(e.message),
  });

  function abrir() {
    if (motivo.trim().length < 3) return setErro("Informe o motivo da tentativa (mín. 3 caracteres).");
    if (!fase) return setErro("Informe a fase de origem.");
    abrirMut.mutate({ dealId, motivo: motivo.trim(), faseOrigem: fase, responsavelId: responsavelId || undefined });
  }

  const d = q.data;
  const av = d?.avaliacao;
  const historico = (d?.acordos ?? []).filter((a) => a.id !== d?.aberto?.id);

  return (
    <div className="border-t pt-4">
      <div className="flex items-center justify-between mb-3 gap-2">
        <p className="text-xs font-semibold text-gray-500 uppercase">🤝 Acordo</p>
        <div className="flex items-center gap-2">
          {d?.encerradoPorAcordo && (
            <span className="text-[11px] text-green-700 bg-green-50 border border-green-200 rounded-full px-2 py-0.5">encerrado por acordo</span>
          )}
          {podeEditar && d?.podeAbrir && !abrindo && (
            <button type="button" onClick={() => { setAbrindo(true); setErro(null); }} className={btnPri}>Tentar acordo</button>
          )}
        </div>
      </div>

      {q.isLoading && <p className="text-xs text-gray-400">Carregando…</p>}
      {q.error && <p className="text-xs text-red-600">{q.error.message}</p>}

      {d && (
        <div className="space-y-3">
          {/* Avaliação prévia */}
          {av && !av.decisao && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs text-amber-800">
                  <b>Avaliação prévia de acordo pendente</b>
                  {av.prazoEm && <> · prazo {fmtData(av.prazoEm)}</>}
                  {av.responsavelNome && <> · {av.responsavelNome}</>}
                </p>
                {podeEditar && !decidindo && (
                  <button type="button" onClick={() => setDecidindo(true)} className={btnSec}>Decidir</button>
                )}
              </div>
              {decidindo && (
                <div className="mt-2">
                  <AvaliacaoDecidir avaliacaoId={av.id} dealId={dealId} onCancel={() => setDecidindo(false)}
                    onDone={(r) => { setDecidindo(false); if (r.acordoId) navigate(`/acordos/${r.acordoId}`); }} />
                </div>
              )}
            </div>
          )}
          {av?.decisao && (
            <p className="text-[11px] text-gray-500">
              Avaliação prévia: <b>{av.decisao === "tentar" ? "tentar acordo" : "não tentar"}</b>
              {av.justificativa && <> — “{av.justificativa}”</>}
            </p>
          )}
          {!av && d.deal.pipeline?.tipo === "processual" && podeEditar && (
            <p className="text-[11px] text-gray-500">
              Sem avaliação prévia registrada.{" "}
              <button type="button" onClick={() => criarAvMut.mutate({ dealId })} disabled={criarAvMut.isLoading} className="underline hover:text-gray-800">
                Criar tarefa de avaliação
              </button>
            </p>
          )}

          {/* Formulário "Tentar acordo" */}
          {abrindo && (
            <div className="bg-gray-50 border border-gray-200 rounded-lg p-3 space-y-2">
              <div>
                <label className={labelCls}>Motivo da tentativa *</label>
                <textarea value={motivo} onChange={(e) => setMotivo(e.target.value)} rows={2} maxLength={2000} className={inputCls}
                  placeholder="Ex.: empresa sinalizou proposta após a perícia" />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <div>
                  <label className={labelCls}>Fase de origem *</label>
                  <select value={fase} onChange={(e) => setFase(e.target.value as Fase)} className={inputCls}>
                    <option value="">Selecione…</option>
                    {FASES.map((f) => <option key={f.valor} value={f.valor}>{f.rotulo}</option>)}
                  </select>
                </div>
                <div>
                  <label className={labelCls}>Responsável</label>
                  <select value={responsavelId} onChange={(e) => setResponsavelId(e.target.value)} className={inputCls}>
                    <option value="">Eu</option>
                    {(responsaveis.data ?? []).map((u) => <option key={u.id} value={u.id}>{u.nome}</option>)}
                  </select>
                </div>
              </div>
              <p className="text-[11px] text-gray-500">
                A tentativa corre em paralelo: a coluna, os prazos e a audiência do processo não mudam.
              </p>
              <div className="flex gap-2">
                <button type="button" onClick={abrir} disabled={abrirMut.isLoading} className={btnPri}>{abrirMut.isLoading ? "Abrindo…" : "Abrir negociação"}</button>
                <button type="button" onClick={() => { setAbrindo(false); setErro(null); }} className={btnSec}>Cancelar</button>
              </div>
            </div>
          )}

          {/* Acordo aberto */}
          {d.aberto && (
            <button type="button" onClick={() => navigate(`/acordos/${d.aberto!.id}`)}
              className="w-full text-left border border-blue-200 bg-blue-50/40 rounded-lg p-3 hover:bg-blue-50">
              <div className="flex items-center justify-between gap-2">
                <span className={`text-[11px] border rounded-full px-2 py-0.5 ${STATUS_ACORDO[d.aberto.status]?.cor ?? ""}`}>
                  {STATUS_ACORDO[d.aberto.status]?.rotulo ?? d.aberto.status}
                </span>
                <span className="text-[11px] text-blue-700">abrir negociação →</span>
              </div>
              <p className="text-xs text-gray-700 mt-1">
                {rotuloTipoAcordo(d.aberto.tipo)} · {rotuloFase(d.aberto.faseOrigem)}
                {d.aberto.responsavelNome && <> · {d.aberto.responsavelNome}</>}
              </p>
              <p className="text-xs text-gray-500 mt-0.5">
                {d.aberto.ultimaRodada
                  ? <>Última rodada {fmtData(d.aberto.ultimaRodada.data)} ({d.aberto.ultimaRodada.autor === "empresa" ? "empresa" : "escritório"}) {fmtBrl(d.aberto.ultimaRodada.valor)}</>
                  : "Sem rodadas registradas"}
                {d.aberto.proximoFollowupEm && (
                  <span className={d.aberto.followupVencido ? "text-red-600 font-semibold" : ""}> · follow-up {fmtData(d.aberto.proximoFollowupEm)}</span>
                )}
              </p>
            </button>
          )}

          {/* Histórico */}
          {historico.length > 0 && (
            <div>
              <p className="text-[11px] font-medium text-gray-500 mb-1">Histórico</p>
              <ul className="space-y-1">
                {historico.map((a) => (
                  <li key={a.id}>
                    <button type="button" onClick={() => navigate(`/acordos/${a.id}`)} className="w-full text-left text-xs text-gray-600 hover:text-gray-900 flex flex-wrap gap-x-2">
                      <span className={`border rounded-full px-2 py-0 text-[10px] ${STATUS_ACORDO[a.status]?.cor ?? ""}`}>{STATUS_ACORDO[a.status]?.rotulo ?? a.status}</span>
                      <span>{rotuloTipoAcordo(a.tipo)} · aberto em {new Date(a.criadoEm).toLocaleDateString("pt-BR")}</span>
                      {a.valorAcordo !== null && <span>· {fmtBrl(a.valorAcordo)}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {!d.aberto && !historico.length && !abrindo && (
            <p className="text-xs text-gray-400">Nenhuma tentativa de acordo neste processo.</p>
          )}
          {erro && <p className="text-xs text-red-600">{erro}</p>}
        </div>
      )}
    </div>
  );
}
