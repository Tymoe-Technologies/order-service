# 迁移到分（Cents）作为价格单位

## 为什么要统一使用分？

### 优势

1. ✅ **避免浮点数精度问题**
   ```javascript
   // 使用元（浮点数）
   0.1 + 0.2 = 0.30000000000000004  // ❌ 精度问题
   
   // 使用分（整数）
   10 + 20 = 30  // ✅ 精确
   ```

2. ✅ **与 Item Service 保持一致**
   - 不需要单位转换
   - 减少出错可能

3. ✅ **数据库性能更好**
   - 整数比 Decimal 类型更快
   - 索引效率更高

4. ✅ **国际惯例**
   - Stripe、PayPal 等支付系统都使用最小货币单位
   - 符合金融系统标准

### 劣势

- ⚠️ 需要迁移现有数据
- ⚠️ 前端需要转换显示（分 -> 元）

---

## 迁移方案

### 第 1 步：修改数据库 Schema

```prisma
// shared/database/schema-order.prisma

model Order {
  id             String        @id @default(uuid()) @db.Uuid
  tenantId       String        @map("tenant_id") @db.Uuid
  orderNumber    String        @unique @map("order_number") @db.VarChar(100)
  
  // 价格字段：使用 Int 存储分
  subtotal       Int           @default(0)                    // 小计（分）
  taxAmount      Int           @default(0) @map("tax_amount") // 税费（分）
  tipAmount      Int           @default(0) @map("tip_amount") // 小费（分）
  discountAmount Int           @default(0) @map("discount_amount") // 折扣（分）
  serviceFee     Int           @default(0) @map("service_fee")     // 服务费（分）
  deliveryFee    Int           @default(0) @map("delivery_fee")    // 配送费（分）
  platformFee    Int           @default(0) @map("platform_fee")    // 平台费（分）
  totalAmount    Int                       @map("total_amount")    // 总金额（分）
  
  // 现金支付字段：使用 Int 存储分
  cashReceived   Int?          @map("cash_received") // 收到的现金（分）
  cashChange     Int?          @map("cash_change")   // 找零（分）
  
  // ... 其他字段保持不变
}

model OrderItem {
  id             String   @id @default(uuid()) @db.Uuid
  orderId        String   @map("order_id") @db.Uuid
  itemId         String   @map("item_id") @db.Uuid
  itemName       String   @map("item_name") @db.VarChar(255)
  quantity       Int
  
  // 价格字段：使用 Int 存储分
  unitPrice      Int      @map("unit_price")      // 单价（分）
  totalPrice     Int      @map("total_price")     // 总价（分）
  discountAmount Int      @default(0) @map("discount_amount") // 折扣（分）
  
  // ... 其他字段保持不变
}
```

### 第 2 步：创建数据库迁移

```bash
# 生成迁移文件
npx prisma migrate dev --name migrate_prices_to_cents --schema=./shared/database/schema-order.prisma
```

迁移 SQL 会自动生成，但需要手动添加数据转换：

```sql
-- 迁移现有数据：元 -> 分（乘以 100）

-- 1. 修改 Order 表
ALTER TABLE "orders" 
  ALTER COLUMN "subtotal" TYPE INTEGER USING (subtotal * 100)::INTEGER,
  ALTER COLUMN "tax_amount" TYPE INTEGER USING (tax_amount * 100)::INTEGER,
  ALTER COLUMN "tip_amount" TYPE INTEGER USING (tip_amount * 100)::INTEGER,
  ALTER COLUMN "discount_amount" TYPE INTEGER USING (discount_amount * 100)::INTEGER,
  ALTER COLUMN "service_fee" TYPE INTEGER USING (service_fee * 100)::INTEGER,
  ALTER COLUMN "delivery_fee" TYPE INTEGER USING (delivery_fee * 100)::INTEGER,
  ALTER COLUMN "platform_fee" TYPE INTEGER USING (platform_fee * 100)::INTEGER,
  ALTER COLUMN "total_amount" TYPE INTEGER USING (total_amount * 100)::INTEGER,
  ALTER COLUMN "cash_received" TYPE INTEGER USING (cash_received * 100)::INTEGER,
  ALTER COLUMN "cash_change" TYPE INTEGER USING (cash_change * 100)::INTEGER;

-- 2. 修改 OrderItem 表
ALTER TABLE "order_items"
  ALTER COLUMN "unit_price" TYPE INTEGER USING (unit_price * 100)::INTEGER,
  ALTER COLUMN "total_price" TYPE INTEGER USING (total_price * 100)::INTEGER,
  ALTER COLUMN "discount_amount" TYPE INTEGER USING (discount_amount * 100)::INTEGER;
```

