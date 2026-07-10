# 订单状态系统设计

## 概述

订单状态系统需要支持不同订单来源的差异化状态流转，同时保持统一的状态管理。

---

## 核心设计原则

### 1. 统一状态模型 + 差异化流转

所有订单使用**统一的状态枚举**，但不同来源有**不同的状态流转路径**。

### 2. 状态的业务含义

每个状态都有明确的业务含义，适用于不同场景：

| 状态 | 业务含义 | 适用场景 |
|------|---------|---------|
| `PENDING` | 待确认 | 所有来源 |
| `CONFIRMED` | 已确认 | 所有来源 |
| `PREPARING` | 准备中/制作中 | 所有来源 |
| `READY` | 已完成/待取餐 | KIOSK, WEB, 外卖 |
| `PICKED_UP` | 已取餐 | KIOSK, WEB |
| `OUT_FOR_DELIVERY` | 配送中 | 外卖订单 |
| `DELIVERED` | 已送达 | 外卖订单 |
| `COMPLETED` | 已完成 | 所有来源 |
| `CANCELLED` | 已取消 | 所有来源 |

---

## 完整状态枚举

```prisma
enum OrderStatus {
  // 初始状态
  PENDING              // 待确认（订单刚创建）
  CONFIRMED            // 已确认（商家确认接单）
  
  // 制作阶段
  PREPARING            // 准备中/制作中
  READY                // 已完成/待取餐
  
  // 取餐/配送阶段
  PICKED_UP            // 已取餐（KIOSK/自取订单）
  OUT_FOR_DELIVERY     // 配送中（外卖订单）
  DELIVERED            // 已送达（外卖订单）
  
  // 终态
  COMPLETED            // 已完成
  CANCELLED            // 已取消
}
```

---

## 不同来源的状态流转

### 1️⃣ POS 订单（堂食/自取）

```
PENDING → CONFIRMED → PREPARING → READY → COMPLETED
   ↓          ↓           ↓          ↓
CANCELLED  CANCELLED   CANCELLED  CANCELLED
```

**特点**：
- 简单直接的流转
- 通常快速完成
- `READY` 后直接 `COMPLETED`（堂食立即用餐，自取立即拿走）

**状态说明**：
- `PENDING`: 订单刚创建，等待确认
- `CONFIRMED`: 订单已确认，准备制作
- `PREPARING`: 厨房正在制作
- `READY`: 菜品已完成
- `COMPLETED`: 客人已用餐/已取走

---

### 2️⃣ KIOSK 订单（自助点餐）

```
PENDING → CONFIRMED → PREPARING → READY → PICKED_UP → COMPLETED
   ↓          ↓           ↓          ↓         ↓
CANCELLED  CANCELLED   CANCELLED  CANCELLED  CANCELLED
```

**特点**：
- 需要叫号系统
- `READY` 状态会触发叫号
- 客人取餐后变为 `PICKED_UP`

**状态说明**：
- `PENDING`: 订单创建，等待支付确认
- `CONFIRMED`: 支付成功，订单确认
- `PREPARING`: 厨房制作中
- `READY`: 制作完成，**开始叫号**
- `PICKED_UP`: 客人已取餐
- `COMPLETED`: 订单完成

**叫号逻辑**：
```typescript
// 当订单状态变为 READY 时
if (order.status === 'READY' && order.orderSource === 'KIOSK') {
  // 1. 在叫号屏显示
  await displayOnScreen({
    orderNumber: order.pickupNumber,
    customerName: order.pickupName
  });
  
  // 2. 发送短信通知（如果有手机号）
  if (order.customerPhone) {
    await sendSMS(order.customerPhone, 
      `您的订单 #${order.pickupNumber} 已完成，请取餐`
    );
  }
  
  // 3. 播放语音提醒
  await playAudio(`请 ${order.pickupNumber} 号取餐`);
}
```

---

### 3️⃣ WEB 订单（在线点餐）

```
PENDING → CONFIRMED → PREPARING → READY → PICKED_UP → COMPLETED
   ↓          ↓           ↓          ↓         ↓
CANCELLED  CANCELLED   CANCELLED  CANCELLED  CANCELLED
```

**特点**：
- 需要支付确认
- 支持预约时间
- 可能需要通知客户

**状态说明**：
- `PENDING`: 订单创建，等待支付
- `CONFIRMED`: 支付成功，订单确认
- `PREPARING`: 制作中
- `READY`: 制作完成，等待客人来取
- `PICKED_UP`: 客人已取餐
- `COMPLETED`: 订单完成

---

### 4️⃣ 外卖订单（Uber Eats, DoorDash 等）

```
PENDING → CONFIRMED → PREPARING → READY → OUT_FOR_DELIVERY → DELIVERED → COMPLETED
   ↓          ↓           ↓          ↓            ↓              ↓
