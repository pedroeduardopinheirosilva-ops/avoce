-- Módulo Assinaturas — assinatura eletrônica via PAKT (nos moldes do PSA-MT)
-- DDL manual: NUNCA rodar `prisma db push` no banco avoce (índices manuais de outro dono).

CREATE TABLE IF NOT EXISTS "Assinatura" (
    "id"                        TEXT PRIMARY KEY,
    "paktDocumentId"            TEXT UNIQUE,
    "emitenteId"                TEXT NOT NULL,
    "nome"                      TEXT NOT NULL,
    "status"                    TEXT NOT NULL DEFAULT 'DRAFT',
    "mensagem"                  TEXT,
    "expiresAt"                 TIMESTAMP(3),
    "paktResponse"              JSONB,

    "arquivoNome"               TEXT,
    "arquivoPath"               TEXT,
    "arquivoTamanho"            INTEGER,
    "arquivoAssinadoPath"       TEXT,
    "arquivoAssinadoEm"         TIMESTAMP(3),

    "criadoPorId"               TEXT,
    "criadoPorNome"             TEXT,

    "signatarios"               JSONB NOT NULL DEFAULT '[]',

    "tomadorId"                 TEXT,
    "dealId"                    TEXT,

    "emailEnviado"              BOOLEAN NOT NULL DEFAULT FALSE,
    "emailEnviadoEm"            TIMESTAMP(3),
    "whatsappEnviado"           BOOLEAN NOT NULL DEFAULT FALSE,
    "whatsappEnviadoEm"         TIMESTAMP(3),
    "whatsappAssinadoEnviado"   BOOLEAN NOT NULL DEFAULT FALSE,
    "whatsappAssinadoEnviadoEm" TIMESTAMP(3),

    "webhookEventos"            JSONB NOT NULL DEFAULT '[]',

    "criadoEm"                  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizadoEm"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

DO $$ BEGIN
    ALTER TABLE "Assinatura"
      ADD CONSTRAINT "Assinatura_emitenteId_fkey"
      FOREIGN KEY ("emitenteId") REFERENCES "EmpresaEmitente"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "Assinatura"
      ADD CONSTRAINT "Assinatura_tomadorId_fkey"
      FOREIGN KEY ("tomadorId") REFERENCES "Tomador"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "Assinatura_emitenteId_status_idx" ON "Assinatura" ("emitenteId", "status");
CREATE INDEX IF NOT EXISTS "Assinatura_criadoEm_idx"          ON "Assinatura" ("criadoEm");
