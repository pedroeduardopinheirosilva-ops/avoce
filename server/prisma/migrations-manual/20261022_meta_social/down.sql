ALTER TABLE "CrmMensagemWhatsapp" DROP COLUMN IF EXISTS "canal";
DROP INDEX IF EXISTS "CrmContato_messengerId_idx";
DROP INDEX IF EXISTS "CrmContato_instagramId_idx";
ALTER TABLE "CrmContato" DROP COLUMN IF EXISTS "messengerId";
ALTER TABLE "CrmContato" DROP COLUMN IF EXISTS "instagramUsername";
ALTER TABLE "CrmContato" DROP COLUMN IF EXISTS "instagramId";
