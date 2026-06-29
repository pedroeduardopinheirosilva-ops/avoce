/**
 * Gate Evaluator — avalia os IaGateSdr configurados no projeto.
 *
 * Gates suportados:
 *   nao_carreteiro   → e_carreteiro === false
 *   vinculo_invalido → e_clt === false
 *   prescricao       → vinculosTodosPrescritos (já computado pelo vinculos-processor)
 *   tempo_minimo     → tempo do vínculo mais recente < mesesMin
 *   empresa_bloqueada → tratado separadamente em assistente-agents.ts
 */

import { prisma } from "../db.js";
import type { VinculoEmprego } from "./types.js";

// ── Cache de gates por projeto (5min TTL) ────────────────────────────────────

interface GateSdr {
  tipo: string;
  campoGatilho: string | null;
  condicaoJson: Record<string, unknown> | null;
  mensagemLead: string;
  motivoChave: string;
  stageDestino: string;
  ativo: boolean;
  ordem: number;
}

const _gateCache = new Map<string, { data: GateSdr[]; expiresAt: number }>();

async function loadGates(projetoId: string): Promise<GateSdr[]> {
  const cached = _gateCache.get(projetoId);
  if (cached && Date.now() < cached.expiresAt) return cached.data;

  const rows = await prisma.iaGateSdr.findMany({
    where: { projetoId, ativo: true },
    orderBy: { ordem: "asc" },
  });

  const data: GateSdr[] = rows.map((r: any) => ({
    tipo: r.tipo,
    campoGatilho: r.campoGatilho ?? null,
    condicaoJson: r.condicaoJson as Record<string, unknown> | null,
    mensagemLead: r.mensagemLead,
    motivoChave: r.motivoChave,
    stageDestino: r.stageDestino,
    ativo: r.ativo,
    ordem: r.ordem,
  }));

  _gateCache.set(projetoId, { data, expiresAt: Date.now() + 5 * 60_000 });
  return data;
}

export function invalidateGateCache(projetoId: string): void {
  _gateCache.delete(projetoId);
}

// ── Parsing de tempo ─────────────────────────────────────────────────────────

/** Converte texto de tempo ("14 anos", "6 meses", "de 2020 até 2026") em meses. */
function parseMeses(texto: string | null | undefined): number | null {
  if (!texto) return null;
  const t = texto.toLowerCase();
  let meses = 0;
  const anos = t.match(/(\d+(?:[,.]\d+)?)\s*ano/);
  const mes  = t.match(/(\d+(?:[,.]\d+)?)\s*m[eê]s/);
  const sem  = t.match(/(\d+(?:[,.]\d+)?)\s*semana/);
  const dia  = t.match(/(\d+(?:[,.]\d+)?)\s*dia/);
  if (anos) meses += Math.round(parseFloat(anos[1].replace(",", ".")) * 12);
  if (mes)  meses += Math.floor(parseFloat(mes[1].replace(",", ".")));
  if (sem)  meses += Math.round(parseFloat(sem[1].replace(",", ".")) / 4.3);
  if (dia && !anos && !mes && !sem) meses += parseFloat(dia[1].replace(",", ".")) / 30;
  // Intervalo de anos: "de 2020 até janeiro de 2026", "2021 a 2025"
  if (!anos && !mes && !sem && !dia) {
    const yr = t.match(/\b((?:19|20)\d{2})\b[^.]{0,60}?\b((?:19|20)\d{2})\b/);
    if (yr) {
      const y1 = parseInt(yr[1]), y2 = parseInt(yr[2]);
      if (y2 > y1 && (y2 - y1) < 50) meses = (y2 - y1) * 12;
    }
  }
  return meses > 0 ? meses : null;
}

// ── Avaliação individual por tipo ─────────────────────────────────────────────

