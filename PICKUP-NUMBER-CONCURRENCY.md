# 取餐号并发安全设计

## 问题场景

多个订单来源同时创建订单时，可能产生重复的取餐号：

```
时间线:
10:30:00.100  POS收银员下单    → 查询最大取餐号: 41 → 生成: 42
10:30:00.150  KIOSK顾客下单    → 查询最大取餐号: 41 → 生成: 42  ❌ 重复!
10:30:00.200  Web顾客下单      → 查询最大取餐号: 41 → 生成: 42  ❌ 重复!
```

**核心问题**: 
- 查询和插入之间有时间差
- 多个请求并发执行
- 数据库层面没有约束

---

## 解决方案对比

### 方案1: 数据库唯一约束 + 重试 (推荐)

#### 优点
✅ 简单可靠  
✅ 数据库层面保证唯一性  
✅ 无需额外服务  
✅ 性能好  

#### 实现

```prisma
model Order {
  id              String   @id @default(uuid())
  tenantId        String   @map("tenant_id")
  orderNumber     String   @unique @map("order_number")
  pickupNumber    Int?     @map("pickup_number")
  createdAt       DateTime @default(now())
  
  // 关键: 联合唯一约束
  @@unique([tenantId, pickupNumber, createdAt(sort: Desc)])
  // 确保同一商户、同一天的取餐号唯一
  
  @@index([tenantId, pickupNumber, createdAt])
}
```

**注意**: Prisma不支持日期函数索引，需要用原生SQL创建：

```sql
-- 创建唯一索引: 同一商户、同一天的取餐号唯一
CREATE UNIQUE INDEX idx_unique_pickup_number 
ON orders (tenant_id, pickup_number, DATE(created_at))
WHERE pickup_number IS NOT NULL;
```

#### 代码实现

```typescript
class OrderService {
  /**
   * 生成取餐号 (带重试机制)
   */
  private async generatePickupNumber(
    tenantId: string,
    maxRetries: number = 5
  ): Promise<number> {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const number = await this.tryGeneratePickupNumber(tenantId);
        return number;
      } catch (error) {
        // 如果是唯一约束冲突，重试
        if (this.isUniqueConstraintError(error) && attempt < maxRetries - 1) {
          // 随机延迟 10-50ms 后重试
          await this.sleep(10 + Math.random() * 40);
          continue;
        }
        throw error;
      }
    }
    
    throw new AppError(500, 'PICKUP_NUMBER_GENERATION_FAILED', '取餐号生成失败');
  }

  /**
   * 尝试生成取餐号
   */
  private async tryGeneratePickupNumber(tenantId: string): Promise<number> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    // 查询今日最大取餐号
    const lastOrder = await prisma.order.findFirst({
      where: {
        tenantId: tenantId,
        createdAt: {
          gte: today,
          lt: tomorrow
        },
        pickupNumber: { not: null }
      },
      orderBy: {
        pickupNumber: 'desc'
      },
      select: {
        pickupNumber: true
      }
    });

    let sequence = 1;
    if (lastOrder?.pickupNumber) {
      sequence = (lastOrder.pickupNumber % 999) + 1;
    }

    return sequence;
  }

  /**
   * 创建订单 (包含取餐号)
   */
  async createOrder(
    orderSource: OrderSource,
    data: any,
    context: OrderContext
  ): Promise<Order> {
    // ... 前面的逻辑
    
    // 生成取餐号 (如果需要)
    let pickupNumber = null;
    if (handler.needsPickupNumber(data, context.sourceConfig)) {
      pickupNumber = await this.generatePickupNumber(context.tenantId);
    }
    
    // 创建订单 (数据库会检查唯一约束)
    const order = await prisma.order.create({
      data: {
        tenantId: context.tenantId,
        orderNumber: orderNumber,
        pickupNumber: pickupNumber,
        // ... 其他字段
      }
    });
    
    return order;
  }

  /**
   * 判断是否是唯一约束错误
   */
  private isUniqueConstraintError(error: any): boolean {
    return (
      error.code === 'P2002' || // Prisma unique constraint
      error.code === '23505'     // PostgreSQL unique violation
    );
  }

  /**
   * 延迟函数
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
```

