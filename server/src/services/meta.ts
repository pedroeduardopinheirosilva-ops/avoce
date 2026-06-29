/**
 * Meta Graph API — campanhas, criativos e publicação no Instagram
 */

const GRAPH_BASE = "https://graph.facebook.com/v19.0";

async function graphFetch(path: string, token: string, options: RequestInit = {}): Promise<any> {
  const sep = path.includes("?") ? "&" : "?";
  const url = `${GRAPH_BASE}/${path}${sep}access_token=${token}`;
  const res = await fetch(url, options);
  const data = await res.json();
  if (data.error) throw new Error(`Meta API: ${data.error.message} (code ${data.error.code})`);
  return data;
}

export interface MetaCampanhaMetricas {
  id: string;
  name: string;
  status: string;
  daily_budget?: string;
  impressions?: string;
  clicks?: string;
  spend?: string;
  cpa?: string;
  roas?: string;
  ctr?: string;
}

// Lista campanhas com métricas dos últimos 7 dias
export async function listarCampanhas(token: string, adAccountId: string): Promise<MetaCampanhaMetricas[]> {
  const fields = "id,name,status,daily_budget,insights.date_preset(last_7d){impressions,clicks,spend,ctr,actions,action_values}";
  const data = await graphFetch(`act_${adAccountId}/campaigns?fields=${fields}&limit=50`, token);
  return (data.data ?? []).map((c: any) => {
    const ins = c.insights?.data?.[0] ?? {};
    const compras = ins.actions?.find((a: any) => a.action_type === "purchase")?.value ?? "0";
    const receita = ins.action_values?.find((a: any) => a.action_type === "purchase")?.value ?? "0";
    const gasto = parseFloat(ins.spend ?? "0");
    const cpa = parseFloat(compras) > 0 ? (gasto / parseFloat(compras)).toFixed(2) : null;
    const roas = gasto > 0 ? (parseFloat(receita) / gasto).toFixed(2) : null;
    return {
      id: c.id,
      name: c.name,
      status: c.status,
      daily_budget: c.daily_budget,
      impressions: ins.impressions ?? "0",
      clicks: ins.clicks ?? "0",
      spend: ins.spend ?? "0",
      ctr: ins.ctr ?? "0",
      cpa,
      roas,
    };
  });
}

// Lista criativos (ad sets + ads) de uma campanha com CTR e CPC
export async function listarCriativos(token: string, campanhaId: string): Promise<any[]> {
  const fields = "id,name,status,insights.date_preset(last_7d){ctr,cpc,impressions,clicks}";
  const data = await graphFetch(`${campanhaId}/ads?fields=${fields}&limit=100`, token);
  return (data.data ?? []).map((ad: any) => {
    const ins = ad.insights?.data?.[0] ?? {};
    return {
      id: ad.id,
      nome: ad.name,
      status: ad.status,
      ctr: parseFloat(ins.ctr ?? "0"),
      cpc: parseFloat(ins.cpc ?? "0"),
      impressoes: parseInt(ins.impressions ?? "0"),
      cliques: parseInt(ins.clicks ?? "0"),
    };
  });
}

export async function pausarCampanha(token: string, campanhaId: string): Promise<void> {
  await graphFetch(`${campanhaId}`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "PAUSED" }),
  });
}

export async function ativarCampanha(token: string, campanhaId: string): Promise<void> {
  await graphFetch(`${campanhaId}`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "ACTIVE" }),
  });
}

export async function ajustarOrcamento(token: string, campanhaId: string, valorDiarioCentavos: number): Promise<void> {
  await graphFetch(`${campanhaId}`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ daily_budget: String(valorDiarioCentavos) }),
  });
}

export async function pausarAnuncio(token: string, anuncioId: string): Promise<void> {
  await graphFetch(`${anuncioId}`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "PAUSED" }),
  });
}

// Instagram — cria container para imagem
export async function criarContainerImagem(
  token: string,
  igAccountId: string,
  imageUrl: string,
  caption: string,
): Promise<string> {
  const data = await graphFetch(`${igAccountId}/media`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image_url: imageUrl, caption }),
  });
  return data.id as string;
}

// Instagram — cria container para vídeo (Reel)
export async function criarContainerVideo(
  token: string,
  igAccountId: string,
  videoUrl: string,
  caption: string,
): Promise<string> {
  const data = await graphFetch(`${igAccountId}/media`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ video_url: videoUrl, caption, media_type: "REELS" }),
  });
  return data.id as string;
}

// Verifica status do container (FINISHED | IN_PROGRESS | ERROR)
export async function verificarContainer(token: string, containerId: string): Promise<string> {
  const data = await graphFetch(`${containerId}?fields=status_code`, token);
  return data.status_code as string;
}

// Publica container já processado
export async function publicarContainer(token: string, igAccountId: string, containerId: string): Promise<string> {
  const data = await graphFetch(`${igAccountId}/media_publish`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ creation_id: containerId }),
  });
  return data.id as string;
}

// Coleta métricas de um post publicado
export async function getMetricasPost(token: string, postId: string): Promise<Record<string, number>> {
  const metricasAlvo = "reach,impressions,likes_count,comments_count,plays,shares_count";
  try {
    const data = await graphFetch(
      `${postId}/insights?metric=${metricasAlvo}&period=lifetime`,
      token,
    );
    const result: Record<string, number> = {};
    for (const m of data.data ?? []) result[m.name] = m.values?.[0]?.value ?? 0;
    return result;
  } catch {
    return {};
  }
}

// Renova long-lived token (válido enquanto o token atual ainda não expirou)
export async function renovarToken(appId: string, appSecret: string, token: string): Promise<{ token: string; expiresAt: Date }> {
  const url = `https://graph.facebook.com/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${token}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.error) throw new Error(`Renovação de token Meta falhou: ${data.error.message}`);
  const expiresAt = new Date(Date.now() + (data.expires_in ?? 5_184_000) * 1_000);
  return { token: data.access_token, expiresAt };
}
