/**
 * Gerador de parcelas de acordo (decisão 3 do plano: cada parcela vira um FinRecebimento
 * com acordoId + parcelaNumero; entrada = parcela 0).
 *
 * Regras:
 *  - soma das parcelas (incluindo a entrada) = valor do acordo, exatamente em centavos;
 *  - parcelas sem valor informado dividem o restante igualmente; o resto de centavos vai na última automática;
 *  - honorários por parcela = valor × percHonorarios, com o ajuste de arredondamento na última parcela,
 *    para que a soma dos honorários = valor do acordo × percHonorarios (arredondado);
 *  - repasse ao cliente = valor − honorários.
 */
import { addMesesData, aplicarBp, paraBp, type Centavos, type DataCal, type Numerico } from "./util.js";

export interface ParamsParcelasAcordo {
  valorTotalCentavos: Centavos;
  /** Número de parcelas, sem contar a entrada (>= 0; 0 só se a entrada cobrir tudo). */
  numParcelas: number;
  /** Vencimento da parcela 1. As demais: + intervaloMeses (dia ajustado ao fim do mês). */
  primeiroVencimento: DataCal;
  intervaloMeses?: number; // default 1
  entrada?: { valorCentavos: Centavos; vencimento: DataCal } | null;
  /** Valores manuais por parcela (índice 0 = parcela 1); null/undefined = automático. */
  valores?: Array<Centavos | null | undefined>;
  /** Vencimentos manuais por parcela (índice 0 = parcela 1); null/undefined = calculado. */
  vencimentos?: Array<DataCal | null | undefined>;
  /** % de honorários contratuais (ex.: 30 ou "30.00"). null = sem honorários (repasse integral). */
  percHonorarios?: Numerico | null;
}

export interface ParcelaAcordo {
  numero: number; // 0 = entrada; 1..N
  vencimento: DataCal;
  valorCentavos: Centavos;
  honorariosCentavos: Centavos;
  repasseCentavos: Centavos;
  manual: boolean; // valor informado (entrada conta como manual)
}

export interface ResultadoParcelasAcordo {
  parcelas: ParcelaAcordo[];
  totalCentavos: Centavos;
  totalHonorarios: Centavos;
  totalRepasse: Centavos;
}

export function gerarParcelasAcordo(p: ParamsParcelasAcordo): ResultadoParcelasAcordo {
  const N = p.numParcelas;
  const total = p.valorTotalCentavos;
  if (!Number.isInteger(total) || total <= 0) throw new Error("valor do acordo deve ser positivo (centavos inteiros)");
  if (!Number.isInteger(N) || N < 0) throw new Error("numParcelas inválido");
  const intervalo = p.intervaloMeses ?? 1;
  if (!Number.isInteger(intervalo) || intervalo < 1) throw new Error("intervaloMeses deve ser >= 1");
  if (p.valores && p.valores.length > N) throw new Error("mais valores informados que parcelas");

  const entrada = p.entrada && p.entrada.valorCentavos > 0 ? p.entrada : null;
  if (entrada && !Number.isInteger(entrada.valorCentavos)) throw new Error("entrada deve ser em centavos inteiros");

  const manuais = Array.from({ length: N }, (_, i) => p.valores?.[i] ?? null);
  for (const v of manuais) {
    if (v !== null && (!Number.isInteger(v) || v <= 0)) throw new Error("valor de parcela deve ser positivo (centavos inteiros)");
  }
  const somaManual = (entrada?.valorCentavos ?? 0) + manuais.reduce<number>((a, v) => a + (v ?? 0), 0);
  const resto = total - somaManual;
  const autos = manuais.map((v, i) => (v === null ? i : -1)).filter((i) => i >= 0);

  if (resto < 0) throw new Error("entrada + parcelas informadas ultrapassam o valor do acordo");
  if (autos.length === 0 && resto !== 0) throw new Error("a soma das parcelas não bate com o valor do acordo");
  if (autos.length > 0 && resto < autos.length) throw new Error("restante insuficiente para as parcelas automáticas");

  const valores = [...manuais] as Array<number | null>;
  if (autos.length > 0) {
    const base = Math.floor(resto / autos.length);
    autos.forEach((i, k) => {
      valores[i] = k === autos.length - 1 ? resto - base * (autos.length - 1) : base;
    });
  }

  const parcelas: ParcelaAcordo[] = [];
  if (entrada) {
    parcelas.push({ numero: 0, vencimento: entrada.vencimento, valorCentavos: entrada.valorCentavos, honorariosCentavos: 0, repasseCentavos: 0, manual: true });
  }
  for (let i = 0; i < N; i++) {
    parcelas.push({
      numero: i + 1,
      vencimento: p.vencimentos?.[i] ?? addMesesData(p.primeiroVencimento, i * intervalo),
      valorCentavos: valores[i]!,
      honorariosCentavos: 0,
      repasseCentavos: 0,
      manual: manuais[i] !== null,
    });
  }
  if (parcelas.length === 0) throw new Error("acordo sem parcelas");

  const bp = p.percHonorarios === null || p.percHonorarios === undefined ? 0 : paraBp(p.percHonorarios);
  if (bp < 0 || bp > 10000) throw new Error("percentual de honorários fora de 0–100");
  const honTotal = aplicarBp(total, bp);
  let honAcum = 0;
  parcelas.forEach((pc, i) => {
    pc.honorariosCentavos = i === parcelas.length - 1 ? honTotal - honAcum : aplicarBp(pc.valorCentavos, bp);
    honAcum += pc.honorariosCentavos;
    pc.repasseCentavos = pc.valorCentavos - pc.honorariosCentavos;
  });

  return {
    parcelas,
    totalCentavos: total,
    totalHonorarios: honTotal,
    totalRepasse: total - honTotal,
  };
}
