# Roteiro de Teste Manual — Modos de Coleta

**Versão:** 2026-04-29  
**Escopo:** Ana (persona `assistente`) — fase de qualificação de carreteiros  
**Arquivo de referência principal:** `src/agent/stage-engine.ts` + `vinculos-processor.ts` + `assistente-agents.ts` + `persona-router.ts`

---

## Status dos modos

| Modo | Ativo? | Como ativar |
|------|--------|-------------|
| **Sequencial** | ✅ Sim (padrão) | Nenhuma configuração necessária |
| **Conversacional** | ⚠️ Implementado mas não conectado | Requer integração de `conversational-router.ts` em `stage-engine.ts` + config `modo_coleta=conversacional` |

> O `conversational-router.ts` existe e está correto, mas `stage-engine.ts` não o importa ainda. O Roteiro B documenta o comportamento esperado **quando ativado**.

---

## Campos obrigatórios para `_vinculos_ok = true`

Definidos em `CAMPOS_REQ` em `vinculos-processor.ts` e `assistente-agents.ts`:

| Campo | O que representa |
|-------|-----------------|
| `empresa` | Nome da transportadora / empregadora |
| `funcao` | Cargo: motorista, auxiliar, mecânico, etc. |
| `vinculo` | Tipo: CLT, autônomo, agregado, TAC |
| `saida` | Forma de desligamento: demitido, pediu demissão, ainda empregado, rescisão indireta |
| `tempo` | Período trabalhado (ex.: "2 anos e 3 meses") |
| `horas_extras` | Se trabalhava além da jornada e se recebia |
| `pagamento_fora` | Valores fora do holerite: Pamcard, PIX, dinheiro |
| `injustica` | Irregularidades: pressão, desconto indevido, jornada sem registro |

**Regra de fechamento (vinculos-processor.ts):**

```
_vinculos_ok = true  quando:
  - Todos os 8 campos acima preenchidos  
  - E LLM sinaliza semMaisEmpregos  
  - Exceto: se tempo < 24 meses E mais_empregos_perguntado = false → BLOQUEIA
    (força perguntar mais_empregos antes de fechar)

Alternativas que também fecham:
  - 2+ vínculos completos
  - 1 vínculo completo após mais_empregos ter sido perguntado (maisEmpregosPerguntado = true)
```

**Campos adicionais necessários para `allDone = true`** (via `getNextDeterministicQuestion()`):

| Campo | Fase |
|-------|------|
| `nome` | Pré-vínculos |
| `cidade` | Pré-vínculos |
| `plataforma_anuncio` | Pré-vínculos |
| `interesse` | Pós-vínculos (fallback hardcoded quando DB sem passos configurados) |
| Passos do DB `pos_vinculos` ou `pos_vinculos_curto` | Pós-vínculos (sobrescreve fallback se configurado) |

---

## ROTEIRO A — MODO SEQUENCIAL

> Comportamento atual em produção.  
> A cada turno, `applyDeterministicOverride` substitui a resposta do LLM pela `nextQDeterministico` — uma pergunta por vez.

---

### Cenário A1 — Fluxo completo sem intercorrência

**Perfil:** CLT, 3 anos de empresa, demitido, sem emprego anterior nos últimos 2 anos.

---

**Turno 1 — Saudação**  
Lead diz: *(primeira mensagem, qualquer texto — ex.: "Oi", "Bom dia", "Vi o anúncio")*  
Sistema deve responder: Saudação com horário correto + pergunta de nome e cidade numa frase  
Campo coletado: — *(nenhum ainda — saudação apenas)*  
Flag alterada: `_saudacao_enviada = true`

> Mecanismo: `_saudacao_enviada` não existe → `getGreetingStep()` retorna passo DB com `stepType=saudacao`. Se não configurado no DB, hardcoded: `"Bom dia! Qual é o seu nome e de onde você é?"`

---

**Turno 2 — Nome + Cidade**  
Lead diz: *"João Silva, sou de Feira de Santana"*  
Sistema deve responder: Confirmação natural + pergunta sobre canal do anúncio  
Campo coletado: `nome = "João Silva"`, `cidade = "Feira de Santana"`  
Flag alterada: —

> Mecanismo: `extractQualificacaoData()` extrai ambos. `getNextPreVinculosQuestion()` retorna próximo passo pré-vínculos (ou fallback `plataforma_anuncio`).

---

