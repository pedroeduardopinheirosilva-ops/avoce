/**
 * Devolução de "lead qualificado" à Meta (Conversions API for Business Messaging).
 * Mostra, por projeto de IA: eventos emitidos, enviados, falhados e o vazamento de
 * atribuição (lead de anúncio que chegou sem ctwa_clid e por isso não pode ser devolvido).
 */

import { useState } from "react";
import { trpc } from "../lib/trpc";
import { Target, RotateCcw } from "lucide-react";

const STATUS_COR: Record<string, string> = {
  enviado:  "bg-emerald-50 text-emerald-700 border-emerald-200",
  pendente: "bg-blue-50 text-blue-700 border-blue-200",
  enviando: "bg-blue-50 text-blue-700 border-blue-200",
  falhou:   "bg-amber-50 text-amber-700 border-amber-200",
  morto:    "bg-red-50 text-red-700 border-red-200",
  sem_ctwa: "bg-gray-50 text-gray-600 border-gray-200",
  expirado: "bg-gray-50 text-gray-500 border-gray-200",
};

function Numero({ label, valor, cor = "text-gray-800", dica }: { label: string; valor: number | string; cor?: string; dica?: string }) {
  return (
    <div className="min-w-[96px]" title={dica}>
      <div className={`text-xl font-semibold tabular-nums ${cor}`}>{valor}</div>
      <div className="text-[11px] uppercase tracking-wide text-gray-400">{label}</div>
    </div>
  );
}

export default function MetaCapiPainel() {
  const resumo = trpc.metaCapi.resumo.useQuery({ dias: 30 });
  const [aberto, setAberto] = useState<string | null>(null);
  const eventos = trpc.metaCapi.eventos.useQuery(
    { projetoId: aberto ?? "", limit: 30 },
    { enabled: !!aberto },
  );
  const reprocessar = trpc.metaCapi.reprocessar.useMutation({
    onSuccess: () => { eventos.refetch(); resumo.refetch(); },
  });

  // Só aparece para projetos que já têm lead de anúncio ou evento.
  const projetos = (resumo.data ?? []).filter((p) => p.leadsAnuncio > 0 || p.emitidos > 0);
  if (!projetos.length) return null;

  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden mb-4">
      <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-gray-100">
        <Target size={16} className="text-gray-400" />
        <span className="text-sm font-semibold text-gray-800">Lead qualificado → Meta</span>
        <span className="text-xs text-gray-400">últimos 30 dias · otimização da campanha por qualidade</span>
      </div>

      {projetos.map((p) => {
        const pctSem = p.taxaSemCtwa == null ? "—" : `${Math.round(p.taxaSemCtwa * 100)}%`;
        const estado = !p.config.ativo
          ? { txt: "envio desligado", cor: "bg-gray-100 text-gray-600" }
          : !p.config.datasetId || !p.config.wabaId || !p.config.mktProjetoId
            ? { txt: "ligado, falta configurar dataset/WABA", cor: "bg-amber-100 text-amber-800" }
            : p.config.modoTeste
              ? { txt: "enviando em modo teste", cor: "bg-blue-100 text-blue-800" }
              : { txt: "enviando", cor: "bg-emerald-100 text-emerald-800" };
        return (
          <div key={p.projetoId} className="px-4 py-3 border-t border-gray-100 first:border-t-0">
            <div className="flex flex-wrap items-center gap-2 mb-2">
              <span className="text-sm font-medium text-gray-800">{p.projetoNome}</span>
              <span className={`text-[11px] rounded-full px-2 py-0.5 ${estado.cor}`}>{estado.txt}</span>
            </div>
            <div className="flex flex-wrap gap-x-6 gap-y-3">
              <Numero label="Qualificados" valor={p.emitidos} dica="Eventos lead_qualificado emitidos pelo funil" />
              <Numero label="Enviados" valor={p.enviados} cor="text-emerald-700" />
              <Numero label="Na fila" valor={p.naFila} cor="text-blue-700" />
              <Numero label="Falhados" valor={p.falhados} cor={p.falhados ? "text-red-700" : "text-gray-800"} dica={`${p.mortos} esgotaram as tentativas`} />
              <Numero label="Sem ctwa_clid" valor={p.semCtwa} cor="text-gray-600" dica="Qualificados que não vieram de clique em anúncio — não há o que devolver" />
              <Numero
                label="Anúncio sem clid"
                valor={pctSem}
                cor={(p.taxaSemCtwa ?? 0) > 0.2 ? "text-amber-700" : "text-gray-800"}
                dica={`${p.leadsAnuncioSemCtwa} de ${p.leadsAnuncio} leads de anúncio chegaram sem ctwa_clid (vazamento de atribuição)`}
              />
            </div>
            <button
              onClick={() => setAberto(aberto === p.projetoId ? null : p.projetoId)}
              className="mt-2 text-xs text-indigo-600 hover:underline"
            >
              {aberto === p.projetoId ? "Ocultar eventos" : "Ver últimos eventos"}
            </button>

            {aberto === p.projetoId && (
              <div className="mt-2 overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-[10px] uppercase tracking-wide text-gray-400">
                      <th className="text-left font-medium py-1 pr-2">Lead</th>
                      <th className="text-left font-medium py-1 pr-2">Status</th>
                      <th className="text-left font-medium py-1 pr-2">Via</th>
                      <th className="text-left font-medium py-1 pr-2">Qualificou</th>
                      <th className="text-left font-medium py-1 pr-2">Erro</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {(eventos.data ?? []).map((e) => (
                      <tr key={e.id} className="border-t border-gray-100 align-top">
                        <td className="py-1 pr-2 max-w-[200px] truncate" title={e.deal.titulo}>{e.deal.titulo}</td>
                        <td className="py-1 pr-2">
                          <span className={`border rounded-full px-1.5 py-0.5 ${STATUS_COR[e.status] ?? STATUS_COR.sem_ctwa}`}>
                            {e.status}{e.testEventCode ? " · teste" : ""}{e.tentativas > 1 ? ` · ${e.tentativas}x` : ""}
                          </span>
                        </td>
                        <td className="py-1 pr-2 text-gray-500">{e.via}</td>
                        <td className="py-1 pr-2 text-gray-500 whitespace-nowrap">{new Date(e.ocorridoEm).toLocaleString("pt-BR")}</td>
                        <td className="py-1 pr-2 text-red-600 max-w-[260px] truncate" title={e.erro ?? ""}>{e.erro}</td>
                        <td className="py-1">
                          {["morto", "falhou", "expirado"].includes(e.status) && (
                            <button
                              title="Devolver à fila"
                              disabled={reprocessar.isLoading}
                              onClick={() => reprocessar.mutate({ id: e.id })}
                              className="text-gray-400 hover:text-indigo-600"
                            >
                              <RotateCcw size={13} />
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                    {eventos.data && !eventos.data.length && (
                      <tr><td colSpan={6} className="py-2 text-gray-400">Nenhum evento ainda.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
