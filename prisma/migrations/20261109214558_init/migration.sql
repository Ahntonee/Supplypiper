-- CreateEnum
CREATE TYPE "Environment" AS ENUM ('demo', 'testnet', 'production');

-- CreateEnum
CREATE TYPE "OrgRole" AS ENUM ('owner', 'buyer_requester', 'buyer_approver', 'supplier_manager', 'supplier_staff', 'read_only_auditor');

-- CreateEnum
CREATE TYPE "Capability" AS ENUM ('buyer', 'supplier');

-- CreateEnum
CREATE TYPE "RfqState" AS ENUM ('draft', 'published', 'collecting', 'ready_for_comparison', 'selected', 'closed', 'cancelled', 'expired');

-- CreateEnum
CREATE TYPE "QuoteState" AS ENUM ('draft', 'submitted', 'superseded', 'withdrawn', 'expired');

-- CreateEnum
CREATE TYPE "QuoteSource" AS ENUM ('supplier_agent', 'human');

-- CreateEnum
CREATE TYPE "OrderState" AS ENUM ('awaiting_supplier_acceptance', 'accepted', 'preparing', 'dispatched', 'delivered_awaiting_buyer_confirmation', 'completed', 'declined', 'cancelled', 'partially_fulfilled', 'issue_reported');

-- CreateEnum
CREATE TYPE "VerificationStatus" AS ENUM ('verified', 'unverified', 'pending', 'revoked', 'stale', 'unavailable', 'invalid');

-- CreateEnum
CREATE TYPE "OperatorType" AS ENUM ('supplier_owned', 'platform_operated', 'buyer_owned');

-- CreateEnum
CREATE TYPE "RunState" AS ENUM ('draft', 'needs_clarification', 'awaiting_publish_approval', 'requesting_quotes', 'awaiting_responses', 'verifying', 'comparing', 'awaiting_order_approval', 'completed', 'blocked', 'cancelled', 'failed');

-- CreateEnum
CREATE TYPE "PaymentState" AS ENUM ('intent', 'pending', 'confirmed', 'failed', 'unknown');

-- CreateEnum
CREATE TYPE "AuthTokenKind" AS ENUM ('email_verify', 'password_reset');

-- CreateEnum
CREATE TYPE "OutboxState" AS ENUM ('pending', 'processing', 'delivered', 'failed', 'dead');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailVerified" TIMESTAMP(3),
    "passwordHash" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'Africa/Lagos',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "csrfToken" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "AuthTokenKind" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuthToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoginAttempt" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "ip" TEXT NOT NULL,
    "success" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoginAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Organisation" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "environment" "Environment" NOT NULL,
    "capabilities" "Capability"[],
    "areaCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Organisation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Membership" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "OrgRole" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invitation" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "OrgRole" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierProfile" (
    "orgId" TEXT NOT NULL,
    "claimedLegalName" TEXT,
    "category" TEXT NOT NULL,
    "areaCode" TEXT NOT NULL,
    "shareContact" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplierProfile_pkey" PRIMARY KEY ("orgId")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "supplierOrgId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "packSizeScaled" BIGINT,
    "packSizeUnit" TEXT,
    "priceBasis" TEXT NOT NULL,
    "unitPriceMinor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryStatement" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "availableScaled" BIGINT NOT NULL,
    "reservedScaled" BIGINT NOT NULL DEFAULT 0,
    "statedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InventoryStatement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentRegistration" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "operatorType" "OperatorType" NOT NULL,
    "network" TEXT NOT NULL,
    "registry" TEXT NOT NULL,
    "tokenAddress" TEXT NOT NULL,
    "ownerAccount" TEXT NOT NULL,
    "cardUri" TEXT,
    "cardHashHex" TEXT,
    "orgAuthorityBoundAt" TIMESTAMP(3),
    "orgAuthorityBoundBy" TEXT,
    "ownerProofNonceUsed" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentRegistration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VerificationAttempt" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "status" "VerificationStatus" NOT NULL,
    "network" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "reasons" TEXT[],
    "chainRef" JSONB,
    "cardHashOk" BOOLEAN,
    "simulated" BOOLEAN NOT NULL DEFAULT false,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VerificationAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcurementRequest" (
    "id" TEXT NOT NULL,
    "buyerOrgId" TEXT NOT NULL,
    "environment" "Environment" NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "state" "RfqState" NOT NULL DEFAULT 'draft',
    "category" TEXT NOT NULL,
    "quantityScaled" BIGINT NOT NULL,
    "unit" TEXT NOT NULL,
    "budgetMinor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "deliverByUtc" TIMESTAMP(3) NOT NULL,
    "deliverTz" TEXT NOT NULL,
    "destinationHash" TEXT NOT NULL,
    "allowManualLane" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProcurementRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RequestRecipient" (
    "requestId" TEXT NOT NULL,
    "supplierOrgId" TEXT NOT NULL,
    "invitedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RequestRecipient_pkey" PRIMARY KEY ("requestId","supplierOrgId")
);

