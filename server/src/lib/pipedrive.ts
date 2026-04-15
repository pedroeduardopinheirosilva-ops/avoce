/**
 * Pipedrive REST API v1 client (fetch-based, no SDK)
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

export interface PipedrivePerson {
  id: number;
  name: string;
  phone: { value: string; primary: boolean; label?: string }[];
  email: { value: string; primary: boolean }[];
  org_name?: string;
  active_flag: boolean;
}

export interface PipedriveDeal {
  id: number;
  title: string;
  value: number;
  status: "open" | "won" | "lost" | "deleted";
  stage_id: number;
  pipeline_id: number;
  person_id?: { value: number } | null;
  org_id?: { value: number; name: string } | null;
  update_time: string;
  add_time: string;
  notes_count?: number;
  person_phone?: { value: string; primary: boolean; label?: string }[];
  person_email?: { value: string; primary: boolean }[];
  [key: string]: any; // custom fields
}

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
  object: string;      // "dealChange" | "activity" | "note" | ...
  timestamp: string;   // "YYYY-MM-DD HH:mm:ss"
  data: {
    field_key?: string;          // "stage_id" para mudança de etapa
    old_value?: string | null;
    new_value?: string;
    log_time?: string;
    user_id?: number;
    change_source?: string;
  };
}

async function pdFetch<T>(token: string, path: string, params: Record<string, string | number> = {}): Promise<T[]> {
  const qs = new URLSearchParams({ api_token: token, limit: "500", start: "0", ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])) });
  const url = `https://api.pipedrive.com/v1${path}?${qs}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Pipedrive API ${path}: ${res.status} ${res.statusText}`);
  const json = await res.json() as { success: boolean; data: T[] | null; additional_data?: { pagination?: { more_items_in_collection: boolean; next_start: number } } };
  if (!json.success) throw new Error(`Pipedrive API ${path}: success=false`);
  const data: T[] = json.data ?? [];

  // Paginate
  if (json.additional_data?.pagination?.more_items_in_collection) {
    const next = await pdFetch<T>(token, path, { ...params, start: json.additional_data.pagination.next_start });
    return [...data, ...next];
  }
  return data;
}

export async function fetchPipelines(token: string) {
  return pdFetch<PipedrivePipeline>(token, "/pipelines");
}

export async function fetchStages(token: string) {
  return pdFetch<PipedriveStage>(token, "/stages");
}

export async function fetchPersons(token: string) {
  return pdFetch<PipedrivePerson>(token, "/persons");
}

export async function fetchDeals(token: string, status = "all_not_deleted") {
  return pdFetch<PipedriveDeal>(token, "/deals", { status });
}

export async function fetchDealFields(token: string) {
  return pdFetch<PipedriveDealField>(token, "/dealFields");
}

export async function fetchNotes(token: string) {
  return pdFetch<PipedriveNote>(token, "/notes");
}

export async function fetchActivities(token: string) {
  return pdFetch<PipedriveActivity>(token, "/activities", { type: "", done: "0" });
}

export async function fetchActivitiesDone(token: string) {
  return pdFetch<PipedriveActivity>(token, "/activities", { done: "1" });
}

export async function fetchDealFlow(token: string, dealId: number): Promise<PipedriveDealFlowItem[]> {
  const qs = new URLSearchParams({ api_token: token, limit: "500", start: "0" });
  const url = `https://api.pipedrive.com/v1/deals/${dealId}/flow?${qs}`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const json = await res.json() as { success: boolean; data?: PipedriveDealFlowItem[] | null };
  if (!json.success) return [];
  return json.data ?? [];
}

export async function testConnection(token: string): Promise<{ ok: boolean; companyDomain?: string; error?: string }> {
  try {
    const res = await fetch(`https://api.pipedrive.com/v1/users/me?api_token=${token}`);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const json = await res.json() as { success: boolean; data?: { company_domain: string } };
    if (!json.success) return { ok: false, error: "Token inválido" };
    return { ok: true, companyDomain: json.data?.company_domain };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}
