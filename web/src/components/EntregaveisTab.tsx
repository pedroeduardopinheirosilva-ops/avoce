import { useState } from "react";
import { trpc } from "../lib/trpc";

type Item = {
  id: string;
  chave: string;
  titulo: string;
  palavrasChave: string;
  legenda: string | null;
  arquivoTipo: string | null;
  arquivoNome: string | null;
  padrao: boolean;
  ativo: boolean;
  ordem: number;
  temArquivo: boolean;
  url: string | null;
  enviados: number;
};

/** Sugestões iniciais das dores mais comuns do carreteiro (mentoria 12/09/2026). */
const SUGESTOES = [
  { chave: "horas_extras", titulo: "Horas extras e jornada", palavrasChave: "hora extra|horas extras|jornada|madrugada|dirigia mais|sem folga|domingo|feriado" },
  { chave: "tempo_espera", titulo: "Tempo de espera", palavrasChave: "tempo de espera|espera|fila|carregamento|descarga|parado no cliente|aguardando carga" },
  { chave: "diarias_por_fora", titulo: "Diárias e pagamento por fora", palavrasChave: "diaria|diarias|por fora|pix|dinheiro em mao|comissao|premio" },
  { chave: "pernoite_cabine", titulo: "Pernoite na cabine e condições", palavrasChave: "pernoite|dormia no caminhao|cabine|banheiro|alojamento|rastreador bloqueado" },
  { chave: "carga_perigosa", titulo: "Carga perigosa (periculosidade)", palavrasChave: "carga perigosa|combustivel|inflamavel|quimico|produto perigoso|periculosidade|tanque" },
];

const TIPO_LABEL: Record<string, string> = { video: "🎬 Vídeo", image: "🖼 Imagem", document: "📄 PDF" };

