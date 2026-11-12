/**
 * Anexo do financeiro / acordos (comprovante, NF, autorização) — componente reutilizável.
 *
 * Upload:   POST /api/fin-anexos/upload?emitenteId=…  (multipart, campo "file", Bearer)
 *           → { path, nome, tamanho, mimetype }; `path` vai no campo *Path do registro e `nome` no *Nome.
 * Download: GET /api/fin-anexos/download?path=…&nome=…[&inline=1]  (Bearer via fetch → blob).
 *
 * Uso controlado:
 *   <FinAnexo emitenteId={id} valor={{ path, nome }} onChange={(v) => …} />   // v = null ao remover
 *   <FinAnexoLink path={l.comprovantePath} nome={l.comprovanteNome} />       // só o link
 * O arquivo antigo não é apagado no servidor ao remover/trocar (só o vínculo no registro).
 */
import { useRef, useState } from "react";

export interface ValorAnexo {
  path: string;
  nome: string | null;
}

export interface RespostaUploadFin {
  path: string;
  nome: string;
  tamanho: number;
  mimetype: string;
}

export const ACCEPT_ANEXO_FIN =
  ".pdf,.png,.jpg,.jpeg,.webp,.gif,.heic,.doc,.docx,.xls,.xlsx,.csv,.odt,.ods,.txt,.xml,.ofx,.zip";

function token(): string {
  try { return localStorage.getItem("avoce_token") ?? ""; } catch { return ""; }
}

async function erroDaResposta(res: Response): Promise<string> {
  try {
    const j = await res.json();
    if (j && typeof j.error === "string") return j.error;
    if (j && typeof j.message === "string") return j.message;
  } catch { /* corpo não-JSON */ }
  return `Erro ${res.status}`;
}

/** Envia o arquivo; lança Error com a mensagem do servidor em caso de falha. */
export async function uploadFinAnexo(emitenteId: string, file: File): Promise<RespostaUploadFin> {
  const fd = new FormData();
  fd.append("file", file);
  const res = await fetch(`/api/fin-anexos/upload?emitenteId=${encodeURIComponent(emitenteId)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token()}` },
    body: fd,
  });
  if (!res.ok) throw new Error(await erroDaResposta(res));
  return res.json() as Promise<RespostaUploadFin>;
}

/** Baixa (ou abre em nova aba, `abrir=true`) um anexo com autenticação Bearer. */
export async function baixarFinAnexo(path: string, nome?: string | null, abrir = false): Promise<void> {
  const qs = new URLSearchParams({ path });
  if (nome) qs.set("nome", nome);
  if (abrir) qs.set("inline", "1");
  // abre a aba antes do await para não ser bloqueada como pop-up
  const janela = abrir ? window.open("", "_blank") : null;
  const res = await fetch(`/api/fin-anexos/download?${qs.toString()}`, { headers: { Authorization: `Bearer ${token()}` } });
  if (!res.ok) {
    janela?.close();
    throw new Error(await erroDaResposta(res));
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  if (janela) {
    janela.location.href = url;
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return;
  }
  const a = document.createElement("a");
  a.href = url;
  a.download = nome || path.split("/").pop() || "anexo";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** Link "📎 nome" que baixa o anexo. Não renderiza nada sem `path`. */
export function FinAnexoLink({ path, nome, className = "", rotulo }: { path?: string | null; nome?: string | null; className?: string; rotulo?: string }) {
  const [erro, setErro] = useState<string | null>(null);
  const [baixando, setBaixando] = useState(false);
  if (!path) return null;
  async function baixar(abrir: boolean) {
    setErro(null);
    setBaixando(true);
    try { await baixarFinAnexo(path!, nome, abrir); } catch (e) { setErro((e as Error).message); } finally { setBaixando(false); }
  }
  return (
    <span className={`inline-flex items-center gap-1 ${className}`}>
      <button
        type="button"
        onClick={() => baixar(true)}
        disabled={baixando}
        title={`Abrir ${nome ?? "anexo"}`}
        className="text-xs text-indigo-600 hover:underline truncate max-w-[200px] disabled:opacity-50"
      >
        📎 {rotulo ?? nome ?? "anexo"}
      </button>
      <button type="button" onClick={() => baixar(false)} disabled={baixando} title="Baixar" className="text-xs text-gray-400 hover:text-gray-700">⬇</button>
      {erro && <span className="text-xs text-red-600">{erro}</span>}
    </span>
  );
}

/** Campo de anexo: mostra o atual (link), permite enviar/trocar e remover. */
export function FinAnexo({
  emitenteId, valor, onChange, desabilitado, rotuloBotao = "Anexar arquivo",
}: {
  emitenteId: string | null | undefined;
  valor: ValorAnexo | null;
  onChange: (v: ValorAnexo | null) => void;
  desabilitado?: boolean;
  rotuloBotao?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  async function enviar(f: File) {
    if (!emitenteId) { setErro("Selecione a empresa antes de anexar"); return; }
    setErro(null);
    setEnviando(true);
    try {
      const r = await uploadFinAnexo(emitenteId, f);
      onChange({ path: r.path, nome: r.nome });
    } catch (e) {
      setErro((e as Error).message);
    } finally {
      setEnviando(false);
      if (ref.current) ref.current.value = "";
    }
  }

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {valor?.path && <FinAnexoLink path={valor.path} nome={valor.nome} />}
      {!desabilitado && (
        <>
          <button
            type="button"
            onClick={() => ref.current?.click()}
            disabled={enviando || !emitenteId}
            className="text-xs px-2 py-1 border border-gray-300 rounded-lg bg-white hover:bg-gray-50 disabled:opacity-50"
          >
            {enviando ? "Enviando…" : valor?.path ? "Trocar" : rotuloBotao}
          </button>
          {valor?.path && (
            <button type="button" onClick={() => onChange(null)} className="text-xs text-red-500 hover:underline">Remover</button>
          )}
          <input
            ref={ref}
            type="file"
            accept={ACCEPT_ANEXO_FIN}
            className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void enviar(f); }}
          />
        </>
      )}
      {!valor?.path && desabilitado && <span className="text-xs text-gray-400">—</span>}
      {erro && <span className="text-xs text-red-600 w-full">{erro}</span>}
    </div>
  );
}
