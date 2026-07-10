-- 将 print_records.printed_by 改为可空
-- 原因：系统自动打印（WebSocket 任务完成）无对应用户 ID
ALTER TABLE "print_records" ALTER COLUMN "printed_by" DROP NOT NULL;
