-- 添加取消原因枚举类型和字段
CREATE TYPE "CancellationReason" AS ENUM (
  'MERCHANT_REQUEST',
  'CUSTOMER_REQUEST',
  'OUT_OF_STOCK',
  'DUPLICATE_ORDER',
  'PAYMENT_FAILED',
  'SYSTEM_CANCEL'
);

ALTER TABLE orders ADD COLUMN cancellation_reason "CancellationReason";
