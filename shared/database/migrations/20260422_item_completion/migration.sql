-- order_items 添加完成状态字段
CREATE TYPE "OrderItemStatus" AS ENUM ('PENDING', 'READY');

ALTER TABLE order_items ADD COLUMN status "OrderItemStatus" NOT NULL DEFAULT 'PENDING';
ALTER TABLE order_items ADD COLUMN completed_at TIMESTAMP(3);
ALTER TABLE order_items ADD COLUMN completed_by UUID;

-- 商家配置添加 item 完成开关
ALTER TABLE merchant_online_order_configs ADD COLUMN item_completion_enabled BOOLEAN NOT NULL DEFAULT FALSE;

-- 加索引，方便查询订单下所有 item 的状态
CREATE INDEX order_items_order_id_status_idx ON order_items (order_id, status);
