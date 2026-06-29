# PROMPT-FIX-AVOCE-SDR — v2 (consolidado 2026-06-03)

Você é engenheiro sênior do SDR Avoce. Implemente as correções abaixo em ordem de prioridade. Cada item especifica arquivo, função e mudança mínima necessária. **NÃO altere lógica não especificada.**

> **Nota sobre personas:** os nomes de exibição (nome_exibicao de IaPersona) são configuráveis pelo admin. Toda lógica de código usa `personaChave` = `"assistente"` | `"advogado"` | `"secretaria"` | `"closer"`. Nunca referencie nomes hardcoded no código. Busque nomes sempre via `getPersonaNomeExibicao(projetoId, personaChave)`.

## FLUXO REAL DO SDR AVOCE

```
assistente (qualificação + vínculos)
    ↓ allAnswered=true + qualificacao_completa rule
    → farewell do assistente enviado
    → INLINE: secretaria greeting enviado proativamente (stage-engine.ts L1268–1302)
secretaria (agenda reunião — escolha de horário)
    ↓ horário escolhido → criarReuniaoAgente → setTimeout(runProativoNextStep, 15-25s)
advogado (parecer jurídico + coleta de dados pessoais: CPF, RG, endereço, etc.)
    ↓ flow __done__
coleta_docs (TRIGGER MANUAL — gera procuração e contrato)
```

**Implicações para os bugs:**
- A transição `assistente → secretaria` é **inline** (não via setTimeout): greeting enviado no mesmo turn do `allDone`
- A transição `secretaria → advogado` usa **setTimeout 15-25s** (line 941) + recuperação pelo cron (já corrigida, BUG-008 FIXO)
- `buildResumoEncerramento` em `assistente-agents.ts` usa `advNome` como próxima persona — **ERRADO**: a próxima persona é a secretaria, não o advogado

---

## SUMÁRIO DE BUGS

| ID      | Severidade | Status  | Arquivo principal          | Título |
|---------|-----------|---------|---------------------------|--------|
| BUG-001 | CRÍTICO   | ABERTO  | vinculos-processor.ts     | parseMesesTempo não suporta dias |
| BUG-002 | CRÍTICO   | ABERTO  | gate-evaluator.ts          | Gate tempo_minimo: tempo NULL bypassa |
| BUG-003 | CRÍTICO   | ABERTO  | stage-engine.ts            | apresentacao_enviado não setado inline → cron reenvia saudação |
| BUG-004 | ALTO      | ABERTO  | stage-engine.ts            | NAO_CARRETEIRO_RE sem normalização Unicode |
| BUG-005 | ALTO      | ABERTO  | assistente-agents.ts       | Auto-close com 2 vínculos inválidos impede 3º vínculo |
| BUG-006 | ALTO      | ABERTO  | triagem-router.ts          | tipo_motorista_valido nunca extraído |
| BUG-007 | ALTO      | ABERTO  | triagem-router.ts          | rv_substituto=true → pessoalidade=null em vez de false |
| BUG-008 | ALTO      | ✅ FIXO  | cron-agent.ts              | Handoff secretaria→advogado não recuperado *(corrigido na linha 192)* |
| BUG-009 | ALTO      | ABERTO  | cron-agent.ts              | Full table scan em 5.779 deals a cada 15 min |
| BUG-010 | MÉDIO     | ABERTO  | assistente-agents.ts       | tipoRazao: prioridade errada (bloqueada antes de curto) |
| BUG-011 | MÉDIO     | ABERTO  | flow-controller.ts         | sec_apresentacao apresentacao_enviado não persiste inline |
| BUG-012 | MÉDIO     | ABERTO  | stage-engine.ts            | Advogado: pergunta_inesperada + step llm_gate → mensagem duplicada |
| BUG-013 | MÉDIO     | ABERTO  | vinculos-processor.ts      | Três implementações divergentes de parseMeses |
| BUG-014 | MÉDIO     | ABERTO  | gate-evaluator.ts          | Prescrição de vínculo recente detectada tarde |
| BUG-015 | MÉDIO     | ABERTO  | flow-controller.ts         | sec_apresentacao (saudacao) avança sem lead escolher horário |
| BUG-016 | MÉDIO     | ABERTO  | secretaria-meeting.ts      | Race condition: duas reuniões criadas |
| BUG-017 | MÉDIO     | ABERTO  | stage-engine.ts            | allDone com temVinculoMinimo envia lead com dados incompletos |
| BUG-018 | BAIXO→ALTO| ABERTO  | stage-engine.ts            | DESCARTE_REGEX aplicado a todas as personas (personaChave qualquer) |
| BUG-019 | BAIXO     | ABERTO  | cron-agent.ts              | mensagens > 4h descartadas silenciosamente |
| BUG-020 | BAIXO     | ABERTO  | stage-engine.ts            | runProativoNextStep: check iaAtiva incorreto |
| BUG-021 | BAIXO     | ABERTO  | flow-controller.ts         | COMP_PREENCHIDO usa chaves literais hardcoded |
| BUG-022 | CRÍTICO   | ABERTO  | gate-evaluator.ts          | _mais_empregos_negado não sincroniza com gate tempo_minimo |
| BUG-023 | CRÍTICO   | ABERTO  | vinculos-processor.ts      | parseMesesTempo: sem suporte a semanas ("3 semanas" → 0) |
| BUG-024 | ALTO      | ABERTO  | persona-router.ts + gate   | Números por extenso ("um mês") não parseados — retornam 999/null |
| BUG-025 | ALTO      | ABERTO  | persona-router.ts          | "menos de 2 meses" parseado como 2 meses — aprovado indevidamente |
| BUG-026 | ALTO      | ABERTO  | vinculos-processor.ts      | "agregado" e "TAC" não estão em NON_CLT_RE — passam como CLT |
| BUG-027 | ALTO      | ABERTO  | stage-engine.ts            | "dono de frota" não capturado pelo NAO_CARRETEIRO_RE |
| BUG-028 | MÉDIO     | ABERTO  | stage-engine.ts            | "motorista de aplicativo de frete" desqualificado via nao_carreteiro indevidamente |
| BUG-029 | MÉDIO     | ABERTO  | stage-engine.ts            | CPF digitado manualmente não validado com validarCPF |
| BUG-030 | MÉDIO     | ABERTO  | stage-engine.ts            | Mensagem curta de cancelamento de reunião silenciada pelo guard pós-reunião |
| BUG-031 | MÉDIO     | ABERTO  | qualification.ts           | Apenas 1 novo_vinculo por mensagem — múltiplas empresas simultâneas perdidas |
| BUG-032 | MÉDIO     | ABERTO  | stage-engine.ts            | Lead com acao_em_andamento=true não é tratado |
| BUG-033 | MÉDIO     | ABERTO  | flow-controller.ts         | Campos obrigatórios avançados sem valor após 2 tentativas (CPF/dados pessoais) |
| BUG-034 | BAIXO     | ABERTO  | qualification.ts           | parseTempo em qualification.ts: 4ª implementação sem suporte a dias/semanas |
| BUG-035 | BAIXO     | ABERTO  | cron-agent.ts              | lead_desqualificado não está em STAGES_HUMANOS — cron tenta reprocessar |
| BUG-036 | MÉDIO     | ABERTO  | assistente-agents.ts       | buildResumoEncerramento cita advNome como próxima persona — errado (próxima é secretaria) |
| BUG-037 | ALTO      | ABERTO  | triagem-router.ts          | resolvePostPhaseRoute: `elementos>=3` avaliado antes de completude → qualifica sem responder rv_substituto |

