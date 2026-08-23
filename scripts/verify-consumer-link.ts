/**
 * POS 单要能出现在顾客自己的订单记录里。
 *
 * consumer app 的订单列表按 `orders.consumer_id` 查，而 POS 收银台只认「会员」
 * （店员输手机号 → memberId）。不把 consumer_id 落下来，那笔单顾客就永远看不到 ——
 * 实际发生过：同一个人同一天两笔网单看得到、一笔 POS 单看不到。
 *
 * 两条路都要验：
 *   · 建单时解析（正常路径）
 *   · 读取时自愈（会员服务当时不可达 / **线下会员后来才注册**）
 * 只验前者的话，"绑定发生在下单之后"那种情况会永远漏，而那正是线下会员的常态。
 */
import { randomUUID } from 'crypto';
import prisma from '../src/utils/prisma';
import orderService from '../src/services/order.service';

const TENANT = process.env.VERIFY_TENANT_ID || 'a6aee8e9-fc5f-419a-8504-3d106b1a3534';
const USER = '00000000-0000-0000-0000-000000000001';
const MARK = 'CONSUMERLINK-VERIFY';
const rows: Array<[string, boolean, string]> = [];
const T = (n: string, ok: boolean, note = '') => rows.push([n, ok, note]);

/* 桩掉 member-client 的两个方向，不依赖 member-service 真的在跑 */
const memberClient = require('../src/utils/member-client');
const MEMBER = 'a0000000-0000-4000-8000-000000000001';   // 必须是合法 UUID，列类型是 uuid
const CONSUMER = 'c0000000-0000-4000-8000-000000000001';
let memberServiceUp = true;
memberClient.getConsumerIdByMemberId = async (mid: string) =>
  (memberServiceUp && mid === MEMBER) ? CONSUMER : null;
memberClient.getMemberIdByConsumerId = async (cid: string) =>
  (memberServiceUp && cid === CONSUMER) ? MEMBER : null;

const body = (over: any = {}) => ({
  orderType: 'TAKEOUT', clientOrigin: 'POS', notes: MARK,
  items: [{ itemId: randomUUID(), itemName: `${MARK} 奶茶`, quantity: 1, unitPrice: 500 }],
  ...over,
});

const cleanup = async () => {
  const os = await prisma.order.findMany({ where: { tenantId: TENANT, notes: MARK }, select: { id: true } });
  const ids = os.map(o => o.id);
  if (!ids.length) return;
  await prisma.outboxEvent.deleteMany({ where: { aggregateId: { in: ids } } });
  await prisma.orderItemModifier.deleteMany({ where: { orderItem: { orderId: { in: ids } } } });
  await prisma.orderItem.deleteMany({ where: { orderId: { in: ids } } });
  await prisma.orderStatusHistory.deleteMany({ where: { orderId: { in: ids } } });
  await prisma.orderAnalytics.deleteMany({ where: { orderId: { in: ids } } }).catch(() => {});
  await prisma.order.deleteMany({ where: { id: { in: ids } } });
  await prisma.idempotencyKey.deleteMany({ where: { tenantId: TENANT, key: { in: ids } } });
};

async function main() {
  await cleanup();

  // ── ① 正常路径：建单时就把 consumer_id 落下来 ──
  const idA = randomUUID();
  await orderService.createOrder(body({ id: idA, memberId: MEMBER }) as any, USER, TENANT);
  const a = await prisma.order.findUnique({ where: { id: idA }, select: { consumerId: true, memberId: true } });
  T('★ POS 单建单时就带上 consumer_id（顾客的订单记录才看得到）',
    a?.consumerId === CONSUMER, `consumerId=${a?.consumerId}`);

  // ── ② 没有会员的单不该被塞一个 ──
  const idB = randomUUID();
  await orderService.createOrder(body({ id: idB }) as any, USER, TENANT);
  const b = await prisma.order.findUnique({ where: { id: idB }, select: { consumerId: true } });
  T('  没带会员的单 consumer_id 保持为空', b?.consumerId === null, `consumerId=${b?.consumerId}`);

  // ── ③ ★ 会员服务挂了：单照建，只是 consumer_id 空着 ──
  memberServiceUp = false;
  const idC = randomUUID();
  await orderService.createOrder(body({ id: idC, memberId: MEMBER }) as any, USER, TENANT);
  const c = await prisma.order.findUnique({ where: { id: idC }, select: { id: true, consumerId: true, memberId: true } });
  T('★ 会员服务不可达时订单照常建成（外部依赖不能变成"收不了钱"）',
    !!c?.id && c?.memberId === MEMBER, `建成=${!!c?.id}`);
  T('  这种情况下 consumer_id 先空着', c?.consumerId === null, `consumerId=${c?.consumerId}`);

  // ── ④ ★ 读取时自愈：服务恢复后，顾客一打开订单记录就补上 ──
  /*
    这一条覆盖的是最常见的那种：**线下会员后来才在 app 注册**，
    绑定发生在下单之后，他此前所有 POS 单的 consumer_id 都是空的。
  */
  memberServiceUp = true;
  const before = await prisma.order.count({ where: { memberId: MEMBER, consumerId: null } });
  const list = await orderService.getConsumerOrders(CONSUMER, { page: 1, limit: 50 });
  const after = await prisma.order.count({ where: { memberId: MEMBER, consumerId: null } });
  T('★ 打开订单记录时自愈：历史上没关联的 POS 单被补上',
    before > 0 && after === 0, `补之前 ${before} 单没关联，补之后 ${after} 单`);
  T('★ 而且这次就能看到它们（不用等下一次刷新）',
    (list as any).data.some((o: any) => o.id === idC), `返回 ${(list as any).data.length} 单`);

  // ── ⑤ 自愈不能把别人的单也认领了 ──
  const other = await prisma.order.findUnique({ where: { id: idB }, select: { consumerId: true } });
  T('★ 没有会员的单不会被自愈误认领（只按 memberId 匹配，不按手机号猜）',
    other?.consumerId === null, `consumerId=${other?.consumerId}`);

  await cleanup();
}

main().then(async () => {
  let fail = 0;
  for (const [n, ok, note] of rows) { if (!ok) fail++; console.log(`  ${ok ? '✓' : '✗'} ${n.padEnd(58)} ${note}`); }
  console.log(`\n  ${fail === 0 ? '✅' : '❌'} ${rows.length - fail}/${rows.length} 通过`);
  await prisma.$disconnect(); process.exit(fail === 0 ? 0 : 1);
}).catch(async (e) => {
  console.error('出错：', e); await cleanup().catch(() => {});
  await prisma.$disconnect(); process.exit(1);
});
