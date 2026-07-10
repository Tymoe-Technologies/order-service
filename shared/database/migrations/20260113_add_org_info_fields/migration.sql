-- AlterTable: 添加组织基本信息字段
ALTER TABLE "merchant_online_order_configs" ADD COLUMN "org_name" VARCHAR(255);
ALTER TABLE "merchant_online_order_configs" ADD COLUMN "location" VARCHAR(500);
ALTER TABLE "merchant_online_order_configs" ADD COLUMN "phone" VARCHAR(50);
ALTER TABLE "merchant_online_order_configs" ADD COLUMN "email" VARCHAR(255);
