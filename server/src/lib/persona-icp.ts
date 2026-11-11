/**
 * Persona (ICP da RAP) a partir do que a IA extraiu da conversa (`CrmDeal.qualificacao`).
 *
 * ICP: motorista carreteiro, CLT, ainda na empresa ou saiu há menos de 2 anos (prazo), e
 * agravantes que aumentam o caso — frota ≥ 30 caminhões, ≥ 1,5 ano de casa, pagamento por fora.
 *
 *  - fora:     declarou não ser carreteiro, vínculo sem carteira (autônomo/agregado/informal)
 *              ou saiu há 2 anos ou mais;
 *  - ideal:    carreteiro + CLT + dentro do prazo + ao menos um agravante;
 *  - parcial:  carreteiro confirmado, sem cair em "fora", mas sem fechar o ideal
 *              (falta CLT/prazo confirmado ou não tem agravante);
 *  - sem_dados: a conversa não chegou a dizer se é carreteiro.
 *
 * Os campos são texto livre do LLM ("mais de 200", "1 ano e 4 meses", "ainda trabalha"):
 * a leitura é deliberadamente conservadora — na dúvida o critério fica "não sabido", nunca "sim".
 */

export type FaixaPersona = "ideal" | "parcial" | "fora" | "sem_dados";

export interface PersonaLead {
  faixa: FaixaPersona;
  carreteiro: boolean | null;
  clt: boolean | null;
  noPrazo: boolean | null;
  frota30: boolean | null;
  tempo18m: boolean | null;
  porFora: boolean | null;
}

const NUM: Record<string, number> = {
  um: 1, uma: 1, dois: 2, duas: 2, "três": 3, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7,
  oito: 8, nove: 9, dez: 10, onze: 11, doze: 12,
};
const n = (s: string) => (/^\d+$/.test(s) ? Number(s) : NUM[s] ?? NaN);
const txt = (v: unknown) => (typeof v === "string" ? v.trim().toLowerCase() : "");
const bool = (v: unknown): boolean | null => (v === true || v === "true" ? true : v === false || v === "false" ? false : null);

/** "2 anos e 9 meses" → 33 · "oito meses" → 8 · "de 2008 até 2019" → 132 · "desde 1993 até hoje" → … */
export function mesesDeCasa(t: string, hoje = new Date()): number | null {
  if (!t) return null;
  const anos = t.match(/(\d+|um|uma|dois|duas|três|tres|quatro|cinco|seis|sete|oito|nove|dez|onze|doze)\s+anos?/);
  const meses = t.match(/(\d+|um|uma|dois|duas|três|tres|quatro|cinco|seis|sete|oito|nove|dez|onze|doze)\s+m[eê]s(es)?/);
  const meio = /e\s+meio/.test(t) ? 6 : 0;
  if (anos || meses) {
    const total = (anos ? n(anos[1]) * 12 : 0) + (meses ? n(meses[1]) : 0) + meio;
    return Number.isFinite(total) ? total : null;
  }
  const faixa = t.match(/(19|20)\d{2}\D+((19|20)\d{2}|hoje|atual)/);
  if (faixa) {
    const ini = Number(t.match(/(19|20)\d{2}/)![0]);
    const fim = /hoje|atual/.test(faixa[2]) ? hoje.getFullYear() : Number(faixa[2]);
    return (fim - ini) * 12;
  }
  return null;
}

/** Frota ≥ 30: só "sim" quando o texto garante (mais de 50, 50 a 200, 80 caminhões…). */
export function frotaAte30(t: string): boolean | null {
  if (!t || /n[aã]o (sabe|informou)/.test(t)) return null;
  if (/menos de/.test(t)) {
    const m = t.match(/menos de\s+(\d+)/);
    return m && Number(m[1]) <= 30 ? false : null; // "menos de 50" não decide
  }
  const m = t.match(/(\d+)/);
  if (m) return Number(m[1]) >= 30;
  return null;
}

/** Ainda na empresa ou saiu há menos de 2 anos (prazo prescricional da ação). */
export function dentroDoPrazo(saida: string, dataSaida: string, ref: Date): boolean | null {
  if (/ainda (trabalh|est[aá]|empregad)|continua (trabalhando|na empresa)|afastad/.test(saida)) return true;
  const ms = dataSaida.match(/^(\d{1,2})\/(\d{4})$/);
  if (ms) {
    const saiu = new Date(Number(ms[2]), Number(ms[1]) - 1, 1);
    const meses = (ref.getFullYear() - saiu.getFullYear()) * 12 + ref.getMonth() - saiu.getMonth();
    return meses < 24;
  }
  const ha = saida.match(/h[aá]\s+(?:cerca de\s+|uns\s+|mais de\s+)?(\d+|um|uma|dois|duas|três|tres|quatro|cinco|seis|sete|oito|nove|dez)\s*(?:-\s*\d+\s*)?(anos?|m[eê]s(?:es)?)/);
  if (ha) {
    const q = n(ha[1]);
    if (!Number.isFinite(q)) return null;
    return ha[2].startsWith("ano") ? q < 2 : q < 24;
  }
  const ano = saida.match(/(?:at[eé]|em)\s+((19|20)\d{2})/);
  if (ano) return ref.getFullYear() - Number(ano[1]) < 2;
  return null;
}

