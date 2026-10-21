-- CreateEnum
CREATE TYPE "AiProviderKind" AS ENUM ('OPENAI', 'GEMINI', 'ANTHROPIC', 'OPENROUTER', 'DEEPSEEK', 'GROQ', 'OPENAI_COMPATIBLE', 'AZURE_SPEECH', 'ESPEAK');

-- CreateEnum
CREATE TYPE "AiModelKind" AS ENUM ('CHAT', 'TTS_VOICE', 'STT');

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "analysisModelId" TEXT;

-- AlterTable
ALTER TABLE "UsageEvent" ADD COLUMN     "modelId" TEXT;

-- CreateTable
CREATE TABLE "AiProvider" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "AiProviderKind" NOT NULL,
    "baseUrl" TEXT,
    "apiKeyEnc" TEXT,
    "keyHint" TEXT,
    "region" TEXT,
    "config" JSONB,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastTestAt" TIMESTAMP(3),
    "lastTestOk" BOOLEAN,
    "lastTestMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiProvider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiModel" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "kind" "AiModelKind" NOT NULL,
    "modelId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "supportsVision" BOOLEAN NOT NULL DEFAULT false,
    "jsonMode" BOOLEAN NOT NULL DEFAULT true,
    "maxOutputTokens" INTEGER,
    "inputUsdPer1M" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "outputUsdPer1M" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "unitUsdPer1M" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "creditMultiplier" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "userSelectable" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "config" JSONB,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiModel_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiModel_kind_enabled_idx" ON "AiModel"("kind", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "AiModel_providerId_kind_modelId_key" ON "AiModel"("providerId", "kind", "modelId");

-- CreateIndex
CREATE INDEX "UsageEvent_modelId_createdAt_idx" ON "UsageEvent"("modelId", "createdAt");

-- AddForeignKey
ALTER TABLE "AiModel" ADD CONSTRAINT "AiModel_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "AiProvider"("id") ON DELETE CASCADE ON UPDATE CASCADE;
