-- 回填修复前落成 PRODUCT 的耗材行（2026-09-10）
--
-- `lineKind='SUPPLY'` 那个修复之前，POS 建单把耗材（餐具/购物袋/打包费）
-- 也写成 PRODUCT。修复后新单都对了，但历史行还留在库里 ——
-- 后果是**热销榜上有一行「Bag」**（实测 09-01 那一单）。
--
-- 判据：同一个 item_id 在别的行上已经是 SUPPLY。
-- 为什么不按名字：名字是商家起的，会重名也会改。
-- 为什么不 join supplies 表：那张表在 item-management，本库没有 ——
-- 而「这个 item_id 是耗材」这件事，本库自己的数据就能证明。
--
-- 只改 line_kind，不动金额：那笔钱确实收了，报表的「按商品」口径
-- 靠 line_kind 过滤，改这一个字段就够。

UPDATE order_items oi
   SET line_kind = 'SUPPLY'
 WHERE oi.line_kind = 'PRODUCT'
   AND EXISTS (
     SELECT 1 FROM order_items ref
      WHERE ref.item_id = oi.item_id
        AND ref.line_kind = 'SUPPLY'
   );
