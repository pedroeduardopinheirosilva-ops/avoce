// Lógica de geração de cobrança compartilhada entre o cron e o faturarLote manual.

import { prisma }          from "../db.js";
import { criarPix, sicoobPixConfigurado }    from "./sicoob-pix.js";
import { criarBoleto, sicoobBoletoConfigurado } from "./sicoob-boleto.js";
import { certPathForEmpresa }                from "../upload.js";
import { calcularRetencoes }                 from "./nfse.js";
import { enviarEmailCobranca }               from "./email-cobranca.js";
import { fieldDecrypt }                      from "./field-crypto.js";
import type { Prisma }                       from "@prisma/client";

type ContratoComRelacoes = Prisma.ContratoGetPayload<{
  include: { emitente: true; tomador: true };
}>;

export type ResultadoCobranca = {
  cobrancaId: string;
  comPix:     boolean;
  comBoleto:  boolean;
};

/**
 * Gera registro de cobrança (PIX e/ou Boleto) para um contrato.
 * Não verifica duplicata — o chamador deve garantir que não existe cobrança no mês.
 */
export async function gerarCobrancaParaContrato(
  contrato:   ContratoComRelacoes,
  competencia: string,
  vencimento:  string,
  enviarEmail: boolean = true,
): Promise<ResultadoCobranca> {
  const metodoCobr = (contrato as any).metodoCobr as string ?? "PIX_BOLETO";
  const comPix     = metodoCobr === "PIX_BOLETO" || metodoCobr === "PIX";
  const comBoleto  = metodoCobr === "PIX_BOLETO" || metodoCobr === "BOLETO";

  // Havendo retenção, quem paga o tributo é o tomador: a NFS-e continua sendo
  // emitida pelo valor cheio (ValorServicos) e a cobrança sai pelo líquido —
  // mesmo valor que aparece como "Valor Líquido" no DANFSE.
  const { total: retido, liquido: valorCobranca } = calcularRetencoes(contrato.valor, {
    aliquotaIss: contrato.emitente.aliquotaIss,
    issRetido:   contrato.issRetido || contrato.tomador.issRetido,
    retirIr:     contrato.retirIr,
    retirCsll:   contrato.retirCsll,
    retirPis:    contrato.retirPis,
    retirCofins: contrato.retirCofins,
  });

  if (retido > 0) {
    console.log(`[Cobrança] Contrato ${contrato.id}: retenção de ${(retido / 100).toFixed(2)} — cobrando líquido ${(valorCobranca / 100).toFixed(2)} sobre bruto ${(contrato.valor / 100).toFixed(2)}`);
  }

  const cobranca = await prisma.cobranca.create({
    data: {
      contratoId:  contrato.id,
      emitenteId:  contrato.emitenteId,
      competencia,
      valor:       valorCobranca,
      vencimento,
    },
  });

  const pCfg = {
    clientId: contrato.emitente.pixClientId ?? "",
    pixChave: contrato.emitente.pixChave || contrato.emitente.cnpj.replace(/\D/g, ""),
    certPath: certPathForEmpresa(contrato.emitente.id),
    certPass: fieldDecrypt(contrato.emitente.certPass),
  };
  const bCfg = {
    clientId:         contrato.emitente.boletoClientId         ?? "",
    numeroCliente:    Number(contrato.emitente.boletoNumeroCliente  ?? 0),
    contaCorrente:    Number((contrato.emitente.boletoContaCorrente ?? "0").replace(/\D/g, "")),
    codigoModalidade: Number(contrato.emitente.boletoModalidade     ?? 1),
    contratoCobranca: Number(contrato.emitente.boletoContratoCobranca ?? 0),
    certPath: certPathForEmpresa(contrato.emitente.id),
    certPass: fieldDecrypt(contrato.emitente.certPass),
  };

  let pixData:    Awaited<ReturnType<typeof criarPix>>    | null = null;
  let boletoData: Awaited<ReturnType<typeof criarBoleto>> | null = null;

  if (comPix && sicoobPixConfigurado(pCfg)) {
    try {
      const descPix     = `${contrato.nomeServico || "Serviços"} ${competencia}`.slice(0, 140);
      const dtVenc      = new Date(vencimento + "T12:00:00Z");
      const TRINTA_DIAS = 30 * 24 * 60 * 60;
      const expiracao   = Math.max(TRINTA_DIAS, Math.floor((dtVenc.getTime() - Date.now()) / 1000) + TRINTA_DIAS);
      pixData = await criarPix(pCfg, { valor: valorCobranca, descricao: descPix, referencia: cobranca.id, expiracao });
    } catch (e) { console.error(`[Cobrança] PIX falhou contrato ${contrato.id}:`, e); }
  }

  if (comBoleto && sicoobBoletoConfigurado(bCfg)) {
    try {
      boletoData = await criarBoleto(bCfg, {
        valor:           valorCobranca,
        dataVencimento:  vencimento,
        seuNumero:       cobranca.id.slice(0, 15),
        instrucoes:      [`Ref: ${competencia} — ${contrato.nomeServico || contrato.emitente.nome}`],
        comPix:          false,
        multaPercent:    contrato.emitente.boletoMultaPercent    ?? 2,
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
    } catch (e) { console.error(`[Cobrança] Boleto falhou contrato ${contrato.id}:`, e); }
  }

  await prisma.cobranca.update({
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

  if (enviarEmail) {
    enviarEmailCobranca(cobranca.id).catch(e =>
      console.error(`[Cobrança] Email falhou contrato ${contrato.id}:`, e)
    );
  }

  return { cobrancaId: cobranca.id, comPix: !!pixData, comBoleto: !!boletoData };
}
