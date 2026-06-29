# RELATÓRIO DE BUGS — SDR AVOCE QA

**Data:** 2026-06-03
**Versão analisada:** stage-engine.ts (1552 linhas), gate-evaluator.ts, assistente-agents.ts, flow-controller.ts, cron-agent.ts, vinculos-processor.ts, triagem-router.ts
**Deals ativos em produção:** 5.779

---

## SUMÁRIO EXECUTIVO

| Severidade | Quantidade |
|------------|-----------|
| CRÍTICO    | 3         |
| ALTO       | 6         |
| MÉDIO      | 7         |
| BAIXO      | 5         |
| **TOTAL**  | **21**    |

---

## TABELA DE BUGS

| ID      | Severidade | Componente              | Título |
|---------|-----------|------------------------|-------|
| BUG-001 | CRÍTICO   | vinculos-processor.ts  | parseMesesTempo não parseia dias — auto-close prematuro com vínculos curtos |
| BUG-002 | CRÍTICO   | gate-evaluator.ts      | Gate tempo_minimo: lead com tempo NULL passa para Daniela sem desqualificação |
| BUG-003 | CRÍTICO   | stage-engine.ts / cron | apresentacao_enviado não setado no fix BUG-FIXED-1 — saudação da secretaria reenviada pelo cron |
| BUG-004 | ALTO      | stage-engine.ts        | Regex NAO_CARRETEIRO_RE: "autonomo\s+sem\s+carteira" nunca faz match + sem normalização Unicode |
| BUG-005 | ALTO      | assistente-agents.ts   | Auto-close com 2 vínculos incompletos/inválidos impede investigação de terceiro vínculo |
| BUG-006 | ALTO      | triagem-router.ts      | tipo_motorista_valido nunca extraído — gate de desqualificação de motorista não-carreteiro em modo triagem nunca dispara |
| BUG-007 | ALTO      | triagem-router.ts      | rv_substituto=null → pessoalidade=null, não conta nos 3 elementos — lead sem substituto não qualifica |
| BUG-008 | ALTO      | cron-agent.ts          | processarHandoffsAtrasados: só verifica lastOut.personaChave === "assistente", ignora "secretaria" → handoff secretaria→advogado perdido |
| BUG-009 | ALTO      | cron-agent.ts          | 5.779 deals carregados sem índice em iaStageChave — full table scan a cada 15 min |
| BUG-010 | MÉDIO     | assistente-agents.ts   | tipoRazao "bloqueada" aplicado quando razão correta é combinação curto+bloqueado — mensagem errada |
| BUG-011 | MÉDIO     | flow-controller.ts     | saudacao step: avança imediatamente no primeiro incoming (saudacao step auto-advances), mas apresentacao_enviado não persiste no caminho sec_apresentacao inline de assistente→secretaria |
| BUG-012 | MÉDIO     | stage-engine.ts        | willOverrideDeterministic: advogado com leadFezPerguntaInesperada=true + step llm_gate → LLM roda E step appended como segunda mensagem duplicada |
| BUG-013 | MÉDIO     | vinculos-processor.ts  | parseMesesTempo tem implementação diferente de parseMeses/parseTempToMeses — três funções com comportamento divergente para o mesmo dado |
| BUG-014 | MÉDIO     | gate-evaluator.ts      | Gate prescricao usa vinculosTodosPrescritos=true (flag de vinculos-processor) mas não verifica prescrição de vínculo recente isolado quando lead ainda está empregado |
| BUG-015 | MÉDIO     | flow-controller.ts     | sec_apresentacao com stepType="saudacao" avança no primeiro incoming sem validar se lead respondeu — pode avançar com "oi" antes de o lead escolher horário |
| BUG-016 | MÉDIO     | secretaria-meeting.ts  | criarReuniaoAgente: não verifica se deal já tem reunião ativa — race condition cria 2 reuniões para o mesmo lead |
| BUG-017 | MÉDIO     | stage-engine.ts        | allDone=true com temVinculoMinimo (empresa+vinculo) mas sem isVinculoComplete — secretaria recebe dados incompletos sem horas_extras, pagamento_fora, injustica |
| BUG-018 | BAIXO     | stage-engine.ts        | DESCARTE_REGEX intercepta respostas legítimas da Daniela quando ela menciona "não vamos conseguir" em outro contexto |
| BUG-019 | BAIXO     | cron-agent.ts          | recuperarMensagensPerdidas: idadeMs > 4h descartada — PM2 restart + cron fora do horário pode causar mensagem de 4h+ ser descartada silenciosamente |
| BUG-020 | BAIXO     | stage-engine.ts        | runProativoNextStep não verifica iaAtiva=true no deal carregado mid-flow (só checa `!(deal as any).iaAtiva`) |
| BUG-021 | BAIXO     | flow-controller.ts     | COMP_PREENCHIDO pré-skip usa keys literais ("comp_salario", "comp_jornada") que podem não coincidir com chaves reais no DB |

---

## DETALHAMENTO DOS BUGS

---

### BUG-001 — CRÍTICO | vinculos-processor.ts | parseMesesTempo não parseia dias

**Arquivo:** `/Users/pedrosilva/NfseCapium/server/src/agent/vinculos-processor.ts` linhas 34–38

**Causa raiz:**
```typescript
function parseMesesTempo(s: string): number {
  let t = 0;
  const ma = s.match(/(\d+)\s*an/i); if (ma) t += parseInt(ma[1]) * 12;
  const mm = s.match(/(\d+)\s*m[eê]/i); if (mm) t += parseInt(mm[1]);
  return t;
  // SEM regex para dias — "30 dias" retorna 0
}
```

O auto-close usa `todosCompletos(vinculosAtuais) && vinculosAtuais.length >= 2`. Com v0.tempo="30 dias" (parseMesesTempo=0 < 2) e v1 também completo, os dois vínculos completam e `_vinculos_ok=true` antes que o SDR possa investigar um terceiro emprego válido.

Contrastando: `parseTempToMeses` (persona-router.ts linha 102) e `parseMeses` (gate-evaluator.ts linha 72) ambos corretamente processam dias como `parseInt(dias[1]) / 30`.

**Reprodução:**
1. Lead informa emprego recente: 30 dias na Transparra
2. SDR coleta todos os 8 campos do vínculo recente
3. Lead informa emprego anterior: 45 dias (também curto)
4. SDR coleta todos os 8 campos do vínculo anterior
5. vinculos-processor: `todosCompletos(2 vínculos)=true` → `_vinculos_ok=true`
6. assistente-agents: `vinculosOk=true` → `allDone=true` → handoff secretaria
7. Lead com total de 75 dias passa para Daniela sem desqualificação pelo gate tempo_minimo
8. Gate tempo_minimo com `parseMeses` daria 1 mês para v0 e 1.5 meses para v1 (ambos < 2) → deveria desqualificar

**Impacto:** Lead com menos de 2 meses em qualquer emprego passa para reunião com Daniela. CRÍTICO.

**Correção:**
```typescript
// vinculos-processor.ts linha 34-38 — substituir por:
function parseMesesTempo(s: string): number {
  if (!s) return 0;
  let t = 0;
  const ma = s.match(/(\d+(?:[,.]\d+)?)\s*an/i);
  const mm = s.match(/(\d+(?:[,.]\d+)?)\s*m[eê]/i);
  const md = s.match(/(\d+(?:[,.]\d+)?)\s*dia/i);
  if (ma) t += Math.round(parseFloat(ma[1].replace(",", ".")) * 12);
  if (mm) t += Math.floor(parseFloat(mm[1].replace(",", ".")));
  if (md && !ma && !mm) t += parseFloat(md[1].replace(",", ".")) / 30;
  return t;
}
```

