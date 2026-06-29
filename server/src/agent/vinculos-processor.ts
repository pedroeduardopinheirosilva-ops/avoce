/**
 * Vinculos Processor — stateless vinculos-loop logic extracted from stage-engine.ts.
 * Calls LLM (tryExtractVinculo, checkVinculoPrazo) but does NOT write to DB.
 * Returns mergedUpdates patch + notasParaCriar so the caller can persist both.
 */

import { tryExtractVinculo, checkVinculoPrazo, deriveDataSaida, deriveDataSaidaFromText } from "./qualification.js";
import { syncVinculosFromFlat } from "./qualification-utils.js";
import type { VinculoEmprego, VinculosState } from "./types.js";

export interface VinculosProcessorInput {
  projetoId: string;
  merged: Record<string, unknown>;
  text: string | null;
  history: Array<{ direcao: string; conteudo?: string | null }>;
  maisEmpregosPerguntado: boolean;
  personaLlmChave?: string | null;
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
  if (!s) return 0;
  const t = s.toLowerCase();
  let meses = 0;
  const ma  = t.match(/(\d+(?:[,.]\d+)?)\s*an/i);
  const mm  = t.match(/(\d+(?:[,.]\d+)?)\s*m[eê]/i);
  const ms  = t.match(/(\d+(?:[,.]\d+)?)\s*semana/i);
  const md  = t.match(/(\d+(?:[,.]\d+)?)\s*dia/i);
  if (ma) meses += Math.round(parseFloat(ma[1].replace(",", ".")) * 12);
  if (mm) meses += Math.floor(parseFloat(mm[1].replace(",", ".")));
  if (ms && !ma && !mm) meses += Math.round(parseFloat(ms[1].replace(",", ".")) / 4.3);
  if (md && !ma && !mm && !ms) meses += parseFloat(md[1].replace(",", ".")) / 30;
  // Intervalo de anos: "de 2020 até janeiro de 2026", "2021 a 2025", "de 2019 a 2023"
  if (!ma && !mm && !ms && !md) {
    const yr = t.match(/\b((?:19|20)\d{2})\b[^.]{0,60}?\b((?:19|20)\d{2})\b/);
    if (yr) {
      const y1 = parseInt(yr[1]), y2 = parseInt(yr[2]);
      if (y2 > y1 && (y2 - y1) < 50) meses = (y2 - y1) * 12;
    }
  }
  return meses;
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
  const { projetoId, merged, text, history, maisEmpregosPerguntado, personaLlmChave = null } = input;
  const w: Record<string, unknown> = { ...merged };
  const notas: string[] = [];

  let vinculos: VinculoEmprego[] = Array.isArray(w.vinculos) ? (w.vinculos as VinculoEmprego[]) : [];
  let vinculosOk = w._vinculos_ok === true;
  const vinculosTodosPrescritos = w._vinculos_todos_prescritos === true;

