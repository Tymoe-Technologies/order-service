/**
 * 验建单的幂等保护。
 *
 * 这套替掉的是「比对订单当前明细」那种判重，而它出问题的场景恰恰是
 * **订单被改过之后的重发** —— 所以必须真的改一次订单再重发，光测
 * 「连发两次一样的」证明不了任何东西（那种老逻辑也过）。
 *
 * 跑真库真服务：要验的是数据库主键抢占和回放的响应内容，桩验不出来。
 *
 *   npx ts-node -r tsconfig-paths/register scripts/verify-idempotency.ts
 *
 * 造的数据跑完自己删干净（含中途失败）。
 */
import { randomUUID } from 'crypto';
import prisma from '../src/utils/prisma';
import orderService from '../src/services/order.service';

const TENANT = process.env.VERIFY_TENANT_ID || 'a6aee8e9-fc5f-419a-8504-3d106b1a3534';
const USER = '00000000-0000-0000-0000-000000000001';
const MARK = 'IDEM-VERIFY';

const rows: Array<[string, boolean, string]> = [];
const T = (n: string, ok: boolean, note = '') => rows.push([n, ok, note]);

/** UUIDv7 风格的 id 就行，这里只要唯一 */
const newId = () => randomUUID();

const payload = (over: Partial<any> = {}) => ({
  orderType: 'TAKEOUT' as const,
  clientOrigin: 'POS' as const,
  notes: MARK,
  items: [
    { itemId: randomUUID(), itemName: `${MARK} 冰美式`, quantity: 1, unitPrice: 500 },
  ],
  ...over,
});

