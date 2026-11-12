/**
 * Funil de acordos — funções puras (sem Prisma) usadas por routers/acordos.ts e routers/recebimentos.ts.
 *
 *  - prazo da avaliação prévia (§2.1);
 *  - quem redigiu a inicial (responsável da avaliação), a partir do histórico de colunas;
 *  - chave/normalização da empresa ré (agrupamento dos indicadores);
 *  - indicadores do funil (§2.4), êxito sem os encerrados por acordo, receita por tipo (§1.9).
 *
 * Dinheiro em centavos inteiros; datas como DataCal ("YYYY-MM-DD"), como no resto de lib/fin.
 */
import { deDataCal, diasEntre, paraDataCal, type Centavos, type DataCal } from "./util.js";

// ── Datas ────────────────────────────────────────────────────────────────────

export function addDias(d: DataCal, n: number): DataCal {
  return paraDataCal(new Date(deDataCal(d).getTime() + n * 86_400_000));
}

/**
 * Prazo da avaliação prévia de acordo: 5 dias antes da audiência; sem audiência, protocolo + 10 dias.
 * Nunca antes do protocolo (audiência muito próxima → o prazo é o próprio dia do protocolo).
 */
export function prazoAvaliacao(args: { protocolo: DataCal; audiencia?: DataCal | null }): DataCal {
  if (args.audiencia) {
    const p = addDias(args.audiencia, -5);
    return p < args.protocolo ? args.protocolo : p;
  }
  return addDias(args.protocolo, 10);
}

// ── Responsável pela avaliação (quem redigiu a inicial) ─────────────────────

export interface LogColuna {
  usuarioId: string | null;
  chaveAnterior: string | null;
  chaveNova: string | null;
  criadoEm: Date;
}

const RE_ELABORACAO = /inicial|elabora|redac|peticao/i;

/**
 * Melhor palpite de quem redigiu a inicial:
 *  1. o último usuário que TIROU o card de uma coluna de elaboração da inicial (quem terminou a peça e protocolou);
 *  2. `deal.responsavelId`;
 *  3. quem disparou o gatilho (moveu para "ajuizado" / gravou o CNJ).
 * Logs antigos do `crm.moveDeal` não gravavam `usuarioId` — por isso o fallback.
 */
export function escolherResponsavelInicial(
  logs: LogColuna[],
  dealResponsavelId: string | null | undefined,
  usuarioGatilho: string | null | undefined,
): string | null {
  const ordenados = [...logs].sort((a, b) => b.criadoEm.getTime() - a.criadoEm.getTime());
  const saiu = ordenados.find((l) => l.usuarioId && l.chaveAnterior && RE_ELABORACAO.test(l.chaveAnterior));
  return saiu?.usuarioId ?? dealResponsavelId ?? usuarioGatilho ?? null;
}

/** Coluna de "ajuizado" do funil processual (chave contendo `ajuizado`). */
export function ehColunaAjuizado(chave: string | null | undefined): boolean {
  return !!chave && chave.toLowerCase().includes("ajuizado");
}

// ── Empresa ré ───────────────────────────────────────────────────────────────

const SUFIXOS = new Set(["ltda", "me", "epp", "eireli", "sa", "s", "a", "cia", "slu", "ss", "mei", "limitada"]);

export function apenasDigitos(s: string): string {
  return s.replace(/\D/g, "");
}

/** Extrai um CNPJ (14 dígitos, com ou sem máscara) de um texto livre. */
export function extrairCnpj(texto: string | null | undefined): string | null {
  if (!texto) return null;
  const m = /(\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2})/.exec(texto);
  if (!m) return null;
  const d = apenasDigitos(m[1]);
  return d.length === 14 ? d : null;
}

/** Nome normalizado: sem acento, minúsculo, sem pontuação e sem sufixo societário. */
export function normalizarNomeEmpresa(nome: string): string {
  const base = nome
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}/g, " ") // tira CNPJ do nome
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  while (base.length > 1 && SUFIXOS.has(base[base.length - 1])) base.pop();
  return base.join(" ");
}

export interface EmpresaRe {
  chave: string; // "cnpj:<14 dígitos>" | "nome:<normalizado>" | "sem_empresa"
  nome: string; // como veio (para exibir)
  cnpj: string | null;
}

