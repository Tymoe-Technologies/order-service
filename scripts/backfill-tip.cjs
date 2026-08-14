/**
 * 补录 order.tipAmount —— finance 侧记了小费，通知时漏传导致订单上是 0。
 * 只改 tip_amount 仍为 0 的行（幂等，重跑无害）。
 * 口径和 order.service.updatePaymentStatus 一致：tipAmount = tip，totalAmount += tip。
 */
require('dotenv').config({ path: '.env.development' });
const { PrismaClient } = require('.prisma/client-order');
const p = new PrismaClient();
const f = (c) => `$${(c / 100).toFixed(2)}`;
const APPLY = process.argv.includes('--apply');

const TARGETS = [
  { id: '019fff73-3eb6-77ae-9b62-a1938a19cfc8', num: 'A6AE260814PPD4D', tip: 498 },
  { id: '019fff80-bc11-7378-9e7f-396cfc34ed24', num: 'A6AE260814PLTVA', tip: 168 },
];

(async () => {
  console.log(APPLY ? '【执行】' : '【干跑】加 --apply 执行');
  for (const t of TARGETS) {
    const o = await p.order.findUnique({ where: { id: t.id }, select: { orderNumber: true, tipAmount: true, totalAmount: true } });
    if (!o) { console.log(`  ${t.num} 不存在，跳过`); continue; }
    if (o.tipAmount !== 0) { console.log(`  ${t.num} 小费已是 ${f(o.tipAmount)}，跳过`); continue; }
    console.log(`  ${t.num}  小费 ${f(0)} → ${f(t.tip)}   总额 ${f(o.totalAmount)} → ${f(o.totalAmount + t.tip)}`);
    if (APPLY) {
      await p.order.update({ where: { id: t.id }, data: { tipAmount: t.tip, totalAmount: o.totalAmount + t.tip } });
    }
  }
  if (APPLY) {
    console.log('\n复核：');
    for (const t of TARGETS) {
      const o = await p.order.findUnique({ where: { id: t.id }, select: { orderNumber: true, tipAmount: true, totalAmount: true } });
      if (o) console.log(`  ${o.orderNumber}  小费 ${f(o.tipAmount)}  总额 ${f(o.totalAmount)}`);
    }
  }
})().catch((e) => console.error('ERR', e.message.slice(0, 200)));
