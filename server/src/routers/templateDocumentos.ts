import { z }                from "zod";
import { router, authProc } from "./trpc.js";
import { prisma }           from "../db.js";
import { htmlToPdf }        from "../lib/pdf.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, unlinkSync } from "node:fs";
import { writeFile }        from "node:fs/promises";
import { resolve, join, basename } from "node:path";
import { execSync }         from "node:child_process";
import { tmpdir }           from "node:os";
import { logoPathToBase64, propostaHtmlPage } from "./propostas.js";
import PizZip               from "pizzip";

// ── Variáveis disponíveis nos templates ───────────────────────────────────────
// {{emitente}}         - nome fantasia/razão social do escritório
// {{cnpj}}             - CNPJ do emitente (com máscara)
// {{tomador}}          - nome do cliente
// {{cpfCnpj}}          - CPF/CNPJ do tomador (com máscara)
// {{enderecoTomador}}  - endereço completo do tomador
// {{emailTomador}}     - e-mail do tomador
// {{telefoneTomador}}  - telefone do tomador
// {{valor}}            - valor do contrato formatado em R$
// {{diaVencimento}}    - dia de vencimento
// {{metodoPagamento}}  - método de pagamento
// {{dataAtual}}        - data atual formatada
// {{cidade}}           - cidade do emitente
// {{endereco}}         - endereço completo do emitente

export const TIPOS_TEMPLATE = ["PROPOSTA", "CONTRATO", "PROCURACAO", "OUTRO"] as const;

// ── HTML wrapper para documentos gerados ─────────────────────────────────────

function fmtCnpjDoc(v: string): string {
  const d = v.replace(/\D/g, "");
  if (d.length === 14) return `${d.slice(0,2)}.${d.slice(2,5)}.${d.slice(5,8)}/${d.slice(8,12)}-${d.slice(12)}`;
  if (d.length === 11) return `${d.slice(0,3)}.${d.slice(3,6)}.${d.slice(6,9)}-${d.slice(9)}`;
  return v;
}

