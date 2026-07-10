# 支付成功后更新订单状态 - 实施说明

## 概览

本文档说明了 **支付成功后更新订单状态** 功能的实施。这是完成支付流程的关键环节，确保订单在 Stripe 支付成功后能被正确标记为已支付。

## 已实施的变更

### 1. Order Service - 新增端点

#### 路径
```
PATCH /api/order/v1/orders/:orderId/payment-status
```

#### 用途
- 由 Finance Service 在支付成功后调用
- 更新订单的支付状态（UNPAID → PAID）
- 自动转换订单状态（PENDING → CONFIRMED）

#### 请求示例
```bash
curl -X PATCH http://localhost:3002/api/order/v1/orders/{orderId}/payment-status \
  -H "X-Organization-Id: {tenantId}" \
  -H "Content-Type: application/json" \
  -d '{
    "paymentStatus": "PAID"
  }'
```

#### 请求头
- `X-Organization-Id`: **必需** - 租户 ID（用于租户隔离）
- `Content-Type`: application/json

#### 请求体
```json
{
  "paymentStatus": "PAID",
  "paymentIntentId": "pi_xxx",  // 可选
  "paymentMethod": "card"       // 可选
}
```

#### 响应示例
```json
{
  "success": true,
  "data": {
    "id": "order-uuid",
    "orderNumber": "A6AEE8-WEB-20240130-0001",
    "paymentStatus": "PAID",
    "status": "CONFIRMED",
    "paidAt": "2024-01-30T12:30:00.000Z",
    "message": "订单支付状态已成功更新"
  }
}
```

## 核心功能

### 1. 租户隔离
```typescript
const order = await tx.order.findFirst({
  where: { id: data.orderId, tenantId: data.tenantId },
});
```
- 通过 `tenantId + orderId` 组合查询
- 防止跨租户越权访问

### 2. 幂等性保证
```typescript
if (order.paymentStatus === data.paymentStatus) {
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    paymentStatus: order.paymentStatus,
    message: '订单支付状态已是目标状态',
  };
}
```
- 重复调用返回成功，不会重复更新
- 符合支付最佳实践（Webhook 可能多次发送）

### 3. 状态转换验证
```typescript
const allowedTransitions: Record<string, string[]> = {
  UNPAID: ['PAID', 'PARTIALLY_PAID', 'FAILED'],
  PARTIALLY_PAID: ['PAID', 'REFUNDED'],
  PAID: ['REFUNDED'],  // 已支付只能退款
  FAILED: ['PAID', 'UNPAID'],
  REFUNDED: [],
};
```
- 防止恶意降级（如 PAID → UNPAID）
- 只允许合法的状态转换

### 4. 自动状态转换
```typescript
if (order.status === 'PENDING') {
  updateData.status = 'CONFIRMED';
  updateData.confirmedAt = new Date();
}
```
- 支付成功后自动将订单从 PENDING 转换为 CONFIRMED
- 用户界面可据此展示订单确认

### 5. 事务保证
```typescript
return await prisma.$transaction(async (tx) => {
  // 所有操作在同一事务中
  const order = await tx.order.findFirst(...);
  const updatedOrder = await tx.order.update(...);
});
```
- 确保原子性
- 避免部分更新的不一致状态

## 完整的支付流程

```
1. 前端：创建 Checkout Snapshot
   POST /api/order/v1/checkout-snapshots
   ↓ 返回 snapshotId 和 verified pricing

2. 前端：创建临时订单
   POST /api/order/v1/web/create-from-snapshot
   ↓ 返回 orderId 和 orderNumber
   ↓ 订单状态: PENDING, 支付状态: UNPAID

3. 前端：创建支付意图
   POST /api/finance/v1/public/payments/intent
   ↓ 返回 clientSecret

4. 用户：完成 Stripe 支付
   ↓ 支付成功

5. Stripe → Finance Service Webhook
   POST /api/finance/v1/webhooks/stripe
   ↓ 事件: payment_intent.succeeded

6. Finance Service → Order Service (本端点)
   PATCH /api/order/v1/orders/{orderId}/payment-status
   ↓ 请求体: { paymentStatus: "PAID" }

7. Order Service: 更新订单状态
   ✅ paymentStatus: UNPAID → PAID
   ✅ status: PENDING → CONFIRMED
   ✅ 返回成功

8. 前端：轮询订单状态
   GET /api/order/v1/orders/web/by-payment/{paymentIntentId}
   ↓ 获取已确认的订单

9. 前端：显示订单确认页
```

