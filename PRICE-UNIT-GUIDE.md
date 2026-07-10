# 价格单位统一指南

## 问题说明

当前系统存在价格单位不统一的问题：
- **Item Service**: 价格以**分**为单位（cents）
- **Order Service**: 价格以**元**为单位（dollars）

这会导致价格计算错误。

---

## 解决方案

### 方案 1: Order Service 统一使用分（推荐）

**优点**:
- 避免浮点数精度问题
- 与 Item Service 保持一致
- 数据库使用整数存储，性能更好

**缺点**:
- 需要修改现有代码和数据库
- 前端需要转换显示

### 方案 2: POS 前端转换单位

**优点**:
- 不需要修改后端
- 改动最小

**缺点**:
- 前端需要处理单位转换
- 容易出错

---

## 推荐实现：前端转换（快速方案）

### POS 前端修改

在发送订单到 Order Service 之前，将价格从分转换为元：

```typescript
// src/services/orderService.ts

/**
 * 将价格从分转换为元
 */
function centsToYuan(cents: number): number {
  return cents / 100;
}

/**
 * 创建订单
 */
async createOrder(orderData: CreateOrderRequest): Promise<Order> {
  // 转换商品价格：分 -> 元
  const itemsInYuan = orderData.items.map(item => ({
    ...item,
    unitPrice: centsToYuan(item.unitPrice),
    // 如果有修饰符，也需要转换
    modifiers: item.modifiers?.map(mod => ({
      ...mod,
      unitPrice: centsToYuan(mod.unitPrice)
    }))
  }));

  // 转换订单总金额
  const orderDataInYuan = {
    ...orderData,
    items: itemsInYuan,
    totalAmount: centsToYuan(orderData.totalAmount),
    taxAmount: orderData.taxAmount ? centsToYuan(orderData.taxAmount) : undefined,
    discountAmount: orderData.discountAmount ? centsToYuan(orderData.discountAmount) : undefined,
    cashReceived: orderData.cashReceived ? centsToYuan(orderData.cashReceived) : undefined,
  };

  // 发送请求
  const response = await this.request('POST', '/orders', orderDataInYuan);
  return response.data;
}
```

### 示例

**Item Service 返回的价格（分）**:
```json
{
  "id": "item-001",
  "name": "宫保鸡丁",
  "price": 3800  // 38.00元 = 3800分
}
```

**发送到 Order Service 的价格（元）**:
```json
{
  "itemId": "item-001",
  "itemName": "宫保鸡丁",
  "unitPrice": 38.00,  // 已转换为元
  "quantity": 1
}
```

---

## 完整示例代码

### 1. 价格转换工具函数

```typescript
// src/utils/priceConverter.ts

/**
 * 价格单位转换工具
 */
export class PriceConverter {
  /**
   * 分转元
   */
  static centsToYuan(cents: number): number {
    return Math.round(cents) / 100;
  }

  /**
   * 元转分
   */
  static yuanToCents(yuan: number): number {
    return Math.round(yuan * 100);
  }

  /**
   * 格式化显示金额（元）
   */
  static formatYuan(yuan: number): string {
    return `$${yuan.toFixed(2)}`;
  }

  /**
   * 转换商品价格（分 -> 元）
   */
  static convertItemPrice(item: any): any {
    return {
      ...item,
      unitPrice: this.centsToYuan(item.unitPrice),
      modifiers: item.modifiers?.map((mod: any) => ({
        ...mod,
        unitPrice: this.centsToYuan(mod.unitPrice)
      }))
    };
  }

  /**
   * 转换订单数据（分 -> 元）
   */
  static convertOrderData(orderData: any): any {
    return {
      ...orderData,
      items: orderData.items.map((item: any) => this.convertItemPrice(item)),
      totalAmount: this.centsToYuan(orderData.totalAmount),
      taxAmount: orderData.taxAmount ? this.centsToYuan(orderData.taxAmount) : undefined,
      discountAmount: orderData.discountAmount ? this.centsToYuan(orderData.discountAmount) : undefined,
      cashReceived: orderData.cashReceived ? this.centsToYuan(orderData.cashReceived) : undefined,
    };
  }
}
```

### 2. 在 Order Service 中使用

```typescript
// src/services/orderService.ts

import { PriceConverter } from '@/utils/priceConverter';

export class OrderService {
  /**
   * 创建订单
   */
  async createOrder(orderData: CreateOrderRequest): Promise<Order> {
    // 转换价格单位：分 -> 元
    const orderDataInYuan = PriceConverter.convertOrderData(orderData);

    // 发送请求
    const response = await this.request('POST', '/orders', orderDataInYuan);
    
    return response.data;
  }

  /**
   * 计算订单总金额（输入为分，输出为元）
   */
  calculateTotal(items: CartItem[]): number {
    const totalCents = items.reduce((sum, item) => {
      return sum + (item.price * item.quantity);
    }, 0);
    
    return PriceConverter.centsToYuan(totalCents);
  }
}
```

