/**
 * 测试 JWT RS256 验证
 * 运行: npx tsx scripts/test-jwt-verify.ts
 */

import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';

// 加载环境变量
dotenv.config({ path: '.env.development' });

console.log('🔍 测试 JWT RS256 验证\n');

// 检查公钥配置
const publicKey = process.env.JWT_PUBLIC_KEY;

if (!publicKey) {
  console.error('❌ JWT_PUBLIC_KEY 未配置');
  console.log('\n请在 .env.development 中配置 JWT_PUBLIC_KEY');
  process.exit(1);
}

console.log('✅ JWT_PUBLIC_KEY 已配置');
console.log('   长度:', publicKey.length, '字符');
console.log('   开头:', publicKey.substring(0, 30) + '...');
console.log('');

// 测试 token (从命令行参数获取)
const testToken = process.argv[2];

if (!testToken) {
  console.log('💡 使用方法:');
  console.log('   npx tsx scripts/test-jwt-verify.ts YOUR_TOKEN_HERE');
  console.log('');
  console.log('📝 示例:');
  console.log('   1. 从浏览器控制台获取 token:');
  console.log('      localStorage.getItem("token")');
  console.log('');
  console.log('   2. 运行测试:');
  console.log('      npx tsx scripts/test-jwt-verify.ts eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...');
  console.log('');
  process.exit(0);
}

console.log('🔑 测试 Token:');
console.log('   长度:', testToken.length, '字符');
console.log('   开头:', testToken.substring(0, 30) + '...');
console.log('');

try {
  // 尝试验证 token
  console.log('⏳ 验证中...\n');
  
  const decoded = jwt.verify(testToken, publicKey, {
    algorithms: ['RS256'],
  });
  
  console.log('✅ Token 验证成功!\n');
  console.log('📋 Decoded Payload:');
  console.log(JSON.stringify(decoded, null, 2));
  console.log('');
  
  // 检查必要字段
  const payload = decoded as any;
  
  console.log('🔍 字段检查:');
  console.log('   userId:', payload.userId ? '✅' : '❌', payload.userId);
  console.log('   tenantId:', payload.tenantId ? '✅' : '❌', payload.tenantId);
  console.log('   exp:', payload.exp ? '✅' : '❌', payload.exp);
  
  if (payload.exp) {
    const expiresAt = new Date(payload.exp * 1000);
    const now = new Date();
    const isExpired = expiresAt < now;
    
    console.log('   过期时间:', expiresAt.toLocaleString());
    console.log('   当前时间:', now.toLocaleString());
    console.log('   是否过期:', isExpired ? '❌ 是' : '✅ 否');
  }
  
  console.log('');
  
  if (!payload.userId || !payload.tenantId) {
    console.warn('⚠️  警告: Token 缺少必要字段 (userId 或 tenantId)');
    console.log('   这可能导致 API 请求失败');
  } else {
    console.log('🎉 Token 完全有效,可以正常使用!');
  }
  
} catch (error: any) {
  console.error('❌ Token 验证失败!\n');
  
  if (error.name === 'TokenExpiredError') {
    console.error('原因: Token 已过期');
    console.error('过期时间:', new Date(error.expiredAt).toLocaleString());
  } else if (error.name === 'JsonWebTokenError') {
    console.error('原因:', error.message);
    
    if (error.message.includes('invalid signature')) {
      console.error('\n💡 可能的原因:');
      console.error('   1. 公钥不正确');
      console.error('   2. Token 是用不同的私钥签名的');
      console.error('   3. Token 格式错误');
    } else if (error.message.includes('jwt malformed')) {
      console.error('\n💡 可能的原因:');
      console.error('   1. Token 格式不正确');
      console.error('   2. Token 不完整');
    }
  } else {
    console.error('错误:', error.message);
  }
  
  console.log('');
  process.exit(1);
}
