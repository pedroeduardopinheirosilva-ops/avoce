import { z }                from "zod";
import { router, authProc } from "./trpc.js";
import { prisma }           from "../db.js";
import { emitirNfse, cancelarNfse, consultarNfse, type EmpresaConfig } from "../lib/nfse.js";
import { certPathForEmpresa } from "../upload.js";
import { renderTemplate }   from "../lib/template.js";
import { enviarEmailNfse }  from "../lib/email.js";

async function getCfg(emitenteId: string): Promise<EmpresaConfig> {
  const emp = await prisma.empresaEmitente.findUniqueOrThrow({ where: { id: emitenteId } });
  const certPath = certPathForEmpresa(emitenteId);
  return {
    cnpj:                   emp.cnpj,
    inscricaoMunicipal:     emp.inscricaoMunicipal,
    certPath,
    certPass:               emp.certPass ?? process.env[`CERT_PASS_${emitenteId}`] ?? process.env.CERT_PASS_DEFAULT ?? "",
    aliquotaIss:            emp.aliquotaIss,
    itemListaServico:       emp.itemListaServico,
    codTributacao:          emp.codTributacao,
    codigoServicoNacional:  emp.codigoServicoNacional ?? undefined,
    codigoNbs:              emp.codigoNbs ?? undefined,
    regimeTributacao:       emp.regimeTributacao ?? undefined,
    simplesNacional:        emp.regime,
  };
}

