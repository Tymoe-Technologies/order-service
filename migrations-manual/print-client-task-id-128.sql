-- clientTaskId 从 VARCHAR(64) 加宽到 VARCHAR(128)
--
-- POS 的任务 id 形如 `<orderId>:<ticketType>:<stationId>`，两个 uuid 加票据类型
-- 就 88 个字符 —— 原来定的 64 装不下厨房单那一类，而那正是最需要补报的一类
-- （一单多张、最容易少一张）。这个错是补报的入参校验单测抓出来的。
--
-- 纯加宽，不会截断已有数据（这一列目前还没有任何值）。
--
-- 跑法：
--   export $(grep -h '^ORDER_DATABASE_URL' .env | head -1 | sed 's/"//g')
--   psql "$ORDER_DATABASE_URL" -f migrations-manual/print-client-task-id-128.sql

ALTER TABLE "print_tasks" ALTER COLUMN "client_task_id" SET DATA TYPE VARCHAR(128);
