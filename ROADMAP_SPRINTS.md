# Avoce Agent — Roadmap de Sprints

> **ATENÇÃO:** Sprints 1 e início do Sprint 2 (§2.1, §2.2) não foram incluídos nesta versão. Adicionar antes de implementar.
> Sprint 5 §5.1 ("Estrutura alvo:") está incompleto — conteúdo cortado.

---

## SPRINT 2 (continuação — §2.1 e §2.2 em falta)

### 2.3 Modificar `stage-engine.ts` — gatilho de valor antes do flow normal

**Após o bloco de frustração** no `processarMensagem`, adicione:

```typescript
// 3. Pergunta de valor — interrompe flow normal e responde com cálculo
if (
  persona.chave === "advogado"
  && isAskingValue(mensagemNormalizada)
  && temDadosMinimosCalculo(merged)
) {
  const calculo = calcularValorCausa(extractVinculosFromMerged(merged));
  const injecao = buildValueResponseInjection(calculo, faseAtualDaniela);

  // não avança flow, gera resposta com LLM e cálculo injetado
  const respostaLLM = await callLlm({
    systemPrompt: persona.systemPrompt + "\n\n" + injecao,
    history: history.slice(-10), // contexto recente apenas
    userMessage: mensagemTexto
  });

  await sendHumanizedSafe(deal, persona, respostaLLM, null);

  // marca flag de que o valor foi apresentado
  await atualizarMerged(deal.id, { _valor_apresentado: true, _valor_apresentado_em: new Date().toISOString() });

  return;
}
```

`temDadosMinimosCalculo(merged)` retorna true se há ao menos 1 vínculo com `empresa` E (`salario_total_declarado` OU `salario_holerite`). Se faltam dados mínimos, **não dispara o gatilho** — segue o flow normal (que vai coletar os dados, e o lead ainda terá oportunidade de perguntar de novo).

---

### 2.4 Reestruturar a Daniela em 3 fases hard-stopped

**Modifique a tabela `IaFlowStep`** adicionando um campo `subFase` (string, nullable):

```prisma
model IaFlowStep {
  // ... campos existentes
  subFase String? // "advogado_valor" | "advogado_dados" | "advogado_documentos"
}
```

Migração para os steps existentes da fase `advogado`:

| chave | subFase atual proposta |
|-------|------------------------|
| apresentacao | advogado_valor |
| parecer | advogado_valor |
| valor_estimado (NOVO) | advogado_valor |
| explicar_processo | advogado_valor |
| cpf | advogado_dados |
| nome_completo | advogado_dados |
| data_nascimento | advogado_dados |
| endereco | advogado_dados |
| estado_civil | advogado_dados |
| profissao | advogado_dados |
| solicitar_cnh (NOVO) | advogado_documentos |
| solicitar_comprovante_endereco (NOVO) | advogado_documentos |
| envio_contrato | advogado_documentos |
| aguardar_assinatura | advogado_documentos |
| confirmacao_final | advogado_documentos |

**Crie seed/migration script** que insere os 3 steps novos:
- `valor_estimado` (`stepType: llm_generated`): pergunta = instrução para apresentar cálculo + perguntar interesse
- `solicitar_cnh` (`stepType: question`): pergunta = "Para gerar a procuração, preciso de uma foto da frente da sua CNH. Pode me enviar?"
- `solicitar_comprovante_endereco` (`stepType: question`): pergunta = "Agora preciso de um comprovante de endereço recente (conta de luz, água ou internet dos últimos 3 meses)."

**Adicione validação em `handleAdvogadoFlow`:**

