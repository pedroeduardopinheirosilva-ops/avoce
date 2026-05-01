/**
 * Qualification utilities — pure functions, zero I/O.
 * No LLM calls, no DB access, no network.
 */

import type { VinculoEmprego } from "./types.js";

export type SyncResult = { vinculos: VinculoEmprego[]; changed: boolean };

// ── BR number parser ──────────────────────────────────────────────────────────
// Handles "2.000", "1.500,50", "R$ 3.200", 2000 (already number), null → 0

export function parseBrNumber(val: unknown): number {
  if (typeof val === "number") return val;
  if (!val) return 0;
  // Strip currency prefix, thousand-dots, convert decimal comma
  const cleaned = String(val)
    .replace(/[^\d,.-]/g, "")   // keep only digits, comma, dot, minus
    .replace(/\.(?=\d{3}(?:[,]|$))/g, "") // remove thousand-separator dots
    .replace(",", ".");          // convert decimal comma to dot
  return Number(cleaned) || 0;
}

// ── CPF validation ────────────────────────────────────────────────────────────

export function validarCPF(cpf: string): boolean {
  const d = cpf.replace(/\D/g, "");
  if (d.length !== 11 || /^(\d)\1+$/.test(d)) return false;
  const calc = (n: number) => {
    let s = 0;
    for (let i = 0; i < n; i++) s += parseInt(d[i]) * (n + 1 - i);
    const r = (s * 10) % 11;
    return r >= 10 ? 0 : r;
  };
  return calc(9) === parseInt(d[9]) && calc(10) === parseInt(d[10]);
}

// ── Minimum data check for cause value calculation ────────────────────────────

export function temDadosMinimosCalculo(merged: Record<string, unknown>): boolean {
  const vinculos = Array.isArray(merged.vinculos) ? merged.vinculos as any[] : [];
  if (vinculos.length > 0) {
    return vinculos.some(v =>
      v.empresa &&
      (v.salario_total_declarado || v.salario_holerite || v.salario_por_fora)
    );
  }
  const temEmpresa = !!(merged.empresa_recente || merged.empresa_principal);
  const temSalario = !!(merged.salario_total_declarado || merged.salario_holerite);
  return temEmpresa && temSalario;
}

// ── Flat-field → vinculos sync ────────────────────────────────────────────────

/**
 * Propagates flat merged fields into the vinculos array to avoid re-asking
 * questions that were already answered via extractQualificacaoData.
 * Never overwrites existing non-null values in vinculos entries.
 */
export function syncVinculosFromFlat(
  vinculos: VinculoEmprego[],
  merged: Record<string, unknown>,
): SyncResult {
  if (vinculos.length === 0) return { vinculos, changed: false };

  const str = (v: unknown) =>
    v !== undefined && v !== null && v !== "" ? String(v) : undefined;

  let changed = false;
  const updated = vinculos.map((v, i) => {
    const patch: Partial<VinculoEmprego> = {};

    if (i === 0) {
      if (!v.empresa)    patch.empresa    = str(merged.empresa_principal ?? merged.empresa_recente);
      if (!v.funcao)     patch.funcao     = str(merged.funcao_recente);
      if (!v.vinculo)    patch.vinculo    = str(merged.vinculo_recente)
                                         ?? (merged.e_clt === true ? "carteira assinada" : undefined);
      if (!v.saida)      patch.saida      = str(merged.saida_recente);
      if (!v.tempo)      patch.tempo      = str(merged.tempo_recente);
      if (!v.data_saida) patch.data_saida = str(merged.data_saida_recente);
      if (!v.frota)      patch.frota      = str(merged.frota_recente ?? merged.frota);
    } else if (i === 1) {
      const flatEmpresa = str(merged.emprego_anterior_empresa ?? merged.empresa_anterior);
      const normalize = (s: string) =>
        s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, "");
      const empresaMatch = flatEmpresa && v.empresa &&
        (normalize(flatEmpresa).includes(normalize(v.empresa)) ||
         normalize(v.empresa).includes(normalize(flatEmpresa)));

      if (empresaMatch) {
        if (!v.funcao)  patch.funcao  = str(merged.emprego_anterior_funcao  ?? merged.funcao_anterior);
        if (!v.vinculo) patch.vinculo = str(merged.emprego_anterior_vinculo ?? merged.clt_anterior);
        if (!v.saida)   patch.saida   = str(merged.emprego_anterior_saida   ?? merged.saida_anterior);
        if (!v.tempo)   patch.tempo   = str(merged.emprego_anterior_tempo   ?? merged.tempo_anterior);
        if (!v.frota)   patch.frota   = str(merged.frota_anterior);
      }
    }

    const effective = Object.fromEntries(
      Object.entries(patch).filter(([, val]) => val !== undefined),
    ) as Partial<VinculoEmprego>;

    if (Object.keys(effective).length === 0) return v;
    changed = true;
    return { ...v, ...effective };
  });

  return { vinculos: updated, changed };
}
