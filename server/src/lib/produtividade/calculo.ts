import { classificar } from "./classificar.js";
import {
  EXPEDIENTE_PADRAO,
  type Categoria,
  type EventoBruto,
  type Expediente,
  type Item,
  type Regra,
  type ResultadoDia,
  type Totais,
} from "./tipos.js";

const DIA_SEG = 86_400;
const FUSO_MS = 3 * 3_600_000;
const NAVEGADORES = ["chrome", "google chrome", "msedge", "microsoft edge", "firefox", "brave", "safari", "opera"];
const MIN_BLOCO_SEG = 60;

/** "YYYY-MM-DD" em -03:00. */
export function dataLocal(d: Date): string {
  return new Date(d.getTime() - FUSO_MS).toISOString().slice(0, 10);
}

function ehNavegador(app: string | null | undefined): boolean {
  if (!app) return false;
  const a = app.toLowerCase().replace(/\.exe$/, "").trim();
  return NAVEGADORES.includes(a);
}

function hhmmSeg(s: string): number {
  const [h, m] = s.split(":").map(Number);
  return (h ?? 0) * 3600 + (m ?? 0) * 60;
}

const zero = (): Totais => ({ ativo: 0, trabalho: 0, pessoal: 0, neutro: 0 });

function faixa(e: EventoBruto, inicioDia: number): [number, number] | null {
  const ini = (e.inicio.getTime() - inicioDia) / 1000;
  const a = Math.max(0, Math.round(ini));
  const b = Math.min(DIA_SEG, Math.round(ini + e.duracaoSeg));
  return b > a ? [a, b] : null;
}

type Bloco = { ini: number; fim: number; cat: Categoria | "pausa" };

