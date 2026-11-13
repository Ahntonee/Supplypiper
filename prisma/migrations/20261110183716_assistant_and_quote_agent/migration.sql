-- AlterTable
ALTER TABLE "AgentRun" ADD COLUMN     "cancelRequested" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "failureReason" TEXT,
ADD COLUMN     "inputHash" TEXT,
ADD COLUMN     "inputLength" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "inputTokens" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'intake',
ADD COLUMN     "model" TEXT,
ADD COLUMN     "outputTokens" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "provider" TEXT,
ADD COLUMN     "requestId" TEXT,
ADD COLUMN     "result" JSONB;

-- CreateTable
CREATE TABLE "QuoteAgentConfig" (
    "orgId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "agentId" TEXT,
    "markupBps" INTEGER NOT NULL DEFAULT 0,
    "validityHours" INTEGER NOT NULL DEFAULT 24,
    "deliveryLeadHours" INTEGER NOT NULL DEFAULT 24,
    "deliveryChargeMinor" BIGINT NOT NULL DEFAULT 0,
    "taxBps" INTEGER NOT NULL DEFAULT 0,
    "allowedProductIds" TEXT[],
    "requireHumanReview" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QuoteAgentConfig_pkey" PRIMARY KEY ("orgId")
);

-- Bounds on what a supplier's quote-agent rules may do.
ALTER TABLE "QuoteAgentConfig"
  ADD CONSTRAINT quote_agent_markup_range CHECK ("markupBps" BETWEEN -1000 AND 5000),
  ADD CONSTRAINT quote_agent_tax_range CHECK ("taxBps" BETWEEN 0 AND 3000),
  ADD CONSTRAINT quote_agent_validity_range CHECK ("validityHours" BETWEEN 1 AND 168),
  ADD CONSTRAINT quote_agent_lead_range CHECK ("deliveryLeadHours" BETWEEN 1 AND 336),
  ADD CONSTRAINT quote_agent_delivery_nonneg CHECK ("deliveryChargeMinor" >= 0);
