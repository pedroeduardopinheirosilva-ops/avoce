/**
 * Pipedrive API client
 *  - v1: pipelines, stages, notes, deal-flow, deal-fields, connection test
 *  - v2: deals, persons, activities  (lower token cost, cursor pagination, RFC3339 filters)
 *
 * Rate limiting (Pipedrive docs):
 *   Daily budget = 30 000 × plan_multiplier × seats  (Lite=1×, Growth=2×, Premium=5×, Ultimate=7×)
 *   Token costs (v1): list=20, search=40, update=10, delete=6, single=2
 *   v2 endpoints have lower token costs per operation.
 *   Burst window: 2 s — Lite=20, Growth=40, Premium=100, Ultimate=120 req (API token auth)
 *   429 = daily budget exhausted; 403 = abuse block.
 */

export interface PipedrivePipeline {
  id: number;
  name: string;
  active: boolean;
  order_nr: number;
}

export interface PipedriveStage {
  id: number;
  name: string;
  pipeline_id: number;
  order_nr: number;
  active_flag: boolean;
}

// v2: is_deleted replaces active_flag; phone/email arrays unchanged
export interface PipedrivePerson {
  id: number;
  name: string;
  phone: { value: string; primary: boolean; label?: string }[];
  email: { value: string; primary: boolean }[];
  org_name?: string;
  active_flag?: boolean;  // v1 compat (may be absent in v2)
  is_deleted?: boolean;   // v2
}

// v2 deal: person_id/org_id are plain integers; custom_fields isolated
export interface PipedriveDealV2 {
  id: number;
  title: string;
  value: number;
  status: "open" | "won" | "lost" | "deleted";
  stage_id: number;
  pipeline_id: number;
  person_id?: number | null;
  org_id?: number | null;
  org_name?: string | null;
  update_time: string;
  add_time: string;
  lost_reason?: string | null;
  expected_close_date?: string | null;
  label_ids?: number[] | null;
  probability?: number | null;
  currency?: string | null;
  custom_fields?: Record<string, any>;
  [key: string]: any;
}

// Keep v1 type alias for backward compat (notes, deal-flow)
export type PipedriveDeal = PipedriveDealV2;

export interface PipedriveDealField {
  id: number;
  key: string;
  name: string;
  field_type: string;
  edit_flag: boolean;
  options?: { id: number; label: string }[];
}

export interface PipedriveNote {
  id: number;
  content: string;
  add_time: string;
  deal_id: number | null;
  person_id: number | null;
}

export interface PipedriveActivity {
  id: number;
  type: string;
  subject: string;
  note: string | null;
  done: boolean;
  due_date: string | null;
  due_time: string | null;
  add_time: string;
  deal_id: number | null;
  person_id: number | null;
}

export interface PipedriveDealFlowItem {
  object: string;
  timestamp: string;
  data: {
    field_key?: string;
    old_value?: string | null;
    new_value?: string;
    log_time?: string;
    user_id?: number;
    change_source?: string;
  };
}

// ── Rate limit state ──────────────────────────────────────────────────────────

const rl = {
  remaining: 999,
  resetSecs: 0,
  dailyLeft: -1,
  windowSize: 20,
};

function updateRl(res: Response): void {
  const h = (name: string) => res.headers.get(name);
  const remaining = h("x-ratelimit-remaining");
  const reset     = h("x-ratelimit-reset");
  const daily     = h("x-daily-requests-left");
  const limit     = h("x-ratelimit-limit");
  if (remaining !== null) rl.remaining  = parseInt(remaining, 10);
  if (reset     !== null) rl.resetSecs  = parseInt(reset, 10);
  if (daily     !== null) rl.dailyLeft  = parseInt(daily, 10);
  if (limit     !== null) rl.windowSize = parseInt(limit, 10);
}

export function getRateLimitStatus(): string {
  const daily = rl.dailyLeft >= 0 ? `, orçamento diário restante: ${rl.dailyLeft}` : "";
  return `rate limit: ${rl.remaining}/${rl.windowSize} req na janela${daily}`;
}