---

### 方案2: 数据库序列 (PostgreSQL)

#### 优点
✅ 数据库原生支持  
✅ 性能最好  
✅ 绝对不会重复  

#### 缺点
❌ 依赖特定数据库  
❌ 不支持每日重置  
❌ 序列会一直增长  

#### 实现

```sql
-- 创建序列
CREATE SEQUENCE pickup_number_seq
  START WITH 1
  INCREMENT BY 1
  MINVALUE 1
  MAXVALUE 999
  CYCLE;  -- 到999后重新从1开始

-- 使用序列
INSERT INTO orders (
  id, 
  order_number, 
  pickup_number, 
  ...
) VALUES (
  uuid_generate_v4(),
  'POS-20241023-0001',
  nextval('pickup_number_seq'),  -- 自动获取下一个序号
  ...
);
```

**问题**: 序列无法按天重置，需要定时任务：

```typescript
// 每天凌晨重置序列
cron.schedule('0 0 * * *', async () => {
  await prisma.$executeRaw`ALTER SEQUENCE pickup_number_seq RESTART WITH 1`;
});
```

---

### 方案3: Redis分布式锁 + 计数器

#### 优点
✅ 支持分布式部署  
✅ 性能好  
✅ 支持每日自动重置  

#### 缺点
❌ 依赖Redis  
❌ 增加系统复杂度  
❌ 需要处理Redis故障  

#### 实现

```typescript
import Redis from 'ioredis';

class PickupNumberService {
  private redis: Redis;

  constructor() {
    this.redis = new Redis({
      host: process.env.REDIS_HOST,
      port: parseInt(process.env.REDIS_PORT || '6379')
    });
  }

  /**
   * 生成取餐号 (使用Redis)
   */
  async generatePickupNumber(tenantId: string): Promise<number> {
    const today = new Date().toISOString().split('T')[0];
    const key = `pickup_number:${tenantId}:${today}`;
    
    // 使用Redis INCR命令 (原子操作)
    let number = await this.redis.incr(key);
    
    // 如果是第一次创建，设置过期时间为2天
    if (number === 1) {
      await this.redis.expire(key, 60 * 60 * 24 * 2);
    }
    
    // 循环使用 1-999
    if (number > 999) {
      number = ((number - 1) % 999) + 1;
    }
    
    return number;
  }
}
```

**优点**: 
- Redis的INCR是原子操作，绝对不会重复
- 自动过期，无需手动清理
- 支持分布式部署

---

### 方案4: 数据库行锁 (悲观锁)

#### 实现

```typescript
async generatePickupNumber(tenantId: string): Promise<number> {
  return await prisma.$transaction(async (tx) => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    // 使用 FOR UPDATE 锁定行
    const lastOrder = await tx.$queryRaw<Array<{ pickup_number: number }>>`
      SELECT pickup_number
      FROM orders
      WHERE tenant_id = ${tenantId}
        AND created_at >= ${today}
        AND created_at < ${tomorrow}
        AND pickup_number IS NOT NULL
      ORDER BY pickup_number DESC
      LIMIT 1
      FOR UPDATE
    `;

    let sequence = 1;
    if (lastOrder.length > 0 && lastOrder[0].pickup_number) {
      sequence = (lastOrder[0].pickup_number % 999) + 1;
    }

    return sequence;
  });
}
```

#### 缺点
❌ 性能较差 (锁等待)  
❌ 可能导致死锁  

---

## 推荐方案选择

### 单机部署 → 方案1 (数据库唯一约束 + 重试)
```
优点: 简单可靠，无需额外依赖
适用: 大部分场景
```

### 分布式部署 + 高并发 → 方案3 (Redis)
```
优点: 性能最好，支持分布式
适用: 多实例部署，高并发场景
```

### PostgreSQL专用 → 方案2 (数据库序列)
```
优点: 数据库原生支持
适用: 只使用PostgreSQL的场景
```

---

