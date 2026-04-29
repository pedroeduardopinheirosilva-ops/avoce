/**
 * Persona Router — flow step selection, system prompt base, and deterministic question ordering.
 * Isolated from stage-engine so flow logic can be tested independently.
 */

import { prisma } from "../db.js";
import type { VinculoEmprego } from "./qualification.js";

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

// ──────────────────────────────────────────────────────────────────────────────
// Default flow steps (auto-seeded when project has no DB rows)
// ──────────────────────────────────────────────────────────────────────────────

const DEFAULT_FLOW_PASSOS: Omit<FlowPasso, "ativo">[] = [
  { chave: "empresa",        campoColetar: "empresa",        ordemPadrao: 1,  pergunta: "Em qual empresa você trabalhou (ou trabalha)?",                                            skipSe: null,                                                                   tipoEspecial: null },
  { chave: "funcao",         campoColetar: "funcao",         ordemPadrao: 2,  pergunta: "Qual era sua função lá?",                                                                  skipSe: null,                                                                   tipoEspecial: null },
  { chave: "vinculo",        campoColetar: "vinculo",        ordemPadrao: 3,  pergunta: "Você tinha carteira assinada (CLT) ou era autônomo?",                                       skipSe: null,                                                                   tipoEspecial: null },
  { chave: "saida",          campoColetar: "saida",          ordemPadrao: 4,  pergunta: "Como foi o desligamento — foi demitido, pediu demissão ou ainda está lá?",                  skipSe: null,                                                                   tipoEspecial: null },
  { chave: "tempo",          campoColetar: "tempo",          ordemPadrao: 5,  pergunta: "Quanto tempo você trabalhou lá? (meses ou anos)",                                           skipSe: null,                                                                   tipoEspecial: null },
  { chave: "horas_extras",   campoColetar: "horas_extras",   ordemPadrao: 6,  pergunta: "Trabalhava além da jornada normal? Recebia por essas horas?",                               skipSe: null,                                                                   tipoEspecial: null },
  { chave: "pagamento_fora", campoColetar: "pagamento_fora", ordemPadrao: 7,  pergunta: "Recebia algum valor fora do holerite, como Pix, Pamcard ou dinheiro?",                     skipSe: null,                                                                   tipoEspecial: null },
  { chave: "injustica",      campoColetar: "injustica",      ordemPadrao: 8,  pergunta: "Teve alguma pressão, desconto indevido ou jornada sem registro?",                           skipSe: null,                                                                   tipoEspecial: null },
  { chave: "frota",          campoColetar: "frota",          ordemPadrao: 9,  pergunta: "Quantos caminhões a empresa tinha na frota?",                                              skipSe: { campo: "vinculo", contem_qualquer: ["clt", "carteira assinada", "carteira"] }, tipoEspecial: null },
  { chave: "mais_empregos",  campoColetar: null,             ordemPadrao: 10, pergunta: "Antes de trabalhar lá, você trabalhou em outro lugar nos últimos 2 anos?",                  skipSe: null,                                                                   tipoEspecial: "mais_empregos" },
];

// In-memory flow cache
const _flowPassosCache: Record<string, { passos: FlowPasso[]; ts: number }> = {};
const FLOW_CACHE_TTL = 2 * 60 * 1000;

export function invalidateFlowCache(projetoId: string) {
  delete _flowPassosCache[projetoId];
}

async function getFlowPassos(projetoId: string): Promise<FlowPasso[]> {
  const cached = _flowPassosCache[projetoId];
  if (cached && Date.now() - cached.ts < FLOW_CACHE_TTL) return cached.passos;

  let rows = await prisma.iaVinculoFlowPasso.findMany({
    where: { projetoId, ativo: true },
    orderBy: { ordemPadrao: "asc" },
  });

  if (rows.length === 0) {
    const seedData = DEFAULT_FLOW_PASSOS.map(p => ({
      projetoId,
      ativo: true,
      chave: p.chave,
      pergunta: p.pergunta,
      campoColetar: p.campoColetar,
      ordemPadrao: p.ordemPadrao,
      skipSe: p.skipSe as any,
      tipoEspecial: p.tipoEspecial,
    }));
    await prisma.iaVinculoFlowPasso.createMany({ data: seedData, skipDuplicates: true });
    rows = await prisma.iaVinculoFlowPasso.findMany({
      where: { projetoId, ativo: true },
      orderBy: { ordemPadrao: "asc" },
    });
  }

  const passos: FlowPasso[] = rows.map(r => ({
    chave: r.chave,
    pergunta: r.pergunta,
    campoColetar: r.campoColetar,
    ordemPadrao: r.ordemPadrao,
    ativo: r.ativo,
    skipSe: r.skipSe as Record<string, any> | null,
    tipoEspecial: r.tipoEspecial,
  }));

  _flowPassosCache[projetoId] = { passos, ts: Date.now() };
  return passos;
}

