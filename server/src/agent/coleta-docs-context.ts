/**
 * Coleta Docs Context Loader
 *
 * Before starting the coleta_docs flow, reads:
 *  1. Active/partial meeting transcriptions from SessaoReuniao (closer may add in real-time)
 *  2. Finalized transcriptions saved as DealAnexo (tipoDocumento = TRANSCRICAO)
 *  3. Documents already received (CNH, COMPROVANTE_ENDERECO, RG, CTPS …)
 *     including their dadosExtraidos for field pre-filling
 *  4. ocrTexto of ID documents without structured dadosExtraidos (extraction fallback)
 *
 * Extracts field values from transcripts via LLM, pre-fills qualificacao so the
 * flow-controller's pre-skip mechanism skips already-known steps.
 *
 * Sets internal flags:
 *  _cnh_recebida            = true when CNH or RG doc is in DealAnexo
 *  _comprovante_recebido    = true when COMPROVANTE_ENDERECO is in DealAnexo
 *  _pf_<campo>              = field value extracted from docs/transcriptions (enables NUNCA_PULAR bypass)
 *
 * No idempotency guard — runs on every message so new documents are always reflected.
 */

import { prisma } from "../db.js";
import { extractJson } from "./llm.js";
import { atualizarMergedFlags } from "./deal-repository.js";

const CAMPOS_PESSOAIS = [
  "nome",
  "cpf",
  "rg",
  "orgao_emissor",
  "data_nascimento",
  "endereco",
  "estado_civil",
  "profissao",
  "nacionalidade",
] as const;

const TIPOS_ID = new Set(["CNH", "RG", "IDENTIDADE", "CTPS"]);

export async function loadColetaDocsContext(
  projetoId: string,
  dealId: string,
  merged: Record<string, unknown>,
): Promise<void> {
  const [anexos, reunioes] = await Promise.all([
    prisma.dealAnexo.findMany({ where: { dealId }, orderBy: { criadoEm: "asc" } }),
    (prisma as any).sessaoReuniao.findMany({
      where: { dealId, transcricao: { not: null } },
      orderBy: { criadaEm: "desc" },
      take: 3,
    }),
  ]);

  const updates: Record<string, unknown> = {};

  // ── Detect received documents ─────────────────────────────────────────────
  const tiposRecebidos = new Set(
    anexos.map((a) => (a.tipoDocumento ?? "OUTRO").toUpperCase()),
  );

  updates._cnh_recebida         = tiposRecebidos.has("CNH") || tiposRecebidos.has("RG") || tiposRecebidos.has("IDENTIDADE");
  updates._comprovante_recebido = tiposRecebidos.has("COMPROVANTE_ENDERECO") || tiposRecebidos.has("COMPROVANTE");

  // ── Fields already stored in dadosExtraidos of ID docs ────────────────────
  for (const anexo of anexos) {
    const tipo = (anexo.tipoDocumento ?? "").toUpperCase();
    if (!TIPOS_ID.has(tipo)) continue;
    const dados = (anexo.dadosExtraidos ?? {}) as Record<string, unknown>;
    for (const campo of CAMPOS_PESSOAIS) {
      if (updates[campo]) continue;  // already set by a previous OCR attachment in this run
      const val = dados[campo] ?? null;
      if (val && String(val).trim()) {
        // Always set _pf_ from authoritative OCR source (bypasses NUNCA_PULAR in flow-controller).
        // Also set the value itself if not already present in merged (from qualificacao).
        updates[`_pf_${campo}`] = String(val).trim();
        if (!merged[campo]) updates[campo] = String(val).trim();
      }
    }
  }

  // ── Build corpus for LLM extraction ──────────────────────────────────────
  const textosParaExtrair: string[] = [];

  // 1. Active/partial meeting transcriptions
  for (const r of reunioes) {
    const t = (r.transcricao as string | null)?.trim();
    if (t) textosParaExtrair.push(`[Reunião "${r.titulo}" — ${r.status}]\n${t}`);
  }

  // 2. Finalized transcriptions saved as DealAnexo
  for (const a of anexos) {
    if (a.tipoDocumento === "TRANSCRICAO" && a.ocrTexto?.trim()) {
      textosParaExtrair.push(`[Transcrição salva]\n${a.ocrTexto}`);
    }
  }

  // 3. ocrTexto of ID documents without structured dadosExtraidos (extraction failed or OCR-only)
  for (const a of anexos) {
    const tipo = (a.tipoDocumento ?? "").toUpperCase();
    if (!TIPOS_ID.has(tipo)) continue;
    if (a.dadosExtraidos && Object.keys(a.dadosExtraidos as object).length > 0) continue;
    if (!a.ocrTexto?.trim()) continue;
    textosParaExtrair.push(`[Documento ${tipo} — texto OCR]\n${a.ocrTexto}`);
  }

  // ── LLM extraction from corpus ────────────────────────────────────────────
  if (textosParaExtrair.length > 0) {
    const textoCompleto = textosParaExtrair.join("\n\n---\n\n").slice(0, 8000);
    const camposFaltando = CAMPOS_PESSOAIS.filter((c) => !merged[c] && !updates[c]);

    if (camposFaltando.length > 0) {
      const instruction = `Você tem acesso a documentos e/ou transcrições de reunião com o cliente.
Extraia APENAS os campos listados abaixo, se mencionados explicitamente.
Se um campo não aparecer claramente, omita-o do JSON.

Campos a extrair: ${camposFaltando.join(", ")}

Regras:
- cpf: apenas dígitos (11 dígitos sem pontos/traços)
- data_nascimento: formato DD/MM/YYYY ou YYYY-MM-DD
- estado_civil: solteiro | casado | divorciado | viúvo | união estável
- endereco: endereço completo (rua, número, bairro, cidade, estado, CEP)
- orgao_emissor: apenas o órgão do RG (ex: SSP/BA)

Retorne: { "campo": "valor" }`;

      try {
        const extracted = await extractJson<Record<string, string>>({
          projetoId,
          instruction,
          text: textoCompleto,
          maxTokens: 512,
        });
        if (extracted) {
          for (const campo of camposFaltando) {
            const val = extracted[campo];
            const invalid = ["não informado", "n/a", "n.a", "desconhecido", "não mencionado"];
            if (val && String(val).trim() && !invalid.includes(String(val).toLowerCase().trim())) {
              updates[campo] = String(val).trim();
              updates[`_pf_${campo}`] = String(val).trim();
            }
          }
        }
      } catch (e: any) {
        console.warn("[ColetaDocsContext] LLM extraction failed:", e.message);
      }
    }
  }

  // ── Persist only when there are real updates ──────────────────────────────
  const realUpdates = Object.entries(updates).filter(
    ([k]) => !["_cnh_recebida", "_comprovante_recebido"].includes(k) && updates[k] !== merged[k],
  );
  const flagUpdates = {
    _cnh_recebida: updates._cnh_recebida,
    _comprovante_recebido: updates._comprovante_recebido,
    ...Object.fromEntries(realUpdates),
  };

  Object.assign(merged, updates);
  await atualizarMergedFlags(dealId, merged, flagUpdates);

  const preenchidos = CAMPOS_PESSOAIS.filter((c) => updates[c]);
  console.log(
    `[ColetaDocsContext] dealId=${dealId} cnh=${updates._cnh_recebida} comprovante=${updates._comprovante_recebido} pre_preenchidos=[${preenchidos.join(", ")}]`,
  );
}