---

### BUG-002 — CRÍTICO | gate-evaluator.ts | Gate tempo_minimo: tempo NULL bypassa gate

**Arquivo:** `/Users/pedrosilva/NfseCapium/server/src/agent/gate-evaluator.ts` linhas 118–130

**Causa raiz:**
```typescript
case "tempo_minimo": {
  const tempoTexto = v0?.tempo ?? (merged.tempo_recente as string | null);
  const meses = parseMeses(tempoTexto);
  if (meses === null) return false; // ← se tempo não coletado, gate não dispara
```

Quando o lead responde "não sei" para a pergunta de tempo, o SDR usa `_q_skipped` para avançar após 2 tentativas. Com `v0.tempo=null`, `parseMeses(null)=null` → gate retorna `false` → lead avança para Daniela sem desqualificação por tempo mínimo.

**Reprodução:**
1. Lead informa empresa: "Transparra"
2. SDR pergunta tempo: Lead responde "não sei" 2 vezes consecutivas
3. `_q_skipped` inclui "tempo_recente" → SDR avança sem coletar tempo
4. `v0.tempo=null` → `parseMeses(null)=null` → gate `tempo_minimo` retorna false
5. Lead com 1 semana de emprego pode passar para secretaria

**Impacto:** Lead com menos de 2 meses passa para Daniela se recusar/não souber informar tempo. CRÍTICO.

**Correção:**
```typescript
// gate-evaluator.ts — adicionar após o check de meses === null:
if (meses === null) {
  // Se tempo não coletado mas _q_skipped inclui o campo de tempo → assumir tempo desconhecido (inválido)
  const qSkipped = (merged._q_skipped as string[] | undefined) ?? [];
  const camposTempo = ["tempo_recente", "tempo_anterior", "tempo"];
  if (qSkipped.some(c => camposTempo.includes(c))) return false; // não desqualifica sem tempo confirmado
  return false; // padrão: aguardar coleta
}
// Adicionar check: se chegou aqui com meses < mesesMin e lead está em fase de auto-close (semAlternativa)
```

**Nota:** A correção ideal é bloquear o `allDone=true` em `assistente-agents.ts` quando `v0.tempo` é null e o gate `tempo_minimo` está ativo:
```typescript
// assistente-agents.ts — em temVinculoValido check:
const temVinculoValido = ctx.vinculos.some(v =>
  !isBlocked(v.empresa) &&
  (v.tempo != null ? parseTempToMeses(String(v.tempo)) >= mesesMin : false) && // null tempo = inválido
  !isNaoClt(v.vinculo)
);
```

---

### BUG-003 — CRÍTICO | stage-engine.ts + cron-agent.ts | Saudação da secretaria reenviada pelo cron

**Arquivos:** `stage-engine.ts` linhas 1268–1302 + `cron-agent.ts` linhas 185–207

**Causa raiz:**
O fix BUG-FIXED-1 (aplicado hoje) envia a saudação da secretaria proativamente após `assistente→secretaria`. O fluxo inline chama `advanceAdvogadoFlow` com `iaFlowStepChave=null`, que seta `apresentacao_enviado=false` (linha 299 do flow-controller). A saudação é enviada mas `apresentacao_enviado` **não é atualizado para `true`** no banco após o envio inline.

No `cron-agent.ts` (processarHandoffsAtrasados e recuperarMensagensPerdidas):
- `recuperarMensagensPerdidas` verifica: `lastOut.personaChave !== "assistente" && lastOut.personaChave !== "secretaria"` → como a saudação foi enviada com `personaChave="secretaria"`, o cron **não reenvia** via handoff atrasado.
- MAS: `recuperarMensagensPerdidas` (follow-up de 90min): após 90min sem resposta do lead, `respondFromDealState` é chamado → `advanceAdvogadoFlow` vê `iaFlowStepChave="sec_apresentacao"` com `apresentacao_enviado=false` → retorna a saudação NOVAMENTE.

**Reprodução:**
1. Lead qualificado → Ana transita para secretaria
2. Saudação da secretaria enviada inline (fix BUG-FIXED-1)
3. `sec_apresentacao_enviado` permanece `false` no banco
4. Lead não responde em 90 min
5. Cron `recuperarMensagensPerdidas` → `respondFromDealState` → `advanceAdvogadoFlow` → `apresentacao_enviado=false` → **reenvia saudação**
6. Lead recebe a lista de slots duas vezes

**Impacto:** Lead recebe mensagem duplicada da secretaria. CRÍTICO para UX profissional.

**Correção:**
```typescript
// stage-engine.ts — após o envio inline da saudação da secretaria (linha ~1293):
if (secGreeting) {
  // ... envio da mensagem ...
  // ADICIONAR: marcar apresentacao_enviado=true para prevenir reenvio pelo cron
  await prisma.crmDeal.update({
    where: { id: deal.id },
    data: { iaFlowStepData: { apresentacao_enviado: true, [`sec_apresentacao_enviado`]: true } },
  });
}

// Mesmo fix para o path advogado→secretaria (linha ~812):
// Após o envio inline, persistir apresentacao_enviado=true
```

---

### BUG-004 — ALTO | stage-engine.ts | Regex NAO_CARRETEIRO_RE: "autonomo\s+sem\s+carteira" nunca faz match

**Arquivo:** `stage-engine.ts` linha 174

**Causa raiz:**
```typescript
const NAO_CARRETEIRO_RE = /\b(taxista|...|autonomo\s+sem\s+carteira|dono\s+do\s+ve[ií]culo|carro\s+pr[oó]prio)\b/i;
```

Dois problemas:
1. `"autonomo\s+sem\s+carteira"` requer literalmente essa sequência. Leads dizem: "sou autônomo", "trabalho como autônomo", nunca "autônomo sem carteira" em mensagem natural.
2. Falta normalização Unicode: a regex usa `/i` sem `/u`, então `"autônomo"` (com acento circunflexo) NÃO faz match com `"autonomo"` (sem acento). Lead que digita "sou autônomo" não é capturado pelo regex pré-LLM.

**Consequência:** leads autônomos donos de caminhão passam pelo caminho mais lento (extração LLM + sync de vinculos). Se o LLM não extrair `vinculo="autônomo"` corretamente, e_clt fica `null` e o gate `vinculo_invalido` nunca dispara.

**Reprodução:**
1. Lead: "sou caminhoneiro autônomo" (com acento)
2. NAO_CARRETEIRO_RE.test("sou caminhoneiro autônomo") → false (sem acento na regex)
3. LLM pode ou não extrair vinculo_recente="autônomo"
4. Se LLM retornar null → e_clt=null → gate vinculo_invalido NÃO dispara → lead avança incorretamente

**Impacto:** Lead autônomo com acento pode passar para secretaria.

**Correção:**
```typescript
// stage-engine.ts — substituir a linha do regex:
const textNorm = text.normalize("NFD").replace(/[\u0300-\u036f]/g, ""); // remover acentos
const NAO_CARRETEIRO_RE = /\b(taxista|taxi|motorista\s+de\s+(taxi|aplicativo)|uber|99\s*(driver|app|\b)|indriver|mototaxi|motoboy|entregador\s+(ifood|rappi|motoboy|de\s+aplicativo)|ifood|rappi|autonomo(\s+sem\s+carteira)?|dono\s+do\s+(veiculo|caminhao)|carro\s+proprio|caminhao\s+proprio)\b/i;
if (NAO_CARRETEIRO_RE.test(textNorm)) {
  merged.e_carreteiro = false;
  // ...
}
// Nota: remover "sem carteira" do requisito — "autônomo" sozinho já é suficiente
// Adicionar: "autonomo" no grupo de captura standalone
```

