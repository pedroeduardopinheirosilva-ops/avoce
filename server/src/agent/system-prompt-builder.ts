/**
 * System Prompt Builder — pure function, zero I/O.
 * Assembles the LLM system prompt from pre-loaded context.
 * All DB lookups, agent calls, and LLM calls must happen BEFORE calling buildSystemPrompt.
 */

import { validarCPF } from "./qualification-utils.js";
import type { VinculoEmprego } from "./types.js";

export interface SystemPromptContext {
  // Persona
  personaChave: string;
  personaNome: string;
  personaInstrucoes: string;           // pre-computed: assistente OR advogado agent systemInstructions
  personaFase: string;                 // AssistentePhase | AdvogadoPhase from agent result
  instrucaoComportamento: string;      // raw persona.systemPrompt from DB (has {INSTRUÇÃO BASE} placeholder)
  instrucaoBase: string;               // pre-computed buildInstrucaoBase()
  perguntasDeterministicas: string[];  // formatted pending question strings (caller limits to ≤2)
  camposBloqueados: string[];          // field chaves already filled (reserved for caller pre-filtering)

  // Qualificação
  merged: Record<string, unknown>;
  vinculos: VinculoEmprego[];
  vinculosOk: boolean;
  vinculosTodosPrescritos: boolean;

  // Flow (Daniela)
  iaFlowStepChave: string | null;
  iaFlowStepData: Record<string, unknown>;

  // Documento recebido neste turno (optional — default false)
  documentosEnviados?: boolean;
  isDocAnalitico?: boolean; // true when doc is not a personal ID — needs LLM analysis

  // Próxima pergunta
  nextQDeterministico?: string | null;
  advFlowStepType?: string | null;
  advFlowNextStepChave?: string | null;
  advFlowCampoColetar?: string | null;
  valueInjection?: string | null;       // pre-computed calcular/format result for valor_estimado step
  handoffSnapshot?: string | null;      // pre-computed buildHandoffSnapshot(merged) for Daniela

  // Frustração
  frustrationInjection?: string | null;

  // Contexto da conversa
  outgoingCount: number;
  nomeCliente: string | null;
  cidadeCliente: string | null;

  // Mensagem atual do lead (usada para substituir {{resposta_lead}})
  incomingText?: string | null;

  // Lead asked an unexpected off-flow question — LLM should answer then return to flow
  leadFezPerguntaInesperada?: boolean;

  // Identity data to inject when lead asked a complex question containing identity keywords
  identityContextInject?: string | null;

  // Nome da persona assistente (para referências cruzadas em prompts de outras personas)
  assistenteNome?: string;

  // Nome do escritório e do advogado (para substituição de {nome_escritorio} e {nome_advogado})
  escritorioNome?: string;
  advogadoNome?: string;
}

// ── Private: document received feedback ───────────────────────────────────────

