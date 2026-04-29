import { prisma } from "../db.js";
import { sendText, sendDocument } from "../services/evolution.js";
import { getEvolutionConfig, type EvolutionConfig } from "./message-handler.js";

export async function criarPropostaAutomatica(
  projetoId: string,
  dealId: string,
  phone: string,
  momento: string,
): Promise<void> {
  try {
    const evoConfig = await getEvolutionConfig(projetoId);
    if (!evoConfig) return;

    // 1. Load proposta configs
    const propostaConfigs = await prisma.iaProjetoConfig.findMany({
      where: { projetoId, categoria: "proposta" },
    });
    const getProp = (k: string) => propostaConfigs.find((c) => c.chave === k)?.valor ?? "";

    if (getProp("proposta_ativo") !== "true") return;
    if (getProp("proposta_momento") !== momento) return;

    const emitenteId = getProp("proposta_emitente_id");
    if (!emitenteId) {
      console.warn("[Proposta] proposta_emitente_id não configurado — proposta não gerada");
      return;
    }

    // 2. Load deal + contato
    const deal = await prisma.crmDeal.findUnique({
      where: { id: dealId },
      include: { contato: true },
    });
    if (!deal) return;

    const merged = {
      ...((deal.qualificacao ?? {}) as Record<string, unknown>),
      ...((deal as any).iaFlowStepData as Record<string, unknown> ?? {}),
    };
    const nomeCliente      = String(merged.nome ?? deal.contato?.nome ?? "Cliente");
    const cpfCliente       = String(merged.cpf ?? deal.contato?.cpf ?? "");
    const emailCliente     = String(merged.email ?? deal.contato?.email ?? "");
    const rgCliente        = String(merged.rg ?? "");
    const orgaoEmissorOrgao = String(merged.orgao_emissor_rg ?? "").trim();
    const orgaoEmissorUF   = String(merged.uf_emissor_rg ?? "").trim();
    const orgaoEmissorRg   = [orgaoEmissorOrgao, orgaoEmissorUF].filter(Boolean).join("/");
    const dataNascimento   = merged.data_nascimento ? new Date(String(merged.data_nascimento).split("/").reverse().join("-")) : null;

    if (!cpfCliente) {
      console.warn(`[Proposta] CPF não disponível para deal ${dealId} — proposta não gerada`);
      return;
    }

    const enderecoCliente     = String(merged.endereco ?? "").trim();
    const estadoCivilCliente  = String(merged.estado_civil ?? "").trim();
    const camposFaltando: string[] = [];
    if (!enderecoCliente)    camposFaltando.push("comprovante de endereço");
    if (!estadoCivilCliente) camposFaltando.push("estado civil");
    if (camposFaltando.length > 0) {
      console.warn(`[Proposta] Qualificação incompleta para deal ${dealId} — faltam: ${camposFaltando.join(", ")} — proposta não gerada`);
      return;
    }

    // 3. Find or create Tomador
    let tomador = await prisma.tomador.findUnique({ where: { cpfCnpj: cpfCliente.replace(/\D/g, "") } });
    const normalizeEc = (s: string) => s.toLowerCase().trim().normalize("NFD").replace(/[̀-ͯ]/g, "");
    const ecMap: Record<string, string> = {
      solteiro: "solteiro", solteira: "solteiro", "solteiro(a)": "solteiro",
      casado: "casada", casada: "casada", "casado(a)": "casada",
      divorciado: "divorciado", divorciada: "divorciado", "divorciado(a)": "divorciado",
      separado: "divorciado", separada: "divorciado",
      viuvo: "viuvo", viuva: "viuvo", "viuvo(a)": "viuvo",
      "uniao estavel": "uniao_estavel", "uniao_estavel": "uniao_estavel",
      "em uniao estavel": "uniao_estavel",
    };
    const estadoCivilRaw = normalizeEc(String(merged.estado_civil ?? ""));
    const estadoCivilKey = ecMap[estadoCivilRaw] ?? (estadoCivilRaw || null);
    const profissaoRaw   = String(merged.profissao ?? "").trim() || null;
    const nacionalidade  = String(merged.nacionalidade ?? "brasileiro(a)").trim() || "brasileiro(a)";

    const tomadorData = {
      nome:           nomeCliente,
      email:          emailCliente || null,
      telefone:       phone || null,
      cidade:         String(merged.cidade ?? "") || null,
      ...(estadoCivilKey  ? { estadoCivil: estadoCivilKey }    : {}),
      ...(profissaoRaw    ? { profissao: profissaoRaw }         : {}),
      ...(nacionalidade   ? { nacionalidade }                   : {}),
      ...(rgCliente       ? { rg: rgCliente }                   : {}),
      ...(orgaoEmissorRg  ? { rgOrgaoEmissor: orgaoEmissorRg }  : {}),
      ...(dataNascimento && !isNaN(dataNascimento.getTime()) ? { dataNascimento } : {}),
    };
    if (!tomador) {
      tomador = await prisma.tomador.create({
        data: { cpfCnpj: cpfCliente.replace(/\D/g, ""), ...tomadorData },
      });
      console.log(`[Proposta] Tomador criado: ${tomador.id} (${nomeCliente})`);
    } else {
      await prisma.tomador.update({
        where: { id: tomador.id },
        data:  tomadorData as any,
      });
    }

    // 4. Load body template HTML
    const corpoTemplateId = getProp("proposta_template_corpo_id");
    let textoHtml = "";
    if (corpoTemplateId) {
      const tmpl = await (prisma as any).templateDocumento.findUnique({ where: { id: corpoTemplateId } });
      textoHtml = tmpl?.textoHtml ?? "";
    }
    if (!textoHtml) {
      const { TEMPLATES_PROPOSTA } = await import("../routers/propostas.js");
      textoHtml = TEMPLATES_PROPOSTA[0].html;
    }

    // 5. Load emitente for variable substitution
    const emitente = await prisma.empresaEmitente.findUnique({ where: { id: emitenteId } });
    if (!emitente) {
      console.warn(`[Proposta] Emitente ${emitenteId} não encontrado`);
      return;
    }

    // 6. Substitute variables in template
    const hoje = new Date();
    const validadeDias = parseInt(getProp("proposta_validade_dias") || "30", 10);
    const validadeAte = new Date(hoje.getTime() + validadeDias * 24 * 60 * 60 * 1000);
    const honorariosPerc = getProp("proposta_honorarios_perc") || "30";
    const descricaoServico = getProp("proposta_descricao_servico") || "Ação trabalhista";

    const valorEstimado = deal.valorEstimado ? Number(deal.valorEstimado) : null;
    const valorStr = valorEstimado
      ? (valorEstimado / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })
      : "a definir";

    const fmtData = (d: Date) => d.toLocaleDateString("pt-BR");
    const localidade = [emitente.cidade, emitente.uf].filter(Boolean).join("/");

    textoHtml = textoHtml
      .replace(/\{\{emitente\}\}/gi,   emitente.nomeFantasia || emitente.nome)
      .replace(/\{\{tomador\}\}/gi,    nomeCliente)
      .replace(/\{\{cnpj\}\}/gi,       emitente.cnpj)
      .replace(/\{\{cidade\}\}/gi,     localidade)
      .replace(/\{\{endereco\}\}/gi,   emitente.endereco || "")
      .replace(/\{\{servico\}\}/gi,    descricaoServico)
      .replace(/\{\{valor\}\}/gi,      valorStr)
      .replace(/\{\{diaVencimento\}\}/gi,      getProp("proposta_dia_vencimento") || "5")
      .replace(/\{\{validadeAte\}\}/gi,         fmtData(validadeAte))
      .replace(/\{\{dataAtual\}\}/gi,           fmtData(hoje))
      .replace(/\{\{honorariosExito\}\}/gi,     `${honorariosPerc}%`)
      .replace(/\{\{honorariosExitoPerc\}\}/gi, honorariosPerc);

    // 7. Collect template IDs for contract/procuracao generation
    const templatesGerar: string[] = [];
    const contratoTemplateId  = getProp("proposta_template_contrato_id");
    const procuracaoTemplateId = getProp("proposta_template_procuracao_id");
    if (contratoTemplateId)   templatesGerar.push(contratoTemplateId);
    if (procuracaoTemplateId) templatesGerar.push(procuracaoTemplateId);

    // 8. Create Proposta record
    const titulo = `Proposta — ${nomeCliente}`;
    const proposta = await prisma.proposta.create({
      data: {
        emitenteId,
        tomadorId:     tomador.id,
        titulo,
        textoHtml,
        valorEstimado: valorEstimado ? Math.round(valorEstimado) : null,
        validadeAte,
        status:        "ACEITA",
        contratoDiaVencimento:     parseInt(getProp("proposta_dia_vencimento") || "5", 10),
        contratoMetodoCobr:        (getProp("proposta_metodo_cobr") as any) || "PIX_BOLETO",
        contratoTipoContrato:      (getProp("proposta_tipo_contrato") as any) || "RECORRENTE",
        contratoEmitirNfseAuto:    false,
        contratoGerarCobrancaAuto: true,
        contratoIssRetido:         false,
        contratoDescricao:         descricaoServico,
        templatesGerar:            templatesGerar.length > 0 ? JSON.stringify(templatesGerar) : null,
      } as any,
    });
    console.log(`[Proposta] Proposta criada: ${proposta.id} para deal ${dealId}`);

    prisma.crmNota.create({
      data: { dealId, conteudo: `[IA] Proposta criada automaticamente: ${proposta.id} | ${titulo}` },
    }).catch(() => {});

    // 9. Generate documents (contrato + procuração)
    if (templatesGerar.length > 0) {
      try {
        const { gerarDocumentosProposta } = await import("../routers/templateDocumentos.js");
        await gerarDocumentosProposta(proposta.id);
        console.log(`[Proposta] Documentos gerados para proposta ${proposta.id}`);
      } catch (e) {
        console.error("[Proposta] Falha ao gerar documentos:", e);
      }
    }

    // 9b. Auto-convert to contrato (no client acceptance needed)
    try {
      const { autoConverterEmContrato } = await import("../routers/propostas.js");
      await autoConverterEmContrato(proposta.id);
      console.log(`[Proposta] Contrato criado automaticamente para proposta ${proposta.id}`);
    } catch (e) {
      console.error("[Proposta] Falha ao criar contrato automaticamente:", e);
    }

    // 10. Upload docs to PAKT and collect sign URLs
    const baseUrl     = process.env.APP_BASE_URL ?? "https://avoce.capium.com.br";
    const paktApiKey  = process.env.PAKT_API_KEY;
    const paktBaseUrl = process.env.PAKT_BASE_URL ?? "https://pakt.capium.com.br";
    const { existsSync } = await import("node:fs");
    const { readFile }   = await import("node:fs/promises");

    type PaktDoc = { titulo: string; signUrl: string; documentId: string };
    const paktDocs: PaktDoc[] = [];

    if (paktApiKey && templatesGerar.length > 0) {
      try {
        const docs = await (prisma as any).documentoGerado.findMany({
          where: { propostaId: proposta.id },
          orderBy: [{ tipo: "asc" }, { criadoEm: "asc" }],
        });
        const signerEmail = emailCliente || "assinar@avoce.com.br";

        for (const doc of docs) {
          if (!doc.pdfPath || !existsSync(doc.pdfPath)) continue;
          try {
            const pdfBuf = await readFile(doc.pdfPath);
            const filename = `${doc.titulo.replace(/[^a-zA-Z0-9\s]/g, "").trim().replace(/\s+/g, "-")}.pdf`;
            const form = new FormData();
            form.append("file", new Blob([pdfBuf as unknown as BlobPart], { type: "application/pdf" }), filename);
            form.append("metadata", JSON.stringify({
              nome:      doc.titulo,
              mensagem:  `Documento de ${emitente.nomeFantasia || emitente.nome} para assinatura.`,
              expiresAt: validadeAte.toISOString(),
              signers:   [{ nome: nomeCliente, email: signerEmail, countryCode: "BR" }],
            }));

            const createRes = await fetch(`${paktBaseUrl}/api/v1/documents`, {
              method: "POST",
              headers: { Authorization: `Bearer ${paktApiKey}` },
              body: form,
            });
            if (createRes.ok) {
              const paktDoc = await createRes.json() as { id: string; signers: Array<{ signUrl: string }> };
              const signUrl = paktDoc.signers[0]?.signUrl;
              if (signUrl) {
                paktDocs.push({ titulo: doc.titulo, signUrl, documentId: paktDoc.id });
              }
            }
          } catch (e) {
            console.error(`[Proposta] PAKT falhou para doc ${doc.id}:`, e);
          }
        }

        if (paktDocs.length > 0) {
          await prisma.proposta.update({
            where: { id: proposta.id },
            data: {
              paktSignUrl:    paktDocs[0].signUrl,
              paktDocumentId: JSON.stringify(paktDocs.map(d => ({ id: d.documentId, signUrl: d.signUrl, titulo: d.titulo }))),
            } as any,
          });
        }
      } catch (e) {
        console.error("[Proposta] Falha no PAKT:", e);
      }
    }

    // 11. Send WhatsApp messages with proposal text + signing links
    const textoPlano = textoHtml
      .replace(/<h[1-6][^>]*>/gi, "\n*")
      .replace(/<\/h[1-6]>/gi, "*\n")
      .replace(/<p[^>]*>/gi, "\n")
      .replace(/<\/p>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<strong[^>]*>(.*?)<\/strong>/gi, "*$1*")
      .replace(/<b[^>]*>(.*?)<\/b>/gi, "*$1*")
      .replace(/<em[^>]*>(.*?)<\/em>/gi, "_$1_")
      .replace(/<li[^>]*>/gi, "\n• ")
      .replace(/<\/li>/gi, "")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    const textoEnviar = textoPlano.length > 3000 ? textoPlano.slice(0, 2997) + "..." : textoPlano;
    if (textoEnviar) {
      await sendText(evoConfig, phone, textoEnviar);
      await new Promise(r => setTimeout(r, 1500));
    }

    if (paktDocs.length > 0) {
      const linhasAssinatura = paktDocs
        .map((d, i) => `${i + 1}. ${d.titulo}:\n${d.signUrl}`)
        .join("\n\n");
      const msgAssinatura = `Para assinar digitalmente, acesse os links abaixo:\n\n${linhasAssinatura}`;
      await sendText(evoConfig, phone, msgAssinatura);
    } else if (templatesGerar.length > 0) {
      try {
        const docs = await (prisma as any).documentoGerado.findMany({
          where: { propostaId: proposta.id },
          orderBy: [{ tipo: "asc" }, { criadoEm: "asc" }],
        });
        for (const doc of docs) {
          if (!doc.pdfPath || !existsSync(doc.pdfPath)) continue;
          try {
            const pdfBuf = await readFile(doc.pdfPath);
            const pdfBase64 = pdfBuf.toString("base64");
            const fileName  = `${doc.titulo.replace(/[^a-zA-Z0-9\s]/g, "").trim().replace(/\s+/g, "-")}.pdf`;
            await sendDocument(evoConfig, phone, pdfBase64, fileName, doc.titulo);
            console.log(`[Proposta] PDF enviado via WhatsApp: ${doc.titulo}`);
            await new Promise(r => setTimeout(r, 1500));
          } catch (e) {
            console.error(`[Proposta] Falha ao enviar PDF ${doc.id}:`, e);
          }
        }
      } catch (e) {
        console.error("[Proposta] Falha ao enviar PDFs via WhatsApp:", e);
      }
    }

    // Log outgoing message
    prisma.crmMensagemWhatsapp.create({
      data: {
        dealId,
        direcao: "out",
        personaChave: "sistema",
        tipo: "text",
        conteudo: `[Proposta automática] ${proposta.id} | Contrato gerado e enviado para assinatura`,
      },
    }).catch(() => {});

    console.log(`[Proposta] Proposta ${proposta.id} enviada via WhatsApp para ${phone}`);
  } catch (err: any) {
    console.error(`[Proposta] Erro em criarPropostaAutomatica: ${err?.message ?? err}`);
  }
}

