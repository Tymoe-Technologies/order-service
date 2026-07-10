-- OrderAnalytics 系统维度升级：天气（强类型 + jsonb 留底）+ 本地时区时间维度
-- 历史行做回填：tenant_id 从 orders 取；时间维度按 UTC 回填（旧行无门店时区，标记 timezone='UTC'）

-- 1. 枚举类型
CREATE TYPE "WeatherCondition" AS ENUM (
  'CLEAR', 'PARTLY_CLOUDY', 'CLOUDY', 'FOG', 'DRIZZLE', 'RAIN',
  'FREEZING_RAIN', 'SNOW', 'SLEET', 'THUNDERSTORM', 'HAIL', 'WINDY', 'UNKNOWN'
);
CREATE TYPE "DayPart" AS ENUM (
  'LATE_NIGHT', 'EARLY_MORNING', 'MORNING', 'LUNCH', 'AFTERNOON', 'DINNER', 'NIGHT'
);

-- 2. tenant_id（先可空 → 回填 → 置非空）
ALTER TABLE "order_analytics" ADD COLUMN "tenant_id" UUID;
UPDATE "order_analytics" a SET "tenant_id" = o."tenant_id"
  FROM "orders" o WHERE o."id" = a."order_id";
ALTER TABLE "order_analytics" ALTER COLUMN "tenant_id" SET NOT NULL;

-- 3. 时间维度列（先可空）
ALTER TABLE "order_analytics" ADD COLUMN "local_time" TIMESTAMP(3);
ALTER TABLE "order_analytics" ADD COLUMN "timezone" VARCHAR(64);
ALTER TABLE "order_analytics" ADD COLUMN "year" INTEGER;
ALTER TABLE "order_analytics" ADD COLUMN "month" INTEGER;
ALTER TABLE "order_analytics" ADD COLUMN "day" INTEGER;
ALTER TABLE "order_analytics" ADD COLUMN "week_of_year" INTEGER;
ALTER TABLE "order_analytics" ADD COLUMN "is_weekend" BOOLEAN;
ALTER TABLE "order_analytics" ADD COLUMN "day_part" "DayPart";

-- 历史行按 UTC 回填（旧行无门店时区信息）
UPDATE "order_analytics" SET
  "local_time"   = "created_at",
  "timezone"     = 'UTC',
  "year"         = EXTRACT(YEAR  FROM "created_at")::int,
  "month"        = EXTRACT(MONTH FROM "created_at")::int,
  "day"          = EXTRACT(DAY   FROM "created_at")::int,
  "week_of_year" = EXTRACT(WEEK  FROM "created_at")::int,
  "is_weekend"   = (EXTRACT(DOW FROM "created_at")::int IN (0, 6)),
  "day_part"     = (CASE
      WHEN EXTRACT(HOUR FROM "created_at")::int < 5  THEN 'LATE_NIGHT'
      WHEN EXTRACT(HOUR FROM "created_at")::int < 8  THEN 'EARLY_MORNING'
      WHEN EXTRACT(HOUR FROM "created_at")::int < 11 THEN 'MORNING'
      WHEN EXTRACT(HOUR FROM "created_at")::int < 14 THEN 'LUNCH'
      WHEN EXTRACT(HOUR FROM "created_at")::int < 17 THEN 'AFTERNOON'
      WHEN EXTRACT(HOUR FROM "created_at")::int < 21 THEN 'DINNER'
      ELSE 'NIGHT'
    END)::"DayPart";

ALTER TABLE "order_analytics" ALTER COLUMN "local_time"   SET NOT NULL;
ALTER TABLE "order_analytics" ALTER COLUMN "timezone"     SET NOT NULL;
ALTER TABLE "order_analytics" ALTER COLUMN "year"         SET NOT NULL;
ALTER TABLE "order_analytics" ALTER COLUMN "month"        SET NOT NULL;
ALTER TABLE "order_analytics" ALTER COLUMN "day"          SET NOT NULL;
ALTER TABLE "order_analytics" ALTER COLUMN "week_of_year" SET NOT NULL;
ALTER TABLE "order_analytics" ALTER COLUMN "is_weekend"   SET NOT NULL;
ALTER TABLE "order_analytics" ALTER COLUMN "day_part"     SET NOT NULL;

-- 4. 天气维度：weather_condition 由 VARCHAR 改为枚举（旧值多为 NULL，直接重建列）
ALTER TABLE "order_analytics" DROP COLUMN "weather_condition";
ALTER TABLE "order_analytics" ADD COLUMN "weather_condition" "WeatherCondition";
-- weather_temp 已存在（DOUBLE PRECISION），保留
ALTER TABLE "order_analytics" ADD COLUMN "weather_feels_like" DOUBLE PRECISION;
ALTER TABLE "order_analytics" ADD COLUMN "weather_humidity"   INTEGER;
ALTER TABLE "order_analytics" ADD COLUMN "weather_precip_mm"  DOUBLE PRECISION;
ALTER TABLE "order_analytics" ADD COLUMN "weather_wind_kph"   DOUBLE PRECISION;
ALTER TABLE "order_analytics" ADD COLUMN "weather_cloud_pct"  INTEGER;
ALTER TABLE "order_analytics" ADD COLUMN "is_raining"         BOOLEAN;
ALTER TABLE "order_analytics" ADD COLUMN "weather_source"     VARCHAR(50);
ALTER TABLE "order_analytics" ADD COLUMN "weather_fetched_at" TIMESTAMP(3);
ALTER TABLE "order_analytics" ADD COLUMN "weather_raw"        JSONB;

-- 5. 日历维度
ALTER TABLE "order_analytics" ADD COLUMN "is_holiday"   BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "order_analytics" ADD COLUMN "holiday_name" VARCHAR(255);
-- event_name 已存在，保留

-- 6. 索引：移除旧单列索引，建立按门店的复合索引
DROP INDEX IF EXISTS "order_analytics_day_of_week_idx";
DROP INDEX IF EXISTS "order_analytics_hour_idx";
DROP INDEX IF EXISTS "order_analytics_weather_condition_idx";

CREATE INDEX "order_analytics_tenant_id_local_time_idx" ON "order_analytics"("tenant_id", "local_time");
CREATE INDEX "order_analytics_tenant_id_weather_condition_idx" ON "order_analytics"("tenant_id", "weather_condition");
CREATE INDEX "order_analytics_tenant_id_day_of_week_hour_idx" ON "order_analytics"("tenant_id", "day_of_week", "hour");
CREATE INDEX "order_analytics_tenant_id_is_holiday_idx" ON "order_analytics"("tenant_id", "is_holiday");
