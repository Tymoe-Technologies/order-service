/**
 * 验「离线补传的单不发取餐号」。
 *
 * 两件事都要量：带了 skipPickupNumber 的不发号，**没带的照常发**。
 * 只测前者的话，把发号整个关掉也能过 —— 那就把正常单的取餐号一起弄没了。
 *
 * ⚠️ 必须走**真的建单入口**（含 Joi 校验）。本仓栽过：新字段没加进 Joi 白名单，
 * 服务跑起来直接 400，而只调 service 层的测试完全看不出来。
 */
import { randomUUID } from 'crypto';
import prisma from '../src/utils/prisma';
import orderService from '../src/services/order.service';
import { createOrderSchema } from '../src/validators/order.validator';

const TENANT = process.env.VERIFY_TENANT_ID || 'a6aee8e9-fc5f-419a-8504-3d106b1a3534';
const USER = '00000000-0000-0000-0000-000000000001';
const MARK = 'SKIPPICKUP-VERIFY';
const rows: Array<[string, boolean, string]> = [];
const T = (n: string, ok: boolean, note = '') => rows.push([n, ok, note]);

const body = (over: any = {}) => ({
  orderType: 'TAKEOUT', clientOrigin: 'POS', notes: MARK,
  items: [{ itemId: randomUUID(), itemName: `${MARK} 茶`, quantity: 1, unitPrice: 400 }],
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

  // ── ① Joi 白名单：漏了这里线上就是 400 ──
  const { error } = createOrderSchema.validate(body({ skipPickupNumber: true }));
  T('★ Joi 放行 skipPickupNumber（漏加白名单的话线上直接 400，只测 service 层看不出来）',
    !error, error?.message ?? 'ok');

  // ── ② 带 skip：不发号 ──
  const idA = randomUUID();
  await orderService.createOrder(body({ id: idA, skipPickupNumber: true }) as any, USER, TENANT);
  const a = await prisma.order.findUnique({ where: { id: idA }, select: { pickupNumber: true } });
  T('★ 离线补传的单没有取餐号（小票上没有，系统里也不该有）',
    a?.pickupNumber === null, `pickupNumber=${a?.pickupNumber}`);

  // ── ③ 不带：照常发 ──
  const idB = randomUUID();
  await orderService.createOrder(body({ id: idB }) as any, USER, TENANT);
  const b = await prisma.order.findUnique({ where: { id: idB }, select: { pickupNumber: true } });
  T('★ 正常单照常发号（否则就是把所有单的取餐号一起关掉了）',
    typeof b?.pickupNumber === 'number', `pickupNumber=${b?.pickupNumber}`);

  // ── ④ 没号的单不能白占一个号 ──
  const idC = randomUUID();
  await orderService.createOrder(body({ id: idC, skipPickupNumber: true }) as any, USER, TENANT);
  const idD = randomUUID();
  await orderService.createOrder(body({ id: idD }) as any, USER, TENANT);
  const d = await prisma.order.findUnique({ where: { id: idD }, select: { pickupNumber: true } });
  T('  中间夹一个离线单，下一个正常单的号是连着的（没号的不该占号）',
    (d?.pickupNumber ?? 0) === (b?.pickupNumber ?? 0) + 1, `${b?.pickupNumber} → ${d?.pickupNumber}`);

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
