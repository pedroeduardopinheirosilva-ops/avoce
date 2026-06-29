/**
 * DeepSeek — inteligência central do Marketing Autopilot
 * Gera roteiros de vídeo e analisa campanhas com decisões em JSON.
 */

const DEEPSEEK_BASE = "https://api.deepseek.com/v1";

function extractJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (match) {
      try { return JSON.parse(match[1].trim()); } catch {}
    }
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end !== -1) {
      try { return JSON.parse(text.slice(start, end + 1)); } catch {}
    }
    throw new Error(`DeepSeek retornou JSON inválido: ${text.slice(0, 200)}`);
  }
}

async function chat(apiKey: string, systemPrompt: string, userMessage: string): Promise<string> {
  const res = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "deepseek-chat",
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      temperature: 0.7,
      max_tokens: 4096,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`DeepSeek API ${res.status}: ${err.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? "";
}

export interface CenaRoteiro {
  ordem: number;
  descricao: string;
  duracao: string;
  textoNarrado: string;
  dicaGravacao: string;
}

export interface RoteiroGerado {
  titulo: string;
  cenas: CenaRoteiro[];
  caption: string;
  hashtags: string[];
  dicasGravacao: string[];
}

export interface InputRoteiro {
  advogadoNome: string;
  areaDireito: string;
  tema: string;
  formato: string; // REEL | CARROSSEL | POST
  tom: string;
  publicoAlvo?: string;
  cta?: string;
  observacoes?: string;
  escritorioDescricao?: string;
}

export async function gerarRoteiro(apiKey: string, input: InputRoteiro): Promise<RoteiroGerado> {
  const system = `Você é um especialista em marketing jurídico para redes sociais.
Retorne SEMPRE um JSON válido com esta estrutura exata:
{
  "titulo": "string — título chamativo para o vídeo",
  "cenas": [
    {
      "ordem": 1,
      "descricao": "O que aparece na tela",
      "duracao": "5s",
      "textoNarrado": "O que o advogado fala",
      "dicaGravacao": "Instrução técnica de gravação"
    }
  ],
  "caption": "string — legenda completa com CTA",
  "hashtags": ["hashtag1", "hashtag2"],
  "dicasGravacao": ["dica geral 1", "dica geral 2"]
}
Adapte o número de cenas ao formato: REEL = 4-8 cenas rápidas, CARROSSEL = 1 cena por slide, POST = 1 cena.`;

  const user = `Advogado: ${input.advogadoNome}
Área: ${input.areaDireito}
Tema: ${input.tema}
Formato: ${input.formato}
Tom: ${input.tom}
${input.publicoAlvo ? `Público-alvo: ${input.publicoAlvo}` : ""}
${input.cta ? `CTA: ${input.cta}` : ""}
${input.observacoes ? `Observações: ${input.observacoes}` : ""}
${input.escritorioDescricao ? `Sobre o escritório: ${input.escritorioDescricao}` : ""}`;

  const raw = await chat(apiKey, system, user);
  return extractJson(raw) as RoteiroGerado;
}

export interface AcaoCampanha {
  tipo: "pausar_campanha" | "pausar_criativo" | "ajustar_orcamento" | "escalar_orcamento" | "alerta";
  entidadeId: string;
  entidadeTipo: "campanha" | "criativo";
  valorNovo?: number;
  motivo: string;
}

export interface InputAnaliseCampanhas {
  campanhas: Array<{
    id: string;
    nome: string;
    plataforma: string;
    cpaAtual: number | null;
    cpaMeta: number | null;
    roasAtual: number | null;
    roasMeta: number | null;
    orcamentoDiario: number | null;
    kpiVioladoCount: number;
    criativos: Array<{ id: string; nome: string; ctr: number; cpc: number; status: string }>;
  }>;
}

export async function analisarCampanhas(apiKey: string, input: InputAnaliseCampanhas): Promise<AcaoCampanha[]> {
  const system = `Você é um gestor de tráfego pago especializado em marketing jurídico.
Analise as métricas e retorne SOMENTE um JSON com ações a tomar:
{
  "acoes": [
    {
      "tipo": "pausar_campanha" | "pausar_criativo" | "ajustar_orcamento" | "escalar_orcamento" | "alerta",
      "entidadeId": "id da campanha ou criativo",
      "entidadeTipo": "campanha" | "criativo",
      "valorNovo": 150.00,
      "motivo": "Explicação em 1-2 frases"
    }
  ]
}
Se não há ações necessárias, retorne { "acoes": [] }.
Regras:
- Pause campanha se CPA > cpaMeta por 2+ coletas consecutivas (kpiVioladoCount >= 2)
- Pause criativo se CTR < 0.5% com gasto significativo
- Sugira ajuste de orçamento se ROAS > roasMeta * 1.5 (escalar) ou ROAS < roasMeta * 0.5 (reduzir)
- Não pause se kpiVioladoCount < 2`;

  const raw = await chat(apiKey, system, JSON.stringify(input.campanhas));
  const parsed = extractJson(raw);
  return (parsed.acoes ?? []) as AcaoCampanha[];
}

export async function gerarTextoAnuncio(
  apiKey: string,
  contexto: { areaDireito: string; publicoAlvo: string; objetivo: string; tomVoz: string },
): Promise<{ titulo: string; headline: string; descricao: string }> {
  const system = `Você é um copywriter especializado em anúncios jurídicos.
Retorne um JSON com esta estrutura:
{
  "titulo": "Título principal (máx 40 chars)",
  "headline": "Headline secundária (máx 30 chars)",
  "descricao": "Texto do anúncio (máx 125 chars)"
}`;
  const raw = await chat(apiKey, system, JSON.stringify(contexto));
  return extractJson(raw);
}