---

## PRIORIDADE 1 — CRÍTICO (implementar HOJE, antes do próximo deploy)

---

### FIX-01 | BUG-001 + BUG-023 | vinculos-processor.ts — parseMesesTempo: adicionar dias, semanas e decimais

**Arquivo:** `server/src/agent/vinculos-processor.ts`
**Função:** `parseMesesTempo` (linha 34)

```typescript
// ANTES:
function parseMesesTempo(s: string): number {
  let t = 0;
  const ma = s.match(/(\d+)\s*an/i); if (ma) t += parseInt(ma[1]) * 12;
  const mm = s.match(/(\d+)\s*m[eê]/i); if (mm) t += parseInt(mm[1]);
  return t;
}

// DEPOIS:
function parseMesesTempo(s: string): number {
  if (!s) return 0;
  const t = s.toLowerCase();
  let meses = 0;
  const ma  = t.match(/(\d+(?:[,.]\d+)?)\s*an/i);
  const mm  = t.match(/(\d+(?:[,.]\d+)?)\s*m[eê]/i);
  const ms  = t.match(/(\d+(?:[,.]\d+)?)\s*semana/i);
  const md  = t.match(/(\d+(?:[,.]\d+)?)\s*dia/i);
  if (ma) meses += Math.round(parseFloat(ma[1].replace(",", ".")) * 12);
  if (mm) meses += Math.floor(parseFloat(mm[1].replace(",", ".")));
  if (ms && !ma && !mm) meses += Math.round(parseFloat(ms[1].replace(",", ".")) / 4.3);
  if (md && !ma && !mm && !ms) meses += parseFloat(md[1].replace(",", ".")) / 30;
  return meses;
}
```

---

### FIX-02 | BUG-002 | assistente-agents.ts — temVinculoValido: tempo null = inválido

**Arquivo:** `server/src/agent/assistente-agents.ts`
**Linha:** ~98

```typescript
// ANTES:
const temVinculoValido = ctx.vinculos.some(v =>
  !isBlocked(v.empresa) &&
  parseTempToMeses(String(v.tempo ?? "")) >= mesesMin &&
  !isNaoClt(v.vinculo)
);

// DEPOIS:
const temVinculoValido = ctx.vinculos.some(v =>
  !isBlocked(v.empresa) &&
  v.tempo != null && v.tempo !== "" &&
  parseTempToMeses(String(v.tempo)) >= mesesMin &&
  !isNaoClt(v.vinculo)
);
```

---

### FIX-03 | BUG-022 | gate-evaluator.ts — tempo_minimo: reconhecer _mais_empregos_negado

**Arquivo:** `server/src/agent/gate-evaluator.ts`
**Case:** `"tempo_minimo"` (linha ~128)

```typescript
// ANTES:
const tem = merged.tem_emprego_anterior;
if (tem === undefined || tem === null) return false;
return tem === false || tem === "false" || tem === "nao" || tem === "não" || tem === "no" || tem === 0;

// DEPOIS:
const tem = merged.tem_emprego_anterior;
const maisEmpregosNegado = merged._mais_empregos_negado === true;
// Se lead negou mais empregos via vinculos-processor, tratar como tem=false
if (tem === undefined || tem === null) {
  if (!maisEmpregosNegado) return false; // aguardando resposta
}
return tem === false || tem === "false" || tem === "nao" || tem === "não" || tem === "no" || tem === 0 || maisEmpregosNegado;
```