  // Seed vinculos[0] from flat fields when array is empty.
  // empresa_recente is preferred but not required — seed with partial data when available
  // so the vinculos flow can advance to saida/tempo/etc. even if empresa was skipped.
  if (vinculos.length === 0 && !vinculosOk && !vinculosTodosPrescritos) {
    const empresaSeed   = (w.empresa_principal ?? w.empresa_recente) as string | undefined;
    const funcaoSeed    = (w.funcao_recente as string | undefined)     ?? undefined;
    const vinculoSeed   = (w.vinculo_recente as string | undefined)    ?? undefined;
    const saidaSeed     = (w.saida_recente as string | undefined)      ?? undefined;
    const tempoSeed     = (w.tempo_recente as string | undefined)      ?? undefined;
    const dataSaidaSeed = (w.data_saida_recente as string | undefined) ?? undefined;
    // BUG-004 FIX: require empresa for seeding — a partial entry with only vinculo/funcao
    // conflicts with the LLM extraction that creates a complete vinculos[1] for the same job.
    const hasSomeData   = !!empresaSeed;
    if (hasSomeData) {
      const seeded: VinculoEmprego = {
        ordem: 1, empresa: empresaSeed,
        funcao:      funcaoSeed,
        vinculo:     vinculoSeed,
        saida:       saidaSeed,
        tempo:       tempoSeed,
        data_saida:  dataSaidaSeed,
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
        .map(m => `${m.direcao === "out" ? "Assistente" : "Cliente"}: ${m.conteudo ?? ""}`)
        .join("\n");

      const extraido = await tryExtractVinculo(
        projetoId, text, vinculos, historiaTexto,
        w._mais_empregos_confirmado === true, maisEmpregosPerguntado,
        personaLlmChave,
      );

      const vinculosAtuais = extraido.updatedVinculos;
      if (JSON.stringify(vinculosAtuais) !== JSON.stringify(vinculos)) {
        w.vinculos = vinculosAtuais;
        notas.push(`[IA] Vínculos enriquecidos com dados da conversa: ${vinculosAtuais.map(v => v.empresa ?? "?").join(", ")}`);
      }

      if (extraido.semMaisEmpregos) {
        // If there's also a new vinculo (lead said "before X I worked at Y, that's all" in one
        // message), add the vinculo first so it's counted when deciding whether to close.
        if (extraido.vinculo) {
          if (!extraido.vinculo.data_saida) {
            const derivada = deriveDataSaida(extraido.vinculo) ?? deriveDataSaidaFromText(text);
            if (derivada) extraido.vinculo.data_saida = derivada;
          }
          const dentroPrazo = await checkVinculoPrazo(projetoId, extraido.vinculo, personaLlmChave);
          if (dentroPrazo) {
            vinculosAtuais.push({ ...extraido.vinculo, ordem: vinculosAtuais.length + 1 });
            delete w._mais_empregos_confirmado;
            notas.push(
              `[IA] Vínculo ${vinculosAtuais.length} (+ fechamento): ${extraido.vinculo.empresa ?? "?"} — ` +
              `saída: ${extraido.vinculo.saida ?? extraido.vinculo.data_saida ?? "?"}`,
            );
          }
        }

        if (maisEmpregosPerguntado) {
          // Question was explicitly asked — honor the denial and close vinculos collection.
          w._mais_empregos_negado = true;
          if (todosCompletos(vinculosAtuais)) {
            w._vinculos_ok = true;
          } else {
            // Minimum viability: lead denied more employers — close if empresa+vinculo+saida present
            const temVinculoValido = vinculosAtuais.some(v => v.empresa && v.vinculo && v.saida);
            if (temVinculoValido) w._vinculos_ok = true;
          }
        }
        // If !maisEmpregosPerguntado: LLM saw an implicit denial before the question was asked.
        // Do NOT close — the question will be asked on the next turn normally.
        w.vinculos = vinculosAtuais;

      } else if (extraido.vinculo) {
        if (!extraido.vinculo.data_saida) {
          // Campos extraídos primeiro; fallback no texto bruto do turno (o turno que cria
          // o vínculo fala dele — extração flash às vezes descarta o ano).
          const derivada = deriveDataSaida(extraido.vinculo) ?? deriveDataSaidaFromText(text);
          if (derivada) extraido.vinculo.data_saida = derivada;
        }
        const dentroPrazo = await checkVinculoPrazo(projetoId, extraido.vinculo, personaLlmChave);
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
        // Honor confirmation even if vinculos[0] is incomplete — "melhor qualificação parcial que nada"
        const temEmpresa = vinculosAtuais.length > 0 && !!vinculosAtuais[0]?.empresa;
        if (maisEmpregosPerguntado || todosCompletos(vinculosAtuais) || temEmpresa) {
          w._mais_empregos_confirmado = true;
        }
        w.vinculos = vinculosAtuais;

      } else {
        // Enrichment only — retroactive prescricao check on v0 if data_saida arrived
        const v0 = vinculosAtuais[0];
        if (v0 && !v0.data_saida) {
          const derivada = deriveDataSaida(v0);
          if (derivada) v0.data_saida = derivada;
        }
        if (v0?.data_saida && !w._vinculos_todos_prescritos) {
          const dentroPrazaEnriq = await checkVinculoPrazo(projetoId, v0, personaLlmChave);
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

      // Auto-close: 2+ complete vinculos only.
      // Single-vínculo close when lead denies more jobs is handled above by the
      // semMaisEmpregos branch (sets _vinculos_ok directly). Do NOT auto-close here
      // with 1 vínculo just because the question was asked (old maisEmpregosPerguntado
      // condition) — that fired before the lead answered and caused the parecer to omit
      // the second employer.
      if (!w._vinculos_ok && todosCompletos(vinculosAtuais) && vinculosAtuais.length >= 2) {
        // RECONHECIMENTO DE VÍNCULO: "informal"/"sem registro"/"PJ forçado" (pejotização) NÃO
        // descartam — motorista subordinado sem carteira tem vínculo reconhecível. Só é não-CLT
        // quem tem autonomia real: dono do caminhão (autônomo/agregado/TAC), cooperado, avulso, app.
        const NON_CLT_CLOSE = /autônomo|autonomo|avulso|cooperado|agregado|\btac\b/i;
        // Só fechar se há pelo menos 1 vínculo CLT com tempo suficiente (mín. 2 meses)
        const algumCltValido = vinculosAtuais.some(v =>
          v.vinculo != null &&
          !NON_CLT_CLOSE.test(String(v.vinculo)) &&
          parseMesesTempo(String(v.tempo ?? "")) >= 2
        );
        const maisEmpregosNegado = w._mais_empregos_negado === true || w.tem_emprego_anterior === false;
        if (algumCltValido || maisEmpregosNegado) {
          w._vinculos_ok = true;
          w.vinculos = vinculosAtuais;
        }
        // Se não tem vínculo válido E mais_empregos não foi negado: NÃO fechar.
      }


      // Auto-close when mais_empregos question was asked 2× without answer (added to _q_skipped).
      // "Melhor qualificação incompleta que nada" — don't block the flow waiting indefinitely.
      const qSkippedArr = (merged._q_skipped as string[] | undefined) ?? [];
      if (!w._vinculos_ok && qSkippedArr.some(c => c.startsWith("mais_empregos"))) {
        const temMinimo = vinculosAtuais.some((v: VinculoEmprego) => v.empresa && (v.vinculo || v.saida));
        if (temMinimo) {
          w._mais_empregos_negado = true;
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

  // 7b-extra: Sync e_clt from vinculos → merged so gates disparam sem esperar extractQualificacaoData.
  // Regra: só marca e_clt=false quando há AUTONOMIA REAL e nenhum vínculo reconhecível.
  // RECONHECIMENTO DE VÍNCULO: "informal"/"sem registro"/"PJ forçado" (pejotização) NÃO contam
  // como não-CLT — motorista subordinado sem carteira qualifica (a invalidade é só app/dono do
  // caminhão/cooperado/avulso). Só seta e_clt se ainda não foi definido.
  if (!w._vinculos_ok && vinculos.length > 0 && (w.e_clt === undefined || w.e_clt === null)) {
    const NON_CLT_RE = /autônomo|autonomo|avulso|cooperado|agregado|\btac\b|transportador\s+autonomo/i;
    const CLT_RE     = /clt|carteira/i;
    const algumClt     = vinculos.some(v => v.vinculo && CLT_RE.test(String(v.vinculo)));
    const algumNaoClt  = vinculos.some(v => v.vinculo && NON_CLT_RE.test(String(v.vinculo)));
    if (algumNaoClt && !algumClt) { w.e_clt = false; }
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
