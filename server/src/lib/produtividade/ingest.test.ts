import { describe, it, expect, vi, beforeEach } from "vitest";

type Disp = any;
const st = vi.hoisted(() => ({ disps: [] as any[], eventos: [] as any[], dias: [] as any[], updates: 0 }));

vi.mock("../../db.js", () => {
  const match = (o: any, w: any) => Object.entries(w).every(([k, v]) => o[k] === v);
  return {
    prisma: {
      monitorDispositivo: {
        findFirst: async ({ where }: any) => st.disps.find((d) => match(d, where)) ?? null,
        update: async ({ where, data }: any) => { const d = st.disps.find((x) => x.id === where.id); Object.assign(d, data); return d; },
        updateMany: async ({ where, data }: any) => {
          const d = st.disps.find((x) => x.id === where.id && x.codigoPareamento === where.codigoPareamento && x.pareadoEm === null
            && x.codigoExpiraEm && x.codigoExpiraEm.getTime() >= where.codigoExpiraEm.gte.getTime());
          if (!d) return { count: 0 };
          Object.assign(d, data); return { count: 1 };
        },
      },
      monitorEvento: {
        findMany: async ({ where }: any) =>
          st.eventos.filter((e) => e.dispositivoId === where.dispositivoId && where.inicio.in.some((i: Date) => i.getTime() === e.inicio.getTime())),
        createMany: async ({ data }: any) => { st.eventos.push(...data.map((d: any) => ({ ...d }))); return { count: data.length }; },
        update: async ({ where, data }: any) => {
          const k = where.dispositivoId_bucket_inicio;
          const e = st.eventos.find((x) => x.dispositivoId === k.dispositivoId && x.bucket === k.bucket && x.inicio.getTime() === k.inicio.getTime());
          st.updates++; Object.assign(e, data); return e;
        },
      },
      monitorDia: {
        upsert: async ({ where, create }: any) => {
          const k = where.usuarioId_data;
          const ex = st.dias.find((d) => d.usuarioId === k.usuarioId && d.data === k.data);
          if (ex) ex.sujo = true; else st.dias.push({ ...create });
        },
      },
    },
  };
});

const { parear, ingerir, hashToken, gerarCodigoPareamento } = await import("./ingest.js");
const { dataLocal } = await import("./calculo.js");

const disp = (o: Partial<Disp> = {}): Disp => ({ id: "d1", usuarioId: "u1", nome: "x", so: null, tokenHash: null, codigoPareamento: null, codigoExpiraEm: null, pareadoEm: null, bucketsVistos: [], ativo: true, ...o });
const iso = (ms: number) => new Date(ms).toISOString();

beforeEach(() => { st.disps = []; st.eventos = []; st.dias = []; st.updates = 0; });

describe("gerarCodigoPareamento", () => {
  it("8 caracteres do alfabeto sem ambíguos", () => {
    expect(gerarCodigoPareamento()).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
  });
});

describe("parear", () => {
  it("pareia com código válido e o código não serve de novo", async () => {
    st.disps.push(disp({ codigoPareamento: "ABCD2345", codigoExpiraEm: new Date(Date.now() + 60_000) }));
    const r = await parear({ codigo: "abcd2345", nome: "PC", so: "windows" });
    expect(r.dispositivoId).toBe("d1");
    expect(st.disps[0].tokenHash).toBe(hashToken(r.token));
    await expect(parear({ codigo: "ABCD2345", nome: "PC", so: "windows" })).rejects.toThrow("codigo_invalido");
  });
  it("código vencido é recusado", async () => {
    st.disps.push(disp({ codigoPareamento: "ABCD2345", codigoExpiraEm: new Date(Date.now() - 1000) }));
    await expect(parear({ codigo: "ABCD2345", nome: "PC", so: "mac" })).rejects.toThrow("codigo_invalido");
  });
});