-- CreateTable
CREATE TABLE "Quote" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "supplierOrgId" TEXT NOT NULL,
    "state" "QuoteState" NOT NULL DEFAULT 'draft',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Quote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuoteVersion" (
    "id" TEXT NOT NULL,
    "quoteId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "source" "QuoteSource" NOT NULL,
    "authorUserId" TEXT NOT NULL,
    "agentId" TEXT,
    "currency" TEXT NOT NULL,
    "offeredScaled" BIGINT NOT NULL,
    "offeredUnit" TEXT NOT NULL,
    "unitPriceMinor" BIGINT NOT NULL,
    "goodsTotalMinor" BIGINT NOT NULL,
    "charges" JSONB NOT NULL,
    "validUntil" TIMESTAMP(3) NOT NULL,
    "deliveryPromisedBy" TIMESTAMP(3),
    "deliveryTz" TEXT,
    "paymentTerms" TEXT,
    "submittedAt" TIMESTAMP(3),

    CONSTRAINT "QuoteVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ComparisonRun" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "calculationVersion" TEXT NOT NULL,
    "sortedBy" TEXT NOT NULL,
    "input" JSONB NOT NULL,
    "result" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ComparisonRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Approval" (
    "id" TEXT NOT NULL,
    "buyerOrgId" TEXT NOT NULL,
    "approverUserId" TEXT NOT NULL,
    "supplierOrgId" TEXT NOT NULL,
    "quoteVersionId" TEXT NOT NULL,
    "totalMinor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "destinationHash" TEXT NOT NULL,
    "requestVersion" INTEGER NOT NULL,
    "intentId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Approval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "approvalId" TEXT NOT NULL,
    "buyerOrgId" TEXT NOT NULL,
    "supplierOrgId" TEXT NOT NULL,
    "state" "OrderState" NOT NULL DEFAULT 'awaiting_supplier_acceptance',
    "version" INTEGER NOT NULL DEFAULT 1,
    "snapshot" JSONB NOT NULL,
    "totalMinor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeliveryUpdate" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "party" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "quantityScaled" BIGINT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeliveryUpdate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Discrepancy" (
    "id" TEXT NOT NULL,
    "updateId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "buyerReport" JSONB,
    "supplierReport" JSONB,
    "resolution" JSONB,

    CONSTRAINT "Discrepancy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentRun" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "state" "RunState" NOT NULL DEFAULT 'draft',
    "version" INTEGER NOT NULL DEFAULT 1,
    "tokenBudget" INTEGER NOT NULL,
    "toolCallBudget" INTEGER NOT NULL,
    "costLimitMicros" BIGINT NOT NULL,
    "costUsedMicros" BIGINT NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ToolExecution" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "tool" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "input" JSONB NOT NULL,
    "outcome" JSONB,
    "status" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ToolExecution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServicePayment" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "asset" TEXT NOT NULL,
    "maxAmount" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "state" "PaymentState" NOT NULL DEFAULT 'intent',
    "txReference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ServicePayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "orgId" TEXT,
    "actorUserId" TEXT,
    "event" TEXT NOT NULL,
    "objectType" TEXT NOT NULL,
    "objectId" TEXT NOT NULL,
    "correlationId" TEXT NOT NULL,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboxEvent" (
    "id" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "state" "OutboxState" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Feedback" (
    "id" TEXT NOT NULL,
    "orgId" TEXT,
    "environment" "Environment" NOT NULL,
    "consent" BOOLEAN NOT NULL,
    "message" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Feedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnalyticsEvent" (
    "id" TEXT NOT NULL,
    "environment" "Environment" NOT NULL,
    "isInternal" BOOLEAN NOT NULL DEFAULT false,
    "isSeeded" BOOLEAN NOT NULL DEFAULT false,
    "name" TEXT NOT NULL,
    "orgId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnalyticsEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "AuthToken_tokenHash_key" ON "AuthToken"("tokenHash");

