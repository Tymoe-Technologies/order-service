# 订单号优化方案 - 分离订单号与取餐号

## 问题分析

纯数字订单号的问题：
1. ❌ 跨日期查询困难 (今天的"42"和昨天的"42"无法区分)
2. ❌ 不同来源的订单号可能重复
3. ❌ 数据库索引效率低
4. ❌ 订单追溯困难
5. ❌ API查询时容易混淆

## 优化方案：订单号 + 取餐号分离

### 核心思想
- **订单号 (orderNumber)**: 唯一标识，用于系统查询、追踪、对账
- **取餐号 (pickupNumber)**: 简单数字，仅用于叫号和顾客识别

```
所有订单都有唯一的订单号
非外卖订单额外生成取餐号用于叫号
```

---

## 数据模型

```prisma
model Order {
  id              String   @id @default(uuid())
  
  // 订单号 - 唯一标识 (必填)
  orderNumber     String   @unique @map("order_number") @db.VarChar(50)
  // 格式: POS-20241023-0001, KIOSK-20241023-0042, MT-20241023-0001
  
  // 取餐号 - 用于叫号 (可选)
  pickupNumber    Int?     @map("pickup_number")
  // 简单数字: 1, 2, 3 ... 999 (仅非外卖订单)
  
  // 取餐名 - 用于KIOSK订单
  pickupName      String?  @map("pickup_name")
  
  orderSource     OrderSource
  orderType       OrderType
  
  @@index([orderNumber])
  @@index([pickupNumber, createdAt])  // 用于叫号屏查询
}
```

---

## 订单号生成规则

### 规则1: 所有订单都有完整订单号

```typescript
订单号格式: {来源前缀}-{日期}-{序号}

POS订单:    POS-20241023-0001
KIOSK订单:  KIOSK-20241023-0042
Web订单:    WEB-20241023-0015
美团订单:   MT-20241023-0008
饿了么订单: ELM-20241023-0023
```

**优点**:
- ✅ 全局唯一
- ✅ 包含日期信息，易于查询
- ✅ 包含来源信息，易于识别
- ✅ 支持跨日期查询
- ✅ 数据库索引友好

### 规则2: 非外卖订单额外生成取餐号

```typescript
取餐号: 1, 2, 3 ... 999 (当日循环)

适用场景:
- POS订单 (堂食/自取)
- KIOSK订单 (自取)
- Web订单 (自取)
- 自定义来源的自取订单

不适用:
- 外卖配送订单 (不需要叫号)
```

---

## 实现代码

```typescript
class OrderService {
  async createOrder(
    orderSource: OrderSource,
    data: any,
    context: OrderContext
  ): Promise<Order> {
    const handler = this.sourceHandlers.get(orderSource);
    
    // 1. 生成完整订单号 (所有订单都有)
    const prefix = handler.getOrderNumberPrefix(context.sourceConfig);
    const orderNumber = await this.generateOrderNumber(prefix);
    // 结果: "POS-20241023-0001"
    
    // 2. 判断是否需要取餐号
    let pickupNumber = null;
    if (handler.needsPickupNumber(data, context.sourceConfig)) {
      pickupNumber = await this.generatePickupNumber();
      // 结果: 42
    }
    
    // 3. 创建订单
    const order = await prisma.order.create({
      data: {
        ...standardData,
        orderNumber: orderNumber,    // POS-20241023-0001
        pickupNumber: pickupNumber,  // 42
        tenantId: context.tenantId,
        status: OrderStatus.PENDING
      }
    });
    
    return order;
  }

  /**
   * 生成订单号 (所有订单)
   * 格式: POS-20241023-0001
   */
  private async generateOrderNumber(prefix: string): Promise<string> {
    const today = new Date();
    const dateStr = today.toISOString().split('T')[0].replace(/-/g, '');
    
    const lastOrder = await prisma.order.findFirst({
      where: {
        orderNumber: {
          startsWith: `${prefix}-${dateStr}`
        }
      },
      orderBy: {
        orderNumber: 'desc'
      }
    });

    let sequence = 1;
    if (lastOrder) {
      const parts = lastOrder.orderNumber.split('-');
      const lastSequence = parseInt(parts[parts.length - 1] || '0');
      sequence = lastSequence + 1;
    }

    return `${prefix}-${dateStr}-${sequence.toString().padStart(4, '0')}`;
  }

  /**
   * 生成取餐号 (仅非外卖订单)
   * 简单数字: 1-999 (当日循环)
   */
  private async generatePickupNumber(): Promise<number> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const lastOrder = await prisma.order.findFirst({
      where: {
        createdAt: {
          gte: today,
          lt: tomorrow
        },
        pickupNumber: { not: null }
      },
      orderBy: {
        pickupNumber: 'desc'
      }
    });

    let sequence = 1;
    if (lastOrder?.pickupNumber) {
      sequence = (lastOrder.pickupNumber % 999) + 1;
    }

    return sequence;
  }
}
```

