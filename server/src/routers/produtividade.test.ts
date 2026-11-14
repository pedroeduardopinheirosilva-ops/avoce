import { describe, it, expect, vi, beforeEach } from "vitest";
import jwt from "jsonwebtoken";

const st = vi.hoisted(() => ({
  verProdutividade: true,
  cargoUsuarios: 0,
  criado: null as any,
  dispCriado: null as any,
  monitorados: [] as any[],
  dias: [] as any[],
  findManyArgs: null as any,
  sujos: [] as any[],
  dispUpdateMany: null as any,
  regraAntes: null as any,
  diaAntigo: null as any,
}));

vi.mock("../db.js", () => ({
  prisma: {
    usuario: {
      findUnique: async ({ select }: any) =>
        select?.verProdutividade ? { verProdutividade: st.verProdutividade } : { permissoes: null },
      findMany: async (a: any) => { st.findManyArgs = a; return st.monitorados; },
      create: async (a: any) => { st.criado = a; return { id: "novo", nome: a.data.nome }; },
      update: async () => ({}),
    },
    monitorDia: { findMany: async () => st.dias, findUnique: async () => st.diaAntigo },
    monitorDispositivo: {
      create: async (a: any) => { st.dispCriado = a; return { id: "d1", ...a.data }; },
      update: async () => ({}),
      updateMany: async (a: any) => { st.dispUpdateMany = a; return { count: 1 }; },
    },
    monitorCargo: {
      findMany: async () => [],
      delete: async () => ({}),
    },
    monitorRegra: {
      count: async () => 0,
      createMany: async (a: any) => ({ count: a.data.length }),
      create: async (a: any) => ({ id: "r1", ...a.data }),
      update: async (a: any) => ({ id: a.where.id, ...a.data }),
      delete: async (a: any) => ({ id: a.where.id, cargoId: "c9", usuarioId: null }),
      findUnique: async () => st.regraAntes,
    },
  },
}));
// contagem de pessoas do cargo
vi.mock("../lib/produtividade/agregar.js", () => ({
  carregarEntradasDia: async () => ({ eventos: [], regras: [], pessoa: { usuarioId: "u", cargoId: null, expediente: null } }),
  sujarDias: async (e: any) => { st.sujos.push({ cargoId: e.cargoId ?? null, usuarioId: e.usuarioId ?? null }); return 0; },
}));

process.env.JWT_SECRET = "teste-secret";
const { produtividadeRouter } = await import("./produtividade.js");
const { prisma } = await import("../db.js");

function caller(role = "user") {
  const token = jwt.sign({ userId: "u1", role }, process.env.JWT_SECRET!);
  return produtividadeRouter.createCaller({ req: { headers: { authorization: `Bearer ${token}` } } } as any);
}

