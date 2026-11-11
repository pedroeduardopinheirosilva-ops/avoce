CREATE TABLE IF NOT EXISTS "CrmDisparo" (
  "id" TEXT PRIMARY KEY,
  "empresaId" TEXT,
  "projetoId" TEXT NOT NULL,
  "nome" TEXT NOT NULL,
  "mensagem" TEXT NOT NULL,
  "filtro" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'rascunho',
  "intervaloSeg" INTEGER NOT NULL DEFAULT 90,
  "limiteDia" INTEGER NOT NULL DEFAULT 60,
  "total" INTEGER NOT NULL DEFAULT 0,
  "enviados" INTEGER NOT NULL DEFAULT 0,
  "falhas" INTEGER NOT NULL DEFAULT 0,
  "pulados" INTEGER NOT NULL DEFAULT 0,
  "criadoPor" TEXT,
  "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "atualizadoEm" TIMESTAMP(3) NOT NULL
);
CREATE INDEX IF NOT EXISTS "CrmDisparo_status_idx" ON "CrmDisparo"("status");
CREATE TABLE IF NOT EXISTS "CrmDisparoItem" (
  "id" TEXT PRIMARY KEY,
  "disparoId" TEXT NOT NULL REFERENCES "CrmDisparo"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "dealId" TEXT NOT NULL,
  "canal" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pendente',
  "erro" TEXT,
  "enviadoEm" TIMESTAMP(3)
);
CREATE UNIQUE INDEX IF NOT EXISTS "CrmDisparoItem_disparoId_dealId_key" ON "CrmDisparoItem"("disparoId", "dealId");
CREATE INDEX IF NOT EXISTS "CrmDisparoItem_disparoId_status_idx" ON "CrmDisparoItem"("disparoId", "status");
ALTER TABLE "CrmDisparo" OWNER TO avoce;
ALTER TABLE "CrmDisparoItem" OWNER TO avoce;
