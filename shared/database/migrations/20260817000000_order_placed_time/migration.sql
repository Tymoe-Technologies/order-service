-- 离线补传单的「实际下单时间」
--
-- created_at 从此表示**业务时间**（这一单什么时候下的），补传时由客户端带上原始时间覆盖；
-- received_at 记录服务端**实际收到**的时刻，只有补传单非空 —— 差值就是它离线了多久。
-- claimed_created_at 存「客户端报了但没通过时钟校验」的值，便于事后追溯。
--
-- 纯新增可空列，不改动既有数据，也不影响任何现有查询
-- （报表/筛选/对账读的都是 created_at，现在它对齐到业务时间反而更准）。
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "received_at" TIMESTAMP(3);
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "claimed_created_at" TIMESTAMP(3);

-- 「只看离线补传单」是排查时的高频查询，且这类行占比很低 —— 用部分索引，几乎不占空间
CREATE INDEX IF NOT EXISTS "orders_received_at_idx" ON "orders" ("tenant_id", "received_at")
  WHERE "received_at" IS NOT NULL;
