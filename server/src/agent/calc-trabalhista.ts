/**
 * Calculadora trabalhista — estimativa preliminar de valor da causa.
 * Função pura: sem acesso ao banco, sem side-effects.
 * Regras conservadoras e defensáveis como "estimativa pré-juízo".
 */

export interface VinculoCalculo {
  empresa: string;
  funcao: string;
  vinculo: "CLT" | "PJ" | "autonomo" | "informal";
  data_admissao?: string;   // ISO YYYY-MM-DD
  data_saida?: string;      // ISO YYYY-MM-DD
  tempo_meses_estimado?: number;
  salario_holerite?: number;
  salario_por_fora?: number;
  salario_total_declarado?: number;
  jornada_inicio?: string;  // "05:00"
  jornada_fim?: string;     // "22:00"
  intervalo_minutos?: number;
  horas_extras_pagas?: boolean;
  modalidade_saida?: "demitido_sem_justa_causa" | "rescisao_indireta" | "pedido_demissao" | "ainda_trabalha";
  injustica_relatada?: string;
  frota_empresa?: number;
  fgtsOk?: "sim" | "nao" | "parcial";
  situacaoCtps?: "assinada" | "nao_assinada" | "parcial";
}

export interface TeseAplicavel {
  tese: string;
  fundamento: string;
  valor_min: number;
  valor_max: number;
  observacao?: string;
}

export interface CalculoResultado {
  vinculos_considerados: number;
  vinculos_prescritos: string[];
  total_estimado_min: number;
  total_estimado_max: number;
  por_tese: TeseAplicavel[];
  resumo_textual_curto: string;
  observacoes: string[];
  data_calculo: string;
  disclaimer: string;
}

const DISCLAIMER =
  "Estimativa preliminar baseada nas informações relatadas pelo cliente, sem análise documental. " +
  "Valores definitivos dependem de perícia contábil, documentos da empresa e decisão judicial. " +
  "Não constitui parecer jurídico vinculante.";

const fmt = (v: number) =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 }).format(v);

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function parseDateSafe(str?: string): Date | null {
  if (!str) return null;
  // ISO format
  let d = new Date(str);
  if (!isNaN(d.getTime())) return d;
  // Brazilian DD/MM/YYYY
  const br = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (br) {
    d = new Date(`${br[3]}-${br[2].padStart(2, "0")}-${br[1].padStart(2, "0")}`);
    if (!isNaN(d.getTime())) return d;
  }
  // MM/YYYY
  const mmyyyy = str.match(/^(\d{1,2})\/(\d{4})$/);
  if (mmyyyy) {
    d = new Date(`${mmyyyy[2]}-${mmyyyy[1].padStart(2, "0")}-01`);
    if (!isNaN(d.getTime())) return d;
  }
  return null;
}

function mesesEntre(inicio: Date, fim: Date): number {
  const anos = fim.getFullYear() - inicio.getFullYear();
  const meses = fim.getMonth() - inicio.getMonth();
  return Math.max(0, Math.round(anos * 12 + meses));
}

function parseHora(str?: string): number | null {
  if (!str) return null;
  const [h, m] = str.split(":").map(Number);
  if (isNaN(h)) return null;
  return h + (m ?? 0) / 60;
}

// ──────────────────────────────────────────────────────────────────────────────
// Horas extras
// ──────────────────────────────────────────────────────────────────────────────

