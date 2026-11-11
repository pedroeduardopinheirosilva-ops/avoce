-- Meta Conversions API for Business Messaging — atribuição CTWA + fila de eventos.
-- Aditivo: só colunas nulas e tabela nova. Nada existente muda de comportamento.
BEGIN;

ALTER TABLE "CrmDeal"
  ADD COLUMN IF NOT EXISTS "origemCtwaClid"   TEXT,
  ADD COLUMN IF NOT EXISTS "origemSourceType" TEXT,
  ADD COLUMN IF NOT EXISTS "origemEntryPoint" TEXT;

CREATE TABLE IF NOT EXISTS "MetaConversaoEvento" (
  "id"                 TEXT         NOT NULL,
  "eventId"            TEXT         NOT NULL,
  "dealId"             TEXT         NOT NULL,
  "projetoId"          TEXT,
  "eventName"          TEXT         NOT NULL,
  "ctwaClid"           TEXT,
  "via"                TEXT,
  "stageChave"         TEXT,
  "ocorridoEm"         TIMESTAMP(3) NOT NULL,
  "status"             TEXT         NOT NULL DEFAULT 'pendente',
  "tentativas"         INTEGER      NOT NULL DEFAULT 0,
  "proximaTentativaEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "enviadoEm"          TIMESTAMP(3),
  "testEventCode"      TEXT,
  "payload"            JSONB,
  "resposta"           JSONB,
  "erro"               TEXT,
  "criadoEm"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "atualizadoEm"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MetaConversaoEvento_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "MetaConversaoEvento_eventId_key" ON "MetaConversaoEvento"("eventId");
CREATE INDEX IF NOT EXISTS "MetaConversaoEvento_status_proximaTentativaEm_idx" ON "MetaConversaoEvento"("status", "proximaTentativaEm");
CREATE INDEX IF NOT EXISTS "MetaConversaoEvento_projetoId_criadoEm_idx" ON "MetaConversaoEvento"("projetoId", "criadoEm");

DO $$ BEGIN
  ALTER TABLE "MetaConversaoEvento"
    ADD CONSTRAINT "MetaConversaoEvento_dealId_fkey" FOREIGN KEY ("dealId")
    REFERENCES "CrmDeal"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMIT;