**Turno 3 — Canal do anúncio**  
Lead diz: *"Vi no Instagram"*  
Sistema deve responder: Confirmação + pergunta sobre empresa onde trabalhou  
Campo coletado: `plataforma_anuncio = "Instagram"`  
Flag alterada: —

> Mecanismo: pré-vínculos encerrados → `getNextVinculoQuestion()` retorna pergunta `empresa` (ordem 1).

---

**Turno 4 — Empresa**  
Lead diz: *"Transportes ABC"*  
Sistema deve responder: Confirmação + pergunta sobre função  
Campo coletado: `vinculos[0].empresa = "Transportes ABC"`  
Flag alterada: —

---

**Turno 5 — Função**  
Lead diz: *"Era motorista truck"*  
Sistema deve responder: Confirmação + pergunta sobre tipo de contrato (CLT ou autônomo)  
Campo coletado: `vinculos[0].funcao = "motorista truck"`  
Flag alterada: —

---

**Turno 6 — Tipo de vínculo**  
Lead diz: *"Tinha carteira assinada"*  
Sistema deve responder: Confirmação + pergunta sobre desligamento  
Campo coletado: `vinculos[0].vinculo = "CLT"` (ou equivalente)  
Flag alterada: pergunta de `frota` será **pulada** (skipSe: vinculo contém "clt")

---

**Turno 7 — Saída**  
Lead diz: *"Fui demitido em março de 2024"*  
Sistema deve responder: Confirmação + pergunta sobre tempo trabalhado  
Campo coletado: `vinculos[0].saida = "demitido"`, `vinculos[0].data_saida ≈ "2024-03"` (se extraído)  
Flag alterada: —

---

**Turno 8 — Tempo**  
Lead diz: *"Trabalhei 3 anos lá"*  
Sistema deve responder: Confirmação + pergunta sobre horas extras  
Campo coletado: `vinculos[0].tempo = "3 anos"`  
Flag alterada: — *(tempo ≥ 24 meses → gate de mais_empregos NÃO bloqueia)*

---

**Turno 9 — Horas extras**  
Lead diz: *"Sim, fazia bastante hora extra mas não pagavam"*  
Sistema deve responder: Confirmação empática + pergunta sobre pagamento fora do holerite  
Campo coletado: `vinculos[0].horas_extras = "sim, não remuneradas"` (ou equivalente booleano/texto)  
Flag alterada: —

---

**Turno 10 — Pagamento fora**  
Lead diz: *"Não, recebia só pelo holerite"*  
Sistema deve responder: Confirmação + pergunta sobre irregularidades/pressão  
Campo coletado: `vinculos[0].pagamento_fora = "não"`  
Flag alterada: —

---

**Turno 11 — Injustiça**  
Lead diz: *"Tinha pressão pra dirigir cansado e descontavam avaria sem culpa"*  
Sistema deve responder: Confirmação + pergunta se trabalhou em outra empresa nos últimos 2 anos  
Campo coletado: `vinculos[0].injustica = "pressão + descontos indevidos"` (ou texto)  
Flag alterada: —

> Mecanismo: todos os 8 CAMPOS_REQ de `vinculos[0]` preenchidos → `mais_empregos` (ordem 10) é a próxima pergunta.

---

**Turno 12 — Mais empregos**  
Lead diz: *"Não, fui só lá mesmo"*  
Sistema deve responder: Confirmação + pergunta pós-vínculos (se configurada no DB) ou pergunta de interesse  
Campo coletado: — *(sinal `semMaisEmpregos` extraído pelo LLM)*  
Flag alterada: `_vinculos_ok = true`

> Mecanismo: `processVinculos()` detecta `semMaisEmpregos` via `tryExtractVinculo()` → `todosCompletos()` = true → tempo 36m ≥ 24m → `_vinculos_ok = true`.  
> `maisEmpregosPerguntado = true` (verificado no texto da última mensagem da Ana: "outro lugar", "outra empresa", etc.)

---

**Turno 13 — Pós-vínculos / Interesse**  
Lead diz: *"Sim, quero saber o que posso receber"*  
Sistema deve responder: Confirmação + encerramento de Ana ("A Dra. Daniela vai te chamar agora mesmo…")  
Campo coletado: `interesse = "sim"` (ou via passo DB)  
Flag alterada: `allDone = true`

> Mecanismo: `getNextDeterministicQuestion()` retorna `null` → `runAssistenteAgent()` retorna `allDone: true` → `assistenteAgentResult.allDone = true` → `allAnswered = true`.

