-- 订单折扣明细
--
-- ## 修的是什么
-- 会员券和店员手动折扣**共用 discount_amount 一个数字**，只靠 discount_type
-- 标一个「优先级最高的那类」（POS 的 CheckoutScreen 注释里写明了）。后果：
--
--   1. **财务科目分发必然记错**：混合折扣时整笔都进 6300 LoyaltyDiscount
--      或整笔都进 6310 ManualDiscount，另一半的钱记在错的科目上
--   2. 叠加校验做不了 —— order-service 连「这单有没有手动折扣」都看不出来
--
-- 第 1 条是现在就在错的账，和叠加校验无关。
--
-- ## 口径
-- [{ source, amount, exclusive, ref?, reason? }]，金额单位分。
-- discount_amount 是这些行的合计；channel_discount_amount 一直是单独字段
-- （服务端自己算的，不信前端），不进这个列表。
--
-- 存量订单没有这个字段，读的时候不要假设它和 discount_amount 一定对得上。

ALTER TABLE "orders" ADD COLUMN "discount_lines" JSON;
