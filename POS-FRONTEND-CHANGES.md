# POS 前端适配指南 - 价格单位统一为分

## 概述

Order Service 已经将所有价格字段从**元（Decimal）**改为**分（Integer）**，与 Item Service 保持一致。

### 好消息 ✅

由于 Item Service 已经返回分，POS 前端的大部分代码**不需要修改**！只需要：
1. 确保内部存储使用分（整数）
2. 只在显示时转换为元

---

## 修改清单

### 1. 创建价格格式化工具

```typescript
// src/utils/priceFormatter.ts

/**
 * 价格格式化工具
 * 
 * 系统内部统一使用分（cents）作为价格单位
 * 只在显示时转换为元（yuan）
 */
export class PriceFormatter {
  /**
   * 分转元（用于显示）
   * @param cents 价格（分）
   * @returns 价格（元）
   */
  static centsToYuan(cents: number): number {
    return cents / 100;
  }

  /**
   * 格式化为货币字符串
   * @param cents 价格（分）
   * @returns 格式化的字符串，如 "$38.00"
   */
  static format(cents: number): string {
    return `$${(cents / 100).toFixed(2)}`;
  }

  /**
   * 元转分（如果需要用户输入元）
   * @param yuan 价格（元）
   * @returns 价格（分）
   */
  static yuanToCents(yuan: number): number {
    return Math.round(yuan * 100);
  }

  /**
   * 解析用户输入的金额（元）并转换为分
   * @param input 用户输入的字符串，如 "38.50"
   * @returns 价格（分）
   */
  static parseInput(input: string): number {
    const yuan = parseFloat(input);
    if (isNaN(yuan)) {
      throw new Error('Invalid price input');
    }
    return this.yuanToCents(yuan);
  }
}
```

---

### 2. 更新 Order Service 类型定义

```typescript
// src/services/orderService.ts

/**
 * 订单商品（价格单位：分）
 */
export interface OrderItem {
  itemId: string;
  itemName: string;
  quantity: number;
  unitPrice: number;  // 单价（分）
  totalPrice?: number;  // 总价（分）
  attributes?: Record<string, any>;
  modifiers?: Array<{
    optionId: string;
    optionName: string;
    groupName?: string;
    unitPrice: number;  // 修饰符价格（分）
    quantity: number;
  }>;
  specialNotes?: string;
}

/**
 * 创建订单请求（价格单位：分）
 */
export interface CreateOrderRequest {
  orderType: 'DINE_IN' | 'TAKEOUT' | 'DELIVERY';
  orderSource: 'POS';
  tableNumber?: string;
  customerName?: string;
  customerPhone?: string;
  items: OrderItem[];
  
  // 费用相关（分）
  taxAmount?: number;
  discountAmount?: number;
  serviceFee?: number;
  deliveryFee?: number;
  tipAmount?: number;
  totalAmount: number;  // 总金额（分）
  
  // 支付信息
  paymentMethod: string;
  transactionId?: string;
  
  // 现金支付（分）
  cashReceived?: number;
  
  notes?: string;
}

/**
 * 订单响应（价格单位：分）
 */
export interface Order {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  totalAmount: number;  // 总金额（分）
  paymentStatus: PaymentStatus;
  paymentMethod?: string;
  cashReceived?: number;  // 收到的现金（分）
  changeGiven?: number;  // 找零（分）
  createdAt: string;
}
```

---

### 3. 购物车存储（使用分）

```typescript
// src/store/cartStore.ts

import { PriceFormatter } from '@/utils/priceFormatter';

export interface CartItem {
  id: string;
  name: string;
  price: number;  // 单价（分）- 直接从 Item Service 获取
  quantity: number;
  modifiers?: Array<{
    id: string;
    name: string;
    price: number;  // 修饰符价格（分）
  }>;
}

export class CartStore {
  private items: CartItem[] = [];

  /**
   * 添加商品到购物车
   * @param item 商品（价格已经是分）
   */
  addItem(item: CartItem) {
    this.items.push(item);
  }

  /**
   * 计算小计（分）
   */
  get subtotalCents(): number {
    return this.items.reduce((sum, item) => {
      const itemPrice = item.price;
      const modifiersPrice = item.modifiers?.reduce(
        (modSum, mod) => modSum + mod.price, 
        0
      ) || 0;
      return sum + (itemPrice + modifiersPrice) * item.quantity;
    }, 0);
  }

  /**
   * 计算税费（分）
   */
  get taxCents(): number {
    // 8% 税率
    return Math.round(this.subtotalCents * 0.08);
  }

  /**
   * 计算总计（分）
   */
  get totalCents(): number {
    return this.subtotalCents + this.taxCents;
  }

  /**
   * 获取小计（元）- 用于显示
   */
  get subtotalYuan(): number {
    return PriceFormatter.centsToYuan(this.subtotalCents);
  }

  /**
   * 获取税费（元）- 用于显示
   */
  get taxYuan(): number {
    return PriceFormatter.centsToYuan(this.taxCents);
  }

  /**
   * 获取总计（元）- 用于显示
   */
  get totalYuan(): number {
    return PriceFormatter.centsToYuan(this.totalCents);
  }

  /**
   * 格式化显示总计
   */
  get totalFormatted(): string {
    return PriceFormatter.format(this.totalCents);
  }
}
```