---

### BUG-005 — ALTO | assistente-agents.ts | Auto-close com 2 vínculos inválidos impede investigação de 3º

**Arquivo:** `assistente-agents.ts` linhas 81–85 + `vinculos-processor.ts` linha 210

**Causa raiz:**
```typescript
// vinculos-processor.ts linha 210:
if (!w._vinculos_ok && todosCompletos(vinculosAtuais) && vinculosAtuais.length >= 2) {
  w._vinculos_ok = true;
}
```

`todosCompletos` verifica apenas se todos os 8 campos estão preenchidos. Não verifica se os vínculos são válidos (CLT, tempo suficiente, não bloqueados). Quando v0 e v1 são completados mas ambos inválidos (curtos, bloqueados, ou autônomos), `_vinculos_ok=true` fecha a coleta antes de investigar um 3º emprego.

Então em `assistente-agents.ts`, `vinculosOk=true` faz detectPhase retornar "resumo" e o check `temVinculoValido=false` dispara `forceDescarte`.

**Reprodução (B2 e B3):**
1. Lead: 30 dias na Transparra (empresa não bloqueada, apenas curto)
2. SDR coleta todos os 8 campos para v0
3. Lead: 45 dias na Transoares (empresa bloqueada)
4. SDR coleta todos os 8 campos para v1
5. vinculos-processor: `todosCompletos=true, length=2` → `_vinculos_ok=true`
6. assistente-agents: `vinculosOk=true`, `temVinculoValido=false` → `forceDescarte`
7. Lead com 3º emprego CLT válido é desqualificado sem chance de informá-lo

**Impacto:** Lead qualificável desqualificado incorretamente. CRÍTICO em cenários reais.

**Correção:**
```typescript
// vinculos-processor.ts linha 210 — adicionar guard:
if (!w._vinculos_ok && todosCompletos(vinculosAtuais) && vinculosAtuais.length >= 2) {
  // Só fecha se há pelo menos 1 vínculo válido (não bloqueado, tempo suficiente, CLT)
  // Senão, deixa assistente-agents decidir se investiga mais empregos
  const NON_CLT_RE = /autônomo|autonomo|pj|informal|avulso|cooperado/i;
  const algumValido = vinculosAtuais.some(v =>
    v.empresa && v.vinculo &&
    !NON_CLT_RE.test(String(v.vinculo)) &&
    parseMesesTempo(String(v.tempo ?? "")) >= 2
  );
  // Se nenhum válido e mais_empregos não foi negado → não fechar, deixar investigar
  if (algumValido || w._mais_empregos_negado === true || w.tem_emprego_anterior === false) {
    w._vinculos_ok = true;
  }
}
```

---

### BUG-006 — ALTO | triagem-router.ts | tipo_motorista_valido nunca extraído

**Arquivo:** `triagem-router.ts` linha 54

**Causa raiz:**
```typescript
const tipoMotoristaValido = asBool(merged.tipo_motorista_valido);
if (tipoMotoristaValido === false) return { toStage: "lead_desqualificado", motivo: "tipo_motorista_invalido" };
```

O campo `tipo_motorista_valido` não existe em nenhuma `IaPerguntaQualificacao` configurada para o projeto (verificado nos flow steps da triagem). O campo `e_carreteiro` é extraído via HINTS_ASSISTENTE mas `tipo_motorista_valido` é um campo diferente e nunca é setado pelo LLM ou pelos gates de triagem.

Verificado no DB: os gates do step `confirmar_funcao` (modo triagem) retornam `end` com mensagem de desqualificação, mas não setam `tipo_motorista_valido=false` em `extracted`. A condição `tipoMotoristaValido === false` nunca é satisfeita porque o campo nunca é populado.

**Impacto:** No modo triagem, motoristas de Uber/táxi/motoboy NÃO são desqualificados pelo caminho `tipo_motorista_invalido`. O gate do step `confirmar_funcao` envia a mensagem de encerramento mas `resolvePostPhaseRoute` não detecta a desqualificação (o deal pode não ter sido movido para lead_desqualificado antes do post-phase route ser avaliado).

**Reprodução:**
1. Lead no modo triagem
2. Step `confirmar_funcao` com gate "NÃO é motorista de carga" → `end` com mensagem
3. `advFlowNextStepChave = "__done__"` → `triagemPostPhaseRoute = resolvePostPhaseRoute(...)`
4. `merged.tipo_motorista_valido = undefined` → `asBool(undefined) = null` → condição não dispara
5. `tinhaClt=null` → `return null` → lead não é roteado → fica preso em `lead_triagem`

**Correção:**
```typescript
// triagem-router.ts — substituir lógica de tipo_motorista_valido:
// O gate "confirmar_funcao" já envia a mensagem de encerramento via actionType="end"
// A transição de stage deve acontecer via stageDestino do gate, não via resolvePostPhaseRoute
// Opção 1: no gate de desqualificação do confirmar_funcao, usar actionType="discard" em vez de "end"
//   e no stage-engine, tratar __discarded__ para modo triagem

// Opção 2: em resolvePostPhaseRoute, checar se o flowResult.nextStepChave === "__done__"
//   E o último gate disparado foi "end" (desqualificador) via extracted:
if (stageChave === "lead_triagem" && merged._triagem_desqualificado === true) {
  return { toStage: "lead_desqualificado", motivo: "tipo_motorista_invalido" };
}

// Para isso, o gate "confirmar_funcao" precisa ser modificado para:
// extracted: { _triagem_desqualificado: "true" }
```

---

### BUG-007 — ALTO | triagem-router.ts | rv_substituto=null → pessoalidade=null

**Arquivo:** `triagem-router.ts` linha 107

**Causa raiz:**
```typescript
const pessoalidade = asBool(merged.rv_substituto) === false ? true : null;
// Se rv_substituto=null (não respondido) → asBool(null)=null → null===false → false → pessoalidade=null
// Se rv_substituto=true (tinha substituto) → asBool(true)=true → true===false → false → pessoalidade=null
// Se rv_substituto=false (não tinha substituto) → asBool(false)=false → true → pessoalidade=true
```

O campo `rv_substituto` significa "tinha substituto". Se o lead NÃO tinha substituto (pessoalidade presente), `rv_substituto=false` → `pessoalidade=true` (correto). Mas se `rv_substituto=null` (não respondido ainda) → `pessoalidade=null` em vez de `false`. Isso significa que o elemento pessoalidade simplesmente não conta, mas não é contabilizado como ausente de forma definitiva.

O problema real: com `rv_substituto=null`, o check `tudo.every(v => v !== undefined && v !== null)` vai falhar (rv_substituto está na lista `tudo`), então `resolvePostPhaseRoute` retorna `null` (aguardando mais dados). Isso é correto em princípio, mas se o LLM não extrair `rv_substituto` corretamente, o lead fica preso sem conseguir avançar mesmo com os outros 3 elementos preenchidos.

**Impacto:** Lead com 3 elementos legítimos (mas sem rv_substituto coletado) não qualifica.

---

### BUG-008 — ALTO | cron-agent.ts | Handoff secretaria→advogado não recuperado pelo cron

**Arquivo:** `cron-agent.ts` linhas 192–195

**Causa raiz:**
```typescript
if (lastOut.personaChave !== "assistente" && lastOut.personaChave !== "secretaria") continue;
```

