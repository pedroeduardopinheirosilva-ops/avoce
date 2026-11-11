import { useEffect, useState } from "react";
import { trpc } from "../lib/trpc";

/**
 * Editor das automações do Instagram/Messenger (server/src/lib/meta-automacoes.ts):
 * gatilho + passos em sequência; botões e condições levam a outra automação.
 */
type Midia = { arquivo: string; nome: string; mime: string };
type Botao = { titulo: string; vaiPara?: string; url?: string };
type Cartao = { titulo: string; subtitulo?: string; imagem?: Midia | null; botoes: Botao[] };
type Passo =
  | { tipo: "texto"; texto: string; botoes?: Botao[] }
  | { tipo: "imagem" | "video" | "audio" | "arquivo"; midia: Midia }
  | { tipo: "cartoes"; cartoes: Cartao[] }
  | { tipo: "esperar"; segundos: number }
  | { tipo: "condicao"; se: string; valor?: string; entao?: string; senao?: string }
  | { tipo: "pedir_whatsapp"; texto: string }
  | { tipo: "acao"; acao: string; valor: string }
  | { tipo: "ir_para"; automacao: string };
type Gatilho = { tipo: string; palavras?: string[]; posts?: string[]; publico?: string; ref?: string };
type Automacao = { id: string; nome: string; ativo: boolean; canais: string[]; gatilho: Gatilho; umaVez24h: boolean; passos: Passo[] };

const GATILHOS: Record<string, string> = {
  comentario: "💬 Comentário em post/Reel/Live",
  dm_palavra: "🔑 Palavra-chave no Direct/Messenger",
  dm_primeira: "👋 1ª mensagem da conversa",
  story_resposta: "↩️ Resposta a story",
  story_mencao: "📣 Menção em story",
  link: "🔗 Link ig.me / m.me com ?ref=",
  botao: "🔘 Só quando chamada (botão, condição, ir para)",
};
const PASSOS: Record<string, string> = {
  texto: "💬 Texto", imagem: "🖼 Imagem", video: "🎬 Vídeo", audio: "🎧 Áudio", arquivo: "📄 PDF",
  cartoes: "🗂 Cartões", esperar: "⏱ Esperar", condicao: "❓ Condição", pedir_whatsapp: "📲 Pedir WhatsApp",
  acao: "🏷 Ação", ir_para: "↪️ Ir para",
};
const CONDICOES: Record<string, string> = {
  segue_perfil: "segue o perfil (Instagram)", tem_whatsapp: "já informou o WhatsApp",
  canal_instagram: "veio pelo Instagram", tem_tag: "tem a tag",
};
const ACEITA: Record<string, string> = {
  imagem: ".png,.jpg,.jpeg,.gif", video: ".mp4,.mov,.webm,.ogg", audio: ".m4a,.aac,.wav,.mp3,.mp4", arquivo: ".pdf",
};

const novoId = () => Math.random().toString(36).slice(2, 10);
const passoVazio = (tipo: string): Passo => {
  switch (tipo) {
    case "texto": return { tipo: "texto", texto: "", botoes: [] };
    case "cartoes": return { tipo: "cartoes", cartoes: [{ titulo: "", subtitulo: "", imagem: null, botoes: [] }] };
    case "esperar": return { tipo: "esperar", segundos: 3 };
    case "condicao": return { tipo: "condicao", se: "segue_perfil", entao: "", senao: "" };
    case "pedir_whatsapp": return { tipo: "pedir_whatsapp", texto: "Me passa seu WhatsApp com DDD que a nossa equipe te chama por lá 📲" };
    case "acao": return { tipo: "acao", acao: "tag", valor: "" };
    case "ir_para": return { tipo: "ir_para", automacao: "" };
    default: return { tipo: tipo as any, midia: { arquivo: "", nome: "", mime: "" } };
  }
};