export function EntregaveisTab({ projetoId }: { projetoId: string }) {
  const utils = trpc.useUtils();
  const lista = trpc.ia.listEntregaveis.useQuery({ projetoId });
  const salvar = trpc.ia.salvarEntregavel.useMutation({ onSuccess: () => utils.ia.listEntregaveis.invalidate() });
  const excluir = trpc.ia.excluirEntregavel.useMutation({ onSuccess: () => utils.ia.listEntregaveis.invalidate() });
  const setEtapa = trpc.ia.setEntregavelEtapa.useMutation({ onSuccess: () => utils.ia.listEntregaveis.invalidate() });
  const testar = trpc.ia.testarEntregavel.useMutation({
    onSuccess: () => alert("Enviado! Confira no WhatsApp de teste."),
    onError: (e) => alert("Erro no teste: " + e.message),
  });

  const [editando, setEditando] = useState<Record<string, Partial<Item>>>({});
  const [uploading, setUploading] = useState<string | null>(null);
  const [foneTeste, setFoneTeste] = useState(() => localStorage.getItem("avoce_fone_teste") ?? "");
  const [etapaLocal, setEtapaLocal] = useState<string | null>(null);

  const itens = (lista.data?.itens ?? []) as Item[];
  const jaExiste = new Set(itens.map((i) => i.chave));

  function campo<K extends keyof Item>(it: Item, k: K): Item[K] {
    const e = editando[it.id];
    return (e && k in e ? e[k] : it[k]) as Item[K];
  }
  function editar(id: string, patch: Partial<Item>) {
    setEditando((m) => ({ ...m, [id]: { ...m[id], ...patch } }));
  }
  function gravar(it: Item) {
    const e = editando[it.id] ?? {};
    salvar.mutate(
      {
        id: it.id, projetoId, chave: it.chave,
        titulo: (e.titulo ?? it.titulo).trim(),
        palavrasChave: (e.palavrasChave ?? it.palavrasChave).trim(),
        legenda: (e.legenda ?? it.legenda) || null,
        padrao: e.padrao ?? it.padrao,
        ativo: e.ativo ?? it.ativo,
      },
      { onSuccess: () => setEditando((m) => { const { [it.id]: _, ...r } = m; return r; }) },
    );
  }

  async function upload(id: string, file: File) {
    if (file.type.startsWith("video/") && file.size > 16 * 1024 * 1024) {
      if (!confirm("O WhatsApp recusa vídeos acima de 16 MB. Enviar mesmo assim?")) return;
    }
    setUploading(id);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const token = localStorage.getItem("avoce_token");
      const res = await fetch(`/api/ia-entregavel/${id}`, {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: fd,
      });
      if (!res.ok) throw new Error(await res.text());
      utils.ia.listEntregaveis.invalidate();
    } catch (e) {
      alert("Erro ao enviar arquivo: " + (e instanceof Error ? e.message : e));
    } finally {
      setUploading(null);
    }
  }

  return (
    <div className="space-y-5">
      <div className="bg-indigo-50 border border-indigo-200 rounded-xl p-4 text-sm text-indigo-900 space-y-1.5">
        <p className="font-semibold">Vídeo curto sobre a dor do lead, enviado ao fim da triagem</p>
        <p>
          Quando o lead entra na etapa abaixo, a IA escolhe o entregável cujas palavras-chave mais aparecem no que ele
          contou e envia uma única vez. Quem não casar com nenhum recebe o marcado como <b>padrão</b>. Só entra quem
          chegou na etapa nas últimas 72h, e o envio respeita o horário de silêncio.
        </p>
        <p className="text-indigo-700">
          Vídeo vertical, 60–90s, até 16 MB. Sem valores de condenação e sem promessa de resultado (Provimento 205/2021 da OAB).
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3 bg-white border rounded-xl p-4">
        <label className="text-sm">
          <span className="block text-xs font-medium text-gray-500 mb-1">Enviar quando o lead entrar na etapa (chave)</span>
          <input
            value={etapaLocal ?? lista.data?.etapa ?? ""}
            onChange={(e) => setEtapaLocal(e.target.value)}
            className="border rounded-lg px-3 py-1.5 text-sm w-64 font-mono"
            placeholder="lead_qualificado"
          />
        </label>
        <button
          disabled={etapaLocal === null || !etapaLocal.trim()}
          onClick={() => etapaLocal && setEtapa.mutate({ projetoId, etapa: etapaLocal.trim() }, { onSuccess: () => setEtapaLocal(null) })}
          className="px-3 py-1.5 text-sm rounded-lg bg-indigo-600 text-white disabled:opacity-40"
        >
          Salvar etapa
        </button>
        <label className="text-sm ml-auto">
          <span className="block text-xs font-medium text-gray-500 mb-1">WhatsApp para testes</span>
          <input
            value={foneTeste}
            onChange={(e) => { setFoneTeste(e.target.value); try { localStorage.setItem("avoce_fone_teste", e.target.value); } catch { /* */ } }}
            className="border rounded-lg px-3 py-1.5 text-sm w-48"
            placeholder="5577999999999"
          />
        </label>
      </div>

      {lista.isLoading && <p className="text-sm text-gray-400">Carregando…</p>}

      {itens.map((it) => {
        const sujo = !!editando[it.id];
        return (
          <div key={it.id} className={`bg-white border rounded-xl p-4 ${!campo(it, "ativo") ? "opacity-60" : ""}`}>
            <div className="flex flex-wrap items-center gap-2 mb-3">
              <input
                value={campo(it, "titulo")}
                onChange={(e) => editar(it.id, { titulo: e.target.value })}
                className="font-semibold text-gray-800 border-b border-transparent hover:border-gray-300 focus:border-indigo-400 outline-none px-1 flex-1 min-w-[12rem]"
              />
              <span className="text-xs font-mono text-gray-400">{it.chave}</span>
              <span className="text-xs text-gray-500 bg-gray-100 px-2 py-0.5 rounded-full">{it.enviados} enviado(s)</span>
              <label className="flex items-center gap-1 text-xs text-gray-600">
                <input type="checkbox" checked={campo(it, "padrao")} onChange={(e) => editar(it.id, { padrao: e.target.checked })} /> padrão
              </label>
              <label className="flex items-center gap-1 text-xs text-gray-600">
                <input type="checkbox" checked={campo(it, "ativo")} onChange={(e) => editar(it.id, { ativo: e.target.checked })} /> ativo
              </label>
            </div>

            <div className="grid md:grid-cols-[1fr_16rem] gap-4">
              <div className="space-y-3">
                <label className="block text-sm">
                  <span className="block text-xs font-medium text-gray-500 mb-1">Palavras-chave (separe por | ; acentos são ignorados)</span>
                  <textarea
                    value={campo(it, "palavrasChave")}
                    onChange={(e) => editar(it.id, { palavrasChave: e.target.value })}
                    rows={2}
                    className="w-full border rounded-lg px-3 py-1.5 text-sm font-mono"
                  />
                </label>
                <label className="block text-sm">
                  <span className="block text-xs font-medium text-gray-500 mb-1">Legenda enviada junto (opcional)</span>
                  <textarea
                    value={campo(it, "legenda") ?? ""}
                    onChange={(e) => editar(it.id, { legenda: e.target.value })}
                    rows={2}
                    placeholder="Ex.: A Dra. Daniela gravou esse vídeo rapidinho sobre horas extras do motorista. Dá uma olhada!"
                    className="w-full border rounded-lg px-3 py-1.5 text-sm"
                  />
                </label>
                <div className="flex flex-wrap gap-2">
                  <button
                    disabled={!sujo || salvar.isLoading}
                    onClick={() => gravar(it)}
                    className="px-3 py-1.5 text-sm rounded-lg bg-indigo-600 text-white disabled:opacity-40"
                  >
                    Salvar
                  </button>
                  <button
                    disabled={!it.temArquivo || !foneTeste.trim() || testar.isLoading}
                    onClick={() => testar.mutate({ id: it.id, whatsapp: foneTeste })}
                    title={!foneTeste.trim() ? "Preencha o WhatsApp para testes acima" : "Envia só para o número de teste"}
                    className="px-3 py-1.5 text-sm rounded-lg bg-green-100 text-green-800 hover:bg-green-200 disabled:opacity-40"
                  >
                    Enviar teste
                  </button>
                  <button
                    onClick={() => confirm(`Excluir "${it.titulo}"?`) && excluir.mutate({ id: it.id })}
                    className="px-3 py-1.5 text-sm rounded-lg text-red-600 hover:bg-red-50 ml-auto"
                  >
                    Excluir
                  </button>
                </div>
              </div>

              <div className="border rounded-lg p-2 bg-gray-50 flex flex-col items-center justify-center gap-2 min-h-[10rem]">
                {it.url && it.arquivoTipo === "video" && (
                  <video src={`${it.url}?t=${it.arquivoNome}`} controls className="max-h-56 rounded" />
                )}
                {it.url && it.arquivoTipo === "image" && <img src={it.url} alt="" className="max-h-56 rounded" />}
                {it.url && it.arquivoTipo === "document" && (
                  <a href={it.url} target="_blank" rel="noreferrer" className="text-sm text-indigo-600 underline">{it.arquivoNome}</a>
                )}
                {!it.temArquivo && <p className="text-xs text-amber-700 text-center">Sem arquivo — não é enviado até subir o vídeo.</p>}
                <label className="text-xs px-3 py-1 rounded-lg bg-white border cursor-pointer hover:bg-gray-100">
                  {uploading === it.id ? "Enviando…" : it.temArquivo ? `Trocar ${TIPO_LABEL[it.arquivoTipo ?? "document"]}` : "Subir vídeo / imagem / PDF"}
                  <input
                    type="file"
                    accept="video/*,image/*,application/pdf"
                    className="hidden"
                    onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) upload(it.id, f); }}
                  />
                </label>
              </div>
            </div>
          </div>
        );
      })}

      <div className="bg-white border border-dashed rounded-xl p-4">
        <p className="text-sm font-medium text-gray-700 mb-2">Adicionar entregável</p>
        <div className="flex flex-wrap gap-2">
          {SUGESTOES.filter((s) => !jaExiste.has(s.chave)).map((s, i) => (
            <button
              key={s.chave}
              onClick={() => salvar.mutate({ projetoId, ...s, ordem: itens.length + i, ativo: true })}
              className="text-sm px-3 py-1.5 rounded-lg border hover:border-indigo-400 hover:text-indigo-700"
            >
              + {s.titulo}
            </button>
          ))}
          {!jaExiste.has("direitos_gerais") && (
            <button
              onClick={() => salvar.mutate({
                projetoId, chave: "direitos_gerais", titulo: "Direitos do motorista (padrão)",
                palavrasChave: "", padrao: true, ativo: true, ordem: 99,
              })}
              className="text-sm px-3 py-1.5 rounded-lg border hover:border-indigo-400 hover:text-indigo-700"
            >
              + Padrão (quem não casar com nenhum)
            </button>
          )}
          <button
            onClick={() => {
              const chave = prompt("Chave (letras minúsculas e _), ex.: acumulo_funcao")?.trim();
              if (!chave) return;
              const titulo = prompt("Título")?.trim() || chave;
              salvar.mutate(
                { projetoId, chave, titulo, palavrasChave: "", ativo: true, ordem: itens.length },
                { onError: (e) => alert(e.message) },
              );
            }}
            className="text-sm px-3 py-1.5 rounded-lg border border-dashed hover:border-indigo-400"
          >
            + Outro…
          </button>
        </div>
      </div>
    </div>
  );
}
