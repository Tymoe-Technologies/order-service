-- 开这一单的 POS 设备码。
--
-- 用来判断「这单的某张票，下单那台机自己能不能打」：能就本地打，
-- 不能就生成任务定向推给负责的设备（见 print-task-ownership.ts）。
-- 没有它的话服务端分不出是哪台机开的单 —— 订单号中段的 P01/P02
-- 是店内短码，和 auth-service 分配的设备码不是一回事。
--
-- 可空：Web/Kiosk/第三方单本来就没有，老版本 POS 也不发。
-- 为空时服务端保持旧行为（POS 单不生成任务），所以两端可以分开部署。
ALTER TABLE orders ADD COLUMN IF NOT EXISTS device_id VARCHAR(255);
