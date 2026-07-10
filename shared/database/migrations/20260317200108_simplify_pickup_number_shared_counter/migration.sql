-- DropIndex
DROP INDEX "pickup_number_configs_tenant_id_order_source_key";

-- AlterTable
ALTER TABLE "pickup_counters" DROP CONSTRAINT "pickup_counters_pkey",
DROP COLUMN "order_source",
ADD CONSTRAINT "pickup_counters_pkey" PRIMARY KEY ("tenant_id", "date");

-- AlterTable
ALTER TABLE "pickup_number_configs" DROP COLUMN "order_source",
ADD COLUMN     "show_prefix" BOOLEAN NOT NULL DEFAULT true;

-- CreateIndex
CREATE UNIQUE INDEX "pickup_number_configs_tenant_id_key" ON "pickup_number_configs"("tenant_id");

