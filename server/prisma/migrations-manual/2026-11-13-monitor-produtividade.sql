-- Monitor de produtividade. Gerado por 'prisma migrate diff' contra o schema do repo em 3bcf4bb.
-- RE-DIFFAR contra producao antes de aplicar (nao foi conferido contra o banco real).
BEGIN;

-- AlterTable
ALTER TABLE "Usuario" ADD COLUMN     "monitorCargoId" TEXT,
ADD COLUMN     "monitorExpediente" JSONB,
ADD COLUMN     "monitorado" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "verProdutividade" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "MonitorCargo" (
    "id" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MonitorCargo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MonitorDispositivo" (
    "id" TEXT NOT NULL,
    "usuarioId" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "so" TEXT,
    "tokenHash" TEXT,
    "codigoPareamento" TEXT,
    "codigoExpiraEm" TIMESTAMP(3),
    "pareadoEm" TIMESTAMP(3),
    "ultimoEnvioEm" TIMESTAMP(3),
    "versaoColetor" TEXT,
    "bucketsVistos" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "ultimoTituloEm" TIMESTAMP(3),
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MonitorDispositivo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MonitorEvento" (
    "id" BIGSERIAL NOT NULL,
    "dispositivoId" TEXT NOT NULL,
    "bucket" TEXT NOT NULL,
    "inicio" TIMESTAMP(3) NOT NULL,
    "duracaoSeg" DOUBLE PRECISION NOT NULL,
    "app" TEXT,
    "titulo" TEXT,
    "url" TEXT,
    "dominio" TEXT,
    "afk" BOOLEAN,

    CONSTRAINT "MonitorEvento_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MonitorRegra" (
    "id" TEXT NOT NULL,
    "alvo" TEXT NOT NULL,
    "padrao" TEXT NOT NULL,
    "categoria" TEXT NOT NULL,
    "cargoId" TEXT,
    "usuarioId" TEXT,
    "prioridade" INTEGER NOT NULL DEFAULT 0,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MonitorRegra_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MonitorDia" (
    "usuarioId" TEXT NOT NULL,
    "data" TEXT NOT NULL,
    "segAtivo" INTEGER NOT NULL DEFAULT 0,
    "segTrabalho" INTEGER NOT NULL DEFAULT 0,
    "segPessoal" INTEGER NOT NULL DEFAULT 0,
    "segNeutro" INTEGER NOT NULL DEFAULT 0,
    "segAtivoFora" INTEGER NOT NULL DEFAULT 0,
    "segTrabalhoFora" INTEGER NOT NULL DEFAULT 0,
    "segPessoalFora" INTEGER NOT NULL DEFAULT 0,
    "segNeutroFora" INTEGER NOT NULL DEFAULT 0,
    "primeiroEvento" TIMESTAMP(3),
    "ultimoEvento" TIMESTAMP(3),
    "topJson" JSONB,
    "sujo" BOOLEAN NOT NULL DEFAULT true,
    "calculadoEm" TIMESTAMP(3),

    CONSTRAINT "MonitorDia_pkey" PRIMARY KEY ("usuarioId","data")
);

-- CreateIndex
CREATE UNIQUE INDEX "MonitorCargo_nome_key" ON "MonitorCargo"("nome");

-- CreateIndex
CREATE UNIQUE INDEX "MonitorDispositivo_tokenHash_key" ON "MonitorDispositivo"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "MonitorDispositivo_codigoPareamento_key" ON "MonitorDispositivo"("codigoPareamento");

-- CreateIndex
CREATE INDEX "MonitorDispositivo_usuarioId_idx" ON "MonitorDispositivo"("usuarioId");

-- CreateIndex
CREATE INDEX "MonitorEvento_dispositivoId_inicio_idx" ON "MonitorEvento"("dispositivoId", "inicio");

-- CreateIndex
CREATE UNIQUE INDEX "MonitorEvento_dispositivoId_bucket_inicio_key" ON "MonitorEvento"("dispositivoId", "bucket", "inicio");

-- CreateIndex
CREATE INDEX "MonitorDia_sujo_idx" ON "MonitorDia"("sujo");

-- AddForeignKey
ALTER TABLE "Usuario" ADD CONSTRAINT "Usuario_monitorCargoId_fkey" FOREIGN KEY ("monitorCargoId") REFERENCES "MonitorCargo"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MonitorDispositivo" ADD CONSTRAINT "MonitorDispositivo_usuarioId_fkey" FOREIGN KEY ("usuarioId") REFERENCES "Usuario"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MonitorEvento" ADD CONSTRAINT "MonitorEvento_dispositivoId_fkey" FOREIGN KEY ("dispositivoId") REFERENCES "MonitorDispositivo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MonitorRegra" ADD CONSTRAINT "MonitorRegra_cargoId_fkey" FOREIGN KEY ("cargoId") REFERENCES "MonitorCargo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MonitorRegra" ADD CONSTRAINT "MonitorRegra_usuarioId_fkey" FOREIGN KEY ("usuarioId") REFERENCES "Usuario"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MonitorDia" ADD CONSTRAINT "MonitorDia_usuarioId_fkey" FOREIGN KEY ("usuarioId") REFERENCES "Usuario"("id") ON DELETE CASCADE ON UPDATE CASCADE;


ALTER TABLE "MonitorCargo" OWNER TO avoce;
ALTER TABLE "MonitorDispositivo" OWNER TO avoce;
ALTER TABLE "MonitorEvento" OWNER TO avoce;
ALTER TABLE "MonitorRegra" OWNER TO avoce;
ALTER TABLE "MonitorDia" OWNER TO avoce;

COMMIT;
