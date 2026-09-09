-- printer_assignments 记下主责设备的名字（2026-09-09）
--
-- 归属记录原来只有设备码（`kklhbb2y8` 这种）。别台 POS 拿到这条记录时
-- 只能显示那串码，而设置界面要说的是「饮品吧这个站已经由『吧台机』负责了」——
-- 一串码对商家等于没说。
--
-- 冗余存一份而不是按 deviceId 反查：设备清单在 auth-service，
-- 为了一行文案新开一个跨服务查询不值得。和 finance-service 的
-- CashDrawerBinding.deviceName 是同一个做法（设备登记时自己带上来）。
--
-- 可空：存量记录没有这个信息，前端退回显示设备码前 8 位。

ALTER TABLE printer_assignments
  ADD COLUMN IF NOT EXISTS device_name VARCHAR(120);