### 第 3 步：修改 Order Service 代码

#### 3.1 更新类型定义

```typescript
// src/services/order.service.ts

interface CreateOrderItem {
  itemId: string;
  itemName: string;
  quantity: number;
  unitPrice: number;  // 单价（分）
  
  discountAmount?: number;  // 折扣（分）
  
  modifiers?: Array<{
    optionId: string;
    optionName: string;
    groupName?: string;
    unitPrice: number;  // 修饰符价格（分）
    quantity: number;
  }>;
}

interface CreateOrderData {
  orderType: 'DINE_IN' | 'TAKEOUT' | 'DELIVERY';
  orderSource?: 'POS' | 'WEB' | 'KIOSK';
  items: CreateOrderItem[];
  
  // 费用相关（分）
  taxAmount?: number;
  discountAmount?: number;
  serviceFee?: number;
  deliveryFee?: number;
  platformFee?: number;
  tipAmount?: number;
  
  // 支付信息
  paymentMethod?: string;
  transactionId?: string;
  
  // 现金支付相关（分）
  cashReceived?: number;
}
```

#### 3.2 更新订单创建逻辑

```typescript
// src/services/order.service.ts

async createOrder(data: CreateOrderData, userId: string, tenantId: string, token: string) {
  try {
    const orderSource = data.orderSource || 'POS';

    // 1. 计算小计（分）
    const subtotal = data.items.reduce((sum, item) => {
      return sum + (item.unitPrice * item.quantity);
    }, 0);

    // 2. 计算总金额（分）
    const totalAmount = subtotal
      + (data.taxAmount || 0)
      + (data.serviceFee || 0)
      + (data.deliveryFee || 0)
      + (data.platformFee || 0)
      + (data.tipAmount || 0)
      - (data.discountAmount || 0);

    // 3. 生成订单号
    const orderNumber = await this.generateOrderNumber(tenantId, orderSource);

    // 4. 处理现金支付逻辑（分）
    let paymentStatus: 'UNPAID' | 'PAID' = 'UNPAID';
    let paidAt: Date | null = null;
    let cashReceived: number | null = null;
    let cashChange: number | null = null;
    
    if (data.paymentMethod === 'CASH' && data.cashReceived) {
      const received = data.cashReceived;  // 分
      const change = received - totalAmount;  // 分
      
      if (change < 0) {
        throw new AppError(
          400, 
          'INSUFFICIENT_CASH', 
          `收到的现金不足，应收 ${(totalAmount / 100).toFixed(2)} 元，实收 ${(received / 100).toFixed(2)} 元`
        );
      }
      
      paymentStatus = 'PAID';
      paidAt = new Date();
      cashReceived = received;
      cashChange = change;
      
      logger.info('Cash payment processed', {
        totalAmount: totalAmount / 100,  // 日志显示为元
        cashReceived: received / 100,
        cashChange: change / 100
      });
    }

    // 5. 创建订单
    const order = await prisma.order.create({
      data: {
        tenantId,
        orderNumber,
        orderType: data.orderType,
        orderSource: orderSource,
        
        // 价格字段（分）
        subtotal: subtotal,
        taxAmount: data.taxAmount || 0,
        tipAmount: data.tipAmount || 0,
        discountAmount: data.discountAmount || 0,
        serviceFee: data.serviceFee || 0,
        deliveryFee: data.deliveryFee || 0,
        platformFee: data.platformFee || 0,
        totalAmount: totalAmount,
        
        // 现金支付信息（分）
        cashReceived: cashReceived,
        cashChange: cashChange,
        
        // 支付状态
        paymentStatus: paymentStatus,
        paymentMethod: data.paymentMethod || null,
        paidAt: paidAt,
        
        // 订单项
        orderItems: {
          create: data.items.map(item => ({
            itemId: item.itemId,
            itemName: item.itemName,
            quantity: item.quantity,
            unitPrice: item.unitPrice,  // 分
            totalPrice: item.unitPrice * item.quantity,  // 分
            discountAmount: item.discountAmount || 0,
            attributes: item.attributes || null,
            modifiers: item.modifiers || null,
            specialNotes: item.specialNotes || null,
          })),
        },
        
        createdBy: userId,
      },
      include: {
        orderItems: true,
      },
    });

    logger.info('Order created successfully', {
      orderId: order.id,
      orderNumber: order.orderNumber,
      totalAmount: order.totalAmount / 100  // 日志显示为元
    });

    return {
      id: order.id,
      orderNumber: order.orderNumber,
      status: order.status,
      totalAmount: order.totalAmount,  // 返回分
      paymentStatus: order.paymentStatus,
      paymentMethod: order.paymentMethod,
      cashReceived: order.cashReceived,  // 返回分
      cashChange: order.cashChange,  // 返回分
      createdAt: order.createdAt,
    };
  } catch (error) {
    logger.error('Error creating order:', error);
    throw error;
  }
}
```