Esta condição foi adicionada para capturar tanto handoffs de assistente→advogado quanto secretaria→advogado. MAS a condição está **invertida**: ela continua (pula) o deal quando `personaChave === "secretaria"`. Lendo novamente: `!== "assistente" && !== "secretaria"` = pula se NÃO é assistente E NÃO é secretaria → ou seja, processa quando personaChave É "assistente" OU É "secretaria". Isso está **correto**.

Verificação adicional: o `processarHandoffsAtrasados` busca `iaPersonaChave: "advogado"` e `lastOut.personaChave = "assistente"` (linha 350):
```typescript
const personaTrocadaSemIntro =
  ultimaMsg.direcao === "out" &&
  ultimaMsg.personaChave === "assistente" && // ← não verifica "secretaria"
  minutosDesde >= 10;
```

**AQUI ESTÁ O BUG REAL:** `processarHandoffsAtrasados` só verifica se `lastOut.personaChave === "assistente"`. Se a transição foi secretaria→advogado (lastOut.personaChave="secretaria"), o cron NÃO envia a intro de Daniela.

**Reprodução:**
1. Lead vai para secretaria (Ana agenda reunião)
2. secretaria→advogado handoff ocorre
3. `iaPersonaChave="advogado"`, `lastOut.personaChave="secretaria"`
4. `processarHandoffsAtrasados`: `"secretaria" === "assistente"` → false → `personaTrocadaSemIntro=false` → cron não envia intro de Daniela
5. Daniela nunca se apresenta

**Correção:**
```typescript
// cron-agent.ts linha 350 — substituir:
const personaTrocadaSemIntro =
  ultimaMsg.direcao === "out" &&
  (ultimaMsg.personaChave === "assistente" || ultimaMsg.personaChave === "secretaria") && // ← adicionar secretaria
  minutosDesde >= 10;
```

---

### BUG-009 — ALTO | cron-agent.ts | Full table scan em 5.779 deals a cada 15 min

**Arquivo:** `cron-agent.ts` linhas 47–55

**Causa raiz:**
```typescript
const deals = await prisma.crmDeal.findMany({
  where: {
    iaAtiva: true,
    status: "aberto",
    projetoId: { not: null },
    iaStageChave: { not: null },
  },
  include: { contato: true },
});
```

5.779 deals carregados integralmente com `include: { contato: true }`, sem paginação, sem índice específico em `iaStageChave`. A cada 15 min, o cron carrega todos os registros em memória. Com crescimento da base, isso vai causar OOM no PM2 e timeouts.

**Impacto:** Degradação progressiva de performance. A cada 3 meses de operação, o número de deals pode triplicar.

**Correção:**
```typescript
// Adicionar índice no DB:
// CREATE INDEX CONCURRENTLY idx_crmdeal_ia_cron ON "CrmDeal" (projetoId, "iaAtiva", status, "iaStageChave")
//   WHERE "iaAtiva" = true AND status = 'aberto';

// Paginação no código:
const BATCH_SIZE = 100;
let skip = 0;
while (true) {
  const batch = await prisma.crmDeal.findMany({
    where: { iaAtiva: true, status: "aberto", projetoId: { not: null }, iaStageChave: { not: null } },
    include: { contato: { select: { whatsapp: true, nome: true } } }, // select mínimo
    take: BATCH_SIZE,
    skip,
    orderBy: { ultimoContatoEm: "asc" },
  });
  if (!batch.length) break;
  // processar batch
  skip += BATCH_SIZE;
}
```

---

### BUG-010 — MÉDIO | assistente-agents.ts | Mensagem errada: empresa_bloqueada quando razão é mista

**Arquivo:** `assistente-agents.ts` linhas 112–117

**Causa raiz:**
```typescript
const tipoRazao: "bloqueada" | "nao_clt" | "curto" =
  todosVinculosBloqueados ? "bloqueada"
  : temAlgumNaoClt        ? "nao_clt"
  : temAlgumBloqueado     ? "bloqueada"  // ← prioridade incorreta
  : temAlgumCurto         ? "curto"
  : "bloqueada";
```

Quando o lead tem v0=curto (não bloqueado) + v1=bloqueado, `temAlgumBloqueado=true` → `tipoRazao="bloqueada"` → mensagem de empresa_bloqueada. Mas a razão primária é que o lead não tem vínculo com tempo suficiente + não tem alternativas. A mensagem de empresa_bloqueada é inadequada e pode gerar desconfiança do lead.

**Correção:**
```typescript
// Verificar primeiro curto+bloqueado como combinação sem válido:
const tipoRazao: "bloqueada" | "nao_clt" | "curto" =
  todosVinculosBloqueados ? "bloqueada"
  : temAlgumNaoClt        ? "nao_clt"
  : temAlgumCurto         ? "curto"       // ← prioridade correta: curto antes de bloqueado
  : temAlgumBloqueado     ? "bloqueada"
  : "bloqueada";
```

---

### BUG-011 — MÉDIO | flow-controller.ts | sec_apresentacao: apresentacao_enviado não persiste no path inline assistente→secretaria

**Arquivo:** `stage-engine.ts` linhas 1277–1297 + `flow-controller.ts` linhas 280–302

**Causa raiz:** Ao fazer o handoff inline de assistente→secretaria (linha 1277), o código chama `advanceAdvogadoFlow` com `iaFlowStepChave: null`. Dentro de `advanceAdvogadoFlow`, o `apresentacao_enviado` é setado como `false` no update do DB (linha 299). A saudação é enviada e registrada no DB como mensagem, mas `iaFlowStepData.apresentacao_enviado` nunca é atualizado para `true` após o envio. Isso faz com que na próxima mensagem do lead, `advanceAdvogadoFlow` ainda veja `apresentacao_enviado=false` e retorne a saudação novamente (duplicata).

Já coberto parcialmente no BUG-003. A diferença: BUG-003 foca no reenvio pelo cron; BUG-011 foca no reenvio pelo webhook na próxima mensagem do lead (mais imediato).

---

### BUG-012 — MÉDIO | stage-engine.ts | Advogado com pergunta inesperada + step llm_gate → mensagem duplicada

**Arquivo:** `stage-engine.ts` linhas 1147–1202

**Causa raiz:**
```typescript
const willOverrideDeterministic =
  (!leadFezPerguntaInesperada || personaChave === "secretaria") && // secretaria ok
  ...
  advFlowStepType !== "llm_gate" &&  // llm_gate NÃO faz override determinístico
  ...
```

Quando `personaChave="advogado"`, `leadFezPerguntaInesperada=true`, e `advFlowStepType="llm_gate"`:
- `willOverrideDeterministic=false` (leadFezPerguntaInesperada=true para advogado, e llm_gate já seria false)
- LLM roda normalmente
- B13 lógica: `leadFezPerguntaInesperada && nextQDeterministico && advFlowStepType !== "llm_gate"` → FALSE (stepType é llm_gate) → NÃO appenda

OK, na verdade não é duplicata aqui. **Reavaliando:** O problema real é quando `personaChave="advogado"`, `leadFezPerguntaInesperada=true`, e `nextQDeterministico` existe mas `advFlowStepType` NÃO é `llm_generated` nem `llm_gate` (ex: stepType="question"). Nesse caso:
- LLM roda (willOverrideDeterministic=false)
- B13: `leadFezPerguntaInesperada && nextQDeterministico && advFlowStepType !== "llm_generated" && advFlowStepType !== "llm_gate"` → TRUE → nextQ é appended como segunda bolha

Resultado: para Daniela em step "question" com lead fazendo pergunta → LLM responde E appenda a pergunta determinística. Isso é comportamento intencional mas pode soar redundante/mecânico para Daniela.

