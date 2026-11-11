/**
 * Resumo da manhã: manda para a equipe (evento de notificação `followups_do_dia`, configurável
 * na aba Notificações do Config IA) a lista de ligações de follow-up que vencem hoje ou estão
 * atrasadas. Só envia se houver pelo menos uma, e uma vez por dia por projeto.
 */
import { prisma } from "../db.js";
import { dispararNotificacoes } from "./message-handler.js";

const TZ = "America/Sao_Paulo";
const hojeSP = () => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
const inicioDoDia = (dia: string) => new Date(`${dia}T00:00:00-03:00`);

export async function enviarResumoFollowups(): Promise<void> {
  const eventos = await prisma.iaNotificacaoEvento.findMany({
    where: { evento: "followups_do_dia", ativo: true },
    select: { projetoId: true },
    distinct: ["projetoId"],
  });
  const hoje = hojeSP();
  const inicio = inicioDoDia(hoje);
  const fim = new Date(inicio.getTime() + 86400_000);

  for (const { projetoId } of eventos) {
    try {
      const jaFoi = await prisma.iaNotificacaoLog.count({ where: { projetoId, evento: "followups_do_dia", enviadaEm: { gte: inicio } } });
      if (jaFoi) continue;

      const deals = await prisma.crmDeal.findMany({
        where: { projetoId, status: "aberto", proximoContatoEm: { lt: fim } },
        orderBy: { proximoContatoEm: "asc" },
        take: 200,
        select: {
          titulo: true, proximoContatoEm: true,
          contato: { select: { nome: true } },
          atividades: { orderBy: { criadoEm: "desc" }, take: 1, select: { resultado: true } },
        },
      });
      if (!deals.length) continue;

      const atrasadas = deals.filter((d) => d.proximoContatoEm! < inicio).length;
      const ROT: Record<string, string> = {
        atendeu: "atendeu", nao_atendeu: "não atendeu", recusou: "recusou", pediu_retorno: "pediu retorno",
        numero_errado: "número errado", agendada: "reunião agendada", realizada: "reunião feita", no_show: "no-show",
      };
      const MAX = 15;
      const lista = deals.slice(0, MAX).map((d) => {
        const dias = Math.floor((inicio.getTime() - d.proximoContatoEm!.getTime()) / 86400_000) + 1;
        const quando = d.proximoContatoEm! < inicio ? `atrasado ${dias}d` : "hoje";
        const ult = d.atividades[0] ? ` · última: ${ROT[d.atividades[0].resultado] ?? d.atividades[0].resultado}` : "";
        return `• ${d.contato?.nome ?? d.titulo} — ${quando}${ult}`;
      }).join("\n") + (deals.length > MAX ? `\n… e mais ${deals.length - MAX}` : "");

      await dispararNotificacoes(projetoId, "followups_do_dia", {
        data: `${hoje.slice(8, 10)}/${hoje.slice(5, 7)}`,
        total: String(deals.length),
        atrasadas: String(atrasadas),
        hoje: String(deals.length - atrasadas),
        lista,
        link: `${process.env.APP_BASE_URL ?? "https://avoce.capium.com.br"}/painel`,
      });
    } catch (err: any) {
      console.error(`[FollowupsDia] erro projeto=${projetoId}: ${err?.message ?? err}`);
    }
  }
}
