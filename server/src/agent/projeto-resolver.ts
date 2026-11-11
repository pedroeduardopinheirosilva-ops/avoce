/**
 * Qual projeto atende esta mensagem?
 *
 * Até aqui a resposta era uma só: o webhook procurava o projeto pela instância
 * do Evolution (`IaProjetoConfig.chave = 'evolution_instancia'`) e pronto —
 * uma instância, um projeto.
 *
 * O escritório passou a ter DOIS funis atendidos pelo MESMO número da Judite
 * (instância `psa-docs`): subvenções de ICMS e defesa de auto de infração de
 * ICMS. Com dois projetos declarando a mesma instância, o `findFirst` antigo
 * escolheria um deles por acaso — e metade dos leads cairia no roteiro errado.
 *
 * O desempate vem da própria mensagem. Os hotsites injetam, no fim da primeira
 * mensagem, uma linha de referência legível:
 *
 *     Ref. site PSA: defesa-icms/hero · google/cpc
 *                    └── slug do site, casado com IaProjetoConfig.marcador_site
 *
 * Ordem de decisão (a primeira que resolver, vence):
 *
 *   1. Um único candidato para a instância → é ele. Caminho de sempre, sem custo.
 *   2. O telefone JÁ TEM deal em um dos candidatos → continua nesse projeto.
 *      Continuidade vence marcador: quem está no meio de uma conversa não pula
 *      de funil porque clicou noutro site.
 *   3. A mensagem traz marcador de site que casa com um candidato → é ele.
 *   4. Candidato marcado com `projeto_padrao_instancia = 'true'` → é ele.
 *      É o contato espontâneo: indicação, cartão, número antigo.
 *   5. Nada disso → o primeiro candidato por id, para ser determinístico.
 *
 * Tudo o que é configurável mora no banco (`marcador_site`,
 * `projeto_padrao_instancia`). Nenhum slug de site está escrito aqui.
 */

import { prisma } from "../db.js";

// "Ref. site PSA: <slug>/<contexto> · <campanha>" — o slug é opcional, porque
// links antigos do hotsite de subvenções mandam só o contexto ("hero", "dock").
const RE_REF_SITE = /Ref\.\s*site\s*PSA\s*:\s*([^\n\r]*)/i;

/** Texto de uma mensagem do Evolution, nas formas que ela chega. */
export function textoDaMensagem(msg: any): string {
  const m = msg?.message ?? {};
  return String(
    m.conversation ??
      m.extendedTextMessage?.text ??
      m.imageMessage?.caption ??
      m.videoMessage?.caption ??
      m.documentMessage?.caption ??
      "",
  );
}

/**
 * Slug do hotsite declarado na linha de referência, ou null.
 * "Ref. site PSA: defesa-icms/hero · google/cpc" → "defesa-icms"
 * "Ref. site PSA: hero · direto"                 → null (formato antigo, sem slug)
 */
export function slugDoSite(texto: string): string | null {
  const achou = RE_REF_SITE.exec(texto);
  if (!achou) return null;
  const contexto = (achou[1].split("·")[0] ?? "").trim();
  if (!contexto.includes("/")) return null;
  const slug = contexto.split("/")[0].trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]{1,40}$/.test(slug) ? slug : null;
}

/** Telefone em variantes com e sem o 9º dígito — o JID varia por idade da conta. */
export function variantesTelefone(phone: string): string[] {
  const d = String(phone).replace(/\D/g, "");
  const v = new Set<string>([d]);
  if (d.startsWith("55") && d.length === 13) v.add(d.slice(0, 4) + d.slice(5));
  if (d.startsWith("55") && d.length === 12) v.add(d.slice(0, 4) + "9" + d.slice(4));
  return [...v];
}

export interface CandidatoProjeto {
  projetoId: string;
  marcadorSite: string | null;
  ehPadrao: boolean;
}

