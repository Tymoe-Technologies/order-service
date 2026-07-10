-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('UNPAID', 'PAID', 'PARTIALLY_PAID', 'REFUNDING', 'REFUNDED', 'FAILED');

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "delivery_fee" DECIMAL(10,2) NOT NULL DEFAULT 0,
ADD COLUMN     "discount_code" VARCHAR(100),
ADD COLUMN     "discount_reason" VARCHAR(255),
ADD COLUMN     "discount_type" VARCHAR(50),
ADD COLUMN     "paid_at" TIMESTAMP(3),
ADD COLUMN     "payment_method" VARCHAR(50),
ADD COLUMN     "payment_status" "PaymentStatus" NOT NULL DEFAULT 'UNPAID',
ADD COLUMN     "platform_fee" DECIMAL(10,2) NOT NULL DEFAULT 0,
ADD COLUMN     "service_fee" DECIMAL(10,2) NOT NULL DEFAULT 0,
ADD COLUMN     "settled_at" TIMESTAMP(3),
ADD COLUMN     "settlement_batch" VARCHAR(100),
ADD COLUMN     "settlement_status" VARCHAR(50) DEFAULT 'PENDING',
ADD COLUMN     "tip_amount" DECIMAL(10,2) NOT NULL DEFAULT 0,
ADD COLUMN     "transaction_id" VARCHAR(255);

-- CreateIndex
CREATE INDEX "orders_payment_status_idx" ON "orders"("payment_status");

-- CreateIndex
CREATE INDEX "orders_settlement_status_idx" ON "orders"("settlement_status");
