import { z } from "zod";
import { router, authProc } from "./trpc.js";
import { prisma } from "../db.js";
import { invalidateClientCache } from "../agent/llm.js";

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
// Router
// ──────────────────────────────────────────────────────────────────────────────

export const iaRouter = router({
  // ── Projetos ──────────────────────────────────────────────────────────────

  listProjetos: authProc.query(() =>
    prisma.iaProjeto.findMany({ orderBy: { criadoEm: "asc" } })
  ),

  getProjeto: authProc
    .input(z.object({ id: z.string() }))
    .query(({ input }) =>
      prisma.iaProjeto.findUnique({
        where: { id: input.id },
        include: { configs: true, personas: { orderBy: { ordem: "asc" } }, fases: { orderBy: { ordem: "asc" } } },
      })
    ),

  createProjeto: authProc
    .input(z.object({ nome: z.string(), descricao: z.string().optional(), whatsappInstancia: z.string().optional() }))
    .mutation(({ input }) =>
      prisma.iaProjeto.create({ data: input })
    ),

  updateProjeto: authProc
    .input(z.object({ id: z.string(), nome: z.string().optional(), ativo: z.boolean().optional(), whatsappInstancia: z.string().optional() }))
    .mutation(({ input }) => {
      const { id, ...data } = input;
      return prisma.iaProjeto.update({ where: { id }, data });
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

  // ── Personas ──────────────────────────────────────────────────────────────

  listPersonas: authProc
    .input(z.object({ projetoId: z.string() }))
    .query(({ input }) =>
      prisma.iaPersona.findMany({
        where: { projetoId: input.projetoId },
        orderBy: { ordem: "asc" },
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
    }))
    .mutation(({ input }) => {
      const { projetoId, chave, ...data } = input;
      return prisma.iaPersona.upsert({
        where: { projetoId_chave: { projetoId, chave } },
        create: { projetoId, chave, ...data } as any,
        update: data as any,
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

  // ── Mensagens WhatsApp ────────────────────────────────────────────────────

  getMensagens: authProc
    .input(z.object({ dealId: z.string(), limit: z.number().optional() }))
    .query(async ({ input }) => {
      const limit = input.limit ?? 100;
      const rows = await prisma.crmMensagemWhatsapp.findMany({
        where: { dealId: input.dealId },
        orderBy: { enviadaEm: "desc" },
        take: limit,
      });
      return rows.reverse();
    }),

  listConversas: authProc
    .input(z.object({ projetoId: z.string().optional() }))
    .query(async ({ input }) => {
      const deals = await prisma.crmDeal.findMany({
        where: {
          ...(input.projetoId ? { projetoId: input.projetoId } : {}),
          mensagens: { some: {} },
        },
        include: {
          contato: true,
          mensagens: {
            orderBy: { enviadaEm: "desc" },
            take: 1,
          },
        },
        orderBy: { ultimoContatoEm: "desc" },
        take: 50,
      });
      return deals;
    }),

  toggleIaPausa: authProc
    .input(z.object({ dealId: z.string(), pausar: z.boolean() }))
    .mutation(({ input, ctx }) =>
      prisma.crmDeal.update({
        where: { id: input.dealId },
        data: {
          iaAtiva: !input.pausar,
          iaPausadaEm:  input.pausar ? new Date() : null,
          iaPausadaPor: input.pausar ? ctx.userId : null,
        },
      })
    ),

  sendMensagemManual: authProc
    .input(z.object({ dealId: z.string(), conteudo: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const deal = await prisma.crmDeal.findUnique({
        where: { id: input.dealId },
        include: { contato: true },
      });
      if (!deal?.contatoId || !deal.projetoId) throw new Error("Deal sem contato ou projeto");

      const phone = deal.contato?.whatsapp;
      if (!phone) throw new Error("Contato sem WhatsApp");

      // Resolve display name: nomeWhatsapp (project setting) → usuario.nome → "Atendente"
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

      // Always prepend name in bold — institutional WhatsApp style
      const textoEnvio = `*${nomeRemetente}*\n${input.conteudo}`;

      const configs = await prisma.iaProjetoConfig.findMany({
        where: { projetoId: deal.projetoId, categoria: "whatsapp" },
      });
      const get = (k: string) => configs.find((c) => c.chave === k)?.valor ?? "";
      const evoConfig = {
        baseUrl: get("evolution_api_url"),
        apiKey: get("evolution_api_key"),
        instancia: get("evolution_instancia"),
      };

      if (!evoConfig.baseUrl) throw new Error("Evolution API não configurada");

      const { sendText } = await import("../services/evolution.js");
      await sendText(evoConfig, phone, textoEnvio);

      return prisma.crmMensagemWhatsapp.create({
        data: {
          dealId:       deal.id,
          contatoId:    deal.contatoId,
          direcao:      "out",
          tipo:         "text",
          conteudo:     textoEnvio,
          usuarioId:    ctx.userId ?? null,
          nomeRemetente,
        },
      });
    }),

  // ── Seed ──────────────────────────────────────────────────────────────────

  seedCarreteiros: authProc.mutation(async () => {
    const existente = await prisma.iaProjeto.findFirst({ where: { nome: "Carreteiros" } });
    if (existente) return { ok: true, projetoId: existente.id, msg: "Já existe" };

    const projeto = await prisma.iaProjeto.create({
      data: { nome: "Carreteiros", descricao: "Motoristas carreteiros — Pinheiro Silva Advogados" },
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
      { chave: "aguardando_assinatura", nomeExibicao: "Aguardando Assinatura do Contrato", ordem: 7, cor: "#10b981", personaChave: "advogado" },
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
        { projetoId: projeto.id, chave: "e_clt", perguntaContexto: "Se o lead tem ou tinha vínculo CLT (carteira assinada) — true/false. Autônomo dono do veículo = false", tipoDado: "booleano", ordem: 0, stageColeta: "lead_carreteiro" },
        { projetoId: projeto.id, chave: "nome", perguntaContexto: "Nome completo do cliente", tipoDado: "texto", ordem: 1, stageColeta: "lead_carreteiro" },
        { projetoId: projeto.id, chave: "cidade", perguntaContexto: "Cidade onde mora o cliente", tipoDado: "texto", ordem: 2, stageColeta: "lead_carreteiro" },
        { projetoId: projeto.id, chave: "funcao_recente", perguntaContexto: "Função no emprego mais recente como carreteiro", tipoDado: "texto", ordem: 3, stageColeta: "lead_carreteiro" },
        { projetoId: projeto.id, chave: "empresa_recente", perguntaContexto: "Nome da empresa mais recente", tipoDado: "texto", ordem: 4, stageColeta: "lead_carreteiro" },
        { projetoId: projeto.id, chave: "vinculo_recente", perguntaContexto: "Tipo de vínculo: CLT, autônomo ou avulso", tipoDado: "texto", ordem: 5, stageColeta: "lead_carreteiro" },
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
      destino:   z.string(),
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
      const { id, ...data } = input;
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

  listTodosUsuarios: authProc.query(async () => {
    return prisma.usuario.findMany({
      where: { ativo: true },
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
            where: { usuarioId: m.usuarioId, direcao: "out", enviadaEm: { gte: de, lte: ate },
              deal: { projetoId: input.projetoId } },
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
      ordem:                z.number().int().default(0),
      requerPrescricaoAtiva: z.boolean().default(false),
    }))
    .mutation(async ({ input }) => {
      const { id, projetoId, ...data } = input;
      if (id) {
        return prisma.iaRegraTransicao.update({ where: { id }, data });
      }
      return prisma.iaRegraTransicao.create({ data: { ...data, projetoId } });
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
          { chave: "vinculo",        campoColetar: "vinculo",        ordemPadrao: 3,  pergunta: "Você tinha carteira assinada (CLT) ou era autônomo?",                    skipSe: null, tipoEspecial: null },
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
        { chave: "plataforma_origem", ordem: 2, label: "Plataforma do anúncio", stepType: "question", campoColetar: "plataforma_anuncio", pergunta: "Você viu nosso anúncio onde? Instagram, Facebook, TikTok, ou foi uma indicação?" },
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
});
