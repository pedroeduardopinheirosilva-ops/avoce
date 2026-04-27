# Avoce — Arquitetura do Agente IA WhatsApp

## Visão Geral

O agente IA do Avoce é um SDR conversacional via WhatsApp voltado para captação de motoristas carreteiros (PSA). Recebe mensagens pela **Evolution API**, processa com LLMs via roteador multi-provider, segue um funil de qualificação data-driven e orquestra a transição entre personas (Ana → Dra. Daniela → Closer).

---

## Stack Técnica

| Camada | Tecnologia |
|--------|-----------|
| Backend | Node.js + Fastify + tRPC + Prisma ORM |
| Banco | PostgreSQL (`avoce` DB — Hetzner) |
| WhatsApp | Evolution API (instância `avoce`) |
| LLM | Multi-provider: Anthropic Claude / Groq / OpenAI / Gemini |
| Áudio in | Groq Whisper (transcrição) |
| Áudio out | ElevenLabs TTS (voz Dra. Daniela) |
| OCR | Mistral OCR → Groq Vision → Tesseract (fallback) |
| Deploy | PM2 cluster, Hetzner 188.40.110.170, porta 8470 |

---

## Arquivos do Agente

```
server/src/agent/
├── stage-engine.ts      # Orquestrador principal (3.700 linhas) — processa cada mensagem recebida
├── flow-controller.ts   # Sequenciador determinístico de perguntas para Ana e Daniela
├── cron-agent.ts        # Jobs de 15min: timeouts de stage e recuperação de mensagens perdidas
├── llm.ts               # Roteador multi-provider (Anthropic, OpenAI, Groq, Gemini)
├── humanizer.ts         # Rejeita respostas com padrões robóticos antes de enviar
├── cnh-extractor.ts     # OCR especializado para CNH (nome, CPF, RG)
├── whisper.ts           # Transcrição de áudio via Groq Whisper
└── elevenlabs.ts        # TTS via ElevenLabs
```

---

## Banco de Dados — Tabelas do Agente

| Tabela | Papel |
|--------|-------|
| `IaProjeto` | Projeto de automação (1 por cliente/caso de uso) |
| `IaProjetoConfig` | Config chave-valor por projeto (LLM, comportamento, templates) |
| `IaPersona` | Persona da IA (`assistente`=Ana, `advogado`=Daniela, `closer`) |
| `IaFaseFunil` | Fases do funil mapeadas aos stages do CRM Kanban |
| `IaFlowStep` | Passos sequenciais do flow (pré-vínculos, pós-vínculos, advogado) |
| `IaFlowStepGate` | Condições de desvio dentro de um step (gate/discard/goto) |
| `IaPerguntaQualificacao` | Campos de qualificação com tipo, obrigatoriedade e contexto semântico |
| `IaVinculoFlowPasso` | Perguntas do loop de vínculos trabalhistas |
| `IaMensagemTemplate` | Templates de mensagens proativas (cron, closers) |
| `IaRegraTransicao` | Regras de transição entre stages (condicao → destino + acaoAdicional) |
| `IaLlmProvedor` | Provedores LLM por projeto, com ordem de prioridade e fallback |
| `IaInteracaoLog` | Log de cada chamada LLM (tokens, latência, erro) |
| `CrmDeal` | Deal do lead — guarda `iaStageChave`, `iaPersonaChave`, `qualificacao` (JSONB) |
| `CrmMensagemWhatsapp` | Histórico de mensagens (direcao: in/out, personaChave, conteudo) |

---

## Funil de Stages

```
lead_carreteiro
    │  (qualificacao_completa)
    ▼
lead_qualificado ──── acaoAdicional: trocar_persona:advogado
    │                  → setTimeout 5min → enviarMensagemProativa("primeira_mensagem")
    │  (sem_resposta 48h)
    ▼
lead_indeciso
    │  (sem_resposta 72h)
    ▼
com_closer ──── acaoAdicional: trocar_persona:closer
    │           → mensagem Closer #1 imediata
    │  (2 tentativas sem resposta)
    ▼
sem_resposta_closer

lead_sem_resposta ──── (cliente_respondeu → lead_carreteiro)

aguardando_docs_pessoais
    │  (docs_confirmados)
    ▼
aguardando_assinatura ──── acaoAdicional: gerar_proposta_automatica
    │  (contrato_assinado)
    ▼
aguardando_reuniao ──── acaoAdicional: criar_deal_processual
```

---

## Personas