## 安全性保证

| 检查项 | 实现方式 | 防御场景 |
|--------|---------|---------|
| **租户隔离** | `tenantId + orderId` 组合查询 | 防止越权访问其他租户订单 |
| **状态转换限制** | 允许转换白名单 | 防止恶意降级（PAID → UNPAID） |
| **请求头验证** | 必须提供 `x-organization-id` | 防止缺失租户信息的请求 |
| **幂等性** | 检查当前状态，重复调用返回成功 | 防止 Webhook 重复发送导致问题 |
| **事务处理** | Prisma 事务保证原子性 | 防止部分更新导致数据不一致 |

## Finance Service 集成

Finance Service 已在 Webhook 处理器中实现了调用逻辑，无需修改：

```typescript
// tymoe-finance-service/src/modules/payment/services/webhook.service.ts
async notifyOrderService(tenantId: string, orderId: string, status: string) {
  const url = `${env.orderServiceUrl}/api/order/v1/orders/${orderId}/payment-status`;
  const payload = { paymentStatus: status };
  const headers = { 'x-organization-id': tenantId };
  await axios.patch(url, payload, { headers });
}
```

✅ Finance Service 端 **无需任何修改**！

## 测试验证

### 前置条件
1. Order Service 已启动（端口 3002）
2. 已创建测试订单（处于 PENDING/UNPAID 状态）
3. 已获取订单的 tenantId 和 orderId

### 运行测试脚本

```bash
# 赋予执行权限
chmod +x test-payment-status.sh

# 运行测试
./test-payment-status.sh
```

### 测试场景

#### 测试 1: 成功更新订单状态
```bash
curl -X PATCH http://localhost:3002/api/order/v1/orders/{orderId}/payment-status \
  -H "X-Organization-Id: {tenantId}" \
  -H "Content-Type: application/json" \
  -d '{"paymentStatus": "PAID"}'
```

**预期结果**:
- ✅ HTTP 200
- ✅ 返回 `paymentStatus: "PAID"`
- ✅ 返回 `status: "CONFIRMED"`（如果原状态为 PENDING）

#### 测试 2: 幂等性（重复调用）
**第二次调用相同的请求**

**预期结果**:
- ✅ HTTP 200
- ✅ 返回消息: "订单支付状态已是目标状态"
- ✅ 不重复更新数据库

#### 测试 3: 缺少租户头
```bash
curl -X PATCH http://localhost:3002/api/order/v1/orders/{orderId}/payment-status \
  -H "Content-Type: application/json" \
  -d '{"paymentStatus": "PAID"}'
```

**预期结果**:
- ❌ HTTP 400
- ❌ 错误消息: "缺少必需的 X-Organization-Id 请求头"

#### 测试 4: 无效的支付状态
```bash
curl -X PATCH http://localhost:3002/api/order/v1/orders/{orderId}/payment-status \
  -H "X-Organization-Id: {tenantId}" \
  -H "Content-Type: application/json" \
  -d '{"paymentStatus": "INVALID_STATUS"}'
```

**预期结果**:
- ❌ HTTP 400
- ❌ 错误消息: "无效的支付状态"

#### 测试 5: 防止越权访问
```bash
curl -X PATCH http://localhost:3002/api/order/v1/orders/{orderId}/payment-status \
  -H "X-Organization-Id: different-tenant-id" \
  -H "Content-Type: application/json" \
  -d '{"paymentStatus": "PAID"}'
```

**预期结果**:
- ❌ HTTP 404
- ❌ 错误消息: "Order not found or no permission"

#### 测试 6: 防止恶意降级（PAID → UNPAID）
**假设订单当前状态为 PAID**

