/**
 * 验事件待发板。
 *
 * 要证的核心是一句话:**建单提交之后、通知投出去之前把进程"杀掉"，通知不会丢**。
 * 这正是原来那套 fire-and-forget 丢东西的那一瞬 —— 不模拟这一下，
 * 测什么都通不过也证明不了什么（老代码在正常情况下也能把通知发出去）。
 *
 * 跑真库真服务：要验的是事务原子性和 FOR UPDATE SKIP LOCKED 的认领，桩验不出来。
 *
 *   node -r <ts-node/register/transpile-only> scripts/verify-outbox.ts
 */
import { randomUUID } from 'crypto';
import prisma from '../src/utils/prisma';
import orderService from '../src/services/order.service';
import { eventBus, registerAllHandlers } from '../src/events';
import { drainOutbox, enqueueEvent } from '../src/services/outbox.service';

const TENANT = process.env.VERIFY_TENANT_ID || 'a6aee8e9-fc5f-419a-8504-3d106b1a3534';
const USER = '00000000-0000-0000-0000-000000000001';
const MARK = 'OUTBOX-VERIFY';

const rows: Array<[string, boolean, string]> = [];
const T = (n: string, ok: boolean, note = '') => rows.push([n, ok, note]);

/** 记录每个 handler 被真正跑了几次 —— at-least-once 的关键就在这个计数上 */
const runs: Record<string, number> = {};
let failNext = new Set<string>();

const payload = () => ({
  orderType: 'TAKEOUT' as const,
  clientOrigin: 'POS' as const,
  notes: MARK,
  items: [{ itemId: randomUUID(), itemName: `${MARK} 拿铁`, quantity: 1, unitPrice: 600 }],
});

const cleanup = async () => {
  const orders = await prisma.order.findMany({ where: { tenantId: TENANT, notes: MARK }, select: { id: true } });
  const ids = orders.map(o => o.id);
  if (ids.length) {
    await prisma.outboxEvent.deleteMany({ where: { aggregateId: { in: ids } } });
    await prisma.orderItemModifier.deleteMany({ where: { orderItem: { orderId: { in: ids } } } });
    await prisma.orderItem.deleteMany({ where: { orderId: { in: ids } } });
    await prisma.orderStatusHistory.deleteMany({ where: { orderId: { in: ids } } });
    await prisma.orderAnalytics.deleteMany({ where: { orderId: { in: ids } } }).catch(() => {});
    await prisma.order.deleteMany({ where: { id: { in: ids } } });
    await prisma.idempotencyKey.deleteMany({ where: { tenantId: TENANT, key: { in: ids } } });
  }
  await prisma.outboxEvent.deleteMany({ where: { tenantId: TENANT, eventType: 'PROBE_EVENT' } });
};

