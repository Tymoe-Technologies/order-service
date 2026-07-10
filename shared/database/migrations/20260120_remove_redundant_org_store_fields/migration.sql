-- RemoveColumn: 删除冗余的组织和门店信息字段
-- 这些字段应该从 Auth Service 动态获取，而不是在 Order Service 中冗余存储

-- 删除组织信息字段（来自 Auth Service）
ALTER TABLE "merchant_online_order_configs" DROP COLUMN IF EXISTS "org_name";
ALTER TABLE "merchant_online_order_configs" DROP COLUMN IF EXISTS "location";
ALTER TABLE "merchant_online_order_configs" DROP COLUMN IF EXISTS "latitude";
ALTER TABLE "merchant_online_order_configs" DROP COLUMN IF EXISTS "longitude";
ALTER TABLE "merchant_online_order_configs" DROP COLUMN IF EXISTS "phone";
ALTER TABLE "merchant_online_order_configs" DROP COLUMN IF EXISTS "email";

-- 删除门店信息字段（来自 Auth Service）
ALTER TABLE "merchant_online_order_configs" DROP COLUMN IF EXISTS "store_name";
ALTER TABLE "merchant_online_order_configs" DROP COLUMN IF EXISTS "store_address";
ALTER TABLE "merchant_online_order_configs" DROP COLUMN IF EXISTS "store_phone";