---

### FIX-04 | BUG-003 + BUG-011 | stage-engine.ts — Marcar apresentacao_enviado=true após envio inline da secretaria (path assistente → secretaria)

**Arquivo:** `server/src/agent/stage-engine.ts`

O path principal onde o bug ocorre é o **`assistente → secretaria`** inline (linhas ~1268–1302), quando `assistenteAgentResult.allDone=true` e `proximaPersonaChaveAssistente === "secretaria"`. Após o `sendHumanizedSafe` do greeting (linha ~1292), `apresentacao_enviado` não é marcado como `true`, fazendo o cron reenviar a saudação após 90 min.

**Fix — adicionar imediatamente após o `prisma.crmMensagemWhatsapp.create` do greeting da secretaria (linha ~1294-1295):**

```typescript
// stage-engine.ts — APÓS o create do CrmMensagemWhatsapp da secretaria greeting (linha ~1294)
if (secGreeting) {
  await saveFlowStepData(
    { id: deal.id, iaFlowStepData: {}, qualificacao: deal.qualificacao },
    { apresentacao_enviado: true, sec_apresentacao_enviado: true },
    "sec_apresentacao"
  );
  console.log(`[StageEngine] sec_apresentacao marcado como enviado (inline assistente→secretaria) para deal ${deal.id}`);
}
```

O path secundário **advogado → secretaria** (linha ~810) também deve receber o mesmo fix para cobertura completa, mas o path principal a corrigir é o `assistente → secretaria` acima.

---

### FIX-05 | BUG-005 | vinculos-processor.ts — auto-close: não fechar sem vínculo válido

**Arquivo:** `server/src/agent/vinculos-processor.ts`
**Linha:** ~210

```typescript
// ANTES:
if (!w._vinculos_ok && todosCompletos(vinculosAtuais) && vinculosAtuais.length >= 2) {
  w._vinculos_ok = true;
  w.vinculos = vinculosAtuais;
}

// DEPOIS:
if (!w._vinculos_ok && todosCompletos(vinculosAtuais) && vinculosAtuais.length >= 2) {
  const NON_CLT_CLOSE = /autônomo|autonomo|pj|informal|avulso|cooperado|agregado|\btac\b/i;
  // Só fechar se há pelo menos 1 vínculo CLT com tempo suficiente
  const algumCltValido = vinculosAtuais.some(v =>
    v.vinculo != null &&
    !NON_CLT_CLOSE.test(String(v.vinculo)) &&
    parseMesesTempo(String(v.tempo ?? "")) >= 2
  );
  const maisEmpregosNegado = w._mais_empregos_negado === true || w.tem_emprego_anterior === false;
  if (algumCltValido || maisEmpregosNegado) {
    w._vinculos_ok = true;
    w.vinculos = vinculosAtuais;
  }
  // Se não tem vínculo válido E mais_empregos não foi negado: NÃO fechar.
  // assistente-agents perguntará sobre mais empregos.
}
```

---

## PRIORIDADE 2 — ALTO (implementar antes do próximo lote de leads)

---

### FIX-06 | BUG-004 + BUG-028 | stage-engine.ts — Normalizar texto antes do NAO_CARRETEIRO_RE; ampliar regex

**Arquivo:** `server/src/agent/stage-engine.ts`
**Função:** `extractAndApplyQual` (linha ~173)

```typescript
// ANTES:
if ((merged.e_carreteiro === undefined || merged.e_carreteiro === null) && text) {
  const NAO_CARRETEIRO_RE = /\b(taxista|t[aá]xi|motorista\s+de\s+(t[aá]xi|aplicativo)|uber|...|autonomo\s+sem\s+carteira|...)\b/i;
  if (NAO_CARRETEIRO_RE.test(text)) {

// DEPOIS:
if ((merged.e_carreteiro === undefined || merged.e_carreteiro === null) && text) {
  const textNorm = text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  // "motorista de aplicativo de frete" NÃO deve desqualificar — é caminhoneiro por app de frete
  const NAO_CARRETEIRO_RE = /\b(taxista|taxi|motorista\s+de\s+(taxi|aplicativo)(?!\s+de\s+frete)|uber|99\s*(driver|app)?\b|indriver|mototaxi|motoboy|entregador\s+(ifood|rappi|motoboy|de\s+aplicativo)|ifood\b|rappi\b|autonomo(\s+sem\s+carteira)?|dono\s+do\s+veiculo|carro\s+proprio|caminhao\s+proprio|dono\s+de\s+frota|dono\s+da\s+frota|proprietario\s+de\s+frota)\b/i;
  if (NAO_CARRETEIRO_RE.test(textNorm)) {
```

---

### FIX-07 | BUG-026 | vinculos-processor.ts + persona-router.ts — Adicionar "agregado" e "TAC" ao NON_CLT_RE

**Arquivos:** `vinculos-processor.ts` e `assistente-agents.ts`

Todas as ocorrências de `NON_CLT_RE` devem incluir "agregado" e "tac":

```typescript
// Padrão unificado para todos os arquivos:
const NON_CLT_RE = /autônomo|autonomo|pj|informal|avulso|cooperado|agregado|\btac\b|transportador\s+autonomo/i;
```

Aplicar em:
- `vinculos-processor.ts` linha ~241 (sync e_clt)
- `vinculos-processor.ts` linha ~730 (guard FIX-05 acima)
- `assistente-agents.ts` linha ~95 (isNaoClt check)
- `assistente-agents.ts` linha ~108 (temAlgumNaoClt)

---

