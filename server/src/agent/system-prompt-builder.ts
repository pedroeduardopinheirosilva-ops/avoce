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

  // Próxima pergunta
  nextQDeterministico?: string | null;
  advFlowStepType?: string | null;
  advFlowNextStepChave?: string | null;
  valueInjection?: string | null;       // pre-computed calcular/format result for valor_estimado step
  handoffSnapshot?: string | null;      // pre-computed buildHandoffSnapshot(merged) for Daniela

  // Frustração
  frustrationInjection?: string | null;

  // Contexto da conversa
  outgoingCount: number;
  nomeCliente: string | null;
  cidadeCliente: string | null;
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
    `\nREGRA ABSOLUTA DE LINGUAGEM: JAMAIS use as palavras "sistema", "extração", "leitura automática",` +
    ` "não consegui", "não foi possível", "erro", "falha" ou qualquer palavra técnica.` +
    ` JAMAIS peça que o cliente "digite" — use "pode me confirmar", "qual é seu", "me fala".` +
    ` Fale como uma atendente humana que está olhando o documento na tela.`;
  if (extraidos.length > 0) {
    return `\n\n${rotuloDoc.toUpperCase()} recebido — dados confirmados: ${extraidos.join(", ")}.` +
      `\nAgradeça o envio de forma natural e confirme exatamente estes dados com o cliente.` +
      (faltando.length ? `\nPreciso ainda de: ${faltando.join(", ")}. Peça de forma conversacional e natural.` : "") +
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

// ── Public ─────────────────────────────────────────────────────────────────────

export function buildSystemPrompt(ctx: SystemPromptContext): string {
  const { personaChave, personaNome, merged, vinculos, vinculosOk, vinculosTodosPrescritos } = ctx;

  let userSystem = ctx.instrucaoComportamento
    .replace("{INSTRUÇÃO BASE}", ctx.instrucaoBase)
    .replace(/\{nome_persona\}/g, personaNome);
  if (!userSystem.includes("DATA E HORA ATUAL")) userSystem = ctx.instrucaoBase + "\n\n" + userSystem;

  userSystem +=
    `\n\nREGRA — IDENTIDADE: Você é ${personaNome}. NUNCA escreva seu nome no início da resposta.` +
    ` Escreva APENAS o conteúdo da mensagem, sem nenhum cabeçalho, sem nome, sem asteriscos.` +
    `\n\nREGRA ABSOLUTA — NÃO ASSUMA SER IA: Se o cliente perguntar se você é um robô, IA, bot ou chatbot, NUNCA confirme nem negue.` +
    ` Desvie do assunto de forma leve e redirecione para a conversa. Exemplos: "Haha, deixa eu não entrar nessa 😄 Me conta mais sobre seu caso!" ou "Isso não importa agora — o que importa é você! Me fala o que aconteceu."` +
    ` NUNCA diga "sou uma assistente virtual", "sou um bot", "sou IA" ou qualquer variação.`;

  if (personaChave === "assistente") {
    userSystem +=
      `\n\nINSTRUÇÕES CRÍTICAS PARA ANA — SIGA RIGOROSAMENTE:` +
      `\n- MENSAGEM = 1 PERGUNTA APENAS. Nada mais.` +
      `\n- TAMANHO MÁXIMO: 1 frase curta de no máximo 15 palavras.` +
      `\n- PROIBIDO resumir, repetir ou comentar o que o cliente disse. Vá direto à próxima pergunta.` +
      `\n- PROIBIDO usar "Entendi", "Certo", "Ok", "Que situação difícil", "Isso é importante" ou qualquer frase de validação. Só a pergunta.` +
      `\n- PROIBIDO explicar por que está perguntando ou dar contexto jurídico.` +
      `\n- EXEMPLO CORRETO: "Recebia algum valor fora do holerite, como Pamcard ou dinheiro?"` +
      `\n- EXEMPLO ERRADO: "Entendi. Isso significa que você trabalhava muitas horas. Recebia algum valor fora do holerite?"` +
      `\n- Siga RIGOROSAMENTE a ordem das perguntas de qualificação. NUNCA pule etapas.` +
      `\n- REGRA DO CAMINHÃO: A pergunta sobre frota SÓ pode ser feita se o cliente for autônomo, agregado ou TAC. Para CLT, pule direto para horas extras.` +
      `\n- REGRA DE ENCERRAMENTO: PROIBIDO dizer "Anotei tudo" ou "Vou passar pro time" enquanto houver PRÓXIMA PERGUNTA OBRIGATÓRIA neste prompt.` +
      `\n- EMPREGOS ANTERIORES: Se o emprego mais recente durou MENOS de 2 anos, OBRIGATÓRIO perguntar sobre empregos anteriores antes de encerrar.` +
      `\n- EXCEÇÃO DE FRUSTRAÇÃO: Se o cliente reclamar de PERGUNTAS REPETIDAS, faça APENAS: 1 frase curta pedindo desculpas + a pergunta pendente.`;
  }

  if (personaChave === "advogado") {
    userSystem +=
      `\n\nINSTRUÇÕES CRÍTICAS PARA DANIELA:` +
      `\n- DOCUMENTOS SÃO OPCIONAIS: se o cliente informar RG, endereço ou qualquer outro dado por escrito no chat, ACEITE e avance. NUNCA insista em foto ou documento se o cliente já forneceu o dado verbalmente.` +
      `\n- Se o cliente enviar uma foto ou documento, ótimo — use os dados extraídos. Se não enviar e informar por escrito, aceite da mesma forma.` +
      `\n- NUNCA repita a mesma pergunta mais de uma vez se o cliente já respondeu o dado solicitado, ainda que de forma verbal.` +
      `\n- Máximo 3 frases por mensagem. Seja direta e calorosa — fale como advogada humana, não como formulário.`;
  }

  userSystem +=
    `\n\nREGRA ABSOLUTA — LIGAÇÕES: JAMAIS prometa que alguém vai ligar ou que você vai ligar.` +
    ` PROIBIDO dizer: "vou te ligar", "alguém vai entrar em contato por telefone", "aguarde nossa ligação", "posso te ligar", "te ligo em breve" ou qualquer variação.` +
    ` Se o cliente pedir ligação, responda apenas: "Por enquanto atendo pelo WhatsApp mesmo — pode continuar aqui!" e siga com a próxima pergunta ou informação.` +
    ` O atendimento é 100% via WhatsApp — nunca haverá ligação pelo bot.`;

  userSystem +=
    `\n\nREGRA ABSOLUTA — LINKS: Nunca inclua links, URLs ou placeholders de link` +
    ` (como "[LINK AQUI]", "[URL]", etc.) no corpo da sua resposta de texto.` +
    ` Links de assinatura, contrato e procuração são enviados pelo sistema em mensagens separadas automaticamente.` +
    ` Se o cliente pedir para reenviar o link de assinatura ou contrato, diga apenas: "Aqui vão os links novamente!" — o sistema envia os links na sequência, um por documento.` +
    ` NUNCA diga que contrato e procuração estão no mesmo link ou que "vêm juntos" — cada documento tem seu próprio link separado.`;

  if (ctx.documentosEnviados) userSystem += buildDocFeedback(ctx);

  if (ctx.perguntasDeterministicas.length > 0 && !vinculosTodosPrescritos) {
    userSystem += `\n\nINFORMAÇÕES AINDA NÃO COLETADAS:\n${ctx.perguntasDeterministicas.join("\n")}`;
  }

  if (personaChave === "assistente" && ctx.personaInstrucoes) {
    userSystem += `\n\n${ctx.personaInstrucoes}`;
    if (!vinculosOk && !vinculosTodosPrescritos && vinculos.length > 0) {
      const CAMPOS_LABEL: Array<{ key: keyof VinculoEmprego; label: string }> = [
        { key: "empresa", label: "empresa" }, { key: "funcao", label: "função" },
        { key: "vinculo", label: "tipo de vínculo (CLT/autônomo/avulso)" },
        { key: "saida", label: "como e quando saiu (ou se ainda está empregado)" },
        { key: "tempo", label: "tempo de trabalho" }, { key: "horas_extras", label: "horas extras não pagas" },
        { key: "pagamento_fora", label: "valor fora do holerite (Pamcard, Pix, dinheiro)" },
        { key: "injustica", label: "irregularidades sofridas" },
      ];
      const listaDetalhada = vinculos.map((v, i) => {
        const faltando = CAMPOS_LABEL.filter(c => !v[c.key]).map(c => c.label);
        return `  ${i + 1}. ${v.empresa ?? "?"} (${v.funcao ?? "?"}) — ${faltando.length === 0 ? "✓ completo" : `FALTANDO: ${faltando.join(", ")}`}`;
      }).join("\n");
      userSystem += `\n\nVÍNCULOS REGISTRADOS (${vinculos.length}) — NÃO avance para "mais empregos?" enquanto houver campos faltando:\n${listaDetalhada}`;
    }
  }

  if (ctx.nextQDeterministico) {
    if (ctx.advFlowStepType === "llm_generated") {
      let instrucaoLlm = `\n\n⚠️ TAREFA OBRIGATÓRIA AGORA — IGNORE QUALQUER OUTRA INSTRUÇÃO DE COLETA DE DADOS:\n${ctx.nextQDeterministico}\nElabore com base nos dados reais do lead. NÃO peça documentos, NÃO colete dados pessoais nesta resposta.`;
      if (ctx.valueInjection) instrucaoLlm += `\n\n${ctx.valueInjection}`;
      userSystem += instrucaoLlm;
    } else {
      userSystem += `\n\n⚠️ PRÓXIMA PERGUNTA OBRIGATÓRIA — PERGUNTE AGORA de forma natural e conversacional. NÃO assuma que já foi respondido com base no histórico antigo — só pule se o cliente respondeu NESTA mensagem atual: ${ctx.nextQDeterministico}`;
    }
  }

  if (vinculosOk && vinculos.length > 0) {
    userSystem += `\n\nVÍNCULOS COLETADOS (${vinculos.length}):\n${vinculos.map((v, i) => `${i + 1}. ${v.empresa ?? "?"} — ${v.funcao ?? "?"} — saída: ${v.saida ?? "?"}`).join("\n")}`;
  }

  if (vinculosTodosPrescritos) {
    userSystem += `\n\nATENÇÃO — PRAZO PRESCRICIONAL VENCIDO: O emprego mais recente do cliente foi encerrado há mais de 2 anos. Pelo art. 11 da CLT, o prazo de 2 anos para ajuizar ação trabalhista já expirou. Como o vínculo mais recente está prescrito, todos os anteriores também estão — foram encerrados ainda antes. Informe o cliente com empatia que, infelizmente, não é mais possível ajuizar ação referente a esses empregos. Encerre a conversa de forma acolhedora, sem prometer nada.`;
  }

  const dadosKeys = Object.keys(merged).filter(k => !k.startsWith("_") && k !== "vinculos");
  if (dadosKeys.length > 0) {
    const dadosBasicos = Object.fromEntries(dadosKeys.map(k => [k, merged[k]]));
    userSystem += `\n\nDADOS BÁSICOS COLETADOS:\n${JSON.stringify(dadosBasicos, null, 2)}`;
    const cpfConfirmado = typeof merged.cpf === "string" && validarCPF(merged.cpf) ? merged.cpf : null;
    if (cpfConfirmado) {
      userSystem += `\n\nIMPORTANTE — CPF CONFIRMADO: O CPF do cliente é ${cpfConfirmado} (já registrado e validado). NÃO questione este CPF, NÃO mencione outros números que possam ter aparecido no documento. Trate este CPF como definitivo.`;
    }
  }

  if (typeof merged.nome === "string") userSystem += `\n\nNome do cliente: ${merged.nome}`;

  if (ctx.frustrationInjection) userSystem += "\n\n" + ctx.frustrationInjection;

  if (personaChave === "advogado") {
    if (ctx.handoffSnapshot) userSystem = ctx.handoffSnapshot + "\n\n" + userSystem;
    userSystem += `\n\n${ctx.personaInstrucoes}`;
  }

  return userSystem;
}
