-- 订单落一份按税种拆开的税额快照（2026-09-10）
--
-- 原来订单只有 tax_amount 合计，日结单没法按 GST/PST 分行 ——
-- 而加拿大申报要按税种分别填。POS 一直算得出这份明细
-- （utils/taxCalculation 的 taxBreakdown），只是建单时没发出来。
--
-- 形状：[{ "name": "GST", "rate": 0.05, "amount": 495 }]，amount 单位分。
-- 快照而不是关联税率表：税率会调，历史单必须保持开票当时的样子。
-- 可空：存量订单没有，报表退回只印合计那一行。

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS tax_lines JSON;
