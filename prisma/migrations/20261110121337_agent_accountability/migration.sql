/*
  Warnings:

  - Added the required column `registeredByUserId` to the `AgentRegistration` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "AgentRegistration" ADD COLUMN     "orgAuthorityOwnerAccount" TEXT,
ADD COLUMN     "ownerProofUserId" TEXT,
ADD COLUMN     "ownerProvedAt" TIMESTAMP(3),
ADD COLUMN     "registeredByUserId" TEXT NOT NULL,
ALTER COLUMN "ownerAccount" DROP NOT NULL;

-- CreateTable
CREATE TABLE "OwnershipChallenge" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "tokenAddress" TEXT NOT NULL,
    "nonceHash" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OwnershipChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OwnershipChallenge_nonceHash_key" ON "OwnershipChallenge"("nonceHash");

-- CreateIndex
CREATE INDEX "OwnershipChallenge_agentId_createdAt_idx" ON "OwnershipChallenge"("agentId", "createdAt");

-- Authority over an agent can only exist once its owner has been proven by a wallet signature.
ALTER TABLE "AgentRegistration" ADD CONSTRAINT agent_authority_needs_proven_owner
  CHECK ("orgAuthorityBoundAt" IS NULL OR ("ownerAccount" IS NOT NULL AND "ownerProvedAt" IS NOT NULL));
