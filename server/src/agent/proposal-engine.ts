import { prisma } from "../db.js";
import { sendText, sendDocument } from "../services/evolution.js";
import { getEvolutionConfig, type EvolutionConfig } from "./message-handler.js";
import { getEvolutionConfigForEmitente } from "../services/evolution-empresa.js";
import { moverDealParaStage } from "./transition-engine.js";

/** Documentos gerados, esperando conferência de alguém do escritório. */
export const REVISAO_PENDENTE = "PENDENTE";
/** Revisão feita: os documentos já foram (ou estão sendo) enviados para assinatura. */
export const REVISAO_LIBERADA = "LIBERADA";
/** Coluna do CRM onde o card espera a conferência (criada no funil Carreteiros 3.0). */
export const STAGE_REVISAO = "docs_em_revisao";

/** Mensagem de espera ao cliente enquanto a revisão não sai (config: proposta_msg_revisao). */
const MSG_REVISAO_PADRAO =
  "Perfeito, {{nome}}! Recebi tudo o que precisava. 🙌\n\n" +
  "Seus documentos já estão sendo preparados e passam por uma conferência final da nossa equipe. " +
  "Assim que estiverem prontos eu te envio aqui mesmo os links para assinatura. 👍";

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
    console.log(`[Proposta] projetoId=${projetoId} | configs carregados: ${propostaConfigs.map(c => c.chave).join(", ")}`);
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

    // O último passo do fluxo de coleta reexecuta a cada mensagem enquanto o card
    // não sai do estágio. Sem este porteiro, cada "oi" do cliente durante a revisão
    // viraria uma proposta nova (o envio automático movia o card e mascarava isto).
    const jaPendente = await (prisma.proposta as any).findFirst({
      where:  { dealId, revisaoStatus: REVISAO_PENDENTE },
      select: { id: true },
    });
    if (jaPendente) {
      console.log(`[Proposta] deal ${dealId} já tem a proposta ${jaPendente.id} aguardando revisão — nada a fazer`);
      return;
    }

    const merged = {
      ...((deal.qualificacao ?? {}) as Record<string, unknown>),
      ...((deal as any).iaFlowStepData as Record<string, unknown> ?? {}),
    };
    const nomeCliente      = String(merged.nome ?? deal.contato?.nome ?? "Cliente");
    const cpfCliente       = String(merged.cpf ?? deal.contato?.cpf ?? "");
    const emailCliente     = String(merged.email ?? deal.contato?.email ?? "");
    const telefoneCliente  = String(merged.telefone ?? "").trim();
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

    // 3. Find or create Tomador (scoped to deal.empresaId — Empresa tenant, not EmpresaEmitente)
    const cpfNormalizado = cpfCliente.replace(/\D/g, "");
    const tomadorEmpresaId = (deal as any).empresaId as string | null;
    if (!tomadorEmpresaId) {
      console.warn(`[Proposta] deal ${dealId} sem empresaId — tomador não criado`);
      return;
    }
    let tomador = await (prisma.tomador as any).findFirst({
      where: { cpfCnpj: cpfNormalizado, empresaId: tomadorEmpresaId },
    });
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
      telefone:       telefoneCliente || phone || null,
      cidade:         String(merged.cidade ?? "") || null,
      ...(estadoCivilKey  ? { estadoCivil: estadoCivilKey }    : {}),
      ...(profissaoRaw    ? { profissao: profissaoRaw }         : {}),
      ...(nacionalidade   ? { nacionalidade }                   : {}),
      ...(rgCliente       ? { rg: rgCliente }                   : {}),
      ...(orgaoEmissorRg  ? { rgOrgaoEmissor: orgaoEmissorRg }  : {}),
      ...(dataNascimento && !isNaN(dataNascimento.getTime()) ? { dataNascimento } : {}),
      ...(enderecoCliente ? { endereco: enderecoCliente } : {}),
    };
    if (!tomador) {
      tomador = await prisma.tomador.create({
        data: { cpfCnpj: cpfNormalizado, empresaId: tomadorEmpresaId, ...tomadorData },
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

    // 7. Collect template IDs for contract/procuracao/atestado generation
    const templatesGerar: string[] = [];
    const contratoTemplateId   = getProp("proposta_template_contrato_id");
    const procuracaoTemplateId = getProp("proposta_template_procuracao_id");
    const atestadoTemplateId   = getProp("proposta_template_atestado_id");
    if (contratoTemplateId)   templatesGerar.push(contratoTemplateId);
    if (procuracaoTemplateId) templatesGerar.push(procuracaoTemplateId);
    if (atestadoTemplateId)   templatesGerar.push(atestadoTemplateId);

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
        dealId,
        iaProjetoId:               projetoId,
        envioTelefone:             phone,
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

    // 9c. Porteiro da revisão: com a revisão ligada (padrão), os documentos ficam
    // no módulo Propostas esperando conferência humana e NADA vai para o cliente
    // até alguém clicar em "Liberar para assinatura".
    const revisaoManual = getProp("proposta_revisao_manual") !== "false";
    if (revisaoManual) {
      await prisma.proposta.update({
        where: { id: proposta.id },
        data:  { revisaoStatus: REVISAO_PENDENTE } as any,
      });

      const primeiroNome = nomeCliente.split(" ")[0];
      const msgEspera = (getProp("proposta_msg_revisao") || MSG_REVISAO_PADRAO)
        .replace(/\{\{nome\}\}/gi, primeiroNome);
      if (msgEspera.trim()) {
        const phoneJidEspera = phone.includes("@") ? phone : `${phone}@s.whatsapp.net`;
        try {
          await sendText(evoConfig, phoneJidEspera, msgEspera);
          await prisma.crmMensagemWhatsapp.create({
            data: { dealId, contatoId: deal.contatoId, direcao: "out", personaChave: "sistema", tipo: "text", conteudo: msgEspera },
          }).catch(() => {});
        } catch (e) {
          console.error("[Proposta] Falha ao avisar o cliente sobre a revisão:", e);
        }
      }

      prisma.crmNota.create({
        data: { dealId, conteudo: `[IA] Documentos gerados — proposta ${proposta.id} AGUARDANDO REVISÃO no módulo Propostas` },
      }).catch(() => {});

      const { dispararNotificacoes } = await import("./message-handler.js");
      dispararNotificacoes(projetoId, "documentos_para_revisao", {
        dealId,
        propostaId: proposta.id,
        nome:       nomeCliente,
        telefone:   phone,
      }).catch(() => {});

      // Card para a coluna de revisão, com a persona do advogado: parado no último
      // passo da coleta, o agente responderia como coletor e voltaria a pedir
      // documento. Sem a fase cadastrada (outro tenant/funil), só troca a persona —
      // mover para um estágio sem IaFaseFunil deixaria a IA muda nesse deal.
      const faseRevisao = await prisma.iaFaseFunil.findUnique({
        where: { projetoId_chave: { projetoId, chave: STAGE_REVISAO } },
        select: { id: true },
      }).catch(() => null);
      if (faseRevisao) {
        await moverDealParaStage(dealId, STAGE_REVISAO, "advogado");
      } else {
        await prisma.crmDeal.update({ where: { id: dealId }, data: { iaPersonaChave: "advogado" } }).catch(() => {});
      }

      console.log(`[Proposta] ${proposta.id} aguardando revisão humana — nada enviado ao cliente ${phone}`);
      return;
    }

    // Revisão desligada: segue direto como antes.
    await enviarPropostaParaAssinatura(proposta.id);

  } catch (err: any) {
    console.error(`[Proposta] Erro em criarPropostaAutomatica: ${err?.message ?? err}`);
  }
}

/**
 * Envia para assinatura a proposta já gerada: converte em contrato, sobe os PDFs
 * para o PAKT e manda ao cliente (e às testemunhas) os links de assinatura.
 *
 * Separado de `criarPropostaAutomatica` para que a revisão humana possa entrar no
 * meio: o agente gera os documentos, alguém confere no módulo Propostas e só então
 * esta função roda — pelo botão "Liberar para assinatura" ou direto, quando a
 * revisão está desligada.
 */
export async function enviarPropostaParaAssinatura(
  propostaId: string,
  opts: { revisadoPor?: string } = {},
): Promise<{ enviado: boolean; paktDocs: number }> {
  const proposta = await prisma.proposta.findUnique({
    where: { id: propostaId },
    include: { emitente: true, tomador: true },
  }) as any;
  if (!proposta) throw new Error("Proposta não encontrada");

  const emitente  = proposta.emitente;
  const projetoId = (proposta.iaProjetoId as string | null) ?? null;
  const dealId    = (proposta.dealId as string | null) ?? null;
  const deal      = dealId ? await prisma.crmDeal.findUnique({ where: { id: dealId } }) : null;

  // Mesma instância que falou com o cliente; sem projeto de IA, a do escritório.
  const evoConfig = (projetoId ? await getEvolutionConfig(projetoId) : null)
    ?? await getEvolutionConfigForEmitente(emitente);

  const propostaConfigs = projetoId
    ? await prisma.iaProjetoConfig.findMany({ where: { projetoId, categoria: "proposta" } })
    : [];
  const getProp = (k: string) => propostaConfigs.find((c) => c.chave === k)?.valor ?? "";

  const nomeCliente  = String(proposta.tomador?.nome ?? "Cliente");
  const emailCliente = String(proposta.tomador?.email ?? "");
  const phone        = String(proposta.envioTelefone ?? proposta.tomador?.telefone ?? "").replace(/\D/g, "");
  const validadeAte: Date | null = proposta.validadeAte ?? null;

  let templatesGerar: string[] = [];
  if (proposta.templatesGerar) {
    try { templatesGerar = JSON.parse(proposta.templatesGerar as string) ?? []; } catch {}
  }

  // 9b. Auto-convert to contrato (no client acceptance needed)
  if (!proposta.contratoId) {
    try {
      const { autoConverterEmContrato } = await import("../routers/propostas.js");
      await autoConverterEmContrato(proposta.id);
      console.log(`[Proposta] Contrato criado automaticamente para proposta ${proposta.id}`);
    } catch (e) {
      console.error("[Proposta] Falha ao criar contrato automaticamente:", e);
    }
  }

  // 10. Upload docs to PAKT and collect sign URLs
  const paktApiKey  = process.env.PAKT_API_KEY;
  const paktBaseUrl = process.env.PAKT_BASE_URL ?? "https://pakt.capium.com.br";
  const { existsSync } = await import("node:fs");
  const { readFile }   = await import("node:fs/promises");

  type SignatarioInterno = { nome: string; email: string; whatsapp: string; papel: string; signUrl?: string };
  type PaktDoc = { titulo: string; signUrl: string; documentId: string; linksInternos?: SignatarioInterno[] };
  const paktDocs: PaktDoc[] = [];

  if (paktApiKey && templatesGerar.length > 0) {
    try {
      const docs = await (prisma as any).documentoGerado.findMany({
        where: { propostaId: proposta.id },
        orderBy: [{ tipo: "asc" }, { criadoEm: "asc" }],
      });
      const signerEmail = emailCliente || "assinar@avoce.com.br";

      // Signatários internos: "Nome|email|whatsapp" na config do projeto.
      // Só entram no CONTRATO — as testemunhas é que dão força executiva ao
      // título (art. 784, III, CPC). Procuração é ato unilateral do outorgante
      // e a declaração de hipossuficiência é do próprio declarante: nas duas,
      // só o cliente assina, e o advogado não assina a procuração que recebe.
      const parseSignatario = (bruto: string | undefined, papel: string) => {
        const [nome, email, whatsapp] = (bruto ?? "").split("|").map(v => v.trim());
        if (!nome || !email) return null;
        return { nome, email, whatsapp: whatsapp || "", papel };
      };
      const internos = [
        parseSignatario(getProp("proposta_rap_signatario"), "RAP"),
        parseSignatario(getProp("proposta_testemunha_1"), "Testemunha 1"),
        parseSignatario(getProp("proposta_testemunha_2"), "Testemunha 2"),
      ].filter((v): v is { nome: string; email: string; whatsapp: string; papel: string } => v !== null);

      // Validade vencida vira envelope nascido expirado ("Este documento expirou"):
      // depois da revisão pode ter passado tempo, então só manda prazo se for futuro.
      const expiresAt = validadeAte && validadeAte.getTime() > Date.now()
        ? validadeAte.toISOString()
        : undefined;

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
            ...(expiresAt ? { expiresAt } : {}),
            signers:   [
              { nome: nomeCliente, email: signerEmail, countryCode: "BR" },
              ...(doc.tipo === "CONTRATO"
                ? internos.map(i => ({ nome: i.nome, email: i.email, countryCode: "BR" }))
                : []),
            ],
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
              // O PAKT devolve os signatários na ordem em que foram enviados:
              // índice 0 é o cliente, os demais acompanham `internos`.
              const linksInternos = doc.tipo === "CONTRATO"
                ? internos
                    .map((i, idx) => ({ ...i, signUrl: paktDoc.signers[idx + 1]?.signUrl }))
                    .filter(i => !!i.signUrl && !!i.whatsapp)
                : [];
              paktDocs.push({ titulo: doc.titulo, signUrl, documentId: paktDoc.id, linksInternos });
            } else {
              console.error(`[Proposta] PAKT doc ${doc.id}: signUrl ausente — resposta:`, JSON.stringify(paktDoc));
            }
          } else {
            const errBody = await createRes.text().catch(() => "(sem corpo)");
            console.error(`[Proposta] PAKT rejeitou doc ${doc.id}: HTTP ${createRes.status} — ${errBody}`);
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

  // Marca a revisão como concluída antes do envio: se o WhatsApp falhar, os
  // envelopes do PAKT já existem e o reenvio é pelo menu, não por nova revisão.
  await prisma.proposta.update({
    where: { id: proposta.id },
    data: {
      revisaoStatus: REVISAO_LIBERADA,
      revisadoEm:    new Date(),
      ...(opts.revisadoPor ? { revisadoPor: opts.revisadoPor } : {}),
    } as any,
  });

  if (!evoConfig || !phone) {
    console.warn(`[Proposta] ${proposta.id}: sem WhatsApp configurado ou sem telefone — links criados, mas não enviados`);
    return { enviado: false, paktDocs: paktDocs.length };
  }

  // 11. Send WhatsApp messages with proposal text + signing links
  const textoPlano = String(proposta.textoHtml ?? "")
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
  // Normalize phone to JID format for Evolution API
  const phoneJid = phone.includes("@") ? phone : `${phone}@s.whatsapp.net`;
  let enviado = false;
  if (textoEnviar) {
    await sendText(evoConfig, phoneJid, textoEnviar);
    if (dealId) {
      await prisma.crmMensagemWhatsapp.create({
        data: { dealId, contatoId: deal?.contatoId ?? null, direcao: "out", personaChave: "sistema", tipo: "text", conteudo: textoEnviar },
      }).catch(() => {});
    }
    await new Promise(r => setTimeout(r, 1500));
    enviado = true;
  }

  if (paktDocs.length > 0) {
    const linhasAssinatura = paktDocs
      .map((d, i) => `${i + 1}. ${d.titulo}:\n${d.signUrl}`)
      .join("\n\n");
    const msgAssinatura = `Para assinar digitalmente, acesse os links abaixo:\n\n${linhasAssinatura}`;
    await sendText(evoConfig, phoneJid, msgAssinatura);
    // Sem isto, a conversa mostrava só o resumo "[Proposta automática] ... enviado
    // para assinatura" — os links de fato nunca ficavam visíveis no histórico do CRM,
    // só chegavam de verdade no WhatsApp do cliente (Evolution), fora de qualquer log.
    if (dealId) {
      await prisma.crmMensagemWhatsapp.create({
        data: { dealId, contatoId: deal?.contatoId ?? null, direcao: "out", personaChave: "sistema", tipo: "text", conteudo: msgAssinatura },
      }).catch(() => {});
    }
    enviado = true;

    // Cada signatário interno recebe SÓ o próprio link, no WhatsApp dele.
    // Fora do fluxo do cliente de propósito: são conversas distintas, e mandar
    // o link de um para outro invalidaria a prova de autoria do PAKT, que
    // amarra a assinatura ao PIX e à selfie de quem abriu aquele link.
    for (const d of paktDocs) {
      for (const i of d.linksInternos ?? []) {
        const { resolverJidReal } = await import("../services/evolution.js");
        const jidReal = i.whatsapp.includes("@") ? i.whatsapp : await resolverJidReal(evoConfig, i.whatsapp);
        if (!jidReal) {
          console.error(`[Proposta] ${i.papel} (${i.nome}): "${i.whatsapp}" não tem WhatsApp — link não enviado`);
          continue;
        }
        const jid = jidReal;
        try {
          await sendText(
            evoConfig, jid,
            `*${i.papel}* — assinatura pendente\n\n${d.titulo}\nCliente: ${nomeCliente}\n\n${i.signUrl}`,
          );
          await new Promise(r => setTimeout(r, 1200));
          console.log(`[Proposta] link de "${d.titulo}" enviado para ${i.papel} (${i.nome})`);
        } catch (e) {
          console.error(`[Proposta] falha ao enviar link para ${i.papel} (${i.nome}):`, (e as Error).message);
        }
      }
    }
  } else if (templatesGerar.length > 0) {
    if (paktApiKey) {
      console.error(`[Proposta] PAKT configurado mas nenhum link gerado para a proposta ${proposta.id} — cliente não receberá link de assinatura`);
    }
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
          await sendDocument(evoConfig, phoneJid, pdfBase64, fileName, doc.titulo);
          console.log(`[Proposta] PDF enviado via WhatsApp: ${doc.titulo}`);
          await new Promise(r => setTimeout(r, 1500));
          enviado = true;
        } catch (e) {
          console.error(`[Proposta] Falha ao enviar PDF ${doc.id}:`, e);
        }
      }
    } catch (e) {
      console.error("[Proposta] Falha ao enviar PDFs via WhatsApp:", e);
    }
  }

  if (enviado) {
    if (dealId) {
      prisma.crmMensagemWhatsapp.create({
        data: {
          dealId,
          direcao: "out",
          personaChave: "sistema",
          tipo: "text",
          conteudo: `[Proposta automática] ${proposta.id} | Contrato gerado e enviado para assinatura`,
        },
      }).catch(() => {});
    }
    console.log(`[Proposta] Proposta ${proposta.id} enviada via WhatsApp para ${phone}`);
    // Contrato enviado para assinatura → mover card para "Aguardando Assinatura".
    // Troca persona p/ advogado (evita re-disparo do fluxo coleta_docs/Nelson).
    if (dealId) await moverDealParaStage(dealId, "aguardando_assinatura", "advogado");
  } else {
    console.warn(`[Proposta] Proposta ${proposta.id} criada mas NADA enviado ao cliente ${phone}`);
  }

  return { enviado, paktDocs: paktDocs.length };
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
