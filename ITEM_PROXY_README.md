# 商品代理端点文档

## 概述

Order Service 现在提供了一个代理端点,用于从 Item Management Service 获取商品数据。这个端点使用服务间认证,确保安全的微服务通信。

## 端点信息

### 获取商家商品列表

**端点**: `GET /api/order/v1/merchants/{merchantId}/items?limit=100&offset=0`

**描述**: 代理请求到 Item Management Service,获取商品列表

**重要说明**:
- Item Management Service 使用 **JWT token 中的 tenantId** 进行租户隔离
- `merchantId` 参数仅用于 Order Service 的日志记录
- 实际调用的是 Item Service 的 `GET /api/item-manage/v1/items` 端点

**路径参数**:
- `merchantId` (string, required): 商家ID (用于日志记录)

**查询参数**:
- `limit` (integer, optional): 返回数量限制,默认 100
- `offset` (integer, optional): 偏移量,默认 0

**请求头**:
- `Authorization` (optional): Bearer token (如果需要用户认证)
- **注意**: 此端点不需要 `X-Merchant-Id` 请求头,因为 merchantId 已在 URL 路径中

**响应示例**:
```json
{
  "items": [
    {
      "id": "item-uuid-1",
      "name": "item_name",
      "displayName": "商品显示名称",
      "description": "商品描述",
      "basePrice": 19.99,
      "categoryId": "category-uuid",
      "isActive": true,
      "sku": "ITEM-001",
      "cost": 5.00
    }
  ],
  "count": 1
}
```

**错误响应**:
- `401`: 未授权 - SERVICE_TOKEN 无效
- `503`: Item Management Service 不可用
- `500`: 服务通信错误

## 配置

### 环境变量

在 `.env` 文件中配置以下变量:

```env
# Item Management Service
ITEM_SERVICE_URL=http://localhost:3003
SERVICE_TOKEN=your-service-to-service-token-here
```

**配置说明**:
- `ITEM_SERVICE_URL`: Item Management Service 的基础 URL
- `SERVICE_TOKEN`: 服务间认证的 Bearer Token

### 生产环境配置

在生产环境中,请确保:
1. 使用 HTTPS 协议
2. 使用安全的服务间认证 token
3. 配置适当的超时时间(当前为 10 秒)
4. 考虑添加重试机制和熔断器

## 架构说明

### 文件结构

```
src/
├── services/
│   └── item-proxy.service.ts    # 商品代理服务层
├── controllers/
│   └── item-proxy.controller.ts # 商品代理控制器
└── routes/
    └── item-proxy.routes.ts     # 商品代理路由
```

### 工作流程

1. **前端请求**: 前端调用 Order Service 的 `/api/order/v1/merchants/{merchantId}/items`
2. **路由处理**: 请求被路由到 `item-proxy.controller.ts`
3. **服务调用**: Controller 调用 `item-proxy.service.ts`
4. **服务间通信**: Service 使用 axios 和服务 token 调用 Item Management Service
5. **响应返回**: Item Service 的响应被直接返回给前端

### 错误处理

服务包含完整的错误处理机制:
- **网络错误**: 当 Item Service 不可达时返回 503
- **业务错误**: 转发 Item Service 返回的错误状态码和消息
- **超时处理**: 10 秒超时保护
- **日志记录**: 所有请求和错误都会被记录

## 使用示例

### cURL 示例

```bash
curl -X GET "http://localhost:3002/api/order/v1/merchants/merchant-uuid-123/items" \
  -H "Authorization: Bearer your-user-token"
```

### JavaScript/Fetch 示例

```javascript
const merchantId = 'merchant-uuid-123';
const response = await fetch(
  `http://localhost:3002/api/order/v1/merchants/${merchantId}/items`,
  {
    headers: {
      'Authorization': `Bearer ${userToken}`,
      'Content-Type': 'application/json'
    }
  }
);

const data = await response.json();
console.log('商品列表:', data.data);
```

### Axios 示例

```javascript
import axios from 'axios';

const merchantId = 'merchant-uuid-123';
const response = await axios.get(
  `http://localhost:3002/api/order/v1/merchants/${merchantId}/items`,
  {
    headers: {
      'Authorization': `Bearer ${userToken}`
    }
  }
);

console.log('商品列表:', response.data.data);
```

## 安全考虑

1. **服务间认证**: 使用 `SERVICE_TOKEN` 进行服务间认证
2. **用户认证**: 前端请求仍需要用户 token(如果配置了认证中间件)
3. **Token 管理**: 
   - 不要在代码中硬编码 token
   - 使用环境变量管理敏感信息
   - 定期轮换服务间认证 token

## 监控和日志

服务会记录以下信息:
- 每次代理请求的商家 ID
- 成功获取的商品数量
- 所有错误详情(包括状态码和错误消息)

查看日志:
```bash
# 开发环境
npm run dev

# 生产环境
pm2 logs order-service
```

## 故障排查

### 常见问题

**1. 503 Service Unavailable**
- 检查 `ITEM_SERVICE_URL` 是否正确
- 确认 Item Management Service 是否正在运行
- 检查网络连接

**2. 401 Unauthorized**
- 检查 `SERVICE_TOKEN` 是否正确
- 确认 Item Service 的认证配置

**3. 超时错误**
- Item Service 响应时间过长
- 考虑增加超时时间或优化 Item Service 性能

## 未来改进

可能的改进方向:
1. 添加响应缓存机制
2. 实现请求重试逻辑
3. 添加熔断器模式
4. 支持批量请求
5. 添加请求限流