#### 3.3 添加价格格式化工具

```typescript
// src/utils/priceFormatter.ts

/**
 * 价格格式化工具
 */
export class PriceFormatter {
  /**
   * 分转元（用于显示）
   */
  static centsToYuan(cents: number): number {
    return cents / 100;
  }

  /**
   * 格式化为货币字符串
   */
  static formatCents(cents: number): string {
    return `$${(cents / 100).toFixed(2)}`;
  }

  /**
   * 元转分（用于计算）
   */
  static yuanToCents(yuan: number): number {
    return Math.round(yuan * 100);
  }
}
```

### 第 4 步：更新 API 文档

```markdown
# Order Service API 文档

## 价格单位说明

⚠️ **重要**: 所有价格字段均以**分**（cents）为单位。

### 示例

- `unitPrice: 3800` 表示 38.00 元
- `totalAmount: 4428` 表示 44.28 元
- `cashReceived: 5000` 表示 50.00 元
- `cashChange: 572` 表示 5.72 元

### 创建订单

```http
POST /api/order/v1/orders
```

**请求体**:
```json
{
  "orderType": "DINE_IN",
  "orderSource": "POS",
  "tableNumber": "A-01",
  "items": [
    {
      "itemId": "550e8400-e29b-41d4-a716-446655440001",
      "itemName": "宫保鸡丁",
      "quantity": 1,
      "unitPrice": 3800  // 38.00元 = 3800分
    },
    {
      "itemId": "550e8400-e29b-41d4-a716-446655440002",
      "itemName": "米饭",
      "quantity": 1,
      "unitPrice": 300  // 3.00元 = 300分
    }
  ],
  "taxAmount": 328,  // 3.28元 = 328分
  "totalAmount": 4428,  // 44.28元 = 4428分
  "paymentMethod": "CASH",
  "cashReceived": 5000  // 50.00元 = 5000分
}
```

**响应**:
```json
{
  "success": true,
  "data": {
    "id": "order-uuid",
    "orderNumber": "A6AEE8-POS-20241206-0001",
    "status": "PENDING",
    "totalAmount": 4428,  // 44.28元 = 4428分
    "paymentStatus": "PAID",
    "paymentMethod": "CASH",
    "cashReceived": 5000,  // 50.00元 = 5000分
    "cashChange": 572,  // 5.72元 = 572分
    "createdAt": "2024-12-06T10:30:00.000Z"
  }
}
```
```

### 第 5 步：更新验证器