| Chave | Nome Exibição | Papel | Ativa no Stage |
|-------|--------------|-------|----------------|
| `assistente` | Ana | SDR — qualifica vínculos trabalhistas | `lead_carreteiro` |
| `advogado` | Dra. Daniela Pires | Advogada — parecer jurídico, coleta pessoal, fechamento | `lead_qualificado` em diante |
| `closer` | Dra. Daniela Pires | Reengajamento — máx 2 tentativas com urgência de prazo | `com_closer` |

Cada persona tem:
- `systemPrompt` (campo no DB) — instrução base injetada em toda chamada LLM
- `nomeExibicao` — aparece no cabeçalho da mensagem WA (`*Ana*\n...`)
- `llmProviderChave` — provider LLM preferencial (optional, fallback à ordem global)

---

## Fluxo de Processamento de Mensagem

```
[Evolution API webhook] POST /api/whatsapp/webhook
         │
         ▼
1. Deduplicação (messageId já visto? → ignorar)
2. Tipo de mídia?
   ├── Áudio    → Groq Whisper → texto
   ├── Imagem   → Mistral OCR → texto estruturado
   ├── Doc PDF  → Mistral OCR → texto estruturado
   └── Texto    → usa direto
3. Find-or-create CrmContato + CrmDeal
4. Salva CrmMensagemWhatsapp (direcao: "in")
5. iaAtiva? → não → ignorar
   stage em STAGES_HUMANOS? → não → ignorar
6. DEBOUNCE 4s (coalesce mensagens rápidas do mesmo deal)
         │
         ▼
processarMensagem(...)
         │
         ▼
7. Carrega persona, history (últimas 20 msgs), qualificacao merged
8. extractQualificacaoData → extrai campos do histórico via LLM
   └── Campos com `perguntaContexto` como hint semântico
   └── Salva novos valores em merged + CrmDeal.qualificacao
9. [Ana] Loop de vínculos:
   ├── tryExtractVinculo → extrai empresa/função/vínculo/saída/horas/pagamento/injustiça
   ├── Detecta mais empregos anteriores dentro de 2 anos
   └── Quando loop completo → _vinculos_ok = true
10. Sync vinculos[] → campos flat (*_recente, emprego_anterior_*)
11. Calcula nextQDeterministico (ANTES de allAnswered)
    ├── [assistente] getNextDeterministicQuestion:
    │   ├── Fase 1 — pre_vinculos: perguntas DB por campoColetar em merged
    │   ├── Fase 2 — vinculos loop: getNextVinculoQuestion
    │   └── Fase 3 — pos_vinculos / pos_vinculos_curto: perguntas DB
    └── [advogado] handleAdvogadoFlow:
        ├── step atual → valida resposta do cliente via LLM (extractJson)
        └── avança para próximo step → retorna pergunta + stepType
12. allAnswered?
    ├── flowCompletedByController (nextQDeterministico === null para assistente)
    └── basicAnswered (todos obrigatorios preenchidos) && _vinculos_ok
    → SE SIM: transitionDeal("qualificacao_completa") → persona: advogado → return
13. Build system prompt (persona.systemPrompt + instruções situacionais)
    ├── [llm_generated] ⚠️ TAREFA OBRIGATÓRIA injeta a instrução sobre o step
    └── [outros]       INFORMAÇÃO A COLETAR AGORA: <pergunta>
14. Chamada LLM (callLlm — multi-provider com fallback)
15. isHumanized? → se não → retry até 3x
16. Deterministic override:
    ├── stepType !== "llm_generated" AND nextQDeterministico → substitui resposta pelo passo determinístico
    └── "llm_generated" → mantém resposta do LLM
17. Avalia transições (checkTransitions: keywords no texto)
18. limparResposta (remove prefixo nome, emojis)
19. sendHumanized: delay read + typing indicator + sendText
20. [Daniela] TTS via ElevenLabs para momentos configurados
21. Salva CrmMensagemWhatsapp (direcao: "out")
22. Atualiza CrmDeal.ultimoContatoEm
```

---

## IaFlowStep — Tipos de Passo

| stepType | Comportamento |
|----------|--------------|
| `saudacao` | Enviado apenas na primeira troca (greeter). Não requer validação. |
| `question` | Pergunta direta. Texto do campo `pergunta` enviado verbatim. |
| `gate` | Pergunta com ramificações (`IaFlowStepGate`). LLM valida resposta e escolhe gate. |
| `llm_generated` | Campo `pergunta` é instrução para o LLM, não texto verbatim. O LLM elabora a resposta. Nunca enviado literalmente. |
| `document` | Envia documento/proposta/link. Não requer resposta do cliente para avançar. |
| `end` | Mensagem final do fluxo. Marca deal como `iaFlowStepChave = "__done__"`. |