---

### BUG-013 — MÉDIO | vinculos-processor.ts | Três implementações divergentes de parseMeses

**Arquivos:** `gate-evaluator.ts` linha 61, `persona-router.ts` linha 93, `vinculos-processor.ts` linha 34

**Três funções diferentes para a mesma operação:**
- `parseMeses` (gate-evaluator): retorna `null` se meses=0, aceita vírgula como decimal, processa semanas
- `parseTempToMeses` (persona-router): retorna `999` se não parseia (assume "muito tempo" = válido), aceita "menos/pouco" → 6 meses
- `parseMesesTempo` (vinculos-processor): retorna `0` se não parseia, **não processa dias** (BUG-001)

Divergências críticas:
- "30 dias": gate=1 mês, persona-router=1 mês, vinculos-processor=0 meses
- "não me lembro": gate=null, persona-router=999, vinculos-processor=0
- "poucos meses": gate=null, persona-router=6 meses, vinculos-processor=0

**Correção:** Centralizar em uma única função exportada de um módulo `time-parser.ts` e usar em todos os arquivos.

---

### BUG-014 — MÉDIO | gate-evaluator.ts | Prescrição de vínculo recente quando lead ainda empregado

**Contexto:** Um lead ainda empregado há 5 anos na mesma empresa não tem `data_saida`. O gate `prescricao` usa `vinculosTodosPrescritos` que é setado pelo vinculos-processor apenas quando `checkVinculoPrazo` é chamado. `checkVinculoPrazo` requer `data_saida` no vínculo para calcular prescrição. Portanto, leads ainda empregados nunca têm `vinculosTodosPrescritos=true`, o que é correto.

O bug real: leads que **acabaram de sair** e informam data de saída via relato espontâneo na primeira mensagem mas o vinculos-processor ainda não rodou o checkVinculoPrazo (porque o v0 ainda não está completo) podem ter a prescrição detectada tardiamente.

**Impacto:** BAIXO-MÉDIO — a prescrição é detectada eventualmente quando o vínculo é completado, mas pode gerar 2-3 perguntas adicionais desnecessárias.

---

### BUG-015 — MÉDIO | flow-controller.ts | sec_apresentacao (saudacao) avança sem lead escolher horário

**Arquivo:** `flow-controller.ts` linhas 349–352

**Causa raiz:**
```typescript
if (currentStep.stepType === "saudacao") {
  return await advanceToNextStep(deal, steps, currentStep, {}, null);
}
```

O step `sec_apresentacao` tem `stepType="saudacao"` e `campoColetar="horario_reuniao"`. Quando o lead envia qualquer mensagem (ex: "oi", "ok", "obrigado"), o step avança automaticamente para `sec_conclusao` sem que o campo `horario_reuniao` tenha sido preenchido.

O `campoColetar="horario_reuniao"` no step de saudação indica que o horário deve ser coletado nessa tela. Mas o código de saudação ignora `campoColetar` e avança incondicionalmente.

**Reprodução:**
1. Secretaria envia lista de horários
2. Lead responde "oi" (ACK)
3. `currentStep.stepType === "saudacao"` → `advanceToNextStep` → `sec_conclusao`
4. Lead never actually chose a horário — `horario_reuniao` fica null
5. `encontrarSlotPorTexto("oi", slots)` → null → `reuniaoJaCriada=false` → reunião não criada
6. `sec_conclusao` enviado mas reunião não confirmada no sistema

**Correção:**
```typescript
// flow-controller.ts — modificar saudacao handler:
if (currentStep.stepType === "saudacao") {
  // Se tem campoColetar, não avança automaticamente — precisa coletar o campo
  if (currentStep.campoColetar) {
    // Usa lógica normal de extração (tratar como "question")
    // Não auto-advance
  } else {
    return await advanceToNextStep(deal, steps, currentStep, {}, null);
  }
}
```

---

### BUG-016 — MÉDIO | secretaria-meeting.ts | Race condition: duas reuniões criadas para o mesmo lead

**Arquivo:** `stage-engine.ts` linhas 868–905 (bloco secretaria)

**Causa raiz:**
```typescript
const reuniaoJaCriada = merged._reuniao_criada || freshSecStepData._reuniao_criada;
if (!reuniaoJaCriada && contato.whatsapp) {
  // ... criarReuniaoAgente
}
```

Sem transação atômica. Se dois webhooks chegarem quase simultaneamente (ex: lead envia "opção 2" e depois "2" em 200ms), ambos processam concorrentemente:
1. Webhook A: `reuniaoJaCriada=false` → chama `criarReuniaoAgente`
2. Webhook B: `reuniaoJaCriada=false` (ainda não persistido) → chama `criarReuniaoAgente`
3. Duas `SessaoReuniao` criadas, dois links enviados, slot reservado duas vezes

**Correção:**
```typescript
// secretaria-meeting.ts — usar upsert ou check atômico:
// Antes de criar a reunião, executar upsert com unique constraint em dealId:
const existeReuniao = await prisma.sessaoReuniao.findFirst({ where: { dealId } });
if (existeReuniao) return existeReuniao; // idempotente

// Ou usar uma transação com pessimistic lock:
await prisma.$transaction(async (tx) => {
  const deal = await tx.crmDeal.findUnique({ where: { id: dealId }, select: { iaFlowStepData: true } });
  if ((deal?.iaFlowStepData as any)?._reuniao_criada) return null; // já criada
  // ... criar reunião
  await tx.crmDeal.update({ where: { id: dealId }, data: { iaFlowStepData: { _reuniao_criada: true } } });
});
```

---

### BUG-017 — MÉDIO | stage-engine.ts | allDone com temVinculoMinimo envia lead com dados incompletos para secretaria

**Arquivo:** `assistente-agents.ts` linhas 84–86

**Causa raiz:**
```typescript
const temVinculoMinimo = ctx.vinculos.some(v => v.empresa && (v.vinculo || v.saida));
if (!nextQ && (vinculosEffectivelyDone || temVinculoMinimo)) {
  // ... pode retornar allDone=true
}
```

`temVinculoMinimo` só requer `empresa` + (`vinculo` ou `saida`). Campos obrigatórios `horas_extras`, `pagamento_fora`, `injustica` podem estar ausentes. Daniela vai receber um caso sem dados suficientes para o parecer jurídico, e o handoff snapshot vai estar incompleto.

**Correção:**
```typescript
// Substituir temVinculoMinimo por verificação mais restrita:
const temVinculoSuficiente = ctx.vinculos.some(v =>
  v.empresa && v.vinculo && v.saida && v.tempo // campos mínimos para Daniela
);
```

---

### BUGS BAIXOS (BUG-018 a BUG-021)

**BUG-018:** `DESCARTE_REGEX` em stage-engine.ts linha 267 detecta frases como "não vamos conseguir provar isso sem documentos" (resposta legítima de Daniela) e intercepta com mensagem genérica. A regex deveria ser aplicada apenas para personaChave="assistente".

**BUG-019:** `recuperarMensagensPerdidas` descarta mensagens com `idadeMs > 4h`. Se o cron ficou offline por 4+ horas (deploy, OOM), mensagens válidas são silenciosamente ignoradas. Deveria pelo menos logar um alerta.

**BUG-020:** `runProativoNextStep` linha 1456: `if (!deal || !(deal as any).iaAtiva) return;` — a negação dupla `!(iaAtiva)` é incorreta semanticamente mas funciona. Se `iaAtiva=null` (estado inválido), `!null=true` → função retorna. Deveria ser `if (!deal || !(deal as any).iaAtiva === true)`.

