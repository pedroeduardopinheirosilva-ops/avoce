/**
 * Persona Router — flow step selection, system prompt base, and deterministic question ordering.
 * Isolated from stage-engine so flow logic can be tested independently.
 */

import { prisma } from "../db.js";
import type { VinculoEmprego } from "./qualification.js";
import { getTempoMinimoGate, getMesesMinimoProjeto, renderNomePlaceholder } from "./gate-evaluator.js";

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

export interface FlowPasso {
  chave: string;
  pergunta: string;
  campoColetar: string | null;
  ordemPadrao: number;
  ativo: boolean;
  skipSe: Record<string, any> | null;
  tipoEspecial: string | null;
}


// In-memory flow cache — keyed by "${projetoId}:${fase}"
const _flowPassosCache: Record<string, { passos: FlowPasso[]; ts: number }> = {};
const FLOW_CACHE_TTL = 2 * 60 * 1000;

export function invalidateFlowCache(projetoId: string) {
  for (const key of Object.keys(_flowPassosCache)) {
    if (key.startsWith(`${projetoId}:`)) delete _flowPassosCache[key];
  }
}

async function getFlowPassos(
  projetoId: string,
  fase: string = "vinculos_loop",
): Promise<FlowPasso[]> {
  const cacheKey = `${projetoId}:${fase}`;
  const cached = _flowPassosCache[cacheKey];
  if (cached && Date.now() - cached.ts < FLOW_CACHE_TTL) return cached.passos;

  const flowStepRows = await prisma.iaFlowStep.findMany({
    where: { projetoId, personaChave: "assistente", fase, ativo: true },
    orderBy: { ordem: "asc" },
  });

  const passos: FlowPasso[] = flowStepRows.map(r => ({
    chave: r.chave,
    pergunta: r.pergunta,
    campoColetar: r.campoColetar ?? null,
    ordemPadrao: r.ordem,
    ativo: r.ativo,
    skipSe: r.skipSe as Record<string, any> | null,
    tipoEspecial: r.stepType === "mais_empregos" ? "mais_empregos"
      : r.stepType === "open_question" ? "open_question"
      : null,
  }));

  _flowPassosCache[cacheKey] = { passos, ts: Date.now() };
  return passos;
}

function shouldSkipPasso(
  passo: FlowPasso,
  vinculo: VinculoEmprego,
  merged?: Record<string, unknown>,
): boolean {
  if (!passo.skipSe) return false;
  const skipSe = passo.skipSe as {
    campo?: string;
    contem_qualquer?: string[];
    ordem_maior_que?: number;
  };

  // Skip if vinculo.ordem > N (used to restrict questions to recent employer only)
  if (skipSe.ordem_maior_que !== undefined && vinculo.ordem > skipSe.ordem_maior_que) return true;

  const { campo, contem_qualquer } = skipSe;
  if (!campo || !Array.isArray(contem_qualquer) || contem_qualquer.length === 0) return false;
  const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const anyMatch = (val: string) => contem_qualquer.some(v => val.includes(norm(v)));

  const valorCampo = norm(String((vinculo as any)[campo] ?? ""));
  if (anyMatch(valorCampo)) return true;

  if (merged && campo === "vinculo") {
    const flatVal = norm(String(merged.vinculo_recente ?? ""));
    if (flatVal && anyMatch(flatVal)) return true;
  }

  return false;
}

