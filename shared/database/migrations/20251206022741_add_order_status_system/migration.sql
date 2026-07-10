-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "OrderStatus" ADD VALUE 'PICKED_UP';
ALTER TYPE "OrderStatus" ADD VALUE 'OUT_FOR_DELIVERY';
ALTER TYPE "OrderStatus" ADD VALUE 'DELIVERED';

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "cancelled_at" TIMESTAMP(3),
ADD COLUMN     "completed_at" TIMESTAMP(3),
ADD COLUMN     "confirmed_at" TIMESTAMP(3),
ADD COLUMN     "delivered_at" TIMESTAMP(3),
ADD COLUMN     "picked_up_at" TIMESTAMP(3),
ADD COLUMN     "preparing_at" TIMESTAMP(3),
ADD COLUMN     "ready_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "order_status_history" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "from_status" "OrderStatus" NOT NULL,
    "to_status" "OrderStatus" NOT NULL,
    "reason" TEXT,
    "changed_by" UUID,
    "changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "order_status_history_order_id_changed_at_idx" ON "order_status_history"("order_id", "changed_at");

-- AddForeignKey
ALTER TABLE "order_status_history" ADD CONSTRAINT "order_status_history_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
