/**
 * Quem está atendendo cada conversa no painel, para atribuir a mensagem que sai
 * direto pelo WhatsApp (celular / WhatsApp Web do número do escritório).
 *
 * O webhook fromMe não diz QUAL pessoa mandou — o número é compartilhado. Antes o
 * remetente vinha de `deal.iaPausadaPor`, ou seja, de quem assumiu a conversa: se
 * a Kamilla assumiu e o Dr. Guilherme mandou um áudio, o áudio ficava como da
 * Kamilla (Gilson 5096, 27/10). Quem está com a conversa ABERTA no Avoce na hora
 * é um sinal muito melhor: a tela consulta `ia.getMensagens` a cada 5 s com o
 * usuário logado.
 *
 * Fica em memória: o Avoce roda em uma instância só (PM2 cluster, instances 1).
 * Se reiniciar, perde-se só a janela recente e o fallback volta a ser quem assumiu.
 */

import { prisma } from "../db.js";

/** Até quanto tempo depois do último poll a pessoa ainda conta como "na conversa". */
const JANELA_ATIVO_MS = 15 * 60_000;
/** Sem poll por mais que isso = saiu e voltou: conta como nova abertura. */
const GAP_REABERTURA_MS = 60_000;

interface Visita { abriuEm: number; vistoEm: number }

const _porDeal = new Map<string, Map<string, Visita>>();

export function registrarQuemVe(dealId: string, userId: string | null | undefined): void {
  if (!userId) return;
  const agora = Date.now();
  let visitas = _porDeal.get(dealId);
  if (!visitas) { visitas = new Map(); _porDeal.set(dealId, visitas); }
  const v = visitas.get(userId);
  if (v && agora - v.vistoEm <= GAP_REABERTURA_MS) v.vistoEm = agora;
  else visitas.set(userId, { abriuEm: agora, vistoEm: agora });
}

/**
 * Usuário que abriu a conversa por último entre os que ainda estão nela.
 * Com duas pessoas na mesma conversa, quem acabou de abrir é quem vai responder.
 */
export function quemEstaAtendendo(dealId: string): string | null {
  const visitas = _porDeal.get(dealId);
  if (!visitas) return null;
  const agora = Date.now();
  let melhor: { userId: string; abriuEm: number } | null = null;
  for (const [userId, v] of visitas) {
    if (agora - v.vistoEm > JANELA_ATIVO_MS) { visitas.delete(userId); continue; }
    if (!melhor || v.abriuEm > melhor.abriuEm) melhor = { userId, abriuEm: v.abriuEm };
  }
  if (!visitas.size) _porDeal.delete(dealId);
  return melhor?.userId ?? null;
}

/** Nome que assina pelo usuário no projeto: nomeWhatsapp → nome do usuário. */
export async function nomeDoAtendente(userId: string, projetoId: string | null | undefined): Promise<string | null> {
  const [membro, usuario] = await Promise.all([
    projetoId
      ? prisma.iaProjetoUsuario.findUnique({ where: { projetoId_usuarioId: { projetoId, usuarioId: userId } } })
      : null,
    prisma.usuario.findUnique({ where: { id: userId }, select: { nome: true } }),
  ]);
  return membro?.nomeWhatsapp?.trim() || usuario?.nome?.trim() || null;
}
