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
    }))
    .mutation(({ input }) => {
      const { projetoId, chave, ...data } = input;
      return prisma.iaPersona.upsert({
        where: { projetoId_chave: { projetoId, chave } },
        create: { projetoId, chave, ...data },
        update: data,
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
        { chave: "proposta_momento",                valor: "parecer_enviado", tipo: "texto", categoria: "proposta", descricao: "Momento de disparo: parecer_enviado | qualificado | stage:<chave>" },
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
});