### IaFlowStepGate — Ações Disponíveis

| actionType | Efeito |
|------------|--------|
| `continue` | Avança para o próximo step normalmente |
| `end` | Encerra o fluxo (`__done__`) com mensagem opcional |
| `discard` | Descarta o lead (`__discarded__`) — cliente sem direito ou interesse |
| `repeat` | Repete o step atual (resposta inválida) |
| `goto_step` | Salta para um step específico por `chave` |
| `notify` | Avança + dispara notificação (SDR, webhook) |

---

## Flow da Ana (assistente)

### Fases em ordem

```
pre_vinculos (IaFlowStep: fase="pre_vinculos")
    └── Steps com campoColetar → nome, cidade, funcao, vinculo, empresa...
    └── Tipo saudacao → primeira mensagem
    └── Quando todos respondidos → cai para vinculos loop

vinculos loop (IaVinculoFlowPasso)
    └── Perguntas para cada vínculo: empresa → função → vínculo → saída → horas_extras → pagamento_fora → injustiça → frota → mais_empregos
    └── Encadeamento automático: se "tem mais empregos?" = sim → novo vínculo
    └── Apenas vínculos dentro de 2 anos (prescrição trabalhista)
    └── _vinculos_ok = true quando completo

pos_vinculos (IaFlowStep: fase="pos_vinculos" ou "pos_vinculos_curto")
    └── pos_vinculos: para vínculos com >18 meses (Ag2)
    └── pos_vinculos_curto: para vínculos com ≤18 meses (Ag3) — inclui coleta do emprego anterior
    └── Steps: horas_extras → pagamento_fora → relato → interesse
    └── Quando interesse confirmado → allAnswered → transição qualificacao_completa
```

### Deterministic Override (Ana e Daniela)

Quando `nextQDeterministico != null` e `stepType != "llm_generated"`, a resposta do LLM é **substituída** pelo passo determinístico. O LLM é chamado apenas para gerar contexto (system prompt) mas o texto enviado ao cliente é o do flow.

Exceções ao override:
- `isDisqualification` — mensagens de encerramento/conflito ético não são substituídas
- `clienteIsLegal` — cliente perguntou sobre valores/direitos → LLM responde + appenda o passo
- `clienteAsksMeta` — cliente perguntou data/hora/quem é você → LLM responde + appenda o passo

---

## Flow da Daniela (advogado)

### Sequência padrão (IaFlowStep: fase="advogado")

```
1. apresentacao  [question]      — "Oi! Sou a Dra. Daniela... A Ana me passou seu caso..."
2. parecer       [llm_generated] — LLM gera parecer jurídico personalizado com dados do lead
3. explicar_processo [gate]      — Explica honorários (30% do sucesso). Gate: interesse confirmado?
4. cpf           [question]      — "Qual é o seu CPF?"
5. nome_completo [question]      — "Pode me informar seu nome completo?"
6. data_nascimento [question]    — "E sua data de nascimento?"
7. endereco      [question]      — "Me informa seu endereço completo com CEP"
8. estado_civil  [question]      — "Qual é o seu estado civil?"
9. profissao     [question]      — "E sua profissão na carteira de trabalho?"
10. envio_contrato [document]    — Dispara geração automática de proposta + contrato
11. aguardar_assinatura [gate]   — Instruções para assinar digitalmente (PAKT)
12. confirmacao_final [end]      — Encerra fluxo, notifica SDR, agenda reunião
```

### Primeiro contato proativo (cron → enviarMensagemProativa)

Quando a qualificação completa, `transitionDeal` agenda um `setTimeout(5min)` para enviar `primeira_mensagem`. O cron recupera o caso se o setTimeout morrer por restart.

**Comportamento atual:** usa diretamente o texto do step 1 (`apresentacao`) da DB e marca `iaFlowStepChave = "apresentacao"` no deal, para que a primeira resposta do cliente inicie no step 2 (`parecer`).

### Validação de respostas (LLM leve)

Para cada step que não é `document` ou `end`, `handleAdvogadoFlow` chama `extractJson` com:
- Pergunta que foi feita
- Resposta do cliente
- Gates disponíveis (se houver)

Retorna `{ answered: boolean, gate_id, extracted }`. Se `answered = false`, repete o step atual (sem avançar), preservando o `stepType`.

