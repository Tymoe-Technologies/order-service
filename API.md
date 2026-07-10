# Order Service API 文档

## 基础信息

**Base URL**: `/api/order/v1`

**认证**: Bearer Token + `x-organization-id` Header

**通用响应格式**:
```json
{
  "success": true,
  "data": { ... }
}
```

**错误响应格式**:
```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "错误描述"
  }
}
```

## 时间与时区约定

- **所有时间戳字段**（`createdAt`/`scheduledAt`/`completedAt` 等）一律为 **UTC ISO 8601**，
  数据库列为 `timestamp without time zone`，存的就是 UTC 时刻。**不要**按本地时区解读原始值。
- 订单查询的 `startDate` / `endDate` 也必须传 **UTC ISO**。前端应先按门店时区算出当天
  `00:00 ~ 23:59:59.999` 的本地边界，再转成 UTC ISO 传入，避免按 UTC 切天导致夜间订单错位。
- **`storeTimezone`**：订单读取类接口（列表 / 详情 / 顾客订单 / 按 paymentIntent）的响应中，
  每个订单附带门店 IANA 时区字段（如 `"America/Toronto"`）。
  - 来源：order-service「读时解析」自 `Organization.timezone`（auth-service），**不落库、不快照**。
  - 为 `null` 表示 auth-service 尚未配置时区，前端应回退到设备/浏览器本地时区。
  - 前端用它把 UTC 时间戳渲染为门店当地时间（`Intl.DateTimeFormat(locale, { timeZone })`）。

---

# 目录