-- CreateIndex
CREATE INDEX "AuthToken_userId_kind_idx" ON "AuthToken"("userId", "kind");

-- CreateIndex
CREATE INDEX "LoginAttempt_email_createdAt_idx" ON "LoginAttempt"("email", "createdAt");

-- CreateIndex
CREATE INDEX "LoginAttempt_ip_createdAt_idx" ON "LoginAttempt"("ip", "createdAt");

-- CreateIndex
CREATE INDEX "Membership_userId_idx" ON "Membership"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Membership_orgId_userId_role_key" ON "Membership"("orgId", "userId", "role");

-- CreateIndex
CREATE UNIQUE INDEX "Invitation_tokenHash_key" ON "Invitation"("tokenHash");

-- CreateIndex
CREATE INDEX "Invitation_orgId_idx" ON "Invitation"("orgId");

-- CreateIndex
CREATE INDEX "Product_supplierOrgId_idx" ON "Product"("supplierOrgId");

-- CreateIndex
CREATE INDEX "InventoryStatement_productId_statedAt_idx" ON "InventoryStatement"("productId", "statedAt");

-- CreateIndex
CREATE INDEX "AgentRegistration_orgId_idx" ON "AgentRegistration"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentRegistration_network_tokenAddress_key" ON "AgentRegistration"("network", "tokenAddress");

-- CreateIndex
CREATE INDEX "VerificationAttempt_agentId_checkedAt_idx" ON "VerificationAttempt"("agentId", "checkedAt");