/**
 * Empresa reclamada do deal, na mesma ordem de `routers/audiencia.ts` ({empresa}):
 * 1º vínculo de emprego → empresa do contato → `deal.organizacao` (Pipedrive).
 * Agrupa por CNPJ quando houver um no texto; senão pelo nome normalizado.
 */
export function empresaReDoDeal(fontes: {
  vinculoEmpresa?: string | null;
  contatoEmpresa?: string | null;
  organizacao?: string | null;
}): EmpresaRe {
  const nome = [fontes.vinculoEmpresa, fontes.contatoEmpresa, fontes.organizacao].map((s) => s?.trim()).find((s) => !!s) ?? "";
  if (!nome) return { chave: "sem_empresa", nome: "(sem empresa)", cnpj: null };
  const cnpj = extrairCnpj(nome);
  if (cnpj) return { chave: `cnpj:${cnpj}`, nome, cnpj };
  const norm = normalizarNomeEmpresa(nome);
  return norm ? { chave: `nome:${norm}`, nome, cnpj: null } : { chave: "sem_empresa", nome: "(sem empresa)", cnpj: null };
}

// ── Indicadores do funil (§2.4) ─────────────────────────────────────────────

export const STATUS_ABERTOS = ["em_negociacao", "firmado", "aguardando_homologacao"] as const;
export const STATUS_FECHADOS = ["firmado", "aguardando_homologacao", "homologado"] as const;
export const FASES = ["previo", "pos_contestacao", "pos_replica", "pos_pericia", "pos_sentenca", "recursal", "execucao"] as const;

export interface AcordoParaIndicador {
  id: string;
  tipo: string; // previo | posterior
  status: string;
  faseOrigem: string | null;
  valorAcordo: Centavos | null;
  valorCausa: Centavos | null; // deal.valorCausaAjuizada (ou estimado)
  estimativaCondenacao: Centavos | null;
  ajuizadoEm: DataCal | null;
  fechadoEm: DataCal | null; // homologadoEm ?? firmadoEm
  empresa: EmpresaRe;
  parcelas: Array<{ vencimento: DataCal | null; dataRecebimento: DataCal | null; valorPrevisto: Centavos | null }>;
}

export interface RazaoMedia {
  qtd: number;
  media: number | null; // média das razões (0..n)
  agregada: number | null; // soma dos acordos / soma da base
}

export interface BlocoIndicadores {
  total: number;
  porStatus: Record<string, number>;
  porTipo: Record<string, { total: number; fechados: number; semAcordo: number; emAberto: number; taxaConversao: number | null; taxaSobreTotal: number | null }>;
  fechados: number;
  semAcordo: number;
  taxaConversao: number | null; // fechados / (fechados + sem_acordo)
  valorTotalAcordos: Centavos;
  acordoSobreCausa: RazaoMedia;
  acordoSobreEstimativa: RazaoMedia;
  porFase: Record<string, number>; // fechados por fase de origem
  tempoMedioDias: number | null; // ajuizamento → acordo (firmado/homologado)
  inadimplencia: {
    parcelasVencidas: number;
    parcelasEmAtraso: number;
    valorVencido: Centavos;
    valorEmAtraso: Centavos;
    taxaParcelas: number | null; // em atraso / vencidas (qtd)
    taxaValor: number | null;
    acordosComParcelas: number;
    acordosInadimplentes: number;
    taxaAcordos: number | null;
  };
}

function razao(xs: Array<{ num: Centavos | null; den: Centavos | null }>): RazaoMedia {
  const v = xs.filter((x) => (x.num ?? 0) > 0 && (x.den ?? 0) > 0) as Array<{ num: number; den: number }>;
  if (!v.length) return { qtd: 0, media: null, agregada: null };
  const media = v.reduce((a, x) => a + x.num / x.den, 0) / v.length;
  const agregada = v.reduce((a, x) => a + x.num, 0) / v.reduce((a, x) => a + x.den, 0);
  return { qtd: v.length, media: arred4(media), agregada: arred4(agregada) };
}

function arred4(x: number): number {
  return Math.round(x * 10000) / 10000;
}

function taxa(n: number, d: number): number | null {
  return d > 0 ? arred4(n / d) : null;
}

