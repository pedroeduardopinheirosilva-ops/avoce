import { useState, useEffect } from "react";

const AVATAR_CORES = [
  "bg-indigo-500", "bg-emerald-500", "bg-rose-500", "bg-amber-500",
  "bg-sky-500", "bg-violet-500", "bg-teal-500", "bg-orange-500",
];

function iniciaisDe(nome: string): string {
  const partes = nome.replace(/[^\p{L}\p{N}\s]/gu, " ").trim().split(/\s+/).filter(Boolean);
  if (partes.length === 0) return "?";
  if (partes.length === 1) return partes[0].slice(0, 2).toUpperCase();
  return (partes[0][0] + partes[partes.length - 1][0]).toUpperCase();
}

function corAvatar(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_CORES[h % AVATAR_CORES.length];
}

/**
 * Foto de perfil do WhatsApp do contato, com iniciais coloridas como fallback.
 * A imagem vem do próprio Avoce (/api/contato-foto), que só existe depois que o
 * servidor baixou a foto pela Evolution — por isso o `onError` volta às iniciais.
 */
export function Avatar({ contato, nome, size = 40 }: {
  contato: { id: string; fotoPerfilUrl?: string | null; fotoPerfilEm?: string | null } | null | undefined;
  nome: string;
  size?: number;
}) {
  const [falhou, setFalhou] = useState(false);
  const temFoto = !!contato?.fotoPerfilUrl && !falhou;
  const token = localStorage.getItem("avoce_token") ?? "";
  const versao = contato?.fotoPerfilEm ? new Date(contato.fotoPerfilEm).getTime() : 0;
  const src = contato && temFoto
    ? `/api/contato-foto/${contato.id}?v=${versao}&token=${encodeURIComponent(token)}`
    : null;
  useEffect(() => { setFalhou(false); }, [contato?.id, versao]);
  const dim = { width: size, height: size, minWidth: size, fontSize: Math.max(10, Math.round(size * 0.38)) };
  if (src) {
    return (
      <img
        src={src}
        alt={nome}
        loading="lazy"
        onError={() => setFalhou(true)}
        style={dim}
        className="rounded-full object-cover bg-gray-200 flex-shrink-0"
      />
    );
  }
  return (
    <div
      style={dim}
      className={`rounded-full flex items-center justify-center text-white font-semibold flex-shrink-0 ${corAvatar(contato?.id ?? nome)}`}
      title={nome}
    >
      {iniciaisDe(nome)}
    </div>
  );
}

