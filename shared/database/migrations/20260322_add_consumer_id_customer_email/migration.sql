-- 订单表：添加 consumerId（用户身份关联）和 customerEmail（联系信息快照）
ALTER TABLE "orders" ADD COLUMN "consumer_id" UUID;
ALTER TABLE "orders" ADD COLUMN "customer_email" VARCHAR(255);

-- 索引：支撑"我的订单"查询
CREATE INDEX "orders_consumer_id_idx" ON "orders"("consumer_id");

-- 结账快照表：添加 consumerId
ALTER TABLE "checkout_snapshots" ADD COLUMN "consumer_id" UUID;
