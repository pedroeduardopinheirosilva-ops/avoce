/**
 * Assistente Interno WhatsApp — equipe do escritório Pinheiro Silva Advogados.
 *
 * Recebe mensagens de usuários na whitelist (Usuario.whatsapp) e gera
 * propostas, contratos e procurações via conversa natural com LLM.
 */

import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { prisma } from "../db.js";
import { callLlm } from "./llm.js";
import { getEvolutionConfig } from "./message-handler.js";
import {
  sendText,
  sendDocument,
  downloadMedia,
} from "../services/evolution.js";
import { extractMediaData } from "./doc-extractor.js";
import {
  buildVars,
  renderTemplateDoc,
  gerarDocumentosProposta,
} from "../routers/templateDocumentos.js";
import {
  propostaHtmlPage,
  logoPathToBase64,
} from "../routers/propostas.js";
import { htmlToPdf } from "../lib/pdf.js";
import type { EvolutionConfig } from "../services/evolution.js";

// ─── Types ────────────────────────────────────────────────────────────────────

interface SessaoCtx {
  history: Array<{ role: "user" | "assistant"; content: string }>;
  clienteNome?: string;
  clienteCpf?: string;
  clienteEmail?: string;
  clienteTelefone?: string;
  emitenteId?: string;
  templateId?: string;
  tipo?: "PROPOSTA" | "CONTRATO" | "PROCURACAO" | "OUTRO";
  valor?: number;
  servicoDescricao?: string;
}

interface GerarAction {
  acao: "gerar";
  tipo: "PROPOSTA" | "CONTRATO" | "PROCURACAO" | "OUTRO";
  dados: Partial<SessaoCtx>;
}

// ─── Entry point ─────────────────────────────────────────────────────────────

