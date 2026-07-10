/**
 * 更新现有模板的组织信息
 * 运行: npx tsx scripts/update-template-org-info.ts <templateId> <token>
 */

import { PrismaClient } from '.prisma/client-order';
import https from 'https';
import http from 'http';

const prisma = new PrismaClient();

async function fetchOrganization(orgId: string, token: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const url = `https://tymoe.com/api/auth-service/v1/organizations/${orgId}`;
    const urlObj = new URL(url);

    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      timeout: 5000,
    };

    const req = https.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        try {
          if (res.statusCode === 200) {
            const result = JSON.parse(data);
            resolve(result.data);
          } else {
            reject(new Error(`HTTP ${res.statusCode}`));
          }
        } catch (error) {
          reject(error);
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    req.end();
  });
}

async function main() {
  const templateId = process.argv[2];
  const token = process.argv[3];

  if (!templateId || !token) {
    console.log('❌ 使用方法:');
    console.log('   npx tsx scripts/update-template-org-info.ts <templateId> <token>');
    console.log('');
    console.log('📝 示例:');
    console.log('   npx tsx scripts/update-template-org-info.ts abc-123 eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...');
    process.exit(1);
  }

  console.log('🔍 查找模板...\n');

  const template = await prisma.receiptTemplate.findUnique({
    where: { id: templateId },
  });

  if (!template) {
    console.error('❌ 模板不存在:', templateId);
    process.exit(1);
  }

  console.log('✅ 找到模板:', template.name);
  console.log('   组织ID:', template.tenantId);
  console.log('');

  console.log('🔍 获取组织信息...\n');

  try {
    const orgInfo = await fetchOrganization(template.tenantId, token);

    console.log('✅ 组织信息:');
    console.log('   名称:', orgInfo.orgName);
    console.log('   地址:', orgInfo.location);
    console.log('   电话:', orgInfo.phone);
    console.log('   邮箱:', orgInfo.email);
    console.log('');

    // 更新模板配置
    const config = template.config as any;

    if (!config.header) {
      config.header = {};
    }

    // 更新店铺名称
    if (config.header.storeName) {
      config.header.storeName.text = orgInfo.orgName;
    }

    // 更新店铺信息
    if (config.header.storeInfo) {
      config.header.storeInfo.address = orgInfo.location;
      config.header.storeInfo.phone = orgInfo.phone;
      config.header.storeInfo.email = orgInfo.email;
    }

    console.log('💾 更新模板...\n');

    await prisma.receiptTemplate.update({
      where: { id: templateId },
      data: {
        config: config,
        version: { increment: 1 },
      },
    });

    console.log('✅ 模板已更新!');
    console.log('   新版本:', template.version + 1);
    console.log('');
    console.log('🎉 完成!');

  } catch (error: any) {
    console.error('❌ 获取组织信息失败:', error.message);
    process.exit(1);
  }
}

main()
  .catch((e) => {
    console.error('❌ 错误:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