async function waitIfNeeded(): Promise<void> {
  if (!isNaN(rl.remaining) && rl.remaining <= 1 && rl.resetSecs > 0) {
    const pauseMs = Math.min(rl.resetSecs * 1000 + 200, 3000);
    await new Promise(r => setTimeout(r, pauseMs));
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function safeJson(res: Response, path: string): Promise<any> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Pipedrive API ${path}: resposta não-JSON (HTTP ${res.status}) — ${text.slice(0, 150)}`);
  }
}

// "2026-05-08 10:30:00" (UTC, stored format) → "2026-05-08T10:30:00Z" (RFC3339 for v2)
function toRfc3339(ts: string | undefined): string | undefined {
  if (!ts) return undefined;
  return ts.replace(" ", "T") + "Z";
}

// ── v1 fetch (offset pagination) ──────────────────────────────────────────────

async function pdFetch<T>(
  token: string,
  path: string,
  params: Record<string, string | number> = {},
  retries = 3,
): Promise<T[]> {
  await waitIfNeeded();

  const qs = new URLSearchParams({
    api_token: token,
    limit: "500",
    start: "0",
    ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
  });
  const url = `https://api.pipedrive.com/v1${path}?${qs}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  updateRl(res);

  if (res.status === 429) {
    if (retries <= 0) {
      if (rl.dailyLeft === 0) {
        throw new Error(
          `Pipedrive: orçamento diário de tokens ESGOTADO — reset ocorre à meia-noite no servidor Pipedrive. Tente amanhã.`,
        );
      }
      throw new Error(
        `Pipedrive API ${path}: rate limit esgotado após ${3} tentativas. ${getRateLimitStatus()}. Aguarde alguns segundos e tente novamente.`,
      );
    }
    const retryAfterRaw = res.headers.get("Retry-After") ?? res.headers.get("x-ratelimit-reset");
    const retryAfterSec = retryAfterRaw ? parseInt(retryAfterRaw, 10) : (rl.resetSecs > 0 ? rl.resetSecs : 3);
    const waitMs = Math.min(retryAfterSec * 1000, 8000);
    await new Promise(r => setTimeout(r, waitMs));
    return pdFetch<T>(token, path, params, retries - 1);
  }

  if (!res.ok) throw new Error(`Pipedrive API ${path}: ${res.status} ${res.statusText}`);

  const json = await safeJson(res, path) as {
    success: boolean;
    data: T[] | null;
    additional_data?: { pagination?: { more_items_in_collection: boolean; next_start: number } };
  };
  if (!json.success) throw new Error(`Pipedrive API ${path}: success=false`);
  const data: T[] = json.data ?? [];

  if (json.additional_data?.pagination?.more_items_in_collection) {
    const next = await pdFetch<T>(token, path, { ...params, start: json.additional_data.pagination.next_start }, retries);
    return [...data, ...next];
  }
  return data;
}

// ── v2 fetch (cursor pagination, lower token cost) ────────────────────────────

async function pdFetchV2<T>(
  token: string,
  path: string,
  params: Record<string, string | number | boolean> = {},
  retries = 3,
): Promise<T[]> {
  await waitIfNeeded();

  const qs = new URLSearchParams({
    api_token: token,
    limit: "500",
    ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
  });
  const url = `https://api.pipedrive.com/api/v2${path}?${qs}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  updateRl(res);

  if (res.status === 429) {
    if (retries <= 0) {
      if (rl.dailyLeft === 0) {
        throw new Error(
          `Pipedrive: orçamento diário de tokens ESGOTADO — reset ocorre à meia-noite no servidor Pipedrive. Tente amanhã.`,
        );
      }
      throw new Error(
        `Pipedrive API v2 ${path}: rate limit esgotado após ${3} tentativas. ${getRateLimitStatus()}. Aguarde alguns segundos e tente novamente.`,
      );
    }
    const retryAfterRaw = res.headers.get("Retry-After") ?? res.headers.get("x-ratelimit-reset");
    const retryAfterSec = retryAfterRaw ? parseInt(retryAfterRaw, 10) : (rl.resetSecs > 0 ? rl.resetSecs : 3);
    const waitMs = Math.min(retryAfterSec * 1000, 8000);
    await new Promise(r => setTimeout(r, waitMs));
    return pdFetchV2<T>(token, path, params, retries - 1);
  }

  if (!res.ok) throw new Error(`Pipedrive API v2 ${path}: ${res.status} ${res.statusText}`);

  const json = await safeJson(res, path) as {
    success: boolean;
    data: T[] | null;
    additional_data?: { next_cursor?: string | null };
  };
  if (!json.success) throw new Error(`Pipedrive API v2 ${path}: success=false`);
  const data: T[] = json.data ?? [];

  if (json.additional_data?.next_cursor) {
    const next = await pdFetchV2<T>(token, path, { ...params, cursor: json.additional_data.next_cursor }, retries);
    return [...data, ...next];
  }
  return data;
}

// ── Public fetch functions ───────────────────────────────────────────────────

// v1 (small lists, structural data — not worth migrating)
export async function fetchPipelines(token: string) {
  return pdFetch<PipedrivePipeline>(token, "/pipelines");
}

export async function fetchStages(token: string) {
  return pdFetch<PipedriveStage>(token, "/stages");
}

export async function fetchDealFields(token: string) {
  return pdFetch<PipedriveDealField>(token, "/dealFields");
}

// v1 — notes not available in v2
export async function fetchNotes(token: string, sinceTimestamp?: string) {
  return pdFetch<PipedriveNote>(token, "/notes", sinceTimestamp ? { since_timestamp: sinceTimestamp } : {});
}

// v2 — lower token cost, cursor pagination, RFC3339 date filter
export async function fetchPersons(token: string, sinceTimestamp?: string) {
  const params: Record<string, string> = {};
  const ts = toRfc3339(sinceTimestamp);
  if (ts) params.updated_since = ts;
  return pdFetchV2<PipedrivePerson>(token, "/persons", params);
}

export async function fetchDeals(token: string, _status = "all_not_deleted", sinceTimestamp?: string) {
  const params: Record<string, string> = {
    // v2 uses comma-separated status values; "all_not_deleted" maps to open+won+lost
    status: "open,won,lost",
    include_option_labels: "true",  // resolve option labels in response (avoids manual lookup)
  };
  const ts = toRfc3339(sinceTimestamp);
  if (ts) params.updated_since = ts;
  return pdFetchV2<PipedriveDealV2>(token, "/deals", params);
}

export async function fetchActivities(token: string, sinceTimestamp?: string) {
  const params: Record<string, string> = { done: "false" };
  const ts = toRfc3339(sinceTimestamp);
  if (ts) params.updated_since = ts;
  return pdFetchV2<PipedriveActivity>(token, "/activities", params);
}

export async function fetchActivitiesDone(token: string, sinceTimestamp?: string) {
  const params: Record<string, string> = { done: "true" };
  const ts = toRfc3339(sinceTimestamp);
  if (ts) params.updated_since = ts;
  return pdFetchV2<PipedriveActivity>(token, "/activities", params);
}

// v1 — deal flow not available in v2
export async function fetchDealFlow(token: string, dealId: number): Promise<PipedriveDealFlowItem[]> {
  await waitIfNeeded();
  const qs = new URLSearchParams({ api_token: token, limit: "500", start: "0" });
  const url = `https://api.pipedrive.com/v1/deals/${dealId}/flow?${qs}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  updateRl(res);
  if (!res.ok) return [];
  const json = await safeJson(res, `/deals/${dealId}/flow`) as {
    success: boolean;
    data?: PipedriveDealFlowItem[] | null;
  };
  if (!json.success) return [];
  return json.data ?? [];
}

// ── Connection test ──────────────────────────────────────────────────────────

export async function testConnection(
  token: string,
): Promise<{ ok: boolean; companyDomain?: string; error?: string; rateLimitInfo?: string }> {
  try {
    const res = await fetch(`https://api.pipedrive.com/v1/users/me?api_token=${token}`, {
      signal: AbortSignal.timeout(10000),
    });
    updateRl(res);

    if (res.status === 429) {
      const retryAfterRaw = res.headers.get("Retry-After") ?? res.headers.get("x-ratelimit-reset");
      const retryAfterSec = retryAfterRaw ? parseInt(retryAfterRaw, 10) : 0;
      const isDaily = retryAfterSec > 60 || rl.dailyLeft === 0;
      if (isDaily) {
        const resetAt = retryAfterSec > 0
          ? new Date(Date.now() + retryAfterSec * 1000).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" })
          : "meia-noite";
        return { ok: false, error: `Budget diário da API Pipedrive esgotado. Reset às ${resetAt} (horário de Brasília). Tente novamente amanhã.` };
      }
      return { ok: false, error: `Rate limit de burst atingido — aguarde ${retryAfterSec}s e tente novamente` };
    }
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };

    const json = await safeJson(res, "/users/me") as { success: boolean; data?: { company_domain: string } };
    if (!json.success) return { ok: false, error: "Token inválido" };

    return {
      ok: true,
      companyDomain: json.data?.company_domain,
      rateLimitInfo: getRateLimitStatus(),
    };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}
