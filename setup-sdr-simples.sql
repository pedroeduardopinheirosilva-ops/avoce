-- =============================================================================
-- SDR Simplificado — Carreteiros com Horas Extras
-- Executar APÓS criar o projeto na UI do Avoce:
--   psql postgresql://avoce:avoce_senha@localhost:5432/avoce \
--     -v PROJETO_ID="'ID_DO_PROJETO_AQUI'" \
--     -f setup-sdr-simples.sql
-- =============================================================================

-- 1. Config: ativa modo SDR simplificado
INSERT INTO "IaProjetoConfig" ("id", "projetoId", "chave", "valor", "categoria", "criadoEm", "atualizadoEm")
VALUES (gen_random_uuid(), :PROJETO_ID, 'modo_sdr', 'simples', 'comportamento', NOW(), NOW())
ON CONFLICT DO NOTHING;

-- 2. Persona Ana SDR
INSERT INTO "IaPersona" ("id", "projetoId", "chave", "nomeExibicao", "systemPrompt", "ativo", "criadoEm", "atualizadoEm")
VALUES (
  gen_random_uuid(), :PROJETO_ID, 'assistente', 'Ana',
  '{INSTRUÇÃO BASE}

Você é Ana, analista jurídica do escritório. Sua missão é qualificar rapidamente se o caminhoneiro tem um caso de horas extras não pagas.

PERFIL DO LEAD: motorista/caminhoneiro que trabalhou com CLT em uma transportadora.

REGRAS:
- Conduza o fluxo UMA PERGUNTA POR VEZ, com naturalidade.
- Tom leve, direto e humano. Sem jargões jurídicos.
- Quando o lead relatar injustiça, demonstre empatia antes de continuar.
- Nunca revele que é IA. Se perguntarem, diga que é a analista do WhatsApp.
- Mensagens curtas: máximo 2-3 frases.
- Se o lead fizer perguntas jurídicas simples, responda brevemente e volte ao fluxo.',
  true, NOW(), NOW()
)
ON CONFLICT ("projetoId", "chave") DO UPDATE
  SET "nomeExibicao" = EXCLUDED."nomeExibicao",
      "systemPrompt" = EXCLUDED."systemPrompt";

-- 3. Fases do funil
INSERT INTO "IaFaseFunil" ("id", "projetoId", "chave", "nomeExibicao", "ordem", "personaChave", "ehEntrada", "requerAcaoHumana", "criadoEm", "atualizadoEm")
VALUES
  (gen_random_uuid(), :PROJETO_ID, 'lead_entrada',     'Lead Entrada',     1, 'assistente', true,  false, NOW(), NOW()),
  (gen_random_uuid(), :PROJETO_ID, 'lead_qualificado', 'Lead Qualificado', 2, 'advogado',   false, false, NOW(), NOW()),
  (gen_random_uuid(), :PROJETO_ID, 'descartado',       'Descartado',       9, null,         false, false, NOW(), NOW())
ON CONFLICT ("projetoId", "chave") DO NOTHING;

-- 4. Regra de transição: qualificado → Daniela
INSERT INTO "IaRegraTransicao" ("id", "projetoId", "stageOrigemChave", "stageDestinoChave", "condicao", "ordem", "acaoAdicional", "requerPrescricaoAtiva", "criadoEm", "atualizadoEm")
VALUES (gen_random_uuid(), :PROJETO_ID, 'lead_entrada', 'lead_qualificado', 'qualificacao_completa', 1, 'trocar_persona:advogado', false, NOW(), NOW())
ON CONFLICT DO NOTHING;

-- =============================================================================
-- 5. Flow steps (personaChave="assistente", fase="sdr_simples")
-- =============================================================================

-- Step 0: saudação / greeting
INSERT INTO "IaFlowStep" ("id","projetoId","personaChave","fase","chave","ordem","label","stepType","pergunta","campoColetar","ativo","criadoEm","atualizadoEm")
VALUES (gen_random_uuid(),:PROJETO_ID,'assistente','sdr_simples','saudacao',0,'Saudação','saudacao',
  'Olá! Sou a Ana, analista jurídica do escritório. Pode me dizer seu nome?',
  'nome',true,NOW(),NOW())