### FIX-08 | BUG-018 | stage-engine.ts — DESCARTE_REGEX restrito a personaChave="assistente"

**Arquivo:** `server/src/agent/stage-engine.ts`
**Linha:** ~1329

```typescript
// ANTES:
if (DESCARTE_REGEX.test(resposta) && stageChave !== "descartado") {
  isDescarte = true;
  ...
}

// DEPOIS:
// Só testar DESCARTE_REGEX quando a persona ativa for "assistente"
// para evitar falsos positivos quando o advogado (personaChave="advogado") usa a frase em contexto diferente
if (personaChave === "assistente" && DESCARTE_REGEX.test(resposta) && stageChave !== "descartado") {
  isDescarte = true;
  ...
}
```

---

### FIX-09 | BUG-006 + BUG-007 | triagem-router.ts — Corrigir pessoalidade e tipo_motorista_valido

**Arquivo:** `server/src/agent/triagem-router.ts`

**Parte 1 — pessoalidade (BUG-007):**
```typescript
// ANTES:
const pessoalidade = asBool(merged.rv_substituto) === false ? true : null;
// rv_substituto=true (tinha substituto → pessoalidade ausente) → deveria ser false

// DEPOIS:
const rv_sub = asBool(merged.rv_substituto);
// rv_substituto=false → NÃO tinha substituto → pessoalidade PRESENTE → true
// rv_substituto=true → TINHA substituto → pessoalidade AUSENTE → false
// rv_substituto=null → não respondido → null (aguardar)
const pessoalidade = rv_sub === false ? true : rv_sub === true ? false : null;
```

**Parte 2 — tipo_motorista_valido (BUG-006):**
O campo `tipo_motorista_valido` nunca é setado pelos gates configurados em DB. Usar `e_carreteiro` como fallback:

```typescript
// ANTES:
const tipoMotoristaValido = asBool(merged.tipo_motorista_valido);
if (tipoMotoristaValido === false) return { toStage: "lead_desqualificado", motivo: "tipo_motorista_invalido" };

// DEPOIS:
// tipo_motorista_valido é setado pelo gate do step confirmar_funcao via extracted
// Se não setado, usar e_carreteiro como fallback (setado pelo regex pré-LLM ou LLM)
const tipoMotoristaValido = asBool(merged.tipo_motorista_valido) ?? asBool(merged.e_carreteiro);
if (tipoMotoristaValido === false) return { toStage: "lead_desqualificado", motivo: "tipo_motorista_invalido" };
```

**DB — atualizar gates do step confirmar_funcao para extrair tipo_motorista_valido:**
```sql
-- Verificar estrutura exata do campo actionValue antes de executar
UPDATE "IaFlowGate"
SET "actionValue" = '{"tipo_motorista_valido": "false"}'
WHERE condicao LIKE 'NÃO é motorista%'
  AND "stepId" IN (
    SELECT id FROM "IaFlowStep" WHERE chave = 'confirmar_funcao'
  );
```

---

### FIX-10 | BUG-010 | assistente-agents.ts — tipoRazao: prioridade curto antes de bloqueado

**Arquivo:** `server/src/agent/assistente-agents.ts`
**Linhas:** ~112-117

```typescript
// ANTES:
const tipoRazao: "bloqueada" | "nao_clt" | "curto" =
  todosVinculosBloqueados ? "bloqueada"
  : temAlgumNaoClt        ? "nao_clt"
  : temAlgumBloqueado     ? "bloqueada"   // ← errado: bloqueado antes de curto
  : temAlgumCurto         ? "curto"
  : "bloqueada";

// DEPOIS:
const tipoRazao: "bloqueada" | "nao_clt" | "curto" =
  todosVinculosBloqueados ? "bloqueada"
  : temAlgumNaoClt        ? "nao_clt"
  : temAlgumCurto         ? "curto"       // ← correto: curto antes de bloqueado parcial
  : temAlgumBloqueado     ? "bloqueada"
  : "bloqueada";
```

---

### FIX-11 | BUG-009 | cron-agent.ts — Select mínimo + índice de DB

**Arquivo:** `server/src/agent/cron-agent.ts`
**Função:** `processarTimeoutsAgente` (linha ~47)

```typescript
// ANTES:
const deals = await prisma.crmDeal.findMany({
  where: { iaAtiva: true, status: "aberto", projetoId: { not: null }, iaStageChave: { not: null } },
  include: { contato: true },
});

// DEPOIS:
const deals = await prisma.crmDeal.findMany({
  where: { iaAtiva: true, status: "aberto", projetoId: { not: null }, iaStageChave: { not: null } },
  select: {
    id: true, projetoId: true, iaStageChave: true, iaPersonaChave: true,
    ultimoContatoEm: true, criadoEm: true, closerTentativas: true,
    qualificacao: true, iaFlowStepData: true,
    contato: { select: { whatsapp: true, nome: true } },
  },
  orderBy: { ultimoContatoEm: "asc" },
});
```

Também aplicar select mínimo em `recuperarMensagensPerdidas` (linha ~169) — trocar `include: { contato: true }` por `select` idêntico ao acima.

**DB — criar índice:**
```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_crmdeal_cron
ON "CrmDeal" ("projetoId", "iaAtiva", status, "iaStageChave", "ultimoContatoEm")
WHERE "iaAtiva" = true AND status = 'aberto';

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_mensagem_deal_dir_em
ON "CrmMensagemWhatsapp" ("dealId", direcao, "enviadaEm" DESC);
```

---