---

**Turno 14 — Transição para Daniela**  
*(automático, sem mensagem do lead)*  
Sistema deve: Disparar `transitionDeal(projetoId, dealId, "qualificacao_completa", phone)` → deal muda de stage → Daniela entra com delay configurado na `IaRegraTransicao` (~45s)  
Campo coletado: —  
Flag alterada: stage do deal muda; `iaPersonaChave` passa para `advogado`

---

**Total: 13 turnos do lead + 1 transição automática.**

---

### Cenário A2 — Lead com emprego anterior obrigatório

**Perfil:** Último emprego durou apenas 14 meses (< 24 meses). Ana DEVE investigar emprego anterior antes de fechar.

Turnos 1–11 idênticos ao A1, exceto no Turno 8:

**Turno 8 — Tempo**  
Lead diz: *"Trabalhei 1 ano e 2 meses lá"*  
Campo coletado: `vinculos[0].tempo = "1 ano e 2 meses"` → `tempoMeses ≈ 14`  
Flag alterada: ⚠️ gate ativo — tempo < 24 meses

---

**Turno 12 — Mais empregos (forçado pelo gate)**  
Lead diz: *"Não, só trabalhei lá"*  
Sistema deve responder: ⚠️ **NÃO deve fechar** — mesmo que `semMaisEmpregos` seja extraído, `_vinculos_ok` NÃO é setado porque `maisEmpregosPerguntado = false` ainda.

> **O que controla esse comportamento:**  
> Em `vinculos-processor.ts`:
> ```typescript
> if (!(tempoMeses > 0 && tempoMeses < 24 && !maisEmpregosPerguntado)) {
>   w._vinculos_ok = true;  // não executa aqui
> }
> ```
> `maisEmpregosPerguntado` é derivado da última mensagem enviada pela Ana — busca por regex `/outro lugar|outra empresa|mais emprego|trabalhou antes|emprego anterior|antes dis[st]/i` no último `out` do histórico.

**PORÉM:** o passo `mais_empregos` (ordem 10) está na lista de passos determinísticos. Na próxima mensagem da Ana, `getNextVinculoQuestion()` chegará até ele e a pergunta será disparada explicitamente.

---

**Turno 13 — Mais empregos (pergunta explícita)**  
*(Ana agora pergunta explicitamente sobre emprego anterior, pois `mais_empregos` ainda não foi coberto com `maisEmpregosPerguntado = true`)*  
Lead diz: *"Ah sim, antes trabalhei na Transportadora XYZ por 8 meses"*  
Sistema deve responder: Confirmação + pergunta sobre função na XYZ  
Campo coletado: `vinculos[1].empresa = "Transportadora XYZ"`, `_mais_empregos_confirmado = true`  
Flag alterada: `_mais_empregos_confirmado = true`; fase do assistente muda para `vinculos_anterior`

---

**Turnos 14–19 — Coleta do emprego anterior**  
Coleta dos campos: `funcao`, `vinculo`, `saida`, `tempo`, `horas_extras`, `pagamento_fora`, `injustica` para `vinculos[1]`.

> **Regras específicas da fase `vinculos_anterior`:**  
> - A person JÁ saiu → NUNCA perguntar "ainda está trabalhando lá?"  
> - Pergunta de saída usa passado: "Como foi o desligamento na XYZ?"  
> - Pergunta de saída inclui data: "E quando foi isso?"

---

**Turno 20 — Mais empregos após XYZ**  
Lead diz: *"Não, foram só essas duas"*  
Sistema deve responder: Confirmação + pós-vínculos  
Campo coletado: sinal `semMaisEmpregos`  
Flag alterada: `_vinculos_ok = true` *(2 vínculos completos → auto-close)*

> Mecanismo: `todosCompletos(vinculosAtuais) && vinculosAtuais.length >= 2` → `_vinculos_ok = true` (auto-close sem depender do gate de 24 meses).

---

**Total: ~21 turnos (vs. 13 no fluxo A1).**

---

### Cenário A3 — Lead autônomo (não é disqualificado)

**Perfil:** Lead era "agregado" / autônomo — nunca teve carteira assinada nessa empresa.

Turnos 1–5 idênticos ao A1.

---

**Turno 6 — Tipo de vínculo**  
Lead diz: *"Não tinha carteira não, era agregado"*  
Sistema deve responder: Confirmação + pergunta sobre desligamento  
Campo coletado: `vinculos[0].vinculo = "agregado"` (ou "autônomo")  
Flag alterada: pergunta de `frota` **NÃO será pulada** (skipSe só pula para CLT/carteira assinada)

