# 差异化定价 & 简化订单号设计

## 1. 差异化定价方案

### 1.1 问题
不同订单来源的商品价格可能不同：
- **堂食/POS**: 原价 ¥38
- **外卖平台**: 加价10% = ¥41.8 (覆盖包装、平台费等成本)
- **企业合作**: 折扣5% = ¥36.1

### 1.2 解决方案

#### 方案A: 订单来源配置中设置价格调整策略 (推荐)

```prisma
model OrderSourceConfig {
  // ... 其他字段
  
  // 定价策略
  priceAdjustmentType String? @default("NONE") @map("price_adjustment_type")
  // NONE: 不调整价格
  // PERCENTAGE: 按百分比调整
  // FIXED: 固定金额调整
  
  priceAdjustmentRate Decimal? @map("price_adjustment_rate") @db.Decimal(5, 4)
  // 价格调整比例，如 0.1000 = 10%加价, -0.0500 = 5%折扣
  
  priceAdjustmentFixed Decimal? @map("price_adjustment_fixed") @db.Decimal(10, 2)
  // 固定调整金额，如 2.00 = 每个商品加2元
}
```

**创建订单来源时配置**:
```typescript
// 美团外卖 - 加价10%
await orderSourceConfigService.createOrderSource({
  name: '美团外卖',
  code: 'MT',
  priceAdjustmentType: 'PERCENTAGE',
  priceAdjustmentRate: 0.10,  // 10%加价
  platformFeeRate: 0.18        // 18%平台费
});

// 企业合作 - 折扣5%
await orderSourceConfigService.createOrderSource({
  name: '某企业食堂',
  code: 'CORP',
  priceAdjustmentType: 'PERCENTAGE',
  priceAdjustmentRate: -0.05,  // 5%折扣
  platformFeeRate: 0
});
```

**订单创建时自动应用价格调整**:
```typescript
// CustomOrderService.transformToStandardOrder()
async transformToStandardOrder(data: any, config: OrderSourceConfig) {
  // 应用价格调整
  const adjustedItems = data.items.map(item => {
    let adjustedPrice = item.unitPrice;
    
    if (config.priceAdjustmentType === 'PERCENTAGE') {
      // 百分比调整
      const rate = parseFloat(config.priceAdjustmentRate?.toString() || '0');
      adjustedPrice = item.unitPrice * (1 + rate);
    } else if (config.priceAdjustmentType === 'FIXED') {
      // 固定金额调整
      const fixed = parseFloat(config.priceAdjustmentFixed?.toString() || '0');
      adjustedPrice = item.unitPrice + fixed;
    }
    
    return {
      ...item,
      unitPrice: adjustedPrice,
      originalPrice: item.unitPrice,  // 保存原价用于对比
      totalPrice: adjustedPrice * item.quantity
    };
  });
  
  const subtotal = adjustedItems.reduce((sum, item) => sum + item.totalPrice, 0);
  
  // 计算平台费
  let platformFee = 0;
  if (config.platformFeeType === 'PERCENTAGE') {
    platformFee = subtotal * parseFloat(config.platformFeeRate?.toString() || '0');
  }
  
  return {
    orderSource: OrderSource.CUSTOM,
    orderSourceConfigId: config.id,
    items: adjustedItems,
    subtotal: subtotal,
    platformFee: platformFee,
    totalAmount: subtotal + platformFee,
    orderSourceMeta: {
      priceAdjustmentApplied: config.priceAdjustmentType !== 'NONE',
      priceAdjustmentType: config.priceAdjustmentType,
      priceAdjustmentRate: config.priceAdjustmentRate,
      originalSubtotal: data.items.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0)
    }
  };
}
```

#### 方案B: 商品表中为不同来源设置价格 (备选)

```prisma
model MenuItem {
  id          String   @id
  name        String
  basePrice   Decimal  // 基础价格
  
  // 不同来源的价格
  prices      MenuItemPrice[]
}

model MenuItemPrice {
  id                  String   @id
  menuItemId          String
  orderSourceConfigId String?  // null表示系统预设来源
  orderSource         OrderSource?
  price               Decimal
  
  menuItem            MenuItem @relation(fields: [menuItemId], references: [id])
}
```

**优缺点对比**:

| 方案 | 优点 | 缺点 |
|------|------|------|
| 方案A (配置调整) | 简单灵活，易于管理，适合统一调价 | 无法针对单个商品精确定价 |
| 方案B (商品价格表) | 可以精确控制每个商品价格 | 复杂度高，维护成本大 |

