// ─────────────────────────────────────────────────────────────────────────────
// Cron de emissão recorrente
// Roda todo dia às 07:00 e emite notas fiscais dos contratos cujo diaVencimento == hoje
// ─────────────────────────────────────────────────────────────────────────────

import cron                 from "node-cron";
import { prisma }           from "./db.js";
import { processarTimeoutsAgente, recuperarMensagensPerdidas, processarHandoffsAtrasados } from "./agent/cron-agent.js";
import { recordCronRun } from "./agent/cron-tracker.js";
import { emSilencio }       from "./agent/quiet-hours.js";
import { emitirNfse, type EmpresaConfig } from "./lib/nfse.js";
import { certPathForEmpresa } from "./upload.js";
import { consultarPix }     from "./lib/sicoob-pix.js";
import { gerarCobrancaParaContrato } from "./lib/gerar-cobranca.js";
import { enviarEmailCobranca }       from "./lib/email-cobranca.js";
import { fieldDecrypt }             from "./lib/field-crypto.js";

function competenciaAtual(): string {
  const d = new Date();
  return `${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
}

function ultimoDiaMes(ano: number, mes: number): number {
  return new Date(ano, mes + 1, 0).getDate();
}

function clampDia(dia: number, ano: number, mes: number): number {
  return Math.min(dia, ultimoDiaMes(ano, mes));
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
    certPass:               fieldDecrypt(emp.certPass) || process.env[`CERT_PASS_${emp.id}`] || process.env.CERT_PASS_DEFAULT || "",
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

    // Resolve valor: usa próxima parcela personalizada não-processada (se houver)
    let valorNota = contrato.valor;
    let parcelaCustomId: string | undefined;
    const parcelasCustom = await prisma.contratoParcelaPersonalizada.findMany({
      where: { contratoId: contrato.id },
      orderBy: { numero: "asc" },
    });
    if (parcelasCustom.length > 0) {
      const proxima = parcelasCustom.find(p => !p.processada);
      if (!proxima) {
        console.log(`[CRON] Contrato ${contrato.id} não tem mais parcelas — suspendendo`);
        await prisma.contrato.update({ where: { id: contrato.id }, data: { ativo: false } });
        continue;
      }
      valorNota    = proxima.valor;
      parcelaCustomId = proxima.id;
    } else if ((contrato as any).tipoContrato === "PARCELADO" && (contrato as any).totalParcelas) {
      // Para contratos parcelados sem parcelas customizadas, verifica limite
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
        valor:      valorNota,
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
        issRetido:   contrato.issRetido || contrato.tomador.issRetido,
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
      if (parcelaCustomId) {
        await prisma.contratoParcelaPersonalizada.update({
          where: { id: parcelaCustomId },
          data:  { processada: true },
        });
      }

      console.log(`[CRON] ✓ Nota ${result.numero} emitida — contrato ${contrato.id} empresa ${contrato.emitente.nome}`);
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
  const agora       = new Date();
  const hoje        = agora.getDate();
  const competencia = competenciaAtual();
  const ultimoDia   = ultimoDiaMes(agora.getFullYear(), agora.getMonth());
  const ehUltimoDia = hoje === ultimoDia;

  // Vencimento = hoje (já clampado ao último dia do mês pelo próprio "hoje")
  const vencDate   = new Date(agora.getFullYear(), agora.getMonth(), hoje);
  const vencimento = vencDate.toISOString().slice(0, 10);

  // No último dia do mês, também processa contratos cujo diaVencimento > hoje
  // (ex: dia 29 ou 30 em fevereiro com 28 dias)
  const diaVencFiltro = ehUltimoDia
    ? { gte: hoje }
    : hoje;

  const contratos = await prisma.contrato.findMany({
    where: { ativo: true, diaVencimento: diaVencFiltro, gerarCobrancaAuto: true },
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

    try {
      await gerarCobrancaParaContrato(contrato, competencia, vencimento);
      console.log(`[CRON-Cob] ✓ Cobrança gerada — contrato ${contrato.id} empresa ${contrato.emitente.nome}`);
    } catch (e) {
      console.error(`[CRON-Cob] Falha ao gerar cobrança contrato ${contrato.id}:`, e);
    }
  }

  // Parcelas personalizadas com dataVencimento = hoje
  const parcelasHoje = await prisma.contratoParcelaPersonalizada.findMany({
    where: { dataVencimento: vencimento, processada: false },
    include: { contrato: { include: { emitente: true, tomador: true } } },
  });

  for (const parcela of parcelasHoje) {
    const contrato = parcela.contrato;
    if (!contrato.ativo || !contrato.gerarCobrancaAuto) continue;

    const jaExiste = await prisma.cobranca.findFirst({
      where: { contratoId: contrato.id, OR: [{ competencia }, { vencimento }] },
    });
    if (jaExiste) continue;

    try {
      await gerarCobrancaParaContrato({ ...contrato, valor: parcela.valor }, competencia, vencimento);
      await prisma.contratoParcelaPersonalizada.update({
        where: { id: parcela.id },
        data:  { processada: true },
      });
      console.log(`[CRON-Cob] ✓ Cobrança parcela ${parcela.numero} — contrato ${contrato.id}`);
    } catch (e) {
      console.error(`[CRON-Cob] Falha parcela ${parcela.id}:`, e);
    }
  }

  console.log("[CRON-Cob] Geração de cobranças concluída");
}

// ── Reprocessamento de e-mails de cobrança (auto-cura) ───────────────────────
// Roda a cada 30 min. Reenvia automaticamente cobranças recentes cujo e-mail
// ficou PENDENTE ou FALHOU (ex.: SMTP fora do ar, Chromium indisponível no
// momento do faturamento). Assim, uma falha transitória no dia da emissão é
// corrigida sozinha nas horas seguintes, sem intervenção manual.
export async function reprocessarEmailsCobranca(): Promise<void> {
  const MAX_TENTATIVAS = 6;
  const JANELA_DIAS    = 15;
  const limite = new Date(Date.now() - JANELA_DIAS * 24 * 60 * 60 * 1000);

  const pendentes = await prisma.cobranca.findMany({
    where: {
      emailStatus:     { in: ["PENDENTE", "FALHA"] },
      emailTentativas: { lt: MAX_TENTATIVAS },
      criadoEm:        { gte: limite },
    },
    select: { id: true },
    orderBy: { criadoEm: "asc" },
    take: 100,
  });

  if (!pendentes.length) return;
  console.log(`[Email-Retry] Reprocessando ${pendentes.length} cobrança(s) com e-mail pendente/falha`);

  for (const c of pendentes) {
    await enviarEmailCobranca(c.id).catch((e) =>
      console.error(`[Email-Retry] Erro ao reenviar cobrança ${c.id}:`, e));
    await new Promise((r) => setTimeout(r, 1500)); // não sobrecarregar o SMTP
  }
  console.log("[Email-Retry] Reprocessamento concluído");
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
        certPass: fieldDecrypt(c.emitente.certPass) || process.env[`CERT_PASS_${c.emitente.id}`] || "",
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

type LembreteConfig = { horas: number; texto: string };

const DEFAULT_LEMBRETES: LembreteConfig[] = [
  { horas: 24, texto: "Oi {nome}! Aqui é a Ana, do escritório da Dra. Daniela. Só lembrando que sua reunião é *amanhã às {horario}h*. Acesse pelo link: {link} Qualquer dúvida me chama!" },
  { horas: 1,  texto: "Oi {nome}! Reunião com a Dra. Daniela em *1 hora* ({horario}h). Acesse pelo link: {link} Até já!" },
];

function parseLembretes(valor: string | null | undefined): LembreteConfig[] {
  if (!valor) return DEFAULT_LEMBRETES;
  try {
    const parsed = JSON.parse(valor);
    if (Array.isArray(parsed) && parsed.length > 0) return parsed as LembreteConfig[];
  } catch {}
  return DEFAULT_LEMBRETES;
}

async function enviarLembretesReuniao(): Promise<void> {
  const agora = new Date();
  const JANELA_MIN = 30; // ± minutes around the target time

  const reunioes = await (prisma.sessaoReuniao as any).findMany({
    where: {
      status: "agendada",
      agendadaPara: { gte: agora },
      dealId: { not: null },
    },
    select: {
      id: true,
      titulo: true,
      agendadaPara: true,
      dealId: true,
      tokenConvidado: true,
      deal: {
        select: {
          id: true,
          projetoId: true,
          iaFlowStepData: true,
          contato: { select: { nome: true, whatsapp: true } },
        },
      },
      contato: { select: { nome: true, whatsapp: true } },
    },
  });

  // Cache lembretes config per projetoId
  const lembretesCache = new Map<string, LembreteConfig[]>();
  const appBaseUrl = (process.env.APP_BASE_URL ?? "").replace(/\/$/, "");

  for (const r of reunioes) {
    const deal = r.deal;
    if (!deal?.projetoId) continue;
    const whatsapp = deal.contato?.whatsapp ?? r.contato?.whatsapp;
    if (!whatsapp) continue;

    const stepData = (deal.iaFlowStepData ?? {}) as Record<string, unknown>;
    const agendada = r.agendadaPara as Date;

    // Load lembretes for this project (cached)
    if (!lembretesCache.has(deal.projetoId)) {
      const cfg = await prisma.iaProjetoConfig.findFirst({
        where: { projetoId: deal.projetoId, chave: "reuniao_lembretes" },
      });
      lembretesCache.set(deal.projetoId, parseLembretes(cfg?.valor));
    }
    const lembretes = lembretesCache.get(deal.projetoId)!;

    // Janela de silêncio: nada de lembrete de madrugada (caso Edgar 9312 — reunião 09:30 e
    // lembrete disparado às 03:00). Sai sem marcar flag: o lembrete é retomado no primeiro
    // tick após o fim do silêncio, tratado como "vencido" logo abaixo.
    if (await emSilencio(deal.projetoId, agora)) continue;

    // Lembretes VENCIDOS (o horário-alvo já chegou ou passou) e ainda não enviados.
    // Antes a condição era uma janela de ±30min em torno do alvo; se o cron não pegasse
    // essa janela — silêncio, app reiniciando, reunião remarcada — o lembrete se perdia.
    const vencidos = lembretes
      .filter(l => !stepData[`_lembrete_${l.horas}h_enviado`])
      .filter(l => agendada.getTime() - agora.getTime() <= l.horas * 60 * 60 * 1000 + JANELA_MIN * 60 * 1000)
      .sort((a, b) => a.horas - b.horas);
    if (!vencidos.length) continue;

    // Só o mais próximo da reunião é enviado. Os outros vencidos são marcados como
    // suprimidos, senão ao sair do silêncio às 07:00 o lead levaria 3 lembretes seguidos.
    const [lembrete, ...suprimidos] = vencidos;
    const flagKey = `_lembrete_${lembrete.horas}h_enviado`;
    const flagsSuprimidas = Object.fromEntries(suprimidos.map(l => [`_lembrete_${l.horas}h_enviado`, true]));
    if (suprimidos.length) {
      console.log(`[Reuniao-Lembrete] Deal ${deal.id} — suprimidos ${suprimidos.map(l => `${l.horas}h`).join(", ")} (acumulados fora do horário de envio)`);
    }

    {

      const { getEvolutionConfig } = await import("./agent/message-handler.js");
      const evo = await getEvolutionConfig(deal.projetoId);
      if (!evo) continue;

      const { sendText } = await import("./services/evolution.js");
      const horarioFmt = agendada.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" });
      const horario = horarioFmt.split(" ")[1]?.slice(0, 5) ?? horarioFmt;
      const nome = deal.contato?.nome ?? "cliente";
      const link = r.tokenConvidado ? `${appBaseUrl}/sala/${r.tokenConvidado}` : "";
      // Nome de quem assina o lembrete vem do banco (IaPersona), nunca fixo no código.
      const { getPersonaNomeExibicao } = await import("./agent/transition-engine.js");
      const nomeSecretaria = await getPersonaNomeExibicao(deal.projetoId, "secretaria").catch(() => "");
      const nomeAssistente = await getPersonaNomeExibicao(deal.projetoId, "assistente").catch(() => "");
      const remetenteLembrete = nomeSecretaria || nomeAssistente || "Secretaria";
      const msg = lembrete.texto
        .replace(/\{nome\}/g, nome)
        .replace(/\{horario\}/g, horario)
        .replace(/\{link\}/g, link)
        .replace(/\{nome_secretaria\}/g, remetenteLembrete)
        .replace(/\{nome_assistente\}/g, nomeAssistente || remetenteLembrete);

      await sendText(evo, whatsapp, msg).catch(() => {});
      await prisma.crmMensagemWhatsapp.create({
        data: {
          dealId: deal.id,
          contatoId: undefined as any,
          direcao: "out",
          personaChave: "secretaria",
          remetente: remetenteLembrete,
          tipo: "text",
          conteudo: msg,
        },
      }).catch(() => {});

      await prisma.crmDeal.update({
        where: { id: deal.id },
        data: { iaFlowStepData: { ...stepData, ...flagsSuprimidas, [flagKey]: true } as any },
      }).catch(() => {});
      console.log(`[Reuniao-Lembrete] Deal ${deal.id} lembrete ${lembrete.horas}h enviado`);
    }
  }

  await alertarReunioesSemConfirmacao();
}

/**
 * Reunião perto da hora e o lead nunca deu sinal depois dos lembretes → avisa o SDR humano
 * enquanto ainda dá tempo de ligar. O no-show respondia por 34,7% das reuniões marcadas
 * (auditoria da planilha, 26/08/2026) e só 6% avisavam antes — o resto sumia no horário.
 *
 * O sinal usado é "respondeu alguma coisa depois do lembrete", não um "sim" explícito:
 * boa parte comparece sem nunca mandar confirmação, e exigir o "sim" geraria alarme falso.
 */
const HORAS_ALERTA_SEM_CONFIRMACAO = 3;

async function alertarReunioesSemConfirmacao(): Promise<void> {
  const agora = new Date();
  const limite = new Date(agora.getTime() + HORAS_ALERTA_SEM_CONFIRMACAO * 60 * 60 * 1000);

  const reunioes = await prisma.sessaoReuniao.findMany({
    where: { status: "agendada", agendadaPara: { gt: agora, lte: limite }, dealId: { not: null } },
    select: {
      id: true, agendadaPara: true, dealId: true,
      deal: { select: { id: true, projetoId: true, iaFlowStepData: true, contato: { select: { nome: true, whatsapp: true } } } },
    },
  });

  for (const r of reunioes) {
    const deal = r.deal;
    if (!deal?.projetoId) continue;

    const stepData = (deal.iaFlowStepData ?? {}) as Record<string, unknown>;
    if (stepData._alerta_sem_confirmacao_enviado) continue;   // um alerta por reunião
    if (stepData._reuniao_confirmada === true) continue;      // já confirmou

    const { respondeuAposLembrete } = await import("./agent/confirmacao-reuniao.js");
    if (await respondeuAposLembrete(deal.id).catch(() => true)) continue;  // deu sinal de vida

    const horario = (r.agendadaPara as Date).toLocaleString("pt-BR", {
      timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short",
    });
    const nome = deal.contato?.nome ?? "cliente";
    const fone = deal.contato?.whatsapp ?? "";

    let briefing = "";
    try {
      const { buildLeadBriefing } = await import("./agent/lead-briefing.js");
      briefing = await buildLeadBriefing(deal.id, {
        titulo: `⚠️ SEM CONFIRMAÇÃO — reunião às ${horario}`,
        acao: `Ligar AGORA para ${nome} (wa.me/${fone}) e confirmar presença antes do horário.`,
      }).catch(() => "");
    } catch { /* briefing é opcional — o alerta vale mesmo sem ele */ }

    const { dispararNotificacoes } = await import("./agent/message-handler.js");
    await dispararNotificacoes(deal.projetoId, "reuniao_sem_confirmacao", {
      nome, telefone: fone, horario, dealId: deal.id,
      briefing: briefing || `⚠️ ${nome} tem reunião às ${horario} e não confirmou presença.\nwa.me/${fone}`,
    }).catch(() => {});

    await prisma.crmDeal.update({
      where: { id: deal.id },
      data: { iaFlowStepData: { ...stepData, _alerta_sem_confirmacao_enviado: true } as any },
    }).catch(() => {});
    console.log(`[Reuniao-SemConfirmacao] Deal ${deal.id} (${nome}) — reunião ${horario} sem confirmação; SDR avisado`);
  }
}

/**
 * Detecta no-shows: reunião agendada cujo horário passou há 15+ min sem ninguém iniciar
 * (iniciadaEm é setado quando a sala abre — routers/reunioes.ts). Marca status="no_show",
 * avisa o SDR humano com briefing (momento de OURO para ligar) e envia mensagem empática
 * de reengajamento ao lead oferecendo reagendamento.
 */
async function detectarNoShows(): Promise<void> {
  const agora = new Date();
  const reunioes = await prisma.sessaoReuniao.findMany({
    where: {
      status: "agendada",
      iniciadaEm: null,
      dealId: { not: null },
      agendadaPara: {
        lt: new Date(agora.getTime() - 15 * 60 * 1000),
        gt: new Date(agora.getTime() - 48 * 60 * 60 * 1000), // não reprocessar histórico antigo
      },
    },
    select: {
      id: true, dealId: true, agendadaPara: true,
      deal: { select: { projetoId: true, contato: { select: { nome: true, whatsapp: true } } } },
    },
  });

  for (const r of reunioes) {
    const projetoId = r.deal?.projetoId;
    if (!projetoId || !r.dealId) continue;
    try {
      await prisma.sessaoReuniao.update({ where: { id: r.id }, data: { status: "no_show" } });

      const nome = r.deal?.contato?.nome ?? "Lead";
      const whatsapp = r.deal?.contato?.whatsapp ?? "";

      // 1) Avisar o SDR humano com briefing completo — ligar agora recupera a reunião.
      const { buildLeadBriefing } = await import("./agent/lead-briefing.js");
      const { dispararNotificacoes } = await import("./agent/message-handler.js");
      const briefing = await buildLeadBriefing(r.dealId, {
        titulo: "🚨 NO-SHOW NA REUNIÃO",
        acao: "LIGAR AGORA — lead não entrou na reunião; reagendar por voz",
      }).catch(() => `🚨 NO-SHOW — ${nome} (${whatsapp})`);
      dispararNotificacoes(projetoId, "reuniao_no_show", {
        nome, telefone: whatsapp, briefing, dealId: r.dealId,
      }).catch(() => {});

      // 2) Mensagem empática ao lead (configurável; sem tom de cobrança).
      const msgCfg = await prisma.iaProjetoConfig.findFirst({
        where: { projetoId, chave: "reuniao_noshow_msg_lead" },
      });
      const msgLead = (msgCfg?.valor ?? "").trim() ||
        "Oi {nome}! Vi que você não conseguiu entrar na reunião — acontece, sei que a rotina na estrada é corrida. Seu caso continua valendo e a gente segura seu horário. Me fala um dia e horário que fique bom pra você que eu já remarco, combinado?";
      if (whatsapp) {
        const { getEvolutionConfig } = await import("./agent/message-handler.js");
        const evo = await getEvolutionConfig(projetoId);
        if (evo) {
          const { sendText } = await import("./services/evolution.js");
          const texto = msgLead.replace(/\{nome\}/g, nome.split(" ")[0]);
          await sendText(evo, whatsapp, texto).catch(() => {});
          await prisma.crmMensagemWhatsapp.create({
            data: { dealId: r.dealId, direcao: "out", personaChave: "secretaria", remetente: "Ana", tipo: "text", conteudo: texto },
          }).catch(() => {});
        }
      }

      // 3) Reabrir o flow da secretaria para o reagendamento ser processado normalmente.
      await prisma.crmDeal.update({
        where: { id: r.dealId },
        data: { iaPersonaChave: "secretaria", iaFlowStepChave: null },
      }).catch(() => {});
      // Limpa a flag de reunião criada para o engine voltar a tratar mensagens do lead.
      const deal = await prisma.crmDeal.findUnique({ where: { id: r.dealId }, select: { iaFlags: true } });
      const flags = ((deal?.iaFlags as Record<string, unknown>) ?? {});
      delete flags._reuniao_criada;
      delete flags._reuniao_link;
      await prisma.crmDeal.update({ where: { id: r.dealId }, data: { iaFlags: flags as object } }).catch(() => {});

      await prisma.crmNota.create({
        data: { dealId: r.dealId, conteudo: `[IA] No-show detectado na reunião de ${r.agendadaPara?.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })} — SDR humano notificado, lead reengajado` },
      }).catch(() => {});

      console.log(`[NoShow] Reunião ${r.id} (deal ${r.dealId}) marcada como no_show — notificações enviadas`);
    } catch (err) {
      console.error(`[NoShow] Erro ao processar reunião ${r.id}:`, err);
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Lembretes de audiência
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Lembra o cliente da audiência que se aproxima: semanal enquanto falta mais de
 * uma semana, diário na última semana.
 *
 * Só entra lead cuja designação já foi avisada — mandar "sua audiência está
 * chegando" para quem nunca recebeu a data seria estranho. `audienciaLembreteEm`
 * trava um envio por dia, para que um restart do processo não repita a mensagem.
 */
async function enviarLembretesAudiencia(): Promise<void> {
  const { diasAte, ehDiaDeLembrete, ehTipoValido, formatarValor, montarMensagemLembrete } =
    await import("./services/audiencia.js");
  const { enviarTextoParaDeal, remetenteDoDeal } = await import("./services/whatsapp-deal.js");

  const agora = new Date();
  const deals = await prisma.crmDeal.findMany({
    where: {
      audienciaEm: { gt: agora },
      audienciaAvisadaEm: { not: null },
      status: "aberto",
    },
    include: { contato: true },
  });

  for (const deal of deals) {
    try {
      if (!deal.audienciaEm || !ehTipoValido(deal.audienciaTipo)) continue;
      if (!deal.contato?.whatsapp) continue;

      const dias = diasAte(deal.audienciaEm, agora);
      if (!ehDiaDeLembrete(dias)) continue;

      // Já mandou hoje? (compara o dia local, não as 24h)
      const ultimo = deal.audienciaLembreteEm;
      if (ultimo && diasAte(agora, ultimo) === 0) continue;

      const texto = montarMensagemLembrete({
        nome:       (deal.contato.nome ?? deal.titulo).trim().split(/\s+/)[0],
        em:         deal.audienciaEm,
        tipo:       deal.audienciaTipo,
        modalidade: deal.audienciaModalidade === "virtual" ? "virtual" : "presencial",
        local:      deal.audienciaLocal,
        empresa:    null,
        valorCausa: formatarValor(deal.valorCausaAjuizada),
      });

      const remetente = await remetenteDoDeal(deal.responsavelId);
      await enviarTextoParaDeal(deal.id, texto, remetente);
      await prisma.crmDeal.update({
        where: { id: deal.id },
        data: { audienciaLembreteEm: new Date() },
      });
      console.log(`[Audiencia] Lembrete enviado — deal ${deal.id}, faltam ${dias} dia(s)`);

      // O número do escritório já foi bloqueado antes por rajada de envio.
      await new Promise((r) => setTimeout(r, 4000));
    } catch (err) {
      console.error(`[Audiencia] Falha no lembrete do deal ${deal.id}:`, err);
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

  // A cada 30 min — reprocessa e-mails de cobrança pendentes/falhos (auto-cura)
  cron.schedule("*/30 * * * *", async () => {
    try {
      await reprocessarEmailsCobranca();
    } catch (err) {
      console.error("[Email-Retry] Erro crítico:", err);
    }
  });

  // A cada hora — lembretes de reunião (24h antes e 1h antes)
  cron.schedule("0 * * * *", async () => {
    try {
      await enviarLembretesReuniao();
    } catch (err) {
      console.error("[Reuniao-Lembrete] Erro:", err);
    }
  });

  // A cada 15 min — no-show: reunião passou e ninguém entrou → notifica SDR humano + reengaja lead
  cron.schedule("*/15 * * * *", async () => {
    try {
      await detectarNoShows();
    } catch (err) {
      console.error("[NoShow] Erro crítico:", err);
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

  // ── Marketing Autopilot — a cada hora ──────────────────────────────────
  cron.schedule("0 * * * *", async () => {
    try {
      await syncMetricasMkt();
    } catch (err) {
      console.error("[MKT-Sync] Erro:", err);
    }
  });

  // ── Marketing Autopilot — publicações agendadas (a cada 5 minutos) ─────
  cron.schedule("*/5 * * * *", async () => {
    try {
      await processarPublicacoesMkt();
    } catch (err) {
      console.error("[MKT-Pub] Erro:", err);
    }
  });

  // ── Marketing Autopilot — verificação de tokens (diariamente às 08:00) ──
  cron.schedule("0 8 * * *", async () => {
    try {
      await verificarTokensMkt();
    } catch (err) {
      console.error("[MKT-Tokens] Erro:", err);
    }
  });

  // Lembretes de audiência: diário às 09:30 (depois do follow-up, no horário comercial)
  cron.schedule("30 9 * * *", async () => {
    try {
      await enviarLembretesAudiencia();
    } catch (err) {
      console.error("[Audiencia] Erro no cron de lembretes:", err);
    }
  });

  // Follow-up PAKT: diário às 9h
  cron.schedule("0 9 * * *", async () => {
    try {
      const { runFollowUpPakt } = await import("./agent/followup-engine.js");
      await runFollowUpPakt();
    } catch (e) {
      console.error("[CRON] Erro follow-up PAKT:", e);
    }
  });

  // ── Limpeza de logs antigos (diário às 03:00) — retém 90 dias ────────────
  cron.schedule("0 3 * * *", async () => {
    try {
      const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
      const [deletedLogs, deletedMsgs] = await Promise.all([
        prisma.iaInteracaoLog.deleteMany({ where: { criadoEm: { lt: cutoff } } }),
        prisma.crmMensagemWhatsapp.deleteMany({
          where: {
            enviadaEm: { lt: cutoff },
            deal: { status: { not: "aberto" } },
          },
        }),
      ]);
      console.log(`[CRON-Cleanup] Logs removidos: ${deletedLogs.count} interações IA, ${deletedMsgs.count} mensagens WA`);
    } catch (e) {
      console.error("[CRON-Cleanup] Erro:", e);
    }
  });

  // ── Fotos de perfil do WhatsApp — renova contatos ativos (diário às 04:30) ──
  cron.schedule("30 4 * * *", async () => {
    try {
      const { renovarFotosPerfilAtivas } = await import("./services/foto-perfil.js");
      const r = await renovarFotosPerfilAtivas();
      console.log(`[FotoPerfil] Renovação: ${r.consultados} consultados, ${r.comFoto} com foto`);
      recordCronRun("renovarFotosPerfilAtivas");
    } catch (e) {
      console.error("[FotoPerfil] Erro no cron:", e);
    }
  });

  console.log("[CRON] Agendado: Notas às 07:00 | PIX poll + Agente IA a cada 15 min | Handoffs a cada 5 min | MKT sync/hora | MKT pub/5min | MKT tokens 08:00 | Follow-up PAKT 9h | Cleanup 03:00");
}

// ─────────────────────────────────────────────────────────────────────────────
// Marketing Autopilot — jobs
// ─────────────────────────────────────────────────────────────────────────────

async function syncMetricasMkt(): Promise<void> {
  const { listarCampanhas: metaListar } = await import("./services/meta.js");
  const { listarCampanhas: googleListar } = await import("./services/googleAds.js");
  const { analisarCampanhas } = await import("./services/deepseekMkt.js");
  const { createCipheriv, createDecipheriv, randomBytes } = await import("crypto");

  const CRYPT_KEY = Buffer.from(process.env.CRYPT_KEY_HEX ?? "", "hex");

  function decrypt(ciphertext: string): string {
    const buf = Buffer.from(ciphertext, "base64");
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const enc = buf.subarray(28);
    const d = createDecipheriv("aes-256-gcm", CRYPT_KEY, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(enc), d.final()]).toString("utf8");
  }

  async function getCfgVal(projetoId: string, chave: string): Promise<string | null> {
    const cfg = await prisma.mktConfig.findUnique({ where: { projetoId_chave: { projetoId, chave } } });
    if (!cfg?.valor) return null;
    return cfg.valorEncrypted ? decrypt(cfg.valor) : cfg.valor;
  }

  async function gravarLogMkt(projetoId: string, tipo: string, entidadeId: string, entidadeTipo: string, valorAntes: any, valorDepois: any, motivoIa: string | null, revertivel: boolean, ok: boolean, erroDetalhe?: string) {
    await prisma.mktLogAcao.create({ data: { projetoId, tipo, entidadeId, entidadeTipo, valorAntes: valorAntes ?? undefined, valorDepois: valorDepois ?? undefined, motivoIa, revertivel, ok, erroDetalhe } });
  }

  const projetos = await prisma.mktProjeto.findMany({ where: { ativo: true } });

  for (const projeto of projetos) {
    const campanhasAtivas = await prisma.mktCampanha.findMany({
      where: { projetoId: projeto.id, status: "ATIVA" },
      include: { criativos: { where: { status: "ATIVO" } } },
    });

    // Sync métricas Meta
    const tokenMeta = await getCfgVal(projeto.id, "meta_access_token");
    const adAccountId = await getCfgVal(projeto.id, "meta_ad_account_id");
    if (tokenMeta && adAccountId) {
      try {
        const campanhasMeta = await metaListar(tokenMeta, adAccountId);
        for (const c of campanhasMeta) {
          await prisma.mktCampanha.updateMany({
            where: { projetoId: projeto.id, idExterno: c.id, plataforma: "META" },
            data: {
              impressoes: parseInt(c.impressions ?? "0"),
              cliques: parseInt(c.clicks ?? "0"),
              gastoTotal: parseFloat(c.spend ?? "0"),
              cpaAtual: c.cpa ? parseFloat(c.cpa) : null,
              roasAtual: c.roas ? parseFloat(c.roas) : null,
              ctrAtual: parseFloat(c.ctr ?? "0"),
              ultimaSincEm: new Date(),
            },
          });
        }
      } catch (e: any) {
        console.error(`[MKT-Sync] Meta projeto ${projeto.id}:`, e.message);
      }
    }

    // Verifica KPIs e incrementa contador de violação
    for (const campanha of campanhasAtivas) {
      if (!campanha.cpaMeta || !campanha.cpaAtual) continue;
      if (campanha.cpaAtual > campanha.cpaMeta) {
        const novoCount = campanha.kpiVioladoCount + 1;
        await prisma.mktCampanha.update({ where: { id: campanha.id }, data: { kpiVioladoCount: novoCount } });

        if (novoCount >= 2) {
          const motivo = `CPA atual R$${campanha.cpaAtual.toFixed(2)} acima do limite R$${campanha.cpaMeta.toFixed(2)} por ${novoCount} coletas consecutivas`;
          if (campanha.autonomia === "TOTAL" && tokenMeta && campanha.plataforma === "META") {
            try {
              const { pausarCampanha } = await import("./services/meta.js");
              await pausarCampanha(tokenMeta, campanha.idExterno);
              await prisma.mktCampanha.update({ where: { id: campanha.id }, data: { status: "PAUSADA" } });
              await gravarLogMkt(projeto.id, "campanha_pausada", campanha.id, "MktCampanha", { status: "ATIVA" }, { status: "PAUSADA" }, motivo, true, true);
            } catch (e: any) {
              await gravarLogMkt(projeto.id, "campanha_pausada", campanha.id, "MktCampanha", null, null, motivo, false, false, e.message);
            }
          } else if (campanha.autonomia === "NOTIFICAR" || campanha.autonomia === "SUGERIR") {
            await gravarLogMkt(projeto.id, "alerta", campanha.id, "MktCampanha", null, null, motivo, false, true);
          }
        }
      } else {
        // CPA dentro do limite — resetar contador
        if (campanha.kpiVioladoCount > 0) {
          await prisma.mktCampanha.update({ where: { id: campanha.id }, data: { kpiVioladoCount: 0 } });
        }
      }
    }
  }

  console.log(`[MKT-Sync] ${projetos.length} projetos sincronizados`);
}

async function processarPublicacoesMkt(): Promise<void> {
  const agora = new Date();
  const publicacoes = await prisma.mktPublicacao.findMany({
    where: {
      OR: [
        { status: "AGENDADO", agendadoPara: { lte: agora } },
        { status: "PROCESSANDO_CONTAINER" },
      ],
    },
  });

  if (!publicacoes.length) return;

  const { createDecipheriv } = await import("crypto");
  const CRYPT_KEY = Buffer.from(process.env.CRYPT_KEY_HEX ?? "", "hex");

  function decrypt(c: string): string {
    const buf = Buffer.from(c, "base64");
    const iv = buf.subarray(0, 12); const tag = buf.subarray(12, 28); const enc = buf.subarray(28);
    const d = createDecipheriv("aes-256-gcm", CRYPT_KEY, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(enc), d.final()]).toString("utf8");
  }

  async function getCfgVal(projetoId: string, chave: string): Promise<string | null> {
    const cfg = await prisma.mktConfig.findUnique({ where: { projetoId_chave: { projetoId, chave } } });
    if (!cfg?.valor) return null;
    return cfg.valorEncrypted ? decrypt(cfg.valor) : cfg.valor;
  }

  const { verificarContainer, publicarContainer, criarContainerImagem, criarContainerVideo } = await import("./services/meta.js");

  for (const pub of publicacoes) {
    try {
      const token = await getCfgVal(pub.projetoId, "meta_access_token");
      const igAccountId = await getCfgVal(pub.projetoId, "meta_ig_account_id");
      if (!token || !igAccountId) continue;

      if (pub.status === "PROCESSANDO_CONTAINER" && pub.containerId) {
        const statusContainer = await verificarContainer(token, pub.containerId);
        if (statusContainer === "FINISHED") {
          const postId = await publicarContainer(token, igAccountId, pub.containerId);
          await prisma.mktPublicacao.update({
            where: { id: pub.id },
            data: { status: "PUBLICADO", idPostIg: postId, publicadoEm: new Date() },
          });
          await prisma.mktLogAcao.create({
            data: {
              projetoId: pub.projetoId, tipo: "post_publicado", entidadeId: pub.id,
              entidadeTipo: "MktPublicacao", valorAntes: { status: "PROCESSANDO_CONTAINER" },
              valorDepois: { status: "PUBLICADO", idPostIg: postId }, revertivel: false, ok: true,
            },
          });
        } else if (statusContainer === "ERROR") {
          await prisma.mktPublicacao.update({ where: { id: pub.id }, data: { status: "FALHOU" } });
        }
        continue;
      }

      if (!pub.urlMidia) {
        await prisma.mktPublicacao.update({ where: { id: pub.id }, data: { status: "AGUARDANDO_MIDIA" } });
        continue;
      }

      const legenda = pub.legenda + (pub.hashtags.length ? "\n\n" + pub.hashtags.map((h) => `#${h}`).join(" ") : "");
      const isVideo = pub.urlMidia.match(/\.(mp4|mov|avi|webm)$/i);
      const containerId = isVideo
        ? await criarContainerVideo(token, igAccountId, pub.urlMidia, legenda)
        : await criarContainerImagem(token, igAccountId, pub.urlMidia, legenda);

      await prisma.mktPublicacao.update({
        where: { id: pub.id },
        data: { containerId, status: "PROCESSANDO_CONTAINER" },
      });
    } catch (e: any) {
      console.error(`[MKT-Pub] Erro publicação ${pub.id}:`, e.message);
      await prisma.mktPublicacao.update({ where: { id: pub.id }, data: { status: "FALHOU" } });
      await prisma.mktLogAcao.create({
        data: {
          projetoId: pub.projetoId, tipo: "post_publicado", entidadeId: pub.id,
          entidadeTipo: "MktPublicacao", revertivel: false, ok: false, erroDetalhe: e.message,
        },
      });
    }
  }
}

async function verificarTokensMkt(): Promise<void> {
  const projetos = await prisma.mktProjeto.findMany({ where: { ativo: true } });
  const AVISO_DIAS = 30;

  for (const projeto of projetos) {
    const expStr = await prisma.mktConfig
      .findUnique({ where: { projetoId_chave: { projetoId: projeto.id, chave: "meta_token_expira" } } })
      .then((c) => c?.valor ?? null);

    if (!expStr) continue;
    const expira = new Date(expStr);
    const diasRestantes = Math.floor((expira.getTime() - Date.now()) / 86_400_000);

    if (diasRestantes <= AVISO_DIAS) {
      await prisma.mktLogAcao.create({
        data: {
          projetoId: projeto.id,
          tipo: "token_alerta",
          entidadeId: projeto.id,
          entidadeTipo: "MktProjeto",
          motivoIa: `Token Meta expira em ${diasRestantes} dias (${expira.toLocaleDateString("pt-BR")}). Reconecte a conta em Configurações.`,
          revertivel: false,
          ok: diasRestantes > 0,
        },
      });
      console.warn(`[MKT-Tokens] Projeto ${projeto.id}: token Meta expira em ${diasRestantes} dias`);
    }
  }
}
