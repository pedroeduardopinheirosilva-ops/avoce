/**
 * Coleta Docs Context Loader
 *
 * Before starting the coleta_docs flow, reads:
 *  1. Active/partial meeting transcriptions from SessaoReuniao (closer may add in real-time)
 *  2. Finalized transcriptions saved as DealAnexo (tipoDocumento = TRANSCRICAO)
 *  3. Documents already received (CNH, COMPROVANTE_ENDERECO, RG, CTPS …)
 *     including their dadosExtraidos for field pre-filling
 *  4. ocrTexto of ID documents without structured dadosExtraidos (extraction fallback)
 *  5. The lead's own WhatsApp text messages — data volunteered in free text before the
 *     flow started (ex: "Estado civil solteiro", "Tlf para contato 34997168365")
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
 * The LLM extraction pass is guarded by `_ctx_extract_sig` so it only re-runs when a new
 * attachment or a new inbound message actually arrived.
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
  "telefone",
  "email",
] as const;

const TIPOS_ID = new Set(["CNH", "RG", "IDENTIDADE", "CTPS"]);
const TIPOS_COMPROVANTE = new Set(["COMPROVANTE_ENDERECO", "COMPROVANTE"]);

/** Titular do comprovante que denuncia pessoa jurídica — o lead costuma mandar conta da
 *  transportadora junto com as provas do caso, e esse endereço NÃO é o dele. */
export const MARCADORES_PJ = /\b(ltda|s\.?\/?a\.?|eireli|epp|\bme\b|mei|transportes?|log[ií]stica|com[eé]rcio|ind[uú]stria|servi[cç]os|associa[cç][aã]o|cooperativa|condom[ií]nio)\b/i;

/** O extrator de documento (DocJsonResult) nomeia o órgão do RG como `orgao_emissor_rg`,
 *  mas o campo do fluxo é `orgao_emissor` — sem esta ponte o dado sai da CNH e morre aqui,
 *  e o passo continua sendo perguntado por texto mesmo com a foto já lida. */
const ALIAS_DOC_JSON: Record<string, string[]> = {
  orgao_emissor: ["orgao_emissor", "orgao_emissor_rg"],
};

/** Monta "AV DO CONTORNO 1906 CS, RESID PARQUE DAS ARVORES, NOVA PONTE - MG, CEP 38160000"
 *  a partir dos campos soltos do comprovante. O extrator devolve rua/bairro/cidade/uf/cep
 *  separados; o passo cd_endereco pede o endereço completo, então sem a composição o dado
 *  do comprovante ficaria incompleto e o fluxo perguntaria de novo. */
export function composeEndereco(d: Record<string, unknown>): string | null {
  const s = (k: string) => {
    const v = d[k];
    return typeof v === "string" && v.trim() ? v.trim() : null;
  };
  const rua = s("endereco") ?? s("logradouro");
  if (!rua) return null;
  const partes = [rua, s("bairro"), s("cidade")].filter(Boolean) as string[];
  const uf = s("uf") ?? s("estado");
  let out = partes.join(", ");
  if (uf) out += ` - ${uf}`;
  const cep = s("cep");
  if (cep) out += `, CEP ${cep}`;
  return out;
}

