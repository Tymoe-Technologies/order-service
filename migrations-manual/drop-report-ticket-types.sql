-- 把 DAILY_REPORT / SHIFT_REPORT 从两个枚举里彻底拿掉（2026-09-09）
--
-- 日结报表和交接班表已下线：Portal 里的配置页删了，POS 也不再出这两种票。
-- 留着枚举值的代价不是「多两行」——而是每个 switch/映射表都得继续照顾它们，
-- 而那些分支永远不会被执行，下一个人读代码时也分不出「在用」和「留着」。
--
-- Postgres 不能直接从枚举里删值，只能建新类型、迁列、换名。
--
-- 执行前的存量核对（生产库实测）：
--   print_records.print_type   → RECEIPT / KITCHEN_TICKET / LABEL，没有这两个值 ✓
--   print_tasks.ticket_type    → 没有这两个值 ✓
--   print_settings.ticket_type → **每个租户各有 1 行**，共 8 行，必须先删
-- 三列都没有 DEFAULT（有的话 ALTER TYPE 会被它挡住）。

BEGIN;

-- 配置行没有业务价值：它们是初始化时按默认值批量建出来的，没人配过。
DELETE FROM print_settings WHERE ticket_type IN ('DAILY_REPORT', 'SHIFT_REPORT');

-- ---- TicketType：print_settings.ticket_type + print_tasks.ticket_type ----
CREATE TYPE "TicketType_new" AS ENUM (
  'CUSTOMER_RECEIPT',
  'KITCHEN_TICKET',
  'ITEM_LABEL',
  'CUSTOM_LABEL'
);

ALTER TABLE print_settings
  ALTER COLUMN ticket_type TYPE "TicketType_new"
  USING ticket_type::text::"TicketType_new";

ALTER TABLE print_tasks
  ALTER COLUMN ticket_type TYPE "TicketType_new"
  USING ticket_type::text::"TicketType_new";

DROP TYPE "TicketType";
ALTER TYPE "TicketType_new" RENAME TO "TicketType";

-- ---- PrintType：print_records.print_type ----
CREATE TYPE "PrintType_new" AS ENUM (
  'RECEIPT',
  'KITCHEN_TICKET',
  'LABEL'
);

ALTER TABLE print_records
  ALTER COLUMN print_type TYPE "PrintType_new"
  USING print_type::text::"PrintType_new";

DROP TYPE "PrintType";
ALTER TYPE "PrintType_new" RENAME TO "PrintType";

COMMIT;
