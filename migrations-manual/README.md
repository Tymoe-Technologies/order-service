# 手工执行过的 DDL

这里存的是**已经在数据库上跑过**的 SQL，留档用 —— 这个项目没有走
`prisma migrate`（`_prisma_migrations` 表是早期留下的），schema 变更靠
`prisma db push`。而 db push 有个坑：它让数据库**完全匹配** schema，
schema 里没写的东西会被当成多余的删掉。

2026-08-29 加 `deliveryProvider` 时就撞上了：db push 生成的 SQL 里除了
本次改动，还夹着三条跟本次无关的破坏性操作 ——

    ALTER TABLE merchant_fulfillment_options
      ALTER COLUMN id DROP DEFAULT,          -- gen_random_uuid()
      ALTER COLUMN updated_at DROP DEFAULT;  -- CURRENT_TIMESTAMP
    ALTER TABLE outbox_events ALTER COLUMN id DROP DEFAULT;
    DROP INDEX order_items_order_id_line_kind_idx;

前三条会删掉**数据库层的 UUID 生成**，之后任何绕过 Prisma 的写入
（原始 SQL、别的服务、手工插数据）都会因为拿不到 id 而失败。

所以那次没跑 db push，而是手写只含本次改动的 SQL 单独执行，
再把数据库现状补写进 schema（`@default(dbgenerated("gen_random_uuid()"))` 等）。
现在 `prisma migrate diff` 已经是空的，两边一致。

## 改 schema 之前

先看一眼 db push 会做什么，别直接跑：

    export $(grep -h '^ORDER_DATABASE_URL' .env | head -1 | sed 's/"//g')
    npx prisma migrate diff \
      --from-url "$ORDER_DATABASE_URL" \
      --to-schema-datamodel ./shared/database/schema-order.prisma \
      --script

输出里只该有你这次改的东西。多出来的，说明 schema 和数据库又漂了 ——
优先把数据库现状补进 schema，而不是反过来让 db push 去删。
