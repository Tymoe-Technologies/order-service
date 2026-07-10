-- CreateEnum
CREATE TYPE "OrderSource" AS ENUM ('POS', 'WEB', 'KIOSK');

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "order_source" "OrderSource" NOT NULL DEFAULT 'POS';

-- CreateIndex
CREATE INDEX "orders_order_source_idx" ON "orders"("order_source");
