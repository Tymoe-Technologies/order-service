-- 商家在线点单配置：添加会员功能开关
ALTER TABLE "merchant_online_order_configs" ADD COLUMN "member_enabled" BOOLEAN NOT NULL DEFAULT FALSE;