## 最佳实践实现 (方案1 + 方案3混合)

```typescript
class OrderService {
  private pickupNumberService: PickupNumberService;
  private useRedis: boolean;

  constructor() {
    // 根据配置决定使用Redis还是数据库
    this.useRedis = process.env.USE_REDIS_FOR_PICKUP_NUMBER === 'true';
    if (this.useRedis) {
      this.pickupNumberService = new RedisPickupNumberService();
    } else {
      this.pickupNumberService = new DatabasePickupNumberService();
    }
  }

  async createOrder(...) {
    // 生成取餐号
    let pickupNumber = null;
    if (handler.needsPickupNumber(data, context.sourceConfig)) {
      pickupNumber = await this.pickupNumberService.generate(
        context.tenantId
      );
    }
    
    // 创建订单
    try {
      const order = await prisma.order.create({
        data: {
          tenantId: context.tenantId,
          orderNumber: orderNumber,
          pickupNumber: pickupNumber,
          ...
        }
      });
      return order;
    } catch (error) {
      // 如果是唯一约束冲突，重试
      if (this.isUniqueConstraintError(error)) {
        logger.warn('Pickup number conflict, retrying...', {
          tenantId: context.tenantId,
          pickupNumber
        });
        // 递归重试
        return this.createOrder(orderSource, data, context);
      }
      throw error;
    }
  }
}

// 抽象接口
interface PickupNumberService {
  generate(tenantId: string): Promise<number>;
}

// 数据库实现
class DatabasePickupNumberService implements PickupNumberService {
  async generate(tenantId: string): Promise<number> {
    // 方案1的实现
    return await this.generateWithRetry(tenantId);
  }
}

// Redis实现
class RedisPickupNumberService implements PickupNumberService {
  async generate(tenantId: string): Promise<number> {
    // 方案3的实现
    return await this.generateWithRedis(tenantId);
  }
}
```

---

## 测试验证

### 并发测试

```typescript
// 测试: 100个并发请求
async function testConcurrency() {
  const promises = [];
  
  for (let i = 0; i < 100; i++) {
    promises.push(
      orderService.createOrder('POS', {
        orderType: 'DINE_IN',
        items: [...]
      }, {
        tenantId: 'test-tenant',
        userId: 'test-user'
      })
    );
  }
  
  const orders = await Promise.all(promises);
  
  // 验证取餐号唯一性
  const pickupNumbers = orders
    .map(o => o.pickupNumber)
    .filter(n => n !== null);
  
  const uniqueNumbers = new Set(pickupNumbers);
  
  console.log('总订单数:', orders.length);
  console.log('取餐号数:', pickupNumbers.length);
  console.log('唯一取餐号:', uniqueNumbers.size);
  console.log('是否有重复:', pickupNumbers.length !== uniqueNumbers.size);
  
  // 断言
  expect(pickupNumbers.length).toBe(uniqueNumbers.size);
}
```

---

## 监控和告警

```typescript
// 监控取餐号生成失败
logger.error('Pickup number generation failed', {
  tenantId: tenantId,
  attempts: maxRetries,
  error: error.message
});

// 监控取餐号冲突率
metrics.increment('pickup_number.conflict', {
  tenant_id: tenantId
});

// 告警规则
if (conflictRate > 0.01) {  // 冲突率超过1%
  alert('取餐号冲突率过高，请检查并发控制');
}
```

---

## 总结

### 推荐方案: 数据库唯一约束 + 重试

**原因**:
1. ✅ 简单可靠，无需额外依赖
2. ✅ 数据库层面保证数据一致性
3. ✅ 重试机制处理并发冲突
4. ✅ 性能足够好 (冲突率很低)
5. ✅ 易于维护和调试

**关键点**:
- 数据库唯一索引: `(tenant_id, pickup_number, DATE(created_at))`
- 重试机制: 最多5次，随机延迟
- 错误处理: 捕获唯一约束冲突
- 监控告警: 记录冲突率

**适用场景**: 99%的场景都适用

只有在**极高并发**场景下才需要考虑Redis方案！