function shouldSkipPasso(
  passo: FlowPasso,
  vinculo: VinculoEmprego,
  merged?: Record<string, unknown>,
): boolean {
  if (!passo.skipSe) return false;
  const { campo, contem_qualquer } = passo.skipSe as { campo?: string; contem_qualquer?: string[] };
  if (!campo || !Array.isArray(contem_qualquer) || contem_qualquer.length === 0) return false;
  const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const anyMatch = (val: string) => contem_qualquer.some(v => val.includes(norm(v)));

  // Primary check: the field on the vínculo object itself
  const valorCampo = norm(String((vinculo as any)[campo] ?? ""));
  if (anyMatch(valorCampo)) return true;

  // Fallback: check flat merged field when vinculo field is empty.
  // Handles the case where CLT/autônomo was answered before empresa was mentioned,
  // so vinculo.vinculo is null even though merged.vinculo_recente has the value.
  if (merged && campo === "vinculo") {
    const flatVal = norm(String(merged.vinculo_recente ?? ""));
    if (flatVal && anyMatch(flatVal)) return true;
  }

  return false;
}

function parseTempToMeses(tempo: string): number {
  if (!tempo) return 999;
  const t = tempo.toLowerCase();
  let meses = 0;
  const anosMatch = t.match(/(\d+)\s*ano/);
  const mesesMatch = t.match(/(\d+)\s*m[eê]s/);
  if (anosMatch)  meses += parseInt(anosMatch[1]) * 12;
  if (mesesMatch) meses += parseInt(mesesMatch[1]);
  if (!anosMatch && !mesesMatch) {
    if (t.includes("menos") || t.includes("pouco") || t.includes("alguns")) return 6;
    return 999;
  }
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

export function buildInstrucaoBase(): string {
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

6. TAMANHO E FORMATAÇÃO — REGRA CRÍTICA
MENSAGENS CURTAS. Máximo 3 frases por resposta. Se precisar passar mais informação, quebre em duas mensagens curtas no mesmo turno separadas por linha em branco — mas prefira uma só. WhatsApp não é e-mail. Não escreva parágrafos longos. Não resuma tudo que o cliente disse. Vá direto ao ponto e faça UMA pergunta de cada vez. Não use emojis. Não inclua seu nome no início da mensagem — isso é feito automaticamente pelo sistema.

7. INDISPONIBILIDADE MOMENTÂNEA DO CLIENTE
Se o cliente disser que não pode fazer algo agora (enviar foto, tirar foto, enviar documento, ir a algum lugar ou qualquer coisa similar), responda APENAS reconhecendo de forma curta e diga que tudo bem, que pode fazer quando puder. NÃO faça outra pergunta em seguida. Não peça outro dado, outro documento nem outra informação. Aguarde em silêncio o cliente retomar.
Exemplos corretos: "Sem problema, quando puder é só me mandar!" / "Tudo bem, pode enviar quando der, sem pressa."
Exemplos PROIBIDOS: qualquer pergunta nova ou solicitação de outro dado após o cliente dizer que não pode fazer algo agora.

8. DOCUMENTOS RECEBIDOS — LEITURA AUTOMÁTICA
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

export async function getNextVinculoQuestion(
  projetoId: string,
  merged: Record<string, unknown>,
  vinculos: VinculoEmprego[],
  vinculosOk: boolean,
  vinculosTodosPrescritos: boolean,
  empresasBloqueadas: string[],
): Promise<string | null> {
  if (vinculosOk || vinculosTodosPrescritos) return null;

  const passos = await getFlowPassos(projetoId);

  const passosNormais = passos.filter(p => p.tipoEspecial !== "mais_empregos" && p.campoColetar);
  const passoMaisEmpregos = passos.find(p => p.tipoEspecial === "mais_empregos");

  if (vinculos.length === 0) {
    const primeiro = passosNormais[0];
    return primeiro?.pergunta ?? "Em qual empresa você trabalhou?";
  }

  const isEmpresaBloqueada = (empresa: string | null | undefined): boolean => {
    if (!empresa || empresasBloqueadas.length === 0) return false;
    const norm = empresa.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
    return empresasBloqueadas.some(b =>
      norm.includes(b.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, ""))
    );
  };

  const primeiroIncompleto = vinculos.find(v => {
    if (isEmpresaBloqueada(v.empresa)) return false;
    return passosNormais.some(p => {
      const campo = p.campoColetar as keyof VinculoEmprego;
      const val = v[campo];
      return (val === undefined || val === null || val === "") && !shouldSkipPasso(p, v, merged);
    });
  });
  const alvoVinculo = primeiroIncompleto ?? vinculos[vinculos.length - 1];

  if (isEmpresaBloqueada(alvoVinculo.empresa)) {
    console.log(`[VinculoFlow] Empresa bloqueada: "${alvoVinculo.empresa}" — pulando para mais_empregos`);
    return passoMaisEmpregos?.pergunta?.replace("lá", `na ${alvoVinculo.empresa}`)
      ?? `A ${alvoVinculo.empresa} infelizmente não é uma empresa que atendemos no momento. Antes disso, você trabalhou em outro lugar nos últimos 2 anos?`;
  }

  for (const passo of passosNormais) {
    const campo = passo.campoColetar as keyof VinculoEmprego;
    const val = alvoVinculo[campo];
    const faltando = val === undefined || val === null || val === "";
    if (!faltando) continue;

    if (shouldSkipPasso(passo, alvoVinculo, merged)) continue;

    if (campo === "saida" && alvoVinculo.ordem > 1) {
      const empresa = alvoVinculo.empresa ?? "essa empresa";
      return `Como foi o desligamento da ${empresa} — foi demitido ou pediu demissão? E quando foi isso?`;
    }

    if (campo === "tempo" && alvoVinculo.ordem > 1) {
      const empresa = alvoVinculo.empresa ?? "essa empresa anterior";
      return `Quanto tempo você trabalhou na ${empresa}?`;
    }

    return passo.pergunta;
  }

  const ultimoVinculo = vinculos[vinculos.length - 1];
  const nomeEmpresa = ultimoVinculo?.empresa ?? "empresa anterior";

  // Gate: need data_saida before asking about previous employers.
  // Without a departure date, prescricao check defaults to "within 2 years" and
  // asks about anterior incorrectly. Only skip the gate if client is still employed.
  if (!merged._mais_empregos_confirmado) {
    const aindaEmpregado = /ainda (est[áa]|trabalh|empregad)/i.test(String(ultimoVinculo?.saida ?? ""));
    if (!aindaEmpregado && !ultimoVinculo?.data_saida) {
      const empresa = nomeEmpresa;
      return `Quando você saiu da ${empresa}? Me passa o mês e o ano aproximado.`;
    }
  }

  if (merged._mais_empregos_confirmado === true) {
    return `Em qual empresa você trabalhou antes da ${nomeEmpresa}?`;
  }

  const perguntaMaisEmpregos = passoMaisEmpregos?.pergunta
    ?.replace("lá", `na ${nomeEmpresa}`)
    ?? `Antes de trabalhar na ${nomeEmpresa}, você trabalhou em outro lugar nos últimos 2 anos?`;

  return perguntaMaisEmpregos;
}

export async function getNextDeterministicQuestion(
  projetoId: string,
  merged: Record<string, unknown>,
  vinculos: VinculoEmprego[],
  vinculosOk: boolean,
  vinculosTodosPrescritos: boolean,
  empresasBloqueadas: string[],
  outgoingCount: number,
): Promise<string | null> {
  if (!merged._saudacao_enviada) {
    const { getGreetingStep } = await import("./flow-controller.js");
    const greeting = await getGreetingStep(projetoId);
    if (greeting) return greeting;
  }

  const { getNextPreVinculosQuestion, getNextPosVinculosQuestion } = await import("./flow-controller.js");

  const preQ = await getNextPreVinculosQuestion(projetoId, merged);
  if (preQ === undefined) {
    const nomeConhecido = typeof merged.nome === "string" && merged.nome.trim().length > 1;
    if (!nomeConhecido) return "Qual é o seu nome?";
    if (!merged.cidade) return "De qual cidade você é?";
    if (!merged.plataforma_anuncio) return "Você viu nosso anúncio onde? Instagram, Facebook, TikTok ou indicação?";
  } else if (preQ) {
    return preQ;
  }

  if (!vinculosTodosPrescritos) {
    const nextVinculo = await getNextVinculoQuestion(
      projetoId, merged, vinculos, vinculosOk, vinculosTodosPrescritos, empresasBloqueadas,
    );
    if (nextVinculo) return nextVinculo;
  }

  if (!vinculosTodosPrescritos) {
    if (!merged._pos_vinculos_fase) {
      const mainVinculo = vinculos.find((v: VinculoEmprego) => v.ordem === 1);
      if (mainVinculo?.tempo) {
        const meses = parseTempToMeses(String(mainVinculo.tempo));
        merged._pos_vinculos_fase = meses <= 18 ? "pos_vinculos_curto" : "pos_vinculos";
      }
    }
    const posFase = (merged._pos_vinculos_fase as string) || "pos_vinculos";

    const mainV = vinculos.find((v: VinculoEmprego) => v.ordem === 1);
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
    if (posQ === undefined) {
      if (!merged.interesse) {
        return "Você gostaria de entender o que seria possível recuperar no seu caso?";
      }
      // melhor_hora_contato and acao_em_andamento removed — Dra. Daniela handles those
    } else if (posQ) {
      return posQ;
    }
  }

  return null;
}
