-- 备餐站与打印路由（PrintStation / PrintRoute / PrinterAssignment）
-- 设计见 POS 仓库 docs/architecture/PRINT_ARCHITECTURE.md
--
-- 手写而不是 db push 的理由见本目录 README。本次 `prisma migrate diff` 输出干净
-- （只有下面这些语句，没有夹带 DROP），但仍按规矩留档 —— 下一个人要复现这次变更
-- 靠的是这个文件，不是我当时看了眼 diff。
--
-- 跑法：
--   export $(grep -h '^ORDER_DATABASE_URL' .env | head -1 | sed 's/"//g')
--   psql "$ORDER_DATABASE_URL" -f migrations-manual/print-station-routing.sql

BEGIN;

-- CreateEnum
CREATE TYPE "RouteMatchType" AS ENUM ('ITEM', 'CATEGORY');

-- AlterTable
ALTER TABLE "print_tasks" ADD COLUMN     "client_task_id" VARCHAR(64),
ADD COLUMN     "station_id" UUID;

-- AlterTable
ALTER TABLE "order_items" ADD COLUMN     "category_id" UUID;

-- CreateTable
CREATE TABLE "print_stations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "config" JSON,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "print_stations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "print_routes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "station_id" UUID NOT NULL,
    "match_type" "RouteMatchType" NOT NULL,
    "match_id" UUID NOT NULL,
    "role" VARCHAR(16) NOT NULL DEFAULT 'PRIMARY',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "print_routes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "printer_assignments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "scope" VARCHAR(80) NOT NULL,
    "device_id" VARCHAR(255) NOT NULL,
    "fallback_device_id" VARCHAR(255),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "printer_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "print_stations_tenant_id_idx" ON "print_stations"("tenant_id");

-- CreateIndex
CREATE INDEX "print_routes_tenant_id_match_type_match_id_idx" ON "print_routes"("tenant_id", "match_type", "match_id");

-- CreateIndex
CREATE UNIQUE INDEX "print_routes_tenant_id_match_type_match_id_station_id_key" ON "print_routes"("tenant_id", "match_type", "match_id", "station_id");

-- CreateIndex
CREATE INDEX "printer_assignments_tenant_id_idx" ON "printer_assignments"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "printer_assignments_tenant_id_scope_key" ON "printer_assignments"("tenant_id", "scope");

-- CreateIndex
CREATE INDEX "print_tasks_tenant_id_station_id_idx" ON "print_tasks"("tenant_id", "station_id");

-- CreateIndex
CREATE UNIQUE INDEX "print_tasks_tenant_id_client_task_id_key" ON "print_tasks"("tenant_id", "client_task_id");

-- AddForeignKey
ALTER TABLE "print_routes" ADD CONSTRAINT "print_routes_station_id_fkey" FOREIGN KEY ("station_id") REFERENCES "print_stations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ========== 数据迁移 ==========
-- 已经在用厨房单的租户，各建一个兜底站「厨房」。
--
-- 不建的话，升级后这些租户所有商品都路由不到站，厨房单会**静默消失** ——
-- 而现在的行为是全单一张，必须等价平移过去：一个兜底站 + 零条路由规则
-- = 所有商品都进这个站 = 还是全单一张。
--
-- 打印机归属（printer_assignments）不在这里迁：现在的绑定存在 POS 本地
-- （printerBindingService），库里没有对应记录可搬。分发端对「没有归属记录」
-- 保留广播兜底，等 POS 设置界面（Phase C）把归属登记上来再切定向。
INSERT INTO "print_stations" ("tenant_id", "name", "is_default", "sort_order")
SELECT DISTINCT "tenant_id", '厨房', true, 0
  FROM "print_settings"
 WHERE "ticket_type" = 'KITCHEN_TICKET' AND "is_enabled" = true;

COMMIT;
