# 商家在线点单配置模块

## 概述

在 Order Service 中添加了商家在线点单配置功能,支持通过子域名识别商家并获取相应的订单配置。

## 数据库迁移

### 1. 生成 Prisma Client

```bash
cd /Users/meng/Desktop/CODE/Reall/reall-order-service
npm run prisma:generate
```

### 2. 创建数据库迁移

```bash
npm run prisma:migrate
# 输入迁移名称: add_merchant_online_order_config
```

### 3. 手动执行 SQL (如果需要)

```sql
-- 创建商家在线点单配置表
CREATE TABLE merchant_online_order_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id UUID UNIQUE NOT NULL,
  subdomain VARCHAR(50) UNIQUE NOT NULL,
  enabled BOOLEAN DEFAULT TRUE,
  
  -- 订单类型配置
  allow_pickup BOOLEAN DEFAULT TRUE,
  allow_dine_in BOOLEAN DEFAULT TRUE,
  allow_delivery BOOLEAN DEFAULT TRUE,
  
  -- 营业时间配置
  business_hours JSONB,
  
  -- 订单设置
  min_order_amount INTEGER,  -- 最低订单金额(分)
  delivery_fee INTEGER,      -- 配送费(分)
  delivery_radius DECIMAL(10, 2),  -- 配送半径(公里)
  
  -- 自定义域名
  custom_domain VARCHAR(255),
  
  -- 主题设置
  theme_settings JSONB,
  
  -- 时间戳
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  
  -- 约束
  CONSTRAINT valid_subdomain CHECK (subdomain ~ '^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$')
);

-- 创建索引
CREATE INDEX idx_merchant_online_order_configs_merchant_id ON merchant_online_order_configs(merchant_id);
CREATE INDEX idx_merchant_online_order_configs_subdomain ON merchant_online_order_configs(subdomain);
CREATE INDEX idx_merchant_online_order_configs_enabled ON merchant_online_order_configs(enabled);
```

## API 接口

### 基础 URL
```
http://localhost:3002/api/order/v1
```

### 1. 根据子域名获取配置 (在线点单前端调用)

**用途**: 在线点单系统根据子域名获取商家配置

```http
GET /merchant-config/by-subdomain/:subdomain

示例: GET /merchant-config/by-subdomain/sweet7
```

**响应**:
```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "merchantId": "merchant-uuid",
    "subdomain": "sweet7",
    "enabled": true,
    "allowPickup": true,
    "allowDineIn": true,
    "allowDelivery": true,
    "businessHours": {
      "monday": { "open": "09:00", "close": "22:00", "closed": false },
      // ...
    },
    "minOrderAmount": 1000,  // 10.00元
    "deliveryFee": 500,      // 5.00元
    "deliveryRadius": 5.0,
    "themeSettings": {
      "primaryColor": "#f97316",
      "logoUrl": "https://..."
    }
  }
}
```

### 2. 获取商家配置 (Portal 调用)

```http
GET /merchants/:merchantId/config

示例: GET /merchants/123e4567-e89b-12d3-a456-426614174000/config
```

### 3. 创建商家配置 (Portal 调用)

```http
POST /merchants/:merchantId/config
Content-Type: application/json

{
  "subdomain": "sweet7",
  "enabled": true,
  "allowPickup": true,
  "allowDineIn": true,
  "allowDelivery": true,
  "minOrderAmount": 1000,
  "deliveryFee": 500,
  "deliveryRadius": 5.0,
  "businessHours": {
    "monday": { "open": "09:00", "close": "22:00", "closed": false },
    "tuesday": { "open": "09:00", "close": "22:00", "closed": false },
    "wednesday": { "open": "09:00", "close": "22:00", "closed": false },
    "thursday": { "open": "09:00", "close": "22:00", "closed": false },
    "friday": { "open": "09:00", "close": "22:00", "closed": false },
    "saturday": { "open": "10:00", "close": "23:00", "closed": false },
    "sunday": { "open": "10:00", "close": "23:00", "closed": false }
  },
  "themeSettings": {
    "primaryColor": "#f97316",
    "logoUrl": "https://example.com/logo.png"
  }
}
```

### 4. 更新商家配置 (Portal 调用)

```http
PUT /merchants/:merchantId/config
Content-Type: application/json

{
  "enabled": false,
  "minOrderAmount": 1500
}
```

### 5. 检查子域名可用性 (Portal 调用)

```http
POST /merchant-config/check-subdomain
Content-Type: application/json

{
  "subdomain": "sweet7",
  "excludeMerchantId": "uuid"  // 可选,用于更新时排除自己
}
```

**响应**:
```json
{
  "success": true,
  "data": {
    "available": false,
    "message": "该子域名已被使用",
    "suggestion": "sweet7123"
  }
}
```