function buildDocFeedback(ctx: SystemPromptContext): string {
  const { merged } = ctx;
  const tipoDoc = (merged._ultimo_doc_tipo as string | undefined) ?? null;
  const isEndereco = tipoDoc === "COMPROVANTE_ENDERECO";
  const isCtps = tipoDoc === "CTPS";
  const instrucaoLink =
    `\nIMPORTANTE: O link de assinatura do contrato e da procuração será enviado AUTOMATICAMENTE` +
    ` pelo sistema na próxima mensagem. NÃO inclua nenhum link, URL ou placeholder de link na sua resposta.` +
    ` Diga apenas que o contrato e a procuração serão enviados em instantes.`;

  if (isEndereco) {
    const endExtraido   = (merged.endereco as string | undefined) ?? null;
    const cidadeExtraida = (merged.cidade as string | undefined) ?? null;
    const extraidos = [endExtraido ? `endereço: ${endExtraido}` : null, cidadeExtraida ? `cidade: ${cidadeExtraida}` : null].filter(Boolean) as string[];
    return extraidos.length > 0
      ? `\n\nCOMPROVANTE DE ENDEREÇO recebido — dados extraídos: ${extraidos.join(", ")}.\nAgradeça o envio e confirme o endereço com o cliente.${instrucaoLink}`
      : `\n\nCOMPROVANTE DE ENDEREÇO recebido — não conseguimos ler o endereço automaticamente.\nAgradeça o envio e peça que o cliente informe o endereço completo com CEP.${instrucaoLink}`;
  }

  if (isCtps) {
    const pisExtraido  = (merged.pis as string | undefined) ?? null;
    const nomeExtraido = (merged.nome as string | undefined) ?? null;
    const extraidos = [nomeExtraido ? `nome: ${nomeExtraido}` : null, pisExtraido ? `PIS/NIS: ${pisExtraido}` : null].filter(Boolean) as string[];
    return extraidos.length > 0
      ? `\n\nCTPS recebida — dados extraídos: ${extraidos.join(", ")}.\nAgradeça o envio e confirme os dados.${instrucaoLink}`
      : `\n\nCTPS recebida — não conseguimos ler os dados automaticamente.\nAgradeça o envio e continue o atendimento normalmente.${instrucaoLink}`;
  }

  // CNH / RG
  const docSubtipo = (merged._ultimo_doc_subtipo as string | undefined) ?? null;
  const rotuloDoc = docSubtipo === "CNH_E" ? "CNH-e digital (documento Gov.br)" : docSubtipo === "CNH_FOTO" ? "foto da CNH física" : "documento de identidade";
  const docNome  = (merged.nome  as string | undefined) ?? null;
  const docCpf   = (merged.cpf   as string | undefined) ?? null;
  const docRg    = (merged.rg    as string | undefined) ?? null;
  const docOrgao = (merged.orgao_emissor_rg as string | undefined) ?? null;
  const extraidos = [docNome ? `nome: ${docNome}` : null, docCpf ? `CPF: ${docCpf}` : null, docRg ? `RG: ${docRg}${docOrgao ? ` ${docOrgao}` : ""}` : null].filter(Boolean) as string[];
  const faltando  = [!docNome ? "nome completo" : null, !docCpf ? "CPF" : null, !docRg ? "RG (número de identidade, não de habilitação)" : null].filter(Boolean) as string[];
  const proibicaoTecnica =
    `\nLinguagem: não use termos técnicos como "sistema", "extração", "leitura automática", "não consegui", "erro", "falha".` +
    ` Em vez de "digite", use "pode me confirmar", "qual é seu", "me fala".` +
    ` Fale como uma atendente humana que está olhando o documento na tela.`;
  if (extraidos.length > 0) {
    const instrucaoCpfFaltando = !docCpf
      ? `\nO CPF não foi encontrado no documento. Não afirme ter o CPF, não confirme dígitos ou terminação. Pergunte diretamente: "Seu CPF não apareceu aqui — pode me informar?".`
      : "";
    return `\n\n${rotuloDoc.toUpperCase()} recebido — dados confirmados: ${extraidos.join(", ")}.` +
      `\nAgradeça o envio de forma natural e confirme exatamente estes dados com o cliente.` +
      (faltando.length ? `\nPreciso ainda de: ${faltando.join(", ")}. Peça de forma conversacional e natural.` : "") +
      instrucaoCpfFaltando +
      `\nNÃO mencione nem peça: número de registro CNH, categoria (A/B/C/D/E), validade da CNH, foto do verso da CNH.` +
      `\nA frente da CNH já contém todos os dados necessários — não há informação adicional no verso.` +
      proibicaoTecnica + instrucaoLink;
  }
  return `\n\n${rotuloDoc.toUpperCase()} recebido.` +
    `\nAgradeça o envio de forma natural. Em seguida, peça de forma conversacional o CPF e o RG.` +
    `\nExemplo de resposta natural: "Recebi sua CNH! Pode me confirmar seu CPF e o número do RG para fecharmos o contrato?"` +
    `\nNÃO mencione nem peça: número de registro CNH, categoria, validade da habilitação, foto do verso da CNH.` +
    `\nA frente da CNH já contém todos os dados necessários.` + proibicaoTecnica + instrucaoLink;
}

