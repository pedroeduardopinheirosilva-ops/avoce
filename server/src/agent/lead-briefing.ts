/**
 * Lead Briefing — resumo acionável do lead para o SDR HUMANO.
 *
 * O SDR humano trabalha em dupla com a IA: liga para os leads para fechar reuniões
 * e garantir comparecimento. Este módulo monta a mensagem de notificação que ele
 * recebe nos eventos-chave (qualificação completa, reunião agendada, no-show,
 * pedido de ligação) com tudo que precisa para a ligação em < 5s de leitura:
 * telefone, melhor horário, vínculos, urgência prescricional, valor estimado e dor.
 */
import { prisma } from "../db.js";
import { calcularValorCausa } from "./calc-trabalhista.js";
import { deriveDataSaida } from "./qualification.js";
import type { VinculoEmprego } from "./types.js";

const fmtBRL = (v: number) =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 }).format(v);

function fmtTelefone(whatsapp: string): string {
  const d = whatsapp.replace(/\D/g, "").replace(/^55/, "");
  if (d.length >= 10) return `(${d.slice(0, 2)}) ${d.slice(2, -4)}-${d.slice(-4)}`;
  return whatsapp;
}

/** Prazo prescricional (data_saida + 24 meses). Retorna "MM/AAAA (⚠ N meses)" ou null. */
function prescricaoInfo(v: VinculoEmprego): string | null {
  const ds = deriveDataSaida(v);
  if (!ds) return null;
  const [mm, yyyy] = ds.split("/").map(Number);
  const limite = new Date(yyyy, mm - 1 + 24, 1);
  const agora = new Date();
  const mesesRestantes = (limite.getFullYear() - agora.getFullYear()) * 12 + (limite.getMonth() - agora.getMonth());
  const limiteFmt = `${String(limite.getMonth() + 1).padStart(2, "0")}/${limite.getFullYear()}`;
  if (mesesRestantes <= 0) return `prescreve ${limiteFmt} (PRESCRITO?)`;
  if (mesesRestantes <= 8) return `prescreve ${limiteFmt} ⚠ ${mesesRestantes} meses`;
  return `prescreve ${limiteFmt}`;
}

export async function buildLeadBriefing(
  dealId: string,
  opcoes: { titulo: string; acao: string },
): Promise<string> {
  const deal = await prisma.crmDeal.findUnique({
    where: { id: dealId },
    include: { contato: true },
  });
  if (!deal) return `${opcoes.titulo} — deal ${dealId} não encontrado`;

  const merged: Record<string, unknown> = {
    ...((deal.qualificacao as Record<string, unknown>) ?? {}),
    ...(((deal as any).iaFlags as Record<string, unknown>) ?? {}),
  };
  const vinculos: VinculoEmprego[] = Array.isArray(merged.vinculos)
    ? (merged.vinculos as VinculoEmprego[])
    : [];

  const nome = String(merged.nome ?? deal.contato?.nome ?? "Lead");
  const whatsapp = deal.contato?.whatsapp ?? "";
  const cidade = merged.cidade ? String(merged.cidade) : null;
  const melhorHora = merged.melhor_hora_contato ? String(merged.melhor_hora_contato) : null;

  const linhas: string[] = [`*${opcoes.titulo} — ${nome}*`];

  if (whatsapp) linhas.push(`📱 wa.me/${whatsapp.replace(/\D/g, "")} | 📞 ${fmtTelefone(whatsapp)}`);
  const localHora = [cidade, melhorHora ? `⏰ melhor hora: ${melhorHora}` : null].filter(Boolean).join(" | ");
  if (localHora) linhas.push(`🏙 ${localHora}`);

  for (const v of vinculos.slice(0, 3)) {
    if (!v?.empresa) continue;
    const partes = [
      v.empresa,
      v.vinculo ?? null,
      v.tempo ? `${v.tempo}` : null,
      v.data_saida ? `saiu ${v.data_saida}` : (v.saida ? `saída: ${String(v.saida).slice(0, 30)}` : null),
      prescricaoInfo(v),
    ].filter(Boolean);
    linhas.push(`🚛 ${partes.join(" — ")}`);
  }

  try {
    // Sanitiza antes do cálculo: a extração às vezes devolve salários como STRING e
    // "2500" + "12500" vira concatenação (250012500 → estimativa de bilhões). Também
    // deriva tempo_meses_estimado do texto "4 anos" — sem ele o cálculo assume a janela
    // quinquenal inteira e superestima.
    const { parseTempToMeses } = await import("./persona-router.js");
    const num = (x: unknown): number | undefined => {
      if (typeof x === "number" && isFinite(x) && x > 0) return x;
      if (typeof x === "string") {
        const n = parseFloat(x.replace(/\./g, "").replace(",", ".").replace(/[^\d.]/g, ""));
        return isFinite(n) && n > 0 ? n : undefined;
      }
      return undefined;
    };
    const vinculosCalc = vinculos.map(v => {
      const mesesTempo = v.tempo ? parseTempToMeses(String(v.tempo)) : 999;
      return {
        ...v,
        salario_holerite: num(v.salario_holerite),
        salario_por_fora: num(v.salario_por_fora),
        salario_total_declarado: num((v as any).salario_total_declarado),
        intervalo_minutos: num((v as any).intervalo_minutos),
        tempo_meses_estimado: (v as any).tempo_meses_estimado
          ?? (mesesTempo > 0 && mesesTempo < 999 ? mesesTempo : undefined),
      };
    });
    const calc = calcularValorCausa(vinculosCalc as any[]);
    // Trava de sanidade: acima de R$ 10M é quase certamente dado sujo — não exibir número.
    if (calc.total_estimado_max > 0 && calc.total_estimado_max <= 10_000_000) {
      const teses = calc.por_tese.slice(0, 3).map(t => (t as any).tese ?? (t as any).nome ?? "").filter(Boolean).join(" + ");
      linhas.push(`💰 Estimativa: ${fmtBRL(calc.total_estimado_min)} – ${fmtBRL(calc.total_estimado_max)}${teses ? ` (${teses})` : ""}`);
    } else if (calc.total_estimado_max > 10_000_000) {
      linhas.push(`💰 Estimativa: dados inconsistentes para cálculo automático — avaliar manualmente`);
    }
  } catch { /* estimativa é best-effort */ }

  const dor = [merged.injustica_recente, merged.relato, merged.injustica_anterior]
    .map(x => (x ? String(x).trim() : ""))
    .find(x => x.length > 3);
  if (dor) linhas.push(`😤 Dor: ${dor.slice(0, 140)}`);

  // Reunião mais recente (agendada ou em andamento)
  const reuniao = await prisma.sessaoReuniao.findFirst({
    where: { dealId, status: { in: ["agendada", "em_andamento", "no_show"] } },
    orderBy: { criadaEm: "desc" },
  });
  if (reuniao?.agendadaPara) {
    const quando = reuniao.agendadaPara.toLocaleString("pt-BR", {
      timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
    });
    linhas.push(`🗓 Reunião: ${quando}${reuniao.status === "no_show" ? " — NÃO COMPARECEU" : ""}`);
  }

  linhas.push(`👉 AÇÃO: ${opcoes.acao}`);
  return linhas.join("\n");
}