function checkGate(
  gate: GateSdr,
  merged: Record<string, unknown>,
  vinculos: VinculoEmprego[],
  vinculosTodosPrescritos: boolean,
): boolean {
  switch (gate.tipo) {

    case "nao_carreteiro": {
      // Só avalia quando e_carreteiro foi explicitamente definido como false
      if (merged.e_carreteiro !== false) return false;
      // Motorista de app (Uber/99/inDriver) é motorista profissional — não descarta por perfil
      // ainda que o LLM classifique e_carreteiro=false. Deixa o gate vinculo_invalido decidir
      // após investigar um possível CLT carreteiro anterior. (BUG-002 / A3-A4)
      if (merged._app_autonomo_recente === true) return false;
      // Lead com vínculo CLT em transportadora/função de motorista não é descartado por
      // perfil — cobre motorista de app que JÁ FOI carreteiro CLT (caso de reabertura).
      const TRANSP_RE = /motorista|carreteir|caminhon|transp|log[ií]st|frete|carga/i;
      const CLT_RE_NC = /clt|carteira/i;
      if (vinculos.some(v =>
        v.vinculo && CLT_RE_NC.test(String(v.vinculo)) &&
        TRANSP_RE.test(`${v.funcao ?? ""} ${v.empresa ?? ""}`))) return false;
      return true;
    }

    case "vinculo_invalido": {
      // Condição configurável: campo + valorDesqualifica
      const cond = gate.condicaoJson ?? {};
      const campo = (cond.campo as string) ?? gate.campoGatilho ?? "e_clt";
      const valorDesq = cond.valorDesqualifica ?? false;
      const val = merged[campo];
      // Só avalia quando o campo já foi coletado (não é undefined/null)
      if (val === undefined || val === null) return false;
      if (val !== valorDesq) return false;
      // Guard e_clt: e_clt=false é setado ao detectar o primeiro vínculo não-CLT, mas o lead
      // pode ter um anterior CLT válido ainda não investigado. Só dispara após pivot de
      // mais_empregos ter sido perguntado/negado, ou quando já existe CLT no array de vínculos.
      if (campo === "e_clt" && valorDesq === false) {
        const CLT_RE = /clt|carteira/i;
        if (vinculos.some(v => v.vinculo && CLT_RE.test(String(v.vinculo)))) return false;
        // Guard: vinculo_recente or clt_anterior extracted as CLT → don't fire yet
        if (merged.vinculo_recente && CLT_RE.test(String(merged.vinculo_recente))) return false;
        if (merged.clt_anterior && CLT_RE.test(String(merged.clt_anterior))) return false;
        const maisEmpregosInvestigado =
          merged._mais_empregos_negado === true ||
          merged._mais_empregos_perguntado === true;
        if (!maisEmpregosInvestigado) return false;
      }
      return true;
    }

    case "prescricao":
      return vinculosTodosPrescritos;

    case "tempo_minimo": {
      const mesesMin = (gate.condicaoJson?.mesesMin as number) ?? 2;
      const v0 = vinculos.find(v => v.ordem === 1) ?? vinculos[0];
      const tempoTexto = v0?.tempo ?? (merged.tempo_recente as string | null);
      const meses = parseMeses(tempoTexto);
      if (meses === null) return false; // tempo não coletado ainda
      if (meses >= mesesMin) return false; // tempo suficiente
      // Job curto: aguardar investigação do emprego anterior antes de desqualificar.
      // Se QUALQUER vínculo posterior tiver tempo adequado, não desqualificar (cobre 3+ empregos).
      const algumValido = vinculos.slice(1).some(v => {
        const m = parseMeses(v.tempo ?? null);
        return m !== null && m >= mesesMin;
      });
      if (algumValido) return false;
      // Só desqualifica após negação EXPLÍCITA do lead (via vinculos-processor).
      // Ignorar tem_emprego_anterior do LLM — pode ser falso (e.g. "último" lido como "único").
      return merged._mais_empregos_negado === true;
    }

    case "empresa_bloqueada":
      return false; // tratado em assistente-agents.ts

    default:
      return false;
  }
}

// ── API pública ───────────────────────────────────────────────────────────────

/**
 * Substitui [nome] / {nome} no template. Quando o nome não existe, remove o placeholder
 * sem deixar vírgula/espaco órfão (", nosso escritório..." → "Nosso escritório...").
 */
