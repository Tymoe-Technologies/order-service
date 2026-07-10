# 订单价格处理逻辑

## 概述

订单服务基于**信任级别**采用不同的价格处理策略：

| 订单来源 | 信任级别 | 价格计算位置 | 后端验证 | 适用场景 |
|---------|---------|-------------|---------|---------|
| **POS** | ✅ 可信 | 前端（POS 机） | ❌ 不验证 | 员工使用，物理安全 |
| **KIOSK** | ✅ 可信 | 前端（KIOSK） | ❌ 不验证 | 店内自助，物理安全 |
| **WEB** | ⚠️ 不可信 | 前端 | ✅ 后端验证 | 客户自助，需要验证 |

---

## 设计理念

### 为什么 POS/KIOSK 不需要验证？

**1. 物理安全**
- POS 机在商家物理控制下
- KIOSK 在店内，有监控和现场管理
- 篡改风险极低

**2. 性能考虑**
- 避免每次下单都调用 Item 服务
- 降低服务器负载和成本
- 减少订单创建延迟
- 支持离线模式（POS 断网仍可下单）

**3. 业务实践**
- POS 机需要员工认证才能使用
- 价格由商家自己设定和控制
- 商家自己审核订单和对账

### 为什么 WEB 需要验证？

**1. 安全风险**
- 客户可以通过浏览器调试修改价格
- 恶意用户可能篡改请求数据
- 无物理监控和现场管理

**2. 合规要求**
- 需要确保计费准确性
- 防止价格欺诈
- 保护商家利益

---

## 技术实现

### 1. 配置项

在 `.env` 文件中配置可信来源：

```env
# 可信任的订单来源（逗号分隔）
# 这些来源的价格不会被后端验证
TRUSTED_ORDER_SOURCES=POS,KIOSK

# Item 服务地址（用于 Web 端价格验证，可选）
ITEM_SERVICE_URL=http://localhost:3001
```

### 2. 服务层实现

```typescript
// src/services/order.service.ts

export class OrderService {
  // 从环境变量读取可信来源列表
  private trustedSources = (process.env.TRUSTED_ORDER_SOURCES || 'POS,KIOSK').split(',');
  
  /**
   * 判断是否需要验证价格
   */
  private needsPriceValidation(orderSource: string): boolean {
    return !this.trustedSources.includes(orderSource);
  }
  
  async createOrder(data: CreateOrderData, userId: string, tenantId: string, token?: string) {
    const orderSource = data.orderSource || 'POS';
    
    if (this.needsPriceValidation(orderSource)) {
      // 不可信来源：调用 Item 服务验证价格
      const validated = await this.validateAndCalculateOrderPrices(
        data.items,
        orderSource,
        token!
      );
      // 使用验证后的价格
    } else {
      // 可信来源：直接使用前端传来的价格
      // 不进行额外验证
    }
  }
}
```

### 3. 价格计算逻辑（POS/KIOSK）

对于可信来源，直接使用前端计算的价格：

```typescript
// 前端计算逻辑（在 POS/KIOSK 应用中）
const item = {
  itemId: "item-123",
  itemName: "珍珠奶茶",
  quantity: 2,
  unitPrice: 15.00,  // 从 Item 服务获取的基础价格
  modifiers: [
    {
      optionId: "modifier-001",
      optionName: "大杯",
      groupName: "杯型",
      unitPrice: 2.00,
      quantity: 1
    },
    {
      optionId: "modifier-002",
      optionName: "珍珠",
      groupName: "加料",
      unitPrice: 1.00,
      quantity: 2  // 双份珍珠
    }
  ]
};

// 商品小计 = 数量 × 单价
const itemTotal = item.quantity * item.unitPrice;  // 2 × 15 = 30

// 修饰符总价 = Σ(modifier.unitPrice × modifier.quantity)
const modifiersTotal = item.modifiers.reduce(
  (sum, modifier) => sum + (modifier.unitPrice * modifier.quantity), 
  0
);  // (2.00 × 1) + (1.00 × 2) = 4.00

// 总价 = 商品小计 + (修饰符总价 × 商品数量)
const totalPrice = itemTotal + modifiersTotal * item.quantity;  // 30 + 4×2 = 38
```

后端接收后直接使用：

