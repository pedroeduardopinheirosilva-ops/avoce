import { z }             from "zod";
import { TRPCError }     from "@trpc/server";
import { Prisma }         from "@prisma/client";
import bcrypt            from "bcryptjs";
import { randomBytes }   from "node:crypto";
import { router, authProc } from "./trpc.js";
import { prisma }        from "../db.js";
import { calcularDia } from "../lib/produtividade/calculo.js";
import { carregarEntradasDia, sujarDias } from "../lib/produtividade/agregar.js";
import { gerarCodigoPareamento }  from "../lib/produtividade/ingest.js";
import { REGRAS_INICIAIS }        from "../lib/produtividade/regras-iniciais.js";
import { limiteRetencao }         from "../lib/produtividade/retencao.js";
import type { ResultadoDia, Totais } from "../lib/produtividade/tipos.js";

const HORA_MS = 3600_000;
const DIA_MS = 24 * HORA_MS;

/** Painel visível só para quem tem `verProdutividade`; lido do banco a cada chamada (admin não ignora). */
export const produtividadeProc = authProc.use(async ({ ctx, next }) => {
  const u = await prisma.usuario.findUnique({ where: { id: ctx.userId }, select: { verProdutividade: true } });
  if (!u?.verProdutividade) throw new TRPCError({ code: "FORBIDDEN", message: "Sem acesso ao monitor de produtividade" });
  return next();
});

const dataStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const expedienteSchema = z
  .object({
    dias: z.array(z.number().int().min(0).max(6)).max(7),
    inicio: hhmm,
    fim: hhmm,
  })
  .refine((e) => e.inicio < e.fim, { message: "Expediente deve terminar depois de começar (virada de dia não é suportada)" });

const regraBase = {
  alvo: z.enum(["app", "dominio", "titulo"]),
  padrao: z.string().trim().min(1).max(200),
  categoria: z.enum(["trabalho", "pessoal", "neutro"]),
  cargoId: z.string().nullable().optional(),
  usuarioId: z.string().nullable().optional(),
  prioridade: z.number().int().min(-1000).max(1000).default(0),
};

const somar = (a: Totais, b: Totais): Totais => ({
  ativo: a.ativo + b.ativo, trabalho: a.trabalho + b.trabalho, pessoal: a.pessoal + b.pessoal, neutro: a.neutro + b.neutro,
});
const zero = (): Totais => ({ ativo: 0, trabalho: 0, pessoal: 0, neutro: 0 });

type LinhaDia = {
  segAtivo: number; segTrabalho: number; segPessoal: number; segNeutro: number;
  segAtivoFora: number; segTrabalhoFora: number; segPessoalFora: number; segNeutroFora: number;
  primeiroEvento: Date | null; ultimoEvento: Date | null; topJson: Prisma.JsonValue | null;
};

/** MonitorDia → formato de ResultadoDia (top vem de topJson; sem blocos). */
function diaParaResultado(data: string, dia: LinhaDia | null): ResultadoDia {
  const top = (dia?.topJson ?? {}) as Partial<ResultadoDia["top"]>;
  return {
    data,
    dentro: dia ? { ativo: dia.segAtivo, trabalho: dia.segTrabalho, pessoal: dia.segPessoal, neutro: dia.segNeutro } : zero(),
    fora: dia ? { ativo: dia.segAtivoFora, trabalho: dia.segTrabalhoFora, pessoal: dia.segPessoalFora, neutro: dia.segNeutroFora } : zero(),
    primeiroEvento: dia?.primeiroEvento ?? null,
    ultimoEvento: dia?.ultimoEvento ?? null,
    top: { trabalho: top.trabalho ?? [], pessoal: top.pessoal ?? [], neutro: top.neutro ?? [] },
    blocos: [],
  };
}

const regrasRouter = router({
  listar: produtividadeProc.query(() => prisma.monitorRegra.findMany({ orderBy: [{ categoria: "asc" }, { padrao: "asc" }] })),
  // Toda mudança de regra suja os dias recalculáveis de quem ela afeta (o cron recalcula).
  criar: produtividadeProc.input(z.object(regraBase)).mutation(async ({ input }) => {
    const r = await prisma.monitorRegra.create({ data: { ...input, cargoId: input.cargoId ?? null, usuarioId: input.usuarioId ?? null } });
    await sujarDias(r);
    return r;
  }),
  editar: produtividadeProc.input(z.object({ id: z.string(), ...regraBase })).mutation(async ({ input }) => {
    const { id, ...rest } = input;
    const antes = await prisma.monitorRegra.findUnique({ where: { id }, select: { cargoId: true, usuarioId: true } });
    const r = await prisma.monitorRegra.update({ where: { id }, data: { ...rest, cargoId: rest.cargoId ?? null, usuarioId: rest.usuarioId ?? null } });
    if (antes && (antes.cargoId !== r.cargoId || antes.usuarioId !== r.usuarioId)) await sujarDias(antes);
    await sujarDias(r);
    return r;
  }),
  excluir: produtividadeProc.input(z.object({ id: z.string() })).mutation(async ({ input }) => {
    const r = await prisma.monitorRegra.delete({ where: { id: input.id } });
    await sujarDias(r);
    return r;
  }),
  semear: produtividadeProc.mutation(async () => {
    if ((await prisma.monitorRegra.count()) > 0) return { inseridas: 0 };
    const r = await prisma.monitorRegra.createMany({ data: REGRAS_INICIAIS.map((x) => ({ ...x, cargoId: null, usuarioId: null })) });
    if (r.count > 0) await sujarDias({});
    return { inseridas: r.count };
  }),
});

