require('dotenv').config({ path: '.env.development' });
const { PrismaClient } = require('.prisma/client-order');
const p = new PrismaClient();
const f = (c) => `$${(c/100).toFixed(2)}`;
(async () => {
  const o = await p.order.findFirst({ where: { orderNumber: process.argv[2].toUpperCase() }, include: { orderItems: true } });
  if (!o) { console.log('没找到'); await p.$disconnect(); return; }
  console.log(`订单 ${o.orderNumber}  id=${o.id}`);
  console.log(`  ${o.status} / ${o.paymentStatus} / 方式 ${o.paymentMethod}`);
  console.log(`  小计 ${f(o.subtotal)} 税 ${f(o.taxAmount)} 折扣 ${f(o.discountAmount)} 小费 ${f(o.tipAmount)} 总计 ${f(o.totalAmount)}`);
  console.log(`  创建 ${o.createdAt.toISOString()}`);
  o.orderItems.forEach(i => console.log(`    ${i.itemName} ×${i.quantity} = ${f(i.totalPrice)}`));
  await p.$disconnect();
})().catch(e => { console.error('ERR', e.message.slice(0,200)); process.exit(1); });
