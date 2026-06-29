import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { router, authProc } from "./trpc.js";
import { prisma } from "../db.js";
import { assertEmitenteAccess } from "./tenant-utils.js";
import * as metaService from "../services/meta.js";
import * as googleService from "../services/googleAds.js";
import * as deepseekMkt from "../services/deepseekMkt.js";
import * as claudeMkt from "../services/claudeMkt.js";
import * as imageGen from "../services/imageGen.js";

// ─── Criptografia de credenciais ─────────────────────────────────────────────

const CRYPT_KEY = Buffer.from(process.env.CRYPT_KEY_HEX ?? "", "hex");

function encrypt(plaintext: string): string {
  if (!CRYPT_KEY.length) throw new Error("CRYPT_KEY_HEX não configurada");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", CRYPT_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

function decrypt(ciphertext: string): string {
  const buf = Buffer.from(ciphertext, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const encrypted = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", CRYPT_KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function getConfigValor(projetoId: string, chave: string): Promise<string | null> {
  const cfg = await prisma.mktConfig.findUnique({ where: { projetoId_chave: { projetoId, chave } } });
  if (!cfg?.valor) return null;
  return cfg.valorEncrypted ? decrypt(cfg.valor) : cfg.valor;
}

async function getMetaToken(projetoId: string): Promise<string> {
  const token = await getConfigValor(projetoId, "meta_access_token");
  if (!token) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Token Meta não configurado" });
  return token;
}

async function getGoogleCreds(projetoId: string): Promise<googleService.GoogleAdsCredenciais> {
  const [clientId, clientSecret, refreshToken, devToken, customerId] = await Promise.all([
    getConfigValor(projetoId, "google_client_id"),
    getConfigValor(projetoId, "google_client_secret"),
    getConfigValor(projetoId, "google_refresh_token"),
    getConfigValor(projetoId, "google_dev_token"),
    getConfigValor(projetoId, "google_customer_id"),
  ]);
  if (!clientId || !clientSecret || !refreshToken || !devToken || !customerId)
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Credenciais Google Ads incompletas" });
  return { clientId, clientSecret, refreshToken, devToken, customerId };
}

async function getDeepseekKey(projetoId: string): Promise<string> {
  const key = await getConfigValor(projetoId, "deepseek_api_key");
  if (!key) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "API Key DeepSeek não configurada" });
  return key;
}

async function getClaudeKey(projetoId: string): Promise<string> {
  // First try project-level key, then fall back to env
  const key = await getConfigValor(projetoId, "claude_api_key");
  if (key) return key;
  const env = process.env.ANTHROPIC_API_KEY;
  if (env) return env;
  throw new TRPCError({ code: "PRECONDITION_FAILED", message: "API Key Claude (Anthropic) não configurada" });
}

async function gravarLog(
  projetoId: string,
  tipo: string,
  entidadeId: string,
  entidadeTipo: string,
  valorAntes: any,
  valorDepois: any,
  motivoIa: string | null,
  revertivel: boolean,
  ok: boolean,
  erroDetalhe?: string,
): Promise<void> {
  await prisma.mktLogAcao.create({
    data: { projetoId, tipo, entidadeId, entidadeTipo, valorAntes: valorAntes ?? undefined, valorDepois: valorDepois ?? undefined, motivoIa, revertivel, ok, erroDetalhe },
  });
}

// ─── Router ──────────────────────────────────────────────────────────────────

