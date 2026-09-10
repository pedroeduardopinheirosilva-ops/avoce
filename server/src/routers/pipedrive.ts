import { z } from "zod";
import { router, authProc } from "./trpc.js";
import { prisma } from "../db.js";
import {
  testConnection,
  fetchPipelines,
  fetchStages,
  fetchPersons,
  fetchDeals,
  fetchDealFields,
  fetchNotes,
  fetchActivities,
  fetchActivitiesDone,
  fetchDealFlow,
  getRateLimitStatus,
} from "../lib/pipedrive.js";

const CONFIG_KEY = "pipedrive_api_token";

/**
 * Pipedrive devolve datas como "2026-05-07 18:56:49" (UTC, sem marcador de fuso).
 * `new Date()` interpretaria isso como horário LOCAL — o que joga o dia para trás.
 */
function parsePdDate(v?: string | null): Date | undefined {
  if (!v) return undefined;
  const iso = /[zZ]|[+-]\d{2}:?\d{2}$/.test(v)
    ? v.replace(" ", "T")
    : `${v.replace(" ", "T")}Z`;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? undefined : d;
}

async function getToken(): Promise<string | null> {
  const cfg = await prisma.configuracao.findUnique({ where: { chave: CONFIG_KEY } });
  return cfg?.valor ?? null;
}

