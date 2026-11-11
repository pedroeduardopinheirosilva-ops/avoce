/**
 * Entregáveis — vídeo (ou imagem/PDF) curto da advogada sobre a dor principal do lead,
 * enviado quando ele termina a triagem.
 *
 * Origem: mentoria comercial de 12/09/2026. O caminhoneiro é desconfiado; um vídeo da
 * Dra. Daniela falando da dor dele (horas extras, tempo de espera, diárias…) aquece o lead
 * antes da ligação da SDR e, com o tempo, substitui a ligação longa de "criar confiança".
 *
 * Quem envia é o cron (a cada 15 min), não o gancho de mudança de etapa: assim vale para
 * qualquer caminho de entrada na etapa (IA qualificou, SDR moveu o card) e respeita o
 * horário de envio. Só entra quem chegou na etapa nas últimas JANELA_HORAS — nunca dispara
 * para o estoque antigo de qualificados.
 */

import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { prisma } from "../db.js";
import { getEvolutionConfig } from "./message-handler.js";
import { podeEnviarAgora } from "./quiet-hours.js";
import { sendVideo, sendImage, sendDocument } from "../services/evolution.js";

const JANELA_HORAS = 72;
const ETAPA_PADRAO = "lead_qualificado";

type Entregavel = {
  id: string;
  chave: string;
  titulo: string;
  palavrasChave: string;
  legenda: string | null;
  arquivoPath: string | null;
  arquivoTipo: string | null;
  arquivoNome: string | null;
  padrao: boolean;
};

const normalizar = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

export function urlPublicaEntregavel(id: string): string {
  return `${process.env.APP_BASE_URL ?? "https://avoce.capium.com.br"}/api/ia-entregavel/${id}/arquivo`;
}

/**
 * Escolhe o entregável pela dor do lead: conta quantos termos de cada entregável aparecem na
 * qualificação e nas mensagens que o lead mandou. Empate fica com a menor `ordem`. Nenhum casou
 * → o marcado como `padrao` (se houver).
 */
export function escolherEntregavel(entregaveis: Entregavel[], corpus: string): Entregavel | null {
  const texto = normalizar(corpus);
  let melhor: { e: Entregavel; pontos: number } | null = null;
  for (const e of entregaveis) {
    const termos = e.palavrasChave.split("|").map((t) => normalizar(t.trim())).filter(Boolean);
    const pontos = termos.filter((t) => texto.includes(t)).length;
    if (pontos > 0 && (!melhor || pontos > melhor.pontos)) melhor = { e, pontos };
  }
  return melhor?.e ?? entregaveis.find((e) => e.padrao) ?? null;
}

export async function corpusDoDeal(dealId: string): Promise<string> {
  const [deal, msgs] = await Promise.all([
    prisma.crmDeal.findUnique({ where: { id: dealId }, select: { qualificacao: true, descricao: true } }),
    prisma.crmMensagemWhatsapp.findMany({
      where: { dealId, direcao: "in" },
      orderBy: { enviadaEm: "desc" },
      take: 40,
      select: { conteudo: true, transcricao: true },
    }),
  ]);
  // Chaves internas (_q_asked_at etc.) só poluem a busca.
  const qualif = Object.entries((deal?.qualificacao as Record<string, unknown>) ?? {})
    .filter(([k]) => !k.startsWith("_"))
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join("\n");
  const falas = msgs.map((m) => m.transcricao || m.conteudo || "").join("\n");
  return [qualif, deal?.descricao ?? "", falas].join("\n");
}

/** Envia o arquivo do entregável pelo Evolution. Devolve o id da mensagem (ou null). */
export async function dispararEntregavel(
  projetoId: string,
  e: Entregavel,
  phone: string,
): Promise<string | null> {
  if (!e.arquivoPath || !existsSync(e.arquivoPath)) throw new Error(`Entregável "${e.titulo}" sem arquivo`);
  const evo = await getEvolutionConfig(projetoId);
  if (!evo) throw new Error("Projeto sem WhatsApp configurado");
  const legenda = e.legenda ?? undefined;
  let res;
  if (e.arquivoTipo === "video") {
    res = await sendVideo(evo, phone, urlPublicaEntregavel(e.id), legenda);
  } else if (e.arquivoTipo === "image") {
    res = await sendImage(evo, phone, urlPublicaEntregavel(e.id), legenda);
  } else {
    const b64 = (await readFile(e.arquivoPath)).toString("base64");
    res = await sendDocument(evo, phone, b64, e.arquivoNome ?? `${e.chave}.pdf`, legenda);
  }
  const id = res?.key?.id;
  return id && id !== "TEST_SKIP" ? id : null;
}