```typescript
function validarTransicaoFase(
  proximoStep: IaFlowStep,
  merged: any
): { permitido: boolean; redirecionarPara?: string } {
  // Não pode entrar em advogado_dados sem valor_apresentado
  if (proximoStep.subFase === "advogado_dados" && !merged._valor_apresentado) {
    return {
      permitido: false,
      redirecionarPara: "valor_estimado"
    };
  }

  // Não pode entrar em advogado_documentos sem dados pessoais completos
  if (proximoStep.subFase === "advogado_documentos") {
    const camposObrigatorios = ["cpf", "nome_completo", "data_nascimento", "endereco"];
    const faltando = camposObrigatorios.filter(c => !merged[c]);
    if (faltando.length > 0) {
      const stepFaltando = camposObrigatorios.find(c => !merged[c]);
      return { permitido: false, redirecionarPara: stepFaltando };
    }
  }

  return { permitido: true };
}
```

**Critérios de aceite Sprint 2:**

a) Testes unitários da calculadora cobrem 10+ cenários, todos com snapshots de output em pt-BR

b) Teste de integração: lead pergunta "quanto vou receber" após dar dados mínimos → recebe resposta com números reais, não com instrução de prompt, não com pergunta-desvio

c) Teste de integração: tentativa de pular do step `parecer` direto para `cpf` (sem `_valor_apresentado`) → sistema redireciona para `valor_estimado`

d) Replay completo do chat do Pedro: na 1ª pergunta de valor, sistema dispara cálculo. Não há 2ª nem 3ª repetição.

---

## SPRINT 3 — Memória Compartilhada e Pre-Skip Universal

**Objetivo:** Eliminar reperguntas de qualquer dado já coletado.

### 3.1 Pre-skip universal no flow controller

Modifique `flow-controller.ts` — função `getNextDeterministicQuestion`:

```typescript
function getNextDeterministicQuestion(deal, persona, merged): IaFlowStep | null {
  const orderedSteps = orderStepsForDealAndPersona(deal, persona);
  const respondidos = new Set(deal.iaStepsRespondidos || []);

  for (const step of orderedSteps) {
    // Já respondido nesta sessão → pula
    if (respondidos.has(step.chave)) continue;

    // PRE-SKIP UNIVERSAL: campo já coletado em merged
    if (step.campoColetar && isFieldAlreadyCollected(merged, step.campoColetar)) {
      await marcarStepRespondidoSemPerguntar(deal.id, step.chave);
      respondidos.add(step.chave);
      continue;
    }

    return step;
  }

  return null;
}

function isFieldAlreadyCollected(merged: any, campo: string): boolean {
  const value = merged[campo];
  if (value == null) return false;
  if (typeof value === "string" && value.trim().length === 0) return false;
  if (Array.isArray(value) && value.length === 0) return false;
  if (campo === "cpf") return /^\d{11}$/.test(value.replace(/\D/g, ""));
  if (campo === "data_nascimento") return /^\d{4}-\d{2}-\d{2}$/.test(value) || /\d{2}\/\d{2}\/\d{4}/.test(value);
  return true;
}
```

### 3.2 `extractQualificacaoData` estendido para fase advogado

Hoje a extração só roda na Ana. Modifique para rodar **também** na Daniela, com hints semânticos específicos:

```typescript
const HINTS_ADVOGADO = {
  cpf: "CPF do cliente, 11 dígitos numéricos. Formato esperado: XXX.XXX.XXX-XX ou apenas dígitos.",
  nome_completo: "Nome completo do cliente conforme documento (RG, CNH). Não confundir com primeiro nome ou apelido.",
  data_nascimento: "Data de nascimento do cliente. Aceitar formato DD/MM/AAAA, DD-MM-AAAA, ou por extenso.",
  endereco: "Endereço residencial completo: rua, número, bairro, cidade, estado, CEP.",
  estado_civil: "Estado civil: solteiro, casado, divorciado, viúvo, união estável.",
  profissao: "Profissão registrada na carteira de trabalho. Pode ser igual à função declarada nos vínculos."
};
```