// ── Private: step type helpers ────────────────────────────────────────────────

const DOCUMENT_STEP_CHAVES = new Set([
  "solicitar_cnh", "solicitar_rg", "solicitar_ctps", "solicitar_comprovante_endereco",
  "cnh", "rg", "ctps", "comprovante_endereco",
]);

function isDocumentStep(chave: string | null | undefined, stepType: string | null | undefined): boolean {
  return stepType === "document" || (!!chave && DOCUMENT_STEP_CHAVES.has(chave));
}

// ── Public ─────────────────────────────────────────────────────────────────────

export function buildSystemPrompt(ctx: SystemPromptContext): string {
  const { personaChave, personaNome, merged, vinculos, vinculosOk, vinculosTodosPrescritos } = ctx;

  let userSystem = ctx.instrucaoComportamento
    .replace("{INSTRUÇÃO BASE}", ctx.instrucaoBase)
    .replace(/\{nome_persona\}/g, personaNome)
    .replace(/\{nome_advogado\}/g, ctx.advogadoNome ?? personaNome)
    .replace(/\{nome_escritorio\}/g, ctx.escritorioNome ?? "escritório");
  if (!userSystem.includes("DATA E HORA ATUAL")) userSystem = ctx.instrucaoBase + "\n\n" + userSystem;

  // coleta_docs uses a visible name prefix on every message so the lead always knows who's writing.
  const identidadeExtra = personaChave === "coleta_docs"
    ? ` Sempre inicie cada mensagem com *${personaNome}:* seguido de uma quebra de linha, depois o conteúdo. Exemplo: "*${personaNome}:*\\nOlá, Pedro! Qual é o seu CPF?"`
    : ` Não escreva seu nome no início da resposta. Escreva apenas o conteúdo da mensagem, sem cabeçalho, sem nome, sem asteriscos.`;
  userSystem +=
    `\n\nIdentidade: você é ${personaNome}.${identidadeExtra}` +
    `\n\nSe o cliente perguntar se você é robô, IA, bot, ou pedir CNPJ/endereço/legitimidade do escritório: mantenha a persona e RESPONDA a preocupação com dados reais. NUNCA diga "isso não importa agora" ou desvie — isso parece golpe. Diga que é a ${personaNome}, da equipe do escritório, que a preocupação é válida, e forneça os dados de legitimidade disponíveis (CNPJ, cidade, advogado responsável). Se não tiver os dados, oriente a verificar na OAB e ofereça passar o contato do advogado.`;

  if (personaChave === "assistente") {
    userSystem +=
      `\n\nOrientações para a assistente (${personaNome}):` +
      `\n- Uma pergunta por mensagem. Nada mais.` +
      `\n- Mensagem curta: no máximo 1 frase de 15 palavras.` +
      `\n- Não resuma, não repita nem comente o que o cliente disse. Vá direto à próxima pergunta.` +
      `\n- EXCEÇÃO: se o cliente fizer uma pergunta de esclarecimento ("como assim?", "o que é isso?", "não entendi") ou demonstrar confusão, responda brevemente em 1 frase simples e depois faça a pergunta atual novamente ou prossiga. Exemplo: "Pressão é quando o patrão ameaça, obriga a trabalhar em condições ruins ou desconta algo indevido. Aconteceu isso com você?"` +
      `\n- Evite "Entendi", "Certo", "Ok", "Que situação difícil" ou qualquer frase de validação. Só a pergunta.` +
      `\n- Não explique por que está perguntando nem dê contexto jurídico.` +
      `\n- Exemplo correto: "Recebia algum valor fora do holerite, como Pamcard ou dinheiro?"` +
      `\n- Exemplo incorreto: "Entendi. Isso significa que você trabalhava muitas horas. Recebia algum valor fora do holerite?"` +
      `\n- Siga a ordem das perguntas de qualificação. Não pule etapas.` +
      `\n- Frota: pergunte sobre frota apenas se o cliente for autônomo, agregado ou TAC. Para CLT, pule direto para horas extras.` +
      `\n- Encerramento: não diga "Anotei tudo" ou "Vou passar pro time" enquanto houver próxima pergunta pendente neste prompt.` +
      `\n- Empregos anteriores: se o emprego mais recente durou menos de 2 anos, pergunte sobre empregos anteriores antes de encerrar.` +
      `\n- Frustração: se o cliente reclamar de perguntas repetidas, faça apenas 1 frase curta pedindo desculpas + a pergunta pendente.` +
      `\n- OBJEÇÕES/RECEIOS: se o cliente demonstrar desconfiança, medo, pressa, recusa ou dúvida sobre custo/golpe/demora/reunião, NUNCA ignore. Responda em 1 frase curta e tranquilizadora (o sistema reenvia a pergunta pendente em seguida). Respostas-padrão:` +
      `\n   • custo/dinheiro/"caro" → "Não tem custo nenhum adiantado — o escritório só recebe se você ganhar."` +
      `\n   • golpe/desconfiança/"é confiável?" → "Somos a Rocha Amorim Pires Advogados, OAB/DF, escritório regular — pode conferir no site da OAB."` +
      `\n   • medo da empresa/retaliação → "Fica tudo em segredo de justiça — na prática a empresa nem fica sabendo."` +
      `\n   • demora/"não vale a pena"/"não dá em nada" → "Hoje é tudo online e rápido, e você não paga nada pra tentar."` +
      `\n   • "vou pensar"/"falar com a esposa"/"não sei" → "Sem compromisso nenhum — é só uma conversa pra entender seu caso."` +
      `\n   • "resolve por aqui"/"não quero reunião" → "A conversa é rápida e por vídeo, só pra a advogada entender seu caso direitinho."` +
      `\n   NUNCA prometa valores, prazos ou garantia de resultado. NÃO faça você mesma a próxima pergunta — o sistema a envia automaticamente.`;
  }

  if (personaChave === "advogado") {
    const isLlmGenerated = ctx.advFlowStepType === "llm_generated";
    userSystem +=
      `\n\nOrientações para a advogada (${personaNome}):` +
      `\n- Documentos são opcionais: se o cliente informar RG, endereço ou qualquer outro dado por escrito no chat, aceite e avance. Não insista em foto ou documento se o cliente já forneceu o dado verbalmente.` +
      `\n- Se o cliente enviar uma foto ou documento, use os dados extraídos. Se não enviar e informar por escrito, aceite da mesma forma.` +
      `\n- Não repita a mesma pergunta se o cliente já respondeu o dado solicitado, ainda que de forma verbal.` +
      (isLlmGenerated
        ? `\n- Este passo exige uma resposta completa — escreva o conteúdo inteiro conforme a estrutura definida. Não resuma nem encurte.`
        : `\n- Máximo 3 frases por mensagem. Seja direta e calorosa — fale como advogada humana, não como formulário.`);
  }

  userSystem +=
    `\n\nSobre ligações: o atendimento é 100% via WhatsApp. Não prometa ligação telefônica.` +
    ` Se o cliente pedir ligação, diga apenas: "Por enquanto atendo pelo WhatsApp mesmo — pode continuar aqui!" e siga com a próxima pergunta ou informação.`;

  userSystem +=
    `\n\nSobre links: não inclua links, URLs ou placeholders de link no corpo da resposta.` +
    ` Links de assinatura, contrato e procuração são enviados pelo sistema em mensagens separadas automaticamente.` +
    ` Se o cliente pedir para reenviar o link, diga apenas: "Aqui vão os links novamente!" — o sistema envia na sequência, um por documento.` +
    ` Cada documento tem seu próprio link — contrato e procuração não estão no mesmo link.`;

  if (ctx.documentosEnviados) {
    if (ctx.isDocAnalitico) {
      // Analytical document (rescisão, holerite, cálculo, contrato, etc.) — any persona
      userSystem +=
        `\n\nDOCUMENTO TRABALHISTA RECEBIDO — o conteúdo extraído automaticamente está na última mensagem do usuário.` +
        `\nTAREFA PRINCIPAL AGORA: analise o documento de forma abrangente e responda com clareza. Guia:` +
        `\n- Rescisão/TRCT: identifique verbas pagas, aponte irregularidades ou direitos não contemplados.` +
        `\n- Holerite: analise salário base, descontos, horas extras, adicionais noturno/periculosidade.` +
        `\n- Cálculo trabalhista ou proposta de acordo: explique os valores e teses de forma acessível.` +
        `\n- Contrato de trabalho: destaque cláusulas relevantes ao caso.` +
        `\n- Outro documento: resuma o conteúdo e aponte o que for relevante para o caso.` +
        `\nUse linguagem simples de WhatsApp (3-5 frases). Pergunte se ficou claro ou se tem dúvidas sobre algum ponto específico.` +
        `\nNÃO force perguntas de qualificação — o foco desta resposta é a análise do documento enviado.`;
    } else if (personaChave === "advogado" || personaChave === "secretaria") {
      userSystem += buildDocFeedback(ctx);
    } else {
      // Assistente (Ana) com documento de identidade: just acknowledge — CPF/RG é papel de Daniela.
      userSystem += `\n\nO cliente enviou um documento ou imagem. Agradeça o recebimento de forma breve e natural e continue normalmente com o fluxo de qualificação. NÃO peça CPF, RG ou qualquer dado de identificação pessoal — isso é papel da advogada especialista mais à frente.`;
    }
  }

  if (personaChave !== "assistente" && ctx.perguntasDeterministicas.length > 0 && !vinculosTodosPrescritos) {
    userSystem += `\n\nINFORMAÇÕES AINDA NÃO COLETADAS:\n${ctx.perguntasDeterministicas.join("\n")}`;
  }

  if (personaChave === "assistente" && ctx.personaInstrucoes) {
    userSystem += `\n\n${ctx.personaInstrucoes}`;
  }

  if (ctx.nextQDeterministico) {
    if (ctx.advFlowStepType === "llm_generated" || ctx.advFlowStepType === "llm_gate" || ctx.advFlowStepType === "gate") {
      // Substitute {{campo}} placeholders from merged so the LLM never sees raw template variables
      const instrucaoTexto = ctx.nextQDeterministico.replace(/\{\{(\w+)\}\}/g, (_: string, key: string) => {
        if (key === "resposta_lead") return ctx.incomingText?.trim() || "[sem resposta do lead]";
        const val = merged[key];
        return val != null && String(val).trim() !== "" ? String(val) : (key === "empresa" ? "a empresa" : key === "nome" ? "o cliente" : `[${key}]`);
      });
      let instrucaoLlm = `\n\nInstruções para este turno:\n${instrucaoTexto}\nElabore com base nos dados reais do lead. Não peça documentos nem colete dados pessoais nesta resposta.`;
      if (ctx.valueInjection) instrucaoLlm += `\n\n${ctx.valueInjection}`;
      userSystem += instrucaoLlm;
    } else {
      const docStep = isDocumentStep(ctx.advFlowNextStepChave, ctx.advFlowStepType);
      const campoVal = ctx.advFlowCampoColetar ? merged[ctx.advFlowCampoColetar] : undefined;
      const campoJaColetado = !docStep && ctx.advFlowCampoColetar &&
        campoVal != null && campoVal !== "";
      if (campoJaColetado) {
        userSystem += `\n\nO campo "${ctx.advFlowCampoColetar}" já foi coletado: ${campoVal}. Use esse valor. NÃO peça novamente. Confirme brevemente e avance para o próximo assunto.`;
      } else if (personaChave === "assistente" && !ctx.leadFezPerguntaInesperada) {
        userSystem += `\n\nPRÓXIMA MENSAGEM (envie exatamente este texto, sem modificar ou parafrasear): ${ctx.nextQDeterministico}`;
      } else {
        // When lead asked an off-flow question: LLM answers ONLY the question (briefly).
        // The deterministic next question is appended automatically as a second bubble by stage-engine.
        // Instructing the LLM to include it here causes double-sending.
        userSystem += `\n\nResponda APENAS a dúvida acima, de forma breve e direta. NÃO faça perguntas nem mencione o próximo assunto — o sistema enviará a próxima pergunta automaticamente.`;
      }
    }
  }

  if (vinculosOk && vinculos.length > 0) {
    userSystem += `\n\nVÍNCULOS COLETADOS (${vinculos.length}):\n${vinculos.map((v, i) => `${i + 1}. ${v.empresa ?? "?"} — ${v.funcao ?? "?"} — saída: ${v.saida ?? "?"}`).join("\n")}`;
  }

  if (personaChave === "secretaria" && merged._reuniao_criada) {
    userSystem +=
      `\n\n✅ REUNIÃO CRIADA COM SUCESSO — O link de acesso já foi enviado ao cliente em mensagem separada.` +
      ` Confirme de forma natural que a reunião está marcada para "${merged.horario_reuniao ?? "o horário combinado"}" e que o link já foi enviado aqui pelo WhatsApp.` +
      ` NÃO repita o link — ele foi enviado numa mensagem separada pelo sistema.`;
  }

  if ((personaChave === "advogado" || personaChave === "calculo") && merged._reuniao_criada) {
    userSystem +=
      `\n\n✅ REUNIÃO JÁ MARCADA — A reunião com o cliente está confirmada para ${merged.horario_reuniao ?? "o horário combinado"}.` +
      ` Você entra em contato APÓS a reunião já estar agendada.` +
      ` NÃO peça para a ${ctx.assistenteNome ?? "assistente"} ou secretária agendar novamente. NÃO sugira marcar reunião — ela já está marcada.` +
      ` Pode referenciar a reunião naturalmente (ex: "até nossa reunião de ${merged.horario_reuniao ?? "quinta"}").`;
  }

  if (vinculosTodosPrescritos) {
    userSystem += `\n\nATENÇÃO — PRAZO PRESCRICIONAL TRABALHISTA VENCIDO: O emprego mais recente do cliente foi encerrado há mais de 2 anos. Pelo art. 11 da CLT, o prazo de 2 anos para ajuizar ação trabalhista já expirou. As pretensões trabalhistas comuns (horas extras, rescisão indevida, FGTS, adicionais, 13º, férias, etc.) estão PRESCRITAS e não podem ser ajuizadas.

EXCEÇÃO CRÍTICA — ACIDENTE DO TRABALHO COM INCAPACIDADE PERMANENTE: Se o cliente mencionou acidente de trabalho ou doença ocupacional que causou incapacidade permanente (ex: perda de movimentos, amputação, paralisia, invalidez total ou parcial), a pretensão à PENSÃO VITALÍCIA (art. 950 do Código Civil) e à indenização por danos morais decorrentes do acidente NÃO segue o prazo da CLT. O STJ entende que a pensão alimentar por incapacidade permanente é imprescritível ou segue o prazo de 3 anos do art. 206, §3°, V do CC a partir da data do evento danoso — o que pode ainda estar dentro do prazo.

Instrução obrigatória:
- Para as verbas trabalhistas comuns (horas extras, rescisão, FGTS, etc.): informe com empatia que essas pretensões estão prescritas e não podem mais ser ajuizadas pelo prazo da CLT.
- Se o cliente mencionou acidente com incapacidade permanente: NÃO encerre a conversa. Analise se há base para ação de responsabilidade civil do empregador por danos materiais (pensão vitalícia proporcional à perda da capacidade de trabalho) e danos morais. Informe ao cliente que, embora as verbas trabalhistas comuns estejam prescritas, o direito à pensão vitalícia e à indenização pelo acidente pode ainda estar dentro do prazo e merece análise aprofundada. Prossiga qualificando esse ponto.
- Se NÃO houve acidente com incapacidade permanente: encerre a conversa de forma acolhedora, sem prometer nada.`;
  }

  // Pre-filled data from meeting transcription or document OCR — show explicitly so LLM can
  // confirm briefly and skip collecting those fields again.
  if (personaChave === "advogado" || personaChave === "secretaria") {
    const pfEntries = Object.entries(ctx.iaFlowStepData)
      .filter(([k]) => k.startsWith("_pf_"))
      .map(([k, v]) => `- ${k.replace("_pf_", "")}: ${v}`);
    if (pfEntries.length > 0) {
      const pfNome = ctx.iaFlowStepData._pf_nome as string | undefined;
      userSystem +=
        `\n\nDADOS JÁ OBTIDOS (da reunião ou documentos — NÃO pergunte esses campos):\n${pfEntries.join("\n")}` +
        `\nNa primeira mensagem desta coleta, confirme esses dados brevemente e de forma natural` +
        (pfNome ? ` (ex: "Você é ${pfNome}, né?")` : "") +
        ` e vá direto para os campos que faltam.`;
    }
  }

  const dadosKeys = Object.keys(merged).filter(k => !k.startsWith("_") && k !== "vinculos");
  if (dadosKeys.length > 0) {
    const dadosBasicos = Object.fromEntries(dadosKeys.map(k => [k, merged[k]]));
    userSystem += `\n\nDADOS BÁSICOS COLETADOS:\n${JSON.stringify(dadosBasicos, null, 2)}`;
    // CPF validation/anti-hallucination: only relevant for advogado persona (Ana doesn't collect CPF)
    if (personaChave === "advogado") {
      const cpfConfirmado = typeof merged.cpf === "string" && validarCPF(merged.cpf) ? merged.cpf : null;
      if (cpfConfirmado) {
        userSystem += `\n\nIMPORTANTE — CPF CONFIRMADO: O CPF do cliente é ${cpfConfirmado} (já registrado e validado). NÃO questione este CPF, NÃO mencione outros números que possam ter aparecido no documento. Trate este CPF como definitivo.`;
      } else {
        userSystem +=
          `\n\nO CPF do cliente ainda não está registrado.` +
          ` Não afirme ter o CPF. Não confirme terminações, dígitos ou qualquer número.` +
          ` Não diga "anotei seu CPF", "seu CPF está registrado" ou "já tenho seu CPF".` +
          ` Se o cliente perguntar "qual meu CPF?", responda: "Ainda não tenho seu CPF registrado aqui — pode me informar agora?" e aguarde.`;
      }
    }
  }

  if (typeof merged.nome === "string") userSystem += `\n\nNome do cliente: ${merged.nome}`;

  if (ctx.frustrationInjection) userSystem += "\n\n" + ctx.frustrationInjection;

  if (ctx.identityContextInject) {
    userSystem += `\n\nDADOS DE LEGITIMIDADE DO ESCRITÓRIO (use para responder à dúvida do lead sobre confiança/segurança/golpe):\n${ctx.identityContextInject}`;
  }

  if (personaChave === "advogado") {
    if (ctx.advFlowStepType === "llm_generated") {
      // Parecer step: wrap the entire prompt with format overrides at BOTH ends.
      // The persona (47KB) has "Máximo 3 frases" — this sandwich ensures Claude sees
      // the explicit format instruction first AND last, overriding the persona rule.
      const handoff = ctx.handoffSnapshot ? ctx.handoffSnapshot + "\n\n" : "";
      userSystem = handoff + userSystem;
      userSystem += `\n\n${ctx.personaInstrucoes}`;
    } else {
      if (ctx.handoffSnapshot) userSystem = ctx.handoffSnapshot + "\n\n" + userSystem;
      userSystem += `\n\n${ctx.personaInstrucoes}`;
    }
  }

  if (personaChave === "secretaria" && ctx.personaInstrucoes) {
    userSystem += `\n\n${ctx.personaInstrucoes}`;
  }

  return userSystem;
}
