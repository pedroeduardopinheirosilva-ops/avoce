// ─────────────────────────────────────────────────────────────────────────────
// Renderização de templates — substitui {{variáveis}} por valores reais
// Variáveis disponíveis:
//   {{mes_referencia}}  → "Abril/2026"
//   {{competencia}}     → "04/2026"
//   {{vencimento}}      → "10/04/2026"
//   {{valor}}           → "R$ 1.000,00"
//   {{emitente}}        → nome da empresa emitente
//   {{tomador}}         → nome do tomador
//   {{servico}}         → nome curto do serviço
// ─────────────────────────────────────────────────────────────────────────────

const MESES = [
  "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
  "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro",
];

export interface TemplateVars {
  competencia:  string;   // "MM/YYYY"
  vencimento:   string;   // "YYYY-MM-DD"
  valor:        number;   // centavos
  emitente:     string;
  tomador:      string;
  servico?:     string;
}

export function renderTemplate(template: string, vars: TemplateVars): string {
  const [mm, yyyy] = vars.competencia.split("/");
  const mesNome    = MESES[(parseInt(mm) - 1) % 12];
  const mesRef     = `${mesNome}/${yyyy}`;

  const vencParts  = vars.vencimento.split("-");
  const vencFmt    = `${vencParts[2]}/${vencParts[1]}/${vencParts[0]}`;

  const valorFmt   = (vars.valor / 100).toLocaleString("pt-BR", {
    style: "currency", currency: "BRL",
  });

  return template
    .replace(/\{\{mes_referencia\}\}/gi, mesRef)
    .replace(/\{\{competencia\}\}/gi,    vars.competencia)
    .replace(/\{\{vencimento\}\}/gi,     vencFmt)
    .replace(/\{\{valor\}\}/gi,          valorFmt)
    .replace(/\{\{emitente\}\}/gi,       vars.emitente)
    .replace(/\{\{tomador\}\}/gi,        vars.tomador)
    .replace(/\{\{servico\}\}/gi,        vars.servico ?? "");
}