/**
 * Cron: envia o entregável a quem entrou na etapa-alvo nas últimas JANELA_HORAS e ainda não
 * recebeu nenhum. Etapa-alvo por projeto em IaProjetoConfig `entregavel_etapa` (lista separada
 * por vírgula), padrão `lead_qualificado`.
 */
export async function enviarEntregaveisPendentes(): Promise<void> {
  const porProjeto = await prisma.iaEntregavel.findMany({
    where: { ativo: true, arquivoPath: { not: null } },
    orderBy: [{ ordem: "asc" }, { criadoEm: "asc" }],
  });
  const projetos = [...new Set(porProjeto.map((e) => e.projetoId))];
  const desde = new Date(Date.now() - JANELA_HORAS * 3600_000);

  for (const projetoId of projetos) {
    try {
      if (!(await podeEnviarAgora(projetoId))) continue;
      const entregaveis = porProjeto.filter((e) => e.projetoId === projetoId);
      const cfg = await prisma.iaProjetoConfig.findFirst({ where: { projetoId, chave: "entregavel_etapa" } });
      const etapas = (cfg?.valor || ETAPA_PADRAO).split(",").map((s) => s.trim()).filter(Boolean);

      const stagesAlvo = (await prisma.crmStage.findMany({
        where: { chave: { in: etapas }, pipeline: { projetos: { some: { id: projetoId } } } },
        select: { id: true },
      })).map((s) => s.id);
      if (!stagesAlvo.length) continue;

      // Entrou numa etapa-alvo dentro da janela E continua nela.
      const entradas = await prisma.crmDealStageLog.findMany({
        where: {
          criadoEm: { gte: desde },
          stageNovoId: { in: stagesAlvo },
          deal: { projetoId, status: "aberto", stageId: { in: stagesAlvo } },
        },
        select: { dealId: true },
        distinct: ["dealId"],
      });

      for (const entrada of entradas) {
        const deal = await prisma.crmDeal.findUnique({
          where: { id: entrada.dealId },
          select: { id: true, empresaId: true, contatoId: true, qualificacao: true, contato: { select: { whatsapp: true } } },
        });
        const phone = deal?.contato?.whatsapp;
        if (!deal || !phone) continue;
        if (((deal.qualificacao as Record<string, unknown>) ?? {})._entregavel_enviado) continue;

        const escolhido = escolherEntregavel(entregaveis, await corpusDoDeal(deal.id));
        if (!escolhido) continue;

        // Marca ANTES de enviar: se o envio falhar no meio, preferimos não mandar em dobro.
        const marca = JSON.stringify({ chave: escolhido.chave, em: new Date().toISOString() });
        const travou: number = await prisma.$executeRaw`
          UPDATE "CrmDeal"
          SET qualificacao = COALESCE(qualificacao, '{}'::jsonb) || jsonb_build_object('_entregavel_enviado', ${marca}::jsonb)
          WHERE id = ${deal.id} AND NOT (COALESCE(qualificacao, '{}'::jsonb) ? '_entregavel_enviado')`;
        if (travou === 0) continue;

        try {
          const msgId = await dispararEntregavel(projetoId, escolhido, phone);
          await prisma.crmMensagemWhatsapp.create({
            data: {
              empresaId: deal.empresaId,
              dealId: deal.id,
              contatoId: deal.contatoId,
              direcao: "out",
              remetente: "Entregável",
              tipo: escolhido.arquivoTipo ?? "document",
              conteudo: escolhido.legenda || `📎 ${escolhido.titulo}`,
              midiaUrl: urlPublicaEntregavel(escolhido.id),
              evolutionMessageId: msgId,
            },
          });
          console.log(`[Entregavel] deal=${deal.id} ← "${escolhido.chave}"`);
        } catch (err: any) {
          console.warn(`[Entregavel] falha deal=${deal.id} "${escolhido.chave}": ${err?.message ?? err}`);
        }
      }
    } catch (err: any) {
      console.error(`[Entregavel] erro projeto=${projetoId}: ${err?.message ?? err}`);
    }
  }
}
