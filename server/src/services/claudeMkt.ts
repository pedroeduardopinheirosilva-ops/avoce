/**
 * Claude (Anthropic) — inteligência central do Marketing Autopilot
 * Mesma interface que deepseekMkt, usando o SDK @anthropic-ai/sdk.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { AcaoCampanha, InputAnaliseCampanhas, InputRoteiro, RoteiroGerado } from "./deepseekMkt.js";

export type { AcaoCampanha, InputAnaliseCampanhas, InputRoteiro, RoteiroGerado };

const MODEL = "claude-sonnet-4-6";

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
    throw new Error(`Claude retornou JSON inválido: ${text.slice(0, 200)}`);
  }
}

async function chat(apiKey: string, systemPrompt: string, userMessage: string): Promise<string> {
  const client = new Anthropic({ apiKey });
  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
  });
  const block = msg.content[0];
  if (block.type !== "text") throw new Error("Claude retornou tipo inesperado: " + block.type);
  return block.text;
}

export async function analisarCampanhas(apiKey: string, input: InputAnaliseCampanhas): Promise<AcaoCampanha[]> {
  const system = `Você é um gestor de tráfego pago especializado em marketing jurídico.
Analise as métricas das campanhas e retorne SOMENTE um JSON com ações recomendadas:
{
  "acoes": [
    {
      "tipo": "pausar_campanha" | "pausar_criativo" | "ajustar_orcamento" | "escalar_orcamento" | "alerta",
      "entidadeId": "id da campanha ou criativo",
      "entidadeTipo": "campanha" | "criativo",
      "valorNovo": 150.00,
      "motivo": "Explicação em 1-2 frases clara e objetiva"
    }
  ]
}
Se não há ações necessárias, retorne { "acoes": [] }.

Regras de decisão:
- Pause campanha se CPA > cpaMeta por 2+ coletas (kpiVioladoCount >= 2)
- Pause criativo se CTR < 0.5% com gasto significativo (> R$ 50)
- Escale orçamento (+30%) se ROAS > roasMeta × 1.5 por 2+ coletas
- Reduza orçamento (-30%) se ROAS < roasMeta × 0.5 por 2+ coletas
- Emita alerta se kpiVioladoCount = 1 (ainda monitorando)
- Não aja se kpiVioladoCount < 2 (exceto alertas)
- Se cpaMeta ou roasMeta for null, emita alerta pedindo configuração de KPIs`;

  const raw = await chat(apiKey, system, JSON.stringify(input.campanhas, null, 2));
  const parsed = extractJson(raw);
  return (parsed.acoes ?? []) as AcaoCampanha[];
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
