import { useState } from "react";
import { trpc } from "../lib/trpc";

/**
 * Disparo segmentado (server/src/lib/disparos.ts): mensagem para um recorte do funil —
 * etapas, etiquetas, origem, vídeo/palavra-chave. O envio é lento e com teto diário de
 * propósito: o número do escritório já foi bloqueado por rajada.
 */
const ORIGENS = [
  { id: "anuncio", rotulo: "Anúncio" },
  { id: "organico", rotulo: "Orgânico" },
  { id: "link", rotulo: "Link / site" },
  { id: "sem", rotulo: "Sem origem" },
];
const STATUS: Record<string, string> = {
  rascunho: "bg-gray-100 text-gray-600", enviando: "bg-green-100 text-green-700", pausado: "bg-amber-100 text-amber-700",
  concluido: "bg-indigo-100 text-indigo-700", cancelado: "bg-red-100 text-red-600",
};

function alternar(lista: string[], id: string) {
  return lista.includes(id) ? lista.filter((x) => x !== id) : [...lista, id];
}

function Chip({ ativo, onClick, children, cor }: { ativo: boolean; onClick: () => void; children: React.ReactNode; cor?: string }) {
  return (
    <button type="button" onClick={onClick}
      className={`text-xs px-2 py-1 rounded-full border ${ativo ? "bg-gray-900 text-white border-gray-900" : "border-gray-200 text-gray-600 hover:bg-gray-50"}`}>
      {cor && <span className="inline-block w-1.5 h-1.5 rounded-full mr-1 align-middle" style={{ backgroundColor: cor }} />}
      {children}
    </button>
  );
}

