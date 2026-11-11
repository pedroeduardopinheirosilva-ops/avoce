/**
 * Integração: payload real do webhook da Evolution (anúncio CTWA, capturado em produção e
 * anonimizado) → origem gravada com ctwa_clid → marco de lead qualificado → envio à
 * Conversions API for Business Messaging. Prisma e fetch são falsos em memória.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const fixtures = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../__fixtures__/webhook-evolution-ctwa.json"), "utf8"),
);

const { db } = vi.hoisted(() => {
  const db = {
    deals: new Map<string, Record<string, any>>(),
    eventos: [] as Record<string, any>[],
    iaConfig: [] as { projetoId: string; chave: string; valor: string }[],
    mktToken: "TOKEN_SYSTEM_USER",
  };
  return { db };
});

function casa(row: Record<string, any>, where: Record<string, any>): boolean {
  return Object.entries(where).every(([k, v]) => {
    const val = row[k];
    if (v && typeof v === "object" && !(v instanceof Date)) {
      if ("in" in v) return v.in.includes(val);
      if ("lte" in v) return val <= v.lte;
      if ("lt" in v) return val < v.lt;
      if ("gte" in v) return val >= v.gte;
      if ("startsWith" in v) return String(val).startsWith(v.startsWith);
    }
    return val === v;
  });
}

vi.mock("../../db.js", () => ({
  prisma: {
    crmDeal: {
      update: vi.fn(async ({ where, data }: any) => Object.assign(db.deals.get(where.id)!, data)),
      findUnique: vi.fn(async ({ where }: any) => db.deals.get(where.id) ?? null),
    },
    iaProjetoConfig: {
      findUnique: vi.fn(async ({ where }: any) =>
        db.iaConfig.find((c) => c.projetoId === where.projetoId_chave.projetoId && c.chave === where.projetoId_chave.chave) ?? null),
      findMany: vi.fn(async ({ where }: any) => db.iaConfig.filter((c) => casa(c, where))),
    },
    mktConfig: {
      findUnique: vi.fn(async () => ({ valor: db.mktToken, valorEncrypted: false })),
    },
    metaConversaoEvento: {
      create: vi.fn(async ({ data }: any) => {
        if (db.eventos.some((e) => e.eventId === data.eventId)) {
          throw Object.assign(new Error("Unique constraint"), { code: "P2002" });
        }
        const row = { id: `ev${db.eventos.length + 1}`, tentativas: 0, proximaTentativaEm: new Date(0), atualizadoEm: new Date(), ...data };
        db.eventos.push(row);
        return row;
      }),
      findMany: vi.fn(async ({ where }: any) => db.eventos.filter((e) => casa(e, where))
        .map((e) => ({ ...e, deal: db.deals.get(e.dealId) }))),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const alvo = db.eventos.filter((e) => casa(e, where));
        alvo.forEach((e) => Object.assign(e, data, { atualizadoEm: new Date() }));
        return { count: alvo.length };
      }),
      update: vi.fn(async ({ where, data }: any) => Object.assign(db.eventos.find((e) => e.id === where.id)!, data)),
    },
  },
}));

import { extrairOrigem, registrarOrigemDeal } from "../lead-origem.js";
import { marcarEntradaEtapa, gerarEventId } from "../lead-qualificado.js";
import { processarFilaMetaCapi, classificarResposta, proximoAtraso } from "../../lib/meta-capi.js";

const PROJETO = "proj_carreteiros";

function configurarCapi(extra: Record<string, string> = {}) {
  const cfg = {
    meta_capi_ativo: "true",
    meta_capi_dataset_id: "999000111",
    meta_capi_waba_id: "1927080631480523",
    meta_capi_mkt_projeto_id: "mkt1",
    ...extra,
  };
  db.iaConfig = Object.entries(cfg).map(([chave, valor]) => ({ projetoId: PROJETO, chave, valor }));
}

describe("atribuição CTWA → lead qualificado → Conversions API", () => {
  const envOriginal = process.env.NODE_ENV;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    db.deals.clear();
    db.eventos.length = 0;
    db.iaConfig = [];
    db.deals.set("d1", { id: "d1", projetoId: PROJETO, origemEm: null, origemCtwaClid: null });
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ events_received: 1, fbtrace_id: "x" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    process.env.NODE_ENV = "production";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    process.env.NODE_ENV = envOriginal;
  });

  it("extrai ctwa_clid, sourceType e entry point do payload real do anúncio", () => {
    const o = extrairOrigem(fixtures.anuncio_ctwa.data);
    expect(o).toMatchObject({
      plataforma: "facebook",
      tipo: "anuncio",
      anuncioId: "120233076428680484",
      anuncioTitulo: "Fale com um Advogado Especialista",
      sourceType: "ad",
      entryPoint: "ctwa_ad",
    });
    expect(o?.ctwaClid).toMatch(/^AfhFIXTURE/);
  });

  it("lead de link do site (orgânico) não tem ctwa_clid e não é erro", () => {
    const o = extrairOrigem(fixtures.link_site.data);
    expect(o).toMatchObject({ plataforma: "site", tipo: "link", entryPoint: "click_to_chat_link" });
    expect(o?.ctwaClid).toBeUndefined();
  });

  it("fluxo completo: grava origem, marca qualificado uma única vez e envia o payload esperado", async () => {
    await registrarOrigemDeal(db.deals.get("d1") as any, fixtures.anuncio_ctwa.data);
    const clid = db.deals.get("d1")!.origemCtwaClid;
    expect(clid).toMatch(/^AfhFIXTURE/);

    // etapa que não é de qualificado não emite nada
    await marcarEntradaEtapa("d1", "lead_carreteiro", "ia:cliente_respondeu");
    expect(db.eventos).toHaveLength(0);

    await marcarEntradaEtapa("d1", "lead_qualificado", "ia:qualificacao_completa");
    // reentrada / segundo caminho: idempotente
    await marcarEntradaEtapa("d1", "aguardando_reuniao", "reuniao:agendada");
    expect(db.eventos).toHaveLength(1);
    expect(db.eventos[0]).toMatchObject({ status: "pendente", eventId: gerarEventId("d1"), ctwaClid: clid });

    // Flag desligada: nada sai.
    await processarFilaMetaCapi();
    expect(fetchMock).not.toHaveBeenCalled();

    configurarCapi();
    const r = await processarFilaMetaCapi();
    expect(r.enviados).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://graph.facebook.com/v21.0/999000111/events");
    expect(url).not.toContain("TOKEN");
    const body = JSON.parse(String(init.body));
    expect(body.access_token).toBe("TOKEN_SYSTEM_USER");
    expect(body.data[0]).toMatchObject({
      event_name: "QualifiedLead",
      event_id: gerarEventId("d1"),
      action_source: "business_messaging",
      messaging_channel: "whatsapp",
      user_data: { whatsapp_business_account_id: "1927080631480523", ctwa_clid: clid },
    });
    expect(body.test_event_code).toBeUndefined();
    expect(db.eventos[0].status).toBe("enviado");
    expect(db.eventos[0].payload).not.toHaveProperty("access_token");

    // já enviado: próxima rodada não reenvia
    await processarFilaMetaCapi();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falha de rede reagenda com backoff; erro de parâmetro vai para morto", async () => {
    db.deals.get("d1")!.origemCtwaClid = "AfhX";
    await marcarEntradaEtapa("d1", "lead_qualificado", "crm:manual");
    configurarCapi();

    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    await processarFilaMetaCapi();
    expect(db.eventos[0]).toMatchObject({ status: "falhou", tentativas: 1 });
    expect(db.eventos[0].proximaTentativaEm.getTime()).toBeGreaterThan(Date.now());

    db.eventos[0].proximaTentativaEm = new Date(0);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "Invalid parameter", code: 100 } }), { status: 400 }));
    await processarFilaMetaCapi();
    expect(db.eventos[0]).toMatchObject({ status: "morto", tentativas: 2, erro: "Invalid parameter" });
  });

  it("fora de produção só envia com test_event_code", async () => {
    process.env.NODE_ENV = "development";
    db.deals.get("d1")!.origemCtwaClid = "AfhX";
    await marcarEntradaEtapa("d1", "lead_qualificado", "ia:qualificacao_completa");

    configurarCapi();
    await processarFilaMetaCapi();
    expect(fetchMock).not.toHaveBeenCalled();

    configurarCapi({ meta_capi_test_event_code: "TEST123" });
    await processarFilaMetaCapi();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String((fetchMock.mock.calls[0] as any)[1].body)).test_event_code).toBe("TEST123");
  });

  it("lead qualificado sem ctwa_clid fica registrado como sem_ctwa e nunca é enviado", async () => {
    await marcarEntradaEtapa("d1", "lead_qualificado", "ia:qualificacao_completa");
    configurarCapi();
    await processarFilaMetaCapi();
    expect(db.eventos[0].status).toBe("sem_ctwa");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("deal sem projeto de IA (legado Pipedrive) não emite", async () => {
    db.deals.set("legado", { id: "legado", projetoId: null, origemCtwaClid: "AfhX" });
    await marcarEntradaEtapa("legado", "lead_qualificado", "crm:manual");
    expect(db.eventos).toHaveLength(0);
  });
});

describe("regras puras", () => {
  it("event_id é determinístico por deal", () => {
    expect(gerarEventId("abc")).toBe(gerarEventId("abc"));
    expect(gerarEventId("abc")).not.toBe(gerarEventId("abd"));
  });
  it("classifica respostas da Graph API", () => {
    expect(classificarResposta(200, { events_received: 1 })).toBe("enviado");
    expect(classificarResposta(null, {})).toBe("retry");
    expect(classificarResposta(500, {})).toBe("retry");
    expect(classificarResposta(400, { error: { code: 613 } })).toBe("retry");
    expect(classificarResposta(400, { error: { code: 190 } })).toBe("permanente");
  });
  it("backoff exponencial com teto", () => {
    expect(proximoAtraso(1, 0.5)).toBe(60_000);
    expect(proximoAtraso(3, 0.5)).toBe(240_000);
    expect(proximoAtraso(30, 0.5)).toBe(6 * 3_600_000);
  });
});
