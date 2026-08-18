-- 幂等键存储
--
-- 替掉 createOrder 里「比对订单当前明细」那套判重。那套只在「订单建好就不会变」
-- 时成立 —— 一旦支持加菜/撤菜，一次正常的补传会被判成 id 撞车，客户端换个 id
-- 重发，同一桌就变成两张单（而且是已收钱的单）。
--
-- 改成 Stripe 的做法：把「这个 key 处理过、当时回了什么」记下来，重发直接回放
-- 原始响应。判重从此和订单当前长什么样彻底无关。
--
-- 通用表而不是往 orders 上加字段：以后 addItems / voidItem 这些可重试的写操作
-- 都需要幂等，一张表一次解决。
CREATE TABLE IF NOT EXISTS "idempotency_keys" (
  "tenant_id"     UUID         NOT NULL,
  "endpoint"      VARCHAR(100) NOT NULL,
  "key"           VARCHAR(255) NOT NULL,
  -- 请求指纹：规范化后的请求体 hash。同 key 不同指纹 = 真撞键，必须拒
  "fingerprint"   VARCHAR(64)  NOT NULL,
  -- 首次成功的响应**原样存字节**，重放照抄。
  -- 用 TEXT 不用 JSONB：jsonb 会重排键，回放出来的和第一次给的不是同一串字符。
  -- 这一列从不按内容查询，不需要 jsonb 的可查询性，byte-exact 更重要。
  -- （存响应而不是重新序列化当前订单：订单后来被改过的话，重新序列化的就不是原来那份了）
  "response_body" TEXT,
  -- IN_PROGRESS 落在插入成功和业务完成之间；卡在这个状态的重发直接拒，不等待
  "status"        VARCHAR(20)  NOT NULL DEFAULT 'IN_PROGRESS',
  "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- 过期只是清理，不是正确性依赖：过期后重发会走到 orders.id 主键冲突那道兜底
  "expires_at"    TIMESTAMP(3) NOT NULL,

  CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("tenant_id", "endpoint", "key")
);

CREATE INDEX IF NOT EXISTS "idempotency_keys_expires_at_idx" ON "idempotency_keys" ("expires_at");