### FIX-12 | BUG-024 + BUG-025 | persona-router.ts — Normalizar números por extenso e modificadores "menos de"

**Arquivo:** `server/src/agent/persona-router.ts`
**Função:** `parseTempToMeses` (linha 93)

```typescript
export function parseTempToMeses(tempo: string): number {
  if (!tempo) return 999;
  // Normalizar números por extenso e modificadores "menos de"
  let t = tempo.toLowerCase()
    .replace(/\bum\b/gi, "1").replace(/\bdois\b|\bduas\b/gi, "2")
    .replace(/\btrês\b|\btres\b/gi, "3").replace(/\bquatro\b/gi, "4")
    .replace(/\bcinco\b/gi, "5").replace(/\bseis\b/gi, "6");
  // "menos de X meses" → "X meses" - 1 (subtrair 0.5 para ficar abaixo do limite)
  t = t.replace(/menos\s+de\s+(\d+)/gi, (_, n) => String(parseInt(n) - 1));
  let meses = 0;
  const anosMatch  = t.match(/(\d+)\s*ano/);
  const mesesMatch = t.match(/(\d+)\s*m[eê]s/);
  const semMatch   = t.match(/(\d+)\s*semana/);
  const diasMatch  = t.match(/(\d+)\s*dia/);
  if (anosMatch)  meses += parseInt(anosMatch[1]) * 12;
  if (mesesMatch) meses += parseInt(mesesMatch[1]);
  if (semMatch && !anosMatch && !mesesMatch)  meses += Math.round(parseInt(semMatch[1]) / 4.3);
  if (diasMatch && !anosMatch && !mesesMatch && !semMatch) meses += parseInt(diasMatch[1]) / 30;
  if (!anosMatch && !mesesMatch && !semMatch && !diasMatch) {
    if (t.includes("menos") || t.includes("pouco") || t.includes("alguns")) return 6;
    return 999;
  }
  return meses > 0 ? meses : 999;
}
```

**Aplicar a mesma normalização de extenso e "menos de" também em `parseMeses` no `gate-evaluator.ts`.**

---

### FIX-13 | BUG-029 | stage-engine.ts — CPF digitado manualmente: validar com validarCPF

**Arquivo:** `server/src/agent/stage-engine.ts`
**Localização:** bloco B9b (linha ~516), onde já existe validação de CPF para documentos OCR

```typescript
// Já existe:
if (merged.cpf && typeof merged.cpf === "string" && !validarCPF(merged.cpf as string)) {
  delete merged.cpf;
}
// ADICIONAR verificação equivalente em flow-controller.ts para CPF extraído via texto:
```

**Arquivo:** `server/src/agent/flow-controller.ts`
**Na função de extração de campos via regex** (REGEX_FIELDS para CPF), após extrair:

```typescript
// Após extrair cpf via regex:
if (field === "cpf") {
  const cpfDigits = String(extracted[field] ?? "").replace(/\D/g, "");
  const { validarCPF } = await import("./qualification-utils.js");
  if (!validarCPF(cpfDigits)) {
    console.log(`[FlowController] CPF inválido digitado: "${cpfDigits}" — não avançando`);
    return { nextQuestion: currentStep.pergunta as string, stepType: currentStep.stepType as string, campoColetar: currentStep.campoColetar ?? null };
  }
}
```

---

### FIX-14 | BUG-030 | stage-engine.ts — Guard de cancelamento de reunião antes de silenciar mensagem curta

**Arquivo:** `server/src/agent/stage-engine.ts`
**Linha:** ~446-452

```typescript
// ANTES:
if (merged._reuniao_criada === true) {
  const txtSilencio = (text ?? "").trim();
  if (txtSilencio.length < 30 && !txtSilencio.includes("?")) {
    // silencia
    return;
  }
}

// DEPOIS:
if (merged._reuniao_criada === true) {
  const txtSilencio = (text ?? "").trim();
  const isCancelamento = /cancelar|cancela|desmarcar|desmarca|reagendar|remarcar|n[aã]o\s+(vou|consigo|virei|posso)\s+(ir|comparecer|participar)/i.test(txtSilencio);
  if (txtSilencio.length < 30 && !txtSilencio.includes("?") && !isCancelamento) {
    await prisma.crmDeal.update({ where: { id: deal.id }, data: { ultimoContatoEm: new Date() } });
    console.log(`[StageEngine] dealId=${deal.id} — mensagem curta silenciada após reunião confirmada`);
    return;
  }
  // Se é cancelamento, deixar passar para o LLM responder naturalmente
}
```

---

### FIX-15 | BUG-032 | stage-engine.ts — Lead com acao_em_andamento=true: notificar humano

**Arquivo:** `server/src/agent/stage-engine.ts`
**Localização:** Após B9a (extractAndApplyQual, linha ~511), antes de B10a (gate evaluation)

```typescript
// ADICIONAR verificação de ação em andamento:
if (personaChave === "assistente" && merged.acao_em_andamento === true) {
  // Disparar notificação para equipe — captação de clientela alheia
  dispararNotificacoes(projetoId, "acao_em_andamento", {
    dealId: deal.id, nome: String(merged.nome ?? contato.nome ?? ""), telefone: phone,
  }).catch(() => {});
  // Opção 1: desqualificar automaticamente (requer gate configurado no DB)
  // Opção 2: escalar para humano (recomendado — depende de decisão de negócio)
  // MÍNIMO: log de alerta para o time
  console.warn(`[StageEngine] ALERTA: dealId=${deal.id} — lead tem ação em andamento (acao_em_andamento=true)`);
}
```

