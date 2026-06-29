/**
 * Geração de imagens com IA — DALL-E 3 e Stability AI
 */

export type ImageProvider = "dalle3" | "stability";

export interface ImagemGerada {
  url: string;
  provider: ImageProvider;
  revisedPrompt?: string;
}

export async function gerarImagem(
  apiKey: string,
  provider: ImageProvider,
  briefing: string,
  tamanho: "1024x1024" | "1792x1024" | "1024x1792" = "1024x1024",
): Promise<ImagemGerada> {
  if (provider === "dalle3") return gerarDalle3(apiKey, briefing, tamanho);
  return gerarStability(apiKey, briefing);
}

async function gerarDalle3(apiKey: string, briefing: string, size: string): Promise<ImagemGerada> {
  const res = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "dall-e-3",
      prompt: briefing,
      size,
      quality: "standard",
      n: 1,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`DALL-E 3 error ${res.status}: ${err.slice(0, 200)}`);
  }
  const data = await res.json();
  const img = data.data?.[0];
  return { url: img.url, provider: "dalle3", revisedPrompt: img.revised_prompt };
}

async function gerarStability(apiKey: string, briefing: string): Promise<ImagemGerada> {
  const res = await fetch("https://api.stability.ai/v1/generation/stable-diffusion-xl-1024-v1-0/text-to-image", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      text_prompts: [{ text: briefing, weight: 1 }],
      cfg_scale: 7,
      height: 1024,
      width: 1024,
      steps: 30,
      samples: 1,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Stability AI error ${res.status}: ${err.slice(0, 200)}`);
  }
  const data = await res.json();
  const b64 = data.artifacts?.[0]?.base64;
  if (!b64) throw new Error("Stability AI não retornou imagem");
  // Retorna data URL (frontend pode exibir ou backend pode salvar)
  return { url: `data:image/png;base64,${b64}`, provider: "stability" };
}