export function parseTempToMeses(tempo: string): number {
  if (!tempo) return 999;
  // Normalizar números por extenso
  let t = tempo.toLowerCase()
    .replace(/\bum\b|\buma\b/gi, "1").replace(/\bdois\b|\bduas\b/gi, "2")
    .replace(/\btrês\b|\btres\b/gi, "3").replace(/\bquatro\b/gi, "4")
    .replace(/\bcinco\b/gi, "5").replace(/\bseis\b/gi, "6")
    .replace(/\bsete\b/gi, "7").replace(/\boito\b/gi, "8")
    .replace(/\bnove\b/gi, "9").replace(/\bdez\b/gi, "10")
    .replace(/\bonze\b/gi, "11").replace(/\bdoze\b/gi, "12");
  // "menos de X meses" → X-1 (fica abaixo do limite)
  t = t.replace(/menos\s+de\s+(\d+)/gi, (_, n) => String(parseInt(n) - 1));
  let meses = 0;
  // Aceita decimais com vírgula ou ponto ("1,5 meses", "2.5 anos") — sem isso a regex
  // capturava só o dígito após a vírgula ("1,5 meses" → 5 meses) e o pivot não disparava.
  const num = (s: string) => parseFloat(s.replace(",", "."));
  const anosMatch  = t.match(/(\d+(?:[.,]\d+)?)\s*ano/);
  const mesesMatch = t.match(/(\d+(?:[.,]\d+)?)\s*m[eê]s/);
  const semMatch   = t.match(/(\d+)\s*semana/);
  const diasMatch  = t.match(/(\d+)\s*dia/);
  if (anosMatch)  meses += Math.floor(num(anosMatch[1]) * 12);
  if (mesesMatch) meses += Math.floor(num(mesesMatch[1]));
  if (semMatch && !anosMatch && !mesesMatch) meses += Math.round(parseInt(semMatch[1]) / 4.3);
  if (diasMatch && !anosMatch && !mesesMatch && !semMatch) meses += parseInt(diasMatch[1]) / 30;
  if (!anosMatch && !mesesMatch && !semMatch && !diasMatch) {
    // Intervalo de anos: "de 2020 até janeiro de 2026", "2021 a 2025"
    const yr = t.match(/\b((?:19|20)\d{2})\b[^.]{0,60}?\b((?:19|20)\d{2})\b/);
    if (yr) {
      const y1 = parseInt(yr[1]), y2 = parseInt(yr[2]);
      if (y2 > y1 && (y2 - y1) < 50) return (y2 - y1) * 12;
    }
    if (t.includes("menos") || t.includes("pouco") || t.includes("alguns")) return 6;
    return 999;
  }
  // Alguma unidade foi reconhecida — 0 é resultado válido ("menos de 1 mês" → 0, abaixo do
  // mínimo). Antes, 0 caía no sentinela 999 e um vínculo de dias passava como válido.
  return meses;
}

// ──────────────────────────────────────────────────────────────────────────────
// Fase detection for Daniela
// ──────────────────────────────────────────────────────────────────────────────

export function detectarFaseAtualDaniela(deal: { iaFlowStepChave?: string | null }): "ana" | "advogado_valor" | "advogado_dados" | "advogado_documentos" {
  const step = (deal as any).iaFlowStepChave ?? null;
  if (!step) return "advogado_valor";
  if (["cpf", "nome_completo", "data_nascimento", "endereco", "estado_civil", "profissao"].includes(step)) return "advogado_dados";
  if (["solicitar_cnh", "solicitar_comprovante_endereco", "envio_contrato", "aguardar_assinatura", "confirmacao_final"].includes(step)) return "advogado_documentos";
  return "advogado_valor";
}

// ──────────────────────────────────────────────────────────────────────────────
// System prompt base builder
// ──────────────────────────────────────────────────────────────────────────────