**Nota:** O tratamento definitivo (desqualificar vs. escalar) é decisão de negócio. O mínimo é garantir que o lead não avance silenciosamente para Daniela.

---

### FIX-16 | BUG-035 | cron-agent.ts — Adicionar lead_desqualificado ao STAGES_HUMANOS

**Arquivo:** `server/src/agent/cron-agent.ts`
**Linha:** ~167

```typescript
// ANTES:
const STAGES_HUMANOS = ["com_advogado", "reuniao_agendada", "fechado", "sem_resposta_closer", "lead_sem_resposta"];

// DEPOIS:
const STAGES_HUMANOS = ["com_advogado", "reuniao_agendada", "fechado", "sem_resposta_closer", "lead_sem_resposta", "lead_desqualificado"];
```

---

## PRIORIDADE 3 — MÉDIO (sprint seguinte)

---

### FIX-17 | BUG-015 | flow-controller.ts — sec_apresentacao (saudacao): não avançar automaticamente se campoColetar

**Arquivo:** `server/src/agent/flow-controller.ts`
**Linhas:** ~349-352

```typescript
// ANTES:
if (currentStep.stepType === "saudacao") {
  return await advanceToNextStep(deal, steps, currentStep, {}, null);
}

// DEPOIS:
if (currentStep.stepType === "saudacao") {
  // Se tem campoColetar (ex: sec_apresentacao coleta horario_reuniao), não avançar automaticamente
  if (!currentStep.campoColetar) {
    return await advanceToNextStep(deal, steps, currentStep, {}, null);
  }
  // Com campoColetar: cair no fluxo normal de extração (tratado como "question")
  // A criação da reunião em stage-engine usa encontrarSlotPorTexto como fallback no texto atual
}
```

Alternativamente, mudar o `stepType` de `sec_apresentacao` no banco de `"saudacao"` para `"question"`:
```sql
UPDATE "IaFlowStep" SET "stepType" = 'question' WHERE chave = 'sec_apresentacao' AND fase = 'secretaria';
```

---

### FIX-18 | BUG-016 | secretaria-meeting.ts — Guard de idempotência antes de criarReuniaoAgente

**Arquivo:** `server/src/agent/secretaria-meeting.ts`
**Função:** `criarReuniaoAgente` — início da função

```typescript
export async function criarReuniaoAgente(...): Promise<SessaoReuniao | null> {
  // Guard de idempotência — previne race condition com webhooks simultâneos
  const reuniaoExistente = await (prisma.sessaoReuniao as any).findFirst({
    where: { dealId },
    select: { id: true, linkConvidado: true, slotIso: true },
  });
  if (reuniaoExistente) {
    console.log(`[SecretariaMeeting] dealId=${dealId} — reunião já existe (${reuniaoExistente.id}), retornando existente`);
    return reuniaoExistente;
  }
  // ... resto da função
}
```

---

### FIX-19 | BUG-017 | assistente-agents.ts — temVinculoMinimo: exigir campos suficientes

**Arquivo:** `server/src/agent/assistente-agents.ts`
**Linha:** ~84

```typescript
// ANTES:
const temVinculoMinimo = ctx.vinculos.some(v => v.empresa && (v.vinculo || v.saida));

// DEPOIS:
// Exigir empresa + vínculo + saída + tempo para garantir dados mínimos para parecer jurídico
const temVinculoMinimo = ctx.vinculos.some(v =>
  v.empresa && v.vinculo && v.saida && v.tempo
);
```

---

### FIX-20 | BUG-013 | Centralizar parsing de tempo em módulo único

**Criar:** `server/src/agent/time-parser.ts`

```typescript
/**
 * Single source of truth for tempo text → months conversion.
 * Returns null when text cannot be parsed (unknown/empty).
 * Returns 999 for generic "long time" expressions.
 */
export function parseTempToMesesUnified(texto: string | null | undefined): number | null {
  if (!texto) return null;
  let t = texto.toLowerCase()
    .replace(/\bum\b/gi, "1").replace(/\bdois\b|\bduas\b/gi, "2")
    .replace(/\btrês\b|\btres\b/gi, "3")
    .replace(/menos\s+de\s+(\d+)/gi, (_, n) => String(parseInt(n) - 1));
  let meses = 0;
  const anos = t.match(/(\d+(?:[,.]\d+)?)\s*ano/);
  const mes  = t.match(/(\d+(?:[,.]\d+)?)\s*m[eê]s/);
  const sem  = t.match(/(\d+(?:[,.]\d+)?)\s*semana/);
  const dia  = t.match(/(\d+(?:[,.]\d+)?)\s*dia/);
  if (anos) meses += Math.round(parseFloat(anos[1].replace(",", ".")) * 12);
  if (mes)  meses += Math.floor(parseFloat(mes[1].replace(",", ".")));
  if (sem && !anos && !mes)  meses += Math.round(parseFloat(sem[1].replace(",", ".")) / 4.3);
  if (dia && !anos && !mes && !sem) meses += parseFloat(dia[1].replace(",", ".")) / 30;
  if (!anos && !mes && !sem && !dia) {
    if (/muito\s+tempo|bastante\s+tempo|muitos\s+anos/.test(t)) return 999;
    if (/menos|pouco|alguns\s+meses/.test(t)) return 3;
    return null;
  }
  return meses > 0 ? meses : null;
}
```

Migrar `gate-evaluator.ts` (parseMeses), `vinculos-processor.ts` (parseMesesTempo) e `persona-router.ts` (parseTempToMeses) para importar esta função, adaptando os retornos para null vs. 999 vs. 0 conforme cada uso.

