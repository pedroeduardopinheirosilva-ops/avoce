export type Categoria = "trabalho" | "pessoal" | "neutro";

export type Regra = {
  alvo: "app" | "dominio" | "titulo";
  padrao: string;
  categoria: Categoria;
  cargoId: string | null;
  usuarioId: string | null;
  prioridade: number;
};

export type Item = { app: string | null; dominio: string | null; titulo: string | null };

export type EventoBruto = {
  dispositivoId: string;
  bucket: "janela" | "afk" | "web";
  inicio: Date;
  duracaoSeg: number;
  app?: string | null;
  titulo?: string | null;
  url?: string | null;
  dominio?: string | null;
  afk?: boolean | null;
};

/** dias: 0 = domingo ... 6 = sábado; inicio/fim "HH:MM" em -03:00. */
export type Expediente = { dias: number[]; inicio: string; fim: string };
export const EXPEDIENTE_PADRAO: Expediente = { dias: [1, 2, 3, 4, 5], inicio: "08:00", fim: "18:00" };

export type Totais = { ativo: number; trabalho: number; pessoal: number; neutro: number };

export type ResultadoDia = {
  data: string;
  dentro: Totais;
  fora: Totais;
  primeiroEvento: Date | null;
  ultimoEvento: Date | null;
  top: Record<Categoria, { chave: string; seg: number }[]>;
  blocos: { inicio: Date; fim: Date; categoria: Categoria | "pausa"; chave: string; titulos: string[] }[];
};
