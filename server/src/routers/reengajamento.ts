import { z } from "zod";
import { router, authProc } from "./trpc.js";
import { prisma } from "../db.js";
import Anthropic from "@anthropic-ai/sdk";

// ── Supabase fetch helper ─────────────────────────────────────────────────────

async function sbFetch<T>(token: string, baseUrl: string, table: string, orderCol = "id"): Promise<T[]> {
  const all: T[] = [];
  let offset = 0;
  const limit = 1000;
  while (true) {
    const url = `${baseUrl}/rest/v1/${table}?select=*&order=${orderCol}.asc&limit=${limit}&offset=${offset}`;
    const res = await fetch(url, {
      headers: { apikey: token, Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`Supabase ${table}: HTTP ${res.status}`);
    const batch = await res.json() as T[];
    all.push(...batch);
    if (batch.length < limit) break;
    offset += limit;
  }
  return all;
}

function normBr(p: string | number): string {
  let s = String(p).replace(/\D/g, "");
  if (s.startsWith("55") && s.length > 11) s = s.slice(2);
  if (s.length === 10) s = s.slice(0, 2) + "9" + s.slice(2);
  return s.length >= 11 ? s.slice(-11) : s;
}

function waFull(p: string | number): string {
  const s = normBr(p);
  return s.startsWith("55") ? s : "55" + s;
}

function parseEmp(raw: any): Record<string, any> {
  if (!raw) return {};
  if (typeof raw === "string") { try { return JSON.parse(raw); } catch { return {}; } }
  return raw as Record<string, any>;
}

function etapaFromData(er: Record<string, any>, ea: Record<string, any>, temAgend: boolean): string {
  if (temAgend) return "reeng_agendamento";
  const agendar = er.agendar_recente || er.agendar || ea.agendar_anterior;
  if (agendar) return "reeng_qualificado";
  const funcao  = String(er.funcao || er["função"] || "").toLowerCase();
  const vinculo = String(er.vinculo || "").toLowerCase();
  // Confirmou carreteiro CLT = tem função de motorista/carreteiro E vínculo empregado/CLT
  const isCarreteiro = funcao.includes("motorista") || funcao.includes("carreteiro") || funcao.includes("caminhoneiro");
  const isClt = vinculo.includes("empregado") || vinculo.includes("clt") || vinculo.includes("carteira") || vinculo.includes("registrado");
  if (isCarreteiro && isClt) return "reeng_carreteiro";
  return "reeng_sem_resposta";
}

const PIPELINE_SEED = {
  nome: "Bot RAP — Reengajamento",
  tipo: "comercial" as const,
  cor: "#f97316",
  stages: [
    { chave: "reeng_sem_resposta",  nome: "Frio / Sem Qualificação",            ordem: 0, cor: "#9ca3af", ehEntrada: true },
    { chave: "reeng_carreteiro",    nome: "✅ Confirmou ser Carreteiro CLT",     ordem: 1, cor: "#3b82f6" },
    { chave: "reeng_qualificado",   nome: "🎯 Qualificado — Indicou Agendar",   ordem: 2, cor: "#8b5cf6" },
    { chave: "reeng_agendamento",   nome: "📅 Tinha Agendamento Original",       ordem: 3, cor: "#10b981", requerAcaoHumana: true },
  ],
};

// ── Pipeline Reengajamento RAP (novo funil Dra. Daniela) ─────────────────────

const RAP_REENG_STAGES = [
  { chave: "reeng_importado",    nome: "📥 Importado",              ordem: 0, cor: "#6b7280", ehEntrada: true },
  { chave: "reeng_msg_enviada",  nome: "📨 Mensagem enviada",       ordem: 1, cor: "#3b82f6" },
  { chave: "reeng_respondido",   nome: "💬 Em contato",             ordem: 2, cor: "#8b5cf6" },
  { chave: "reeng_vinculo",      nome: "🔍 Coletando vínculo",      ordem: 3, cor: "#f59e0b" },
  { chave: "reeng_advogado",     nome: "👩‍⚖️ Dra. Daniela",         ordem: 4, cor: "#10b981" },
  { chave: "reeng_parecer",      nome: "📋 Parecer emitido",        ordem: 5, cor: "#6366f1" },
  { chave: "reeng_fechado",      nome: "✅ Fechado",                ordem: 6, cor: "#059669", ehGanho: true },
  { chave: "reeng_perdido",      nome: "❌ Perdido",                ordem: 7, cor: "#dc2626", ehEncerramento: true },
];

const RAP_FASES_FUNIL: { chave: string; personaChave: string; nome: string }[] = [
  { chave: "reeng_importado",  personaChave: "assistente", nome: "Importado" },
  { chave: "reeng_msg_enviada", personaChave: "assistente", nome: "Mensagem enviada" },
  { chave: "reeng_respondido", personaChave: "assistente", nome: "Em contato" },
  { chave: "reeng_vinculo",    personaChave: "assistente", nome: "Coletando vínculo" },
  { chave: "reeng_advogado",   personaChave: "advogado",   nome: "Dra. Daniela" },
  { chave: "reeng_parecer",    personaChave: "advogado",   nome: "Parecer emitido" },
];

const RAP_REENG_REGRAS: { origem: string; destino: string; condicao: string; acao?: string }[] = [
  { origem: "reeng_msg_enviada", destino: "reeng_respondido", condicao: "cliente_respondeu" },
  { origem: "reeng_respondido",  destino: "reeng_vinculo",    condicao: "qualificacao_completa" },
  { origem: "reeng_vinculo",     destino: "reeng_advogado",   condicao: "qualificacao_completa", acao: "trocar_persona:advogado" },
  { origem: "reeng_advogado",    destino: "reeng_parecer",    condicao: "interesse_confirmado" },
];

/** Garante que o pipeline Reengajamento RAP existe com stages, fases e regras */
async function ensureReengPipeline(projetoId: string): Promise<{
  pipeline: any;
  stageMap: Map<string, string>;
}> {
  // 1. Pipeline + stages
  let pipeline = await prisma.crmPipeline.findFirst({
    where: { nome: "Reengajamento RAP" },
    include: { stages: true },
  });

  if (!pipeline) {
    pipeline = await prisma.crmPipeline.create({
      data: { nome: "Reengajamento RAP", tipo: "comercial", cor: "#6b7280", ordem: 99 },
      include: { stages: true },
    });
  }

  const stageMap = new Map<string, string>();
  for (const s of (pipeline as any).stages) stageMap.set(s.chave, s.id);
  for (const sd of RAP_REENG_STAGES) {
    if (!stageMap.has(sd.chave)) {
      const created = await prisma.crmStage.create({
        data: {
          pipelineId: (pipeline as any).id,
          chave: sd.chave,
          nome: sd.nome,
          ordem: sd.ordem,
          cor: sd.cor,
          ehEntrada: (sd as any).ehEntrada ?? false,
          ehGanho: (sd as any).ehGanho ?? false,
          ehEncerramento: (sd as any).ehEncerramento ?? false,
        },
      });
      stageMap.set(sd.chave, created.id);
    }
  }

  // 2. IaFaseFunil — mapear estágios → personas
  for (const f of RAP_FASES_FUNIL) {
    const exists = await prisma.iaFaseFunil.findFirst({
      where: { projetoId, chave: f.chave },
    });
    if (!exists) {
      await prisma.iaFaseFunil.create({
        data: {
          projetoId,
          pipelineId: (pipeline as any).id,
          chave: f.chave,
          nomeExibicao: f.nome,
          personaChave: f.personaChave,
          pipelineTipo: "comercial",
          ordem: RAP_REENG_STAGES.find(s => s.chave === f.chave)?.ordem ?? 99,
        },
      });
    }
  }

  // 3. IaRegraTransicao
  for (const r of RAP_REENG_REGRAS) {
    const exists = await prisma.iaRegraTransicao.findFirst({
      where: {
        projetoId,
        stageOrigemChave: r.origem,
        stageDestinoChave: r.destino,
        condicao: r.condicao,
      },
    });
    if (!exists) {
      await prisma.iaRegraTransicao.create({
        data: {
          projetoId,
          stageOrigemChave: r.origem,
          stageDestinoChave: r.destino,
          condicao: r.condicao,
          acaoAdicional: r.acao,
          ordem: RAP_REENG_REGRAS.indexOf(r),
        },
      });
    }
  }

  return { pipeline, stageMap };
}

/** Mapeia segmento do JSON para estágio inicial do funil */
function mapSegmentToStage(segmento: number | null): { stage: string; persona: string } {
  if (!segmento || segmento <= 2) return { stage: "reeng_importado", persona: "assistente" };
  if (segmento === 3) return { stage: "reeng_respondido", persona: "assistente" };
  if (segmento === 4) return { stage: "reeng_vinculo", persona: "assistente" };
  if (segmento === 5) return { stage: "reeng_advogado", persona: "advogado" };
  if (segmento === 6) return { stage: "reeng_respondido", persona: "assistente" };
  return { stage: "reeng_importado", persona: "assistente" };
}

export const reengajamentoRouter = router({

  listar: authProc.query(async () => {
    return prisma.crmCampanhaReengajamento.findMany({
      orderBy: { criadoEm: "desc" },
      include: { projeto: { select: { id: true, nome: true } } },
    });
  }),

  criar: authProc
    .input(z.object({
      nome: z.string().min(1),
      projetoId: z.string().optional(),
      pipelineId: z.string().optional(),
      stageIds: z.array(z.string()).min(1),
      diasSemContato: z.number().int().min(1).default(7),
      mensagem: z.string().min(1),
    }))
    .mutation(async ({ input }) => {
      return prisma.crmCampanhaReengajamento.create({ data: input });
    }),

  atualizar: authProc
    .input(z.object({
      id: z.string(),
      nome: z.string().min(1).optional(),
      stageIds: z.array(z.string()).optional(),
      diasSemContato: z.number().int().min(1).optional(),
      mensagem: z.string().min(1).optional(),
      ativa: z.boolean().optional(),
    }))
    .mutation(async ({ input }) => {
      const { id, ...data } = input;
      return prisma.crmCampanhaReengajamento.update({ where: { id }, data });
    }),

  deletar: authProc
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      return prisma.crmCampanhaReengajamento.delete({ where: { id: input.id } });
    }),

  // Preview: mostra quantos deals seriam afetados agora
  preview: authProc
    .input(z.object({ id: z.string() }))
    .query(async ({ input }) => {
      const campanha = await prisma.crmCampanhaReengajamento.findUniqueOrThrow({ where: { id: input.id } });
      const corte = new Date(Date.now() - campanha.diasSemContato * 24 * 60 * 60 * 1000);
      const deals = await prisma.crmDeal.findMany({
        where: {
          stageId: { in: campanha.stageIds },
          status: "aberto",
          iaAtiva: true,
          OR: [
            { ultimoContatoEm: { lte: corte } },
            { ultimoContatoEm: null },
          ],
        },
        include: { contato: true },
      });
      return {
        total: deals.length,
        deals: deals.slice(0, 10).map(d => ({
          id: d.id,
          titulo: d.titulo,
          contato: d.contato?.nome,
          whatsapp: d.contato?.whatsapp,
          ultimoContato: d.ultimoContatoEm,
        })),
      };
    }),

  // Disparo manual
  disparar: authProc
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      const campanha = await prisma.crmCampanhaReengajamento.findUniqueOrThrow({
        where: { id: input.id },
        include: { projeto: { include: { configs: true } } },
      });

      if (!campanha.projetoId || !campanha.projeto) {
        return { ok: false, error: "Campanha sem projeto IA vinculado" };
      }

      const configs = campanha.projeto.configs;
      const evolutionUrl = configs.find(c => c.chave === "evolution_url")?.valor;
      const evolutionApiKey = configs.find(c => c.chave === "evolution_api_key")?.valor;
      const evolutionInstance = campanha.projeto.whatsappInstancia;

      if (!evolutionUrl || !evolutionApiKey || !evolutionInstance) {
        return { ok: false, error: "Evolution API não configurada no projeto" };
      }

      const corte = new Date(Date.now() - campanha.diasSemContato * 24 * 60 * 60 * 1000);
      const deals = await prisma.crmDeal.findMany({
        where: {
          stageId: { in: campanha.stageIds },
          status: "aberto",
          OR: [
            { ultimoContatoEm: { lte: corte } },
            { ultimoContatoEm: null },
          ],
        },
        include: { contato: true },
      });

      let enviados = 0;
      const erros: string[] = [];

      for (const deal of deals) {
        const phone = deal.contato?.whatsapp;
        if (!phone) continue;

        try {
          const phoneNum = phone.replace(/\D/g, "");
          await fetch(`${evolutionUrl}/message/sendText/${evolutionInstance}`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "apikey": evolutionApiKey },
            body: JSON.stringify({
              number: phoneNum,
              text: campanha.mensagem.replace("{{nome}}", deal.contato?.nome ?? ""),
            }),
          });

          await prisma.crmDeal.update({
            where: { id: deal.id },
            data: { ultimoContatoEm: new Date() },
          });

          await prisma.crmMensagemWhatsapp.create({
            data: {
              dealId: deal.id,
              contatoId: deal.contatoId ?? undefined,
              direcao: "out",
              conteudo: campanha.mensagem,
              tipo: "text",
            },
          });

          enviados++;
        } catch (e: any) {
          erros.push(`Deal ${deal.id}: ${e.message}`);
        }
      }

      await prisma.crmCampanhaReengajamento.update({
        where: { id: campanha.id },
        data: {
          ultimoDisparo: new Date(),
          totalEnviados: { increment: enviados },
        },
      });

      return { ok: true, enviados, erros };
    }),

  // ── Importar do bot RAP (Supabase) ────────────────────────────────────────

  importarBot: authProc
    .input(z.object({
      supabaseUrl: z.string().url(),
      supabaseToken: z.string().min(10),
      overwrite: z.boolean().default(false),
      apenasQualificados: z.boolean().default(false),
    }))
    .mutation(async ({ input }) => {
      const { supabaseUrl, supabaseToken } = input;
      const log: string[] = [];

      // 1. Buscar dados do Supabase em paralelo
      log.push("Buscando dados do Supabase...");
      const [leads2Raw, agendRaw, chat1Raw, chat2Raw] = await Promise.all([
        sbFetch<any>(supabaseToken, supabaseUrl, "leads_2", "phone"),
        sbFetch<any>(supabaseToken, supabaseUrl, "agendamentos", "phone"),
        sbFetch<any>(supabaseToken, supabaseUrl, "rap_chat", "id"),
        sbFetch<any>(supabaseToken, supabaseUrl, "rap_chat_2", "id"),
      ]);
      log.push(`Supabase: ${leads2Raw.length} leads qualificados, ${agendRaw.length} agendamentos, ${chat1Raw.length + chat2Raw.length} mensagens`);

      // 2. Índices em memória
      const leads2Map = new Map<string, any>(leads2Raw.map((l: any) => [normBr(l.phone), l]));
      const agendMap  = new Map<string, any>(agendRaw.map((a: any) => [normBr(a.phone), a]));

      // Conversas agrupadas por phone
      const chatByPhone = new Map<string, any[]>();
      for (const row of [...chat1Raw, ...chat2Raw]) {
        const ph = normBr(row.phone);
        if (!chatByPhone.has(ph)) chatByPhone.set(ph, []);
        chatByPhone.get(ph)!.push(row);
      }
      for (const [ph, msgs] of chatByPhone) {
        msgs.sort((a, b) => (a.date || "").localeCompare(b.date || ""));
        chatByPhone.set(ph, msgs);
      }

      // Todos os phones únicos que interagiram
      const allPhones = [...chatByPhone.keys()];
      const filteredPhones = input.apenasQualificados
        ? allPhones.filter(ph => leads2Map.has(ph))
        : allPhones;

      log.push(`Total contatos únicos a importar: ${filteredPhones.length}`);

      // 3. Garantir pipeline + stages
      let pipeline = await prisma.crmPipeline.findFirst({
        where: { nome: PIPELINE_SEED.nome },
        include: { stages: true },
      });
      if (!pipeline) {
        pipeline = await prisma.crmPipeline.create({
          data: {
            nome: PIPELINE_SEED.nome,
            tipo: PIPELINE_SEED.tipo,
            cor: PIPELINE_SEED.cor,
            ordem: 99,
          },
          include: { stages: true },
        }) as any;
        log.push(`Pipeline criado: ${PIPELINE_SEED.nome}`);
      }
      // Garantir stages
      const stageMap = new Map<string, string>(); // chave → id
      for (const s of (pipeline as any).stages) stageMap.set(s.chave, s.id);
      for (const sd of PIPELINE_SEED.stages) {
        if (!stageMap.has(sd.chave)) {
          const created = await prisma.crmStage.create({
            data: {
              pipelineId: (pipeline as any).id,
              chave: sd.chave,
              nome: sd.nome,
              ordem: sd.ordem,
              cor: sd.cor,
              ehEntrada: (sd as any).ehEntrada ?? false,
              requerAcaoHumana: (sd as any).requerAcaoHumana ?? false,
            },
          });
          stageMap.set(sd.chave, created.id);
          log.push(`Stage criado: ${sd.nome}`);
        }
      }

      // 4. Carregar contatos existentes para matching por whatsapp
      const existingContatos = await prisma.crmContato.findMany({
        select: { id: true, whatsapp: true, telefone: true },
      });
      const contatoByPhone = new Map<string, string>(); // normBr(phone) → contatoId
      for (const c of existingContatos) {
        if (c.whatsapp) contatoByPhone.set(normBr(c.whatsapp), c.id);
        if (c.telefone) contatoByPhone.set(normBr(c.telefone), c.id);
      }

      // 5. Importar contatos/deals
      let contatosCriados = 0, contatosVinculados = 0;
      let dealsCriados = 0, dealsAtualizados = 0;
      let notasCriadas = 0;

      for (const ph of filteredPhones) {
        const leadData = leads2Map.get(ph);
        const agendData = agendMap.get(ph);
        const msgs      = chatByPhone.get(ph) ?? [];

        const er = parseEmp(leadData?.emprego_recente);
        const ea = parseEmp(leadData?.emprego_anterior);
        const temAgend = !!agendData;
        const etapaChave = etapaFromData(er, ea, temAgend);
        const stageId = stageMap.get(etapaChave) ?? stageMap.get("reeng_sem_resposta")!;

        const nome   = leadData?.name || agendData?.name || `Lead ${ph}`;
        const cidade = leadData?.cidade ?? null;
        const waNum  = waFull(ph);

        // Contato — vincular existente ou criar novo
        let contatoId = contatoByPhone.get(ph);
        if (!contatoId) {
          const c = await prisma.crmContato.create({
            data: { nome, whatsapp: waNum, cidade: cidade ?? undefined },
          });
          contatoId = c.id;
          contatoByPhone.set(ph, contatoId);
          contatosCriados++;
        } else {
          contatosVinculados++;
          if (input.overwrite) {
            await prisma.crmContato.update({
              where: { id: contatoId },
              data: {
                ...(nome !== `Lead ${ph}` ? { nome } : {}),
                ...(cidade ? { cidade } : {}),
              },
            });
          }
        }

        // Campos custom do emprego
        const camposCustom: Record<string, string> = {};
        const empFields: [string, any][] = [
          ["Função", er.funcao || er["função"]],
          ["Vínculo", er.vinculo],
          ["Empresa", er.empresa],
          ["Tempo", er.tempo],
          ["Frota", er.frota],
          ["Horas extras", er.horas_extras],
          ["Pagamento fora da folha", er.pagamento_fora],
          ["Motivo saída", er.saida || er["saída"]],
          ["Injustiça relatada", er.injustica || er["injustiça"]],
          ["Emp. anterior", ea.funcao || ea["função"]],
          ["Empresa anterior", ea.empresa],
          ["Ação trabalhista anterior", ea.acao_trabalhista],
        ];
        const SKIP_VALUES = new Set(["não","nao","","none","false","não se aplica","não teve","null","undefined"]);
        for (const [k, raw] of empFields) {
          if (raw == null) continue;
          const v = String(raw).trim();
          if (v && !SKIP_VALUES.has(v.toLowerCase())) {
            camposCustom[k] = v;
          }
        }

        // Deal — verificar se já existe neste pipeline
        const existingDeal = await prisma.crmDeal.findFirst({
          where: { contatoId, pipelineId: (pipeline as any).id },
        });

        let dealId: string;
        if (existingDeal) {
          dealId = existingDeal.id;
          dealsAtualizados++;
          if (input.overwrite) {
            await prisma.crmDeal.update({
              where: { id: dealId },
              data: { stageId, ...(Object.keys(camposCustom).length ? { camposCustom } : {}) },
            });
          }
        } else {
          const deal = await prisma.crmDeal.create({
            data: {
              titulo:     `${nome} — Reengajamento`,
              pipelineId: (pipeline as any).id,
              stageId,
              contatoId,
              status:     "aberto",
              fonteLead:  "Bot RAP",
              ...(Object.keys(camposCustom).length ? { camposCustom } : {}),
            },
          });
          dealId = deal.id;
          await prisma.crmDealStageLog.create({
            data: { dealId, stageNovoId: stageId },
          });
          dealsCriados++;
        }

        // Nota de conversa (primeiras 30 trocas)
        if (msgs.length > 0) {
          const linhas = msgs.slice(0, 30).flatMap((m: any) => {
            const c = (m.msg_cliente || "").trim();
            const a = (m.msg_ai || "").trim();
            const data = (m.date || "").slice(0, 10);
            const parts: string[] = [];
            if (c.length > 1) parts.push(`[${data}] Lead: ${c.slice(0, 300)}`);
            if (a.length > 1) parts.push(`[${data}] Bot: ${a.slice(0, 300)}`);
            return parts;
          });
          const conteudo = `[Bot RAP — ${msgs.length} msgs | ${msgs[0]?.date?.slice(0,10)} → ${msgs[msgs.length-1]?.date?.slice(0,10)}]\n\n` + linhas.join("\n");
          const exists = await prisma.crmNota.findFirst({
            where: { dealId, conteudo: { startsWith: "[Bot RAP" } },
          });
          if (!exists) {
            await prisma.crmNota.create({ data: { dealId, conteudo } });
            notasCriadas++;
          } else if (input.overwrite) {
            await prisma.crmNota.update({ where: { id: exists.id }, data: { conteudo } });
          }
        }
      }

      log.push(`Contatos: ${contatosCriados} criados, ${contatosVinculados} vinculados a existentes`);
      log.push(`Deals: ${dealsCriados} criados, ${dealsAtualizados} já existiam`);
      log.push(`Notas de conversa: ${notasCriadas} criadas`);

      return { ok: true, log };
    }),

  // ── Análise IA em batch dos leads Bot RAP ─────────────────────────────────

  progressoAnalise: authProc.query(async () => {
    const pipeline = await prisma.crmPipeline.findFirst({ where: { nome: "Bot RAP — Reengajamento" } });
    if (!pipeline) return { total: 0, analisados: 0, pendentes: 0, excluidos: 0 };

    const rows = await prisma.$queryRaw<{ total: bigint; analisados: bigint; excluidos: bigint }[]>`
      WITH outros_funis AS (
        SELECT DISTINCT "contatoId"
        FROM "CrmDeal"
        WHERE "pipelineId" != ${pipeline.id}
          AND status = 'aberto'
          AND "contatoId" IS NOT NULL
      )
      SELECT
        COUNT(*) FILTER (WHERE d."contatoId" NOT IN (SELECT "contatoId" FROM outros_funis)) AS total,
        COUNT(*) FILTER (
          WHERE d."contatoId" NOT IN (SELECT "contatoId" FROM outros_funis)
          AND d."camposCustom" ? 'ia_analisado_em'
        ) AS analisados,
        COUNT(*) FILTER (WHERE d."contatoId" IN (SELECT "contatoId" FROM outros_funis)) AS excluidos
      FROM "CrmDeal" d
      WHERE d."pipelineId" = ${pipeline.id} AND d.status = 'aberto'
    `;

    const r = rows[0];
    const total     = Number(r.total);
    const analisados = Number(r.analisados);
    const excluidos  = Number(r.excluidos);
    return { total, analisados, pendentes: total - analisados, excluidos };
  }),

  analisarLeadsBot: authProc
    .input(z.object({
      projetoId: z.string(),
      batchSize: z.number().int().min(1).max(50).default(20),
    }))
    .mutation(async ({ input }) => {
      // 1. Buscar API key do Claude
      const cfg = await prisma.iaProjetoConfig.findFirst({
        where: { projetoId: input.projetoId, chave: "anthropic_api_key" },
      });
      const apiKey = cfg?.valor;
      if (!apiKey) throw new Error("anthropic_api_key não configurada no projeto IA");

      const anthropic = new Anthropic({ apiKey });

      // 2. Pipeline Bot RAP
      const pipeline = await prisma.crmPipeline.findFirst({
        where: { nome: "Bot RAP — Reengajamento" },
        include: { stages: true },
      });
      if (!pipeline) throw new Error("Pipeline 'Bot RAP — Reengajamento' não encontrado. Importe primeiro.");

      const stageMap = new Map<string, string>(pipeline.stages.map((s: any) => [s.chave, s.id]));

      // 3. Contatos já ativos em outros funis — excluir
      const contatosOutrosFunis = await prisma.crmDeal.findMany({
        where: { pipelineId: { not: pipeline.id }, status: "aberto", contatoId: { not: null } },
        select: { contatoId: true },
        distinct: ["contatoId"],
      });
      const idsExcluidos = contatosOutrosFunis.map(d => d.contatoId!);

      // 4. Buscar IDs dos deals ainda não analisados via SQL (JSON path filter confiável)
      const pendingIds = await prisma.$queryRaw<{ id: string }[]>`
        SELECT d.id FROM "CrmDeal" d
        WHERE d."pipelineId" = ${pipeline.id}
          AND d.status = 'aberto'
          AND (d."camposCustom" IS NULL OR NOT (d."camposCustom" ? 'ia_analisado_em'))
          AND (
            d."contatoId" IS NULL
            OR d."contatoId" NOT IN (
              SELECT DISTINCT "contatoId" FROM "CrmDeal"
              WHERE "pipelineId" != ${pipeline.id}
                AND status = 'aberto'
                AND "contatoId" IS NOT NULL
            )
          )
        ORDER BY d."criadoEm" ASC
        LIMIT ${input.batchSize}
      `;

      if (pendingIds.length === 0) return { ok: true, processados: 0, msg: "Todos os leads elegíveis já foram analisados." };

      const deals = await prisma.crmDeal.findMany({
        where: { id: { in: pendingIds.map(r => r.id) } },
        include: {
          contato: { select: { nome: true, whatsapp: true } },
          notas: { where: { conteudo: { startsWith: "[Bot RAP" } }, take: 1 },
        },
      });

      const PROMPT_SISTEMA = `Você é um analista comercial especializado em reativação de leads para escritório de advocacia trabalhista focado em motoristas carreteiros.

Analise a conversa do lead e retorne um JSON com a seguinte estrutura EXATA (sem texto adicional):
{
  "tom": "receptivo" | "frio" | "desconfiado" | "sem_resposta",
  "nivel": "confirmado_carreteiro" | "dados_parciais" | "interesse_demonstrado" | "sem_qualificacao",
  "objecoes": ["array de objeções identificadas, pode ser vazio"],
  "angulo": "1-2 frases sobre o melhor ângulo de reativação para este lead específico",
  "mensagem": "Mensagem de reativação personalizada de até 3 linhas para WhatsApp. Deve ser natural, humana, sem linguagem de bot.",
  "stage": "reeng_carreteiro" | "reeng_qualificado" | "reeng_agendamento" | "reeng_sem_resposta",
  "persona": "advogado" | "assistente"
}

REGRAS DE CLASSIFICAÇÃO:
- stage "reeng_carreteiro" + persona "advogado": lead confirmou ser motorista CLT, tem dados de emprego — Dra. Daniela pode fechar
- stage "reeng_agendamento" + persona "advogado": tinha agendamento marcado — follow-up urgente da Dra. Daniela
- stage "reeng_qualificado" + persona "assistente": conversou, demonstrou interesse mas não qualificou completamente — Ana continua qualificação
- stage "reeng_sem_resposta" + persona "assistente": pouco ou nenhum engajamento — Ana faz abertura fria

CONTEXTO DO ESCRITÓRIO: Pinheiro Silva / RAP Advogados — direitos trabalhistas de motoristas carreteiros na Bahia. Honorários de êxito, sem custo antecipado.`;

      let processados = 0;
      let erros = 0;

      // Processar em paralelo com limite de concorrência
      const CONCORRENCIA = 5;
      for (let i = 0; i < deals.length; i += CONCORRENCIA) {
        const lote = deals.slice(i, i + CONCORRENCIA);

        await Promise.all(lote.map(async (deal) => {
          const nome = deal.contato?.nome ?? deal.titulo;
          const nota = deal.notas[0]?.conteudo ?? "";
          const camposExistentes = (deal.camposCustom as Record<string, any>) ?? {};

          // Montar contexto de emprego do lead
          const empCtx = Object.entries(camposExistentes)
            .filter(([k]) => !k.startsWith("ia_"))
            .map(([k, v]) => `${k}: ${v}`)
            .join("\n") || "Sem dados de emprego registrados.";

          const userMsg = `LEAD: ${nome}
DADOS DE EMPREGO IDENTIFICADOS:
${empCtx}

HISTÓRICO DA CONVERSA (bot anterior):
${nota.slice(0, 2000) || "Sem histórico de conversa disponível."}`;

          try {
            const resp = await anthropic.messages.create({
              model: "claude-haiku-4-5-20251001",
              max_tokens: 512,
              system: PROMPT_SISTEMA,
              messages: [{ role: "user", content: userMsg }],
            });

            const rawText = resp.content[0]?.type === "text" ? resp.content[0].text.trim() : "";
            const jsonMatch = rawText.match(/\{[\s\S]*\}/);
            if (!jsonMatch) throw new Error("Resposta Claude não continha JSON");

            const analise = JSON.parse(jsonMatch[0]);

            // Determinar novo stage
            const stageChave = analise.stage ?? "reeng_sem_resposta";
            const novoStageId = stageMap.get(stageChave) ?? stageMap.get("reeng_sem_resposta");

            // Atualizar deal
            await prisma.crmDeal.update({
              where: { id: deal.id },
              data: {
                stageId: novoStageId ?? deal.stageId,
                iaStageChave: stageChave,
                iaPersonaChave: analise.persona ?? "assistente",
                projetoId: input.projetoId,
                iaAtiva: true,
                camposCustom: {
                  ...camposExistentes,
                  ia_tom: analise.tom,
                  ia_nivel: analise.nivel,
                  ia_objecoes: (analise.objecoes ?? []).join("; "),
                  ia_angulo: analise.angulo,
                  ia_primeira_mensagem: analise.mensagem,
                  ia_analisado_em: new Date().toISOString(),
                },
              },
            });

            processados++;
          } catch (e: any) {
            erros++;
            // Marcar como analisado com erro para não repetir
            await prisma.crmDeal.update({
              where: { id: deal.id },
              data: {
                camposCustom: {
                  ...camposExistentes,
                  ia_analisado_em: new Date().toISOString(),
                  ia_erro_analise: e.message?.slice(0, 100),
                },
              },
            });
          }
        }));

        // Rate limit: pausa entre lotes
        if (i + CONCORRENCIA < deals.length) {
          await new Promise(r => setTimeout(r, 300));
        }
      }

      const countRows = await prisma.$queryRaw<{ total: bigint; analisados: bigint }[]>`
        SELECT
          COUNT(*) FILTER (
            WHERE (d."contatoId" IS NULL OR d."contatoId" NOT IN (
              SELECT DISTINCT "contatoId" FROM "CrmDeal"
              WHERE "pipelineId" != ${pipeline.id} AND status = 'aberto' AND "contatoId" IS NOT NULL
            ))
          ) AS total,
          COUNT(*) FILTER (
            WHERE (d."contatoId" IS NULL OR d."contatoId" NOT IN (
              SELECT DISTINCT "contatoId" FROM "CrmDeal"
              WHERE "pipelineId" != ${pipeline.id} AND status = 'aberto' AND "contatoId" IS NOT NULL
            ))
            AND d."camposCustom" ? 'ia_analisado_em'
          ) AS analisados
        FROM "CrmDeal" d
        WHERE d."pipelineId" = ${pipeline.id} AND d.status = 'aberto'
      `;
      const total     = Number(countRows[0].total);
      const analisados = Number(countRows[0].analisados);

      return {
        ok: true,
        processados,
        erros,
        totalAnalisados: analisados,
        totalDeals: total,
        pendentes: total - analisados,
        excluidos: idsExcluidos.length,
      };
    }),

  // ── Análise IA generalizada — qualquer funil ──────────────────────────────

  progressoAnaliseGeral: authProc
    .input(z.object({ pipelineId: z.string().optional() }))
    .query(async ({ input }) => {
      const rows = input.pipelineId
        ? await prisma.$queryRaw<{ total: bigint; analisados: bigint }[]>`
            SELECT
              COUNT(*) AS total,
              COUNT(*) FILTER (WHERE d."camposCustom" ? 'ia_analisado_em') AS analisados
            FROM "CrmDeal" d
            WHERE d."pipelineId" = ${input.pipelineId} AND d.status = 'aberto'
          `
        : await prisma.$queryRaw<{ total: bigint; analisados: bigint }[]>`
            SELECT
              COUNT(*) AS total,
              COUNT(*) FILTER (WHERE d."camposCustom" ? 'ia_analisado_em') AS analisados
            FROM "CrmDeal" d
            WHERE d.status = 'aberto'
          `;

      const total     = Number(rows[0].total);
      const analisados = Number(rows[0].analisados);
      return { total, analisados, pendentes: total - analisados };
    }),

  analisarLeadsGeral: authProc
    .input(z.object({
      projetoId: z.string(),
      pipelineId: z.string().optional(),
      batchSize: z.number().int().min(1).max(50).default(20),
    }))
    .mutation(async ({ input }) => {
      // 1. API key
      const cfg = await prisma.iaProjetoConfig.findFirst({
        where: { projetoId: input.projetoId, chave: "anthropic_api_key" },
      });
      const apiKey = cfg?.valor;
      if (!apiKey) throw new Error("anthropic_api_key não configurada no projeto IA");

      const anthropic = new Anthropic({ apiKey });

      // 2. Buscar IDs pendentes via SQL (JSON path confiável)
      const pendingIds = input.pipelineId
        ? await prisma.$queryRaw<{ id: string }[]>`
            SELECT d.id FROM "CrmDeal" d
            WHERE d."pipelineId" = ${input.pipelineId}
              AND d.status = 'aberto'
              AND (d."camposCustom" IS NULL OR NOT (d."camposCustom" ? 'ia_analisado_em'))
            ORDER BY d."criadoEm" ASC
            LIMIT ${input.batchSize}
          `
        : await prisma.$queryRaw<{ id: string }[]>`
            SELECT d.id FROM "CrmDeal" d
            WHERE d.status = 'aberto'
              AND (d."camposCustom" IS NULL OR NOT (d."camposCustom" ? 'ia_analisado_em'))
            ORDER BY d."criadoEm" ASC
            LIMIT ${input.batchSize}
          `;

      if (pendingIds.length === 0) {
        return { ok: true, processados: 0, semAbordagem: 0, msg: "Todos os leads elegíveis já foram analisados." };
      }

      const deals = await prisma.crmDeal.findMany({
        where: { id: { in: pendingIds.map(r => r.id) } },
        include: {
          contato: { select: { nome: true, whatsapp: true } },
          stage: { select: { id: true, nome: true, chave: true, ehGanho: true, ehEncerramento: true } },
          pipeline: { select: { id: true, nome: true } },
          notas: { take: 3, orderBy: { criadoEm: "desc" } },
        },
      });

      // Stage map por pipelineId (para Bot RAP)
      const botRapPipeline = await prisma.crmPipeline.findFirst({
        where: { nome: "Bot RAP — Reengajamento" },
        include: { stages: true },
      });
      const botRapStageMap = new Map<string, string>(
        (botRapPipeline?.stages ?? []).map((s: any) => [s.chave, s.id])
      );

      const PROMPT_GERAL = `Você é um analista comercial especializado em reativação de leads para escritório de advocacia trabalhista (Pinheiro Silva / RAP Advogados — Bahia).

Analise o contexto do lead e retorne APENAS um JSON válido com esta estrutura exata:
{
  "precisa_abordagem": true | false,
  "motivo_sem_abordagem": "string (preencher apenas quando precisa_abordagem=false, ex: 'Lead já ajuizado', 'Contrato assinado', 'Processo ativo')",
  "tom": "receptivo" | "frio" | "desconfiado" | "sem_resposta" | "nao_aplicavel",
  "nivel": "confirmado" | "parcial" | "interesse" | "sem_qualificacao" | "nao_aplicavel",
  "objecoes": ["array de objeções ou vazio"],
  "angulo": "1-2 frases sobre o melhor ângulo de abordagem (vazio se precisa_abordagem=false)",
  "mensagem": "Mensagem de abertura personalizada para WhatsApp, natural e humana, até 3 linhas (vazio se precisa_abordagem=false)",
  "stage": "reeng_carreteiro" | "reeng_qualificado" | "reeng_agendamento" | "reeng_sem_resposta" | null,
  "persona": "advogado" | "assistente" | null
}

QUANDO precisa_abordagem = false:
- Lead está em etapa de encerramento (ajuizado, contrato assinado, reunião realizada, cliente ativo, perdido)
- Não gerar mensagem nem ângulo
- Preencher motivo_sem_abordagem

QUANDO precisa_abordagem = true (stage e persona são obrigatórios):
- stage "reeng_carreteiro" + persona "advogado": motorista CLT confirmado — Dra. Daniela fecha
- stage "reeng_agendamento" + persona "advogado": tinha agendamento — follow-up urgente Dra. Daniela
- stage "reeng_qualificado" + persona "assistente": interesse mas incompleto — Ana qualifica
- stage "reeng_sem_resposta" + persona "assistente": sem engajamento — Ana abre
- stage e persona são null quando o lead não é do funil Bot RAP`;

      let processados = 0;
      let semAbordagem = 0;
      let erros = 0;

      const CONCORRENCIA = 5;
      for (let i = 0; i < deals.length; i += CONCORRENCIA) {
        const lote = deals.slice(i, i + CONCORRENCIA);

        await Promise.all(lote.map(async (deal: any) => {
          const camposExistentes = (deal.camposCustom as Record<string, any>) ?? {};
          const isBotRap = deal.pipeline?.id === botRapPipeline?.id;

          // Leads em stages ganho/encerramento: não precisam de abordagem — sem chamada à API
          if (deal.stage?.ehGanho || deal.stage?.ehEncerramento) {
            const motivo = deal.stage.ehGanho ? "Lead ganho/cliente ativo" : "Lead encerrado/perdido";
            await prisma.crmDeal.update({
              where: { id: deal.id },
              data: {
                camposCustom: {
                  ...camposExistentes,
                  ia_precisa_abordagem: false,
                  ia_motivo_sem_abordagem: motivo,
                  ia_analisado_em: new Date().toISOString(),
                },
              },
            });
            semAbordagem++;
            return;
          }

          // Contexto de campos do lead
          const empCtx = Object.entries(camposExistentes)
            .filter(([k]) => !k.startsWith("ia_"))
            .map(([k, v]) => `${k}: ${v}`)
            .join("\n") || "Sem dados adicionais.";

          const notasTexto = deal.notas.map((n: any) => n.conteudo.slice(0, 1500)).join("\n\n---\n\n") || "Sem notas registradas.";

          const userMsg = `FUNIL: ${deal.pipeline?.nome ?? "desconhecido"}
ETAPA ATUAL: ${deal.stage?.nome ?? "desconhecida"} (chave: ${deal.stage?.chave ?? ""})
LEAD: ${deal.contato?.nome ?? deal.titulo}
CAMPOS ADICIONAIS:
${empCtx}

NOTAS / HISTÓRICO:
${notasTexto.slice(0, 2500)}`;

          try {
            const resp = await anthropic.messages.create({
              model: "claude-haiku-4-5-20251001",
              max_tokens: 600,
              system: PROMPT_GERAL,
              messages: [{ role: "user", content: userMsg }],
            });

            const rawText = resp.content[0]?.type === "text" ? resp.content[0].text.trim() : "";
            const jsonMatch = rawText.match(/\{[\s\S]*\}/);
            if (!jsonMatch) throw new Error("Resposta Claude não continha JSON");

            const analise = JSON.parse(jsonMatch[0]);
            const precisaAbordagem = analise.precisa_abordagem !== false;

            const updateData: any = {
              projetoId: input.projetoId,
              iaAtiva: precisaAbordagem,
              camposCustom: {
                ...camposExistentes,
                ia_precisa_abordagem: precisaAbordagem,
                ia_tom: analise.tom,
                ia_nivel: analise.nivel,
                ...(analise.objecoes?.length ? { ia_objecoes: analise.objecoes.join("; ") } : {}),
                ...(!precisaAbordagem && analise.motivo_sem_abordagem
                  ? { ia_motivo_sem_abordagem: analise.motivo_sem_abordagem }
                  : {}),
                ...(precisaAbordagem && analise.angulo ? { ia_angulo: analise.angulo } : {}),
                ...(precisaAbordagem && analise.mensagem ? { ia_primeira_mensagem: analise.mensagem } : {}),
                ia_analisado_em: new Date().toISOString(),
              },
            };

            // Para Bot RAP: atualizar stage e persona conforme classificação
            if (isBotRap && precisaAbordagem && analise.stage) {
              const novoStageId = botRapStageMap.get(analise.stage);
              if (novoStageId) {
                updateData.stageId = novoStageId;
                updateData.iaStageChave = analise.stage;
              }
              if (analise.persona) updateData.iaPersonaChave = analise.persona;
            }

            await prisma.crmDeal.update({ where: { id: deal.id }, data: updateData });

            if (precisaAbordagem) processados++;
            else semAbordagem++;
          } catch (e: any) {
            erros++;
            await prisma.crmDeal.update({
              where: { id: deal.id },
              data: {
                camposCustom: {
                  ...camposExistentes,
                  ia_analisado_em: new Date().toISOString(),
                  ia_erro_analise: e.message?.slice(0, 100),
                },
              },
            });
          }
        }));

        if (i + CONCORRENCIA < deals.length) {
          await new Promise(r => setTimeout(r, 300));
        }
      }

      // Progresso atual
      const countRows = input.pipelineId
        ? await prisma.$queryRaw<{ total: bigint; analisados: bigint }[]>`
            SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE d."camposCustom" ? 'ia_analisado_em') AS analisados
            FROM "CrmDeal" d WHERE d."pipelineId" = ${input.pipelineId} AND d.status = 'aberto'
          `
        : await prisma.$queryRaw<{ total: bigint; analisados: bigint }[]>`
            SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE d."camposCustom" ? 'ia_analisado_em') AS analisados
            FROM "CrmDeal" d WHERE d.status = 'aberto'
          `;
      const total      = Number(countRows[0].total);
      const analisados = Number(countRows[0].analisados);

      return {
        ok: true,
        processados,
        semAbordagem,
        erros,
        totalAnalisados: analisados,
        totalDeals: total,
        pendentes: total - analisados,
      };
    }),

  // ── Disparar leads importados do JSON (mensagens personalizadas) ──────────

  dispararImportados: authProc
    .input(z.object({
      projetoId: z.string().min(1),
      stageChaves: z.array(z.string()).optional(),
      maxDeals: z.number().int().min(1).max(2000).default(200),
      delayMs: z.number().int().min(100).max(30000).default(1000),
    }))
    .mutation(async ({ input }) => {
      // 1. Garantir pipeline Reengajamento RAP (cria se não existir)
      const { pipeline, stageMap } = await ensureReengPipeline(input.projetoId);
      const msgEnviadaId = stageMap.get("reeng_msg_enviada");
      const importadoId = stageMap.get("reeng_importado");

      // 2. Buscar configs do projeto Evolution API
      const configs = await prisma.iaProjetoConfig.findMany({
        where: { projetoId: input.projetoId },
      });
      const evolutionUrl = configs.find(c => c.chave === "evolution_url")?.valor;
      const evolutionApiKey = configs.find(c => c.chave === "evolution_api_key")?.valor;
      const projeto = await prisma.iaProjeto.findUnique({ where: { id: input.projetoId } });
      const evolutionInstance = projeto?.whatsappInstancia;

      if (!evolutionUrl || !evolutionApiKey || !evolutionInstance) {
        return { ok: false, error: "Evolution API não configurada no projeto" };
      }

      // 3. Buscar deals em reeng_importado com mensagem personalizada
      const stageIds = input.stageChaves?.length
        ? input.stageChaves.map(ch => stageMap.get(ch)).filter(Boolean)
        : importadoId ? [importadoId] : [];

      if (!stageIds.length) return { ok: false, error: "Nenhum stage alvo encontrado" };

      const deals = await prisma.crmDeal.findMany({
        where: {
          pipelineId: (pipeline as any).id,
          stageId: { in: stageIds as string[] },
          status: "aberto",
          projetoId: input.projetoId,
          iaAtiva: true,
          OR: [{ ultimoContatoEm: null }],
        },
        include: { contato: true },
        orderBy: { criadoEm: "asc" },
        take: input.maxDeals,
      });

      if (!deals.length) return { ok: true, enviados: 0, msg: "Nenhum lead pendente de disparo.", total: 0 };

      let enviados = 0;
      let semMensagem = 0;
      const erros: string[] = [];

      for (const deal of deals) {
        const customFields = (deal.camposCustom as Record<string, any>) ?? {};
        const mensagem = customFields?.ia_mensagem_personalizada;
        if (!mensagem) { semMensagem++; continue; }

        const phone = deal.contato?.whatsapp;
        if (!phone) { semMensagem++; continue; }

        try {
          const phoneNum = phone.replace(/\D/g, "");
          const resp = await fetch(`${evolutionUrl}/message/sendText/${evolutionInstance}`, {
            method: "POST",
            headers: { "Content-Type": "application/json", apikey: evolutionApiKey },
            body: JSON.stringify({ number: phoneNum, text: mensagem }),
          });

          if (!resp.ok) {
            erros.push(`Deal ${deal.id}: Evolution HTTP ${resp.status}`);
            continue;
          }

          await prisma.crmDeal.update({
            where: { id: deal.id },
            data: {
              stageId: msgEnviadaId ?? deal.stageId,
              iaStageChave: "reeng_msg_enviada",
              ultimoContatoEm: new Date(),
              camposCustom: {
                ...customFields,
                ia_mensagem_enviada_em: new Date().toISOString(),
              },
            },
          });

          await prisma.crmDealStageLog.create({
            data: {
              dealId: deal.id,
              stageAnteriorId: deal.stageId,
              stageNovoId: msgEnviadaId ?? deal.stageId,
              motivo: "Mensagem de reengajamento enviada",
            },
          });

          await prisma.crmMensagemWhatsapp.create({
            data: {
              dealId: deal.id,
              contatoId: deal.contatoId ?? undefined,
              direcao: "out",
              personaChave: "advogado",
              conteudo: mensagem,
              tipo: "text",
            },
          });

          enviados++;
          await new Promise(r => setTimeout(r, input.delayMs));
        } catch (e: any) {
          erros.push(`Deal ${deal.id}: ${e.message}`);
        }
      }

      return {
        ok: true,
        enviados,
        semMensagem,
        erros,
        total: deals.length,
      };
    }),

  // ── Status dos leads importados ───────────────────────────────────────────

  statusImportados: authProc
    .input(z.object({ projetoId: z.string().optional() }))
    .query(async ({ input }) => {
      const pipeline = await prisma.crmPipeline.findFirst({
        where: { nome: "Reengajamento RAP" },
        include: { stages: true },
      });
      if (!pipeline) return { total: 0, stages: [], enviados: 0, pendentes: 0 };

      const whereProjeto = input.projetoId ? { projetoId: input.projetoId } : {};

      const deals = await prisma.crmDeal.findMany({
        where: {
          pipelineId: pipeline.id,
          status: "aberto",
          ...whereProjeto,
        },
        include: { stage: { select: { id: true, chave: true, nome: true } } },
      });

      const stageCounts = new Map<string, { chave: string; nome: string; total: number; enviados: number }>();
      for (const s of pipeline.stages) {
        stageCounts.set(s.chave, { chave: s.chave, nome: s.nome, total: 0, enviados: 0 });
      }

      let enviados = 0;
      for (const d of deals) {
        const chave = d.iaStageChave || d.stage.chave;
        const counter = stageCounts.get(chave);
        if (counter) counter.total++;
        const cf = (d.camposCustom as Record<string, any>) ?? {};
        if (cf.ia_mensagem_enviada_em) {
          enviados++;
          if (counter) counter.enviados++;
        }
      }

      // Pipeline ID para link ao Kanban
      const pipelineId = (pipeline as any).id;

      return {
        pipelineId,
        total: deals.length,
        stages: Array.from(stageCounts.values()).filter(s => s.total > 0),
        enviados,
        pendentes: deals.length - enviados,
      };
    }),
});