export function buildInstrucaoBase(advogadoNome: string = "o(a) especialista"): string {
  const agora = new Date();
  const hoje = agora.toLocaleDateString("pt-BR", {
    day: "2-digit", month: "long", year: "numeric", timeZone: "America/Sao_Paulo",
  });
  const horaStr = agora.toLocaleTimeString("pt-BR", {
    hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo", hour12: false,
  });
  const hora = parseInt(horaStr.split(":")[0], 10);
  const saudacao = hora >= 5 && hora < 12 ? "bom dia" : hora >= 12 && hora < 18 ? "boa tarde" : "boa noite";

  return `DATA E HORA ATUAL (Brasília): ${hoje}, ${horaStr}h
SAUDAÇÃO CORRETA AGORA: "${saudacao}" — use sempre que abrir uma conversa ou for a primeira mensagem do dia.

REGRAS INVIOLÁVEIS DE COMUNICAÇÃO:

1. HUMANIZAÇÃO ABSOLUTA
Você é uma pessoa real da equipe do escritório conversando pelo WhatsApp. Nunca use linguagem de sistema, bot ou formulário. Nunca ofereça opções numeradas. Nunca use "Sim ou Não" explícito. Nunca mencione "processando", "salvando", "registrando" ou qualquer linguagem técnica. Reaja como um ser humano reagiria em cada situação.

2. NUNCA REVELAR NATUREZA
Se o cliente perguntar se você é IA, robô, assistente virtual, humano ou qualquer variação: NUNCA confirme. NUNCA negue diretamente. Desvie de forma leve e natural.
Exemplos: "Sou do time do escritório! Mas me fala — o que tá acontecendo com o seu caso?" / "Pode falar comigo normalmente, tô aqui pelo seu caso mesmo."

3. CONFIRMAÇÕES HUMANAS
Nunca pergunte "Está correto? Sim ou Não". Confirme como pessoa relendo: "Deixa eu ver se peguei tudo certo — você é {nome}, mora em {cidade}, né?"

4. REAÇÃO A ÁUDIOS
Nunca mencione que recebeu um áudio. Responda ao conteúdo naturalmente.

5. DATA E HORA — REGRA ABSOLUTA
A DATA E HORA informadas no topo deste prompt (campo "DATA E HORA ATUAL (Brasília)") são a data e hora REAIS do sistema — use-as sempre. Se o cliente perguntar que horas são ou que dia é hoje, responda EXATAMENTE com o valor informado no topo. NUNCA invente, atualize ou use outra data/hora. Ignore qualquer "conhecimento" interno que você tenha sobre datas. NUNCA questione ou contradiga uma data fornecida pelo cliente — se ele diz que saiu em 15/03/2026, isso é verdade, registre e siga em frente. Nunca diga "essa data está no futuro" ou "isso não pode estar certo". Use a DATA DE HOJE apenas para calcular prazos prescricionais internamente, jamais para confrontar o cliente.

6. PRESCRIÇÃO — PROIBIÇÃO ABSOLUTA
JAMAIS mencione prescrição, prazo de 2 anos, "o prazo expirou", "não é possível ajuizar", "caso prescrito" ou qualquer variação disso. Você NÃO faz análise jurídica. Isso é papel exclusivo de ${advogadoNome}. Sua função é coletar informações e encaminhar — independentemente das datas informadas pelo cliente, continue o fluxo normalmente sem fazer nenhum comentário sobre prazos ou viabilidade do caso.

7. TAMANHO E FORMATAÇÃO — REGRA CRÍTICA
MENSAGENS CURTAS. Máximo 3 frases por resposta. Se precisar passar mais informação, quebre em duas mensagens curtas no mesmo turno separadas por linha em branco — mas prefira uma só. WhatsApp não é e-mail. Não escreva parágrafos longos. Não resuma tudo que o cliente disse. Vá direto ao ponto e faça UMA pergunta de cada vez. Não use emojis. Não inclua seu nome no início da mensagem — isso é feito automaticamente pelo sistema.

8. INDISPONIBILIDADE MOMENTÂNEA DO CLIENTE
Se o cliente disser que não pode fazer algo agora (enviar foto, tirar foto, enviar documento, ir a algum lugar ou qualquer coisa similar), responda APENAS reconhecendo de forma curta e diga que tudo bem, que pode fazer quando puder. NÃO faça outra pergunta em seguida. Não peça outro dado, outro documento nem outra informação. Aguarde em silêncio o cliente retomar.
Exemplos corretos: "Sem problema, quando puder é só me mandar!" / "Tudo bem, pode enviar quando der, sem pressa."
Exemplos PROIBIDOS: qualquer pergunta nova ou solicitação de outro dado após o cliente dizer que não pode fazer algo agora.

9. DOCUMENTOS RECEBIDOS — LEITURA AUTOMÁTICA
Quando a mensagem começa com "[Documento recebido — dados extraídos]", significa que o sistema JÁ leu e extraiu o texto do documento automaticamente (OCR). O texto completo extraído está logo abaixo dessa linha. VOCÊ DEVE:
  a) Ler o texto extraído e identificar os dados relevantes (nome, CPF, RG, CNH, endereço, data, valor, empresa, etc.)
  b) Apresentar UMA confirmação rápida e humana dos dados encontrados, como: "Peguei sua CNH — número 12345678, categoria B, válida até 15/08/2028. Confere?"
  c) NUNCA pedir para o cliente digitar dados que já estão no documento extraído. Se você conseguiu ler o dado, confirme ele.
  d) Se o texto extraído estiver ilegível ou incompleto para um campo específico, aí sim peça só aquele campo faltante.
Quando a mensagem for "[Cliente enviou um documento/PDF]" ou "[Cliente enviou uma foto/imagem]" (sem dados extraídos), informe gentilmente que não conseguiu abrir o arquivo e peça para reenviar.

REGRA CRÍTICA — CNH DIGITAL É DOCUMENTO VÁLIDO:
A CNH Digital exportada pelo aplicativo "Carteira Digital de Trânsito" (CDT) ou pelo "Gov.br" É a CNH oficial brasileira. O PDF exportado contém TODOS os dados necessários (nome, CPF, número de registro, categoria, validade, data de habilitação). JAMAIS diga que é "só um comprovante de autenticidade" ou peça outro formato. O texto extraído que começa com "REPÚBLICA FEDERATIVA DO BRASIL" e contém "CARTEIRA NACIONAL DE HABILITAÇÃO", "HABILITAÇÃO" ou "CNH" É o documento oficial — leia os dados dele normalmente. Os campos a extrair da CNH: nome completo, CPF, número do registro (1ª CNH ou "Registro nº"), categoria (A, B, C, D, E ou combinações), data de validade, data da 1ª habilitação. Se algum campo apareceu com texto estranho por erro de OCR, tente inferir o valor correto e confirme com o cliente.`.trim();
}