ON CONFLICT ("projetoId","personaChave","chave") DO NOTHING;

-- Step 1: resumo do caso
INSERT INTO "IaFlowStep" ("id","projetoId","personaChave","fase","chave","ordem","label","stepType","pergunta","campoColetar","ativo","criadoEm","atualizadoEm")
VALUES (gen_random_uuid(),:PROJETO_ID,'assistente','sdr_simples','resumo_caso',1,'Resumo do caso','question',
  'Me conta um pouco o que aconteceu — qual transportadora você trabalhava e o que houve lá?',
  'resumo_caso',true,NOW(),NOW())
ON CONFLICT ("projetoId","personaChave","chave") DO NOTHING;

-- Step 2: emprego_status (ainda trabalha ou saiu?)
INSERT INTO "IaFlowStep" ("id","projetoId","personaChave","fase","chave","ordem","label","stepType","pergunta","campoColetar","ativo","criadoEm","atualizadoEm")
VALUES (gen_random_uuid(),:PROJETO_ID,'assistente','sdr_simples','emprego_status',2,'Status emprego','gate',
  'Você ainda trabalha nessa empresa ou já saiu?',
  'emprego_status',true,NOW(),NOW())
ON CONFLICT ("projetoId","personaChave","chave") DO NOTHING;

-- Step 3: data_saida_check (prescrição)
INSERT INTO "IaFlowStep" ("id","projetoId","personaChave","fase","chave","ordem","label","stepType","pergunta","campoColetar","ativo","criadoEm","atualizadoEm")
VALUES (gen_random_uuid(),:PROJETO_ID,'assistente','sdr_simples','data_saida_check',3,'Gate prescrição','gate',
  'Em que mês e ano você saiu? Pode ser aproximado — ex: março de 2024.',
  'data_saida_aproximada',true,NOW(),NOW())
ON CONFLICT ("projetoId","personaChave","chave") DO NOTHING;

-- Step 4: tinha_clt
INSERT INTO "IaFlowStep" ("id","projetoId","personaChave","fase","chave","ordem","label","stepType","pergunta","campoColetar","ativo","criadoEm","atualizadoEm")
VALUES (gen_random_uuid(),:PROJETO_ID,'assistente','sdr_simples','tinha_clt',4,'Gate CLT','gate',
  'Você tinha carteira de trabalho assinada (CLT) nessa empresa?',
  'tinha_clt',true,NOW(),NOW())
ON CONFLICT ("projetoId","personaChave","chave") DO NOTHING;

-- Step 5: jornada
INSERT INTO "IaFlowStep" ("id","projetoId","personaChave","fase","chave","ordem","label","stepType","pergunta","campoColetar","ativo","criadoEm","atualizadoEm")
VALUES (gen_random_uuid(),:PROJETO_ID,'assistente','sdr_simples','jornada',5,'Jornada','question',
  'Qual era o horário de trabalho? Me diz a entrada e saída. Ex: das 06h às 22h.',
  'jornada_descricao',true,NOW(),NOW())
ON CONFLICT ("projetoId","personaChave","chave") DO NOTHING;

-- Step 6: horas_extras (gate — foco principal)
INSERT INTO "IaFlowStep" ("id","projetoId","personaChave","fase","chave","ordem","label","stepType","pergunta","campoColetar","ativo","criadoEm","atualizadoEm")
VALUES (gen_random_uuid(),:PROJETO_ID,'assistente','sdr_simples','horas_extras',6,'Horas extras','gate',
  'Você fazia horas extras além do combinado? Eram pagas corretamente no holerite?',
  'horas_extras_situacao',true,NOW(),NOW())
ON CONFLICT ("projetoId","personaChave","chave") DO NOTHING;

