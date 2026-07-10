-- AlterTable: 添加 parent_merchant_id 字段支持分店引用主店配置
ALTER TABLE "merchant_online_order_configs" ADD COLUMN "parent_merchant_id" UUID;

-- 删除原有的 subdomain 唯一约束，因为分店也可能有相同的 subdomain（继承自主店）
DROP INDEX IF EXISTS "merchant_online_order_configs_subdomain_key";

-- CreateIndex: 为 parent_merchant_id 添加索引
CREATE INDEX "merchant_online_order_configs_parent_merchant_id_idx" ON "merchant_online_order_configs"("parent_merchant_id");

-- CreateIndex: 保留 subdomain 索引但不要求唯一
CREATE INDEX "merchant_online_order_configs_subdomain_idx_new" ON "merchant_online_order_configs"("subdomain");

-- CreateIndex: 添加复合唯一约束（同一主店下的分店）
CREATE UNIQUE INDEX "merchant_online_order_configs_parent_merchant_id_merchant_id_key" ON "merchant_online_order_configs"("parent_merchant_id", "merchant_id");
