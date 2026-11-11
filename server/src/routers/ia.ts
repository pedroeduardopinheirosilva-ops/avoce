import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, authProc } from "./trpc.js";
import { prisma } from "../db.js";
import { whereEmpresa, canOperate } from "./tenant-utils.js";
import { whereTagVisivel } from "./crm.js";
import { invalidateClientCache } from "../agent/llm.js";
import { fieldEncryptIfPlain } from "../lib/field-crypto.js";
import { registrarQuemVe } from "../services/quem-atende.js";

// ──────────────────────────────────────────────────────────────────────────────
// Seed data — Projeto Carreteiros
// ──────────────────────────────────────────────────────────────────────────────

const INSTRUCAO_BASE = `
REGRAS INVIOLÁVEIS DE COMUNICAÇÃO:

1. HUMANIZAÇÃO ABSOLUTA
Você é uma pessoa real da equipe do escritório conversando pelo WhatsApp. Nunca use linguagem de sistema, bot ou formulário. Nunca ofereça opções numeradas. Nunca use "Sim ou Não" explícito. Nunca mencione "processando", "salvando", "registrando" ou qualquer linguagem técnica. Reaja como um ser humano reagiria em cada situação.

2. NUNCA REVELAR NATUREZA
Se o cliente perguntar se você é IA, robô, assistente virtual, humano ou qualquer variação: NUNCA confirme. NUNCA negue diretamente. Desvie de forma leve e natural, reafirme que faz parte da equipe do escritório e redirecione para o assunto do caso.

Exemplos de desvio:
"Sou do time do escritório! Mas me fala — o que tá acontecendo com o seu caso?"
"Pode falar comigo normalmente, tô aqui pelo seu caso mesmo."
"Haha, por quê? Pareceu estranho? 😄 Pode falar à vontade!"

3. CONFIRMAÇÕES HUMANAS
Nunca pergunte "Está correto? Sim ou Não". Confirme como pessoa relendo: "Deixa eu ver se peguei tudo certo — você é {nome}, mora em {cidade}, né?"

4. REAÇÃO A ÁUDIOS
Nunca mencione que recebeu um áudio ou transcreveu. Responda ao conteúdo naturalmente.

5. FORMATAÇÃO
Sempre iniciar com *{nome_persona}* em negrito. Máximo 4 linhas por bloco. Parágrafos separados por linha em branco. Emojis com moderação — máximo 2 por mensagem.
`.trim();

const PERSONA_ASSISTENTE_PROMPT = `Você é Ana, do escritório Pinheiro Silva Advogados, especializado em direitos trabalhistas de motoristas carreteiros na Bahia.

PAPEL: Primeiro contato. Recepcionar o lead e coletar dados dos vínculos trabalhistas de forma natural. Máximo 2 perguntas por mensagem.

CONTEXTO JURÍDICO:
- Prescrição trabalhista: 2 anos após saída (CLT art. 11)
- FGTS: prescrição 5 anos
- Sem registro: direito a CTPS, 13º, férias, FGTS, horas extras, DSR, adicional noturno
- Jornada legal: 8h/dia, 44h/semana (CLT art. 58)
- Lei do Motorista: 12.619/2012 e 13.103/2015
- Investigar sempre 2 vínculos: recente e anterior

AO COMPLETAR QUALIFICAÇÃO:
Migrar para Dra. Daniela sem quebra perceptível.

{INSTRUÇÃO BASE}`;

const PERSONA_ADVOGADO_PROMPT = `Você é a Dra. Daniela Pires, advogada do escritório Pinheiro Silva responsável pela análise e fechamento.

AO ASSUMIR:
Apresentar-se, demonstrar que leu o caso, dar parecer jurídico com segurança. Transição natural.

Exemplo:
"*Dra. Daniela Pires*
Oi {nome}! Sou a Dra. Daniela, advogada do escritório. A Ana me passou seu caso.
Analisei o que você relatou — você tem direitos sim a reclamar. Me deixa explicar..."

APÓS INTERESSE CONFIRMADO:
Solicitar documentos em sequência natural: CNH frente → CNH verso → Comprovante endereço

{INSTRUÇÃO BASE}`;

const PERSONA_CLOSER_PROMPT = `Você é a Dra. Daniela Pires reengajando cliente que parou de responder. Máximo 2 tentativas.

Tentativa 1:
"*Dra. Daniela Pires*
{nome}, só passando pra lembrar que o prazo pra ação trabalhista é de 2 anos.
Pelo seu caso ainda dá tempo — mas corre. 👊
Quando quiser avançar é só falar."

Tentativa 2 (após 48h):
"*Dra. Daniela Pires*
{nome}, em casos parecidos com o seu costumamos recuperar valores significativos.
Sem custo antecipado nenhum pra você.
Vale a conversa — o que acha?"

Após 2 tentativas sem resposta → parar completamente.

{INSTRUÇÃO BASE}`;

// ──────────────────────────────────────────────────────────────────────────────
// Acesso a deals do WhatsApp
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Um deal é operável por quem tem a empresa dona do deal entre as suas — inclusive
 * pelas empresas extras de `permissoes.empresas`, e não só pela empresa primária.
 * Atendente de uma empresa do grupo operando o projeto de outra é o caso normal aqui.
 */
function assertPodeOperarDeal(
  ctx: { empresaId?: string; empresaIds?: string[]; role?: string },
  deal: { empresaId: string | null },
): void {
  if (canOperate(ctx, deal.empresaId)) return;
  throw new TRPCError({ code: "FORBIDDEN", message: "Deal não pertence à sua empresa" });
}

// ──────────────────────────────────────────────────────────────────────────────
// Router
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Filtros da caixa do WhatsApp IA. Os funis (Carreteiros, Defesa ICMS, Subvenção,
 * Contadores…) dividem a mesma caixa; sem filtro o SDR de um funil garimpava as
 * conversas dele no meio das dos outros.
 */
const filtroConversas = z.object({
  projetoId: z.string().optional(),
  pipelineId: z.string().optional(),
  /** Conversa com QUALQUER uma destas tags (mesma regra do filtro do Kanban). */
  tagIds: z.array(z.string()).optional(),
  semTag: z.boolean().optional(),
  atendimento: z.enum(["ia", "humano"]).optional(),
  /** Última mensagem é do lead — ninguém respondeu ainda. */
  aguardando: z.boolean().optional(),
  /** Próximo follow-up vence hoje ou já passou (rotina diária do SDR). */
  followup: z.boolean().optional(),
  /** Esconde as conversas abertas por comentário/Live do Instagram ou Facebook. */
  semComentarios: z.boolean().optional(),
});

/** Títulos de origem gravados em meta-social.ts: "Comentário Instagram · FILA", "Live Facebook · comentario"... */
const PREFIXOS_COMENTARIO = ["Comentário Instagram", "Comentário Facebook", "Live Instagram", "Live Facebook"];
const VEIO_DE_COMENTARIO = {
  OR: PREFIXOS_COMENTARIO.map((p) => ({ origemAnuncioTitulo: { startsWith: p } })),
};
/** O título nulo entra de propósito: NOT sobre coluna nula dá NULL no SQL e a conversa sem origem sumiria junto. */
const NAO_VEIO_DE_COMENTARIO = {
  OR: [{ origemAnuncioTitulo: null }, { NOT: VEIO_DE_COMENTARIO }],
};

/** Fim do dia de hoje em São Paulo — "vence hoje" inclui o dia inteiro. */
function fimDeHojeSP(): Date {
  const hoje = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
  return new Date(new Date(`${hoje}T00:00:00-03:00`).getTime() + 24 * 3600_000);
}

function whereFiltroConversas(f: z.infer<typeof filtroConversas>): Record<string, unknown> {
  return {
    ...(f.projetoId ? { projetoId: f.projetoId } : {}),
    ...(f.pipelineId ? { pipelineId: f.pipelineId } : {}),
    ...(f.tagIds?.length ? { tags: { some: { id: { in: f.tagIds } } } } : f.semTag ? { tags: { none: {} } } : {}),
    ...(f.atendimento ? { iaAtiva: f.atendimento === "ia" } : {}),
    ...(f.followup ? { status: "aberto", proximoContatoEm: { lt: fimDeHojeSP() } } : {}),
    // Em AND porque a busca global usa o OR do nível de cima para os termos.
    ...(f.semComentarios ? { AND: [NAO_VEIO_DE_COMENTARIO] } : {}),
  };
}

const includeConversa = {
  contato: true,
  mensagens: { orderBy: { enviadaEm: "desc" as const }, take: 1 },
  stage: { select: { pipelineId: true, nome: true, cor: true } },
  pipeline: { select: { id: true, nome: true, cor: true } },
  tags: { select: { id: true, nome: true, cor: true, pipelineId: true } },
};

/**
 * Variantes de um número para busca "por pedaço", porque o banco guarda o
 * WhatsApp em formatos diferentes: com e sem DDI 55, com e sem o 9º dígito
 * (`557799656376` convive com `5577999656376`) e com máscara em `telefone`.
 * Sem isso, colar "(77) 99965-6376" da agenda não achava nada.
 */
function variantesNumero(digitos: string): string[] {
  const v = new Set<string>([digitos]);
  let d = digitos;
  if (d.startsWith("55") && d.length >= 12) { d = d.slice(2); v.add(d); }
  if (d.length === 11 && d[2] === "9") v.add(d.slice(0, 2) + d.slice(3)); // sem 9º dígito
  if (d.length === 10) v.add(d.slice(0, 2) + "9" + d.slice(2));           // com 9º dígito
  if (d.length === 9 && d[0] === "9") v.add(d.slice(1));                  // sem DDD, sem o 9
  if (d.length === 8) v.add("9" + d);
  return [...v];
}

