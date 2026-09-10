/**
 * Cadastro da audiência do lead e disparo da mensagem de designação.
 *
 * O envio é em duas etapas de propósito: o Modelo 1 leva valor da causa e nome
 * da empresa, e erro nesses campos vai direto para o cliente. Salvar só grava;
 * a mensagem aparece montada, editável, e sai quando alguém clica em enviar.
 */

import { useEffect, useState } from "react";
import { trpc } from "../lib/trpc";

type Props = { dealId: string };

/** ISO → valor de <input type="datetime-local"> no fuso do navegador. */
function isoParaLocal(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function AudienciaLead({ dealId }: Props) {
  const utils = trpc.useUtils();
  const { data: opcoes } = trpc.audiencia.opcoes.useQuery({});
  const { data: deal } = trpc.crm.getDeal.useQuery({ id: dealId }, { enabled: !!dealId });

  const [em, setEm] = useState("");
  const [tipo, setTipo] = useState("");
  const [modalidade, setModalidade] = useState("presencial");
  const [local, setLocal] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const [texto, setTexto] = useState("");
  const [editouTexto, setEditouTexto] = useState(false);
  const [enviado, setEnviado] = useState(false);

  // Hidrata a partir do lead sempre que ele muda (troca de card no funil).
  useEffect(() => {
    const d = deal as any;
    if (!d) return;
    setEm(isoParaLocal(d.audienciaEm));
    setTipo(d.audienciaTipo ?? "");
    setModalidade(d.audienciaModalidade ?? "presencial");
    setLocal(d.audienciaLocal ?? "");
    setEditouTexto(false);
    setEnviado(false);
  }, [deal?.id, (deal as any)?.audienciaEm, (deal as any)?.audienciaTipo]);

  const cadastrada = !!(deal as any)?.audienciaEm && !!(deal as any)?.audienciaTipo;

  const { data: preview } = trpc.audiencia.preview.useQuery(
    { dealId, qual: "designacao" },
    { enabled: cadastrada },
  );

  // Só sobrescreve o rascunho enquanto ninguém mexeu nele.
  useEffect(() => {
    if (preview?.texto && !editouTexto) setTexto(preview.texto);
  }, [preview?.texto, editouTexto]);

  const salvarMut = trpc.audiencia.salvar.useMutation({
    onSuccess: () => {
      setErro(null);
      utils.crm.getDeal.invalidate({ id: dealId });
      utils.audiencia.preview.invalidate({ dealId });
      setEditouTexto(false);
    },
    onError: (e) => setErro(e.message),
  });

  const enviarMut = trpc.audiencia.enviarDesignacao.useMutation({
    onSuccess: () => {
      setErro(null);
      setEnviado(true);
      utils.crm.getDeal.invalidate({ id: dealId });
      utils.ia.invalidate();
    },
    onError: (e) => setErro(e.message),
  });

  function salvar() {
    if (!em || !tipo) { setErro("Informe a data e o tipo da audiência."); return; }
    salvarMut.mutate({
      dealId,
      em: new Date(em).toISOString(),
      tipo: tipo as any,
      modalidade: modalidade as any,
      local: local.trim() || null,
    });
  }

  function limpar() {
    salvarMut.mutate({ dealId, em: null, tipo: null, modalidade: null, local: null });
    setTexto("");
  }

  const avisadaEm = (deal as any)?.audienciaAvisadaEm as string | null | undefined;
  const inputCls =
    "w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500";

  return (
    <div className="border-t pt-4">
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs font-semibold text-gray-500 uppercase">⚖️ Audiência</p>
        {avisadaEm && (
          <span className="text-[11px] text-green-700 bg-green-50 border border-green-200 rounded-full px-2 py-0.5">
            cliente avisado em {new Date(avisadaEm).toLocaleDateString("pt-BR")}
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Data e hora</label>
          <input type="datetime-local" value={em} onChange={(e) => setEm(e.target.value)} className={inputCls} />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Tipo</label>
          <select value={tipo} onChange={(e) => setTipo(e.target.value)} className={inputCls}>
            <option value="">Selecione…</option>
            {opcoes?.tipos.map((t) => (
              <option key={t.chave} value={t.chave}>{t.rotulo}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Modalidade</label>
          <select value={modalidade} onChange={(e) => setModalidade(e.target.value)} className={inputCls}>
            <option value="presencial">Presencial</option>
            <option value="virtual">Virtual (Zoom)</option>
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">
            {modalidade === "virtual" ? "Link da sala" : "Local (vara/fórum)"}
          </label>
          <input
            value={local}
            onChange={(e) => setLocal(e.target.value)}
            className={inputCls}
            placeholder={modalidade === "virtual" ? "https://…" : "Ex.: 2ª Vara do Trabalho de…"}
          />
        </div>
      </div>

      <div className="flex items-center gap-2 mt-3">
        <button
          onClick={salvar}
          disabled={salvarMut.isPending}
          className="px-3 py-1.5 text-xs bg-brand-600 text-white rounded-lg hover:bg-brand-700 disabled:opacity-50"
        >
          {salvarMut.isPending ? "Salvando…" : cadastrada ? "Atualizar audiência" : "Salvar audiência"}
        </button>
        {cadastrada && (
          <button onClick={limpar} className="px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-100 rounded-lg">
            Remover
          </button>
        )}
      </div>

      {erro && <p className="text-xs text-red-600 mt-2">{erro}</p>}

      {cadastrada && (
        <div className="mt-4">
          <p className="text-xs font-medium text-gray-600 mb-1">
            Mensagem para o cliente — confira antes de enviar
          </p>
          {preview?.semModelo && (
            <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-2 mb-2">
              O modelo <code>{preview.chaveTemplate}</code> ainda não foi cadastrado. Crie o texto em
              Config IA → Audiências para que a mensagem seja montada.
            </p>
          )}
          {!!preview?.faltando?.length && (
            <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-2 mb-2">
              O modelo usa {preview.faltando.join(", ")} e esse dado está vazio no lead. Preencha no
              cadastro ou ajuste o texto abaixo antes de enviar.
            </p>
          )}
          <textarea
            value={texto}
            onChange={(e) => { setTexto(e.target.value); setEditouTexto(true); }}
            rows={10}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
          <div className="flex items-center gap-2 mt-2">
            <button
              onClick={() => enviarMut.mutate({ dealId, texto })}
              disabled={enviarMut.isPending || texto.trim().length < 10 || !!preview?.semModelo}
              className="px-3 py-1.5 text-xs bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50"
            >
              {enviarMut.isPending ? "Enviando…" : avisadaEm ? "Enviar novamente" : "Enviar no WhatsApp"}
            </button>
            {editouTexto && (
              <button
                onClick={() => { setEditouTexto(false); setTexto(preview?.texto ?? ""); }}
                className="px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-100 rounded-lg"
              >
                Restaurar modelo
              </button>
            )}
            {enviado && <span className="text-xs text-green-700">Enviado ✓</span>}
          </div>
          {preview?.previsao && preview.previsao.length > 0 && (
            <p className="text-[11px] text-gray-500 mt-2">
              Depois do envio, o lembrete sai sozinho faltando{" "}
              {preview.previsao.join(", ")} dia(s) — {preview.previsao.length} mensagem(ns), às{" "}
              {String(preview.cadencia?.hora ?? 9).padStart(2, "0")}h. A cadência e os textos são
              editados em Config IA → Audiências.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