const cargosRouter = router({
  listar: produtividadeProc.query(() => prisma.monitorCargo.findMany({ orderBy: { nome: "asc" } })),
  criar: produtividadeProc.input(z.object({ nome: z.string().trim().min(1).max(100) })).mutation(({ input }) =>
    prisma.monitorCargo.create({ data: { nome: input.nome } }),
  ),
  renomear: produtividadeProc.input(z.object({ id: z.string(), nome: z.string().trim().min(1).max(100) })).mutation(({ input }) =>
    prisma.monitorCargo.update({ where: { id: input.id }, data: { nome: input.nome } }),
  ),
  excluir: produtividadeProc.input(z.object({ id: z.string() })).mutation(async ({ input }) => {
    const n = await prisma.usuario.count({ where: { monitorCargoId: input.id } });
    if (n > 0) throw new TRPCError({ code: "BAD_REQUEST", message: "Cargo possui pessoas; mova-as antes de excluir" });
    await prisma.monitorCargo.delete({ where: { id: input.id } });
    return { ok: true };
  }),
});

const pessoasRouter = router({
  listar: produtividadeProc.query(async () => {
    const agora = Date.now();
    const us = await prisma.usuario.findMany({
      where: { monitorado: true },
      orderBy: { nome: "asc" },
      select: {
        id: true, nome: true, monitorCargoId: true, monitorExpediente: true,
        monitorDispositivos: { orderBy: { criadoEm: "asc" } },
      },
    });
    return us.map((u) => ({
      id: u.id,
      nome: u.nome,
      cargoId: u.monitorCargoId,
      expediente: u.monitorExpediente,
      dispositivos: u.monitorDispositivos.map((d) => ({
        id: d.id, nome: d.nome, so: d.so, ativo: d.ativo, pareadoEm: d.pareadoEm, ultimoEnvioEm: d.ultimoEnvioEm,
        versaoColetor: d.versaoColetor, codigoPareamento: d.codigoPareamento, codigoExpiraEm: d.codigoExpiraEm,
        checks: {
          enviando: !!d.ultimoEnvioEm && agora - d.ultimoEnvioEm.getTime() < 2 * HORA_MS,
          sites: d.bucketsVistos.includes("web"),
          titulos: !!d.ultimoTituloEm && agora - d.ultimoTituloEm.getTime() < DIA_MS,
        },
      })),
    }));
  }),

  candidatos: produtividadeProc.query(() =>
    prisma.usuario.findMany({
      where: { ativo: true, monitorado: false },
      orderBy: { nome: "asc" },
      select: { id: true, nome: true, email: true },
    }),
  ),

  criarSoMonitorado: produtividadeProc.input(z.object({ nome: z.string().trim().min(1).max(200) })).mutation(async ({ input }) => {
    const senha = await bcrypt.hash(randomBytes(32).toString("hex"), 10);
    const u = await prisma.usuario.create({
      data: {
        nome: input.nome,
        email: `monitor+${randomBytes(8).toString("hex")}@avoce.local`,
        senha,
        permissoes: { modulos: [] },
        monitorado: true,
        ativo: true,
      },
      select: { id: true, nome: true },
    });
    return u;
  }),

  atualizar: produtividadeProc
    .input(z.object({
      usuarioId: z.string(),
      monitorado: z.boolean().optional(),
      cargoId: z.string().nullable().optional(),
      expediente: expedienteSchema.nullable().optional(),
    }))
    .mutation(async ({ input }) => {
      const data: Record<string, unknown> = {};
      if (input.monitorado !== undefined) data.monitorado = input.monitorado;
      if (input.cargoId !== undefined) data.monitorCargoId = input.cargoId;
      // Json nullable: limpar (voltar ao padrão) exige Prisma.DbNull
      if (input.expediente !== undefined) data.monitorExpediente = input.expediente ?? Prisma.DbNull;
      await prisma.usuario.update({ where: { id: input.usuarioId }, data });
      if (input.monitorado === false) {
        // Parar de monitorar revoga os dispositivos (e códigos pendentes); voltar exige reinstalar o coletor.
        await prisma.monitorDispositivo.updateMany({
          where: { usuarioId: input.usuarioId },
          data: { ativo: false, tokenHash: null, codigoPareamento: null, codigoExpiraEm: null },
        });
      }
      // Cargo muda as regras aplicáveis; expediente muda dentro/fora: recalcular os dias ainda possíveis.
      if (input.cargoId !== undefined || input.expediente !== undefined) await sujarDias({ usuarioId: input.usuarioId });
      return { ok: true };
    }),
});

