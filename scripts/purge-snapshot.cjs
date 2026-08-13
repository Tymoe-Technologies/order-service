require('dotenv').config({ path: '.env.development' });
const { PrismaClient } = require('.prisma/client-order');
const p = new PrismaClient();
(async () => {
  const n = (await p.checkoutSnapshot.deleteMany({})).count;
  console.log(`  删除 checkoutSnapshot ${n}，剩余 ${await p.checkoutSnapshot.count()}`);
})().catch(e=>console.error(e.message.slice(0,200)));