CANCELLED  CANCELLED   CANCELLED  CANCELLED    CANCELLED      CANCELLED
```

**特点**：
- 状态最复杂
- 需要同步到外卖平台
- 涉及配送员

**状态说明**：
- `PENDING`: 平台推送订单，等待商家确认
- `CONFIRMED`: 商家确认接单
- `PREPARING`: 制作中
- `READY`: 制作完成，等待配送员取餐
- `OUT_FOR_DELIVERY`: 配送员已取餐，正在配送
- `DELIVERED`: 已送达客户
- `COMPLETED`: 订单完成

**平台同步**：
```typescript
// 状态变化时同步到外卖平台
async function syncStatusToPlatform(order: Order, newStatus: OrderStatus) {
  if (order.orderSource === 'UBER_EATS') {
    const platformStatus = mapStatusToUberEats(newStatus);
    await uberEatsClient.updateOrderStatus(
      order.orderSourceId,
      platformStatus
    );
  }
}

// 状态映射
function mapStatusToUberEats(status: OrderStatus): string {
  const mapping = {
    'CONFIRMED': 'accepted',
    'PREPARING': 'preparing',
    'READY': 'ready_for_pickup',
    'OUT_FOR_DELIVERY': 'picked_up',
    'DELIVERED': 'delivered',
    'CANCELLED': 'cancelled'
  };
  return mapping[status] || 'unknown';
}
```

---

## 状态流转规则

### 允许的状态转换

```typescript
const ALLOWED_TRANSITIONS = {
  'PENDING': ['CONFIRMED', 'CANCELLED'],
  'CONFIRMED': ['PREPARING', 'CANCELLED'],
  'PREPARING': ['READY', 'CANCELLED'],
  'READY': ['PICKED_UP', 'OUT_FOR_DELIVERY', 'COMPLETED', 'CANCELLED'],
  'PICKED_UP': ['COMPLETED', 'CANCELLED'],
  'OUT_FOR_DELIVERY': ['DELIVERED', 'CANCELLED'],
  'DELIVERED': ['COMPLETED'],
  'COMPLETED': [],  // 终态，不能转换
  'CANCELLED': []   // 终态，不能转换
};

// 验证状态转换
function validateStatusTransition(
  currentStatus: OrderStatus, 
  newStatus: OrderStatus
): boolean {
  const allowedNext = ALLOWED_TRANSITIONS[currentStatus];
  return allowedNext.includes(newStatus);
}
```

### 状态转换验证

```typescript
async function updateOrderStatus(
  orderId: string,
  newStatus: OrderStatus,
  reason?: string
) {
  const order = await getOrder(orderId);
  
  // 1. 验证状态转换是否合法
  if (!validateStatusTransition(order.status, newStatus)) {
    throw new Error(
      `不允许从 ${order.status} 转换到 ${newStatus}`
    );
  }
  
  // 2. 更新状态
  await prisma.order.update({
    where: { id: orderId },
    data: { status: newStatus }
  });
  
  // 3. 记录状态历史
  await prisma.orderStatusHistory.create({
    data: {
      orderId,
      fromStatus: order.status,
      toStatus: newStatus,
      reason,
      changedAt: new Date()
    }
  });
  
  // 4. 触发状态变化后的业务逻辑
  await handleStatusChange(order, newStatus);
}
```

---

## 状态历史记录

### 数据模型

```prisma
model OrderStatusHistory {
  id          String      @id @default(uuid()) @db.Uuid
  orderId     String      @map("order_id") @db.Uuid
  fromStatus  OrderStatus @map("from_status")
  toStatus    OrderStatus @map("to_status")
  reason      String?     @db.Text
  changedBy   String?     @map("changed_by") @db.Uuid
  changedAt   DateTime    @default(now()) @map("changed_at")
  
  order       Order       @relation(fields: [orderId], references: [id], onDelete: Cascade)
  
  @@index([orderId, changedAt])
  @@map("order_status_history")
}
```

### 查询状态历史

```typescript
// 获取订单的状态变更历史
async function getOrderStatusHistory(orderId: string) {
  return await prisma.orderStatusHistory.findMany({
    where: { orderId },
    orderBy: { changedAt: 'asc' }
  });
}