**推荐**: 使用方案A，如果需要个别商品特殊定价，可以在订单创建时手动覆盖。

---

## 2. 简化订单号设计

### 2.1 问题
- 非外卖订单(POS、KIOSK、堂食)需要简单的取餐号，方便叫号
- 外卖订单需要完整的订单号用于追踪和对账

### 2.2 解决方案

#### 订单号规则

```typescript
// 非外卖订单: 简单数字序号
订单号: "1", "2", "3" ... "999"
取餐号: 1, 2, 3 ... 999
显示: "1号" "2号" "3号"

// 外卖订单: 完整格式
订单号: "MT-20241023-0001"
取餐号: null (不需要叫号)
显示: "MT-20241023-0001"
```

#### 实现逻辑

```typescript
// BaseOrderSource 添加方法
abstract class BaseOrderSource {
  /**
   * 是否使用简单订单号(作为取餐号)
   */
  useSimpleOrderNumber(): boolean {
    return true; // 默认使用简单订单号
  }
}

// 不同处理器的实现
class POSOrderService extends BaseOrderSource {
  useSimpleOrderNumber(): boolean {
    return true; // POS订单使用简单序号: 1, 2, 3
  }
}

class KioskOrderService extends BaseOrderSource {
  useSimpleOrderNumber(): boolean {
    return true; // KIOSK订单使用简单序号: 1, 2, 3
  }
}

class CustomOrderService extends BaseOrderSource {
  useSimpleOrderNumber(config?: OrderSourceConfig): boolean {
    // 根据订单类型判断
    // 如果是外卖配送，使用复杂订单号
    // 如果是自取，使用简单订单号
    return config?.config?.orderType !== 'DELIVERY';
  }
}

class UberEatsOrderService extends BaseOrderSource {
  useSimpleOrderNumber(): boolean {
    return false; // 外卖订单使用复杂格式: UE-20241023-0001
  }
}
```

#### 订单号生成服务

```typescript
class OrderService {
  /**
   * 生成订单号
   */
  private async generateOrderNumber(
    handler: BaseOrderSource,
    config?: OrderSourceConfig
  ): Promise<{ orderNumber: string; pickupNumber: number | null }> {
    
    const useSimple = handler.useSimpleOrderNumber(config);
    
    if (useSimple) {
      // 生成简单序号
      const number = await this.generateSimpleOrderNumber();
      return {
        orderNumber: number.toString(),
        pickupNumber: number
      };
    } else {
      // 生成复杂格式
      const prefix = handler.getOrderNumberPrefix(config);
      const orderNumber = await this.generateComplexOrderNumber(prefix);
      return {
        orderNumber: orderNumber,
        pickupNumber: null
      };
    }
  }

  /**
   * 生成简单订单号(取餐号)
   * 当日循环: 1-999
   */
  private async generateSimpleOrderNumber(): Promise<number> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    // 获取今日最大取餐号
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
      // 循环使用 1-999
      sequence = (lastOrder.pickupNumber % 999) + 1;
    }

    return sequence;
  }

  /**
   * 生成复杂订单号(外卖订单)
   * 格式: MT-20241023-0001
   */
  private async generateComplexOrderNumber(prefix: string): Promise<string> {
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
}
```

---

## 3. 完整示例

### 3.1 POS订单 (简单序号)

```typescript
// 创建POS订单
POST /api/order/v1/orders
{
  "orderSource": "POS",
  "orderType": "DINE_IN",
  "tableNumber": "A5",
  "items": [
    {
      "itemId": "item-1",
      "itemName": "宫保鸡丁",
      "quantity": 1,
      "unitPrice": 38.00
    }
  ]
}

// 响应
{
  "id": "uuid-1",
  "orderNumber": "42",      // 简单序号
  "pickupNumber": 42,       // 取餐号
  "orderSource": "POS",
  "totalAmount": 38.00
}

// 小票显示
=============================
        取餐号
         42
=============================
桌号: A5
宫保鸡丁 x1      ¥38.00
-----------------------------
合计:            ¥38.00
=============================
```

### 3.2 KIOSK订单 (简单序号)

```typescript
// 创建KIOSK订单
POST /api/order/v1/orders
{
  "orderSource": "KIOSK",
  "orderType": "TAKEOUT",
  "customerName": "张三",
  "items": [...]
}

// 响应
{
  "orderNumber": "43",      // 简单序号
  "pickupNumber": 43,       // 取餐号
  "pickupName": "张三"
}

// 小票显示 (超大字体)
=============================
        取餐号
         43
        张三
=============================
```

