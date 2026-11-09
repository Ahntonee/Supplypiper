/*
  Warnings:

  - Added the required column `requestId` to the `Approval` table without a default value. This is not possible if the table is not empty.
  - Added the required column `quoteVersionId` to the `Order` table without a default value. This is not possible if the table is not empty.
  - Added the required column `requestId` to the `Order` table without a default value. This is not possible if the table is not empty.
  - Added the required column `destinationAddress` to the `ProcurementRequest` table without a default value. This is not possible if the table is not empty.
  - Added the required column `destinationArea` to the `ProcurementRequest` table without a default value. This is not possible if the table is not empty.
  - Added the required column `category` to the `QuoteVersion` table without a default value. This is not possible if the table is not empty.
  - Added the required column `deliversToArea` to the `QuoteVersion` table without a default value. This is not possible if the table is not empty.
  - Added the required column `priceUnit` to the `QuoteVersion` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Approval" ADD COLUMN     "comparisonRunId" TEXT,
ADD COLUMN     "requestId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "quoteVersionId" TEXT NOT NULL,
ADD COLUMN     "requestId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "ProcurementRequest" ADD COLUMN     "destinationAddress" TEXT NOT NULL,
ADD COLUMN     "destinationArea" TEXT NOT NULL,
ADD COLUMN     "responseDeadline" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "QuoteVersion" ADD COLUMN     "category" TEXT NOT NULL,
ADD COLUMN     "deliversToArea" BOOLEAN NOT NULL,
ADD COLUMN     "priceUnit" TEXT NOT NULL,
ADD COLUMN     "productId" TEXT;

-- At most one live order per RFQ: a second approval/tab cannot create a second order.
-- A declined or cancelled order frees the RFQ for a new approval.
CREATE UNIQUE INDEX order_one_live_per_request ON "Order"("requestId") WHERE "state" NOT IN ('declined', 'cancelled');