```typescript
// 后端不验证，直接使用前端计算的价格
orderItems = data.items.map((item) => {
  const itemTotal = item.quantity * item.unitPrice;
  // 计算修饰符总价: Σ(modifier.unitPrice × modifier.quantity)
  const modifiersTotal = item.modifiers?.reduce(
    (sum, modifier) => sum + (modifier.unitPrice * modifier.quantity), 
    0
  ) || 0;
  const totalPrice = itemTotal + modifiersTotal * item.quantity;
  subtotal += totalPrice;
  
  return {
    itemId: item.itemId,
    itemName: item.itemName,
    quantity: item.quantity,
    unitPrice: new Decimal(item.unitPrice),
    totalPrice: new Decimal(totalPrice),
    modifiers: item.modifiers || null,
    // ...
  };
});
```

### 4. 价格验证逻辑（WEB，未来实现）

对于不可信来源，需要调用 Item 服务验证：

```typescript
/**
 * 未来实现步骤：
 * 1. 安装 axios: npm install axios
 * 2. 配置 ITEM_SERVICE_URL 环境变量
 * 3. 为每个商品调用 Item 服务的 /pricing/calculate API
 * 4. 验证前端价格和后端计算的价格是否一致
 * 5. 如果不一致，拒绝订单
 */
private async validateAndCalculateOrderPrices(
  items: CreateOrderItem[],
  orderSource: string,
  token: string
): Promise<{ items: any[]; subtotal: number }> {
  const itemServiceUrl = process.env.ITEM_SERVICE_URL;
  
  // 对每个商品调用定价服务
  for (const item of items) {
    const response = await axios.post(
      `${itemServiceUrl}/pricing/calculate`,
      {
        itemId: item.itemId,
        sourceCode: orderSource,
        modifiers: item.modifiers?.map(m => ({
          optionId: m.optionId,
          quantity: m.quantity
        }))
      },
      {
        headers: { Authorization: token }
      }
    );
    
    // 验证价格
    const backendPrice = response.data.totalPrice;
    const frontendPrice = item.unitPrice + 
      (item.modifiers?.reduce((sum, m) => sum + (m.unitPrice * m.quantity), 0) || 0);
    
    if (Math.abs(backendPrice - frontendPrice) > 0.01) {
      throw new AppError(400, 'PRICE_MISMATCH', '价格验证失败');
    }
  }
  
  // 返回验证后的商品列表和小计
}
```

---

## 数据流程

### POS/KIOSK 流程

```
┌─────────────┐
│  POS/KIOSK  │
│   前端应用   │
└──────┬──────┘
       │
       │ 1. 从 Item 服务获取商品价格
       ▼
┌─────────────┐
│ Item Service│
└──────┬──────┘
       │
       │ 2. 在前端计算总价
       ▼
┌─────────────┐
│ 前端计算价格 │
│ unitPrice +  │
│ modifiers    │
└──────┬──────┘
       │
       │ 3. 提交订单（带价格）
       ▼
┌─────────────┐
│Order Service│ ← 直接接受价格，不验证
└──────┬──────┘
       │
       │ 4. 保存订单
       ▼
┌─────────────┐
│  Database   │
└─────────────┘
```

**特点**：
- ✅ 快速：无额外服务调用
- ✅ 低成本：减少服务器负载
- ✅ 离线友好：POS 断网可继续下单

### WEB 流程（未来）

```
┌─────────────┐
│  Web 前端   │
└──────┬──────┘
       │
       │ 1. 从 Item 服务获取商品价格
       ▼
┌─────────────┐
│ Item Service│
└──────┬──────┘
       │
       │ 2. 在前端计算总价
       ▼
┌─────────────┐
│ 前端计算价格 │
└──────┬──────┘
       │
       │ 3. 提交订单（带价格）
       ▼
┌─────────────┐
│Order Service│
└──────┬──────┘
       │
       │ 4. 调用 Item 服务验证价格
       ▼
┌─────────────┐
│ Item Service│
│ /pricing/   │
│ calculate   │
└──────┬──────┘
       │
       │ 5. 验证通过后保存
       ▼
┌─────────────┐
│  Database   │
└─────────────┘
```

**特点**：
- ✅ 安全：后端验证防止篡改
- ⚠️ 较慢：需要额外的验证请求
- ⚠️ 成本高：增加服务器负载

---

## 安全考虑

### 基础验证（所有来源）

即使对于可信来源，仍然进行基本的数据格式验证：

