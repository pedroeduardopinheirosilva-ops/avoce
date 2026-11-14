import { describe, it, expect, vi, beforeEach } from "vitest";

const st = vi.hoisted(() => ({
  usuario: null as any,
  disps: [] as any[],
  eventos: [] as any[],
  regras: [] as any[],
  upserts: [] as any[],
  deleteWhere: null as any,
  calcArgs: null as any,
}));

vi.mock("../../db.js", () => ({
  prisma: {
    usuario: { findUnique: async () => st.usuario, findMany: async () => [] },
    monitorDispositivo: { findMany: async () => st.disps },
    monitorEvento: {
      findMany: async () => st.eventos,
      deleteMany: async ({ where }: any) => { st.deleteWhere = where; return { count: 3 }; },
    },
    monitorRegra: { findMany: async () => st.regras },
    monitorDia: { upsert: async (a: any) => { st.upserts.push(a); }, findMany: async () => [] },
  },
}));

const { recalcularDia, apagarEventosAntigos } = await import("./agregar.js");

// 2026-11-11 é quarta; 10:00-03:00 = 13:00Z
const ev = (bucket: string, hora: number, dur: number, extra: any = {}) => ({
  dispositivoId: "d1", bucket, inicio: new Date(Date.UTC(2026, 10, 11, hora + 3, 0, 0)), duracaoSeg: dur,
  app: null, titulo: null, url: null, dominio: null, afk: null, ...extra,
});

beforeEach(() => {
  st.usuario = { monitorCargoId: null, monitorExpediente: null };
  st.disps = [{ id: "d1" }];
  st.regras = [{ alvo: "app", padrao: "excel", categoria: "trabalho", cargoId: null, usuarioId: null, prioridade: 0 }];
  st.eventos = [
    ev("afk", 10, 3600, { afk: false }),
    ev("janela", 10, 3600, { app: "excel.exe", titulo: "planilha" }),
  ];
  st.upserts = []; st.deleteWhere = null;
});

describe("recalcularDia", () => {
  it("grava os totais e limpa sujo", async () => {
    const r = await recalcularDia("u1", "2026-11-11");
    expect(r.dentro.trabalho).toBe(3600);
    const up = st.upserts[0];
    expect(up.where.usuarioId_data).toEqual({ usuarioId: "u1", data: "2026-11-11" });
    expect(up.update.segTrabalho).toBe(3600);
    expect(up.update.segAtivo).toBe(3600);
    expect(up.update.sujo).toBe(false);
    expect(up.update.calculadoEm).toBeInstanceOf(Date);
    expect(up.update.topJson).toBeTruthy();
  });

  it("usa EXPEDIENTE_PADRAO quando monitorExpediente é null", async () => {
    // 10h numa quarta cai dentro do padrão seg–sex 08–18
    await recalcularDia("u1", "2026-11-11");
    expect(st.upserts[0].update.segTrabalho).toBe(3600);
    expect(st.upserts[0].update.segTrabalhoFora).toBe(0);
  });

  it("expediente do usuário muda dentro/fora", async () => {
    st.usuario = { monitorCargoId: null, monitorExpediente: { dias: [1, 2, 3, 4, 5], inicio: "14:00", fim: "18:00" } };
    await recalcularDia("u1", "2026-11-11");
    expect(st.upserts[0].update.segTrabalho).toBe(0);
    expect(st.upserts[0].update.segTrabalhoFora).toBe(3600);
  });
});

describe("apagarEventosAntigos", () => {
  it("usa corte de 90 dias", async () => {
    const antes = Date.now();
    const n = await apagarEventosAntigos();
    expect(n).toBe(3);
    const corte = st.deleteWhere.inicio.lt.getTime();
    expect(Math.abs(corte - (antes - 90 * 86_400_000))).toBeLessThan(5000);
  });
});
