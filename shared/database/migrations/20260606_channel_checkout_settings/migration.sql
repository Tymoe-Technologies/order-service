-- 添加结账方式枚举
CREATE TYPE "CheckoutMode" AS ENUM ('NORMAL', 'CREDIT_ACCOUNT');

-- 添加渠道准入模式枚举
CREATE TYPE "ChannelAccessMode" AS ENUM ('PUBLIC', 'MEMBER_ONLY');

-- 添加外卖平台枚举
CREATE TYPE "DeliveryPlatform" AS ENUM (
  'UBER_EATS',
  'DOORDASH',
  'SKIP_THE_DISHES',
  'GRUBHUB',
  'RITUAL',
  'FANTUAN',
  'OTHER_PLATFORM'
);

-- 为订单渠道表添加新字段
ALTER TABLE "order_source_configs"
  ADD COLUMN "is_system_channel" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "platform_type"     "DeliveryPlatform",
  ADD COLUMN "commission_rate"   DECIMAL(5,4),
  ADD COLUMN "access_mode"       "ChannelAccessMode" NOT NULL DEFAULT 'PUBLIC',
  ADD COLUMN "checkout_mode"     "CheckoutMode" NOT NULL DEFAULT 'NORMAL',
  ADD COLUMN "credit_config"     Json,
  ADD COLUMN "checkout_rules"    Json;

-- 添加系统渠道索引
CREATE INDEX "order_source_configs_tenant_id_is_system_channel_idx"
  ON "order_source_configs"("tenant_id", "is_system_channel");
