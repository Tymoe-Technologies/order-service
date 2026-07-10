/**
 * 会员积分 Handler
 * 订单完成后，异步通知 member-service 累积积分
 *
 * 幂等性：member-service 的 earn 接口通过 idempotencyKey（orderId）保证
 */

import type { IEventBus } from '../event-bus';
import type { OrderCompletedEvent, OrderPaidEvent } from '../types';
import logger from '../../utils/logger';
import organizationService from '../../services/organization.service';

const MEMBER_SERVICE_URL = process.env.MEMBER_SERVICE_URL || 'http://localhost:7006';
const INTERNAL_SERVICE_KEY = process.env.INTERNAL_SERVICE_KEY || '';

/**
 * 调用 member-service 标记 GrantedReward 为 USED
 */
async function callUseGrantedReward(params: {
  grantedRewardId: string;
  orderId: string;
}): Promise<void> {
  if (!INTERNAL_SERVICE_KEY) {
    logger.warn('[MemberHandler] INTERNAL_SERVICE_KEY 未配置，跳过奖励标记');
    return;
  }

  const url = `${MEMBER_SERVICE_URL}/internal/rewards/use`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-service-api-key': INTERNAL_SERVICE_KEY,
    },
    body: JSON.stringify({
      grantedRewardId: params.grantedRewardId,
      orderId: params.orderId,
    }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    logger.warn('[MemberHandler] 奖励标记失败（非致命）', {
      grantedRewardId: params.grantedRewardId,
      status: res.status,
      body,
    });
  } else {
    logger.info('[MemberHandler] 奖励已标记为 USED', {
      grantedRewardId: params.grantedRewardId,
      orderId: params.orderId,
    });
  }
}

/**
 * 调用 member-service 内部积分接口
 * totalAmount: 分（cents） → 转换为元（dollars）传给 member-service
 */
async function callEarnPoints(params: {
  memberId: string;
  organizationId: string;
  orderAmountCents: number;
  orderId: string;
  source: 'ONLINE_ORDER' | 'STAFF_APP';
}): Promise<void> {
  if (!INTERNAL_SERVICE_KEY) {
    logger.warn('[MemberHandler] INTERNAL_SERVICE_KEY 未配置，跳过积分累积');
    return;
  }

  const url = `${MEMBER_SERVICE_URL}/internal/points/earn`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-service-api-key': INTERNAL_SERVICE_KEY,
    },
    body: JSON.stringify({
      memberId: params.memberId,
      organizationId: params.organizationId,
      orderAmount: params.orderAmountCents / 100,  // cents → dollars
      orderId: params.orderId,
      source: params.source,
    }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`member-service earn failed: ${res.status} ${JSON.stringify(body)}`);
  }

  const body = await res.json();
  const data = body?.data;

  if (data?.earned === false) {
    logger.warn('[MemberHandler] 积分未累积', {
      memberId: params.memberId,
      orderId: params.orderId,
      reason: data.reason,
      message: data.message,
    });
    return;
  }

  logger.info('[MemberHandler] 积分累积成功', {
    memberId: params.memberId,
    orderId: params.orderId,
    amount: data?.pointTransaction?.amount,
    newBalance: data?.newBalance,
  });
}

export function registerMemberHandler(bus: IEventBus): void {
  // 在线订单（WEB）：支付成功即加积分，不等 POS 完成
  bus.on('ORDER_PAID', async (event) => {
    const e = event as OrderPaidEvent;

    if (e.clientOrigin !== 'WEB') return;
    if (e.paymentMethod === 'ACCOUNT') return;  // 记账订单不计积分
    if (!e.memberId) return;
    if (!e.subtotal) return;

    // 会员体系归属主店：分店下单时用 parentOrgId 调 member-service
    const memberOrgId = await organizationService.resolveMemberOrgId(e.tenantId);

    // 按实付金额累积积分：税前小计 - 普通折扣 - 渠道折扣
    const earnBase = Math.max(0, e.subtotal - (e.discountAmount ?? 0) - (e.channelDiscountAmount ?? 0));
    await callEarnPoints({
      memberId: e.memberId,
      organizationId: memberOrgId,
      orderAmountCents: earnBase,
      orderId: e.orderId,
      source: 'ONLINE_ORDER',
    });

    // 支付成功后标记 GrantedReward 为 USED（非致命，失败只记日志）
    if (e.grantedRewardId) {
      await callUseGrantedReward({
        grantedRewardId: e.grantedRewardId,
        orderId: e.orderId,
      }).catch(err => {
        logger.warn('[MemberHandler] callUseGrantedReward 异常（非致命）', { err });
      });
    }

    logger.info('[MemberHandler] ORDER_PAID (WEB) 积分处理完成', {
      orderId: e.orderId,
      memberId: e.memberId,
    });
  });

  // POS/KIOSK 订单：等订单真正完成才加积分
  bus.on('ORDER_COMPLETED', async (event) => {
    const e = event as OrderCompletedEvent;

    if (e.clientOrigin === 'WEB') return;  // WEB 订单已在 ORDER_PAID 处理，避免重复
    if (!e.memberId) return;

    // 未付款的订单不累积积分（防止手动操作绕过支付流程）
    if (e.paymentStatus !== 'PAID') {
      logger.warn('[MemberHandler] 跳过积分：订单未支付', {
        orderId: e.orderId,
        paymentStatus: e.paymentStatus,
      });
      return;
    }

    // 会员体系归属主店：分店下单时用 parentOrgId 调 member-service
    const memberOrgId = await organizationService.resolveMemberOrgId(e.tenantId);

    // 按实付金额累积积分：税前小计 - 普通折扣 - 渠道折扣
    const earnBase = Math.max(0, e.subtotal - (e.discountAmount ?? 0) - (e.channelDiscountAmount ?? 0));
    await callEarnPoints({
      memberId: e.memberId,
      organizationId: memberOrgId,
      orderAmountCents: earnBase,
      orderId: e.orderId,
      source: 'STAFF_APP',
    });

    // POS 同步流程使用了会员券 → 标记为 USED(非致命,失败仅记日志)
    if (e.grantedRewardId) {
      await callUseGrantedReward({
        grantedRewardId: e.grantedRewardId,
        orderId: e.orderId,
      }).catch((err) => {
        logger.warn('[MemberHandler] callUseGrantedReward (POS) 异常,非致命', { err, orderId: e.orderId });
      });
    }

    logger.info('[MemberHandler] ORDER_COMPLETED 积分处理完成', {
      orderId: e.orderId,
      memberId: e.memberId,
    });
  });
}
