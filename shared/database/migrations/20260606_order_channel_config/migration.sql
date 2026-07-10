-- 订单关联渠道配置（记账和渠道折扣报表用）
ALTER TABLE "orders"
  ADD COLUMN "channel_config_id"       UUID,
  ADD COLUMN "channel_discount_amount" INT NOT NULL DEFAULT 0;

-- 同时在 paymentMethod 文档层面支持 'ACCOUNT' 值（String 字段，无需改枚举）

CREATE INDEX "orders_channel_config_id_idx" ON "orders"("channel_config_id");
