-- 添加 message_id 字段用于实现幂等性

-- 1. 添加 message_id 列（用于追踪 MQ 消息）
ALTER TABLE "orders"
ADD COLUMN "message_id" VARCHAR(255) UNIQUE;

-- 2. 创建索引以优化查询性能
CREATE INDEX "idx_orders_message_id" ON "orders"("message_id");

-- 说明：
-- message_id 用于存储来自 RabbitMQ 的 correlationId
-- 通过检查 message_id，可以实现幂等性处理：
-- - 如果消息重复到达，根据 message_id 识别并返回现有订单
-- - 避免创建重复订单
