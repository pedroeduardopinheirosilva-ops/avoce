import { z }                from "zod";
import { TRPCError }        from "@trpc/server";
import { randomBytes }      from "node:crypto";
import { router, authProc } from "./trpc.js";
import { prisma }           from "../db.js";
import { canOperate }       from "./tenant-utils.js";
import { configDoProjeto, conectar, sincronizarIceBreakers, todasPalavras } from "../lib/meta-social.js";
import { lerAutomacoes } from "../lib/meta-automacoes.js";

/**
 * Configuração do Instagram Direct / Messenger por projeto (lib/meta-social.ts).
 * O token da Página nunca volta para a tela — só se ele está preenchido.
 */

const CAMPOS = [
  "ativo", "page_token", "app_secret", "resposta_auto", "palavras", "comentario_resposta", "comentario_publico",
  "ice_breakers", "whatsapp_abertura", "telefone_resposta", "whatsapp_numero",
  "regras", "story_resposta", "story_mencao", "seguir_aviso", "comentario_todos", "automacoes",
] as const;

async function projetoDoUsuario(ctx: any, projetoId: string) {
  const p = await prisma.iaProjeto.findUnique({ where: { id: projetoId }, select: { id: true, empresaId: true } });
  if (!p) throw new TRPCError({ code: "NOT_FOUND", message: "Projeto não encontrado" });
  if (!canOperate(ctx, p.empresaId)) throw new TRPCError({ code: "FORBIDDEN", message: "Projeto não pertence à sua empresa" });
  return p;
}

async function gravar(projetoId: string, chave: string, valor: string) {
  const tipo = chave === "page_token" || chave === "app_secret" ? "senha" : chave === "ativo" ? "booleano" : "texto";
  await prisma.iaProjetoConfig.upsert({
    where: { projetoId_chave: { projetoId, chave: `meta_social_${chave}` } },
    create: { projetoId, chave: `meta_social_${chave}`, valor, tipo, categoria: "meta_social", editavelPainel: false },
    update: { valor },
  });
}