export function renderNomePlaceholder(template: string, nomeCliente: string | null | undefined): string {
  const nome = (nomeCliente ?? "").trim();
  if (nome) return template.replace(/[\[{]nome[\]}]/gi, nome).trim();
  let out = template
    .replace(/[\[{]nome[\]}]/gi, "")
    .replace(/\s+,/g, ",")
    .replace(/,\s*,/g, ",")
    .replace(/,\s*([!?.])/g, "$1")   // "Oi, !" → "Oi!"
    .replace(/^[\s,]+/, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (out) out = out.charAt(0).toUpperCase() + out.slice(1);
  return out;
}

export interface GateFireResult {
  mensagem: string;
  motivoChave: string;
  stageDestino: string;
  tipo: string;
}

/**
 * Avalia todos os gates ativos do projeto.
 * Retorna o primeiro gate que dispara, ou null se nenhum.
 *
 * Não avalia `empresa_bloqueada` (tratado em assistente-agents.ts).
 */
export async function evaluateGates(
  projetoId: string,
  merged: Record<string, unknown>,
  vinculos: VinculoEmprego[],
  vinculosTodosPrescritos: boolean,
  nomeCliente: string | null,
): Promise<GateFireResult | null> {
  const gates = await loadGates(projetoId);

  for (const gate of gates) {
    if (gate.tipo === "empresa_bloqueada") continue;
    if (!checkGate(gate, merged, vinculos, vinculosTodosPrescritos)) continue;

    // tempo_minimo com vínculo de empresa bloqueada no histórico: o descarte correto é o de
    // empresa_bloqueada (tratado em assistente-agents) — suprime para não mandar a mensagem errada.
    if (gate.tipo === "tempo_minimo" && vinculos.some(v => !!v.empresa)) {
      const bloqueadas = await (prisma as any).iaEmpresaBloqueada.findMany({
        where: { projetoId, ativo: true }, select: { nomeNorm: true },
      }) as Array<{ nomeNorm: string }>;
      const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
      const temBloqueada = vinculos.some(v =>
        !!v.empresa && bloqueadas.some(b => b.nomeNorm && norm(String(v.empresa)).includes(norm(b.nomeNorm))));
      if (temBloqueada) {
        console.log(`[GateEval] tempo_minimo suprimido — vínculo com empresa bloqueada (assistente-agents trata)`);
        continue;
      }
    }

    let mensagem = renderNomePlaceholder(gate.mensagemLead, nomeCliente);
    // Mensagem do tempo_minimo é redigida como pivot ("Vamos investigar outro vinculo?") —
    // como descarte final o convite não faz sentido; troca o fecho por encerramento.
    if (gate.tipo === "tempo_minimo" && /vamos investigar outro v[ií]nculo\??\s*$/i.test(mensagem)) {
      mensagem = mensagem.replace(/\s*vamos investigar outro v[ií]nculo\??\s*$/i,
        " Infelizmente, não conseguiremos te ajudar nesse caso. Agradecemos muito o contato!");
    }
    console.log(`[GateEval] projetoId=${projetoId} gate="${gate.tipo}" disparou — motivo=${gate.motivoChave}`);
    return { mensagem, motivoChave: gate.motivoChave, stageDestino: gate.stageDestino, tipo: gate.tipo };
  }

  return null;
}

/**
 * Retorna configuração completa do gate tempo_minimo: mesesMin e mensagemLead.
 * Usa o mesmo cache de 5min do evaluateGates.
 */
export async function getTempoMinimoGate(projetoId: string): Promise<{ mesesMin: number; mensagemLead: string } | null> {
  const gates = await loadGates(projetoId);
  const gate = gates.find(g => g.tipo === "tempo_minimo" && g.ativo);
  if (!gate) return null;
  return {
    mesesMin: (gate.condicaoJson?.mesesMin as number) ?? 2,
    mensagemLead: gate.mensagemLead,
  };
}

/** Atalho para quem só precisa do mesesMin. */
export async function getMesesMinimoProjeto(projetoId: string): Promise<number> {
  const gate = await getTempoMinimoGate(projetoId);
  return gate?.mesesMin ?? 2;
}
