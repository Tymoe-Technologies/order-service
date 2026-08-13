require('dotenv').config({ path: '.env.development' });
const { PrismaClient } = require('.prisma/client-order');
const p = new PrismaClient();
(async () => {
  // 子表先删：orderItem / statusHistory 都外键指向 order
  const r = {};
  for (const m of ['orderStatusHistory','orderItem','order']) {
    try { r[m] = (await p[m].deleteMany({})).count; } catch(e) { r[m] = `失败: ${e.message.slice(0,80)}`; }
  }
  Object.entries(r).forEach(([k,v]) => console.log(`  删除 ${k.padEnd(20)} ${v}`));
  for (const m of ['order','orderItem','orderStatusHistory']) console.log(`  剩余 ${m.padEnd(20)} ${await p[m].count()}`);
})().catch(e=>{console.error('ERR', e.message.slice(0,300));process.exit(1)});