export function DisparosSegmentados() {
  const utils = trpc.useUtils();
  const pipelines = trpc.crm.listPipelines.useQuery();
  const [pipelineId, setPipelineId] = useState("");
  const [stageIds, setStageIds] = useState<string[]>([]);
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [origemTipos, setOrigemTipos] = useState<string[]>([]);
  const [palavras, setPalavras] = useState<string[]>([]);
  const [somenteQuemConversou, setSomenteQuemConversou] = useState(true);
  const [pularHoras, setPularHoras] = useState(72);
  const [nome, setNome] = useState("");
  const [mensagem, setMensagem] = useState("");
  const [intervaloSeg, setIntervaloSeg] = useState(90);
  const [limiteDia, setLimiteDia] = useState(60);
  const [msg, setMsg] = useState("");

  const opcoes = trpc.disparos.opcoes.useQuery({ pipelineId }, { enabled: !!pipelineId });
  const filtro = { pipelineId, stageIds, tagIds, origemTipos, palavras, somenteQuemConversou, pularContatadosHoras: pularHoras };
  const previa = trpc.disparos.previa.useQuery(filtro, { enabled: !!pipelineId });
  const lista = trpc.disparos.listar.useQuery(undefined, { refetchInterval: 30_000 });
  const criar = trpc.disparos.criar.useMutation({
    onSuccess: (d) => { setMsg(`Disparo criado com ${d.total} envio(s). Confira e clique em Iniciar.`); setNome(""); setMensagem(""); utils.disparos.listar.invalidate(); },
    onError: (e) => setMsg(e.message),
  });
  const mudar = trpc.disparos.mudarStatus.useMutation({ onSuccess: () => utils.disparos.listar.invalidate(), onError: (e) => setMsg(e.message) });

  const p = previa.data;
  const diasEstimados = p && p.enviar ? Math.ceil(p.enviar / Math.max(1, limiteDia)) : 0;

  return (
    <div className="bg-white border rounded-xl p-5 space-y-4">
      <div>
        <h2 className="font-semibold text-gray-800">Disparo segmentado</h2>
        <p className="text-xs text-gray-500 mt-0.5">
          Mensagem para um recorte do funil. Vai devagar (1 a cada {intervaloSeg}s, até {limiteDia}/dia, seg–sáb 8h–20h) para não bloquear o número.
        </p>
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        <div className="space-y-3">
          <select value={pipelineId} onChange={(e) => { setPipelineId(e.target.value); setStageIds([]); setTagIds([]); setPalavras([]); }}
            className="w-full border rounded-lg px-3 py-2 text-sm">
            <option value="">Escolha o funil…</option>
            {(pipelines.data ?? []).map((pl: any) => <option key={pl.id} value={pl.id}>{pl.nome}</option>)}
          </select>

          {opcoes.data && (
            <>
              <div>
                <p className="text-xs font-medium text-gray-600 mb-1">Etapas (nenhuma = todas)</p>
                <div className="flex flex-wrap gap-1">
                  {opcoes.data.stages.map((s) => <Chip key={s.id} cor={s.cor} ativo={stageIds.includes(s.id)} onClick={() => setStageIds(alternar(stageIds, s.id))}>{s.nome}</Chip>)}
                </div>
              </div>
              {opcoes.data.tags.length > 0 && (
                <div>
                  <p className="text-xs font-medium text-gray-600 mb-1">Etiquetas</p>
                  <div className="flex flex-wrap gap-1">
                    {opcoes.data.tags.map((t) => <Chip key={t.id} cor={t.cor} ativo={tagIds.includes(t.id)} onClick={() => setTagIds(alternar(tagIds, t.id))}>{t.nome}</Chip>)}
                  </div>
                </div>
              )}
              <div>
                <p className="text-xs font-medium text-gray-600 mb-1">Origem</p>
                <div className="flex flex-wrap gap-1">
                  {ORIGENS.map((o) => <Chip key={o.id} ativo={origemTipos.includes(o.id)} onClick={() => setOrigemTipos(alternar(origemTipos, o.id))}>{o.rotulo}</Chip>)}
                </div>
              </div>
              {opcoes.data.palavras.length > 0 && (
                <div>
                  <p className="text-xs font-medium text-gray-600 mb-1">Vídeo / palavra-chave</p>
                  <div className="flex flex-wrap gap-1">
                    {opcoes.data.palavras.map((w) => <Chip key={w.id} ativo={palavras.includes(w.id)} onClick={() => setPalavras(alternar(palavras, w.id))}>{w.id} ({w.n})</Chip>)}
                  </div>
                </div>
              )}
              <label className="flex items-center gap-2 text-xs text-gray-600">
                <input type="checkbox" checked={somenteQuemConversou} onChange={(e) => setSomenteQuemConversou(e.target.checked)} />
                Só quem já mandou mensagem alguma vez (recomendado — contato frio gera denúncia)
              </label>
              <label className="flex items-center gap-2 text-xs text-gray-600">
                Pular quem recebeu mensagem nossa nas últimas
                <input type="number" min={0} max={720} value={pularHoras} onChange={(e) => setPularHoras(Number(e.target.value))} className="w-16 border rounded px-1 py-0.5" />
                horas
              </label>
            </>
          )}
        </div>

        <div className="space-y-3">
          <input value={nome} onChange={(e) => setNome(e.target.value)} placeholder="Nome do disparo (ex.: Reativar Lead Qualificado — out/26)"
            className="w-full border rounded-lg px-3 py-2 text-sm" />
          <textarea rows={5} value={mensagem} onChange={(e) => setMensagem(e.target.value)}
            placeholder="Oi {nome}, tudo bem? Passando para saber se você ainda tem interesse em…"
            className="w-full border rounded-lg px-3 py-2 text-sm" />
          <p className="text-[11px] text-gray-400">{"{nome}"} = primeiro nome. Vai assinado com o seu nome em negrito, como as mensagens do painel.</p>
          <div className="flex items-center gap-3 text-xs text-gray-600">
            <label>Intervalo <input type="number" min={opcoes.data?.intervaloMin ?? 30} value={intervaloSeg} onChange={(e) => setIntervaloSeg(Number(e.target.value))} className="w-16 border rounded px-1 py-0.5" /> s</label>
            <label>Teto <input type="number" min={1} max={opcoes.data?.limiteMax ?? 300} value={limiteDia} onChange={(e) => setLimiteDia(Number(e.target.value))} className="w-16 border rounded px-1 py-0.5" /> /dia</label>
          </div>

          {p && (
            <div className="bg-gray-50 rounded-lg p-3 text-xs space-y-1">
              <p><b>{p.enviar}</b> de {p.total} leads recebem
                {Object.entries(p.porCanal).map(([c, n]) => ` · ${n} ${c}`).join("")}
                {diasEstimados > 1 ? ` · cerca de ${diasEstimados} dias para terminar` : ""}</p>
              {Object.entries(p.pulos).map(([m, n]) => <p key={m} className="text-gray-500">pulados: {n} — {m}</p>)}
              {p.exemplos.length > 0 && <p className="text-gray-400">ex.: {p.exemplos.map((e) => e.titulo).join(", ")}</p>}
            </div>
          )}

          <button
            disabled={!pipelineId || !nome.trim() || !mensagem.trim() || !p?.enviar || criar.isLoading}
            onClick={() => criar.mutate({ nome, mensagem, filtro, intervaloSeg, limiteDia })}
            className="bg-gray-900 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-black disabled:opacity-50"
          >
            {criar.isLoading ? "Criando…" : "Criar disparo (não envia ainda)"}
          </button>
          {msg && <p className="text-sm text-gray-600">{msg}</p>}
        </div>
      </div>

      {(lista.data ?? []).length > 0 && (
        <div className="border-t pt-3">
          <p className="text-xs font-medium text-gray-600 mb-2">Disparos</p>
          <div className="divide-y">
            {(lista.data ?? []).map((d: any) => (
              <div key={d.id} className="flex items-center gap-3 py-2 text-sm">
                <span className={`text-[11px] px-2 py-0.5 rounded-full ${STATUS[d.status] ?? ""}`}>{d.status}</span>
                <span className="flex-1 truncate">{d.nome}</span>
                <span className="text-xs text-gray-500">{d.enviados}/{d.total} enviados{d.falhas ? ` · ${d.falhas} falha(s)` : ""}{d.pulados ? ` · ${d.pulados} pulado(s)` : ""}</span>
                {(d.status === "rascunho" || d.status === "pausado") && (
                  <button onClick={() => mudar.mutate({ id: d.id, status: "enviando" })} className="text-xs text-green-700">Iniciar</button>
                )}
                {d.status === "enviando" && <button onClick={() => mudar.mutate({ id: d.id, status: "pausado" })} className="text-xs text-amber-700">Pausar</button>}
                {!["concluido", "cancelado"].includes(d.status) && (
                  <button onClick={() => mudar.mutate({ id: d.id, status: "cancelado" })} className="text-xs text-red-600">Cancelar</button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
