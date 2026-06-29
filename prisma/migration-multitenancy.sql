-- =============================================================
-- Multi-tenancy Avoce — Sprint 1: Backfill empresaId
-- =============================================================
-- Este script deve ser executado APÓS o prisma db push (quando
-- as colunas empresaId já existirem na tabela, mas como nullable).
-- =============================================================

BEGIN;

-- 1. Criar registros Empresa
-- Pinheiro Silva Advocacia (PSA) — CNPJ 09473196000106
-- Rocha Amorim Pires (RAP) — CNPJ 41177089000143

INSERT INTO "Empresa" (id, nome, cnpj, ativo, "criadoEm")
SELECT 'emp_psa', 'Pinheiro Silva Advocacia', '09473196000106', true, NOW()
WHERE NOT EXISTS (SELECT 1 FROM "Empresa" WHERE cnpj = '09473196000106');

INSERT INTO "Empresa" (id, nome, cnpj, ativo, "criadoEm")
SELECT 'emp_rap', 'Rocha Amorim Pires Advocacia', '41177089000143', true, NOW()
WHERE NOT EXISTS (SELECT 1 FROM "Empresa" WHERE cnpj = '41177089000143');

-- 2. EmpresaEmitente → empresaId
-- PSA emitente = CNPJ 09473196000106
UPDATE "EmpresaEmitente" SET "empresaId" = 'emp_psa'
WHERE cnpj = '09473196000106';

-- RAP emitente = CNPJ 41177089000143
UPDATE "EmpresaEmitente" SET "empresaId" = 'emp_rap'
WHERE cnpj = '41177089000143';

-- 3. Usuario → empresaId
-- admin@capium.com.br → empresa PSA (admin, pode acessar tudo depois via role)
-- pedroeduardo@pinheirosilva.adv.br → PSA
-- luanahelena@pinheirosilva.adv.br → PSA
-- financeiro@pinheirosilva.adv.br → PSA
UPDATE "Usuario" SET "empresaId" = 'emp_psa'
WHERE email IN (
  'admin@capium.com.br',
  'pedroeduardopinheirosilva@gmail.com',
  'luanahelena@pinheirosilva.adv.br',
  'financeiro@pinheirosilva.adv.br',
  'teste@teste.com'
);

-- 4. Tomador → empresaId
-- O usuário confirmou: PSA tem os tomadores e contratos cadastrados
UPDATE "Tomador" SET "empresaId" = 'emp_psa'
WHERE "empresaId" IS NULL;
-- (eventualmente pode ter tomadores da RAP também)

-- 5. Administrador → empresaId (mesmo tomadorId → mesma empresa)
UPDATE "Administrador" adm
SET "empresaId" = t."empresaId"
FROM "Tomador" t
WHERE adm."tomadorId" = t.id
  AND adm."empresaId" IS NULL;

-- 6. CrmPipeline → empresaId
-- O usuário confirmou: todos os deals são da RAP
UPDATE "CrmPipeline" SET "empresaId" = 'emp_rap'
WHERE "empresaId" IS NULL;

-- 7. CrmDeal → empresaId
-- Todas as pipelines são da RAP, todos os deals também
UPDATE "CrmDeal" d
SET "empresaId" = COALESCE(
  (SELECT p."empresaId" FROM "CrmPipeline" p WHERE p.id = d."pipelineId"),
  'emp_rap'
)
WHERE d."empresaId" IS NULL;

-- 8. CrmContato → empresaId
-- Contatos estão ligados a deals (RAP)
UPDATE "CrmContato" c
SET "empresaId" = COALESCE(
  (SELECT d."empresaId" FROM "CrmDeal" d WHERE d."contatoId" = c.id LIMIT 1),
  'emp_rap'
)
WHERE c."empresaId" IS NULL;

-- Fallback: contatos sem deal associado → RAP
UPDATE "CrmContato" SET "empresaId" = 'emp_rap'
WHERE "empresaId" IS NULL;

-- 9. CrmMensagemWhatsapp → empresaId (via deal ou contato)
UPDATE "CrmMensagemWhatsapp" m
SET "empresaId" = COALESCE(
  (SELECT d."empresaId" FROM "CrmDeal" d WHERE d.id = m."dealId"),
  (SELECT c."empresaId" FROM "CrmContato" c WHERE c.id = m."contatoId"),
  'emp_rap'
)
WHERE m."empresaId" IS NULL;

-- 10. IaProjeto → empresaId
-- O projeto Carreteiros é da RAP (deals são da RAP)
UPDATE "IaProjeto" SET "empresaId" = 'emp_rap'
WHERE "empresaId" IS NULL;

COMMIT;

-- =============================================================
-- Verificação
-- =============================================================
SELECT 'Empresa' as tabela, COUNT(*) as total FROM "Empresa"
UNION ALL
SELECT 'EmpresaEmitente', COUNT(*) FROM "EmpresaEmitente" WHERE "empresaId" IS NULL
UNION ALL
SELECT 'Usuario', COUNT(*) FROM "Usuario" WHERE "empresaId" IS NULL
UNION ALL
SELECT 'Tomador', COUNT(*) FROM "Tomador" WHERE "empresaId" IS NULL
UNION ALL
SELECT 'Administrador', COUNT(*) FROM "Administrador" WHERE "empresaId" IS NULL
UNION ALL
SELECT 'CrmPipeline', COUNT(*) FROM "CrmPipeline" WHERE "empresaId" IS NULL
UNION ALL
SELECT 'CrmDeal', COUNT(*) FROM "CrmDeal" WHERE "empresaId" IS NULL
UNION ALL
SELECT 'CrmContato', COUNT(*) FROM "CrmContato" WHERE "empresaId" IS NULL
UNION ALL
SELECT 'CrmMensagemWhatsapp', COUNT(*) FROM "CrmMensagemWhatsapp" WHERE "empresaId" IS NULL
UNION ALL
SELECT 'IaProjeto', COUNT(*) FROM "IaProjeto" WHERE "empresaId" IS NULL
;
