import type { Categoria, Item, Regra } from "./tipos.js";

export function dominioDaUrl(url: string): string | null {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    return host || null;
  } catch {
    return null;
  }
}

function casa(regra: Regra, item: Item): boolean {
  const padrao = regra.padrao.toLowerCase();
  if (!padrao) return false;
  if (regra.alvo === "app") return (item.app ?? "").toLowerCase().includes(padrao);
  if (regra.alvo === "titulo") return (item.titulo ?? "").toLowerCase().includes(padrao);
  const d = (item.dominio ?? "").toLowerCase();
  return d === padrao || d.endsWith("." + padrao);
}

/** Pessoa = 3, cargo = 2, geral = 1; regra de outra pessoa/cargo = 0 (ignorada). */
function nivel(regra: Regra, pessoa: { usuarioId: string; cargoId: string | null }): number {
  if (regra.usuarioId !== null) return regra.usuarioId === pessoa.usuarioId ? 3 : 0;
  if (regra.cargoId !== null) return pessoa.cargoId !== null && regra.cargoId === pessoa.cargoId ? 2 : 0;
  return 1;
}

export function classificar(
  item: Item,
  regras: Regra[],
  pessoa: { usuarioId: string; cargoId: string | null },
): Categoria {
  let melhor: Regra | null = null;
  let melhorNivel = 0;
  for (const r of regras) {
    const n = nivel(r, pessoa);
    if (n === 0 || !casa(r, item)) continue;
    if (
      melhor === null ||
      n > melhorNivel ||
      (n === melhorNivel &&
        (r.prioridade > melhor.prioridade ||
          (r.prioridade === melhor.prioridade && r.padrao.length > melhor.padrao.length)))
    ) {
      melhor = r;
      melhorNivel = n;
    }
  }
  return melhor ? melhor.categoria : "neutro";
}