export function calcularDia(
  data: string,
  eventos: EventoBruto[],
  regras: Regra[],
  pessoa: { usuarioId: string; cargoId: string | null; expediente: Expediente | null },
): ResultadoDia {
  const inicioDia = new Date(`${data}T00:00:00-03:00`).getTime();
  const exp = pessoa.expediente ?? EXPEDIENTE_PADRAO;
  const diaSemana = new Date(`${data}T12:00:00Z`).getUTCDay();
  const expIni = hhmmSeg(exp.inicio);
  const expFim = hhmmSeg(exp.fim);
  const diaUtil = exp.dias.includes(diaSemana);

  // 1. ativo (união entre dispositivos)
  const ativo = new Uint8Array(DIA_SEG);
  for (const e of eventos) {
    if (e.bucket !== "afk" || e.afk !== false) continue;
    const f = faixa(e, inicioDia);
    if (f) ativo.fill(1, f[0], f[1]);
  }

  // 2. item: janelas ordenadas; primeiro a ocupar fica
  const itens: Item[] = [];
  const indice = new Map<string, number>();
  const idItem = (it: Item): number => {
    const k = JSON.stringify([it.app, it.dominio, it.titulo]);
    let i = indice.get(k);
    if (i === undefined) {
      i = itens.length;
      itens.push(it);
      indice.set(k, i);
    }
    return i;
  };
  const janelaIdx = new Int32Array(DIA_SEG).fill(-1);
  const ordenadas = eventos.filter((e) => e.bucket === "janela").sort((a, b) => a.inicio.getTime() - b.inicio.getTime());
  const webs = eventos.filter((e) => e.bucket === "web").sort((a, b) => a.inicio.getTime() - b.inicio.getTime());
  const webIdx = new Int32Array(DIA_SEG).fill(-1);
  const webItens: Item[] = [];
  for (const w of webs) {
    const f = faixa(w, inicioDia);
    if (!f) continue;
    const wi = webItens.push({ app: null, dominio: w.dominio ?? null, titulo: w.titulo ?? null }) - 1;
    for (let s = f[0]; s < f[1]; s++) if (webIdx[s] === -1) webIdx[s] = wi;
  }
  for (const j of ordenadas) {
    const f = faixa(j, inicioDia);
    if (!f) continue;
    const base: Item = { app: j.app ?? null, dominio: null, titulo: j.titulo ?? null };
    const nav = ehNavegador(j.app);
    for (let s = f[0]; s < f[1]; s++) {
      if (!ativo[s] || janelaIdx[s] !== -1) continue;
      const w = nav && webIdx[s] !== -1 ? webItens[webIdx[s]!]! : null;
      janelaIdx[s] = idItem(w ? { app: base.app, dominio: w.dominio, titulo: w.titulo } : base);
    }
  }
  const vazio = idItem({ app: null, dominio: null, titulo: null });

  // 3-5. classificar, totais e top
  const cats = new Map<number, Categoria>();
  const catDe = (i: number): Categoria => {
    let c = cats.get(i);
    if (!c) {
      c = classificar(itens[i]!, regras, pessoa);
      cats.set(i, c);
    }
    return c;
  };
  const dentro = zero();
  const fora = zero();
  const topMap: Record<Categoria, Map<string, number>> = { trabalho: new Map(), pessoal: new Map(), neutro: new Map() };
  const catPos: (Categoria | "pausa")[] = new Array(DIA_SEG);
  const itemPos = new Int32Array(DIA_SEG).fill(-1);
  let primeiro = -1;
  let ultimo = -1;
  for (let s = 0; s < DIA_SEG; s++) {
    if (!ativo[s]) {
      catPos[s] = "pausa";
      continue;
    }
    if (primeiro === -1) primeiro = s;
    ultimo = s;
    const i = janelaIdx[s] === -1 ? vazio : janelaIdx[s]!;
    itemPos[s] = i;
    const c = catDe(i);
    catPos[s] = c;
    const t = diaUtil && s >= expIni && s < expFim ? dentro : fora;
    t.ativo++;
    t[c]++;
    const it = itens[i]!;
    const chave = it.dominio || it.app;
    if (chave) topMap[c].set(chave, (topMap[c].get(chave) ?? 0) + 1);
  }
  const top = {} as ResultadoDia["top"];
  for (const c of ["trabalho", "pessoal", "neutro"] as const) {
    top[c] = [...topMap[c].entries()]
      .map(([chave, seg]) => ({ chave, seg }))
      .sort((a, b) => b.seg - a.seg || a.chave.localeCompare(b.chave))
      .slice(0, 10);
  }

  // 6. blocos
  const blocos: ResultadoDia["blocos"] = [];
  if (primeiro !== -1) {
    let runs: Bloco[] = [];
    for (let s = primeiro; s <= ultimo; s++) {
      const ult = runs[runs.length - 1];
      if (ult && ult.cat === catPos[s]) ult.fim = s + 1;
      else runs.push({ ini: s, fim: s + 1, cat: catPos[s]! });
    }
    const juntos: Bloco[] = [];
    for (const r of runs) {
      const ant = juntos[juntos.length - 1];
      if (ant && r.fim - r.ini < MIN_BLOCO_SEG) ant.fim = r.fim;
      else if (ant && ant.cat === r.cat) ant.fim = r.fim;
      else juntos.push({ ...r });
    }
    runs = juntos;
    for (const b of runs) {
      const freqItem = new Map<number, number>();
      for (let s = b.ini; s < b.fim; s++) {
        const i = itemPos[s]!;
        if (i !== -1) freqItem.set(i, (freqItem.get(i) ?? 0) + 1);
      }
      const freqChave = new Map<string, number>();
      const freqTitulo = new Map<string, number>();
      for (const [i, n] of freqItem) {
        const it = itens[i]!;
        const k = it.dominio || it.app;
        if (k) freqChave.set(k, (freqChave.get(k) ?? 0) + n);
        if (it.titulo) freqTitulo.set(it.titulo, (freqTitulo.get(it.titulo) ?? 0) + n);
      }
      const maisFreq = (m: Map<string, number>) => [...m.entries()].sort((a, c) => c[1] - a[1]);
      blocos.push({
        inicio: new Date(inicioDia + b.ini * 1000),
        fim: new Date(inicioDia + b.fim * 1000),
        categoria: b.cat,
        chave: maisFreq(freqChave)[0]?.[0] ?? "",
        titulos: maisFreq(freqTitulo).slice(0, 5).map(([t]) => t),
      });
    }
  }

  return {
    data,
    dentro,
    fora,
    primeiroEvento: primeiro === -1 ? null : new Date(inicioDia + primeiro * 1000),
    ultimoEvento: ultimo === -1 ? null : new Date(inicioDia + (ultimo + 1) * 1000),
    top,
    blocos,
  };
}
