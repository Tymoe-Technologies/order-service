/*
  Warnings:

  - You are about to alter the column `cash_received` on the `orders` table. The data in that column could be lost. The data in that column will be cast from `Decimal(10,2)` to `Integer`.
  - You are about to alter the column `change_given` on the `orders` table. The data in that column could be lost. The data in that column will be cast from `Decimal(10,2)` to `Integer`.
  - Made the column `discount_amount` on table `order_items` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE "order_items" ALTER COLUMN "discount_amount" SET NOT NULL;

-- AlterTable
ALTER TABLE "orders" ALTER COLUMN "cash_received" SET DATA TYPE INTEGER,
ALTER COLUMN "change_given" SET DATA TYPE INTEGER;

-- CreateTable
CREATE TABLE "merchant_online_order_configs" (
    "id" UUID NOT NULL,
    "merchant_id" UUID NOT NULL,
    "subdomain" VARCHAR(50) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "allow_pickup" BOOLEAN NOT NULL DEFAULT true,
    "allow_dine_in" BOOLEAN NOT NULL DEFAULT true,
    "allow_delivery" BOOLEAN NOT NULL DEFAULT true,
    "business_hours" JSON,
    "min_order_amount" INTEGER,
    "delivery_fee" INTEGER,
    "delivery_radius" DECIMAL(10,2),
    "custom_domain" VARCHAR(255),
    "theme_settings" JSON,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "merchant_online_order_configs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "merchant_online_order_configs_merchant_id_key" ON "merchant_online_order_configs"("merchant_id");

-- CreateIndex
CREATE UNIQUE INDEX "merchant_online_order_configs_subdomain_key" ON "merchant_online_order_configs"("subdomain");

-- CreateIndex
CREATE INDEX "merchant_online_order_configs_merchant_id_idx" ON "merchant_online_order_configs"("merchant_id");

-- CreateIndex
CREATE INDEX "merchant_online_order_configs_subdomain_idx" ON "merchant_online_order_configs"("subdomain");

-- CreateIndex
CREATE INDEX "merchant_online_order_configs_enabled_idx" ON "merchant_online_order_configs"("enabled");

-- RenameIndex
ALTER INDEX "idx_orders_message_id" RENAME TO "orders_message_id_idx";
