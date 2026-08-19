-- 事件待发板（transactional outbox）
--
-- 现在的事件总线是进程内 fire-and-forget，异常只打日志。而 emit 发生在业务写入
-- **提交之后** —— 进程在这中间挂掉，订单在库里、通知没人收到，之后再也不会重试。
-- 结果是每发现一处会丢就单独写一个补救程序（POS 待入账队列、对账补现金流水、
-- 订单支付状态核对，已经三个了）。
--
-- 通知板的做法：把「要通知的事」和业务数据**写在同一个事务里**，两者要么都成、
-- 要么都不成，没有中间态。再由 relay 一条条投递，投到了才标记。
--
-- ## 一个事件一个 handler 一行
-- 不是「一个事件一行、投递时跑所有 handler」—— 那样一个 handler 失败会把整批
-- 重跑，已经成功的（比如加积分）会**再执行一遍**。拆到 handler 粒度，
-- 重试只重试失败的那个。
CREATE TABLE IF NOT EXISTS "outbox_events" (
  "id"              UUID         NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id"       UUID         NOT NULL,
  "event_type"      VARCHAR(50)  NOT NULL,
  -- 目标 handler。同一个事件有几个 handler 就有几行，各自独立重试
  "handler"         VARCHAR(80)  NOT NULL,
  "aggregate_id"    UUID,
  -- 事件原文。和幂等表同理用 TEXT：jsonb 会重排键，而这是要原样回放的东西
  "payload"         TEXT         NOT NULL,
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "published_at"    TIMESTAMP(3),
  "attempts"        INTEGER      NOT NULL DEFAULT 0,
  -- 退避：claim 的时候先把它推到将来，失败就自然等着下一轮
  "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_error"      TEXT,

  CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- relay 的查询条件：没投出去的、到点了的，按产生顺序
CREATE INDEX IF NOT EXISTS "outbox_events_pending_idx"
  ON "outbox_events" ("published_at", "next_attempt_at", "created_at");
CREATE INDEX IF NOT EXISTS "outbox_events_aggregate_idx"
  ON "outbox_events" ("aggregate_id");
