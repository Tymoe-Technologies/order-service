-- 配送费计税：补上一直漏收的销项税，并为进项税（ITC）预留字段
--
-- 背景：deliveryFee 从下单到入账全程没进过任何计税逻辑
--   baseTotal = discountedSubtotal + supplySubtotal + taxAmount + tipAmount + deliveryFee
--                                                     ↑ 只含商品+耗材      ↑ 裸加
--
-- 为什么这笔税是商家的责任：用的是 Uber Direct（白标派送），顾客在商家自有渠道
-- 下单、钱进商家的 Stripe 账户，商家是 Merchant of Record。这跟 Uber Eats 平台单
-- 不同——那种是 Uber 作为 marketplace facilitator 代收代缴。
-- 顺带一提，Uber 官方的《Canada Tax FAQs for Stores》只覆盖 Uber Eats，
-- 明确不涉及 Uber Direct 和商家自有渠道收的配送费。
--
-- 税率口径：跟随所配送的商品，按商品行金额加权分摊（混合税率订单自动正确）。
-- 计税基数是 deliveryFee 而不是 uberDeliveryFee —— 前者已扣商家补贴，
-- 只有顾客自掏腰包的部分才向顾客收税。
--
-- 存量订单不回填：过去的单没收这笔税，补记会让账面税额和实收对不上。
-- 要处理历史欠税得走会计的更正申报，不是数据库能解决的。

ALTER TABLE "orders"
    -- 销项：向顾客收的配送费税，已包含在 tax_amount 内，单列供对账拆分
    ADD COLUMN IF NOT EXISTS "delivery_fee_tax" INTEGER NOT NULL DEFAULT 0,
    -- 进项：Uber 收商家的那笔里含的税，可做 ITC 抵扣。
    -- 可空是因为现在填不了——Uber Direct 报价接口只给费用总额，不给税额明细，
    -- 留给月度发票对账回填。
    ADD COLUMN IF NOT EXISTS "uber_delivery_fee_tax" INTEGER;
