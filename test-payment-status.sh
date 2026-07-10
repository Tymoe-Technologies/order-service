#!/bin/bash

# 支付成功后订单更新状态集成测试脚本
# 测试 PATCH /api/order/v1/orders/:orderId/payment-status 端点

BASE_URL="http://localhost:3002"
TENANT_ID="test-tenant-uuid-12345"
ORDER_ID="test-order-uuid-12345"

echo "=== 支付成功后订单更新状态测试 ==="
echo ""

# 测试 1: 成功更新订单状态（UNPAID → PAID）
echo "测试 1: 成功更新订单状态（UNPAID → PAID）"
echo "请求："
echo "PATCH $BASE_URL/api/order/v1/orders/$ORDER_ID/payment-status"
echo "Headers:"
echo "  X-Organization-Id: $TENANT_ID"
echo "  Content-Type: application/json"
echo "Body:"
echo "  { \"paymentStatus\": \"PAID\" }"
echo ""
echo "执行命令："
curl -X PATCH "$BASE_URL/api/order/v1/orders/$ORDER_ID/payment-status" \
  -H "X-Organization-Id: $TENANT_ID" \
  -H "Content-Type: application/json" \
  -d '{"paymentStatus": "PAID"}' \
  -w "\nHTTP Status: %{http_code}\n" \
  2>/dev/null | jq '.'
echo ""
echo "---"
echo ""

# 测试 2: 幂等性测试（重复调用相同状态）
echo "测试 2: 幂等性测试（重复调用，订单已是 PAID 状态）"
echo "预期结果：返回成功，消息提示订单已是目标状态"
echo ""
echo "执行命令："
curl -X PATCH "$BASE_URL/api/order/v1/orders/$ORDER_ID/payment-status" \
  -H "X-Organization-Id: $TENANT_ID" \
  -H "Content-Type: application/json" \
  -d '{"paymentStatus": "PAID"}' \
  -w "\nHTTP Status: %{http_code}\n" \
  2>/dev/null | jq '.'
echo ""
echo "---"
echo ""

# 测试 3: 缺少租户信息的错误处理
echo "测试 3: 缺少 X-Organization-Id 请求头（应返回 400 错误）"
echo ""
echo "执行命令："
curl -X PATCH "$BASE_URL/api/order/v1/orders/$ORDER_ID/payment-status" \
  -H "Content-Type: application/json" \
  -d '{"paymentStatus": "PAID"}' \
  -w "\nHTTP Status: %{http_code}\n" \
  2>/dev/null | jq '.'
echo ""
echo "---"
echo ""

# 测试 4: 无效的支付状态
echo "测试 4: 无效的支付状态（应返回 400 错误）"
echo ""
echo "执行命令："
curl -X PATCH "$BASE_URL/api/order/v1/orders/$ORDER_ID/payment-status" \
  -H "X-Organization-Id: $TENANT_ID" \
  -H "Content-Type: application/json" \
  -d '{"paymentStatus": "INVALID_STATUS"}' \
  -w "\nHTTP Status: %{http_code}\n" \
  2>/dev/null | jq '.'
echo ""
echo "---"
echo ""

# 测试 5: 不存在的订单
echo "测试 5: 不存在的订单（应返回 404 错误）"
echo ""
echo "执行命令："
curl -X PATCH "$BASE_URL/api/order/v1/orders/non-existent-id/payment-status" \
  -H "X-Organization-Id: $TENANT_ID" \
  -H "Content-Type: application/json" \
  -d '{"paymentStatus": "PAID"}' \
  -w "\nHTTP Status: %{http_code}\n" \
  2>/dev/null | jq '.'
echo ""
echo "---"
echo ""

# 测试 6: 非法的状态转换（PAID → UNPAID）
echo "测试 6: 非法的状态转换（PAID → UNPAID，应返回 400 错误）"
echo "注意：此测试假设订单当前状态为 PAID"
echo ""
echo "执行命令："
curl -X PATCH "$BASE_URL/api/order/v1/orders/$ORDER_ID/payment-status" \
  -H "X-Organization-Id: $TENANT_ID" \
  -H "Content-Type: application/json" \
  -d '{"paymentStatus": "UNPAID"}' \
  -w "\nHTTP Status: %{http_code}\n" \
  2>/dev/null | jq '.'
echo ""
echo "=== 测试完成 ==="