### 3.3 美团外卖订单 (复杂格式 + 加价)

```typescript
// 1. 创建美团配置
POST /api/order/v1/order-sources
{
  "name": "美团外卖",
  "code": "MT",
  "priceAdjustmentType": "PERCENTAGE",
  "priceAdjustmentRate": 0.10,  // 10%加价
  "platformFeeRate": 0.18,
  "config": {
    "orderType": "DELIVERY"  // 标记为外卖
  }
}

// 2. 创建美团订单
POST /api/order/v1/orders
{
  "orderSource": "CUSTOM",
  "orderSourceConfigId": "uuid-mt",
  "orderType": "DELIVERY",
  "items": [
    {
      "itemId": "item-1",
      "itemName": "宫保鸡丁",
      "quantity": 1,
      "unitPrice": 38.00  // 原价
    }
  ]
}

// 响应
{
  "orderNumber": "MT-20241023-0001",  // 复杂格式
  "pickupNumber": null,               // 外卖不需要取餐号
  "items": [
    {
      "itemName": "宫保鸡丁",
      "quantity": 1,
      "unitPrice": 41.80,    // 自动加价10%
      "originalPrice": 38.00  // 保存原价
    }
  ],
  "subtotal": 41.80,
  "platformFee": 7.52,  // 18%平台费
  "totalAmount": 49.32
}

// 厨房单显示
=============================
【美团外卖】MT-20241023-0001
-----------------------------
宫保鸡丁 x1
配送地址: 中关村大街1号
备注: 不要辣
=============================
```

### 3.4 企业合作订单 (简单序号 + 折扣)

```typescript
// 1. 创建企业合作配置
POST /api/order/v1/order-sources
{
  "name": "某企业食堂",
  "code": "CORP",
  "priceAdjustmentType": "PERCENTAGE",
  "priceAdjustmentRate": -0.05,  // 5%折扣
  "platformFeeRate": 0,
  "config": {
    "orderType": "TAKEOUT"  // 自取
  }
}

// 2. 创建订单
POST /api/order/v1/orders
{
  "orderSource": "CUSTOM",
  "orderSourceConfigId": "uuid-corp",
  "orderType": "TAKEOUT",
  "items": [
    {
      "itemName": "宫保鸡丁",
      "quantity": 1,
      "unitPrice": 38.00
    }
  ]
}

// 响应
{
  "orderNumber": "44",      // 简单序号(因为是自取)
  "pickupNumber": 44,
  "items": [
    {
      "unitPrice": 36.10,    // 自动折扣5%
      "originalPrice": 38.00
    }
  ],
  "subtotal": 36.10,
  "platformFee": 0,
  "totalAmount": 36.10
}
```

---

## 4. 叫号屏显示

```typescript
// 获取待取餐订单(只显示有取餐号的订单)
GET /api/order/v1/orders/pickup-queue

// 响应
{
  "preparing": [
    { "pickupNumber": 40, "pickupName": "李四", "status": "PREPARING" },
    { "pickupNumber": 41, "pickupName": "王五", "status": "PREPARING" }
  ],
  "ready": [
    { "pickupNumber": 38, "pickupName": "张三", "status": "READY" },
    { "pickupNumber": 39, "pickupName": null, "status": "READY" }  // POS订单
  ]
}

// 叫号屏显示
┌─────────────────────────────┐
│      请取餐                  │
├─────────────────────────────┤
│   38号  张三                 │
│   39号                       │
├─────────────────────────────┤
│      制作中                  │
├─────────────────────────────┤
│   40号  李四                 │
│   41号  王五                 │
└─────────────────────────────┘
```

---

## 5. 优势总结

### 5.1 差异化定价
✅ 灵活配置不同来源的价格策略  
✅ 自动计算调整后的价格  
✅ 保留原价用于对比和报表  
✅ 支持百分比和固定金额两种方式  

### 5.2 简化订单号
✅ 非外卖订单使用简单数字，方便叫号  
✅ 外卖订单使用完整格式，便于追踪  
✅ 自动循环使用1-999，避免数字过大  
✅ 统一存储在同一个字段，简化查询  

### 5.3 用户体验
✅ 顾客容易记住取餐号  
✅ 叫号屏显示清晰  
✅ 减少取错餐的情况  
✅ 外卖订单有完整追踪信息  

这个设计既满足了不同场景的需求，又保持了系统的简洁性！