export function calcularIndicadores(lista: AcordoParaIndicador[], hoje: DataCal): BlocoIndicadores {
  const fech = new Set<string>(STATUS_FECHADOS);
  const porStatus: Record<string, number> = {};
  const porTipo: BlocoIndicadores["porTipo"] = {};
  const porFase: Record<string, number> = {};
  let fechados = 0, semAcordo = 0, valorTotal = 0;
  const tempos: number[] = [];

  for (const a of lista) {
    porStatus[a.status] = (porStatus[a.status] ?? 0) + 1;
    const t = (porTipo[a.tipo] ??= { total: 0, fechados: 0, semAcordo: 0, emAberto: 0, taxaConversao: null, taxaSobreTotal: null });
    t.total++;
    if (fech.has(a.status)) {
      fechados++; t.fechados++;
      valorTotal += a.valorAcordo ?? 0;
      const fase = a.faseOrigem ?? "nao_informada";
      porFase[fase] = (porFase[fase] ?? 0) + 1;
      if (a.ajuizadoEm && a.fechadoEm) tempos.push(Math.max(0, diasEntre(a.ajuizadoEm, a.fechadoEm)));
    } else if (a.status === "sem_acordo") {
      semAcordo++; t.semAcordo++;
    }
    if (a.status === "em_negociacao") t.emAberto++;
  }
  for (const t of Object.values(porTipo)) {
    t.taxaConversao = taxa(t.fechados, t.fechados + t.semAcordo);
    t.taxaSobreTotal = taxa(t.fechados, t.total);
  }

  const fechadosLista = lista.filter((a) => fech.has(a.status));
  let parcelasVencidas = 0, parcelasEmAtraso = 0, valorVencido = 0, valorEmAtraso = 0, acordosComParcelas = 0, acordosInadimplentes = 0;
  for (const a of fechadosLista) {
    if (!a.parcelas.length) continue;
    acordosComParcelas++;
    let inad = false;
    for (const p of a.parcelas) {
      if (!p.vencimento || p.vencimento >= hoje) continue;
      parcelasVencidas++;
      valorVencido += p.valorPrevisto ?? 0;
      if (!p.dataRecebimento) {
        parcelasEmAtraso++;
        valorEmAtraso += p.valorPrevisto ?? 0;
        inad = true;
      }
    }
    if (inad) acordosInadimplentes++;
  }

  return {
    total: lista.length,
    porStatus,
    porTipo,
    fechados,
    semAcordo,
    taxaConversao: taxa(fechados, fechados + semAcordo),
    valorTotalAcordos: valorTotal,
    acordoSobreCausa: razao(fechadosLista.map((a) => ({ num: a.valorAcordo, den: a.valorCausa }))),
    acordoSobreEstimativa: razao(fechadosLista.map((a) => ({ num: a.valorAcordo, den: a.estimativaCondenacao }))),
    porFase,
    tempoMedioDias: tempos.length ? Math.round((tempos.reduce((x, y) => x + y, 0) / tempos.length) * 10) / 10 : null,
    inadimplencia: {
      parcelasVencidas, parcelasEmAtraso, valorVencido, valorEmAtraso,
      taxaParcelas: taxa(parcelasEmAtraso, parcelasVencidas),
      taxaValor: taxa(valorEmAtraso, valorVencido),
      acordosComParcelas, acordosInadimplentes,
      taxaAcordos: taxa(acordosInadimplentes, acordosComParcelas),
    },
  };
}