/** Projetos ativos que declaram esta instância do Evolution. */
export async function candidatosDaInstancia(instancia: string): Promise<CandidatoProjeto[]> {
  const configs = await prisma.iaProjetoConfig.findMany({
    where: { chave: "evolution_instancia", valor: instancia },
    select: { projetoId: true },
  });
  const ids = configs.map((c) => c.projetoId).filter(Boolean) as string[];
  if (ids.length === 0) return [];

  const [projetos, extras] = await Promise.all([
    prisma.iaProjeto.findMany({
      where: { id: { in: ids }, ativo: true },
      select: { id: true },
      orderBy: { id: "asc" },
    }),
    prisma.iaProjetoConfig.findMany({
      where: { projetoId: { in: ids }, chave: { in: ["marcador_site", "projeto_padrao_instancia"] } },
      select: { projetoId: true, chave: true, valor: true },
    }),
  ]);

  return projetos.map((p) => {
    const meus = extras.filter((e) => e.projetoId === p.id);
    const marcador = meus.find((e) => e.chave === "marcador_site")?.valor?.trim().toLowerCase();
    const padrao = meus.find((e) => e.chave === "projeto_padrao_instancia")?.valor?.trim().toLowerCase();
    return {
      projetoId: p.id,
      marcadorSite: marcador || null,
      ehPadrao: padrao === "true" || padrao === "1" || padrao === "sim",
    };
  });
}

export interface ProjetoResolvido {
  projetoId: string;
  motivo: "unico" | "deal_existente" | "marcador_site" | "padrao_instancia" | "primeiro";
}

/** Escolhe o projeto para esta mensagem. Ver a ordem de decisão no topo. */
export async function resolverProjeto(
  candidatos: CandidatoProjeto[],
  phone: string,
  msg: any,
): Promise<ProjetoResolvido | null> {
  if (candidatos.length === 0) return null;
  if (candidatos.length === 1) return { projetoId: candidatos[0].projetoId, motivo: "unico" };

  const ids = candidatos.map((c) => c.projetoId);

  // 2. Conversa já em andamento manda mais que qualquer marcador.
  const contatos = await prisma.crmContato.findMany({
    where: { whatsapp: { in: variantesTelefone(phone) } },
    select: { id: true },
  });
  if (contatos.length > 0) {
    // O mesmo celular pode estar em mais de um funil: o contador informa o
    // próprio número no cadastro das empresas clientes, então a empresa (funil de
    // subvenção, sem conversa) e o contador (funil de contadores, abordado pela
    // Judite) dividem o telefone. Vence o deal ABERTO com contato mais recente —
    // e deal que nunca conversou (ultimoContatoEm null) vai para o fim, porque no
    // Postgres o DESC põe NULL primeiro.
    const deal = await prisma.crmDeal.findFirst({
      where: { contatoId: { in: contatos.map((c) => c.id) }, projetoId: { in: ids }, status: "aberto" },
      orderBy: [{ ultimoContatoEm: { sort: "desc", nulls: "last" } }, { criadoEm: "desc" }],
      select: { projetoId: true },
    });
    if (deal?.projetoId) return { projetoId: deal.projetoId, motivo: "deal_existente" };
    // Cliente já ganho volta pelo mesmo projeto em que fechou.
    const ganho = await prisma.crmDeal.findFirst({
      where: { contatoId: { in: contatos.map((c) => c.id) }, projetoId: { in: ids }, status: "ganho" },
      orderBy: { atualizadoEm: "desc" },
      select: { projetoId: true },
    });
    if (ganho?.projetoId) return { projetoId: ganho.projetoId, motivo: "deal_existente" };
  }

  // 3. Marcador do hotsite na mensagem.
  const slug = slugDoSite(textoDaMensagem(msg));
  if (slug) {
    const casou = candidatos.find((c) => c.marcadorSite === slug);
    if (casou) return { projetoId: casou.projetoId, motivo: "marcador_site" };
  }

  // 4. Projeto padrão da instância (contato espontâneo).
  const padrao = candidatos.find((c) => c.ehPadrao);
  if (padrao) return { projetoId: padrao.projetoId, motivo: "padrao_instancia" };

  // 5. Determinístico, para nunca variar entre reinícios.
  return { projetoId: candidatos[0].projetoId, motivo: "primeiro" };
}
