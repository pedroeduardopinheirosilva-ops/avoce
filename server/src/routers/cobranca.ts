import { z }                from "zod";
import { router, authProc } from "./trpc.js";
import { prisma }           from "../db.js";
import { criarPix, consultarPix, registrarWebhookPix, consultarWebhookPix, sicoobPixConfigurado } from "../lib/sicoob-pix.js";
import type { SicoobPixConfig }    from "../lib/sicoob-pix.js";
import { criarBoleto, consultarBoleto, sicoobBoletoConfigurado } from "../lib/sicoob-boleto.js";
import type { SicoobBoletoConfig } from "../lib/sicoob-boleto.js";
import { renderTemplate }          from "../lib/template.js";
import { certPathForEmpresa }      from "../upload.js";
import { enviarEmailCobranca }     from "../lib/email-cobranca.js";

type Emitente = Awaited<ReturnType<typeof prisma.empresaEmitente.findUniqueOrThrow>>;

function pixCfg(emp: Emitente): SicoobPixConfig {
  return {
    clientId: emp.pixClientId ?? "",
    pixChave: emp.pixChave || emp.cnpj.replace(/\D/g, ""),
    certPath: certPathForEmpresa(emp.id),
    certPass: emp.certPass    ?? "",
  };
}

function boletoCfg(emp: Emitente): SicoobBoletoConfig {
  return {
    clientId:         emp.boletoClientId         ?? "",
    numeroCliente:    Number(emp.boletoNumeroCliente  ?? 0),
    contaCorrente:    Number((emp.boletoContaCorrente ?? "0").replace(/\D/g, "")),
    codigoModalidade: Number(emp.boletoModalidade     ?? 1),
    contratoCobranca: Number(emp.boletoContratoCobranca ?? 0),
    certPath: certPathForEmpresa(emp.id),
    certPass: emp.certPass ?? "",
  };
}

