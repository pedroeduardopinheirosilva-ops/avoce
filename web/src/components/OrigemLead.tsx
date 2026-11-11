/**
 * Origem do lead (plataforma / anúncio) gravada no deal a partir da 1ª mensagem do WhatsApp.
 * Usado no card do funil, no modal do deal e no cabeçalho da conversa.
 */

export type DealOrigem = {
  origemPlataforma?: string | null;
  origemTipo?: string | null;
  origemAnuncioId?: string | null;
  origemAnuncioTitulo?: string | null;
  origemAnuncioTexto?: string | null;
  origemUrl?: string | null;
  origemEm?: string | null;
  origemCtwaClid?: string | null;
  origemEntryPoint?: string | null;
};

const PLATAFORMA: Record<string, { nome: string; icone: string; cor: string }> = {
  facebook:  { nome: "Facebook",  icone: "📘", cor: "bg-blue-50 text-blue-700 border-blue-200" },
  instagram: { nome: "Instagram", icone: "📸", cor: "bg-pink-50 text-pink-700 border-pink-200" },
  meta:      { nome: "Meta Ads",  icone: "📣", cor: "bg-indigo-50 text-indigo-700 border-indigo-200" },
  site:      { nome: "Site",      icone: "🌐", cor: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  whatsapp:  { nome: "Busca WhatsApp", icone: "🔎", cor: "bg-gray-50 text-gray-700 border-gray-200" },
  telefone:  { nome: "Nº salvo",  icone: "📞", cor: "bg-gray-50 text-gray-700 border-gray-200" },
  social:    { nome: "Redes (orgânico)", icone: "🎬", cor: "bg-amber-50 text-amber-800 border-amber-200" },
};

export function resumoOrigem(d: DealOrigem | null | undefined) {
  if (!d?.origemPlataforma) return null;
  const p = PLATAFORMA[d.origemPlataforma] ?? { nome: d.origemPlataforma, icone: "📍", cor: "bg-gray-50 text-gray-700 border-gray-200" };
  const anuncio = d.origemTipo === "anuncio"
    ? (d.origemAnuncioTexto?.trim() || d.origemAnuncioTitulo?.trim() || (d.origemAnuncioId ? `anúncio ${d.origemAnuncioId}` : "anúncio"))
    : d.origemTipo === "link" ? "link wa.me" : (d.origemAnuncioTitulo?.trim() || "orgânico");
  return { ...p, anuncio, curto: anuncio.length > 42 ? anuncio.slice(0, 40).trimEnd() + "…" : anuncio };
}

export function OrigemBadge({ deal, compact = false }: { deal: DealOrigem | null | undefined; compact?: boolean }) {
  const r = resumoOrigem(deal);
  if (!r) return null;
  const title = `${r.nome}${deal?.origemTipo === "anuncio" ? " · " + r.anuncio : ""}${deal?.origemAnuncioId ? ` (ID ${deal.origemAnuncioId})` : ""}`;
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 max-w-full border rounded-full px-1.5 py-0.5 text-[11px] font-medium leading-tight ${r.cor}`}
    >
      <span>{r.icone}</span>
      <span className="truncate">{compact ? r.nome : `${r.nome} · ${r.curto}`}</span>
    </span>
  );
}

export const PLATAFORMA_PAINEL: Record<string, { nome: string; cor: string }> = {
  facebook:   { nome: "Facebook",   cor: "#2a78d6" },
  instagram:  { nome: "Instagram",  cor: "#d6409f" },
  meta:       { nome: "Meta Ads",   cor: "#6366f1" },
  site:       { nome: "Site",       cor: "#1baf7a" },
  organico:   { nome: "Orgânico",   cor: "#eda100" },
  social:     { nome: "Redes (orgânico)", cor: "#c2410c" },
  sem_origem: { nome: "Sem origem", cor: "#d4d4d8" },
};

export function OrigemDetalhe({ deal }: { deal: DealOrigem | null | undefined }) {
  const r = resumoOrigem(deal);
  if (!deal) return null;
  if (!r) {
    return (
      <div>
        <p className="text-xs font-semibold text-gray-500 uppercase mb-2">Captação</p>
        <p className="text-sm text-gray-500 rounded-lg border border-dashed border-gray-200 px-3 py-2">
          Origem não identificada. O lead não veio com metadado de anúncio ou link na primeira mensagem
          (áudio, saudação simples, indicação ou contato anterior ao rastreio).
        </p>
      </div>
    );
  }
  return (
    <div>
      <p className="text-xs font-semibold text-gray-500 uppercase mb-2">Captação · origem do lead</p>
      <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm space-y-1">
        <div className="flex items-center gap-2">
          <span>{r.icone}</span>
          <span className="font-medium text-gray-800">{r.nome}</span>
          <span className="text-xs text-gray-500">
            {deal.origemTipo === "anuncio" ? "anúncio Click-to-WhatsApp" : deal.origemTipo === "link" ? "link wa.me (site / bio)" : "contato orgânico"}
          </span>
        </div>
        {deal.origemAnuncioTitulo && <p className="text-gray-700"><span className="text-gray-500">Título:</span> {deal.origemAnuncioTitulo}</p>}
        {deal.origemAnuncioTexto && <p className="text-gray-700"><span className="text-gray-500">Anúncio:</span> {deal.origemAnuncioTexto}</p>}
        {deal.origemAnuncioId && (
          <p className="text-gray-700"><span className="text-gray-500">ID do anúncio (Meta):</span> <code className="text-xs bg-white border rounded px-1">{deal.origemAnuncioId}</code></p>
        )}
        {deal.origemUrl && (
          <p className="truncate"><span className="text-gray-500">Link:</span> <a href={deal.origemUrl} target="_blank" rel="noreferrer" className="text-indigo-600 underline">{deal.origemUrl}</a></p>
        )}
        {deal.origemTipo === "anuncio" && (
          <p className="text-gray-700">
            <span className="text-gray-500">Atribuição Meta:</span>{" "}
            {deal.origemCtwaClid
              ? <span className="text-emerald-700" title={deal.origemCtwaClid}>clique rastreado (ctwa_clid) — qualificação volta para a campanha</span>
              : <span className="text-amber-700">sem ctwa_clid — a qualificação não pode ser devolvida à campanha</span>}
          </p>
        )}
        {deal.origemEm && <p className="text-xs text-gray-400">Registrado em {new Date(deal.origemEm).toLocaleString("pt-BR")}{deal.origemEntryPoint ? ` · entrada: ${deal.origemEntryPoint}` : ""}</p>}
      </div>
    </div>
  );
}