async function subirMidia(projetoId: string, file: File): Promise<Midia> {
  const fd = new FormData();
  fd.append("file", file);
  const r = await fetch(`/api/meta/midia/${projetoId}`, {
    method: "POST", body: fd, headers: { Authorization: `Bearer ${localStorage.getItem("avoce_token") ?? ""}` },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `Falha no upload (${r.status})`);
  return j as Midia;
}

const input = "border rounded-lg px-3 py-2 text-sm w-full bg-white";

type Ctx = { lista: Automacao[]; base: string; projetoId: string; setMsg: (m: string) => void; set: (id: string, patch: Partial<Automacao>) => void };

const SelectAut = ({ ctx, valor, onChange, excluir, vazio }: { ctx: Ctx; valor?: string; onChange: (v: string) => void; excluir?: string; vazio: string }) => (
  <select value={valor ?? ""} onChange={(e) => onChange(e.target.value)} className={input}>
    <option value="">{vazio}</option>
    {ctx.lista.filter((a) => a.id !== excluir).map((a) => <option key={a.id} value={a.id}>{a.nome}</option>)}
  </select>
);

function MidiaCampo({ ctx, tipo, midia, onChange }: { ctx: Ctx; tipo: string; midia?: Midia | null; onChange: (m: Midia) => void }) {
  const [subindo, setSubindo] = useState(false);
  const url = midia?.arquivo ? ctx.base + midia.arquivo : "";
  return (
    <div className="space-y-2">
      {url && tipo === "imagem" && <img src={url} className="max-h-32 rounded border" />}
      {url && tipo === "video" && <video src={url} controls className="max-h-40 rounded border" />}
      {url && tipo === "audio" && <audio src={url} controls className="w-full" />}
      {url && tipo === "arquivo" && <a href={url} target="_blank" rel="noreferrer" className="text-sm text-indigo-600">📄 {midia?.nome}</a>}
      <label className="inline-block text-sm text-indigo-600 cursor-pointer">
        {subindo ? "Enviando…" : url ? "Trocar arquivo" : "Escolher arquivo"}
        <input type="file" accept={ACEITA[tipo]} className="hidden" onChange={async (e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          setSubindo(true);
          try { onChange(await subirMidia(ctx.projetoId, f)); ctx.setMsg(""); } catch (err: any) { ctx.setMsg(err.message); }
          setSubindo(false);
        }} />
      </label>
    </div>
  );
}

const BotoesEditor = ({ ctx, botoes, onChange, max, comLink }: { ctx: Ctx; botoes: Botao[]; onChange: (b: Botao[]) => void; max: number; comLink?: boolean; excluir: string }) => (
  <div className="space-y-1.5">
    {botoes.map((b, i) => (
      <div key={i} className="grid grid-cols-[1fr_1.4fr_auto] gap-2 items-center">
        <input value={b.titulo} maxLength={20} placeholder="Texto do botão" className={input}
          onChange={(e) => onChange(botoes.map((x, j) => (j === i ? { ...x, titulo: e.target.value } : x)))} />
        {comLink && b.url !== undefined ? (
          <input value={b.url} placeholder="https://…" className={input}
            onChange={(e) => onChange(botoes.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)))} />
        ) : (
          <SelectAut ctx={ctx} valor={b.vaiPara} excluir={undefined} vazio="(só registra a escolha)"
            onChange={(v) => onChange(botoes.map((x, j) => (j === i ? { ...x, vaiPara: v || undefined } : x)))} />
        )}
        <button onClick={() => onChange(botoes.filter((_, j) => j !== i))} className="text-xs text-red-500">✕</button>
      </div>
    ))}
    {botoes.length < max && (
      <div className="flex gap-3">
        <button onClick={() => onChange([...botoes, { titulo: "" }])} className="text-xs text-indigo-600">+ botão</button>
        {comLink && <button onClick={() => onChange([...botoes, { titulo: "", url: "" }])} className="text-xs text-indigo-600">+ botão de link</button>}
      </div>
    )}
  </div>
);