export const marketingAutopilotRouter = router({

  // ── Projetos ──────────────────────────────────────────────────────────────

  listProjetos: authProc
    .input(z.object({ emitenteId: z.string() }))
    .query(({ input, ctx }) => {
      assertEmitenteAccess(ctx, input.emitenteId);
      return prisma.mktProjeto.findMany({
        where: { emitenteId: input.emitenteId },
        orderBy: { criadoEm: "desc" },
      });
    }),

  createProjeto: authProc
    .input(z.object({ emitenteId: z.string(), nome: z.string(), descricao: z.string().optional() }))
    .mutation(({ input, ctx }) => {
      assertEmitenteAccess(ctx, input.emitenteId);
      return prisma.mktProjeto.create({ data: input });
    }),

  updateProjeto: authProc
    .input(z.object({ id: z.string(), nome: z.string().optional(), descricao: z.string().optional(), ativo: z.boolean().optional() }))
    .mutation(async ({ input }) => {
      const { id, ...data } = input;
      return prisma.mktProjeto.update({ where: { id }, data });
    }),

  // ── Configurações (credenciais) ───────────────────────────────────────────

  listConfigs: authProc
    .input(z.object({ projetoId: z.string() }))
    .query(async ({ input }) => {
      const configs = await prisma.mktConfig.findMany({
        where: { projetoId: input.projetoId },
        orderBy: [{ categoria: "asc" }, { chave: "asc" }],
      });
      // Nunca expõe valor de senha — retorna apenas se está configurado
      return configs.map((c) => ({
        ...c,
        valor: c.tipo === "senha" ? (c.valor ? "••••configurado" : null) : c.valor,
      }));
    }),

  upsertConfig: authProc
    .input(z.object({
      projetoId: z.string(),
      chave: z.string(),
      valor: z.string().optional(),
      tipo: z.string().optional(),
      categoria: z.string().optional(),
      descricao: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      const { projetoId, chave, valor, tipo, ...rest } = input;
      const isSenha = tipo === "senha";
      const valorFinal = valor && isSenha && !valor.startsWith("••••") ? encrypt(valor) : valor;
      return prisma.mktConfig.upsert({
        where: { projetoId_chave: { projetoId, chave } },
        create: { projetoId, chave, valor: valorFinal, tipo: tipo ?? "texto", valorEncrypted: isSenha && !!valor, ...rest },
        update: { valor: valorFinal, tipo, valorEncrypted: isSenha && !!valor && !valor?.startsWith("••••"), ...rest },
      });
    }),

  // ── Campanhas ─────────────────────────────────────────────────────────────

  listCampanhas: authProc
    .input(z.object({ projetoId: z.string() }))
    .query(({ input }) =>
      prisma.mktCampanha.findMany({
        where: { projetoId: input.projetoId },
        include: { criativos: true },
        orderBy: { gastoTotal: "desc" },
      }),
    ),

  syncCampanhas: authProc
    .input(z.object({ projetoId: z.string() }))
    .mutation(async ({ input }) => {
      const { projetoId } = input;
      const erros: string[] = [];

      // Meta
      try {
        const token = await getMetaToken(projetoId);
        const adAccountId = await getConfigValor(projetoId, "meta_ad_account_id");
        if (adAccountId) {
          const campanhas = await metaService.listarCampanhas(token, adAccountId);
          for (const c of campanhas) {
            await prisma.mktCampanha.upsert({
              where: { projetoId_idExterno_plataforma: { projetoId, idExterno: c.id, plataforma: "META" } },
              create: {
                projetoId,
                plataforma: "META",
                idExterno: c.id,
                nome: c.name,
                status: c.status === "ACTIVE" ? "ATIVA" : c.status === "PAUSED" ? "PAUSADA" : "ARQUIVADA",
                orcamentoDiario: c.daily_budget ? parseFloat(c.daily_budget) / 100 : null,
                impressoes: parseInt(c.impressions ?? "0"),
                cliques: parseInt(c.clicks ?? "0"),
                gastoTotal: parseFloat(c.spend ?? "0"),
                cpaAtual: c.cpa ? parseFloat(c.cpa) : null,
                roasAtual: c.roas ? parseFloat(c.roas) : null,
                ctrAtual: parseFloat(c.ctr ?? "0"),
                ultimaSincEm: new Date(),
              },
              update: {
                nome: c.name,
                status: c.status === "ACTIVE" ? "ATIVA" : c.status === "PAUSED" ? "PAUSADA" : "ARQUIVADA",
                orcamentoDiario: c.daily_budget ? parseFloat(c.daily_budget) / 100 : null,
                impressoes: parseInt(c.impressions ?? "0"),
                cliques: parseInt(c.clicks ?? "0"),
                gastoTotal: parseFloat(c.spend ?? "0"),
                cpaAtual: c.cpa ? parseFloat(c.cpa) : null,
                roasAtual: c.roas ? parseFloat(c.roas) : null,
                ctrAtual: parseFloat(c.ctr ?? "0"),
                ultimaSincEm: new Date(),
              },
            });
          }
        }
      } catch (e: any) {
        erros.push(`Meta: ${e.message}`);
      }

      // Google
      try {
        const creds = await getGoogleCreds(projetoId);
        const campanhas = await googleService.listarCampanhas(creds);
        for (const c of campanhas) {
          await prisma.mktCampanha.upsert({
            where: { projetoId_idExterno_plataforma: { projetoId, idExterno: c.id, plataforma: "GOOGLE" } },
            create: {
              projetoId,
              plataforma: "GOOGLE",
              idExterno: c.id,
              nome: c.nome,
              status: c.status === "ENABLED" ? "ATIVA" : c.status === "PAUSED" ? "PAUSADA" : "ARQUIVADA",
              orcamentoDiario: c.orcamentoDiario,
              impressoes: c.impressoes,
              cliques: c.cliques,
              gastoTotal: c.gasto,
              cpaAtual: c.cpa,
              roasAtual: c.roas,
              ctrAtual: c.ctr,
              ultimaSincEm: new Date(),
            },
            update: {
              nome: c.nome,
              status: c.status === "ENABLED" ? "ATIVA" : c.status === "PAUSED" ? "PAUSADA" : "ARQUIVADA",
              orcamentoDiario: c.orcamentoDiario,
              impressoes: c.impressoes,
              cliques: c.cliques,
              gastoTotal: c.gasto,
              cpaAtual: c.cpa,
              roasAtual: c.roas,
              ctrAtual: c.ctr,
              ultimaSincEm: new Date(),
            },
          });
        }
      } catch (e: any) {
        erros.push(`Google: ${e.message}`);
      }

      return { ok: erros.length === 0, erros };
    }),

  updateCampanhaKpis: authProc
    .input(z.object({
      id: z.string(),
      cpaMeta: z.number().nullable().optional(),
      roasMeta: z.number().nullable().optional(),
      autonomia: z.enum(["TOTAL", "NOTIFICAR", "SUGERIR"]).optional(),
    }))
    .mutation(({ input }) => {
      const { id, ...data } = input;
      return prisma.mktCampanha.update({ where: { id }, data });
    }),

  pausarCampanha: authProc
    .input(z.object({ id: z.string(), motivo: z.string().optional() }))
    .mutation(async ({ input }) => {
      const campanha = await prisma.mktCampanha.findUniqueOrThrow({ where: { id: input.id } });
      const token = campanha.plataforma === "META" ? await getMetaToken(campanha.projetoId) : null;

      if (campanha.plataforma === "META" && token) {
        await metaService.pausarCampanha(token, campanha.idExterno);
      }

      const anterior = { status: campanha.status };
      const novo = await prisma.mktCampanha.update({ where: { id: input.id }, data: { status: "PAUSADA" } });
      await gravarLog(campanha.projetoId, "campanha_pausada", input.id, "MktCampanha", anterior, { status: "PAUSADA" }, input.motivo ?? null, true, true);
      return novo;
    }),

  ativarCampanha: authProc
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      const campanha = await prisma.mktCampanha.findUniqueOrThrow({ where: { id: input.id } });
      const token = campanha.plataforma === "META" ? await getMetaToken(campanha.projetoId) : null;

      if (campanha.plataforma === "META" && token) {
        await metaService.ativarCampanha(token, campanha.idExterno);
      }

      const anterior = { status: campanha.status };
      const novo = await prisma.mktCampanha.update({ where: { id: input.id }, data: { status: "ATIVA", kpiVioladoCount: 0 } });
      await gravarLog(campanha.projetoId, "campanha_ativada", input.id, "MktCampanha", anterior, { status: "ATIVA" }, null, true, true);
      return novo;
    }),

  // ── DeepSeek — análise de campanhas ──────────────────────────────────────

  analisarComDeepSeek: authProc
    .input(z.object({ projetoId: z.string() }))
    .mutation(async ({ input }) => {
      const { projetoId } = input;
      const apiKey = await getDeepseekKey(projetoId);

      const campanhas = await prisma.mktCampanha.findMany({
        where: { projetoId, status: "ATIVA" },
        include: { criativos: { where: { status: "ATIVO" } } },
      });

      const input_ia = {
        campanhas: campanhas.map((c) => ({
          id: c.id,
          nome: c.nome,
          plataforma: c.plataforma,
          cpaAtual: c.cpaAtual,
          cpaMeta: c.cpaMeta,
          roasAtual: c.roasAtual,
          roasMeta: c.roasMeta,
          orcamentoDiario: c.orcamentoDiario,
          kpiVioladoCount: c.kpiVioladoCount,
          criativos: c.criativos.map((cr) => ({ id: cr.id, nome: cr.nome, ctr: cr.ctr ?? 0, cpc: cr.cpc ?? 0, status: cr.status })),
        })),
      };

      const acoes = await deepseekMkt.analisarCampanhas(apiKey, input_ia);
      const resultados: Array<{ acao: string; ok: boolean; erro?: string }> = [];

      for (const acao of acoes) {
        try {
          if (acao.tipo === "pausar_campanha") {
            const c = campanhas.find((x) => x.id === acao.entidadeId);
            if (c) {
              if (c.autonomia === "TOTAL") {
                const token = c.plataforma === "META" ? await getMetaToken(projetoId) : null;
                if (token) await metaService.pausarCampanha(token, c.idExterno);
                await prisma.mktCampanha.update({ where: { id: c.id }, data: { status: "PAUSADA" } });
              }
              await gravarLog(projetoId, "campanha_pausada", c.id, "MktCampanha", { status: c.status }, { status: "PAUSADA" }, acao.motivo, true, true);
            }
          } else if (acao.tipo === "pausar_criativo") {
            const cr = await prisma.mktCriativo.findUnique({ where: { id: acao.entidadeId }, include: { campanha: true } });
            if (cr) {
              const c = cr.campanha;
              if (c.autonomia === "TOTAL") {
                const token = c.plataforma === "META" ? await getMetaToken(projetoId) : null;
                if (token) await metaService.pausarAnuncio(token, cr.idExterno);
                await prisma.mktCriativo.update({ where: { id: cr.id }, data: { status: "PAUSADO", pausadoPorIa: true, motivoPausa: acao.motivo } });
              }
              await gravarLog(projetoId, "criativo_pausado", cr.id, "MktCriativo", { status: cr.status }, { status: "PAUSADO" }, acao.motivo, true, true);
            }
          } else if (acao.tipo === "alerta") {
            await gravarLog(projetoId, "alerta", acao.entidadeId, acao.entidadeTipo, null, null, acao.motivo, false, true);
          }
          resultados.push({ acao: acao.tipo, ok: true });
        } catch (e: any) {
          await gravarLog(projetoId, acao.tipo, acao.entidadeId, acao.entidadeTipo, null, null, acao.motivo, false, false, e.message);
          resultados.push({ acao: acao.tipo, ok: false, erro: e.message });
        }
      }

      return { acoes, resultados };
    }),

  // ── Claude — análise de campanhas ────────────────────────────────────────

  analisarComClaude: authProc
    .input(z.object({ projetoId: z.string() }))
    .mutation(async ({ input }) => {
      const { projetoId } = input;
      const apiKey = await getClaudeKey(projetoId);

      const campanhas = await prisma.mktCampanha.findMany({
        where: { projetoId, status: "ATIVA" },
        include: { criativos: { where: { status: "ATIVO" } } },
      });

      if (campanhas.length === 0) {
        return { acoes: [], resultados: [], aviso: "Nenhuma campanha ATIVA encontrada para análise" };
      }

      const input_ia: claudeMkt.InputAnaliseCampanhas = {
        campanhas: campanhas.map((c) => ({
          id: c.id,
          nome: c.nome,
          plataforma: c.plataforma,
          cpaAtual: c.cpaAtual,
          cpaMeta: c.cpaMeta,
          roasAtual: c.roasAtual,
          roasMeta: c.roasMeta,
          orcamentoDiario: c.orcamentoDiario,
          kpiVioladoCount: c.kpiVioladoCount,
          criativos: c.criativos.map((cr) => ({ id: cr.id, nome: cr.nome, ctr: cr.ctr ?? 0, cpc: cr.cpc ?? 0, status: cr.status })),
        })),
      };

      const acoes = await claudeMkt.analisarCampanhas(apiKey, input_ia);
      const resultados: Array<{ acao: string; ok: boolean; erro?: string }> = [];

      for (const acao of acoes) {
        try {
          if (acao.tipo === "pausar_campanha") {
            const c = campanhas.find((x) => x.id === acao.entidadeId);
            if (c) {
              if (c.autonomia === "TOTAL") {
                const token = c.plataforma === "META" ? await getMetaToken(projetoId) : null;
                if (token) await metaService.pausarCampanha(token, c.idExterno);
                await prisma.mktCampanha.update({ where: { id: c.id }, data: { status: "PAUSADA" } });
              }
              await gravarLog(projetoId, "campanha_pausada", c.id, "MktCampanha", { status: c.status }, { status: "PAUSADA" }, acao.motivo, true, true);
            }
          } else if (acao.tipo === "pausar_criativo") {
            const cr = await prisma.mktCriativo.findUnique({ where: { id: acao.entidadeId }, include: { campanha: true } });
            if (cr) {
              const c = cr.campanha;
              if (c.autonomia === "TOTAL") {
                const token = c.plataforma === "META" ? await getMetaToken(projetoId) : null;
                if (token) await metaService.pausarAnuncio(token, cr.idExterno);
                await prisma.mktCriativo.update({ where: { id: cr.id }, data: { status: "PAUSADO", pausadoPorIa: true, motivoPausa: acao.motivo } });
              }
              await gravarLog(projetoId, "criativo_pausado", cr.id, "MktCriativo", { status: cr.status }, { status: "PAUSADO" }, acao.motivo, true, true);
            }
          } else if (acao.tipo === "ajustar_orcamento" || acao.tipo === "escalar_orcamento") {
            const c = campanhas.find((x) => x.id === acao.entidadeId);
            if (c && acao.valorNovo) {
              const anterior = { orcamentoDiario: c.orcamentoDiario };
              if (c.autonomia === "TOTAL") {
                if (c.plataforma === "META") {
                  const token = await getMetaToken(projetoId);
                  await metaService.ajustarOrcamento(token, c.idExterno, acao.valorNovo * 100);
                }
                await prisma.mktCampanha.update({ where: { id: c.id }, data: { orcamentoDiario: acao.valorNovo } });
              }
              await gravarLog(projetoId, acao.tipo, c.id, "MktCampanha", anterior, { orcamentoDiario: acao.valorNovo }, acao.motivo, true, true);
            }
          } else if (acao.tipo === "alerta") {
            await gravarLog(projetoId, "alerta", acao.entidadeId, acao.entidadeTipo, null, null, acao.motivo, false, true);
          }
          resultados.push({ acao: acao.tipo, ok: true });
        } catch (e: any) {
          await gravarLog(projetoId, acao.tipo, acao.entidadeId, acao.entidadeTipo, null, null, acao.motivo, false, false, e.message);
          resultados.push({ acao: acao.tipo, ok: false, erro: e.message });
        }
      }

      return { acoes, resultados };
    }),

  // ── Roteiros ──────────────────────────────────────────────────────────────

  listRoteiros: authProc
    .input(z.object({ projetoId: z.string() }))
    .query(({ input }) =>
      prisma.mktRoteiro.findMany({
        where: { projetoId: input.projetoId },
        orderBy: { criadoEm: "desc" },
      }),
    ),

  gerarRoteiro: authProc
    .input(z.object({
      projetoId: z.string(),
      advogadoNome: z.string(),
      areaDireito: z.string(),
      tema: z.string(),
      formato: z.enum(["REEL", "CARROSSEL", "POST", "STORY"]),
      tom: z.string(),
      publicoAlvo: z.string().optional(),
      cta: z.string().optional(),
      observacoes: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      const { projetoId, ...roteiroInput } = input;
      const apiKey = await getDeepseekKey(projetoId);

      const prompt: deepseekMkt.InputRoteiro = {
        ...roteiroInput,
        formato: input.formato,
      };

      const resultado = await deepseekMkt.gerarRoteiro(apiKey, prompt);
      const promptUsado = JSON.stringify(prompt);

      return prisma.mktRoteiro.create({
        data: {
          projetoId,
          ...roteiroInput,
          titulo: resultado.titulo,
          cenas: resultado.cenas as any,
          caption: resultado.caption,
          hashtags: resultado.hashtags,
          dicasGravacao: resultado.dicasGravacao,
          promptUsado,
        },
      });
    }),

  updateRoteiro: authProc
    .input(z.object({
      id: z.string(),
      status: z.enum(["GERADO", "GRAVADO", "EDITADO", "APROVADO"]).optional(),
      titulo: z.string().optional(),
      caption: z.string().optional(),
    }))
    .mutation(({ input }) => {
      const { id, ...data } = input;
      return prisma.mktRoteiro.update({ where: { id }, data });
    }),

  // ── Publicações ───────────────────────────────────────────────────────────

  listPublicacoes: authProc
    .input(z.object({ projetoId: z.string() }))
    .query(({ input }) =>
      prisma.mktPublicacao.findMany({
        where: { projetoId: input.projetoId },
        include: { roteiro: { select: { titulo: true, advogadoNome: true } } },
        orderBy: { agendadoPara: "asc" },
      }),
    ),

  createPublicacao: authProc
    .input(z.object({
      projetoId: z.string(),
      roteiroId: z.string().optional(),
      titulo: z.string(),
      legenda: z.string(),
      hashtags: z.array(z.string()).optional(),
      urlMidia: z.string().optional(),
      agendadoPara: z.string().optional(),
    }))
    .mutation(({ input }) => {
      const { agendadoPara, ...rest } = input;
      return prisma.mktPublicacao.create({
        data: {
          ...rest,
          hashtags: rest.hashtags ?? [],
          agendadoPara: agendadoPara ? new Date(agendadoPara) : null,
          status: agendadoPara ? "AGENDADO" : "RASCUNHO",
        },
      });
    }),

  aprovarPublicacao: authProc
    .input(z.object({ id: z.string(), agendadoPara: z.string() }))
    .mutation(({ input }) =>
      prisma.mktPublicacao.update({
        where: { id: input.id },
        data: {
          status: "AGENDADO",
          agendadoPara: new Date(input.agendadoPara),
          aprovadoEm: new Date(),
        },
      }),
    ),

  // ── Geração de imagem ────────────────────────────────────────────────────

  gerarImagem: authProc
    .input(z.object({
      projetoId: z.string(),
      briefing: z.string(),
      provider: z.enum(["dalle3", "stability"]).optional(),
    }))
    .mutation(async ({ input }) => {
      const providerConfig = (await getConfigValor(input.projetoId, "image_provider")) ?? "dalle3";
      const provider = (input.provider ?? providerConfig) as imageGen.ImageProvider;
      const apiKey = await getConfigValor(input.projetoId, "image_api_key");
      if (!apiKey) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "API Key de imagem não configurada" });
      return imageGen.gerarImagem(apiKey, provider, input.briefing);
    }),

  // ── Log de ações ─────────────────────────────────────────────────────────

  listLogs: authProc
    .input(z.object({
      projetoId: z.string(),
      tipo: z.string().optional(),
      limit: z.number().default(50),
      offset: z.number().default(0),
    }))
    .query(({ input }) =>
      prisma.mktLogAcao.findMany({
        where: {
          projetoId: input.projetoId,
          ...(input.tipo ? { tipo: input.tipo } : {}),
        },
        orderBy: { criadoEm: "desc" },
        take: input.limit,
        skip: input.offset,
      }),
    ),

  reverterAcao: authProc
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      const log = await prisma.mktLogAcao.findUniqueOrThrow({ where: { id: input.id } });

      if (!log.revertivel) throw new TRPCError({ code: "BAD_REQUEST", message: "Esta ação não é reversível" });
      if (log.revertido) throw new TRPCError({ code: "BAD_REQUEST", message: "Ação já foi revertida" });

      const antes = log.valorAntes as any;
      if (!antes) throw new TRPCError({ code: "BAD_REQUEST", message: "Sem estado anterior para restaurar" });

      if (log.entidadeTipo === "MktCampanha") {
        await prisma.mktCampanha.update({ where: { id: log.entidadeId }, data: antes });
      } else if (log.entidadeTipo === "MktCriativo") {
        await prisma.mktCriativo.update({ where: { id: log.entidadeId }, data: antes });
      }

      return prisma.mktLogAcao.update({
        where: { id: input.id },
        data: { revertido: true, revertidoEm: new Date() },
      });
    }),

  // ── Status de tokens ─────────────────────────────────────────────────────

  getTokenStatus: authProc
    .input(z.object({ projetoId: z.string() }))
    .query(async ({ input }) => {
      const expiracaoStr = await getConfigValor(input.projetoId, "meta_token_expira");
      let metaDiasRestantes: number | null = null;
      if (expiracaoStr) {
        const expira = new Date(expiracaoStr);
        metaDiasRestantes = Math.floor((expira.getTime() - Date.now()) / 86_400_000);
      }
      return { metaDiasRestantes };
    }),
});
