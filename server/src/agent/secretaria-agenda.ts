/**
 * Secretaria Agenda — queries available AgendaSlot records for a project,
 * formats them for presentation in the WhatsApp flow, and reserves them
 * when a meeting is created.
 */

import { prisma } from "../db.js";
import { extractJson } from "./llm.js";

export interface SlotDisponivel {
  id: string;
  inicio: Date;
  fim: Date;
  label: string; // e.g. "Segunda-feira (26/05) às 10h"
}

const DIAS_PT = [
  "Domingo", "Segunda-feira", "Terça-feira", "Quarta-feira",
  "Quinta-feira", "Sexta-feira", "Sábado",
];

function toBrazilTime(utcDate: Date): Date {
  // Brazil: UTC-3 (no DST since 2019)
  return new Date(utcDate.getTime() - 3 * 60 * 60 * 1000);
}

function formatSlotLabel(inicio: Date): string {
  const local = toBrazilTime(inicio);
  const dia = DIAS_PT[local.getUTCDay()];
  const dd = String(local.getUTCDate()).padStart(2, "0");
  const mm = String(local.getUTCMonth() + 1).padStart(2, "0");
  const hh = String(local.getUTCHours()).padStart(2, "0");
  const mn = String(local.getUTCMinutes()).padStart(2, "0");
  return mn === "00"
    ? `${dia} (${dd}/${mm}) às ${hh}h`
    : `${dia} (${dd}/${mm}) às ${hh}h${mn}`;
}

/**
 * Taxa de comparecimento por faixa de horário, medida sobre 214 agendamentos reais
 * (planilha da equipe, 05/06 a 17/09/2026 — auditoria de 26/08). Carreteiro de manhã cedo
 * está saindo ou carregando: a faixa das 8h às 10h perde metade das reuniões marcadas.
 *
 *   08-10h  48,8%   (n=41)  ← pior
 *   10-12h  68,6%   (n=51)  ← melhor
 *   12-14h  71,4%   (n=7)   amostra pequena, tratada como média
 *   14-16h  54,7%   (n=53)
 *   16-18h  60,5%   (n=43)
 *   18-21h  68,4%   (n=19)
 *
 * Usado só para ORDENAR o que já está publicado — nenhum horário é escondido do lead.
 * Rever quando houver mais dados; a fonte é a planilha, não o banco.
 */
export function pesoComparecimento(inicio: Date): number {
  const h = Number(new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo", hour: "2-digit", hour12: false,
  }).format(inicio));
  if (h < 10) return 0.49;
  if (h < 12) return 0.69;
  if (h < 14) return 0.61;   // n=7: puxado para a média em vez de confiar no 71%
  if (h < 16) return 0.55;
  if (h < 18) return 0.61;
  return 0.68;
}

export async function getSlotsDisponiveis(
  projetoId: string,
  quantidade = 8,
): Promise<SlotDisponivel[]> {
  const agora = new Date();
  const limite = new Date(agora.getTime() + 21 * 24 * 60 * 60 * 1000);

  // Busca um lote maior do que vai oferecer, para ter o que priorizar.
  const rows = await (prisma as any).agendaSlot.findMany({
    where: {
      projetoId,
      disponivel: true,
      reservadoPara: null,
      inicio: { gt: agora, lte: limite },
    },
    orderBy: { inicio: "asc" },
    take: Math.max(quantidade * 4, 24),
    select: { id: true, inicio: true, fim: true },
  });

  // Ordena por comparecimento esperado, com desempate pela proximidade — oferecer um
  // horário bom daqui a duas semanas seria pior que um razoável amanhã.
  const t0 = agora.getTime();
  const escolhidos = [...rows]
    .sort((a: any, b: any) => {
      const pa = pesoComparecimento(a.inicio) - (a.inicio.getTime() - t0) / (21 * 24 * 3600 * 1000) * 0.25;
      const pb = pesoComparecimento(b.inicio) - (b.inicio.getTime() - t0) / (21 * 24 * 3600 * 1000) * 0.25;
      return pb - pa;
    })
    .slice(0, quantidade)
    .sort((a: any, b: any) => a.inicio.getTime() - b.inicio.getTime());  // exibir em ordem cronológica

  return escolhidos.map((r: any) => ({
    id: r.id,
    inicio: r.inicio,
    fim: r.fim,
    label: formatSlotLabel(r.inicio),
  }));
}