function calcularHorasExtras(
  v: VinculoCalculo,
  salarioBase: number,
  meses: number
): { min: number; max: number; tese: TeseAplicavel | null; obs: string[] } {
  const obs: string[] = [];

  // Horas diárias trabalhadas
  const horarioInicio = parseHora(v.jornada_inicio);
  const horarioFim = parseHora(v.jornada_fim);
  const intervaloH = (v.intervalo_minutos ?? 60) / 60;

  let horasDia: number;
  if (horarioInicio !== null && horarioFim !== null) {
    const bruto = horarioFim > horarioInicio
      ? horarioFim - horarioInicio
      : (24 - horarioInicio) + horarioFim; // virada da meia-noite
    horasDia = Math.max(0, bruto - intervaloH);
  } else {
    horasDia = 12; // fallback médio para carreteiro
    obs.push("Jornada não informada — usando estimativa de 12h/dia para carreteiro");
  }

  // Horas extras por dia
  const limiteJornada = 8;
  const heXDia = Math.max(0, horasDia - limiteJornada);

  if (heXDia <= 0) {
    return { min: 0, max: 0, tese: null, obs };
  }

  // Salário-hora
  const salarioHora = salarioBase / 220;

  // HE mensal (valor bruto)
  const heMensalBruto = heXDia * 22 * salarioHora * 1.5;

  // Reflexos: DSR + 13º + férias + FGTS (fator 1.4 min / 1.6 max)
  const heMensalMin = heMensalBruto * 1.4;
  const heMensalMax = heMensalBruto * 1.6;

  // Total no período com incerteza de fato (0.7 min / 1.0 max)
  const totalMin = Math.round(heMensalMin * meses * 0.7);
  const totalMax = Math.round(heMensalMax * meses * 1.0);

  const pagas = v.horas_extras_pagas ?? false;
  const label = pagas
    ? "Horas extras não quitadas integralmente"
    : "Horas extras não quitadas";

  return {
    min: totalMin,
    max: totalMax,
    tese: {
      tese: label,
      fundamento: "art. 59 CLT, Súmula 264 TST",
      valor_min: totalMin,
      valor_max: totalMax,
      observacao: pagas ? "Cliente relatou pagamento parcial — diferença estimada" : undefined,
    },
    obs,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Verbas rescisórias
// ──────────────────────────────────────────────────────────────────────────────

function calcularVerbaRescisoria(
  v: VinculoCalculo,
  salarioBase: number,
  meses: number
): { min: number; max: number; tese: TeseAplicavel | null; obs: string[] } {
  const obs: string[] = [];
  const modalidade = v.modalidade_saida ?? "demitido_sem_justa_causa";

  if (modalidade === "ainda_trabalha") {
    obs.push("Verbas rescisórias serão calculadas no momento do desligamento");
    return { min: 0, max: 0, tese: null, obs };
  }

  if (modalidade === "pedido_demissao") {
    obs.push("Pedido de demissão — verificar elementos de rescisão indireta para equiparação");
    return {
      min: 0,
      max: 0,
      tese: {
        tese: "Possível conversão em rescisão indireta",
        fundamento: "art. 483 CLT",
        valor_min: 0,
        valor_max: 0,
        observacao: "Depende da comprovação de falta grave do empregador",
      },
      obs,
    };
  }

  // demitido_sem_justa_causa | rescisao_indireta
  const anosCompletos = Math.floor(meses / 12);
  const diasAviso = Math.min(30 + anosCompletos * 3, 90);
  const avisoPrevio = (salarioBase / 30) * diasAviso;

  const saldoFgts = salarioBase * 0.08 * meses;
  const multaFgts = saldoFgts * 0.40;

  const mesAquisitivo = meses % 12;
  const feriasProporcionais = (salarioBase / 12) * mesAquisitivo * 1.333; // + 1/3
  const decimoTerceiro = (salarioBase / 12) * mesAquisitivo;

  const total = avisoPrevio + multaFgts + feriasProporcionais + decimoTerceiro;
  const totalMin = Math.round(total * 0.85); // margem para contestação patronal
  const totalMax = Math.round(total * 1.0);

  return {
    min: totalMin,
    max: totalMax,
    tese: {
      tese: modalidade === "rescisao_indireta" ? "Rescisão indireta (verbas plenas)" : "Verbas rescisórias sem justa causa",
      fundamento: modalidade === "rescisao_indireta" ? "art. 483 CLT" : "arts. 477, 487 CLT",
      valor_min: totalMin,
      valor_max: totalMax,
    },
    obs,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// FGTS não depositado
// ──────────────────────────────────────────────────────────────────────────────

function calcularFgtsNaoDepositado(
  v: VinculoCalculo,
  salarioBase: number,
  meses: number
): { min: number; max: number; tese: TeseAplicavel | null; obs: string[] } {
  const obs: string[] = [];
  const fgtsOk = v.fgtsOk ?? "sim";

  if (fgtsOk === "sim") {
    return { min: 0, max: 0, tese: null, obs };
  }

  // 8% mensal não depositado
  const depositoMensal = salarioBase * 0.08;

  if (fgtsOk === "nao") {
    // Nenhum depósito foi feito — total integral devido
    const totalDevido = depositoMensal * meses;
    // Com correção monetária + juros aproximados (1% a.m. + correção)
    const totalCorrigido = totalDevido * 1.3;
    const totalMin = Math.round(totalDevido * 0.85);
    const totalMax = Math.round(totalCorrigido);

    obs.push(`FGTS não depositado: ${meses} meses × R$ ${depositoMensal.toFixed(2)}/mês = R$ ${totalDevido.toFixed(2)}, mais correção + juros`);

    return {
      min: totalMin,
      max: totalMax,
      tese: {
        tese: "FGTS não depositado durante o contrato",
        fundamento: "Lei 8.036/90, art. 297 CLT",
        valor_min: totalMin,
        valor_max: totalMax,
        observacao: `Empresa não recolheu FGTS por ${meses} meses. Valor já inclui correção monetária + juros estimados.`,
      },
      obs,
    };
  }

  // fgtsOk === "parcial" — depósitos parciais/irregulares
  const totalParcial = depositoMensal * meses * 0.5; // estimativa 50% não depositado
  const totalParcialMin = Math.round(totalParcial * 0.85);
  const totalParcialMax = Math.round(totalParcial * 1.3);

  obs.push(`FGTS depositado parcialmente — estimando 50% do período sem depósito`);

  return {
    min: totalParcialMin,
    max: totalParcialMax,
    tese: {
      tese: "Diferenças de FGTS (depósitos parciais/irregulares)",
      fundamento: "Lei 8.036/90, art. 297 CLT",
      valor_min: totalParcialMin,
      valor_max: totalParcialMax,
      observacao: "Cliente relatou depósitos irregulares — valor estimado proporcional.",
    },
    obs,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Teses qualitativas
// ──────────────────────────────────────────────────────────────────────────────

function detectarTesesQualitativas(v: VinculoCalculo): TeseAplicavel[] {
  const teses: TeseAplicavel[] = [];

  const injusticaNorm = (v.injustica_relatada ?? "").toLowerCase();
  if (/pressao|assedio|cobranca excessiva|abuso|humilh/.test(injusticaNorm)) {
    teses.push({
      tese: "Dano moral por assédio/pressão excessiva",
      fundamento: "art. 223-A CLT, Súmula 37 STJ",
      valor_min: 0,
      valor_max: 0,
      observacao: "Valor arbitrado pelo juiz — entre 1x e 50x o salário-base",
    });
  }

  if ((v.frota_empresa ?? 0) >= 1000) {
    teses.push({
      tese: "Possível enquadramento em convenção coletiva de frota grande / periculosidade",
      fundamento: "art. 193 CLT, NR-16",
      valor_min: 0,
      valor_max: 0,
      observacao: "Verificar CCT da categoria e laudo de periculosidade",
    });
  }

  if ((v.salario_por_fora ?? 0) > 0) {
    teses.push({
      tese: "Integração de valores pagos por fora (Pamcard, PIX, dinheiro)",
      fundamento: "Súmula 264 TST, art. 457 CLT",
      valor_min: 0,
      valor_max: 0,
      observacao: "Reflexos retroativos em todas as parcelas salariais",
    });
  }

  const ctps = v.situacaoCtps ?? "assinada";
  if (ctps === "nao_assinada") {
    teses.push({
      tese: "FGTS não depositado + CTPS não assinada (reconhecimento de vínculo)",
      fundamento: "art. 29 CLT, art. 47 CLT, Súmula 12 TST",
      valor_min: 0,
      valor_max: 0,
      observacao: "Ausência de registro em CTPS agrava a situação — presunção de todos os direitos trabalhistas. Reforça tese de rescisão indireta.",
    });
  } else if (ctps === "parcial") {
    teses.push({
      tese: "CTPS assinada com irregularidades (registro parcial/extemporâneo)",
      fundamento: "art. 29 CLT",
      valor_min: 0,
      valor_max: 0,
      observacao: "Registro em CTPS feito fora do prazo legal de 5 dias — impacta presunção de vínculo no período inicial.",
    });
  }

  return teses;
}

// ──────────────────────────────────────────────────────────────────────────────
// calcularValorCausa — função principal
// ──────────────────────────────────────────────────────────────────────────────

export function calcularValorCausa(
  vinculos: VinculoCalculo[],
  dataReferencia: Date = new Date()
): CalculoResultado {
  const observacoes: string[] = [];
  const prescritos: string[] = [];
  const todasTeses: TeseAplicavel[] = [];

  let totalMin = 0;
  let totalMax = 0;
  let vinculosConsiderados = 0;

  for (const v of vinculos) {
    const dataSaida = parseDateSafe(v.data_saida);
    const dataAdmissao = parseDateSafe(v.data_admissao);

    // Prescrição: 5 anos a partir da data de referência
    if (dataSaida) {
      const anosDesde = (dataReferencia.getTime() - dataSaida.getTime()) / (1000 * 60 * 60 * 24 * 365);
      if (anosDesde > 5) {
        prescritos.push(`${v.empresa} (encerrado há ${Math.floor(anosDesde)} anos)`);
        continue;
      }
    }

    vinculosConsiderados++;

    // Período de cálculo — com corte quinquenal correto (Art. 11 CLT)
    // A retroatividade é de 5 anos A PARTIR DE HOJE, não da duração total do contrato.
    // Fórmula: recuperável = min(tempo_total, 60_meses) - max(0, meses_desde_saída)
    let meses: number;
    const JANELA_MESES = 60; // 5 anos
    const dataCortePrescricao = new Date(dataReferencia.getTime() - JANELA_MESES * 30.4375 * 24 * 60 * 60 * 1000);

    if (dataSaida) {
      const mesesDesde = Math.max(0,
        (dataReferencia.getTime() - dataSaida.getTime()) / (30.4375 * 24 * 60 * 60 * 1000)
      );
      // Determine start of employment
      let inicioEmprego: Date;
      if (dataAdmissao) {
        inicioEmprego = dataAdmissao;
      } else if (v.tempo_meses_estimado) {
        inicioEmprego = new Date(dataSaida.getTime() - v.tempo_meses_estimado * 30.4375 * 24 * 60 * 60 * 1000);
      } else {
        // Unknown start — use cutoff as start (conservative)
        inicioEmprego = dataCortePrescricao;
      }
      // Recoverable window: overlap of [inicio, saida] with [hoje-5anos, hoje]
      const inicioRecuperavel = inicioEmprego > dataCortePrescricao ? inicioEmprego : dataCortePrescricao;
      meses = Math.max(0, mesesEntre(inicioRecuperavel, dataSaida));
      const mesesTotais = v.tempo_meses_estimado ?? mesesEntre(inicioEmprego, dataSaida);
      if (meses < mesesTotais - 1) {
        observacoes.push(
          `${v.empresa}: período truncado para os últimos 5 anos (prescrição) — recuperável ${Math.round(meses)} de ${Math.round(mesesTotais)} meses trabalhados`
        );
      }
    } else if (v.tempo_meses_estimado) {
      // No departure date — use raw duration capped at 60 months.
      // Cannot apply the "meses_desde_saída" correction without knowing when they left.
      // This is a known limitation: value will be overestimated if they left long ago.
      meses = Math.min(v.tempo_meses_estimado, JANELA_MESES);
      observacoes.push(`${v.empresa}: tempo de ${v.tempo_meses_estimado} meses estimado pelo cliente — sem datas confirmadas`);
    } else {
      meses = 12; // fallback conservador
      observacoes.push(`${v.empresa}: período desconhecido — usando 12 meses para estimativa`);
    }

    // Salário base efetivo
    let salarioBase: number;
    if ((v.salario_por_fora ?? 0) > 0 && (v.salario_holerite ?? 0) > 0) {
      salarioBase = (v.salario_holerite ?? 0) + (v.salario_por_fora ?? 0);
    } else if (v.salario_total_declarado) {
      salarioBase = v.salario_total_declarado;
    } else if (v.salario_holerite) {
      salarioBase = v.salario_holerite;
    } else {
      observacoes.push(`${v.empresa}: salário não informado — cálculo de horas extras prejudicado`);
      salarioBase = 0;
    }

    // Horas extras (apenas se tem salário e é CLT)
    if (salarioBase > 0 && v.vinculo === "CLT") {
      const he = calcularHorasExtras(v, salarioBase, meses);
      observacoes.push(...he.obs);
      if (he.tese) {
        todasTeses.push(he.tese);
        totalMin += he.min;
        totalMax += he.max;
      }
    }

    // Verbas rescisórias
    if (salarioBase > 0 && v.vinculo === "CLT") {
      const vr = calcularVerbaRescisoria(v, salarioBase, meses);
      observacoes.push(...vr.obs);
      if (vr.tese) {
        todasTeses.push(vr.tese);
        totalMin += vr.min;
        totalMax += vr.max;
      }
    }

    // FGTS não depositado (apenas se tem salário)
    if (salarioBase > 0) {
      const fgts = calcularFgtsNaoDepositado(v, salarioBase, meses);
      observacoes.push(...fgts.obs);
      if (fgts.tese) {
        todasTeses.push(fgts.tese);
        totalMin += fgts.min;
        totalMax += fgts.max;
      }
    }

    // Teses qualitativas
    const qualit = detectarTesesQualitativas(v);
    todasTeses.push(...qualit);
  }

  // Resumo textual para WhatsApp
  const tesesComValor = todasTeses.filter(t => t.valor_max > 0);
  const tese1 = tesesComValor[0]?.tese ?? "créditos trabalhistas";
  const tese2 = tesesComValor[1]?.tese;

  let resumo: string;
  if (totalMax === 0) {
    resumo = "Ainda não foi possível calcular uma estimativa — precisarei de mais informações sobre salário e período trabalhado.";
  } else {
    const partes = tese2
      ? `${tese1} e ${tese2}`
      : tese1;
    resumo =
      `Pelos dados que você passou, sua causa pode girar entre ${fmt(totalMin)} e ${fmt(totalMax)}, ` +
      `considerando principalmente ${partes}. ` +
      `É uma estimativa inicial — o valor real depende dos documentos da empresa e do andamento do processo.`;
  }

  return {
    vinculos_considerados: vinculosConsiderados,
    vinculos_prescritos: prescritos,
    total_estimado_min: totalMin,
    total_estimado_max: totalMax,
    por_tese: todasTeses,
    resumo_textual_curto: resumo,
    observacoes: [...new Set(observacoes)],
    data_calculo: dataReferencia.toISOString(),
    disclaimer: DISCLAIMER,
  };
}
