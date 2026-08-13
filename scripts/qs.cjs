require('dotenv').config({ path: '.env.development' });
const { PrismaClient } = require('.prisma/client-order');
const p = new PrismaClient();
(async () => {
  const os = await p.order.findMany({
    where: { orderNumber: { in: ['A6AE260813P6JX5','A6AE260813P5XPC','A6AE260813PWK4D','A6AE260813PA7W7'] } },
    select: { orderNumber: true, status: true, paymentStatus: true, paymentMethod: true, totalAmount: true },
  });
  os.forEach(o => console.log(`${o.orderNumber}  ${o.status}/${o.paymentStatus}  ${o.paymentMethod}  ${o.totalAmount}`));
})().catch(e=>console.error(e.message.slice(0,200)));