const OBJECTIONS_BLOCK = `
SE O LEAD FIZER PERGUNTAS OU LEVANTAR DÚVIDAS ANTES DE CONFIRMAR O HORÁRIO:
Responda brevemente (1-2 frases) com as respostas abaixo e volte ao agendamento.
Você não é advogada — não entre em detalhes técnicos. Só responda, depois confirme o horário.

• "A empresa vai saber?" / "Vou queimar meu nome?" →
  O escritório pede segredo de justiça e exclusão do nome no Jusbrasil e Escavador — na prática, ninguém encontra em busca pública. E a reunião não abre nenhum processo, é só uma conversa.

• "Vou ter que ir ao fórum?" / "Preciso parar o caminhão?" →
  Não precisa — hoje as audiências são por vídeo. O advogado acompanha tudo.

• "Quanto vou pagar?" / "Tem custo?" / "E se eu perder?" →
  Zero adiantado, zero de risco. O escritório só cobra 30% se ganhar. Se não ganhar, você não paga nada.

• "Preciso levar documento?" / "Tenho que me preparar?" →
  Não precisa levar nada — é só uma conversa para tirar dúvidas e entender o caso.

• "Não conheço o escritório" / "É confiável?" →
  Especializado em direito do trabalhador de estrada, já resolveu casos acima de R$ 1,5 milhão. Contrato claro, sem letra miúda.

• "Ainda não sei" / "Preciso pensar" / "Não sei se quero" →
  Sem compromisso nenhum — a reunião é só pra entender seu caso e te dizer quanto você tem a receber. Vamos garantir? Qual horário fica melhor?

APÓS RESPONDER QUALQUER DÚVIDA: volte imediatamente ao agendamento, SEMPRE terminando com uma pergunta oferecendo um horário.
NUNCA prometa valores específicos do caso, prazos de recebimento ou garanta resultado.
NUNCA discuta detalhes jurídicos além do que está listado acima — "a advogada esclarece na reunião".

POLÍTICA DE PERSISTÊNCIA (CRÍTICA): este lead JÁ foi qualificado e tem um caso com potencial real. Seu único objetivo é marcar a reunião.
- NUNCA encerre a conversa nem se despeça por conta própria. Seguir insistindo é o comportamento CORRETO e esperado — só pare se o lead deixar de responder.
- TODA mensagem sua DEVE terminar com uma pergunta oferecendo um horário específico da lista (ex: "Bora fechar na terça às 09h?"). Mensagem sua que não termina oferecendo horário é ERRO.
- FRASES TERMINANTEMENTE PROIBIDAS (nunca use nenhuma variação): "respeito sua decisão", "a porta está/tá aberta", "se mudar de ideia", "quando você quiser", "é só me chamar", "fico à disposição", "vou parar por aqui", "desculpa se fui insistente", "tenha um bom dia", "qualquer coisa, tô por aqui". Essas frases entregam o lead e estão proibidas.
- "para de insistir", "não adianta insistir", "resolve por aqui", "não quero", "não vou" NÃO são autorização para parar. Acolha com bom humor em meia frase, escale o argumento e re-ofereça o horário na MESMA mensagem.
- "resolve por aqui no WhatsApp" → explique que a análise do caso precisa da advogada na reunião (rápida, online), e re-ofereça o horário. NUNCA ofereça resolver tudo por chat.`;

/**
 * Instrução de ESCALADA de venda no agendamento: a cada recusa do lead em marcar a reunião,
 * sobe o nível do argumento. O SDR NUNCA capitula — só "desiste" quando o lead some/bloqueia.
 * `recusas` = quantas vezes o lead já recusou/desviou após os horários terem sido oferecidos (1-based).
 */