export const notaRouter = router({
  listar: authProc
    .input(z.object({
      emitenteId:  z.string().optional(),
      contratoId:  z.string().optional(),
      status:      z.string().optional(),
      competencia: z.string().optional(),
      page:        z.number().int().default(1),
      pageSize:    z.number().int().default(20),
    }))
    .query(async ({ input }) => {
      const where = {
        ...(input.emitenteId  ? { emitenteId: input.emitenteId }   : {}),
        ...(input.contratoId  ? { contratoId: input.contratoId }   : {}),
        ...(input.status      ? { status: input.status }           : {}),
        ...(input.competencia ? { competencia: input.competencia } : {}),
      };
      const [notas, total] = await Promise.all([
        prisma.notaFiscal.findMany({
          where,
          include: {
            emitente: { select: { id: true, nome: true } },
            contrato: { select: { id: true, descricaoServico: true, tomador: { select: { nome: true } } } },
          },
          orderBy: { criadoEm: "desc" },
          skip: (input.page - 1) * input.pageSize,
          take: input.pageSize,
        }),
        prisma.notaFiscal.count({ where }),
      ]);
      return { notas, total, pages: Math.ceil(total / input.pageSize) };
    }),

  emitir: authProc
    .input(z.object({ contratoId: z.string(), competencia: z.string().optional() }))
    .mutation(async ({ input }) => {
      const contrato = await prisma.contrato.findUniqueOrThrow({
        where:   { id: input.contratoId },
        include: { emitente: true, tomador: true },
      });

      // Contratos suspensos ainda podem ter NFS-e emitida manualmente

      const competencia = input.competencia ?? (() => {
        const d = new Date();
        return `${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
      })();

      // Verificar se já emitida neste mês
      const [mm, yyyy] = competencia.split("/");
      const jaExiste = await prisma.notaFiscal.findFirst({
        where: { contratoId: input.contratoId, competencia, status: { in: ["EMITIDA", "PENDENTE"] } },
      });
      if (jaExiste) throw new Error(`Já existe nota para competência ${competencia}`);

      const nota = await prisma.notaFiscal.create({
        data: {
          contratoId:  input.contratoId,
          emitenteId:  contrato.emitenteId,
          competencia,
          valor:       contrato.valor,
          status:      "PENDENTE",
        },
      });

      try {
        const cfg = await getCfg(contrato.emitenteId);

        // Calcular vencimento com base no diaVencimento do contrato
        const dtVenc = new Date();
        dtVenc.setDate(contrato.diaVencimento);
        const vencimento = dtVenc.toISOString().slice(0, 10);

        // Renderizar templates
        const templateVars = {
          competencia: competencia,
          vencimento:  vencimento,
          valor:       contrato.valor,
          emitente:    contrato.emitente.nomeFantasia || contrato.emitente.nome,
          tomador:     contrato.tomador.nome,
          servico:     contrato.nomeServico ?? undefined,
        };
        const discriminacaoRendered = renderTemplate(contrato.descricaoServico, templateVars);

        const result = await emitirNfse(contrato.emitenteId, cfg, {
          valor:         contrato.valor,
          discriminacao: discriminacaoRendered,
          tomador: {
            nome:            contrato.tomador.nome,
            cpfCnpj:         contrato.tomador.cpfCnpj,
            inscMunicipal:   contrato.tomador.inscMunicipal ?? undefined,
            endereco:        contrato.tomador.endereco ?? "Endereço não informado",
            numero:          contrato.tomador.numero ?? "S/N",
            bairro:          contrato.tomador.bairro ?? "Centro",
            cidade:          contrato.tomador.cidade ?? "Vitória da Conquista",
            codigoMunicipio: contrato.tomador.codigoMunicipio ?? "2933307",
            uf:              contrato.tomador.uf ?? "BA",
            cep:             contrato.tomador.cep ?? "45000000",
            email:           contrato.tomador.email ?? undefined,
          },
          competencia:      `${yyyy}-${mm}`,
          issRetido:        contrato.issRetido,
          itemListaServico: contrato.itemListaServico ?? undefined,
          codigoNbs:        contrato.codigoNbs ?? undefined,
          retirIr:          contrato.retirIr,
          retirCsll:        contrato.retirCsll,
          retirPis:         contrato.retirPis,
          retirCofins:      contrato.retirCofins,
        });

        const notaAtualizada = await prisma.notaFiscal.update({
          where: { id: nota.id },
          data: {
            status:      "EMITIDA",
            numero:      result.numero,
            codigoVerif: result.codigoVerif,
            xmlRetorno:  result.xmlRetorno,
            linkNfse:    result.linkNfse,
            emitidoEm:   new Date(),
          },
        });

        // Enviar por e-mail (assíncrono — não bloqueia nem reverte em caso de falha)
        const smtpEmp = contrato.emitente.smtpHost && contrato.emitente.smtpUser ? {
          host:   contrato.emitente.smtpHost,
          port:   contrato.emitente.smtpPort ?? 587,
          secure: contrato.emitente.smtpSecure,
          user:   contrato.emitente.smtpUser,
          pass:   contrato.emitente.smtpPass ?? "",
          from:   contrato.emitente.smtpFrom ?? contrato.emitente.smtpUser,
        } : null;
        enviarEmailNfse({
          numero:       result.numero,
          competencia,
          valor:        contrato.valor,
          discriminacao: discriminacaoRendered,
          linkNfse:     result.linkNfse ?? undefined,
          codigoVerif:  result.codigoVerif ?? undefined,
          emitente: {
            nome:        contrato.emitente.nome,
            nomeFantasia: contrato.emitente.nomeFantasia,
            cnpj:        contrato.emitente.cnpj,
            email:       contrato.emitente.email,
            smtp:        smtpEmp,
          },
          tomador: {
            nome:    contrato.tomador.nome,
            cpfCnpj: contrato.tomador.cpfCnpj,
            email:   contrato.tomador.email,
          },
        }).catch(console.error);

        return notaAtualizada;
      } catch (err) {
        await prisma.notaFiscal.update({
          where: { id: nota.id },
          data: { status: "ERRO", erroMsg: String(err instanceof Error ? err.message : err).slice(0, 1000) },
        });
        throw err;
      }
    }),

  // ── Faturamento em lote ─────────────────────────────────────────────────────
  // Emite NFS-e para uma lista de contratos em uma dada competência.
  // Retorna o resultado de cada contrato (ok / pulado / erro) sem lançar exceção.
  faturarLote: authProc
    .input(z.object({
      competencia: z.string().regex(/^\d{2}\/\d{4}$/),
      contratoIds: z.array(z.string()).min(1).max(100),
    }))
    .mutation(async ({ input }) => {
      const { competencia, contratoIds } = input;
      const [mm, yyyy] = competencia.split("/");

      const contratos = await prisma.contrato.findMany({
        where: { id: { in: contratoIds }, ativo: true },
        include: { emitente: true, tomador: true },
      });

      type ResultItem = {
        contratoId: string;
        tomador:    string;
        emitente:   string;
        valor:      number;
        status:     "EMITIDA" | "PULADO" | "ERRO";
        numero?:    string;
        erroMsg?:   string;
      };

      const resultados: ResultItem[] = [];

      for (const contrato of contratos) {
        // Verifica se já emitida neste mês
        const jaExiste = await prisma.notaFiscal.findFirst({
          where: { contratoId: contrato.id, competencia, status: { in: ["EMITIDA", "PENDENTE"] } },
        });
        if (jaExiste) {
          resultados.push({
            contratoId: contrato.id,
            tomador:    contrato.tomador.nome,
            emitente:   contrato.emitente.nome,
            valor:      contrato.valor,
            status:     "PULADO",
            numero:     jaExiste.numero ?? undefined,
          });
          continue;
        }

        const nota = await prisma.notaFiscal.create({
          data: { contratoId: contrato.id, emitenteId: contrato.emitenteId, competencia, valor: contrato.valor, status: "PENDENTE" },
        });

        try {
          const cfg = await getCfg(contrato.emitenteId);

          const dtVenc = new Date();
          dtVenc.setDate(contrato.diaVencimento);
          const vencimento = dtVenc.toISOString().slice(0, 10);

          const templateVars = {
            competencia, vencimento, valor: contrato.valor,
            emitente: contrato.emitente.nomeFantasia || contrato.emitente.nome,
            tomador:  contrato.tomador.nome,
            servico:  contrato.nomeServico ?? undefined,
          };
          const discriminacaoRendered = renderTemplate(contrato.descricaoServico, templateVars);

          const result = await emitirNfse(contrato.emitenteId, cfg, {
            valor:            contrato.valor,
            discriminacao:    discriminacaoRendered,
            tomador: {
              nome:            contrato.tomador.nome,
              cpfCnpj:         contrato.tomador.cpfCnpj,
              inscMunicipal:   contrato.tomador.inscMunicipal ?? undefined,
              endereco:        contrato.tomador.endereco ?? "Endereço não informado",
              numero:          contrato.tomador.numero ?? "S/N",
              bairro:          contrato.tomador.bairro ?? "Centro",
              cidade:          contrato.tomador.cidade ?? "Vitória da Conquista",
              codigoMunicipio: contrato.tomador.codigoMunicipio ?? "2933307",
              uf:              contrato.tomador.uf ?? "BA",
              cep:             contrato.tomador.cep ?? "45000000",
              email:           contrato.tomador.email ?? undefined,
            },
            competencia:      `${yyyy}-${mm}`,
            issRetido:        contrato.issRetido,
            itemListaServico: contrato.itemListaServico ?? undefined,
            codigoNbs:        contrato.codigoNbs ?? undefined,
            retirIr:          contrato.retirIr,
            retirCsll:        contrato.retirCsll,
            retirPis:         contrato.retirPis,
            retirCofins:      contrato.retirCofins,
          });

          await prisma.notaFiscal.update({
            where: { id: nota.id },
            data: { status: "EMITIDA", numero: result.numero, codigoVerif: result.codigoVerif,
                    xmlRetorno: result.xmlRetorno, linkNfse: result.linkNfse, emitidoEm: new Date() },
          });

          // E-mail assíncrono
          const smtpEmp = contrato.emitente.smtpHost && contrato.emitente.smtpUser ? {
            host: contrato.emitente.smtpHost, port: contrato.emitente.smtpPort ?? 587,
            secure: contrato.emitente.smtpSecure, user: contrato.emitente.smtpUser,
            pass: contrato.emitente.smtpPass ?? "", from: contrato.emitente.smtpFrom ?? contrato.emitente.smtpUser,
          } : null;
          enviarEmailNfse({
            numero: result.numero, competencia, valor: contrato.valor, discriminacao: discriminacaoRendered,
            linkNfse: result.linkNfse ?? undefined, codigoVerif: result.codigoVerif ?? undefined,
            emitente: { nome: contrato.emitente.nome, nomeFantasia: contrato.emitente.nomeFantasia,
                        cnpj: contrato.emitente.cnpj, email: contrato.emitente.email, smtp: smtpEmp },
            tomador:  { nome: contrato.tomador.nome, cpfCnpj: contrato.tomador.cpfCnpj, email: contrato.tomador.email },
          }).catch(e => console.error(`[Lote] Email falhou ${contrato.id}:`, e));

          resultados.push({ contratoId: contrato.id, tomador: contrato.tomador.nome,
                            emitente: contrato.emitente.nome, valor: contrato.valor,
                            status: "EMITIDA", numero: result.numero });
        } catch (err) {
          const erroMsg = (err instanceof Error ? err.message : String(err)).slice(0, 500);
          await prisma.notaFiscal.update({ where: { id: nota.id }, data: { status: "ERRO", erroMsg } });
          resultados.push({ contratoId: contrato.id, tomador: contrato.tomador.nome,
                            emitente: contrato.emitente.nome, valor: contrato.valor,
                            status: "ERRO", erroMsg });
        }
      }

      return resultados;
    }),

  cancelar: authProc
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      const nota = await prisma.notaFiscal.findUniqueOrThrow({ where: { id: input.id } });
      if (nota.status !== "EMITIDA") throw new Error("Apenas notas emitidas podem ser canceladas");
      if (!nota.numero) throw new Error("Nota sem número");

      const cfg = await getCfg(nota.emitenteId);
      await cancelarNfse(cfg, nota.numero);

      return prisma.notaFiscal.update({
        where: { id: input.id },
        data:  { status: "CANCELADA" },
      });
    }),

  consultar: authProc
    .input(z.object({ id: z.string() }))
    .query(async ({ input }) => {
      const nota = await prisma.notaFiscal.findUniqueOrThrow({ where: { id: input.id } });
      if (!nota.numero) throw new Error("Nota sem número emitido");
      const cfg = await getCfg(nota.emitenteId);
      return consultarNfse(cfg, nota.numero);
    }),

  dashboard: authProc.query(async () => {
    const [total, emitidas, erros, valorAgg] = await Promise.all([
      prisma.notaFiscal.count(),
      prisma.notaFiscal.count({ where: { status: "EMITIDA" } }),
      prisma.notaFiscal.count({ where: { status: "ERRO" } }),
      prisma.notaFiscal.aggregate({
        where:  { status: "EMITIDA" },
        _sum:   { valor: true },
      }),
    ]);
    return {
      total,
      emitidas,
      erros,
      valorTotal: valorAgg._sum.valor ?? 0,
    };
  }),
});
