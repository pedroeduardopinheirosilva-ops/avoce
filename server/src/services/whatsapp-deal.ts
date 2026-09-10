/**
 * Envio de texto para o WhatsApp do contato de um lead, reaproveitando a mesma
 * instância Evolution da conversa que o lead já tem (a do projeto de IA dele).
 *
 * Existe para que router e cron enviem pelo mesmo caminho: a resolução de
 * instância estava inline em `ia.sendMensagemManual` e não dava para reusar.
 */

import { prisma } from "../db.js";
import { sendText } from "./evolution.js";

export const REMETENTE_PADRAO = "Equipe Jurídica";

export interface ResultadoEnvio {
  mensagemId: string;
  remetente: string;
}

/**
 * Manda `conteudo` para o contato do deal e registra na timeline da conversa.
 * O nome do remetente vai em negrito na primeira linha, padrão do escritório.
 */
export async function enviarTextoParaDeal(
  dealId: string,
  conteudo: string,
  remetente: string = REMETENTE_PADRAO,
): Promise<ResultadoEnvio> {
  const deal = await prisma.crmDeal.findUnique({
    where: { id: dealId },
    include: { contato: true },
  });
  if (!deal) throw new Error("Lead não encontrado");
  if (!deal.contatoId) throw new Error("Lead sem contato vinculado");

  const phone = deal.contato?.whatsapp;
  if (!phone) throw new Error("Contato sem WhatsApp");

  // Deal sem projeto ainda pode ser atendido pela instância da empresa dele.
  let projetoId = deal.projetoId;
  if (!projetoId && deal.empresaId) {
    const projeto = await prisma.iaProjeto.findFirst({ where: { empresaId: deal.empresaId } });
    projetoId = projeto?.id ?? null;
  }
  if (!projetoId) throw new Error("Nenhum projeto WhatsApp configurado para esta empresa");

  const configs = await prisma.iaProjetoConfig.findMany({
    where: { projetoId, categoria: "whatsapp" },
  });
  const get = (k: string) => configs.find((c) => c.chave === k)?.valor ?? "";
  const evoConfig = {
    baseUrl:    get("evolution_api_url"),
    apiKey:     get("evolution_api_key"),
    instancia:  get("evolution_instancia"),
  };
  if (!evoConfig.baseUrl) throw new Error("Evolution API não configurada");

  const textoEnvio = `*${remetente}*\n${conteudo}`;
  const sendResult = await sendText(evoConfig, phone, textoEnvio);

  const registro = await prisma.crmMensagemWhatsapp.create({
    data: {
      dealId:             deal.id,
      contatoId:          deal.contatoId,
      direcao:            "out",
      tipo:               "text",
      conteudo:           textoEnvio,
      remetente,
      evolutionMessageId: sendResult?.key?.id ?? null,
    },
  });

  return { mensagemId: registro.id, remetente };
}

/** Nome que assina a mensagem: responsável do lead, senão o padrão. */
export async function remetenteDoDeal(responsavelId: string | null | undefined): Promise<string> {
  if (!responsavelId) return REMETENTE_PADRAO;
  const u = await prisma.usuario.findUnique({ where: { id: responsavelId }, select: { nome: true } });
  return u?.nome?.trim() || REMETENTE_PADRAO;
}
