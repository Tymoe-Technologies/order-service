# 现金支付流程文档

## 概述

现金支付是最简单、最直接的支付方式，主要用于 POS 订单。系统会自动计算找零金额。

---

## 支付流程

### 1. POS 现金支付流程

```
收银员扫描商品
    ↓
系统计算总金额
    ↓
收银员输入收到的现金
    ↓
系统自动计算找零
    ↓
创建订单（状态：PAID）
    ↓
打印小票（显示找零金额）
```

---

## API 使用

### 创建现金支付订单

**请求**:
```http
POST /api/order/v1/orders
Authorization: Bearer {token}
x-organization-id: {tenantId}
Content-Type: application/json
```

**请求体**:
```json
{
  "orderType": "DINE_IN",
  "orderSource": "POS",
  "tableNumber": "A-01",
  "items": [
    {
      "itemId": "uuid-1",
      "itemName": "宫保鸡丁",
      "quantity": 1,
      "unitPrice": 38.00
    }
  ],
  "taxAmount": 3.04,
  "totalAmount": 41.04,
  
  "paymentMethod": "CASH",
  "cashReceived": 50.00
}
```

**字段说明**:
- `paymentMethod`: 必须为 `"CASH"`
- `cashReceived`: **必填**，收到的现金金额，必须 ≥ totalAmount
- `totalAmount`: 订单总金额

**响应**:
```json
{
  "success": true,
  "data": {
    "id": "order-uuid",
    "orderNumber": "A6AEE8-POS-20241206-0001",
    "status": "PENDING",
    "totalAmount": 41.04,
    "paymentStatus": "PAID",
    "cashReceived": 50.00,
    "changeGiven": 8.96,
    "createdAt": "2024-12-06T02:30:00Z"
  }
}
```

**计算逻辑**:
```typescript
changeGiven = cashReceived - totalAmount
// 例如: 50.00 - 41.04 = 8.96
```

---

## 数据库字段

### Order 表新增字段

| 字段 | 类型 | 说明 | 示例 |
|------|------|------|------|
| `cashReceived` | Decimal(10,2) | 收到的现金金额 | 50.00 |
| `changeGiven` | Decimal(10,2) | 找零金额 | 8.96 |
| `cashierId` | UUID | 收银员ID | uuid |
| `paymentStatus` | Enum | 支付状态 | PAID |
| `paidAt` | DateTime | 支付时间 | 2024-12-06T02:30:00Z |

---

## 验证规则

### 1. 现金金额验证

```typescript
if (paymentMethod === 'CASH') {
  // cashReceived 必填
  if (!cashReceived) {
    throw new Error('现金支付必须提供收到的现金金额');
  }
  
  // 现金必须足够
  if (cashReceived < totalAmount) {
    throw new Error(`收到的现金不足，应收 ${totalAmount}，实收 ${cashReceived}`);
  }
}
```

### 2. 支付方式验证

支持的支付方式:
- ✅ `CASH` - 现金
- ✅ `CARD` - 银行卡
- ✅ `ALIPAY` - 支付宝
- ✅ `WECHAT` - 微信支付
- ✅ `APPLE_PAY` - Apple Pay
- ✅ `GOOGLE_PAY` - Google Pay

---

## 业务规则

### 1. 自动标记为已支付

现金支付的订单会自动:
- ✅ `paymentStatus` 设置为 `PAID`
- ✅ `paidAt` 设置为当前时间
- ✅ `cashierId` 设置为创建订单的用户ID

### 2. 找零计算

系统自动计算找零:
```
找零 = 收到的现金 - 订单总金额
```

**示例**:
- 订单总金额: $41.04
- 收到现金: $50.00
- 找零: $8.96

### 3. 小票打印

现金支付小票会显示:
- ✅ 订单总金额
- ✅ 收到现金
- ✅ 找零金额

```
================================
         餐厅名称
================================
订单号: A6AEE8-POS-20241206-0001
时间: 2024-12-06 14:30:00
收银员: John Doe
--------------------------------
宫保鸡丁 x1         $38.00
--------------------------------
小计:               $38.00
税费:                $3.04
--------------------------------
总计:               $41.04
================================
收款:               $50.00
找零:                $8.96
================================
感谢惠顾！
```

---

## 错误处理

### 常见错误

| 错误码 | 说明 | 解决方案 |
|--------|------|---------|
| `INSUFFICIENT_CASH` | 现金不足 | 增加收到的现金金额 |
| `CASH_REQUIRED` | 缺少现金金额 | 提供 `cashReceived` 字段 |
| `INVALID_PAYMENT_METHOD` | 无效的支付方式 | 使用支持的支付方式 |

**示例错误响应**:
```json
{
  "success": false,
  "error": {
    "code": "INSUFFICIENT_CASH",
    "message": "收到的现金不足，应收 41.04，实收 40.00"
  }
}
```

---

## 前端集成示例

### React 示例

