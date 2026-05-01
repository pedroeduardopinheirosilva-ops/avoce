/**
 * Vinculos Processor — stateless vinculos-loop logic extracted from stage-engine.ts.
 * Calls LLM (tryExtractVinculo, checkVinculoPrazo) but does NOT write to DB.
 * Returns mergedUpdates patch + notasParaCriar so the caller can persist both.
 */

import { tryExtractVinculo, checkVinculoPrazo } from "./qualification.js";
import { syncVinculosFromFlat } from "./qualification-utils.js";
import type { VinculoEmprego, VinculosState } from "./types.js";

export interface VinculosProcessorInput {
  projetoId: string;
  merged: Record<string, unknown>;
  text: string | null;
  history: Array<{ direcao: string; conteudo?: string | null }>;
  maisEmpregosPerguntado: boolean;
}

export interface VinculosProcessorResult {
  state: VinculosState;
  mergedUpdates: Record<string, unknown>;
  notasParaCriar: string[];
}

const CAMPOS_REQ: Array<keyof VinculoEmprego> = [
  "empresa", "funcao", "vinculo", "saida", "tempo",
  "horas_extras", "pagamento_fora", "injustica",
];

function todosCompletos(arr: VinculoEmprego[]): boolean {
  return arr.length > 0 && arr.every(v => CAMPOS_REQ.every(k => v[k] != null && v[k] !== ""));
}

function parseMesesTempo(s: string): number {
  let t = 0;
  const ma = s.match(/(\d+)\s*an/i); if (ma) t += parseInt(ma[1]) * 12;
  const mm = s.match(/(\d+)\s*m[eê]/i); if (mm) t += parseInt(mm[1]);
  return t;
}

function computeDelta(
  original: Record<string, unknown>,
  updated: Record<string, unknown>,
): Record<string, unknown> {
  const delta: Record<string, unknown> = {};
  const keys = new Set([...Object.keys(original), ...Object.keys(updated)]);
  for (const k of keys) {
    if (JSON.stringify(updated[k]) !== JSON.stringify(original[k])) delta[k] = updated[k];
  }
  return delta;
}

