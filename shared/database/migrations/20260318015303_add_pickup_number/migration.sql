-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "pickup_number" INTEGER;

-- CreateIndex
CREATE INDEX "orders_tenant_id_pickup_number_idx" ON "orders"("tenant_id", "pickup_number");