---

### FIX-21 | BUG-019 | cron-agent.ts — Log alerta em mensagens > 4h

**Arquivo:** `server/src/agent/cron-agent.ts`
**Linha:** ~294

```typescript
// ANTES:
if (idadeMs > 4 * 60 * 60 * 1000) continue;

// DEPOIS:
if (idadeMs > 4 * 60 * 60 * 1000) {
  console.warn(`[CronAgent] Deal ${deal.id}: mensagem de ${Math.round(idadeMs / 3600000)}h atrás — muito antiga para recuperar automaticamente`);
  continue;
}
```

---

### FIX-22 | BUG-033 | cron-agent.ts + recuperarMensagensPerdidas — Select mínimo

Já coberto no **FIX-11** (selects mínimos em ambas as funções).

---

## PRIORIDADE 4 — BAIXO (backlog)

### FIX-23 | BUG-012 | stage-engine.ts — Log silenciamento autônomo
Ver BUG-021 do relatório original. Adicionar log em `autonomousPersonaOverride` silencioso.

### FIX-24 | BUG-021 | flow-controller.ts — COMP_PREENCHIDO dinâmico
Substituir keys hardcoded por verificação via `campoColetar` do step.

### FIX-25 | BUG-034 | qualification.ts — parseTempo: adicionar dias/semanas
Idêntico ao FIX-01, aplicar na função `parseTempo` local em `qualification.ts`.

---

## ORDEM DE DEPLOY RECOMENDADA

```
Fase 0 — Hoje, DB (zero downtime):
  SQL FIX-11 (índices)
  SQL FIX-09 Parte 2 (gates confirmar_funcao → tipo_motorista_valido)

Fase 1 — Hoje, code deploy (CRÍTICO):
  FIX-01 (parseMesesTempo dias+semanas)
  FIX-02 (temVinculoValido tempo null)
  FIX-03 (gate tempo_minimo + _mais_empregos_negado)
  FIX-04 (apresentacao_enviado inline secretaria)
  FIX-05 (auto-close guard — vínculo válido obrigatório)
  FIX-08 (DESCARTE_REGEX restrito a assistente)
  FIX-14 (guard cancelamento reunião)
  FIX-16 (lead_desqualificado em STAGES_HUMANOS)

Fase 2 — Sprint seguinte (ALTO):
  FIX-06 (NAO_CARRETEIRO_RE normalização + frete)
  FIX-07 (agregado/TAC no NON_CLT_RE)
  FIX-09 Parte 1 (pessoalidade + tipo_motorista_valido)
  FIX-10 (tipoRazao: curto antes de bloqueado)
  FIX-11 (select mínimos cron)
  FIX-12 (parseTempToMeses: extenso + "menos de")
  FIX-13 (validarCPF para CPF digitado)
  FIX-15 (acao_em_andamento: notificar humano)
  FIX-26 (buildResumoEncerramento: não citar advogado + revisar farewellTexto no DB)

Fase 3 — Sprint +2 (MÉDIO):
  FIX-17 (sec_apresentacao campoColetar guard)
  FIX-18 (idempotência criarReuniaoAgente)
  FIX-19 (temVinculoMinimo campos completos)
  FIX-20 (centralizar time-parser)
  FIX-21 (log mensagens > 4h)
```

---

## ESTIMATIVA DE RISCO

| Fase | Arquivos | Risco de regressão | Razão |
|------|----------|-------------------|-------|
| 0    | 0 (DB)   | BAIXO             | Só índices e updates de gate |
| 1    | 4        | MÉDIO             | vinculos-processor + gate-evaluator + stage-engine |
| 2    | 5        | MÉDIO             | Regex + NON_CLT_RE afetam detecção de múltiplos tipos |
| 3    | 4+       | BAIXO-MÉDIO       | Flow-controller + secretaria — mudanças isoladas |

---

### FIX-26 | BUG-036 | assistente-agents.ts — buildResumoEncerramento: não citar advogado como próxima persona

**Arquivo:** `server/src/agent/assistente-agents.ts`
**Função:** `buildResumoEncerramento` (linha ~288)

```typescript
// ANTES:
function buildResumoEncerramento(vinculos: VinculoEmprego[], advNome: string = "a especialista"): string {
  return [
    `FASE DE ENCERRAMENTO — Todos os dados foram coletados (${empresas}).`,
    `Sua resposta DEVE:`,
    `1. Agradecer brevemente pelo tempo do cliente`,
    `2. Informar que ${advNome} vai entrar em contato agora mesmo para dar o parecer jurídico`,
    `MÁXIMO 2 frases. NÃO prometa ligação. NÃO peça horário. NÃO colete mais dados.`,
    `Exemplo: "Registrei tudo certinho. ${advNome} vai te chamar agora mesmo com o parecer do seu caso."`,
  ].join("\n");
}

// DEPOIS:
// O fluxo real é: assistente → secretaria → advogado.
// A próxima persona após o assistente é a SECRETARIA (agenda reunião), não o advogado diretamente.
// A mensagem de encerramento deve apenas confirmar o registro — a secretaria entrará em seguida proativamente.
// O texto final enviado ao lead é o `persona.farewellTexto` configurado no DB (ou o fallback).
// As systemInstructions de buildResumoEncerramento guiam o LLM nessa última mensagem do assistente.
function buildResumoEncerramento(vinculos: VinculoEmprego[], _advNome?: string): string {
  const empresas = vinculos.map(v => v.empresa ?? "?").join(", ");
  return [
    `FASE DE ENCERRAMENTO — Todos os dados foram coletados (${vinculos.length} empresa(s): ${empresas}).`,
    `Sua resposta DEVE:`,
    `1. Agradecer brevemente pelo tempo do cliente`,
    `2. Confirmar que registrou tudo e que nossa equipe vai entrar em contato em seguida`,
    `REGRAS: MÁXIMO 2 frases curtas. NÃO mencione o nome do advogado nem da secretária — a equipe vai entrar em contato.`,
    `NÃO prometa ligação. NÃO peça horário (a secretária vai apresentar os horários logo em seguida).`,
    `NÃO colete mais dados.`,
    `Exemplo: "Registrei tudo certinho! Nossa equipe já vai entrar em contato com você."`,
  ].join("\n");
}
```