---

## 处理器实现

```typescript
abstract class BaseOrderSource {
  /**
   * 是否需要生成取餐号
   */
  needsPickupNumber(data: any, config?: OrderSourceConfig): boolean {
    // 默认: 非外卖订单需要取餐号
    return data.orderType !== OrderType.DELIVERY;
  }
  
  abstract getOrderNumberPrefix(config?: OrderSourceConfig): string;
}

// POS订单处理器
class POSOrderService extends BaseOrderSource {
  getOrderNumberPrefix(): string {
    return 'POS';
  }
  
  needsPickupNumber(data: any): boolean {
    // POS订单: 堂食和自取需要取餐号，外卖不需要
    return data.orderType !== OrderType.DELIVERY;
  }
}

// KIOSK订单处理器
class KioskOrderService extends BaseOrderSource {
  getOrderNumberPrefix(): string {
    return 'KIOSK';
  }
  
  needsPickupNumber(): boolean {
    return true; // KIOSK订单总是需要取餐号
  }
}

// 自定义来源处理器
class CustomOrderService extends BaseOrderSource {
  getOrderNumberPrefix(config?: OrderSourceConfig): string {
    return config?.code || 'CUSTOM';
  }
  
  needsPickupNumber(data: any, config?: OrderSourceConfig): boolean {
    // 根据订单类型判断
    return data.orderType !== OrderType.DELIVERY;
  }
}

// Uber Eats处理器
class UberEatsOrderService extends BaseOrderSource {
  getOrderNumberPrefix(): string {
    return 'UE';
  }
  
  needsPickupNumber(): boolean {
    return false; // 外卖订单不需要取餐号
  }
}
```

---

## 使用示例

### 示例1: POS堂食订单

```typescript
POST /api/order/v1/orders
{
  "orderSource": "POS",
  "orderType": "DINE_IN",
  "tableNumber": "A5",
  "items": [...]
}

// 响应
{
  "id": "uuid-1",
  "orderNumber": "POS-20241023-0001",  // 完整订单号
  "pickupNumber": 42,                   // 取餐号
  "orderSource": "POS",
  "orderType": "DINE_IN"
}

// 小票显示
=============================
订单号: POS-20241023-0001
-----------------------------
        取餐号
         42
=============================
桌号: A5
宫保鸡丁 x1      ¥38.00
-----------------------------
合计:            ¥38.00
=============================
```

### 示例2: KIOSK自助订单

```typescript
POST /api/order/v1/orders
{
  "orderSource": "KIOSK",
  "orderType": "TAKEOUT",
  "customerName": "张三",
  "items": [...]
}

// 响应
{
  "orderNumber": "KIOSK-20241023-0042",  // 完整订单号
  "pickupNumber": 43,                     // 取餐号
  "pickupName": "张三"
}

// 小票显示 (超大字体)
=============================
订单号: KIOSK-20241023-0042
-----------------------------
        取餐号
         43
        张三
=============================
```

### 示例3: 美团外卖订单

```typescript
POST /api/order/v1/orders
{
  "orderSource": "CUSTOM",
  "orderSourceConfigId": "uuid-mt",
  "orderType": "DELIVERY",
  "items": [...]
}

// 响应
{
  "orderNumber": "MT-20241023-0008",  // 完整订单号
  "pickupNumber": null,                // 外卖不需要取餐号
  "orderType": "DELIVERY"
}

// 厨房单显示
=============================
【美团外卖】
订单号: MT-20241023-0008
-----------------------------
宫保鸡丁 x1
配送地址: 中关村大街1号
=============================
```

---

## API设计

### 1. 按订单号查询 (精确查询)

```typescript
GET /api/order/v1/orders/by-number/:orderNumber

// 示例
GET /api/order/v1/orders/by-number/POS-20241023-0001
GET /api/order/v1/orders/by-number/MT-20241023-0008

// 响应
{
  "success": true,
  "data": {
    "id": "uuid",
    "orderNumber": "POS-20241023-0001",
    "pickupNumber": 42,
    "status": "READY",
    ...
  }
}
```

### 2. 按取餐号查询 (今日订单)