### 6. 获取所有配置 (管理员)

```http
GET /admin/merchant-configs?page=1&limit=20
```

## 与在线点单前端集成

### 前端调用示例

```typescript
// 在线点单前端 - 获取商家配置
import { apiClient } from '@/lib/api-client'
import { useMerchant } from '@/contexts/MerchantContext'

function useOrderConfig() {
  const { merchantId } = useMerchant()
  
  useEffect(() => {
    if (merchantId) {
      // 设置 API 客户端的商家 ID
      apiClient.setMerchantId(merchantId)
      
      // 获取商家配置
      const config = await apiClient.get(
        `${ORDER_SERVICE_URL}/merchant-config/by-subdomain/${merchantId}`
      )
      
      // 使用配置...
    }
  }, [merchantId])
}
```

### 创建订单时的验证

Order Service 可以在创建订单时验证商家配置:

```typescript
// 在 order.service.ts 中
import { getConfigByMerchantId } from './merchant-config.service'

async function createOrder(data) {
  // 从请求头获取商家 ID
  const merchantId = req.headers['x-merchant-id']
  
  // 验证商家配置
  const config = await getConfigByMerchantId(merchantId)
  
  if (!config || !config.enabled) {
    throw new Error('商家在线点单功能未启用')
  }
  
  // 验证订单类型
  if (data.orderType === 'PICKUP' && !config.allowPickup) {
    throw new Error('该商家不支持自取订单')
  }
  
  // 验证最低订单金额
  if (config.minOrderAmount && data.totalAmount < config.minOrderAmount) {
    throw new Error(`订单金额不足最低要求: ${config.minOrderAmount / 100}元`)
  }
  
  // 创建订单...
}
```

## 测试

### 1. 创建测试配置

```bash
# 使用 test-merchant-config.http 文件
```

创建文件 `test-merchant-config.http`:

```http
### 1. 创建商家配置
POST http://localhost:3002/api/order/v1/merchants/123e4567-e89b-12d3-a456-426614174000/config
Content-Type: application/json

{
  "subdomain": "sweet7",
  "enabled": true,
  "allowPickup": true,
  "allowDineIn": true,
  "allowDelivery": true,
  "minOrderAmount": 1000,
  "deliveryFee": 500
}

### 2. 根据子域名获取配置
GET http://localhost:3002/api/order/v1/merchant-config/by-subdomain/sweet7

### 3. 检查子域名可用性
POST http://localhost:3002/api/order/v1/merchant-config/check-subdomain
Content-Type: application/json

{
  "subdomain": "sweet7"
}

### 4. 更新配置
PUT http://localhost:3002/api/order/v1/merchants/123e4567-e89b-12d3-a456-426614174000/config
Content-Type: application/json

{
  "minOrderAmount": 1500,
  "enabled": true
}

### 5. 获取所有配置
GET http://localhost:3002/api/order/v1/admin/merchant-configs?page=1&limit=20
```

## 文件结构

```
reall-order-service/
├── shared/
│   └── database/
│       └── schema-order.prisma          # 添加了 MerchantOnlineOrderConfig 模型
├── src/
│   ├── controllers/
│   │   └── merchant-config.controller.ts  # 新增
│   ├── services/
│   │   └── merchant-config.service.ts     # 新增
│   ├── validators/
│   │   └── merchant-config.validator.ts   # 新增
│   ├── routes/
│   │   ├── merchant-config.routes.ts      # 新增
│   │   └── index.ts                       # 已更新
│   └── app.ts                             # 已更新 (CORS)
└── MERCHANT-CONFIG-SETUP.md               # 本文件
```

## 环境变量

确保 `.env` 文件中有以下配置:

```env
ORDER_DATABASE_URL=postgresql://user:password@localhost:5432/order_db
PORT=3002
ALLOWED_ORIGINS=http://localhost:3000,http://localhost:8888
```

## 启动服务

```bash
# 1. 安装依赖
npm install

# 2. 生成 Prisma Client
npm run prisma:generate

# 3. 运行迁移
npm run prisma:migrate

# 4. 启动开发服务器
npm run dev
```

## 注意事项

1. **Prisma Client 错误**: 如果看到 `Property 'merchantOnlineOrderConfig' does not exist` 错误,运行 `npm run prisma:generate` 重新生成客户端

2. **子域名格式**: 子域名必须符合格式 `^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$`

3. **金额单位**: 所有金额字段使用"分"作为单位 (minOrderAmount, deliveryFee)

4. **CORS 配置**: 已添加 `x-merchant-id` 到允许的请求头列表

## 下一步

1. 在 Portal Frontend 中创建商家配置管理页面
2. 在在线点单前端中集成配置获取逻辑
3. 在创建订单时添加商家配置验证
4. 添加单元测试和集成测试