---

## extractQualificacaoData — Extração de Campos

Chamado a cada mensagem recebida pela Ana. Passa o histórico das últimas 16 trocas e os campos pendentes como hints semânticos.

```typescript
// Instrução enviada ao LLM:
"campo" /* perguntaContexto */: "valor ou null"
```

Exemplo para o campo `e_clt`:
```
"e_clt" /* Se o lead tem ou tinha vínculo CLT (carteira assinada) — true/false */:  true/false/null
```

Apenas campos ainda não preenchidos (`merged[chave] === undefined`) são incluídos na instrução. Isso evita sobreescrever dados já capturados.

---

## Cron Agent (15 minutos)

### processarTimeoutsAgente

| Stage | Condição | Ação |
|-------|----------|------|
| `lead_carreteiro` | 24h sem resposta | → `lead_sem_resposta` |
| `lead_qualificado` | 48h sem resposta | → `lead_indeciso` |
| `lead_indeciso` | 72h sem resposta | → `com_closer` + mensagem Closer #1 |
| `com_closer` | ≥2 tentativas | → `sem_resposta_closer` |
| `com_closer` | 48h sem resposta | → envia próxima tentativa closer |

### recuperarMensagensPerdidas

Detecta deals onde:
- Última mensagem é `in` (cliente) com mais de 3 min e menos de 4h
- → Re-dispara `respondFromDealState` (recupera resposta perdida em restart do PM2)

### Intro pendente da Daniela

Detecta deals onde:
- `iaPersonaChave = "advogado"` (ou `"closer"`)
- Última mensagem `out` ainda é da `assistente` (Ana)
- Passou mais de 5 min
- **Sem limite superior de tempo** — Daniela nunca foi apresentada, envia sempre

---

## LLM Router (multi-provider)

```
IaLlmProvedor (DB) → ordered by `ordem`
     │
     ▼
Para cada provider:
  ├── Tenta callProvider (Anthropic / OpenAI / Groq / Gemini)
  ├── Erro quota/rate/503 → retry com backoff exponencial (2s, 4s) até 2x
  ├── Se persistir → tenta próximo provider
  └── Se todos falharem → throw + scheduleLlmRetry (60s→120s→240s→480s)
```

Fallback legado: se não há `IaLlmProvedor` → usa `anthropic_api_key` de `IaProjetoConfig`.

---

## Problemas Conhecidos / Bugs Históricos

| Bug | Causa | Status |
|-----|-------|--------|
| Daniela nunca envia intro | setTimeout morria no restart; cron tinha cap de 4h | Corrigido — sem cap de tempo |
| `empresa_principal` nunca preenchida | Extração capturava `empresa_recente`, flow verificava `empresa_principal` | Corrigido — syncMap após extração |
| `e_clt` repetia após "trabalhava CLT" | LLM não mapeava resposta sem contexto semântico do campo | Corrigido — `perguntaContexto` nos hints |
| allAnswered nunca true para `pos_vinculos` longo | Flow sem `melhor_hora_contato`, mas DB marcava como obrigatório | Corrigido — flow controller é autoritativo para allAnswered |
| Instrução `llm_generated` enviada verbatim | `handleAdvogadoFlow` retornava early sem `stepType` → override disparava | Corrigido — early returns preservam `stepType` |
| Ana prometia "verificar Daniela" em loop | Frustration exception muito ampla; nextQDeterministico = null → LLM freewheel | Corrigido — frustration exception restrita + override autoritativo |
| Double intro da Daniela | `enviarMensagemProativa` gerava LLM + flow enviava step 1 separado | Corrigido — `enviarMensagemProativa` usa step 1 da DB e marca `iaFlowStepChave` |
| CNH confirmava campos errados | OCR extrai tudo; LLM confirmava nº registro/categoria em vez de nome/CPF/RG | Corrigido — instrução explícita no system prompt de documentos |

---

## Problemas Estruturais Atuais (para reestruturação)

### 1. stage-engine.ts é um monólito de 3.700 linhas
Toda a orquestração vive em um arquivo. Difícil de manter, testar e estender.

### 2. Duas fontes de verdade para "qualificação completa"
`basicAnswered` (verificação por DB fields) e `flowCompletedByController` (flow controller) podem divergir. Atualmente resolvido com OR, mas é frágil — a fonte autoritativa deveria ser apenas o flow controller.

### 3. extractQualificacaoData rodando em toda mensagem
Chamada LLM extra em cada mensagem recebida, mesmo quando o campo já está capturado. Caro e lento.

