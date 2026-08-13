require('dotenv').config({ path: '.env.development' });
const { PrismaClient } = require('.prisma/client-order');
const p = new PrismaClient();
(async () => {
  for (const m of ['orderItemModifier','orderNote','printRecord','orderAnalytics','printTask','checkoutSnapshot','pickupCounter']) {
    try { const c = await p[m].count(); if (c) console.log(`  ⚠️ ${m.padEnd(20)} 还剩 ${c}`); else console.log(`  ✓ ${m.padEnd(20)} 0`); }
    catch(e) { console.log(`  ? ${m.padEnd(20)} —`); }
  }
})().catch(e=>console.error(e.message.slice(0,200)));
