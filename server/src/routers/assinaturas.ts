import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, authProc } from "./trpc.js";
import { prisma } from "../db.js";
import { whereEmitenteFilter, assertEmitenteAccess } from "./tenant-utils.js";
import {
  paktCancelarDocumento,
  paktEnviarDocumento,
  paktListarDocumentos,
  paktObterDocumento,
} from "../lib/pakt.js";
import {
  enviarConvites,
  enviarPdfAssinadoWhatsapp,
  nomeEscritorio,
  processarConclusao,
  type Signatario,
} from "../modules/assinaturas/assinatura-service.js";
import { paktBaixarPdf } from "../lib/pakt.js";

const STATUS_FINAIS = new Set(["COMPLETED", "CANCELLED", "EXPIRED"]);

/** Garante que a assinatura pertence a um emitente acessível pelo usuário. */
async function obterAssinatura(ctx: any, id: string) {
  const a = await prisma.assinatura.findFirst({
    where: { id, ...whereEmitenteFilter(ctx) },
    include: { emitente: { select: { id: true, nome: true, nomeFantasia: true } } },
  });
  if (!a) throw new TRPCError({ code: "NOT_FOUND", message: "Documento não encontrado" });
  return a;
}

function resumo(a: any) {
  const signatarios = (a.signatarios as Signatario[]) ?? [];
  return {
    id: a.id,
    paktDocumentId: a.paktDocumentId,
    nome: a.nome,
    status: a.status,
    mensagem: a.mensagem,
    escritorio: a.emitente ? nomeEscritorio(a.emitente) : "",
    emitenteId: a.emitenteId,
    criadoPorNome: a.criadoPorNome,
    criadoEm: a.criadoEm,
    arquivoNome: a.arquivoNome,
    temOriginal: !!a.arquivoPath,
    temAssinado: !!a.arquivoAssinadoPath,
    emailEnviado: a.emailEnviado,
    whatsappEnviado: a.whatsappEnviado,
    whatsappAssinadoEnviado: a.whatsappAssinadoEnviado,
    signatarios: signatarios.map((s) => ({
      nome: s.nome,
      email: s.email,
      telefone: s.telefone ?? "",
      cpf: s.cpf ?? "",
      papel: s.papel ?? "SIGNER",
      status: s.status ?? "",
      signUrl: s.signUrl ?? "",
      signedAt: s.signedAt ?? null,
    })),
  };
}

/** Reaplica no registro local o status atual do documento no PAKT. */
async function sincronizarComPakt(a: { id: string; paktDocumentId: string | null; signatarios: any }) {
  if (!a.paktDocumentId) return null;
  const doc = await paktObterDocumento(a.paktDocumentId);

  const locais = (a.signatarios as Signatario[]) ?? [];
  const atualizados = locais.map((s) => {
    const remoto = doc.signers?.find(
      (p) => p.id === s.paktSignerId || (!!s.email && p.email?.toLowerCase() === s.email.toLowerCase()),
    );
    return remoto
      ? { ...s, status: remoto.status ?? s.status, signedAt: remoto.signedAt ?? s.signedAt, signUrl: remoto.signUrl ?? s.signUrl }
      : s;
  });

  if (doc.status === "COMPLETED") {
    await prisma.assinatura.update({
      where: { id: a.id },
      data: { signatarios: atualizados as any },
    });
    await processarConclusao(a.paktDocumentId);
  } else {
    await prisma.assinatura.update({
      where: { id: a.id },
      data: { status: doc.status, signatarios: atualizados as any },
    });
  }
  return doc;
}