// 示例输出
[
  {
    fromStatus: 'PENDING',
    toStatus: 'CONFIRMED',
    changedAt: '2024-12-06T10:00:00Z',
    changedBy: 'user-uuid'
  },
  {
    fromStatus: 'CONFIRMED',
    toStatus: 'PREPARING',
    changedAt: '2024-12-06T10:05:00Z',
    changedBy: 'user-uuid'
  },
  {
    fromStatus: 'PREPARING',
    toStatus: 'READY',
    changedAt: '2024-12-06T10:20:00Z',
    changedBy: 'user-uuid'
  }
]
```

---

## 状态变化触发的业务逻辑

```typescript
async function handleStatusChange(
  order: Order,
  newStatus: OrderStatus
) {
  switch (newStatus) {
    case 'CONFIRMED':
      // 订单确认
      await onOrderConfirmed(order);
      break;
      
    case 'PREPARING':
      // 开始制作
      await onOrderPreparing(order);
      break;
      
    case 'READY':
      // 制作完成
      await onOrderReady(order);
      break;
      
    case 'PICKED_UP':
      // 已取餐
      await onOrderPickedUp(order);
      break;
      
    case 'OUT_FOR_DELIVERY':
      // 开始配送
      await onOrderOutForDelivery(order);
      break;
      
    case 'DELIVERED':
      // 已送达
      await onOrderDelivered(order);
      break;
      
    case 'COMPLETED':
      // 订单完成
      await onOrderCompleted(order);
      break;
      
    case 'CANCELLED':
      // 订单取消
      await onOrderCancelled(order);
      break;
  }
}

// 订单完成时的处理
async function onOrderReady(order: Order) {
  // 1. KIOSK 订单：触发叫号
  if (order.orderSource === 'KIOSK') {
    await callNumber(order.pickupNumber, order.pickupName);
    await sendSMS(order.customerPhone, `订单 #${order.pickupNumber} 已完成`);
  }
  
  // 2. 外卖订单：通知平台
  if (isDeliveryOrder(order.orderSource)) {
    await notifyPlatformOrderReady(order);
  }
  
  // 3. WEB 订单：发送通知
  if (order.orderSource === 'WEB') {
    await sendEmail(order.customerEmail, '订单已完成，请来取餐');
  }
  
  // 4. 记录完成时间
  await prisma.order.update({
    where: { id: order.id },
    data: { readyAt: new Date() }
  });
}
```

---

## 数据库 Schema 更新

### 1. 更新 Order 表

```prisma
model Order {
  // ... 现有字段
  
  status            OrderStatus   @default(PENDING)
  
  // 状态时间戳（可选，用于统计）
  confirmedAt       DateTime?     @map("confirmed_at")
  preparingAt       DateTime?     @map("preparing_at")
  readyAt           DateTime?     @map("ready_at")
  pickedUpAt        DateTime?     @map("picked_up_at")
  deliveredAt       DateTime?     @map("delivered_at")
  completedAt       DateTime?     @map("completed_at")
  cancelledAt       DateTime?     @map("cancelled_at")
  
  // 关联
  statusHistory     OrderStatusHistory[]
}
```

### 2. 新增状态枚举

```prisma
enum OrderStatus {
  PENDING              // 待确认
  CONFIRMED            // 已确认
  PREPARING            // 准备中
  READY                // 已完成/待取餐
  PICKED_UP            // 已取餐
  OUT_FOR_DELIVERY     // 配送中
  DELIVERED            // 已送达
  COMPLETED            // 已完成
  CANCELLED            // 已取消
}
```

---

## API 设计

### 1. 更新订单状态

```http
PATCH /api/order/v1/orders/:orderId/status
```

**请求体**:
```json
{
  "status": "READY",
  "reason": "制作完成"
}
```

**响应**:
```json
{
  "success": true,
  "data": {
    "id": "order-uuid",
    "orderNumber": "A6AEE8-POS-20241206-0001",
    "status": "READY",
    "previousStatus": "PREPARING",
    "updatedAt": "2024-12-06T10:20:00Z"
  }
}
```

### 2. 获取状态历史

```http
GET /api/order/v1/orders/:orderId/status-history
```

**响应**:
```json
{
  "success": true,
  "data": [
    {
      "fromStatus": "PENDING",
      "toStatus": "CONFIRMED",
      "changedAt": "2024-12-06T10:00:00Z",
      "changedBy": "user-uuid",
      "reason": null
    },
    {
      "fromStatus": "CONFIRMED",
      "toStatus": "PREPARING",
      "changedAt": "2024-12-06T10:05:00Z",
      "changedBy": "user-uuid",
      "reason": null
    }
  ]
}
```

### 3. 批量更新状态

```http
POST /api/order/v1/orders/batch-status
```

**请求体**:
```json
{
  "orderIds": ["uuid-1", "uuid-2", "uuid-3"],
  "status": "PREPARING"
}
```

---

## 前端集成

### 状态显示

```typescript
const STATUS_DISPLAY = {
  'PENDING': { label: '待确认', color: 'gray', icon: 'clock' },
  'CONFIRMED': { label: '已确认', color: 'blue', icon: 'check' },
  'PREPARING': { label: '制作中', color: 'orange', icon: 'cooking' },
  'READY': { label: '待取餐', color: 'green', icon: 'bell' },
  'PICKED_UP': { label: '已取餐', color: 'green', icon: 'hand' },
  'OUT_FOR_DELIVERY': { label: '配送中', color: 'blue', icon: 'truck' },
  'DELIVERED': { label: '已送达', color: 'green', icon: 'check-circle' },
  'COMPLETED': { label: '已完成', color: 'gray', icon: 'check-double' },
  'CANCELLED': { label: '已取消', color: 'red', icon: 'x' }
};