export function buildEscaladaAgendamento(recusas: number): string {
  const argumentos: string[] = [
    // nível 1
    `O lead resistiu à reunião pela 1ª vez. NÃO desista. Acolha em 1 frase e reforce o BENEFÍCIO CONCRETO: "A reunião é rapidinha (uns 20 min), online, sem sair de casa, e é nela que a advogada te diz exatamente quanto você tem a receber." Termine oferecendo um horário da lista.`,
    // nível 2
    `O lead resistiu pela 2ª vez. Suba o argumento com PROVA SOCIAL + valor: "Olha, gente exatamente na sua situação já recuperou valores altos — teve caso acima de R$ 1,5 milhão. Vale demais os 20 minutos." Termine oferecendo um horário específico.`,
    // nível 3
    `O lead resistiu pela 3ª vez. Use URGÊNCIA / CUSTO DE NÃO AGIR: "Tem um detalhe importante: existe prazo legal pra entrar com a ação (prescrição) — cada mês que passa pode ser dinheiro seu indo embora. A análise é gratuita, bora pelo menos garantir ela?" Termine oferecendo um horário.`,
    // nível 4
    `O lead resistiu pela 4ª vez. Reduza a fricção ao mínimo e reforce que é SÓ uma conversa, zero compromisso e zero custo: "Não tem pegadinha nem compromisso — se depois você não quiser seguir, tudo bem. Mas não deixa de ouvir o que a advogada tem pra te falar. Me diz só um horário que eu já reservo." Termine oferecendo um horário.`,
  ];
  const ultimo = `O lead segue resistindo (${recusas}ª vez), inclusive com frases como "para de insistir" ou "não vou". Isso NÃO é autorização para parar. CONTINUE insistindo com simpatia e bom humor, SEM se despedir e SEM repetir o argumento da mensagem anterior — alterne entre: valor a receber, prova social (casos de R$ 1,5 mi), prazo/prescrição, facilidade (online, 20 min, pode ser na viagem). SEMPRE termine oferecendo um horário específico da lista. Só pare quando o lead deixar de responder.`;
  const idx = Math.min(recusas, argumentos.length) - 1;
  const corpo = idx >= 0 && recusas <= argumentos.length ? argumentos[idx] : ultimo;
  return [
    `=== ESCALADA DE AGENDAMENTO (recusa nº ${recusas}) ===`,
    corpo,
    `OBRIGATÓRIO: sua resposta DEVE terminar com uma pergunta oferecendo um horário específico da lista. NÃO se despeça, NÃO diga "respeito sua decisão / a porta tá aberta / é só me chamar / fico à disposição". Mesmo diante de "para de insistir" ou "resolve por aqui", acolha em meia frase e re-ofereça o horário.`,
  ].join("\n");
}

/** Builds the system-prompt block injected into secretaria's instructions. */
export function buildSlotsInstrucoes(slots: SlotDisponivel[], advogadoNome: string = "a Dra. Daniela"): string {
  if (!slots.length) {
    return [
      `⚠️ HORÁRIOS DISPONÍVEIS NA AGENDA DE ${advogadoNome.toUpperCase()}: NENHUM HORÁRIO PRÉ-CADASTRADO NO MOMENTO.`,
      `CRÍTICO: NÃO invente horários. NÃO mencione qualquer hora específica (ex: 10h, 14h, etc).`,
      `Instrução obrigatória: pergunte ao cliente qual dia e horário seria melhor para ele e diga que a equipe vai confirmar.`,
      `NUNCA diga que vai mandar link nem que a reunião está marcada — nenhuma reunião foi criada.`,
      OBJECTIONS_BLOCK,
    ].join("\n");
  }

  const lista = slots.map((s, i) => `${i + 1}. ${s.label}`).join("\n");

  return [
    `HORÁRIOS DISPONÍVEIS NA AGENDA DE ${advogadoNome.toUpperCase()}:`,
    lista,
    ``,
    `INSTRUÇÕES OBRIGATÓRIAS:`,
    `- Apresente SEMPRE estes horários numerados ao cliente, assim que possível.`,
    `- Exemplo: "Tenho esses horários disponíveis:\n1. Segunda-feira (26/05) às 10h\n2. ..."`,
    `- Quando o cliente confirmar um número ou descrever o horário, confirme o horário. NÃO fale em link — a confirmação sai pelo sistema.`,
    `- NÃO invente horários que não estejam nesta lista.`,
    `- NÃO pergunte "qual horário você prefere?" sem antes apresentar esta lista.`,
    `- CRÍTICO: Ao confirmar o horário escolhido, copie o nome do dia EXATAMENTE como aparece na lista acima. NUNCA reformule o nome do dia da semana — ex: se a lista diz "Quarta-feira", não escreva "Terça-feira".`,
    OBJECTIONS_BLOCK,
  ].join("\n");
}