function fmtValorDoc(c: number): string {
  return (c / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

export function buildVars(
  emitente: {
    nome: string; nomeFantasia?: string | null; cnpj: string;
    cidade?: string | null; uf?: string | null;
    endereco?: string | null; numero?: string | null;
    complemento?: string | null; bairro?: string | null; cep?: string | null;
    telefone?: string | null; email?: string | null;
  },
  tomador: {
    nome: string; cpfCnpj: string;
    email?: string | null; telefone?: string | null;
    endereco?: string | null; numero?: string | null;
    complemento?: string | null; bairro?: string | null;
    cidade?: string | null; uf?: string | null; cep?: string | null;
  },
  contrato?: {
    valorEstimado?: number | null;
    contratoDiaVencimento?: number | null;
    contratoMetodoCobr?: string | null;
    honorariosExitoPerc?: number | null;
  } | null,
): Record<string, string> {
  const emitenteNome = emitente.nomeFantasia || emitente.nome;
  const localidade   = [emitente.cidade, emitente.uf].filter(Boolean).join("/");
  const endEmitente  = [
    emitente.endereco && emitente.numero ? `${emitente.endereco}, ${emitente.numero}` : emitente.endereco,
    emitente.complemento, emitente.bairro, localidade,
    emitente.cep ? `CEP ${emitente.cep.replace(/(\d{5})(\d{3})/, "$1-$2")}` : null,
  ].filter(Boolean).join(", ");

  const endTomador = [
    tomador.endereco && tomador.numero ? `${tomador.endereco}, ${tomador.numero}` : tomador.endereco,
    tomador.complemento, tomador.bairro,
    [tomador.cidade, tomador.uf].filter(Boolean).join("/"),
    tomador.cep ? `CEP ${tomador.cep.replace(/(\d{5})(\d{3})/, "$1-$2")}` : null,
  ].filter(Boolean).join(", ");

  const metodosLabel: Record<string, string> = {
    PIX_BOLETO: "PIX ou Boleto",
    PIX:        "PIX",
    BOLETO:     "Boleto Bancário",
    NENHUM:     "a combinar",
    ALVARA:     "Transferência por Alvará Judicial",
  };

  const isPf = tomador.cpfCnpj.replace(/\D/g, "").length <= 11;

  const ecLabel: Record<string, string> = {
    solteiro: "solteiro(a)", casada: "casado(a)",
    divorciado: "divorciado(a)", viuvo: "viúvo(a)", uniao_estavel: "em união estável",
  };
  const rcLabel: Record<string, string> = {
    comunhao_universal:    "comunhão universal de bens",
    comunhao_parcial:      "comunhão parcial de bens",
    separacao_bens:        "separação total de bens",
    part_final_aquestos:   "participação final nos aquestos",
  };

  const estadoCivilTxt = ecLabel[(tomador as any).estadoCivil ?? ""] ?? "";
  const regimeCasamentoTxt = rcLabel[(tomador as any).regimeCasamento ?? ""] ?? "";
  const estadoCivilComRegime = regimeCasamentoTxt && ["casada", "uniao_estavel"].includes((tomador as any).estadoCivil ?? "")
    ? `${estadoCivilTxt} sob o regime de ${regimeCasamentoTxt}`
    : estadoCivilTxt;

  // Qualificação PF completa
  const qualificacaoPF = isPf ? [
    (tomador as any).profissao,
    (tomador as any).nacionalidade ?? "brasileiro(a)",
    estadoCivilComRegime,
    (tomador as any).dataNascimento
      ? `nascido(a) em ${new Date((tomador as any).dataNascimento).toLocaleDateString("pt-BR")}`
      : (tomador as any).naturalidade ? `natural de ${(tomador as any).naturalidade}` : "",
    (tomador as any).rg
      ? `portador(a) do RG nº ${(tomador as any).rg}${(tomador as any).rgOrgaoEmissor ? " " + (tomador as any).rgOrgaoEmissor : ""}`
      : "",
    `CPF nº ${fmtCnpjDoc(tomador.cpfCnpj)}`,
    `residente e domiciliado(a) em ${endTomador}`,
  ].filter(Boolean).join(", ") : "";

  // Qualificação PJ completa
  const tipoSoc    = (tomador as any).tipoSocietario ?? "";
  const qualificacaoPJ = !isPf ? [
    tipoSoc ? `${tomador.nome}${tipoSoc ? `, ${tipoSoc}` : ""}` : tomador.nome,
    `inscrita no CNPJ sob o nº ${fmtCnpjDoc(tomador.cpfCnpj)}`,
    (tomador as any).dataConstituicao
      ? `constituída em ${new Date((tomador as any).dataConstituicao).toLocaleDateString("pt-BR")}`
      : "",
    (tomador as any).capitalSocial
      ? `com capital social de ${fmtValorDoc((tomador as any).capitalSocial)}`
      : "",
    `com sede em ${endTomador}`,
  ].filter(Boolean).join(", ") : "";

  // Qualificação do representante legal / administrador principal
  const admin = (tomador as any).administradores?.[0];
  const adminEstadoCivil = ecLabel[admin?.estadoCivil ?? ""] ?? "";
  const adminRegimeCasamento = rcLabel[admin?.regimeCasamento ?? ""] ?? "";
  const adminEstadoCivilComRegime = adminRegimeCasamento && ["casada", "uniao_estavel"].includes(admin?.estadoCivil ?? "")
    ? `${adminEstadoCivil} sob o regime de ${adminRegimeCasamento}`
    : adminEstadoCivil;

  const qualificacaoAdmin = admin ? [
    admin.profissao,
    admin.nacionalidade ?? "brasileiro(a)",
    adminEstadoCivilComRegime,
    admin.dataNascimento
      ? `nascido(a) em ${new Date(admin.dataNascimento).toLocaleDateString("pt-BR")}`
      : admin.naturalidade ? `natural de ${admin.naturalidade}` : "",
    admin.rg ? `portador(a) do RG nº ${admin.rg}${admin.rgOrgaoEmissor ? " " + admin.rgOrgaoEmissor : ""}` : "",
    admin.cpf ? `CPF nº ${fmtCnpjDoc(admin.cpf)}` : "",
    admin.endereco ? `residente e domiciliado(a) em ${[
      admin.endereco && admin.numero ? `${admin.endereco}, ${admin.numero}` : admin.endereco,
      admin.complemento, admin.bairro,
      [admin.cidade, admin.uf].filter(Boolean).join("/"),
      admin.cep ? `CEP ${admin.cep.replace(/(\d{5})(\d{3})/, "$1-$2")}` : null,
    ].filter(Boolean).join(", ")}` : "",
  ].filter(Boolean).join(", ") : "";

  const endAdmin = admin ? [
    admin.endereco && admin.numero ? `${admin.endereco}, ${admin.numero}` : admin.endereco,
    admin.complemento, admin.bairro,
    [admin.cidade, admin.uf].filter(Boolean).join("/"),
    admin.cep ? `CEP ${admin.cep.replace(/(\d{5})(\d{3})/, "$1-$2")}` : null,
  ].filter(Boolean).join(", ") : "";

  return {
    emitente:          emitenteNome,
    cnpj:              fmtCnpjDoc(emitente.cnpj),
    tomador:           tomador.nome,
    cpfCnpj:           fmtCnpjDoc(tomador.cpfCnpj),
    enderecoTomador:   endTomador,
    emailTomador:      tomador.email ?? "",
    telefoneTomador:   tomador.telefone ?? "",
    valor:             contrato?.valorEstimado ? fmtValorDoc(contrato.valorEstimado) : "",
    diaVencimento:     contrato?.contratoDiaVencimento ? String(contrato.contratoDiaVencimento) : "",
    metodoPagamento:   metodosLabel[contrato?.contratoMetodoCobr ?? ""] ?? "",
    honorariosExitoPerc: contrato?.honorariosExitoPerc != null ? String(contrato.honorariosExitoPerc) : "",
    honorariosExito:     contrato?.honorariosExitoPerc != null ? `${contrato.honorariosExitoPerc}%` : "",
    dataAtual:         new Date().toLocaleDateString("pt-BR"),
    cidade:            localidade,
    endereco:          endEmitente,
    // Qualificação PF
    qualificacaoPF,
    rgTomador:         (tomador as any).rg ?? "",
    orgaoEmissorRg:    (tomador as any).rgOrgaoEmissor ?? "",
    estadoCivilTomador: estadoCivilComRegime,
    profissaoTomador:  (tomador as any).profissao ?? "",
    nacionalidadeTomador: (tomador as any).nacionalidade ?? "",
    naturalidadeTomador:  (tomador as any).naturalidade ?? "",
    regimeCasamento:   regimeCasamentoTxt,
    // Qualificação PJ
    qualificacaoPJ,
    tipoSocietario:    (tomador as any).tipoSocietario ?? "",
    objetoSocial:      (tomador as any).objetoSocial ?? "",
    capitalSocial:     (tomador as any).capitalSocial ? fmtValorDoc((tomador as any).capitalSocial) : "",
    // Representante legal / administrador
    administrador:              admin?.nome ?? "",
    cpfAdministrador:           admin?.cpf ? fmtCnpjDoc(admin.cpf) : "",
    cargoAdministrador:         admin?.cargo ?? "Administrador",
    qualificacaoAdministrador:  qualificacaoAdmin,
    enderecoAdministrador:      endAdmin,
    // Todos os admins listados
    administradores: (tomador as any).administradores?.length
      ? (tomador as any).administradores.map((a: any) => `${a.nome} (${a.cargo ?? "Administrador"}${a.cpf ? ", CPF " + fmtCnpjDoc(a.cpf) : ""})`).join("; ")
      : "",
  };
}

export function renderTemplateDoc(html: string, vars: Record<string, string>): string {
  return Object.entries(vars).reduce(
    (acc, [k, v]) => acc.replace(new RegExp(`\\{\\{${k}\\}\\}`, "gi"), v),
    html,
  );
}

// Gera DOCX montando o conteúdo HTML no corpo do timbrado (cabeçalho/rodapé preservados automaticamente)
// Não requer marcadores no timbrado — o cabeçalho e rodapé são detectados pelo próprio formato DOCX.
export async function generateFromDocxTemplate(
  timbradoDocxPath: string,
  titulo: string,
  textoHtml: string,
  vars: Record<string, string>,
  outputDocxPath: string,
  outputPdfPath: string,
): Promise<void> {
  const htmlFinal = renderTemplateDoc(textoHtml, vars);

  // Pasta temporária exclusiva para esta geração (evita conflito de instâncias LibreOffice)
  const uid = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const loHome = join(tmpdir(), `lo-${uid}`);
  mkdirSync(loHome, { recursive: true });

  const htmlFile  = join(loHome, `content.html`);
  const loDocxOut = join(loHome, `content.docx`);

  // 1. HTML completo → LibreOffice converte para DOCX (preserva bold, tabelas, etc.)
  const fullHtml = `<!DOCTYPE html><html lang="pt-BR">
<head><meta charset="UTF-8">
<style>
body{font-family:Arial,sans-serif;font-size:11pt;margin:0}
h1,h2,h3{font-family:Arial,sans-serif;margin:10pt 0 4pt}
p{margin:0 0 8pt;line-height:1.5}
table{width:100%;border-collapse:collapse}
td,th{padding:3pt 6pt;border:1px solid #ccc}
hr{border:none;border-top:1px solid #999;margin:10pt 0}
</style>
</head>
<body>${htmlFinal}</body></html>`;

  writeFileSync(htmlFile, fullHtml, "utf8");

  execSync(
    `libreoffice --headless --norestore --convert-to docx --outdir "${loHome}" "${htmlFile}"`,
    { timeout: 30000, env: { ...process.env, HOME: loHome } },
  );

  if (!existsSync(loDocxOut)) {
    throw new Error(`[DocxTemplate] LibreOffice não gerou ${loDocxOut}`);
  }

  // 2. Extrair corpo OOXML do DOCX gerado (sem o <w:sectPr> — ele ficará do timbrado)
  const contentZip = new PizZip(readFileSync(loDocxOut, "binary"));
  const contentDocXml: string = contentZip.file("word/document.xml")!.asText();

  // Pegar tudo que está dentro de <w:body> exceto o último <w:sectPr>
  const bodyInnerMatch = contentDocXml.match(/<w:body>([\s\S]*)<\/w:body>/);
  let bodyInner = bodyInnerMatch ? bodyInnerMatch[1] : "";
  // Remove qualquer <w:sectPr> que o LibreOffice possa ter inserido
  bodyInner = bodyInner.replace(/<w:sectPr\b[\s\S]*?<\/w:sectPr>/g, "").trim();

  // 3. Abrir o timbrado como ZIP — extrair sectPr e o wrapper do documento
  const timbradoZip = new PizZip(readFileSync(timbradoDocxPath, "binary"));
  const timbradoDocXml: string = timbradoZip.file("word/document.xml")!.asText();

  // sectPr do timbrado: contém referências aos arquivos de header/footer, margens, tamanho de página
  const sectPrMatch = timbradoDocXml.match(/<w:sectPr(?:\s[^>]*)?>[\s\S]*?<\/w:sectPr>|<w:sectPr(?:\s[^>]*)?\/>/);
  const sectPr = sectPrMatch ? sectPrMatch[0] : "";

  // Abertura do documento (namespaces XML) vinda do timbrado
  const docOpenMatch = timbradoDocXml.match(/([\s\S]*?)<w:body>/);
  const docOpen = docOpenMatch ? docOpenMatch[1] : "";

  // 4. Montar novo document.xml: namespaces do timbrado + corpo do conteúdo + sectPr do timbrado
  const newDocXml = `${docOpen}<w:body>${bodyInner}${sectPr ? "\n" + sectPr : ""}\n</w:body>\n</w:document>`;

  // 5. Substituir document.xml no ZIP do timbrado (header/footer/styles/rels intactos)
  timbradoZip.file("word/document.xml", newDocXml);
  const outputBuf = timbradoZip.generate({ type: "nodebuffer", compression: "DEFLATE" });
  writeFileSync(outputDocxPath, outputBuf);

  // 6. Converter DOCX final para PDF
  const outDir = join(outputDocxPath, "..");
  execSync(
    `libreoffice --headless --norestore --convert-to pdf --outdir "${outDir}" "${outputDocxPath}"`,
    { timeout: 60000, env: { ...process.env, HOME: loHome } },
  );

  const pdfName = basename(outputDocxPath).replace(/\.docx$/i, ".pdf");
  const generatedPdf = join(outDir, pdfName);
  if (existsSync(generatedPdf) && generatedPdf !== outputPdfPath) {
    copyFileSync(generatedPdf, outputPdfPath);
    unlinkSync(generatedPdf);
  }

  // 7. Limpar pasta temporária
  try {
    for (const f of [htmlFile, loDocxOut]) try { unlinkSync(f); } catch {}
    import("node:fs").then(fs => { try { fs.rmdirSync(loHome); } catch {} });
  } catch {}
}

export function documentoHtmlPage(
  titulo: string,
  textoHtml: string,
  emitente: Parameters<typeof propostaHtmlPage>[2] & { timbradoPath?: string | null },
  cabecalhoPath?: string | null,
): string {
  // Prioridade: timbrado do template > timbrado da empresa > fallback padrão
  const timbrado = (cabecalhoPath && existsSync(cabecalhoPath))
    ? cabecalhoPath
    : ((emitente as any).timbradoPath && existsSync((emitente as any).timbradoPath))
      ? (emitente as any).timbradoPath
      : null;

  if (timbrado) {
    const buf  = readFileSync(timbrado);
    const ext  = timbrado.split(".").pop()?.toLowerCase() ?? "jpg";
    const mime = ext === "png" ? "image/png" : "image/jpeg";
    const b64  = `data:${mime};base64,${buf.toString("base64")}`;
    return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <title>${titulo}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: Arial, Helvetica, sans-serif; font-size: 11pt; color: #1a1a1a; background: #f4f6f9; }
    .page { max-width: 750px; margin: 30px auto; background: #fff; border-radius: 10px; box-shadow: 0 2px 12px rgba(0,0,0,.08); overflow: hidden; }
    .timbrado { width: 100%; display: block; }
    .body { padding: 28px 32px; }
    .body h2 { font-size: 13pt; color: #1a1a1a; margin: 18px 0 8px; text-align: center; }
    .body h3 { font-size: 11pt; color: #1a1a1a; margin: 14px 0 5px; }
    .body p  { margin-bottom: 9px; line-height: 1.65; }
    .body ul, .body ol { margin: 6px 0 10px 20px; line-height: 1.7; }
    .footer { border-top: 1px solid #eee; padding: 12px 32px; font-size: 8pt; color: #999; text-align: center; }
    @media print { .page { box-shadow: none; margin: 0; border-radius: 0; } }
  </style>
</head>
<body>
<div class="page">
  <img src="${b64}" alt="Timbrado" class="timbrado">
  <div class="body">${textoHtml}</div>
  <div class="footer">${titulo} · Documento gerado pelo sistema Avoce</div>
</div>
</body>
</html>`;
  }
  return propostaHtmlPage(titulo, textoHtml, emitente, null, null);
}

// ── Gerar e salvar PDFs dos documentos de uma proposta ───────────────────────

export async function gerarDocumentosProposta(propostaId: string): Promise<void> {
  const proposta = await prisma.proposta.findUnique({
    where: { id: propostaId },
    include: {
      emitente: true,
      tomador:  true,
    },
  }) as any;

  // Carregar administradores separadamente (evita erro de tipo Prisma)
  if (proposta?.tomador) {
    proposta.tomador.administradores = await (prisma as any).administrador.findMany({
      where: { tomadorId: proposta.tomador.id },
      orderBy: { criadoEm: "asc" },
    });
  }

  if (!proposta) { console.warn(`[Doc] Proposta ${propostaId} não encontrada`); return; }

  console.log(`[Doc] Iniciando gerarDocumentosProposta para ${propostaId} | emitenteId=${proposta.emitenteId}`);

  // Determinar quais templates gerar (filtrar por IDs selecionados na proposta, se houver)
  let templateIds: string[] | null = null;
  if ((proposta as any).templatesGerar) {
    try { templateIds = JSON.parse((proposta as any).templatesGerar); } catch { console.warn("[Doc] JSON templatesGerar inválido:", (proposta as any).templatesGerar); }
  }
  console.log(`[Doc] templatesGerar=${JSON.stringify(templateIds)}`);

  const whereTemplates: any = { emitenteId: proposta.emitenteId, ativo: true, tipo: { not: "PROPOSTA" } };
  if (templateIds && templateIds.length > 0) {
    whereTemplates.id = { in: templateIds };
  }
  console.log(`[Doc] whereTemplates=${JSON.stringify(whereTemplates)}`);

  const templates = await (prisma as any).templateDocumento.findMany({ where: whereTemplates });
  console.log(`[Doc] ${templates.length} template(s) encontrado(s): ${templates.map((t: any) => t.tipo + "/" + t.id).join(", ")}`);

  if (templates.length === 0) { console.warn("[Doc] Nenhum template encontrado, saindo"); return; }

  const pdfDir = resolve("./uploads/documentos-gerados");
  mkdirSync(pdfDir, { recursive: true });

  const vars = buildVars(proposta.emitente, proposta.tomador, proposta);

  for (const template of templates) {
    console.log(`[Doc] Processando template ${template.id} (${template.tipo}: "${template.titulo}")`);
    try {
      // Verificar se já foi gerado para esta proposta
      const existing = await (prisma as any).documentoGerado.findFirst({
        where: { propostaId, templateId: template.id },
      });
      if (existing) {
        console.log(`[Doc] Já existe DocumentoGerado para template ${template.id}, pulando`);
        continue;
      }

      // Determinar timbrado efetivo (template > empresa)
      const timbradoEfetivo = (template.cabecalhoPath && existsSync(template.cabecalhoPath))
        ? template.cabecalhoPath
        : ((proposta.emitente as any).timbradoPath && existsSync((proposta.emitente as any).timbradoPath))
          ? (proposta.emitente as any).timbradoPath
          : null;

      const isDocxTimbrado = timbradoEfetivo?.toLowerCase().endsWith(".docx");
      const pdfPath  = join(pdfDir, `${propostaId}-${template.id}.pdf`);
      const docxPath = isDocxTimbrado ? join(pdfDir, `${propostaId}-${template.id}.docx`) : null;

      if (isDocxTimbrado) {
        console.log(`[Doc] Timbrado DOCX detectado, usando generateFromDocxTemplate...`);
        await generateFromDocxTemplate(
          timbradoEfetivo!,
          template.titulo,
          template.textoHtml,
          vars,
          docxPath!,
          pdfPath,
        );
        console.log(`[Doc] DOCX+PDF gerados: ${docxPath} / ${pdfPath}`);
      } else {
        const htmlFinal = renderTemplateDoc(template.textoHtml, vars);
        const pageHtml  = documentoHtmlPage(template.titulo, htmlFinal, {
          ...proposta.emitente,
          logoSrc: logoPathToBase64(proposta.emitente.logoPath),
        }, timbradoEfetivo);

        console.log(`[Doc] Chamando htmlToPdf para ${template.tipo}...`);
        const pdfBuffer = await htmlToPdf(pageHtml);
        console.log(`[Doc] htmlToPdf retornou ${pdfBuffer?.length ?? 0} bytes`);
        await writeFile(pdfPath, pdfBuffer);
      }

      await (prisma as any).documentoGerado.create({
        data: {
          propostaId,
          templateId: template.id,
          tipo:       template.tipo,
          titulo:     template.titulo,
          pdfPath,
          ...(docxPath ? { docxPath } : {}),
        },
      });

      console.log(`[Doc] Gerado ${template.tipo} "${template.titulo}" para proposta ${propostaId}`);
    } catch (e) {
      console.error(`[Doc] Erro ao gerar template ${template.id}:`, e);
    }
  }
  console.log(`[Doc] gerarDocumentosProposta concluído para ${propostaId}`);
}

// ── Router ────────────────────────────────────────────────────────────────────

export const templateDocumentoRouter = router({

  listar: authProc
    .input(z.object({ emitenteId: z.string().optional(), tipo: z.string().optional() }))
    .query(async ({ input }) => {
      return (prisma as any).templateDocumento.findMany({
        where: {
          ...(input.emitenteId ? { emitenteId: input.emitenteId } : {}),
          ...(input.tipo       ? { tipo: input.tipo }              : {}),
        },
        orderBy: [{ tipo: "asc" }, { titulo: "asc" }],
        include: { emitente: { select: { id: true, nome: true, nomeFantasia: true } } },
      });
    }),

  criar: authProc
    .input(z.object({
      emitenteId: z.string(),
      tipo:       z.enum(TIPOS_TEMPLATE),
      titulo:     z.string().min(3),
      textoHtml:  z.string().min(10),
    }))
    .mutation(async ({ input }) => {
      return (prisma as any).templateDocumento.create({ data: input });
    }),

  atualizar: authProc
    .input(z.object({
      id:        z.string(),
      titulo:    z.string().min(3).optional(),
      textoHtml: z.string().min(10).optional(),
      tipo:      z.enum(TIPOS_TEMPLATE).optional(),
      ativo:     z.boolean().optional(),
    }))
    .mutation(async ({ input }) => {
      const { id, ...data } = input;
      return (prisma as any).templateDocumento.update({ where: { id }, data });
    }),

  excluir: authProc
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      return (prisma as any).templateDocumento.delete({ where: { id: input.id } });
    }),

  // Buscar documentos gerados para uma proposta
  listarDocumentosProposta: authProc
    .input(z.object({ propostaId: z.string() }))
    .query(async ({ input }) => {
      return (prisma as any).documentoGerado.findMany({
        where: { propostaId: input.propostaId },
        orderBy: { criadoEm: "asc" },
      });
    }),

  // Regenerar documentos de uma proposta (reprocessar templates)
  gerarDocumentos: authProc
    .input(z.object({ propostaId: z.string() }))
    .mutation(async ({ input }) => {
      // Remover documentos gerados anteriores
      await (prisma as any).documentoGerado.deleteMany({
        where: { propostaId: input.propostaId },
      });
      await gerarDocumentosProposta(input.propostaId);
      return (prisma as any).documentoGerado.findMany({
        where: { propostaId: input.propostaId },
        orderBy: { criadoEm: "asc" },
      });
    }),

  // Template padrão de contrato de prestação de serviços
  templatePadraoContrato: authProc.query(() => ({
    tipo: "CONTRATO" as const,
    titulo: "Contrato de Prestação de Serviços Advocatícios",
    textoHtml: `<h2 style="text-align:center">CONTRATO DE PRESTAÇÃO DE SERVIÇOS ADVOCATÍCIOS</h2>

<p>Pelo presente instrumento particular, as partes abaixo qualificadas celebram o presente <strong>Contrato de Prestação de Serviços Advocatícios</strong>, que se regerá pelas cláusulas e condições seguintes:</p>

<h3>PARTES</h3>

<p><strong>CONTRATADO:</strong> <strong>{{emitente}}</strong>, inscrito no CNPJ sob o nº <strong>{{cnpj}}</strong>, com endereço em {{endereco}}.</p>

<p><strong>CONTRATANTE:</strong> <strong>{{tomador}}</strong>, inscrito no CPF/CNPJ nº <strong>{{cpfCnpj}}</strong>, com endereço em {{enderecoTomador}}, e-mail: {{emailTomador}}.</p>

<h3>CLÁUSULA 1ª — DO OBJETO</h3>

<p>O presente contrato tem por objeto a prestação de serviços advocatícios pelo CONTRATADO ao CONTRATANTE, conforme proposta previamente apresentada e aceita pelas partes.</p>

<h3>CLÁUSULA 2ª — DOS HONORÁRIOS</h3>

<p>Pelos serviços contratados, o CONTRATANTE pagará ao CONTRATADO honorários mensais no valor de <strong>{{valor}}</strong>, com vencimento no dia <strong>{{diaVencimento}}</strong> de cada mês, mediante <strong>{{metodoPagamento}}</strong>.</p>

<h3>CLÁUSULA 3ª — DO PRAZO</h3>

<p>O presente contrato vigerá por prazo indeterminado, podendo ser rescindido por qualquer das partes mediante aviso prévio de 30 (trinta) dias.</p>

<h3>CLÁUSULA 4ª — DAS OBRIGAÇÕES DO CONTRATADO</h3>

<p>O CONTRATADO obriga-se a prestar os serviços com diligência, competência e sigilo profissional, observando o Código de Ética e Disciplina da OAB e a legislação aplicável.</p>

<h3>CLÁUSULA 5ª — DAS OBRIGAÇÕES DO CONTRATANTE</h3>

<p>O CONTRATANTE obriga-se a fornecer ao CONTRATADO todas as informações e documentos necessários à prestação dos serviços, bem como a efetuar o pagamento dos honorários nas datas convencionadas.</p>

<h3>CLÁUSULA 6ª — DO REAJUSTE</h3>

<p>Os honorários serão reajustados anualmente pelo IGP-M (FGV) ou índice oficial que o substitua.</p>

<h3>CLÁUSULA 7ª — DO FORO</h3>

<p>As partes elegem o foro da Comarca de {{cidade}} para dirimir quaisquer controvérsias oriundas do presente contrato.</p>

<p><br>{{cidade}}, {{dataAtual}}.</p>

<br>

<table style="width:100%;margin-top:40px">
  <tr>
    <td style="width:50%;text-align:center;padding:10px">
      <hr style="border:1px solid #000;margin-bottom:8px">
      <p><strong>{{emitente}}</strong><br>CNPJ: {{cnpj}}<br>CONTRATADO</p>
    </td>
    <td style="width:50%;text-align:center;padding:10px">
      <hr style="border:1px solid #000;margin-bottom:8px">
      <p><strong>{{tomador}}</strong><br>CPF/CNPJ: {{cpfCnpj}}<br>CONTRATANTE</p>
    </td>
  </tr>
</table>`,
  })),

  templatePadraoProcuracao: authProc.query(() => ({
    tipo: "PROCURACAO" as const,
    titulo: "Procuração Ad Judicia",
    textoHtml: `<h2 style="text-align:center">PROCURAÇÃO AD JUDICIA ET EXTRA</h2>

<p><strong>OUTORGANTE:</strong> <strong>{{tomador}}</strong>, inscrito(a) no CPF/CNPJ nº <strong>{{cpfCnpj}}</strong>, com endereço em {{enderecoTomador}}, e-mail: {{emailTomador}}.</p>

<p><strong>OUTORGADO:</strong> Os advogados do escritório <strong>{{emitente}}</strong>, inscrito no CNPJ sob o nº <strong>{{cnpj}}</strong>, com endereço em {{endereco}}, e respectivos substabelecidos.</p>

<h3>PODERES</h3>

<p>Pelo presente instrumento, o OUTORGANTE nomeia e constitui como seu(s) bastante(s) procurador(es) o(s) advogado(s) acima qualificado(s), conferindo-lhe(s) amplos poderes para:</p>

<ul>
  <li>representar o OUTORGANTE em todos os atos processuais, em qualquer instância judicial ou tribunal;</li>
  <li>propor, contestar, reconvir, recorrer, transigir, desistir, confessar, receber e dar quitação;</li>
  <li>assinar petições, contratos e demais documentos necessários;</li>
  <li>praticar todos os demais atos necessários ao fiel cumprimento do presente mandato;</li>
  <li>substabelecer com ou sem reserva de poderes.</li>
</ul>

<p>Esta procuração é outorgada para representação nos interesses do OUTORGANTE perante quaisquer órgãos públicos, autarquias, empresas públicas, sociedades de economia mista, repartições públicas em geral, Poder Judiciário, Ministério Público e quaisquer outras entidades, públicas ou privadas.</p>

<p><br>{{cidade}}, {{dataAtual}}.</p>

<br>

<div style="margin-top:50px;text-align:center">
  <hr style="border:1px solid #000;width:60%;margin:0 auto 8px">
  <p><strong>{{tomador}}</strong><br>CPF/CNPJ: {{cpfCnpj}}<br>OUTORGANTE</p>
</div>`,
  })),
});