export async function processAssistenteInterno(
  projetoId: string,
  phone: string,
  msg: any,
  app: any,
): Promise<void> {
  // Lê configs do assistente (ativo, prompt_extra)
  const assistenteCfgs = await prisma.iaProjetoConfig.findMany({
    where: { projetoId, categoria: "assistente_interno" },
  });
  const getCfg = (k: string) => assistenteCfgs.find((c) => c.chave === k)?.valor ?? "";
  if (getCfg("ativo") === "false") return; // desativado

  const evo = await getEvolutionConfig(projetoId);
  if (!evo) {
    app.log.warn("[AssistenteInterno] Config Evolution não encontrada");
    return;
  }

  // Load or create session
  let session = await (prisma as any).assistenteSession.findUnique({
    where: { phone },
  });
  if (!session) {
    const usuario = await (prisma as any).usuario.findFirst({ where: { whatsapp: phone, ativo: true } });
    session = await (prisma as any).assistenteSession.create({
      data: { phone, usuarioId: usuario?.id ?? null, step: "idle", contexto: { history: [] } },
    });
  }

  const ctx: SessaoCtx = (session.contexto as SessaoCtx) ?? { history: [] };
  ctx.history = ctx.history ?? [];

  // Cancelar/reiniciar conversa
  const rawText = extractRawText(msg);
  if (/^(cancelar|reiniciar|reset|limpar)$/i.test(rawText?.trim() ?? "")) {
    const fresh: SessaoCtx = { history: [] };
    await saveSession(phone, fresh);
    await sendText(evo, phone, "🔄 Conversa reiniciada. Como posso ajudar?");
    return;
  }

  // Extract user input (text / audio transcription / OCR)
  const userText = await extractUserInput(projetoId, evo, msg, app);
  if (!userText) return;
  ctx.history.push({ role: "user", content: userText });

  // Load emitentes and templates to give the LLM context
  const [emitentes, templates] = await Promise.all([
    (prisma as any).empresaEmitente.findMany({
      select: { id: true, nome: true, nomeFantasia: true, cnpj: true },
      orderBy: { nome: "asc" },
    }),
    (prisma as any).templateDocumento.findMany({
      select: { id: true, tipo: true, titulo: true, emitenteId: true },
      where: { ativo: true },
      orderBy: { titulo: "asc" },
    }),
  ]);

  const promptExtra = getCfg("prompt_extra");
  const systemPrompt = buildSystemPrompt(emitentes, templates, ctx, promptExtra);
  const messages = ctx.history
    .slice(-14)
    .map((h) => ({ role: h.role as "user" | "assistant", content: h.content }));

  let resposta: string;
  try {
    const result = await callLlm({
      projetoId,
      systemPrompt,
      messages,
      personaChave: "assistente_interno",
      maxTokens: 1200,
    });
    resposta = result.content.trim();
  } catch (e: any) {
    app.log.error({ err: e }, "[AssistenteInterno] LLM falhou");
    await sendText(evo, phone, "❌ Serviço temporariamente indisponível. Tente novamente.");
    return;
  }

  ctx.history.push({ role: "assistant", content: resposta });

  // Check if the LLM decided to generate a document
  const action = tryParseGerarAction(resposta);
  if (action) {
    // Merge collected data from action into session context
    const merged: SessaoCtx = { ...ctx, ...action.dados };
    await saveSession(phone, merged);

    await sendText(evo, phone, "⏳ Gerando documento, aguarde...");
    try {
      const pdfPath = await gerarDocumentoAssistente(action, app);
      if (pdfPath && existsSync(pdfPath)) {
        const pdfBuf = readFileSync(pdfPath);
        const fileName = `${action.tipo.toLowerCase()}.pdf`;
        await sendDocument(evo, phone, pdfBuf.toString("base64"), fileName);
        await sendText(evo, phone, `✅ *${action.tipo}* gerada com sucesso!`);
      } else {
        await sendText(evo, phone, "❌ Documento gerado mas arquivo não localizado. Verifique no sistema.");
      }
      // Reset context after generation, keep last 4 turns for continuity
      const fresh: SessaoCtx = { history: ctx.history.slice(-4) };
      await saveSession(phone, fresh);
      return;
    } catch (e: any) {
      app.log.error({ err: e }, "[AssistenteInterno] Erro ao gerar documento");
      await sendText(evo, phone, `❌ Erro ao gerar: ${e.message?.slice(0, 250)}`);
    }
  } else {
    await sendText(evo, phone, resposta);
  }

  // Keep history bounded
  if (ctx.history.length > 20) ctx.history = ctx.history.slice(-20);
  await saveSession(phone, ctx);
}

// ─── Session persistence ──────────────────────────────────────────────────────

async function saveSession(phone: string, ctx: SessaoCtx): Promise<void> {
  await (prisma as any).assistenteSession.upsert({
    where: { phone },
    update: { contexto: ctx as any },
    create: { phone, contexto: ctx as any },
  });
}

// ─── Text extraction ──────────────────────────────────────────────────────────

function extractRawText(msg: any): string | null {
  const m = msg?.message ?? {};
  return (
    m.conversation ??
    m.extendedTextMessage?.text ??
    m.buttonsResponseMessage?.selectedDisplayText ??
    m.listResponseMessage?.title ??
    null
  );
}

