-- AlterTable: 添加门店基本信息字段
ALTER TABLE "merchant_online_order_configs" ADD COLUMN "store_name" VARCHAR(255);
ALTER TABLE "merchant_online_order_configs" ADD COLUMN "store_address" VARCHAR(500);
ALTER TABLE "merchant_online_order_configs" ADD COLUMN "store_phone" VARCHAR(20);