export const metaSocialRouter = router({
  status: authProc
    .input(z.object({ projetoId: z.string() }))
    .query(async ({ input, ctx }) => {
      await projetoDoUsuario(ctx, input.projetoId);
      let cfg = await configDoProjeto(input.projetoId);
      if (!cfg?.verifyToken) {
        await gravar(input.projetoId, "verify_token", randomBytes(12).toString("hex"));
        cfg = await configDoProjeto(input.projetoId);
      }
      const baseUrl = process.env.APP_BASE_URL ?? "https://avoce.capium.com.br";
      const [conversas, ultimos7] = await Promise.all([
        prisma.crmDeal.count({ where: { projetoId: input.projetoId, mensagens: { some: { canal: { in: ["instagram", "messenger"] } } } } }),
        prisma.crmMensagemWhatsapp.count({
          where: { canal: { in: ["instagram", "messenger"] }, direcao: "in", deal: { projetoId: input.projetoId }, enviadaEm: { gte: new Date(Date.now() - 7 * 86_400_000) } },
        }),
      ]);
      return {
        webhookUrl: `${baseUrl}/api/meta/webhook`,
        verifyToken: cfg!.verifyToken,
        ativo: cfg!.ativo,
        temToken: !!cfg!.pageToken,
        temSegredo: !!cfg!.appSecret,
        pageId: cfg!.pageId,
        igId: cfg!.igId,
        respostaAuto: cfg!.respostaAuto,
        palavras: cfg!.palavras.join(", "),
        comentarioResposta: cfg!.comentarioResposta,
        comentarioPublico: cfg!.comentarioPublico,
        iceBreakers: cfg!.iceBreakers,
        whatsappAbertura: cfg!.whatsappAbertura,
        telefoneResposta: cfg!.telefoneResposta,
        whatsappNumero: cfg!.whatsappNumero,
        igUsername: cfg!.igUsername,
        regras: cfg!.regras.map((r) => ({ ...r, palavras: r.palavras.join(", "), posts: r.posts.join("\n") })),
        storyResposta: cfg!.storyResposta,
        storyMencao: cfg!.storyMencao,
        seguirAviso: cfg!.seguirAviso,
        comentarioTodos: cfg!.comentarioTodos,
        automacoes: cfg!.automacoes,
        midiaBase: `${baseUrl}/api/meta/midia/${input.projetoId}/`,
        // Um link por palavra-chave em cada canal: a origem do lead chega pronta (ref / texto).
        links: todasPalavras(cfg!).map((p) => {
          const ref = p.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/[^A-Z0-9]+/g, "_");
          return {
            palavra: p,
            instagram: cfg!.igUsername ? `https://ig.me/m/${cfg!.igUsername}?ref=${ref}` : null,
            messenger: cfg!.pageId ? `https://m.me/${cfg!.pageId}?ref=${ref}` : null,
            whatsapp: cfg!.whatsappNumero ? `https://wa.me/${cfg!.whatsappNumero}?text=${encodeURIComponent(p)}` : null,
          };
        }),
        conversas,
        mensagens7d: ultimos7,
      };
    }),

  salvar: authProc
    .input(z.object({
      projetoId: z.string(),
      ativo: z.boolean().optional(),
      page_token: z.string().optional(),
      app_secret: z.string().optional(),
      resposta_auto: z.string().optional(),
      palavras: z.string().optional(),
      comentario_resposta: z.string().optional(),
      comentario_publico: z.string().optional(),
      ice_breakers: z.array(z.object({ pergunta: z.string().max(80), resposta: z.string() })).max(4).optional(),
      whatsapp_abertura: z.string().optional(),
      telefone_resposta: z.string().optional(),
      whatsapp_numero: z.string().optional(),
      regras: z.array(z.object({
        palavras: z.string(), resposta: z.string(), publico: z.string(), posts: z.string(), seguir: z.boolean(),
      })).max(50).optional(),
      story_resposta: z.string().optional(),
      story_mencao: z.string().optional(),
      seguir_aviso: z.string().optional(),
      comentario_todos: z.string().optional(),
      // Validação de forma em lerAutomacoes (o que não fecha é descartado, não quebra o save).
      automacoes: z.array(z.any()).max(200).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      await projetoDoUsuario(ctx, input.projetoId);
      for (const k of CAMPOS) {
        const v = input[k];
        if (v === undefined) continue;
        // Campo secreto em branco = manter o que está salvo.
        if ((k === "page_token" || k === "app_secret") && !String(v).trim()) continue;
        const valor = k === "automacoes"
          ? JSON.stringify(lerAutomacoes(JSON.stringify(v)))
          : typeof v === "boolean" ? String(v) : Array.isArray(v) ? JSON.stringify(v) : String(v).trim();
        await gravar(input.projetoId, k, valor);
      }
      // Ice breakers moram na Meta: precisa publicar de novo a cada mudança.
      let aviso: string | null = null;
      if (input.ice_breakers) {
        const cfg = await configDoProjeto(input.projetoId);
        if (cfg?.pageToken && cfg.pageId) {
          await sincronizarIceBreakers(cfg).catch((e) => { aviso = `Ice breakers não publicados: ${e?.message ?? e}`; });
        }
      }
      return { ok: true, aviso };
    }),

  /** Converte as respostas antigas (regras, story, 1ª resposta, comentário qualquer) em automações. */
  /** Valida o token, descobre Página + Instagram e assina o webhook da Página. */
  conectar: authProc
    .input(z.object({ projetoId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      await projetoDoUsuario(ctx, input.projetoId);
      const cfg = await configDoProjeto(input.projetoId);
      if (!cfg?.pageToken) throw new TRPCError({ code: "BAD_REQUEST", message: "Cole o token da Página antes de conectar." });
      try {
        const r = await conectar(cfg.pageToken);
        await gravar(input.projetoId, "page_id", r.pageId);
        await gravar(input.projetoId, "ig_id", r.igId);
        await gravar(input.projetoId, "ig_username", r.igUsername);
        const atual = await configDoProjeto(input.projetoId);
        if (atual?.iceBreakers.length) await sincronizarIceBreakers(atual).catch(() => {});
        return r;
      } catch (e: any) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `Meta recusou: ${e?.message ?? e}` });
      }
    }),
});