const dispositivosRouter = router({
  gerarCodigo: produtividadeProc
    .input(z.object({ usuarioId: z.string(), nome: z.string().trim().min(1).max(200) }))
    .mutation(async ({ input }) => {
      const codigo = gerarCodigoPareamento();
      const expiraEm = new Date(Date.now() + DIA_MS);
      await prisma.monitorDispositivo.create({
        data: { usuarioId: input.usuarioId, nome: input.nome, codigoPareamento: codigo, codigoExpiraEm: expiraEm },
      });
      return { codigo, expiraEm };
    }),
  revogar: produtividadeProc.input(z.object({ id: z.string() })).mutation(async ({ input }) => {
    await prisma.monitorDispositivo.update({ where: { id: input.id }, data: { ativo: false, tokenHash: null } });
    return { ok: true };
  }),
});

export const produtividadeRouter = router({
  equipe: produtividadeProc.input(z.object({ de: dataStr, ate: dataStr })).query(async ({ input }) => {
    const agora = Date.now();
    const us = await prisma.usuario.findMany({
      where: { monitorado: true },
      orderBy: { nome: "asc" },
      select: {
        id: true, nome: true,
        monitorCargo: { select: { nome: true } },
        monitorDispositivos: { where: { ativo: true }, select: { ultimoEnvioEm: true } },
      },
    });
    const dias = await prisma.monitorDia.findMany({
      where: { usuarioId: { in: us.map((u) => u.id) }, data: { gte: input.de, lte: input.ate } },
      orderBy: { data: "asc" },
    });
    return us.map((u) => {
      const meus = dias.filter((d) => d.usuarioId === u.id);
      let dentro = zero(), fora = zero();
      for (const d of meus) {
        dentro = somar(dentro, { ativo: d.segAtivo, trabalho: d.segTrabalho, pessoal: d.segPessoal, neutro: d.segNeutro });
        fora = somar(fora, { ativo: d.segAtivoFora, trabalho: d.segTrabalhoFora, pessoal: d.segPessoalFora, neutro: d.segNeutroFora });
      }
      const envios = u.monitorDispositivos.map((d) => d.ultimoEnvioEm?.getTime()).filter((x): x is number => !!x);
      const ultimo = envios.length ? Math.max(...envios) : null;
      const horas = ultimo === null ? null : (agora - ultimo) / HORA_MS;
      return {
        usuarioId: u.id,
        nome: u.nome,
        cargo: u.monitorCargo?.nome ?? null,
        dias: meus,
        soma: { dentro, fora },
        coletorParadoHa: horas !== null && horas >= 2 ? horas : null,
      };
    });
  }),

  pessoa: produtividadeProc.input(z.object({ usuarioId: z.string(), data: dataStr })).query(async ({ input }): Promise<ResultadoDia> => {
    if (input.data < limiteRetencao()) {
      // Sem eventos brutos completos: devolve o agregado permanente no mesmo formato, sem linha do tempo.
      const dia = await prisma.monitorDia.findUnique({ where: { usuarioId_data: { usuarioId: input.usuarioId, data: input.data } } });
      return diaParaResultado(input.data, dia);
    }
    const { eventos, regras, pessoa } = await carregarEntradasDia(input.usuarioId, input.data);
    return calcularDia(input.data, eventos, regras, pessoa);
  }),

  neutrosMaisUsados: produtividadeProc.input(z.object({ de: dataStr, ate: dataStr })).query(async ({ input }) => {
    const dias = await prisma.monitorDia.findMany({
      where: { data: { gte: input.de, lte: input.ate } },
      select: { topJson: true },
    });
    const soma = new Map<string, number>();
    for (const d of dias) {
      const lista = (d.topJson as { neutro?: { chave: string; seg: number; tipo?: "dominio" | "app" }[] } | null)?.neutro ?? [];
      for (const it of lista) {
        // linhas antigas não têm `tipo`: .exe ou sem ponto = app, senão domínio
        const tipo = it.tipo ?? (/\.exe$/i.test(it.chave) || !it.chave.includes(".") ? "app" : "dominio");
        const k = `${tipo}:${it.chave}`;
        soma.set(k, (soma.get(k) ?? 0) + it.seg);
      }
    }
    return [...soma.entries()]
      .map(([k, seg]) => ({ tipo: (k.startsWith("app:") ? "app" : "dominio") as "app" | "dominio", chave: k.slice(k.indexOf(":") + 1), seg }))
      .sort((a, b) => b.seg - a.seg)
      .slice(0, 30);
  }),

  regras: regrasRouter,
  cargos: cargosRouter,
  pessoas: pessoasRouter,
  dispositivos: dispositivosRouter,
});
