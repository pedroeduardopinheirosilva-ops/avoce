import { describe, it, expect, vi, beforeEach } from "vitest";
import jwt from "jsonwebtoken";

const st = vi.hoisted(() => ({
  verProdutividade: true,
  cargoUsuarios: 0,
  criado: null as any,
  dispCriado: null as any,
  monitorados: [] as any[],
}));

vi.mock("../db.js", () => ({
  prisma: {
    usuario: {
      findUnique: async ({ select }: any) =>
        select?.verProdutividade ? { verProdutividade: st.verProdutividade } : { permissoes: null },
      findMany: async () => st.monitorados,
      create: async (a: any) => { st.criado = a; return { id: "novo", nome: a.data.nome }; },
      update: async () => ({}),
    },
    monitorDia: { findMany: async () => [] },
    monitorDispositivo: {
      create: async (a: any) => { st.dispCriado = a; return { id: "d1", ...a.data }; },
      update: async () => ({}),
    },
    monitorCargo: {
      findMany: async () => [],
      delete: async () => ({}),
    },
    monitorRegra: { count: async () => 0, createMany: async () => ({ count: 0 }) },
  },
}));
// contagem de pessoas do cargo
vi.mock("../lib/produtividade/agregar.js", () => ({
  carregarEntradasDia: async () => ({ eventos: [], regras: [], pessoa: { usuarioId: "u", cargoId: null, expediente: null } }),
}));

process.env.JWT_SECRET = "teste-secret";
const { produtividadeRouter } = await import("./produtividade.js");
const { prisma } = await import("../db.js");

function caller(role = "user") {
  const token = jwt.sign({ userId: "u1", role }, process.env.JWT_SECRET!);
  return produtividadeRouter.createCaller({ req: { headers: { authorization: `Bearer ${token}` } } } as any);
}

beforeEach(() => {
  st.verProdutividade = true; st.cargoUsuarios = 0; st.criado = null; st.dispCriado = null; st.monitorados = [];
  (prisma.usuario as any).count = async () => st.cargoUsuarios;
});

describe("produtividade router", () => {
  it("admin sem verProdutividade recebe FORBIDDEN", async () => {
    st.verProdutividade = false;
    await expect(caller("admin").equipe({ de: "2026-11-01", ate: "2026-11-07" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("usuário com verProdutividade lista a equipe", async () => {
    st.monitorados = [{ id: "p1", nome: "Ana", monitorCargo: { nome: "Adv" }, monitorDispositivos: [] }];
    const r = await caller().equipe({ de: "2026-11-01", ate: "2026-11-07" });
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ usuarioId: "p1", nome: "Ana", cargo: "Adv", coletorParadoHa: null });
    expect(r[0].soma.dentro.trabalho).toBe(0);
  });

  it("criarSoMonitorado cria usuário sem nenhum módulo", async () => {
    await caller().pessoas.criarSoMonitorado({ nome: "Bia" });
    const d = st.criado.data;
    expect(d.permissoes).toEqual({ modulos: [] });
    expect(d.monitorado).toBe(true);
    expect(d.ativo).toBe(true);
    expect(d.email).toMatch(/^monitor\+.+@avoce\.local$/);
    expect(d.senha).toMatch(/^\$2[aby]\$/);
  });

  it("gerarCodigo expira em 24 h", async () => {
    const antes = Date.now();
    const r = await caller().dispositivos.gerarCodigo({ usuarioId: "p1", nome: "PC" });
    expect(r.codigo).toMatch(/^[A-Z2-9]{8}$/);
    const dt = r.expiraEm.getTime() - antes;
    expect(dt).toBeGreaterThan(24 * 3600e3 - 5000);
    expect(dt).toBeLessThan(24 * 3600e3 + 5000);
    expect(st.dispCriado.data.codigoPareamento).toBe(r.codigo);
  });

  it("excluir cargo com pessoas falha", async () => {
    st.cargoUsuarios = 2;
    await expect(caller().cargos.excluir({ id: "c1" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("atualizar rejeita expediente com inicio >= fim", async () => {
    await expect(
      caller().pessoas.atualizar({ usuarioId: "p1", expediente: { dias: [1], inicio: "18:00", fim: "08:00" } }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
