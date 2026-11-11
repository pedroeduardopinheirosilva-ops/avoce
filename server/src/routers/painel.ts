import { z }                from "zod";
import { router, authProc } from "./trpc.js";
import { prisma }           from "../db.js";
import { Prisma }           from "@prisma/client";
import { whereEmpresa }     from "./tenant-utils.js";
import { ETAPAS_QUALIFICADO_PADRAO } from "../agent/lead-qualificado.js";
import { configFollowup, usuariosDoFollowup } from "./crm.js";
import { classificarPersona, type FaixaPersona } from "../lib/persona-icp.js";

/**
 * Painel diário do comercial: contatos novos, fechados e protocolados por dia.
 *
 * - "Novos"        → data de criação do deal (`CrmDeal.criadoEm`).
 * - "Fechados"     → data em que o deal ENTROU num stage marcado como fechamento.
 * - "Protocolados" → idem, para os stages marcados como protocolo.
 *
 * A entrada no stage vem de `CrmDealStageLog`. Deals antigos (importados sem
 * histórico) não têm log: para eles usamos `atualizadoEm` como fallback, desde
 * que estejam HOJE no stage-alvo e não tenham nenhum log daquele stage.
 */

const TZ = "America/Sao_Paulo";
const CONFIG_PREFIX = "painel_stages";

// ─── Config de classificação dos stages ──────────────────────────────────────

type PainelConfig = { fechado: string[]; protocolado: string[] };

function configKey(empresaId?: string | null) {
  return `${CONFIG_PREFIX}:${empresaId ?? "global"}`;
}

/** Detecta por nome/flag quais stages são de fechamento e de protocolo. */
function defaultsPorNome(
  stages: { id: string; chave: string; nome: string; ehGanho: boolean }[],
): PainelConfig {
  const protocolado: string[] = [];
  const fechado: string[] = [];

  for (const s of stages) {
    const alvo = `${s.chave} ${s.nome}`.toLowerCase();
    const ehProtocolo = /protocol|ajuizad|enviado para jur/.test(alvo);
    if (ehProtocolo) {
      protocolado.push(s.id);
      continue; // protocolo não conta também como fechado no default
    }
    if (/contrato assinado|fechad|assinatura conclu/.test(alvo) || s.ehGanho) {
      fechado.push(s.id);
    }
  }
  return { fechado, protocolado };
}

async function carregarConfig(
  ctx: { empresaId?: string; empresaIds?: string[]; role?: string },
  stages: { id: string; chave: string; nome: string; ehGanho: boolean }[],
): Promise<PainelConfig & { padrao: boolean }> {
  const cfg = await prisma.configuracao.findUnique({ where: { chave: configKey(ctx.empresaId) } });
  if (cfg?.valor) {
    try {
      const parsed = JSON.parse(cfg.valor) as PainelConfig;
      const validos = new Set(stages.map(s => s.id));
      return {
        fechado:     (parsed.fechado     ?? []).filter(id => validos.has(id)),
        protocolado: (parsed.protocolado ?? []).filter(id => validos.has(id)),
        padrao: false,
      };
    } catch { /* config corrompida → cai no default */ }
  }
  return { ...defaultsPorNome(stages), padrao: true };
}

// ─── Helpers de data ─────────────────────────────────────────────────────────

/** "2026-08-19" → Date no início do dia em São Paulo (UTC-3, sem horário de verão). */
function inicioDoDia(dia: string): Date {
  return new Date(`${dia}T00:00:00-03:00`);
}
function fimDoDia(dia: string): Date {
  const d = inicioDoDia(dia);
  return new Date(d.getTime() + 24 * 60 * 60 * 1000);
}
function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}
/** Data (YYYY-MM-DD) de um timestamp UTC, no fuso de São Paulo. */
function diaLocal(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(d);
}
/** Lista de dias (YYYY-MM-DD) entre `de` e `ate`, inclusive. */
function listarDias(de: string, ate: string): string[] {
  const out: string[] = [];
  const fim = inicioDoDia(ate).getTime();
  for (let t = inicioDoDia(de).getTime(); t <= fim; t += 24 * 60 * 60 * 1000) {
    // meio-dia UTC evita qualquer arredondamento de fuso ao formatar
    out.push(ymd(new Date(t + 12 * 60 * 60 * 1000)));
  }
  return out;
}

// ─── Tempo até a 1ª ligação ──────────────────────────────────────────────────

const EXPEDIENTE_INI = 8;   // hora de Brasília
const EXPEDIENTE_FIM = 18;
const H = 3600_000;

/** Minutos de expediente (seg–sex, 8h–18h de Brasília, UTC-3 fixo) entre dois instantes. */
function minutosUteis(deMs: number, ateMs: number): number {
  let total = 0;
  // Desloca para o "relógio de Brasília" e anda dia a dia
  const a = deMs - 3 * H, b = ateMs - 3 * H;
  for (let dia = Math.floor(a / (24 * H)) * 24 * H; dia < b; dia += 24 * H) {
    const dow = new Date(dia).getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const ini = Math.max(a, dia + EXPEDIENTE_INI * H);
    const fim = Math.min(b, dia + EXPEDIENTE_FIM * H);
    if (fim > ini) total += fim - ini;
  }
  return total / 60_000;
}

function mediana(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((x, y) => x - y);
  const m = s.length >> 1;
  return Math.round(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2);
}

function resumoMinutos(xs: number[]) {
  return {
    mediana: mediana(xs),
    media: xs.length ? Math.round(xs.reduce((a, x) => a + x, 0) / xs.length) : null,
    ate5min:  xs.filter(x => x <= 5).length,
    ate15min: xs.filter(x => x <= 15).length,
    ate1h:    xs.filter(x => x <= 60).length,
  };
}

// SQL: converte timestamp (gravado em UTC) para a data local
const DIA_LOCAL = (col: string) => Prisma.raw(`(${col} AT TIME ZONE 'UTC' AT TIME ZONE '${TZ}')::date`);

/**
 * Limite de período como timestamp SEM fuso, no relógio UTC (como o Prisma grava).
 * Passar um Date direto vira timestamptz e o Postgres converte a coluna usando o fuso da
 * sessão (America/Bahia), deslocando o corte em 3 h: a lista do dia mostrava leads da
 * noite anterior enquanto a contagem por dia (que usa AT TIME ZONE explícito) não.
 */