### 4. merged (JSONB) mistura campos de qualificação com flags internas
`_vinculos_ok`, `_saudacao_enviada`, `_pos_vinculos_fase`, `_mais_empregos_confirmado` convivem com `nome`, `cidade`, `e_clt` no mesmo objeto. Sem schema.

### 5. System prompt construído proceduralmente
Dezenas de `userSystem +=` condicionais ao longo de 300+ linhas. Sem template engine, sem separação de responsabilidades.

### 6. pos_vinculos vs pos_vinculos_curto: divergência
`pos_vinculos_curto` tem `melhor_hora_contato`, `pos_vinculos` não. Campo obrigatório no DB mas não coletado no flow longo.

### 7. Transições de stage acopladas ao processamento de mensagem
`transitionDeal`, `checkTransitions`, `allAnswered` estão misturados no mesmo `processarMensagem`. Uma transição acidental pode deixar o deal em estado inconsistente.

### 8. Primeiro contato de Daniela: setTimeout vs cron vs flow
Três mecanismos diferentes podem disparar a intro da Daniela: `setTimeout(5min)` no `transitionDeal`, o cron de 15min, e o webhook ao receber mensagem do cliente. Sem idempotência garantida.

### 9. Histórico de 20 mensagens fixo
O contexto enviado ao LLM é sempre as últimas 20 mensagens, independente da fase. Para Daniela coletando documentos, as mensagens de qualificação da Ana são ruído.

---

## Estrutura de Dados: CrmDeal.qualificacao (JSONB)

```json
{
  // Campos de identidade
  "nome": "Pedro",
  "cidade": "São Paulo",
  "melhor_hora_contato": "manhã",

  // Campos de qualificação trabalhista
  "e_carreteiro": true,
  "e_clt": true,
  "interesse": "sim",
  "acao_em_andamento": false,

  // Vínculos (array estruturado)
  "vinculos": [
    {
      "ordem": 1,
      "empresa": "Transportes XYZ",
      "funcao": "motorista carreteiro",
      "vinculo": "CLT",
      "tempo": "2 anos",
      "saida": "demitido sem justa causa",
      "data_saida": "01/03/2024",
      "horas_extras": true,
      "pagamento_fora": false,
      "injustica": "desconto indevido no holerite"
    }
  ],

  // Campos flat espelhados dos vínculos (para relatórios)
  "empresa_recente": "Transportes XYZ",
  "funcao_recente": "motorista carreteiro",
  "tempo_recente": "2 anos",
  "horas_extras_recentes": true,

  // Flags internas do fluxo (não são dados do lead)
  "_vinculos_ok": true,
  "_saudacao_enviada": true,
  "_pos_vinculos_fase": "pos_vinculos",
  "_mais_empregos_confirmado": true,
  "_vinculos_todos_prescritos": false
}
```

---

## Configurações por Projeto (IaProjetoConfig)

| categoria | chave | Descrição |
|-----------|-------|-----------|
| `llm` | `anthropic_api_key` | Legado — usado se não há IaLlmProvedor |
| `llm` | `llm_model_principal` | Modelo Anthropic legado |
| `comportamento` | `resposta_delay_min` | Delay mínimo de "leitura" antes de responder (ms) |
| `comportamento` | `resposta_delay_max` | Delay máximo de "leitura" |
| `comportamento` | `solicita_ligacao_palavras` | Frases que ativam notificação de pedido de ligação |
| `comportamento` | `empresas_bloqueadas` | Empresas onde não atuamos (pula vínculo no loop) |

---

## Pontos de Extensão para Reestruturação

1. **Separar stage-engine em módulos**: `message-handler.ts`, `qualification.ts`, `persona-router.ts`, `transition-engine.ts`
2. **Flow controller como fonte única de verdade**: eliminar `basicAnswered`; `allAnswered = flowController.isDone()`
3. **Template engine para system prompts**: YAML/JSON por persona+stage, renderizado por engine, testável isolado
4. **extractQualificacaoData lazy**: só chamar quando última mensagem do cliente contém dado novo (length > threshold ou não é ack)
5. **Separar flags internas do merged**: `_flags` separadas do JSONB de qualificação real
6. **Idempotência no primeiro contato de Daniela**: antes de enviar, verificar se já existe msg `out` de `advogado`
7. **Histórico contextual por fase**: para Daniela, enviar apenas msgs desde a transição de persona (não toda a conversa da Ana)
