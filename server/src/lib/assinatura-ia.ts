/**
 * Análise de PDF para sugerir os signatários de um documento.
 * Extrai o texto com pdf-parse e pede ao LLM (mesma cadeia de provedores do agente)
 * que identifique nome/e-mail/CPF/telefone/papel de cada signatário.
 */

import { createRequire } from "node:module";
import { prisma } from "../db.js";
import { extractJson } from "../agent/llm.js";

const require = createRequire(import.meta.url);

const MAX_CHARS = 12_000;

export type SignatarioSugerido = {
  nome: string;
  email: string;
  cpf: string;
  telefone: string;
  papel: "SIGNER" | "WITNESS" | "APPROVER";
  orderIndex: number;
};

export type AnaliseSignatarios = {
  nomeDocumento: string;
  signatarios: SignatarioSugerido[];
};

const INSTRUCAO = `Você é um assistente jurídico especializado em documentos brasileiros.
Analise o documento e extraia:
1. O nome/título do documento
2. Todos os signatários identificados (partes, testemunhas, representantes legais)

Para cada signatário extraia, quando disponível: nome completo, e-mail, CPF, telefone e papel.

Papéis aceitos:
- SIGNER   → signatário principal (parte, sócio, acionista, representante legal)
- WITNESS  → testemunha
- APPROVER → aprovador (advogado, auditor)

Responda SOMENTE com este JSON, sem markdown e sem explicação:
{
  "nome_documento": "...",
  "signatarios": [
    { "nome": "...", "email": "", "cpf": "", "telefone": "", "papel": "SIGNER", "orderIndex": 0 }
  ]
}`;

/** Extrai texto do PDF. Retorna "" quando o PDF é só imagem (sem camada de texto). */
export async function extrairTextoPdf(buffer: Buffer): Promise<string> {
  try {
    // Importar o lib/ direto evita o modo debug do pdf-parse (que lê um PDF de teste
    // do próprio pacote quando carregado como módulo principal).
    const pdfParse = require("pdf-parse/lib/pdf-parse.js") as (b: Buffer) => Promise<{ text: string }>;
    const { text } = await pdfParse(buffer);
    return (text ?? "").slice(0, MAX_CHARS);
  } catch (e) {
    console.error("[Assinatura] Falha ao extrair texto do PDF:", e);
    return "";
  }
}

/** Projeto de IA usado para resolver a cadeia de provedores LLM. */
async function projetoIaId(): Promise<string | null> {
  const cfg = await prisma.configuracao.findUnique({ where: { chave: "assinatura_projeto_ia_id" } }).catch(() => null);
  if (cfg?.valor) return cfg.valor;
  const projeto = await prisma.iaProjeto.findFirst({
    where: { ativo: true },
    orderBy: { criadoEm: "asc" },
    select: { id: true },
  });
  return projeto?.id ?? null;
}

const PAPEIS = new Set(["SIGNER", "WITNESS", "APPROVER"]);

export async function analisarSignatarios(buffer: Buffer, nomeArquivo: string): Promise<AnaliseSignatarios> {
  const fallback: AnaliseSignatarios = {
    nomeDocumento: nomeArquivo.replace(/\.pdf$/i, ""),
    signatarios: [],
  };

  const texto = await extrairTextoPdf(buffer);
  if (!texto.trim()) {
    console.warn("[Assinatura] PDF sem camada de texto — IA não aplicável");
    return fallback;
  }

  const projetoId = await projetoIaId();
  if (!projetoId) {
    console.warn("[Assinatura] Nenhum projeto de IA ativo — pulando análise");
    return fallback;
  }

  const raw = await extractJson<{ nome_documento?: string; signatarios?: any[] }>({
    projetoId,
    instruction: INSTRUCAO,
    text: texto,
    maxTokens: 2000,
  });

  if (!raw) return fallback;

  const signatarios: SignatarioSugerido[] = (raw.signatarios ?? [])
    .filter((s) => s && typeof s.nome === "string" && s.nome.trim())
    .map((s, i) => ({
      nome: String(s.nome ?? "").trim(),
      email: String(s.email ?? "").trim(),
      cpf: String(s.cpf ?? "").trim(),
      telefone: String(s.telefone ?? "").trim(),
      papel: PAPEIS.has(s.papel) ? s.papel : "SIGNER",
      orderIndex: typeof s.orderIndex === "number" ? s.orderIndex : i,
    }));

  return {
    nomeDocumento: (raw.nome_documento ?? "").trim() || fallback.nomeDocumento,
    signatarios,
  };
}