describe("ingerir", () => {
  const tok = "tok";
  const ativo = (o: Partial<Disp> = {}) => st.disps.push(disp({ tokenHash: hashToken(tok), ...o }));
  const lote = (eventos: any[]) => ({ versao: "1.0", so: "windows", eventos });

  it("token revogado é recusado e nada é gravado", async () => {
    ativo({ ativo: false });
    await expect(ingerir(tok, lote([{ bucket: "afk", inicio: iso(Date.now() - 1000), duracaoSeg: 5 }]))).rejects.toThrow("token_invalido");
    expect(st.eventos).toHaveLength(0);
  });
  it("reenvio do mesmo evento com duração maior atualiza, não duplica", async () => {
    ativo();
    const inicio = iso(Date.now() - 3600_000);
    await ingerir(tok, lote([{ bucket: "janela", inicio, duracaoSeg: 60, app: "chrome" }]));
    await ingerir(tok, lote([{ bucket: "janela", inicio, duracaoSeg: 300, app: "chrome" }]));
    expect(st.eventos).toHaveLength(1);
    expect(st.eventos[0].duracaoSeg).toBe(300);
  });
  it("evento de 10 dias atrás marca aquele dia como sujo", async () => {
    ativo();
    const t = Date.now() - 10 * 86400_000;
    const r = await ingerir(tok, lote([{ bucket: "afk", inicio: iso(t), duracaoSeg: 30, afk: false }]));
    expect(r.dias).toContain(dataLocal(new Date(t)));
    expect(st.dias.find((d) => d.data === dataLocal(new Date(t)))?.sujo).toBe(true);
  });
  it("durações absurdas ou negativas são descartadas e o resto do lote é salvo", async () => {
    ativo();
    const t = Date.now() - 60_000;
    const r = await ingerir(tok, lote([
      { bucket: "afk", inicio: iso(t), duracaoSeg: 1e300 },
      { bucket: "afk", inicio: iso(t - 1000), duracaoSeg: 1e15 },
      { bucket: "afk", inicio: iso(t - 2000), duracaoSeg: -1 },
      { bucket: "afk", inicio: iso(t - 3000), duracaoSeg: 86401 },
      { bucket: "afk", inicio: iso(t - 4000), duracaoSeg: 20 },
    ]));
    expect(r.gravados).toBe(1);
    expect(st.eventos).toHaveLength(1);
  });
  it("reenvio de lote idêntico não faz nenhum update de evento nem suja dias", async () => {
    ativo();
    const l = lote([{ bucket: "janela", inicio: iso(Date.now() - 3600_000), duracaoSeg: 60, app: "x", titulo: "t" }]);
    await ingerir(tok, l);
    st.dias.forEach((d) => (d.sujo = false));
    const r = await ingerir(tok, l);
    expect(st.updates).toBe(0);
    expect(r.dias).toEqual([]);
    expect(st.dias.every((d) => d.sujo === false)).toBe(true);
  });
  it("evento no futuro distante é descartado", async () => {
    ativo();
    const r = await ingerir(tok, lote([{ bucket: "afk", inicio: iso(Date.now() + 3600_000), duracaoSeg: 30 }]));
    expect(r.gravados).toBe(0);
    expect(st.eventos).toHaveLength(0);
  });
  it("lote com evento web marca o bucket como visto e janela com título atualiza ultimoTituloEm", async () => {
    ativo();
    const t = Date.now() - 60_000;
    await ingerir(tok, lote([
      { bucket: "web", inicio: iso(t), duracaoSeg: 10, url: "https://www.exemplo.com.br/x" },
      { bucket: "janela", inicio: iso(t - 5000), duracaoSeg: 10, app: "chrome", titulo: "Pagina" },
    ]));
    expect(st.disps[0].bucketsVistos).toEqual(expect.arrayContaining(["web", "janela"]));
    expect(st.disps[0].ultimoTituloEm).toBeInstanceOf(Date);
    expect(st.eventos.find((e) => e.bucket === "web").dominio).toBeTruthy();
  });
});
