-- 拆出「谁负责配送」这个维度。只含本次改动需要的 DDL：
-- prisma db push 生成的 SQL 里还有三条**既存漂移**（merchant_fulfillment_options
-- 和 outbox_events 的 gen_random_uuid() 默认值被 DROP、order_items 上一个索引被删），
-- 那些是数据库和 schema 长期不同步造成的，不该由这次改动顺手带走。

CREATE TYPE "DeliveryProvider" AS ENUM ('MERCHANT', 'PLATFORM');

ALTER TABLE "orders" ADD COLUMN "delivery_provider" "DeliveryProvider";

-- 索引换定义：deliveryProvider 排最前（选择性最高，正是原来漏掉的过滤条件）
DROP INDEX "orders_order_type_delivery_confirmed_at_delivery_confirm_de_idx";
CREATE INDEX "orders_delivery_provider_order_type_delivery_confirmed_at_d_idx"
  ON "orders"("delivery_provider", "order_type", "delivery_confirmed_at", "delivery_confirm_deadline_at");