function PassoEditor({ ctx, a, p, i }: { ctx: Ctx; a: Automacao; p: Passo; i: number }) {
  const { set } = ctx;
  const mudar = (np: Passo) => set(a.id, { passos: a.passos.map((x, j) => (j === i ? np : x)) });
  const mover = (d: number) => {
    const ps = [...a.passos]; const j = i + d;
    if (j < 0 || j >= ps.length) return;
    [ps[i], ps[j]] = [ps[j], ps[i]];
    set(a.id, { passos: ps });
  };
  return (
    <div className="border rounded-lg p-3 bg-white space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-gray-700">{i + 1}. {PASSOS[p.tipo]}</span>
        <span className="flex gap-2 text-xs">
          <button onClick={() => mover(-1)} className="text-gray-500">↑</button>
          <button onClick={() => mover(1)} className="text-gray-500">↓</button>
          <button onClick={() => set(a.id, { passos: a.passos.filter((_, j) => j !== i) })} className="text-red-500">remover</button>
        </span>
      </div>
      {(p.tipo === "texto" || p.tipo === "pedir_whatsapp") && (
        <textarea rows={3} value={p.texto} className={input} placeholder="Use {nome} para o primeiro nome"
          onChange={(e) => mudar({ ...p, texto: e.target.value })} />
      )}
      {p.tipo === "texto" && (
        <>
          <p className="text-xs text-gray-400">Botões (até 13). Com botões, a automação para aqui e segue pela automação do botão escolhido.</p>
          <BotoesEditor ctx={ctx} botoes={p.botoes ?? []} max={13} excluir={a.id} onChange={(b) => mudar({ ...p, botoes: b })} />
        </>
      )}
      {(p.tipo === "imagem" || p.tipo === "video" || p.tipo === "audio" || p.tipo === "arquivo") && (
        <MidiaCampo ctx={ctx} tipo={p.tipo} midia={p.midia} onChange={(m) => mudar({ ...p, midia: m })} />
      )}
      {p.tipo === "cartoes" && (
        <div className="space-y-3">
          {p.cartoes.map((c, ci) => {
            const mc = (nc: Cartao) => mudar({ ...p, cartoes: p.cartoes.map((x, j) => (j === ci ? nc : x)) });
            return (
              <div key={ci} className="border rounded p-2 space-y-1.5 bg-gray-50">
                <div className="flex justify-between text-xs text-gray-500">
                  <span>Cartão {ci + 1}</span>
                  <button onClick={() => mudar({ ...p, cartoes: p.cartoes.filter((_, j) => j !== ci) })} className="text-red-500">remover</button>
                </div>
                <input value={c.titulo} maxLength={80} placeholder="Título" className={input} onChange={(e) => mc({ ...c, titulo: e.target.value })} />
                <input value={c.subtitulo ?? ""} maxLength={80} placeholder="Subtítulo" className={input} onChange={(e) => mc({ ...c, subtitulo: e.target.value })} />
                <MidiaCampo ctx={ctx} tipo="imagem" midia={c.imagem} onChange={(m) => mc({ ...c, imagem: m })} />
                <BotoesEditor ctx={ctx} botoes={c.botoes} max={3} comLink excluir={a.id} onChange={(b) => mc({ ...c, botoes: b })} />
              </div>
            );
          })}
          {p.cartoes.length < 10 && (
            <button onClick={() => mudar({ ...p, cartoes: [...p.cartoes, { titulo: "", subtitulo: "", imagem: null, botoes: [] }] })}
              className="text-xs text-indigo-600">+ cartão (vira carrossel)</button>
          )}
        </div>
      )}
      {p.tipo === "esperar" && (
        <label className="flex items-center gap-2 text-sm">
          <input type="number" min={1} max={600} value={p.segundos} className="border rounded px-2 py-1 w-24"
            onChange={(e) => mudar({ ...p, segundos: Number(e.target.value) || 1 })} /> segundos (máx. 600)
        </label>
      )}
      {p.tipo === "condicao" && (
        <div className="space-y-1.5 text-sm">
          <div className="grid grid-cols-[auto_1fr_1fr] gap-2 items-center">
            <span>Se o lead</span>
            <select value={p.se} className={input} onChange={(e) => mudar({ ...p, se: e.target.value })}>
              {Object.entries(CONDICOES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            {p.se === "tem_tag" ? <input value={p.valor ?? ""} placeholder="nome da tag" className={input} onChange={(e) => mudar({ ...p, valor: e.target.value })} /> : <span />}
          </div>
          <div className="grid grid-cols-[auto_1fr] gap-2 items-center">
            <span>Sim →</span>
            <SelectAut ctx={ctx} valor={p.entao} excluir={a.id} vazio="continua nesta automação" onChange={(v) => mudar({ ...p, entao: v })} />
            <span>Não →</span>
            <SelectAut ctx={ctx} valor={p.senao} excluir={a.id} vazio="para aqui" onChange={(v) => mudar({ ...p, senao: v })} />
          </div>
        </div>
      )}
      {p.tipo === "acao" && (
        <div className="grid grid-cols-[1fr_1.5fr] gap-2">
          <select value={p.acao} className={input} onChange={(e) => mudar({ ...p, acao: e.target.value })}>
            <option value="tag">Adicionar tag</option>
            <option value="etapa">Mover para a etapa do funil</option>
            <option value="nota">Anotar no deal</option>
          </select>
          <input value={p.valor} className={input} placeholder={p.acao === "etapa" ? "nome da etapa (ex.: Pré-qualificação)" : p.acao === "tag" ? "nome da tag" : "texto da nota"}
            onChange={(e) => mudar({ ...p, valor: e.target.value })} />
        </div>
      )}
      {p.tipo === "ir_para" && (
        <SelectAut ctx={ctx} valor={p.automacao} excluir={a.id} vazio="escolha a automação" onChange={(v) => mudar({ ...p, automacao: v })} />
      )}
    </div>
  );
}

export function AutomacoesMeta({ projetoId }: { projetoId: string }) {
  const st = trpc.metaSocial.status.useQuery({ projetoId });
  const [lista, setLista] = useState<Automacao[]>([]);
  const [aberta, setAberta] = useState<string | null>(null);
  const [msg, setMsg] = useState("");

  useEffect(() => { if (st.data) setLista(st.data.automacoes as any); }, [st.data]);

  const salvar = trpc.metaSocial.salvar.useMutation({
    onSuccess: () => { setMsg("Automações salvas."); st.refetch(); },
    onError: (e) => setMsg(e.message),
  });

  if (!st.data) return null;
  const base = st.data.midiaBase;
  const set = (id: string, patch: Partial<Automacao>) => setLista(lista.map((a) => (a.id === id ? { ...a, ...patch } : a)));
  const ctx: Ctx = { lista, base, projetoId, setMsg, set };

  const resumoGatilho = (g: Gatilho) => {
    const t = GATILHOS[g.tipo] ?? g.tipo;
    if ((g.tipo === "comentario" || g.tipo === "dm_palavra") && g.palavras?.length) return `${t}: ${g.palavras.join(", ")}`;
    if (g.tipo === "comentario") return `${t}: qualquer`;
    if (g.tipo === "link") return `${t}: ${g.ref}`;
    return t;
  };

  return (
    <div className="bg-white border rounded-xl p-5 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="font-semibold text-gray-800">Automações</h3>
          <p className="text-xs text-gray-500">
            Gatilho + passos (texto, áudio, vídeo, PDF, imagem, cartões, espera, condição, ação). São a única fonte de
            resposta automática no Direct, nos comentários e nos stories.
          </p>
        </div>
      </div>

      {!lista.some((a) => a.ativo) && (
        <p className="text-sm bg-amber-50 border border-amber-200 text-amber-800 rounded-lg px-3 py-2">
          Nenhuma automação ativa: Direct, comentários e stories ficam sem resposta automática — só a equipe responde.
        </p>
      )}

      <div className="divide-y border rounded-lg">
        {lista.map((a) => (
          <div key={a.id} className="p-3 space-y-3">
            <div className="flex items-center gap-3">
              <input type="checkbox" checked={a.ativo} onChange={(e) => set(a.id, { ativo: e.target.checked })} title="Ativa" />
              <button onClick={() => setAberta(aberta === a.id ? null : a.id)} className="flex-1 text-left">
                <span className="font-medium text-gray-800">{a.nome}</span>
                <span className="block text-xs text-gray-500">{resumoGatilho(a.gatilho)} · {a.passos.length} passo(s)</span>
              </button>
              <button onClick={() => { if (confirm(`Apagar a automação "${a.nome}"?`)) setLista(lista.filter((x) => x.id !== a.id)); }}
                className="text-xs text-red-500">apagar</button>
            </div>

            {aberta === a.id && (
              <div className="space-y-3 pl-6">
                <div className="grid sm:grid-cols-2 gap-2">
                  <input value={a.nome} className={input} placeholder="Nome" onChange={(e) => set(a.id, { nome: e.target.value })} />
                  <select value={a.gatilho.tipo} className={input}
                    onChange={(e) => set(a.id, { gatilho: { tipo: e.target.value, palavras: [], posts: [], publico: "", ref: "" } })}>
                    {Object.entries(GATILHOS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                </div>
                {(a.gatilho.tipo === "comentario" || a.gatilho.tipo === "dm_palavra") && (
                  <input value={(a.gatilho.palavras ?? []).join(", ")} className={input}
                    placeholder={a.gatilho.tipo === "comentario" ? "Palavras (vazio = qualquer comentário)" : "Palavras, separadas por vírgula"}
                    onChange={(e) => set(a.id, { gatilho: { ...a.gatilho, palavras: e.target.value.split(",").map((x) => x.trim()) } })} />
                )}
                {a.gatilho.tipo === "comentario" && (
                  <>
                    <textarea rows={2} value={(a.gatilho.posts ?? []).join("\n")} className={input} placeholder="Só nestes posts/Reels (links, um por linha) — vazio = todos"
                      onChange={(e) => set(a.id, { gatilho: { ...a.gatilho, posts: e.target.value.split("\n") } })} />
                    <input value={a.gatilho.publico ?? ""} className={input} placeholder="Resposta pública no comentário (opcional)"
                      onChange={(e) => set(a.id, { gatilho: { ...a.gatilho, publico: e.target.value } })} />
                    <p className="text-xs text-amber-700 bg-amber-50 rounded p-2">
                      A Meta só deixa UMA resposta privada por comentário: o 1º texto vai na hora; o resto segue quando o lead tocar
                      no botão ou responder. Comece com um passo de texto.
                    </p>
                  </>
                )}
                {a.gatilho.tipo === "link" && (
                  <input value={a.gatilho.ref ?? ""} className={input} placeholder="ref do link (ex.: REEL_FILA)"
                    onChange={(e) => set(a.id, { gatilho: { ...a.gatilho, ref: e.target.value } })} />
                )}
                <div className="flex flex-wrap gap-4 text-sm">
                  <label className="flex items-center gap-1.5">
                    <input type="checkbox" checked={a.canais.includes("instagram")}
                      onChange={(e) => set(a.id, { canais: e.target.checked ? [...a.canais, "instagram"] : a.canais.filter((c) => c !== "instagram") })} /> Instagram
                  </label>
                  <label className="flex items-center gap-1.5">
                    <input type="checkbox" checked={a.canais.includes("messenger")}
                      onChange={(e) => set(a.id, { canais: e.target.checked ? [...a.canais, "messenger"] : a.canais.filter((c) => c !== "messenger") })} /> Facebook
                  </label>
                  <label className="flex items-center gap-1.5">
                    <input type="checkbox" checked={a.umaVez24h} onChange={(e) => set(a.id, { umaVez24h: e.target.checked })} /> No máximo 1 vez a cada 24h por pessoa
                  </label>
                </div>

                <div className="space-y-2">
                  {a.passos.map((p, i) => <PassoEditor key={i} ctx={ctx} a={a} p={p} i={i} />)}
                </div>
                <div className="flex flex-wrap gap-2">
                  {Object.entries(PASSOS).map(([k, v]) => (
                    <button key={k} onClick={() => set(a.id, { passos: [...a.passos, passoVazio(k)] })}
                      className="text-xs border rounded-full px-2.5 py-1 hover:bg-gray-50">+ {v}</button>
                  ))}
                </div>
              </div>
            )}
          </div>
        ))}
        {!lista.length && <p className="p-3 text-sm text-gray-400">Nenhuma automação.</p>}
      </div>

      <div className="flex items-center gap-3">
        <button onClick={() => {
          const id = novoId();
          setLista([...lista, { id, nome: "Nova automação", ativo: true, canais: ["instagram", "messenger"], gatilho: { tipo: "dm_palavra", palavras: [] }, umaVez24h: false, passos: [passoVazio("texto")] }]);
          setAberta(id);
        }} className="text-sm text-indigo-600">+ automação</button>
        <button onClick={() => salvar.mutate({ projetoId, automacoes: lista })} disabled={salvar.isLoading}
          className="bg-gray-900 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-black disabled:opacity-50">
          {salvar.isLoading ? "Salvando…" : "Salvar automações"}
        </button>
        {msg && <span className="text-sm text-gray-600">{msg}</span>}
      </div>
    </div>
  );
}
