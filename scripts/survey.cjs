require('dotenv').config({ path: '.env.development' });
const { PrismaClient } = require('.prisma/client-order');
const p = new PrismaClient();
(async () => {
  const t = async (n, fn) => { try { console.log(`  ${n.padEnd(22)} ${await fn()}`); } catch(e){ console.log(`  ${n.padEnd(22)} —`); } };
  console.log('【order-service】');
  for (const n of ['order','orderItem','orderStatusHistory','orderPayment']) await t(n, () => p[n].count());
  const by = await p.order.groupBy({ by: ['status','paymentStatus'], _count: true });
  by.forEach(b => console.log(`    ${b.status}/${b.paymentStatus}: ${b._count}`));
})().catch(e=>console.error(e.message.slice(0,200)));