export const assinaturaRouter = router({
  listar: authProc
    .input(
      z
        .object({
          status: z.string().optional(),
          emitenteId: z.string().optional(),
          busca: z.string().optional(),
          limite: z.number().min(1).max(200).default(100),
        })
        .optional(),
    )
    .query(async ({ ctx, input }) => {
      const where: Record<string, unknown> = { ...whereEmitenteFilter(ctx) };
      if (input?.status) where.status = input.status;
      if (input?.emitenteId) {
        assertEmitenteAccess(ctx, input.emitenteId);
        where.emitenteId = input.emitenteId;
      }
      if (input?.busca?.trim()) where.nome = { contains: input.busca.trim(), mode: "insensitive" };

      const linhas = await prisma.assinatura.findMany({
        where,
        include: { emitente: { select: { id: true, nome: true, nomeFantasia: true } } },
        orderBy: { criadoEm: "desc" },
        take: input?.limite ?? 100,
      });
      return linhas.map(resumo);
    }),

  obter: authProc
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      const a = await obterAssinatura(ctx, input.id);

      // Mantém o status em dia mesmo se o webhook falhar.
      let auditoria: Array<{ evento: string; createdAt: string }> = [];
      if (a.paktDocumentId && !STATUS_FINAIS.has(a.status)) {
        try {
          const doc = await sincronizarComPakt(a);
          auditoria = doc?.auditLogs ?? [];
        } catch (e) {
          console.error("[Assinatura] sync no detalhe:", e);
        }
      } else if (a.paktDocumentId) {
        try {
          auditoria = (await paktObterDocumento(a.paktDocumentId)).auditLogs ?? [];
        } catch { /* trilha é opcional */ }
      }

      const atual = await obterAssinatura(ctx, input.id);
      return { ...resumo(atual), auditoria };
    }),

  /** Dispara o /send do PAKT + convites por e-mail e WhatsApp do escritório escolhido. */
  enviar: authProc
    .input(z.object({ id: z.string(), email: z.boolean().default(true), whatsapp: z.boolean().default(true) }))
    .mutation(async ({ ctx, input }) => {
      const a = await obterAssinatura(ctx, input.id);
      if (!a.paktDocumentId) throw new TRPCError({ code: "BAD_REQUEST", message: "Documento sem vínculo no PAKT" });
      if (STATUS_FINAIS.has(a.status))
        throw new TRPCError({ code: "BAD_REQUEST", message: `Documento já está ${a.status}` });

      await paktEnviarDocumento(a.paktDocumentId);
      await prisma.assinatura.update({ where: { id: a.id }, data: { status: "PENDING" } });

      const envio = await enviarConvites(a.id, { email: input.email, whatsapp: input.whatsapp });
      return { ok: true, ...envio };
    }),

  /** Reenvia os convites (e-mail + WhatsApp) sem tocar no PAKT. */
  reenviarConvites: authProc
    .input(z.object({ id: z.string(), email: z.boolean().default(true), whatsapp: z.boolean().default(true) }))
    .mutation(async ({ ctx, input }) => {
      const a = await obterAssinatura(ctx, input.id);
      if (a.status === "COMPLETED")
        throw new TRPCError({ code: "BAD_REQUEST", message: "Documento já foi assinado por todos" });
      const envio = await enviarConvites(a.id, { email: input.email, whatsapp: input.whatsapp });
      return { ok: true, ...envio };
    }),

  /** Reenvia o PDF assinado pelo WhatsApp. */
  reenviarAssinado: authProc
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const a = await obterAssinatura(ctx, input.id);
      if (a.status !== "COMPLETED" || !a.paktDocumentId)
        throw new TRPCError({ code: "BAD_REQUEST", message: "Documento ainda não foi concluído" });

      const pdf = await paktBaixarPdf(a.paktDocumentId, "final");
      const enviados = await enviarPdfAssinadoWhatsapp(a.id, pdf);
      if (enviados > 0) {
        await prisma.assinatura.update({
          where: { id: a.id },
          data: { whatsappAssinadoEnviado: true, whatsappAssinadoEnviadoEm: new Date() },
        });
      }
      return { ok: true, enviados };
    }),

  cancelar: authProc
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const a = await obterAssinatura(ctx, input.id);
      if (a.status === "COMPLETED")
        throw new TRPCError({ code: "FORBIDDEN", message: "Documentos concluídos não podem ser cancelados" });
      if (a.paktDocumentId) await paktCancelarDocumento(a.paktDocumentId);
      await prisma.assinatura.update({ where: { id: a.id }, data: { status: "CANCELLED" } });
      return { ok: true };
    }),

  /** Atualiza o status de todos os documentos ainda abertos contra o PAKT. */
  sincronizar: authProc.mutation(async ({ ctx }) => {
    const pendentes = await prisma.assinatura.findMany({
      where: { ...whereEmitenteFilter(ctx), status: { notIn: [...STATUS_FINAIS] }, paktDocumentId: { not: null } },
      orderBy: { criadoEm: "desc" },
      take: 50,
    });

    let ok = 0;
    let erros = 0;
    for (const a of pendentes) {
      try {
        await sincronizarComPakt(a);
        ok++;
      } catch (e) {
        console.error(`[Assinatura] sync ${a.paktDocumentId}:`, e);
        erros++;
      }
    }
    return { sincronizados: ok, erros };
  }),

  /**
   * Resgata documentos que existem na conta PAKT mas não estão registrados aqui.
   * ATENÇÃO: a conta PAKT é compartilhada com o PSA DOCS — a importação traz
   * também os documentos criados por lá.
   */
  importarDoPakt: authProc
    .input(z.object({ emitenteId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      assertEmitenteAccess(ctx, input.emitenteId);

      const existentes = new Set(
        (await prisma.assinatura.findMany({ where: { paktDocumentId: { not: null } }, select: { paktDocumentId: true } }))
          .map((r) => r.paktDocumentId!)
          .filter(Boolean),
      );

      let importados = 0;
      let totalPakt = 0;
      let pagina = 1;
      let totalPaginas = 1;

      while (pagina <= totalPaginas && pagina <= 50) {
        const { documents, pagination } = await paktListarDocumentos(pagina, 100);
        totalPaginas = pagination?.totalPages ?? 1;
        totalPakt = pagination?.total ?? totalPakt;

        for (const d of documents ?? []) {
          if (!d.id || existentes.has(d.id)) continue;
          const signatarios: Signatario[] = (d.signers ?? []).map((s, i) => ({
            nome: s.nome ?? "",
            email: s.email ?? "",
            telefone: "",
            papel: "SIGNER",
            orderIndex: s.orderIndex ?? i,
            paktSignerId: s.id,
            status: s.status,
            signedAt: s.signedAt ?? null,
          }));
          try {
            await prisma.assinatura.create({
              data: {
                paktDocumentId: d.id,
                emitenteId: input.emitenteId,
                nome: (d.nome ?? "documento").replace(/\.pdf$/i, ""),
                status: d.status ?? "PENDING",
                arquivoNome: d.nome ?? null,
                criadoPorNome: "Importado do PAKT",
                signatarios: signatarios as any,
                paktResponse: d as any,
                criadoEm: d.createdAt ? new Date(d.createdAt) : new Date(),
              },
            });
            existentes.add(d.id);
            importados++;
          } catch (e) {
            console.warn(`[Assinatura] importar ${d.id}:`, e);
          }
        }
        pagina++;
      }

      return { importados, totalPakt, jaExistiam: existentes.size - importados };
    }),

  excluir: authProc
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const a = await obterAssinatura(ctx, input.id);
      if (a.status === "PENDING")
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Cancele o documento no PAKT antes de removê-lo da lista",
        });
      await prisma.assinatura.delete({ where: { id: a.id } });
      return { ok: true };
    }),
});
