-- 履约方式体系化：从三个布尔列换成可扩展的配置表，并补齐 CURBSIDE / DRIVE_THRU
--
-- 背景：
--   1. MerchantOnlineOrderConfig 用 allow_pickup / allow_dine_in / allow_delivery
--      三个布尔列表示门店支持哪些方式。每加一种就要加一列，还要连带改 validator、
--      DTO、前端类型。curbside、drive-thru、自提柜这些加不进来。
--   2. 这三个开关虽然有完整的读写 API，但**没有任何前端读过**——顾客端的
--      选择器硬编码三个选项，商家关掉堂食也没用。
--   3. POS 下单硬编码 DINE_IN，所以库里的 DINE_IN 不代表真的堂食。
--      本迁移不动历史数据（改了反而丢失「这单来自 POS」这个唯一确定的事实）。
--
-- 新增两种履约方式的业务判断安全性：现有逻辑（叫号屏、自动接单、Uber 配送、
-- 配送确认）全部写成「是不是 DELIVERY」，所以 CURBSIDE/DRIVE_THRU 会自动
-- 获得自取类行为，语义正确，无需改动那些分支。

-- ── 枚举扩展 ────────────────────────────────────────────────────
-- Postgres 不允许在事务里 ADD VALUE 后立刻使用，这里只加值，回填走下面的 INSERT
ALTER TYPE "OrderType" ADD VALUE IF NOT EXISTS 'CURBSIDE';
ALTER TYPE "OrderType" ADD VALUE IF NOT EXISTS 'DRIVE_THRU';

-- CURBSIDE 需要一个「顾客已到店」的状态：顾客在车里点「我到了」，
-- 店员据此送餐出去。没有这个状态，READY 之后就断了。
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'CUSTOMER_ARRIVED';

-- ── 订单上的 curbside 字段 ──────────────────────────────────────
ALTER TABLE "orders"
    ADD COLUMN IF NOT EXISTS "vehicle_info" JSON,
    ADD COLUMN IF NOT EXISTS "arrived_at" TIMESTAMP(3);

ALTER TABLE "checkout_snapshots"
    ADD COLUMN IF NOT EXISTS "vehicle_info" JSON;

-- ── 履约方式配置表 ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "merchant_fulfillment_options" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "merchant_id" UUID NOT NULL,
    "fulfillment_type" "OrderType" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "config" JSON,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "merchant_fulfillment_options_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "merchant_fulfillment_options_merchant_type_key"
    ON "merchant_fulfillment_options"("merchant_id", "fulfillment_type");

CREATE INDEX IF NOT EXISTS "merchant_fulfillment_options_merchant_enabled_idx"
    ON "merchant_fulfillment_options"("merchant_id", "enabled");
