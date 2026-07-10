# POS 前端接入 Order Service 指南

## 概述

本文档指导 POS 前端如何接入 Order Service，重点说明现金支付流程。

---

## 前置条件

### 1. 服务信息

- **服务地址**: `http://localhost:3002`
- **API Base URL**: `http://localhost:3002/api/order/v1`
- **认证方式**: JWT Bearer Token
- **必需 Header**: 
  - `Authorization: Bearer {token}`
  - `x-organization-id: {tenantId}`

### 2. 环境要求

- Order Service 已启动（端口 3002）
- POS 前端已获取 JWT Token
- POS 前端已知道 tenantId (组织ID)

---

## 快速开始 - 现金支付流程

### 流程图

```
POS 前端
    ↓
1. 扫描商品/手动输入
    ↓
2. 计算订单总金额
    ↓
3. 收银员输入收到的现金
    ↓
4. 调用 Order Service 创建订单
    ↓
5. 后端自动计算找零
    ↓
6. 返回订单信息（包含找零金额）
    ↓
7. POS 显示找零金额
    ↓
8. 打印小票
```

---

## API 接口详情

### 创建现金支付订单

**接口**: `POST /api/order/v1/orders`

**完整 URL**: `http://localhost:3002/api/order/v1/orders`

**请求头**:
```http
POST /api/order/v1/orders HTTP/1.1
Host: localhost:3002
Content-Type: application/json
Authorization: Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...
x-organization-id: 550e8400-e29b-41d4-a716-446655440000
```

**请求体**:
```json
{
  "orderType": "DINE_IN",
  "orderSource": "POS",
  "tableNumber": "A-01",
  "customerName": "张三",
  "customerPhone": "13800138000",
  "items": [
    {
      "itemId": "550e8400-e29b-41d4-a716-446655440001",
      "itemName": "宫保鸡丁",
      "quantity": 1,
      "unitPrice": 38.00,
      "attributes": {
        "size": "大份",
        "spiciness": "中辣"
      },
      "modifiers": [
        {
          "optionId": "mod-001",
          "optionName": "加辣",
          "groupName": "辣度",
          "unitPrice": 0,
          "quantity": 1
        }
      ],
      "specialNotes": "少油"
    }
  ],
  "taxAmount": 3.04,
  "discountAmount": 0,
  "totalAmount": 41.04,
  "paymentMethod": "CASH",
  "cashReceived": 50.00,
  "notes": "尽快出餐"
}
```

**字段说明**:

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `orderType` | string | ✅ | 订单类型: `DINE_IN`(堂食) / `TAKEOUT`(自取) / `DELIVERY`(配送) |
| `orderSource` | string | ✅ | 订单来源: 固定为 `"POS"` |
| `tableNumber` | string | ⚠️ | 桌号（堂食必填） |
| `customerName` | string | ❌ | 客户姓名（可选） |
| `customerPhone` | string | ❌ | 客户电话（可选） |
| `items` | array | ✅ | 订单商品列表，至少1个 |
| `items[].itemId` | string | ✅ | 商品ID (UUID) |
| `items[].itemName` | string | ✅ | 商品名称 |
| `items[].quantity` | number | ✅ | 数量 |
| `items[].unitPrice` | number | ✅ | 单价（含修饰符，不含折扣） |
| `items[].attributes` | object | ❌ | 商品属性（可选） |
| `items[].modifiers` | array | ❌ | 修饰符/加料（可选） |
| `items[].specialNotes` | string | ❌ | 特殊备注（可选） |
| `taxAmount` | number | ❌ | 税费，默认0 |
| `discountAmount` | number | ❌ | 折扣金额，默认0 |
| `totalAmount` | number | ✅ | 订单总金额 |
| `paymentMethod` | string | ✅ | 支付方式: `"CASH"` |
| `cashReceived` | number | ✅ | 收到的现金金额（必须 ≥ totalAmount） |
| `notes` | string | ❌ | 订单备注（可选） |