/**
 * Renderiza o placeholder {horarios} de uma mensagem QUE VAI PARA O CLIENTE.
 *
 * Com slots → lista numerada. Sem slots → o texto configurado no banco em
 * IaProjetoConfig (categoria "reuniao", chave "agenda_sem_slots_texto"), que
 * SUBSTITUI a mensagem inteira — o template fala "tenho estes horários" e
 * sem horário nenhum o texto ao redor não faz sentido.
 *
 * Nunca injetar aqui instrução de prompt: este retorno é enviado literalmente
 * ao lead (o step é determinístico, não passa pelo LLM).
 */
export async function renderHorarios(
  projetoId: string,
  texto: string,
  slots: SlotDisponivel[],
): Promise<string> {
  if (!texto.includes("{horarios}")) return texto;

  if (slots.length > 0) {
    return texto.replace("{horarios}", slots.map((s, i) => `${i + 1}. ${s.label}`).join("\n"));
  }

  const cfg = await prisma.iaProjetoConfig.findFirst({
    where: { projetoId, categoria: "reuniao", chave: "agenda_sem_slots_texto" },
  }).catch(() => null);
  const configurado = (cfg?.valor ?? "").trim();
  if (configurado) return configurado;

  // Sem config no projeto: nada de texto fixo no código (o antigo prometia um link que
  // nunca era enviado). Vazio → o step não manda texto determinístico e a LLM responde.
  // O correto é cadastrar `agenda_sem_slots_texto` para este projeto.
  console.warn(`[SecretariaAgenda] projeto ${projetoId} sem "agenda_sem_slots_texto" e sem slots — sem texto determinístico`);
  return "";
}

/** Finds which slot the lead's text refers to, using number matching first then LLM. */
export async function encontrarSlotPorTexto(
  projetoId: string,
  horarioTexto: string,
  slots: SlotDisponivel[],
): Promise<SlotDisponivel | null> {
  if (!slots.length) return null;

  // Numeric pick: lead said "1", "2", "3"
  const num = parseInt(horarioTexto.trim().replace(/[^0-9]/g, ""), 10);
  if (!isNaN(num) && num >= 1 && num <= slots.length) {
    return slots[num - 1];
  }

  // LLM-assisted match
  const slotsCtx = slots.map((s, i) => `${i + 1}. "${s.label}" id="${s.id}"`).join("\n");
  try {
    const result = await extractJson<{ slot_numero: number }>({
      projetoId,
      instruction: `O cliente disse: "${horarioTexto}".\nHorários disponíveis:\n${slotsCtx}\n\nQual número de horário o cliente escolheu? Retorne: { "slot_numero": N } onde N é o número (1, 2, …) ou 0 se não identificado.`,
      text: horarioTexto,
      maxTokens: 64,
    });
    const n = result?.slot_numero ?? 0;
    if (n >= 1 && n <= slots.length) return slots[n - 1];
  } catch {
    // fallback: no match
  }

  return null;
}

/** Marks an AgendaSlot as reserved and links it to a SessaoReuniao. */
export async function reservarSlot(
  slotId: string,
  dealId: string,
  reuniaoId: string,
): Promise<void> {
  await (prisma as any).agendaSlot.update({
    where: { id: slotId },
    data: { disponivel: false, reservadoPara: dealId, reuniaoId },
  }).catch((e: any) => console.error(`[SecretariaAgenda] Erro ao reservar slot ${slotId}: ${e.message}`));
}
