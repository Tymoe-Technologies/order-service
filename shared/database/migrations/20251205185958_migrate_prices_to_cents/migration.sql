-- 迁移价格单位：从元（Decimal）到分（Integer）
-- 所有现有数据将乘以 100 转换为分

-- 1. 修改 orders 表的价格字段
ALTER TABLE "orders" 
  ALTER COLUMN "subtotal" TYPE INTEGER USING (COALESCE(subtotal, 0) * 100)::INTEGER,
  ALTER COLUMN "tax_amount" TYPE INTEGER USING (COALESCE(tax_amount, 0) * 100)::INTEGER,
  ALTER COLUMN "discount_amount" TYPE INTEGER USING (COALESCE(discount_amount, 0) * 100)::INTEGER,
  ALTER COLUMN "service_fee" TYPE INTEGER USING (COALESCE(service_fee, 0) * 100)::INTEGER,
  ALTER COLUMN "delivery_fee" TYPE INTEGER USING (COALESCE(delivery_fee, 0) * 100)::INTEGER,
  ALTER COLUMN "platform_fee" TYPE INTEGER USING (COALESCE(platform_fee, 0) * 100)::INTEGER,
  ALTER COLUMN "tip_amount" TYPE INTEGER USING (COALESCE(tip_amount, 0) * 100)::INTEGER,
  ALTER COLUMN "total_amount" TYPE INTEGER USING (total_amount * 100)::INTEGER;

-- 1.1 修改现金支付相关字段(如果存在)
DO $$ 
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'orders' AND column_name = 'cash_received') THEN
    ALTER TABLE "orders" ALTER COLUMN "cash_received" TYPE INTEGER USING (COALESCE(cash_received, 0) * 100)::INTEGER;
  END IF;
  
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'orders' AND column_name = 'change_given') THEN
    ALTER TABLE "orders" ALTER COLUMN "change_given" TYPE INTEGER USING (COALESCE(change_given, 0) * 100)::INTEGER;
  END IF;
END $$;

-- 2. 修改 order_items 表的价格字段
ALTER TABLE "order_items"
  ALTER COLUMN "unit_price" TYPE INTEGER USING (unit_price * 100)::INTEGER,
  ALTER COLUMN "total_price" TYPE INTEGER USING (total_price * 100)::INTEGER,
  ALTER COLUMN "discount_amount" TYPE INTEGER USING (COALESCE(discount_amount, 0) * 100)::INTEGER;

-- 3. 设置默认值
ALTER TABLE "orders"
  ALTER COLUMN "subtotal" SET DEFAULT 0,
  ALTER COLUMN "tax_amount" SET DEFAULT 0,
  ALTER COLUMN "discount_amount" SET DEFAULT 0,
  ALTER COLUMN "service_fee" SET DEFAULT 0,
  ALTER COLUMN "delivery_fee" SET DEFAULT 0,
  ALTER COLUMN "platform_fee" SET DEFAULT 0,
  ALTER COLUMN "tip_amount" SET DEFAULT 0;

ALTER TABLE "order_items"
  ALTER COLUMN "discount_amount" SET DEFAULT 0;