async function extractUserInput(
  projetoId: string,
  evo: EvolutionConfig,
  msg: any,
  app: any,
): Promise<string | null> {
  const m = msg?.message ?? {};
  const isAudio = !!m.audioMessage;
  const isDocument = !!m.documentMessage;
  const isImage = !isAudio && !!m.imageMessage;

  const text = extractRawText(msg);
  if (text) return text;

  if (isAudio) {
    try {
      const { transcribeAudio, downloadAudioFromEvolution } = await import("../services/whisper.js");
      const audioConfigs = await prisma.iaProjetoConfig.findMany({
        where: { projetoId, categoria: "audio" },
      });
      const getAudio = (k: string) => audioConfigs.find((c) => c.chave === k)?.valor ?? "";
      const audioApiKey = getAudio("audio_api_key");
      if (!audioApiKey) return "[Áudio recebido — chave de transcrição não configurada]";
      const audio = await downloadAudioFromEvolution(evo.baseUrl, evo.apiKey, evo.instancia, msg);
      if (!audio) return "[Áudio recebido — falha no download]";
      const result = await transcribeAudio(
        audio.buffer, audio.mimetype, audioApiKey,
        getAudio("audio_model") || "whisper-large-v3-turbo",
        (getAudio("audio_provider") || "groq") as "groq" | "openai",
        "Conversa em português brasileiro sobre direito trabalhista e emprego de motorista carreteiro.",
      );
      if (result.ok && result.text) return result.text;
    } catch (e: any) {
      app.log.warn({ err: e }, "[AssistenteInterno] Falha na transcrição de áudio");
    }
    return "[Áudio recebido — transcrição falhou]";
  }

  if (isDocument || isImage) {
    try {
      const ocrConfigs = await prisma.iaProjetoConfig.findMany({
        where: { projetoId, categoria: "ocr" },
      });
      const groqRow = await prisma.iaLlmProvedor.findFirst({
        where: { projetoId, ativo: true, provider: "groq" },
        orderBy: { ordem: "asc" },
      });
      const mistralKey = ocrConfigs.find((c) => c.chave === "ocr_mistral_api_key")?.valor ?? "";
      const groqKey = groqRow?.apiKey ?? "";

      const mediaBuffer = await downloadMedia(evo, msg.key.id);
      const mimetype =
        m.documentMessage?.mimetype ??
        (isImage ? "image/jpeg" : "application/octet-stream");
      const extracted = await extractMediaData({ groqKey, mistralKey }, mediaBuffer, mimetype);
      return extracted
        ? `[Documento recebido — dados extraídos]\n${extracted}`
        : `[${isDocument ? "Documento" : "Imagem"} recebido — leitura automática falhou]`;
    } catch (e: any) {
      app.log.warn({ err: e }, "[AssistenteInterno] Falha no OCR");
      return `[${isDocument ? "Documento" : "Imagem"} recebido — erro ao processar]`;
    }
  }

  return null;
}

// ─── System prompt ────────────────────────────────────────────────────────────

