-- 添加 order_source 字段到 receipt_templates 表
ALTER TABLE "receipt_templates" 
ADD COLUMN "order_source" VARCHAR(10) NOT NULL DEFAULT 'POS';

-- 创建索引
CREATE INDEX "receipt_templates_tenant_id_order_source_idx" 
ON "receipt_templates"("tenant_id", "order_source");

-- 添加注释
COMMENT ON COLUMN "receipt_templates"."order_source" IS '订单来源: POS, KIOSK, WEB';
