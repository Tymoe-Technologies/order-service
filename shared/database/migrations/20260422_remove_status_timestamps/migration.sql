-- 删除冗余状态时间戳字段（由 order_status_history 表完整记录）
ALTER TABLE orders DROP COLUMN confirmed_at;
ALTER TABLE orders DROP COLUMN preparing_at;
ALTER TABLE orders DROP COLUMN ready_at;
ALTER TABLE orders DROP COLUMN picked_up_at;
ALTER TABLE orders DROP COLUMN delivered_at;
ALTER TABLE orders DROP COLUMN delivery_confirmed_at;