function buildSystemPrompt(emitentes: any[], templates: any[], ctx: SessaoCtx, promptExtra?: string): string {
  const emitentesStr = emitentes.length
    ? emitentes
        .map((e) => `• ID="${e.id}" | ${e.nomeFantasia || e.nome} (CNPJ: ${e.cnpj})`)
        .join("\n")
    : "Nenhum emitente cadastrado";

  const byTipo = templates.reduce<Record<string, string[]>>((acc, t) => {
    const emNome = emitentes.find((e) => e.id === t.emitenteId)?.nome ?? t.emitenteId;
    (acc[t.tipo] = acc[t.tipo] ?? []).push(`  • ID="${t.id}" | "${t.titulo}" [${emNome}]`);
    return acc;
  }, {});

  const templatesStr = Object.entries(byTipo)
    .map(([tipo, items]) => `**${tipo}**:\n${items.join("\n")}`)
    .join("\n\n") || "Nenhum template cadastrado";

  const coletados: string[] = [];
  if (ctx.clienteNome) coletados.push(`• Cliente: ${ctx.clienteNome}`);
  if (ctx.clienteCpf) coletados.push(`• CPF/CNPJ: ${ctx.clienteCpf}`);
  if (ctx.clienteEmail) coletados.push(`• E-mail: ${ctx.clienteEmail}`);
  if (ctx.clienteTelefone) coletados.push(`• Telefone: ${ctx.clienteTelefone}`);
  if (ctx.emitenteId) coletados.push(`• Emitente: ID="${ctx.emitenteId}"`);
  if (ctx.templateId) coletados.push(`• Template: ID="${ctx.templateId}"`);
  if (ctx.tipo) coletados.push(`• Tipo: ${ctx.tipo}`);
  if (ctx.valor) coletados.push(`• Valor: R$ ${ctx.valor}`);
  if (ctx.servicoDescricao) coletados.push(`• Serviço: ${ctx.servicoDescricao}`);

  return `Você é o Assistente Avoce, ferramenta interna do escritório Pinheiro Silva Advogados.
A equipe do escritório usa você via WhatsApp para gerar propostas, contratos e procurações rapidamente.

=== EMITENTES DISPONÍVEIS ===
${emitentesStr}

=== TEMPLATES DISPONÍVEIS ===
${templatesStr}

=== DADOS COLETADOS ATÉ AGORA ===
${coletados.length ? coletados.join("\n") : "Nenhum dado coletado ainda"}

=== INSTRUÇÕES ===
1. Para gerar qualquer documento você PRECISA de:
   - Nome completo do cliente
   - CPF (pessoa física) ou CNPJ (empresa)
   - ID do emitente (quem assina)
   - Tipo: PROPOSTA | CONTRATO | PROCURACAO | OUTRO
   - ID do template

2. Dados opcionais mas úteis: e-mail, telefone, descrição do serviço, valor, endereço.

3. Se o usuário enviar um documento (CNH, RG, contrato), os dados extraídos chegam como texto — use-os para preencher os campos do cliente automaticamente.

4. Quando tiver TODOS os dados obrigatórios, responda APENAS com JSON puro (sem texto antes nem depois):
{"acao":"gerar","tipo":"PROPOSTA","dados":{"clienteNome":"...","clienteCpf":"...","clienteEmail":"...","clienteTelefone":"...","emitenteId":"...","templateId":"...","valor":0,"servicoDescricao":"..."}}

5. Se faltar algum dado, faça UMA pergunta objetiva por vez.

6. Para listar emitentes ou templates disponíveis basta pedir.

7. Se o usuário digitar "cancelar" ou "reiniciar", a sessão é zerada automaticamente.

8. Seja conciso e profissional. Use português brasileiro informal.
${promptExtra ? `\n=== INSTRUÇÕES ADICIONAIS ===\n${promptExtra}` : ""}`;
}

// ─── Parse LLM action ─────────────────────────────────────────────────────────

