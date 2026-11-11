/**
 * Marco único de "lead qualificado".
 *
 * Um deal fica qualificado na PRIMEIRA vez que entra numa etapa de qualificado-ou-além
 * (lead_qualificado, reunião agendada, assinatura, docs...). Tanto faz o caminho: a IA
 * concluindo a qualificação, o atalho da reunião marcada, a triagem ou alguém arrastando
 * o card no CRM — todos chamam `marcarEntradaEtapa`, e é só aqui que se decide se aquilo
 * conta. Assim a regra fica num lugar e nenhum caminho escapa.
 *
 * O "evento interno lead_qualificado" é a linha em MetaConversaoEvento (outbox persistente):
 * { dealId, ctwaClid, ocorridoEm, eventId }. Quem consome é lib/meta-capi.ts, que não
 * conhece estado de conversa. O eventId é determinístico (sha256 dealId:eventName), então
 * chamar de novo, reentrar na etapa ou dois caminhos correndo juntos não duplicam nada.
 *
 * Nunca lança: é chamado de dentro do atendimento e não pode interferir nele.
 */

import { createHash } from "node:crypto";
import { prisma } from "../db.js";

export const EVENTO_QUALIFICADO = "QualifiedLead";

// Etapas de qualificado-ou-além no funil Carreteiros. Um projeto pode sobrescrever com
// IaProjetoConfig "meta_capi_etapas_qualificado" (chaves separadas por vírgula).
export const ETAPAS_QUALIFICADO_PADRAO = [
  "lead_qualificado",
  "aguardando_reuniao",
  "reuniao_futura",
  "checklist_reuniao",
  "aguardando_assinatura",
  "aguardando_docs_pessoais",
  "docs_em_revisao",
  "docs_comprobatorios",
  "contrato_assinado",
  "inicial_protocolada",
  "protocolados",
];

export function gerarEventId(dealId: string, eventName = EVENTO_QUALIFICADO): string {
  return createHash("sha256").update(`${dealId}:${eventName}`).digest("hex");
}

export function parseEtapas(valor: string | null | undefined): string[] {
  const lista = (valor ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return lista.length ? lista : ETAPAS_QUALIFICADO_PADRAO;
}

const _cacheEtapas = new Map<string, { etapas: Set<string>; em: number }>();
const CACHE_MS = 5 * 60_000;

async function etapasDoProjeto(projetoId: string): Promise<Set<string>> {
  const c = _cacheEtapas.get(projetoId);
  if (c && Date.now() - c.em < CACHE_MS) return c.etapas;
  const cfg = await prisma.iaProjetoConfig.findUnique({
    where: { projetoId_chave: { projetoId, chave: "meta_capi_etapas_qualificado" } },
    select: { valor: true },
  });
  const etapas = new Set(parseEtapas(cfg?.valor));
  _cacheEtapas.set(projetoId, { etapas, em: Date.now() });
  return etapas;
}

/**
 * Avisa que o deal entrou na etapa `etapaChave` pelo caminho `via`.
 * Se a etapa for de qualificado e o deal ainda não tiver o evento, grava na fila.
 */
export async function marcarEntradaEtapa(
  dealId: string,
  etapaChave: string | null | undefined,
  via: string,
): Promise<void> {
  try {
    if (!etapaChave) return;
    const deal = await prisma.crmDeal.findUnique({
      where: { id: dealId },
      select: { id: true, projetoId: true, origemCtwaClid: true },
    });
    // Deal sem projeto de IA é importação/Pipedrive legado: não é lead de anúncio do SDR.
    if (!deal?.projetoId) return;
    if (!(await etapasDoProjeto(deal.projetoId)).has(etapaChave)) return;

    const eventId = gerarEventId(deal.id);
    const ctwaClid = deal.origemCtwaClid ?? null;
    await prisma.metaConversaoEvento.create({
      data: {
        eventId,
        dealId: deal.id,
        projetoId: deal.projetoId,
        eventName: EVENTO_QUALIFICADO,
        ctwaClid,
        via: via.slice(0, 80),
        stageChave: etapaChave,
        ocorridoEm: new Date(),
        // Sem ctwa_clid não há o que devolver à Meta — fica registrado para medir o vazamento.
        status: ctwaClid ? "pendente" : "sem_ctwa",
      },
    });
    console.log(`[LeadQualificado] deal=${deal.id} etapa=${etapaChave} via=${via} ${ctwaClid ? "com ctwa" : "SEM ctwa"}`);
  } catch (err: any) {
    if (err?.code === "P2002") return; // já marcado antes — idempotente
    console.warn(`[LeadQualificado] falha ao marcar deal=${dealId}: ${err?.message ?? err}`);
  }
}
