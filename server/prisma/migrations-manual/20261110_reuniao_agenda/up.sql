-- Reunião marcada pelo SDR/closer: pauta, quem conduz, duração, modalidade e aviso ao cliente.
ALTER TABLE "SessaoReuniao" ADD COLUMN IF NOT EXISTS "pauta" TEXT;
ALTER TABLE "SessaoReuniao" ADD COLUMN IF NOT EXISTS "responsavelId" TEXT;
ALTER TABLE "SessaoReuniao" ADD COLUMN IF NOT EXISTS "duracaoMin" INTEGER NOT NULL DEFAULT 60;
ALTER TABLE "SessaoReuniao" ADD COLUMN IF NOT EXISTS "modalidade" TEXT NOT NULL DEFAULT 'video';
ALTER TABLE "SessaoReuniao" ADD COLUMN IF NOT EXISTS "avisarCliente" BOOLEAN NOT NULL DEFAULT true;
CREATE INDEX IF NOT EXISTS "SessaoReuniao_agendadaPara_idx" ON "SessaoReuniao"("agendadaPara");
CREATE INDEX IF NOT EXISTS "SessaoReuniao_responsavelId_agendadaPara_idx" ON "SessaoReuniao"("responsavelId", "agendadaPara");
