import { z }                        from "zod";
import { router, authProc }         from "./trpc.js";
import { prisma }                   from "../db.js";
import nodemailer                   from "nodemailer";
import { existsSync, readFileSync } from "node:fs";
import { certPathForEmpresa }       from "../upload.js";
import { extrairMetaCert }          from "../lib/nfse.js";

export const empresaRouter = router({
  listar: authProc.query(async () => {
    return prisma.empresaEmitente.findMany({ orderBy: { nome: "asc" } });
  }),

  obter: authProc
    .input(z.object({ id: z.string() }))
    .query(async ({ input }) => {
      return prisma.empresaEmitente.findUniqueOrThrow({ where: { id: input.id } });
    }),

  criar: authProc
    .input(z.object({
      nome:               z.string().min(2),
      nomeFantasia:       z.string().optional().nullable(),
      cnpj:               z.string().min(14),
      inscricaoMunicipal: z.string().optional().default(""),
      inscricaoEstadual:  z.string().optional().nullable(),
      email:              z.string().optional().nullable(),
      telefone:           z.string().optional().nullable(),
      endereco:           z.string().optional().nullable(),
      numero:             z.string().optional().nullable(),
      complemento:        z.string().optional().nullable(),
      bairro:             z.string().optional().nullable(),
      cidade:             z.string().optional().nullable(),
      codigoMunicipio:    z.string().optional().nullable(),
      uf:                 z.string().max(2).optional().nullable(),
      cep:                z.string().optional().nullable(),
      regime:                   z.enum(["1", "2", "3"]).default("2"),
      aliquotaIss:              z.number().min(0).max(1).default(0.05),
      itemListaServico:         z.string().default("1.01"),
      codTributacao:            z.string().default("0101"),
      codigoServicoNacional:    z.string().optional().nullable(),
      codigoNbs:                z.string().optional().nullable(),
      regimeTributacao:         z.string().optional().nullable(),
      smtpHost:           z.string().optional().nullable(),
      smtpPort:           z.number().int().optional().nullable(),
      smtpSecure:         z.boolean().optional(),
      smtpUser:           z.string().optional().nullable(),
      smtpPass:           z.string().optional().nullable(),
      smtpFrom:           z.string().optional().nullable(),
    }))
    .mutation(async ({ input }) => {
      return prisma.empresaEmitente.create({ data: input });
    }),

  atualizar: authProc
    .input(z.object({
      id:                 z.string(),
      nome:               z.string().min(2).optional(),
      nomeFantasia:       z.string().optional().nullable(),
      inscricaoMunicipal: z.string().min(1).optional(),
      inscricaoEstadual:  z.string().optional().nullable(),
      email:              z.string().email().optional().nullable(),
      telefone:           z.string().optional().nullable(),
      endereco:           z.string().optional().nullable(),
      numero:             z.string().optional().nullable(),
      complemento:        z.string().optional().nullable(),
      bairro:             z.string().optional().nullable(),
      cidade:             z.string().optional().nullable(),
      codigoMunicipio:    z.string().optional().nullable(),
      uf:                 z.string().length(2).optional().nullable(),
      cep:                z.string().optional().nullable(),
      regime:                   z.enum(["1", "2", "3"]).optional(),
      aliquotaIss:              z.number().min(0).max(1).optional(),
      itemListaServico:         z.string().optional(),
      codTributacao:            z.string().optional(),
      codigoServicoNacional:    z.string().optional().nullable(),
      codigoNbs:                z.string().optional().nullable(),
      regimeTributacao:         z.string().optional().nullable(),
      ativo:              z.boolean().optional(),
      smtpHost:           z.string().optional().nullable(),
      smtpPort:           z.number().int().optional().nullable(),
      smtpSecure:         z.boolean().optional(),
      smtpUser:           z.string().optional().nullable(),
      smtpPass:           z.string().optional().nullable(),
      smtpFrom:           z.string().optional().nullable(),
      certPass:           z.string().optional().nullable(),
      // Sicoob PIX
      pixClientId:        z.string().optional().nullable(),
      pixChave:           z.string().optional().nullable(),
      // Sicoob Boleto
      boletoClientId:           z.string().optional().nullable(),
      boletoNumeroCliente:      z.string().optional().nullable(),
      boletoContaCorrente:      z.string().optional().nullable(),
      boletoModalidade:         z.string().optional().nullable(),
      boletoContratoCobranca:   z.string().optional().nullable(),
      boletoMultaPercent:       z.number().optional().nullable(),
      boletoJurosDiaPercent:    z.number().optional().nullable(),
    }))
    .mutation(async ({ input }) => {
      const { id, ...data } = input;
      return prisma.empresaEmitente.update({ where: { id }, data });
    }),

  salvarSenhaCert: authProc
    .input(z.object({ id: z.string(), certPass: z.string() }))
    .mutation(async ({ input }) => {
      const certPath = certPathForEmpresa(input.id);
      if (!existsSync(certPath)) throw new Error("Certificado não encontrado. Faça o upload do arquivo .p12 primeiro.");

      const buf = readFileSync(certPath);
      extrairMetaCert(buf, input.certPass); // lança se senha errada

      process.env[`CERT_PASS_${input.id}`] = input.certPass;
      return prisma.empresaEmitente.update({
        where: { id: input.id },
        data:  { certPass: input.certPass },
      });
    }),

  testarSmtp: authProc
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      const emp = await prisma.empresaEmitente.findUniqueOrThrow({ where: { id: input.id } });
      if (!emp.smtpHost || !emp.smtpUser) throw new Error("SMTP não configurado para esta empresa");

      const port   = emp.smtpPort ?? 587;
      const secure = port === 465;            // SSL direto só na 465; 587 usa STARTTLS
      const transporter = nodemailer.createTransport({
        host:       emp.smtpHost,
        port,
        secure,
        requireTLS: !secure,
        auth:       { user: emp.smtpUser, pass: emp.smtpPass ?? "" },
        tls:        { rejectUnauthorized: false },
      });

      await transporter.verify();

      const destinatario = emp.email || emp.smtpUser;
      await transporter.sendMail({
        from:    emp.smtpFrom || emp.smtpUser,
        to:      destinatario,
        subject: `✅ Teste SMTP — ${emp.nomeFantasia || emp.nome}`,
        html: `
          <p>Este é um e-mail de teste enviado pelo sistema Avoce.</p>
          <p>Se você recebeu este e-mail, as configurações SMTP de <strong>${emp.nomeFantasia || emp.nome}</strong> estão corretas.</p>
          <br><p style="color:#666;font-size:12px">Avoce · Vitória da Conquista / BA</p>
        `,
      });

      return { ok: true, destinatario };
    }),

  excluir: authProc
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      // soft delete
      return prisma.empresaEmitente.update({
        where: { id: input.id },
        data:  { ativo: false },
      });
    }),

  estatisticas: authProc
    .input(z.object({ id: z.string() }))
    .query(async ({ input }) => {
      const [totalContratos, totalNotas, notasEmitidas] = await Promise.all([
        prisma.contrato.count({ where: { emitenteId: input.id, ativo: true } }),
        prisma.notaFiscal.count({ where: { emitenteId: input.id } }),
        prisma.notaFiscal.aggregate({
          where:  { emitenteId: input.id, status: "EMITIDA" },
          _sum:   { valor: true },
          _count: true,
        }),
      ]);
      return {
        totalContratos,
        totalNotas,
        notasEmitidas: notasEmitidas._count,
        valorTotalEmitido: notasEmitidas._sum.valor ?? 0,
      };
    }),
});
