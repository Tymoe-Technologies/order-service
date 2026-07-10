const { PrismaClient } = require('./shared/database/client-order');
const prisma = new PrismaClient();

async function checkSettings() {
  const settings = await prisma.printSetting.findMany({
    where: {
      ticketType: 'CUSTOMER_RECEIPT'
    }
  });
  
  console.log('找到', settings.length, '条 CUSTOMER_RECEIPT 设置');
  
  for (const setting of settings) {
    console.log('\n=== Setting ID:', setting.id);
    console.log('Tenant ID:', setting.tenantId);
    console.log('Version:', setting.version);
    console.log('Config.sections.storeInfo:', JSON.stringify(setting.config?.sections?.storeInfo, null, 2));
  }
  
  await prisma.$disconnect();
}

checkSettings().catch(console.error);