---

### 4. 显示组件（转换为元显示）

```typescript
// src/components/CartSummary.tsx

import React from 'react';
import { PriceFormatter } from '@/utils/priceFormatter';
import { useCart } from '@/store/cartStore';

export function CartSummary() {
  const cart = useCart();

  return (
    <div className="cart-summary">
      <div className="row">
        <span>小计:</span>
        <span>{PriceFormatter.format(cart.subtotalCents)}</span>
      </div>
      
      <div className="row">
        <span>税费:</span>
        <span>{PriceFormatter.format(cart.taxCents)}</span>
      </div>
      
      <div className="row total">
        <span>总计:</span>
        <span>{PriceFormatter.format(cart.totalCents)}</span>
      </div>
    </div>
  );
}
```

```typescript
// src/components/MenuItem.tsx

import React from 'react';
import { PriceFormatter } from '@/utils/priceFormatter';

interface MenuItemProps {
  item: {
    id: string;
    name: string;
    price: number;  // 价格（分）
    description?: string;
  };
  onAdd: () => void;
}

export function MenuItem({ item, onAdd }: MenuItemProps) {
  return (
    <div className="menu-item">
      <div className="info">
        <h3>{item.name}</h3>
        <p>{item.description}</p>
      </div>
      <div className="price-action">
        <span className="price">
          {PriceFormatter.format(item.price)}
        </span>
        <button onClick={onAdd}>添加</button>
      </div>
    </div>
  );
}
```

---

### 5. 现金支付组件

```typescript
// src/components/CashPayment.tsx

import React, { useState, useEffect } from 'react';
import { PriceFormatter } from '@/utils/priceFormatter';

interface CashPaymentProps {
  totalCents: number;  // 订单总额（分）
  onConfirm: (cashReceivedCents: number) => void;
}

export function CashPayment({ totalCents, onConfirm }: CashPaymentProps) {
  const [cashInput, setCashInput] = useState('');  // 用户输入（元）
  const [cashReceivedCents, setCashReceivedCents] = useState(0);  // 收到的现金（分）
  const [changeCents, setChangeCents] = useState(0);  // 找零（分）

  // 计算找零
  useEffect(() => {
    try {
      const received = PriceFormatter.parseInput(cashInput);
      setCashReceivedCents(received);
      setChangeCents(received - totalCents);
    } catch {
      setCashReceivedCents(0);
      setChangeCents(0);
    }
  }, [cashInput, totalCents]);

  const isValid = cashReceivedCents >= totalCents;

  return (
    <div className="cash-payment">
      <div className="total">
        <label>应收金额:</label>
        <div className="amount">
          {PriceFormatter.format(totalCents)}
        </div>
      </div>

      <div className="input-section">
        <label>收到现金:</label>
        <input
          type="number"
          value={cashInput}
          onChange={(e) => setCashInput(e.target.value)}
          placeholder="输入金额（元）"
          step="0.01"
          min="0"
          autoFocus
        />
      </div>

      {cashInput && (
        <div className={`change ${isValid ? 'valid' : 'invalid'}`}>
          <label>找零:</label>
          <div className="amount">
            {isValid 
              ? PriceFormatter.format(changeCents)
              : '金额不足'
            }
          </div>
        </div>
      )}

      {/* 快捷按钮 */}
      <div className="quick-buttons">
        <button onClick={() => setCashInput('20')}>$20</button>
        <button onClick={() => setCashInput('50')}>$50</button>
        <button onClick={() => setCashInput('100')}>$100</button>
      </div>

      <button
        className="confirm-btn"
        disabled={!isValid}
        onClick={() => onConfirm(cashReceivedCents)}
      >
        确认收款
      </button>
    </div>
  );
}
```

---

### 6. 创建订单（不需要转换）

```typescript
// src/services/orderService.ts

import { PriceFormatter } from '@/utils/priceFormatter';

export class OrderService {
  /**
   * 创建订单
   * 注意：所有价格已经是分，不需要转换
   */
  async createOrder(
    cart: CartStore,
    orderType: OrderType,
    tableNumber?: string,
    cashReceivedCents?: number
  ): Promise<Order> {
    // 构建订单数据（价格都是分）
    const orderData: CreateOrderRequest = {
      orderType,
      orderSource: 'POS',
      tableNumber,
      items: cart.items.map(item => ({
        itemId: item.id,
        itemName: item.name,
        quantity: item.quantity,
        unitPrice: item.price,  // 已经是分，不需要转换
        modifiers: item.modifiers?.map(mod => ({
          optionId: mod.id,
          optionName: mod.name,
          unitPrice: mod.price,  // 已经是分，不需要转换
          quantity: 1
        }))
      })),
      taxAmount: cart.taxCents,  // 已经是分
      totalAmount: cart.totalCents,  // 已经是分
      paymentMethod: 'CASH',
      cashReceived: cashReceivedCents,  // 已经是分
    };

    // 发送请求
    const response = await this.request('POST', '/orders', orderData);
    return response.data;
  }
}
```

