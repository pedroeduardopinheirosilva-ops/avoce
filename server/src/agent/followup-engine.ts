import { prisma } from "../db.js";
import { sendText } from "../services/evolution.js";
import { getEvolutionConfig } from "./message-handler.js";

// Checks PAKT API to see if ALL documents in a proposal are signed
async function isPaktAssinado(paktDocumentId: string | null, paktApiKey: string, paktBaseUrl: string): Promise<boolean> {
  if (!paktDocumentId) return false;
  try {
    const docs = JSON.parse(paktDocumentId) as Array<{ id: string } | string>;
    for (const entry of docs) {
      const docId = typeof entry === "string" ? entry : entry.id;
      const res = await fetch(`${paktBaseUrl}/api/v1/documents/${docId}`, {
        headers: { Authorization: `Bearer ${paktApiKey}` },
      });
      if (!res.ok) continue;
      const data = await res.json() as { status?: string; signers?: Array<{ status?: string }> };
      // Check if all signers have signed
      const allSigned = data.signers?.every(s => s.status === "SIGNED" || s.status === "COMPLETED") ?? false;
      if (!allSigned) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Normaliza nome para comparar signatário do PAKT com o tomador da proposta. */
function chaveNome(nome: string): string {
  return (nome ?? "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/\s+/g, " ").trim();
}

/** E-mail genérico que o fluxo usa quando o cliente não tem e-mail — não identifica ninguém. */
const EMAIL_GENERICO = "assinar@avoce.com.br";

/**
 * Envelope refeito à mão.
 *
 * Quando alguém do escritório recria os documentos direto no PAKT (upload dos
 * .docx) em vez de reenviar pelo fluxo, a proposta continua apontando para o
 * envelope velho: o follow-up nunca vê a assinatura e cobra por dias um cliente
 * que já assinou. Aqui a proposta é reconciliada pelo signatário — procura na
 * conta PAKT documentos COMPLETED do mesmo cliente criados a partir da data da
 * proposta e que ainda não estejam no `paktDocumentId` dela.
 *
 * A conta PAKT é compartilhada com o PSA-MT, por isso o casamento exige
 * e-mail igual (ignorando o genérico do fluxo) ou nome idêntico.
 */
export async function acharEnvelopeAssinadoFora(proposta: any): Promise<Array<{ id: string; signUrl: string; titulo: string; assinadoEm: Date }>> {
  const email = (proposta.tomador?.email ?? "").trim().toLowerCase();
  const nome   = chaveNome(proposta.tomador?.nome ?? "");
  if ((!email || email === EMAIL_GENERICO) && !nome) return [];

  // Ids que a proposta já conhece — o que já está nela não é envelope novo.
  const conhecidos = new Set<string>();
  try {
    const parsed = JSON.parse(proposta.paktDocumentId ?? "[]");
    for (const e of Array.isArray(parsed) ? parsed : [parsed]) {
      const id = typeof e === "string" ? e : e?.id;
      if (id) conhecidos.add(id);
    }
  } catch { /* paktDocumentId antigo era id solto */ }

  const desde = new Date(proposta.criadoEm ?? 0).getTime();
  const { paktListarDocumentos, paktObterDocumento } = await import("../lib/pakt.js");
  const achados: Array<{ id: string; signUrl: string; titulo: string; assinadoEm: Date }> = [];

  // Lista vem por createdAt desc: para de paginar ao passar da data da proposta.
  for (let page = 1; page <= 5; page++) {
    let lote;
    try {
      lote = await paktListarDocumentos(page, 100, "COMPLETED");
    } catch (e) {
      console.error("[FollowUp] falha ao listar documentos do PAKT:", (e as Error).message);
      break;
    }
    const docs = lote?.documents ?? [];
    if (docs.length === 0) break;

    let passouDaData = false;
    for (const doc of docs) {
      const criadoEm = doc.createdAt ? new Date(doc.createdAt).getTime() : NaN;
      if (!Number.isNaN(criadoEm) && criadoEm < desde) { passouDaData = true; continue; }
      if (conhecidos.has(doc.id)) continue;

      const signer = (doc.signers ?? []).find((s: any) => {
        const e = (s.email ?? "").trim().toLowerCase();
        if (e && e !== EMAIL_GENERICO && e === email) return true;
        return !!nome && chaveNome(s.nome ?? "") === nome;
      });
      if (!signer || (signer.status ?? "").toUpperCase() !== "SIGNED") continue;

      // signUrl só vem no detalhe; a lista traz os signatários sem o token.
      let signUrl = "";
      try {
        const detalhe = await paktObterDocumento(doc.id);
        signUrl = detalhe.signers?.find((s: any) => s.id === signer.id)?.signUrl ?? "";
      } catch { /* segue sem link: o que importa é o PDF assinado */ }

      achados.push({
        id: doc.id,
        signUrl,
        titulo: doc.nome ?? "Documento",
        assinadoEm: signer.signedAt ? new Date(signer.signedAt) : new Date(),
      });
    }

    if (passouDaData || page >= (lote?.pagination?.totalPages ?? 1)) break;
  }

  return achados;
}

// Renew a PAKT document link (create new doc with same PDF)
async function renovarLinkPakt(
  doc: { id: string; titulo: string; pdfPath: string },
  nomeCliente: string,
  emailCliente: string,
  validadeAte: Date,
  paktApiKey: string,
  paktBaseUrl: string,
): Promise<{ signUrl: string; documentId: string } | null> {
  try {
    const { existsSync } = await import("node:fs");
    const { readFile } = await import("node:fs/promises");
    if (!existsSync(doc.pdfPath)) return null;
    const buf = await readFile(doc.pdfPath);
    const filename = doc.titulo.replace(/[^a-zA-Z0-9\s]/g, "").trim().replace(/\s+/g, "-") + ".pdf";
    const form = new FormData();
    form.append("file", new Blob([buf as unknown as BlobPart], { type: "application/pdf" }), filename);
    form.append("metadata", JSON.stringify({
      nome: doc.titulo,
      mensagem: "Documento para assinatura digital.",
      expiresAt: validadeAte.toISOString(),
      signers: [{ nome: nomeCliente, email: emailCliente || "assinar@avoce.com.br", countryCode: "BR" }],
    }));
    const res = await fetch(`${paktBaseUrl}/api/v1/documents`, {
      method: "POST",
      headers: { Authorization: `Bearer ${paktApiKey}` },
      body: form,
    });
    if (!res.ok) return null;
    const data = await res.json() as { id: string; signers: Array<{ signUrl: string }> };
    const signUrl = data.signers?.[0]?.signUrl;
    if (!signUrl) return null;
    return { signUrl, documentId: data.id };
  } catch {
    return null;
  }
}

// Returns the escalating follow-up message — only from DB config, no hardcoded defaults.
function getMensagemFollowUp(
  count: number,
  nomeCliente: string,
  links: Array<{ titulo: string; signUrl: string }>,
  customMsgs: Record<string, string>,
): string | null {
  const firstName = nomeCliente.split(" ")[0];
  const linhasLinks = links.map((l, i) => `${i + 1}. ${l.titulo}:\n${l.signUrl}`).join("\n\n");

  const nivel = Math.min(count, 4);
  const customKey = `follow_up_msg_${nivel + 1}`;
  if (customMsgs[customKey]) {
    return customMsgs[customKey]
      .replace(/\{\{nome\}\}/gi, firstName)
      .replace(/\{\{links\}\}/gi, linhasLinks);
  }

  return null;
}

export async function runFollowUpPakt(): Promise<void> {
  const paktApiKey  = process.env.PAKT_API_KEY;
  const paktBaseUrl = process.env.PAKT_BASE_URL ?? "https://pakt.capium.com.br";
  if (!paktApiKey) return;

  // Load all active projects
  const projetos = await (prisma as any).iaProjeto.findMany({ where: { ativo: true } });

  for (const projeto of projetos) {
    try {
      await runFollowUpProjeto(projeto.id, paktApiKey, paktBaseUrl);
    } catch (e) {
      console.error(`[FollowUp] Erro projeto ${projeto.id}:`, e);
    }
  }
}

async function runFollowUpProjeto(projetoId: string, paktApiKey: string, paktBaseUrl: string): Promise<void> {
  // Load follow-up configs
  const configs = await prisma.iaProjetoConfig.findMany({
    where: { projetoId, categoria: "follow_up" },
  });
  const getCfg = (k: string, def = "") => configs.find(c => c.chave === k)?.valor ?? def;

  if (getCfg("follow_up_ativo") !== "true") return;

  const intervaloDias  = parseInt(getCfg("follow_up_intervalo_dias", "1"), 10);
  const maxTentativas  = parseInt(getCfg("follow_up_max_tentativas", "0"), 10); // 0 = ilimitado
  const validadeMeses  = parseInt(getCfg("follow_up_validade_meses", "24"), 10);

  // Custom message overrides
  const customMsgs: Record<string, string> = {};
  for (const c of configs) {
    if (c.chave.startsWith("follow_up_msg_")) customMsgs[c.chave] = c.valor ?? "";
  }

  // Get Evolution config
  const evoConfig = await getEvolutionConfig(projetoId);
  if (!evoConfig) return;

  // Find proposals linked to deals of this project with paktSignUrl but not signed
  const propostas = await (prisma as any).proposta.findMany({
    where: {
      paktSignUrl:    { not: null },
      paktAssinadoEm: null,
      status:         "ACEITA",
    },
    include: {
      tomador:          { select: { id: true, nome: true, email: true, telefone: true } },
      documentosGerados: { select: { id: true, titulo: true, tipo: true, pdfPath: true } },
    },
  });

  // Filter to proposals whose deal belongs to this project
  // Use CrmNota to link proposta → deal → projeto
  const notasPropostas = await prisma.crmNota.findMany({
    where: {
      deal: { projetoId },
      conteudo: { startsWith: "[IA] Proposta criada automaticamente:" },
    },
    include: { deal: { select: { id: true, projetoId: true } } },
  });
  // propostaId → dealId: precisa do deal para anexar os assinados no acervo dele
  const propostaParaDeal = new Map<string, string>();
  for (const n of notasPropostas) {
    const pid = n.conteudo.split(": ")[1]?.split(" |")[0]?.trim();
    if (pid && n.deal?.id) propostaParaDeal.set(pid, n.deal.id);
  }
  const propostaIdsDoProjeto = new Set(propostaParaDeal.keys());

  const propostasFiltradas = propostas.filter((p: any) => propostaIdsDoProjeto.has(p.id));

  console.log(`[FollowUp] Projeto ${projetoId}: ${propostasFiltradas.length} proposta(s) pendente(s) de assinatura`);

  for (const proposta of propostasFiltradas) {
    try {
      const followUpCount    = (proposta.followUpCount as number) ?? 0;
      const followUpUltimoEm = (proposta.followUpUltimoEm as Date | null) ?? null;

      // Check max tentativas
      if (maxTentativas > 0 && followUpCount >= maxTentativas) continue;

      // Check interval
      if (followUpUltimoEm) {
        const diasDesde = (Date.now() - new Date(followUpUltimoEm).getTime()) / 86400_000;
        if (diasDesde < intervaloDias) continue;
      }

      // Recolhe o que já estiver assinado, mesmo com a proposta incompleta.
      // Rede de segurança: o caminho normal é o webhook, que chama o mesmo módulo.
      const { anexarAssinadosAoDeal } = await import("./assinados-deal.js");
      await anexarAssinadosAoDeal(
        proposta.paktDocumentId, propostaParaDeal.get(proposta.id), paktApiKey, paktBaseUrl,
      );

      // Check if already signed via PAKT API
      const jaAssinado = await isPaktAssinado(proposta.paktDocumentId, paktApiKey, paktBaseUrl);
      if (jaAssinado) {
        await (prisma as any).proposta.update({
          where: { id: proposta.id },
          data: { paktAssinadoEm: new Date() },
        });
        console.log(`[FollowUp] Proposta ${proposta.id} assinada — marcando e parando follow-up`);
        continue;
      }

      // Assinou, mas num envelope refeito à mão fora do fluxo: reconcilia e para de cobrar.
      const refeito = await acharEnvelopeAssinadoFora(proposta);
      if (refeito.length > 0) {
        const novoJson = JSON.stringify(refeito.map(d => ({ id: d.id, signUrl: d.signUrl, titulo: d.titulo })));
        const assinadoEm = refeito.reduce((max, d) => (d.assinadoEm > max ? d.assinadoEm : max), refeito[0].assinadoEm);
        await (prisma as any).proposta.update({
          where: { id: proposta.id },
          data: { paktDocumentId: novoJson, paktSignUrl: refeito[0].signUrl || proposta.paktSignUrl, paktAssinadoEm: assinadoEm },
        });
        await anexarAssinadosAoDeal(novoJson, propostaParaDeal.get(proposta.id), paktApiKey, paktBaseUrl);
        console.log(
          `[FollowUp] Proposta ${proposta.id} (${proposta.tomador.nome}): assinada em envelope refeito ` +
          `(${refeito.map(d => d.titulo).join(", ")}) — reconciliada e follow-up encerrado`,
        );
        continue;
      }

      // Get or renew PAKT links
      let paktDocsAtivos: Array<{ titulo: string; signUrl: string }> = [];
      const validadeAte = new Date(Date.now() + validadeMeses * 30 * 86400_000);

      if (proposta.paktDocumentId) {
        try {
          const parsed = JSON.parse(proposta.paktDocumentId) as Array<{ id: string; signUrl: string; titulo: string }>;

          for (const entry of parsed) {
            // Check if this doc link is still valid (try to access it)
            const checkRes = await fetch(`${paktBaseUrl}/api/v1/documents/${entry.id}`, {
              headers: { Authorization: `Bearer ${paktApiKey}` },
            }).catch(() => null);

            if (checkRes?.ok) {
              const docData = await checkRes.json() as { status?: string; signers?: Array<{ signUrl?: string; status?: string }> };
              const signer  = docData.signers?.[0];
              const signUrl = signer?.signUrl ?? entry.signUrl;
              paktDocsAtivos.push({ titulo: entry.titulo, signUrl });
            } else {
              // Link may be expired — try to renew
              const docGerado = proposta.documentosGerados?.find(
                (d: any) => d.tipo === (entry.titulo.includes("Procur") ? "PROCURACAO" : "CONTRATO")
              );
              if (docGerado?.pdfPath) {
                const renewed = await renovarLinkPakt(
                  { id: entry.id, titulo: entry.titulo, pdfPath: docGerado.pdfPath },
                  proposta.tomador.nome,
                  proposta.tomador.email ?? "",
                  validadeAte,
                  paktApiKey,
                  paktBaseUrl,
                );
                if (renewed) {
                  paktDocsAtivos.push({ titulo: entry.titulo, signUrl: renewed.signUrl });
                  // Update paktDocumentId with new entry
                  const updatedParsed = parsed.map(e =>
                    e.id === entry.id ? { ...e, id: renewed.documentId, signUrl: renewed.signUrl } : e
                  );
                  await (prisma as any).proposta.update({
                    where: { id: proposta.id },
                    data: { paktDocumentId: JSON.stringify(updatedParsed), paktSignUrl: updatedParsed[0].signUrl },
                  });
                }
              }
            }
          }
        } catch { /* fall through with empty links */ }
      }

      if (paktDocsAtivos.length === 0) {
        console.warn(`[FollowUp] Proposta ${proposta.id}: sem links ativos para enviar`);
        continue;
      }

      // Get phone number
      const phone = proposta.tomador.telefone?.replace(/\D/g, "") ?? "";
      if (!phone) continue;
      const phoneJid = phone.startsWith("55") ? `${phone}@s.whatsapp.net` : `55${phone}@s.whatsapp.net`;

      // Build and send message — skip if no config found for this level
      const msg = getMensagemFollowUp(followUpCount, proposta.tomador.nome, paktDocsAtivos, customMsgs);
      if (!msg) {
        console.log(`[FollowUp] Proposta ${proposta.id}: sem mensagem configurada para follow-up #${followUpCount + 1} — pulando`);
        continue;
      }
      await sendText(evoConfig, phoneJid, msg);

      // Update follow-up tracking
      await (prisma as any).proposta.update({
        where: { id: proposta.id },
        data: { followUpCount: followUpCount + 1, followUpUltimoEm: new Date() },
      });

      console.log(`[FollowUp] Proposta ${proposta.id} (${proposta.tomador.nome}): follow-up #${followUpCount + 1} enviado`);

      await new Promise(r => setTimeout(r, 2000)); // throttle between sends

    } catch (e) {
      console.error(`[FollowUp] Erro na proposta ${proposta.id}:`, e);
    }
  }
}
