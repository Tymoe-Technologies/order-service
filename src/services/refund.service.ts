import logger from '../utils/logger';

// 占位设计：finance-service 已提供 POST /internal/refund-by-order（uber-service 的
// cancelDelivery 已在用，行为已验证：按 orderId+tenantId 查最近一笔 SUCCEEDED Payment 做全额退款）。
// 这里只是把这段已验证可用的调用逻辑迁移到 order-service 侧，包一层可替换、可降级的调用点，
// 不是从零设计未知接口——但仍不假设它长期稳定，接口契约变化只需改这一个文件

const FINANCE_SERVICE_URL = process.env.FINANCE_SERVICE_URL || 'http://localhost:7007';
const INTERNAL_SERVICE_KEY = process.env.INTERNAL_SERVICE_KEY || '';

export interface RefundOrderParams {
  orderId: string;
  tenantId: string;
  reason: string;
}

export interface RefundOrderResult {
  ok: boolean;
  note?: string;
}

export interface OrderRefund {
  id: string;
  paymentId: string;
  amount: number;
  currency: string;
  reason: string | null;
  status: string;
  createdAt: string;
  processedAt: string | null;
  failureReason: string | null;
}

// 查询某订单的退款记录，供消费者端订单详情展示。
// finance-service 查不到数据也可能是正常情况（订单没退过款），失败时返回空数组，
// 不让退款信息拖垮整个订单详情接口。
export async function getRefundsByOrderId(orderId: string): Promise<OrderRefund[]> {
  if (!INTERNAL_SERVICE_KEY) {
    logger.error('[RefundService] INTERNAL_SERVICE_KEY 未配置，无法查询退款记录', { orderId });
    return [];
  }

  try {
    const res = await fetch(
      `${FINANCE_SERVICE_URL}/internal/refunds-by-order?orderId=${encodeURIComponent(orderId)}`,
      { headers: { 'x-service-api-key': INTERNAL_SERVICE_KEY } },
    );

    if (!res.ok) {
      logger.warn('[RefundService] 查询退款记录失败', { orderId, status: res.status });
      return [];
    }

    const body: any = await res.json().catch(() => ({}));
    return Array.isArray(body.data) ? body.data : [];
  } catch (err: any) {
    logger.warn('[RefundService] 查询退款记录异常', { orderId, error: err.message });
    return [];
  }
}

export async function refundOrder(params: RefundOrderParams): Promise<RefundOrderResult> {
  if (!INTERNAL_SERVICE_KEY) {
    logger.error('[RefundService] INTERNAL_SERVICE_KEY 未配置，无法发起退款', params);
    return { ok: false, note: 'MISSING_SERVICE_KEY' };
  }

  try {
    const res = await fetch(`${FINANCE_SERVICE_URL}/internal/refund-by-order`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-service-api-key': INTERNAL_SERVICE_KEY },
      body: JSON.stringify({ orderId: params.orderId, tenantId: params.tenantId, reason: params.reason }),
    });

    if (!res.ok) {
      logger.error('[RefundService] 退款请求失败，需人工介入', { ...params, status: res.status });
      return { ok: false, note: `HTTP_${res.status}` };
    }

    const body: any = await res.json().catch(() => ({}));
    if (body.note === 'no_payment_found' || body.note === 'already_refunded') {
      logger.warn('[RefundService] 退款跳过', { ...params, note: body.note });
    } else {
      logger.info('[RefundService] 退款成功', params);
    }
    return { ok: true, note: body.note };
  } catch (err: any) {
    logger.error('[RefundService] 退款请求异常，需人工介入', { ...params, error: err.message });
    return { ok: false, note: 'NETWORK_ERROR' };
  }
}
