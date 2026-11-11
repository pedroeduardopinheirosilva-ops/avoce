/**
 * Confirmação de presença na reunião.
 *
 * Motivo (auditoria da planilha, 26/08/2026): 61 dos 176 leads agendados — 34,7% — não
 * atenderam a ligação da reunião. É a maior perda isolada do funil. Só 6% avisaram antes;
 * os outros 94% simplesmente sumiram no horário.
 *
 * Os lembretes de 48h e 24h já PEDIAM confirmação ("Me confirma aqui se está tudo certo?"),
 * mas nada acontecia quando ninguém respondia — pedia e ignorava. Este módulo fecha o ciclo:
 * detecta a confirmação e, na falta dela, avisa o SDR humano a tempo de ligar antes.
 */

import { prisma } from "../db.js";

/** Respostas que valem como confirmação de presença. */
const CONFIRMA_RE = new RegExp(
  [
    "\\b(sim|isso|claro|confirmo|confirmado|confirmada|confirmar)\\b",
    "\\b(ok|okay|blz|beleza|certo|combinado|fechado|perfeito|show)\\b",
    "\\b(pode ser|tudo certo|ta certo|tá certo|to sim|tô sim|estarei|vou estar|estarei la|estarei lá)\\b",
    "\\b(vou participar|vou entrar|pode contar|conta comigo|sem problema)\\b",
    "👍|👌|🤝|✅",
  ].join("|"),
  "i",
);

/** Respostas que indicam que NÃO vai dar — tratadas como pedido de remarcação, não confirmação. */
const NEGA_RE = /\b(nao vai dar|não vai dar|nao consigo|não consigo|nao posso|não posso|remarcar|outro dia|outro horario|outro horário|desmarcar|cancelar|imprevisto)\b/i;

function normalizar(texto: string): string {
  return (texto ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
}

export type SinalConfirmacao = "confirmou" | "negou" | "nenhum";

/** Classifica a mensagem do lead quando ele já tem reunião marcada. */
export function classificarConfirmacao(texto: string | null | undefined): SinalConfirmacao {
  const t = normalizar(texto ?? "");
  if (!t) return "nenhum";
  if (NEGA_RE.test(t)) return "negou";
  if (CONFIRMA_RE.test(t)) return "confirmou";
  return "nenhum";
}

/**
 * Registra a confirmação no deal. Guardar em iaFlowStepData (e não só inferir do histórico)
 * deixa o estado visível para o cron e para quem abrir o deal.
 */
export async function marcarConfirmacao(dealId: string, sinal: SinalConfirmacao): Promise<void> {
  if (sinal === "nenhum") return;
  const deal = await prisma.crmDeal.findUnique({ where: { id: dealId }, select: { iaFlowStepData: true } });
  const atual = (deal?.iaFlowStepData ?? {}) as Record<string, unknown>;
  await prisma.crmDeal.update({
    where: { id: dealId },
    data: {
      iaFlowStepData: {
        ...atual,
        _reuniao_confirmada: sinal === "confirmou",
        _reuniao_confirmada_em: new Date().toISOString(),
      } as any,
    },
  }).catch(() => {});
}

/**
 * O lead deu QUALQUER sinal de vida depois do último lembrete enviado?
 * Silêncio total após o lembrete é o preditor de no-show — mais confiável que exigir
 * um "sim" explícito, que boa parte não manda mesmo pretendendo comparecer.
 */
export async function respondeuAposLembrete(dealId: string): Promise<boolean> {
  const ultimoLembrete = await prisma.crmMensagemWhatsapp.findFirst({
    where: { dealId, direcao: "out", conteudo: { contains: "reunião", mode: "insensitive" } },
    orderBy: { enviadaEm: "desc" },
    select: { enviadaEm: true },
  });
  if (!ultimoLembrete) return false;

  const resposta = await prisma.crmMensagemWhatsapp.findFirst({
    where: { dealId, direcao: "in", enviadaEm: { gt: ultimoLembrete.enviadaEm } },
    select: { id: true },
  });
  return !!resposta;
}
