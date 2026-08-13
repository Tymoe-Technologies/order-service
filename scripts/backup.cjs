require('dotenv').config({ path: '.env.development' });
const { PrismaClient } = require('.prisma/client-order');
const fs = require('fs');
const p = new PrismaClient();
(async () => {
  const dir = process.argv[2];
  const out = {};
  for (const m of ['order','orderItem','orderStatusHistory']) out[m] = await p[m].findMany();
  fs.writeFileSync(`${dir}/orders.json`, JSON.stringify(out, (k,v)=>typeof v==='bigint'?String(v):v, 2));
  console.log('order 备份:', Object.entries(out).map(([k,v])=>`${k}=${v.length}`).join(' '));
})().catch(e=>{console.error(e.message.slice(0,200));process.exit(1)});
