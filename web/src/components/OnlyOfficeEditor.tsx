import { useEffect, useRef, useState } from "react";

/**
 * Editor OnlyOffice (mesmo Document Server do PSA Docs) para os documentos
 * gerados de uma proposta. Edita o .docx com o timbrado de verdade — o que o
 * cliente assina — em vez do HTML intermediário.
 *
 * O salvamento é do OnlyOffice: ele avisa o servidor pelo callbackUrl. "Salvar e
 * fechar" pede forcesave e só então fecha, senão o PDF regerado chegaria depois
 * de o revisor já estar olhando o preview antigo.
 */
export default function OnlyOfficeEditor({ docId, titulo, onClose }: {
  docId: string;
  titulo: string;
  onClose: (salvou: boolean) => void;
}) {
  const containerId = useRef(`oo-editor-${docId}`);
  const editorRef   = useRef<any>(null);
  const [erro, setErro]       = useState<string | null>(null);
  const [pronto, setPronto]   = useState(false);
  const [salvando, setSalvando] = useState(false);

  useEffect(() => {
    let destruido = false;

    async function abrir() {
      const token = localStorage.getItem("avoce_token");
      const res = await fetch(`/api/oo/sessao/${docId}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setErro((j as any).error ?? "Não foi possível abrir o editor");
        return;
      }
      const { config, scriptUrl } = await res.json();

      // O api.js do Document Server registra window.DocsAPI; carregar uma vez só
      if (!(window as any).DocsAPI) {
        await new Promise<void>((resolve, reject) => {
          const s = document.createElement("script");
          s.src = scriptUrl;
          s.onload = () => resolve();
          s.onerror = () => reject(new Error("falha ao carregar o OnlyOffice"));
          document.body.appendChild(s);
        }).catch((e) => setErro(e.message));
      }
      if (destruido || !(window as any).DocsAPI) return;

      editorRef.current = new (window as any).DocsAPI.DocEditor(containerId.current, {
        ...config,
        width:  "100%",
        height: "100%",
        events: {
          onAppReady: () => setPronto(true),
          onError:    (e: any) => setErro(e?.data ?? "Erro no editor"),
        },
      });
    }

    abrir().catch((e) => setErro(String(e?.message ?? e)));
    return () => {
      destruido = true;
      try { editorRef.current?.destroyEditor?.(); } catch { /* editor já morto */ }
    };
  }, [docId]);

  async function salvarEFechar() {
    setSalvando(true);
    const token = localStorage.getItem("avoce_token");
    try {
      await fetch(`/api/oo/forcesave/${docId}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      // O forcesave responde antes de o callback terminar de gravar e converter
      await new Promise(r => setTimeout(r, 2500));
    } catch { /* segue: o autosave do OO grava de qualquer forma */ }
    setSalvando(false);
    onClose(true);
  }

  return (
    <div className="fixed inset-0 bg-black/70 z-[60] flex flex-col">
      <div className="bg-white px-4 py-2 flex items-center gap-3 border-b border-gray-200">
        <span className="font-medium text-gray-800 text-sm truncate flex-1 min-w-0">✏️ {titulo}</span>
        {!pronto && !erro && <span className="text-xs text-gray-400">carregando editor...</span>}
        <button onClick={() => onClose(false)} className="btn-secondary text-sm" disabled={salvando}>
          Fechar sem salvar
        </button>
        <button onClick={salvarEFechar} className="btn-primary text-sm" disabled={salvando || !pronto}>
          {salvando ? "Salvando..." : "Salvar e fechar"}
        </button>
      </div>
      {erro ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="bg-white rounded-xl px-6 py-5 max-w-md text-center">
            <p className="text-sm text-red-600 font-medium mb-1">Não foi possível abrir o editor</p>
            <p className="text-xs text-gray-500">{erro}</p>
          </div>
        </div>
      ) : (
        <div id={containerId.current} className="flex-1 min-h-0 bg-gray-100" />
      )}
    </div>
  );
}