function tryParseGerarAction(text: string): GerarAction | null {
  const match = text.match(/\{[\s\S]*?"acao"\s*:\s*"gerar"[\s\S]*?\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    if (parsed.acao === "gerar" && parsed.tipo && parsed.dados) return parsed as GerarAction;
  } catch {
    /* ignore */
  }
  return null;
}

// ─── Document generation ──────────────────────────────────────────────────────

async function gerarDocumentoAssistente(action: GerarAction, app: any): Promise<string | null> {
  const { tipo, dados } = action;
  const {
    clienteNome, clienteCpf, clienteEmail, clienteTelefone,
    emitenteId, templateId, valor, servicoDescricao,
  } = dados;

  if (!clienteNome || !clienteCpf || !emitenteId) {
    throw new Error("Dados insuficientes: nome, CPF e emitente são obrigatórios");
  }

  const emitente: any = await (prisma as any).empresaEmitente.findUnique({ where: { id: emitenteId } });
  if (!emitente) throw new Error(`Emitente "${emitenteId}" não encontrado`);

  const cpfClean = clienteCpf.replace(/\D/g, "");
  let tomador: any = await (prisma as any).tomador.findFirst({
    where: { cpfCnpj: { contains: cpfClean } },
    include: { administradores: { orderBy: { criadoEm: "asc" } } },
  });

  if (!tomador) {
    tomador = await (prisma as any).tomador.create({
      data: {
        nome: clienteNome,
        cpfCnpj: clienteCpf,
        email: clienteEmail ?? null,
        telefone: clienteTelefone ?? null,
        empresaId: emitente.empresaId ?? null,
      },
      include: { administradores: true },
    });
    app.log.info(`[AssistenteInterno] Tomador criado: ${tomador.id} (${clienteNome})`);
  } else {
    // Update name/contact if new data was given
    await (prisma as any).tomador.update({
      where: { id: tomador.id },
      data: {
        nome: clienteNome ?? tomador.nome,
        email: clienteEmail ?? tomador.email,
        telefone: clienteTelefone ?? tomador.telefone,
      },
    });
    tomador.nome = clienteNome ?? tomador.nome;
    tomador.email = clienteEmail ?? tomador.email;
    tomador.telefone = clienteTelefone ?? tomador.telefone;
  }

  const pdfDir = resolve("./uploads/documentos-gerados");
  mkdirSync(pdfDir, { recursive: true });

  // ── PROPOSTA ──────────────────────────────────────────────────────────────
  if (tipo === "PROPOSTA") {
    let propostaHtml: string;

    if (templateId) {
      const tmpl: any = await (prisma as any).templateDocumento.findUnique({ where: { id: templateId } });
      if (tmpl) {
        const vars = buildVars(emitente, tomador, {
          valorEstimado: valor ?? null,
          contratoDescricao: servicoDescricao ?? null,
          validadeAte: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        });
        propostaHtml = renderTemplateDoc(tmpl.textoHtml, vars);
      } else {
        propostaHtml = defaultPropostaHtml(clienteNome, servicoDescricao, valor);
      }
    } else {
      propostaHtml = defaultPropostaHtml(clienteNome, servicoDescricao, valor);
    }

    const validadeAte = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const proposta: any = await (prisma as any).proposta.create({
      data: {
        titulo: `Proposta — ${clienteNome}`,
        textoHtml: propostaHtml,
        valorEstimado: valor ? Math.round(valor * 100) : null,
        status: "RASCUNHO",
        emitenteId,
        tomadorId: tomador.id,
        validadeAte,
        templatesGerar: "[]",
      },
    });

    const logoSrc = logoPathToBase64(emitente.logoPath ?? null);
    const pageHtml = propostaHtmlPage(
      proposta.titulo,
      propostaHtml,
      { ...emitente, logoSrc },
      validadeAte,
      { nome: tomador.nome },
    );

    const pdfPath = join(pdfDir, `proposta-${proposta.id}.pdf`);
    const pdfBuf = await htmlToPdf(pageHtml);
    await writeFile(pdfPath, pdfBuf);
    app.log.info(`[AssistenteInterno] Proposta ${proposta.id} gerada: ${pdfPath}`);
    return pdfPath;
  }

  // ── CONTRATO / PROCURACAO / OUTRO — usa TemplateDocumento ────────────────
  if (!templateId) throw new Error("templateId obrigatório para CONTRATO/PROCURACAO/OUTRO");

  const proposta: any = await (prisma as any).proposta.create({
    data: {
      titulo: `${tipo} — ${clienteNome}`,
      textoHtml: "",
      valorEstimado: valor ? Math.round(valor * 100) : null,
      status: "RASCUNHO",
      emitenteId,
      tomadorId: tomador.id,
      contratoDescricao: servicoDescricao ?? null,
      templatesGerar: JSON.stringify([templateId]),
    },
  });

  await gerarDocumentosProposta(proposta.id);

  const pdfPath = join(pdfDir, `${proposta.id}-${templateId}.pdf`);
  return existsSync(pdfPath) ? pdfPath : null;
}

function defaultPropostaHtml(nome: string, servico?: string, valor?: number): string {
  const valorStr = valor ? `R$ ${valor.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}` : "a combinar";
  return `<h2>Proposta de Honorários Advocatícios</h2>
<p>Apresentamos a <strong>${nome}</strong> nossa proposta de serviços jurídicos.</p>
${servico ? `<h3>Objeto</h3><p>${servico}</p>` : ""}
<h3>Honorários</h3>
<p>Valor proposto: <strong>${valorStr}</strong></p>
<h3>Condições Gerais</h3>
<p>Esta proposta é válida por 30 (trinta) dias a contar de sua emissão.</p>`;
}