-- Step 7: pagamento_fora
INSERT INTO "IaFlowStep" ("id","projetoId","personaChave","fase","chave","ordem","label","stepType","pergunta","campoColetar","ativo","criadoEm","atualizadoEm")
VALUES (gen_random_uuid(),:PROJETO_ID,'assistente','sdr_simples','pagamento_fora',7,'Pagamento fora','question',
  'Recebia algum valor por PIX, Pamcard ou dinheiro fora do holerite?',
  'pagamento_fora_descricao',true,NOW(),NOW())
ON CONFLICT ("projetoId","personaChave","chave") DO NOTHING;

-- Step 8: fgts_check
INSERT INTO "IaFlowStep" ("id","projetoId","personaChave","fase","chave","ordem","label","stepType","pergunta","campoColetar","ativo","criadoEm","atualizadoEm")
VALUES (gen_random_uuid(),:PROJETO_ID,'assistente','sdr_simples','fgts_check',8,'FGTS','question',
  'O FGTS era depositado todo mês? (pode verificar pelo app da Caixa)',
  'fgts_situacao',true,NOW(),NOW())
ON CONFLICT ("projetoId","personaChave","chave") DO NOTHING;

-- Step 9: valor_estimado (LLM gera parecer + valor)
INSERT INTO "IaFlowStep" ("id","projetoId","personaChave","fase","chave","ordem","label","stepType","pergunta","campoColetar","ativo","criadoEm","atualizadoEm")
VALUES (gen_random_uuid(),:PROJETO_ID,'assistente','sdr_simples','valor_estimado',9,'Valor estimado','llm_generated',
  'Com base no que o cliente relatou (jornada, horas extras, pagamento fora e FGTS), gere uma mensagem natural de WhatsApp que:
1. Reconheça a situação com empatia
2. Explique brevemente que horas extras não pagas geram direito a indenização
3. Apresente estimativa INFORMAL: calcule horas diárias excedentes × 1,5 × salário estimado × meses. Use intervalo "entre R$ X e R$ Y". Se não tiver dados suficientes, diga "pode chegar a valores expressivos dependendo do salário"
4. Termine com: "Quer que nossa advogada analise seu caso detalhadamente?"
Seja direto, humano, sem juridiquês. Máx 4 frases.',
  null,true,NOW(),NOW())
ON CONFLICT ("projetoId","personaChave","chave") DO NOTHING;

-- Step 10: aceite_prosseguir (gate — confirma interesse)
INSERT INTO "IaFlowStep" ("id","projetoId","personaChave","fase","chave","ordem","label","stepType","pergunta","campoColetar","ativo","criadoEm","atualizadoEm")
VALUES (gen_random_uuid(),:PROJETO_ID,'assistente','sdr_simples','aceite_prosseguir',10,'Aceite','gate',
  '',
  'aceite_prosseguir',true,NOW(),NOW())
ON CONFLICT ("projetoId","personaChave","chave") DO NOTHING;

-- =============================================================================
-- 6. Gates
-- =============================================================================

-- Gates: emprego_status
WITH step AS (SELECT id FROM "IaFlowStep" WHERE "projetoId"=:PROJETO_ID AND chave='emprego_status')
INSERT INTO "IaFlowGate"("id","stepId","ordem","condicao","actionType","actionValue","criadoEm")
SELECT gen_random_uuid(),step.id,g.ordem::int,g.condicao,g.act,g.val,NOW()
FROM step,(VALUES
  (1,'Ainda está trabalhando na empresa / não saiu','discard',
     'Entendido! Quem ainda está na empresa pode ter direito à rescisão indireta. Nossa equipe vai avaliar seu caso e entrar em contato. Obrigada!'),
  (2,'Já saiu da empresa / não trabalha mais lá','continue',null)
) AS g(ordem,condicao,act,val)
ON CONFLICT DO NOTHING;

