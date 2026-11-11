/**
 * Chamadas de WhatsApp → atividade de ligação no lead.
 *
 * A SDR liga pelo WhatsApp (desktop) do MESMO número da instância do Evolution. Não dá para
 * originar chamada pelo Evolution (a rota /call/offer é um stub — ver memória), mas o Baileys
 * emite o evento `call` (offer → accept → terminate, ou reject/timeout) para as chamadas que
 * chegam ao número; o Evolution repassa como webhook `call` quando o evento CALL está assinado.
 *
 * - Chamada RECEBIDA (lead retornando): sempre chega. Vira ligação "entrada".
 * - Chamada FEITA pela SDR em outro aparelho da conta: se o WhatsApp avisar os aparelhos
 *   vinculados, chega com o criador = o próprio número. Vira ligação "saida".
 *
 * Tudo é idempotente pelo id da chamada (`externoId`). Evento sem deal correspondente só é
 * logado (`[Chamada] sem deal`) — o formato do jid (PN ou LID) é o que o teste real vai mostrar.
 */

import { prisma } from "../db.js";

type EventoChamada = {
  id?: string;
  from?: string;      // quem criou a chamada
  chatId?: string;    // o outro lado (attrs.from do nó)
  status?: string;    // offer | ringing | accept | reject | timeout | terminate
  date?: string | number;
  isVideo?: boolean;
  isGroup?: boolean;
};

const localPart = (jid?: string) => (jid ?? "").replace(/@.*/, "").replace(/:\d+$/, "");
const soDigitos = (s: string) => s.replace(/\D/g, "");

/** Variantes de um número BR: com/sem 55 e com/sem o 9º dígito. */
function variantes(numero: string): string[] {
  const d = soDigitos(numero);
  const out = new Set<string>([d]);
  const sem55 = d.startsWith("55") && d.length >= 12 ? d.slice(2) : d;
  out.add(sem55);
  out.add(`55${sem55}`);
  // DDD + 9 + 8 dígitos ⇄ DDD + 8 dígitos
  if (sem55.length === 11 && sem55[2] === "9") { const s8 = sem55.slice(0, 2) + sem55.slice(3); out.add(s8); out.add(`55${s8}`); }
  if (sem55.length === 10) { const s9 = sem55.slice(0, 2) + "9" + sem55.slice(2); out.add(s9); out.add(`55${s9}`); }
  return [...out];
}

// Número dono de cada instância (ownerJid), para saber se a chamada foi FEITA por nós.
const _donos = new Map<string, { numero: string | null; ts: number }>();
async function donoDaInstancia(instancia: string, projetoIds: string[]): Promise<string | null> {
  const c = _donos.get(instancia);
  if (c && Date.now() - c.ts < 3600_000) return c.numero;
  let numero: string | null = null;
  try {
    const cfg = await prisma.iaProjetoConfig.findMany({ where: { projetoId: { in: projetoIds }, categoria: "whatsapp" } });
    const v = (k: string) => cfg.find((x) => x.chave === k)?.valor ?? "";
    const base = v("evolution_api_url").replace(/\/$/, "");
    const key = v("evolution_api_key");
    if (base && key) {
      const res = await fetch(`${base}/instance/fetchInstances?instanceName=${encodeURIComponent(instancia)}`, { headers: { apikey: key } });
      const arr = await res.json() as any[];
      const owner = (Array.isArray(arr) ? arr[0] : null)?.ownerJid ?? (Array.isArray(arr) ? arr[0]?.instance?.owner : null);
      numero = owner ? localPart(owner) : null;
    }
  } catch (err: any) {
    console.warn(`[Chamada] não consegui o dono da instância ${instancia}: ${err?.message ?? err}`);
  }
  _donos.set(instancia, { numero, ts: Date.now() });
  return numero;
}

async function acharDeal(numero: string, projetoIds: string[]) {
  const vs = variantes(numero);
  const contatos = await prisma.crmContato.findMany({
    where: { OR: [{ whatsapp: { in: vs } }, { telefone: { in: vs } }] },
    select: { id: true },
  });
  if (!contatos.length) return null;
  return prisma.crmDeal.findFirst({
    where: { contatoId: { in: contatos.map((c) => c.id) }, projetoId: { in: projetoIds } },
    orderBy: [{ status: "asc" }, { ultimoContatoEm: { sort: "desc", nulls: "last" } }], // "aberto" antes de ganho/perdido
    select: { id: true },
  });
}

export async function registrarEventoChamada(instancia: string, projetoIds: string[], ev: EventoChamada): Promise<void> {
  try {
    if (!ev?.id || !ev.status || ev.isGroup) return;
    const dono = await donoDaInstancia(instancia, projetoIds);
    const criador = localPart(ev.from);
    const outroLado = [localPart(ev.chatId), criador].find((n) => n && n !== dono) ?? "";
    const direcao = dono && criador === dono ? "saida" : "entrada";
    console.log(`[Chamada] ${instancia} id=${ev.id} status=${ev.status} from=${ev.from} chatId=${ev.chatId} → ${direcao} ${outroLado}`);
    if (!outroLado) return;

    const existente = await prisma.crmAtividade.findUnique({ where: { externoId: ev.id } });
    const quando = ev.date ? new Date(typeof ev.date === "number" && ev.date < 1e12 ? ev.date * 1000 : ev.date) : new Date();

    if (!existente) {
      const deal = await acharDeal(outroLado, projetoIds);
      if (!deal) { console.log(`[Chamada] sem deal para ${outroLado} (${ev.from})`); return; }
      await prisma.crmAtividade.create({
        data: {
          dealId: deal.id, tipo: "ligacao", canal: "whatsapp", direcao, origem: "automatica",
          externoId: ev.id, criadoEm: isNaN(quando.getTime()) ? new Date() : quando,
          resultado: ev.status === "accept" ? "atendeu" : ev.status === "reject" ? "recusou" : "nao_atendeu",
          atendidaEm: ev.status === "accept" ? new Date() : null,
        },
      }).catch((err: any) => { if (err?.code !== "P2002") throw err; }); // corrida entre workers
      await prisma.crmDeal.update({ where: { id: deal.id }, data: { ultimoContatoEm: new Date(), followupEm: new Date() } });
      if (ev.status === "offer" || ev.status === "ringing") return;
    }

    const atual = existente ?? await prisma.crmAtividade.findUnique({ where: { externoId: ev.id } });
    if (!atual) return;
    // O SDR já completou/corrigiu à mão (resultado + resumo) — o evento não sobrescreve.
    if (atual.origem === "manual" || atual.nota) return;

    if (ev.status === "accept") {
      await prisma.crmAtividade.update({ where: { id: atual.id }, data: { resultado: "atendeu", atendidaEm: atual.atendidaEm ?? new Date() } });
    } else if (ev.status === "reject") {
      await prisma.crmAtividade.update({ where: { id: atual.id }, data: { resultado: atual.atendidaEm ? atual.resultado : "recusou" } });
    } else if (ev.status === "timeout") {
      await prisma.crmAtividade.update({ where: { id: atual.id }, data: { resultado: "nao_atendeu" } });
    } else if (ev.status === "terminate") {
      const dur = atual.atendidaEm ? Math.max(0, Math.round((Date.now() - atual.atendidaEm.getTime()) / 1000)) : null;
      await prisma.crmAtividade.update({
        where: { id: atual.id },
        data: atual.atendidaEm ? { resultado: "atendeu", duracaoSeg: dur } : {},
      });
    }
  } catch (err: any) {
    console.warn(`[Chamada] erro ao registrar evento ${ev?.id}: ${err?.message ?? err}`);
  }
}