export const iaRouter = router({
  // ── Projetos ──────────────────────────────────────────────────────────────

  listProjetos: authProc.query(({ ctx }) =>
    prisma.iaProjeto.findMany({ where: whereEmpresa(ctx), orderBy: { criadoEm: "asc" } })
  ),

  /**
   * Números de onde se pode abrir uma conversa nova: um item por projeto ativo, com a
   * instância Evolution e o telefone/nome do perfil conectado nela. O número vem do próprio
   * Evolution (best-effort, 3s) — se não responder, a tela mostra só o nome da instância.
   */
  listCanaisNovaConversa: authProc.query(async ({ ctx }) => {
    const projetos = await prisma.iaProjeto.findMany({
      where: { ...whereEmpresa(ctx), ativo: true },
      orderBy: { criadoEm: "asc" },
      select: {
        id: true, nome: true, empresaId: true,
        configs: { where: { categoria: "whatsapp" }, select: { chave: true, valor: true } },
      },
    });
    const empresas = await prisma.empresa.findMany({
      where: { id: { in: projetos.map((p) => p.empresaId).filter(Boolean) as string[] } },
      select: { id: true, nome: true },
    });
    const empresaNome = new Map(empresas.map((e) => [e.id, e.nome]));

    const perfis = new Map<string, Promise<{ telefone: string | null; perfil: string | null; status: string | null }>>();
    const perfilDa = (baseUrl: string, apiKey: string, instancia: string) => {
      const chave = `${baseUrl}|${instancia}`;
      if (!perfis.has(chave)) {
        perfis.set(chave, (async () => {
          try {
            const r = await fetch(`${baseUrl}/instance/fetchInstances?instanceName=${encodeURIComponent(instancia)}`, {
              headers: { apikey: apiKey }, signal: AbortSignal.timeout(3000),
            });
            const lista = (await r.json()) as Array<{ ownerJid?: string; profileName?: string; connectionStatus?: string }>;
            const i = Array.isArray(lista) ? lista[0] : undefined;
            return {
              telefone: i?.ownerJid?.split("@")[0] ?? null,
              perfil: i?.profileName ?? null,
              status: i?.connectionStatus ?? null,
            };
          } catch {
            return { telefone: null, perfil: null, status: null };
          }
        })());
      }
      return perfis.get(chave)!;
    };

    const canais = await Promise.all(projetos.map(async (p) => {
      const get = (k: string) => p.configs.find((c) => c.chave === k)?.valor ?? "";
      const baseUrl = get("evolution_api_url"), apiKey = get("evolution_api_key"), instancia = get("evolution_instancia");
      const info = baseUrl && instancia ? await perfilDa(baseUrl, apiKey, instancia) : null;
      return {
        projetoId: p.id,
        projetoNome: p.nome,
        empresaNome: (p.empresaId && empresaNome.get(p.empresaId)) || null,
        instancia: instancia || null,
        telefone: info?.telefone ?? null,
        perfil: info?.perfil ?? null,
        conectado: info?.status ? info.status === "open" : null,
      };
    }));
    return canais.filter((c) => c.instancia);
  }),

  getProjeto: authProc
    .input(z.object({ id: z.string() }))
    .query(async ({ input, ctx }) => {
      const projeto = await prisma.iaProjeto.findUnique({
        where: { id: input.id },
        include: { configs: true, personas: { orderBy: { ordem: "asc" } }, fases: { orderBy: { ordem: "asc" } } },
      });
      if (!projeto) throw new Error("Projeto não encontrado");
      if (!canOperate(ctx, projeto.empresaId)) throw new Error("Projeto não pertence à sua empresa");
      return projeto;
    }),

  createProjeto: authProc
    .input(z.object({ nome: z.string(), descricao: z.string().optional(), whatsappInstancia: z.string().optional() }))
    .mutation(({ input, ctx }) =>
      prisma.iaProjeto.create({ data: { ...input, empresaId: ctx.empresaId ?? undefined } })
    ),

  updateProjeto: authProc
    .input(z.object({ id: z.string(), nome: z.string().optional(), ativo: z.boolean().optional(), whatsappInstancia: z.string().optional() }))
    .mutation(async ({ input, ctx }) => {
      const { id, ...data } = input;
      const p = await prisma.iaProjeto.findUnique({ where: { id }, select: { empresaId: true } });
      if (!p || !canOperate(ctx, p.empresaId)) throw new Error("Projeto não pertence à sua empresa");
      return prisma.iaProjeto.update({ where: { id }, data });
    }),

  // Cria (ou reaproveita) um CrmPipeline dedicado para o projeto e vincula via pipelineId
  criarFunilDoProjeto: authProc
    .input(z.object({ projetoId: z.string() }))
    .mutation(async ({ input }) => {
      const projeto = await prisma.iaProjeto.findUnique({ where: { id: input.projetoId } });
      if (!projeto) throw new Error("Projeto não encontrado");

      // Reuse existing pipeline if already linked
      if ((projeto as any).pipelineId) {
        return { pipelineId: (projeto as any).pipelineId, criado: false };
      }

      // Gather commercial phases
      const fases = await prisma.iaFaseFunil.findMany({
        where: { projetoId: input.projetoId, pipelineTipo: "comercial" },
        orderBy: { ordem: "asc" },
      });

      // Create pipeline
      const pipeline = await prisma.crmPipeline.create({
        data: {
          nome: projeto.nome,
          tipo: "comercial",
          empresaId: projeto.empresaId ?? undefined,
        },
      });

      // Create stages from phases
      const coresDefault: Record<string, string> = {
        lead_triagem: "#3b82f6", lead_rescisao_indireta: "#8b5cf6",
        lead_direito_suprimido: "#06b6d4", lead_acidente_trabalho: "#f97316",
        lead_reconhecimento_vinculo: "#14b8a6", lead_qualificado: "#8b5cf6",
        lead_indeciso: "#f59e0b", com_closer: "#f97316",
        sem_resposta_closer: "#ef4444", aguardando_reuniao: "#a855f7",
        aguardando_docs_pessoais: "#06b6d4", docs_em_revisao: "#f59e0b",
        aguardando_assinatura: "#10b981",
        lead_desqualificado: "#6b7280", descartado: "#dc2626",
      };

      for (const fase of fases) {
        const stage = await prisma.crmStage.create({
          data: {
            pipelineId: pipeline.id,
            nome: fase.nomeExibicao,
            chave: fase.chave,
            ordem: fase.ordem,
            cor: coresDefault[fase.chave] ?? fase.cor,
            ehEncerramento: fase.ehEncerramento,
            requerAcaoHumana: fase.requerAcaoHumana,
          },
        });
        await prisma.iaFaseFunil.update({
          where: { projetoId_chave: { projetoId: input.projetoId, chave: fase.chave } },
          data: { pipelineId: pipeline.id },
        });
        void stage;
      }

      // Link pipeline to project
      await prisma.iaProjeto.update({
        where: { id: input.projetoId },
        data: { pipelineId: pipeline.id } as any,
      });

      return { pipelineId: pipeline.id, criado: true };
    }),

  // ── Follow-up PAKT ────────────────────────────────────────────────────────

  getFollowUpConfigs: authProc
    .input(z.object({ projetoId: z.string() }))
    .query(async ({ input }) => {
      const rows = await prisma.iaProjetoConfig.findMany({
        where: { projetoId: input.projetoId, categoria: "follow_up" },
      });
      return Object.fromEntries(rows.map(r => [r.chave, r.valor ?? ""]));
    }),

  saveFollowUpConfig: authProc
    .input(z.object({ projetoId: z.string(), chave: z.string(), valor: z.string() }))
    .mutation(async ({ input }) => {
      await prisma.iaProjetoConfig.upsert({
        where: { projetoId_chave: { projetoId: input.projetoId, chave: input.chave } },
        create: { projetoId: input.projetoId, categoria: "follow_up", chave: input.chave, valor: input.valor },
        update: { valor: input.valor },
      });
      return { ok: true };
    }),

  // ── Configs ───────────────────────────────────────────────────────────────

  listConfigs: authProc
    .input(z.object({ projetoId: z.string() }))
    .query(({ input }) =>
      prisma.iaProjetoConfig.findMany({
        where: { projetoId: input.projetoId },
        orderBy: [{ categoria: "asc" }, { chave: "asc" }],
      })
    ),

  upsertConfig: authProc
    .input(z.object({
      projetoId: z.string(),
      chave: z.string(),
      valor: z.string().optional(),
      descricao: z.string().optional(),
      tipo: z.string().optional(),
      categoria: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      const { projetoId, chave, ...data } = input;
      const result = await prisma.iaProjetoConfig.upsert({
        where: { projetoId_chave: { projetoId, chave } },
        create: { projetoId, chave, ...data },
        update: data,
      });
      invalidateClientCache(projetoId);
      return result;
    }),

  // ── Assistente Interno — sessões ──────────────────────────────────────────

  listAssistenteSessoes: authProc
    .input(z.object({ limit: z.number().optional() }))
    .query(async ({ input }) => {
      const rows = await (prisma as any).assistenteSession.findMany({
        orderBy: { updatedAt: "desc" },
        take: input.limit ?? 30,
      });
      return rows.map((r: any) => ({
        id: r.id,
        phone: r.phone,
        step: r.step,
        updatedAt: r.updatedAt,
        totalMensagens: (r.contexto as any)?.history?.length ?? 0,
      }));
    }),

  clearAssistenteSessao: authProc
    .input(z.object({ phone: z.string() }))
    .mutation(async ({ input }) => {
      await (prisma as any).assistenteSession.deleteMany({ where: { phone: input.phone } });
      return { ok: true };
    }),

  // ── Personas ──────────────────────────────────────────────────────────────

  listPersonas: authProc
    .input(z.object({ projetoId: z.string() }))
    .query(({ input }) =>
      prisma.iaPersona.findMany({
        where: { projetoId: input.projetoId },
        orderBy: { ordem: "asc" },
      })
    ),

  /** Liga/desliga uma persona para todo o sistema. Desligada, ela não responde
   *  nem envia proativa — o deal segue vivo e a conversa fica com a equipe. */
  setPersonaAtiva: authProc
    .input(z.object({ projetoId: z.string(), chave: z.string(), ativo: z.boolean() }))
    .mutation(({ input }) =>
      prisma.iaPersona.update({
        where: { projetoId_chave: { projetoId: input.projetoId, chave: input.chave } },
        data: { ativo: input.ativo },
      })
    ),

  upsertPersona: authProc
    .input(z.object({
      projetoId: z.string(),
      chave: z.string(),
      nomeExibicao: z.string(),
      systemPrompt: z.string(),
      descricaoPapel: z.string().optional(),
      tom: z.string().optional(),
      ordem: z.number().optional(),
      ttsVoiceId: z.string().optional(),
      llmProviderChave: z.string().optional().nullable(),
      proximaPersonaChave: z.string().optional().nullable(),
      usarAudio: z.boolean().optional(),
      farewellTexto: z.string().optional().nullable(),
    }))
    .mutation(({ input }) => {
      const { projetoId, chave, ...data } = input;
      return prisma.iaPersona.upsert({
        where: { projetoId_chave: { projetoId, chave } },
        create: { projetoId, chave, ...data } as any,
        update: data as any,
      });
    }),

  reorderPersonas: authProc
    .input(z.object({
      projetoId: z.string(),
      items: z.array(z.object({ id: z.string(), ordem: z.number().int() })),
    }))
    .mutation(async ({ input }) => {
      await Promise.all(input.items.map(item =>
        prisma.iaPersona.update({ where: { id: item.id }, data: { ordem: item.ordem } })
      ));
      return { ok: true };
    }),

  clearPersonaMidia: authProc
    .input(z.object({ personaId: z.string() }))
    .mutation(async ({ input }) => {
      const p = await prisma.iaPersona.findUnique({
        where: { id: input.personaId }, select: { midiaApresentacaoPath: true },
      });
      if (p?.midiaApresentacaoPath) {
        const { unlinkSync } = await import("node:fs");
        try { unlinkSync(p.midiaApresentacaoPath); } catch {}
      }
      return prisma.iaPersona.update({
        where: { id: input.personaId },
        data: { midiaApresentacaoPath: null, midiaApresentacaoTipo: null },
      });
    }),

  // ── Fases ─────────────────────────────────────────────────────────────────

  listFases: authProc
    .input(z.object({ projetoId: z.string() }))
    .query(({ input }) =>
      prisma.iaFaseFunil.findMany({
        where: { projetoId: input.projetoId },
        orderBy: [{ pipelineTipo: "asc" }, { ordem: "asc" }],
      })
    ),

  // ── Entregáveis (vídeo por dor, enviado ao fim da triagem) ───────────────

  listEntregaveis: authProc
    .input(z.object({ projetoId: z.string() }))
    .query(async ({ input }) => {
      const [lista, etapaCfg] = await Promise.all([
        prisma.iaEntregavel.findMany({ where: { projetoId: input.projetoId }, orderBy: [{ ordem: "asc" }, { criadoEm: "asc" }] }),
        prisma.iaProjetoConfig.findFirst({ where: { projetoId: input.projetoId, chave: "entregavel_etapa" } }),
      ]);
      const enviados = lista.length
        ? await prisma.$queryRaw<{ chave: string; n: bigint }[]>`
            SELECT (qualificacao->'_entregavel_enviado'->>'chave') AS chave, count(*) AS n
            FROM "CrmDeal" WHERE "projetoId" = ${input.projetoId} AND qualificacao ? '_entregavel_enviado'
            GROUP BY 1`
        : [];
      const porChave = new Map(enviados.map((r) => [r.chave, Number(r.n)]));
      return {
        etapa: etapaCfg?.valor || "lead_qualificado",
        itens: lista.map(({ arquivoPath, ...e }) => ({
          ...e,
          temArquivo: !!arquivoPath,
          url: arquivoPath ? `/api/ia-entregavel/${e.id}/arquivo` : null,
          enviados: porChave.get(e.chave) ?? 0,
        })),
      };
    }),

  salvarEntregavel: authProc
    .input(z.object({
      id: z.string().optional(),
      projetoId: z.string(),
      chave: z.string().min(1).regex(/^[a-z0-9_]+$/, "Use só letras minúsculas, números e _"),
      titulo: z.string().min(1),
      palavrasChave: z.string(),
      legenda: z.string().nullable().optional(),
      padrao: z.boolean().optional(),
      ativo: z.boolean().optional(),
      ordem: z.number().int().optional(),
    }))
    .mutation(async ({ input }) => {
      const { id, projetoId, ...data } = input;
      // Só um entregável padrão por projeto.
      if (data.padrao) {
        await prisma.iaEntregavel.updateMany({ where: { projetoId, padrao: true, ...(id ? { id: { not: id } } : {}) }, data: { padrao: false } });
      }
      return id
        ? prisma.iaEntregavel.update({ where: { id }, data })
        : prisma.iaEntregavel.create({ data: { projetoId, ...data } });
    }),

  excluirEntregavel: authProc
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      const e = await prisma.iaEntregavel.delete({ where: { id: input.id } });
      if (e.arquivoPath) { try { (await import("node:fs")).unlinkSync(e.arquivoPath); } catch {} }
      return { ok: true };
    }),

  setEntregavelEtapa: authProc
    .input(z.object({ projetoId: z.string(), etapa: z.string().min(1) }))
    .mutation(async ({ input }) => {
      await prisma.iaProjetoConfig.upsert({
        where: { projetoId_chave: { projetoId: input.projetoId, chave: "entregavel_etapa" } },
        create: { projetoId: input.projetoId, chave: "entregavel_etapa", valor: input.etapa, categoria: "entregavel" },
        update: { valor: input.etapa },
      });
      return { ok: true };
    }),

  /** Manda o entregável para um número de teste (o seu), sem mexer em deal nenhum. */
  testarEntregavel: authProc
    .input(z.object({ id: z.string(), whatsapp: z.string().min(10) }))
    .mutation(async ({ input }) => {
      const e = await prisma.iaEntregavel.findUnique({ where: { id: input.id } });
      if (!e) throw new TRPCError({ code: "NOT_FOUND", message: "Entregável não encontrado" });
      const { dispararEntregavel } = await import("../agent/entregaveis.js");
      await dispararEntregavel(e.projetoId, e, input.whatsapp.replace(/\D/g, ""));
      return { ok: true };
    }),

  /** Qual entregável este deal receberia, sem enviar — para conferir as palavras-chave. */
  simularEntregavel: authProc
    .input(z.object({ projetoId: z.string(), dealId: z.string() }))
    .query(async ({ input }) => {
      const { escolherEntregavel, corpusDoDeal } = await import("../agent/entregaveis.js");
      const lista = await prisma.iaEntregavel.findMany({ where: { projetoId: input.projetoId, ativo: true }, orderBy: [{ ordem: "asc" }] });
      const e = escolherEntregavel(lista, await corpusDoDeal(input.dealId));
      return e ? { chave: e.chave, titulo: e.titulo } : null;
    }),

  // ── Mensagens WhatsApp ────────────────────────────────────────────────────

  getMensagens: authProc
    .input(z.object({ dealId: z.string(), limit: z.number().optional(), q: z.string().optional() }))
    .query(async ({ input, ctx }) => {
      // A tela da conversa consulta isto a cada 5 s: é o que diz quem está atendendo,
      // para assinar a mensagem que a pessoa mandar direto pelo WhatsApp.
      registrarQuemVe(input.dealId, ctx.userId);
      // Com `q`, procura no histórico INTEIRO do deal em vez de devolver só a
      // última janela: o filtro do painel era client-side sobre as 100 últimas,
      // então mensagem antiga achada na busca global abria a conversa vazia.
      const q = (input.q ?? "").trim();
      const limit = input.limit ?? (q ? 200 : 100);
      const rows = await prisma.crmMensagemWhatsapp.findMany({
        where: {
          dealId: input.dealId,
          ...(q ? { conteudo: { contains: q, mode: "insensitive" as const } } : {}),
        },
        orderBy: { enviadaEm: "desc" },
        take: limit,
      });
      return rows.reverse();
    }),

  /**
   * Apaga uma mensagem da conversa. `paraTodos` (só mensagem enviada por nós, no
   * WhatsApp) também a apaga do celular do lead; se o WhatsApp recusar (passou
   * do prazo, instância fora), NÃO apaga do painel e devolve o erro, para o
   * atendente não achar que sumiu do lado do lead. Sai do banco de vez — e,
   * com isso, também do histórico que o agente lê.
   */
  apagarMensagem: authProc
    .input(z.object({ mensagemId: z.string(), paraTodos: z.boolean().default(false) }))
    .mutation(async ({ input, ctx }) => {
      const msg = await prisma.crmMensagemWhatsapp.findUnique({
        where: { id: input.mensagemId },
        include: { deal: { include: { contato: true } } },
      });
      if (!msg) throw new TRPCError({ code: "NOT_FOUND", message: "Mensagem não encontrada" });
      if (!msg.deal) throw new TRPCError({ code: "FORBIDDEN", message: "Mensagem sem conversa" });
      assertPodeOperarDeal(ctx, msg.deal);

      let apagadaNoWhatsapp = false;
      if (input.paraTodos) {
        if (msg.direcao !== "out" || msg.canal !== "whatsapp") {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Só dá para apagar para todos uma mensagem nossa no WhatsApp" });
        }
        const phone = msg.deal.contato?.whatsapp;
        if (!msg.evolutionMessageId || !phone || !msg.deal.projetoId) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Mensagem sem identificador do WhatsApp — só dá para apagar do Avoce" });
        }
        const configs = await prisma.iaProjetoConfig.findMany({ where: { projetoId: msg.deal.projetoId, categoria: "whatsapp" } });
        const get = (k: string) => configs.find((c) => c.chave === k)?.valor ?? "";
        const evo = { baseUrl: get("evolution_api_url"), apiKey: get("evolution_api_key"), instancia: get("evolution_instancia") };
        if (!evo.baseUrl) throw new TRPCError({ code: "BAD_REQUEST", message: "Evolution API não configurada" });
        const { deleteMessageForEveryone } = await import("../services/evolution.js");
        const r = await deleteMessageForEveryone(evo, phone, msg.evolutionMessageId);
        if (!r.ok) {
          console.warn(`[apagarMensagem] WhatsApp recusou ${msg.id}: ${r.erro}`);
          throw new TRPCError({ code: "BAD_REQUEST", message: `O WhatsApp não apagou para todos (o prazo é de ~2 dias após o envio). Nada foi apagado. Detalhe: ${r.erro}` });
        }
        apagadaNoWhatsapp = true;
      }

      await prisma.crmMensagemWhatsapp.delete({ where: { id: msg.id } });

      // Áudio/arquivo guardado por nós em disco vai junto.
      const arq = msg.midiaUrl?.match(/^\/api\/audio\/([a-zA-Z0-9_.-]+)$/)?.[1];
      if (arq) {
        const { unlink } = await import("node:fs/promises");
        const { resolve, join } = await import("node:path");
        await unlink(join(resolve(process.env.AUDIO_DIR ?? "./audio"), arq)).catch(() => {});
      }

      console.log(`[apagarMensagem] ${msg.id} (${msg.direcao}/${msg.tipo}) deal=${msg.dealId} por=${ctx.userId} whatsapp=${apagadaNoWhatsapp}`);
      return { ok: true, apagadaNoWhatsapp };
    }),

  listConversas: authProc
    .input(filtroConversas)
    .query(async ({ input, ctx }) => {
      const deals = await prisma.crmDeal.findMany({
        where: {
          ...whereEmpresa(ctx),
          ...whereFiltroConversas(input),
          mensagens: { some: {} },
        },
        include: includeConversa,
        // Janela ampla ordenada pelo campo do deal; a ordem final é decidida abaixo pela data da
        // última mensagem de verdade, porque ultimoContatoEm pode ficar para trás (deal criado
        // fora do fluxo do agente, importação, backfill) e nesse caso a conversa afundaria para
        // fora do corte e a mensagem sumiria do painel mesmo estando gravada.
        orderBy: { ultimoContatoEm: { sort: "desc", nulls: "last" } },
        take: 300,
      });

      // Resolve SDR names for deals with IA paused
      const sdrIds = [...new Set(deals.map((d) => d.iaPausadaPor).filter(Boolean))] as string[];
      const sdrUsers = sdrIds.length
        ? await prisma.usuario.findMany({ where: { id: { in: sdrIds } }, select: { id: true, nome: true } })
        : [];
      const sdrMap = new Map(sdrUsers.map((u) => [u.id, u.nome]));

      const ultimaMensagemEm = (d: (typeof deals)[number]) =>
        d.mensagens[0]?.enviadaEm?.getTime() ?? d.ultimoContatoEm?.getTime() ?? 0;

      // 50 era pouco: só nas últimas 48h o SDR passa de 70 conversas ativas, e as que ficavam
      // para fora do corte sumiam da caixa mesmo com mensagem nova.
      return deals
        // "Aguardando resposta" = a última mensagem é do lead. Só dá para saber depois de
        // carregar a última mensagem, por isso o filtro é aqui e não no where.
        .filter((d) => !input.aguardando || d.mensagens[0]?.direcao === "in")
        .sort((a, b) => ultimaMensagemEm(b) - ultimaMensagemEm(a))
        .slice(0, 150)
        .map((d) => ({
          ...d,
          sdrNome: d.iaPausadaPor ? (sdrMap.get(d.iaPausadaPor) ?? "Atendente") : null,
        }));
    }),

  /**
   * Contagens para os chips de filtro do WhatsApp IA: conversas por funil e por tag
   * (tags do funil em foco + gerais). Conta só deals que têm mensagem — é o universo
   * da caixa de conversas, não o do Kanban.
   */
  resumoConversas: authProc
    .input(z.object({ pipelineId: z.string().optional(), semComentarios: z.boolean().optional() }))
    .query(async ({ input, ctx }) => {
      const todasComMensagem = { ...whereEmpresa(ctx), mensagens: { some: {} } };
      const comMensagem = input.semComentarios
        ? { ...todasComMensagem, AND: [NAO_VEIO_DE_COMENTARIO] }
        : todasComMensagem;
      const [porFunil, pipelines, tags, semTag, followupPendentes, comentarios] = await Promise.all([
        prisma.crmDeal.groupBy({ by: ["pipelineId"], where: comMensagem, _count: { _all: true } }),
        prisma.crmPipeline.findMany({
          where: { ...whereEmpresa(ctx), ativo: true },
          select: { id: true, nome: true, cor: true, ordem: true, empresaId: true },
          orderBy: [{ ordem: "asc" }, { nome: "asc" }],
        }),
        prisma.crmTag.findMany({
          where: {
            AND: [
              whereTagVisivel(ctx),
              ...(input.pipelineId ? [{ OR: [{ pipelineId: input.pipelineId }, { pipelineId: null }] }] : []),
            ],
          },
          select: {
            id: true, nome: true, cor: true, pipelineId: true,
            _count: {
              select: {
                deals: { where: { ...comMensagem, ...(input.pipelineId ? { pipelineId: input.pipelineId } : {}) } },
              },
            },
          },
          orderBy: [{ pipelineId: { sort: "asc", nulls: "first" } }, { nome: "asc" }],
        }),
        prisma.crmDeal.count({
          where: { ...comMensagem, ...(input.pipelineId ? { pipelineId: input.pipelineId } : {}), tags: { none: {} } },
        }),
        prisma.crmDeal.count({
          where: {
            ...comMensagem, ...(input.pipelineId ? { pipelineId: input.pipelineId } : {}),
            status: "aberto", proximoContatoEm: { lt: fimDeHojeSP() },
          },
        }),
        // Sempre sobre todas, para o botão dizer quantas esconde mesmo com o filtro ligado.
        prisma.crmDeal.count({
          where: { ...todasComMensagem, ...(input.pipelineId ? { pipelineId: input.pipelineId } : {}), ...VEIO_DE_COMENTARIO },
        }),
      ]);
      const contagem = new Map(porFunil.map((g) => [g.pipelineId, g._count._all]));
      return {
        total: porFunil.reduce((acc, g) => acc + g._count._all, 0),
        semTag,
        followupPendentes,
        comentarios,
        // Funil sem nenhuma conversa não vira chip — só polui a barra.
        pipelines: pipelines
          .map((p) => ({ ...p, conversas: contagem.get(p.id) ?? 0 }))
          .filter((p) => p.conversas > 0 || p.id === input.pipelineId),
        tags: tags.map(({ _count, ...t }) => ({ ...t, conversas: _count.deals })),
      };
    }),

  /**
   * Busca GLOBAL nas conversas do WhatsApp IA.
   *
   * Casa por nome do contato, título do deal, número inteiro ou pedaço do número
   * (só dígitos, ignora máscara), CPF e — o que faltava — o TEXTO de qualquer
   * mensagem de qualquer conversa. O filtro do painel só olhava as mensagens já
   * carregadas da conversa aberta.
   */
  buscarConversas: authProc
    .input(filtroConversas.extend({
      q: z.string(),
      limit: z.number().int().min(1).max(100).optional(),
    }))
    .query(async ({ input, ctx }) => {
      const q = input.q.trim();
      if (q.length < 2) return [];
      const limit = input.limit ?? 40;
      const digitos = q.replace(/\D/g, "");
      const base = {
        ...whereEmpresa(ctx),
        ...whereFiltroConversas(input),
      };
      const include = includeConversa;

      const orContato: any[] = [
        { titulo: { contains: q, mode: "insensitive" } },
        { contato: { nome: { contains: q, mode: "insensitive" } } },
      ];
      // 3 dígitos já servem de "parte do número"; menos que isso casa com quase tudo.
      // O `contains` do Prisma não serve aqui: `whatsapp` é só dígito e `telefone`
      // vem mascarado ("+55 49 9825-8617"), então a comparação tem que ser feita
      // com os dois lados normalizados — daí o raw.
      if (digitos.length >= 3) {
        const padroes = variantesNumero(digitos).map((v) => `%${v}%`);
        const contatos = await prisma.$queryRaw<{ id: string }[]>`
          SELECT id FROM "CrmContato"
          WHERE regexp_replace(COALESCE(whatsapp, ''), '\D', '', 'g') LIKE ANY(${padroes})
             OR regexp_replace(COALESCE(telefone, ''), '\D', '', 'g') LIKE ANY(${padroes})
             OR regexp_replace(COALESCE(cpf, ''),      '\D', '', 'g') LIKE ANY(${padroes})
          LIMIT 500`;
        if (contatos.length) orContato.push({ contatoId: { in: contatos.map((c) => c.id) } });
      }

      const [porContato, msgs] = await Promise.all([
        prisma.crmDeal.findMany({
          where: { ...base, OR: orContato },
          include,
          orderBy: { ultimoContatoEm: { sort: "desc", nulls: "last" } },
          take: limit * 3,
        }),
        prisma.crmMensagemWhatsapp.findMany({
          where: { conteudo: { contains: q, mode: "insensitive" }, deal: { ...base } },
          orderBy: { enviadaEm: "desc" },
          take: 500,
          select: { id: true, dealId: true, conteudo: true, direcao: true, enviadaEm: true },
        }),
      ]);

      // Primeira (mais recente) mensagem casada por deal + quantas casaram.
      const hitPorDeal = new Map<string, { msg: (typeof msgs)[number]; total: number }>();
      for (const m of msgs) {
        if (!m.dealId) continue;
        const atual = hitPorDeal.get(m.dealId);
        if (atual) atual.total++;
        else hitPorDeal.set(m.dealId, { msg: m, total: 1 });
      }

      const jaTem = new Set(porContato.map((d) => d.id));
      const faltando = [...hitPorDeal.keys()].filter((id) => !jaTem.has(id));
      const porMensagem = faltando.length
        ? await prisma.crmDeal.findMany({ where: { ...base, id: { in: faltando } }, include })
        : [];

      const deals = [...porContato, ...porMensagem];

      const sdrIds = [...new Set(deals.map((d) => d.iaPausadaPor).filter(Boolean))] as string[];
      const sdrUsers = sdrIds.length
        ? await prisma.usuario.findMany({ where: { id: { in: sdrIds } }, select: { id: true, nome: true } })
        : [];
      const sdrMap = new Map(sdrUsers.map((u) => [u.id, u.nome]));

      /** Janela de ~140 caracteres em volta do termo, para mostrar na lista. */
      const trechoDe = (texto: string): string => {
        const i = texto.toLowerCase().indexOf(q.toLowerCase());
        if (i < 0) return texto.slice(0, 140);
        const ini = Math.max(0, i - 45);
        const fim = Math.min(texto.length, i + q.length + 95);
        return `${ini > 0 ? "…" : ""}${texto.slice(ini, fim)}${fim < texto.length ? "…" : ""}`;
      };

      const quando = (d: (typeof deals)[number]) =>
        d.mensagens[0]?.enviadaEm?.getTime() ?? d.ultimoContatoEm?.getTime() ?? 0;

      return deals
        .map((d) => {
          const hit = hitPorDeal.get(d.id);
          return {
            ...d,
            sdrNome: d.iaPausadaPor ? (sdrMap.get(d.iaPausadaPor) ?? "Atendente") : null,
            match: hit
              ? {
                  tipo: "mensagem" as const,
                  trecho: trechoDe(hit.msg.conteudo ?? ""),
                  direcao: hit.msg.direcao,
                  enviadaEm: hit.msg.enviadaEm,
                  total: hit.total,
                }
              : { tipo: "contato" as const, trecho: "", direcao: "", enviadaEm: null, total: 0 },
          };
        })
        .sort((a, b) => quando(b) - quando(a))
        .slice(0, limit);
    }),

  toggleIaPausa: authProc
    .input(z.object({ dealId: z.string(), pausar: z.boolean() }))
    .mutation(async ({ input, ctx }) => {
      const d = await prisma.crmDeal.findUnique({
        where: { id: input.dealId },
        select: { empresaId: true },
      });
      if (!d) throw new TRPCError({ code: "NOT_FOUND", message: "Deal não encontrado" });
      assertPodeOperarDeal(ctx, d);
      const updated = await prisma.crmDeal.update({
        where: { id: input.dealId },
        data: {
          iaAtiva: !input.pausar,
          iaPausadaEm:  input.pausar ? new Date() : null,
          iaPausadaPor: input.pausar ? ctx.userId : null,
        },
        include: { contato: true },
      });

      // When reactivating: if last message is unanswered from lead, re-trigger the stage engine
      if (!input.pausar && updated.projetoId && updated.contato?.whatsapp) {
        const lastMsg = await prisma.crmMensagemWhatsapp.findFirst({
          where: { dealId: input.dealId },
          orderBy: { enviadaEm: "desc" },
        });
        if (lastMsg?.direcao === "in" && lastMsg.conteudo) {
          const phone = updated.contato.whatsapp;
          const syntheticMsg = {
            key: {
              id: lastMsg.evolutionMessageId ?? `reprocess_${lastMsg.id}`,
              remoteJid: `${phone}@s.whatsapp.net`,
              fromMe: false,
            },
            message: { conversation: lastMsg.conteudo },
            messageType: "conversation",
            pushName: updated.contato.nome ?? undefined,
          };
          const { processIncomingMessage } = await import("../agent/stage-engine.js");
          processIncomingMessage(updated.projetoId, syntheticMsg).catch((e: any) =>
            console.error("[toggleIaPausa] reprocess error:", e.message)
          );
        }
      }

      return updated;
    }),

  sendMensagemManual: authProc
    .input(z.object({ dealId: z.string(), conteudo: z.string(), respondeAId: z.string().optional() }))
    .mutation(async ({ input, ctx }) => {
      const deal = await prisma.crmDeal.findUnique({
        where: { id: input.dealId },
        include: { contato: true },
      });
      if (!deal) throw new Error("Deal não encontrado");
      registrarQuemVe(deal.id, ctx.userId);
      assertPodeOperarDeal(ctx, deal);
      if (!deal?.contatoId) throw new Error("Deal sem contato vinculado");

      // "Responder" uma mensagem específica: só vale dentro da mesma conversa.
      const citada = input.respondeAId
        ? await prisma.crmMensagemWhatsapp.findUnique({ where: { id: input.respondeAId } })
        : null;
      if (input.respondeAId && (!citada || citada.dealId !== deal.id)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Mensagem citada não pertence a esta conversa" });
      }
      const textoCitada = citada
        ? (citada.conteudo?.trim() || ({ image: "📷 Imagem", audio: "🎤 Áudio", video: "🎥 Vídeo", document: "📎 Arquivo" } as Record<string, string>)[citada.tipo] || "Mensagem").slice(0, 1000)
        : null;
      const camposCitacao = citada
        ? { citacaoEvolutionId: citada.evolutionMessageId ?? null, citacaoTexto: textoCitada }
        : {};

      // Conversa do Instagram Direct / Messenger: responde pela Meta, não pelo Evolution.
      const { canalDoDeal, enviarManualSocial } = await import("../lib/meta-social.js");
      const canal = await canalDoDeal(deal.id, deal.contato ?? {});
      if (canal !== "whatsapp") {
        const [membro, usuario] = ctx.userId ? await Promise.all([
          deal.projetoId
            ? prisma.iaProjetoUsuario.findUnique({ where: { projetoId_usuarioId: { projetoId: deal.projetoId, usuarioId: ctx.userId } } })
            : null,
          prisma.usuario.findUnique({ where: { id: ctx.userId } }),
        ]) : [null, null];
        const nome = membro?.nomeWhatsapp || usuario?.nome || "Atendente";
        // Direct e Messenger não têm negrito com *asterisco*: o nome vai numa linha própria.
        const mid = await enviarManualSocial(deal, deal.contato!, canal, `${nome}\n${input.conteudo}`);
        const msg = await prisma.crmMensagemWhatsapp.create({
          data: {
            dealId: deal.id, contatoId: deal.contatoId, direcao: "out", canal, tipo: "text",
            conteudo: `*${nome}*\n${input.conteudo}`, remetente: nome, evolutionMessageId: mid ?? undefined,
            ...camposCitacao,
            ...(deal.empresaId ? { empresaId: deal.empresaId } : {}),
          },
        });
        await prisma.crmDeal.update({ where: { id: deal.id }, data: { ultimoContatoEm: new Date() } });
        return msg;
      }

      const phone = deal.contato?.whatsapp;
      if (!phone) throw new Error("Contato sem WhatsApp");

      // Se o deal não tem projeto, busca o primeiro projeto da empresa
      let projetoId = deal.projetoId;
      if (!projetoId && deal.empresaId) {
        const projeto = await prisma.iaProjeto.findFirst({ where: { empresaId: deal.empresaId } });
        if (projeto) projetoId = projeto.id;
      }
      if (!projetoId) throw new Error("Nenhum projeto de Chat (WhatsApp IA) configurado para esta empresa");

      // Resolve display name: nomeWhatsapp (project setting) → usuario.nome → "Atendente"
      let nomeRemetente = "Atendente";
      if (ctx.userId) {
        const [membroProjeto, usuario] = await Promise.all([
          prisma.iaProjetoUsuario.findUnique({
            where: { projetoId_usuarioId: { projetoId: projetoId!, usuarioId: ctx.userId } },
          }),
          prisma.usuario.findUnique({ where: { id: ctx.userId } }),
        ]);
        nomeRemetente = membroProjeto?.nomeWhatsapp || usuario?.nome || "Atendente";
      }

      // Always prepend name in bold — institutional WhatsApp style
      const textoEnvio = `*${nomeRemetente}*\n${input.conteudo}`;

      const configs = await prisma.iaProjetoConfig.findMany({
        where: { projetoId: projetoId!, categoria: "whatsapp" },
      });
      const get = (k: string) => configs.find((c) => c.chave === k)?.valor ?? "";
      const evoConfig = {
        baseUrl: get("evolution_api_url"),
        apiKey: get("evolution_api_key"),
        instancia: get("evolution_instancia"),
      };

      if (!evoConfig.baseUrl) throw new Error("Evolution API não configurada");

      const { sendText } = await import("../services/evolution.js");
      // Sem o id do WhatsApp (mensagem gravada antes do envio confirmar, ou de teste) não dá
      // para citar no celular do lead: a resposta vai como mensagem comum, mas o painel
      // continua mostrando a citação.
      const citacaoEnvio = citada?.evolutionMessageId && citada.evolutionMessageId !== "TEST_SKIP"
        ? { id: citada.evolutionMessageId, fromMe: citada.direcao === "out", texto: textoCitada ?? "" }
        : undefined;
      const sendResult = await sendText(evoConfig, phone, textoEnvio, citacaoEnvio);
      const evolutionMessageId = sendResult?.key?.id ?? null;

      return prisma.crmMensagemWhatsapp.create({
        data: {
          dealId:             deal.id,
          contatoId:          deal.contatoId,
          direcao:            "out",
          tipo:               "text",
          conteudo:           textoEnvio,
          remetente:          nomeRemetente,
          evolutionMessageId: evolutionMessageId,
          ...camposCitacao,
        },
      });
    }),

  sendAudioManual: authProc
    .input(z.object({ dealId: z.string(), audioBase64: z.string(), mimeType: z.string().optional() }))
    .mutation(async ({ input, ctx }) => {
      const deal = await prisma.crmDeal.findUnique({
        where: { id: input.dealId },
        include: { contato: true },
      });
      if (!deal) throw new Error("Deal não encontrado");
      registrarQuemVe(deal.id, ctx.userId);
      if (!deal?.contatoId || !deal.projetoId) throw new Error("Deal sem contato ou projeto");

      const phone = deal.contato?.whatsapp;
      if (!phone) throw new Error("Contato sem WhatsApp");

      let nomeRemetente = "Atendente";
      if (ctx.userId) {
        const [membroProjeto, usuario] = await Promise.all([
          prisma.iaProjetoUsuario.findUnique({
            where: { projetoId_usuarioId: { projetoId: deal.projetoId, usuarioId: ctx.userId } },
          }),
          prisma.usuario.findUnique({ where: { id: ctx.userId } }),
        ]);
        nomeRemetente = membroProjeto?.nomeWhatsapp || usuario?.nome || "Atendente";
      }

      const allConfigs = await prisma.iaProjetoConfig.findMany({
        where: { projetoId: deal.projetoId, categoria: { in: ["whatsapp", "audio"] } },
      });
      const get = (k: string) => allConfigs.find((c) => c.chave === k)?.valor ?? "";
      const evoConfig = {
        baseUrl: get("evolution_api_url"),
        apiKey: get("evolution_api_key"),
        instancia: get("evolution_instancia"),
      };

      if (!evoConfig.baseUrl) throw new Error("Evolution API não configurada");

      const { sendWhatsAppAudio } = await import("../services/evolution.js");
      const sendResult = await sendWhatsAppAudio(evoConfig, phone, input.audioBase64, input.mimeType);
      const evolutionMessageId = sendResult?.key?.id ?? null;

      // Guarda o arquivo para o player do painel — sem isso o áudio do atendente
      // aparecia só como "🔊 Áudio enviado", sem como ouvir.
      const { salvarAudioPainel } = await import("../agent/media-processor.js");
      const midiaUrl = salvarAudioPainel(
        Buffer.from(input.audioBase64, "base64"),
        evolutionMessageId && evolutionMessageId !== "TEST_SKIP" ? evolutionMessageId : `manual_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        input.mimeType ?? "audio/ogg",
      );

      // Grava JÁ (antes da transcrição, que leva segundos): o webhook fromMe deste mesmo
      // áudio pode chegar nesse meio-tempo e, sem a linha no banco, virava uma segunda
      // mensagem — ou o create daqui estourava no evolutionMessageId único. Upsert cobre
      // os dois lados da corrida.
      const dados = {
        dealId:    deal.id,
        contatoId: deal.contatoId,
        direcao:   "out",
        tipo:      "audio",
        conteudo:  `🎤 Áudio — ${nomeRemetente}`,
        midiaUrl,
        remetente: nomeRemetente,
      };
      let salvo = evolutionMessageId
        ? await prisma.crmMensagemWhatsapp.upsert({
            where:  { evolutionMessageId },
            create: { ...dados, evolutionMessageId },
            update: { midiaUrl, remetente: nomeRemetente },
          })
        : await prisma.crmMensagemWhatsapp.create({ data: dados });

      // Transcrição do áudio enviado (melhoria; nunca impede o registro)
      try {
        const audioApiKey = get("audio_api_key") || get("groq_api_key");
        const audioModel   = get("audio_model") || "whisper-large-v3-turbo";
        const audioProvider = (get("audio_provider") || "groq") as "groq" | "openai";
        if (audioApiKey) {
          const { transcribeAudio } = await import("../services/whisper.js");
          const audioBuffer = Buffer.from(input.audioBase64, "base64");
          const mimeType    = input.mimeType ?? "audio/ogg";
          const result = await transcribeAudio(audioBuffer, mimeType, audioApiKey, audioModel, audioProvider);
          if (result.ok && result.text) {
            salvo = await prisma.crmMensagemWhatsapp.update({ where: { id: salvo.id }, data: { conteudo: `🎤 ${result.text}` } });
          }
        }
      } catch (e: any) {
        console.warn("[sendAudioManual] Transcrição falhou:", e.message);
      }
      return salvo;
    }),

  sendArquivoManual: authProc
    .input(z.object({
      dealId:       z.string(),
      arquivoBase64: z.string(),
      mimeType:     z.string(),
      fileName:     z.string(),
      legenda:      z.string().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const deal = await prisma.crmDeal.findUnique({
        where: { id: input.dealId },
        include: { contato: true },
      });
      if (!deal) throw new Error("Deal não encontrado");
      registrarQuemVe(deal.id, ctx.userId);
      if (!deal?.contatoId || !deal.projetoId) throw new Error("Deal sem contato ou projeto");
      const phone = deal.contato?.whatsapp;
      if (!phone) throw new Error("Contato sem WhatsApp");

      let nomeRemetente = "Atendente";
      if (ctx.userId) {
        const [membroProjeto, usuario] = await Promise.all([
          prisma.iaProjetoUsuario.findUnique({
            where: { projetoId_usuarioId: { projetoId: deal.projetoId, usuarioId: ctx.userId } },
          }),
          prisma.usuario.findUnique({ where: { id: ctx.userId } }),
        ]);
        nomeRemetente = membroProjeto?.nomeWhatsapp || usuario?.nome || "Atendente";
      }

      const configs = await prisma.iaProjetoConfig.findMany({
        where: { projetoId: deal.projetoId, categoria: "whatsapp" },
      });
      const get = (k: string) => configs.find((c) => c.chave === k)?.valor ?? "";
      const evoConfig = { baseUrl: get("evolution_api_url"), apiKey: get("evolution_api_key"), instancia: get("evolution_instancia") };
      if (!evoConfig.baseUrl) throw new Error("Evolution API não configurada");

      const { sendMediaBase64 } = await import("../services/evolution.js");
      const sendResult = await sendMediaBase64(evoConfig, phone, input.arquivoBase64, input.mimeType, input.fileName, input.legenda);
      const evolutionMessageId = sendResult?.key?.id ?? null;

      const tipoMsg = input.mimeType.startsWith("image/") ? "image" : input.mimeType.startsWith("video/") ? "video" : "document";
      const conteudoPlaceholder = tipoMsg === "image" ? `🖼️ ${input.fileName}` : `📎 ${input.fileName}`;

      return prisma.crmMensagemWhatsapp.create({
        data: {
          dealId:             deal.id,
          contatoId:          deal.contatoId,
          direcao:            "out",
          tipo:               tipoMsg,
          conteudo:           conteudoPlaceholder,
          remetente:          nomeRemetente,
          evolutionMessageId: evolutionMessageId,
        },
      });
    }),

  iniciarNovaConversa: authProc
    .input(z.object({
      projetoId:  z.string(),
      whatsapp:   z.string(),
      nomeContato: z.string().optional(),
      mensagem:   z.string(),
    }))
    .mutation(async ({ input, ctx }) => {
      const configs = await prisma.iaProjetoConfig.findMany({
        where: { projetoId: input.projetoId, categoria: "whatsapp" },
      });
      const get = (k: string) => configs.find((c) => c.chave === k)?.valor ?? "";
      const evoConfig = { baseUrl: get("evolution_api_url"), apiKey: get("evolution_api_key"), instancia: get("evolution_instancia") };
      if (!evoConfig.baseUrl) throw new Error("Evolution API não configurada");

      // Contato e deal pertencem à empresa do PROJETO, não à empresa primária de quem
      // opera — senão o atendente de outra empresa do grupo cria contato/deal duplicado
      // em vez de reaproveitar o existente.
      const projeto = await prisma.iaProjeto.findUnique({
        where: { id: input.projetoId },
        select: { empresaId: true },
      });
      if (!projeto) throw new TRPCError({ code: "NOT_FOUND", message: "Projeto não encontrado" });
      if (!canOperate(ctx, projeto.empresaId)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Projeto não pertence à sua empresa" });
      }
      const empresaProjeto = projeto.empresaId ?? undefined;

      // Normaliza para E.164 BR sem o +: 55DDXXXXXXXXX (13 dígitos)
      // Aceita: 077991322975 (12d 0+DDD+9+8d), 07791322975 (11d 0+DDD+8d),
      //         77 91322975 (10d), 77991322975 (11d), +55 77 9132-2975 (12d c/55), 5577991322975 (13d)
      const phone = (() => {
        let d = input.whatsapp.replace(/\D/g, "");
        if (d.startsWith("0") && !d.startsWith("055")) d = d.slice(1); // remove 0 inicial do DDD
        if (d.length === 13 && d.startsWith("55")) return d;           // já completo
        if (d.length === 12 && d.startsWith("55")) return d.slice(0, 4) + "9" + d.slice(4); // 55+DDD+8d → insere 9
        if (d.length === 11) return "55" + d;                          // DDD+9+8d
        if (d.length === 10) return "55" + d.slice(0, 2) + "9" + d.slice(2); // DDD+8d → insere 9
        return d; // formato não reconhecido, passa como está
      })();

      // Find or create contact
      let contato = await prisma.crmContato.findFirst({
        where: { whatsapp: phone, ...(empresaProjeto ? { empresaId: empresaProjeto } : {}) },
      });
      if (!contato) {
        contato = await prisma.crmContato.create({
          data: {
            nome: input.nomeContato ?? `Lead ${phone}`,
            whatsapp: phone,
            ...(empresaProjeto ? { empresaId: empresaProjeto } : {}),
          },
        });
      }

      // Find or create deal
      let deal = await prisma.crmDeal.findFirst({
        where: { contatoId: contato.id, projetoId: input.projetoId, status: "aberto" },
        orderBy: { criadoEm: "desc" },
      });

      if (!deal) {
        const entryPhase = await prisma.iaFaseFunil.findFirst({
          where: { projetoId: input.projetoId, ehEntrada: true, pipelineTipo: "comercial" },
          orderBy: { ordem: "asc" },
        });
        const pipelineId = entryPhase?.pipelineId;
        const entryStage = pipelineId
          ? await prisma.crmStage.findFirst({ where: { pipelineId, ehEntrada: true }, orderBy: { ordem: "asc" } })
            ?? await prisma.crmStage.findFirst({ where: { pipelineId }, orderBy: { ordem: "asc" } })
          : null;

        // Fallback: first pipeline of the project's empresa
        let finalPipelineId = pipelineId;
        let finalStageId = entryStage?.id;
        if (!finalPipelineId || !finalStageId) {
          const pipeline = await prisma.crmPipeline.findFirst({
            where: empresaProjeto ? { empresaId: empresaProjeto } : {},
            include: { stages: { orderBy: { ordem: "asc" }, take: 1 } },
            orderBy: { ordem: "asc" },
          });
          finalPipelineId = pipeline?.id;
          finalStageId = pipeline?.stages[0]?.id;
        }
        if (!finalPipelineId || !finalStageId) throw new Error("Nenhum pipeline disponível");

        deal = await prisma.crmDeal.create({
          data: {
            titulo: contato.nome,
            pipelineId: finalPipelineId,
            stageId: finalStageId,
            contatoId: contato.id,
            projetoId: input.projetoId,
            iaAtiva: false,
            iaPausadaPor: ctx.userId ?? undefined,
            iaPausadaEm: new Date(),
            iaStageChave: entryPhase?.chave ?? null,
            status: "aberto",
            ...(empresaProjeto ? { empresaId: empresaProjeto } : {}),
          },
        });
      } else {
        // Pause IA so operator keeps control
        await prisma.crmDeal.update({
          where: { id: deal.id },
          data: { iaAtiva: false, iaPausadaPor: ctx.userId ?? undefined, iaPausadaEm: new Date() },
        });
      }

      let nomeRemetente = "Atendente";
      if (ctx.userId) {
        const [membroProjeto, usuario] = await Promise.all([
          prisma.iaProjetoUsuario.findUnique({
            where: { projetoId_usuarioId: { projetoId: input.projetoId, usuarioId: ctx.userId } },
          }),
          prisma.usuario.findUnique({ where: { id: ctx.userId } }),
        ]);
        nomeRemetente = membroProjeto?.nomeWhatsapp || usuario?.nome || "Atendente";
      }

      const textoEnvio = `*${nomeRemetente}*\n${input.mensagem}`;
      const { sendText } = await import("../services/evolution.js");
      const sendResult = await sendText(evoConfig, phone, textoEnvio);
      const evolutionMessageId = sendResult?.key?.id ?? null;

      await prisma.crmMensagemWhatsapp.create({
        data: {
          dealId:             deal.id,
          contatoId:          contato.id,
          direcao:            "out",
          tipo:               "text",
          conteudo:           textoEnvio,
          remetente:          nomeRemetente,
          evolutionMessageId: evolutionMessageId,
          ...(ctx.empresaId ? { empresaId: ctx.empresaId } : {}),
        },
      });

      await prisma.crmDeal.update({ where: { id: deal.id }, data: { ultimoContatoEm: new Date(), followupEm: new Date() } });
      return { dealId: deal.id, contatoId: contato.id };
    }),

  // ── Seed ──────────────────────────────────────────────────────────────────

  seedCarreteiros: authProc.mutation(async ({ ctx }) => {
    const existente = await prisma.iaProjeto.findFirst({ where: { nome: "Carreteiros" } });
    if (existente) return { ok: true, projetoId: existente.id, msg: "Já existe" };

    const projeto = await prisma.iaProjeto.create({
      data: { nome: "Carreteiros", descricao: "Motoristas carreteiros", empresaId: ctx.empresaId ?? undefined },
    });

    // Personas
    await prisma.iaPersona.createMany({
      data: [
        { projetoId: projeto.id, chave: "assistente", nomeExibicao: "Ana", ordem: 1, systemPrompt: PERSONA_ASSISTENTE_PROMPT },
        { projetoId: projeto.id, chave: "advogado", nomeExibicao: "Dra. Daniela Pires", ordem: 2, systemPrompt: PERSONA_ADVOGADO_PROMPT },
        { projetoId: projeto.id, chave: "closer", nomeExibicao: "Dra. Daniela Pires", ordem: 3, systemPrompt: PERSONA_CLOSER_PROMPT },
      ],
    });

    // Ensure comercial pipeline exists
    let pipelineComercial = await prisma.crmPipeline.findFirst({ where: { tipo: "comercial" } });
    if (!pipelineComercial) {
      pipelineComercial = await prisma.crmPipeline.create({
        data: { nome: "Captação Carreteiros", tipo: "comercial", cor: "#6366f1" },
      });
    }

    let pipelineProcessual = await prisma.crmPipeline.findFirst({ where: { tipo: "processual" } });
    if (!pipelineProcessual) {
      pipelineProcessual = await prisma.crmPipeline.create({
        data: { nome: "Jurídico Processual", tipo: "processual", cor: "#059669" },
      });
    }

    // Fases comerciais
    const fasesComerciais = [
      { chave: "lead_carreteiro", nomeExibicao: "Lead Qualificado como Carreteiro", ordem: 0, cor: "#3b82f6", ehEntrada: true, personaChave: "assistente" },
      { chave: "lead_sem_resposta", nomeExibicao: "Lead sem Resposta", ordem: 1, cor: "#6b7280", personaChave: "assistente" },
      { chave: "lead_qualificado", nomeExibicao: "Lead Qualificado", ordem: 2, cor: "#8b5cf6", personaChave: "advogado" },
      { chave: "lead_indeciso", nomeExibicao: "Lead Indeciso / Futuro", ordem: 3, cor: "#f59e0b", personaChave: "advogado" },
      { chave: "com_closer", nomeExibicao: "Lead com Contato do Closer", ordem: 4, cor: "#f97316", personaChave: "closer" },
      { chave: "sem_resposta_closer", nomeExibicao: "Lead sem Resposta ao Closer", ordem: 5, cor: "#ef4444", requerAcaoHumana: true, personaChave: "closer" },
      { chave: "aguardando_docs_pessoais", nomeExibicao: "Aguardando Documentos Pessoais", ordem: 6, cor: "#06b6d4", personaChave: "advogado" },
      { chave: "docs_em_revisao", nomeExibicao: "📝 Documentos em Revisão", ordem: 7, cor: "#f59e0b", personaChave: "advogado" },
      { chave: "aguardando_assinatura", nomeExibicao: "Aguardando Assinatura do Contrato", ordem: 8, cor: "#10b981", personaChave: "advogado" },
    ];

    for (const fase of fasesComerciais) {
      await prisma.iaFaseFunil.upsert({
        where: { projetoId_chave: { projetoId: projeto.id, chave: fase.chave } },
        create: { projetoId: projeto.id, pipelineId: pipelineComercial.id, pipelineTipo: "comercial", ...fase },
        update: {},
      });
      await prisma.crmStage.upsert({
        where: { pipelineId_chave: { pipelineId: pipelineComercial.id, chave: fase.chave } },
        create: { pipelineId: pipelineComercial.id, chave: fase.chave, nome: fase.nomeExibicao, ordem: fase.ordem, cor: fase.cor, ehEntrada: fase.ehEntrada ?? false, requerAcaoHumana: (fase as any).requerAcaoHumana ?? false },
        update: {},
      });
    }

    // Fases processuais
    const fasesProcessuais = [
      { chave: "aguardando_reuniao", nomeExibicao: "Aguardando Reunião c/ Advogado", ordem: 0, cor: "#6366f1", requerAcaoHumana: true, ehEntrada: true },
      { chave: "aguardando_docs_adicionais", nomeExibicao: "Aguardando Documentos Adicionais", ordem: 1, cor: "#8b5cf6", requerAcaoHumana: true },
      { chave: "elaboracao_inicial", nomeExibicao: "Elaboração da Inicial", ordem: 2, cor: "#3b82f6", requerAcaoHumana: true },
      { chave: "ajuizado_audiencia", nomeExibicao: "Ajuizado / Aguardando Audiência", ordem: 3, cor: "#f59e0b", requerAcaoHumana: true },
      { chave: "audiencia_feita", nomeExibicao: "Audiência Feita", ordem: 4, cor: "#f97316", requerAcaoHumana: true },
      { chave: "aguardando_sentenca", nomeExibicao: "Aguardando Sentença", ordem: 5, cor: "#06b6d4", requerAcaoHumana: true },
      { chave: "aguardando_faturamento", nomeExibicao: "Aguardando Faturamento", ordem: 6, cor: "#10b981", requerAcaoHumana: true, ehGanho: true },
    ];

    for (const fase of fasesProcessuais) {
      await prisma.iaFaseFunil.upsert({
        where: { projetoId_chave: { projetoId: projeto.id, chave: fase.chave } },
        create: { projetoId: projeto.id, pipelineId: pipelineProcessual.id, pipelineTipo: "processual", ...fase },
        update: {},
      });
      await prisma.crmStage.upsert({
        where: { pipelineId_chave: { pipelineId: pipelineProcessual.id, chave: fase.chave } },
        create: { pipelineId: pipelineProcessual.id, chave: fase.chave, nome: fase.nomeExibicao, ordem: fase.ordem, cor: fase.cor, ehGanho: (fase as any).ehGanho ?? false, ehEntrada: (fase as any).ehEntrada ?? false, requerAcaoHumana: fase.requerAcaoHumana },
        update: {},
      });
    }

    // Perguntas de qualificação
    await prisma.iaPerguntaQualificacao.createMany({
      data: [
        { projetoId: projeto.id, chave: "e_carreteiro", perguntaContexto: "Se o lead é motorista carreteiro/caminhoneiro (true) ou não (false)", tipoDado: "booleano", ordem: 0, stageColeta: "lead_carreteiro" },
        { projetoId: projeto.id, chave: "e_clt", perguntaContexto: "true se o lead tinha carteira assinada (CLT) OU trabalhava de forma SUBORDINADA para a empresa mesmo sem registro/sem carteira (reconhecimento de vínculo) OU foi obrigado a abrir PJ/MEI para o mesmo trabalho (pejotização). false APENAS se era autônomo DONO do próprio caminhão rodando para vários clientes, motorista de app (Uber/99/iFood), cooperado ou avulso. Não tinha carteira mas era motorista fixo da empresa = true.", tipoDado: "booleano", ordem: 0, stageColeta: "lead_carreteiro" },
        { projetoId: projeto.id, chave: "nome", perguntaContexto: "Nome completo do cliente", tipoDado: "texto", ordem: 1, stageColeta: "lead_carreteiro" },
        { projetoId: projeto.id, chave: "cidade", perguntaContexto: "Cidade onde mora o cliente", tipoDado: "texto", ordem: 2, stageColeta: "lead_carreteiro" },
        { projetoId: projeto.id, chave: "funcao_recente", perguntaContexto: "Função no emprego mais recente como carreteiro", tipoDado: "texto", ordem: 3, stageColeta: "lead_carreteiro" },
        { projetoId: projeto.id, chave: "empresa_recente", perguntaContexto: "Nome da empresa mais recente", tipoDado: "texto", ordem: 4, stageColeta: "lead_carreteiro" },
        { projetoId: projeto.id, chave: "vinculo_recente", perguntaContexto: "Tipo de vínculo: CLT (carteira); informal/sem registro (motorista subordinado da empresa sem carteira, ou PJ/MEI forçado — reconhecimento de vínculo); autônomo (dono do próprio caminhão p/ vários clientes/app); avulso; cooperado", tipoDado: "texto", ordem: 5, stageColeta: "lead_carreteiro" },
        { projetoId: projeto.id, chave: "saida_recente", perguntaContexto: "Motivo e data de saída do emprego mais recente", tipoDado: "texto", ordem: 6, stageColeta: "lead_carreteiro" },
        { projetoId: projeto.id, chave: "horas_extras", perguntaContexto: "Se fazia horas extras não pagas", tipoDado: "booleano", ordem: 7, stageColeta: "lead_carreteiro" },
      ],
    });

    // Regras de transição
    const regras = [
      { stageOrigemChave: "lead_carreteiro", stageDestinoChave: "lead_sem_resposta", condicao: "sem_resposta_Xhoras", parametros: { horas: 24 }, ordem: 1 },
      { stageOrigemChave: "lead_sem_resposta", stageDestinoChave: "lead_carreteiro", condicao: "cliente_respondeu", ordem: 2 },
      { stageOrigemChave: "lead_carreteiro", stageDestinoChave: "lead_qualificado", condicao: "qualificacao_completa", acaoAdicional: "trocar_persona:advogado", ordem: 3 },
      { stageOrigemChave: "lead_qualificado", stageDestinoChave: "lead_indeciso", condicao: "sem_resposta_Xhoras", parametros: { horas: 48 }, ordem: 4 },
      { stageOrigemChave: "lead_indeciso", stageDestinoChave: "com_closer", condicao: "sem_resposta_Xhoras", parametros: { horas: 72 }, acaoAdicional: "trocar_persona:closer", ordem: 5 },
      { stageOrigemChave: "com_closer", stageDestinoChave: "sem_resposta_closer", condicao: "closer_tentativas_esgotadas", ordem: 6 },
      { stageOrigemChave: "lead_qualificado", stageDestinoChave: "aguardando_docs_pessoais", condicao: "interesse_confirmado", acaoAdicional: "solicitar_documentos", ordem: 7 },
      { stageOrigemChave: "lead_indeciso", stageDestinoChave: "aguardando_docs_pessoais", condicao: "interesse_confirmado", acaoAdicional: "solicitar_documentos", ordem: 8 },
      { stageOrigemChave: "com_closer", stageDestinoChave: "aguardando_docs_pessoais", condicao: "interesse_confirmado", acaoAdicional: "solicitar_documentos", ordem: 9 },
      { stageOrigemChave: "aguardando_docs_pessoais", stageDestinoChave: "aguardando_assinatura", condicao: "docs_confirmados", acaoAdicional: "gerar_proposta_automatica", ordem: 10 },
      { stageOrigemChave: "aguardando_assinatura", stageDestinoChave: "aguardando_reuniao", condicao: "contrato_assinado", acaoAdicional: "criar_deal_processual", ordem: 11 },
    ];

    await prisma.iaRegraTransicao.createMany({
      data: regras.map((r) => ({ projetoId: projeto.id, ...r })),
    });

    // Default configs
    const defaultConfigs = [
      { chave: "anthropic_api_key", valor: "", tipo: "senha", categoria: "llm", descricao: "Claude API Key" },
      { chave: "llm_model_principal", valor: "claude-haiku-4-5-20251001", tipo: "texto", categoria: "llm", descricao: "Modelo Claude principal" },
      { chave: "evolution_api_url", valor: "", tipo: "texto", categoria: "whatsapp", descricao: "URL base da Evolution API (ex: https://api.evolution.com)" },
      { chave: "evolution_api_key", valor: "", tipo: "senha", categoria: "whatsapp", descricao: "Evolution API Key" },
      { chave: "evolution_instancia", valor: "", tipo: "texto", categoria: "whatsapp", descricao: "Nome da instância Evolution" },
      { chave: "audio_provider",  valor: "groq",                  tipo: "texto", categoria: "audio", descricao: "Provedor de transcrição de áudio (groq | openai)" },
      { chave: "audio_api_key",   valor: "",                       tipo: "senha", categoria: "audio", descricao: "API Key do provedor de áudio (Groq ou OpenAI)" },
      { chave: "audio_model",     valor: "whisper-large-v3-turbo", tipo: "texto", categoria: "audio", descricao: "Modelo Whisper (whisper-large-v3-turbo | whisper-large-v3 | whisper-1)" },
      { chave: "tts_api_key",     valor: "",                       tipo: "senha", categoria: "tts",   descricao: "API Key ElevenLabs para envio de áudio" },
      { chave: "tts_model",       valor: "eleven_multilingual_v2", tipo: "texto", categoria: "tts",   descricao: "Modelo TTS ElevenLabs (eleven_multilingual_v2 | eleven_turbo_v2_5)" },
      { chave: "tts_momentos_audio", valor: "",                    tipo: "texto", categoria: "tts",   descricao: "Momentos para envio de áudio (ex: primeira_mensagem,parecer)" },
      { chave: "ocr_mistral_api_key", valor: "", tipo: "senha", categoria: "ocr", descricao: "API Key Mistral OCR (PDFs e imagens)" },
      { chave: "timeout_sem_resposta_h", valor: "24", tipo: "numero", categoria: "comportamento", descricao: "Horas sem resposta para mover stage" },
      { chave: "honorarios_percentual", valor: "30", tipo: "numero", categoria: "comportamento", descricao: "% de honorários de êxito" },
      { chave: "nome_escritorio", valor: "Pinheiro Silva Advogados", tipo: "texto", categoria: "comportamento", descricao: "Nome do escritório" },
    ];

    await prisma.iaProjetoConfig.createMany({
      data: defaultConfigs.map((c) => ({ projetoId: projeto.id, ...c })),
    });

    return { ok: true, projetoId: projeto.id, msg: "Seed criado com sucesso" };
  }),

  seedCarreteiro3: authProc.mutation(async ({ ctx }) => {
    const empresaId = ctx.empresaId ?? ctx.empresaIds?.[0] ?? undefined;
    const existente = await prisma.iaProjeto.findFirst({ where: { nome: "Carreteiro 3.0", empresaId: empresaId ?? null } });
    if (existente) return { ok: true, projetoId: existente.id, msg: "Já existe" };

    const projeto = await prisma.iaProjeto.create({
      data: { nome: "Carreteiro 3.0", descricao: "SDR trabalhista com triagem inteligente (rescisão indireta, direito suprimido, reconhecimento de vínculo)", empresaId },
    });

    // Personas
    await prisma.iaPersona.createMany({
      data: [
        { projetoId: projeto.id, chave: "assistente", nomeExibicao: "Ana", ordem: 1, systemPrompt: PERSONA_ASSISTENTE_PROMPT },
        { projetoId: projeto.id, chave: "advogado", nomeExibicao: "Dra. Daniela Pires", ordem: 2, systemPrompt: PERSONA_ADVOGADO_PROMPT },
        { projetoId: projeto.id, chave: "closer", nomeExibicao: "Dra. Daniela Pires", ordem: 3, systemPrompt: PERSONA_CLOSER_PROMPT },
      ],
    });

    let pipelineComercial = await prisma.crmPipeline.findFirst({ where: { tipo: "comercial" } });
    if (!pipelineComercial) {
      pipelineComercial = await prisma.crmPipeline.create({
        data: { nome: "Captação Carreteiros", tipo: "comercial", cor: "#6366f1" },
      });
    }
    let pipelineProcessual = await prisma.crmPipeline.findFirst({ where: { tipo: "processual" } });
    if (!pipelineProcessual) {
      pipelineProcessual = await prisma.crmPipeline.create({
        data: { nome: "Jurídico Processual", tipo: "processual", cor: "#059669" },
      });
    }

    // Fases comerciais (triagem + qualificação + pós)
    const fasesComerciais = [
      { chave: "lead_triagem",                nomeExibicao: "Triagem",                         ordem: 0,  cor: "#3b82f6", ehEntrada: true, personaChave: "assistente" },
      { chave: "lead_rescisao_indireta",      nomeExibicao: "Rescisão Indireta",               ordem: 1,  cor: "#8b5cf6", personaChave: "assistente" },
      { chave: "lead_direito_suprimido",      nomeExibicao: "Direito Suprimido",               ordem: 2,  cor: "#06b6d4", personaChave: "assistente" },
      { chave: "lead_reconhecimento_vinculo", nomeExibicao: "Reconhecimento de Vínculo",       ordem: 3,  cor: "#14b8a6", personaChave: "assistente" },
      { chave: "lead_qualificado",            nomeExibicao: "Lead Qualificado",                ordem: 4,  cor: "#10b981", personaChave: "advogado" },
      { chave: "lead_indeciso",               nomeExibicao: "Lead Indeciso / Futuro",          ordem: 5,  cor: "#f59e0b", personaChave: "advogado" },
      { chave: "com_closer",                  nomeExibicao: "Lead com Contato do Closer",      ordem: 6,  cor: "#f97316", personaChave: "closer" },
      { chave: "sem_resposta_closer",         nomeExibicao: "Lead sem Resposta ao Closer",     ordem: 7,  cor: "#ef4444", requerAcaoHumana: true, personaChave: "closer" },
      { chave: "aguardando_docs_pessoais",    nomeExibicao: "Aguardando Documentos Pessoais",  ordem: 8,  cor: "#06b6d4", personaChave: "advogado" },
      { chave: "docs_em_revisao",             nomeExibicao: "📝 Documentos em Revisão",        ordem: 9,  cor: "#f59e0b", personaChave: "advogado" },
      { chave: "aguardando_assinatura",       nomeExibicao: "Aguardando Assinatura",           ordem: 10, cor: "#10b981", personaChave: "advogado" },
      { chave: "lead_desqualificado",         nomeExibicao: "Desqualificado",                  ordem: 10, cor: "#6b7280", requerAcaoHumana: true, personaChave: "assistente" },
    ];

    for (const fase of fasesComerciais) {
      await prisma.iaFaseFunil.upsert({
        where: { projetoId_chave: { projetoId: projeto.id, chave: fase.chave } },
        create: { projetoId: projeto.id, pipelineId: pipelineComercial.id, pipelineTipo: "comercial", ...fase },
        update: {},
      });
      await prisma.crmStage.upsert({
        where: { pipelineId_chave: { pipelineId: pipelineComercial.id, chave: fase.chave } },
        create: { pipelineId: pipelineComercial.id, chave: fase.chave, nome: fase.nomeExibicao, ordem: fase.ordem, cor: fase.cor, ehEntrada: fase.ehEntrada ?? false, requerAcaoHumana: (fase as any).requerAcaoHumana ?? false },
        update: {},
      });
    }

    // Fases processuais (reutiliza as mesmas do seedCarreteiros se existirem)
    const fasesProcessuais = [
      { chave: "aguardando_reuniao",         nomeExibicao: "Aguardando Reunião",             ordem: 0, cor: "#6366f1", requerAcaoHumana: true, ehEntrada: true },
      { chave: "elaboracao_inicial",         nomeExibicao: "Elaboração da Inicial",          ordem: 1, cor: "#3b82f6", requerAcaoHumana: true },
      { chave: "ajuizado_audiencia",         nomeExibicao: "Ajuizado / Aguardando Audiência",ordem: 2, cor: "#f59e0b", requerAcaoHumana: true },
      { chave: "aguardando_sentenca",        nomeExibicao: "Aguardando Sentença",            ordem: 3, cor: "#06b6d4", requerAcaoHumana: true },
      { chave: "aguardando_faturamento",     nomeExibicao: "Aguardando Faturamento",         ordem: 4, cor: "#10b981", requerAcaoHumana: true, ehGanho: true },
    ];

    for (const fase of fasesProcessuais) {
      await prisma.iaFaseFunil.upsert({
        where: { projetoId_chave: { projetoId: projeto.id, chave: fase.chave } },
        create: { projetoId: projeto.id, pipelineId: pipelineProcessual.id, pipelineTipo: "processual", ...fase },
        update: {},
      });
      await prisma.crmStage.upsert({
        where: { pipelineId_chave: { pipelineId: pipelineProcessual.id, chave: fase.chave } },
        create: { pipelineId: pipelineProcessual.id, chave: fase.chave, nome: fase.nomeExibicao, ordem: fase.ordem, cor: fase.cor, ehGanho: (fase as any).ehGanho ?? false, ehEntrada: (fase as any).ehEntrada ?? false, requerAcaoHumana: fase.requerAcaoHumana },
        update: {},
      });
    }

    // ── IaFlowStep: questões determinísticas por fase ─────────────────────────

    // Fase: triagem (3 perguntas de roteamento)
    const stepsTriagem = [
      { chave: "triagem_nome",          ordem: 1,  label: "Nome",          pergunta: "Olá! Sou a Ana, analista jurídica da equipe. Pode me dizer seu nome?", stepType: "saudacao", campoColetar: "nome" },
      { chave: "triagem_status",        ordem: 2,  label: "Status emprego", pergunta: "Você ainda está trabalhando nessa empresa ou já saiu?", campoColetar: "ainda_na_empresa" },
      { chave: "triagem_data_saida",    ordem: 3,  label: "Data saída",     pergunta: "Há quanto tempo você saiu desse emprego?", campoColetar: "data_saida_recente" },
      { chave: "triagem_tinha_clt",     ordem: 4,  label: "CLT",            pergunta: "Você tinha carteira assinada (CLT) nesse emprego?", campoColetar: "tinha_clt" },
    ];

    // Fase: rescisao_indireta (8 perguntas sobre irregularidades em vigência do contrato)
    const stepsRescisaoIndireta = [
      { chave: "ri_salario",       ordem: 1, label: "Salário atraso",    pergunta: "Seu salário estava sendo pago em dia?", campoColetar: "ri_salario_atrasado" },
      { chave: "ri_reclamacao",    ordem: 2, label: "Reclamação",        pergunta: "Qual é a sua maior reclamação sobre a empresa atualmente?", campoColetar: "ri_maior_reclamacao", stepType: "llm_generated" },
      { chave: "ri_pressao",       ordem: 3, label: "Pressão",           pergunta: "Você sofre pressão excessiva ou humilhação no trabalho?", campoColetar: "ri_pressao_humilhacao" },
      { chave: "ri_desvio",        ordem: 4, label: "Desvio de função",  pergunta: "Você exerce funções diferentes do que foi contratado, ou houve transferência sem sua concordância?", campoColetar: "ri_desvio_funcao" },
      { chave: "ri_insalubridade", ordem: 5, label: "Insalubridade",     pergunta: "Você trabalha com agentes nocivos (químicos, ruído, calor) sem receber o adicional de insalubridade?", campoColetar: "ri_insalubridade" },
      { chave: "ri_horas_extras",  ordem: 6, label: "Horas extras",      pergunta: "Você faz horas extras e não recebe por elas?", campoColetar: "ri_horas_extras" },
      { chave: "ri_ferias",        ordem: 7, label: "Férias",            pergunta: "Suas férias estão sendo concedidas dentro do prazo legal (a cada 12 meses)?", campoColetar: "ri_ferias" },
      { chave: "ri_beneficios",    ordem: 8, label: "Benefícios",        pergunta: "Algum benefício (vale-alimentação, plano de saúde, etc.) foi cortado sem aviso?", campoColetar: "ri_beneficios_cortados" },
    ];

    // Fase: direito_suprimido (11 perguntas sobre violações pós-rescisão)
    const stepsDireitoSuprimido = [
      { chave: "ds_justa_causa",    ordem: 1,  label: "Justa causa",       pergunta: "Como foi o seu desligamento? Você foi demitido por justa causa?", campoColetar: "ds_justa_causa" },
      { chave: "ds_coacao",         ordem: 2,  label: "Coação",             pergunta: "Houve alguma pressão ou coação para você pedir demissão?", campoColetar: "ds_coacao" },
      { chave: "ds_salario_fora",   ordem: 3,  label: "Salário por fora",   pergunta: "Você recebia algum valor por fora da folha de pagamento (em dinheiro ou separado)?", campoColetar: "ds_salario_por_fora" },
      { chave: "ds_horas_extras",   ordem: 4,  label: "Horas extras",       pergunta: "Durante o emprego, você fazia horas extras e não recebia por elas?", campoColetar: "ds_horas_extras" },
      { chave: "ds_assedio",        ordem: 5,  label: "Assédio",            pergunta: "Sofreu algum tipo de assédio moral ou sexual no trabalho?", campoColetar: "ds_assedio" },
      { chave: "ds_acidente",       ordem: 6,  label: "Acidente",           pergunta: "Sofreu algum acidente de trabalho ou desenvolveu alguma doença por causa do trabalho?", campoColetar: "ds_acidente" },
      { chave: "ds_verbas",         ordem: 7,  label: "Verbas rescisórias", pergunta: "Você recebeu todas as verbas rescisórias corretamente (FGTS, aviso prévio, férias, 13°)?", campoColetar: "ds_verbas_rescisorias" },
      { chave: "ds_desvio",         ordem: 8,  label: "Desvio de função",   pergunta: "Você exercia funções além do que foi contratado, sem receber por isso?", campoColetar: "ds_desvio_funcao" },
      { chave: "ds_descontos",      ordem: 9,  label: "Descontos",          pergunta: "Havia descontos indevidos no seu salário (além de INSS e IR)?", campoColetar: "ds_descontos_indevidos" },
      { chave: "ds_adicionais",     ordem: 10, label: "Adicionais",         pergunta: "Você recebia todos os adicionais devidos, como noturno, insalubridade ou periculosidade?", campoColetar: "ds_adicionais" },
      { chave: "ds_relato",         ordem: 11, label: "Relato livre",       pergunta: "Há alguma outra situação irregular que você vivenciou nesse emprego e que considera importante mencionar?", campoColetar: "ds_relato_livre", stepType: "llm_generated" },
    ];

    // Fase: reconhecimento_vinculo (10 perguntas sobre os 4 elementos do vínculo)
    const stepsReconhecimento = [
      { chave: "rv_inicio",      ordem: 1,  label: "Data início",       pergunta: "Quando você começou a trabalhar para essa empresa (mês e ano)?", campoColetar: "rv_data_inicio" },
      { chave: "rv_tipo_reg",    ordem: 2,  label: "PF ou PJ",          pergunta: "Como você era remunerado? Recebia como pessoa física (CPF) ou pessoa jurídica (CNPJ)?", campoColetar: "rv_pf_pj" },
      { chave: "rv_horario",     ordem: 3,  label: "Horário fixo",      pergunta: "Você tinha horário fixo de trabalho (entrada e saída no mesmo horário todos os dias)?", campoColetar: "rv_horario_fixo" },
      { chave: "rv_pagamento",   ordem: 4,  label: "Forma pagamento",   pergunta: "Como você recebia o pagamento? Depósito bancário, PIX, dinheiro ou outra forma?", campoColetar: "rv_forma_pagamento" },
      { chave: "rv_tempo",       ordem: 5,  label: "Tempo de serviço",  pergunta: "Por quanto tempo você trabalhou para essa empresa?", campoColetar: "rv_tempo_servico" },
      { chave: "rv_ausencias",   ordem: 6,  label: "Ausências",         pergunta: "Você precisava justificar suas ausências ou pedir autorização para faltar?", campoColetar: "rv_justificar_ausencias" },
      { chave: "rv_sancoes",     ordem: 7,  label: "Sanções",           pergunta: "Você já recebeu alguma advertência, suspensão ou foi ameaçado de punição?", campoColetar: "rv_sancoes" },
      { chave: "rv_frequencia",  ordem: 8,  label: "Frequência",        pergunta: "Com que frequência você trabalhava? Era mais de 4 dias por semana regularmente?", campoColetar: "rv_frequencia_trabalho" },
      { chave: "rv_ordens",      ordem: 9,  label: "Ordens",            pergunta: "Você recebia ordens diretas de como executar seu trabalho (horário, modo de fazer, etc.)?", campoColetar: "rv_recebia_ordens" },
      { chave: "rv_substituto",  ordem: 10, label: "Substituto",        pergunta: "Você poderia mandar outra pessoa no seu lugar para trabalhar, ou precisava ser sempre você?", campoColetar: "rv_substituto" },
    ];

    const toFlowStep = (projetoId: string, personaChave: string, fase: string) =>
      (s: { chave: string; ordem: number; label: string; pergunta: string; stepType?: string; campoColetar?: string }) => ({
        projetoId, personaChave, fase,
        chave: s.chave, ordem: s.ordem, label: s.label, pergunta: s.pergunta,
        stepType: s.stepType ?? "question",
        campoColetar: s.campoColetar ?? null,
      });

    await prisma.iaFlowStep.createMany({
      data: [
        ...stepsTriagem.map(toFlowStep(projeto.id, "assistente", "triagem")),
        ...stepsRescisaoIndireta.map(toFlowStep(projeto.id, "assistente", "rescisao_indireta")),
        ...stepsDireitoSuprimido.map(toFlowStep(projeto.id, "assistente", "direito_suprimido")),
        ...stepsReconhecimento.map(toFlowStep(projeto.id, "assistente", "reconhecimento_vinculo")),
      ],
      skipDuplicates: true,
    });

    // ── IaPerguntaQualificacao — extração LLM por stage ───────────────────────

    const pergsTriagem = [
      { chave: "nome",               perguntaContexto: "Nome completo do cliente", tipoDado: "texto",    ordem: 1, stageColeta: "lead_triagem" },
      { chave: "ainda_na_empresa",   perguntaContexto: "O cliente ainda está empregado nessa empresa? true = sim, false = não", tipoDado: "booleano", ordem: 2, stageColeta: "lead_triagem" },
      { chave: "data_saida_recente", perguntaContexto: "Data ou período em que o cliente saiu do emprego (ex: há 6 meses, jan/2024)", tipoDado: "texto", ordem: 3, stageColeta: "lead_triagem" },
      { chave: "prescrito",          perguntaContexto: "Faz mais de 2 anos (730 dias) que o cliente saiu? true = sim (prescrito), false = não", tipoDado: "booleano", ordem: 4, stageColeta: "lead_triagem" },
      { chave: "tempo_muito_curto",  perguntaContexto: "O cliente trabalhou menos de 2 meses (60 dias)? true = sim, false = não", tipoDado: "booleano", ordem: 5, stageColeta: "lead_triagem" },
      { chave: "tinha_clt",          perguntaContexto: "O cliente tinha carteira assinada (CLT)? true = sim, false = não", tipoDado: "booleano", ordem: 6, stageColeta: "lead_triagem" },
    ];

    const pergsRi = [
      { chave: "ri_salario_atrasado",  perguntaContexto: "Salário atrasado/não pago? true = sim (há problema), false = não", tipoDado: "booleano", ordem: 1, stageColeta: "lead_rescisao_indireta" },
      { chave: "ri_pressao_humilhacao",perguntaContexto: "Há pressão excessiva ou humilhação no trabalho? true = sim", tipoDado: "booleano", ordem: 2, stageColeta: "lead_rescisao_indireta" },
      { chave: "ri_desvio_funcao",     perguntaContexto: "Exerce funções diferentes do contratado ou foi transferido? true = sim", tipoDado: "booleano", ordem: 3, stageColeta: "lead_rescisao_indireta" },
      { chave: "ri_insalubridade",     perguntaContexto: "Trabalha com agentes nocivos sem adicional de insalubridade? true = sim", tipoDado: "booleano", ordem: 4, stageColeta: "lead_rescisao_indireta" },
      { chave: "ri_horas_extras",      perguntaContexto: "Faz horas extras não remuneradas? true = sim", tipoDado: "booleano", ordem: 5, stageColeta: "lead_rescisao_indireta" },
      { chave: "ri_ferias",            perguntaContexto: "Férias concedidas no prazo legal? true = sim (sem problema), false = atrasadas (problema)", tipoDado: "booleano", ordem: 6, stageColeta: "lead_rescisao_indireta" },
      { chave: "ri_beneficios_cortados",perguntaContexto: "Algum benefício foi cortado sem aviso? true = sim (há problema)", tipoDado: "booleano", ordem: 7, stageColeta: "lead_rescisao_indireta" },
      { chave: "caso_viavel",          perguntaContexto: "Caso juridicamente viável para rescisão indireta? true = sim (há irregularidade), false = não determinado", tipoDado: "booleano", ordem: 8, stageColeta: "lead_rescisao_indireta" },
    ];

    const pergsDs = [
      { chave: "ds_coacao",           perguntaContexto: "Houve coação ou pressão para pedir demissão? true = sim", tipoDado: "booleano", ordem: 1, stageColeta: "lead_direito_suprimido" },
      { chave: "ds_salario_por_fora", perguntaContexto: "Recebia valor por fora da folha? true = sim", tipoDado: "booleano", ordem: 2, stageColeta: "lead_direito_suprimido" },
      { chave: "ds_horas_extras",     perguntaContexto: "Fazia horas extras não pagas? true = sim", tipoDado: "booleano", ordem: 3, stageColeta: "lead_direito_suprimido" },
      { chave: "ds_assedio",          perguntaContexto: "Sofreu assédio moral ou sexual? true = sim", tipoDado: "booleano", ordem: 4, stageColeta: "lead_direito_suprimido" },
      { chave: "ds_acidente",         perguntaContexto: "Acidente de trabalho ou doença ocupacional? true = sim", tipoDado: "booleano", ordem: 5, stageColeta: "lead_direito_suprimido" },
      { chave: "ds_verbas_rescisorias",perguntaContexto: "Recebeu todas as verbas rescisórias corretamente? true = sim (sem problema), false = não (problema)", tipoDado: "booleano", ordem: 6, stageColeta: "lead_direito_suprimido" },
      { chave: "ds_desvio_funcao",    perguntaContexto: "Exercia funções além do contratado? true = sim", tipoDado: "booleano", ordem: 7, stageColeta: "lead_direito_suprimido" },
      { chave: "ds_descontos_indevidos",perguntaContexto: "Havia descontos indevidos no salário? true = sim", tipoDado: "booleano", ordem: 8, stageColeta: "lead_direito_suprimido" },
      { chave: "ds_adicionais",       perguntaContexto: "Recebia todos os adicionais devidos? true = sim (sem problema), false = não recebia (problema)", tipoDado: "booleano", ordem: 9, stageColeta: "lead_direito_suprimido" },
      { chave: "caso_viavel",         perguntaContexto: "Caso viável para direito suprimido? true = há irregularidades identificadas", tipoDado: "booleano", ordem: 10, stageColeta: "lead_direito_suprimido" },
    ];

    const pergsRv = [
      { chave: "rv_frequencia_trabalho",perguntaContexto: "Trabalhava mais de 4 dias por semana regularmente? true = sim", tipoDado: "booleano", ordem: 1, stageColeta: "lead_reconhecimento_vinculo" },
      { chave: "rv_recebia_ordens",     perguntaContexto: "Recebia ordens diretas sobre como executar o trabalho? true = sim", tipoDado: "booleano", ordem: 2, stageColeta: "lead_reconhecimento_vinculo" },
      { chave: "rv_substituto",         perguntaContexto: "Podia mandar substituto no seu lugar? true = sim (enfraquece vínculo), false = não podia (reforça pessoalidade)", tipoDado: "booleano", ordem: 3, stageColeta: "lead_reconhecimento_vinculo" },
      { chave: "rv_forma_pagamento",    perguntaContexto: "Forma de pagamento (depósito, PIX, dinheiro, etc.)", tipoDado: "texto", ordem: 4, stageColeta: "lead_reconhecimento_vinculo" },
      { chave: "caso_viavel",           perguntaContexto: "Caso viável para reconhecimento de vínculo empregatício? true = 3+ elementos presentes", tipoDado: "booleano", ordem: 5, stageColeta: "lead_reconhecimento_vinculo" },
    ];

    await prisma.iaPerguntaQualificacao.createMany({
      data: [
        ...pergsTriagem.map(p => ({ projetoId: projeto.id, ...p })),
        ...pergsRi.map(p => ({ projetoId: projeto.id, ...p })),
        ...pergsDs.map(p => ({ projetoId: projeto.id, ...p })),
        ...pergsRv.map(p => ({ projetoId: projeto.id, ...p })),
      ],
      skipDuplicates: true,
    });

    // ── Regras de transição ───────────────────────────────────────────────────

    const regras = [
      // Triagem → branches (handled directly by triagem-router, but keep DB rules as fallback)
      { stageOrigemChave: "lead_triagem",                stageDestinoChave: "lead_rescisao_indireta",      condicao: "goto_lead_rescisao_indireta",      ordem: 1 },
      { stageOrigemChave: "lead_triagem",                stageDestinoChave: "lead_direito_suprimido",      condicao: "goto_lead_direito_suprimido",      ordem: 2 },
      { stageOrigemChave: "lead_triagem",                stageDestinoChave: "lead_reconhecimento_vinculo", condicao: "goto_lead_reconhecimento_vinculo", ordem: 3 },
      { stageOrigemChave: "lead_triagem",                stageDestinoChave: "lead_desqualificado",         condicao: "goto_lead_desqualificado",         ordem: 4 },
      // Qualification → qualificado
      { stageOrigemChave: "lead_rescisao_indireta",      stageDestinoChave: "lead_qualificado",            condicao: "qualificacao_completa", acaoAdicional: "trocar_persona:advogado", ordem: 5 },
      { stageOrigemChave: "lead_direito_suprimido",      stageDestinoChave: "lead_qualificado",            condicao: "qualificacao_completa", acaoAdicional: "trocar_persona:advogado", ordem: 6 },
      { stageOrigemChave: "lead_reconhecimento_vinculo", stageDestinoChave: "lead_qualificado",            condicao: "qualificacao_completa", acaoAdicional: "trocar_persona:advogado", ordem: 7 },
      // Qualification → desqualificado
      { stageOrigemChave: "lead_rescisao_indireta",      stageDestinoChave: "lead_desqualificado",         condicao: "goto_lead_desqualificado",         ordem: 8 },
      { stageOrigemChave: "lead_direito_suprimido",      stageDestinoChave: "lead_desqualificado",         condicao: "goto_lead_desqualificado",         ordem: 9 },
      { stageOrigemChave: "lead_reconhecimento_vinculo", stageDestinoChave: "lead_desqualificado",         condicao: "goto_lead_desqualificado",         ordem: 10 },
      // Post-qualification flow
      { stageOrigemChave: "lead_qualificado",            stageDestinoChave: "lead_indeciso",               condicao: "sem_resposta_Xhoras",  parametros: { horas: 48 }, ordem: 11 },
      { stageOrigemChave: "lead_indeciso",               stageDestinoChave: "com_closer",                  condicao: "sem_resposta_Xhoras",  parametros: { horas: 72 }, acaoAdicional: "trocar_persona:closer", ordem: 12 },
      { stageOrigemChave: "com_closer",                  stageDestinoChave: "sem_resposta_closer",         condicao: "closer_tentativas_esgotadas", ordem: 13 },
      { stageOrigemChave: "lead_qualificado",            stageDestinoChave: "aguardando_docs_pessoais",    condicao: "interesse_confirmado", acaoAdicional: "solicitar_documentos", ordem: 14 },
      { stageOrigemChave: "aguardando_docs_pessoais",    stageDestinoChave: "aguardando_assinatura",       condicao: "docs_confirmados",     acaoAdicional: "gerar_proposta_automatica", ordem: 15 },
    ];

    await prisma.iaRegraTransicao.createMany({
      data: regras.map(r => ({ projetoId: projeto.id, ...r })),
    });

    // ── Configs ───────────────────────────────────────────────────────────────

    const configs = [
      { chave: "modo_sdr",              valor: "triagem",                        tipo: "texto",  categoria: "comportamento", descricao: "Modo SDR: triagem = triagem inteligente LiderHub-style" },
      { chave: "modo_coleta",           valor: "sequencial",                     tipo: "texto",  categoria: "comportamento", descricao: "Modo coleta: sequencial | conversacional" },
      { chave: "anthropic_api_key",     valor: "",                               tipo: "senha",  categoria: "llm",           descricao: "Claude API Key" },
      { chave: "llm_model_principal",   valor: "claude-haiku-4-5-20251001",      tipo: "texto",  categoria: "llm",           descricao: "Modelo Claude principal" },
      { chave: "evolution_api_url",     valor: "",                               tipo: "texto",  categoria: "whatsapp",      descricao: "URL base da Evolution API" },
      { chave: "evolution_api_key",     valor: "",                               tipo: "senha",  categoria: "whatsapp",      descricao: "Evolution API Key" },
      { chave: "evolution_instancia",   valor: "",                               tipo: "texto",  categoria: "whatsapp",      descricao: "Nome da instância Evolution" },
      { chave: "audio_provider",        valor: "groq",                           tipo: "texto",  categoria: "audio",         descricao: "Provedor de transcrição de áudio (groq | openai)" },
      { chave: "audio_api_key",         valor: "",                               tipo: "senha",  categoria: "audio",         descricao: "API Key do provedor de áudio" },
      { chave: "audio_model",           valor: "whisper-large-v3-turbo",         tipo: "texto",  categoria: "audio",         descricao: "Modelo Whisper" },
      { chave: "ocr_mistral_api_key",   valor: "",                               tipo: "senha",  categoria: "ocr",           descricao: "API Key Mistral OCR" },
      { chave: "timeout_sem_resposta_h",valor: "24",                             tipo: "numero", categoria: "comportamento", descricao: "Horas sem resposta para mover stage" },
      { chave: "honorarios_percentual", valor: "30",                             tipo: "numero", categoria: "comportamento", descricao: "% de honorários de êxito" },
      { chave: "nome_escritorio",       valor: "Pinheiro Silva Advogados",       tipo: "texto",  categoria: "comportamento", descricao: "Nome do escritório" },
    ];

    await prisma.iaProjetoConfig.createMany({
      data: configs.map(c => ({ projetoId: projeto.id, ...c })),
    });

    return { ok: true, projetoId: projeto.id, msg: "Carreteiro 3.0 criado com sucesso" };
  }),

  // ── WhatsApp status + QR code ─────────────────────────────────────────────

  whatsappStatus: authProc
    .input(z.object({ projetoId: z.string() }))
    .query(async ({ input }) => {
      const configs = await prisma.iaProjetoConfig.findMany({ where: { projetoId: input.projetoId, categoria: "whatsapp" } });
      const get = (k: string) => configs.find(c => c.chave === k)?.valor ?? "";
      const baseUrl   = get("evolution_api_url").replace(/\/$/, "");
      const apiKey    = get("evolution_api_key");
      const instancia = get("evolution_instancia");

      if (!baseUrl || !apiKey || !instancia) return { ok: false, error: "Evolution API não configurada", state: "not_configured", instancia: "" };

      try {
        const res = await fetch(`${baseUrl}/instance/connectionState/${instancia}`, { headers: { apikey: apiKey } });
        if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, state: "error", instancia };
        const data = await res.json() as { instance?: { state?: string } };
        return { ok: true, state: data?.instance?.state ?? "unknown", instancia };
      } catch (e: any) {
        return { ok: false, error: e.message, state: "error", instancia };
      }
    }),

  whatsappQr: authProc
    .input(z.object({ projetoId: z.string() }))
    .query(async ({ input }) => {
      const configs = await prisma.iaProjetoConfig.findMany({ where: { projetoId: input.projetoId, categoria: "whatsapp" } });
      const get = (k: string) => configs.find(c => c.chave === k)?.valor ?? "";
      const baseUrl   = get("evolution_api_url").replace(/\/$/, "");
      const apiKey    = get("evolution_api_key");
      const instancia = get("evolution_instancia");

      if (!baseUrl || !apiKey || !instancia) return { ok: false, error: "Evolution API não configurada", qrcode: null as string | null };

      try {
        const res = await fetch(`${baseUrl}/instance/connect/${instancia}`, { headers: { apikey: apiKey } });
        if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, qrcode: null as string | null };
        const data = await res.json() as { base64?: string; code?: string };
        return { ok: true, qrcode: (data.base64 ?? null) as string | null, code: data.code ?? null };
      } catch (e: any) {
        return { ok: false, error: e.message, qrcode: null as string | null };
      }
    }),

  whatsappDesconectar: authProc
    .input(z.object({ projetoId: z.string() }))
    .mutation(async ({ input }) => {
      const configs = await prisma.iaProjetoConfig.findMany({ where: { projetoId: input.projetoId, categoria: "whatsapp" } });
      const get = (k: string) => configs.find(c => c.chave === k)?.valor ?? "";
      const baseUrl   = get("evolution_api_url").replace(/\/$/, "");
      const apiKey    = get("evolution_api_key");
      const instancia = get("evolution_instancia");

      if (!baseUrl || !apiKey || !instancia) return { ok: false, error: "Não configurado" };

      try {
        await fetch(`${baseUrl}/instance/logout/${instancia}`, { method: "DELETE", headers: { apikey: apiKey } });
        return { ok: true };
      } catch (e: any) {
        return { ok: false, error: e.message };
      }
    }),

  // ── Seed configs de proposta automática ──────────────────────────────────

  seedPropostaConfigs: authProc
    .input(z.object({ projetoId: z.string() }))
    .mutation(async ({ input }) => {
      const propostaConfigs = [
        { chave: "proposta_ativo",                  valor: "false",        tipo: "texto",  categoria: "proposta", descricao: "Proposta automática ativa (true/false)" },
        { chave: "proposta_emitente_id",            valor: "",             tipo: "texto",  categoria: "proposta", descricao: "ID da empresa emissora das propostas" },
        { chave: "proposta_momento",                valor: "parecer_enviado", tipo: "texto", categoria: "proposta", descricao: "Momento de disparo: parecer_enviado | dados_coletados | qualificado | documentos_pessoais | stage:<chave>" },
        { chave: "proposta_template_corpo_id",      valor: "",             tipo: "texto",  categoria: "proposta", descricao: "ID do template do corpo da proposta (tipo PROPOSTA)" },
        { chave: "proposta_template_contrato_id",   valor: "",             tipo: "texto",  categoria: "proposta", descricao: "ID do template de contrato gerado ao aceitar" },
        { chave: "proposta_template_procuracao_id", valor: "",             tipo: "texto",  categoria: "proposta", descricao: "ID do template de procuração gerado ao aceitar" },
        { chave: "proposta_dia_vencimento",         valor: "5",            tipo: "numero", categoria: "proposta", descricao: "Dia de vencimento do pagamento" },
        { chave: "proposta_metodo_cobr",            valor: "PIX_BOLETO",   tipo: "texto",  categoria: "proposta", descricao: "Método de cobrança (PIX_BOLETO | PIX | BOLETO | NENHUM)" },
        { chave: "proposta_tipo_contrato",          valor: "EVENTUAL",     tipo: "texto",  categoria: "proposta", descricao: "Tipo de contrato (RECORRENTE | PARCELADO | EVENTUAL)" },
        { chave: "proposta_descricao_servico",      valor: "",             tipo: "texto",  categoria: "proposta", descricao: "Descrição do serviço para o template da proposta" },
        { chave: "proposta_validade_dias",          valor: "30",           tipo: "numero", categoria: "proposta", descricao: "Validade da proposta em dias" },
        { chave: "proposta_honorarios_tipo",        valor: "exito",        tipo: "texto",  categoria: "proposta", descricao: "Tipo de honorários: exito (%) ou fixo" },
        { chave: "proposta_honorarios_perc",        valor: "30",           tipo: "numero", categoria: "proposta", descricao: "% de honorários de êxito (ex: 30)" },
        { chave: "proposta_revisao_manual",         valor: "true",         tipo: "texto",  categoria: "proposta", descricao: "Revisar os documentos antes de enviar para assinatura (true/false)" },
        { chave: "proposta_msg_revisao",            valor: "",             tipo: "texto",  categoria: "proposta", descricao: "Mensagem ao cliente enquanto os documentos estão em revisão ({{nome}}); vazio = texto padrão" },
      ];
      for (const c of propostaConfigs) {
        await prisma.iaProjetoConfig.upsert({
          where: { projetoId_chave: { projetoId: input.projetoId, chave: c.chave } },
          update: {},
          create: { projetoId: input.projetoId, ...c },
        });
      }
      return { ok: true };
    }),

  // ── Seed configs de áudio em projetos existentes ──────────────────────────

  seedAudioConfigs: authProc
    .input(z.object({ projetoId: z.string() }))
    .mutation(async ({ input }) => {
      const audioConfigs = [
        { chave: "audio_provider",  valor: "groq",                  tipo: "senha",  categoria: "audio", descricao: "Provedor de transcrição (groq | openai)" },
        { chave: "audio_api_key",   valor: "",                       tipo: "senha",  categoria: "audio", descricao: "API Key do provedor de áudio" },
        { chave: "audio_model",     valor: "whisper-large-v3-turbo", tipo: "texto",  categoria: "audio", descricao: "Modelo Whisper" },
      ];
      for (const c of audioConfigs) {
        await prisma.iaProjetoConfig.upsert({
          where: { projetoId_chave: { projetoId: input.projetoId, chave: c.chave } },
          update: {},  // não sobrescreve se já existe
          create: { projetoId: input.projetoId, ...c },
        });
      }
      return { ok: true };
    }),

  seedTtsConfigs: authProc
    .input(z.object({ projetoId: z.string() }))
    .mutation(async ({ input }) => {
      const ttsConfigs = [
        { chave: "tts_api_key",        valor: "", tipo: "senha",  categoria: "tts", descricao: "API Key ElevenLabs para envio de áudio" },
        { chave: "tts_model",          valor: "eleven_multilingual_v2", tipo: "texto", categoria: "tts", descricao: "Modelo TTS ElevenLabs (eleven_multilingual_v2 | eleven_turbo_v2_5)" },
        { chave: "tts_momentos_audio", valor: "", tipo: "texto",  categoria: "tts", descricao: "Momentos para envio de áudio (ex: primeira_mensagem,parecer)" },
      ];
      for (const c of ttsConfigs) {
        await prisma.iaProjetoConfig.upsert({
          where: { projetoId_chave: { projetoId: input.projetoId, chave: c.chave } },
          update: {},
          create: { projetoId: input.projetoId, ...c },
        });
      }
      return { ok: true };
    }),

  // ── Testar transcrição de áudio ───────────────────────────────────────────

  testarAudio: authProc
    .input(z.object({ projetoId: z.string() }))
    .query(async ({ input }) => {
      const configs = await prisma.iaProjetoConfig.findMany({ where: { projetoId: input.projetoId, categoria: "audio" } });
      const get = (k: string) => configs.find(c => c.chave === k)?.valor ?? "";
      const provider = get("audio_provider") || "groq";
      const apiKey   = get("audio_api_key");
      const model    = get("audio_model") || "whisper-large-v3-turbo";
      if (!apiKey) return { ok: false, error: "API Key não configurada" };
      return { ok: true, provider, model, msg: `Pronto — ${provider} / ${model}` };
    }),

  // ── Notification Events ────────────────────────────────────────────────────

  listNotificacoes: authProc
    .input(z.object({ projetoId: z.string() }))
    .query(async ({ input }) => {
      return prisma.iaNotificacaoEvento.findMany({
        where: { projetoId: input.projetoId },
        orderBy: { criadoEm: "asc" },
      });
    }),

  upsertNotificacao: authProc
    .input(z.object({
      id:        z.string().optional(),
      projetoId: z.string(),
      nome:      z.string(),
      evento:    z.string(),
      // trim: espaço sobrando no destino já quebrou consulta/dedupe de notificações
      destino:   z.string().transform((s) => s.trim()),
      mensagem:  z.string(),
      ativo:     z.boolean().default(true),
    }))
    .mutation(async ({ input }) => {
      if (input.id) {
        return prisma.iaNotificacaoEvento.update({
          where: { id: input.id },
          data: { nome: input.nome, evento: input.evento, destino: input.destino, mensagem: input.mensagem, ativo: input.ativo },
        });
      }
      return prisma.iaNotificacaoEvento.create({
        data: {
          projetoId: input.projetoId,
          nome:      input.nome,
          evento:    input.evento,
          destino:   input.destino,
          mensagem:  input.mensagem,
          ativo:     input.ativo,
        },
      });
    }),

  deleteNotificacao: authProc
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      return prisma.iaNotificacaoEvento.delete({ where: { id: input.id } });
    }),

  listNotificacaoLogs: authProc
    .input(z.object({ projetoId: z.string(), limit: z.number().optional() }))
    .query(async ({ input }) => {
      return prisma.iaNotificacaoLog.findMany({
        where: { projetoId: input.projetoId },
        orderBy: { enviadaEm: "desc" },
        take: input.limit ?? 50,
      });
    }),

  // ── LLM Provedores ────────────────────────────────────────────────────────

  listLlmProvedores: authProc
    .input(z.object({ projetoId: z.string() }))
    .query(({ input }) =>
      prisma.iaLlmProvedor.findMany({
        where: { projetoId: input.projetoId },
        orderBy: { ordem: "asc" },
      })
    ),

  upsertLlmProvedor: authProc
    .input(z.object({
      id:        z.string().optional(),
      projetoId: z.string(),
      ordem:     z.number(),
      provider:  z.enum(["anthropic", "openai", "groq", "gemini"]),
      modelo:    z.string(),
      apiKey:    z.string(),
      ativo:     z.boolean().optional(),
    }))
    .mutation(async ({ input }) => {
      const { id, ...data }: any = input;
      if (data.apiKey) data.apiKey = fieldEncryptIfPlain(data.apiKey);
      const result = id
        ? await prisma.iaLlmProvedor.update({ where: { id }, data })
        : await prisma.iaLlmProvedor.create({ data: { ...data, ativo: data.ativo ?? true } });
      invalidateClientCache(input.projetoId);
      return result;
    }),

  deleteLlmProvedor: authProc
    .input(z.object({ id: z.string(), projetoId: z.string() }))
    .mutation(async ({ input }) => {
      const result = await prisma.iaLlmProvedor.delete({ where: { id: input.id } });
      invalidateClientCache(input.projetoId);
      return result;
    }),

  // ── User management ────────────────────────────────────────────────────────

  listUsuarios: authProc
    .input(z.object({ projetoId: z.string() }))
    .query(async ({ input }) => {
      const membros = await prisma.iaProjetoUsuario.findMany({
        where: { projetoId: input.projetoId },
        include: { usuario: { select: { id: true, nome: true, email: true, ativo: true } } },
        orderBy: { criadoEm: "asc" },
      });
      return membros;
    }),

  listTodosUsuarios: authProc.query(async ({ ctx }) => {
    return prisma.usuario.findMany({
      where: { ativo: true, ...whereEmpresa(ctx) },
      select: { id: true, nome: true, email: true },
      orderBy: { nome: "asc" },
    });
  }),

  upsertProjetoUsuario: authProc
    .input(z.object({
      projetoId:    z.string(),
      usuarioId:    z.string(),
      funcao:       z.string().default("atendente"),
      nomeWhatsapp: z.string().nullable().optional(),
    }))
    .mutation(async ({ input }) => {
      return prisma.iaProjetoUsuario.upsert({
        where: { projetoId_usuarioId: { projetoId: input.projetoId, usuarioId: input.usuarioId } },
        create: {
          projetoId:    input.projetoId,
          usuarioId:    input.usuarioId,
          funcao:       input.funcao,
          nomeWhatsapp: input.nomeWhatsapp ?? null,
        },
        update: {
          funcao:       input.funcao,
          nomeWhatsapp: input.nomeWhatsapp ?? null,
        },
      });
    }),

  removeProjetoUsuario: authProc
    .input(z.object({ projetoId: z.string(), usuarioId: z.string() }))
    .mutation(async ({ input }) => {
      return prisma.iaProjetoUsuario.delete({
        where: { projetoId_usuarioId: { projetoId: input.projetoId, usuarioId: input.usuarioId } },
      });
    }),

  // ── Metrics ────────────────────────────────────────────────────────────────

  metricsUsuarios: authProc
    .input(z.object({
      projetoId: z.string(),
      de:        z.string().optional(), // ISO date string
      ate:       z.string().optional(),
    }))
    .query(async ({ input }) => {
      const de  = input.de  ? new Date(input.de)  : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const ate = input.ate ? new Date(input.ate) : new Date();

      const membros = await prisma.iaProjetoUsuario.findMany({
        where: { projetoId: input.projetoId },
        include: { usuario: { select: { id: true, nome: true, email: true } } },
      });

      const metrics = await Promise.all(membros.map(async (m) => {
        const [mensagensEnviadas, conversasTomadas, mudancasStage] = await Promise.all([
          // Manual messages sent
          prisma.crmMensagemWhatsapp.count({
            where: { direcao: "out", enviadaEm: { gte: de, lte: ate },
              deal: { projetoId: input.projetoId, iaPausadaPor: m.usuarioId } },
          }),
          // Deals taken over (paused by this user)
          prisma.crmDeal.count({
            where: { iaPausadaPor: m.usuarioId, projetoId: input.projetoId,
              iaPausadaEm: { gte: de, lte: ate } },
          }),
          // Stage changes attributed to user
          prisma.crmDealStageLog.count({
            where: { usuarioId: m.usuarioId, criadoEm: { gte: de, lte: ate },
              deal: { projetoId: input.projetoId } },
          }),
        ]);

        return {
          usuarioId:    m.usuarioId,
          nome:         m.usuario.nome,
          email:        m.usuario.email,
          funcao:       m.funcao,
          nomeWhatsapp: m.nomeWhatsapp,
          mensagensEnviadas,
          conversasTomadas,
          mudancasStage,
        };
      }));

      return metrics;
    }),

  // ── Perguntas de qualificação ───────────────────────────────────────────────

  listPerguntas: authProc
    .input(z.object({ projetoId: z.string() }))
    .query(async ({ input }) => {
      return prisma.iaPerguntaQualificacao.findMany({
        where: { projetoId: input.projetoId },
        orderBy: { ordem: "asc" },
      });
    }),

  upsertPergunta: authProc
    .input(z.object({
      id:               z.string().optional(),
      projetoId:        z.string(),
      chave:            z.string().min(1),
      perguntaContexto: z.string().min(1),
      exemploAbordagem: z.string().optional(),
      tipoDado:         z.enum(["texto", "booleano", "numero", "data"]).default("texto"),
      obrigatorio:      z.boolean().default(true),
      ativo:            z.boolean().default(true),
      ordem:            z.number().int(),
      stageColeta:      z.string().optional(),
      dependeDe:        z.string().optional(),
      ativaSeResposta:  z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      const { id, projetoId, ...data } = input;
      if (id) {
        return prisma.iaPerguntaQualificacao.update({ where: { id }, data });
      }
      return prisma.iaPerguntaQualificacao.create({ data: { ...data, projetoId } });
    }),

  deletePergunta: authProc
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      return prisma.iaPerguntaQualificacao.update({ where: { id: input.id }, data: { ativo: false } });
    }),

  reorderPerguntas: authProc
    .input(z.object({ ids: z.array(z.string()) }))
    .mutation(async ({ input }) => {
      await Promise.all(
        input.ids.map((id, idx) =>
          prisma.iaPerguntaQualificacao.update({ where: { id }, data: { ordem: idx + 1 } })
        )
      );
      return { ok: true };
    }),

  // ── Regras de transição ────────────────────────────────────────────────────

  listRegras: authProc
    .input(z.object({ projetoId: z.string() }))
    .query(async ({ input }) => {
      return prisma.iaRegraTransicao.findMany({
        where: { projetoId: input.projetoId },
        orderBy: [{ stageOrigemChave: "asc" }, { ordem: "asc" }],
      });
    }),

  upsertRegra: authProc
    .input(z.object({
      id:                   z.string().optional(),
      projetoId:            z.string(),
      stageOrigemChave:     z.string().optional(),
      stageDestinoChave:    z.string().min(1),
      condicao:             z.string().min(1),
      acaoAdicional:        z.string().optional(),
      parametros:           z.record(z.unknown()).optional(),
      ordem:                z.number().int().default(0),
      requerPrescricaoAtiva: z.boolean().default(false),
    }))
    .mutation(async ({ input }) => {
      const { id, projetoId, ...data } = input;
      if (id) {
        return prisma.iaRegraTransicao.update({ where: { id }, data: data as any });
      }
      return prisma.iaRegraTransicao.create({ data: { ...data, projetoId } as any });
    }),

  deleteRegra: authProc
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      return prisma.iaRegraTransicao.delete({ where: { id: input.id } });
    }),

  // ─── Vínculo Flow Passos ───────────────────────────────────────────────────

  listFlowPassos: authProc
    .input(z.object({ projetoId: z.string() }))
    .query(async ({ input }) => {
      // Auto-seed if empty (same logic as stage-engine)
      const rows = await prisma.iaVinculoFlowPasso.findMany({
        where: { projetoId: input.projetoId },
        orderBy: { ordemPadrao: "asc" },
      });
      if (rows.length === 0) {
        // Return defaults without seeding from here — engine auto-seeds on first message
        const defaults = [
          { chave: "empresa",        campoColetar: "empresa",        ordemPadrao: 1,  pergunta: "Em qual empresa você trabalhou (ou trabalha)?",                         skipSe: null, tipoEspecial: null },
          { chave: "funcao",         campoColetar: "funcao",         ordemPadrao: 2,  pergunta: "Qual era sua função lá?",                                               skipSe: null, tipoEspecial: null },
          { chave: "vinculo",        campoColetar: "vinculo",        ordemPadrao: 3,  pergunta: "Nessa empresa você tinha carteira assinada, trabalhava sem registro (sem carteira) ou era autônomo com o seu próprio caminhão?", skipSe: null, tipoEspecial: null },
          { chave: "saida",          campoColetar: "saida",          ordemPadrao: 4,  pergunta: "Como foi o desligamento — foi demitido, pediu demissão ou ainda está lá?", skipSe: null, tipoEspecial: null },
          { chave: "horas_extras",   campoColetar: "horas_extras",   ordemPadrao: 5,  pergunta: "Trabalhava além da jornada normal? Recebia por essas horas?",            skipSe: null, tipoEspecial: null },
          { chave: "pagamento_fora", campoColetar: "pagamento_fora", ordemPadrao: 6,  pergunta: "Recebia algum valor fora do holerite, como Pix, Pamcard ou dinheiro?",   skipSe: null, tipoEspecial: null },
          { chave: "injustica",      campoColetar: "injustica",      ordemPadrao: 7,  pergunta: "Teve alguma pressão, desconto indevido ou jornada sem registro?",        skipSe: null, tipoEspecial: null },
          { chave: "frota",          campoColetar: "frota",          ordemPadrao: 8,  pergunta: "Quantos caminhões a empresa tinha na frota?",                            skipSe: { campo: "vinculo", contem_qualquer: ["clt", "carteira assinada", "carteira"] }, tipoEspecial: null },
          { chave: "mais_empregos",  campoColetar: null,             ordemPadrao: 9,  pergunta: "Antes de trabalhar lá, você trabalhou em outro lugar nos últimos 2 anos?", skipSe: null, tipoEspecial: "mais_empregos" },
        ];
        await prisma.iaVinculoFlowPasso.createMany({
          data: defaults.map(d => ({
            projetoId: input.projetoId,
            ativo: true,
            chave: d.chave,
            pergunta: d.pergunta,
            campoColetar: d.campoColetar,
            ordemPadrao: d.ordemPadrao,
            skipSe: d.skipSe as any,
            tipoEspecial: d.tipoEspecial,
          })),
          skipDuplicates: true,
        });
        return prisma.iaVinculoFlowPasso.findMany({
          where: { projetoId: input.projetoId },
          orderBy: { ordemPadrao: "asc" },
        });
      }
      return rows;
    }),

  upsertFlowPasso: authProc
    .input(z.object({
      id: z.string().optional(),
      projetoId: z.string(),
      chave: z.string(),
      pergunta: z.string(),
      campoColetar: z.string().nullable().optional(),
      ordemPadrao: z.number().int().default(0),
      ativo: z.boolean().default(true),
      skipSe: z.any().optional(),
      tipoEspecial: z.string().nullable().optional(),
    }))
    .mutation(async ({ input }) => {
      const { id, projetoId, ...data } = input;
      const { invalidateFlowCache } = await import("../agent/stage-engine.js");
      invalidateFlowCache(projetoId);
      if (id) {
        return prisma.iaVinculoFlowPasso.update({ where: { id }, data });
      }
      return prisma.iaVinculoFlowPasso.create({ data: { ...data, projetoId } });
    }),

  deleteFlowPasso: authProc
    .input(z.object({ id: z.string(), projetoId: z.string() }))
    .mutation(async ({ input }) => {
      const { invalidateFlowCache } = await import("../agent/stage-engine.js");
      invalidateFlowCache(input.projetoId);
      return prisma.iaVinculoFlowPasso.delete({ where: { id: input.id } });
    }),

  reorderFlowPassos: authProc
    .input(z.object({
      projetoId: z.string(),
      items: z.array(z.object({ id: z.string(), ordemPadrao: z.number().int() })),
    }))
    .mutation(async ({ input }) => {
      const { invalidateFlowCache } = await import("../agent/stage-engine.js");
      invalidateFlowCache(input.projetoId);
      await Promise.all(
        input.items.map(item =>
          prisma.iaVinculoFlowPasso.update({ where: { id: item.id }, data: { ordemPadrao: item.ordemPadrao } })
        )
      );
      return { ok: true };
    }),

  // ── Flow Controller — IaFlowStep ──────────────────────────────────────────

  listFlowSteps: authProc
    .input(z.object({ projetoId: z.string(), personaChave: z.string().optional() }))
    .query(async ({ input }) => {
      return prisma.iaFlowStep.findMany({
        where: {
          projetoId: input.projetoId,
          ativo: true,
          ...(input.personaChave ? { personaChave: input.personaChave } : {}),
        },
        orderBy: [{ personaChave: "asc" }, { ordem: "asc" }],
        include: { gates: { orderBy: { ordem: "asc" } } },
      });
    }),

  upsertFlowStep: authProc
    .input(z.object({
      id: z.string().optional(),
      projetoId: z.string(),
      personaChave: z.string(),
      fase: z.string(),
      chave: z.string(),
      ordem: z.number().int(),
      label: z.string(),
      pergunta: z.string(),
      stepType: z.string().default("question"),
      campoColetar: z.string().nullable().optional(),
      skipSe: z.any().optional(),
      ativo: z.boolean().default(true),
    }))
    .mutation(async ({ input }) => {
      const { id, projetoId, ...data } = input;
      const { invalidateFlowStepCache } = await import("../agent/flow-controller.js");
      invalidateFlowStepCache(projetoId);
      if (id) return prisma.iaFlowStep.update({ where: { id }, data });
      return prisma.iaFlowStep.create({ data: { ...data, projetoId } });
    }),

  deleteFlowStep: authProc
    .input(z.object({ id: z.string(), projetoId: z.string() }))
    .mutation(async ({ input }) => {
      const { invalidateFlowStepCache } = await import("../agent/flow-controller.js");
      invalidateFlowStepCache(input.projetoId);
      const deleted = await prisma.iaFlowStep.delete({ where: { id: input.id } });
      // Renumber remaining steps in same group so there are no gaps
      const siblings = await prisma.iaFlowStep.findMany({
        where: { projetoId: deleted.projetoId, personaChave: deleted.personaChave, fase: deleted.fase, ordem: { gt: deleted.ordem } },
        orderBy: { ordem: "asc" },
        select: { id: true, ordem: true },
      });
      await Promise.all(siblings.map(s => prisma.iaFlowStep.update({ where: { id: s.id }, data: { ordem: s.ordem - 1 } })));
      return deleted;
    }),

  reorderFlowSteps: authProc
    .input(z.object({
      projetoId: z.string(),
      items: z.array(z.object({ id: z.string(), ordem: z.number().int() })),
    }))
    .mutation(async ({ input }) => {
      const { invalidateFlowStepCache } = await import("../agent/flow-controller.js");
      invalidateFlowStepCache(input.projetoId);
      await Promise.all(input.items.map(item =>
        prisma.iaFlowStep.update({ where: { id: item.id }, data: { ordem: item.ordem } })
      ));
      return { ok: true };
    }),

  // ── Flow Controller — IaFlowGate ──────────────────────────────────────────

  upsertFlowGate: authProc
    .input(z.object({
      id: z.string().optional(),
      stepId: z.string(),
      projetoId: z.string(),
      condicao: z.string(),
      actionType: z.string(),
      actionValue: z.string().nullable().optional(),
      label: z.string().nullable().optional(),
      cor: z.string().nullable().optional(),
      ordem: z.number().int().default(0),
    }))
    .mutation(async ({ input }) => {
      const { id, projetoId, ...data } = input;
      const { invalidateFlowStepCache } = await import("../agent/flow-controller.js");
      invalidateFlowStepCache(projetoId);
      if (id) return prisma.iaFlowGate.update({ where: { id }, data });
      return prisma.iaFlowGate.create({ data });
    }),

  deleteFlowGate: authProc
    .input(z.object({ id: z.string(), projetoId: z.string() }))
    .mutation(async ({ input }) => {
      const { invalidateFlowStepCache } = await import("../agent/flow-controller.js");
      invalidateFlowStepCache(input.projetoId);
      return prisma.iaFlowGate.delete({ where: { id: input.id } });
    }),

  // ── Seed Flow Steps (Ana + Daniela) ───────────────────────────────────────

  seedFlowSteps: authProc
    .input(z.object({ projetoId: z.string() }))
    .mutation(async ({ input }) => {
      const { projetoId } = input;
      const { invalidateFlowStepCache } = await import("../agent/flow-controller.js");
      invalidateFlowStepCache(projetoId);

      // ── Ana — Agente 0: triagem (pre_vinculos) ────────────────────────────────
      type AnaStep = { chave: string; ordem: number; label: string; pergunta: string; campoColetar?: string | null; stepType: string };
      const preSteps: AnaStep[] = [
        { chave: "saudacao",           ordem: 0, label: "Saudação inicial",         stepType: "saudacao", campoColetar: null,                pergunta: "Sou a Ana, do escritório PSA. Vi que você entrou em contato — pode me informar seu nome?" },
        { chave: "nome_cliente",       ordem: 1, label: "Nome do cliente",          stepType: "question", campoColetar: "nome",              pergunta: "Qual é o seu nome?" },
        { chave: "confirmar_funcao",   ordem: 2, label: "Confirmar função",          stepType: "gate",     campoColetar: "e_carreteiro",      pergunta: "Você trabalha ou trabalhou como motorista carreteiro ou caminhoneiro?" },
        { chave: "confirmar_clt",      ordem: 3, label: "Confirmar vínculo CLT",     stepType: "gate",     campoColetar: "e_clt",             pergunta: "Você trabalha com carteira assinada ou é autônomo (dono do seu próprio caminhão)? Se trabalhava sem registro na carteira, me fala também." },
        { chave: "cidade_residencia",  ordem: 4, label: "Cidade de residência",      stepType: "question", campoColetar: "cidade",            pergunta: "Em qual cidade você reside atualmente?" },
        { chave: "empresa_situacao",   ordem: 5, label: "Empresa + saída + tempo",   stepType: "gate",     campoColetar: "empresa_principal", pergunta: "Qual é o nome da empresa que você trabalhou ou ainda trabalha? Você já saiu desta empresa? Se já saiu, quando ocorreu?" },
        { chave: "acao_andamento",     ordem: 6, label: "Ação em andamento?",        stepType: "gate",     campoColetar: "acao_em_andamento", pergunta: "Você já possui alguma ação em andamento ou tem outro advogado cuidando dessa situação?" },
        { chave: "frota",              ordem: 7, label: "Frota da empresa",           stepType: "question", campoColetar: "frota",             pergunta: "Quantos caminhões ou carretas tem a frota dessa empresa? Pode ser um número aproximado." },
      ];

      // ── Ana — Marketing (fase separada, sem bloquear o fluxo principal) ──────
      const marketingSteps: AnaStep[] = [
        { chave: "cidade_anuncio",   ordem: 1, label: "Cidade do anúncio",    stepType: "question", campoColetar: "cidade_anuncio",   pergunta: "Em qual cidade você viu o nosso anúncio?" },
      ];

      for (const s of marketingSteps) {
        await prisma.iaFlowStep.upsert({
          where: { projetoId_personaChave_chave: { projetoId, personaChave: "assistente", chave: s.chave } },
          create: { projetoId, personaChave: "assistente", fase: "marketing", ...s },
          update: { fase: "marketing", ...s },
        });
      }

      const preGates: Record<string, { condicao: string; actionType: string; actionValue: string | null; label: string; cor: string; ordem: number }[]> = {
        confirmar_funcao: [
          { condicao: "NÃO é motorista de carga (ex: motorista de ônibus, moto)", actionType: "end",      actionValue: "Entendo! Infelizmente o nosso escritório é especializado em carreteiros e caminhoneiros. Não consigo te ajudar nesse caso.", label: "Não é carreteiro", cor: "#ef4444", ordem: 0 },
          { condicao: "É carreteiro, caminhoneiro ou transportador de carga",       actionType: "continue", actionValue: null, label: "É carreteiro",     cor: "#10b981", ordem: 1 },
        ],
        confirmar_clt: [
          { condicao: "É autônomo — dono do próprio caminhão, sem patrão",          actionType: "end",      actionValue: "Entendo! Para entrar com uma ação trabalhista é necessário ter vínculo empregatício — carteira assinada ou trabalho sem registro. Autônomos donos do próprio caminhão não se enquadram.", label: "Autônomo", cor: "#ef4444", ordem: 0 },
          { condicao: "Tinha carteira assinada ou trabalhava sem registro (CLT não registrado)", actionType: "continue", actionValue: null, label: "CLT / sem registro", cor: "#10b981", ordem: 1 },
        ],
        empresa_situacao: [
          { condicao: "Empresa na lista negra (bloqueada pelo escritório)",          actionType: "end",        actionValue: "Infelizmente não trabalhamos com ações contra essa empresa no momento.", label: "Lista negra", cor: "#ef4444", ordem: 0 },
          { condicao: "Tempo trabalhado MAIOR que 1 ano e 6 meses",                  actionType: "goto_agent", actionValue: "pos_vinculos",       label: "🔀 > 1a6m → Ag. 2",     cor: "#8b5cf6", ordem: 1 },
          { condicao: "Tempo trabalhado MENOR ou igual a 1 ano e 6 meses",           actionType: "goto_agent", actionValue: "pos_vinculos_curto", label: "🔀 ≤ 1a6m → Ag. 3",     cor: "#f59e0b", ordem: 2 },
        ],
        acao_andamento: [
          { condicao: "SIM — já tem advogado ou ação trabalhista em andamento",      actionType: "end",      actionValue: "Entendo! Já que você tem um advogado cuidando disso, não vou interferir. Qualquer dúvida, pode falar comigo.", label: "Tem advogado/ação", cor: "#ef4444", ordem: 0 },
          { condicao: "Resposta ambígua — não ficou claro se tem ou não",            actionType: "repeat",   actionValue: null, label: "Ambíguo → repetir",  cor: "#f59e0b", ordem: 1 },
          { condicao: "NÃO tem advogado nem ação em andamento",                      actionType: "continue", actionValue: null, label: "Não tem → continua",  cor: "#10b981", ordem: 2 },
        ],
      };

      for (const s of preSteps) {
        const created = await prisma.iaFlowStep.upsert({
          where: { projetoId_personaChave_chave: { projetoId, personaChave: "assistente", chave: s.chave } },
          create: { projetoId, personaChave: "assistente", fase: "pre_vinculos", ...s },
          update: { fase: "pre_vinculos", ...s },
        });
        if (preGates[s.chave]) {
          await prisma.iaFlowGate.createMany({ data: preGates[s.chave].map(g => ({ ...g, stepId: created.id })), skipDuplicates: true });
        }
      }

      // ── Ana — Agente 2/3: qualificação (pos_vinculos) ─────────────────────────
      const posSteps: AnaStep[] = [
        { chave: "prazo_prescricional", ordem: 1, label: "Prazo prescricional",   stepType: "gate",     campoColetar: null,                  pergunta: "Você saiu deste emprego há mais de 2 anos?" },
        { chave: "horas_extras",        ordem: 2, label: "Horas extras",           stepType: "question", campoColetar: "horas_extras",        pergunta: "Sua rotina de trabalho ultrapassava 8 horas por dia ou 44 horas semanais?" },
        { chave: "pagamento_fora",      ordem: 3, label: "Pagamento por fora",     stepType: "question", campoColetar: "pagamento_fora",      pergunta: "Você recebia algum valor por fora do salário — em dinheiro vivo ou depósito fora do holerite?" },
        { chave: "relato_injustica",    ordem: 4, label: "Relato / injustiça",     stepType: "question", campoColetar: "relato",              pergunta: "Há mais alguma coisa que você queira relatar? Acidente, dificuldade ou outra situação que viveu nessa empresa?" },
        { chave: "interesse_acao",      ordem: 5, label: "Interesse na ação",      stepType: "gate",     campoColetar: "interesse",           pergunta: "Com base no que você me contou, acredito que você tem direitos a reclamar. Você tem interesse em entrar com uma ação trabalhista?" },
        { chave: "turno_agendamento",   ordem: 6, label: "Turno para contato",     stepType: "question", campoColetar: "melhor_hora_contato", pergunta: "Qual o melhor turno para a advogada entrar em contato com você? Manhã, tarde ou noite?" },
        { chave: "encerramento_ana",    ordem: 7, label: "Encerramento",           stepType: "end",      campoColetar: null,                  pergunta: "Ótimo! Já direcionei seu caso para a nossa advogada. Ela vai entrar em contato no turno que você indicou. Obrigada!" },
      ];

      const posGates: Record<string, { condicao: string; actionType: string; actionValue: string | null; label: string; cor: string; ordem: number }[]> = {
        prazo_prescricional: [
          { condicao: "Saiu do emprego HÁ MAIS de 2 anos (prazo prescricional encerrado)",    actionType: "end",      actionValue: "Infelizmente, pela legislação trabalhista, o prazo para ajuizar ação é de 2 anos após a saída do emprego. Seu prazo já expirou.", label: "Prescrito", cor: "#ef4444", ordem: 0 },
          { condicao: "Ainda está empregado ou saiu HÁ MENOS de 2 anos",                       actionType: "continue", actionValue: null, label: "Dentro do prazo", cor: "#10b981", ordem: 1 },
        ],
        interesse_acao: [
          { condicao: "NÃO tem interesse ou desiste",  actionType: "end",      actionValue: "Entendo! Fica à vontade — se mudar de ideia, pode me chamar aqui a qualquer momento.", label: "Sem interesse", cor: "#ef4444", ordem: 0 },
          { condicao: "SIM, tem interesse em prosseguir", actionType: "continue", actionValue: null, label: "Tem interesse", cor: "#10b981", ordem: 1 },
        ],
        encerramento_ana: [
          { condicao: "Lead qualificado — notificar equipe de advogados", actionType: "notify", actionValue: "LEAD_QUALIFICADO", label: "🔔 Notificar equipe", cor: "#14b8a6", ordem: 0 },
        ],
      };

      for (const s of posSteps) {
        const created = await prisma.iaFlowStep.upsert({
          where: { projetoId_personaChave_chave: { projetoId, personaChave: "assistente", chave: s.chave } },
          create: { projetoId, personaChave: "assistente", fase: "pos_vinculos", ...s },
          update: { fase: "pos_vinculos", ...s },
        });
        if (posGates[s.chave]) {
          await prisma.iaFlowGate.createMany({ data: posGates[s.chave].map(g => ({ ...g, stepId: created.id })), skipDuplicates: true });
        }
      }

      // ── Ana — Agente 3: qualificação curta (≤1a6m) com investigação de anterior ──
      type AnaStep3 = { chave: string; ordem: number; label: string; stepType: string; campoColetar: string | null; pergunta: string };
      const curtaSteps: AnaStep3[] = [
        { chave: "prazo_curto",           ordem:  1, label: "Prazo prescricional",          stepType: "gate",     campoColetar: "prazo_ok_curto",        pergunta: "Você saiu deste emprego há mais de 2 anos?" },
        { chave: "horas_extras_curto",    ordem:  2, label: "Horas extras",                  stepType: "question", campoColetar: "horas_extras",           pergunta: "Sua rotina de trabalho ultrapassava 8 horas por dia ou 44 horas semanais?" },
        { chave: "pagamento_curto",       ordem:  3, label: "Pagamento por fora",             stepType: "question", campoColetar: "pagamento_fora",         pergunta: "Você recebia algum valor por fora do salário — em dinheiro vivo ou depósito fora do holerite?" },
        { chave: "relato_curto",          ordem:  4, label: "Relato / injustiça",             stepType: "question", campoColetar: "relato",                 pergunta: "Há mais alguma coisa que você queira relatar sobre essa empresa? Acidente, dificuldade, pressão?" },
        { chave: "tem_emprego_anterior",  ordem:  5, label: "Tem emprego anterior?",          stepType: "gate",     campoColetar: "tem_emprego_anterior",   pergunta: "Antes dessa empresa, você trabalhou como carreteiro ou caminhoneiro em outra empresa nos últimos 2 anos?" },
        { chave: "empresa_anterior",      ordem:  6, label: "Empresa anterior",               stepType: "gate",     campoColetar: "empresa_anterior",       pergunta: "Qual é o nome dessa empresa anterior onde você trabalhou como carreteiro?" },
        { chave: "prazo_anterior",        ordem:  7, label: "Prazo prescricional anterior",   stepType: "gate",     campoColetar: "prazo_anterior_ok",      pergunta: "Quanto tempo faz que você saiu dessa empresa anterior? Ainda está dentro dos últimos 2 anos?" },
        { chave: "tempo_anterior",        ordem:  8, label: "Tempo na empresa anterior",      stepType: "question", campoColetar: "tempo_anterior",         pergunta: "Quanto tempo você trabalhou nessa empresa anterior?" },
        { chave: "clt_anterior",          ordem:  9, label: "Vínculo CLT anterior",           stepType: "gate",     campoColetar: "clt_anterior",           pergunta: "Nessa empresa anterior você tinha carteira assinada ou trabalhava sem registro?" },
        { chave: "frota_anterior",        ordem: 10, label: "Frota da empresa anterior",      stepType: "question", campoColetar: "frota_anterior",         pergunta: "Quantos caminhões ou carretas tinha a frota dessa empresa anterior?" },
        { chave: "horas_anterior",        ordem: 11, label: "Horas extras — anterior",        stepType: "question", campoColetar: "horas_extras_anterior",  pergunta: "Nessa empresa anterior sua rotina também ultrapassava 8h por dia ou 44h semanais?" },
        { chave: "pagamento_anterior",    ordem: 12, label: "Pagamento por fora — anterior",  stepType: "question", campoColetar: "pagamento_anterior",     pergunta: "Recebia algum valor por fora do salário nessa empresa anterior?" },
        { chave: "injustica_anterior",    ordem: 13, label: "Injustiça — anterior",           stepType: "question", campoColetar: "injustica_anterior",     pergunta: "Teve alguma dificuldade, acidente ou injustiça nessa empresa anterior que queira relatar?" },
        { chave: "interesse_curto",       ordem: 14, label: "Interesse na ação",              stepType: "gate",     campoColetar: "interesse",              pergunta: "Com base no que você me contou, acredito que você tem direitos a reclamar. Você tem interesse em entrar com uma ação trabalhista?" },
        { chave: "turno_curto",           ordem: 15, label: "Turno para contato",             stepType: "question", campoColetar: "melhor_hora_contato",    pergunta: "Qual o melhor turno para a advogada entrar em contato com você? Manhã, tarde ou noite?" },
        { chave: "encerramento_curto",    ordem: 16, label: "Encerramento",                   stepType: "end",      campoColetar: null,                     pergunta: "Ótimo! Já direcionei seu caso para a nossa advogada. Ela vai entrar em contato no turno que você indicou. Obrigada!" },
      ];

      const curtaGates: Record<string, { condicao: string; actionType: string; actionValue: string | null; label: string; cor: string; ordem: number }[]> = {
        prazo_curto: [
          { condicao: "Saiu do emprego HÁ MAIS de 2 anos (prazo prescricional encerrado)",   actionType: "end",      actionValue: "Infelizmente, pela legislação trabalhista, o prazo para ajuizar ação é de 2 anos após a saída do emprego. Seu prazo já expirou.", label: "Prescrito",       cor: "#ef4444", ordem: 0 },
          { condicao: "Ainda está empregado ou saiu HÁ MENOS de 2 anos",                      actionType: "continue", actionValue: null, label: "Dentro do prazo", cor: "#10b981", ordem: 1 },
        ],
        tem_emprego_anterior: [
          { condicao: "NÃO tem emprego anterior como carreteiro nos últimos 2 anos",           actionType: "goto_step", actionValue: "interesse_curto", label: "Sem anterior → pula", cor: "#f59e0b", ordem: 0 },
          { condicao: "SIM, tem emprego anterior como carreteiro",                             actionType: "continue",  actionValue: null,              label: "Tem anterior",        cor: "#10b981", ordem: 1 },
        ],
        empresa_anterior: [
          { condicao: "Empresa anterior na lista negra (bloqueada pelo escritório)",           actionType: "goto_step", actionValue: "interesse_curto", label: "Lista negra → pula", cor: "#ef4444", ordem: 0 },
          { condicao: "Empresa anterior fora da lista — pode prosseguir",                     actionType: "continue",  actionValue: null,              label: "Empresa ok",          cor: "#10b981", ordem: 1 },
        ],
        prazo_anterior: [
          { condicao: "Saiu do emprego anterior HÁ MAIS de 2 anos (prescrito)",               actionType: "goto_step", actionValue: "interesse_curto", label: "Prescrito → pula",  cor: "#ef4444", ordem: 0 },
          { condicao: "Ainda dentro dos 2 anos — pode investigar",                            actionType: "continue",  actionValue: null,              label: "Dentro do prazo",     cor: "#10b981", ordem: 1 },
        ],
        clt_anterior: [
          { condicao: "Era autônomo (dono do próprio caminhão) na empresa anterior",           actionType: "goto_step", actionValue: "interesse_curto", label: "Autônomo → pula",   cor: "#f59e0b", ordem: 0 },
          { condicao: "Tinha carteira assinada ou trabalhava sem registro na anterior",        actionType: "continue",  actionValue: null,              label: "CLT / sem registro",  cor: "#10b981", ordem: 1 },
        ],
        interesse_curto: [
          { condicao: "NÃO tem interesse ou desiste",                                          actionType: "end",      actionValue: "Entendo! Fica à vontade — se mudar de ideia, pode me chamar aqui a qualquer momento.", label: "Sem interesse", cor: "#ef4444", ordem: 0 },
          { condicao: "SIM, tem interesse em prosseguir",                                     actionType: "continue", actionValue: null, label: "Tem interesse", cor: "#10b981", ordem: 1 },
        ],
        encerramento_curto: [
          { condicao: "Lead qualificado — notificar equipe de advogados",                     actionType: "notify",   actionValue: "LEAD_QUALIFICADO", label: "🔔 Notificar equipe", cor: "#14b8a6", ordem: 0 },
        ],
      };

      for (const s of curtaSteps) {
        const created = await prisma.iaFlowStep.upsert({
          where: { projetoId_personaChave_chave: { projetoId, personaChave: "assistente", chave: s.chave } },
          create: { projetoId, personaChave: "assistente", fase: "pos_vinculos_curto", ...s },
          update: { fase: "pos_vinculos_curto", ...s },
        });
        if (curtaGates[s.chave]) {
          await prisma.iaFlowGate.createMany({ data: curtaGates[s.chave].map(g => ({ ...g, stepId: created.id })), skipDuplicates: true });
        }
      }

      // Daniela — coleta sequencial
      const danielaSteps = [
        { chave: "apresentacao",       ordem:  1, label: "Apresentação",            stepType: "question",  campoColetar: null,             pergunta: "Oi! Sou a Dra. Daniela Pires, advogada do escritório. A Ana me passou seu caso e analisei o que você relatou — você tem direitos a reclamar sim. Me deixa te explicar como funciona." },
        { chave: "parecer",            ordem:  2, label: "Parecer jurídico",        stepType: "llm_generated", campoColetar: null,          pergunta: "Gere um parecer jurídico personalizado com base nos dados reais coletados do lead: empresa(s), tempo de serviço, vínculos trabalhistas, horas extras, irregularidades relatadas. Cite as irregularidades específicas deste caso (não genéricas). Fundamente brevemente (CLT, art. 7º CF). Pergunte se faz sentido prosseguir. Máximo 4 frases curtas." },
        { chave: "explicar_processo",  ordem:  3, label: "Explicação do processo",  stepType: "gate",      campoColetar: null,             pergunta: "Nosso escritório trabalha no sucesso — você não paga nada adiantado. Só cobramos uma porcentagem do que conseguirmos para você. O processo fica na Justiça do Trabalho. Quer que eu explique os próximos passos?" },
        { chave: "turno_reuniao",      ordem:  4, label: "Turno para reunião",      stepType: "question",  campoColetar: "turno_reuniao",  pergunta: "Qual o melhor turno para você: manhã, tarde ou noite?" },
        { chave: "nome_completo",      ordem:  5, label: "Nome completo",           stepType: "question",  campoColetar: "nome_completo",  pergunta: "Pode me informar seu nome completo?" },
        { chave: "cpf",                ordem:  6, label: "CPF",                     stepType: "question",  campoColetar: "cpf",            pergunta: "Qual é o seu CPF?" },
        { chave: "data_nascimento",    ordem:  7, label: "Data de nascimento",      stepType: "question",  campoColetar: "data_nascimento",pergunta: "E sua data de nascimento?" },
        { chave: "endereco",           ordem:  8, label: "Endereço completo",       stepType: "question",  campoColetar: "endereco",       pergunta: "Me informa seu endereço completo com CEP, por favor." },
        { chave: "estado_civil",       ordem:  9, label: "Estado civil",            stepType: "question",  campoColetar: "estado_civil",   pergunta: "Qual é o seu estado civil?" },
        { chave: "profissao",          ordem: 10, label: "Profissão",               stepType: "question",  campoColetar: "profissao",      pergunta: "E sua profissão na carteira de trabalho?" },
        { chave: "envio_contrato",     ordem: 11, label: "Envio do contrato",       stepType: "document",  campoColetar: null,             pergunta: "Perfeito! Vou preparar o contrato e a procuração. Aguarda um instante." },
        { chave: "aguardar_assinatura",ordem: 12, label: "Aguardar assinatura",     stepType: "gate",      campoColetar: null,             pergunta: "Você pode me enviar os documentos assinados aqui pelo WhatsApp?" },
        { chave: "confirmacao_final",  ordem: 13, label: "Confirmação final",       stepType: "end",       campoColetar: null,             pergunta: "Recebi tudo! Em breve nossa equipe vai entrar em contato. Muito obrigada pela confiança!" },
      ];

      for (const s of danielaSteps) {
        const created = await prisma.iaFlowStep.upsert({
          where: { projetoId_personaChave_chave: { projetoId, personaChave: "advogado", chave: s.chave } },
          create: { projetoId, personaChave: "advogado", fase: "advogado", ...s },
          update: { fase: "advogado", ...s },
        });

        if (s.chave === "explicar_processo") {
          await prisma.iaFlowGate.createMany({
            data: [
              { stepId: created.id, condicao: "Cliente não quer seguir ou desiste",          actionType: "end",      actionValue: "Entendo! Se mudar de ideia, pode falar comigo a qualquer momento.", label: "Não quer",      cor: "#ef4444", ordem: 0 },
              { stepId: created.id, condicao: "Cliente confirma interesse em prosseguir",    actionType: "continue", actionValue: null,                                                                label: "Quer prosseguir",cor: "#10b981", ordem: 1 },
            ],
            skipDuplicates: true,
          });
        }
        if (s.chave === "aguardar_assinatura") {
          await prisma.iaFlowGate.createMany({
            data: [
              { stepId: created.id, condicao: "Cliente enviou documentos assinados",          actionType: "continue", actionValue: null,                                           label: "Docs enviados", cor: "#10b981", ordem: 0 },
              { stepId: created.id, condicao: "Cliente não enviou ainda ou teve dificuldade", actionType: "repeat",   actionValue: null,                                           label: "Aguardar",      cor: "#f59e0b", ordem: 1 },
            ],
            skipDuplicates: true,
          });
        }
        if (s.chave === "confirmacao_final") {
          await prisma.iaFlowGate.createMany({
            data: [
              { stepId: created.id, condicao: "Contrato assinado — notificar equipe para abertura do processo", actionType: "notify", actionValue: "CONTRATO_ASSINADO", label: "🔔 Notificar abertura", cor: "#14b8a6", ordem: 0 },
            ],
            skipDuplicates: true,
          });
        }
      }

      return { ok: true };
    }),

  // ── Fluxo pós-reunião: coleta docs + gera proposta ──────────────────────────

  dispararFluxoColetaDocs: authProc
    .input(z.object({ dealId: z.string() }))
    .mutation(async ({ input }) => {
      const deal = await prisma.crmDeal.findUnique({
        where: { id: input.dealId },
        include: { contato: { select: { id: true, nome: true, whatsapp: true } } },
      });
      if (!deal) throw new TRPCError({ code: "NOT_FOUND" });
      if (!deal.projetoId) throw new TRPCError({ code: "BAD_REQUEST", message: "Deal sem projeto IA" });

      // Reset to coleta_docs persona at beginning of flow
      await (prisma.crmDeal as any).update({
        where: { id: input.dealId },
        data: {
          iaPersonaChave: "coleta_docs",
          iaFlowStepChave: null,
          iaFlowStepData: null,
          iaAtiva: true,
          iaPersonaTrocadaEm: new Date(),
        },
      });

      // Send the first flow step message via WhatsApp (always cd_nome, never skip)
      if (deal.contato?.whatsapp) {
        const { getEvolutionConfig } = await import("../agent/message-handler.js");
        const evo = await getEvolutionConfig(deal.projetoId!);
        if (evo) {
          const { sendHumanized } = await import("../agent/message-handler.js");
          const nome = deal.contato.nome ?? "cliente";

          // First non-internal step (cd_nome) always has the intro + name question
          const firstStep = await prisma.iaFlowStep.findFirst({
            where: { projetoId: deal.projetoId!, personaChave: "coleta_docs", ativo: true, stepType: { not: "context_load" }, pergunta: { not: "" } },
            orderBy: { ordem: "asc" },
          });

          if (firstStep) {
            // Os steps do fluxo trazem {nome_persona} e companhia no texto — sem resolver aqui,
            // o lead recebe a chave literal ("Aqui é {nome_persona}"). Mesmos placeholders que o
            // stage-engine já resolve nas demais mensagens do fluxo.
            const { getPersonaNomeExibicao } = await import("../agent/transition-engine.js");
            const [personaNome, advNome, secNome, assistNome] = await Promise.all([
              getPersonaNomeExibicao(deal.projetoId!, "coleta_docs"),
              getPersonaNomeExibicao(deal.projetoId!, "advogado"),
              getPersonaNomeExibicao(deal.projetoId!, "secretaria"),
              getPersonaNomeExibicao(deal.projetoId!, "assistente"),
            ]);
            const texto = firstStep.pergunta
              .replace(/\{nome\}/g, nome)
              .replace(/\{nome_persona\}/g, personaNome)
              .replace(/\{nome_advogado\}/g, advNome)
              .replace(/\{nome_secretaria\}/g, secNome)
              .replace(/\{nome_assistente\}/g, assistNome);
            await sendHumanized(evo, deal.contato.whatsapp, texto, 0);
            await prisma.crmMensagemWhatsapp.create({
              // remetente era "Ana" fixo, mas quem fala na coleta é a persona coleta_docs —
              // a caixa mostrava um nome e o texto da mensagem, outro.
              data: { dealId: deal.id, contatoId: deal.contato.id, direcao: "out", personaChave: "coleta_docs", remetente: personaNome, tipo: "text", conteudo: texto },
            });
            // Mark first step as sent so next incoming message processes the step
            // (not reinitializes the flow with the greeting again)
            await (prisma.crmDeal as any).update({
              where: { id: deal.id },
              data: {
                iaFlowStepChave: firstStep.chave,
                iaFlowStepData: { apresentacao_enviado: true },
              },
            });
          }
        }
      }

      await prisma.crmNota.create({
        data: { dealId: input.dealId, conteudo: `[IA] Fluxo pós-reunião iniciado — coletando dados para procuração/contrato` },
      });

      return { ok: true };
    }),

  dispararFluxoMarcarReuniao: authProc
    .input(z.object({ dealId: z.string() }))
    .mutation(async ({ input }) => {
      const deal = await prisma.crmDeal.findUnique({
        where: { id: input.dealId },
        include: { contato: { select: { id: true, nome: true, whatsapp: true } } },
      });
      if (!deal) throw new TRPCError({ code: "NOT_FOUND" });
      if (!deal.contato?.whatsapp) throw new TRPCError({ code: "BAD_REQUEST", message: "Deal sem WhatsApp no contato" });

      // Se o deal não tem projetoId, usa o primeiro projeto da empresa
      let projetoId = deal.projetoId;
      if (!projetoId) {
        const projeto = await prisma.iaProjeto.findFirst({
          where: { empresaId: deal.empresaId ?? undefined },
          orderBy: { criadoEm: "asc" },
        });
        if (!projeto) throw new TRPCError({ code: "BAD_REQUEST", message: "Nenhum projeto IA configurado para esta empresa" });
        projetoId = projeto.id;
        await prisma.crmDeal.update({ where: { id: input.dealId }, data: { projetoId } });
      }

      const secPersona = await prisma.iaPersona.findUnique({
        where: { projetoId_chave: { projetoId, chave: "secretaria" } },
      });
      if (!secPersona) throw new TRPCError({ code: "BAD_REQUEST", message: "Persona secretaria não configurada" });

      // Troca para persona secretaria com estado limpo
      await (prisma.crmDeal as any).update({
        where: { id: input.dealId },
        data: {
          projetoId,
          iaPersonaChave: "secretaria",
          iaFlowStepChave: null,
          iaFlowStepData: {},
          iaAtiva: true,
          iaPersonaTrocadaEm: new Date(),
        },
      });

      // Remove stale meeting fields from qualificacao so encontrarSlotPorTexto
      // doesn't match a previously chosen (possibly hallucinated) horario_reuniao.
      await prisma.$executeRaw`UPDATE "CrmDeal" SET qualificacao = qualificacao - 'horario_reuniao' - '_reuniao_criada' - '_reuniao_link' WHERE id = ${input.dealId}`;

      await prisma.crmNota.create({
        data: { dealId: input.dealId, conteudo: `[IA] Fluxo de agendamento iniciado pelo SDR humano — Ana assumirá o agendamento com o lead` },
      });

      // Dispara processIncomingMessage com mensagem sintética do lead,
      // exatamente como o stage-engine faria ao receber uma mensagem real.
      // O stage-engine detecta persona=secretaria, busca slots reais e gera a abertura.
      const phone = deal.contato.whatsapp;
      const syntheticMsg = {
        key: {
          id: `secretaria_trigger_${Date.now()}`,
          remoteJid: `${phone}@s.whatsapp.net`,
          fromMe: false,
        },
        message: { conversation: "." },
        messageType: "conversation",
        pushName: deal.contato.nome ?? undefined,
      };
      const { processIncomingMessage } = await import("../agent/stage-engine.js");
      processIncomingMessage(projetoId, syntheticMsg).catch((e: any) =>
        console.error("[dispararFluxoMarcarReuniao] stage-engine error:", e.message)
      );

      return { ok: true };
    }),

  // ── Follow-up por stage (conversa) ───────────────────────────────────────────

  getStageFollowUp: authProc
    .input(z.object({ projetoId: z.string(), stageChave: z.string() }))
    .query(async ({ input }) => {
      const { projetoId, stageChave } = input;
      const regras = await prisma.iaRegraTransicao.findMany({
        where: { projetoId, stageOrigemChave: stageChave, condicao: "follow_up_timed" },
        orderBy: { ordem: "asc" },
      });
      const templates = await prisma.iaMensagemTemplate.findMany({
        where: { projetoId, chave: { startsWith: `${stageChave}_follow_up_` } },
      });
      const tplMap = Object.fromEntries(templates.map(t => [t.chave, t.template]));
      const defaults = [
        { delayHoras: 24, template: "" },
        { delayHoras: 48, template: "" },
        { delayHoras: 72, template: "" },
      ];
      return {
        ativo: regras.length > 0,
        mensagens: regras.length > 0
          ? regras.map((r, i) => ({
              delayHoras: (r.parametros as any)?.delayHoras ?? 24,
              template: tplMap[`${stageChave}_follow_up_${i + 1}`] ?? "",
            }))
          : defaults,
      };
    }),

  saveStageFollowUp: authProc
    .input(z.object({
      projetoId:  z.string(),
      stageChave: z.string(),
      ativo:      z.boolean(),
      mensagens:  z.array(z.object({ delayHoras: z.number(), template: z.string() })),
    }))
    .mutation(async ({ input }) => {
      const { projetoId, stageChave, ativo, mensagens } = input;
      await prisma.iaRegraTransicao.deleteMany({
        where: { projetoId, stageOrigemChave: stageChave, condicao: "follow_up_timed" },
      });
      if (ativo && mensagens.length > 0) {
        await prisma.iaRegraTransicao.createMany({
          data: mensagens.map((m, i) => ({
            projetoId,
            stageOrigemChave:  stageChave,
            stageDestinoChave: stageChave,
            condicao:          "follow_up_timed",
            acaoAdicional:     `follow_up_${i + 1}`,
            parametros:        { delayHoras: m.delayHoras },
            ordem:             i + 1,
          })),
        });
      }
      for (let i = 0; i < mensagens.length; i++) {
        const chave = `${stageChave}_follow_up_${i + 1}`;
        if (mensagens[i].template.trim()) {
          await prisma.iaMensagemTemplate.upsert({
            where:  { projetoId_chave: { projetoId, chave } },
            create: { projetoId, chave, template: mensagens[i].template, ativo: true },
            update: { template: mensagens[i].template },
          });
        }
      }
      return { ok: true };
    }),

  // ── IaMensagemTemplate CRUD ───────────────────────────────────────────────────

  listMensagemTemplates: authProc
    .input(z.object({ projetoId: z.string(), prefixo: z.string().optional() }))
    .query(async ({ input }) => {
      return prisma.iaMensagemTemplate.findMany({
        where: {
          projetoId: input.projetoId,
          ...(input.prefixo ? { chave: { startsWith: input.prefixo } } : {}),
        },
        orderBy: { chave: "asc" },
      });
    }),

  upsertMensagemTemplate: authProc
    .input(z.object({
      projetoId:    z.string(),
      chave:        z.string().min(1),
      template:     z.string(),
      descricao:    z.string().optional(),
      personaChave: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      const { projetoId, chave, ...rest } = input;
      return prisma.iaMensagemTemplate.upsert({
        where:  { projetoId_chave: { projetoId, chave } },
        create: { projetoId, chave, ...rest, ativo: true },
        update: { ...rest },
      });
    }),

  deleteMensagemTemplate: authProc
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      return prisma.iaMensagemTemplate.delete({ where: { id: input.id } });
    }),

  // ── Deal Anexos (document folder) ────────────────────────────────────────────

  listarAnexosDeal: authProc
    .input(z.object({ dealId: z.string() }))
    .query(async ({ input }) => {
      return prisma.dealAnexo.findMany({
        where: { dealId: input.dealId },
        orderBy: { criadoEm: "desc" },
        select: {
          id: true,
          nomeArquivo: true,
          mimetype: true,
          tamanho: true,
          tipoDocumento: true,
          dadosExtraidos: true,
          criadoEm: true,
        },
      });
    }),

  // ── Gates de Desqualificação SDR ─────────────────────────────────────────────

  listGatesSdr: authProc
    .input(z.object({ projetoId: z.string() }))
    .query(async ({ input }) => {
      return prisma.iaGateSdr.findMany({
        where: { projetoId: input.projetoId },
        orderBy: { ordem: "asc" },
      });
    }),

  toggleGateSdr: authProc
    .input(z.object({ id: z.string(), ativo: z.boolean() }))
    .mutation(async ({ input }) => {
      return prisma.iaGateSdr.update({
        where: { id: input.id },
        data: { ativo: input.ativo },
      });
    }),

  deleteGateSdr: authProc
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      return prisma.iaGateSdr.delete({ where: { id: input.id } });
    }),

  updateGateSdr: authProc
    .input(z.object({ id: z.string(), mensagemLead: z.string(), mesesMin: z.number().int().positive().optional() }))
    .mutation(async ({ input }) => {
      const { id, mensagemLead, mesesMin } = input;
      const current = await prisma.iaGateSdr.findUnique({ where: { id }, select: { condicaoJson: true } });
      const condicaoJson = mesesMin !== undefined
        ? { ...((current?.condicaoJson as Record<string, unknown>) ?? {}), mesesMin }
        : undefined;
      return prisma.iaGateSdr.update({
        where: { id },
        data: { mensagemLead, ...(condicaoJson !== undefined ? { condicaoJson } : {}) },
      });
    }),

  // ── Empresas Bloqueadas SDR ───────────────────────────────────────────────────

  listEmpresasBloqueadas: authProc
    .input(z.object({ projetoId: z.string() }))
    .query(async ({ input }) => {
      return prisma.iaEmpresaBloqueada.findMany({
        where: { projetoId: input.projetoId },
        orderBy: { nome: "asc" },
      });
    }),

  criarEmpresaBloqueada: authProc
    .input(z.object({ projetoId: z.string(), nome: z.string().min(1), motivo: z.string().optional() }))
    .mutation(async ({ input }) => {
      const nomeNorm = input.nome
        .toLowerCase()
        .normalize("NFD").replace(/[̀-ͯ]/g, "")
        .replace(/\b(transportadora|transporte|transportes|logistica|distribuidora|industria|broker|ltda|s\.?a|mei)\b/g, "")
        .replace(/[.\-,]/g, " ").replace(/\s+/g, " ").trim();
      return prisma.iaEmpresaBloqueada.create({
        data: {
          projetoId: input.projetoId,
          nome: input.nome,
          nomeNorm,
          motivo: input.motivo ?? "prescricao_coletiva",
        },
      });
    }),

  toggleEmpresaBloqueada: authProc
    .input(z.object({ id: z.string(), ativo: z.boolean() }))
    .mutation(async ({ input }) => {
      return prisma.iaEmpresaBloqueada.update({
        where: { id: input.id },
        data: { ativo: input.ativo },
      });
    }),

  deleteEmpresaBloqueada: authProc
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      return prisma.iaEmpresaBloqueada.delete({ where: { id: input.id } });
    }),
});