```typescript
// src/validators/order.validator.ts

export const createOrderSchema = Joi.object({
  orderType: Joi.string().valid('DINE_IN', 'TAKEOUT', 'DELIVERY').required(),
  orderSource: Joi.string().valid('POS', 'WEB', 'KIOSK').optional().default('POS'),
  tableNumber: Joi.string().max(50).optional().allow(null),
  customerName: Joi.string().max(100).optional().allow(null),
  customerPhone: Joi.string().max(50).optional().allow(null),
  
  items: Joi.array().min(1).items(
    Joi.object({
      itemId: Joi.string().uuid().required(),
      itemName: Joi.string().max(255).required(),
      quantity: Joi.number().integer().min(1).required(),
      unitPrice: Joi.number().integer().min(0).required(),  // 分（整数）
      discountAmount: Joi.number().integer().min(0).optional(),  // 分（整数）
      attributes: Joi.object().optional().allow(null),
      modifiers: Joi.array().items(
        Joi.object({
          optionId: Joi.string().required(),
          optionName: Joi.string().required(),
          groupName: Joi.string().optional().allow(null),
          unitPrice: Joi.number().integer().min(0).required(),  // 分（整数）
          quantity: Joi.number().integer().min(1).required(),
        })
      ).optional(),
      specialNotes: Joi.string().max(500).optional().allow(null),
    })
  ).required(),
  
  // 费用相关（分，整数）
  taxAmount: Joi.number().integer().min(0).optional().default(0),
  discountAmount: Joi.number().integer().min(0).optional().default(0),
  serviceFee: Joi.number().integer().min(0).optional().default(0),
  deliveryFee: Joi.number().integer().min(0).optional().default(0),
  platformFee: Joi.number().integer().min(0).optional().default(0),
  tipAmount: Joi.number().integer().min(0).optional().default(0),
  
  // 支付信息
  paymentMethod: Joi.string().max(50).optional().allow(null),
  transactionId: Joi.string().max(255).optional().allow(null),
  paymentStatus: Joi.string().valid('UNPAID', 'PAID', 'PARTIALLY_PAID', 'REFUNDING', 'REFUNDED', 'FAILED').optional().default('UNPAID'),
  cashReceived: Joi.number().integer().min(0).optional().allow(null),  // 分（整数）
  paymentDetails: Joi.object().optional().allow(null),
  
  notes: Joi.string().max(1000).optional().allow(null),
});
```

---

## 前端适配

### POS 前端（不需要改动）

如果 Item Service 已经返回分，POS 前端不需要任何改动：

```typescript
// 直接使用 Item Service 返回的价格（分）
const orderData = {
  items: cartItems.map(item => ({
    itemId: item.id,
    itemName: item.name,
    quantity: item.quantity,
    unitPrice: item.price,  // 已经是分
  })),
  totalAmount: calculateTotal(),  // 已经是分
  cashReceived: cashInput,  // 已经是分
};

// 发送到 Order Service
await orderService.createOrder(orderData);
```

### 显示转换

只在显示时转换为元：

```typescript
// 显示价格
function formatPrice(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

// 使用
<Text>{formatPrice(item.price)}</Text>  // 显示 "$38.00"
<Text>{formatPrice(order.totalAmount)}</Text>  // 显示 "$44.28"
<Text>{formatPrice(order.cashChange)}</Text>  // 显示 "$5.72"
```

---

## 迁移步骤总结

1. ✅ 修改 `schema-order.prisma`，将 Decimal 改为 Int
2. ✅ 创建数据库迁移，转换现有数据
3. ✅ 更新 `order.service.ts`，使用整数计算
4. ✅ 更新 `order.validator.ts`，验证整数
5. ✅ 更新 API 文档，说明单位为分
6. ✅ 前端添加显示转换（分 -> 元）

---

## 优势总结

### 使用分（整数）

```typescript
// ✅ 精确计算
const item1 = 3800;  // 38.00元
const item2 = 300;   // 3.00元
const tax = 328;     // 3.28元
const total = item1 + item2 + tax;  // 4428分 = 44.28元
```

### 使用元（浮点数）

```typescript
// ❌ 可能有精度问题
const item1 = 38.00;
const item2 = 3.00;
const tax = 3.28;
const total = item1 + item2 + tax;  // 44.28 或 44.280000000000001?
```

---

## 兼容性

如果需要兼容旧的 API（接收元），可以添加一个转换层：

```typescript
// 中间件：自动转换元 -> 分
app.use('/api/order/v1/orders', (req, res, next) => {
  if (req.body.totalAmount && req.body.totalAmount < 1000) {
    // 如果金额小于1000，可能是元，转换为分
    req.body.totalAmount = Math.round(req.body.totalAmount * 100);
    req.body.cashReceived = req.body.cashReceived ? Math.round(req.body.cashReceived * 100) : undefined;
    // ... 转换其他字段
  }
  next();
});
```

但**不推荐**这种方式，容易出错。最好统一使用分。




