DROP INDEX IF EXISTS "SessaoReuniao_responsavelId_agendadaPara_idx";
DROP INDEX IF EXISTS "SessaoReuniao_agendadaPara_idx";
ALTER TABLE "SessaoReuniao" DROP COLUMN IF EXISTS "avisarCliente";
ALTER TABLE "SessaoReuniao" DROP COLUMN IF EXISTS "modalidade";
ALTER TABLE "SessaoReuniao" DROP COLUMN IF EXISTS "duracaoMin";
ALTER TABLE "SessaoReuniao" DROP COLUMN IF EXISTS "responsavelId";
ALTER TABLE "SessaoReuniao" DROP COLUMN IF EXISTS "pauta";
