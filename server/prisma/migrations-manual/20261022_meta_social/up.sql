ALTER TABLE "CrmContato" ADD COLUMN IF NOT EXISTS "instagramId" TEXT;
ALTER TABLE "CrmContato" ADD COLUMN IF NOT EXISTS "instagramUsername" TEXT;
ALTER TABLE "CrmContato" ADD COLUMN IF NOT EXISTS "messengerId" TEXT;
CREATE INDEX IF NOT EXISTS "CrmContato_instagramId_idx" ON "CrmContato"("instagramId");
CREATE INDEX IF NOT EXISTS "CrmContato_messengerId_idx" ON "CrmContato"("messengerId");
ALTER TABLE "CrmMensagemWhatsapp" ADD COLUMN IF NOT EXISTS "canal" TEXT NOT NULL DEFAULT 'whatsapp';
