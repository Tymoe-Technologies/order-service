-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "member_id" UUID;

-- CreateTable
CREATE TABLE "order_item_modifiers" (
    "id" UUID NOT NULL,
    "order_item_id" UUID NOT NULL,
    "modifier_group_id" UUID NOT NULL,
    "modifier_option_id" UUID NOT NULL,
    "group_name" VARCHAR(255) NOT NULL,
    "option_name" VARCHAR(255) NOT NULL,
    "unit_price" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "order_item_modifiers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_analytics" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "day_of_week" INTEGER NOT NULL,
    "hour" INTEGER NOT NULL,
    "weather_temp" DOUBLE PRECISION,
    "weather_condition" VARCHAR(50),
    "event_name" VARCHAR(255),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_analytics_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "order_item_modifiers_order_item_id_idx" ON "order_item_modifiers"("order_item_id");

-- CreateIndex
CREATE INDEX "order_item_modifiers_modifier_option_id_idx" ON "order_item_modifiers"("modifier_option_id");

-- CreateIndex
CREATE INDEX "order_item_modifiers_modifier_group_id_idx" ON "order_item_modifiers"("modifier_group_id");

-- CreateIndex
CREATE UNIQUE INDEX "order_analytics_order_id_key" ON "order_analytics"("order_id");

-- CreateIndex
CREATE INDEX "order_analytics_day_of_week_idx" ON "order_analytics"("day_of_week");

-- CreateIndex
CREATE INDEX "order_analytics_hour_idx" ON "order_analytics"("hour");

-- CreateIndex
CREATE INDEX "order_analytics_weather_condition_idx" ON "order_analytics"("weather_condition");

-- CreateIndex
CREATE INDEX "orders_member_id_idx" ON "orders"("member_id");

-- AddForeignKey
ALTER TABLE "order_item_modifiers" ADD CONSTRAINT "order_item_modifiers_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_analytics" ADD CONSTRAINT "order_analytics_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
