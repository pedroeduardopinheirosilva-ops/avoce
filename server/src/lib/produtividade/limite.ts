// Limitador em memória (janela deslizante) por chave — sem dependências.
const hits = new Map<string, number[]>();

function recentes(chave: string, janelaMs: number, agora: number): number[] {
  const lista = (hits.get(chave) ?? []).filter((t) => agora - t < janelaMs);
  if (lista.length) hits.set(chave, lista); else hits.delete(chave);
  return lista;
}

/** Já atingiu o máximo na janela? (não conta tentativa) */
export function bloqueado(chave: string, max: number, janelaMs: number): boolean {
  return recentes(chave, janelaMs, Date.now()).length >= max;
}

/** Registra uma tentativa. */
export function registrar(chave: string, janelaMs: number): void {
  const agora = Date.now();
  const lista = recentes(chave, janelaMs, agora);
  lista.push(agora);
  hits.set(chave, lista);
}

/** Conta a tentativa e diz se ainda é permitida (true = pode). */
export function permitir(chave: string, max: number, janelaMs: number): boolean {
  if (bloqueado(chave, max, janelaMs)) return false;
  registrar(chave, janelaMs);
  return true;
}

export function _limparLimites(): void { hits.clear(); }
