/*
  Warnings:

  - The `order_source` column on the `receipt_templates` table would be dropped and recreated. This will lead to data loss if there is data in the column.

*/
-- AlterTable
ALTER TABLE "receipt_templates" DROP COLUMN "order_source",
ADD COLUMN     "order_source" "OrderSource" NOT NULL DEFAULT 'POS';

-- CreateTable
CREATE TABLE "order_source_configs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "source_type" VARCHAR(50) NOT NULL,
    "source_name" VARCHAR(255) NOT NULL,
    "description" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "order_source_configs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "order_source_configs_tenant_id_is_active_idx" ON "order_source_configs"("tenant_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "order_source_configs_tenant_id_source_type_key" ON "order_source_configs"("tenant_id", "source_type");

-- CreateIndex
CREATE INDEX "receipt_templates_tenant_id_order_source_idx" ON "receipt_templates"("tenant_id", "order_source");