export const pipedriveRouter = router({

  // ── Token management ──────────────────────────────────────────────────────

  getConfig: authProc.query(async () => {
    const [cfg, lastSync] = await Promise.all([
      prisma.configuracao.findUnique({ where: { chave: CONFIG_KEY } }),
      prisma.configuracao.findUnique({ where: { chave: "pipedrive_last_sync" } }),
    ]);
    return {
      hasToken: !!cfg?.valor,
      token: cfg?.valor ? `${cfg.valor.slice(0, 6)}...` : null,
      lastSync: lastSync?.valor ?? null,
    };
  }),

  saveToken: authProc
    .input(z.object({ token: z.string().min(10) }))
    .mutation(async ({ input }) => {
      await prisma.configuracao.upsert({
        where: { chave: CONFIG_KEY },
        update: { valor: input.token },
        create: { chave: CONFIG_KEY, valor: input.token },
      });
      return { ok: true };
    }),

  testarConexao: authProc.query(async () => {
    const token = await getToken();
    if (!token) return { ok: false, error: "Token não configurado" };
    return testConnection(token);
  }),

  // ── Preview ───────────────────────────────────────────────────────────────

  preview: authProc.query(async () => {
    const token = await getToken();
    if (!token) throw new Error("Token não configurado");
    const [pipelines, stages, persons, deals] = await Promise.all([
      fetchPipelines(token),
      fetchStages(token),
      fetchPersons(token).then(p => p.filter(x => !x.is_deleted)),
      fetchDeals(token),
    ]);
    return {
      pipelines: pipelines.length,
      stages: stages.length,
      contatos: persons.length,
      deals: deals.length,
      dealsOpen: deals.filter(d => d.status === "open").length,
      dealsWon: deals.filter(d => d.status === "won").length,
      dealsLost: deals.filter(d => d.status === "lost").length,
    };
  }),

  // ── Backfill de datas de criação ──────────────────────────────────────────

  /**
   * Regrava `CrmDeal.criadoEm` com o `add_time` real do Pipedrive.
   *
   * Importações antigas gravavam a data do SYNC, o que empilhava milhares de
   * deals num único dia e inutilizava qualquer série diária (painel).
   */
  backfillDatas: authProc
    .input(z.object({ dryRun: z.boolean().default(false) }).default({ dryRun: false }))
    .mutation(async ({ input }) => {
      const token = await getToken();
      if (!token) throw new Error("Token não configurado");

      const pdDeals = await fetchDeals(token);
      const locais = await prisma.crmDeal.findMany({
        where: { pipedriveId: { not: null } },
        select: { id: true, pipedriveId: true, criadoEm: true, titulo: true },
      });
      const porPd = new Map(locais.map(d => [d.pipedriveId!, d]));

      const updates: { id: string; criadoEm: Date; titulo: string; antes: Date }[] = [];
      let semAddTime = 0;
      for (const pd of pdDeals) {
        const local = porPd.get(pd.id);
        if (!local) continue;
        const nova = parsePdDate(pd.add_time);
        if (!nova) { semAddTime++; continue; }
        // tolerância de 1 min evita reescrever o que já está certo
        if (Math.abs(nova.getTime() - local.criadoEm.getTime()) < 60_000) continue;
        updates.push({ id: local.id, criadoEm: nova, titulo: local.titulo, antes: local.criadoEm });
      }

      if (!input.dryRun && updates.length) {
        const BATCH = 50;
        for (let i = 0; i < updates.length; i += BATCH) {
          await Promise.all(updates.slice(i, i + BATCH).map(u =>
            prisma.crmDeal.update({ where: { id: u.id }, data: { criadoEm: u.criadoEm } })
          ));
        }
      }

      return {
        dryRun: input.dryRun,
        dealsPipedrive: pdDeals.length,
        dealsLocais: locais.length,
        semAddTime,
        atualizados: updates.length,
        exemplos: updates.slice(0, 8).map(u => ({
          titulo: u.titulo,
          de: u.antes.toISOString().slice(0, 10),
          para: u.criadoEm.toISOString().slice(0, 10),
        })),
      };
    }),

  // ── Import ────────────────────────────────────────────────────────────────

  importar: authProc
    .input(z.object({
      overwrite: z.boolean().default(false),
      importarPerdidos: z.boolean().default(false),
      importarHistoricoEtapas: z.boolean().default(false),
      forceFull: z.boolean().default(false),
    }))
    .mutation(async ({ input, ctx }) => {
      const token = await getToken();
      if (!token) throw new Error("Token não configurado");

      // Verify token + check rate limit before starting the full import
      const conn = await testConnection(token);
      if (!conn.ok) throw new Error(`Pipedrive: ${conn.error ?? "token inválido ou rate limit atingido"}`);

      // Load last sync timestamp for incremental mode
      const lastSyncCfg = await prisma.configuracao.findUnique({ where: { chave: "pipedrive_last_sync" } });
      const sinceTimestamp = (!input.forceFull && lastSyncCfg?.valor) ? lastSyncCfg.valor : undefined;
      const syncStartedAt = new Date().toISOString().replace("T", " ").slice(0, 19);

      const log: string[] = [];
      log.push(sinceTimestamp
        ? `🔄 Sync incremental desde ${sinceTimestamp} (Brasília)`
        : `📥 Importação completa (primeira vez ou forçada)`);

      // 0. Buscar definições de campos customizados dos deals (v1, para mapear key → nome legível)
      const dealFields = await fetchDealFields(token);
      log.push(`ℹ ${getRateLimitStatus()}`);
      // Mapa key → {name, field_type}
      const fieldDefs = new Map(dealFields.map(f => [f.key, f]));

      // 1. Pipelines
      const pdPipelines = await fetchPipelines(token);
      const pipelineMap = new Map<number, string>(); // pdId → localId
      // Sem herdar a empresa, o deal importado nasce com empresaId nulo: some das
      // listagens por empresa e trava todo guard canAccess — ninguém consegue abrir
      // nem excluir o card, que mesmo assim aparece no kanban.
      const pipelineEmpresaMap = new Map<number, string | null>(); // pdId → empresaId

      for (const pp of pdPipelines) {
        const existing = await prisma.crmPipeline.findUnique({ where: { pipedriveId: pp.id } });
        if (existing) {
          pipelineMap.set(pp.id, existing.id);
          pipelineEmpresaMap.set(pp.id, existing.empresaId ?? ctx.empresaId ?? null);
          if (input.overwrite) {
            await prisma.crmPipeline.update({ where: { id: existing.id }, data: { nome: pp.name } });
          }
        } else {
          const last = await prisma.crmPipeline.findFirst({ orderBy: { ordem: "desc" } });
          const created = await prisma.crmPipeline.create({
            data: {
              nome: pp.name,
              pipedriveId: pp.id,
              ordem: (last?.ordem ?? -1) + 1,
              empresaId: ctx.empresaId ?? undefined,
            },
          });
          pipelineMap.set(pp.id, created.id);
          pipelineEmpresaMap.set(pp.id, created.empresaId ?? null);
          log.push(`Pipeline criado: ${pp.name}`);
        }
      }

      // 2. Stages
      const pdStages = await fetchStages(token);
      const stageMap = new Map<number, string>(); // pdId → localId

      for (const ps of pdStages) {
        const pipelineLocalId = pipelineMap.get(ps.pipeline_id);
        if (!pipelineLocalId) continue;

        const existing = await prisma.crmStage.findFirst({ where: { pipedriveId: ps.id } });
        if (existing) {
          stageMap.set(ps.id, existing.id);
          if (input.overwrite) {
            await prisma.crmStage.update({ where: { id: existing.id }, data: { nome: ps.name } });
          }
        } else {
          const chave = `pd_${ps.id}`;
          // Check if chave+pipeline unique conflict
          const conflict = await prisma.crmStage.findFirst({ where: { pipelineId: pipelineLocalId, chave } });
          const created = await prisma.crmStage.create({
            data: {
              pipelineId: pipelineLocalId,
              chave: conflict ? `pd_${ps.id}_${Date.now()}` : chave,
              nome: ps.name,
              ordem: ps.order_nr,
              pipedriveId: ps.id,
            },
          });
          stageMap.set(ps.id, created.id);
          log.push(`Stage criado: ${ps.name}`);
        }
      }

      // 3. Persons → CrmContato
      const pdPersons = await fetchPersons(token, sinceTimestamp);
      const contatoMap = new Map<number, string>(); // pdId → localId
      let contatosCriados = 0;
      let contatosAtualizados = 0;

      // Bulk-load all existing contacts that came from Pipedrive
      const existingContatoRows = await prisma.crmContato.findMany({
        where: { pipedriveId: { not: null } },
        select: { id: true, pipedriveId: true, whatsapp: true },
      });
      const existingContatoByPdId = new Map(existingContatoRows.map(r => [r.pipedriveId!, r]));

      // Prepare rows for new contacts
      type ContatoRow = { nome: string; whatsapp?: string; email?: string; telefone?: string; empresa?: string; pipedriveId: number };
      const newContatoRows: ContatoRow[] = [];
      const overwriteContatoUpdates: Array<{ id: string; data: Omit<ContatoRow, "pipedriveId"> }> = [];

      for (const pp of pdPersons) {
        if (pp.is_deleted) continue;
        const phones = pp.phone ?? [];
        const emails = pp.email ?? [];
        const whatsapp = (
          phones.find((p: any) => p.label?.toLowerCase().includes("whatsapp"))?.value ??
          phones.find((p: any) => p.label?.toLowerCase().includes("mobile") || p.label?.toLowerCase().includes("celular"))?.value ??
          phones.find((p: any) => p.primary)?.value ??
          phones[0]?.value
        ) || undefined;
        const email = emails.find((p: any) => p.primary)?.value ?? emails[0]?.value ?? undefined;
        const telefone = phones.find((p: any) =>
          !p.label?.toLowerCase().includes("whatsapp") && p.value && p.value !== whatsapp
        )?.value || undefined;
        const empresa = pp.org_name || undefined;

        const existing = existingContatoByPdId.get(pp.id);
        if (existing) {
          contatoMap.set(pp.id, existing.id);
          if (input.overwrite) {
            overwriteContatoUpdates.push({ id: existing.id, data: { nome: pp.name, whatsapp, email, telefone, empresa } });
          }
        } else {
          newContatoRows.push({ nome: pp.name, whatsapp, email, telefone, empresa, pipedriveId: pp.id });
        }
      }

      // Bulk create new contacts
      if (newContatoRows.length > 0) {
        await (prisma.crmContato as any).createMany({ data: newContatoRows, skipDuplicates: true });
        contatosCriados = newContatoRows.length;
        // Re-fetch to get local IDs
        const created = await prisma.crmContato.findMany({
          where: { pipedriveId: { in: newContatoRows.map(r => r.pipedriveId) } },
          select: { id: true, pipedriveId: true },
        });
        for (const c of created) contatoMap.set(c.pipedriveId!, c.id);
      }

      // Bulk overwrite updates (batches of 50 parallel)
      if (overwriteContatoUpdates.length > 0) {
        const BATCH = 50;
        for (let i = 0; i < overwriteContatoUpdates.length; i += BATCH) {
          await Promise.all(overwriteContatoUpdates.slice(i, i + BATCH).map(u =>
            (prisma.crmContato as any).update({ where: { id: u.id }, data: u.data })
          ));
        }
        contatosAtualizados = overwriteContatoUpdates.length;
      }

      log.push(`Contatos: ${contatosCriados} criados, ${contatosAtualizados} atualizados`);

      // 4. Deals → CrmDeal
      const pdDeals = await fetchDeals(token, "all_not_deleted", sinceTimestamp);
      let dealsCriados = 0;
      let dealsAtualizados = 0;

      // Mapa pdDealId → localDealId (para linkar notas/atividades)
      const dealMap = new Map<number, string>();

      // Bulk-load existing deals
      const existingDealRows = await prisma.crmDeal.findMany({
        where: { pipedriveId: { not: null } },
        select: { id: true, pipedriveId: true },
      });
      const existingDealByPdId = new Map(existingDealRows.map(r => [r.pipedriveId!, r.id]));

      type DealRow = Record<string, any>;
      const newDealRows: DealRow[] = [];
      // pdId → stageLocalId for stagelog creation after bulk insert
      const newDealStageMap = new Map<number, string>();
      // pdId → { contatoId, dealPhone } for whatsapp fill
      const dealContactPhone = new Map<number, { contatoId: string; phone: string }>();
      const overwriteDealUpdates: Array<{ id: string; data: DealRow; contatoId?: string; phone?: string }> = [];
      let ignorados = 0;

      for (const pd of pdDeals) {
        if (pd.status === "deleted") continue;
        if (!input.importarPerdidos && pd.status === "lost") continue;

        const pipelineLocalId = pipelineMap.get(pd.pipeline_id);
        const stageLocalId = stageMap.get(pd.stage_id);
        if (!pipelineLocalId || !stageLocalId) {
          ignorados++;
          continue;
        }

        const status = pd.status === "won" ? "ganho" : pd.status === "lost" ? "perdido" : "aberto";
        // v2: person_id is a plain integer (v1 was { value: number })
        const contatoId = pd.person_id ? contatoMap.get(pd.person_id as number) : undefined;

        // v2: custom_fields is isolated; include_option_labels=true resolves labels in response
        const camposCustom: Record<string, string> = {};
        for (const [key, val] of Object.entries(pd.custom_fields ?? {})) {
          if (val === null || val === undefined || val === "") continue;
          const def = fieldDefs.get(key);
          if (!def || def.field_type === "org" || def.field_type === "people") continue;
          let displayVal: string;
          if (Array.isArray(val)) {
            displayVal = val.map((v: any) => (typeof v === "object" ? (v.label ?? String(v.value ?? v)) : String(v))).join(", ");
          } else if (typeof val === "object" && val !== null) {
            displayVal = val.label ?? val.formatted ?? String(val.value ?? JSON.stringify(val));
          } else {
            displayVal = String(val);
          }
          camposCustom[def.name] = displayVal;
        }

        // v2: person_phone not included in deal response; phones come from person import
        const dealPhone: string | null = null;

        // add_time = data real de criação no Pipedrive. Sem isso, `criadoEm`
        // vira a data da importação e o painel diário fica todo no dia do sync.
        const criadoEm = parsePdDate(pd.add_time);

        const dealExtra = {
          organizacao:           pd.org_name ?? null,  // v2: org_name is a root string field
          motivoPerda:           pd.lost_reason ?? null,
          dataFechamentoEsperada: pd.expected_close_date ? new Date(pd.expected_close_date) : null,
          rotulo:                pd.label_ids?.[0] != null ? String(pd.label_ids[0]) : null,
          probabilidade:         pd.probability ? Number(pd.probability) : null,
          moeda:                 pd.currency ?? null,
          ...(Object.keys(camposCustom).length ? { camposCustom } : {}),
        };

        const existingId = existingDealByPdId.get(pd.id);
        if (existingId) {
          dealMap.set(pd.id, existingId);
          dealsAtualizados++;
          if (input.overwrite) {
            overwriteDealUpdates.push({
              id: existingId,
              data: { titulo: pd.title, valor: pd.value || undefined, status, stageId: stageLocalId, contatoId, ...(criadoEm ? { criadoEm } : {}), ...dealExtra },
              contatoId: contatoId ?? undefined,
              phone: dealPhone ?? undefined,
            });
          }
        } else {
          newDealRows.push({
            titulo: pd.title,
            pipelineId: pipelineLocalId,
            stageId: stageLocalId,
            contatoId: contatoId ?? null,
            valor: pd.value || undefined,
            status,
            pipedriveId: pd.id,
            fonteLead: "Pipedrive",
            empresaId: pipelineEmpresaMap.get(pd.pipeline_id) ?? ctx.empresaId ?? undefined,
            ...(criadoEm ? { criadoEm } : {}),
            ...dealExtra,
          });
          newDealStageMap.set(pd.id, stageLocalId);
          if (contatoId && dealPhone) dealContactPhone.set(pd.id, { contatoId, phone: dealPhone });
        }
      }

      if (ignorados > 0) log.push(`⚠ ${ignorados} deals ignorados (pipeline/stage não mapeado)`);

      // Bulk create new deals
      if (newDealRows.length > 0) {
        await prisma.crmDeal.createMany({ data: newDealRows as any, skipDuplicates: true });
        dealsCriados = newDealRows.length;

        // Re-fetch to get local IDs for stageLog + whatsapp fill
        const newPdIds = newDealRows.map(r => r.pipedriveId as number);
        const createdDeals = await prisma.crmDeal.findMany({
          where: { pipedriveId: { in: newPdIds } },
          select: { id: true, pipedriveId: true },
        });
        const stageLogs: Array<{ dealId: string; stageNovoId: string }> = [];
        for (const d of createdDeals) {
          dealMap.set(d.pipedriveId!, d.id);
          const stageId = newDealStageMap.get(d.pipedriveId!);
          if (stageId) stageLogs.push({ dealId: d.id, stageNovoId: stageId });
        }
        if (stageLogs.length > 0) {
          await prisma.crmDealStageLog.createMany({ data: stageLogs, skipDuplicates: true });
        }

        // Fill whatsapp on contacts that don't have it yet
        const contatosParaWhatsapp = [...dealContactPhone.entries()]
          .map(([pdId, { contatoId, phone }]) => {
            const localDeal = dealMap.get(pdId);
            return localDeal ? { contatoId, phone } : null;
          })
          .filter((x): x is { contatoId: string; phone: string } => x !== null);

        if (contatosParaWhatsapp.length > 0) {
          const contatoIds = [...new Set(contatosParaWhatsapp.map(x => x.contatoId))];
          const semWhatsapp = await prisma.crmContato.findMany({
            where: { id: { in: contatoIds }, whatsapp: null },
            select: { id: true },
          });
          const semWhatsappSet = new Set(semWhatsapp.map(c => c.id));
          const BATCH = 50;
          const updates = contatosParaWhatsapp.filter(x => semWhatsappSet.has(x.contatoId));
          for (let i = 0; i < updates.length; i += BATCH) {
            await Promise.all(updates.slice(i, i + BATCH).map(u =>
              prisma.crmContato.update({ where: { id: u.contatoId }, data: { whatsapp: u.phone } })
            ));
          }
        }
      }

      // Overwrite updates (batches of 50 parallel)
      if (overwriteDealUpdates.length > 0) {
        const BATCH = 50;
        for (let i = 0; i < overwriteDealUpdates.length; i += BATCH) {
          await Promise.all(overwriteDealUpdates.slice(i, i + BATCH).map(u =>
            prisma.crmDeal.update({ where: { id: u.id }, data: u.data as any })
          ));
        }
      }

      log.push(`Deals: ${dealsCriados} criados, ${dealsAtualizados} já existiam`);

      // 4.5. Histórico de etapas (deal flow) → CrmDealStageLog (opcional)
      let stageHistoriaCriados = 0;
      if (input.importarHistoricoEtapas && dealMap.size > 0) {
        log.push(`Buscando histórico de etapas para ${dealMap.size} deals...`);

        // Busca em paralelo com concorrência máxima de 5 para respeitar rate limit
        const entries = [...dealMap.entries()];
        const CONCURRENCY = 5;
        for (let i = 0; i < entries.length; i += CONCURRENCY) {
          const batch = entries.slice(i, i + CONCURRENCY);
          const flows = await Promise.all(
            batch.map(([pdDealId, localDealId]) =>
              fetchDealFlow(token, pdDealId)
                .then(flow => ({ localDealId, flow }))
                .catch(() => ({ localDealId, flow: [] }))
            )
          );

          for (const { localDealId, flow } of flows) {
            for (const item of flow) {
              if (item.object !== "dealChange") continue;
              if (item.data.field_key !== "stage_id") continue;
              if (!item.data.new_value) continue;

              const pdStageNovoId = parseInt(item.data.new_value, 10);
              const localStageNovoId = stageMap.get(pdStageNovoId);
              if (!localStageNovoId) continue;

              const localStageAnteriorId = item.data.old_value
                ? stageMap.get(parseInt(item.data.old_value, 10))
                : undefined;

              const ts = new Date(item.data.log_time ?? item.timestamp);

              const exists = await prisma.crmDealStageLog.findFirst({
                where: { dealId: localDealId, stageNovoId: localStageNovoId, criadoEm: ts },
              });
              if (!exists) {
                await prisma.crmDealStageLog.create({
                  data: {
                    dealId: localDealId,
                    stageNovoId: localStageNovoId,
                    stageAnteriorId: localStageAnteriorId ?? null,
                    criadoEm: ts,
                  },
                });
                stageHistoriaCriados++;
              }
            }
          }
        }
        log.push(`Histórico de etapas: ${stageHistoriaCriados} movimentações importadas`);
      } else if (!input.importarHistoricoEtapas) {
        log.push(`Histórico de etapas: ignorado (opção desativada)`);
      }

      // 5. Notas + Atividades → CrmNota (bulk)
      let notasCriadas = 0;
      let atividadesCriadas = 0;
      try {
        const localDealIds = [...new Set(dealMap.values())];

        // Fetch notes + activities from Pipedrive in parallel
        const [pdNotes, atPendentes, atFeitas] = await Promise.all([
          fetchNotes(token, sinceTimestamp),
          fetchActivities(token, sinceTimestamp),
          fetchActivitiesDone(token, sinceTimestamp),
        ]);

        // Load existing notes for all relevant deals in one query
        const existingNotas = localDealIds.length > 0
          ? await (prisma as any).crmNota.findMany({
              where: { dealId: { in: localDealIds } },
              select: { dealId: true, conteudo: true },
            })
          : [];
        const existingNotaKeys = new Set<string>(
          existingNotas.map((n: any) => `${n.dealId}|||${n.conteudo}`)
        );

        const notasParaCriar: Array<{ dealId: string; conteudo: string }> = [];

        for (const note of pdNotes) {
          if (!note.deal_id || !note.content?.trim()) continue;
          const dealLocalId = dealMap.get(note.deal_id);
          if (!dealLocalId) continue;
          const key = `${dealLocalId}|||${note.content}`;
          if (!existingNotaKeys.has(key)) {
            notasParaCriar.push({ dealId: dealLocalId, conteudo: note.content });
            existingNotaKeys.add(key); // prevent duplicates within same batch
          }
        }

        for (const at of [...atPendentes, ...atFeitas]) {
          if (!at.deal_id) continue;
          const dealLocalId = dealMap.get(at.deal_id);
          if (!dealLocalId) continue;
          const conteudo = [
            `[Atividade Pipedrive] ${at.type?.toUpperCase()} — ${at.subject ?? ""}`,
            at.note ? `Nota: ${at.note}` : null,
            at.due_date ? `Data: ${at.due_date}${at.due_time ? " " + at.due_time : ""}` : null,
            `Status: ${at.done ? "Concluída" : "Pendente"}`,
          ].filter(Boolean).join("\n");
          const key = `${dealLocalId}|||${conteudo}`;
          if (!existingNotaKeys.has(key)) {
            notasParaCriar.push({ dealId: dealLocalId, conteudo });
            existingNotaKeys.add(key);
            atividadesCriadas++;
          }
        }

        notasCriadas = notasParaCriar.length - atividadesCriadas;

        if (notasParaCriar.length > 0) {
          await (prisma as any).crmNota.createMany({ data: notasParaCriar, skipDuplicates: true });
        }

        log.push(`Notas: ${notasCriadas} importadas`);
        log.push(`Atividades: ${atividadesCriadas} importadas`);
      } catch (e: any) {
        log.push(`Notas/Atividades: erro — ${e.message}`);
      }

      // Save last sync timestamp (UTC → stored in Brasilia format for display)
      await prisma.configuracao.upsert({
        where: { chave: "pipedrive_last_sync" },
        update: { valor: syncStartedAt },
        create: { chave: "pipedrive_last_sync", valor: syncStartedAt },
      });
      log.push(`✅ Sync salvo: próxima execução será incremental desde ${syncStartedAt}`);

      return { ok: true, log };
    }),
});