const cleanup = async () => {
  const orders = await prisma.order.findMany({
    where: { tenantId: TENANT, notes: MARK }, select: { id: true },
  });
  const ids = orders.map(o => o.id);
  if (ids.length) {
    await prisma.orderItemModifier.deleteMany({ where: { orderItem: { orderId: { in: ids } } } });
    await prisma.orderItem.deleteMany({ where: { orderId: { in: ids } } });
    await prisma.orderStatusHistory.deleteMany({ where: { orderId: { in: ids } } });
    await prisma.orderAnalytics.deleteMany({ where: { orderId: { in: ids } } }).catch(() => {});
    await prisma.order.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.idempotencyKey.deleteMany({ where: { tenantId: TENANT, key: { in: ids } } });
};

async function main() {
  await cleanup();
  const before = await prisma.order.count({ where: { tenantId: TENANT } });

  // ── ① 正常建单 ──
  const id1 = newId();
  const body = payload();
  const first: any = await orderService.createOrder({ ...body, id: id1 } as any, USER, TENANT);
  T('  第一次建单成功', !!first?.id && first.id === id1, `${first?.orderNumber}`);

  const keyRow = await prisma.idempotencyKey.findUnique({
    where: { tenantId_endpoint_key: { tenantId: TENANT, endpoint: 'orders.create', key: id1 } },
  });
  T('  幂等记录落库且标成功', keyRow?.status === 'SUCCEEDED' && keyRow.responseBody != null,
    String(keyRow?.status));

  // ── ② 原样重发：回放，不多建单 ──
  const again: any = await orderService.createOrder({ ...body, id: id1 } as any, USER, TENANT);
  const cnt2 = await prisma.order.count({ where: { tenantId: TENANT } });
  T('★ 原样重发不多建单', cnt2 === before + 1, `建单前 ${before}，现在 ${cnt2}`);
  const diffKeys = Object.keys({ ...first, ...again }).filter(
    k => JSON.stringify((first as any)[k]) !== JSON.stringify((again as any)[k]));
  T('★ 回放的响应和第一次逐字一致（幂等的定义：调用方不需要知道自己在重放）',
    JSON.stringify(again) === JSON.stringify(first),
    diffKeys.length ? diffKeys.map(k => `${k}: ${JSON.stringify((first as any)[k])} → ${JSON.stringify((again as any)[k])}`).join('; ') : '');

  // ── ③ ★ 核心：订单被改过之后再重发 ──
  /*
    这是老逻辑会栽的那一格。老的判重比对订单**当前**明细，
    订单一旦被改（以后的加菜就是这个动作），正常重发会被判成 id 撞车 →
    客户端换 id 重发 → 同一桌两张单，而且钱已经收了。
  */
  await prisma.orderItem.create({
    data: {
      orderId: id1, itemId: randomUUID(), itemName: `${MARK} 后加的菜`,
      quantity: 1, unitPrice: 300, totalPrice: 300,
    } as any,
  });
  await prisma.order.update({ where: { id: id1 }, data: { totalAmount: 800 } });

  let afterEdit: any = null;
  let editErr: any = null;
  try {
    afterEdit = await orderService.createOrder({ ...body, id: id1 } as any, USER, TENANT);
  } catch (e) { editErr = e; }
  const cnt3 = await prisma.order.count({ where: { tenantId: TENANT } });
  T('★ 订单被改过之后重发，仍判为重发（不报撞车、不多建单）',
    !editErr && cnt3 === before + 1, editErr ? `抛了 ${editErr.code || editErr.message}` : `订单数 ${cnt3}`);
  T('★ 回放的仍是**第一次那份**响应，不是改过之后的当前订单',
    JSON.stringify(afterEdit) === JSON.stringify(first),
    afterEdit?.totalAmount === first?.totalAmount ? '' : `回放 total=${afterEdit?.totalAmount}，首次=${first?.totalAmount}`);

  // ── ④ 同 key 不同内容 = 真撞键，必须拒 ──
  let reuseErr: any = null;
  try {
    await orderService.createOrder(
      { ...payload({ items: [{ itemId: randomUUID(), itemName: `${MARK} 别的`, quantity: 3, unitPrice: 999 }] }), id: id1 } as any,
      USER, TENANT,
    );
  } catch (e) { reuseErr = e; }
  T('★ 同一 key 换了内容 → 拒绝（否则会静默返回别人的订单）',
    reuseErr?.code === 'IDEMPOTENCY_KEY_REUSED', reuseErr?.code || `<没抛，抛的是 ${reuseErr?.message ?? '什么都没有'}>`);

  // ── ⑤ 指纹和顺序无关 ──
  const id5 = newId();
  const two = payload({
    items: [
      { itemId: 'aaaaaaaa-0000-4000-8000-000000000001', itemName: 'A', quantity: 1, unitPrice: 100 },
      { itemId: 'bbbbbbbb-0000-4000-8000-000000000002', itemName: 'B', quantity: 2, unitPrice: 200 },
    ],
  });
  const r5a: any = await orderService.createOrder({ ...two, id: id5 } as any, USER, TENANT);
  const swapped = { ...two, items: [two.items[1], two.items[0]] };
  let orderErr: any = null;
  let r5b: any = null;
  try { r5b = await orderService.createOrder({ ...swapped, id: id5 } as any, USER, TENANT); }
  catch (e) { orderErr = e; }
  T('  同一批商品换个顺序传，仍算同一请求（指纹先排序）',
    !orderErr && r5b?.id === r5a.id, orderErr?.code || 'ok');

  // ── ⑥ 业务失败要把占位删掉，否则这个 key 卡到过期 ──
  const id6 = newId();
  let failErr: any = null;
  try {
    await orderService.createOrder({ ...payload({ items: [] }), id: id6 } as any, USER, TENANT);
  } catch (e) { failErr = e; }
  const leftover = await prisma.idempotencyKey.findUnique({
    where: { tenantId_endpoint_key: { tenantId: TENANT, endpoint: 'orders.create', key: id6 } },
  });
  T('★ 业务失败后占位被清掉（留着的话这个 key 24 小时内再也建不成单）',
    !!failErr && leftover === null, failErr ? `失败于 ${failErr.code}，残留=${leftover ? '有' : '无'}` : '<没失败>');

  // 同一个 key 重试要能成功
  let retry: any = null;
  try { retry = await orderService.createOrder({ ...payload(), id: id6 } as any, USER, TENANT); } catch (e) { /* */ }
  T('  失败后用同一个 key 重试能建成', retry?.id === id6, retry?.orderNumber || '<没建成>');

  // ── ⑦ 不带 id 的请求不受影响（WEB / UberEats 走这条） ──
  const noId: any = await orderService.createOrder(payload() as any, USER, TENANT);
  T('  不带 id 的建单照常（这条路不进幂等表）', !!noId?.id, noId?.orderNumber || '<失败>');

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