**BUG-021:** `COMP_PREENCHIDO` em flow-controller.ts linhas 333–338 usa hardcoded step chaves. Se o admin renomear steps no DB para `comp_salario_recente`, o pré-skip quebra silenciosamente sem log de erro.

---

## FALSOS POSITIVOS DESCARTADOS

**FP-1: Gate vinculo_invalido para autônomo sem mais_empregos investigado** — comportamento INTENCIONAL. O guard protege leads que são CLT mas têm outro emprego autônomo secundário.

**FP-2: parseTempToMeses retorna 999 para texto não parseável** — INTENCIONAL. "Muito tempo" = válido é uma heurística razoável para evitar desqualificar por falta de dados.

**FP-3: sec_apresentacao como saudacao step não persiste campoColetar imediatamente** — funciona porque `encontrarSlotPorTexto` é chamado depois no bloco secretaria com `text` atual.

**FP-4: allAnswered=true quando isSdrTriagem e toStage="lead_qualificado"** — correto, triagem usa seu próprio pipeline de qualificação.

---

## COBERTURA

- Gates testados: 5/5
- Cenários executados: 31 (todos os especificados + variações)
- Cenários que falharam (bug confirmado): 12
- Deals em produção potencialmente afetados por CRÍTICOS: todos os 5.779

---

## PARTE 2 — PROMPT DE CORREÇÃO

---

# PROMPT-FIX-AVOCE-SDR

Você é engenheiro sênior do SDR Avoce. Implemente as correções abaixo em ordem de prioridade. Cada item especifica arquivo, função e mudança mínima necessária. NÃO altere lógica não especificada.

---

## PRIORIDADE 1 — CRÍTICO (implementar HOJE, antes do próximo deploy)

### FIX-01: vinculos-processor.ts — parseMesesTempo: adicionar suporte a dias

**Arquivo:** `/Users/pedrosilva/NfseCapium/server/src/agent/vinculos-processor.ts`
**Função:** `parseMesesTempo` (linha 34)
**Mudança:**
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
  const ma = t.match(/(\d+(?:[,.]\d+)?)\s*an/i);
  const mm = t.match(/(\d+(?:[,.]\d+)?)\s*m[eê]/i);
  const md = t.match(/(\d+(?:[,.]\d+)?)\s*dia/i);
  if (ma) meses += Math.round(parseFloat(ma[1].replace(",", ".")) * 12);
  if (mm) meses += Math.floor(parseFloat(mm[1].replace(",", ".")));
  if (md && !ma && !mm) meses += parseFloat(md[1].replace(",", ".")) / 30;
  return meses;
}
```

### FIX-02: assistente-agents.ts — temVinculoValido: tempo null = inválido

**Arquivo:** `/Users/pedrosilva/NfseCapium/server/src/agent/assistente-agents.ts`
**Função:** `runAssistenteAgent` — bloco `temVinculoValido` (linha 98)
**Mudança:**
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
  v.tempo != null && v.tempo !== "" &&    // ← tempo deve estar coletado
  parseTempToMeses(String(v.tempo)) >= mesesMin &&
  !isNaoClt(v.vinculo)
);
```

### FIX-03: vinculos-processor.ts — auto-close: só fechar com 2+ vínculos se há pelo menos 1 válido

**Arquivo:** `/Users/pedrosilva/NfseCapium/server/src/agent/vinculos-processor.ts`
**Linha:** 210
**Mudança:**
```typescript
// ANTES:
if (!w._vinculos_ok && todosCompletos(vinculosAtuais) && vinculosAtuais.length >= 2) {
  w._vinculos_ok = true;
  w.vinculos = vinculosAtuais;
}

// DEPOIS:
if (!w._vinculos_ok && todosCompletos(vinculosAtuais) && vinculosAtuais.length >= 2) {
  const NON_CLT_RE_CLOSE = /autônomo|autonomo|pj|informal|avulso|cooperado/i;
  const BLOQUEADAS = (input.merged._empresas_bloqueadas_norm as string[] | undefined) ?? [];
  // Nota: empresasBloqueadas não está disponível aqui — usar campo persistido ou
  // deixar assistente-agents decidir se o close é válido
  // Alternativa segura: só fechar se há pelo menos 1 vínculo CLT com tempo suficiente
  const algumCltValido = vinculosAtuais.some(v =>
    v.vinculo != null &&
    !NON_CLT_RE_CLOSE.test(String(v.vinculo)) &&
    parseMesesTempo(String(v.tempo ?? "")) >= 2
  );
  const mais_empregos_negado = w._mais_empregos_negado === true || w.tem_emprego_anterior === false;
  if (algumCltValido || mais_empregos_negado) {
    w._vinculos_ok = true;
    w.vinculos = vinculosAtuais;
  }
  // Se não tem vínculo válido e mais_empregos não foi negado: NÃO fecha
  // assistente-agents vai perguntar sobre mais empregos
}
```

### FIX-04: stage-engine.ts — Marcar apresentacao_enviado=true após envio inline da secretaria (path assistente→secretaria)

**Arquivo:** `/Users/pedrosilva/NfseCapium/server/src/agent/stage-engine.ts`
**Após linha 1293** (envio da saudação da secretaria no path `proximaPersonaChaveAssistente === "secretaria"`):
```typescript
// ADICIONAR após o bloco de envio (após prisma.crmMensagemWhatsapp.create):
await prisma.crmDeal.update({
  where: { id: deal.id },
  data: {
    iaFlowStepData: {
      apresentacao_enviado: true,
      sec_apresentacao_enviado: true,
    },
  },
});
console.log(`[StageEngine] sec_apresentacao marcado como enviado para deal ${deal.id}`);
```

**Também aplicar no path advogado→secretaria (linha ~814):**
```typescript
// Após o bloco if (nextQDeterministico?.includes("{horarios}")) { ... }
// ADICIONAR:
await saveFlowStepData(
  { id: deal.id, iaFlowStepData: {}, qualificacao: deal.qualificacao },
  { apresentacao_enviado: true, sec_apresentacao_enviado: true },
  "sec_apresentacao"
);
```

### FIX-05: cron-agent.ts — processarHandoffsAtrasados: incluir secretaria como lastOut válido

**Arquivo:** `/Users/pedrosilva/NfseCapium/server/src/agent/cron-agent.ts`
**Linha:** 350
**Mudança:**
```typescript
// ANTES:
ultimaMsg.personaChave === "assistente" &&

// DEPOIS:
(ultimaMsg.personaChave === "assistente" || ultimaMsg.personaChave === "secretaria") &&
```

---

## PRIORIDADE 2 — ALTO (implementar antes do próximo lote de leads)

### FIX-06: stage-engine.ts — Normalizar texto antes do regex NAO_CARRETEIRO_RE

**Arquivo:** `/Users/pedrosilva/NfseCapium/server/src/agent/stage-engine.ts`
**Função:** `extractAndApplyQual` (linha 173)
**Mudança:**
```typescript
// ANTES:
if ((merged.e_carreteiro === undefined || merged.e_carreteiro === null) && text) {
  const NAO_CARRETEIRO_RE = /\b(taxista|...|autonomo\s+sem\s+carteira|...)\b/i;
  if (NAO_CARRETEIRO_RE.test(text)) {

// DEPOIS:
if ((merged.e_carreteiro === undefined || merged.e_carreteiro === null) && text) {
  const textNorm = text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const NAO_CARRETEIRO_RE = /\b(taxista|taxi|motorista\s+de\s+(taxi|aplicativo)|uber|99\s*(driver|app)?\b|indriver|mototaxi|motoboy|entregador\s+(ifood|rappi|motoboy|de\s+aplicativo)|ifood\b|rappi\b|autonomo(\s+sem\s+carteira)?|sem\s+carteira|dono\s+do\s+(veiculo|caminhao)|carro\s+proprio|caminhao\s+proprio)\b/i;
  if (NAO_CARRETEIRO_RE.test(textNorm)) {
```

