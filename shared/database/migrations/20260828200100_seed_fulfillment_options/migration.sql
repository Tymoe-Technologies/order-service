-- 把存量的 allow_pickup / allow_dine_in / allow_delivery 搬进 merchant_fulfillment_options
--
-- 单独一个迁移文件是因为上一个刚 ALTER TYPE ADD VALUE，Postgres 不允许在同一事务里
-- 使用新加的枚举值。这里只用三个旧值（TAKEOUT/DINE_IN/DELIVERY），但拆开更保险。
--
-- 映射：allow_pickup → TAKEOUT。「自取」在 OrderType 里对应的就是 TAKEOUT，
-- consumer-app 的 pickup 也是这么映射的（checkout/page.tsx: pickup ? 'TAKEOUT' : 'DELIVERY'）。
--
-- CURBSIDE / DRIVE_THRU 不预置成 enabled：它们是新能力，商家没主动开就不该出现在
-- 顾客端。预置成 false 的行也不插——查询侧「查不到 = 未启用」，插一堆 false 只是噪音。

INSERT INTO "merchant_fulfillment_options" ("merchant_id", "fulfillment_type", "enabled", "display_order")
SELECT "merchant_id", 'TAKEOUT'::"OrderType", COALESCE("allow_pickup", true), 0
FROM "merchant_online_order_configs"
ON CONFLICT ("merchant_id", "fulfillment_type") DO NOTHING;

INSERT INTO "merchant_fulfillment_options" ("merchant_id", "fulfillment_type", "enabled", "display_order")
SELECT "merchant_id", 'DINE_IN'::"OrderType", COALESCE("allow_dine_in", true), 1
FROM "merchant_online_order_configs"
ON CONFLICT ("merchant_id", "fulfillment_type") DO NOTHING;

INSERT INTO "merchant_fulfillment_options" ("merchant_id", "fulfillment_type", "enabled", "display_order")
SELECT "merchant_id", 'DELIVERY'::"OrderType", COALESCE("allow_delivery", true), 2
FROM "merchant_online_order_configs"
ON CONFLICT ("merchant_id", "fulfillment_type") DO NOTHING;
