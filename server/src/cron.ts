// ─────────────────────────────────────────────────────────────────────────────
// Cron de emissão recorrente
// Roda todo dia às 07:00 e emite notas fiscais dos contratos cujo diaVencimento == hoje
// ─────────────────────────────────────────────────────────────────────────────

import cron                 from "node-cron";
import { prisma }           from "./db.js";
import { processarTimeoutsAgente, recuperarMensagensPerdidas, processarHandoffsAtrasados } from "./agent/cron-agent.js";
import { recordCronRun } from "./agent/cron-tracker.js";
import { emitirNfse, type EmpresaConfig } from "./lib/nfse.js";
import { certPathForEmpresa } from "./upload.js";
import { consultarPix }     from "./lib/sicoob-pix.js";
import { criarPix, sicoobPixConfigurado } from "./lib/sicoob-pix.js";
import { criarBoleto, sicoobBoletoConfigurado } from "./lib/sicoob-boleto.js";
import { enviarEmailNfse }  from "./lib/email.js";
import { enviarEmailCobranca } from "./lib/email-cobranca.js";

function competenciaAtual(): string {
  const d = new Date();
  return `${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
}

async function getCfg(emp: {
  id: string; cnpj: string; inscricaoMunicipal: string;
  aliquotaIss: number; itemListaServico: string; codTributacao: string; regime: string;
  certPass: string | null;
  codigoServicoNacional?: string | null;
  codigoNbs?: string | null;
  regimeTributacao?: string | null;
}): Promise<EmpresaConfig> {
  return {
    cnpj:                   emp.cnpj,
    inscricaoMunicipal:     emp.inscricaoMunicipal,
    certPath:               certPathForEmpresa(emp.id),
    certPass:               emp.certPass ?? process.env[`CERT_PASS_${emp.id}`] ?? process.env.CERT_PASS_DEFAULT ?? "",
    aliquotaIss:            emp.aliquotaIss,
    itemListaServico:       emp.itemListaServico,
    codTributacao:          emp.codTributacao,
    codigoServicoNacional:  emp.codigoServicoNacional ?? undefined,
    codigoNbs:              emp.codigoNbs ?? undefined,
    regimeTributacao:       emp.regimeTributacao ?? undefined,
    simplesNacional:        emp.regime,
  };
}

export async function emitirContratosDoDia(): Promise<void> {
  const hoje        = new Date().getDate();
  const competencia = competenciaAtual();

  console.log(`[CRON] Verificando faturamento automático — dia=${hoje} competencia=${competencia}`);

  // Emitentes com faturamento automático ativo e dia de emissão = hoje
  const emitentes = await prisma.empresaEmitente.findMany({
    where: { faturamentoAutoAtivo: true, diaEmissaoNfse: hoje },
    select: { id: true, nome: true },
  });

  if (!emitentes.length) {
    console.log("[CRON] Nenhum emitente com faturamento automático configurado para hoje");
    return;
  }

  console.log(`[CRON] ${emitentes.length} emitente(s) com faturamento automático hoje`);

  const contratos = await prisma.contrato.findMany({
    where: {
      ativo: true,
      emitirNfseAuto: true,
      emitenteId: { in: emitentes.map((e) => e.id) },
    },
    include: { emitente: true, tomador: true },
  });

  console.log(`[CRON] ${contratos.length} contrato(s) para processar`);

  for (const contrato of contratos) {
    // Pula se já emitida neste mês
    const jaEmitida = await prisma.notaFiscal.findFirst({
      where: {
        contratoId:  contrato.id,
        competencia,
        status: { in: ["EMITIDA", "PENDENTE"] },
      },
    });
    if (jaEmitida) {
      console.log(`[CRON] Contrato ${contrato.id} já processado em ${competencia}, pulando`);
      continue;
    }

    // Para contratos parcelados, verifica se já atingiu o total de parcelas
    if ((contrato as any).tipoContrato === "PARCELADO" && (contrato as any).totalParcelas) {
      const emitidas = await prisma.notaFiscal.count({
        where: { contratoId: contrato.id, status: { in: ["EMITIDA", "PENDENTE"] } },
      });
      if (emitidas >= (contrato as any).totalParcelas) {
        console.log(`[CRON] Contrato ${contrato.id} atingiu ${emitidas}/${(contrato as any).totalParcelas} parcelas — suspendendo`);
        await prisma.contrato.update({ where: { id: contrato.id }, data: { ativo: false } });
        continue;
      }
    }

    // Cria registro PENDENTE
    const nota = await prisma.notaFiscal.create({
      data: {
        contratoId: contrato.id,
        emitenteId: contrato.emitenteId,
        competencia,
        valor:      contrato.valor,
        status:     "PENDENTE",
      },
    });

    try {
      const cfg    = await getCfg(contrato.emitente);
      const [mm, yyyy] = competencia.split("/");
      const result = await emitirNfse(contrato.emitenteId, cfg, {
        valor:         contrato.valor,
        discriminacao: contrato.descricaoServico,
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
        competencia: `${yyyy}-${mm}`,
        issRetido:   contrato.issRetido,
      });

      await prisma.notaFiscal.update({
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

      console.log(`[CRON] ✓ Nota ${result.numero} emitida — contrato ${contrato.id} empresa ${contrato.emitente.nome}`);

      // Enviar e-mail (assíncrono — não bloqueia o cron)
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
        discriminacao: contrato.descricaoServico,
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
      }).catch(e => console.error(`[CRON] Email falhou contrato ${contrato.id}:`, e));
    } catch (err) {
      const erroMsg = (err instanceof Error ? err.message : String(err)).slice(0, 1000);
      await prisma.notaFiscal.update({
        where: { id: nota.id },
        data:  { status: "ERRO", erroMsg },
      });
      console.error(`[CRON] ✗ Erro contrato ${contrato.id}: ${erroMsg}`);
    }
  }

  console.log(`[CRON] Faturamento automático concluído — ${contratos.length} contrato(s) processado(s)`);
}

// ── Geração automática de cobranças (PIX + Boleto) ──────────────────────────
// Roda todo dia às 07:00 junto com a emissão de NFS-e
// Processa contratos com gerarCobrancaAuto=true cujo diaVencimento == hoje

export async function gerarCobrancasDoDia(): Promise<void> {
  const hoje        = new Date().getDate();
  const competencia = competenciaAtual();

  // Calcular a data de vencimento (diaVencimento deste mês)
  const agora   = new Date();
  const vencDate = new Date(agora.getFullYear(), agora.getMonth(), hoje);
  const vencimento = vencDate.toISOString().slice(0, 10);

  const contratos = await prisma.contrato.findMany({
    where: { ativo: true, diaVencimento: hoje, gerarCobrancaAuto: true },
    include: { emitente: true, tomador: true },
  });

  if (!contratos.length) return;
  console.log(`[CRON-Cob] ${contratos.length} contrato(s) para gerar cobrança`);

  for (const contrato of contratos) {
    // Pula se já existe cobrança nesta competência ou neste vencimento
    const jaExiste = await prisma.cobranca.findFirst({
      where: {
        contratoId: contrato.id,
        OR: [{ competencia }, { vencimento }],
      },
    });
    if (jaExiste) {
      console.log(`[CRON-Cob] Contrato ${contrato.id} já tem cobrança em ${competencia} / vencimento ${vencimento}, pulando`);
      continue;
    }

    // Para contratos parcelados, verifica se já atingiu o total de parcelas
    if ((contrato as any).tipoContrato === "PARCELADO" && (contrato as any).totalParcelas) {
      const geradas = await prisma.cobranca.count({ where: { contratoId: contrato.id } });
      if (geradas >= (contrato as any).totalParcelas) {
        console.log(`[CRON-Cob] Contrato ${contrato.id} atingiu ${geradas}/${(contrato as any).totalParcelas} parcelas — suspendendo`);
        await prisma.contrato.update({ where: { id: contrato.id }, data: { ativo: false } });
        continue;
      }
    }

    // Criar registro de cobrança
    const cobranca = await prisma.cobranca.create({
      data: {
        contratoId:  contrato.id,
        emitenteId:  contrato.emitenteId,
        competencia,
        valor:       contrato.valor,
        vencimento,
      },
    });

    const pCfg = {
      clientId: contrato.emitente.pixClientId ?? "",
      pixChave: contrato.emitente.pixChave || contrato.emitente.cnpj.replace(/\D/g, ""),
      certPath: certPathForEmpresa(contrato.emitente.id),
      certPass: contrato.emitente.certPass ?? "",
    };
    const bCfg = {
      clientId:         contrato.emitente.boletoClientId         ?? "",
      numeroCliente:    Number(contrato.emitente.boletoNumeroCliente ?? 0),
      contaCorrente:    Number((contrato.emitente.boletoContaCorrente ?? "0").replace(/\D/g, "")),
      codigoModalidade: Number(contrato.emitente.boletoModalidade ?? 1),
      contratoCobranca: Number(contrato.emitente.boletoContratoCobranca ?? 0),
      certPath: certPathForEmpresa(contrato.emitente.id),
      certPass: contrato.emitente.certPass ?? "",
    };

    let pixData:    Awaited<ReturnType<typeof criarPix>>    | null = null;
    let boletoData: Awaited<ReturnType<typeof criarBoleto>> | null = null;

    // PIX
    if (sicoobPixConfigurado(pCfg)) {
      try {
        const descPix = `${contrato.nomeServico || "Serviços"} ${competencia}`.slice(0, 140);
        const dtVenc  = new Date(vencimento + "T12:00:00Z");
        const TRINTA_DIAS = 30 * 24 * 60 * 60;
        const expiracao = Math.max(TRINTA_DIAS, Math.floor((dtVenc.getTime() - Date.now()) / 1000) + TRINTA_DIAS);
        pixData = await criarPix(pCfg, { valor: contrato.valor, descricao: descPix, referencia: cobranca.id, expiracao });
      } catch (e) { console.error(`[CRON-Cob] PIX falhou contrato ${contrato.id}:`, e); }
    }

    // Boleto
    if (sicoobBoletoConfigurado(bCfg)) {
      try {
        boletoData = await criarBoleto(bCfg, {
          valor:          contrato.valor,
          dataVencimento: vencimento,
          seuNumero:      cobranca.id.slice(0, 15),
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
      } catch (e) { console.error(`[CRON-Cob] Boleto falhou contrato ${contrato.id}:`, e); }
    }

    // Atualizar com PIX e boleto gerados
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

    console.log(`[CRON-Cob] ✓ Cobrança gerada — contrato ${contrato.id} empresa ${contrato.emitente.nome}`);

    // Enviar e-mail com carta + boleto
    enviarEmailCobranca(cobranca.id).catch(e =>
      console.error(`[CRON-Cob] Email falhou contrato ${contrato.id}:`, e)
    );
  }

  console.log("[CRON-Cob] Geração de cobranças concluída");
}

// ── Polling de status PIX pendentes (fallback para webhook) ──────────────────
// Roda a cada 15 minutos e atualiza cobranças com PIX PENDENTE não expirados.

export async function pollarPixPendentes(): Promise<void> {
  const agora = new Date();
  const cobrancas = await prisma.cobranca.findMany({
    where: {
      pixStatus: "PENDENTE",
      pixTxid:   { not: null },
      OR: [
        { pixExpiresAt: null },
        { pixExpiresAt: { gt: agora } },
      ],
    },
    include: { emitente: true },
  });

  if (!cobrancas.length) return;
  console.log(`[PIX-Poll] Verificando ${cobrancas.length} PIX(s) pendentes`);

  for (const c of cobrancas) {
    if (!c.pixTxid) continue;
    try {
      const cfg = {
        clientId: c.emitente.pixClientId ?? "",
        pixChave: c.emitente.pixChave    ?? "",
        certPath: certPathForEmpresa(c.emitente.id),
        certPass: c.emitente.certPass ?? process.env[`CERT_PASS_${c.emitente.id}`] ?? "",
      };
      const status = await consultarPix(cfg, c.pixTxid);
      if (status.status === "PAGO") {
        await prisma.cobranca.update({
          where: { id: c.id },
          data: {
            pixStatus:     "PAGO",
            pixPagoEm:     status.paidAt ?? agora,
            pixPagadorNome: status.pagador ?? null,
            pixPagadorDoc:  status.pagadorCpfCnpj ?? null,
            pixEndToEndId:  status.endToEnd ?? null,
          },
        });
        console.log(`[PIX-Poll] Cobrança ${c.id} marcada como PAGA (txid=${c.pixTxid})`);
      } else if (status.status === "EXPIRADO") {
        await prisma.cobranca.update({
          where: { id: c.id },
          data:  { pixStatus: "EXPIRADO" },
        });
      }
    } catch (err) {
      console.error(`[PIX-Poll] Erro ao consultar txid=${c.pixTxid}:`, err);
    }
  }
}

export function iniciarCron(): void {
  // Todo dia às 07:00 — emitir NFS-e automáticas + gerar cobranças
  cron.schedule("0 7 * * *", async () => {
    try {
      await emitirContratosDoDia();
    } catch (err) {
      console.error("[CRON] Erro crítico:", err);
    }
    try {
      await gerarCobrancasDoDia();
    } catch (err) {
      console.error("[CRON-Cob] Erro crítico:", err);
    }
  });

  // A cada 5 minutos — handoffs atrasados (Ana→Daniela sem intro)
  cron.schedule("*/5 * * * *", async () => {
    try {
      await processarHandoffsAtrasados();
      recordCronRun("processarHandoffsAtrasados");
    } catch (err) {
      console.error("[CronAgent] Erro ao processar handoffs:", err);
    }
  });

  // A cada 15 minutos — consultar PIX pendentes + verificar timeouts do agente IA
  cron.schedule("*/15 * * * *", async () => {
    try {
      await pollarPixPendentes();
    } catch (err) {
      console.error("[PIX-Poll] Erro crítico:", err);
    }
    try {
      await processarTimeoutsAgente();
      recordCronRun("processarTimeoutsAgente");
    } catch (err) {
      console.error("[CronAgent] Erro crítico:", err);
    }
    try {
      await recuperarMensagensPerdidas();
      recordCronRun("recuperarMensagensPerdidas");
    } catch (err) {
      console.error("[CronAgent] Erro ao recuperar mensagens perdidas:", err);
    }
  });

  console.log("[CRON] Agendado: Notas às 07:00 | PIX poll + Agente IA a cada 15 min | Handoffs a cada 5 min");
}