-- Gates: data_saida_check (prescrição 2 anos)
WITH step AS (SELECT id FROM "IaFlowStep" WHERE "projetoId"=:PROJETO_ID AND chave='data_saida_check')
INSERT INTO "IaFlowGate"("id","stepId","ordem","condicao","actionType","actionValue","criadoEm")
SELECT gen_random_uuid(),step.id,g.ordem::int,g.condicao,g.act,g.val,NOW()
FROM step,(VALUES
  (1,'A data de saída foi há mais de 2 anos — prazo prescricional trabalhista encerrado','discard',
     'Entendo. O prazo para ação trabalhista é de 2 anos após a saída da empresa, e infelizmente esse prazo já encerrou para o seu caso. Agradeço o contato e desejo boa sorte!'),
  (2,'A data de saída foi há 2 anos ou menos — dentro do prazo','continue',null)
) AS g(ordem,condicao,act,val)
ON CONFLICT DO NOTHING;

-- Gates: tinha_clt
WITH step AS (SELECT id FROM "IaFlowStep" WHERE "projetoId"=:PROJETO_ID AND chave='tinha_clt')
INSERT INTO "IaFlowGate"("id","stepId","ordem","condicao","actionType","actionValue","criadoEm")
SELECT gen_random_uuid(),step.id,g.ordem::int,g.condicao,g.act,g.val,NOW()
FROM step,(VALUES
  (1,'Não tinha CLT — era autônomo, agregado, TAC ou sem registro em carteira','discard',
     'Entendido! Mesmo sem CLT pode haver reconhecimento de vínculo — mas esse processo é diferente. Nossa equipe vai avaliar e entrar em contato. Obrigada!'),
  (2,'Tinha carteira de trabalho assinada / CLT','continue',null)
) AS g(ordem,condicao,act,val)
ON CONFLICT DO NOTHING;

-- Gates: horas_extras (ambos continuam — só queremos registrar a situação)
WITH step AS (SELECT id FROM "IaFlowStep" WHERE "projetoId"=:PROJETO_ID AND chave='horas_extras')
INSERT INTO "IaFlowGate"("id","stepId","ordem","condicao","actionType","actionValue","criadoEm")
SELECT gen_random_uuid(),step.id,g.ordem::int,g.condicao,g.act,g.val,NOW()
FROM step,(VALUES
  (1,'Fazia horas extras mas não eram pagas ou eram pagas parcialmente','continue',null),
  (2,'Não fazia horas extras ou eram pagas corretamente','continue',null)
) AS g(ordem,condicao,act,val)
ON CONFLICT DO NOTHING;

-- Gates: aceite_prosseguir
WITH step AS (SELECT id FROM "IaFlowStep" WHERE "projetoId"=:PROJETO_ID AND chave='aceite_prosseguir')
INSERT INTO "IaFlowGate"("id","stepId","ordem","condicao","actionType","actionValue","criadoEm")
SELECT gen_random_uuid(),step.id,g.ordem::int,g.condicao,g.act,g.val,NOW()
FROM step,(VALUES
  (1,'Aceita seguir / quer prosseguir com a advogada / sim / quero','end',null),
  (2,'Não quer prosseguir / recusa / não / agora não','discard',
     'Sem problema! Se mudar de ideia, é só chamar. Boa sorte!')
) AS g(ordem,condicao,act,val)
ON CONFLICT DO NOTHING;

-- =============================================================================
-- VERIFICAÇÃO FINAL
-- =============================================================================
SELECT 'Steps sdr_simples:' AS info, COUNT(*)::text AS total
FROM "IaFlowStep" WHERE "projetoId"=:PROJETO_ID AND fase='sdr_simples';

SELECT 'Gates criados:' AS info, COUNT(*)::text AS total
FROM "IaFlowGate" g
JOIN "IaFlowStep" s ON g."stepId"=s.id
WHERE s."projetoId"=:PROJETO_ID;

SELECT 'modo_sdr=' || valor AS info, 'ok' AS total
FROM "IaProjetoConfig" WHERE "projetoId"=:PROJETO_ID AND chave='modo_sdr';
