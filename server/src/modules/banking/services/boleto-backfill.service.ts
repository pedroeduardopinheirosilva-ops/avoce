import { prisma }                                     from "../../../db.js";
import { consultarBoleto, sicoobBoletoConfigurado }   from "../../../lib/sicoob-boleto.js";
import type { SicoobBoletoConfig }                    from "../../../lib/sicoob-boleto.js";
import { certPathForEmpresa }                         from "../../../upload.js";
import { fieldDecrypt }                               from "../../../lib/field-crypto.js";

type EmitenteBoleto = {
  id:                    string;
  boletoClientId:        string | null;
  boletoNumeroCliente:   string | null;
  boletoContaCorrente:   string | null;
  boletoModalidade:      string | null;
  boletoContratoCobranca: string | null;
  certPass:              string | null;
};

function boletoCfg(emp: EmitenteBoleto): SicoobBoletoConfig {
  return {
    clientId:         emp.boletoClientId ?? "",
    numeroCliente:    Number(emp.boletoNumeroCliente ?? 0),
    contaCorrente:    Number((emp.boletoContaCorrente ?? "0").replace(/\D/g, "")),
    codigoModalidade: Number(emp.boletoModalidade ?? 1),
    contratoCobranca: Number(emp.boletoContratoCobranca ?? 0),
    certPath:         certPathForEmpresa(emp.id),
    certPass:         fieldDecrypt(emp.certPass),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Consulta com retry p/ o rate limit do Sicoob ("Assembly Rate Limit", 429)
async function consultarComRetry(cfg: SicoobBoletoConfig, nossoNumero: number) {
  const waits = [0, 3000, 8000];
  for (let i = 0; i < waits.length; i++) {
    if (waits[i] > 0) await sleep(waits[i]);
    try {
      return await consultarBoleto(cfg, nossoNumero);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("429") || i === waits.length - 1) throw err;
    }
  }
  throw new Error("unreachable");
}

/**
 * Preenche boletoPagoEm/boletoValorPago de boletos já PAGOS que estão sem a
 * data de pagamento (importados do histórico, ou marcados PAGO por outro
 * caminho). A data real vem da consulta do boleto no Sicoob e é o que permite
 * conciliar os créditos "CRÉD.LIQUIDAÇÃO COBRANÇA" do extrato.
 */
export async function backfillBoletoPagamentos(
  emitenteId?: string
): Promise<{ examined: number; updated: number; errors: number }> {
  const cobrancas = await prisma.cobranca.findMany({
    where: {
      ...(emitenteId ? { emitenteId } : {}),
      boletoStatus:      "PAGO",
      boletoPagoEm:      null,
      boletoNossoNumero: { not: null },
    },
    include: { emitente: true },
  });

  const result = { examined: cobrancas.length, updated: 0, errors: 0 };
  if (cobrancas.length === 0) return result;

  // Cache de config por emitente (todas as cobranças costumam ser do mesmo)
  const cfgCache = new Map<string, SicoobBoletoConfig>();

  for (const c of cobrancas) {
    try {
      let cfg = cfgCache.get(c.emitenteId);
      if (!cfg) {
        cfg = boletoCfg(c.emitente as unknown as EmitenteBoleto);
        cfgCache.set(c.emitenteId, cfg);
      }
      if (!sicoobBoletoConfigurado(cfg)) continue;

      await sleep(400); // rate limit Sicoob
      const boleto = await consultarComRetry(cfg, c.boletoNossoNumero!);
      if (!boleto.dataPagamento) continue;

      await prisma.cobranca.update({
        where: { id: c.id },
        data: {
          boletoPagoEm: boleto.dataPagamento,
          ...(boleto.valorPago != null
            ? { boletoValorPago: Math.round(boleto.valorPago * 100) }
            : {}),
        },
      });
      result.updated += 1;
    } catch (err) {
      result.errors += 1;
      console.error(
        `[boleto-backfill] Erro ao consultar nossoNumero=${c.boletoNossoNumero} (cobranca ${c.id}):`,
        err instanceof Error ? err.message : err
      );
    }
  }

  if (result.updated > 0 || result.errors > 0) {
    console.log(
      `[boleto-backfill] ${result.updated}/${result.examined} boletos atualizados, ${result.errors} erros`
    );
  }
  return result;
}