// ──────────────────────────────────────────────────────────────────────────────
// Deterministic question selectors
// ──────────────────────────────────────────────────────────────────────────────

// Template substitution: replaces {{empresa}} with the company name
function sub(pergunta: string, empresa: string | null | undefined): string {
  if (empresa) return pergunta.replace(/\{\{empresa\}\}/g, empresa);
  // Sem empresa conhecida: "Antes da {{empresa}}" → "Antes disso" (evita "Antes da essa empresa").
  return pergunta
    .replace(/\b(da|de|do|na|no)\s+\{\{empresa\}\}/gi, "disso")
    .replace(/\{\{empresa\}\}/g, "essa empresa");
}

export interface VinculoQuestionResult {
  pergunta: string;
  passoChave: string | null;
}

export async function getNextVinculoQuestion(
  projetoId: string,
  merged: Record<string, unknown>,
  vinculos: VinculoEmprego[],
  vinculosOk: boolean,
  vinculosTodosPrescritos: boolean,
  empresasBloqueadas: string[],
): Promise<VinculoQuestionResult | null> {
  if (vinculosOk || vinculosTodosPrescritos) return null;
  // D2 FIX: _mais_empregos_negado NÃO interrompe a coleta de campos do v0.
  // O check foi movido para APÓS o loop de passosNormais — só bloqueia a pergunta
  // mais_empregos quando todos os campos do vínculo atual já foram coletados.
  // Antes, saía imediatamente quando empresa != null, mesmo com vinculo/saida ausentes.

  // Determine which flow to use based on whether we're collecting an anterior employer
  const isAnterior = merged._mais_empregos_confirmado === true || vinculos.some(v => v.ordem > 1);
  const fase = isAnterior ? "vinculos_anterior" : "vinculos_recente";

  const passos = await getFlowPassos(projetoId, fase);
  const passosNormais = passos.filter(p => p.tipoEspecial !== "mais_empregos" && p.campoColetar);
  const passoMaisEmpregos = passos.find(p => p.tipoEspecial === "mais_empregos");

  // Campos that have been asked 2+ times without answer are skipped to avoid loops.
  // Tracked via merged._q_skipped (array of step chaves).
  const qSkipped: string[] = Array.isArray(merged._q_skipped) ? merged._q_skipped as string[] : [];

  const isEmpresaBloqueada = (empresa: string | null | undefined): boolean => {
    if (!empresa || empresasBloqueadas.length === 0) return false;
    const norm = empresa.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
    return empresasBloqueadas.some(b =>
      norm.includes(b.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, ""))
    );
  };

  const ret = (pergunta: string, chave: string | null): VinculoQuestionResult =>
    ({ pergunta, passoChave: chave });

  // Find the target vinculos entry for this phase
  let alvoVinculo: VinculoEmprego | null = null;
  if (!isAnterior) {
    alvoVinculo = vinculos.find(v => v.ordem === 1) ?? null;
  } else {
    const anteriorVinculos = vinculos.filter(v => v.ordem > 1);
    if (anteriorVinculos.length === 0) {
      // mais_empregos confirmado mas sem entrada ainda — pergunta ABERTA primeiro (uma vez),
      // depois a pergunta específica de empresa como resíduo.
      const pOpenAnt = passos.find(p => p.tipoEspecial === "open_question");
      if (pOpenAnt && !qSkipped.includes(pOpenAnt.chave) && merged[`_${pOpenAnt.chave}_enviada`] !== true) {
        merged[`_${pOpenAnt.chave}_enviada`] = true;
        return ret(pOpenAnt.pergunta, pOpenAnt.chave);
      }
      const p0 = passosNormais[0];
      return p0 ? ret(p0.pergunta, p0.chave) : null;
    }
    // Find first incomplete anterior vinculos
    alvoVinculo = anteriorVinculos.find(v =>
      !isEmpresaBloqueada(v.empresa) &&
      passosNormais.some(p => {
        if (qSkipped.includes(p.chave)) return false;
        const campo = p.campoColetar as keyof VinculoEmprego;
        const val = v[campo];
        return (val === undefined || val === null || val === "") && !shouldSkipPasso(p, v, merged);
      })
    ) ?? null;
  }

  // Empresa bloqueada — check abrangente ANTES de qualquer retorno do loop
  // Cobre: alvoVinculo.empresa, vinculos[0] do array passado, merged.empresa_recente/principal
  // (merged.empresa_recente só é sincronizado de vinculos após _vinculos_ok, por isso o fallback duplo)
  if (!isAnterior) {
    const empresaParaBloquear: string | null =
      (alvoVinculo?.empresa ?? null)
      ?? (vinculos.find(v => v.ordem === 1)?.empresa ?? null)
      ?? (Array.isArray(merged.vinculos) ? ((merged.vinculos as any[])[0]?.empresa ?? null) : null)
      ?? (merged.empresa_recente as string | null)
      ?? (merged.empresa_principal as string | null);
    if (empresaParaBloquear && isEmpresaBloqueada(empresaParaBloquear)) {
      // Se lead já negou ter mais empregos → retorna null para que assistente-agents
      // entre no bloco allDone e dispare o gate empresa_bloqueada com forceDescarte.
      // tem_emprego_anterior só conta como negação se a pergunta foi feita de fato
      // (extração pode alucinar false a partir de relatos — caso Nelson 11/06).
      const maisEmpregosNegado = merged._mais_empregos_negado === true
        || (merged._mais_empregos_perguntado === true &&
            (merged.tem_emprego_anterior === false || merged.tem_emprego_anterior === "false"
             || merged.tem_emprego_anterior === "nao" || merged.tem_emprego_anterior === "não"));
      if (maisEmpregosNegado) {
        console.log(`[VinculoFlow] Empresa bloqueada "${empresaParaBloquear}" + mais_empregos negado → null (deixa assistente-agents disparar gate)`);
        return null;
      }
      console.log(`[VinculoFlow] Empresa bloqueada: "${empresaParaBloquear}" — pulando para mais_empregos`);
      return passoMaisEmpregos
        ? ret(sub(passoMaisEmpregos.pergunta, empresaParaBloquear), passoMaisEmpregos.chave)
        : null;
    }
  }

  // Pergunta ABERTA (modo sequencial v2): convite ao relato livre, UMA vez por fase,
  // antes das perguntas específicas. Os campos que o relato cobrir são extraídos pelo
  // processVinculos e somente o RESÍDUO é perguntado individualmente depois.
  // Pulada quando o lead já contou a história espontaneamente (2+ campos narrativos no vínculo).
  const passoOpen = passos.find(p => p.tipoEspecial === "open_question");
  if (passoOpen && !qSkipped.includes(passoOpen.chave)) {
    const flagOpen = `_${passoOpen.chave}_enviada`;
    const camposNarrativos: Array<keyof VinculoEmprego> = ["funcao", "tempo", "saida", "horas_extras", "pagamento_fora", "injustica"];
    const contados = alvoVinculo
      ? camposNarrativos.filter(k => alvoVinculo![k] != null && alvoVinculo![k] !== "").length
      : 0;
    if (merged[flagOpen] !== true && contados < 2) {
      merged[flagOpen] = true; // persistido pelo stage-engine no mesmo turno (flags "_" novas)
      return ret(sub(passoOpen.pergunta, alvoVinculo?.empresa ?? null), passoOpen.chave);
    }
  }

  // No target entry yet → ask first question (respecting skipped steps)
  if (!alvoVinculo) {
    if (!isAnterior) {
      // Autônomo declarado sem nenhuma empresa citada: não há vínculo para detalhar — pergunta
      // direto sobre emprego anterior CLT. A negação seta _mais_empregos_negado e o gate
      // vinculo_invalido descarta (antes: coletava campos de um vínculo inexistente para sempre).
      const semEmpresaCitada = !vinculos.some(v => !!v.empresa);
      const naoCltDeclarado = merged.e_clt === false ||
        (merged.vinculo_recente != null && !/clt|carteira/i.test(String(merged.vinculo_recente)) &&
         /autônomo|autonomo|\bpj\b|cooperado|agregado|conta própria|conta propria|freteiro/i.test(String(merged.vinculo_recente)));
      if (semEmpresaCitada && naoCltDeclarado && passoMaisEmpregos && !qSkipped.includes(passoMaisEmpregos.chave)) {
        if (merged._mais_empregos_negado === true) return null;
        console.log(`[VinculoFlow] Autônomo sem empresa citada → pivot mais_empregos direto`);
        return ret(
          "Entendi! E antes disso, você trabalhou com carteira assinada em alguma empresa nos últimos 2 anos?",
          passoMaisEmpregos.chave,
        );
      }
      const p0 = passosNormais.find(p => !qSkipped.includes(p.chave));
      return p0 ? ret(p0.pergunta, p0.chave) : null;
    }
    // All anterior vinculos complete — ask mais_empregos for another potential employer
    // Se lead já negou ter mais empregos → retorna null para que assistente-agents
    // entre no bloco nenhumVinculoValido e dispare o gate correto.
    const maisEmpregosNegadoAnt = merged._mais_empregos_negado === true
      || (merged._mais_empregos_perguntado === true &&
          (merged.tem_emprego_anterior === false || merged.tem_emprego_anterior === "false"
           || merged.tem_emprego_anterior === "nao" || merged.tem_emprego_anterior === "não"));
    if (maisEmpregosNegadoAnt) {
      console.log(`[VinculoFlow] Todos anteriores completos + mais_empregos negado → null (assistente-agents trata)`);
      return null;
    }
    const ultimoAnterior = vinculos.filter(v => v.ordem > 1).at(-1);
    return passoMaisEmpregos
      ? ret(sub(passoMaisEmpregos.pergunta, ultimoAnterior?.empresa), passoMaisEmpregos.chave)
      : null;
  }

  // Vínculo inválido (muito curto OU não-CLT): pular coleta detalhada e ir direto para mais_empregos.
  // Aplica tanto para emprego recente quanto anterior.
  // mesesMin e mensagem de pivot lidos do gate tempo_minimo do projeto (fallback: 2 meses).
  const gateTempoMinimo = await getTempoMinimoGate(projetoId);
  const mesesMinBase = gateTempoMinimo?.mesesMin ?? 2;
  // CLT/carteira tem prioridade: vínculo misto ("metade CLT, depois PJ") qualifica.
  // RECONHECIMENTO DE VÍNCULO: "informal"/"sem registro"/"PJ forçado" (pejotização) NÃO são não-CLT
  // — motorista subordinado sem carteira qualifica. Só é não-CLT a autonomia real (dono do
  // caminhão: autônomo/agregado/TAC, cooperado, avulso, app).
  const isNaoClt = (vinculo: string | null | undefined) =>
    vinculo != null && !/clt|carteira/i.test(String(vinculo))
    && /autônomo|autonomo|avulso|cooperado|agregado|\btac\b/i.test(String(vinculo));

  if (alvoVinculo.empresa) {
    const tempoMesAlvo = alvoVinculo.tempo ? parseTempToMeses(String(alvoVinculo.tempo)) : null;
    const vinculoCurto  = tempoMesAlvo !== null && tempoMesAlvo < mesesMinBase;
    const vinculoNaoClt = isNaoClt(alvoVinculo.vinculo);

    if ((vinculoCurto || vinculoNaoClt) && passoMaisEmpregos && !qSkipped.includes(passoMaisEmpregos.chave)) {
      const nomeCliente = typeof merged.nome === "string" ? merged.nome.split(" ")[0].trim() : "";
      const pivotMsg = gateTempoMinimo?.mensagemLead
        ? renderNomePlaceholder(gateTempoMinimo.mensagemLead, nomeCliente)
        : sub(passoMaisEmpregos.pergunta, alvoVinculo.empresa);
      return ret(pivotMsg, passoMaisEmpregos.chave);
    }
    // Sem passoMaisEmpregos disponível → encerra coleta deste vínculo
    if ((vinculoCurto || vinculoNaoClt)) return null;
  }

  const SAIDA_INFERIDA = ["saiu", "já saiu", "saiu da empresa", "deixou a empresa", "não trabalha mais"];

  // Iterate flow steps — ask first missing campo (skip already-attempted ones)
  for (const passo of passosNormais) {
    if (qSkipped.includes(passo.chave)) continue;
    const campo = passo.campoColetar as keyof VinculoEmprego;
    const val = alvoVinculo[campo];
    const faltando = val === undefined || val === null || val === ""
      || (campo === "saida" && SAIDA_INFERIDA.includes(String(val).toLowerCase().trim()));
    if (!faltando) continue;
    if (shouldSkipPasso(passo, alvoVinculo, merged)) continue;
    // Caso Nelson 11/06: se o lead JÁ contou a história (função/tempo/saída presentes) e só falta
    // o nome da empresa, o passo de abertura ("Agora me conta do seu emprego...") soa robótico e
    // repetido. Usa o passo direto de empresa (ex: nome_empresa_rec — "Qual era o nome da empresa?").
    if (campo === "empresa" && (alvoVinculo.funcao || alvoVinculo.tempo || alvoVinculo.saida)) {
      const passoDireto = [...passosNormais].reverse().find(p =>
        p.campoColetar === "empresa" && p.chave !== passo.chave && !qSkipped.includes(p.chave));
      if (passoDireto) return ret(sub(passoDireto.pergunta, alvoVinculo.empresa), passoDireto.chave);
    }
    return ret(sub(passo.pergunta, alvoVinculo.empresa), passo.chave);
  }

  // FIX: empresa é campo obrigatório — não pode ficar null por _q_skipped.
  // Se todos os passos de empresa foram pulados mas empresa ainda é null, perguntar mesmo assim.
  if (!alvoVinculo.empresa) {
    const empPasso = [...passosNormais].reverse().find(p => p.campoColetar === "empresa");
    if (empPasso) return ret(sub(empPasso.pergunta, null), empPasso.chave);
  }

  // All passosNormais done for this vinculos

  // data_saida gate: ask for a precise departure date when needed for prescription check.
  const saida = String(alvoVinculo.saida ?? "");
  const aindaEmpregado = /ainda (est[áa]|trabalh|empregad)/i.test(saida);
  const temReferenciaTemporal = /\b(h[aá]\s*\d|dia[s]?\s+atr[aá]|m[eê]s(es)?\s+atr[aá]|ano\s+atr[aá]|\d+\s*(dia|m[eê]s|ano)|mês passado|ano passado|semana passada|faz\s+\d)/i.test(saida);
  if (!aindaEmpregado && !alvoVinculo.data_saida && !temReferenciaTemporal) {
    const gateChave = isAnterior ? "data_saida_gate_ant" : "data_saida_gate";
    const gateStep = passos.find(p => p.chave === gateChave);
    if (gateStep && !qSkipped.includes(gateChave)) return ret(sub(gateStep.pergunta, alvoVinculo.empresa), gateChave);
  }

  // A pergunta "trabalhou em outro lugar nos últimos 2 anos?" é CONDICIONAL: só faz sentido
  // para investigar OUTRO vínculo dentro da janela de prescrição. Se o vínculo atual já
  // preenche essa janela (tenure ≥ 2 anos), não há "outro nos últimos 2 anos" a investigar —
  // pula direto para o fechamento.
  // parseTempToMeses normaliza meses E anos ("36 meses", "3 anos", "desde 2020"). Antes a
  // detecção usava só um regex de "anos", então tenure em meses ("36 meses") escapava e o bot
  // perguntava à toa mesmo com 3 anos de casa (caso Transmagna 20/06). 999 = tempo não
  // reconhecido → NÃO pula (mantém a pergunta) para não fechar com tenure desconhecido.
  const tempoMesesNum =
    (typeof alvoVinculo.tempo_meses_estimado === "number" ? alvoVinculo.tempo_meses_estimado : null)
    ?? (typeof merged.tempo_meses_estimado === "number" ? merged.tempo_meses_estimado : null);
  const tempoTexto = String(alvoVinculo.tempo ?? (isAnterior ? "" : merged.tempo_recente ?? "")).trim();
  const mesesTenure = tempoMesesNum ?? (tempoTexto ? parseTempToMeses(tempoTexto) : 0);
  const empregoLongo = mesesTenure >= 24 && mesesTenure < 900;
  // empregoLongo só retorna null se empresa já foi coletada.
  if (empregoLongo && alvoVinculo.empresa) return null;

  // D2 FIX: só bloqueia mais_empregos quando lead já negou E todos os passosNormais estão feitos.
  // Chegando aqui, todos os campos do alvoVinculo foram coletados ou explicitamente pulados.
  if (merged._mais_empregos_negado === true) return null;

  // Ask mais_empregos — only if not already skipped after 2 unanswered attempts
  if (passoMaisEmpregos && !qSkipped.includes(passoMaisEmpregos.chave)) {
    return ret(sub(passoMaisEmpregos.pergunta, alvoVinculo.empresa), passoMaisEmpregos.chave);
  }
  return null;
}