async function main() {
  await cleanup();

  /*
    装两个探针 handler。用真的 handler 不行：它们会打印、会调 member-service，
    而这里要量的是「跑了几次」，不是副作用本身。
  */
  registerAllHandlers();
  for (const name of ['probeA', 'probeB']) {
    eventBus.on('PROBE_EVENT', async () => {
      runs[name] = (runs[name] ?? 0) + 1;
      if (failNext.has(name)) throw new Error(`${name} 故意失败`);
    }, name);
  }

  // ── ① 建单：事件和订单在同一笔写入里 ──
  const id1 = randomUUID();
  await orderService.createOrder({ ...payload(), id: id1 } as any, USER, TENANT);
  const boardRows = await prisma.outboxEvent.findMany({ where: { aggregateId: id1 } });
  T('★ 建单的同时事件就落到板上了（不是提交之后再补一次）',
    boardRows.length > 0 && boardRows.every(r => r.publishedAt === null),
    `${boardRows.length} 条待投：${boardRows.map(r => r.handler).join(', ')}`);
  T('  按 handler 拆行（一个失败不会把已成功的重跑）',
    new Set(boardRows.map(r => r.handler)).size === boardRows.length,
    boardRows.map(r => r.handler).join(', '));

  // ── ② ★ 核心：建单成功但通知一次都没投出去，之后仍然会被投出去 ──
  /*
    上一步之后我们**没有跑 relay** —— 等价于「订单提交了，进程立刻挂了」。
    老代码在这一刻通知就永久丢了。现在它还在板上，下一轮自然会捞起来。
  */
  const beforeDrain = await prisma.outboxEvent.count({ where: { aggregateId: id1, publishedAt: null } });
  await drainOutbox();
  const stuck = await prisma.outboxEvent.findMany({ where: { aggregateId: id1, publishedAt: null } });
  const afterDrain = stuck.length;
  T('★ 进程"挂掉"后重启，板上的通知照样投出去（老代码在这一刻永久丢）',
    beforeDrain > 0 && afterDrain === 0,
    `投递前 ${beforeDrain} 条，投递后 ${afterDrain} 条`
    + (afterDrain ? ` —— ${stuck.map(r => `${r.handler}: ${r.lastError?.slice(0, 120)}`).join(' | ')}` : ''));

  // ── ③ 一个 handler 失败，不影响别的，也不会把成功的重跑 ──
  runs.probeA = 0; runs.probeB = 0;
  failNext = new Set(['probeB']);
  const evId = randomUUID();
  await enqueueEvent(prisma, {
    type: 'PROBE_EVENT', eventId: evId, timestamp: new Date(),
    tenantId: TENANT, orderId: null,
  } as any);
  await drainOutbox();
  T('  一轮之后：成功的标掉，失败的留着',
    runs.probeA === 1 && runs.probeB === 1, `probeA 跑了 ${runs.probeA} 次，probeB 跑了 ${runs.probeB} 次`);

  const left = await prisma.outboxEvent.findMany({ where: { tenantId: TENANT, eventType: 'PROBE_EVENT' } });
  const pending = left.filter(r => r.publishedAt === null);
  T('★ 只有失败的那条还在板上（成功的不会因为同伴失败而重投）',
    pending.length === 1 && pending[0].handler === 'probeB', pending.map(r => r.handler).join(',') || '<空>');
  T('  失败原因记下来了', !!pending[0]?.lastError, pending[0]?.lastError?.slice(0, 30) || '<没记>');

  // ── ④ 重投只重投失败的那个 ──
  failNext = new Set();
  await prisma.outboxEvent.updateMany({
    where: { tenantId: TENANT, eventType: 'PROBE_EVENT', publishedAt: null },
    data: { nextAttemptAt: new Date(Date.now() - 1000) },   // 免得等退避
  });
  await drainOutbox();
  T('★ 重投只跑失败的那个，成功过的没有再跑一遍（否则积分会加两次）',
    runs.probeA === 1 && runs.probeB === 2, `probeA ${runs.probeA} 次，probeB ${runs.probeB} 次`);
  const stillPending = await prisma.outboxEvent.count({
    where: { tenantId: TENANT, eventType: 'PROBE_EVENT', publishedAt: null },
  });
  T('  重投成功后板上清空', stillPending === 0, `${stillPending} 条`);

  // ── ⑤ 失败后有退避，不会空转打爆日志 ──
  runs.probeA = 0; runs.probeB = 0;
  failNext = new Set(['probeA', 'probeB']);
  await enqueueEvent(prisma, {
    type: 'PROBE_EVENT', eventId: randomUUID(), timestamp: new Date(),
    tenantId: TENANT, orderId: null,
  } as any);
  await drainOutbox();
  const firstRuns = runs.probeA;
  await drainOutbox();   // 立刻再来一轮，应该一条都认领不到
  T('★ 失败后按退避等待，紧接着的一轮不会重复认领（否则失败的事件会空转刷屏）',
    runs.probeA === firstRuns, `连跑两轮，probeA 共 ${runs.probeA} 次`);

  failNext = new Set();
  await cleanup();
}

main()
  .then(async () => {
    let fail = 0;
    for (const [n, ok, note] of rows) { if (!ok) fail++; console.log(`  ${ok ? '✓' : '✗'} ${n.padEnd(58)} ${note}`); }
    console.log(`\n  ${fail === 0 ? '✅' : '❌'} ${rows.length - fail}/${rows.length} 通过`);
    await prisma.$disconnect();
    process.exit(fail === 0 ? 0 : 1);
  })
  .catch(async (e) => {
    console.error('验证脚本出错：', e);
    await cleanup().catch(() => {});
    await prisma.$disconnect();
    process.exit(1);
  });
