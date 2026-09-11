/**
 * Documento assinado no PAKT → acervo do deal.
 *
 * Existiam três implementações disso, cada uma com sua regra: o módulo de
 * Assinaturas (tabela Assinatura), o webhook em index.ts (que salvava só em
 * uploads/propostas-signed) e o cron de follow-up. Contrato e procuração do
 * fluxo nascem direto na API do PAKT, então caíam entre as três. Aqui é o
 * único lugar que sabe pegar um documento assinado e arquivá-lo no deal.
 *
 * Chamado pelo webhook (instantâneo) e pelo follow-up (rede de segurança para
 * webhook perdido). Idempotente: reprocessar não duplica.
 */

import { prisma } from "../db.js";

/** Nome estável do arquivo — é ele que impede a duplicata entre as passadas. */
function nomeDoAnexo(titulo: string): string {
  return `${titulo.replace(/[^\w\s.-]/g, "").trim()}-assinado.pdf`;
}

/**
 * Descobre o deal de uma proposta. A ligação vive na nota que o fluxo grava ao
 * criar a proposta — não há coluna direta entre as duas tabelas.
 */
export async function dealIdDaProposta(propostaId: string): Promise<string | undefined> {
  const nota = await prisma.crmNota.findFirst({
    where: {
      conteudo: { startsWith: "[IA] Proposta criada automaticamente:", contains: propostaId },
    },
    select: { dealId: true },
    orderBy: { criadoEm: "desc" },
  });
  return nota?.dealId ?? undefined;
}

/**
 * Arquiva no deal cada documento da proposta que já esteja assinado.
 *
 * Documento a documento, de propósito: esperar o envelope inteiro deixava o
 * contrato já assinado invisível enquanto a procuração não fosse assinada.
 * Devolve quantos anexos foram criados nesta passada.
 */
export async function anexarAssinadosAoDeal(
  paktDocumentId: string | null,
  dealId: string | undefined,
  paktApiKey: string,
  paktBaseUrl: string,
): Promise<number> {
  if (!paktDocumentId || !dealId || !paktApiKey) return 0;

  let docs: Array<{ id: string; titulo?: string }>;
  try {
    const parsed = JSON.parse(paktDocumentId);
    docs = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    // paktDocumentId antigo era um id solto, não JSON.
    docs = [{ id: paktDocumentId }];
  }

  const [{ paktBaixarPdf }, { salvarAnexoDeal }, { tipoDoAssinado }] = await Promise.all([
    import("../lib/pakt.js"),
    import("./deal-anexos.js"),
    import("../modules/assinaturas/assinatura-service.js"),
  ]);

  let anexados = 0;
  for (const d of docs) {
    if (!d?.id) continue;
    const titulo = d.titulo ?? "Documento";
    const nomeArquivo = nomeDoAnexo(titulo);
    try {
      const res = await fetch(`${paktBaseUrl}/api/v1/documents/${d.id}`, {
        headers: { Authorization: `Bearer ${paktApiKey}` },
      }).catch(() => null);
      if (!res?.ok) continue;
      const info = (await res.json()) as { status?: string };
      if ((info.status ?? "").toUpperCase() !== "COMPLETED") continue;

      if (await prisma.dealAnexo.findFirst({ where: { dealId, nomeArquivo } })) continue;

      const pdf = await paktBaixarPdf(d.id, "final");
      if (!pdf?.length) continue;

      await salvarAnexoDeal(dealId, pdf, "application/pdf", nomeArquivo, null, null, tipoDoAssinado(titulo));
      anexados++;
      console.log(`[Assinados] "${titulo}" anexado ao deal ${dealId} como ${tipoDoAssinado(titulo)}`);
    } catch (e) {
      // Arquivar é melhoria: nunca derrubar o webhook nem o follow-up por isto.
      console.error(`[Assinados] falha ao anexar "${titulo}" no deal ${dealId}:`, (e as Error).message);
    }
  }
  return anexados;
}

/** Conveniência para quem tem a proposta em mãos e não o dealId. */
export async function sincronizarAssinadosDaProposta(
  propostaId: string,
  paktDocumentId: string | null,
  paktApiKey: string,
  paktBaseUrl: string,
): Promise<number> {
  const dealId = await dealIdDaProposta(propostaId);
  if (!dealId) return 0;
  return anexarAssinadosAoDeal(paktDocumentId, dealId, paktApiKey, paktBaseUrl);
}
