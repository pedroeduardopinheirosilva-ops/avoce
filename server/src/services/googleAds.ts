/**
 * Google Ads API — leitura de métricas e ajuste de orçamento
 * Usa OAuth2 com refresh token. Developer Token obrigatório.
 */

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const ADS_BASE = "https://googleads.googleapis.com/v16";

// Troca refresh token por access token
async function getAccessToken(clientId: string, clientSecret: string, refreshToken: string): Promise<string> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(`Google OAuth: ${data.error_description ?? data.error}`);
  return data.access_token as string;
}

export interface GoogleCampanhaMetricas {
  id: string;
  nome: string;
  status: string;
  orcamentoDiario: number;
  impressoes: number;
  cliques: number;
  gasto: number;
  conversoes: number;
  cpa: number | null;
  roas: number | null;
  ctr: number;
}

export interface GoogleAdsCredenciais {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  devToken: string;
  customerId: string; // sem traços: "1234567890"
}

async function adsQuery(creds: GoogleAdsCredenciais, query: string): Promise<any[]> {
  const accessToken = await getAccessToken(creds.clientId, creds.clientSecret, creds.refreshToken);
  const url = `${ADS_BASE}/customers/${creds.customerId}/googleAds:searchStream`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "developer-token": creds.devToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Google Ads API ${res.status}: ${err.slice(0, 200)}`);
  }
  const lines = await res.json();
  return (Array.isArray(lines) ? lines : [lines])
    .flatMap((chunk: any) => chunk.results ?? []);
}

// Lista campanhas ativas com métricas dos últimos 30 dias
export async function listarCampanhas(creds: GoogleAdsCredenciais): Promise<GoogleCampanhaMetricas[]> {
  const query = `
    SELECT
      campaign.id,
      campaign.name,
      campaign.status,
      campaign_budget.amount_micros,
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.conversions,
      metrics.conversions_value,
      metrics.ctr
    FROM campaign
    WHERE segments.date DURING LAST_30_DAYS
      AND campaign.status != 'REMOVED'
    ORDER BY metrics.cost_micros DESC
    LIMIT 50
  `;
  const rows = await adsQuery(creds, query);
  return rows.map((r: any) => {
    const gasto = (r.metrics?.costMicros ?? 0) / 1_000_000;
    const conversoes = parseFloat(r.metrics?.conversions ?? "0");
    const receita = parseFloat(r.metrics?.conversionsValue ?? "0");
    return {
      id: String(r.campaign?.id),
      nome: r.campaign?.name ?? "",
      status: r.campaign?.status ?? "",
      orcamentoDiario: (r.campaignBudget?.amountMicros ?? 0) / 1_000_000,
      impressoes: parseInt(r.metrics?.impressions ?? "0"),
      cliques: parseInt(r.metrics?.clicks ?? "0"),
      gasto,
      conversoes,
      cpa: conversoes > 0 ? parseFloat((gasto / conversoes).toFixed(2)) : null,
      roas: gasto > 0 ? parseFloat((receita / gasto).toFixed(2)) : null,
      ctr: parseFloat(r.metrics?.ctr ?? "0"),
    };
  });
}

// Ajusta orçamento diário de uma campanha (valor em R$, convertido para micros)
export async function ajustarOrcamento(
  creds: GoogleAdsCredenciais,
  campanhaResourceName: string,
  valorDiarioReais: number,
): Promise<void> {
  const accessToken = await getAccessToken(creds.clientId, creds.clientSecret, creds.refreshToken);
  const amountMicros = Math.round(valorDiarioReais * 1_000_000);

  // Primeiro busca o resource name do budget
  const query = `
    SELECT campaign_budget.resource_name
    FROM campaign
    WHERE campaign.resource_name = '${campanhaResourceName}'
    LIMIT 1
  `;
  const rows = await adsQuery(creds, query);
  const budgetName = rows[0]?.campaignBudget?.resourceName;
  if (!budgetName) throw new Error("Budget não encontrado para a campanha");

  const url = `${ADS_BASE}/${budgetName}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "developer-token": creds.devToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ amountMicros }),
  });
  if (!res.ok) throw new Error(`Ajuste de orçamento Google falhou: ${res.status}`);
}
