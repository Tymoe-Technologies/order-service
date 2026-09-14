# POS 前端快速接入指南

## 🚀 5分钟快速开始

### 步骤 1: 启动 Order Service

```bash
cd /Users/meng/Desktop/CODE/Reall/reall-order-service
npm run dev
```

服务将运行在 `http://localhost:3002`

---

### 步骤 2: 准备认证信息

你需要准备：
- ✅ **JWT Token** - 从认证服务获取
- ✅ **Tenant ID** - 你的组织/门店 ID (UUID 格式)

---

### 步骤 3: 测试接口

#### 方法 1: 使用 HTML 测试页面（最简单）

1. 用浏览器打开 `test-pos-frontend.html`
2. 填入 JWT Token 和 Tenant ID
3. 输入收到的现金金额
4. 点击"确认收款并创建订单"

#### 方法 2: 使用 HTTP 文件测试

1. 用 VS Code 打开 `test-pos-integration.http`
2. 安装 REST Client 插件
3. 修改顶部的 `@token` 和 `@tenantId`
4. 点击 "Send Request" 运行测试

#### 方法 3: 使用 curl 命令

```bash
curl -X POST http://localhost:3002/api/order/v1/orders \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "x-organization-id: YOUR_TENANT_ID" \
  -d '{
    "orderType": "DINE_IN",
    "orderSource": "POS",
    "tableNumber": "A-01",
    "items": [
      {
        "itemId": "550e8400-e29b-41d4-a716-446655440001",
        "itemName": "测试商品",
        "quantity": 1,
        "unitPrice": 10.00
      }
    ],
    "totalAmount": 10.00,
    "paymentMethod": "CASH",
    "cashReceived": 20.00
  }'
```

---

### 步骤 4: 验证响应

成功的响应应该包含：

```json
{
  "success": true,
  "data": {
    "id": "订单UUID",
    "orderNumber": "A6AEE8-POS-20241206-0001",
    "status": "PENDING",
    "totalAmount": "10.00",
    "paymentStatus": "PAID",
    "paymentMethod": "CASH",
    "cashReceived": "20.00",
    "changeGiven": "10.00",  // 👈 找零金额
    "createdAt": "2024-12-06T10:30:00.000Z"
  }
}
```

---

## 📋 最小可用代码

### JavaScript/TypeScript

```typescript
async function createCashOrder(
  totalAmount: number,
  cashReceived: number,
  items: any[]
) {
  const response = await fetch('http://localhost:3002/api/order/v1/orders', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${YOUR_JWT_TOKEN}`,
      'x-organization-id': YOUR_TENANT_ID
    },
    body: JSON.stringify({
      orderType: 'DINE_IN',
      orderSource: 'POS',
      tableNumber: 'A-01',
      items: items,
      totalAmount: totalAmount,
      paymentMethod: 'CASH',
      cashReceived: cashReceived
    })
  });

  const result = await response.json();
  
  if (result.success) {
    // 显示找零
    alert(`找零: $${result.data.changeGiven}`);
    return result.data;
  } else {
    throw new Error(result.error.message);
  }
}

// 使用示例
const order = await createCashOrder(
  44.28,  // 订单总额
  50.00,  // 收到的现金
  [
    {
      itemId: '550e8400-e29b-41d4-a716-446655440001',
      itemName: '宫保鸡丁',
      quantity: 1,
      unitPrice: 38.00
    }
  ]
);

console.log('订单号:', order.orderNumber);
console.log('找零:', order.changeGiven);
```

---

## ✅ 测试清单

在正式接入前，请测试以下场景：

- [ ] 正常现金支付（收 $50，订单 $44.28）
- [ ] 刚好金额（收 $44.28，订单 $44.28）
- [ ] 大额现金（收 $100，订单 $44.28）
- [ ] 现金不足（收 $40，订单 $44.28）- 应该报错
- [ ] 多商品订单
- [ ] 堂食订单（需要桌号）
- [ ] 自取订单（不需要桌号）

---

## 🔧 常见问题

### Q: CORS 错误怎么办？

A: Order Service 已配置 CORS，允许 `http://localhost:8888`。如果你的前端运行在其他端口，需要在 `.env` 文件中添加：

```env
ALLOWED_ORIGINS=http://localhost:3000,http://localhost:8888,http://localhost:YOUR_PORT
```

然后重启服务。

### Q: 401 Unauthorized 错误？

A: 检查：
1. JWT Token 是否正确
2. Token 是否过期
3. `Authorization` header 格式是否为 `Bearer {token}`

### Q: Missing tenantId 错误？

A: 检查：
1. 是否添加了 `x-organization-id` header
2. Tenant ID 格式是否为 UUID

### Q: 现金不足错误？

A: 这是正常的业务验证，确保 `cashReceived >= totalAmount`

---

## 📖 完整文档

- [POS-INTEGRATION-GUIDE.md](./POS-INTEGRATION-GUIDE.md) - 完整接入指南
- [API.md](./API.md) - 完整 API 文档
- [CASH-PAYMENT.md](./CASH-PAYMENT.md) - 现金支付详细文档

---

## 🆘 需要帮助？

如果遇到问题：
1. 检查 Order Service 日志
2. 使用浏览器开发者工具查看网络请求
3. 参考 `test-pos-integration.http` 中的测试用例
4. 查看完整文档

---

## 下一步

完成现金支付接入后，可以继续实现：
1. 订单状态更新
2. 订单查询
3. 打印小票
4. 其他支付方式（银行卡、支付宝、微信）