---

### 7. 显示订单详情

```typescript
// src/components/OrderReceipt.tsx

import React from 'react';
import { PriceFormatter } from '@/utils/priceFormatter';
import { Order } from '@/services/orderService';

interface OrderReceiptProps {
  order: Order;
}

export function OrderReceipt({ order }: OrderReceiptProps) {
  return (
    <div className="receipt">
      <h2>订单详情</h2>
      
      <div className="order-number">
        订单号: {order.orderNumber}
      </div>

      <div className="summary">
        <div className="row">
          <span>总金额:</span>
          <span>{PriceFormatter.format(order.totalAmount)}</span>
        </div>

        {order.cashReceived && (
          <>
            <div className="row">
              <span>收到现金:</span>
              <span>{PriceFormatter.format(order.cashReceived)}</span>
            </div>
            <div className="row change">
              <span>找零:</span>
              <span>{PriceFormatter.format(order.changeGiven || 0)}</span>
            </div>
          </>
        )}
      </div>

      <div className="status">
        支付状态: {order.paymentStatus}
      </div>
    </div>
  );
}
```

---

## 完整示例流程

### 从 Item Service 获取商品 → 添加到购物车 → 创建订单

```typescript
// 1. 从 Item Service 获取商品（价格已经是分）
const item = await itemService.getItem('item-001');
// item.price = 3800 (38.00元)

// 2. 添加到购物车（不需要转换）
cart.addItem({
  id: item.id,
  name: item.name,
  price: item.price,  // 3800分
  quantity: 1
});

// 3. 显示给用户（转换为元）
console.log('商品价格:', PriceFormatter.format(item.price));  // "$38.00"
console.log('购物车总计:', cart.totalFormatted);  // "$41.04"

// 4. 用户输入现金（元）
const cashInput = '50.00';  // 用户输入50元
const cashReceivedCents = PriceFormatter.parseInput(cashInput);  // 5000分

// 5. 创建订单（所有价格都是分）
const order = await orderService.createOrder(
  cart,
  'DINE_IN',
  'A-01',
  cashReceivedCents  // 5000分
);

// 6. 显示找零（转换为元）
console.log('找零:', PriceFormatter.format(order.changeGiven));  // "$8.96"
```

---

## 测试清单

### ✅ 需要测试的场景

1. **商品显示**
   - [ ] 商品价格正确显示（元）
   - [ ] 修饰符价格正确显示（元）

2. **购物车计算**
   - [ ] 小计计算正确
   - [ ] 税费计算正确
   - [ ] 总计计算正确

3. **现金支付**
   - [ ] 用户输入金额（元）正确转换为分
   - [ ] 找零计算正确
   - [ ] 快捷按钮工作正常

4. **订单创建**
   - [ ] 订单数据正确发送（分）
   - [ ] 响应数据正确显示（元）

5. **边界情况**
   - [ ] 刚好金额（找零为0）
   - [ ] 现金不足（显示错误）
   - [ ] 大额现金（找零计算正确）
   - [ ] 小数点处理（如 $0.99）

---

## 关键点总结

### ✅ 要做的

1. **创建 `PriceFormatter` 工具类**
2. **内部存储使用分（整数）**
3. **只在显示时转换为元**
4. **用户输入时转换为分**

### ❌ 不要做的

1. **不要在发送到 Order Service 前转换单位**（已经是分）
2. **不要在内部计算时使用浮点数**（容易出错）
3. **不要混用单位**（统一使用分）

### 📊 数据流

```
Item Service (分) 
    ↓
Cart Store (分) 
    ↓
Display (元) ← PriceFormatter.format()
    ↓
User Input (元) → PriceFormatter.parseInput() → (分)
    ↓
Order Service (分)
    ↓
Response (分)
    ↓
Display (元) ← PriceFormatter.format()
```

---

## 需要帮助？

如果遇到问题：
1. 检查是否所有价格都是整数（分）
2. 确保只在显示时转换
3. 使用 `PriceFormatter` 统一处理
4. 查看 `MIGRATE-TO-CENTS.md` 了解后端改动

---

## 示例代码仓库

完整的示例代码可以在以下位置找到：
- `src/utils/priceFormatter.ts` - 价格格式化工具
- `src/store/cartStore.ts` - 购物车逻辑
- `src/components/CashPayment.tsx` - 现金支付组件
- `src/services/orderService.ts` - 订单服务


