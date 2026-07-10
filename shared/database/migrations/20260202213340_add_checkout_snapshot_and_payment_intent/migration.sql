/*
  Warnings:

  - A unique constraint covering the columns `[payment_intent_id]` on the table `orders` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "payment_intent_id" VARCHAR(255);

-- CreateTable
CREATE TABLE "checkout_snapshots" (
    "id" UUID NOT NULL,
    "merchant_id" UUID NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    "order_type" "OrderType" NOT NULL,
    "customer_name" VARCHAR(255) NOT NULL,
    "customer_phone" VARCHAR(50) NOT NULL,
    "customer_email" VARCHAR(255),
    "items" JSON NOT NULL,
    "pricing" JSON NOT NULL,
    "notes" TEXT,
    "payment_intent_id" VARCHAR(255),
    "order_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "checkout_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "checkout_snapshots_payment_intent_id_key" ON "checkout_snapshots"("payment_intent_id");

-- CreateIndex
CREATE UNIQUE INDEX "checkout_snapshots_order_id_key" ON "checkout_snapshots"("order_id");

-- CreateIndex
CREATE INDEX "checkout_snapshots_merchant_id_status_idx" ON "checkout_snapshots"("merchant_id", "status");

-- CreateIndex
CREATE INDEX "checkout_snapshots_status_expires_at_idx" ON "checkout_snapshots"("status", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "orders_payment_intent_id_key" ON "orders"("payment_intent_id");

-- RenameIndex
ALTER INDEX "merchant_online_order_configs_parent_merchant_id_merchant_id_ke" RENAME TO "merchant_online_order_configs_parent_merchant_id_merchant_i_key";
