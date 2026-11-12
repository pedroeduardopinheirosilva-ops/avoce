/**
 * Recebimentos (parcela de acordo ou execução/sentença) — decisões 3 e 4 do plano.
 *
 *  - Honorários contratuais = bruto × percHonorarios (ou valor informado); repasse = bruto − honorários.
 *  - Sucumbência é separada: 100% do escritório, nunca entra no repasse.
 *  - Receita do escritório = honorários + sucumbência. O repasse é valor de TERCEIRO (cliente):
 *    não é receita/DRE; enquanto pendente é passivo "Valores de terceiros" e sai do caixa disponível.
 *  - Status derivado: recebida (tem dataRecebimento) | em_atraso (vencimento < hoje, sem receber) | prevista.
 *  - repasseStatus "nao_aplicavel" → nada a repassar (todo o bruto é do escritório).
 */
import { aplicarBp, diasEntre, paraBp, paraCentavos, type Centavos, type DataCal, type Numerico } from "./util.js";

export type StatusRecebimento = "prevista" | "recebida" | "em_atraso";
export type RepasseStatus = "pendente" | "realizado" | "nao_aplicavel";
export type NfStatus = "a_emitir" | "emitida" | "nao_aplicavel";

export interface HonorariosCalculados {
  bruto: Centavos;
  honorarios: Centavos;
  repasse: Centavos;
  sucumbencia: Centavos;
  receitaEscritorio: Centavos; // honorarios + sucumbencia
  valoresTerceiros: Centavos; // = repasse
  totalRecebido: Centavos; // bruto + sucumbencia
  nfValorSugerido: Centavos; // NF de serviço sobre a receita do escritório
}

export function calcularHonorarios(args: {
  valorBrutoCentavos: Centavos;
  percHonorarios?: Numerico | null;
  /** Se informado, prevalece sobre o percentual (honorário negociado em valor). */
  honorariosInformadosCentavos?: Centavos | null;
  valorSucumbenciaCentavos?: Centavos | null;
  /** "nao_aplicavel" → sem repasse: todo o bruto é honorário. */
  repasseStatus?: RepasseStatus;
}): HonorariosCalculados {
  const bruto = args.valorBrutoCentavos;
  const sucumbencia = args.valorSucumbenciaCentavos ?? 0;
  let honorarios: Centavos;
  if (args.repasseStatus === "nao_aplicavel") honorarios = bruto;
  else if (args.honorariosInformadosCentavos !== null && args.honorariosInformadosCentavos !== undefined)
    honorarios = args.honorariosInformadosCentavos;
  else honorarios = aplicarBp(bruto, paraBp(args.percHonorarios ?? 0));
  if (honorarios > bruto) throw new Error("honorários maiores que o valor bruto");
  const repasse = bruto - honorarios;
  return {
    bruto, honorarios, repasse, sucumbencia,
    receitaEscritorio: honorarios + sucumbencia,
    valoresTerceiros: repasse,
    totalRecebido: bruto + sucumbencia,
    nfValorSugerido: honorarios + sucumbencia,
  };
}

/** Status derivado. `hoje` é data-calendário (America/Bahia). Vence hoje ainda não está em atraso. */
export function statusRecebimento(
  r: { vencimento?: DataCal | null; dataRecebimento?: DataCal | null },
  hoje: DataCal,
): StatusRecebimento {
  if (r.dataRecebimento) return "recebida";
  if (r.vencimento && r.vencimento < hoje) return "em_atraso";
  return "prevista";
}

/** Dias de atraso (0 se recebida, sem vencimento ou não vencida). */
export function diasEmAtraso(r: { vencimento?: DataCal | null; dataRecebimento?: DataCal | null }, hoje: DataCal): number {
  if (r.dataRecebimento || !r.vencimento || r.vencimento >= hoje) return 0;
  return diasEntre(r.vencimento, hoje);
}

/** Forma mínima de um FinRecebimento para os agregados (valores já em centavos, datas em DataCal). */
export interface RecebimentoResumo {
  vencimento?: DataCal | null;
  dataRecebimento?: DataCal | null;
  valorPrevistoCentavos?: Centavos | null;
  valorBrutoCentavos?: Centavos | null;
  valorHonorariosCentavos?: Centavos | null;
  valorSucumbenciaCentavos?: Centavos | null;
  valorRepasseCentavos?: Centavos | null;
  repasseStatus: RepasseStatus;
  nfStatus: NfStatus;
}

export interface TotaisRecebimentos {
  qtd: number;
  qtdRecebidas: number;
  qtdEmAtraso: number;
  previstoAReceber: Centavos; // valorPrevisto das não recebidas (inclui em atraso)
  emAtraso: Centavos; // valorPrevisto das em atraso
  recebidoBruto: Centavos; // bruto das recebidas
  sucumbencia: Centavos; // sucumbência das recebidas
  receitaEscritorio: Centavos; // honorários + sucumbência das recebidas
  repassePendente: Centavos; // valores de terceiros ainda não repassados (passivo)
  repasseRealizado: Centavos;
  qtdSemNf: number; // recebidas com nfStatus a_emitir
}

/** Agrega uma lista de recebimentos (receita do escritório × valores de terceiros). */
export function totalizarRecebimentos(lista: RecebimentoResumo[], hoje: DataCal): TotaisRecebimentos {
  const t: TotaisRecebimentos = {
    qtd: lista.length, qtdRecebidas: 0, qtdEmAtraso: 0, previstoAReceber: 0, emAtraso: 0,
    recebidoBruto: 0, sucumbencia: 0, receitaEscritorio: 0, repassePendente: 0, repasseRealizado: 0, qtdSemNf: 0,
  };
  for (const r of lista) {
    const st = statusRecebimento(r, hoje);
    if (st !== "recebida") {
      const prev = r.valorPrevistoCentavos ?? 0;
      t.previstoAReceber += prev;
      if (st === "em_atraso") {
        t.qtdEmAtraso++;
        t.emAtraso += prev;
      }
      continue;
    }
    t.qtdRecebidas++;
    const bruto = r.valorBrutoCentavos ?? r.valorPrevistoCentavos ?? 0;
    const suc = r.valorSucumbenciaCentavos ?? 0;
    const repasse = r.repasseStatus === "nao_aplicavel" ? 0 : (r.valorRepasseCentavos ?? 0);
    const honorarios = r.repasseStatus === "nao_aplicavel" ? bruto : (r.valorHonorariosCentavos ?? bruto - repasse);
    t.recebidoBruto += bruto;
    t.sucumbencia += suc;
    t.receitaEscritorio += honorarios + suc;
    if (r.repasseStatus === "pendente") t.repassePendente += repasse;
    else if (r.repasseStatus === "realizado") t.repasseRealizado += repasse;
    if (r.nfStatus === "a_emitir") t.qtdSemNf++;
  }
  return t;
}

/** Caixa disponível = saldo em caixa − repasses pendentes (valores de terceiros). */
export function caixaDisponivel(saldoCaixaCentavos: Centavos, repassePendenteCentavos: Centavos): Centavos {
  return saldoCaixaCentavos - repassePendenteCentavos;
}

/** Atalho para converter um FinRecebimento do Prisma (Decimal) em centavos. */
export function centavosOuNull(v: Numerico | null | undefined): Centavos | null {
  return v === null || v === undefined ? null : paraCentavos(v);
}