export async function processVinculos(input: VinculosProcessorInput): Promise<VinculosProcessorResult> {
  const { projetoId, merged, text, history, maisEmpregosPerguntado } = input;
  const w: Record<string, unknown> = { ...merged };
  const notas: string[] = [];

  let vinculos: VinculoEmprego[] = Array.isArray(w.vinculos) ? (w.vinculos as VinculoEmprego[]) : [];
  let vinculosOk = w._vinculos_ok === true;
  const vinculosTodosPrescritos = w._vinculos_todos_prescritos === true;

  // Seed vinculos[0] from flat fields when array is empty
  if (vinculos.length === 0 && !vinculosOk && !vinculosTodosPrescritos) {
    const empresaSeed = (w.empresa_principal ?? w.empresa_recente) as string | undefined;
    if (empresaSeed) {
      const seeded: VinculoEmprego = {
        ordem: 1, empresa: empresaSeed,
        funcao:         (w.funcao_recente as string | undefined)     ?? undefined,
        vinculo:        (w.vinculo_recente as string | undefined)    ?? undefined,
        saida:          (w.saida_recente as string | undefined)      ?? undefined,
        tempo:          (w.tempo_recente as string | undefined)      ?? undefined,
        data_saida:     (w.data_saida_recente as string | undefined) ?? undefined,
        horas_extras: undefined, pagamento_fora: undefined, injustica: undefined,
        frota: w.frota_recente != null ? String(w.frota_recente) : w.frota != null ? String(w.frota) : undefined,
      };
      w.vinculos = [seeded];
      vinculos = [seeded];
    }
  }

  // Sync flat merged fields → vinculos entries
  if (vinculos.length > 0 && !vinculosOk) {
    const sync = syncVinculosFromFlat(vinculos, w);
    if (sync.changed) { vinculos = sync.vinculos; w.vinculos = vinculos; }
  }

  if (!vinculosOk && text) {
    try {
      const historiaTexto = history.slice(-20)
        .map(m => `${m.direcao === "out" ? "Ana" : "Cliente"}: ${m.conteudo ?? ""}`)
        .join("\n");

      const extraido = await tryExtractVinculo(
        projetoId, text, vinculos, historiaTexto,
        w._mais_empregos_confirmado === true, maisEmpregosPerguntado,
      );

      const vinculosAtuais = extraido.updatedVinculos;
      if (JSON.stringify(vinculosAtuais) !== JSON.stringify(vinculos)) {
        w.vinculos = vinculosAtuais;
        notas.push(`[IA] Vínculos enriquecidos com dados da conversa: ${vinculosAtuais.map(v => v.empresa ?? "?").join(", ")}`);
      }

      if (extraido.semMaisEmpregos) {
        w._mais_empregos_negado = true;
        if (todosCompletos(vinculosAtuais)) {
          w._vinculos_ok = true;
        } else {
          // Minimum viability: lead denied more employers — close if empresa+vinculo+saida present
          const temVinculoValido = vinculosAtuais.some(v => v.empresa && v.vinculo && v.saida);
          if (temVinculoValido) w._vinculos_ok = true;
        }
        w.vinculos = vinculosAtuais;

      } else if (extraido.vinculo) {
        const dentroPrazo = await checkVinculoPrazo(projetoId, extraido.vinculo);
        if (!dentroPrazo) {
          if (vinculosAtuais.length === 0) {
            w._vinculos_ok = true;
            w._vinculos_todos_prescritos = true;
          } else if (todosCompletos(vinculosAtuais)) {
            w._vinculos_ok = true;
          }
          w.vinculos = vinculosAtuais;
        } else {
          vinculosAtuais.push({ ...extraido.vinculo, ordem: vinculosAtuais.length + 1 });
          w.vinculos = vinculosAtuais;
          delete w._mais_empregos_confirmado;
          notas.push(
            `[IA] Vínculo ${vinculosAtuais.length}: ${extraido.vinculo.empresa ?? "?"} — ` +
            `${extraido.vinculo.funcao ?? "?"} — saída: ${extraido.vinculo.saida ?? extraido.vinculo.data_saida ?? "?"}`,
          );
        }

      } else if (extraido.confirmouMaisEmpregos) {
        if (todosCompletos(vinculosAtuais)) {
          w._mais_empregos_confirmado = true;
        }
        w.vinculos = vinculosAtuais;

      } else {
        // Enrichment only — retroactive prescricao check on v0 if data_saida arrived
        const v0 = vinculosAtuais[0];
        if (v0?.data_saida && !w._vinculos_todos_prescritos) {
          const dentroPrazaEnriq = await checkVinculoPrazo(projetoId, v0);
          if (!dentroPrazaEnriq) {
            w._vinculos_ok = true;
            w._vinculos_todos_prescritos = true;
          }
        }
        w.vinculos = vinculosAtuais;
      }

      // Recovery seed: if LLM returned confirmouMaisEmpregos in a prior call but never created
      // vinculos[1], seed a partial entry from emprego_anterior_* flat fields. Must run BEFORE
      // auto-close so the seed entry is counted when determining whether to close.
      const empresaAnteriorFlat =
        (merged.emprego_anterior_empresa as string | undefined) ??
        (merged.empresa_anterior as string | undefined);
      const deveSedarV1 =
        !w._vinculos_ok &&
        vinculosAtuais.length === 1 &&
        w._mais_empregos_confirmado === true &&
        !!empresaAnteriorFlat &&
        empresaAnteriorFlat !== vinculosAtuais[0]?.empresa;

      if (deveSedarV1) {
        const v1Seed: VinculoEmprego = {
          ordem: 2,
          empresa: empresaAnteriorFlat as string,
          funcao: merged.emprego_anterior_funcao
            ? String(merged.emprego_anterior_funcao)
            : vinculosAtuais[0]?.funcao,
          vinculo: merged.emprego_anterior_vinculo
            ? String(merged.emprego_anterior_vinculo)
            : vinculosAtuais[0]?.vinculo,
          tempo: merged.emprego_anterior_tempo ? String(merged.emprego_anterior_tempo) : undefined,
          saida: merged.emprego_anterior_saida ? String(merged.emprego_anterior_saida) : undefined,
          data_saida: undefined,
          horas_extras: undefined,
          pagamento_fora: undefined,
          injustica: undefined,
        };
        vinculosAtuais.push(v1Seed);
        w.vinculos = vinculosAtuais;
        notas.push(`[IA] Recovery seed vinculos[1]: ${empresaAnteriorFlat}`);
      }

      // Auto-close: 2+ complete vinculos, or 1 complete after mais_empregos was asked
      if (!w._vinculos_ok && todosCompletos(vinculosAtuais) &&
          (vinculosAtuais.length >= 2 || maisEmpregosPerguntado)) {
        w._vinculos_ok = true;
        w.vinculos = vinculosAtuais;
      }

      // Auto-close (partial): lead confirmed all vinculos with minimum fields,
      // mais_empregos was already asked and confirmed. Handles leads who go quiet
      // on secondary fields (horas_extras, pagamento_fora, injustica) of older vinculos.
      if (!w._vinculos_ok && w._mais_empregos_perguntado === true && vinculosAtuais.length >= 2) {
        const todosTemMinimo = vinculosAtuais.every(
          (v: VinculoEmprego) => v.empresa && v.vinculo && v.saida,
        );
        if (todosTemMinimo) {
          w._vinculos_ok = true;
          w.vinculos = vinculosAtuais;
        }
      }

    } catch (err: any) {
      console.warn("[VinculosLoop] Erro na extração:", err?.message ?? err);
    }

    vinculos = Array.isArray(w.vinculos) ? (w.vinculos as VinculoEmprego[]) : vinculos;
    vinculosOk = w._vinculos_ok === true;
  }

  // 7c. Sync vinculos[0/1] → flat fields when _vinculos_ok is set
  if (w._vinculos_ok === true && vinculos.length > 0) {
    const flatSync = buildFlatSync(vinculos, merged);
    if (Object.keys(flatSync).length > 0) {
      Object.assign(w, flatSync);
      notas.push(`[IA] Sync vínculos→flat:\n${Object.entries(flatSync).map(([k, v]) => `${k}: ${v}`).join("\n")}`);
    }
  }

  return {
    state: {
      vinculos,
      vinculosOk,
      todosPrescritosFlag: w._vinculos_todos_prescritos === true,
    },
    mergedUpdates: computeDelta(merged, w),
    notasParaCriar: notas,
  };
}

