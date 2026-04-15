// ── PIX Webhook — Avoce ────────────────────────────────────────────────
// Recebe notificações do Sicoob quando um PIX de cobrança é pago.
// Atualiza Cobranca.pixStatus = "PAGO".
// Endpoint: POST /api/pix/webhook
// O Sicoob envia: { pix: [{ txid, endToEndId, valor, horario, pagador: { nome, cpf?, cnpj? } }] }

import { prisma } from "../db.js";

export interface PixWebhookBody {
  pix?: Array<{
    txid:        string;
    endToEndId?: string;
    valor?:      string;
    horario?:    string;
    pagador?: {
      nome?:  string;
      cpf?:   string;
      cnpj?:  string;
    };
  }>;
}

export async function handlePixWebhookCobranca(body: PixWebhookBody): Promise<void> {
  for (const ev of body.pix ?? []) {
    if (!ev.txid) continue;

    console.log(`[PIX-Webhook] Recebido txid=${ev.txid} pagador=${ev.pagador?.nome ?? "-"}`);

    const cobranca = await prisma.cobranca.findFirst({
      where: { pixTxid: ev.txid },
      select: { id: true, pixStatus: true },
    });

    if (!cobranca) {
      console.log(`[PIX-Webhook] txid=${ev.txid} não pertence a nenhuma cobrança — ignorando`);
      continue;
    }

    if (cobranca.pixStatus === "PAGO") {
      console.log(`[PIX-Webhook] txid=${ev.txid} já marcado como PAGO — idempotente`);
      continue;
    }

    await prisma.cobranca.update({
      where: { id: cobranca.id },
      data: {
        pixStatus:      "PAGO",
        pixPagadorNome: ev.pagador?.nome ?? null,
        pixPagadorDoc:  ev.pagador?.cpf ?? ev.pagador?.cnpj ?? null,
        pixEndToEndId:  ev.endToEndId ?? null,
        pixPagoEm:      ev.horario ? new Date(ev.horario) : new Date(),
      },
    });

    console.log(`[PIX-Webhook] Cobrança ${cobranca.id}: PIX confirmado (endToEnd=${ev.endToEndId ?? "-"})`);
  }
}
