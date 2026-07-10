#!/bin/bash

# 测试完整的支付流程

set -e

# 配置
API_BASE="http://localhost:3002/api/order/v1"
MERCHANT_ID="a6aee8e9-fc5f-419a-8504-3d106b1a3534"  # mixue
TENANT_ID="3fa85f64-5717-4562-b3fc-2c963f66afa6"    # 示例租户 ID，需要替换为实际的

echo "========================================="
echo "完整支付流程测试"
echo "========================================="

# 1. 创建快照
echo ""
echo "📸 Step 1: 创建 Checkout Snapshot"
echo "=================================="

SNAPSHOT_RESPONSE=$(curl -s -X POST "$API_BASE/checkout-snapshots" \
  -H "X-Merchant-Id: $MERCHANT_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "orderType": "TAKEOUT",
    "customer": {
      "name": "Test Customer",
      "phone": "+16175551234",
      "email": "test@example.com"
    },
    "items": [
      {
        "itemId": "d056ac13-5f8d-4376-b1fd-7bc0dec9150d",
        "quantity": 1,
        "modifiers": {
          "4e0fb907-f9b9-44ae-b5ac-757762fc512e": ["957923dc-64e8-4545-ace2-3133e97ab8f6"],
          "469af108-f566-4b1d-b3bc-f9b4d97b712a": ["255a7c8c-e012-4ad8-a1cd-f939df93f55c"]
        }
      }
    ],
    "tipAmount": 0
  }')

echo "Response: $SNAPSHOT_RESPONSE"
SNAPSHOT_ID=$(echo "$SNAPSHOT_RESPONSE" | grep -o '"snapshotId":"[^"]*' | cut -d'"' -f4)
echo "✅ Snapshot ID: $SNAPSHOT_ID"

# 2. 创建临时订单
echo ""
echo "📦 Step 2: 创建临时订单"
echo "========================"

ORDER_RESPONSE=$(curl -s -X POST "$API_BASE/web/create-from-snapshot" \
  -H "X-Merchant-Id: $MERCHANT_ID" \
  -H "Content-Type: application/json" \
  -d "{\"snapshotId\": \"$SNAPSHOT_ID\"}")

echo "Response: $ORDER_RESPONSE"
ORDER_ID=$(echo "$ORDER_RESPONSE" | grep -o '"id":"[^"]*' | head -1 | cut -d'"' -f4)
ORDER_NUMBER=$(echo "$ORDER_RESPONSE" | grep -o '"orderNumber":"[^"]*' | cut -d'"' -f4)
echo "✅ Order ID: $ORDER_ID"
echo "✅ Order Number: $ORDER_NUMBER"

# 3. 查询订单（支付前）
echo ""
echo "🔍 Step 3: 查询订单状态（支付前）"
echo "=================================="

curl -s -X GET "$API_BASE/orders/$ORDER_ID" \
  -H "Authorization: Bearer dummy-token" | jq '.data | {id, orderNumber, status, paymentStatus}'

# 4. 模拟 Webhook 调用（Finance Service 会调用此端点）
echo ""
echo "⚡ Step 4: 模拟 Webhook 调用（更新支付状态为 PAID）"
echo "====================================================="

WEBHOOK_RESPONSE=$(curl -s -X PATCH "$API_BASE/orders/$ORDER_ID/payment-status" \
  -H "X-Organization-Id: $TENANT_ID" \
  -H "Content-Type: application/json" \
  -d '{"paymentStatus": "PAID"}')

echo "Response: $WEBHOOK_RESPONSE"
echo "✅ Webhook调用完成"

# 5. 查询订单（支付后）
echo ""
echo "✨ Step 5: 查询订单状态（支付后）"
echo "================================="

curl -s -X GET "$API_BASE/orders/$ORDER_ID" \
  -H "Authorization: Bearer dummy-token" | jq '.data | {id, orderNumber, status, paymentStatus, paidAt}'

# 6. 测试幂等性（重复调用）
echo ""
echo "🔄 Step 6: 测试幂等性（重复调用更新为 PAID）"
echo "=========================================="

IDEMPOTENT_RESPONSE=$(curl -s -X PATCH "$API_BASE/orders/$ORDER_ID/payment-status" \
  -H "X-Organization-Id: $TENANT_ID" \
  -H "Content-Type: application/json" \
  -d '{"paymentStatus": "PAID"}')

echo "Response: $IDEMPOTENT_RESPONSE"
echo "✅ 幂等性测试完成（应该看到 '订单支付状态已是目标状态' 消息）"

# 7. 测试安全性：防止越权
echo ""
echo "🛡️  Step 7: 测试安全性（防止越权 - 错误的 tenantId）"
echo "======================================================"

SECURITY_RESPONSE=$(curl -s -w "\nHTTP_CODE: %{http_code}" -X PATCH "$API_BASE/orders/$ORDER_ID/payment-status" \
  -H "X-Organization-Id: wrong-tenant-id" \
  -H "Content-Type: application/json" \
  -d '{"paymentStatus": "PAID"}')

echo "Response: $SECURITY_RESPONSE"
echo "✅ 应该返回 404 错误"

# 8. 测试安全性：防止恶意降级
echo ""
echo "🛡️  Step 8: 测试安全性（防止恶意降级 - PAID → UNPAID）"
echo "========================================================"

DOWNGRADE_RESPONSE=$(curl -s -w "\nHTTP_CODE: %{http_code}" -X PATCH "$API_BASE/orders/$ORDER_ID/payment-status" \
  -H "X-Organization-Id: $TENANT_ID" \
  -H "Content-Type: application/json" \
  -d '{"paymentStatus": "UNPAID"}')

echo "Response: $DOWNGRADE_RESPONSE"
echo "✅ 应该返回 400 错误和 'INVALID_STATUS_TRANSITION' 消息"

echo ""
echo "========================================="
echo "✅ 完整支付流程测试结束"
echo "========================================="
