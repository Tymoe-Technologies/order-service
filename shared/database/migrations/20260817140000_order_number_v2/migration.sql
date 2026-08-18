-- 订单号改成门店内唯一 + 客户端号留痕
--
-- 唯一性范围从「全局」收到「门店内」：全局唯一由 id（UUIDv7）承担。
-- 这样订单号里不用再塞门店码 —— 那 4 位对店员是纯噪音，只为撑全局唯一而存在。
-- 老订单号本来就全局唯一，换成复合唯一一样成立，**不用改数据**。
--
-- claimed_order_number：客户端给的号撞了、服务端改用自己发的号时留痕。
-- 顾客小票上印的是那个号，拿来查单要能对上。
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "claimed_order_number" VARCHAR(50);

-- 先建新索引再删旧的：中间任何时刻都有唯一性保护，不留窗口
CREATE UNIQUE INDEX IF NOT EXISTS "orders_tenant_id_order_number_key" ON "orders" ("tenant_id", "order_number");
DROP INDEX IF EXISTS "orders_order_number_key";
