import { z }                from "zod";
import { router, authProc } from "./trpc.js";
import { prisma }           from "../db.js";
import { whereEmitenteFilter, assertEmitenteAccess } from "./tenant-utils.js";
import { criarPix, consultarPix, registrarWebhookPix, consultarWebhookPix, sicoobPixConfigurado } from "../lib/sicoob-pix.js";
import type { SicoobPixConfig }    from "../lib/sicoob-pix.js";
import { criarBoleto, consultarBoleto, baixarBoleto, sicoobBoletoConfigurado } from "../lib/sicoob-boleto.js";
import type { SicoobBoletoConfig } from "../lib/sicoob-boleto.js";
import { renderTemplate }          from "../lib/template.js";
import { certPathForEmpresa }      from "../upload.js";
import { enviarEmailCobranca }     from "../lib/email-cobranca.js";
import { fieldDecrypt }           from "../lib/field-crypto.js";

type Emitente = Awaited<ReturnType<typeof prisma.empresaEmitente.findUniqueOrThrow>>;

function pixCfg(emp: Emitente): SicoobPixConfig {
  return {
    clientId: emp.pixClientId ?? "",
    pixChave: emp.pixChave || emp.cnpj.replace(/\D/g, ""),
    certPath: certPathForEmpresa(emp.id),
    certPass: fieldDecrypt(emp.certPass),
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
    .query(async ({ input, ctx }) => {
      const emitenteFilter = whereEmitenteFilter(ctx);
      const where = {
        ...emitenteFilter,
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
    .mutation(async ({ input, ctx }) => {
      const contrato = await prisma.contrato.findUniqueOrThrow({
        where: { id: input.contratoId },
        include: { emitente: true, tomador: true },
      });
      assertEmitenteAccess(ctx, contrato.emitenteId);

      // Bloquear duplicata por vencimento — sempre, mesmo com forcar=true
      const duplicataVenc = await prisma.cobranca.findFirst({
        where: { contratoId: input.contratoId, vencimento: input.vencimento },
      });
      if (duplicataVenc) throw new Error(`Já existe cobrança com vencimento ${input.vencimento} para este contrato`);

      // Duplicata por competência. Mesmo com forcar=true NÃO permitimos criar uma
      // segunda cobrança quando já existe uma com boleto ou PIX ATIVO na mesma
      // competência — foi assim que nasceram os boletos duplicados de 15/06 (o
      // modal "Gerar e Abrir" envia forcar:true). O forcar só libera quando a
      // cobrança existente não tem nada ativo (ex.: boleto cancelado / geração
      // anterior que falhou e não chegou a registrar boleto/PIX).
      const existente = await prisma.cobranca.findFirst({
        where: { contratoId: input.contratoId, competencia: input.competencia },
      });
      if (existente) {
        const boletoAtivo = !!existente.boletoNossoNumero && existente.boletoStatus !== "CANCELADO";
        const pixAtivo    = !!existente.pixTxid && existente.pixStatus !== "CANCELADO";
        if (boletoAtivo || pixAtivo) {
          throw new Error(
            `Já existe cobrança ativa para ${input.competencia} neste contrato (boleto/PIX em aberto). ` +
            `Cancele ou altere a cobrança existente antes de gerar outra — evita duplicar no banco.`,
          );
        }
        if (!input.forcar) {
          throw new Error(`Já existe cobrança para ${input.competencia}`);
        }
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
    .mutation(async ({ input, ctx }) => {
      const c = await prisma.cobranca.findUniqueOrThrow({ where: { id: input.id }, select: { emitenteId: true } });
      assertEmitenteAccess(ctx, c.emitenteId);
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
    .mutation(async ({ input, ctx }) => {
      const emitenteFilter = whereEmitenteFilter(ctx);
      const where = input.id
        ? { id: input.id }
        : {
            ...emitenteFilter,
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
    .query(async ({ input, ctx }) => {
      const emitenteFilter = whereEmitenteFilter(ctx);
      const where: Record<string, unknown> = { ...emitenteFilter };
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
        } else if (c.baixaManualStatus === "PAGO") {
          qtdPagoPix++; // contabiliza junto com PIX no total
          totalPagoPix += c.baixaManualValorPago ?? c.valor;
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
        statusEfetivo: c.boletoStatus === "PAGO" || c.pixStatus === "PAGO" || c.baixaManualStatus === "PAGO"
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
    .mutation(async ({ input, ctx }) => {
      const emp = await prisma.empresaEmitente.findUniqueOrThrow({ where: { id: input.emitenteId } });
      assertEmitenteAccess(ctx, emp.id);
      await registrarWebhookPix(pixCfg(emp), input.webhookUrl);
      return { ok: true, webhookUrl: input.webhookUrl };
    }),

  consultarWebhook: authProc
    .input(z.object({ emitenteId: z.string() }))
    .query(async ({ input, ctx }) => {
      const emp = await prisma.empresaEmitente.findUniqueOrThrow({ where: { id: input.emitenteId } });
      assertEmitenteAccess(ctx, emp.id);
      return consultarWebhookPix(pixCfg(emp));
    }),

  // ── Cancelar boleto no Sicoob ─────────────────────────────────────────────
  cancelarBoleto: authProc
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const c = await prisma.cobranca.findUniqueOrThrow({
        where: { id: input.id },
        include: { emitente: true },
      });
      assertEmitenteAccess(ctx, c.emitenteId);

      if (!c.boletoNossoNumero) throw new Error("Cobrança não possui boleto registrado");
      if (c.boletoStatus === "PAGO")      throw new Error("Boleto já pago — não pode ser cancelado");
      if (c.boletoStatus === "CANCELADO") throw new Error("Boleto já cancelado");

      const bCfg = boletoCfg(c.emitente);
      if (!sicoobBoletoConfigurado(bCfg)) throw new Error("Sicoob Boleto não configurado para esta empresa");

      await baixarBoleto(bCfg, c.boletoNossoNumero);

      return prisma.cobranca.update({
        where: { id: c.id },
        data: { boletoStatus: "CANCELADO" },
      });
    }),

  // ── Alterar valor (cancela boleto, recria com novo valor) ─────────────────
  alterarValor: authProc
    .input(z.object({
      id:             z.string(),
      novoValor:      z.number().int().positive(),       // em centavos
      novoVencimento: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      enviarEmail:    z.boolean().default(true),
    }))
    .mutation(async ({ input, ctx }) => {
      const c = await prisma.cobranca.findUniqueOrThrow({
        where: { id: input.id },
        include: { emitente: true, contrato: { include: { tomador: true } } },
      });
      assertEmitenteAccess(ctx, c.emitenteId);

      if (c.boletoStatus === "PAGO") throw new Error("Boleto já pago — não é possível alterar");

      const bCfg = boletoCfg(c.emitente);
      if (!sicoobBoletoConfigurado(bCfg)) throw new Error("Sicoob Boleto não configurado para esta empresa");

      // Baixar boleto existente se ainda estiver ativo. NÃO engolir a falha: se o
      // baixar não confirmar, abortamos — caso contrário o boleto antigo continua
      // ativo no Sicoob e o novo é criado por cima, gerando cobrança duplicada
      // (foi assim que o nossoNumero 81 ficou órfão).
      if (c.boletoNossoNumero && c.boletoStatus !== "CANCELADO") {
        try {
          await baixarBoleto(bCfg, c.boletoNossoNumero);
        } catch (e) {
          // Tolerar apenas quando o boleto já está efetivamente baixado/cancelado no Sicoob.
          let jaBaixado = false;
          try {
            const st = await consultarBoleto(bCfg, c.boletoNossoNumero);
            jaBaixado = /baixad|cancelad|liquidad|pago/i.test(st.situacao);
          } catch { /* ignora erro de consulta */ }
          if (!jaBaixado) {
            throw new Error(
              `Falha ao cancelar o boleto anterior ${c.boletoNossoNumero} no Sicoob — alteração abortada para não duplicar a cobrança. Detalhe: ${(e as Error).message}`,
            );
          }
        }
      }

      const vencimento = input.novoVencimento ?? c.vencimento;

      // Atualizar valor e vencimento no DB, limpar dados do boleto anterior
      await prisma.cobranca.update({
        where: { id: c.id },
        data: {
          valor:                input.novoValor,
          vencimento,
          boletoNossoNumero:    null,
          boletoLinhaDigitavel: null,
          boletoCodigoBarras:   null,
          boletoUrlPdf:         null,
          boletoStatus:         "AGUARDANDO",
        },
      });

      // Recriar boleto com novo valor
      const instrucoes = [
        `Ref: ${c.competencia} — ${c.contrato.nomeServico || c.emitente.nome}`,
        `Vencimento: ${vencimento}`,
      ];

      let boletoData: Awaited<ReturnType<typeof criarBoleto>> | null = null;
      try {
        boletoData = await criarBoleto(bCfg, {
          valor:          input.novoValor,
          dataVencimento: vencimento,
          seuNumero:      c.id.slice(0, 15),
          instrucoes,
          comPix:         false,
          multaPercent:   c.emitente.boletoMultaPercent    ?? 2,
          jurosDiaPercent: c.emitente.boletoJurosDiaPercent ?? 0.033,
          pagador: {
            nome:     c.contrato.tomador.nome,
            cpfCnpj:  c.contrato.tomador.cpfCnpj,
            endereco: c.contrato.tomador.endereco || "Endereço não informado",
            bairro:   c.contrato.tomador.bairro   || "Centro",
            cidade:   c.contrato.tomador.cidade   || "Vitória da Conquista",
            uf:       c.contrato.tomador.uf       || "BA",
            cep:      c.contrato.tomador.cep      || "45000000",
            email:    c.contrato.tomador.email    ?? undefined,
          },
        });
      } catch (e) {
        console.error("[Cobrança] Falha ao recriar boleto:", e);
        throw new Error(`Valor atualizado mas falha ao emitir novo boleto: ${(e as Error).message}`);
      }

      const cobAtualizada = await prisma.cobranca.update({
        where: { id: c.id },
        data: {
          boletoNossoNumero:    boletoData.nossoNumero,
          boletoLinhaDigitavel: boletoData.linhaDigitavel,
          boletoCodigoBarras:   boletoData.codigoBarras,
          boletoUrlPdf:         boletoData.urlPdf ?? null,
        },
      });

      if (input.enviarEmail) {
        enviarEmailCobranca(cobAtualizada.id).catch(err =>
          console.error(`[Email-Cob] Erro ao reenviar após alteração ${cobAtualizada.id}:`, err)
        );
      }

      return cobAtualizada;
    }),

  // ── Excluir cobrança ──────────────────────────────────────────────────────
  excluir: authProc
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const c = await prisma.cobranca.findUniqueOrThrow({ where: { id: input.id }, include: { emitente: true } });
      assertEmitenteAccess(ctx, c.emitenteId);

      // Cancelar (baixar) o boleto no Sicoob ANTES de excluir. Caso contrário, o
      // boleto continua ativo no banco sem registro no Avoce — vira boleto órfão
      // e o cliente recebe cobrança duplicada. (Foi assim que os nossoNumero 91 e
      // 124 ficaram órfãos no faturamento 06/2026.)
      if (c.boletoNossoNumero && c.boletoStatus !== "PAGO" && c.boletoStatus !== "CANCELADO") {
        const bCfg = boletoCfg(c.emitente);
        if (sicoobBoletoConfigurado(bCfg)) {
          try {
            await baixarBoleto(bCfg, c.boletoNossoNumero);
          } catch (e) {
            throw new Error(
              `Falha ao cancelar o boleto ${c.boletoNossoNumero} no Sicoob — exclusão abortada para evitar boleto órfão. ` +
              `Cancele o boleto primeiro ou verifique o Sicoob. Detalhe: ${(e as Error).message}`,
            );
          }
        }
      }

      return prisma.cobranca.delete({ where: { id: input.id } });
    }),

  // ── Baixa manual (depósito / PIX avulso) ─────────────────────────────────
  baixaManual: authProc
    .input(z.object({
      id:               z.string(),
      formaPagamento:   z.enum(["PIX", "DEPOSITO", "TRANSFERENCIA", "OUTRO"]),
      valorPago:        z.number().int().positive(),
      dataRecebimento:  z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      pagadorNome:      z.string().optional(),
      pagadorDoc:       z.string().optional(),
      banco:            z.string().optional(),
      obs:              z.string().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const c = await prisma.cobranca.findUniqueOrThrow({
        where: { id: input.id },
        select: { emitenteId: true, pixStatus: true, boletoStatus: true, baixaManualStatus: true },
      });
      assertEmitenteAccess(ctx, c.emitenteId);

      if (c.pixStatus === "PAGO" || c.boletoStatus === "PAGO") {
        throw new Error("Cobrança já registrada como paga (via Sicoob)");
      }
      if (c.baixaManualStatus === "PAGO") {
        throw new Error("Baixa manual já registrada para esta cobrança");
      }

      const usuario = await prisma.usuario.findUniqueOrThrow({
        where: { id: ctx.userId! },
        select: { nome: true, email: true },
      });

      const [cobranca] = await prisma.$transaction([
        prisma.cobranca.update({
          where: { id: input.id },
          data: {
            baixaManualStatus:          "PAGO",
            baixaManualEm:              new Date(),
            baixaManualPorId:           ctx.userId,
            baixaManualPorNome:         usuario.nome,
            baixaManualPorEmail:        usuario.email,
            baixaManualFormaPagamento:  input.formaPagamento,
            baixaManualValorPago:       input.valorPago,
            baixaManualDataRecebimento: input.dataRecebimento,
            baixaManualPagadorNome:     input.pagadorNome ?? null,
            baixaManualPagadorDoc:      input.pagadorDoc  ?? null,
            baixaManualBanco:           input.banco       ?? null,
            baixaManualObs:             input.obs         ?? null,
          },
        }),
        prisma.cobrancaBaixaLog.create({
          data: {
            cobrancaId:     input.id,
            acao:           "BAIXA_MANUAL",
            usuarioId:      ctx.userId!,
            usuarioNome:    usuario.nome,
            usuarioEmail:   usuario.email,
            formaPagamento: input.formaPagamento,
            valorPago:      input.valorPago,
            dataRecebimento: input.dataRecebimento,
            pagadorNome:    input.pagadorNome ?? null,
            pagadorDoc:     input.pagadorDoc  ?? null,
            banco:          input.banco       ?? null,
            obs:            input.obs         ?? null,
          },
        }),
      ]);

      return cobranca;
    }),

  // ── Estornar baixa manual ─────────────────────────────────────────────────
  estornarBaixaManual: authProc
    .input(z.object({ id: z.string(), obs: z.string().optional() }))
    .mutation(async ({ input, ctx }) => {
      const c = await prisma.cobranca.findUniqueOrThrow({
        where: { id: input.id },
        select: { emitenteId: true, baixaManualStatus: true },
      });
      assertEmitenteAccess(ctx, c.emitenteId);

      if (c.baixaManualStatus !== "PAGO") {
        throw new Error("Esta cobrança não possui baixa manual ativa");
      }

      const usuario = await prisma.usuario.findUniqueOrThrow({
        where: { id: ctx.userId! },
        select: { nome: true, email: true },
      });

      const [cobranca] = await prisma.$transaction([
        prisma.cobranca.update({
          where: { id: input.id },
          data: {
            baixaManualStatus:          "ESTORNADO",
            baixaManualEm:              null,
            baixaManualPorId:           null,
            baixaManualPorNome:         null,
            baixaManualPorEmail:        null,
            baixaManualFormaPagamento:  null,
            baixaManualValorPago:       null,
            baixaManualDataRecebimento: null,
            baixaManualPagadorNome:     null,
            baixaManualPagadorDoc:      null,
            baixaManualBanco:           null,
            baixaManualObs:             null,
          },
        }),
        prisma.cobrancaBaixaLog.create({
          data: {
            cobrancaId:   input.id,
            acao:         "ESTORNO_BAIXA_MANUAL",
            usuarioId:    ctx.userId!,
            usuarioNome:  usuario.nome,
            usuarioEmail: usuario.email,
            obs:          input.obs ?? null,
          },
        }),
      ]);

      return cobranca;
    }),

  // ── Histórico de baixas manuais ───────────────────────────────────────────
  historicoBaixa: authProc
    .input(z.object({ id: z.string() }))
    .query(async ({ input, ctx }) => {
      const c = await prisma.cobranca.findUniqueOrThrow({
        where: { id: input.id },
        select: { emitenteId: true },
      });
      assertEmitenteAccess(ctx, c.emitenteId);
      return prisma.cobrancaBaixaLog.findMany({
        where: { cobrancaId: input.id },
        orderBy: { criadoEm: "asc" },
      });
    }),
});