const tsUtc = (d: Date) => Prisma.sql`(${d.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;

/**
 * Data de ENTRADA do contato no funil.
 *
 * `criadoEm` sozinho não serve para deals importados: o valor é a data do
 * import, não a da chegada do lead. Quando existe histórico de etapas, a
 * primeira movimentação é anterior e mais fiel — por isso o LEAST.
 */
const ENTRADA_SQL = Prisma.raw(
  `LEAST(d."criadoEm", COALESCE((SELECT MIN(l0."criadoEm") FROM "CrmDealStageLog" l0 WHERE l0."dealId" = d.id), d."criadoEm"))`,
);
const DIA_ENTRADA = Prisma.raw(
  `(LEAST(d."criadoEm", COALESCE((SELECT MIN(l0."criadoEm") FROM "CrmDealStageLog" l0 WHERE l0."dealId" = d.id), d."criadoEm")) AT TIME ZONE 'UTC' AT TIME ZONE '${TZ}')::date`,
);

/** Filtro de empresa em SQL cru, espelhando `whereEmpresa`. */
function empresaSql(ctx: { empresaId?: string; empresaIds?: string[]; role?: string }): Prisma.Sql {
  const where = whereEmpresa(ctx) as { empresaId?: string | { in: string[] } };
  if (!where.empresaId) return Prisma.sql``;
  const ids = typeof where.empresaId === "string" ? [where.empresaId] : where.empresaId.in;
  return Prisma.sql` AND d."empresaId" IN (${Prisma.join(ids)})`;
}

const periodoInput = z.object({
  de:  z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  ate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  pipelineIds: z.array(z.string()).optional(),  // undefined = todos
});

async function pipelinesPermitidos(
  ctx: { empresaId?: string; empresaIds?: string[]; role?: string },
  pipelineIds?: string[],
): Promise<string[]> {
  const rows = await prisma.crmPipeline.findMany({
    where: {
      ativo: true,
      ...whereEmpresa(ctx),
      ...(pipelineIds?.length ? { id: { in: pipelineIds } } : {}),
    },
    select: { id: true },
  });
  return rows.map(r => r.id);
}

type LinhaDia = { dia: string; qtd: number };

function mapaDeLinhas(rows: { dia: Date | string; qtd: number | bigint }[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows) {
    const dia = r.dia instanceof Date ? ymd(new Date(r.dia.getTime() + 12 * 3600 * 1000)) : String(r.dia).slice(0, 10);
    m.set(dia, Number(r.qtd));
  }
  return m;
}

// ─── Router ──────────────────────────────────────────────────────────────────

export const painelRouter = router({

  /** Pipelines + stages + configuração atual de classificação. */
  config: authProc.query(async ({ ctx }) => {
    const pipelines = await prisma.crmPipeline.findMany({
      where: { ativo: true, ...whereEmpresa(ctx) },
      orderBy: { ordem: "asc" },
      select: {
        id: true, nome: true, cor: true,
        stages: {
          where: { ativo: true },
          orderBy: { ordem: "asc" },
          select: { id: true, chave: true, nome: true, ordem: true, ehGanho: true },
        },
      },
    });
    const todosStages = pipelines.flatMap(p => p.stages);
    const cfg = await carregarConfig(ctx, todosStages);

    // Período coberto por cada funil (para o preset "Todo o período")
    const emp = empresaSql(ctx);
    const periodos = pipelines.length
      ? await prisma.$queryRaw<{ pipelineId: string; primeira: Date | null; ultima: Date | null; deals: bigint }[]>(Prisma.sql`
          SELECT d."pipelineId" AS "pipelineId",
                 MIN(${ENTRADA_SQL}) AS primeira,
                 MAX(${ENTRADA_SQL}) AS ultima,
                 COUNT(*)::bigint     AS deals
            FROM "CrmDeal" d
           WHERE d."pipelineId" IN (${Prisma.join(pipelines.map(p => p.id))})${emp}
           GROUP BY 1
        `)
      : [];
    const porPipeline = new Map(periodos.map(r => [r.pipelineId, r]));

    return {
      pipelines: pipelines.map(p => {
        const per = porPipeline.get(p.id);
        return {
          ...p,
          deals:    per ? Number(per.deals) : 0,
          primeira: per?.primeira ? diaLocal(per.primeira) : null,
          ultima:   per?.ultima   ? diaLocal(per.ultima)   : null,
        };
      }),
      ...cfg,
    };
  }),

  salvarConfig: authProc
    .input(z.object({ fechado: z.array(z.string()), protocolado: z.array(z.string()) }))
    .mutation(async ({ input, ctx }) => {
      const chave = configKey(ctx.empresaId);
      const valor = JSON.stringify({ fechado: input.fechado, protocolado: input.protocolado });
      await prisma.configuracao.upsert({
        where: { chave },
        update: { valor },
        create: { chave, valor },
      });
      return { ok: true };
    }),

  /**
   * Quem faz follow-up: as SDRs ficam com os follow-ups que elas mesmas marcam; o que for marcado
   * por quem não é SDR vai para a SDR padrão (ver crm.definirProximoContato).
   */
  followupSdr: authProc.query(async ({ ctx }) => {
    const empresaId = ctx.empresaId ?? null;
    const cfg = await configFollowup(empresaId);
    const usuarios = await usuariosDoFollowup(empresaId);
    return { ...cfg, usuarios };
  }),

  salvarFollowupSdr: authProc
    .input(z.object({ padrao: z.string().nullable(), sdrs: z.array(z.string()), transferirPendentes: z.boolean().default(true) }))
    .mutation(async ({ input, ctx }) => {
      const chave = `followup_sdr:${ctx.empresaId ?? "global"}`;
      if (!input.padrao) {
        await prisma.configuracao.deleteMany({ where: { chave } });
        return { ok: true, transferidos: 0 };
      }
      const sdrs = [...new Set([input.padrao, ...input.sdrs])];
      const ativos = await prisma.usuario.count({ where: { id: { in: sdrs }, ativo: true } });
      if (ativos !== sdrs.length) throw new Error("Usuário não encontrado ou inativo");
      const valor = JSON.stringify({ padrao: input.padrao, sdrs });
      await prisma.configuracao.upsert({ where: { chave }, update: { valor }, create: { chave, valor } });

      // Follow-ups pendentes de quem não é SDR passam para a padrão (senão ficam numa fila que ninguém olha)
      let transferidos = 0;
      if (input.transferirPendentes) {
        const pipeIds = await pipelinesPermitidos(ctx);
        if (pipeIds.length) {
          const r = await prisma.crmDeal.updateMany({
            where: { pipelineId: { in: pipeIds }, status: "aberto", proximoContatoEm: { not: null },
                     OR: [{ proximoContatoPor: null }, { proximoContatoPor: { notIn: sdrs } }] },
            data: { proximoContatoPor: input.padrao },
          });
          transferidos = r.count;
        }
      }
      return { ok: true, transferidos };
    }),

  /** Série diária: novos, fechados e protocolados. */
  resumo: authProc
    .input(periodoInput)
    .query(async ({ input, ctx }) => {
      const pipeIds = await pipelinesPermitidos(ctx, input.pipelineIds);
      const dias = listarDias(input.de, input.ate);
      if (pipeIds.length === 0) {
        return { dias: dias.map(dia => ({ dia, novos: 0, fechados: 0, protocolados: 0 })), totais: { novos: 0, fechados: 0, protocolados: 0 } };
      }

      const stages = await prisma.crmStage.findMany({
        where: { pipelineId: { in: pipeIds } },
        select: { id: true, chave: true, nome: true, ehGanho: true },
      });
      const cfg = await carregarConfig(ctx, stages);

      const de   = tsUtc(inicioDoDia(input.de));
      const ate  = tsUtc(fimDoDia(input.ate));
      const emp  = empresaSql(ctx);
      const pipe = Prisma.join(pipeIds);

      // Novos: data de entrada do contato no funil, quebrado por plataforma de captação
      const novosPorPlatRows = await prisma.$queryRaw<{ dia: Date; plataforma: string | null; qtd: bigint }[]>(Prisma.sql`
        SELECT ${DIA_ENTRADA} AS dia, d."origemPlataforma" AS plataforma, COUNT(*)::bigint AS qtd
          FROM "CrmDeal" d
         WHERE d."pipelineId" IN (${pipe})
           AND ${ENTRADA_SQL} >= ${de} AND ${ENTRADA_SQL} < ${ate}${emp}
         GROUP BY 1, 2
      `);
      const novosRows: { dia: Date; qtd: bigint }[] = [];
      const origensPorDia = new Map<string, Record<string, number>>();
      for (const r of novosPorPlatRows) {
        const dia = ymd(new Date(r.dia));
        const plat = plataformaChave(r.plataforma);
        const m = origensPorDia.get(dia) ?? {};
        m[plat] = (m[plat] ?? 0) + Number(r.qtd);
        origensPorDia.set(dia, m);
        const ex = novosRows.find(x => ymd(new Date(x.dia)) === dia);
        if (ex) ex.qtd = BigInt(Number(ex.qtd) + Number(r.qtd)); else novosRows.push({ dia: r.dia, qtd: r.qtd });
      }

      async function porStages(stageIds: string[]): Promise<Map<string, number>> {
        if (stageIds.length === 0) return new Map();
        const alvos = Prisma.join(stageIds);
        const rows = await prisma.$queryRaw<{ dia: Date; qtd: bigint }[]>(Prisma.sql`
          SELECT dia, COUNT(DISTINCT "dealId")::bigint AS qtd FROM (
            -- entrada registrada no histórico de etapas
            SELECT l."dealId" AS "dealId", ${DIA_LOCAL('l."criadoEm"')} AS dia
              FROM "CrmDealStageLog" l
              JOIN "CrmDeal" d ON d.id = l."dealId"
             WHERE l."stageNovoId" IN (${alvos})
               AND l."criadoEm" >= ${de} AND l."criadoEm" < ${ate}
               AND d."pipelineId" IN (${pipe})${emp}
            UNION ALL
            -- fallback: deal está no stage-alvo mas não tem histórico dele
            SELECT d.id AS "dealId", ${DIA_LOCAL('d."atualizadoEm"')} AS dia
              FROM "CrmDeal" d
             WHERE d."stageId" IN (${alvos})
               AND d."atualizadoEm" >= ${de} AND d."atualizadoEm" < ${ate}
               AND d."pipelineId" IN (${pipe})${emp}
               AND NOT EXISTS (
                 SELECT 1 FROM "CrmDealStageLog" l2
                  WHERE l2."dealId" = d.id AND l2."stageNovoId" IN (${alvos})
               )
          ) t GROUP BY dia
        `);
        return mapaDeLinhas(rows);
      }

      const [fechadosMap, protocoladosMap] = await Promise.all([
        porStages(cfg.fechado),
        porStages(cfg.protocolado),
      ]);
      const novosMap = mapaDeLinhas(novosRows);

      const linhas = dias.map(dia => ({
        dia,
        novos:        novosMap.get(dia) ?? 0,
        fechados:     fechadosMap.get(dia) ?? 0,
        protocolados: protocoladosMap.get(dia) ?? 0,
        origens:      origensPorDia.get(dia) ?? {},
      }));

      return {
        dias: linhas,
        totais: {
          novos:        linhas.reduce((a, l) => a + l.novos, 0),
          fechados:     linhas.reduce((a, l) => a + l.fechados, 0),
          protocolados: linhas.reduce((a, l) => a + l.protocolados, 0),
        },
      };
    }),

  /**
   * Funil do SDR (mentoria 12/09/2026): dos leads que CHEGARAM em cada dia, quantos responderam,
   * se qualificaram, receberam ligação, atenderam, agendaram e foram desqualificados — é a
   * leitura "dos que chegaram hoje" que a SDR montava à mão. Reuniões, no-show, ganhos e perdas
   * são contados pelo dia em que ACONTECERAM (CrmAtividade), junto com os motivos de perda.
   *
   * Etapas são reconhecidas pela chave/nome (qualificado, reunião, desqualificado), o que vale
   * para os funis de carreteiros e de ICMS sem configuração extra.
   */
  funilSdr: authProc
    .input(periodoInput)
    .query(async ({ input, ctx }) => {
      const pipeIds = await pipelinesPermitidos(ctx, input.pipelineIds);
      const dias = listarDias(input.de, input.ate);
      const vazio = { dias: dias.map((dia) => ({ dia, chegaram: 0, responderam: 0, qualificaram: 0, ligacoes: 0, atendidas: 0, agendaram: 0, desqualificados: 0, reunioes: 0, noShows: 0, ganhos: 0, perdidos: 0 })), motivosPerda: [] as { motivo: string; qtd: number }[] };
      if (!pipeIds.length) return vazio;

      const de = tsUtc(inicioDoDia(input.de));
      const ate = tsUtc(fimDoDia(input.ate));
      const emp = empresaSql(ctx);
      const pipe = Prisma.join(pipeIds);
      const RE_QUAL = "(^|_| )qualificad";
      const RE_REUN = "reuni";
      const RE_DESQ = "desqualific|descart|nao_motorista";
      // Passou pela etapa (histórico) ou está nela agora. RE_QUAL exige separador antes de
      // "qualificad", então "lead_desqualificado" não conta como qualificado.
      const passouPor = (re: string) => Prisma.sql`(
        EXISTS (SELECT 1 FROM "CrmDealStageLog" lx JOIN "CrmStage" sx ON sx.id = lx."stageNovoId"
                 WHERE lx."dealId" = d.id AND lower(sx.chave || ' ' || sx.nome) ~ ${re}::text)
        OR EXISTS (SELECT 1 FROM "CrmStage" sy WHERE sy.id = d."stageId" AND lower(sy.chave || ' ' || sy.nome) ~ ${re}::text))`;

      const coorte = await prisma.$queryRaw<{ dia: Date; chegaram: bigint; responderam: bigint; qualificaram: bigint; ligacoes: bigint; atendidas: bigint; agendaram: bigint; desqualificados: bigint }[]>(Prisma.sql`
        SELECT ${DIA_ENTRADA} AS dia,
               COUNT(*)::bigint AS chegaram,
               COUNT(*) FILTER (WHERE (SELECT COUNT(*) FROM "CrmMensagemWhatsapp" m WHERE m."dealId" = d.id AND m.direcao = 'in') >= 2)::bigint AS responderam,
               COUNT(*) FILTER (WHERE ${passouPor(RE_QUAL)} OR ${passouPor(RE_REUN)} OR d.status = 'ganho')::bigint AS qualificaram,
               COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM "CrmAtividade" a WHERE a."dealId" = d.id AND a.tipo = 'ligacao')
                                   OR EXISTS (SELECT 1 FROM "CrmLigacao" c WHERE c."dealId" = d.id))::bigint AS ligacoes,
               COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM "CrmAtividade" a WHERE a."dealId" = d.id AND a.tipo = 'ligacao' AND a.resultado IN ('atendeu', 'pediu_retorno'))
                                   OR EXISTS (SELECT 1 FROM "CrmLigacao" c WHERE c."dealId" = d.id AND c.status = 'ENCERRADA' AND COALESCE(c.duracao, 0) >= 20))::bigint AS atendidas,
               COUNT(*) FILTER (WHERE ${passouPor(RE_REUN)} OR EXISTS (SELECT 1 FROM "CrmAtividade" a WHERE a."dealId" = d.id AND a.tipo = 'reuniao'))::bigint AS agendaram,
               COUNT(*) FILTER (WHERE ${passouPor(RE_DESQ)})::bigint AS desqualificados
          FROM "CrmDeal" d
         WHERE d."pipelineId" IN (${pipe})
           AND ${ENTRADA_SQL} >= ${de} AND ${ENTRADA_SQL} < ${ate}${emp}
         GROUP BY 1
      `);

      const eventos = await prisma.$queryRaw<{ dia: Date; reunioes: bigint; noshows: bigint; ganhos: bigint; perdidos: bigint }[]>(Prisma.sql`
        SELECT ${DIA_LOCAL('a."criadoEm"')} AS dia,
               COUNT(DISTINCT a."dealId") FILTER (WHERE a.tipo = 'reuniao' AND a.resultado = 'realizada')::bigint AS reunioes,
               COUNT(DISTINCT a."dealId") FILTER (WHERE a.tipo = 'reuniao' AND a.resultado = 'no_show')::bigint AS noshows,
               COUNT(DISTINCT a."dealId") FILTER (WHERE a.tipo = 'encerramento' AND a.resultado = 'ganho')::bigint AS ganhos,
               COUNT(DISTINCT a."dealId") FILTER (WHERE a.tipo = 'encerramento' AND a.resultado = 'perdido')::bigint AS perdidos
          FROM "CrmAtividade" a JOIN "CrmDeal" d ON d.id = a."dealId"
         WHERE a."criadoEm" >= ${de} AND a."criadoEm" < ${ate}
           AND d."pipelineId" IN (${pipe})${emp}
         GROUP BY 1
      `);

      const motivos = await prisma.$queryRaw<{ motivo: string; qtd: bigint }[]>(Prisma.sql`
        SELECT COALESCE(NULLIF(trim(a.nota), ''), '(sem motivo)') AS motivo, COUNT(DISTINCT a."dealId")::bigint AS qtd
          FROM "CrmAtividade" a JOIN "CrmDeal" d ON d.id = a."dealId"
         WHERE a.tipo = 'encerramento' AND a.resultado = 'perdido'
           AND a."criadoEm" >= ${de} AND a."criadoEm" < ${ate}
           AND d."pipelineId" IN (${pipe})${emp}
         GROUP BY 1 ORDER BY 2 DESC
      `);

      const chave = (d: Date) => ymd(new Date(new Date(d).getTime() + 12 * 3600 * 1000));
      const cMap = new Map(coorte.map((r) => [chave(r.dia), r]));
      const eMap = new Map(eventos.map((r) => [chave(r.dia), r]));
      return {
        dias: dias.map((dia) => {
          const c = cMap.get(dia);
          const e = eMap.get(dia);
          return {
            dia,
            chegaram: Number(c?.chegaram ?? 0),
            responderam: Number(c?.responderam ?? 0),
            qualificaram: Number(c?.qualificaram ?? 0),
            ligacoes: Number(c?.ligacoes ?? 0),
            atendidas: Number(c?.atendidas ?? 0),
            agendaram: Number(c?.agendaram ?? 0),
            desqualificados: Number(c?.desqualificados ?? 0),
            reunioes: Number(e?.reunioes ?? 0),
            noShows: Number(e?.noshows ?? 0),
            ganhos: Number(e?.ganhos ?? 0),
            perdidos: Number(e?.perdidos ?? 0),
          };
        }),
        motivosPerda: motivos.map((m) => ({ motivo: m.motivo, qtd: Number(m.qtd) })),
      };
    }),

  /**
   * Ligações de follow-up do dia: leads abertos cujo próximo contato vence hoje ou já passou
   * (atrasados primeiro) + as ligações já registradas hoje. É a "rotina de 20 minutos" do
   * script comercial: começar o dia pelos ATRASADOS e HOJE.
   */
  followupsHoje: authProc
    .input(z.object({ pipelineIds: z.array(z.string()).optional() }))
    .query(async ({ input, ctx }) => {
      const pipeIds = await pipelinesPermitidos(ctx, input.pipelineIds);
      if (!pipeIds.length) return { hoje: diaLocal(new Date()), pendentes: [], feitasHoje: [], usuarios: [], eu: null };
      const hoje = diaLocal(new Date());
      const [pendentes, feitasHoje] = await Promise.all([
        prisma.crmDeal.findMany({
          where: { pipelineId: { in: pipeIds }, status: "aberto", proximoContatoEm: { lt: fimDoDia(hoje) } },
          orderBy: { proximoContatoEm: "asc" },
          take: 200,
          select: {
            id: true, titulo: true, proximoContatoEm: true, proximoContatoPor: true, ultimoContatoEm: true, iaAtiva: true,
            contato: { select: { nome: true, whatsapp: true } },
            pipeline: { select: { nome: true, cor: true } },
            stage: { select: { nome: true } },
            atividades: {
              orderBy: { criadoEm: "desc" }, take: 3,
              select: { id: true, tipo: true, resultado: true, nota: true, canal: true, direcao: true, duracaoSeg: true, origem: true, criadoEm: true },
            },
          },
        }),
        prisma.crmAtividade.findMany({
          where: { tipo: "ligacao", criadoEm: { gte: inicioDoDia(hoje) }, deal: { pipelineId: { in: pipeIds } } },
          orderBy: { criadoEm: "desc" },
          take: 100,
          select: {
            id: true, resultado: true, nota: true, origem: true, direcao: true, criadoEm: true, usuarioId: true,
            deal: { select: { id: true, titulo: true, proximoContatoEm: true, contato: { select: { nome: true } } } },
          },
        }),
      ]);
      // Nomes de quem marcou cada follow-up / registrou cada ligação, para o painel separar
      // a fila por usuário.
      const ids = [...new Set([
        ...pendentes.map((d) => d.proximoContatoPor),
        ...feitasHoje.map((a) => a.usuarioId),
      ].filter((x): x is string => !!x))];
      const usuarios = ids.length
        ? await prisma.usuario.findMany({ where: { id: { in: ids } }, select: { id: true, nome: true } })
        : [];
      return { hoje, pendentes, feitasHoje, usuarios, eu: (ctx as any).userId ?? null };
    }),

  /** Só a contagem, para o número no menu. */
  followupsPendentes: authProc.query(async ({ ctx }) => {
    const pipeIds = await pipelinesPermitidos(ctx);
    if (!pipeIds.length) return 0;
    return prisma.crmDeal.count({
      where: { pipelineId: { in: pipeIds }, status: "aberto", proximoContatoEm: { lt: fimDoDia(diaLocal(new Date())) } },
    });
  }),

  /**
   * Ligações do dia por usuário, somando todos os funis da empresa (produtividade de quem liga
   * não depende do funil escolhido no painel). Soma duas fontes, na conta de quem estava logado:
   *  - CrmAtividade tipo "ligacao" (baixa manual no CRM/follow-up);
   *  - CrmLigacao de SAÍDA pelo discador VoIP (origem = DID da empresa). Entrantes não contam,
   *    e FALHOU (não chegou a discar) também não. Se o mesmo usuário também deu baixa manual
   *    no mesmo deal até 1 h depois/antes, a do discador é ignorada para não contar duas vezes.
   */
  ligacoesPorUsuario: authProc
    .input(z.object({ dia: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }))
    .query(async ({ input, ctx }) => {
      const dia = input.dia ?? diaLocal(new Date());
      const pipeIds = await pipelinesPermitidos(ctx);
      if (!pipeIds.length) return { dia, usuarios: [] };
      const de   = tsUtc(inicioDoDia(dia));
      const ate  = tsUtc(fimDoDia(dia));
      const emp  = empresaSql(ctx);
      const pipe = Prisma.join(pipeIds);

      const [ativ, voip] = await Promise.all([
        prisma.$queryRaw<{ usuarioId: string | null; resultado: string; qtd: bigint }[]>(Prisma.sql`
          SELECT a."usuarioId", a.resultado, COUNT(*)::bigint AS qtd
            FROM "CrmAtividade" a JOIN "CrmDeal" d ON d.id = a."dealId"
           WHERE a.tipo = 'ligacao' AND a."criadoEm" >= ${de} AND a."criadoEm" < ${ate}
             AND d."pipelineId" IN (${pipe})${emp}
           GROUP BY 1, 2
        `),
        prisma.$queryRaw<{ usuarioId: string | null; atendeu: boolean; qtd: bigint }[]>(Prisma.sql`
          SELECT l."usuarioId", (l.status = 'ENCERRADA' AND COALESCE(l.duracao, 0) > 0) AS atendeu, COUNT(*)::bigint AS qtd
            FROM "CrmLigacao" l
            JOIN "CrmDeal" d ON d.id = l."dealId"
            JOIN "EmpresaEmitente" e ON e.id = l."emitenteId"
           WHERE l."iniciadaEm" >= ${de} AND l."iniciadaEm" < ${ate}
             AND d."pipelineId" IN (${pipe})${emp}
             AND l."numeroOrigem" IN (e."voipDid", e."voipDid2", e."voipDid3")
             AND l.status <> 'FALHOU'
             AND NOT EXISTS (
               SELECT 1 FROM "CrmAtividade" a
                WHERE a.tipo = 'ligacao' AND a."dealId" = l."dealId"
                  AND a."usuarioId" IS NOT DISTINCT FROM l."usuarioId"
                  AND a."criadoEm" BETWEEN l."iniciadaEm" - interval '1 hour' AND l."iniciadaEm" + interval '1 hour'
             )
           GROUP BY 1, 2
        `),
      ]);

      type Linha = { usuarioId: string | null; nome: string; total: number; atendeu: number; naoAtendeu: number; outros: number; discador: number };
      const porUsuario = new Map<string, Linha>();
      const linha = (id: string | null) => {
        const k = id ?? "";
        if (!porUsuario.has(k)) porUsuario.set(k, { usuarioId: id, nome: "", total: 0, atendeu: 0, naoAtendeu: 0, outros: 0, discador: 0 });
        return porUsuario.get(k)!;
      };
      for (const r of ativ) {
        const l = linha(r.usuarioId);
        const n = Number(r.qtd);
        l.total += n;
        if (r.resultado === "atendeu") l.atendeu += n;
        else if (r.resultado === "nao_atendeu") l.naoAtendeu += n;
        else l.outros += n;
      }
      for (const r of voip) {
        const l = linha(r.usuarioId);
        const n = Number(r.qtd);
        l.total += n;
        l.discador += n;
        if (r.atendeu) l.atendeu += n;
        else l.naoAtendeu += n;
      }

      const ids = [...porUsuario.values()].map(l => l.usuarioId).filter((x): x is string => !!x);
      const nomes = new Map(
        (await prisma.usuario.findMany({ where: { id: { in: ids } }, select: { id: true, nome: true } })).map(u => [u.id, u.nome]),
      );
      const usuarios = [...porUsuario.values()]
        .map(l => ({ ...l, nome: l.usuarioId ? nomes.get(l.usuarioId) ?? "(usuário removido)" : "(sem usuário)" }))
        .sort((a, b) => b.total - a.total);
      return { dia, usuarios };
    }),

  /** Lista dos contatos de um dia específico, por tipo. */
  itensDia: authProc
    .input(z.object({
      dia: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      tipo: z.enum(["novos", "fechados", "protocolados"]),
      pipelineIds: z.array(z.string()).optional(),
    }))
    .query(async ({ input, ctx }) => {
      const pipeIds = await pipelinesPermitidos(ctx, input.pipelineIds);
      if (pipeIds.length === 0) return [];

      const de  = tsUtc(inicioDoDia(input.dia));
      const ate = tsUtc(fimDoDia(input.dia));
      const emp = empresaSql(ctx);
      const pipe = Prisma.join(pipeIds);

      let ids: string[];
      let horas = new Map<string, Date>();

      if (input.tipo === "novos") {
        const rows = await prisma.$queryRaw<{ id: string; em: Date }[]>(Prisma.sql`
          SELECT d.id, ${ENTRADA_SQL} AS em
            FROM "CrmDeal" d
           WHERE d."pipelineId" IN (${pipe})
             AND ${ENTRADA_SQL} >= ${de} AND ${ENTRADA_SQL} < ${ate}${emp}
           ORDER BY 2
        `);
        ids = rows.map(r => r.id);
        horas = new Map(rows.map(r => [r.id, r.em]));
      } else {
        const stages = await prisma.crmStage.findMany({
          where: { pipelineId: { in: pipeIds } },
          select: { id: true, chave: true, nome: true, ehGanho: true },
        });
        const cfg = await carregarConfig(ctx, stages);
        const stageIds = input.tipo === "fechados" ? cfg.fechado : cfg.protocolado;
        if (stageIds.length === 0) return [];
        const alvos = Prisma.join(stageIds);

        const rows = await prisma.$queryRaw<{ id: string; em: Date }[]>(Prisma.sql`
          SELECT "dealId" AS id, MIN(em) AS em FROM (
            SELECT l."dealId" AS "dealId", l."criadoEm" AS em
              FROM "CrmDealStageLog" l
              JOIN "CrmDeal" d ON d.id = l."dealId"
             WHERE l."stageNovoId" IN (${alvos})
               AND l."criadoEm" >= ${de} AND l."criadoEm" < ${ate}
               AND d."pipelineId" IN (${pipe})${emp}
            UNION ALL
            SELECT d.id AS "dealId", d."atualizadoEm" AS em
              FROM "CrmDeal" d
             WHERE d."stageId" IN (${alvos})
               AND d."atualizadoEm" >= ${de} AND d."atualizadoEm" < ${ate}
               AND d."pipelineId" IN (${pipe})${emp}
               AND NOT EXISTS (
                 SELECT 1 FROM "CrmDealStageLog" l2
                  WHERE l2."dealId" = d.id AND l2."stageNovoId" IN (${alvos})
               )
          ) t GROUP BY "dealId" ORDER BY MIN(em)
        `);
        ids = rows.map(r => r.id);
        horas = new Map(rows.map(r => [r.id, r.em]));
      }

      if (ids.length === 0) return [];

      const deals = await prisma.crmDeal.findMany({
        where: { id: { in: ids } },
        select: {
          id: true, titulo: true, status: true, valor: true, numeroCnj: true,
          pipeline: { select: { id: true, nome: true } },
          stage:    { select: { nome: true, cor: true } },
          contato:  { select: { nome: true, whatsapp: true, telefone: true, cpf: true, cidade: true } },
          origemPlataforma: true, origemTipo: true, origemAnuncioId: true,
          origemAnuncioTitulo: true, origemAnuncioTexto: true, origemUrl: true, origemEm: true,
        },
      });
      const porId = new Map(deals.map(d => [d.id, d]));

      return ids.flatMap(id => {
        const d = porId.get(id);
        if (!d) return [];
        return [{
          dealId:    d.id,
          titulo:    d.titulo,
          status:    d.status,
          valor:     d.valor ? Number(d.valor) : null,
          numeroCnj: d.numeroCnj,
          pipeline:  d.pipeline.nome,
          pipelineId: d.pipeline.id,
          stage:     d.stage.nome,
          stageCor:  d.stage.cor,
          contato:   d.contato?.nome ?? null,
          whatsapp:  d.contato?.whatsapp ?? d.contato?.telefone ?? null,
          cpf:       d.contato?.cpf ?? null,
          cidade:    d.contato?.cidade ?? null,
          em:        horas.get(id) ?? null,
          origemPlataforma: d.origemPlataforma, origemTipo: d.origemTipo, origemAnuncioId: d.origemAnuncioId,
          origemAnuncioTitulo: d.origemAnuncioTitulo, origemAnuncioTexto: d.origemAnuncioTexto,
          origemUrl: d.origemUrl, origemEm: d.origemEm,
        }];
      });
    }),

  /**
   * Captação por origem no período: leads novos agrupados por plataforma/anúncio,
   * com quantos engajaram (responderam além da 1ª mensagem), fecharam e protocolaram.
   * A origem vem do metadado da 1ª mensagem do WhatsApp (ver agent/lead-origem.ts).
   */
  origens: authProc
    .input(periodoInput)
    .query(async ({ input, ctx }) => {
      const pipeIds = await pipelinesPermitidos(ctx, input.pipelineIds);
      if (pipeIds.length === 0) return { grupos: [], total: 0 };

      const stages = await prisma.crmStage.findMany({
        where: { pipelineId: { in: pipeIds } },
        select: { id: true, chave: true, nome: true, ehGanho: true },
      });
      const cfg = await carregarConfig(ctx, stages);

      const de   = tsUtc(inicioDoDia(input.de));
      const ate  = tsUtc(fimDoDia(input.ate));
      const emp  = empresaSql(ctx);
      const pipe = Prisma.join(pipeIds);

      const rows = await prisma.$queryRaw<{
        id: string; plataforma: string | null; tipo: string | null; anuncioId: string | null;
        titulo: string | null; texto: string | null; url: string | null; stageId: string; msgs_in: bigint;
      }[]>(Prisma.sql`
        SELECT d.id, d."origemPlataforma" AS plataforma, d."origemTipo" AS tipo, d."origemAnuncioId" AS "anuncioId",
               d."origemAnuncioTitulo" AS titulo, d."origemAnuncioTexto" AS texto, d."origemUrl" AS url, d."stageId",
               (SELECT COUNT(*) FROM "CrmMensagemWhatsapp" m WHERE m."dealId" = d.id AND m.direcao = 'in')::bigint AS msgs_in
          FROM "CrmDeal" d
         WHERE d."pipelineId" IN (${pipe})
           AND ${ENTRADA_SQL} >= ${de} AND ${ENTRADA_SQL} < ${ate}${emp}
      `);
      if (rows.length === 0) return { grupos: [], total: 0 };

      const ids = rows.map(r => r.id);
      // Qualificado = passou por alguma etapa de qualificado-ou-além (mesma régua do evento
      // devolvido à Meta, agent/lead-qualificado.ts). Mede a QUALIDADE de cada anúncio, não só volume.
      const etapasQualif = new Set(ETAPAS_QUALIFICADO_PADRAO);
      const qualifStageIds = stages.filter(s => etapasQualif.has(s.chave)).map(s => s.id);
      const alvos = [...cfg.fechado, ...cfg.protocolado, ...qualifStageIds];
      const logs = alvos.length
        ? await prisma.crmDealStageLog.findMany({
            where: { dealId: { in: ids }, stageNovoId: { in: alvos } },
            select: { dealId: true, stageNovoId: true },
          })
        : [];
      const fechadoSet = new Set(cfg.fechado), protocoladoSet = new Set(cfg.protocolado);
      const qualifSet = new Set(qualifStageIds);
      const fechou = new Set<string>(), protocolou = new Set<string>(), qualificou = new Set<string>();
      for (const l of logs) {
        if (fechadoSet.has(l.stageNovoId)) fechou.add(l.dealId);
        if (protocoladoSet.has(l.stageNovoId)) protocolou.add(l.dealId);
        if (qualifSet.has(l.stageNovoId)) qualificou.add(l.dealId);
      }
      for (const r of rows) {
        if (fechadoSet.has(r.stageId)) fechou.add(r.id);
        if (protocoladoSet.has(r.stageId)) protocolou.add(r.id);
        if (qualifSet.has(r.stageId)) qualificou.add(r.id);
      }
      // Fechou/protocolou também passou pela qualificação, mesmo que o card tenha pulado a coluna.
      for (const id of [...fechou, ...protocolou]) qualificou.add(id);

      type Grupo = {
        chave: string; plataforma: string; tipo: string | null; anuncioId: string | null;
        anuncioTitulo: string | null; anuncioTexto: string | null; url: string | null;
        leads: number; engajaram: number; qualificados: number; fechados: number; protocolados: number;
      };
      const grupos = new Map<string, Grupo>();
      for (const r of rows) {
        const plat = plataformaChave(r.plataforma);
        // Anúncio agrupa pelo ID da Meta (mesmo criativo em FB e IG vira linhas separadas por plataforma).
        // Orgânico rastreado (bio, palavra-chave de vídeo, post) separa por anuncioId também.
        const chave = r.tipo === "anuncio" ? `${plat}|ad|${r.anuncioId ?? r.texto ?? ""}`
          : r.tipo === "organico" && r.anuncioId ? `${plat}|org|${r.anuncioId}` : `${plat}|${r.tipo ?? ""}`;
        let g = grupos.get(chave);
        if (!g) {
          g = { chave, plataforma: plat, tipo: r.tipo, anuncioId: r.anuncioId, anuncioTitulo: r.titulo, anuncioTexto: r.texto, url: r.url,
                leads: 0, engajaram: 0, qualificados: 0, fechados: 0, protocolados: 0 };
          grupos.set(chave, g);
        }
        g.leads++;
        if (Number(r.msgs_in) >= 2) g.engajaram++;
        if (qualificou.has(r.id)) g.qualificados++;
        if (fechou.has(r.id)) g.fechados++;
        if (protocolou.has(r.id)) g.protocolados++;
      }
      return {
        grupos: [...grupos.values()].sort((a, b) => b.leads - a.leads),
        total: rows.length,
      };
    }),

  /**
   * Horário de chegada dos leads (entrada no funil, hora de São Paulo), hora a hora e separado
   * entre dias úteis e fim de semana. O painel agrupa em turnos: madrugada 0–6h, manhã 6–12h,
   * tarde 12–18h, noite 18–24h.
   *
   * `picoDia` expõe o dia com mais entradas: funil carregado em lote (import, lista de prospecção)
   * concentra quase tudo num dia e a hora é a da carga, não a da chegada — a tela avisa.
   */
  turnos: authProc
    .input(periodoInput)
    .query(async ({ input, ctx }) => {
      const pipeIds = await pipelinesPermitidos(ctx, input.pipelineIds);
      const vazio = { horas: Array.from({ length: 24 }, (_, hora) => ({ hora, uteis: 0, fimDeSemana: 0 })), total: 0, picoDia: null as { dia: string; qtd: number } | null };
      if (!pipeIds.length) return vazio;

      const de   = tsUtc(inicioDoDia(input.de));
      const ate  = tsUtc(fimDoDia(input.ate));
      const emp  = empresaSql(ctx);
      const pipe = Prisma.join(pipeIds);
      const LOCAL = Prisma.sql`(${ENTRADA_SQL} AT TIME ZONE 'UTC' AT TIME ZONE ${Prisma.raw(`'${TZ}'`)})`;

      const [rows, pico] = await Promise.all([
        prisma.$queryRaw<{ hora: number; fds: boolean; qtd: bigint }[]>(Prisma.sql`
          SELECT extract(hour FROM ${LOCAL})::int AS hora,
                 (extract(isodow FROM ${LOCAL}) >= 6) AS fds,
                 COUNT(*)::bigint AS qtd
            FROM "CrmDeal" d
           WHERE d."pipelineId" IN (${pipe})
             AND ${ENTRADA_SQL} >= ${de} AND ${ENTRADA_SQL} < ${ate}${emp}
           GROUP BY 1, 2
        `),
        prisma.$queryRaw<{ dia: Date; qtd: bigint }[]>(Prisma.sql`
          SELECT ${DIA_ENTRADA} AS dia, COUNT(*)::bigint AS qtd
            FROM "CrmDeal" d
           WHERE d."pipelineId" IN (${pipe})
             AND ${ENTRADA_SQL} >= ${de} AND ${ENTRADA_SQL} < ${ate}${emp}
           GROUP BY 1 ORDER BY 2 DESC LIMIT 1
        `),
      ]);

      const horas = vazio.horas;
      for (const r of rows) {
        const h = horas[r.hora];
        if (r.fds) h.fimDeSemana += Number(r.qtd); else h.uteis += Number(r.qtd);
      }
      return {
        horas,
        total: horas.reduce((a, h) => a + h.uteis + h.fimDeSemana, 0),
        picoDia: pico[0] ? { dia: ymd(new Date(new Date(pico[0].dia).getTime() + 12 * 3600 * 1000)), qtd: Number(pico[0].qtd) } : null,
      };
    }),

  /**
   * Funil Lead → MQL → SQL → Cliente, com Persona (ICP).
   *
   *  - Lead:     entrou no funil no período (mesma ENTRADA dos "Novos").
   *  - Engajou:  mandou 2+ mensagens no WhatsApp.
   *  - MQL:      engajou E a conversa confirmou que é carreteiro (interesse + perfil) — ou chegou
   *              a "Lead Qualificado"/além por qualquer caminho.
   *  - Qualificado: entrou numa etapa de qualificado-ou-além (ETAPAS_QUALIFICADO_PADRAO, mesmo
   *              marco do evento QualifiedLead da Meta). Fica entre MQL e SQL.
   *  - SQL:      reunião agendada (etapa de reunião ou atividade "reuniao") — pronto para a advogada.
   *  - Cliente:  assinatura/documentos/protocolo (etapas de fechado/protocolado do painel) ou ganho.
   * Os marcos são cumulativos: quem é cliente também conta como SQL, qualificado e MQL.
   */
  funilQualificacao: authProc
    .input(periodoInput)
    .query(async ({ input, ctx }) => {
      const pipeIds = await pipelinesPermitidos(ctx, input.pipelineIds);
      const MARCOS = ["leads", "engajou", "mql", "qualificado", "sql", "cliente"] as const;
      type Marco = typeof MARCOS[number];
      type Contagem = Record<Marco, number>;
      const zerado = (): Contagem => ({ leads: 0, engajou: 0, mql: 0, qualificado: 0, sql: 0, cliente: 0 });
      const vazio = {
        totais: zerado(),
        tempos: { leadMql: null as number | null, mqlSql: null as number | null, sqlCliente: null as number | null },
        persona: [] as ({ faixa: FaixaPersona } & Contagem)[],
        origem: [] as ({ grupo: string } & Contagem)[],
        conteudo: [] as ({ chave: string; titulo: string } & Contagem)[],
      };
      if (!pipeIds.length) return vazio;

      const de   = tsUtc(inicioDoDia(input.de));
      const ate  = tsUtc(fimDoDia(input.ate));
      const emp  = empresaSql(ctx);
      const pipe = Prisma.join(pipeIds);

      const deals = await prisma.$queryRaw<{
        id: string; entrada: Date; stageId: string; status: string; qualificacao: any;
        origemTipo: string | null; origemPlataforma: string | null;
        origemAnuncioId: string | null; origemAnuncioTitulo: string | null; segundaMsg: Date | null; reuniaoEm: Date | null;
        textoLead: string | null;
      }[]>(Prisma.sql`
        SELECT d.id, ${ENTRADA_SQL} AS entrada, d."stageId", d.status, d.qualificacao,
               d."origemTipo", d."origemPlataforma", d."origemAnuncioId", d."origemAnuncioTitulo",
               (SELECT m."enviadaEm" FROM "CrmMensagemWhatsapp" m WHERE m."dealId" = d.id AND m.direcao = 'in'
                 ORDER BY m."enviadaEm" OFFSET 1 LIMIT 1) AS "segundaMsg",
               (SELECT MIN(a."criadoEm") FROM "CrmAtividade" a WHERE a."dealId" = d.id AND a.tipo = 'reuniao') AS "reuniaoEm",
               (SELECT string_agg(left(x.conteudo, 400), ' ') FROM (
                  SELECT m.conteudo FROM "CrmMensagemWhatsapp" m
                   WHERE m."dealId" = d.id AND m.direcao = 'in' AND m.conteudo IS NOT NULL
                   ORDER BY m."enviadaEm" LIMIT 40) x) AS "textoLead"
          FROM "CrmDeal" d
         WHERE d."pipelineId" IN (${pipe})
           AND ${ENTRADA_SQL} >= ${de} AND ${ENTRADA_SQL} < ${ate}${emp}
      `);
      if (!deals.length) return vazio;

      const stages = await prisma.crmStage.findMany({
        where: { pipelineId: { in: pipeIds } },
        select: { id: true, chave: true, nome: true, ehGanho: true },
      });
      const cfg = await carregarConfig(ctx, stages);
      const QUALIF = new Set(ETAPAS_QUALIFICADO_PADRAO);
      const CLIENTE_CHAVES = new Set(["aguardando_assinatura", "aguardando_docs_pessoais", "docs_em_revisao", "docs_comprobatorios",
                                      "contrato_assinado", "inicial_protocolada", "protocolados"]);
      const fechadoOuProt = new Set([...cfg.fechado, ...cfg.protocolado]);
      const nivel = new Map<string, number>(); // 1 qualificado · 2 sql · 3 cliente
      for (const s of stages) {
        const alvo = `${s.chave} ${s.nome}`.toLowerCase();
        if (CLIENTE_CHAVES.has(s.chave) || fechadoOuProt.has(s.id) || s.ehGanho) nivel.set(s.id, 3);
        else if (/reuni/.test(alvo)) nivel.set(s.id, 2);
        else if (QUALIF.has(s.chave)) nivel.set(s.id, 1);
      }

      const logs = await prisma.crmDealStageLog.findMany({
        where: { dealId: { in: deals.map(d => d.id) }, stageNovoId: { in: [...nivel.keys()] } },
        select: { dealId: true, stageNovoId: true, criadoEm: true },
        orderBy: { criadoEm: "asc" },
      });
      // Primeira vez que o deal chegou a cada nível (ou além)
      const primeira = new Map<string, [Date | null, Date | null, Date | null]>();
      for (const l of logs) {
        const nv = nivel.get(l.stageNovoId)!;
        const t = primeira.get(l.dealId) ?? [null, null, null];
        for (let k = 1; k <= nv; k++) if (!t[k - 1]) t[k - 1] = l.criadoEm;
        primeira.set(l.dealId, t);
      }

      const grupoOrigem = (d: typeof deals[number]) =>
        d.origemTipo === "anuncio" ? "Anúncio" : d.origemTipo === "organico" ? "Orgânico" : d.origemTipo === "link" ? "Link / site" : "Sem origem";

      // Orgânico por conteúdo: a palavra-chave do vídeo (texto no WhatsApp, link ?ref=, comentário)
      // junta tudo do mesmo vídeo, qualquer que seja o canal; o resto por porta de entrada.
      const conteudoOrganico = (d: typeof deals[number]): { chave: string; titulo: string } | null => {
        if (d.origemTipo !== "organico") return null;
        const id = d.origemAnuncioId ?? "";
        if (!id) return { chave: "sem_detalhe", titulo: "Orgânico sem detalhe" };
        if (id === "perfil") return { chave: "perfil", titulo: "Perfil / bio (sem vídeo)" };
        if (/^\d{8,}$/.test(id)) return { chave: id, titulo: `Post ${d.origemAnuncioTitulo || id}` };
        if (id === "direct") return { chave: "direct", titulo: "Direct / Messenger (sem vídeo)" };
        if (id.startsWith("story_")) return { chave: "story", titulo: "Stories" };
        return { chave: id.toUpperCase(), titulo: id.toUpperCase() };
      };

      const totais = zerado();
      const porConteudo = new Map<string, { titulo: string; c: Contagem }>();
      const porPersona = new Map<FaixaPersona, Contagem>();
      const porOrigem = new Map<string, Contagem>();
      const dLeadMql: number[] = [], dMqlSql: number[] = [], dSqlCli: number[] = [];
      const h = (a: Date, b: Date) => (b.getTime() - a.getTime()) / 60_000; // minutos

      for (const d of deals) {
        const persona = classificarPersona(d.qualificacao, d.entrada, d.textoLead ?? "");
        const t = primeira.get(d.id) ?? [null, null, null];
        const nivelAgora = nivel.get(d.stageId) ?? 0;
        const cliente = nivelAgora >= 3 || !!t[2] || d.status === "ganho";
        const sql = cliente || nivelAgora >= 2 || !!t[1] || !!d.reuniaoEm;
        const qualificado = sql || nivelAgora >= 1 || !!t[0];
        const engajou = !!d.segundaMsg;
        const mql = qualificado || (engajou && persona.carreteiro === true);

        const marcou: Record<Marco, boolean> = { leads: true, engajou, mql, qualificado, sql, cliente };
        const somar = (c: Contagem) => { for (const m of MARCOS) if (marcou[m]) c[m]++; };
        somar(totais);
        somar(porPersona.get(persona.faixa) ?? porPersona.set(persona.faixa, zerado()).get(persona.faixa)!);
        const g = grupoOrigem(d);
        somar(porOrigem.get(g) ?? porOrigem.set(g, zerado()).get(g)!);
        const ct = conteudoOrganico(d);
        if (ct) somar((porConteudo.get(ct.chave) ?? porConteudo.set(ct.chave, { titulo: ct.titulo, c: zerado() }).get(ct.chave)!).c);

        // Tempos entre marcos (só quando as duas pontas têm data)
        const emMql = [engajou && persona.carreteiro === true ? d.segundaMsg : null, t[0]]
          .filter((x): x is Date => !!x).sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
        const emSql = [t[1], d.reuniaoEm].filter((x): x is Date => !!x).sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
        const emCli = t[2];
        if (mql && emMql) dLeadMql.push(Math.max(0, h(d.entrada, emMql)));
        // Mesmo instante = o card pulou etapas de uma vez; não é tempo de passagem, fica fora da mediana.
        if (sql && emMql && emSql && emSql > emMql) dMqlSql.push(h(emMql, emSql));
        if (cliente && emSql && emCli && emCli > emSql) dSqlCli.push(h(emSql, emCli));
      }

      const ORDEM_FAIXA: FaixaPersona[] = ["ideal", "parcial", "fora", "sem_dados"];
      return {
        totais,
        tempos: { leadMql: mediana(dLeadMql), mqlSql: mediana(dMqlSql), sqlCliente: mediana(dSqlCli) },
        persona: ORDEM_FAIXA.filter(f => porPersona.has(f)).map(faixa => ({ faixa, ...porPersona.get(faixa)! })),
        origem: [...porOrigem.entries()].map(([grupo, c]) => ({ grupo, ...c })).sort((a, b) => b.leads - a.leads),
        conteudo: [...porConteudo.entries()].map(([chave, v]) => ({ chave, titulo: v.titulo, ...v.c }))
          .sort((a, b) => b.cliente - a.cliente || b.sql - a.sql || b.leads - a.leads),
      };
    }),

  /**
   * Tempo até a 1ª ligação: da ENTRADA do lead no funil (mesma data de "Novos") até a primeira
   * ligação de SAÍDA — baixa de ligação no CRM (qualquer resultado, inclusive não atendeu) ou
   * discagem pelo VoIP a partir do DID do emitente. Medido corrido e em horário comercial
   * (seg–sex, 8h–18h de Brasília, sem feriados): lead que chega às 23h e é ligado às 8h05 conta
   * 5 min úteis. Leads ainda sem ligação ficam fora da mediana e aparecem como "sem ligação".
   */
  primeiraLigacao: authProc
    .input(periodoInput)
    .query(async ({ input, ctx }) => {
      const pipeIds = await pipelinesPermitidos(ctx, input.pipelineIds);
      const vazio = {
        leads: 0, ligados: 0,
        corrido: resumoMinutos([]), util: resumoMinutos([]),
        dias: [] as { dia: string; leads: number; ligados: number; medianaCorrido: number | null; medianaUtil: number | null }[],
        usuarios: [] as { usuarioId: string | null; nome: string; ligados: number; medianaCorrido: number | null; medianaUtil: number | null }[],
      };
      if (!pipeIds.length) return vazio;

      const de   = tsUtc(inicioDoDia(input.de));
      const ate  = tsUtc(fimDoDia(input.ate));
      const emp  = empresaSql(ctx);
      const pipe = Prisma.join(pipeIds);

      // Baixa manual costuma vir com o minuto arredondado: tolera ligação até 10 min antes da entrada.
      const rows = await prisma.$queryRaw<{ entrada: Date; primeira: Date | null; usuarioId: string | null }[]>(Prisma.sql`
        SELECT e.entrada, pl.em AS primeira, pl."usuarioId"
          FROM "CrmDeal" d
          CROSS JOIN LATERAL (SELECT ${ENTRADA_SQL} AS entrada) e
          LEFT JOIN LATERAL (
            SELECT x.em, x."usuarioId" FROM (
              SELECT a."criadoEm" AS em, a."usuarioId"
                FROM "CrmAtividade" a
               WHERE a."dealId" = d.id AND a.tipo = 'ligacao' AND COALESCE(a.direcao, 'saida') = 'saida'
              UNION ALL
              SELECT l."iniciadaEm", l."usuarioId"
                FROM "CrmLigacao" l JOIN "EmpresaEmitente" em ON em.id = l."emitenteId"
               WHERE l."dealId" = d.id AND l.status <> 'FALHOU'
                 AND l."numeroOrigem" IN (em."voipDid", em."voipDid2", em."voipDid3")
            ) x
            WHERE x.em >= e.entrada - interval '10 minutes'
            ORDER BY x.em LIMIT 1
          ) pl ON true
         WHERE d."pipelineId" IN (${pipe})
           AND e.entrada >= ${de} AND e.entrada < ${ate}${emp}
      `);

      // Colunas são timestamp sem fuso gravadas em UTC: o Date já sai certo no relógio UTC.
      const itens = rows.map(r => {
        const ent = r.entrada.getTime();
        const pri = r.primeira ? Math.max(ent, r.primeira.getTime()) : null;
        return {
          dia: diaLocal(r.entrada),
          usuarioId: r.usuarioId,
          corrido: pri === null ? null : (pri - ent) / 60_000,
          util:    pri === null ? null : minutosUteis(ent, pri),
        };
      });
      const ligados = itens.filter(i => i.corrido !== null);

      const porDia = new Map<string, typeof itens>();
      for (const i of itens) (porDia.get(i.dia) ?? porDia.set(i.dia, []).get(i.dia)!).push(i);
      const dias = [...porDia.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([dia, xs]) => {
        const lig = xs.filter(i => i.corrido !== null);
        return {
          dia, leads: xs.length, ligados: lig.length,
          medianaCorrido: mediana(lig.map(i => i.corrido!)),
          medianaUtil:    mediana(lig.map(i => i.util!)),
        };
      });

      const porUsuario = new Map<string, typeof itens>();
      for (const i of ligados) (porUsuario.get(i.usuarioId ?? "") ?? porUsuario.set(i.usuarioId ?? "", []).get(i.usuarioId ?? "")!).push(i);
      const ids = [...porUsuario.keys()].filter(Boolean);
      const nomes = new Map(
        (await prisma.usuario.findMany({ where: { id: { in: ids } }, select: { id: true, nome: true } })).map(u => [u.id, u.nome]),
      );
      const usuarios = [...porUsuario.entries()].map(([id, xs]) => ({
        usuarioId: id || null,
        nome: id ? nomes.get(id) ?? "(usuário removido)" : "(sem usuário)",
        ligados: xs.length,
        medianaCorrido: mediana(xs.map(i => i.corrido!)),
        medianaUtil:    mediana(xs.map(i => i.util!)),
      })).sort((a, b) => b.ligados - a.ligados);

      return {
        leads: itens.length,
        ligados: ligados.length,
        corrido: resumoMinutos(ligados.map(i => i.corrido!)),
        util:    resumoMinutos(ligados.map(i => i.util!)),
        dias,
        usuarios,
      };
    }),

  /**
   * Lista analítica de leads do período (sem kanban): um lead por linha com origem,
   * etapa, volume de mensagens, tempo até a 1ª resposta, atendimento (IA/SDR), valor,
   * tags e marcação de fechado/protocolado. Filtros e ordenação ficam no cliente.
   */
  leads: authProc
    .input(periodoInput)
    .query(async ({ input, ctx }) => {
      const pipeIds = await pipelinesPermitidos(ctx, input.pipelineIds);
      if (pipeIds.length === 0) return [];

      const stages = await prisma.crmStage.findMany({
        where: { pipelineId: { in: pipeIds } },
        select: { id: true, chave: true, nome: true, cor: true, ordem: true, ehGanho: true, pipelineId: true },
      });
      const cfg = await carregarConfig(ctx, stages);
      const stageMap = new Map(stages.map(s => [s.id, s]));
      // Etapa inicial = menor ordem entre as etapas "positivas" (Desqualificado costuma ser a coluna 0).
      const NEGATIVA = /desqualific|sem_resposta|perdid/;
      const primeiraOrdem = new Map<string, number>();
      for (const s of stages) {
        if (NEGATIVA.test(`${s.chave} ${s.nome}`.toLowerCase())) continue;
        primeiraOrdem.set(s.pipelineId, Math.min(primeiraOrdem.get(s.pipelineId) ?? 1e9, s.ordem));
      }

      const de   = tsUtc(inicioDoDia(input.de));
      const ate  = tsUtc(fimDoDia(input.ate));
      const emp  = empresaSql(ctx);
      const pipe = Prisma.join(pipeIds);

      const rows = await prisma.$queryRaw<{
        id: string; titulo: string; entrada: Date; stageId: string; pipelineId: string; status: string;
        iaAtiva: boolean; iaPausadaPor: string | null; valorEstimado: unknown; valor: unknown; ultimoContatoEm: Date | null;
        origemPlataforma: string | null; origemTipo: string | null; origemAnuncioId: string | null;
        origemAnuncioTitulo: string | null; origemAnuncioTexto: string | null; origemUrl: string | null; origemEm: Date | null;
        contatoId: string | null; contatoNome: string | null; whatsapp: string | null; cidade: string | null;
        fotoPerfilUrl: string | null; fotoPerfilEm: Date | null;
        msgsIn: bigint; msgsOut: bigint; primeiraIn: Date | null; primeiraOut: Date | null; ultimaMsg: Date | null;
      }[]>(Prisma.sql`
        SELECT d.id, d.titulo, ${ENTRADA_SQL} AS entrada, d."stageId", d."pipelineId", d.status,
               d."iaAtiva", d."iaPausadaPor", d."valorEstimado", d.valor, d."ultimoContatoEm",
               d."origemPlataforma", d."origemTipo", d."origemAnuncioId", d."origemAnuncioTitulo", d."origemAnuncioTexto", d."origemUrl", d."origemEm",
               c.id AS "contatoId", c.nome AS "contatoNome", COALESCE(c.whatsapp, c.telefone) AS whatsapp, c.cidade,
               c."fotoPerfilUrl", c."fotoPerfilEm",
               COALESCE(m."msgsIn", 0)::bigint AS "msgsIn", COALESCE(m."msgsOut", 0)::bigint AS "msgsOut",
               m."primeiraIn", m."primeiraOut", m."ultimaMsg"
          FROM "CrmDeal" d
          LEFT JOIN "CrmContato" c ON c.id = d."contatoId"
          LEFT JOIN LATERAL (
            SELECT COUNT(*) FILTER (WHERE x.direcao = 'in')  AS "msgsIn",
                   COUNT(*) FILTER (WHERE x.direcao = 'out') AS "msgsOut",
                   MIN(x."enviadaEm") FILTER (WHERE x.direcao = 'in')  AS "primeiraIn",
                   MIN(x."enviadaEm") FILTER (WHERE x.direcao = 'out') AS "primeiraOut",
                   MAX(x."enviadaEm") AS "ultimaMsg"
              FROM "CrmMensagemWhatsapp" x WHERE x."dealId" = d.id
          ) m ON TRUE
         WHERE d."pipelineId" IN (${pipe})
           AND ${ENTRADA_SQL} >= ${de} AND ${ENTRADA_SQL} < ${ate}${emp}
         ORDER BY 3 DESC
      `);
      if (rows.length === 0) return [];
      const ids = rows.map(r => r.id);

      const alvos = [...cfg.fechado, ...cfg.protocolado];
      const [logs, comTags, sdrs, pipelines] = await Promise.all([
        alvos.length
          ? prisma.crmDealStageLog.findMany({ where: { dealId: { in: ids }, stageNovoId: { in: alvos } }, select: { dealId: true, stageNovoId: true } })
          : Promise.resolve([] as { dealId: string; stageNovoId: string }[]),
        prisma.crmDeal.findMany({ where: { id: { in: ids } }, select: { id: true, tags: { select: { nome: true, cor: true } } } }),
        prisma.usuario.findMany({
          where: { id: { in: [...new Set(rows.map(r => r.iaPausadaPor).filter(Boolean))] as string[] } },
          select: { id: true, nome: true },
        }),
        prisma.crmPipeline.findMany({ where: { id: { in: pipeIds } }, select: { id: true, nome: true } }),
      ]);
      const fechadoSet = new Set(cfg.fechado), protocoladoSet = new Set(cfg.protocolado);
      const fechou = new Set<string>(), protocolou = new Set<string>();
      for (const l of logs) {
        if (fechadoSet.has(l.stageNovoId)) fechou.add(l.dealId);
        if (protocoladoSet.has(l.stageNovoId)) protocolou.add(l.dealId);
      }
      const tagsMap = new Map(comTags.map(d => [d.id, d.tags]));
      const sdrMap  = new Map(sdrs.map(u => [u.id, u.nome]));
      const pipeMap = new Map(pipelines.map(p => [p.id, p.nome]));

      return rows.map(r => {
        const st = stageMap.get(r.stageId);
        if (st && fechadoSet.has(st.id)) fechou.add(r.id);
        if (st && protocoladoSet.has(st.id)) protocolou.add(r.id);
        const msgsIn = Number(r.msgsIn), msgsOut = Number(r.msgsOut);
        const respostaMin = r.primeiraIn && r.primeiraOut && r.primeiraOut > r.primeiraIn
          ? Math.round((r.primeiraOut.getTime() - r.primeiraIn.getTime()) / 60000) : null;
        const chave = (st?.chave ?? "").toLowerCase();
        const negativo = NEGATIVA.test(`${chave} ${(st?.nome ?? "").toLowerCase()}`) || r.status === "perdido";
        const avancou = !!st && !negativo && st.ordem > (primeiraOrdem.get(r.pipelineId) ?? 0);
        return {
          dealId: r.id, titulo: r.titulo, entrada: r.entrada, status: r.status,
          pipeline: pipeMap.get(r.pipelineId) ?? "", pipelineId: r.pipelineId,
          stage: st?.nome ?? "", stageCor: st?.cor ?? "#999", stageChave: st?.chave ?? "", stageOrdem: st?.ordem ?? 0,
          contato: r.contatoNome, whatsapp: r.whatsapp, cidade: r.cidade,
          contatoRef: r.contatoId ? { id: r.contatoId, fotoPerfilUrl: r.fotoPerfilUrl, fotoPerfilEm: r.fotoPerfilEm } : null,
          origemPlataforma: r.origemPlataforma, origemTipo: r.origemTipo, origemAnuncioId: r.origemAnuncioId,
          origemAnuncioTitulo: r.origemAnuncioTitulo, origemAnuncioTexto: r.origemAnuncioTexto, origemUrl: r.origemUrl, origemEm: r.origemEm,
          msgsIn, msgsOut, engajou: msgsIn >= 2, respostaMin,
          ultimaMsg: r.ultimaMsg ?? r.ultimoContatoEm ?? null,
          diasNoFunil: Math.max(0, Math.floor((Date.now() - r.entrada.getTime()) / 86400000)),
          atendimento: r.iaAtiva ? "IA" : (r.iaPausadaPor ? (sdrMap.get(r.iaPausadaPor) ?? "Atendente") : "Humano"),
          valorEstimado: r.valorEstimado != null ? Number(r.valorEstimado) : null,
          valor: r.valor != null ? Number(r.valor) : null,
          tags: tagsMap.get(r.id) ?? [],
          avancou, negativo, fechou: fechou.has(r.id), protocolou: protocolou.has(r.id),
        };
      });
    }),
});

/** Normaliza a plataforma gravada no deal para as chaves usadas no painel. */
function plataformaChave(p: string | null | undefined): string {
  if (!p) return "sem_origem";
  if (p === "facebook" || p === "instagram" || p === "meta" || p === "site" || p === "social") return p;
  return "organico"; // whatsapp (busca) / telefone
}

export type { LinhaDia };