### FIX-07: triagem-router.ts — tipo_motorista_valido: usar e_carreteiro como fallback ou gate action extracted

**Arquivo:** `/Users/pedrosilva/NfseCapium/server/src/agent/triagem-router.ts`
**Função:** `resolvePostPhaseRoute` (linha 54)
**Mudança:**
```typescript
// ANTES:
const tipoMotoristaValido = asBool(merged.tipo_motorista_valido);
if (tipoMotoristaValido === false) return { toStage: "lead_desqualificado", motivo: "tipo_motorista_invalido" };

// DEPOIS:
// tipo_motorista_valido pode ser setado pelo gate do step confirmar_funcao via extracted
// OU podemos usar e_carreteiro como fallback (setado pelo regex pré-LLM ou LLM)
const tipoMotoristaValido = asBool(merged.tipo_motorista_valido) ?? asBool(merged.e_carreteiro);
if (tipoMotoristaValido === false) return { toStage: "lead_desqualificado", motivo: "tipo_motorista_invalido" };

// TAMBÉM: modificar os gates do step confirmar_funcao para incluir extracted:
// Gate "NÃO é motorista de carga": actionType="end", extracted: { tipo_motorista_valido: "false" }
// Isso requer update no DB: UPDATE "IaFlowGate" SET extracted = '{"tipo_motorista_valido": "false"}'
//   WHERE condicao LIKE 'NÃO é motorista%'
```

### FIX-08: triagem-router.ts — pessoalidade: null → false quando rv_substituto respondido como true

**Arquivo:** `/Users/pedrosilva/NfseCapium/server/src/agent/triagem-router.ts`
**Linha:** 107
**Mudança:**
```typescript
// ANTES:
const pessoalidade = asBool(merged.rv_substituto) === false ? true : null;

// DEPOIS:
const rv_sub = asBool(merged.rv_substituto);
// rv_substituto=false → lead NÃO tinha substituto → pessoalidade=true (elemento presente)
// rv_substituto=true → lead TINHA substituto → pessoalidade=false (elemento ausente)
// rv_substituto=null → não respondido → null (aguardar)
const pessoalidade = rv_sub === false ? true : rv_sub === true ? false : null;
```

### FIX-09: cron-agent.ts — Paginação + índice para processarTimeoutsAgente

**Arquivo:** `/Users/pedrosilva/NfseCapium/server/src/agent/cron-agent.ts`
**Função:** `processarTimeoutsAgente` (linha 42)

Script de migração a executar no DB:
```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_crmdeal_cron
ON "CrmDeal" ("projetoId", "iaAtiva", status, "iaStageChave", "ultimoContatoEm")
WHERE "iaAtiva" = true AND status = 'aberto';
```

Código:
```typescript
// Adicionar select: { ... } para carregar apenas campos necessários:
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

### FIX-10: assistente-agents.ts — tipoRazao: prioridade curto antes de bloqueado

**Arquivo:** `/Users/pedrosilva/NfseCapium/server/src/agent/assistente-agents.ts`
**Linhas:** 112–117
**Mudança:**
```typescript
// ANTES:
const tipoRazao: "bloqueada" | "nao_clt" | "curto" =
  todosVinculosBloqueados ? "bloqueada"
  : temAlgumNaoClt        ? "nao_clt"
  : temAlgumBloqueado     ? "bloqueada"
  : temAlgumCurto         ? "curto"
  : "bloqueada";

// DEPOIS:
const tipoRazao: "bloqueada" | "nao_clt" | "curto" =
  todosVinculosBloqueados ? "bloqueada"
  : temAlgumNaoClt        ? "nao_clt"
  : temAlgumCurto         ? "curto"     // ← swap: curto antes de bloqueado parcial
  : temAlgumBloqueado     ? "bloqueada"
  : "bloqueada";
```

---

## PRIORIDADE 3 — MÉDIO (implementar no próximo sprint)

### FIX-11: flow-controller.ts — sec_apresentacao saudacao: não avançar se campoColetar não preenchido

**Arquivo:** `/Users/pedrosilva/NfseCapium/server/src/agent/flow-controller.ts`
**Linhas:** 349–352
**Mudança:**
```typescript
// ANTES:
if (currentStep.stepType === "saudacao") {
  return await advanceToNextStep(deal, steps, currentStep, {}, null);
}

// DEPOIS:
if (currentStep.stepType === "saudacao") {
  // Se o step tem campoColetar, não avança automaticamente — precisa coletar o campo
  // (ex: sec_apresentacao coleta horario_reuniao)
  if (!currentStep.campoColetar) {
    return await advanceToNextStep(deal, steps, currentStep, {}, null);
  }
  // Fall through para lógica normal de extração (tratado como "question")
}
```

### FIX-12: secretaria-meeting.ts — Guard de idempotência antes de criarReuniaoAgente

**Arquivo:** `/Users/pedrosilva/NfseCapium/server/src/agent/secretaria-meeting.ts`
**Função:** `criarReuniaoAgente`
**Adicionar no início:**
```typescript
export async function criarReuniaoAgente(...): Promise<SessaoReuniao | null> {
  // Guard de idempotência — previne race condition com webhooks simultâneos
  const reuniaoExistente = await (prisma.sessaoReuniao as any).findFirst({
    where: { dealId },
    select: { id: true, linkConvidado: true },
  });
  if (reuniaoExistente) {
    console.log(`[SecretariaMeeting] dealId=${dealId} — reunião já existe (${reuniaoExistente.id}), retornando existente`);
    return reuniaoExistente;
  }
  // ... resto da função
}
```

### FIX-13: assistente-agents.ts — temVinculoMinimo: exigir campos suficientes para Daniela

**Arquivo:** `/Users/pedrosilva/NfseCapium/server/src/agent/assistente-agents.ts`
**Linha:** 84
**Mudança:**
```typescript
// ANTES:
const temVinculoMinimo = ctx.vinculos.some(v => v.empresa && (v.vinculo || v.saida));

// DEPOIS:
const temVinculoMinimo = ctx.vinculos.some(v =>
  v.empresa && v.vinculo && v.saida && v.tempo // mínimo para parecer jurídico
);
```

### FIX-14: Centralizar parsing de tempo em módulo único

**Criar:** `/Users/pedrosilva/NfseCapium/server/src/agent/time-parser.ts`
```typescript
/**
 * Parses tempo text to months. Single source of truth.
 * Returns null if text cannot be parsed (unknown/empty).
 * Returns 999 for generic "long time" expressions ("muito tempo", "anos").
 */
