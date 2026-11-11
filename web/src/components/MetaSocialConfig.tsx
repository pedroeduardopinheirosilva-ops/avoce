import { useEffect, useState } from "react";
import { trpc } from "../lib/trpc";
import { AutomacoesMeta } from "./AutomacoesMeta";

/**
 * Instagram Direct + Messenger (Página do Facebook) no CRM — server/src/lib/meta-social.ts.
 * Mensagens do Direct/Messenger viram conversa no WhatsApp IA (selo IG/FB) e deal no funil de
 * entrada. Toda resposta automática (Direct, comentário, story) sai das Automações; aqui ficam
 * a conexão, os ice breakers, a passagem para o WhatsApp e os links com ?ref=.
 */
type IceBreaker = { pergunta: string; resposta: string };

export function MetaSocialConfig({ projetoId }: { projetoId: string }) {
  const st = trpc.metaSocial.status.useQuery({ projetoId });
  const [form, setForm] = useState({
    page_token: "", app_secret: "", palavras: "", whatsapp_abertura: "", telefone_resposta: "", whatsapp_numero: "",
  });
  const [ice, setIce] = useState<IceBreaker[]>([]);
  const [msg, setMsg] = useState("");
  const [copiado, setCopiado] = useState("");

  useEffect(() => {
    if (!st.data) return;
    setForm((f) => ({
      ...f,
      palavras: st.data.palavras,
      whatsapp_abertura: st.data.whatsappAbertura,
      telefone_resposta: st.data.telefoneResposta,
      whatsapp_numero: st.data.whatsappNumero,
    }));
    setIce(st.data.iceBreakers);
  }, [st.data]);

  const salvar = trpc.metaSocial.salvar.useMutation({
    onSuccess: (r) => { setMsg(r.aviso ?? "Salvo."); setForm((f) => ({ ...f, page_token: "", app_secret: "" })); st.refetch(); },
    onError: (e) => setMsg(e.message),
  });
  const conectar = trpc.metaSocial.conectar.useMutation({
    onSuccess: (r) => {
      setMsg(`Conectado: Página "${r.pageNome}"${r.igUsername ? ` + Instagram @${r.igUsername}` : " (nenhum Instagram ligado à Página)"}.`);
      st.refetch();
    },
    onError: (e) => setMsg(e.message),
  });

  const d = st.data;
  if (!d) return <p className="text-sm text-gray-400">Carregando…</p>;
  const campo = (k: keyof typeof form, label: string, opts?: { area?: boolean; senha?: boolean; ph?: string }) => (
    <label className="block">
      <span className="text-xs font-medium text-gray-600">{label}</span>
      {opts?.area ? (
        <textarea rows={3} value={form[k]} placeholder={opts.ph} onChange={(e) => setForm({ ...form, [k]: e.target.value })}
          className="mt-1 w-full border rounded-lg px-3 py-2 text-sm" />
      ) : (
        <input type={opts?.senha ? "password" : "text"} value={form[k]} placeholder={opts?.ph}
          onChange={(e) => setForm({ ...form, [k]: e.target.value })}
          className="mt-1 w-full border rounded-lg px-3 py-2 text-sm" />
      )}
    </label>
  );
  const copiar = async (url: string) => {
    try { await navigator.clipboard.writeText(url); setCopiado(url); setTimeout(() => setCopiado(""), 1500); } catch { /* sem permissão */ }
  };
  const Link = ({ url, rotulo }: { url: string | null; rotulo: string }) =>
    url ? (
      <button onClick={() => copiar(url)} title={url}
        className={`text-xs px-2 py-0.5 rounded border ${copiado === url ? "bg-green-50 border-green-300 text-green-700" : "border-gray-200 text-gray-600 hover:bg-gray-50"}`}>
        {copiado === url ? "copiado" : rotulo}
      </button>
    ) : <span className="text-xs text-gray-300">{rotulo}</span>;

  return (
    <div className="space-y-5">
      <div className="bg-white border rounded-xl p-5 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-semibold text-gray-800">Instagram Direct e Messenger</h3>
            <p className="text-xs text-gray-500 mt-0.5">
              {d.pageId ? `Página ${d.pageId}${d.igId ? ` · Instagram ${d.igUsername ? "@" + d.igUsername : d.igId}` : " · sem Instagram ligado"}` : "Ainda não conectado"}
              {" · "}{d.conversas} conversa(s) · {d.mensagens7d} mensagem(ns) recebida(s) em 7 dias
            </p>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={d.ativo} disabled={!d.pageId}
              onChange={(e) => salvar.mutate({ projetoId, ativo: e.target.checked })} />
            Ativo
          </label>
        </div>

        <div className="grid sm:grid-cols-2 gap-3 text-xs bg-gray-50 rounded-lg p-3">
          <div><span className="text-gray-500">URL do webhook (no app da Meta)</span><p className="font-mono break-all">{d.webhookUrl}</p></div>
          <div><span className="text-gray-500">Verify token</span><p className="font-mono break-all">{d.verifyToken}</p></div>
        </div>

        <div className="grid sm:grid-cols-2 gap-3">
          {campo("page_token", `Token da Página ${d.temToken ? "(salvo — deixe em branco para manter)" : ""}`, { senha: true })}
          {campo("app_secret", `Chave secreta do app ${d.temSegredo ? "(salva)" : ""}`, { senha: true })}
        </div>
      </div>

      <AutomacoesMeta projetoId={projetoId} />

      <div className="bg-white border rounded-xl p-5 space-y-3">
        <h3 className="font-semibold text-gray-800">Perguntas prontas (ice breakers)</h3>
        <p className="text-xs text-gray-500">Aparecem como botões quando a pessoa abre o Direct ou o Messenger pela primeira vez. Até 4.</p>
        {ice.map((ib, i) => (
          <div key={i} className="grid sm:grid-cols-[1fr_2fr_auto] gap-2 items-start">
            <input value={ib.pergunta} maxLength={80} placeholder="Pergunta (ex.: Fui demitido)"
              onChange={(e) => setIce(ice.map((x, j) => (j === i ? { ...x, pergunta: e.target.value } : x)))}
              className="border rounded-lg px-3 py-2 text-sm" />
            <textarea rows={2} value={ib.resposta} placeholder="Resposta automática (opcional)"
              onChange={(e) => setIce(ice.map((x, j) => (j === i ? { ...x, resposta: e.target.value } : x)))}
              className="border rounded-lg px-3 py-2 text-sm" />
            <button onClick={() => setIce(ice.filter((_, j) => j !== i))} className="text-xs text-red-500 px-2 py-2">remover</button>
          </div>
        ))}
        {ice.length < 4 && (
          <button onClick={() => setIce([...ice, { pergunta: "", resposta: "" }])} className="text-sm text-indigo-600">+ pergunta</button>
        )}
      </div>

      <div className="bg-white border rounded-xl p-5 space-y-3">
        <h3 className="font-semibold text-gray-800">Do Direct para o WhatsApp</h3>
        <p className="text-xs text-gray-500">
          Quando o lead escreve o celular no Direct, o número entra no contato — se já existir alguém com esse WhatsApp, as duas
          conversas viram um lead só. Com a mensagem abaixo preenchida, o Avoce chama no WhatsApp e a IA assume a qualificação lá.
        </p>
        {campo("whatsapp_abertura", "1ª mensagem no WhatsApp (vazio = só grava o número)", {
          area: true, ph: "Oi {nome}, aqui é a Isabella da RAP! Você falou com a gente pelo Instagram. Me conta: você é motorista carreteiro?",
        })}
        {campo("telefone_resposta", "Confirmação no Direct", { ph: "Perfeito! Acabei de te chamar no WhatsApp 👍" })}
      </div>

      <div className="bg-white border rounded-xl p-5 space-y-3">
        <h3 className="font-semibold text-gray-800">Links por palavra-chave</h3>
        <p className="text-xs text-gray-500">
          Use na legenda, na bio ou no story de cada vídeo: quem entra pelo link chega com a origem marcada, e o Painel mostra
          quantos viraram MQL, SQL e cliente por vídeo. Clique para copiar.
        </p>
        {campo("whatsapp_numero", "Número do WhatsApp para os links (com 55 e DDD)", { ph: "5577999831015" })}
        {campo("palavras", "Palavras extras para links e rastreio de origem (as das automações já entram)")}
        <div className="divide-y">
          {d.links.map((l) => (
            <div key={l.palavra} className="flex items-center gap-2 py-1.5">
              <span className="text-sm font-medium text-gray-700 w-28 truncate">{l.palavra}</span>
              <Link url={l.instagram} rotulo="Instagram" />
              <Link url={l.messenger} rotulo="Messenger" />
              <Link url={l.whatsapp} rotulo="WhatsApp" />
            </div>
          ))}
        </div>
        {!d.igUsername && <p className="text-xs text-gray-400">Links do Instagram e do Messenger aparecem depois de conectar.</p>}
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={() => salvar.mutate({
            projetoId, ...form,
            ice_breakers: ice.filter((x) => x.pergunta.trim()),
          })}
          disabled={salvar.isLoading}
          className="bg-gray-900 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-black disabled:opacity-50"
        >
          {salvar.isLoading ? "Salvando…" : "Salvar"}
        </button>
        <button
          onClick={() => conectar.mutate({ projetoId })}
          disabled={conectar.isLoading || !d.temToken}
          className="bg-indigo-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:opacity-50"
        >
          {conectar.isLoading ? "Conectando…" : "Testar token e conectar"}
        </button>
        {msg && <span className="text-sm text-gray-600">{msg}</span>}
      </div>
    </div>
  );
}