---

**Turno 7 — Saída**  
Lead diz: *"Parei de trabalhar lá há 1 ano, saí por conta própria"*  
Sistema deve responder: Confirmação + pergunta sobre tempo  
Campo coletado: `vinculos[0].saida = "pediu demissão"` / `vinculos[0].data_saida ≈ "2025-04"`

---

**Turno 8 — Tempo**  
Lead diz: *"Uns 4 anos"*  
Campo coletado: `vinculos[0].tempo = "4 anos"`

---

**Turnos 9–11 — horas_extras, pagamento_fora, injustica**  
*(idêntico ao A1)*

---

**Turno 12 — Frota** *(pergunta EXTRA que CLT não tem)*  
Lead diz: *"A empresa tinha umas 30 carretas"*  
Sistema deve responder: Confirmação + pergunta mais_empregos  
Campo coletado: `vinculos[0].frota = "30"` (ou equivalente)  
Flag alterada: —

> Mecanismo: `shouldSkipPasso(passo_frota, vinculo)` verifica `vinculo.vinculo` por "clt", "carteira assinada", "carteira" → não encontra → **não pula** → pergunta é feita.

---

**Turno 13 — Mais empregos**  
Lead diz: *"Não, trabalhei só lá"*  
Sistema deve responder: Confirmação + pós-vínculos / interesse  
Campo coletado: sinal `semMaisEmpregos`  
Flag alterada: `_vinculos_ok = true`

---

**O que acontece com `_vinculos_ok` e a transição para Daniela?**

- `_vinculos_ok = true` é setado normalmente — o sistema **não disqualifica autônomos**.
- A transição `qualificacao_completa` ocorre normalmente.
- Daniela recebe o lead e faz a avaliação jurídica da existência de vínculo empregatício disfarçado (prática comum no setor de transporte).

> A disqualificação por prescrição (> 5 anos desde a saída) existe, mas é por prazo, não por tipo de vínculo.

---

## ROTEIRO B — MODO CONVERSACIONAL

> ⚠️ **Status:** `conversational-router.ts` implementado mas NÃO conectado ao `stage-engine.ts`.  
> Para ativar: (1) integrar `getConversationalSystemInstructions()` em `stage-engine.ts`, (2) ler config `modo_coleta` de `IaProjetoConfig`, (3) quando `"conversacional"`, substituir `applyDeterministicOverride` pelo `systemSuffix` do router.

Este roteiro documenta o **comportamento esperado quando ativado**, com base em `conversational-router.ts`.

---

### Cenário B1 — Resposta completa numa só mensagem

**Perfil:** Lead prolixo que dá múltiplos dados de uma vez.

---

**Turno 1 — Saudação**  
Lead diz: *"Oi"*  
Ana deve perguntar: nome + cidade combinados numa única pergunta natural  
Campos que extractQualificacaoData deve extrair: nenhum (turno de saudação)

---

**Turno 2 — Nome + cidade numa resposta**  
Lead diz: *"Meu nome é Carlos Mendes, sou de Vitória da Conquista"*  
Campos que `extractQualificacaoData` deve extrair: `nome = "Carlos Mendes"`, `cidade = "Vitória da Conquista"`  
Ana deve perguntar a seguir: apenas `plataforma_anuncio` (nome e cidade já coletados)

---

**Turno 3 — Dados do emprego em uma só mensagem**  
Lead diz: *"trabalhei 4 anos na Transportes ABC como motorista CLT, fui demitido em janeiro de 2025"*  
Campos que `extractQualificacaoData` deve extrair: `empresa = "Transportes ABC"`, `funcao = "motorista"`, `vinculo = "CLT"`, `tempo = "4 anos"`, `saida = "demitido"`, `data_saida ≈ "2025-01"`  
Ana deve perguntar a seguir: apenas os campos que faltam — `horas_extras`, `pagamento_fora`, `injustica`

> No modo conversacional, o `systemSuffix` correspondente seria o "Default" da lista (CAMPO OBRIGATÓRIO com campo `horas_extras`). O LLM tem liberdade para combinar num único turno.

---

**Turno 4 — Horas extras + fora do holerite combinados**  
Lead diz: *"Fazia horas extras sim mas nunca pagaram. Também recebia uns R$300 em dinheiro por entrega"*  
Campos extraídos: `horas_extras = "sim, não remuneradas"`, `pagamento_fora = "sim, R$300/entrega em dinheiro"`  
Ana deve perguntar a seguir: apenas `injustica`