function ehCarreteiro(q: any, funcao: string): boolean | null {
  const flag = bool(q?.e_carreteiro);
  if (flag !== null) return flag;
  if (/carret|caminh|bitrem|rodotrem|treminh|truck|ca[cç]amba|motorista de carga/.test(funcao)) return true;
  if (/[ôo]nibus|seguran|brigad|aplicativo|uber|van\b/.test(funcao) && !/carret|caminh/.test(funcao)) return false;
  return null;
}

function ehClt(q: any, vinculo: string): boolean | null {
  if (/clt|carteira|registrad/.test(vinculo) && !/sem (registro|carteira)/.test(vinculo)) return true;
  if (/informal|sem registro|sem carteira|aut[oô]nom|agregad|\bmei\b|pj\b|terceiriz.*sem/.test(vinculo)) return false;
  return bool(q?.e_clt);
}

function temPorFora(t: string): boolean | null {
  if (!t) return null;
  if (/^(n[aã]o|nao\b)|n[aã]o recebia|tudo no (holerite|contra)|n[aã]o tinha/.test(t)) return false;
  return true;
}

/**
 * Leitura das mensagens DO LEAD (direção "in") quando a IA não extraiu o dado — acontece quando
 * a SDR assume a conversa e a extração para. Só sinais fortes; o resto fica "não sabido".
 */
export function sinaisDaConversa(texto: string) {
  const t = texto.toLowerCase();
  const sim = (re: RegExp) => re.test(t);
  return {
    carreteiro: sim(/carret|bitrem|rodotrem|treminh|caminh[aã]o|caminhoneiro|truck|cavalo mec/) ? true
              : sim(/motorista de [ôo]nibus|sou (uber|motoboy)|de aplicativo/) ? false : null,
    clt: sim(/sem (carteira|registro)|n[aã]o (era |sou |fui )?(registrad|fichad)|aut[oô]nomo|agregad|sou mei|pj/) ? false
       : sim(/carteira assinada|registrad|fichad|clt/) ? true : null,
    noPrazo: sim(/ainda (trabalho|t[oô] |estou|sou funcion)|(estou|t[oô]) trabalhando (na|nela|l[aá])/) ? true : null,
    porFora: sim(/por fora|fora do (holerite|contra)|no pix|em m[aã]os?|comiss[aã]o|di[aá]ria/) ? true : null,
  };
}

/** `ref` = data de entrada do lead (o prazo conta da conversa, não de hoje). */
export function classificarPersona(q: any, ref: Date = new Date(), textoLead = ""): PersonaLead {
  const qq = q && typeof q === "object" ? q : {};
  const vincs: any[] = Array.isArray(qq.vinculos) ? qq.vinculos.filter((v: any) => v && typeof v === "object") : [];
  // Vínculo mais recente: ordem 1 (a IA numera do mais recente para o mais antigo)
  const v = [...vincs].sort((a, b) => (Number(a.ordem) || 99) - (Number(b.ordem) || 99))[0] ?? {};

  const funcao  = txt(v.funcao ?? qq.funcao_recente);
  const vinculo = txt(v.vinculo ?? qq.vinculo_recente);
  const saida   = txt(v.saida ?? qq.saida_recente);
  const dataSai = txt(v.data_saida);
  const tempo   = txt(v.tempo ?? qq.tempo_recente);
  const frota   = txt(v.frota ?? qq.frota_recente ?? qq.frota);
  const fora    = txt(v.pagamento_fora ?? qq.pagamento_fora_recente ?? qq.pagamento_fora);

  // Extração da IA primeiro; o texto do lead só preenche o que ficou em branco.
  const conv = textoLead ? sinaisDaConversa(textoLead) : { carreteiro: null, clt: null, noPrazo: null, porFora: null };
  const carreteiro = ehCarreteiro(qq, funcao) ?? conv.carreteiro;
  const clt = ehClt(qq, vinculo) ?? conv.clt;
  const noPrazo = dentroDoPrazo(saida, dataSai, ref) ?? conv.noPrazo;
  const meses = mesesDeCasa(tempo, ref);
  const p: Omit<PersonaLead, "faixa"> = {
    carreteiro, clt, noPrazo,
    frota30: frotaAte30(frota),
    tempo18m: meses === null ? null : meses >= 18,
    porFora: temPorFora(fora) ?? conv.porFora,
  };

  let faixa: FaixaPersona;
  if (carreteiro === false || clt === false || noPrazo === false) faixa = "fora";
  else if (carreteiro === null) faixa = "sem_dados";
  else if (clt && noPrazo && (p.frota30 || p.tempo18m || p.porFora)) faixa = "ideal";
  else faixa = "parcial";
  return { faixa, ...p };
}
