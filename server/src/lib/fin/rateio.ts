/**
 * Rateio de um lançamento entre fontes de recursos (FinLancamentoFonte). Puro, em centavos.
 *
 * Cada item informa `valor` (reais) OU `percentual` (% do total). Regras:
 *  - pelo menos um item; sem fonte repetida; valor/percentual > 0;
 *  - itens por percentual são calculados sobre o total; se a soma ficar a até 1 centavo por item
 *    percentual do total (arredondamento), a diferença vai para o maior item percentual;
 *  - só percentuais: a soma deles precisa dar 100%;
 *  - a soma final tem de ser EXATAMENTE o valor do lançamento — senão erro (`ErroRateio`).
 * O `percentual` gravado é informativo (4 casas); o valor manda.
 */
import { arred, paraCentavos, type Centavos, type Numerico } from "./util.js";

export interface ItemRateioEntrada {
  fonteId: string;
  valor?: Numerico | null;
  percentual?: Numerico | null;
}

export interface ItemRateio {
  fonteId: string;
  valorCentavos: Centavos;
  percentual: number; // 4 casas
}

export class ErroRateio extends Error {}

function pct4(parte: Centavos, total: Centavos): number {
  return total === 0 ? 0 : Math.round((parte / total) * 100 * 10000) / 10000;
}

function vazio(v: Numerico | null | undefined): boolean {
  return v === null || v === undefined || v === "";
}

export function resolverRateio(totalCentavos: Centavos, itens: ItemRateioEntrada[]): ItemRateio[] {
  if (!Number.isInteger(totalCentavos) || totalCentavos <= 0) throw new ErroRateio("valor do lançamento inválido");
  if (!itens.length) throw new ErroRateio("informe ao menos uma fonte de recursos");
  const vistos = new Set<string>();
  const out: Array<ItemRateio & { porPct: boolean }> = [];
  let somaPct = 0;
  let qtdPct = 0;

  for (const it of itens) {
    if (!it.fonteId) throw new ErroRateio("fonte não informada no rateio");
    if (vistos.has(it.fonteId)) throw new ErroRateio("fonte repetida no rateio");
    vistos.add(it.fonteId);
    if (!vazio(it.valor)) {
      const c = paraCentavos(it.valor);
      if (c <= 0) throw new ErroRateio("valor do rateio deve ser positivo");
      out.push({ fonteId: it.fonteId, valorCentavos: c, percentual: 0, porPct: false });
    } else if (!vazio(it.percentual)) {
      const p = Number(it.percentual!.toString().replace(",", "."));
      if (!Number.isFinite(p) || p <= 0 || p > 100) throw new ErroRateio("percentual do rateio deve estar entre 0 e 100");
      somaPct += p;
      qtdPct++;
      out.push({ fonteId: it.fonteId, valorCentavos: arred((totalCentavos * p) / 100), percentual: p, porPct: true });
    } else {
      throw new ErroRateio("cada fonte do rateio precisa de valor ou percentual");
    }
  }

  if (qtdPct === out.length && Math.abs(somaPct - 100) > 0.0001 * qtdPct) {
    throw new ErroRateio(`a soma dos percentuais é ${somaPct.toFixed(4)}% (precisa ser 100%)`);
  }

  let soma = out.reduce((a, i) => a + i.valorCentavos, 0);
  const diff = totalCentavos - soma;
  if (diff !== 0 && qtdPct > 0 && Math.abs(diff) <= qtdPct) {
    const alvo = out.filter((i) => i.porPct).sort((a, b) => b.valorCentavos - a.valorCentavos)[0];
    alvo.valorCentavos += diff;
    soma += diff;
  }
  if (soma !== totalCentavos) {
    throw new ErroRateio(
      `a soma do rateio (R$ ${(soma / 100).toFixed(2)}) difere do valor do lançamento (R$ ${(totalCentavos / 100).toFixed(2)})`,
    );
  }
  if (out.some((i) => i.valorCentavos <= 0)) throw new ErroRateio("item do rateio ficou com valor zero");
  return out.map(({ fonteId, valorCentavos }) => ({ fonteId, valorCentavos, percentual: pct4(valorCentavos, totalCentavos) }));
}

/** Distribui `total` proporcionalmente aos pesos (maiores restos), soma exata. */
export function distribuirProporcional(total: Centavos, pesos: number[]): Centavos[] {
  const somaPesos = pesos.reduce((a, b) => a + b, 0);
  if (somaPesos <= 0) throw new ErroRateio("pesos inválidos");
  const brutos = pesos.map((p) => (total * p) / somaPesos);
  const base = brutos.map((b) => Math.floor(b));
  let resto = total - base.reduce((a, b) => a + b, 0);
  const ordem = brutos.map((b, i) => ({ i, frac: b - Math.floor(b) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; resto > 0; k = (k + 1) % ordem.length, resto--) base[ordem[k].i] += 1;
  return base;
}

/**
 * Valor do lançamento mudou sem novo rateio: reescala o rateio atual proporcionalmente
 * (mesmas fontes, mesmas proporções, soma exata ao novo total).
 */
export function reescalarRateio(atual: Array<{ fonteId: string; valorCentavos: Centavos }>, novoTotal: Centavos): ItemRateio[] {
  if (!atual.length) return [];
  const vals = distribuirProporcional(novoTotal, atual.map((a) => a.valorCentavos));
  return atual.map((a, i) => ({ fonteId: a.fonteId, valorCentavos: vals[i], percentual: pct4(vals[i], novoTotal) }));
}