function OrderStatusBadge({ status }: { status: OrderStatus }) {
  const config = STATUS_DISPLAY[status];
  return (
    <span className={`badge badge-${config.color}`}>
      <Icon name={config.icon} />
      {config.label}
    </span>
  );
}
```

### 状态进度条

```typescript
function OrderProgressBar({ order }: { order: Order }) {
  const steps = getStepsForOrderSource(order.orderSource);
  const currentStep = steps.indexOf(order.status);
  
  return (
    <div className="progress-bar">
      {steps.map((step, index) => (
        <div 
          key={step}
          className={index <= currentStep ? 'active' : 'inactive'}
        >
          {STATUS_DISPLAY[step].label}
        </div>
      ))}
    </div>
  );
}

function getStepsForOrderSource(source: OrderSource): OrderStatus[] {
  switch (source) {
    case 'POS':
      return ['PENDING', 'CONFIRMED', 'PREPARING', 'READY', 'COMPLETED'];
    case 'KIOSK':
      return ['PENDING', 'CONFIRMED', 'PREPARING', 'READY', 'PICKED_UP', 'COMPLETED'];
    case 'UBER_EATS':
      return ['PENDING', 'CONFIRMED', 'PREPARING', 'READY', 'OUT_FOR_DELIVERY', 'DELIVERED', 'COMPLETED'];
    default:
      return ['PENDING', 'CONFIRMED', 'PREPARING', 'READY', 'COMPLETED'];
  }
}
```

---

## 统计分析

### 按状态统计订单

```typescript
async function getOrderStatsByStatus(tenantId: string, date: Date) {
  const stats = await prisma.order.groupBy({
    by: ['status'],
    where: {
      tenantId,
      createdAt: {
        gte: startOfDay(date),
        lte: endOfDay(date)
      }
    },
    _count: true
  });
  
  return stats;
}

// 输出示例
{
  'PENDING': 5,
  'CONFIRMED': 12,
  'PREPARING': 8,
  'READY': 3,
  'COMPLETED': 45,
  'CANCELLED': 2
}
```

### 平均处理时间

```typescript
async function getAverageProcessingTime(tenantId: string) {
  const orders = await prisma.order.findMany({
    where: {
      tenantId,
      status: 'COMPLETED',
      completedAt: { not: null }
    },
    select: {
      createdAt: true,
      completedAt: true
    }
  });
  
  const totalTime = orders.reduce((sum, order) => {
    const duration = order.completedAt.getTime() - order.createdAt.getTime();
    return sum + duration;
  }, 0);
  
  return totalTime / orders.length / 1000 / 60; // 转换为分钟
}
```

---

## 总结

### 优势

1. ✅ **统一的状态模型**，易于理解和维护
2. ✅ **差异化的状态流转**，适应不同业务场景
3. ✅ **完整的状态历史**，可追溯所有变更
4. ✅ **灵活的业务逻辑**，状态变化可触发不同操作
5. ✅ **支持叫号系统**，KIOSK 订单自动叫号
6. ✅ **外卖平台同步**，自动同步状态到第三方平台

### 扩展性

- 易于添加新状态（如 `REFUNDING`、`DELAYED` 等）
- 易于为新的订单来源定义状态流转
- 易于添加新的状态变化触发逻辑