```typescript
import { useState } from 'react';

function CashPayment({ order }) {
  const [cashReceived, setCashReceived] = useState('');
  const [changeGiven, setChangeGiven] = useState(0);
  
  // 实时计算找零
  const handleCashInput = (value: string) => {
    setCashReceived(value);
    const received = parseFloat(value) || 0;
    const change = received - order.totalAmount;
    setChangeGiven(change >= 0 ? change : 0);
  };
  
  const handlePayment = async () => {
    try {
      const response = await fetch('/api/order/v1/orders', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
          'x-organization-id': tenantId
        },
        body: JSON.stringify({
          ...order,
          paymentMethod: 'CASH',
          cashReceived: parseFloat(cashReceived)
        })
      });
      
      const result = await response.json();
      
      if (result.success) {
        // 显示找零金额
        alert(`找零: $${result.data.changeGiven.toFixed(2)}`);
        // 打印小票
        printReceipt(result.data);
      }
    } catch (error) {
      console.error('Payment failed:', error);
    }
  };
  
  return (
    <div>
      <h3>总金额: ${order.totalAmount.toFixed(2)}</h3>
      
      <input
        type="number"
        value={cashReceived}
        onChange={(e) => handleCashInput(e.target.value)}
        placeholder="收到的现金"
        min={order.totalAmount}
        step="0.01"
      />
      
      {changeGiven > 0 && (
        <div className="change-display">
          <strong>找零: ${changeGiven.toFixed(2)}</strong>
        </div>
      )}
      
      <button 
        onClick={handlePayment}
        disabled={parseFloat(cashReceived) < order.totalAmount}
      >
        确认收款
      </button>
    </div>
  );
}
```

---

## 测试用例

### 测试场景 1: 正常现金支付

```bash
curl -X POST http://localhost:3002/api/order/v1/orders \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer {token}" \
  -H "x-organization-id: {tenantId}" \
  -d '{
    "orderType": "DINE_IN",
    "orderSource": "POS",
    "items": [{
      "itemId": "uuid-1",
      "itemName": "测试商品",
      "quantity": 1,
      "unitPrice": 10.00
    }],
    "totalAmount": 10.00,
    "paymentMethod": "CASH",
    "cashReceived": 20.00
  }'
```

**预期结果**:
- ✅ 订单创建成功
- ✅ `paymentStatus` = `PAID`
- ✅ `cashReceived` = 20.00
- ✅ `changeGiven` = 10.00

### 测试场景 2: 现金不足

```bash
curl -X POST http://localhost:3002/api/order/v1/orders \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer {token}" \
  -H "x-organization-id: {tenantId}" \
  -d '{
    "orderType": "DINE_IN",
    "orderSource": "POS",
    "items": [{
      "itemId": "uuid-1",
      "itemName": "测试商品",
      "quantity": 1,
      "unitPrice": 10.00
    }],
    "totalAmount": 10.00,
    "paymentMethod": "CASH",
    "cashReceived": 5.00
  }'
```

**预期结果**:
- ❌ 返回 400 错误
- ❌ 错误码: `INSUFFICIENT_CASH`
- ❌ 错误信息: "收到的现金不足，应收 10.00，实收 5.00"

### 测试场景 3: 缺少现金金额

```bash
curl -X POST http://localhost:3002/api/order/v1/orders \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer {token}" \
  -H "x-organization-id: {tenantId}" \
  -d '{
    "orderType": "DINE_IN",
    "orderSource": "POS",
    "items": [{
      "itemId": "uuid-1",
      "itemName": "测试商品",
      "quantity": 1,
      "unitPrice": 10.00
    }],
    "totalAmount": 10.00,
    "paymentMethod": "CASH"
  }'
```

**预期结果**:
- ❌ 返回 400 错误
- ❌ 验证失败: `cashReceived` 字段必填

---

## 常见问题 (FAQ)

### Q1: 如果收到的现金刚好等于订单金额怎么办？

A: 系统会自动计算 `changeGiven = 0`，表示无需找零。

### Q2: 现金支付是否需要调用第三方支付接口？

A: 不需要。现金支付完全在本地处理，不涉及第三方支付平台。

### Q3: 现金支付的订单可以退款吗？

A: 可以。退款流程需要通过 Finance Service 处理，记录退款金额和原因。

### Q4: 如何查询某个收银员的现金收款记录？

A: 通过 `cashierId` 字段查询:
```sql
SELECT * FROM orders 
WHERE cashier_id = 'user-uuid' 
  AND payment_method = 'CASH'
  AND payment_status = 'PAID'
  AND created_at >= '2024-12-06'
```

### Q5: 现金支付是否支持部分支付？

A: 当前版本不支持。现金必须一次性支付全部金额。

---

## 后续优化

### 计划中的功能

1. **多种支付方式组合**
   - 现金 + 银行卡
   - 现金 + 支付宝

2. **现金管理**
   - 班次现金统计
   - 收银员交班报表
   - 现金盘点功能

3. **找零优化**
   - 智能找零建议（如建议给 $50 而不是 $49.99）
   - 零钱不足提醒

4. **小票增强**
   - 显示收银员姓名
   - 显示找零明细（几张几元）

---

## 更新日志

### v1.0.0 (2024-12-06)
- ✅ 初始版本
- ✅ 支持基础现金支付
- ✅ 自动计算找零
- ✅ 验证现金金额
- ✅ 记录收银员信息