```typescript
GET /api/order/v1/orders/by-pickup/:pickupNumber

// 示例
GET /api/order/v1/orders/by-pickup/42

// 自动查询今日订单
// 响应
{
  "success": true,
  "data": {
    "orderNumber": "POS-20241023-0001",
    "pickupNumber": 42,
    "status": "READY"
  }
}
```

### 3. 叫号屏查询 (只查有取餐号的订单)

```typescript
GET /api/order/v1/orders/pickup-queue

// 响应
{
  "preparing": [
    {
      "orderNumber": "KIOSK-20241023-0040",
      "pickupNumber": 40,
      "pickupName": "李四",
      "status": "PREPARING"
    }
  ],
  "ready": [
    {
      "orderNumber": "POS-20241023-0038",
      "pickupNumber": 38,
      "pickupName": null,
      "status": "READY"
    }
  ]
}
```

### 4. 订单列表查询 (支持多种筛选)

```typescript
GET /api/order/v1/orders?date=2024-10-23&orderSource=POS

// 响应
{
  "orders": [
    {
      "orderNumber": "POS-20241023-0001",
      "pickupNumber": 42,
      "createdAt": "2024-10-23T10:30:00Z"
    },
    {
      "orderNumber": "POS-20241023-0002",
      "pickupNumber": 43,
      "createdAt": "2024-10-23T10:35:00Z"
    }
  ]
}
```

---

## 显示逻辑

### 前端显示规则

```typescript
function displayOrderIdentifier(order: Order) {
  if (order.pickupNumber) {
    // 有取餐号: 优先显示取餐号 (大字体) + 订单号 (小字体)
    return {
      primary: `${order.pickupNumber}号`,        // 大字体
      secondary: order.orderNumber,              // 小字体
      showOnCallScreen: true
    };
  } else {
    // 无取餐号: 只显示订单号
    return {
      primary: order.orderNumber,
      secondary: null,
      showOnCallScreen: false
    };
  }
}

// 示例输出
// POS订单:
{
  primary: "42号",                    // 叫号屏显示
  secondary: "POS-20241023-0001"     // 详情页显示
}

// 美团订单:
{
  primary: "MT-20241023-0008",       // 详情页显示
  secondary: null
}
```

### 小票打印

```typescript
// POS/KIOSK订单小票
=============================
订单号: POS-20241023-0001
-----------------------------
        取餐号
         42              ← 超大字体
=============================

// 外卖订单厨房单
=============================
【美团外卖】
订单号: MT-20241023-0008   ← 正常字体
-----------------------------
配送地址: xxx
=============================
```

---

## 优势对比

| 方案 | 订单号 | 取餐号 | 查询 | 叫号 | 追溯 |
|------|--------|--------|------|------|------|
| **纯数字** | "42" | 42 | ❌ 困难 | ✅ 简单 | ❌ 困难 |
| **分离方案** | "POS-20241023-0001" | 42 | ✅ 简单 | ✅ 简单 | ✅ 简单 |

### 分离方案的优势

✅ **订单号唯一**: 全局唯一，支持跨日期查询  
✅ **取餐号简单**: 1-999循环，顾客容易记忆  
✅ **查询友好**: 支持按订单号、取餐号、日期等多维度查询  
✅ **追溯清晰**: 订单号包含日期和来源信息  
✅ **兼容性好**: 外卖订单只用订单号，非外卖订单两者都有  
✅ **用户体验**: 叫号时显示简单数字，查询时用完整订单号  

---

## 数据库索引优化

```sql
-- 订单号索引 (唯一)
CREATE UNIQUE INDEX idx_order_number ON orders(order_number);

-- 取餐号 + 日期索引 (用于叫号屏查询)
CREATE INDEX idx_pickup_number_date ON orders(pickup_number, created_at)
WHERE pickup_number IS NOT NULL;

-- 来源 + 日期索引 (用于统计)
CREATE INDEX idx_source_date ON orders(order_source, created_at);
```

---

## 总结

这个优化方案完美解决了原方案的问题：

1. **系统层面**: 使用完整订单号，支持精确查询和追溯
2. **用户层面**: 使用简单取餐号，方便叫号和记忆
3. **兼容性**: 外卖订单只用订单号，非外卖订单两者都有
4. **可扩展**: 未来可以在订单号中加入更多信息

**最佳实践**:
- 订单号用于系统查询、API调用、数据分析
- 取餐号用于叫号屏、小票显示、顾客沟通
- 两者各司其职，互不干扰

这就是"给凯撒的归凯撒，给上帝的归上帝"的设计哲学！ 🎯
