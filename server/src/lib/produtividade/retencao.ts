import { dataLocal } from "./calculo.js";

export const DIA_MS = 86_400_000;
/** Eventos brutos ficam 90 dias; MonitorDia é permanente. */
export const RETENCAO_DIAS = 90;

/** Instante antes do qual os eventos brutos já foram (ou serão) apagados. */
export function corteRetencao(agora = Date.now()): number {
  return agora - RETENCAO_DIAS * DIA_MS;
}

/**
 * Primeiro dia local (-03:00) cujos eventos brutos ainda estão inteiros — inclusive a folga
 * de 1 dia antes que o cálculo carrega (eventos que começam na véspera). Dias anteriores
 * só existem como MonitorDia: não são recalculados nem lidos dos eventos brutos.
 */
export function limiteRetencao(agora = Date.now()): string {
  const corte = corteRetencao(agora);
  let d = dataLocal(new Date(corte));
  // avança até que (início do dia − 1 dia) >= corte
  while (new Date(`${d}T00:00:00-03:00`).getTime() - DIA_MS < corte) {
    d = dataLocal(new Date(new Date(`${d}T12:00:00-03:00`).getTime() + DIA_MS));
  }
  return d;
}