function buildFlatSync(vinculos: VinculoEmprego[], merged: Record<string, unknown>): Record<string, unknown> {
  const s: Record<string, unknown> = {};
  const isNull = (x: unknown) => x === undefined || x === null;
  const v0 = vinculos[0], v1 = vinculos[1];
  if (v0) {
    if (!merged.empresa_recente && v0.empresa) s.empresa_recente = v0.empresa;
    if (!merged.funcao_recente && v0.funcao) s.funcao_recente = v0.funcao;
    if (!merged.vinculo_recente && v0.vinculo) s.vinculo_recente = v0.vinculo;
    if (!merged.tempo_recente && v0.tempo) s.tempo_recente = v0.tempo;
    if (!merged.saida_recente && (v0.saida ?? v0.data_saida)) s.saida_recente = v0.saida ?? v0.data_saida;
    if (!merged.frota_recente && v0.frota) s.frota_recente = v0.frota;
    if (isNull(merged.horas_extras_recentes) && !isNull(v0.horas_extras)) s.horas_extras_recentes = v0.horas_extras;
    if (isNull(merged.pagamento_fora_recente) && !isNull(v0.pagamento_fora)) s.pagamento_fora_recente = v0.pagamento_fora;
    if (isNull(merged.injustica_recente) && !isNull(v0.injustica)) s.injustica_recente = v0.injustica;
  }
  if (v1) {
    // vinculos[] is authoritative for emprego_anterior_* — always overwrite (no isNull guard)
    if (v1.empresa)  s.emprego_anterior_empresa  = v1.empresa;
    if (v1.funcao)   s.emprego_anterior_funcao   = v1.funcao;
    if (v1.vinculo)  s.emprego_anterior_vinculo  = v1.vinculo;
    if (v1.tempo)    s.emprego_anterior_tempo    = v1.tempo;
    if (v1.saida ?? v1.data_saida) s.emprego_anterior_saida = v1.saida ?? v1.data_saida;
    if (v1.empresa)  s.empresa_anterior = v1.empresa;
    if (!isNull(v1.horas_extras))   s.emprego_anterior_horas_extras   = v1.horas_extras;
    if (!isNull(v1.pagamento_fora)) s.emprego_anterior_pagamento_fora = v1.pagamento_fora;
    if (v1.injustica) s.emprego_anterior_injustica = v1.injustica;
  }
  return s;
}
