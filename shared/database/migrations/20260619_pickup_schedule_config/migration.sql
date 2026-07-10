-- 自取预约配置字段
ALTER TABLE "merchant_online_order_configs"
  ADD COLUMN IF NOT EXISTS "allow_pickup_schedule" BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS "pickup_lead_minutes"   INTEGER NOT NULL DEFAULT 15,
  ADD COLUMN IF NOT EXISTS "pickup_slot_interval"  INTEGER NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS "pickup_advance_days"   INTEGER NOT NULL DEFAULT 0;