// Bubbled up from getNextVinculoQuestion for attempt-tracking in stage-engine
let _lastVinculoStepChave: string | null = null;
export function getLastVinculoStepChave(): string | null { return _lastVinculoStepChave; }

export async function getNextDeterministicQuestion(
  projetoId: string,
  merged: Record<string, unknown>,
  vinculos: VinculoEmprego[],
  vinculosOk: boolean,
  vinculosTodosPrescritos: boolean,
  empresasBloqueadas: string[],
  outgoingCount: number,
): Promise<string | null> {
  // Reset on every call — module-level state persists across deals in the same PM2 worker.
  // A stale value from a different deal's request would incorrectly trigger _last_dq tracking.
  _lastVinculoStepChave = null;

  if (!merged._saudacao_enviada) {
    const { getGreetingStep } = await import("./flow-controller.js");
    const greeting = await getGreetingStep(projetoId);
    if (greeting) return greeting;
  }

  const { getNextPreVinculosQuestion, getNextPosVinculosQuestion } = await import("./flow-controller.js");

  const preQ = await getNextPreVinculosQuestion(projetoId, merged);
  if (preQ) {
    return preQ;
  }

  if (!vinculosTodosPrescritos) {
    const nextVinculo = await getNextVinculoQuestion(
      projetoId, merged, vinculos, vinculosOk, vinculosTodosPrescritos, empresasBloqueadas,
    );
    // Return the question text; bubble up passoChave via module-level for stage-engine tracking
    if (nextVinculo) {
      _lastVinculoStepChave = nextVinculo.passoChave;
      return nextVinculo.pergunta;
    }
    _lastVinculoStepChave = null;
  }

  // FIX: pos_vinculos só executa se empresa do vínculo principal já foi coletada.
  // Se empresa ainda é null, não há pós-vinculos válido — o fluxo deve permanecer em coleta.
  const _mainVinculoPos = vinculos.find((v: VinculoEmprego) => v.ordem === 1);
  const _empresaPosOk = !!_mainVinculoPos?.empresa;
  if (!vinculosTodosPrescritos && !vinculosOk && _empresaPosOk) {
    if (!merged._pos_vinculos_fase) {
      if (_mainVinculoPos?.tempo) {
        const meses = parseTempToMeses(String(_mainVinculoPos.tempo));
        merged._pos_vinculos_fase = meses <= 18 ? "pos_vinculos_curto" : "pos_vinculos";
      }
    }
    const posFase = (merged._pos_vinculos_fase as string) || "pos_vinculos";

    const mainV = _mainVinculoPos;
    if (mainV) {
      if (merged.horas_extras === undefined || merged.horas_extras === null)
        merged.horas_extras = mainV.horas_extras ?? null;
      if (merged.pagamento_fora === undefined || merged.pagamento_fora === null)
        merged.pagamento_fora = mainV.pagamento_fora ?? null;
    }

    if (posFase === "pos_vinculos_curto") {
      if (!merged.prazo_ok_curto) merged.prazo_ok_curto = "curto";

      const antV = vinculos.find((v: VinculoEmprego) => v.ordem === 2);
      if (antV) {
        // Vinculos array is authoritative — always overwrite flat merged fields from vinculos[1].
        // Prevents LLM qualificacao extraction from poisoning anterior fields with wrong company.
        merged.tem_emprego_anterior = true;
        merged.prazo_anterior_ok = true;
        merged.empresa_anterior   = antV.empresa      ?? merged.empresa_anterior      ?? null;
        merged.tempo_anterior     = antV.tempo        ?? merged.tempo_anterior        ?? null;
        merged.clt_anterior       = antV.vinculo      ?? merged.clt_anterior          ?? null;
        merged.frota_anterior     = antV.frota        ?? merged.frota_anterior        ?? null;
        merged.horas_extras_anterior = antV.horas_extras  ?? merged.horas_extras_anterior ?? null;
        merged.pagamento_anterior    = antV.pagamento_fora ?? merged.pagamento_anterior    ?? null;
        merged.injustica_anterior    = antV.injustica      ?? merged.injustica_anterior    ?? null;
      }
    }

    // Guard: if empresa_anterior still matches empresa_principal after vinculos sync
    // (antV.empresa itself was wrong, or there is no antV), clear the anterior fields so the
    // pos_vinculos_curto flow asks the anterior questions from scratch.
    const empPrincipalNorm = String(merged.empresa_principal ?? merged.empresa_recente ?? "").toLowerCase().replace(/\s+/g, " ").trim();
    const empAnteriorNorm  = String(merged.empresa_anterior ?? "").toLowerCase().replace(/\s+/g, " ").trim();
    if (posFase === "pos_vinculos_curto" && empAnteriorNorm && empPrincipalNorm && empAnteriorNorm === empPrincipalNorm) {
      delete merged.tem_emprego_anterior;
      delete merged.empresa_anterior;
      delete merged.prazo_anterior_ok;
      delete merged.tempo_anterior;
      delete merged.clt_anterior;
      delete merged.frota_anterior;
      delete merged.horas_extras_anterior;
      delete merged.pagamento_anterior;
      delete merged.injustica_anterior;
    }

    const posQ = await getNextPosVinculosQuestion(projetoId, merged, posFase);
    if (posQ) return posQ;
  }

  return null;
}

/**
 * Retorna a pergunta do passo mais_empregos do fluxo vinculos_anterior.
 * Usada como fallback quando nenhum vínculo válido existe mas o lead pode ter outros empregos.
 */
export async function getMaisEmpregosAnteriorQuestion(projetoId: string, ultimaEmpresa: string | null): Promise<string | null> {
  const passos = await getFlowPassos(projetoId, "vinculos_anterior");
  const passo = passos.find(p => p.tipoEspecial === "mais_empregos");
  if (!passo) return null;
  return sub(passo.pergunta, ultimaEmpresa);
}