---

**Turno 5 — Injustiça + mais empregos**  
Lead diz: *"Tinha muita pressão. Não, não trabalhei em outro lugar"*  
Campos extraídos: `injustica = "pressão"`, sinal `semMaisEmpregos`  
Ana encerra: `_vinculos_ok = true` → pós-vínculos

> **Total neste cenário: ~6-7 turnos** (vs. 13 no modo sequencial).

---

### Cenário B2 — Resposta parcial (risco principal do modo)

**Perfil:** Ana combina empresa + função + tipo de contrato numa pergunta. Lead responde só uma parte.

---

**Turno 3 — Ana faz pergunta combinada**  
Ana pergunta: *"Me conta — em qual empresa você trabalhava? Qual era sua função e tinha carteira assinada?"*  
*(gerado pelo Group 2 do router: `isEmpresaQ && startingNewCompany`)*

---

**Turno 4 — Lead responde parcialmente**  
Lead diz: *"Transportes ABC"*  
Campos extraídos por `extractQualificacaoData`: `empresa = "Transportes ABC"` (apenas)

**O que DEVE acontecer:**  
Ana repergunta função e tipo de vínculo, mas **NÃO repete a pergunta de empresa**.

**O que NÃO DEVE acontecer:**  
Ana não pode incluir empresa na repergunta — o campo já está coletado no `merged`.

**Qual campo indica que empresa já foi coletada:**  
`merged.empresa_recente` (campo flat sincronizado a partir de `vinculos[0].empresa`) — se não vazio, o router sabe que empresa está coletada e não a inclui na instrução de compound question.

> `startingNewCompany` requer `vinculos.length === 0 || merged._mais_empregos_confirmado === true` — após empresa ser seed-ada em `vinculos[0]`, `vinculos.length > 0` → `startingNewCompany = false` → router cai no Default, pedindo apenas o próximo campo faltante (funcao).

---

**Turno 5 — Lead completa**  
Lead diz: *"Era motorista, tinha carteira assinada"*  
Campos extraídos: `funcao = "motorista"`, `vinculo = "CLT"`  
Ana segue para `saida`.

---

### Cenário B3 — Comparação direta com Sequencial (mesmo lead do A1)

**Lead:** João Silva, Feira de Santana, CLT, 3 anos, demitido, sem emprego anterior.

| Fase | Sequencial (A1) | Conversacional (estimado) |
|------|-----------------|--------------------------|
| Saudação → nome + cidade | 2 turnos (saudação + nome/cidade) | 2 turnos (igual — saudação não combina com dados) |
| Plataforma anúncio | 1 turno | 1 turno (campo simples, não combina) |
| Empresa + Função + Vínculo | 3 turnos (1 por campo) | **1 turno** (Group 2: compound) |
| Saída + Data | 1 turno saída | **1 turno** (Group 3: saida + data combinados) |
| Tempo | 1 turno | 1 turno (campo simples) |
| Horas extras + Pagamento fora | 2 turnos | **1 turno** (Default permite combinar) |
| Injustiça | 1 turno | 1 turno |
| Mais empregos | 1 turno | 1 turno (Group 4: mandatory) |
| Pós-vínculos / interesse | 1 turno | 1 turno |
| **Total estimado** | **~13 turnos** | **~9-10 turnos** |

**Campos que o modo conversacional NÃO pode combinar:**

| Campo | Razão |
|-------|-------|
| Campos de vínculo anterior (`vinculos[1+]`) | Só aparecem depois que `_mais_empregos_confirmado = true` — depende de resposta de turno anterior |
| `mais_empregos` com qualquer outro campo | É uma pergunta de bifurcação — combinar com dados do próximo emprego seria prematuro |
| Saudação com dados pessoais | Primeiro turno é saudação pura; `_saudacao_enviada` ainda não está set quando `getGreetingStep` dispara |

---

## CHECKLIST DE VALIDAÇÃO

*Preencher durante o teste real no WhatsApp Business / Evolution API*

### Roteiro A — Modo Sequencial

