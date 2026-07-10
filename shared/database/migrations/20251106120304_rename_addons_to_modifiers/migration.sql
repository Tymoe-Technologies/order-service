-- AlterTable
-- 重命名 addons 列为 modifiers（保留现有数据）
ALTER TABLE "order_items" RENAME COLUMN "addons" TO "modifiers";

-- 添加注释说明
COMMENT ON COLUMN "order_items"."modifiers" IS '商品修饰符（Modifiers）- 替代旧的 addons 字段';

