# PLANO MESTRE — SDR Avoce v2 (Carreteiros / RAP Advogados)
*Gerado em 11/06/2026 — auditoria completa de código (15k linhas), banco, prompts (110KB) e caso real (Nelson).*

---

## 1. MASTER PROMPT — A Estrela-Norte do SDR

> **Missão**: Converter cada carreteiro lesado que chega no WhatsApp em uma reunião REALIZADA com a
> advogada, entregando ao SDR humano um briefing completo no momento exato em que uma ligação fecha o negócio.
>
> **O sistema é uma dupla**: a IA qualifica, agenda, lembra e detecta risco; o SDR HUMANO liga para
> fechar reuniões, derrubar objeções por voz e garantir comparecimento. Tudo que a IA coleta existe
> para servir a essa ligação: telefone, melhor horário, dor principal, valor estimado da causa,
> urgência prescricional e temperatura do lead.
>
> **Regras de ouro**:
> 1. NUNCA desqualificar um lead sem ter PERGUNTADO explicitamente sobre vínculos anteriores (custo de
>    um falso descarte = uma causa inteira; custo de uma pergunta a mais = 10 segundos).
> 2. Dados extraídos por inferência NUNCA disparam gates — só dados respondidos a perguntas feitas.
> 3. Cada lead qualificado gera um BRIEFING acionável para o humano em < 5 segundos de leitura.
> 4. Reunião marcada sem lembrete + confirmação = no-show; o sistema lembra, confirma e detecta falta.
> 5. Em caso de dúvida sobre prescrição/validade, o lead AVANÇA (revisão humana descarta; o robô não).

## 2. O QUE O CASO NELSON REVELOU (bugs confirmados em produção)

| # | Bug | Causa raiz | Severidade |
|---|-----|-----------|------------|
| N1 | Desqualificado sem investigar empregos anteriores | `tem_emprego_anterior:false` ALUCINADO pela extração (nunca perguntado) conta como "negou" em `assistente-agents.ts:121` e `persona-router.ts:289,327` | CRÍTICO |
| N2 | Repetiu "Agora me conta do seu emprego mais recente!" após a história completa | Router escolhe sempre o 1º step de `empresa` (texto-história, ordem 1) em vez do step direto `nome_empresa_rec` (ordem 10) quando só falta o nome | ALTO |
| N3 | `data_saida: 12/2026` para "saí em fevereiro de 2026" | `deriveDataSaida` não entende nome de mês PT-BR; cai no fallback `12/ANO` | ALTO |
| N4 | `tempo: "4 meses"` extraído de "saí... já tem quatro meses" | Prompt de extração não diferencia tempo DESDE A SAÍDA de tempo DE SERVIÇO | ALTO |

## 3. BUGS VERIFICADOS NA AUDITORIA (além do Nelson)

| # | Bug | Local | Fix |
|---|-----|-------|-----|
| B1 | `runProativoNextStep` roda sem lock por deal → race com webhook → mensagens duplicadas | stage-engine.ts:1605 | Adquirir o mesmo mutex `_dealProcessingSet` |
| B2 | Dois waiters do lock podem sair do loop juntos e processar em paralelo | stage-engine.ts:409-426 | Re-checar e voltar ao loop após o reload |
| B3 | Regex de saída não cobre "despedido/larguei/pedi as contas" | qualification.ts:327 | Ampliar regex |
| B4 | Falsos descartes não revisáveis: notificação de descarte sem briefing | message-handler | Briefing estruturado em todos os eventos |

**Descartados (falsos positivos da auditoria):** early_path perde texto (linha 93 atualiza), lock sem finally (1594 existe), append pós-allAnswered (guard na 1297), lembretes de reunião inexistentes (existem em cron.ts:350-468, cron de hora em hora).

## 4. FEATURES NOVAS — Suporte ao SDR HUMANO (o coração do pedido)

### F1. Briefing de lead (novo módulo `lead-briefing.ts`)
Mensagem estruturada enviada ao SDR humano nos eventos `qualificacao_completa`, `reuniao_agendada`,
`reuniao_no_show` e `solicita_ligacao`:
```
🔥 LEAD QUALIFICADO — João Silva
📱 wa.me/5577999... | 📞 ligar: (77) 9999-...
🏙 Vitória da Conquista/BA | ⏰ melhor hora: tarde
🚛 Transportes ABC — CLT, 3 anos, saiu 02/2025 (prescreve 02/2027 ⚠ 8 meses)
💰 Estimativa: R$ 80–140 mil (HE + verbas + FGTS)
😤 Dor: jornada 4h–23h, 60 dias sem folga, R$ 12k por fora
🗓 Reunião: 13/06 às 10h — link enviado
👉 AÇÃO: ligar para confirmar presença
```
Inclui valor via `calc-trabalhista.ts` (já existe, hoje subusado) e urgência prescricional calculada.

### F2. Detecção de no-show + reengajamento
Cron 15min: `SessaoReuniao` agendada, passou >15min do horário, sem `iniciadaEm` → marca `no_show`,
notifica o SDR humano (briefing + "LIGAR AGORA — lead não compareceu") e envia mensagem empática ao lead
oferecendo reagendamento.

### F3. Lembretes com confirmação de presença
Config `reuniao_lembretes` já roda de hora em hora; atualizar para 24h (pede confirmação "me responde
aqui se está confirmado") + 2h (link + "qualquer imprevisto me avisa que a gente remarca").
Resposta do lead em `aguardando_reuniao` com palavras de remarcação → notifica SDR humano.

### F4. Melhor horário para ligação
A confirmação de reunião da secretária passa a perguntar o melhor horário para ligações; campo
`melhor_hora_contato` (já existe na qualificação) entra no briefing.

## 5. PROMPTS — patches aplicados agora (append-only, sem remover regras)

1. **Camila**: urgência ética de prazo (comunicar os 2 anos como aliado), regra absoluta de valores,
   preparação para ligação do time, objeções: "não tenho documentos", "medo de retaliação", "vou pensar".
2. **Ana (secretária)**: prompt era 1KB sem tratamento de "nenhum horário serve", reagendamento,
   link não recebido — completado.
3. **Daniela**: bloco "o que esperar da reunião" (gratuita, 30min, pode ser do caminhão) + objeções
   "já tentei outro advogado", "vou falar com a esposa".
4. **Nelson (coleta_docs)**: era 377 bytes; instruções completas de ordem de coleta, falha de OCR e recusa.

### Backlog de prompts (próxima sessão, exige teste A/B):
- Consolidar blocos duplicados Camila/Daniela (−4KB/prompt, −20% custo flash)
- Checklist de saída da Camila; script de agregados; reescrita completa anti-redundância

## 6. ORDEM DE EXECUÇÃO DESTA SESSÃO

1. ✅ Build local consertado (Lancamento, transition-engine, testes excluídos do dist)
2. Fixes N1–N4, B1–B3 no fonte
3. F1–F4 (briefing, no-show, lembretes, melhor hora)
4. SQL: hardening de `tem_emprego_anterior`, templates de notificação, lembretes, patches de prompt
5. Build + deploy Debian + restart PM2
6. Smoke test live (harness de telefones fake) — cenário Nelson reproduzido e corrigido
7. Recuperar o lead Nelson real (reset + pergunta de empregos anteriores)