**成功响应** (HTTP 201):
```json
{
  "success": true,
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "orderNumber": "A6AEE8-POS-20241206-0001",
    "status": "PENDING",
    "totalAmount": "41.04",
    "paymentStatus": "PAID",
    "paymentMethod": "CASH",
    "cashReceived": "50.00",
    "changeGiven": "8.96",
    "createdAt": "2024-12-06T10:30:00.000Z"
  }
}
```

**重要**: 响应中直接包含 `cashReceived` 和 `changeGiven`，可以立即显示找零金额。

---

## 完整流程示例

### 步骤 1: 准备订单数据

```typescript
// POS 前端代码示例

interface OrderItem {
  itemId: string;
  itemName: string;
  quantity: number;
  unitPrice: number;
  attributes?: Record<string, any>;
  modifiers?: Array<{
    optionId: string;
    optionName: string;
    groupName?: string;
    unitPrice: number;
    quantity: number;
  }>;
  specialNotes?: string;
}

interface CreateOrderRequest {
  orderType: 'DINE_IN' | 'TAKEOUT' | 'DELIVERY';
  orderSource: 'POS';
  tableNumber?: string;
  customerName?: string;
  customerPhone?: string;
  items: OrderItem[];
  taxAmount?: number;
  discountAmount?: number;
  totalAmount: number;
  paymentMethod: 'CASH';
  cashReceived: number;
  notes?: string;
}

// 构建订单数据
const orderData: CreateOrderRequest = {
  orderType: 'DINE_IN',
  orderSource: 'POS',
  tableNumber: currentTable,
  items: cartItems.map(item => ({
    itemId: item.id,
    itemName: item.name,
    quantity: item.quantity,
    unitPrice: item.price,
    attributes: item.attributes,
    modifiers: item.modifiers,
    specialNotes: item.notes
  })),
  taxAmount: calculateTax(subtotal),
  discountAmount: appliedDiscount,
  totalAmount: calculateTotal(),
  paymentMethod: 'CASH',
  cashReceived: cashInput,
  notes: orderNotes
};
```

### 步骤 2: 验证现金金额

```typescript
// 在发送请求前验证
function validateCashPayment(totalAmount: number, cashReceived: number): boolean {
  if (cashReceived < totalAmount) {
    alert(`现金不足！应收 $${totalAmount.toFixed(2)}，实收 $${cashReceived.toFixed(2)}`);
    return false;
  }
  return true;
}

// 计算找零（前端预览用）
function calculateChange(totalAmount: number, cashReceived: number): number {
  return cashReceived - totalAmount;
}
```

### 步骤 3: 发送请求

```typescript
async function createCashOrder(orderData: CreateOrderRequest): Promise<Order> {
  const API_BASE_URL = 'http://localhost:3002/api/order/v1';
  const token = localStorage.getItem('jwt_token'); // 或从你的状态管理获取
  const tenantId = localStorage.getItem('tenant_id');

  try {
    const response = await fetch(`${API_BASE_URL}/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'x-organization-id': tenantId
      },
      body: JSON.stringify(orderData)
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error?.message || 'Failed to create order');
    }

    const result = await response.json();
    return result.data;
  } catch (error) {
    console.error('Create order error:', error);
    throw error;
  }
}
```

### 步骤 4: 显示找零并打印小票

```typescript
// 使用示例
const order = await createCashOrder(orderData);

// 响应中已包含找零信息
console.log('找零金额:', order.changeGiven);

// 显示找零
function showChangeAmount(order: Order) {
  const changeAmount = parseFloat(order.changeGiven);
  
  // 显示找零界面
  showModal({
    title: '找零',
    content: `
      <div class="change-display">
        <div class="amount">$${changeAmount.toFixed(2)}</div>
        <div class="label">请找零给客户</div>
      </div>
    `,
    buttons: [
      {
        text: '打印小票',
        onClick: () => printReceipt(order)
      },
      {
        text: '完成',
        onClick: () => closeModal()
      }
    ]
  });
}