/** Mesmos indicadores agrupados por empresa ré (chave CNPJ/nome normalizado), maior volume primeiro. */
export function indicadoresPorEmpresa(lista: AcordoParaIndicador[], hoje: DataCal): Array<{ chave: string; nome: string; cnpj: string | null; indicadores: BlocoIndicadores }> {
  const grupos = new Map<string, AcordoParaIndicador[]>();
  for (const a of lista) {
    const g = grupos.get(a.empresa.chave);
    if (g) g.push(a); else grupos.set(a.empresa.chave, [a]);
  }
  const out = [...grupos.entries()].map(([chave, itens]) => {
    // nome exibido = grafia mais frequente no grupo
    const freq = new Map<string, number>();
    for (const i of itens) freq.set(i.empresa.nome, (freq.get(i.empresa.nome) ?? 0) + 1);
    const nome = [...freq.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
    return { chave, nome, cnpj: itens.find((i) => i.empresa.cnpj)?.empresa.cnpj ?? null, indicadores: calcularIndicadores(itens, hoje) };
  });
  return out.sort((a, b) => b.indicadores.total - a.indicadores.total || a.nome.localeCompare(b.nome));
}

// ── Êxito (sem os encerrados por acordo) ────────────────────────────────────

export interface DealParaExito {
  id: string;
  valorCondenacao: Centavos | null; // null = sem resultado registrado; 0 = improcedente
  valorCausa: Centavos | null;
  encerradoPorAcordo: boolean; // Acordo homologado ou deal.valorAcordo preenchido
}

/**
 * % de êxito judicial. Não havia cálculo de êxito no sistema; este nasce já excluindo os
 * processos encerrados por acordo (decisão 11). Base = processos com `valorCondenacao`
 * registrado: > 0 é êxito, 0 é improcedência.
 */
export function calcularExito(lista: DealParaExito[]) {
  const base = lista.filter((d) => !d.encerradoPorAcordo && d.valorCondenacao !== null);
  const exitos = base.filter((d) => (d.valorCondenacao ?? 0) > 0);
  return {
    excluidosPorAcordo: lista.filter((d) => d.encerradoPorAcordo).length,
    comResultado: base.length,
    exitos: exitos.length,
    improcedentes: base.length - exitos.length,
    taxaExito: taxa(exitos.length, base.length),
    valorTotalCondenacoes: exitos.reduce((a, d) => a + (d.valorCondenacao ?? 0), 0),
    condenacaoSobreCausa: razao(exitos.map((d) => ({ num: d.valorCondenacao, den: d.valorCausa }))),
  };
}

// ── Receita por tipo (§1.9) ─────────────────────────────────────────────────

export interface RecebimentoParaReceita {
  tipo: string; // acordo | execucao
  dealId: string | null;
  dataRecebimento: DataCal | null;
  receitaEscritorio: Centavos; // honorários + sucumbência
  bruto: Centavos;
  ajuizadoEm: DataCal | null;
}

export function receitaPorTipo(lista: RecebimentoParaReceita[]) {
  const tipos = new Map<string, RecebimentoParaReceita[]>();
  for (const r of lista) {
    if (!r.dataRecebimento) continue;
    const g = tipos.get(r.tipo);
    if (g) g.push(r); else tipos.set(r.tipo, [r]);
  }
  const bloco = (itens: RecebimentoParaReceita[]) => {
    const receita = itens.reduce((a, r) => a + r.receitaEscritorio, 0);
    const bruto = itens.reduce((a, r) => a + r.bruto, 0);
    // tempo: do ajuizamento ao PRIMEIRO recebimento de cada processo
    const primeiro = new Map<string, { aj: DataCal; rec: DataCal }>();
    for (const r of itens) {
      if (!r.dealId || !r.ajuizadoEm || !r.dataRecebimento) continue;
      const atual = primeiro.get(r.dealId);
      if (!atual || r.dataRecebimento < atual.rec) primeiro.set(r.dealId, { aj: r.ajuizadoEm, rec: r.dataRecebimento });
    }
    const tempos = [...primeiro.values()].map((p) => Math.max(0, diasEntre(p.aj, p.rec)));
    const processos = new Set(itens.filter((r) => r.dealId).map((r) => r.dealId)).size + itens.filter((r) => !r.dealId).length;
    return {
      qtdRecebimentos: itens.length,
      qtdProcessos: processos,
      bruto,
      receitaEscritorio: receita,
      ticketMedioPorRecebimento: itens.length ? Math.round(receita / itens.length) : 0,
      ticketMedioPorProcesso: processos ? Math.round(receita / processos) : 0,
      tempoMedioAjuizamentoRecebimentoDias: tempos.length ? Math.round((tempos.reduce((a, b) => a + b, 0) / tempos.length) * 10) / 10 : null,
    };
  };
  const todos = [...tipos.values()].flat();
  return {
    acordo: bloco(tipos.get("acordo") ?? []),
    execucao: bloco(tipos.get("execucao") ?? []),
    total: bloco(todos),
  };
}
