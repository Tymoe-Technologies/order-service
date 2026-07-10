-- AlterTable: 添加经纬度坐标字段用于地图显示
ALTER TABLE "merchant_online_order_configs" ADD COLUMN "latitude" DECIMAL(10, 8);
ALTER TABLE "merchant_online_order_configs" ADD COLUMN "longitude" DECIMAL(11, 8);