| # | Cenário | Verificação | OK? | Obs. |
|---|---------|-------------|-----|------|
| A1.1 | A1 — Fluxo completo | Saudação com horário correto (bom dia / boa tarde / boa noite) | [ ] | |
| A1.2 | A1 — Fluxo completo | Todos os 8 CAMPOS_REQ preenchidos em `vinculos[0]` (verificar no DB: `qualificacao.vinculos`) | [ ] | |
| A1.3 | A1 — Fluxo completo | frota **não** perguntado para CLT | [ ] | |
| A1.4 | A1 — Fluxo completo | `_vinculos_ok = true` após resposta "não" ao mais_empregos | [ ] | |
| A1.5 | A1 — Fluxo completo | Transição para Daniela ocorreu (stage mudou no CRM) | [ ] | |
| A1.6 | A1 — Fluxo completo | Daniela entrou após ~45s (cronometrar após última mensagem da Ana) | [ ] | |
| A1.7 | A1 — Fluxo completo | Link PAKT gerado ao final do fluxo da Daniela | [ ] | |
| A2.1 | A2 — Emprego anterior | Quando tempo < 24m, `_vinculos_ok` NÃO setado antes de mais_empregos ser perguntado | [ ] | |
| A2.2 | A2 — Emprego anterior | `vinculos_anterior` coletado completo (8 campos) | [ ] | |
| A2.3 | A2 — Emprego anterior | Transição para Daniela ocorreu | [ ] | |
| A2.4 | A2 — Emprego anterior | Daniela entrou após ~45s | [ ] | |
| A3.1 | A3 — Autônomo | frota **foi** perguntado para autônomo/agregado | [ ] | |
| A3.2 | A3 — Autônomo | `_vinculos_ok = true` setado normalmente | [ ] | |
| A3.3 | A3 — Autônomo | Transição para Daniela ocorreu (autônomo não é disqualificado) | [ ] | |
| A3.4 | A3 — Autônomo | Daniela entrou após ~45s | [ ] | |
| A3.5 | A3 — Autônomo | Link PAKT gerado | [ ] | |

---

### Roteiro B — Modo Conversacional

> *Executar somente após ativar o modo conversacional em `stage-engine.ts`.*

| # | Cenário | Verificação | OK? | Obs. |
|---|---------|-------------|-----|------|
| B1.1 | B1 — Resposta completa | Quando lead diz empresa + função + vínculo + tempo numa mensagem, todos os campos extraídos | [ ] | |
| B1.2 | B1 — Resposta completa | Ana não repergunta campos já coletados | [ ] | |
| B1.3 | B1 — Resposta completa | Fluxo completou sem erro | [ ] | |
| B1.4 | B1 — Resposta completa | Transição para Daniela ocorreu | [ ] | |
| B1.5 | B1 — Resposta completa | Daniela entrou após ~45s | [ ] | |
| B1.6 | B1 — Resposta completa | Link PAKT gerado | [ ] | |
| B2.1 | B2 — Resposta parcial | Ana repergunta somente os campos faltantes (função + vínculo), não empresa | [ ] | |
| B2.2 | B2 — Resposta parcial | `merged.empresa_recente` preenchido após turno parcial | [ ] | |
| B2.3 | B2 — Resposta parcial | Fluxo completou sem loop de repergunta | [ ] | |
| B3.1 | B3 — Comparação | Total de turnos ≤ 11 (vs. 13 do sequencial) | [ ] | Anotar o número real: ___ |
| B3.2 | B3 — Comparação | Campos de emprego anterior coletados somente APÓS mais_empregos confirmado | [ ] | |

---

## Notas de teste

- **Como verificar os campos no DB:**
  ```sql
  SELECT id, "qualificacao" FROM "CrmDeal" WHERE id = '<deal_id>';
  ```
  O campo `qualificacao` é JSONB — contém `vinculos[]` e todos os campos flat.

- **Como verificar se stage mudou:**  
  No CRM (página `/crm`): checar se o card do lead está no stage correto após transição.

- **Delay da Daniela:**  
  Configurado em `IaRegraTransicao.delayMs` para a regra `qualificacao_completa`. Valor padrão referenciado pelo usuário: ~45.000ms (45s). Verificar valor real no DB:
  ```sql
  SELECT "delayMs", * FROM "IaRegraTransicao" WHERE condicao = 'qualificacao_completa';
  ```

- **Como identificar modo ativo:**  
  ```sql
  SELECT valor FROM "IaProjetoConfig"
  WHERE "projetoId" = '<projeto_id>' AND chave = 'modo_coleta';
  ```
  Sem linha = sequencial. `valor = 'conversacional'` = conversacional (requer integração no engine).
