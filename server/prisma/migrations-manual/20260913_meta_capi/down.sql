-- Reverte 20260913_meta_capi. Apaga a fila de eventos e as colunas de atribuição CTWA.
BEGIN;
DROP TABLE IF EXISTS "MetaConversaoEvento";
ALTER TABLE "CrmDeal"
  DROP COLUMN IF EXISTS "origemCtwaClid",
  DROP COLUMN IF EXISTS "origemSourceType",
  DROP COLUMN IF EXISTS "origemEntryPoint";
COMMIT;
