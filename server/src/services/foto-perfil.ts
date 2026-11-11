/**
 * Foto de perfil do WhatsApp dos contatos do CRM.
 *
 * A Evolution devolve uma URL do pps.whatsapp.net que expira em ~10 dias e que o
 * navegador do atendente nem sempre consegue abrir. Por isso a imagem é baixada
 * uma vez para disco e servida pelo próprio Avoce (/api/contato-foto/:contatoId).
 * `fotoPerfilEm` registra a última consulta — inclusive quando o contato não tem
 * foto ou a privacidade esconde — para não bater na Evolution a cada mensagem.
 */

import { mkdirSync, existsSync, unlinkSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { prisma } from "../db.js";
import { fetchProfilePictureUrl, type EvolutionConfig } from "./evolution.js";

const UPLOADS_BASE = process.env.UPLOADS_DIR ?? "/opt/avoce/uploads";
export const FOTOS_PERFIL_DIR = resolve(join(UPLOADS_BASE, "fotos-perfil"));

/** Depois de quanto tempo vale a pena perguntar de novo à Evolution. */
const REFRESH_MS = 3 * 24 * 60 * 60 * 1000;

export function fotoPerfilPath(contatoId: string): string {
  return join(FOTOS_PERFIL_DIR, `${contatoId.replace(/[^a-zA-Z0-9_-]/g, "")}.jpg`);
}

export function fotoPerfilEstaFresca(fotoPerfilEm: Date | null | undefined): boolean {
  return !!fotoPerfilEm && Date.now() - fotoPerfilEm.getTime() < REFRESH_MS;
}

/**
 * Consulta a Evolution, baixa a imagem e grava no contato.
 * Devolve true quando o contato ficou com foto no disco.
 */
export async function atualizarFotoPerfil(
  contato: { id: string; whatsapp: string | null; fotoPerfilEm?: Date | null },
  evo: EvolutionConfig,
  opts: { force?: boolean } = {},
): Promise<boolean> {
  if (!contato.whatsapp) return false;
  if (!opts.force && fotoPerfilEstaFresca(contato.fotoPerfilEm)) return existsSync(fotoPerfilPath(contato.id));

  const url = await fetchProfilePictureUrl(evo, contato.whatsapp);
  const agora = new Date();
  const destino = fotoPerfilPath(contato.id);

  if (!url) {
    // Sem foto (ou privacidade). Remove a antiga para o painel voltar às iniciais.
    if (existsSync(destino)) { try { unlinkSync(destino); } catch { /* ignore */ } }
    await prisma.crmContato.update({ where: { id: contato.id }, data: { fotoPerfilUrl: null, fotoPerfilEm: agora } });
    return false;
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 100) throw new Error("imagem vazia");
    mkdirSync(FOTOS_PERFIL_DIR, { recursive: true });
    await writeFile(destino, buf);
    await prisma.crmContato.update({ where: { id: contato.id }, data: { fotoPerfilUrl: url, fotoPerfilEm: agora } });
    return true;
  } catch (err: any) {
    console.warn(`[FotoPerfil] Falha ao baixar foto de ${contato.whatsapp}: ${err?.message ?? err}`);
    // Guarda a URL mesmo assim: o painel ainda tenta exibir e a próxima rodada baixa de novo.
    await prisma.crmContato.update({ where: { id: contato.id }, data: { fotoPerfilUrl: url, fotoPerfilEm: agora } });
    return existsSync(destino);
  }
}

/**
 * Dispara a atualização sem bloquear o fluxo da mensagem (webhook).
 */
export function atualizarFotoPerfilEmSegundoPlano(
  contato: { id: string; whatsapp: string | null; fotoPerfilEm?: Date | null },
  evo: EvolutionConfig | null,
): void {
  if (!evo || !contato.whatsapp) return;
  if (fotoPerfilEstaFresca(contato.fotoPerfilEm) && existsSync(fotoPerfilPath(contato.id))) return;
  atualizarFotoPerfil(contato, evo).catch((err) =>
    console.warn(`[FotoPerfil] Erro em segundo plano (${contato.whatsapp}): ${err?.message ?? err}`),
  );
}

/**
 * Cron: renova as fotos dos contatos com conversa recente. A foto do WhatsApp muda
 * e a URL expira; sem renovação o painel ficaria com avatar velho ou quebrado.
 * Percorre por projeto porque cada projeto tem sua instância Evolution.
 */
export async function renovarFotosPerfilAtivas(opts: { diasAtividade?: number; limite?: number } = {}): Promise<{ consultados: number; comFoto: number }> {
  const diasAtividade = opts.diasAtividade ?? 30;
  const limite = opts.limite ?? 300;
  const desde = new Date(Date.now() - diasAtividade * 24 * 60 * 60 * 1000);
  const corte = new Date(Date.now() - REFRESH_MS);

  const deals = await prisma.crmDeal.findMany({
    where: {
      projetoId: { not: null },
      ultimoContatoEm: { gte: desde },
      contato: {
        whatsapp: { not: null },
        OR: [{ fotoPerfilEm: null }, { fotoPerfilEm: { lt: corte } }],
      },
    },
    select: { projetoId: true, contato: { select: { id: true, whatsapp: true, fotoPerfilEm: true } } },
    orderBy: { ultimoContatoEm: "desc" },
    take: limite,
  });

  const { getEvolutionConfig } = await import("../agent/message-handler.js");
  const evoPorProjeto = new Map<string, EvolutionConfig | null>();
  const vistos = new Set<string>();
  let consultados = 0, comFoto = 0;

  for (const d of deals) {
    if (!d.projetoId || !d.contato || vistos.has(d.contato.id)) continue;
    vistos.add(d.contato.id);
    if (!evoPorProjeto.has(d.projetoId)) evoPorProjeto.set(d.projetoId, await getEvolutionConfig(d.projetoId));
    const evo = evoPorProjeto.get(d.projetoId);
    if (!evo) continue;
    consultados++;
    try {
      if (await atualizarFotoPerfil(d.contato, evo, { force: true })) comFoto++;
    } catch (err: any) {
      console.warn(`[FotoPerfil] Cron falhou p/ ${d.contato.whatsapp}: ${err?.message ?? err}`);
    }
    // A Evolution/WhatsApp limita consultas em rajada.
    await new Promise((r) => setTimeout(r, 250));
  }
  return { consultados, comFoto };
}