```bash
curl -X PATCH http://localhost:3002/api/order/v1/orders/{orderId}/payment-status \
  -H "X-Organization-Id: {tenantId}" \
  -H "Content-Type: application/json" \
  -d '{"paymentStatus": "UNPAID"}'
```

**预期结果**:
- ❌ HTTP 400
- ❌ 错误消息: "Cannot transition from PAID to UNPAID"

## 数据库验证

### 查看订单更新
```sql
-- 查询订单的支付状态
SELECT id, orderNumber, status, paymentStatus, paidAt
FROM "Order"
WHERE id = '{orderId}'
  AND tenantId = '{tenantId}';
```

**预期结果**:
- `status`: CONFIRMED（如果原来是 PENDING）
- `paymentStatus`: PAID
- `paidAt`: 更新时间（当前时间）

## 故障排查

### 问题 1: "Order not found" 错误
**可能原因**:
- tenantId 和 orderId 不匹配
- orderId 不存在
- 拼写错误

**解决方案**:
```bash
# 验证订单是否存在
SELECT id, tenantId, status, paymentStatus
FROM "Order"
WHERE id = '{orderId}';
```

### 问题 2: 状态转换失败
**可能原因**:
- 尝试的状态转换不被允许（如 PAID → UNPAID）

**解决方案**:
- 检查允许的状态转换规则
- 先将订单标记为退款（REFUNDED）再处理

### 问题 3: 幂等性检查失败
**可能原因**:
- 订单已经是目标状态，返回成功但未更新

**解决方案**:
- 这是预期行为
- 查看返回消息："订单支付状态已是目标状态"

## 日志示例

### 成功更新日志
```
[UpdatePaymentStatus] 订单支付状态已更新
{
  "orderId": "order-uuid",
  "orderNumber": "A6AEE8-WEB-20240130-0001",
  "oldStatus": "UNPAID",
  "newStatus": "PAID"
}
```

### 幂等性日志
```
[UpdatePaymentStatus] 订单已处于目标状态，跳过更新
{
  "orderId": "order-uuid",
  "currentStatus": "PAID"
}
```

## 联调步骤

### Step 1: 启动本地服务
```bash
# Order Service
cd tymoe-order-service
npm run dev

# Finance Service（在另一个终端）
cd tymoe-finance-service
npm run dev
```

### Step 2: 创建测试订单
1. 创建 Checkout Snapshot
2. 创建临时订单
3. 获取 orderId 和 tenantId

### Step 3: 模拟 Finance Service 调用
```bash
# 使用 test-payment-status.sh 或直接 curl 调用
curl -X PATCH http://localhost:3002/api/order/v1/orders/{orderId}/payment-status \
  -H "X-Organization-Id: {tenantId}" \
  -H "Content-Type: application/json" \
  -d '{"paymentStatus": "PAID"}'
```

### Step 4: 验证结果
- 检查订单状态是否更新为 CONFIRMED/PAID
- 检查前端轮询是否能获取更新后的订单
- 查看日志确认没有错误

## 总结

✅ **已实现**:
- [x] Service 方法：updatePaymentStatus()
- [x] Controller 控制器：updatePaymentStatus()
- [x] Routes 路由：PATCH /:orderId/payment-status
- [x] 租户隔离安全验证
- [x] 幂等性保证
- [x] 状态转换验证
- [x] 自动状态转换
- [x] 事务处理
- [x] 详细日志记录

✅ **Finance Service 集成**:
- ✅ 无需修改（已有 notifyOrderService 实现）

✅ **测试验证**:
- ✅ 测试脚本已提供
- ✅ 所有场景覆盖（成功、幂等性、错误处理等）

## 相关文件

- [order.service.ts](src/services/order.service.ts) - updatePaymentStatus() 方法
- [order.controller.ts](src/controllers/order.controller.ts) - updatePaymentStatus() 控制器
- [order.routes.ts](src/routes/order.routes.ts) - 路由注册
- [test-payment-status.sh](test-payment-status.sh) - 测试脚本

## 参考

- 计划文档：[/Users/meng/.claude/plans/wondrous-coalescing-gosling.md]()
- Stripe Webhook 处理：[tymoe-finance-service/src/modules/payment/services/webhook.service.ts]()
