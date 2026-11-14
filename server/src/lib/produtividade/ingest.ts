import { createHash, randomBytes, randomInt } from "node:crypto";
import { prisma } from "../../db.js";
import { dominioDaUrl } from "./classificar.js";
import { dataLocal } from "./calculo.js";

const ALFABETO = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // sem 0/O/1/I
const BUCKETS = ["janela", "afk", "web"] as const;
const DIA_MS = 24 * 3600 * 1000;

export function gerarCodigoPareamento(): string {
  let c = "";
  for (let i = 0; i < 8; i++) c += ALFABETO[randomInt(ALFABETO.length)];
  return c;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function parear(input: { codigo: string; nome: string; so: string }): Promise<{ token: string; dispositivoId: string }> {
  const codigo = String(input.codigo ?? "").trim().toUpperCase();
  if (!codigo) throw new Error("codigo_invalido");
  const disp = await prisma.monitorDispositivo.findFirst({ where: { codigoPareamento: codigo } });
  if (!disp || disp.pareadoEm || !disp.codigoExpiraEm || disp.codigoExpiraEm.getTime() < Date.now()) {
    throw new Error("codigo_invalido");
  }
  const token = randomBytes(32).toString("hex");
  await prisma.monitorDispositivo.update({
    where: { id: disp.id },
    data: {
      tokenHash: hashToken(token),
      codigoPareamento: null,
      codigoExpiraEm: null,
      pareadoEm: new Date(),
      nome: String(input.nome ?? "").trim().slice(0, 200) || disp.nome,
      so: input.so ? String(input.so).slice(0, 50) : disp.so,
    },
  });
  return { token, dispositivoId: disp.id };
}

export type LoteIngest = {
  versao: string;
  so: string;
  eventos: { bucket: "janela" | "afk" | "web"; inicio: string; duracaoSeg: number; app?: string; titulo?: string; url?: string; afk?: boolean }[];
};

/** Dias locais (-03:00) de dataLocal(inicio) até dataLocal(fim), inclusive. */
function diasCobertos(inicio: Date, fim: Date): string[] {
  const ini = dataLocal(inicio);
  const ate = dataLocal(fim);
  const out = [ini];
  let cur = ini;
  let t = new Date(`${ini}T12:00:00-03:00`).getTime();
  while (cur < ate && out.length < 400) {
    t += DIA_MS;
    cur = dataLocal(new Date(t));
    out.push(cur);
  }
  return out;
}

export async function ingerir(token: string, lote: LoteIngest): Promise<{ gravados: number; dias: string[] }> {
  const disp = token ? await prisma.monitorDispositivo.findFirst({ where: { tokenHash: hashToken(token), ativo: true } }) : null;
  if (!disp) throw new Error("token_invalido");

  const agora = Date.now();
  const max = agora + 5 * 60_000;
  const min = agora - 90 * DIA_MS;

  // Valida, normaliza e deduplica por (bucket, inicio) — o último vence.
  const validos = new Map<string, {
    bucket: string; inicio: Date; duracaoSeg: number;
    app: string | null; titulo: string | null; url: string | null; dominio: string | null; afk: boolean | null;
  }>();
  for (const e of Array.isArray(lote?.eventos) ? lote.eventos : []) {
    if (!e || !(BUCKETS as readonly string[]).includes(e.bucket)) continue;
    const inicio = new Date(e.inicio);
    const dur = Number(e.duracaoSeg);
    if (isNaN(inicio.getTime()) || !isFinite(dur) || dur < 0) continue;
    if (inicio.getTime() > max || inicio.getTime() < min) continue;
    const url = e.url ? String(e.url).slice(0, 1000) : null;
    validos.set(`${e.bucket}|${inicio.getTime()}`, {
      bucket: e.bucket,
      inicio,
      duracaoSeg: dur,
      app: e.app ? String(e.app).slice(0, 300) : null,
      titulo: e.titulo ? String(e.titulo).slice(0, 500) : null,
      url,
      dominio: url ? dominioDaUrl(url) : null,
      afk: typeof e.afk === "boolean" ? e.afk : null,
    });
  }
  const eventos = [...validos.values()];

  if (eventos.length) {
    const existentes = await prisma.monitorEvento.findMany({
      where: { dispositivoId: disp.id, inicio: { in: eventos.map((e) => e.inicio) } },
      select: { id: true, bucket: true, inicio: true, duracaoSeg: true },
    });
    const porChave = new Map(existentes.map((x) => [`${x.bucket}|${x.inicio.getTime()}`, x]));
    const novos = eventos.filter((e) => !porChave.has(`${e.bucket}|${e.inicio.getTime()}`));
    if (novos.length) {
      await prisma.monitorEvento.createMany({
        data: novos.map((e) => ({ dispositivoId: disp.id, ...e })),
        skipDuplicates: true,
      });
    }
    for (const e of eventos) {
      const ex = porChave.get(`${e.bucket}|${e.inicio.getTime()}`);
      if (!ex) continue;
      await prisma.monitorEvento.update({
        where: { dispositivoId_bucket_inicio: { dispositivoId: disp.id, bucket: e.bucket, inicio: e.inicio } },
        data: { duracaoSeg: e.duracaoSeg, app: e.app, titulo: e.titulo, url: e.url, dominio: e.dominio, afk: e.afk },
      });
    }
  }

  const vistos = new Set(disp.bucketsVistos ?? []);
  for (const e of eventos) vistos.add(e.bucket);
  const temTitulo = eventos.some((e) => e.bucket === "janela" && e.titulo);
  const agoraD = new Date(agora);
  await prisma.monitorDispositivo.update({
    where: { id: disp.id },
    data: {
      ultimoEnvioEm: agoraD,
      versaoColetor: lote?.versao ? String(lote.versao).slice(0, 50) : disp.versaoColetor,
      so: lote?.so ? String(lote.so).slice(0, 50) : disp.so,
      bucketsVistos: [...vistos],
      ...(temTitulo ? { ultimoTituloEm: agoraD } : {}),
    },
  });

  const dias = new Set<string>();
  for (const e of eventos) {
    for (const d of diasCobertos(e.inicio, new Date(e.inicio.getTime() + e.duracaoSeg * 1000))) dias.add(d);
  }
  for (const data of dias) {
    await prisma.monitorDia.upsert({
      where: { usuarioId_data: { usuarioId: disp.usuarioId, data } },
      create: { usuarioId: disp.usuarioId, data, sujo: true },
      update: { sujo: true },
    });
  }

  return { gravados: eventos.length, dias: [...dias].sort() };
}