export const cobrancaRouter = router({

  // ── Listar cobranças ──────────────────────────────────────────────────────
  listar: authProc
    .input(z.object({
      contratoId:  z.string().optional(),
      emitenteId:  z.string().optional(),
      competencia: z.string().optional(),
      page:        z.number().int().default(1),
      pageSize:    z.number().int().default(20),
    }))
    .query(async ({ input }) => {
      const where = {
        ...(input.contratoId  ? { contratoId:  input.contratoId  } : {}),
        ...(input.emitenteId  ? { emitenteId:  input.emitenteId  } : {}),
        ...(input.competencia ? { competencia: input.competencia } : {}),
      };
      const [cobrancas, total] = await Promise.all([
        prisma.cobranca.findMany({
          where,
          include: {
            emitente: { select: { id: true, nome: true } },
            contrato: {
              select: {
                id: true, nomeServico: true, descricaoServico: true,
                tomador: { select: { nome: true } },
              },
            },
          },
          orderBy: { criadoEm: "desc" },
          skip: (input.page - 1) * input.pageSize,
          take: input.pageSize,
        }),
        prisma.cobranca.count({ where }),
      ]);
      return { cobrancas, total, pages: Math.ceil(total / input.pageSize) };
    }),

  // ── Gerar cobrança (PIX + Boleto) ─────────────────────────────────────────
  gerar: authProc
    .input(z.object({
      contratoId:  z.string(),
      competencia: z.string().regex(/^\d{2}\/\d{4}$/),
      vencimento:  z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      comPix:      z.boolean().default(true),
      comBoleto:   z.boolean().default(true),
      forcar:      z.boolean().default(false),
      enviarEmail: z.boolean().default(true),
    }))
    .mutation(async ({ input }) => {
      const contrato = await prisma.contrato.findUniqueOrThrow({
        where: { id: input.contratoId },
        include: { emitente: true, tomador: true },
      });

      // Bloquear duplicata por vencimento — sempre, mesmo com forcar=true
      const duplicataVenc = await prisma.cobranca.findFirst({
        where: { contratoId: input.contratoId, vencimento: input.vencimento },
      });
      if (duplicataVenc) throw new Error(`Já existe cobrança com vencimento ${input.vencimento} para este contrato`);

      // Verificar duplicata por competência (apenas sem forcar)
      if (!input.forcar) {
        const existente = await prisma.cobranca.findFirst({
          where: { contratoId: input.contratoId, competencia: input.competencia },
        });
        if (existente) throw new Error(`Já existe cobrança para ${input.competencia}`);
      }

      const [mm, yyyy] = input.competencia.split("/");
      const valorBRL = contrato.valor;

      // Renderizar templates com variáveis
      const templateVars = {
        competencia: input.competencia,
        vencimento:  input.vencimento,
        valor:       valorBRL,
        emitente:    contrato.emitente.nomeFantasia || contrato.emitente.nome,
        tomador:     contrato.tomador.nome,
        servico:     contrato.nomeServico ?? undefined,
      };
      const discriminacaoRendered = renderTemplate(contrato.descricaoServico, templateVars);
      const observacaoRendered    = contrato.observacoes
        ? renderTemplate(contrato.observacoes, templateVars)
        : undefined;

      // Criar registro inicial
      const cobranca = await prisma.cobranca.create({
        data: {
          contratoId:  input.contratoId,
          emitenteId:  contrato.emitenteId,
          competencia: input.competencia,
          valor:       valorBRL,
          vencimento:  input.vencimento,
        },
      });

      const pCfg = pixCfg(contrato.emitente);
      const bCfg = boletoCfg(contrato.emitente);

      let pixData:    Awaited<ReturnType<typeof criarPix>>    | null = null;
      let boletoData: Awaited<ReturnType<typeof criarBoleto>> | null = null;

      // ── PIX ───────────────────────────────────────────────────────────────
      if (input.comPix && sicoobPixConfigurado(pCfg)) {
        try {
          const descPix = `${contrato.nomeServico || "Serviços"} ${input.competencia}`.slice(0, 140);
          const dtVenc  = new Date(input.vencimento + "T12:00:00Z");
          const TRINTA_DIAS = 30 * 24 * 60 * 60;
          const expiracaoSec = Math.max(
            TRINTA_DIAS,
            Math.floor((dtVenc.getTime() - Date.now()) / 1000) + TRINTA_DIAS,
          );
          pixData = await criarPix(pCfg, {
            valor:      valorBRL,
            descricao:  descPix,
            referencia: cobranca.id,
            expiracao:  expiracaoSec,
          });
        } catch (e) {
          console.error("[Cobrança] PIX falhou:", e);
        }
      }

      // ── Boleto ────────────────────────────────────────────────────────────
      if (input.comBoleto && sicoobBoletoConfigurado(bCfg)) {
        try {
          const instrucoes = [
            `Ref: ${input.competencia} — ${contrato.nomeServico || contrato.emitente.nome}`,
            `Vencimento: ${input.vencimento}`,
          ];
          if (observacaoRendered) instrucoes.push(observacaoRendered.slice(0, 80));

          boletoData = await criarBoleto(bCfg, {
            valor:          valorBRL,
            dataVencimento: input.vencimento,
            seuNumero:      cobranca.id.slice(0, 15),
            instrucoes,
            comPix:         false,
            multaPercent:   contrato.emitente.boletoMultaPercent    ?? 2,
            jurosDiaPercent: contrato.emitente.boletoJurosDiaPercent ?? 0.033,
            pagador: {
              nome:     contrato.tomador.nome,
              cpfCnpj:  contrato.tomador.cpfCnpj,
              endereco: contrato.tomador.endereco || "Endereço não informado",
              bairro:   contrato.tomador.bairro   || "Centro",
              cidade:   contrato.tomador.cidade   || "Vitória da Conquista",
              uf:       contrato.tomador.uf       || "BA",
              cep:      contrato.tomador.cep      || "45000000",
              email:    contrato.tomador.email    ?? undefined,
            },
          });
        } catch (e) {
          console.error("[Cobrança] Boleto falhou:", e);
        }
      }

      // Avisar se nenhum método foi gerado (Sicoob não configurado)
      const pixSolicitado    = input.comPix    && !sicoobPixConfigurado(pCfg);
      const boletoSolicitado = input.comBoleto && !sicoobBoletoConfigurado(bCfg);
      if (pixSolicitado || boletoSolicitado) {
        const faltando = [pixSolicitado && "PIX", boletoSolicitado && "Boleto"].filter(Boolean).join(" e ");
        console.warn(`[Cobrança] ${faltando} não configurado(s) para empresa ${contrato.emitenteId}`);
      }

      // Atualizar com dados do PIX e boleto
      const cobAtualizada = await prisma.cobranca.update({
        where: { id: cobranca.id },
        data: {
          ...(pixData ? {
            pixTxid:      pixData.txid,
            pixBrcode:    pixData.brcode,
            pixQrcode:    pixData.qrcode ?? null,
            pixStatus:    "PENDENTE",
            pixExpiresAt: pixData.expiresAt,
          } : {}),
          ...(boletoData ? {
            boletoNossoNumero:    boletoData.nossoNumero,
            boletoLinhaDigitavel: boletoData.linhaDigitavel,
            boletoCodigoBarras:   boletoData.codigoBarras,
            boletoUrlPdf:         boletoData.urlPdf ?? null,
          } : {}),
        },
      });

      // Enviar e-mail com carta + boleto PDF (não bloqueia a resposta)
      if (input.enviarEmail !== false) {
        enviarEmailCobranca(cobAtualizada.id).catch(err =>
          console.error(`[Email-Cob] Erro ao enviar cobrança ${cobAtualizada.id}:`, err)
        );
      }

      return cobAtualizada;
    }),

  // ── Reenviar e-mail de cobrança ───────────────────────────────────────────
  reenviarEmail: authProc
    .input(z.object({ id: z.string() }))
    .mutation(({ input }) => {
      enviarEmailCobranca(input.id).catch(err =>
        console.error(`[Email-Cob] Erro ao reenviar cobrança ${input.id}:`, err)
      );
      return { ok: true };
    }),

  // ── Consultar status na API Sicoob ────────────────────────────────────────
  // Atualiza pixStatus e boletoStatus de uma ou todas as cobranças pendentes
  consultarStatus: authProc
    .input(z.object({
      id: z.string().optional(), // se omitido, verifica todas pendentes
    }))
    .mutation(async ({ input }) => {
      const where = input.id
        ? { id: input.id }
        : {
            OR: [
              { pixStatus: "PENDENTE", pixTxid: { not: null } },
              { boletoStatus: "AGUARDANDO", boletoNossoNumero: { not: null } },
            ],
          };

      const cobrancas = await prisma.cobranca.findMany({ where, include: { emitente: true } });
      const results: { id: string; pixStatus?: string; boletoStatus?: string; error?: string }[] = [];

      for (const c of cobrancas) {
        const update: Record<string, unknown> = {};
        try {
          const cPix    = pixCfg(c.emitente);
          const cBoleto = boletoCfg(c.emitente);

          // Verificar PIX
          if (c.pixTxid && c.pixStatus === "PENDENTE") {
            const pix = await consultarPix(cPix, c.pixTxid);
            update["pixStatus"] = pix.status;
          }

          // Verificar boleto
          if (c.boletoNossoNumero && c.boletoStatus === "AGUARDANDO") {
            const boleto = await consultarBoleto(cBoleto, c.boletoNossoNumero);
            const situacao = boleto.situacao?.toUpperCase() ?? "";

            if (situacao === "LIQUIDADO" || situacao === "PAGO" || situacao.includes("LIQUIDA")) {
              update["boletoStatus"]   = "PAGO";
              update["boletoPagoEm"]   = boleto.dataPagamento ?? null;
              update["boletoValorPago"] = boleto.valorPago
                ? Math.round(boleto.valorPago * 100)
                : null;
            } else if (situacao === "BAIXADO" || situacao === "CANCELADO") {
              update["boletoStatus"] = "CANCELADO";
            } else {
              // Verificar vencimento
              const venc = new Date(c.vencimento + "T23:59:59");
              if (new Date() > venc) {
                update["boletoStatus"] = "VENCIDO";
              }
            }
          }

          if (Object.keys(update).length > 0) {
            await prisma.cobranca.update({ where: { id: c.id }, data: update });
          }
          results.push({ id: c.id, pixStatus: update["pixStatus"] as string, boletoStatus: update["boletoStatus"] as string });
        } catch (e: any) {
          results.push({ id: c.id, error: String(e?.message ?? e) });
        }
      }

      return { atualizadas: results.length, resultados: results };
    }),

  // ── Relatório de cobranças ────────────────────────────────────────────────
  relatorio: authProc
    .input(z.object({
      emitenteId:   z.string().optional(),
      competencia:  z.string().optional(),
      dataInicio:   z.string().optional(), // "YYYY-MM-DD"
      dataFim:      z.string().optional(), // "YYYY-MM-DD"
    }))
    .query(async ({ input }) => {
      const where: Record<string, unknown> = {};
      if (input.emitenteId)  where["emitenteId"]  = input.emitenteId;
      if (input.competencia) where["competencia"] = input.competencia;
      if (input.dataInicio || input.dataFim) {
        where["vencimento"] = {
          ...(input.dataInicio ? { gte: input.dataInicio } : {}),
          ...(input.dataFim    ? { lte: input.dataFim    } : {}),
        };
      }

      const cobrancas = await prisma.cobranca.findMany({
        where,
        include: {
          emitente: { select: { id: true, nome: true, nomeFantasia: true } },
          contrato: { select: { id: true, nomeServico: true, tomador: { select: { nome: true } } } },
        },
        orderBy: { vencimento: "asc" },
      });

      // Totalizadores
      let totalValor        = 0;
      let totalPagoBoleto   = 0;
      let totalPagoPix      = 0;
      let qtdPagoBoleto     = 0;
      let qtdPagoPix        = 0;
      let qtdPendente       = 0;
      let qtdVencido        = 0;
      let qtdCancelado      = 0;

      for (const c of cobrancas) {
        totalValor += c.valor;
        if (c.boletoStatus === "PAGO") {
          qtdPagoBoleto++;
          totalPagoBoleto += c.boletoValorPago ?? c.valor;
        } else if (c.pixStatus === "PAGO") {
          qtdPagoPix++;
          totalPagoPix += c.valor;
        } else if (c.boletoStatus === "CANCELADO") {
          qtdCancelado++;
        } else if (c.boletoStatus === "VENCIDO") {
          qtdVencido++;
        } else {
          qtdPendente++;
        }
      }

      const hoje = new Date().toISOString().slice(0, 10);
      // Marcar como vencido localmente (sem salvar) as que passaram do prazo
      const cobrancasEnriquecidas = cobrancas.map(c => ({
        ...c,
        statusEfetivo: c.boletoStatus === "PAGO" || c.pixStatus === "PAGO"
          ? "PAGO"
          : c.boletoStatus === "CANCELADO"
          ? "CANCELADO"
          : c.vencimento < hoje
          ? "VENCIDO"
          : "PENDENTE",
      }));

      return {
        cobrancas: cobrancasEnriquecidas,
        totais: {
          quantidade:    cobrancas.length,
          totalValor,
          totalPago:     totalPagoBoleto + totalPagoPix,
          totalPendente: totalValor - totalPagoBoleto - totalPagoPix,
          qtdPago:       qtdPagoBoleto + qtdPagoPix,
          qtdPagoBoleto,
          qtdPagoPix,
          qtdPendente,
          qtdVencido,
          qtdCancelado,
        },
      };
    }),

  // ── Webhook PIX — registrar URL no Sicoob ────────────────────────────────
  registrarWebhook: authProc
    .input(z.object({ emitenteId: z.string(), webhookUrl: z.string().url() }))
    .mutation(async ({ input }) => {
      const emp = await prisma.empresaEmitente.findUniqueOrThrow({ where: { id: input.emitenteId } });
      await registrarWebhookPix(pixCfg(emp), input.webhookUrl);
      return { ok: true, webhookUrl: input.webhookUrl };
    }),

  consultarWebhook: authProc
    .input(z.object({ emitenteId: z.string() }))
    .query(async ({ input }) => {
      const emp = await prisma.empresaEmitente.findUniqueOrThrow({ where: { id: input.emitenteId } });
      return consultarWebhookPix(pixCfg(emp));
    }),

  // ── Excluir cobrança ──────────────────────────────────────────────────────
  excluir: authProc
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      return prisma.cobranca.delete({ where: { id: input.id } });
    }),
});