### 3. 在购物车中使用

```typescript
// src/store/cartStore.ts

import { PriceConverter } from '@/utils/priceConverter';

export class CartStore {
  // 商品价格存储为分
  private items: CartItem[] = [];

  /**
   * 获取小计（元）
   */
  get subtotal(): number {
    const totalCents = this.items.reduce((sum, item) => {
      return sum + (item.price * item.quantity);
    }, 0);
    return PriceConverter.centsToYuan(totalCents);
  }

  /**
   * 获取税费（元）
   */
  get tax(): number {
    const taxCents = Math.round(this.subtotalCents * 0.08); // 8% 税率
    return PriceConverter.centsToYuan(taxCents);
  }

  /**
   * 获取总计（元）
   */
  get total(): number {
    return this.subtotal + this.tax;
  }

  /**
   * 格式化显示金额
   */
  get totalFormatted(): string {
    return PriceConverter.formatYuan(this.total);
  }
}
```

---

## 测试用例

```typescript
// __tests__/priceConverter.test.ts

import { PriceConverter } from '@/utils/priceConverter';

describe('PriceConverter', () => {
  test('分转元', () => {
    expect(PriceConverter.centsToYuan(3800)).toBe(38.00);
    expect(PriceConverter.centsToYuan(100)).toBe(1.00);
    expect(PriceConverter.centsToYuan(99)).toBe(0.99);
  });

  test('元转分', () => {
    expect(PriceConverter.yuanToCents(38.00)).toBe(3800);
    expect(PriceConverter.yuanToCents(1.00)).toBe(100);
    expect(PriceConverter.yuanToCents(0.99)).toBe(99);
  });

  test('转换订单数据', () => {
    const orderData = {
      items: [
        {
          itemId: 'item-001',
          itemName: '宫保鸡丁',
          unitPrice: 3800,  // 分
          quantity: 1
        }
      ],
      totalAmount: 3800,
      cashReceived: 5000
    };

    const converted = PriceConverter.convertOrderData(orderData);

    expect(converted.items[0].unitPrice).toBe(38.00);
    expect(converted.totalAmount).toBe(38.00);
    expect(converted.cashReceived).toBe(50.00);
  });
});
```

---

## 数据流示例

### 完整流程

```
1. Item Service 返回价格（分）
   ↓
   { itemId: "001", name: "宫保鸡丁", price: 3800 }

2. POS 前端存储价格（分）
   ↓
   cartStore.addItem({ id: "001", name: "宫保鸡丁", price: 3800 })

3. 显示给用户（元）
   ↓
   显示: "宫保鸡丁 - $38.00"

4. 创建订单前转换（分 -> 元）
   ↓
   orderData = PriceConverter.convertOrderData(cartData)

5. 发送到 Order Service（元）
   ↓
   POST /api/order/v1/orders
   { unitPrice: 38.00, totalAmount: 38.00, cashReceived: 50.00 }

6. Order Service 存储（元）
   ↓
   数据库: totalAmount = 38.00
```

---

## 注意事项

### 1. 浮点数精度

使用元作为单位时，要注意浮点数精度问题：

```typescript
// ❌ 错误：直接计算可能有精度问题
const total = 0.1 + 0.2;  // 0.30000000000000004

// ✅ 正确：使用分计算，最后转换
const totalCents = 10 + 20;  // 30
const total = totalCents / 100;  // 0.30
```

### 2. 四舍五入

转换时要注意四舍五入：

```typescript
// 使用 Math.round 确保结果为整数
const cents = Math.round(yuan * 100);
```

### 3. 显示格式

显示金额时要格式化：

```typescript
// ✅ 正确：始终显示两位小数
const formatted = amount.toFixed(2);  // "38.00"

// ❌ 错误：可能显示不完整
const formatted = amount.toString();  // "38" (缺少小数)
```

---

## 总结

### 当前方案

1. **Item Service**: 价格以**分**为单位
2. **POS 前端**: 内部使用**分**，显示时转换为**元**
3. **Order Service**: 接收和存储**元**
4. **转换时机**: 创建订单时，前端将分转换为元

### 关键代码

```typescript
// 创建订单时转换
const orderDataInYuan = PriceConverter.convertOrderData(orderDataInCents);
await orderService.createOrder(orderDataInYuan);
```

### 优势

- ✅ 改动最小
- ✅ 不影响现有 Order Service
- ✅ 前端统一管理单位转换
- ✅ 易于测试和维护