```typescript
const hintsAtivos = persona.chave === "advogado"
  ? { ...HINTS_GLOBAIS_ANA, ...HINTS_ADVOGADO }
  : HINTS_GLOBAIS_ANA;

const camposPendentes = Object.entries(hintsAtivos)
  .filter(([campo]) => !isFieldAlreadyCollected(merged, campo))
  .reduce((acc, [k, v]) => ({ ...acc, [k]: v }), {});

if (Object.keys(camposPendentes).length === 0) return; // economiza LLM
```

### 3.3 `extractQualificacaoData` lazy

```typescript
function shouldExtractFromMessage(
  message: string,
  camposPendentes: Record<string, string>
): boolean {
  if (Object.keys(camposPendentes).length === 0) return false;

  const acks = /^(ok|sim|nao|não|certo|beleza|tá|ta|aham|claro|isso|combinado|pode|opa|oi)\.?$/i;
  if (acks.test(message.trim())) return false;

  const charsUteis = message.replace(/\s/g, "").length;
  if (charsUteis < 3) return false;

  return true;
}
```

### 3.4 Handoff Ana → Daniela com snapshot

Quando `qualificacao_completa` dispara troca de persona para `advogado`, gere um snapshot estruturado prependado ao `systemPrompt` da Daniela em **toda chamada LLM**:

```typescript
function buildHandoffSnapshot(merged: any): string {
  const fatos: string[] = [];

  if (merged.nome) fatos.push(`Nome: ${merged.nome}`);
  if (merged.cidade) fatos.push(`Cidade: ${merged.cidade}`);
  if (merged.cpf) fatos.push(`CPF: ${formatCpf(merged.cpf)}`);

  if (merged.vinculos?.length > 0) {
    fatos.push("\nVínculos trabalhistas relatados:");
    merged.vinculos.forEach((v: any, i: number) => {
      const linhas = [
        `  ${i + 1}. Empresa: ${v.empresa || "?"}`,
        `     Função: ${v.funcao || "?"}`,
        `     Vínculo: ${v.vinculo || "?"}`,
        `     Período: ${v.tempo || (v.data_admissao + " a " + v.data_saida)}`,
        `     Saída: ${v.saida || v.modalidade_saida || "?"}`,
        v.salario_total_declarado ? `     Salário declarado: R$ ${v.salario_total_declarado}` : null,
        v.horas_extras !== undefined ? `     Horas extras: ${v.horas_extras ? "trabalhava além" : "dentro do normal"}` : null,
        v.pagamento_fora ? `     Pagamento por fora: SIM` : null,
        v.injustica ? `     Irregularidade relatada: ${v.injustica}` : null
      ].filter(Boolean);
      fatos.push(linhas.join("\n"));
    });
  }

  return [
    "=== DADOS JÁ COLETADOS PELA ANA (NÃO REPERGUNTAR) ===",
    fatos.join("\n"),
    "=== FIM DOS DADOS COLETADOS ===",
    "Você é a Dra. Daniela. Esses dados já foram coletados — confirme-os naturalmente quando útil, mas NÃO faça perguntas que já têm resposta acima."
  ].join("\n");
}
```

**Critérios de aceite Sprint 3:**

a) Teste: deal com `merged.cpf = "12345678900"` chega ao step `cpf` da Daniela → sistema pula automaticamente

b) Teste: lead diz CPF dentro de uma mensagem da Daniela → próxima resposta não repergunta CPF

c) Teste: handoff Ana → Daniela com 4 vínculos coletados → primeira chamada LLM da Daniela tem snapshot completo

d) Teste de regressão: replay do chat do Pedro com Sprints 1+2+3 → não há reperguntas de nome ou CPF

---

## SPRINT 4 — Health Checks e Recuperação Automática

**Objetivo:** Tornar visível e auto-curativo o problema do handoff travado.

### 4.1 Cron de 5 minutos para handoffs travados

Em `cron-agent.ts`:

```typescript
async function processarHandoffsAtrasados() {
  const deals = await prisma.crmDeal.findMany({
    where: {
      iaPersonaChave: "advogado",
      iaAtiva: true,
      iaStageChave: "lead_qualificado"
    },
    include: {
      mensagensWhatsapp: {
        orderBy: { criadoEm: "desc" },
        take: 1
      }
    }
  });

  for (const deal of deals) {
    const ultimaMsg = deal.mensagensWhatsapp[0];
    if (!ultimaMsg) continue;

    const minutosDesdeUltima = (Date.now() - ultimaMsg.criadoEm.getTime()) / 60000;
    const personaTrocadaSemIntro =
      ultimaMsg.direcao === "out"
      && ultimaMsg.personaChave === "assistente"
      && minutosDesdeUltima >= 10;

    if (personaTrocadaSemIntro) {
      try {
        await tentarEnviarIntroDaniela(deal);
      } catch (err) {
        console.error("Falha ao recuperar intro Daniela:", err);
      }
    }

    if (personaTrocadaSemIntro && minutosDesdeUltima >= 60) {
      await notificarOperacao({
        tipo: "handoff_critico_atrasado",
        dealId: deal.id,
        minutosTravado: Math.floor(minutosDesdeUltima)
      });
    }
  }
}
```

Schedule: a cada 5 minutos via node-cron.

### 4.2 Endpoint de health check

`GET /api/agent/health` (autenticado, só admin):

```json
{
  "timestamp": "ISO",
  "llm_health": {
    "last_24h_calls": 0,
    "last_24h_errors": 0,
    "error_rate": 0,
    "providers_status": [{ "provider": "anthropic", "status": "ok" }]
  },
  "cron_health": {
    "last_run_processarTimeoutsAgente": "ISO",
    "last_run_recuperarMensagensPerdidas": "ISO",
    "last_run_processarHandoffsAtrasados": "ISO",
    "any_overdue": false
  },
  "deals_anomalos": {
    "handoff_atrasado_30min": 0,
    "cliente_sem_resposta_5min": 0,
    "bloqueados_intervencao_humana": 0,
    "em_loop_repeticao": 0
  },
  "prompt_leaks_24h": 0,
  "identity_questions_24h": 0
}
```

### 4.3 Painel administrativo

`GET /admin/agent-dashboard` — HTML com:
- Cards dos números do health check
- Lista de deals em estado anômalo (com link para conversa)
- Últimas 10 entradas de `IaInteracaoLog` com `tipo: prompt_leak_blocked`

Usar framework já existente no projeto (Fastify + React via tRPC). Não introduzir dependências novas.

**Critérios de aceite Sprint 4:**

a) Cron `processarHandoffsAtrasados` roda a cada 5 min, comprovado em log

b) Deal artificialmente travado (SQL: `iaPersonaChave: 'advogado'`, última msg é da Ana, criadoEm = 30 min atrás) → próximo cron envia intro da Daniela automaticamente

c) `/api/agent/health` retorna 200 com schema correto em < 500ms

d) `/admin/agent-dashboard` mostra os números corretamente

---

## SPRINT 5 — Refatoração Estrutural (Dívida Técnica)

> **Pré-requisito:** Sprints 1–4 em produção e estáveis por pelo menos 1 semana.

**Objetivo:** Atacar os 9 problemas estruturais listados em `AGENT_ARCHITECTURE.md`.

### 5.1 Quebrar `stage-engine.ts` em módulos

**Estrutura alvo:** *(conteúdo incompleto — completar antes de implementar)*

```
server/src/agent/
├── stage-engine.ts          # entry point apenas (orquestra os módulos abaixo)
├── message-handler.ts       # recepção, dedup, mídia, debounce
├── qualification.ts         # extractQualificacaoData, syncFlat, vinculos loop
├── persona-router.ts        # seleção de persona, build system prompt, handoff snapshot
├── transition-engine.ts     # checkTransitions, transitionDeal, allAnswered
├── flow-controller.ts       # (existente, manter)
├── llm.ts                   # (existente, manter)
└── ...
```

> **TODO:** Adicionar §5.2 em diante (conteúdo não fornecido).