-- CreateIndex
CREATE INDEX "ProcurementRequest_buyerOrgId_state_idx" ON "ProcurementRequest"("buyerOrgId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "Quote_requestId_supplierOrgId_key" ON "Quote"("requestId", "supplierOrgId");

-- CreateIndex
CREATE UNIQUE INDEX "QuoteVersion_quoteId_version_key" ON "QuoteVersion"("quoteId", "version");

-- CreateIndex
CREATE INDEX "ComparisonRun_requestId_idx" ON "ComparisonRun"("requestId");

-- CreateIndex
CREATE UNIQUE INDEX "Approval_intentId_key" ON "Approval"("intentId");

-- CreateIndex
CREATE INDEX "Approval_buyerOrgId_idx" ON "Approval"("buyerOrgId");

-- CreateIndex
CREATE UNIQUE INDEX "Order_approvalId_key" ON "Order"("approvalId");

-- CreateIndex
CREATE INDEX "Order_buyerOrgId_idx" ON "Order"("buyerOrgId");

-- CreateIndex
CREATE INDEX "Order_supplierOrgId_idx" ON "Order"("supplierOrgId");

-- CreateIndex
CREATE INDEX "DeliveryUpdate_orderId_idx" ON "DeliveryUpdate"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "Discrepancy_updateId_key" ON "Discrepancy"("updateId");

-- CreateIndex
CREATE INDEX "AgentRun_orgId_state_idx" ON "AgentRun"("orgId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "ToolExecution_runId_idempotencyKey_key" ON "ToolExecution"("runId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "ServicePayment_idempotencyKey_key" ON "ServicePayment"("idempotencyKey");

-- CreateIndex
CREATE INDEX "AuditEvent_orgId_createdAt_idx" ON "AuditEvent"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "OutboxEvent_state_nextAttemptAt_idx" ON "OutboxEvent"("state", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "AnalyticsEvent_environment_name_createdAt_idx" ON "AnalyticsEvent"("environment", "name", "createdAt");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthToken" ADD CONSTRAINT "AuthToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierProfile" ADD CONSTRAINT "SupplierProfile_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_supplierOrgId_fkey" FOREIGN KEY ("supplierOrgId") REFERENCES "SupplierProfile"("orgId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryStatement" ADD CONSTRAINT "InventoryStatement_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VerificationAttempt" ADD CONSTRAINT "VerificationAttempt_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "AgentRegistration"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RequestRecipient" ADD CONSTRAINT "RequestRecipient_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "ProcurementRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "ProcurementRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuoteVersion" ADD CONSTRAINT "QuoteVersion_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Quote"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_approvalId_fkey" FOREIGN KEY ("approvalId") REFERENCES "Approval"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryUpdate" ADD CONSTRAINT "DeliveryUpdate_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Discrepancy" ADD CONSTRAINT "Discrepancy_updateId_fkey" FOREIGN KEY ("updateId") REFERENCES "DeliveryUpdate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ToolExecution" ADD CONSTRAINT "ToolExecution_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===== Hand-written integrity rules (not expressible in Prisma schema) =====
ALTER TABLE "InventoryStatement"
  ADD CONSTRAINT inventory_nonneg CHECK ("availableScaled" >= 0 AND "reservedScaled" >= 0),
  ADD CONSTRAINT inventory_no_oversell CHECK ("reservedScaled" <= "availableScaled");
ALTER TABLE "QuoteVersion"
  ADD CONSTRAINT quote_amounts_nonneg CHECK ("unitPriceMinor" >= 0 AND "goodsTotalMinor" >= 0 AND "offeredScaled" > 0);
ALTER TABLE "Approval" ADD CONSTRAINT approval_total_nonneg CHECK ("totalMinor" >= 0);
ALTER TABLE "Order" ADD CONSTRAINT order_total_nonneg CHECK ("totalMinor" >= 0);
ALTER TABLE "ProcurementRequest" ADD CONSTRAINT request_positive CHECK ("quantityScaled" > 0 AND "budgetMinor" >= 0);

-- A submitted quote version is immutable: edits must create a new version.
CREATE FUNCTION quote_version_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD."submittedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'QuoteVersion % is submitted and immutable', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER quote_version_no_update BEFORE UPDATE ON "QuoteVersion"
  FOR EACH ROW EXECUTE FUNCTION quote_version_immutable();
CREATE TRIGGER quote_version_no_delete BEFORE DELETE ON "QuoteVersion"
  FOR EACH ROW EXECUTE FUNCTION quote_version_immutable();

-- Audit events are append-only for the application role. This guards against application bugs;
-- it does NOT stop a database superuser from altering storage (see docs/audit-and-tamper-detection.md).
CREATE FUNCTION audit_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'AuditEvent is append-only' USING ERRCODE = 'restrict_violation';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER audit_no_update BEFORE UPDATE ON "AuditEvent" FOR EACH ROW EXECUTE FUNCTION audit_append_only();
CREATE TRIGGER audit_no_delete BEFORE DELETE ON "AuditEvent" FOR EACH ROW EXECUTE FUNCTION audit_append_only();
