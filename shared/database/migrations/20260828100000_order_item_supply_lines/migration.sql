-- 耗材订单行：让餐具/购物袋/打包费能作为独立订单行入库
--
-- 为什么不新开一张表、也不在 Order 上加一个 supply_fee 汇总字段：
-- 耗材做成 OrderItem 行之后，小票打印、单独退款、销量与成本统计、税额计算
-- 全部复用商品行既有逻辑，不用在十几处聚合查询里加分支。代价只是多一个判别字段。
--
-- 存量数据：line_kind 默认 PRODUCT，老订单行为完全不变。

-- CreateEnum
CREATE TYPE "OrderLineKind" AS ENUM ('PRODUCT', 'SUPPLY');

-- AlterTable
ALTER TABLE "order_items"
    ADD COLUMN "line_kind" "OrderLineKind" NOT NULL DEFAULT 'PRODUCT',
    -- AUTO = 系统按规则自动加的，SELECTED = 顾客自己勾的。
    -- 客服处理「我没点这个为什么收我钱」时要能一眼分辨，商品行恒为 NULL。
    ADD COLUMN "supply_origin" VARCHAR(20);

-- CreateIndex：按行类型筛选（报表要分开算商品销售额和耗材收入）
CREATE INDEX "order_items_order_id_line_kind_idx" ON "order_items"("order_id", "line_kind");