beforeEach(() => {
  st.verProdutividade = true; st.cargoUsuarios = 0; st.criado = null; st.dispCriado = null; st.monitorados = []; st.dias = []; st.findManyArgs = null;
  st.sujos = []; st.dispUpdateMany = null; st.regraAntes = null; st.diaAntigo = null;
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

  it("candidatos: só ativos não monitorados, sem filtro de empresa", async () => {
    st.monitorados = [{ id: "u9", nome: "Zé", email: "z@x.com" }];
    const r = await caller().pessoas.candidatos();
    expect(r).toEqual(st.monitorados);
    expect(st.findManyArgs.where).toEqual({ ativo: true, monitorado: false });
  });

  it("neutrosMaisUsados devolve tipo, com fallback para linhas antigas", async () => {
    st.dias = [
      { topJson: { neutro: [{ chave: "chrome.exe", seg: 10 }, { chave: "site.com", seg: 5 }, { chave: "Code", seg: 3 }, { chave: "x.com", seg: 2, tipo: "app" }] } },
      { topJson: { neutro: [{ chave: "chrome.exe", seg: 5, tipo: "app" }] } },
    ];
    const r = await caller().neutrosMaisUsados({ de: "2026-11-01", ate: "2026-11-30" });
    expect(r).toEqual([
      { tipo: "app", chave: "chrome.exe", seg: 15 },
      { tipo: "dominio", chave: "site.com", seg: 5 },
      { tipo: "app", chave: "Code", seg: 3 },
      { tipo: "app", chave: "x.com", seg: 2 },
    ]);
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

  const regra = { alvo: "dominio" as const, padrao: "x.com", categoria: "trabalho" as const, prioridade: 0 };

  it("criar regra suja os dias do escopo dela (geral, cargo, pessoa)", async () => {
    await caller().regras.criar({ ...regra });
    await caller().regras.criar({ ...regra, cargoId: "c1" });
    await caller().regras.criar({ ...regra, usuarioId: "p1" });
    expect(st.sujos).toEqual([
      { cargoId: null, usuarioId: null },
      { cargoId: "c1", usuarioId: null },
      { cargoId: null, usuarioId: "p1" },
    ]);
  });

  it("editar regra que mudou de escopo suja o escopo antigo e o novo", async () => {
    st.regraAntes = { cargoId: "c1", usuarioId: null };
    await caller().regras.editar({ id: "r1", ...regra, usuarioId: "p2" });
    expect(st.sujos).toEqual([{ cargoId: "c1", usuarioId: null }, { cargoId: null, usuarioId: "p2" }]);
    st.sujos = []; st.regraAntes = { cargoId: null, usuarioId: "p2" };
    await caller().regras.editar({ id: "r1", ...regra, usuarioId: "p2", categoria: "pessoal" });
    expect(st.sujos).toEqual([{ cargoId: null, usuarioId: "p2" }]);
  });

  it("excluir regra suja o escopo da regra excluída; semear suja todos", async () => {
    await caller().regras.excluir({ id: "r1" });
    expect(st.sujos).toEqual([{ cargoId: "c9", usuarioId: null }]);
    st.sujos = [];
    const r = await caller().regras.semear();
    expect(r.inseridas).toBeGreaterThan(0);
    expect(st.sujos).toEqual([{ cargoId: null, usuarioId: null }]);
  });

  it("mudar cargo ou expediente suja os dias da pessoa; só monitorado não", async () => {
    await caller().pessoas.atualizar({ usuarioId: "p1", cargoId: "c2" });
    await caller().pessoas.atualizar({ usuarioId: "p1", expediente: null });
    expect(st.sujos).toEqual([{ cargoId: null, usuarioId: "p1" }, { cargoId: null, usuarioId: "p1" }]);
    st.sujos = [];
    await caller().pessoas.atualizar({ usuarioId: "p1", monitorado: true });
    expect(st.sujos).toEqual([]);
    expect(st.dispUpdateMany).toBeNull();
  });

  it("desmarcar monitorado revoga todos os dispositivos da pessoa", async () => {
    await caller().pessoas.atualizar({ usuarioId: "p1", monitorado: false });
    expect(st.dispUpdateMany).toEqual({
      where: { usuarioId: "p1" },
      data: { ativo: false, tokenHash: null, codigoPareamento: null, codigoExpiraEm: null },
    });
  });

  it("pessoa: dia fora da retenção vem do MonitorDia no formato de ResultadoDia", async () => {
    st.diaAntigo = {
      segAtivo: 100, segTrabalho: 60, segPessoal: 30, segNeutro: 10,
      segAtivoFora: 5, segTrabalhoFora: 5, segPessoalFora: 0, segNeutroFora: 0,
      primeiroEvento: new Date("2026-01-05T11:00:00Z"), ultimoEvento: new Date("2026-01-05T20:00:00Z"),
      topJson: { trabalho: [{ chave: "excel", seg: 60, tipo: "app" }] },
    };
    const r = await caller().pessoa({ usuarioId: "p1", data: "2026-01-05" });
    expect(r).toEqual({
      data: "2026-01-05",
      dentro: { ativo: 100, trabalho: 60, pessoal: 30, neutro: 10 },
      fora: { ativo: 5, trabalho: 5, pessoal: 0, neutro: 0 },
      primeiroEvento: st.diaAntigo.primeiroEvento,
      ultimoEvento: st.diaAntigo.ultimoEvento,
      top: { trabalho: [{ chave: "excel", seg: 60, tipo: "app" }], pessoal: [], neutro: [] },
      blocos: [],
    });
    st.diaAntigo = null;
    const vazio = await caller().pessoa({ usuarioId: "p1", data: "2026-01-05" });
    expect(vazio.dentro).toEqual({ ativo: 0, trabalho: 0, pessoal: 0, neutro: 0 });
    expect(vazio.top).toEqual({ trabalho: [], pessoal: [], neutro: [] });
  });

  it("atualizar rejeita expediente com inicio >= fim", async () => {
    await expect(
      caller().pessoas.atualizar({ usuarioId: "p1", expediente: { dias: [1], inicio: "18:00", fim: "08:00" } }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