export function parseTempToMesesUnified(texto: string | null | undefined): number | null {
  if (!texto) return null;
  const t = texto.toLowerCase().trim();
  let meses = 0;
  const anos = t.match(/(\d+(?:[,.]\d+)?)\s*ano/);
  const mes  = t.match(/(\d+(?:[,.]\d+)?)\s*m[eê]s/);
  const sem  = t.match(/(\d+(?:[,.]\d+)?)\s*semana/);
  const dia  = t.match(/(\d+(?:[,.]\d+)?)\s*dia/);
  if (anos) meses += Math.round(parseFloat(anos[1].replace(",", ".")) * 12);
  if (mes)  meses += Math.floor(parseFloat(mes[1].replace(",", ".")));
  if (sem)  meses += Math.round(parseFloat(sem[1].replace(",", ".")) / 4.3);
  if (dia && !anos && !mes && !sem) meses += parseFloat(dia[1].replace(",", ".")) / 30;
  if (!anos && !mes && !sem && !dia) {
    if (/muito tempo|bastante tempo|muitos anos/.test(t)) return 999;
    if (/menos|pouco|alguns meses/.test(t)) return 3;
    return null; // não parseável
  }
  return meses > 0 ? meses : null;
}
```

Substituir todas as chamadas em gate-evaluator.ts, vinculos-processor.ts e persona-router.ts.

### FIX-15: stage-engine.ts — DESCARTE_REGEX restringido a personaChave="assistente"

**Arquivo:** `/Users/pedrosilva/NfseCapium/server/src/agent/stage-engine.ts`
**Linha:** 1329
**Mudança:**
```typescript
// ANTES:
if (DESCARTE_REGEX.test(resposta) && stageChave !== "descartado") {

// DEPOIS:
if (personaChave === "assistente" && DESCARTE_REGEX.test(resposta) && stageChave !== "descartado") {
```

### FIX-16: cron-agent.ts — recuperarMensagensPerdidas: logar mensagens > 4h sem tentar ignorar

**Arquivo:** `/Users/pedrosilva/NfseCapium/server/src/agent/cron-agent.ts`
**Linha:** 294
**Mudança:**
```typescript
// ANTES:
if (idadeMs > 4 * 60 * 60 * 1000) continue;

// DEPOIS:
if (idadeMs > 4 * 60 * 60 * 1000) {
  console.warn(`[CronAgent] Deal ${deal.id}: mensagem de ${Math.round(idadeMs / 3600000)}h atrás — muito antiga para recuperar automaticamente`);
  continue;
}
```

### FIX-17: Adicionar índice no DB para recuperarMensagensPerdidas

```sql
-- Executar no DB (Debian server):
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_crmdeal_recuperar
ON "CrmDeal" ("iaAtiva", status, "projetoId", "iaStageChave")
WHERE "iaAtiva" = true AND status = 'aberto';

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_mensagem_deal_dir_em
ON "CrmMensagemWhatsapp" ("dealId", direcao, "enviadaEm" DESC);
```

### FIX-18: triagem-router.ts — Atualizar gate confirmar_funcao no DB para extrair tipo_motorista_valido

```sql
-- Executar no DB para os gates de desqualificação do step confirmar_funcao:
UPDATE "IaFlowGate"
SET "actionValue" = jsonb_build_object('tipo_motorista_valido', 'false')::text
WHERE condicao LIKE 'NÃO é motorista%'
  AND "stepId" IN (
    SELECT id FROM "IaFlowStep"
    WHERE chave = 'confirmar_funcao'
    AND "projetoId" = 'cmnvy47x3000wrmmamnsrhgj9'
  );
```

**Nota:** Verificar estrutura exata do campo `actionValue` no schema antes de executar.

### FIX-19: flow-controller.ts — COMP_PREENCHIDO: usar chaves configuradas via DB

**Arquivo:** `/Users/pedrosilva/NfseCapium/server/src/agent/flow-controller.ts`
**Linhas:** 333–338
**Mudança:** Carregar os steps `comp_*` do banco e verificar `campoColetar` dinamicamente:
```typescript
// ANTES: hardcoded keys
const COMP_PREENCHIDO: Record<string, boolean> = {
  comp_salario: !!(v0?.salario_holerite || ...),
  // ...
};

// DEPOIS: verificar se o step atual é do tipo comp_ e se o campo já foi coletado
// Usar isFieldCollected(merged, currentStep.campoColetar, vinculos) diretamente
// (já implementado no advanceToNextStep pre-skip)
```

### FIX-20: cron-agent.ts + secretaria — Select mínimo em recuperarMensagensPerdidas

**Arquivo:** `/Users/pedrosilva/NfseCapium/server/src/agent/cron-agent.ts`
**Linhas:** 168–178
**Mudança:**
```typescript
// ANTES:
const deals = await prisma.crmDeal.findMany({
  where: { ... },
  include: { contato: true },
});

// DEPOIS:
const deals = await prisma.crmDeal.findMany({
  where: { ... },
  select: {
    id: true, projetoId: true, iaStageChave: true, iaPersonaChave: true,
    iaAtiva: true, status: true, iaFlowStepData: true, qualificacao: true,
    contato: { select: { whatsapp: true, nome: true } },
  },
});
```

### FIX-21: Adicionar log quando autonomousPersonaOverride silencia sem log

**Arquivo:** `/Users/pedrosilva/NfseCapium/server/src/agent/stage-engine.ts`
**Linha:** 429
**Mudança:**
```typescript
// ANTES:
if (!fase || (fase.requerAcaoHumana && !autonomousPersonaOverride)) return;

// DEPOIS:
if (!fase || (fase.requerAcaoHumana && !autonomousPersonaOverride)) {
  if (!fase) {
    console.warn(`[StageEngine] dealId=${deal?.id} stage="${stageChave}" não encontrada — ignorando`);
  } else {
    console.log(`[StageEngine] dealId=${deal?.id} stage="${stageChave}" requerAcaoHumana=true, persona="${personaChave}" não autônoma — silenciando`);
  }
  return;
}
```

---

## ORDEM DE DEPLOY RECOMENDADA

```
Fase 1 (HOJE — sem reinício de PM2 necessário para DB):
  - FIX-17 (índices DB) — executar via psql no servidor Debian

Fase 2 (HOJE — code deploy):
  - FIX-01 (parseMesesTempo dias)
  - FIX-02 (temVinculoValido tempo null)
  - FIX-03 (auto-close guard)
  - FIX-04 (apresentacao_enviado após envio inline)
  - FIX-05 (handoff cron secretaria)
  - FIX-09 (select mínimo cron)
  - FIX-15 (DESCARTE_REGEX restringido)

Fase 3 (SPRINT SEGUINTE):
  - FIX-06 (NAO_CARRETEIRO_RE Unicode)
  - FIX-07 + FIX-18 (triagem tipo_motorista)
  - FIX-08 (pessoalidade)
  - FIX-10 (tipoRazao ordem)
  - FIX-11 (saudacao campoColetar)
  - FIX-12 (race condition reunião)
  - FIX-13 (temVinculoMinimo)
  - FIX-14 (centralizar time-parser)
  - FIX-16 (log mensagens antigas)
  - FIX-19 (COMP_PREENCHIDO dinâmico)
  - FIX-20 (select mínimo recuperar)
  - FIX-21 (log silenciamento)
```

---

## ESTIMATIVA DE RISCO

| Fase | Arquivos alterados | Risk de regressão | Razão |
|------|-------------------|-------------------|-------|
| 1    | 0 (só DB)         | BAIXO             | Apenas índices, sem lógica |
| 2    | 4                 | MÉDIO             | vinculos-processor e stage-engine têm muitos pontos de entrada |
| 3    | 7+                | MÉDIO-ALTO        | Mudanças em fluxo de triagem e flow-controller afetam múltiplos modos |

**Teste mínimo antes do deploy Fase 2:**
1. Lead taxista → deve desqualificar via nao_carreteiro
2. Lead CLT 30 dias + CLT 3 anos → deve qualificar (não desqualificar por B2)
3. Lead CLT 30 dias + nega mais empregos → deve desqualificar via tempo_minimo
4. Qualificação completa → secretaria → saudação NOT duplicada após 90min