const PEDIDO_LINK_REGEX = /link|contrato|assinar|assinatura|procura|cad[eê]|reenv|chegou|n[aã]o recebi|manda.*de novo|onde (est[aá]|ficou)/i;

export async function resendPropostaLinks(
  dealId: string, projetoId: string, evoConfig: EvolutionConfig, phone: string,
): Promise<void> {
  const notaProposta = await prisma.crmNota.findFirst({
    where: { dealId, conteudo: { startsWith: "[IA] Proposta criada automaticamente:" } },
    orderBy: { criadoEm: "desc" },
  });
  if (!notaProposta) return;
  const propostaId = notaProposta.conteudo.split(": ")[1]?.split(" |")[0]?.trim();
  if (!propostaId) return;
  const proposta = await prisma.proposta.findUnique({ where: { id: propostaId } });
  if (!proposta?.paktSignUrl) return;

  const linksEnvio: Array<{ titulo: string; signUrl: string }> = [];
  if (proposta.paktDocumentId) {
    try {
      const parsed = JSON.parse(proposta.paktDocumentId as string);
      if (Array.isArray(parsed) && typeof parsed[0] === "object" && parsed[0]?.signUrl) {
        linksEnvio.push(...(parsed as Array<{ titulo: string; signUrl: string }>));
      }
    } catch {}
  }
  if (linksEnvio.length === 0) linksEnvio.push({ titulo: "Documentos para assinar", signUrl: proposta.paktSignUrl as string });

  const msgLinks = linksEnvio.length > 1
    ? `Para assinar digitalmente, acesse os links abaixo:\n\n${linksEnvio.map((d, i) => `${i + 1}. ${d.titulo}:\n${d.signUrl}`).join("\n\n")}`
    : `Aqui está o link para assinar:\n\n${linksEnvio[0].signUrl}`;
  console.log(`[Proposta] Reenviando ${linksEnvio.length} link(s) para deal ${dealId}`);
  await sendText(evoConfig, phone, msgLinks);
  prisma.crmMensagemWhatsapp.create({ data: { dealId, direcao: "out", personaChave: "sistema", tipo: "text", conteudo: msgLinks } }).catch(() => {});
}

export { PEDIDO_LINK_REGEX };