1. [订单管理 API](#订单管理-api)
2. [订单便签 API](#订单便签-api)
3. [订单来源配置 API](#订单来源配置-api)
4. [打印服务 API](#打印服务-api)
5. [统计分析 API](#统计分析-api)
6. [打印设置 API](#打印设置-api)
7. [票据模板 API](#票据模板-api)
8. [WebSocket 打印队列](#websocket-打印队列)

---

# 订单管理 API

**Base URL**: `/api/order/v1/orders`

## 1. 创建订单

```http
POST /orders
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
      "itemId": "uuid-1",
      "itemName": "宫保鸡丁",
      "quantity": 2,
      "unitPrice": 38.00,
      "discountAmount": 7.60,
      "discountType": "PERCENTAGE",
      "discountValue": 10,
      "discountReason": "会员折扣",
      "attributes": {
        "size": "大份",
        "spiciness": "中辣"
      },
      "modifiers": [
        {
          "optionId": "modifier-001",
          "optionName": "大杯",
          "groupName": "杯型",
          "unitPrice": 2.00,
          "quantity": 1
        }
      ],
      "specialNotes": "少油少盐"
    },
    {
      "itemId": "uuid-2",
      "itemName": "可乐",
      "quantity": 1,
      "unitPrice": 5.00,
      "discountAmount": 5.00,
      "discountType": "FIXED",
      "discountValue": 5.00,
      "discountReason": "赠品"
    }
  ],
  "notes": "尽快出餐",
  
  "taxAmount": 5.00,
  "discountAmount": 10.00,
  "serviceFee": 2.00,
  "deliveryFee": 5.00,
  "platformFee": 3.00,
  "tipAmount": 5.00,
  
  "discountType": "COUPON",
  "discountCode": "SAVE10",
  "discountReason": "新用户优惠",
  
  "paymentMethod": "CARD",
  "transactionId": "txn_1234567890"
}
```

**字段说明**:

**基础信息**:
- `orderType` (必填): `DINE_IN` (堂食) | `TAKEOUT` (自取) | `DELIVERY` (配送)
- `orderSource` (可选): `POS` | `WEB` | `KIOSK`, 默认 `POS`
- `tableNumber` (可选): 桌号,堂食时使用
- `customerName` (可选): 客户姓名
- `customerPhone` (可选): 客户电话
- `items` (必填): 订单商品列表,至少包含1个商品
- `notes` (可选): 订单备注

**商品信息** (items 数组中每个商品的字段):
- `itemId` (必填): 商品 ID
- `itemName` (必填): 商品名称
- `quantity` (必填): 数量
- `unitPrice` (必填): 单价（含修饰符，不含折扣）
- `discountAmount` (可选): 该商品的总折扣金额
- `discountType` (可选): 折扣类型 - `PERCENTAGE` (百分比) | `FIXED` (固定金额)
- `discountValue` (可选): 折扣值（百分比: 10 表示 10%；固定金额: 5.00 表示减 5 元）
- `discountReason` (可选): 折扣原因，如"会员折扣"、"促销活动"、"赠品"等
- `modifiers` (可选): 修饰符列表（如杯型、加料等）
- `attributes` (可选): 商品属性
- `specialNotes` (可选): 商品备注

**费用明细** (所有可选,默认 0):
- `taxAmount` (可选): 税费
- `discountAmount` (可选): **整单折扣金额**（不包含商品折扣，商品折扣在商品级别单独记录）
- `serviceFee` (可选): 服务费
- `deliveryFee` (可选): 配送费
- `platformFee` (可选): 平台费 (外卖平台抽成等)
- `tipAmount` (可选): 小费

**整单折扣明细** (所有可选):
- `discountType` (可选): 整单折扣类型 - `COUPON` (优惠券) | `PROMOTION` (促销) | `MEMBER` (会员折扣) | `MANUAL` (手动折扣)
- `discountCode` (可选): 优惠券/促销代码
- `discountReason` (可选): 整单折扣原因说明

**⚠️ 重要说明**:
- 商品折扣在每个商品的 `discountAmount` 字段中记录
- 订单的 `discountAmount` 只包含整单折扣（在所有商品折扣之后额外的折扣）
- 两种折扣是叠加的，但分别记录在不同字段

**支付信息** (所有可选):
- `paymentMethod` (可选): 支付方式 - `CASH` (现金) | `CARD` (刷卡) | `ALIPAY` (支付宝) | `WECHAT` (微信支付) 等
- `transactionId` (可选): 支付平台交易ID

**响应**:
```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "orderNumber": "A6AEE8-POS-20241106-0001",
    "orderType": "DINE_IN",
    "orderSource": "POS",
    "status": "PENDING",
    "tableNumber": "A-01",
    "customerName": "张三",
    "customerPhone": "13800138000",
    
    "subtotal": 82.00,
    "taxAmount": 5.00,
    "discountAmount": 10.00,
    "serviceFee": 2.00,
    "deliveryFee": 5.00,
    "platformFee": 3.00,
    "tipAmount": 5.00,
    "totalAmount": 92.00,
    
    "discountType": "COUPON",
    "discountCode": "SAVE10",
    "discountReason": "新用户优惠",
    
    "paymentStatus": "UNPAID",
    "paymentMethod": "CARD",
    "transactionId": "txn_1234567890",
    "paidAt": null,
    
    "settlementStatus": "PENDING",
    "settledAt": null,
    "settlementBatch": null,
    
    "orderItems": [
      {
        "id": "item-uuid-1",
        "itemId": "uuid-1",
        "itemName": "宫保鸡丁",
        "quantity": 2,
        "unitPrice": 38.00,
        "discountAmount": 7.60,
        "discountType": "PERCENTAGE",
        "discountValue": 10,
        "discountReason": "会员折扣",
        "totalPrice": 68.40,
        "attributes": { "size": "大份", "spiciness": "中辣" },
        "modifiers": [
          {
            "optionId": "modifier-001",
            "optionName": "大杯",
            "groupName": "杯型",
            "unitPrice": 2.00,
            "quantity": 1
          }
        ],
        "specialNotes": "少油少盐"
      },
      {
        "id": "item-uuid-2",
        "itemId": "uuid-2",
        "itemName": "可乐",
        "quantity": 1,
        "unitPrice": 5.00,
        "discountAmount": 5.00,
        "discountType": "FIXED",
        "discountValue": 5.00,
        "discountReason": "赠品",
        "totalPrice": 0.00,
        "modifiers": null
      }
    ],
    "notes": "尽快出餐",
    "createdBy": "user-uuid",
    "createdAt": "2024-01-01T10:00:00Z",
    "updatedAt": "2024-01-01T10:00:00Z"
  }
}
```

**订单号格式说明**:
- 格式: `{门店代码}-{订单来源}-{日期}-{序号}`
- 示例: `A6AEE8-POS-20241106-0001`
  - `A6AEE8`: 门店代码 (从租户ID提取前6位)
  - `POS`: 订单来源
  - `20241106`: 日期
  - `0001`: 当天序号 (按门店+来源每天重置)

**总金额计算公式**:
```
总金额 = 小计 + 税费 + 服务费 + 配送费 + 平台费 + 小费 - 折扣
totalAmount = subtotal + taxAmount + serviceFee + deliveryFee + platformFee + tipAmount - discountAmount
```

---

## 2. 获取订单列表

```http
GET /orders
GET /orders?status=PENDING
GET /orders?orderSource=POS
GET /orders?startDate=2024-01-01&endDate=2024-01-31
GET /orders?page=1&limit=20
```

**查询参数**:
- `status` (可选): 订单状态筛选
- `orderSource` (可选): 订单来源筛选
- `orderType` (可选): 订单类型筛选
- `startDate` (可选): 开始日期 (ISO 8601)
- `endDate` (可选): 结束日期 (ISO 8601)
- `page` (可选): 页码,默认 1
- `limit` (可选): 每页数量,默认 20

**响应**:
```json
{
  "success": true,
  "data": {
    "orders": [
      {
        "id": "uuid",
        "orderNumber": "A6AEE8-POS-20241106-0001",
        "orderType": "DINE_IN",
        "orderSource": "POS",
        "status": "PENDING",
        "paymentStatus": "UNPAID",
        "tableNumber": "A-01",
        "customerName": "张三",
        "totalAmount": 92.00,
        "createdAt": "2024-01-01T10:00:00Z"
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 20,
      "total": 100,
      "totalPages": 5
    }
  }
}
```

---

## 3. 获取订单详情

```http
GET /orders/:orderId
```

**响应**:
```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "orderNumber": "A6AEE8-POS-20241106-0001",
    "orderType": "DINE_IN",
    "orderSource": "POS",
    "status": "PENDING",
    "tableNumber": "A-01",
    "customerName": "张三",
    "customerPhone": "13800138000",
    
    "subtotal": 82.00,
    "taxAmount": 5.00,
    "discountAmount": 10.00,
    "serviceFee": 2.00,
    "deliveryFee": 5.00,
    "platformFee": 3.00,
    "tipAmount": 5.00,
    "totalAmount": 92.00,
    
    "discountType": "COUPON",
    "discountCode": "SAVE10",
    "discountReason": "新用户优惠",
    
    "paymentStatus": "UNPAID",
    "paymentMethod": "CARD",
    "transactionId": "txn_1234567890",
    "paidAt": null,
    
    "settlementStatus": "PENDING",
    "settledAt": null,
    "settlementBatch": null,
    
    "orderItems": [...],
    "orderNotes": [...],
    "printRecords": [...],
    "createdBy": "user-uuid",
    "createdAt": "2024-01-01T10:00:00Z",
    "updatedAt": "2024-01-01T10:00:00Z"
  }
}
```

---

## 4. 更新订单状态

```http
PATCH /orders/:orderId/status
```

**请求体**:
```json
{
  "status": "CONFIRMED"
}
```

**状态流转**:
```
PENDING → CONFIRMED → PREPARING → READY → COMPLETED
                                      ↓
                                  CANCELLED
```

**可用状态**:
- `PENDING` - 待确认
- `CONFIRMED` - 已确认
- `PREPARING` - 准备中
- `READY` - 已完成
- `COMPLETED` - 已取餐/已送达
- `CANCELLED` - 已取消

**响应**:
```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "status": "CONFIRMED",
    "updatedAt": "2024-01-01T10:05:00Z"
  }
}
```

---

## 5. 取消订单

```http
POST /orders/:orderId/cancel
```

**请求体**:
```json
{
  "reason": "客户要求取消"
}
```

**响应**:
```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "status": "CANCELLED",
    "cancelReason": "客户要求取消",
    "cancelledAt": "2024-01-01T10:10:00Z"
  }
}
```

---

# 订单便签 API

## 1. 添加订单便签

```http
POST /orders/:orderId/notes
```

**请求体**:
```json
{
  "noteType": "KITCHEN",
  "content": "客人对花生过敏,请注意",
  "color": "#FF5252",
  "isPinned": true
}
```

**字段说明**:
- `noteType` (必填): `GENERAL` (普通) | `KITCHEN` (厨房) | `CUSTOMER` (客户) | `INTERNAL` (内部)
- `content` (必填): 便签内容
- `color` (可选): 颜色代码
- `isPinned` (可选): 是否置顶,默认 false

**响应**:
```json
{
  "success": true,
  "data": {
    "id": "note-uuid",
    "orderId": "order-uuid",
    "noteType": "KITCHEN",
    "content": "客人对花生过敏,请注意",
    "color": "#FF5252",
    "isPinned": true,
    "createdBy": "user-uuid",
    "createdAt": "2024-01-01T10:00:00Z"
  }
}
```

---

## 2. 更新订单便签

```http
PUT /orders/:orderId/notes/:noteId
```

**请求体**:
```json
{
  "content": "更新后的内容",
  "color": "#4CAF50",
  "isPinned": false
}
```

---

## 3. 删除订单便签

```http
DELETE /orders/:orderId/notes/:noteId
```

---

## 4. 获取便签模板列表

```http
GET /orders/note-templates
```

**响应**:
```json
{
  "success": true,
  "data": [
    {
      "id": "template-uuid",
      "name": "过敏提醒",
      "content": "客人对{allergen}过敏,请注意",
      "color": "#FF5252",
      "isActive": true
    }
  ]
}
```

---

## 5. 创建便签模板

```http
POST /orders/note-templates
```

**请求体**:
```json
{
  "name": "加急订单",
  "content": "请优先处理",
  "color": "#FF9800"
}
```

---

# 订单来源配置 API

**Base URL**: `/api/order/v1/order-sources`

## 1. 获取订单来源列表

```http
GET /order-sources
```

**响应**:
```json
{
  "success": true,
  "data": [
    {
      "id": "source-uuid",
      "tenantId": "tenant-uuid",
      "sourceType": "POS",
      "sourceName": "POS收银",
      "description": "POS机收银系统",
      "isActive": true,
      "displayOrder": 1,
      "createdAt": "2024-01-01T00:00:00Z"
    },
    {
      "id": "source-uuid-2",
      "sourceType": "KIOSK",
      "sourceName": "自助点餐机",
      "isActive": true,
      "displayOrder": 2
    }
  ]
}
```

---

## 2. 初始化默认订单来源

```http
POST /order-sources/init-defaults
```

**说明**: 为新组织初始化默认的订单来源配置 (POS, KIOSK, WEB)

**响应**:
```json
{
  "success": true,
  "data": {
    "created": 3,
    "sources": [
      { "id": "uuid-1", "sourceType": "POS", "sourceName": "POS收银" },
      { "id": "uuid-2", "sourceType": "KIOSK", "sourceName": "自助点餐机" },
      { "id": "uuid-3", "sourceType": "WEB", "sourceName": "网页点餐" }
    ]
  }
}
```

---

## 3. 创建订单来源

```http
POST /order-sources
```

**请求体**:
```json
{
  "sourceType": "CUSTOM",
  "sourceName": "美团外卖",
  "description": "美团外卖平台订单",
  "displayOrder": 10
}
```

---

## 4. 获取单个订单来源

```http
GET /order-sources/:channelId
```

---

## 5. 更新订单来源

```http
PUT /order-sources/:channelId
```

**请求体**:
```json
{
  "sourceName": "美团外卖 (更新)",
  "description": "美团外卖平台订单 - 已对接",
  "isActive": true,
  "displayOrder": 5
}
```

---

## 6. 删除订单来源

```http
DELETE /order-sources/:channelId
```

---

# 打印服务 API

## 1. 打印订单

```http
POST /orders/:orderId/print
```

**请求体**:
```json
{
  "printType": "RECEIPT",
  "printerName": "Kitchen-Printer-01",
  "copies": 2
}
```

**字段说明**:
- `printType` (必填): `RECEIPT` (小票) | `KITCHEN_TICKET` (厨房单) | `LABEL` (标签)
- `printerName` (可选): 打印机名称
- `copies` (可选): 打印份数,默认 1

**响应**:
```json
{
  "success": true,
  "data": {
    "printRecordId": "record-uuid",
    "orderId": "order-uuid",
    "printType": "RECEIPT",
    "status": "SUCCESS",
    "printedAt": "2024-01-01T10:00:00Z"
  }
}
```

---

## 2. 获取打印记录

```http
GET /orders/:orderId/print-records
```

**响应**:
```json
{
  "success": true,
  "data": [
    {
      "id": "record-uuid",
      "orderId": "order-uuid",
      "printType": "RECEIPT",
      "printerName": "Kitchen-Printer-01",
      "status": "SUCCESS",
      "printedBy": "user-uuid",
      "printedAt": "2024-01-01T10:00:00Z"
    }
  ]
}
```

---

## 3. 生成小票 PDF

```http
GET /orders/:orderId/receipt/pdf
```

**响应**: PDF 文件流

---

# 统计分析 API

**Base URL**: `/api/order/v1/statistics`

> **口径说明**：以下所有接口的 `startDate`/`endDate` 均为**必填**，UTC ISO 8601；营收类指标（revenue/totalAmount 等）**已剔除 CANCELLED 订单**，避免虚增营收；金额字段统一以"元"为单位返回（数据库存储为分）；响应均附带 `storeTimezone`（门店 IANA 时区，供前端切天展示，读时按 UTC 传参）。

## 1. 获取订单统计

```http
GET /statistics/orders?startDate=2024-01-01T00:00:00Z&endDate=2024-01-31T23:59:59Z
```

**查询参数**:
- `startDate` (必填): 开始时间
- `endDate` (必填): 结束时间

**响应**:
```json
{
  "success": true,
  "data": {
    "totalOrders": 1200,
    "totalRevenue": 125000.00,
    "averageOrderValue": 104.17,
    "ordersByStatus": { "COMPLETED": 1200, "CANCELLED": 50 },
    "ordersByType": { "DINE_IN": 700, "TAKEOUT": 400, "DELIVERY": 150 },
    "ordersBySource": { "POS": 800, "KIOSK": 300, "WEB": 150 },
    "storeTimezone": "America/Vancouver"
  }
}
```
`totalOrders`/`totalRevenue`/`averageOrderValue` 已剔除 CANCELLED；`ordersByStatus` 覆盖全部状态（含 CANCELLED，用于计算取消率）。

## 2. 收入报表

```http
GET /statistics/revenue?startDate=...&endDate=...&groupBy=day
GET /statistics/revenue?startDate=...&endDate=...&groupBy=source|type|channel
```

**查询参数**:
- `startDate`/`endDate` (必填)
- `groupBy` (可选，默认 `day`): `day` | `hour` | `source` | `type` | `channel`
  - `hour`：按门店时区把时间范围内所有订单按"一天中第几小时"（0-23）累加，用于看营业高峰时段；门店未配置时区时按 UTC 兜底

**响应**（`groupBy=day` 示例）:
```json
{
  "success": true,
  "data": {
    "storeTimezone": "America/Vancouver",
    "groupBy": "day",
    "rows": [
      { "bucket": "2024-01-01T00:00:00Z", "orderCount": 40, "subtotal": 3500.00,
        "taxAmount": 350.00, "discountAmount": 100.00, "serviceFee": 50.00,
        "deliveryFee": 200.00, "tipAmount": 300.00, "totalAmount": 4300.00 }
    ]
  }
}
```

## 3. 商品/菜品销售分析

```http
GET /statistics/items?startDate=...&endDate=...&page=1&pageSize=20
```

**查询参数**:
- `startDate`/`endDate` (必填)
- `page` (可选，默认1) / `pageSize` (可选，默认20)

**响应**:
```json
{
  "success": true,
  "data": {
    "page": 1, "pageSize": 20, "total": 86,
    "rows": [
      { "itemId": "uuid", "itemName": "招牌牛肉面", "quantity": 320, "totalPrice": 9600.00, "discountAmount": 120.00 }
    ]
  }
}
```
按销售额（`totalPrice`）降序排列，已剔除 CANCELLED 订单的明细。

## 4. 税务汇总报表

```http
GET /statistics/tax?startDate=...&endDate=...&groupBy=day|source|channel
```

**响应**:
```json
{
  "success": true,
  "data": {
    "storeTimezone": "America/Vancouver",
    "groupBy": "day",
    "note": "税额为下单时按商品税率计算后写入订单的汇总值（Order.taxAmount），不含分税率明细拆分；已剔除已取消订单。",
    "rows": [
      { "bucket": "2024-01-01T00:00:00Z", "orderCount": 40, "taxableSales": 3500.00, "taxCollected": 350.00 }
    ]
  }
}
```
> 限制：商品税率来自 item-management 服务，下单时计算后仅落库为订单级 `taxAmount` 汇总值，未保存逐税率明细，因此本报表不能按税率分档展示，仅提供"应税销售额 / 已收税额"汇总口径。

## 5. 对账汇总报表

```http
GET /statistics/reconciliation?startDate=...&endDate=...
```

**响应**:
```json
{
  "success": true,
  "data": {
    "storeTimezone": "America/Vancouver",
    "note": "本报表基于订单自身的支付/结算字段汇总（尚未对接 finance-service 的第三方支付平台结算记录），已取消订单单独列出而非剔除，用于核对取消/退款对营收的影响。",
    "rows": [
      { "paymentMethod": "CARD", "paymentStatus": "PAID", "settlementStatus": "PENDING",
        "orderCount": 300, "totalAmount": 31000.00, "tipAmount": 1800.00 }
    ]
  }
}
```

---

# 打印设置 API

**Base URL**: `/api/order/v1/print-settings`

**说明**: 按票据类型配置打印内容。每个租户每种票据类型只有一条配置记录。POS 端根据配置 JSON 生成打印指令（ESC/POS 或 TSPL），后端只保存配置。

---

## 票据类型

| 票据类型 | 标识 | 协议 | 纸张 | 触发时机 |
|---------|------|------|------|---------|
| 客户收据 | `CUSTOMER_RECEIPT` | ESC/POS | 58/80mm | 结账后 |
| 厨房菜品单 | `KITCHEN_TICKET` | ESC/POS | 80mm | 下单/加菜 |
| 标签贴纸 | `ITEM_LABEL` | TSPL | 40x30mm等 | 下单时 |
| 日结报表 | `DAILY_REPORT` | ESC/POS | 80mm | 日结时 |
| 交接班单 | `SHIFT_REPORT` | ESC/POS | 80mm | 交接班 |

---

## 1. 获取所有打印设置

```http
GET /print-settings
```

**响应**:
```json
{
  "success": true,
  "data": [
    {
      "id": "uuid",
      "tenantId": "tenant-uuid",
      "ticketType": "CUSTOMER_RECEIPT",
      "isEnabled": true,
      "copies": 1,
      "config": { ... },
      "version": 1,
      "createdBy": "user-uuid",
      "createdAt": "2024-01-01T00:00:00Z",
      "updatedAt": "2024-01-01T00:00:00Z"
    }
  ]
}
```

---

## 2. 获取某种票据类型的设置

```http
GET /print-settings/:ticketType
```

**参数**:
- `ticketType`: `CUSTOMER_RECEIPT` | `KITCHEN_TICKET` | `ITEM_LABEL` | `DAILY_REPORT` | `SHIFT_REPORT`

---

## 3. 更新打印设置

```http
PUT /print-settings/:ticketType
```

**请求体**:
```json
{
  "isEnabled": true,
  "copies": 2,
  "config": {
    "paperWidth": 80,
    "language": "zh-CN",
    "sections": { ... }
  }
}
```

**说明**: 更新后 `version` 自动 +1，用于 POS 同步。

---

## 4. 启用/禁用票据类型

```http
PATCH /print-settings/:ticketType/toggle
```

---

## 5. 检查版本号（POS 同步用）

```http
GET /print-settings/check-version?versions=CUSTOMER_RECEIPT:3,KITCHEN_TICKET:2
```

**响应**:
```json
{
  "success": true,
  "data": {
    "hasUpdates": true,
    "versions": {
      "CUSTOMER_RECEIPT": { "version": 4, "needsUpdate": true },
      "KITCHEN_TICKET": { "version": 2, "needsUpdate": false }
    }
  }
}
```

---

## 6. 初始化默认打印设置

```http
POST /print-settings/initialize
```

**说明**: 为新租户初始化所有 5 种票据类型的默认配置。已存在的不会覆盖。

---

## 7. 获取票据类型元信息

```http
GET /print-settings/meta
```

**响应**:
```json
{
  "success": true,
  "data": [
    {
      "ticketType": "CUSTOMER_RECEIPT",
      "name": "客户收据",
      "protocol": "ESCPOS",
      "defaultCopies": 1,
      "defaultEnabled": true
    }
  ]
}
```

---

## 配置 JSON 结构

### 客户收据 (CUSTOMER_RECEIPT)

```json
{
  "paperWidth": 80,
  "language": "zh-CN",
  "sections": {
    "storeInfo": { "showName": true, "showAddress": true, "showPhone": true, "showLogo": false },
    "orderInfo": { "showOrderNumber": true, "showOrderType": true, "showTableNumber": true, "showTime": true, "showCustomerName": false, "showCustomerPhone": false, "showCashier": false },
    "items": { "showAttributes": true, "showModifiers": true, "showItemNotes": true, "showUnitPrice": true },
    "amounts": { "showSubtotal": true, "showDiscount": true, "showTax": true, "showServiceFee": false, "showDeliveryFee": false, "showTip": false },
    "payment": { "showPaymentMethod": true, "showPaymentTime": true, "showTransactionId": false, "showCashDetail": true },
    "footer": { "showQrCode": false, "qrCodeUrl": "", "customMessage": { "zh-CN": "感谢惠顾", "en": "Thank you!", "zh-TW": "感謝惠顧" }, "showOrderNotes": true }
  }
}
```

### 厨房菜品单 (KITCHEN_TICKET)

```json
{
  "paperWidth": 80,
  "language": "zh-CN",
  "sections": {
    "header": { "showOrderNumber": true, "showOrderType": true, "showTableNumber": true, "showTime": true, "showCustomerName": false },
    "items": { "showAttributes": true, "showModifiers": true, "showItemNotes": true, "fontSize": "large" },
    "footer": { "showOrderNotes": true }
  }
}
```

### 标签贴纸 (ITEM_LABEL)

配置标签纸张尺寸、显示内容和打印样式。标签用于饮品杯贴、商品贴纸等场景，打印协议使用 TSPL（热敏打印机标准）。

**纸张规格示例**:
- 40mm × 30mm (常见咖啡杯贴)
- 50mm × 30mm
- 60mm × 40mm

```json
{
  "labelWidth": 40,          // mm，常见: 40/50/60
  "labelHeight": 30,         // mm，常见: 30/40
  "labelGap": 2,             // mm，标签间距
  "language": "zh-CN",

  // 内容显示开关
  "sections": {
    "showItemName": true,         // 商品名称（核心字段，建议始终开启）
    "showAttributes": true,       // 商品属性（如"大杯"、"冷"等）
    "showModifiers": true,        // 修饰项/自定义选项（如"少糖"、"去冰"）
    "showSpecialNotes": true,     // 特殊备注（如"不要泡沫"）
    "showCupIndex": true,         // 第几杯，用 itemIndex/totalItems 表示 (1/3)
    "showOrderNumber": true,      // 订单号
    "showCustomerName": false,    // 顾客姓名
    "showTableNumber": false,     // 桌号
    "showTimestamp": false,       // 时间戳
    "showQrCode": false           // 二维码
  },

  // 样式配置
  "style": {
    "itemNameFontSize": "large",   // 商品名称字号: small | medium | large
    "modifierFontSize": "small",   // 修饰项字号: small | medium | large
    "bold": true,                  // 是否加粗
    "printDensity": "normal"       // 打印浓度: light | normal | dark
  }
}
```

**字段说明**:

| 字段 | 类型 | 说明 |
|------|------|------|
| `labelWidth` | number | 标签宽度（mm） |
| `labelHeight` | number | 标签高度（mm） |
| `labelGap` | number | 标签间距（mm，用于批量打印） |
| `language` | string | 多语言支持，目前支持 `zh-CN` `en` |
| `sections.showItemName` | boolean | 显示商品名称（建议始终开启） |
| `sections.showAttributes` | boolean | 显示商品属性（如杯型、温度） |
| `sections.showModifiers` | boolean | 显示修饰项/自定义选项 |
| `sections.showSpecialNotes` | boolean | 显示商品特殊备注 |
| `sections.showCupIndex` | boolean | 显示杯数（如 1/3，表示3杯中的第1杯） |
| `sections.showOrderNumber` | boolean | 显示订单号（便于人工查找） |
| `sections.showCustomerName` | boolean | 显示顾客名字 |
| `sections.showTableNumber` | boolean | 显示桌号（堂食场景） |
| `sections.showTimestamp` | boolean | 显示订单创建时间 |
| `sections.showQrCode` | boolean | 显示订单二维码（待支持） |
| `style.itemNameFontSize` | string | 商品名称字号：`small` \| `medium` \| `large` |
| `style.modifierFontSize` | string | 修饰项字号：`small` \| `medium` \| `large` |
| `style.bold` | boolean | 是否加粗显示 |
| `style.printDensity` | string | 打印浓度控制：`light` \| `normal` \| `dark` |

**打印 Payload 示例**:

当 POS 创建订单时，系统会根据配置生成打印任务。ITEM_LABEL 任务的 payload 格式如下：

```json
{
  "labelData": {
    "itemName": "拿铁",
    "itemIndex": 1,            // 当前是第几杯
    "totalItems": 2,           // 该商品共几杯
    "attributes": ["大杯", "热"],
    "modifiers": ["少糖", "燕麦奶"],
    "notes": "不要泡沫",
    "orderNumber": "ORD-20241201-001"
  },
  "paperConfig": {
    "labelWidth": 40,
    "labelHeight": 30,
    "labelGap": 2,
    "style": {
      "itemNameFontSize": "large",
      "modifierFontSize": "small",
      "bold": true,
      "printDensity": "normal"
    }
  }
}
```

**说明**:
- `labelData`: 实际标签内容，根据 `sections` 开关决定是否包含某个字段
- `paperConfig`: 纸张和样式配置，供 POS 端渲染 TSPL 指令时使用

### 日结报表 (DAILY_REPORT)

```json
{
  "paperWidth": 80,
  "language": "zh-CN",
  "sections": {
    "showOrderSummary": true,
    "showRevenueBreakdown": true,
    "showPaymentBreakdown": true,
    "showRefundSummary": true,
    "showTopItems": true,
    "topItemsCount": 10,
    "showCategoryBreakdown": false
  }
}
```

### 交接班单 (SHIFT_REPORT)

```json
{
  "paperWidth": 80,
  "language": "zh-CN",
  "sections": {
    "showCashierInfo": true,
    "showShiftTime": true,
    "showOrderSummary": true,
    "showRevenueBreakdown": true,
    "showPaymentBreakdown": true,
    "showCashDrawer": true
  }
}
```

---

## POS 同步机制

Portal 修改配置 → version+1 → POS 定时轮询 check-version → 发现更新 → 拉取最新配置 → 本地缓存

---

# 错误码参考

## 通用错误码

| 状态码 | 错误码 | 说明 |
|--------|--------|------|
| 400 | VALIDATION_ERROR | 请求参数验证失败 |
| 401 | UNAUTHORIZED | 未授权,Token无效或过期 |
| 403 | FORBIDDEN | 无权限访问该资源 |
| 404 | NOT_FOUND | 请求的资源不存在 |
| 409 | CONFLICT | 资源冲突 |
| 429 | RATE_LIMIT_EXCEEDED | 请求频率超限 |
| 500 | INTERNAL_SERVER_ERROR | 服务器内部错误 |

## 订单相关错误码

| 状态码 | 错误码 | 说明 |
|--------|--------|------|
| 400 | INVALID_ORDER_TYPE | 无效的订单类型 |
| 400 | INVALID_ORDER_SOURCE | 无效的订单来源 |
| 400 | INVALID_ORDER_STATUS | 无效的订单状态 |
| 400 | INVALID_STATUS_TRANSITION | 订单状态流转不合法 |
| 400 | EMPTY_ORDER_ITEMS | 订单商品列表不能为空 |
| 400 | INVALID_ITEM_QUANTITY | 商品数量必须大于0 |
| 400 | INVALID_PRICE | 价格不能为负数 |
| 404 | ORDER_NOT_FOUND | 订单不存在 |
| 409 | ORDER_ALREADY_CANCELLED | 订单已被取消 |
| 409 | ORDER_ALREADY_COMPLETED | 订单已完成 |

## 便签相关错误码

| 状态码 | 错误码 | 说明 |
|--------|--------|------|
| 400 | INVALID_NOTE_TYPE | 无效的便签类型 |
| 404 | NOTE_NOT_FOUND | 便签不存在 |
| 404 | NOTE_TEMPLATE_NOT_FOUND | 便签模板不存在 |

## 打印相关错误码

| 状态码 | 错误码 | 说明 |
|--------|--------|------|
| 400 | INVALID_PRINT_TYPE | 无效的打印类型 |
| 404 | PRINTER_NOT_FOUND | 打印机不存在 |
| 500 | PRINT_FAILED | 打印失败 |

## 打印设置相关错误码

| 状态码 | 错误码 | 说明 |
|--------|--------|------|
| 400 | INVALID_TICKET_TYPE | 无效的票据类型 |
| 404 | PRINT_SETTING_NOT_FOUND | 打印设置不存在，需先初始化 |

---

# 附录

## 订单状态说明

| 状态 | 说明 | 可流转到 |
|------|------|---------|
| PENDING | 待确认 | CONFIRMED, CANCELLED |
| CONFIRMED | 已确认 | PREPARING, CANCELLED |
| PREPARING | 准备中 | READY, CANCELLED |
| READY | 已完成 | COMPLETED, CANCELLED |
| COMPLETED | 已取餐/已送达 | - |
| CANCELLED | 已取消 | - |

## 订单类型说明

| 类型 | 说明 | 使用场景 |
|------|------|---------|
| DINE_IN | 堂食 | 客人在店内用餐,需要桌号 |
| TAKEOUT | 自取/打包 | 客人点餐后自取,或打包带走 |
| DELIVERY | 配送 | 外卖配送到客户地址 |

## 支付状态说明

| 状态 | 说明 | 适用场景 |
|------|------|---------|
| UNPAID | 未支付 | 订单创建时的默认状态 |
| PAID | 已支付 | 支付成功 |
| PARTIALLY_PAID | 部分支付 | 订单部分金额已支付 |
| REFUNDING | 退款中 | 正在处理退款 |
| REFUNDED | 已退款 | 退款完成 |
| FAILED | 支付失败 | 支付过程中出现错误 |

## 结算状态说明

| 状态 | 说明 | 适用场景 |
|------|------|---------|
| PENDING | 待结算 | 订单创建时的默认状态 |
| PROCESSING | 结算中 | 正在处理结算 |
| SETTLED | 已结算 | 结算完成 |
| FAILED | 结算失败 | 结算过程出现错误 |

## 订单来源说明

| 来源 | 说明 | 特点 |
|------|------|------|
| POS | POS机 | 员工操作,完整信息,支持所有订单类型 |
| KIOSK | 自助点餐机 | 客户自助,显示取餐号,通常为TAKEOUT |
| WEB | 网页点餐 | 在线下单,支持预约时间 |

## 便签类型说明

| 类型 | 说明 | 使用场景 |
|------|------|---------|
| GENERAL | 普通 | 一般性备注 |
| KITCHEN | 厨房 | 厨房制作注意事项(如过敏信息) |
| CUSTOMER | 客户 | 客户特殊要求 |
| INTERNAL | 内部 | 员工内部沟通 |

## 打印类型说明

| 类型 | 说明 | 协议 | 内容 |
|------|------|------|------|
| RECEIPT | 客户收据 | ESC/POS | 完整订单信息,给客户 |
| KITCHEN_TICKET | 厨房菜品单 | ESC/POS | 简化信息,给厨房制作 |
| LABEL | 标签贴纸 | TSPL | 商品标签,贴在外带盒上 |
| DAILY_REPORT | 日结报表 | ESC/POS | 每日营业数据汇总 |
| SHIFT_REPORT | 交接班单 | ESC/POS | 交接班营业数据汇总 |

## 商品折扣说明

### 折扣类型

| 类型 | 说明 | 计算公式 | 示例 |
|------|------|---------|------|
| PERCENTAGE | 百分比折扣 | `discountAmount = unitPrice × quantity × (discountValue / 100)` | 10% 折扣: `discountValue = 10` |
| FIXED | 固定金额折扣 | `discountAmount = min(discountValue × quantity, unitPrice × quantity)` | 减5元: `discountValue = 5.00` |

### 计算规则

**商品总价计算**:
```
商品总价 = (unitPrice × quantity) - discountAmount
```

**订单小计计算**:
```
subtotal = Σ(所有商品的总价)
```

**订单总金额计算**:
```
totalAmount = subtotal + taxAmount + serviceFee + deliveryFee + platformFee + tipAmount - discountAmount
```

**注意**:
- 商品 `unitPrice`: 包含修饰符价格，不包含折扣
- 商品 `totalPrice`: `unitPrice × quantity - discountAmount`（扣除商品折扣后的价格）
- 订单 `subtotal`: Σ(所有商品的 `totalPrice`)（已包含商品折扣的影响）
- 订单 `discountAmount`: **只包含整单折扣**，不包含商品折扣
- 订单 `totalAmount`: `subtotal + taxAmount + serviceFee + ... - discountAmount`

### 使用示例

#### 示例 1: 百分比折扣 (会员折扣)

商品: 珍珠奶茶 × 2，单价 15.00，会员 9 折

```json
{
  "itemId": "milk-tea-001",
  "itemName": "珍珠奶茶",
  "quantity": 2,
  "unitPrice": 15.00,
  "discountType": "PERCENTAGE",
  "discountValue": 10,  // 10% 折扣
  "discountAmount": 3.00,  // 15 × 2 × 10% = 3.00
  "discountReason": "会员折扣"
}
```

最终价格: `15 × 2 - 3 = 27.00`

#### 示例 2: 固定金额折扣 (赠品)

商品: 可乐 × 1，单价 5.00，免费赠送

```json
{
  "itemId": "coke-001",
  "itemName": "可乐",
  "quantity": 1,
  "unitPrice": 5.00,
  "discountType": "FIXED",
  "discountValue": 5.00,
  "discountAmount": 5.00,
  "discountReason": "赠品"
}
```

最终价格: `5 - 5 = 0.00`

#### 示例 3: 混合折扣 (商品折扣 + 整单折扣)

两个商品有各自的折扣，整单再减 5 元：

```json
{
  "items": [
    {
      "itemName": "宫保鸡丁",
      "quantity": 2,
      "unitPrice": 38.00,
      "discountAmount": 7.60,  // 商品级折扣 (10%)
      "discountType": "PERCENTAGE",
      "discountValue": 10
    },
    {
      "itemName": "可乐",
      "quantity": 1,
      "unitPrice": 5.00,
      "discountAmount": 5.00,  // 商品级折扣 (全免)
      "discountType": "FIXED",
      "discountValue": 5.00
    }
  ],
  "taxAmount": 0,
  "discountAmount": 5.00,  // ⚠️ 只包含整单折扣（不包含商品折扣 7.60 + 5.00）
  "discountType": "MANUAL",
  "discountReason": "新用户优惠"
}
```

**计算过程**:
1. **商品 1 总价**: `38 × 2 - 7.60 = 68.40`
2. **商品 2 总价**: `5 × 1 - 5.00 = 0.00`
3. **小计 (subtotal)**: `68.40 + 0.00 = 68.40`（已扣除商品折扣）
4. **订单总金额**: `68.40 + 0（税费）- 5.00（整单折扣）= 63.40`

**折扣记录**:
- 商品折扣总计: `7.60 + 5.00 = 12.60`（记录在各商品的 `discountAmount`）
- 整单折扣: `5.00`（记录在订单的 `discountAmount`）
- 总折扣: `12.60 + 5.00 = 17.60`

**数据库保存**:
```json
{
  "subtotal": 68.40,        // 已扣除商品折扣
  "discountAmount": 5.00,   // 只包含整单折扣
  "totalAmount": 63.40,
  "orderItems": [
    {
      "unitPrice": 38.00,
      "quantity": 2,
      "discountAmount": 7.60,  // 商品折扣单独记录
      "totalPrice": 68.40
    },
    {
      "unitPrice": 5.00,
      "quantity": 1,
      "discountAmount": 5.00,  // 商品折扣单独记录
      "totalPrice": 0.00
    }
  ]
}
```

---

# WebSocket 打印队列

**端点**: `ws://localhost:3002/ws/print-queue`

**说明**: 基于 `ws` 库实现的 WebSocket 服务，用于将打印任务实时推送到 POS 设备。订单创建时根据租户的 PrintSetting 配置自动生成 PrintTask，通过 WebSocket 推送给已连接的设备。

---

## 连接与认证

POS 设备通过 WebSocket 连接后，需先发送 `REGISTER` 消息注册设备身份。

---

## 数据模型 - PrintTask

| 字段 | 类型 | 说明 |
|------|------|------|
| id | UUID | 打印任务ID |
| tenantId | UUID | 租户ID |
| orderId | UUID | 关联订单ID |
| ticketType | String | 票据类型（CUSTOMER_RECEIPT, KITCHEN_TICKET 等） |
| status | Enum | 任务状态 |
| deviceId | String | 目标设备ID |
| payload | JSON | 打印数据 |
| createdAt | DateTime | 创建时间 |
| sentAt | DateTime | 发送时间 |
| completedAt | DateTime | 完成时间 |

**PrintTask 状态流转**:
```
PENDING → SENT → RECEIVED → COMPLETED
                          → FAILED
```

- `PENDING` - 等待推送（设备不在线时）
- `SENT` - 已推送到设备
- `RECEIVED` - 设备已确认接收
- `COMPLETED` - 打印完成
- `FAILED` - 打印失败

---

## 消息协议

### 客户端 → 服务端

#### REGISTER - 设备注册
```json
{
  "type": "REGISTER",
  "deviceId": "pos-001",
  "tenantId": "tenant-uuid"
}
```

#### TASK_ACK - 确认接收打印任务
```json
{
  "type": "TASK_ACK",
  "taskId": "task-uuid"
}
```

#### TASK_RESULT - 报告打印结果
```json
{
  "type": "TASK_RESULT",
  "taskId": "task-uuid",
  "success": true,
  "error": null
}
```

#### FETCH_PENDING - 请求未完成的打印任务
```json
{
  "type": "FETCH_PENDING"
}
```

#### PING - 心跳
```json
{
  "type": "PING"
}
```

### 服务端 → 客户端

#### REGISTER_ACK - 注册确认
```json
{
  "type": "REGISTER_ACK",
  "success": true,
  "deviceId": "pos-001"
}
```

#### PRINT_TASK - 推送打印任务
```json
{
  "type": "PRINT_TASK",
  "taskId": "task-uuid",
  "orderId": "order-uuid",
  "ticketType": "CUSTOMER_RECEIPT",
  "payload": { ... }
}
```

#### PENDING_TASKS - 返回待处理任务列表
```json
{
  "type": "PENDING_TASKS",
  "tasks": [
    {
      "taskId": "task-uuid",
      "orderId": "order-uuid",
      "ticketType": "KITCHEN_TICKET",
      "payload": { ... }
    }
  ]
}
```

#### PONG - 心跳响应
```json
{
  "type": "PONG"
}
```

---

## 工作流程

1. POS 设备连接 WebSocket 并发送 `REGISTER`
2. 服务端验证后返回 `REGISTER_ACK`
3. 设备发送 `FETCH_PENDING` 拉取离线期间积压的任务
4. 当新订单创建时，系统根据 PrintSetting 自动生成 PrintTask
5. 如果目标设备在线，立即通过 `PRINT_TASK` 推送
6. 如果设备不在线，任务保持 `PENDING` 状态，等待设备重连后拉取
7. 设备收到任务后回复 `TASK_ACK`，打印完成后回复 `TASK_RESULT`

---

# 更新日志

## v1.5.0 (2026-02-24)
- **新增**: WebSocket 打印队列系统
  - WebSocket 端点 `ws://localhost:3002/ws/print-queue`
  - 新增 Prisma 模型 `PrintTask`，支持状态跟踪（PENDING → SENT → RECEIVED → COMPLETED/FAILED）
  - 订单创建时根据租户 PrintSetting 自动生成打印任务
  - 实时推送打印任务到已连接的 POS 设备
  - 设备离线时任务排队，重连后自动拉取
  - 完整的消息协议：REGISTER, PRINT_TASK, TASK_ACK, TASK_RESULT, FETCH_PENDING 等

## v1.4.0 (2026-02-24)
- 🎉 **新增**: 票据模板 Logo 上传功能
  - 支持票据模板 Logo 图片上传到 Cloudinary 云存储
  - 支持 JPG、PNG、WebP 格式，最大 5MB
  - 自动图片优化和格式转换
  - 覆盖策略：新上传自动替换旧图片
  - 新增 API 端点：
    - `GET /receipt-templates` - 获取所有票据模板
    - `GET /receipt-templates/:id` - 获取单个票据模板
    - `POST /receipt-templates/:id/logo` - 上传票据 Logo
    - `DELETE /receipt-templates/:id/logo` - 删除票据 Logo
- 🎉 **新增**: 打印设置 Logo 上传功能
  - 支持打印设置全局 Logo 上传到 Cloudinary 云存储（租户级别）
  - 用于打印收据时显示店铺 Logo
  - 新增 API 端点：
    - `POST /print-settings/logo` - 上传打印设置 Logo
    - `DELETE /print-settings/logo` - 删除打印设置 Logo
- 📝 **数据库**: ReceiptTemplate 模型新增 `logoUrl` 字段

## v1.3.0 (2026-02-23)
- 🎉 **新增**: 打印设置系统 - 按票据类型配置打印内容
  - 支持 5 种票据类型: 客户收据、厨房菜品单、标签贴纸、日结报表、交接班单
  - 版本号同步机制，支持 Portal 到 POS 的配置同步
  - 初始化默认配置功能
- 🗑️ **移除**: 旧的小票模板系统 (receipt-templates)
  - 移除样式选择、Logo 上传等功能
  - 新系统使用固定样式 + 可配置内容的方式

## v1.2.0 (2024-11-06)
- 🎉 **新增**: 商品级别折扣功能
  - 支持单个商品的百分比折扣和固定金额折扣
  - 添加 `discountAmount`、`discountType`、`discountValue`、`discountReason` 字段
  - 支持商品折扣与整单折扣混合使用
- 🎉 **新增**: 修饰符架构升级 (从 addons 升级为 modifiers)
  - 支持修饰符数量控制
  - 更灵活的修饰符定价机制
- 📝 **优化**: 价格计算逻辑优化，支持复杂折扣场景

## v1.1.0 (2024-11-06)
- 🎉 **新增**: 订单号优化 - 包含门店代码和订单来源
- 🎉 **新增**: 支付信息字段 (支付状态、支付方式、交易ID)
- 🎉 **新增**: 详细费用字段 (税费、服务费、配送费、平台费、小费)
- 🎉 **新增**: 折扣明细字段 (折扣类型、优惠码、折扣原因)
- 🎉 **新增**: 对账信息字段 (结算状态、结算时间、结算批次)
- 📝 **优化**: 总金额计算公式更新

## v1.0.0 (2024-01-01)
- 初始版本
- 订单管理基础功能
- 订单便签功能
- 订单来源配置
- 打印服务
- 统计分析
- 小票模板系统（已在 v1.3.0 中替换为打印设置系统）

---

## 7. 上传打印设置 Logo

```http
POST /print-settings/logo
```

**认证**: Required (Bearer Token)

**请求头**:
```
Content-Type: multipart/form-data
```

**请求体**:
```
image: File (图片文件)
```

**支持的图片格式**:
- JPG/JPEG
- PNG
- WebP

**文件大小限制**: 5MB

**说明**: 上传租户级别的打印 Logo（用于打印设置的店铺Logo），上传后会自动覆盖旧图片。

**响应**:
```json
{
  "success": true,
  "data": {
    "url": "https://res.cloudinary.com/xxx/image/upload/v1234567890/tymoe/print-settings/tenant-id/logo.jpg"
  }
}
```

**错误响应**:

文件未上传:
```json
{
  "success": false,
  "error": {
    "code": "FILE_MISSING",
    "message": "请上传图片文件"
  }
}
```

不支持的文件格式:
```json
{
  "success": false,
  "error": {
    "code": "INVALID_FILE_TYPE",
    "message": "不支持的图片格式",
    "allowedFormats": ["JPG", "PNG", "WebP"]
  }
}
```

文件过大:
```json
{
  "success": false,
  "error": {
    "code": "FILE_TOO_LARGE",
    "message": "图片文件过大",
    "maxSize": "5MB",
    "actualSize": "6.24MB"
  }
}
```

---

## 8. 删除打印设置 Logo

```http
DELETE /print-settings/logo
```

**认证**: Required (Bearer Token)

**响应**:
```json
{
  "success": true,
  "data": {
    "message": "Logo 删除成功"
  }
}
```

---

# 票据模板 API

**Base URL**: `/api/order/v1/receipt-templates`

**说明**: 管理票据模板，包括模板的 CRUD 操作和 Logo 图片上传功能。

---

## 1. 获取所有票据模板

```http
GET /receipt-templates
```

**认证**: Required (Bearer Token)

**响应**:
```json
{
  "success": true,
  "data": [
    {
      "id": "template-uuid",
      "tenantId": "tenant-uuid",
      "name": "标准收据模板",
      "description": "适用于POS系统的标准收据",
      "paperWidth": 80,
      "isDefault": true,
      "isActive": true,
      "logoUrl": "https://res.cloudinary.com/xxx/image/upload/v1234567890/tymoe/receipts/tenant-id/template-id.jpg",
      "config": {
        "header": {
          "showLogo": true,
          "showStoreName": true,
          "showAddress": true
        },
        "body": {
          "showItemDetails": true,
          "showModifiers": true
        },
        "footer": {
          "showThankYou": true,
          "customMessage": "感谢您的光临！"
        }
      },
      "version": 1,
      "orderSource": "POS",
      "createdBy": "user-uuid",
      "createdAt": "2024-01-01T10:00:00Z",
      "updatedAt": "2024-01-01T10:00:00Z"
    }
  ]
}
```

---

## 2. 获取单个票据模板

```http
GET /receipt-templates/:id
```

**认证**: Required (Bearer Token)

**路径参数**:
- `id` (必需): 票据模板 ID

**响应**:
```json
{
  "success": true,
  "data": {
    "id": "template-uuid",
    "tenantId": "tenant-uuid",
    "name": "标准收据模板",
    "description": "适用于POS系统的标准收据",
    "paperWidth": 80,
    "isDefault": true,
    "isActive": true,
    "logoUrl": "https://res.cloudinary.com/xxx/image/upload/v1234567890/tymoe/receipts/tenant-id/template-id.jpg",
    "config": { ... },
    "version": 1,
    "orderSource": "POS",
    "createdBy": "user-uuid",
    "createdAt": "2024-01-01T10:00:00Z",
    "updatedAt": "2024-01-01T10:00:00Z"
  }
}
```

**错误响应**:
```json
{
  "error": "票据模板不存在"
}
```

---

## 3. 上传票据模板 Logo

```http
POST /receipt-templates/:id/logo
```

**认证**: Required (Bearer Token)

**路径参数**:
- `id` (必需): 票据模板 ID

**请求头**:
```
Content-Type: multipart/form-data
```

**请求体**:
```
logo: File (图片文件)
```

**支持的图片格式**:
- JPG/JPEG
- PNG
- WebP

**文件大小限制**: 5MB

**覆盖策略**: 同一票据模板上传新 Logo 会自动替换旧 Logo（无需手动删除旧图片）

**响应**:
```json
{
  "message": "Logo 上传成功",
  "template": {
    "id": "template-uuid",
    "tenantId": "tenant-uuid",
    "name": "标准收据模板",
    "logoUrl": "https://res.cloudinary.com/xxx/image/upload/v1234567890/tymoe/receipts/tenant-id/template-id.jpg",
    "updatedAt": "2024-01-01T10:00:00Z"
  },
  "logo": {
    "url": "https://res.cloudinary.com/xxx/image/upload/v1234567890/tymoe/receipts/tenant-id/template-id.jpg",
    "publicId": "tymoe/receipts/tenant-id/template-id"
  }
}
```

**错误响应**:

文件未上传:
```json
{
  "error": "请上传 logo 文件"
}
```

不支持的文件格式:
```json
{
  "error": "不支持的图片格式",
  "allowedFormats": ["JPG", "PNG", "WebP"]
}
```

文件过大:
```json
{
  "error": "图片文件过大",
  "maxSize": "5MB",
  "actualSize": "6.24MB"
}
```

票据模板不存在:
```json
{
  "error": "票据模板不存在"
}
```

Cloudinary 未配置:
```json
{
  "error": "Cloudinary 服务未配置，请联系管理员"
}
```

---

## 4. 删除票据模板 Logo

```http
DELETE /receipt-templates/:id/logo
```

**认证**: Required (Bearer Token)

**路径参数**:
- `id` (必需): 票据模板 ID

**响应**:
```json
{
  "message": "Logo 删除成功",
  "template": {
    "id": "template-uuid",
    "tenantId": "tenant-uuid",
    "name": "标准收据模板",
    "logoUrl": null,
    "updatedAt": "2024-01-01T10:00:00Z"
  }
}
```

**错误响应**:

票据模板不存在:
```json
{
  "error": "票据模板不存在"
}
```

没有 Logo:
```json
{
  "message": "票据模板没有 logo"
}
```

---

## 使用示例

### 使用 cURL 上传 Logo

```bash
# 上传票据 Logo
curl -X POST \
  https://api.example.com/api/order/v1/receipt-templates/template-uuid/logo \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'x-organization-id: YOUR_TENANT_ID' \
  -F 'logo=@/path/to/logo.png'
```

### 使用 JavaScript/Fetch 上传 Logo

```javascript
const formData = new FormData();
formData.append('logo', logoFile); // logoFile 是 File 对象

const response = await fetch(`/api/order/v1/receipt-templates/${templateId}/logo`, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`,
    'x-organization-id': tenantId
  },
  body: formData
});

const result = await response.json();
console.log('Logo URL:', result.logo.url);
```

### 使用 Axios 上传 Logo

```javascript
const formData = new FormData();
formData.append('logo', logoFile);

const response = await axios.post(
  `/api/order/v1/receipt-templates/${templateId}/logo`,
  formData,
  {
    headers: {
      'Authorization': `Bearer ${token}`,
      'x-organization-id': tenantId,
      'Content-Type': 'multipart/form-data'
    }
  }
);

console.log('Logo URL:', response.data.logo.url);
```

---

## 环境配置

票据 Logo 上传功能需要配置 Cloudinary 云存储服务。

在 `.env` 文件中添加以下配置：

```env
# Cloudinary Configuration
CLOUDINARY_CLOUD_NAME=your-cloud-name
CLOUDINARY_API_KEY=your-api-key
CLOUDINARY_API_SECRET=your-api-secret
```

**获取 Cloudinary 凭证**:
1. 访问 [https://cloudinary.com](https://cloudinary.com)
2. 注册/登录账号
3. 在 Dashboard 中获取 Cloud Name、API Key 和 API Secret

---

# 现金支付 API

## 创建现金支付订单

现金支付主要用于 POS 订单，系统会自动计算找零。

**请求示例**:
```json
{
  "orderType": "DINE_IN",
  "orderSource": "POS",
  "items": [...],
  "totalAmount": 41.04,
  "paymentMethod": "CASH",
  "cashReceived": 50.00
}
```

**响应**:
```json
{
  "success": true,
  "data": {
    "orderNumber": "A6AEE8-POS-20241206-0001",
    "paymentStatus": "PAID",
    "cashReceived": 50.00,
    "changeGiven": 8.96
  }
}
```

**详细文档**: 查看 [CASH-PAYMENT.md](./CASH-PAYMENT.md)

