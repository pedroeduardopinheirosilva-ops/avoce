/**
 * Handoff Snapshot — gera sumário estruturado dos dados coletados pela Ana
 * para injetar no system prompt da Daniela em TODAS as chamadas subsequentes.
 * Sprint 3 — P3: dado coletado nunca é repetido.
 */

function formatCpf(cpf: string): string {
  const digits = cpf.replace(/\D/g, "");
  if (digits.length !== 11) return cpf;
  return `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6, 9)}-${digits.slice(9)}`;
}

export function buildHandoffSnapshot(merged: Record<string, unknown>): string {
  const fatos: string[] = [];

  if (merged.nome) fatos.push(`Nome: ${merged.nome}`);
  if (merged.cidade) fatos.push(`Cidade: ${merged.cidade}`);
  if (merged.cpf) fatos.push(`CPF: ${formatCpf(String(merged.cpf))}`);
  if (merged.data_nascimento) fatos.push(`Data de nascimento: ${merged.data_nascimento}`);
  if (merged.endereco) fatos.push(`Endereço: ${merged.endereco}`);
  if (merged.estado_civil) fatos.push(`Estado civil: ${merged.estado_civil}`);

  if (Array.isArray(merged.vinculos) && merged.vinculos.length > 0) {
    fatos.push("\nVínculos trabalhistas relatados:");
    (merged.vinculos as any[]).forEach((v, i) => {
      const linhas = [
        `  ${i + 1}. Empresa: ${v.empresa ?? "?"}`,
        `     Função: ${v.funcao ?? "?"}`,
        `     Vínculo: ${v.vinculo ?? "?"}`,
        v.tempo_servico
          ? `     Período: ${v.tempo_servico}`
          : (v.data_admissao ? `     Período: ${v.data_admissao} a ${v.data_saida ?? "atual"}` : null),
        v.saida ? `     Saída: ${v.saida}` : null,
        v.modalidade_saida ? `     Modalidade: ${v.modalidade_saida}` : null,
        v.salario_total_declarado ? `     Salário declarado: R$ ${Number(v.salario_total_declarado).toLocaleString("pt-BR")}` : null,
        v.horas_extras === false ? `     Horas extras: dentro do normal` :
        v.horas_extras === true ? `     Horas extras: trabalhava além do limite` : null,
        v.pagamento_fora ? `     Pagamento por fora: SIM` : null,
        v.injustica ? `     Irregularidade: ${v.injustica}` : null,
      ].filter(Boolean);
      fatos.push(linhas.join("\n"));
    });
  } else {
    // Fallback: campos flat
    if (merged.empresa_recente || merged.empresa_principal) {
      fatos.push(`Empresa: ${merged.empresa_recente ?? merged.empresa_principal}`);
    }
    if (merged.funcao) fatos.push(`Função: ${merged.funcao}`);
    if (merged.vinculo) fatos.push(`Vínculo: ${merged.vinculo}`);
    if (merged.saida || merged.modalidade_saida) {
      fatos.push(`Saída: ${merged.saida ?? merged.modalidade_saida}`);
    }
    if (merged.horas_extras !== undefined) {
      fatos.push(`Horas extras: ${merged.horas_extras ? "trabalhava além do limite" : "dentro do normal"}`);
    }
    if (merged.injustica) fatos.push(`Irregularidade: ${merged.injustica}`);
  }

  return [
    "=== DADOS JÁ COLETADOS PELA ANA (NÃO REPERGUNTAR) ===",
    fatos.join("\n"),
    "=== FIM DOS DADOS COLETADOS ===",
    "Você é a Dra. Daniela. Esses dados já foram coletados — confirme-os naturalmente quando útil, mas NÃO faça perguntas que já têm resposta acima.",
  ].join("\n");
}

/**
 * Retorna apenas as mensagens desde a troca de persona,
 * mais eficiente do que enviar todo o histórico ao LLM.
 */
export function buildHistoryForPersona(
  mensagens: Array<{ direcao: string; conteudo: string | null; enviadaEm: Date; personaChave?: string | null }>,
  personaChave: string,
  personaTrocadaEm?: Date | null
): Array<{ role: "user" | "assistant"; content: string }> {
  let lista = mensagens;

  if (personaChave === "advogado" && personaTrocadaEm) {
    lista = mensagens.filter(m => m.enviadaEm >= personaTrocadaEm);
    if (lista.length > 15) lista = lista.slice(-15);
  } else {
    if (lista.length > 20) lista = lista.slice(-20);
  }

  return lista.map(m => ({
    role: (m.direcao === "out" ? "assistant" : "user") as "user" | "assistant",
    content: m.conteudo ?? "",
  }));
}