function normalizarNome(v: unknown): string {
  return String(v ?? "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();
}

/** Dois nomes são "da mesma pessoa" quando compartilham um token de sobrenome (≥4 letras).
 *  Tolera o OCR errando o primeiro nome ("WILL S" vs "WILIS"), que é o caso comum. */
export function mesmaPessoa(a: string, b: string): boolean {
  if (!a || !b) return false;
  const ta = new Set(normalizarNome(a).split(" ").filter((t) => t.length >= 4));
  const tb = normalizarNome(b).split(" ").filter((t) => t.length >= 4);
  return tb.some((t) => ta.has(t));
}

export async function loadColetaDocsContext(
  projetoId: string,
  dealId: string,
  merged: Record<string, unknown>,
): Promise<void> {
  const [anexos, reunioes, mensagens, contato] = await Promise.all([
    prisma.dealAnexo.findMany({ where: { dealId }, orderBy: { criadoEm: "asc" } }),
    (prisma as any).sessaoReuniao.findMany({
      where: { dealId, transcricao: { not: null } },
      orderBy: { criadaEm: "desc" },
      take: 3,
    }),
    prisma.crmMensagemWhatsapp.findMany({
      where: { dealId, direcao: "in" },
      orderBy: { enviadaEm: "desc" },
      take: 80,
      select: { conteudo: true, tipo: true, enviadaEm: true },
    }),
    prisma.crmDeal.findUnique({ where: { id: dealId }, select: { contato: true } }),
  ]);

  const updates: Record<string, unknown> = {};

  // ── Detect received documents ─────────────────────────────────────────────
  const tiposRecebidos = new Set(
    anexos.map((a) => (a.tipoDocumento ?? "OUTRO").toUpperCase()),
  );

  updates._cnh_recebida         = tiposRecebidos.has("CNH") || tiposRecebidos.has("RG") || tiposRecebidos.has("IDENTIDADE");
  updates._comprovante_recebido = tiposRecebidos.has("COMPROVANTE_ENDERECO") || tiposRecebidos.has("COMPROVANTE");

  // Projeto "Carreteiros" (RAP Advogados, emp_rap) — todo lead desse funil é motorista
  // profissional (é a própria tese do escritório), então cd_profissao não precisa perguntar.
  if (projetoId === "cmnvy47x3000wrmmamnsrhgj9" && !merged.profissao) {
    updates.profissao = "Motorista";
    updates._pf_profissao = "Motorista";
  }

  const setCampo = (campo: string, valor: unknown) => {
    if (updates[campo]) return;
    const v = typeof valor === "string" ? valor.trim() : "";
    if (!v) return;
    updates[`_pf_${campo}`] = v;
    if (!merged[campo]) updates[campo] = v;
  };

  /** Só preenche quando não há absolutamente nada — usado nos defaults do fim,
   *  para não sobrescrever com um palpite o que o cliente declarou. */
  const setCampoSeVazio = (campo: string, valor: unknown) => {
    if (updates[campo] || merged[campo]) return;
    setCampo(campo, valor);
  };

  // ── 1. Identity documents (authoritative for nome/cpf/rg/nascimento) ──────
  for (const anexo of anexos) {
    const tipo = (anexo.tipoDocumento ?? "").toUpperCase();
    if (!TIPOS_ID.has(tipo)) continue;
    const dados = (anexo.dadosExtraidos ?? {}) as Record<string, unknown>;
    for (const campo of CAMPOS_PESSOAIS) {
      const chaves = ALIAS_DOC_JSON[campo] ?? [campo];
      const val = chaves.map((k) => dados[k]).find((v) => v != null && String(v).trim()) ?? null;
      setCampo(campo, val);
    }
  }

  // ── 2. Proof of address — fills nome/endereço that the CNH OCR usually misses ──
  // Só entra o comprovante do PRÓPRIO cliente: o lead manda junto contas da transportadora
  // (prova do caso), e usar aquele endereço colocaria a empresa no contrato.
  const nomeConhecido = String(
    updates._pf_nome ?? merged.nome ?? (contato as any)?.contato?.nome ?? "",
  );
  const comprovantes = anexos
    .filter((a) => TIPOS_COMPROVANTE.has((a.tipoDocumento ?? "").toUpperCase()))
    .map((a) => ({ a, d: (a.dadosExtraidos ?? {}) as Record<string, unknown> }))
    .filter(({ d }) => !MARCADORES_PJ.test(String(d.nome ?? "")))
    .reverse(); // mais recente primeiro

  const comprovanteDoCliente =
    comprovantes.find(({ d }) => mesmaPessoa(String(d.nome ?? ""), nomeConhecido)) ??
    comprovantes[0];

  if (comprovanteDoCliente) {
    const d = comprovanteDoCliente.d;
    setCampo("endereco", composeEndereco(d));
    setCampo("nome", d.nome);
    setCampo("cpf", d.cpf);
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

  // 4. Lead's own typed messages — antes de a coleta começar o cliente já responde coisas
  // soltas ("Estado civil solteiro", "Tlf para contato 34997168365"). Sem isto o fluxo
  // repergunta o que ele acabou de escrever. Só texto: os áudios deste funil são quase
  // sempre conversas ENCAMINHADAS com a transportadora, dados de terceiros.
  const TIPOS_TEXTO = new Set(["conversation", "extendedTextMessage", "text"]);
  const linhasMsg = mensagens
    .filter((m) => TIPOS_TEXTO.has(m.tipo) && (m.conteudo ?? "").trim().length > 2)
    .reverse()
    .map((m) => (m.conteudo ?? "").trim().slice(0, 300));
  if (linhasMsg.length > 0) {
    textosParaExtrair.push(
      `[Mensagens escritas pelo próprio cliente no WhatsApp, da mais antiga para a mais recente]\n${linhasMsg.join("\n")}`,
    );
  }

  // ── LLM extraction from corpus ────────────────────────────────────────────
  // Guard: a extração só re-roda quando chegou anexo ou mensagem nova — sem isto o LLM
  // seria chamado a cada webhook, inclusive nos ACKs ("ok", "sim").
  const extractSig = `${anexos.length}:${reunioes.length}:${linhasMsg.length}`;
  const sigMudou = merged._ctx_extract_sig !== extractSig;

  if (textosParaExtrair.length > 0 && sigMudou) {
    const textoCompleto = textosParaExtrair.join("\n\n---\n\n").slice(0, 8000);
    const camposFaltando = CAMPOS_PESSOAIS.filter((c) => !merged[c] && !updates[c]);

    if (camposFaltando.length > 0) {
      const instruction = `Você tem acesso a documentos, transcrições e mensagens do cliente de um escritório de advocacia.
Extraia APENAS os campos listados abaixo, se mencionados explicitamente.
Se um campo não aparecer claramente, omita-o do JSON.

Campos a extrair: ${camposFaltando.join(", ")}

Regras:
- Extraia SOMENTE dados do PRÓPRIO CLIENTE. O bloco de mensagens contém conversas
  ENCAMINHADAS dele com a transportadora, chefes e colegas — nomes, telefones e endereços
  que aparecem nessas conversas são de TERCEIROS e devem ser IGNORADOS.
- Na dúvida sobre a quem o dado pertence, omita o campo.
- cpf: apenas dígitos (11 dígitos sem pontos/traços)
- data_nascimento: formato DD/MM/YYYY ou YYYY-MM-DD
- estado_civil: solteiro | casado | divorciado | viúvo | união estável
- endereco: endereço completo (rua, número, bairro, cidade, estado, CEP)
- orgao_emissor: apenas o órgão do RG (ex: SSP/BA)
- telefone: telefone de contato do próprio cliente, com DDD
- email: e-mail do próprio cliente

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
    updates._ctx_extract_sig = extractSig;
  }

  // ── Defaults de última instância — só depois da extração, para que um telefone
  //    ou nacionalidade que o cliente tenha declarado explicitamente sempre vença. ──

  // O próprio WhatsApp do lead já é um telefone válido para contrato e procuração.
  const whatsapp = String((contato as any)?.contato?.whatsapp ?? "").replace(/\D/g, "");
  if (whatsapp.length >= 12) {
    // 553492948372 → (34) 9294-8372
    const nac = whatsapp.replace(/^55/, "");
    setCampoSeVazio("telefone", nac.length >= 10 ? `(${nac.slice(0, 2)}) ${nac.slice(2, -4)}-${nac.slice(-4)}` : nac);
  }

  // Documento de identidade brasileiro na mão + confirmação do cliente no gate
  // cd_confirmacao tornam a pergunta de nacionalidade pura fricção.
  if (updates._cnh_recebida) setCampoSeVazio("nacionalidade", "brasileiro(a)");

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

  const preenchidos = CAMPOS_PESSOAIS.filter((c) => updates[`_pf_${c}`]);
  console.log(
    `[ColetaDocsContext] dealId=${dealId} cnh=${updates._cnh_recebida} comprovante=${updates._comprovante_recebido} pre_preenchidos=[${preenchidos.join(", ")}]`,
  );
}