// 打印小票
function printReceipt(order: Order) {
  // 调用打印机 API 或使用浏览器打印
  window.print();
  
  // 或者调用后端打印服务
  // await fetch(`${API_BASE_URL}/orders/${order.id}/print`, {
  //   method: 'POST',
  //   headers: { ... },
  //   body: JSON.stringify({ printType: 'RECEIPT' })
  // });
}
```

---

## 完整的 React 组件示例

```typescript
import React, { useState } from 'react';

interface CashPaymentProps {
  totalAmount: number;
  orderData: CreateOrderRequest;
  onSuccess: (order: Order) => void;
  onError: (error: Error) => void;
}

export function CashPayment({ totalAmount, orderData, onSuccess, onError }: CashPaymentProps) {
  const [cashReceived, setCashReceived] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);

  // 计算找零
  const changeAmount = parseFloat(cashReceived) - totalAmount;
  const isValidAmount = parseFloat(cashReceived) >= totalAmount;

  // 处理支付
  const handlePayment = async () => {
    if (!isValidAmount) {
      alert('现金金额不足！');
      return;
    }

    setIsProcessing(true);

    try {
      // 1. 创建订单（响应中已包含找零信息）
      const order = await createCashOrder({
        ...orderData,
        cashReceived: parseFloat(cashReceived)
      });

      // 2. 显示找零
      alert(`找零: $${order.changeGiven}`);

      // 3. 打印小票
      printReceipt(order);

      // 4. 回调成功
      onSuccess(order);

    } catch (error) {
      console.error('Payment failed:', error);
      onError(error as Error);
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="cash-payment">
      <div className="total-amount">
        <label>应收金额:</label>
        <div className="amount">${totalAmount.toFixed(2)}</div>
      </div>

      <div className="cash-input">
        <label>收到现金:</label>
        <input
          type="number"
          value={cashReceived}
          onChange={(e) => setCashReceived(e.target.value)}
          placeholder="输入收到的现金"
          min={totalAmount}
          step="0.01"
          autoFocus
        />
      </div>

      {cashReceived && (
        <div className={`change-amount ${isValidAmount ? 'valid' : 'invalid'}`}>
          <label>找零:</label>
          <div className="amount">
            {isValidAmount 
              ? `$${changeAmount.toFixed(2)}`
              : '金额不足'
            }
          </div>
        </div>
      )}

      <button
        onClick={handlePayment}
        disabled={!isValidAmount || isProcessing}
        className="btn-primary"
      >
        {isProcessing ? '处理中...' : '确认收款'}
      </button>
    </div>
  );
}
```

---

## 错误处理

### 常见错误及处理

#### 1. 现金不足

**错误响应**:
```json
{
  "success": false,
  "error": {
    "code": "INSUFFICIENT_CASH",
    "message": "收到的现金不足，应收 41.04，实收 40.00"
  }
}
```

**处理方式**:
```typescript
if (error.code === 'INSUFFICIENT_CASH') {
  alert('收到的现金不足，请重新输入');
  focusCashInput();
}
```

#### 2. 缺少必填字段

**错误响应**:
```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "\"cashReceived\" is required"
  }
}
```

**处理方式**:
```typescript
if (error.code === 'VALIDATION_ERROR') {
  alert('请输入收到的现金金额');
}
```

#### 3. 认证失败

**错误响应**:
```json
{
  "success": false,
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Invalid token"
  }
}
```

**处理方式**:
```typescript
if (error.code === 'UNAUTHORIZED') {
  // Token 过期，重新登录
  redirectToLogin();
}
```

#### 4. 缺少 tenantId

**错误响应**:
```json
{
  "success": false,
  "error": {
    "code": "MISSING_TENANT_ID",
    "message": "Missing tenantId"
  }
}
```

**处理方式**:
```typescript
if (error.code === 'MISSING_TENANT_ID') {
  alert('系统配置错误，请联系管理员');
}
```

---

## 测试清单

### 在接入前，请测试以下场景：

- [ ] **正常现金支付**: 收到 $50，订单 $41.04，找零 $8.96
- [ ] **刚好金额**: 收到 $41.04，订单 $41.04，找零 $0
- [ ] **现金不足**: 收到 $40，订单 $41.04，应该报错
- [ ] **大额现金**: 收到 $100，订单 $41.04，找零 $58.96
- [ ] **带折扣订单**: 原价 $50，折扣 $10，实付 $40
- [ ] **多商品订单**: 3个商品，总计 $85.50
- [ ] **堂食订单**: 需要桌号
- [ ] **自取订单**: 不需要桌号

---

## Postman 测试示例

### 导入到 Postman

```json
{
  "info": {
    "name": "Order Service - Cash Payment",
    "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"
  },
  "item": [
    {
      "name": "Create Cash Order",
      "request": {
        "method": "POST",
        "header": [
          {
            "key": "Content-Type",
            "value": "application/json"
          },
          {
            "key": "Authorization",
            "value": "Bearer {{jwt_token}}"
          },
          {
            "key": "x-organization-id",
            "value": "{{tenant_id}}"
          }
        ],
        "body": {
          "mode": "raw",
          "raw": "{\n  \"orderType\": \"DINE_IN\",\n  \"orderSource\": \"POS\",\n  \"tableNumber\": \"A-01\",\n  \"items\": [\n    {\n      \"itemId\": \"550e8400-e29b-41d4-a716-446655440001\",\n      \"itemName\": \"测试商品\",\n      \"quantity\": 1,\n      \"unitPrice\": 10.00\n    }\n  ],\n  \"totalAmount\": 10.00,\n  \"paymentMethod\": \"CASH\",\n  \"cashReceived\": 20.00\n}"
        },
        "url": {
          "raw": "http://localhost:3002/api/order/v1/orders",
          "protocol": "http",
          "host": ["localhost"],
          "port": "3002",
          "path": ["api", "order", "v1", "orders"]
        }
      }
    },
    {
      "name": "Get Order Details",
      "request": {
        "method": "GET",
        "header": [
          {
            "key": "Authorization",
            "value": "Bearer {{jwt_token}}"
          },
          {
            "key": "x-organization-id",
            "value": "{{tenant_id}}"
          }
        ],
        "url": {
          "raw": "http://localhost:3002/api/order/v1/orders/{{order_id}}",
          "protocol": "http",
          "host": ["localhost"],
          "port": "3002",
          "path": ["api", "order", "v1", "orders", "{{order_id}}"]
        }
      }
    }
  ]
}
```

---

## 常见问题 FAQ

### Q1: 为什么创建订单的响应中没有 cashReceived 和 changeGiven？

A: 为了减少响应大小，创建订单接口只返回基本信息。需要通过订单详情接口获取完整信息。

### Q2: POS 端是否需要验证价格？

A: 不需要。POS 是可信来源，后端直接接受前端计算的价格。

### Q3: 如果网络断开怎么办？

A: 建议实现离线模式，将订单缓存到本地，网络恢复后再同步。

### Q4: 订单号格式是什么？

A: 格式为 `{门店代码}-POS-{日期}-{序号}`，例如：`A6AEE8-POS-20241206-0001`

### Q5: 如何处理找零不足的情况？

A: 这是业务逻辑，建议在 POS 端提示收银员，系统不会阻止订单创建。

---

## 下一步

完成现金支付接入后，可以继续实现：

1. **订单查询** - 查看历史订单
2. **订单状态更新** - 更新订单状态
3. **打印小票** - 集成打印服务
4. **其他支付方式** - 银行卡、支付宝、微信支付

---

## 技术支持

如有问题，请查看：
- [API.md](./API.md) - 完整 API 文档
- [CASH-PAYMENT.md](./CASH-PAYMENT.md) - 现金支付详细文档
- [test-cash-payment.http](./test-cash-payment.http) - API 测试用例