**Nota:** O texto real enviado ao lead é o `farewellTexto` configurado em `IaPersona` para a persona `assistente` (linha ~1237 do stage-engine). O `buildResumoEncerramento` é apenas a instrução do sistema para o LLM gerar essa última mensagem. O `farewellTexto` no DB deve ser revisado para não mencionar o advogado diretamente.

---

## TESTES MÍNIMOS ANTES DO DEPLOY FASE 1

1. **Lead CLT 30 dias + nega mais empregos** → desqualificar via `tempo_minimo` (BUG-001 + BUG-022)
2. **Lead CLT "3 semanas" + nega mais empregos** → desqualificar (BUG-023)
3. **Lead CLT "menos de 2 meses" + nega mais empregos** → desqualificar (BUG-025)
4. **Lead CLT 30 dias + CLT 3 anos** → qualificar + secretaria ativada (BUG-003 + BUG-005)
5. **Lead autônomo com til ("autônomo")** → desqualificar via nao_carreteiro (BUG-004)
6. **Lead "agregado" na transportadora** → desqualificar via vinculo_invalido (BUG-026)
7. **Qualificação completa → assistente manda farewell → secretaria greeting enviado inline → SEM reenvio após 90min** (BUG-003, fluxo correto: assistente→secretaria)
8. **Advogado diz "não conseguimos atender sua solicitação de documentos"** → NOT descartado (BUG-018)
9. **Lead envia "quero cancelar a reunião"** → NOT silenciado (BUG-030)
10. **CPF 111.111.111-11 digitado** → pedido novamente (BUG-029)
11. **Última mensagem do assistente NÃO menciona o advogado pelo nome como próxima persona** (BUG-036 / FIX-26)

---

### FIX-27 | BUG-037 | triagem-router.ts — Verificar completude antes de elementos>=3

**Arquivo:** `server/src/agent/triagem-router.ts`
**Função:** `resolvePostPhaseRoute` (linha ~101-115)

**Causa raiz:** O check `elementos >= 3` é avaliado ANTES do `tudo.every` (completude). Com `rv_substituto=undefined` (não respondido), `pessoalidade=null` → `elementos = 3` (hab+sub+oner) → qualifica imediatamente sem fazer a pergunta de pessoalidade.

**Confirmado por teste automatizado** (`sdr-bugs.test.ts` → "NOVO BUG-037 ATIVO").

```typescript
// ANTES (triagem-router.ts ~L109-115):
const elementos = [habitualidade, subordinacao, pessoalidade, onerosidade].filter(v => v === true).length;
if (elementos >= 3) return { toStage: "lead_qualificado", motivo: "rv_elementos_presentes" };
const tudo = [merged.rv_frequencia_trabalho, merged.rv_recebia_ordens, merged.rv_substituto, merged.rv_forma_pagamento];
if (tudo.every(v => v !== undefined && v !== null) && elementos < 3) {
  return { toStage: "lead_desqualificado", motivo: "rv_elementos_insuficientes" };
}
return null;

// DEPOIS — verificar completude ANTES de qualificar:
const tudo = [merged.rv_frequencia_trabalho, merged.rv_recebia_ordens, merged.rv_substituto, merged.rv_forma_pagamento];
const todoRespondido = tudo.every(v => v !== undefined && v !== null);
const elementos = [habitualidade, subordinacao, pessoalidade, onerosidade].filter(v => v === true).length;
// Só qualificar quando todos os campos foram respondidos (evita pular rv_substituto)
if (todoRespondido && elementos >= 3) return { toStage: "lead_qualificado", motivo: "rv_elementos_presentes" };
if (todoRespondido && elementos < 3)  return { toStage: "lead_desqualificado", motivo: "rv_elementos_insuficientes" };
return null; // aguardar respostas restantes
```

---

## BUGS ARQUIVADOS (já corrigidos no código atual)

- **BUG-008**: Handoff `secretaria → advogado` não recuperado pelo cron.
  **Status: ✅ CORRIGIDO.**
  - `cron-agent.ts` linha 192 já verifica `lastOut.personaChave !== "assistente" && lastOut.personaChave !== "secretaria"` — trata corretamente a transição `secretaria → advogado`.
  - Caminho primário: `stage-engine.ts` linha 939-943 agenda `setTimeout(runProativoNextStep, 15-25s)` quando `nextChaveAfterSec === "advogado"`.
  - Caminho de recuperação (PM2 restart): `cron-agent.ts` `recuperarMensagensPerdidas` detecta `iaPersonaChave="advogado"` + `lastOut.personaChave="secretaria"` e chama `enviarMensagemProativa("primeira_mensagem")`.
  - **Não é necessário nenhum fix de código.**
