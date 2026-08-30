-- 索引改名，对齐 Prisma 的命名约定。纯改名：不动数据、不重建、不影响查询计划。
-- 这几个名字是早期迁移留下的，和现在 Prisma 期望的名字对不上，
-- 于是每次 migrate diff 都会冒出来，把真正的差异淹掉。
ALTER INDEX "merchant_fulfillment_options_merchant_enabled_idx" RENAME TO "merchant_fulfillment_options_merchant_id_enabled_idx";
ALTER INDEX "merchant_fulfillment_options_merchant_type_key" RENAME TO "merchant_fulfillment_options_merchant_id_fulfillment_type_key";
ALTER INDEX "outbox_events_aggregate_idx" RENAME TO "outbox_events_aggregate_id_idx";
ALTER INDEX "outbox_events_pending_idx" RENAME TO "outbox_events_published_at_next_attempt_at_created_at_idx";
