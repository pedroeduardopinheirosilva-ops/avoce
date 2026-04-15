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
} from "../lib/pipedrive.js";

const CONFIG_KEY = "pipedrive_api_token";

async function getToken(): Promise<string | null> {
  const cfg = await prisma.configuracao.findUnique({ where: { chave: CONFIG_KEY } });
  return cfg?.valor ?? null;
}

export const pipedriveRouter = router({

  // ── Token management ──────────────────────────────────────────────────────

  getConfig: authProc.query(async () => {
    const cfg = await prisma.configuracao.findUnique({ where: { chave: CONFIG_KEY } });
    return { hasToken: !!cfg?.valor, token: cfg?.valor ? `${cfg.valor.slice(0, 6)}...` : null };
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
      fetchPersons(token).then(p => p.filter(x => x.active_flag)),
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

  // ── Import ────────────────────────────────────────────────────────────────

  importar: authProc
    .input(z.object({
      overwrite: z.boolean().default(false),
      importarPerdidos: z.boolean().default(false),
    }))
    .mutation(async ({ input }) => {
      const token = await getToken();
      if (!token) throw new Error("Token não configurado");

      const log: string[] = [];

      // 0. Buscar definições de campos customizados dos deals
      const dealFields = await fetchDealFields(token);
      // Campos padrão do Pipedrive — ignorar ao salvar camposCustom
      const CAMPOS_PADRAO = new Set([
        "id","title","value","currency","status","stage_id","pipeline_id",
        "person_id","org_id","update_time","add_time","close_time","won_time",
        "lost_time","expected_close_date","lost_reason","visible_to","owner_id",
        "cc_email","notes_count","activities_count","done_activities_count",
        "undone_activities_count","email_messages_count","formatted_value",
        "stage_change_time","active","deleted","weighted_value","rotten_time",
        "stage_order_nr","person_name","org_name","next_activity_date",
        "next_activity_time","next_activity_id","last_activity_id","last_activity_date",
        "last_incoming_mail_time","last_outgoing_mail_time","label","renewal_type",
        "person_phone","person_email","creator_user_id","user_id","followers_count",
        "participants_count","products_count","contract_duration",
      ]);
      // Mapa key → {name, options}
      const fieldDefs = new Map(dealFields.map(f => [f.key, f]));

      // 1. Pipelines
      const pdPipelines = await fetchPipelines(token);
      const pipelineMap = new Map<number, string>(); // pdId → localId

      for (const pp of pdPipelines) {
        const existing = await prisma.crmPipeline.findUnique({ where: { pipedriveId: pp.id } });
        if (existing) {
          pipelineMap.set(pp.id, existing.id);
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
            },
          });
          pipelineMap.set(pp.id, created.id);
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
      const pdPersons = await fetchPersons(token);
      const contatoMap = new Map<number, string>(); // pdId → localId
      let contatosCriados = 0;
      let contatosAtualizados = 0;

      for (const pp of pdPersons) {
        if (!pp.active_flag) continue;
        // Prioridade: WhatsApp > mobile > primary > primeiro
        const whatsapp = (
          pp.phone.find(p => p.label?.toLowerCase().includes("whatsapp"))?.value ??
          pp.phone.find(p => p.label?.toLowerCase().includes("mobile") || p.label?.toLowerCase().includes("celular"))?.value ??
          pp.phone.find(p => p.primary)?.value ??
          pp.phone[0]?.value
        ) || undefined;
        const email = pp.email.find(p => p.primary)?.value ?? pp.email[0]?.value ?? undefined;

        // Telefone fixo/comercial separado do WhatsApp
        const telefone = pp.phone.find(p =>
          !p.label?.toLowerCase().includes("whatsapp") && p.value && p.value !== whatsapp
        )?.value || undefined;
        const empresa = pp.org_name || undefined;

        const existing = await prisma.crmContato.findUnique({ where: { pipedriveId: pp.id } });
        if (existing) {
          contatoMap.set(pp.id, existing.id);
          if (input.overwrite) {
            await (prisma.crmContato as any).update({
              where: { id: existing.id },
              data: { nome: pp.name, whatsapp, email, telefone, empresa },
            });
            contatosAtualizados++;
          }
        } else {
          const created = await (prisma.crmContato as any).create({
            data: { nome: pp.name, whatsapp, email, telefone, empresa, pipedriveId: pp.id },
          });
          contatoMap.set(pp.id, created.id);
          contatosCriados++;
        }
      }
      log.push(`Contatos: ${contatosCriados} criados, ${contatosAtualizados} atualizados`);

      // 4. Deals → CrmDeal
      const pdDeals = await fetchDeals(token);
      let dealsCriados = 0;
      let dealsAtualizados = 0;

      // Mapa pdDealId → localDealId (para linkar notas/atividades)
      const dealMap = new Map<number, string>();

      for (const pd of pdDeals) {
        if (pd.status === "deleted") continue;
        if (!input.importarPerdidos && pd.status === "lost") continue;

        const pipelineLocalId = pipelineMap.get(pd.pipeline_id);
        const stageLocalId = stageMap.get(pd.stage_id);
        if (!pipelineLocalId || !stageLocalId) continue;

        const status = pd.status === "won" ? "ganho" : pd.status === "lost" ? "perdido" : "aberto";
        const contatoId = pd.person_id ? contatoMap.get(pd.person_id.value) : undefined;

        // Extrair campos customizados (não-padrão com valor preenchido)
        const camposCustom: Record<string, string> = {};
        for (const [key, val] of Object.entries(pd)) {
          if (CAMPOS_PADRAO.has(key) || val === null || val === undefined || val === "") continue;
          if (typeof val === "object" || Array.isArray(val)) continue;
          const def = fieldDefs.get(key);
          if (!def || def.field_type === "org" || def.field_type === "people") continue;
          // Resolver enum options
          let displayVal = String(val);
          if (def.options) {
            const opt = def.options.find(o => String(o.id) === String(val));
            if (opt) displayVal = opt.label;
          }
          camposCustom[def.name] = displayVal;
        }

        // Telefone do deal (person_phone vem junto no deal)
        const dealPhone = pd.person_phone?.find((p: any) => p.primary)?.value
          ?? pd.person_phone?.[0]?.value ?? null;

        const dealExtra = {
          organizacao:             pd.org_id?.name ?? null,
          motivoPerda:             pd.lost_reason ?? null,
          dataFechamentoEsperada:  pd.expected_close_date ? new Date(pd.expected_close_date) : null,
          rotulo:                  pd.label ? String(pd.label) : null,
          probabilidade:           pd.probability ? Number(pd.probability) : null,
          moeda:                   pd.currency ?? null,
          ...(Object.keys(camposCustom).length ? { camposCustom } : {}),
        };

        const existing = await prisma.crmDeal.findUnique({ where: { pipedriveId: pd.id } });
        if (existing) {
          dealMap.set(pd.id, existing.id);
          dealsAtualizados++;
          if (input.overwrite) {
            await prisma.crmDeal.update({
              where: { id: existing.id },
              data: {
                titulo: pd.title,
                valor: pd.value || undefined,
                status,
                stageId: stageLocalId,
                contatoId,
                ...dealExtra,
              },
            });
            // Atualizar whatsapp do contato com telefone do deal se não tiver
            if (contatoId && dealPhone) {
              const c = await prisma.crmContato.findUnique({ where: { id: contatoId } });
              if (c && !c.whatsapp) {
                await prisma.crmContato.update({ where: { id: contatoId }, data: { whatsapp: dealPhone } });
              }
            }
          }
        } else {
          const deal = await prisma.crmDeal.create({
            data: {
              titulo: pd.title,
              pipelineId: pipelineLocalId,
              stageId: stageLocalId,
              contatoId,
              valor: pd.value || undefined,
              status,
              pipedriveId: pd.id,
              fonteLead: "Pipedrive",
              ...dealExtra,
            },
          });
          dealMap.set(pd.id, deal.id);
          await prisma.crmDealStageLog.create({
            data: { dealId: deal.id, stageNovoId: stageLocalId },
          });
          // Salvar telefone do deal no contato se não tiver
          if (contatoId && dealPhone) {
            const c = await prisma.crmContato.findUnique({ where: { id: contatoId } });
            if (c && !c.whatsapp) {
              await prisma.crmContato.update({ where: { id: contatoId }, data: { whatsapp: dealPhone } });
            }
          }
          dealsCriados++;
        }
      }
      log.push(`Deals: ${dealsCriados} criados, ${dealsAtualizados} já existiam`);

      // 4.5. Histórico de etapas (deal flow) → CrmDealStageLog
      let stageHistoriaCriados = 0;
      for (const [pdDealId, localDealId] of dealMap) {
        try {
          const flow = await fetchDealFlow(token, pdDealId);
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

            // Deduplicar por dealId + stageNovoId + criadoEm
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
        } catch {
          // ignora erros individuais de flow
        }
      }
      log.push(`Histórico de etapas: ${stageHistoriaCriados} movimentações importadas`);

      // 5. Notas → CrmNota
      let notasCriadas = 0;
      try {
        const pdNotes = await fetchNotes(token);
        for (const note of pdNotes) {
          if (!note.deal_id || !note.content?.trim()) continue;
          const dealLocalId = dealMap.get(note.deal_id);
          if (!dealLocalId) continue;
          // Evitar duplicar
          const exists = await (prisma as any).crmNota.findFirst({
            where: { dealId: dealLocalId, conteudo: note.content },
          });
          if (!exists) {
            await (prisma as any).crmNota.create({
              data: { dealId: dealLocalId, conteudo: note.content },
            });
            notasCriadas++;
          }
        }
        log.push(`Notas: ${notasCriadas} importadas`);
      } catch (e: any) {
        log.push(`Notas: erro — ${e.message}`);
      }

      // 6. Atividades → CrmNota (como registro de atividade)
      let atividadesCriadas = 0;
      try {
        const [atPendentes, atFeitas] = await Promise.all([
          fetchActivities(token),
          fetchActivitiesDone(token),
        ]);
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
          const exists = await (prisma as any).crmNota.findFirst({
            where: { dealId: dealLocalId, conteudo },
          });
          if (!exists) {
            await (prisma as any).crmNota.create({
              data: { dealId: dealLocalId, conteudo },
            });
            atividadesCriadas++;
          }
        }
        log.push(`Atividades: ${atividadesCriadas} importadas`);
      } catch (e: any) {
        log.push(`Atividades: erro — ${e.message}`);
      }

      return { ok: true, log };
    }),
});
