-- =============================================================================
-- Fix: Desqualificação de leads fora do perfil (ex: motorista de Uber)
-- no modo SDR Triagem.
--
-- Executar com o projetoId do projeto alvo:
--   psql postgresql://avoce:avoce_senha@localhost:5432/avoce \
--     -v PROJETO_ID="'ID_DO_PROJETO_AQUI'" \
--     -f fix-triagem-tipo-motorista.sql
--
-- Ou para todos os projetos em modo triagem:
--   psql postgresql://avoce:avoce_senha@localhost:5432/avoce \
--     -f fix-triagem-tipo-motorista.sql
-- =============================================================================

-- 1. Adiciona campo de qualificação tipo_motorista_valido para stage lead_triagem
--    O extrator LLM vai marcar false quando o lead diz "Uber", "mototaxi", "táxi", etc.
--    Isso garante que resolvePostPhaseRoute receba o valor antes de tomar a decisão.

INSERT INTO "IaPerguntaQualificacao" (
  "id", "projetoId", "chave", "perguntaContexto", "tipoDado", "ordem",
  "stageColeta", "ativo", "criadoEm", "atualizadoEm"
)
SELECT
  gen_random_uuid(),
  p.id,
  'tipo_motorista_valido',
  'Se o lead É carreteiro, caminhoneiro, motorista de ônibus, van ou transporte de carga/passageiros (true). FALSE se for motorista de Uber/99/Lyft/InDriver/aplicativo, mototaxi, taxista, ou qualquer outro perfil fora do escopo.',
  'booleano',
  0,
  'lead_triagem',
  true,
  NOW(),
  NOW()
FROM "IaProjeto" p
JOIN "IaProjetoConfig" cfg ON cfg."projetoId" = p.id AND cfg.chave = 'modo_sdr' AND cfg.valor = 'triagem'
WHERE NOT EXISTS (
  SELECT 1 FROM "IaPerguntaQualificacao" q
  WHERE q."projetoId" = p.id AND q.chave = 'tipo_motorista_valido'
);

-- 2. Atualiza o primeiro step da fase triagem para ser tipo "gate"
--    e coleta o campo tipo_motorista_valido.
--    Só atualiza se o step ainda está como "question" (sem gate).

WITH primeiro_step AS (
  SELECT s.id, s.chave, s."projetoId"
  FROM "IaFlowStep" s
  JOIN "IaProjetoConfig" cfg ON cfg."projetoId" = s."projetoId" AND cfg.chave = 'modo_sdr' AND cfg.valor = 'triagem'
  WHERE s.fase = 'triagem'
    AND s."personaChave" = 'assistente'
    AND s.ordem = (
      SELECT MIN(s2.ordem)
      FROM "IaFlowStep" s2
      WHERE s2."projetoId" = s."projetoId"
        AND s2.fase = 'triagem'
        AND s2."personaChave" = 'assistente'
        AND s2."stepType" != 'saudacao'
        AND s2.ativo = true
    )
    AND s."stepType" = 'question'
    AND s.ativo = true
)
UPDATE "IaFlowStep" fs
SET "stepType" = 'gate', "campoColetar" = 'tipo_motorista_valido', "atualizadoEm" = NOW()
FROM primeiro_step ps
WHERE fs.id = ps.id;

-- 3. Adiciona gates no primeiro step (carreteiro → continue, outro → end com mensagem)

WITH primeiro_step AS (
  SELECT s.id, s."projetoId"
  FROM "IaFlowStep" s
  JOIN "IaProjetoConfig" cfg ON cfg."projetoId" = s."projetoId" AND cfg.chave = 'modo_sdr' AND cfg.valor = 'triagem'
  WHERE s.fase = 'triagem'
    AND s."personaChave" = 'assistente'
    AND s."campoColetar" = 'tipo_motorista_valido'
    AND s."stepType" = 'gate'
    AND s.ativo = true
    AND NOT EXISTS (SELECT 1 FROM "IaFlowGate" g WHERE g."stepId" = s.id)
)
INSERT INTO "IaFlowGate" ("id", "stepId", "ordem", "condicao", "actionType", "actionValue", "criadoEm")
SELECT
  gen_random_uuid(),
  ps.id,
  1,
  'Lead confirma ser carreteiro, caminhoneiro, motorista de ônibus, van, carreta ou transporte de carga/passageiros profissional (NÃO app/plataforma)',
  'continue',
  NULL,
  NOW()
FROM primeiro_step ps
UNION ALL
SELECT
  gen_random_uuid(),
  ps.id,
  2,
  'Lead diz ser motorista de Uber, 99, InDriver, Lyft, aplicativo, mototaxi, taxista ou qualquer outro perfil fora de carreteiro/caminhoneiro/transporte profissional',
  'end',
  'Entendido! Infelizmente nosso escritório atende apenas motoristas profissionais de carga e transporte (carreteiros, caminhoneiros, ônibus e similares). Motoristas de aplicativo como Uber têm um perfil diferente e não conseguimos te atender neste momento. Obrigado pelo contato!',
  NOW()
FROM primeiro_step ps;

-- 4. Verifica o resultado
SELECT
  s."projetoId",
  p.nome AS projeto,
  s.chave,
  s."stepType",
  s."campoColetar",
  COUNT(g.id) AS gates
FROM "IaFlowStep" s
JOIN "IaProjeto" p ON p.id = s."projetoId"
LEFT JOIN "IaFlowGate" g ON g."stepId" = s.id
JOIN "IaProjetoConfig" cfg ON cfg."projetoId" = s."projetoId" AND cfg.chave = 'modo_sdr' AND cfg.valor = 'triagem'
WHERE s.fase = 'triagem' AND s."campoColetar" = 'tipo_motorista_valido'
GROUP BY s."projetoId", p.nome, s.chave, s."stepType", s."campoColetar";

SELECT
  q."projetoId",
  p.nome AS projeto,
  q.chave,
  q."tipoDado",
  q."stageColeta"
FROM "IaPerguntaQualificacao" q
JOIN "IaProjeto" p ON p.id = q."projetoId"
WHERE q.chave = 'tipo_motorista_valido';