```typescript
// src/validators/order.validator.ts
export const createOrderSchema = Joi.object({
  items: Joi.array()
    .items(
      Joi.object({
        itemId: Joi.string().uuid().required(),
        itemName: Joi.string().max(255).required(),
        quantity: Joi.number().integer().min(1).required(),
        unitPrice: Joi.number().min(0).required(),  // 确保价格非负
        modifiers: Joi.array()
          .items(
            Joi.object({
              optionId: Joi.string().uuid().required(),
              optionName: Joi.string().required(),
              groupName: Joi.string().optional(),
              unitPrice: Joi.number().min(0).required(),  // 确保价格非负
              quantity: Joi.number().integer().min(1).required(),
            })
          )
          .optional(),
      })
    )
    .min(1)
    .required(),
});
```

### 日志记录

所有订单创建都会记录详细日志：

```typescript
logger.info(`Order created: ${order.orderNumber}`, { 
  orderId: order.id,
  orderSource,
  priceValidated: this.needsPriceValidation(orderSource),
  subtotal,
  totalAmount
});
```

可以通过日志审计订单创建过程：
- 价格是否被验证
- 订单来源
- 金额明细

### 后续审计

商家可以通过对账功能定期审核订单：
- 检查异常金额的订单
- 对比 Item 服务的价格历史
- 识别潜在的价格错误

---

## 配置管理

### 开发环境

```env
# .env.development
TRUSTED_ORDER_SOURCES=POS,KIOSK
# Item 服务未部署，Web 端暂不可用
```

### 生产环境

```env
# .env.production
TRUSTED_ORDER_SOURCES=POS,KIOSK
ITEM_SERVICE_URL=https://item-service.example.com
```

### 紧急情况

如果发现价格篡改问题，可以临时调整配置：

```env
# 紧急情况：移除某个来源的信任级别
TRUSTED_ORDER_SOURCES=POS
# KIOSK 将开始验证价格
```

---

## 未来扩展

### 支持 Web 端

1. **实现价格验证方法**

```typescript
private async validateAndCalculateOrderPrices(
  items: CreateOrderItem[],
  orderSource: string,
  token: string
): Promise<{ items: any[]; subtotal: number }> {
  // 实现完整的价格验证逻辑
}
```

2. **安装依赖**

```bash
npm install axios
```

3. **配置环境变量**

```env
ITEM_SERVICE_URL=https://item-service.example.com
```

4. **更新文档**

在 `API.md` 中说明 Web 端需要提供 Authorization 头。

### 支持混合模式

允许部分商家对 POS 也启用价格验证：

```typescript
// 支持每个租户自定义配置
interface TenantPricingConfig {
  tenantId: string;
  trustedSources: string[];
  priceValidationEnabled: boolean;
}
```

### 支持价格审计

定期检查订单价格和 Item 服务价格的一致性：

```typescript
// 每日审计任务
async function auditOrderPrices() {
  // 检查最近的订单
  // 对比 Item 服务的价格
  // 生成审计报告
}
```

---

## 常见问题

### Q1: POS 价格计算错误怎么办？

**A**: 
1. POS 应用应该直接从 Item 服务获取最新价格
2. Item 服务应该提供价格缓存机制
3. 商家可以通过对账功能定期审核
4. 如果发现错误，可以手动调整订单

### Q2: KIOSK 被恶意修改怎么办？

**A**:
1. KIOSK 应该运行在 kiosk 模式，禁止访问系统
2. KIOSK 应该定期更新和重启，清除可能的篡改
3. KIOSK 有物理监控，可以发现异常行为
4. 如果担心安全，可以将 KIOSK 从可信列表移除

### Q3: 如何测试价格验证功能？

**A**:
```env
# 测试环境：临时将 POS 设为不可信
TRUSTED_ORDER_SOURCES=KIOSK
# POS 将尝试验证价格，触发 NOT_IMPLEMENTED 错误
```

### Q4: 性能影响有多大？

**A**:
- **POS/KIOSK**（当前实现）：几乎无影响，直接接受价格
- **WEB**（未来实现）：每个订单需要 N 次 Item 服务调用（N = 商品数量），增加约 100-500ms 延迟

---

## 总结

当前实现专注于 **POS 和 KIOSK 的高性能订单创建**，通过信任级别机制保证了：

✅ **性能**: 无额外服务调用  
✅ **成本**: 减少服务器负载  
✅ **体验**: 订单创建快速流畅  
✅ **安全**: 物理环境保证安全性  
✅ **扩展**: 为 Web 端预留验证接口  

未来支持 Web 端时，只需实现 `validateAndCalculateOrderPrices` 方法即可，不影响现有的 POS/KIOSK 功能。

