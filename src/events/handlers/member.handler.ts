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
// 和 order.service 的建单流程共用同一份 —— 两条路都要核销券，别各写一份
import { useGrantedReward } from '../../utils/member-client';

const MEMBER_SERVICE_URL = process.env.MEMBER_SERVICE_URL || 'http://localhost:7006';
const INTERNAL_SERVICE_KEY = process.env.INTERNAL_SERVICE_KEY || '';


/**
 * 下单的是**哪家店**。
 *
 * 积分流水的 organizationId 存的是会员归属的主店（上面 resolveMemberOrgId
 * 把分店换成了 parentOrgId），所以它答不了「这笔在哪消费的」——
 * 会员面板要显示门店就得单独带。
 *
 * 名字取不到不挡积分：流水少一个门店名，比少一笔积分轻得多。
 * organizationService 有 5 分钟缓存，这里不会给每单加一次 HTTP。
 */
async function resolveStore(tenantId: string): Promise<{ storeId: string; storeName?: string }> {
  try {
    const info = await organizationService.getOrganization(tenantId);
    return { storeId: tenantId, storeName: info?.orgName };
  } catch {
    return { storeId: tenantId };
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
  storeId?: string;
  storeName?: string;
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
      storeId: params.storeId,
      storeName: params.storeName,
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
  /*
    **支付成功即加积分，不分来源。**

    原来这里只处理 WEB，POS 单要等 ORDER_COMPLETED。那个设计依赖一个假设：
    POS 单支付成功会自动完成（见 order.service 的 autoComplete）。
    而 autoComplete 的条件是**叫号屏关着** —— 商家 2026-08-29 打开叫号屏之后，
    POS 单全部停在 CONFIRMED，于是会员消费再也不计积分了
    （生产库实证：最后一次积分入账 08-23，而 09-12 两笔带会员的 POS 单都是 CONFIRMED）。

    积分记的是**顾客花了多少钱**，和这单做没做完、叫没叫号无关。
    所以判据换成支付成功，不再依赖门店怎么配叫号屏。

    下面 ORDER_COMPLETED 那支留着当兜底：member-service 的 earn 接口按
    orderId 幂等，重复调用不会重复加分。
  */
  bus.on('ORDER_PAID', async function member_ORDER_PAID(event) {
    const e = event as OrderPaidEvent;

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
      // 来源按下单端分：member-service 那边用它区分线上单和店员代下单
      source: e.clientOrigin === 'WEB' ? 'ONLINE_ORDER' : 'STAFF_APP',
      ...(await resolveStore(e.tenantId)),
    });

    // 支付成功后标记 GrantedReward 为 USED（非致命，失败只记日志）
    if (e.grantedRewardId) {
      await useGrantedReward({
        grantedRewardId: e.grantedRewardId,
        orderId: e.orderId,
      }).catch(err => {
        logger.warn('[MemberHandler] callUseGrantedReward 异常（非致命）', { err });
      });
    }

    logger.info('[MemberHandler] ORDER_PAID 积分处理完成', {
      clientOrigin: e.clientOrigin,
      orderId: e.orderId,
      memberId: e.memberId,
    });
  });

  /*
    兜底：订单完成时再算一次。

    正常情况上面那支在支付成功时已经加过了，这里调的是同一个幂等键
    （orderId），member-service 会直接返回「已加过」。留着是为了两种情况：
      · 存量的、支付时还没走到这套逻辑的订单
      · 先完成后补付款之类的异常顺序
  */
  bus.on('ORDER_COMPLETED', async function member_ORDER_COMPLETED(event) {
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
      ...(await resolveStore(e.tenantId)),
    });

    // POS 同步流程使用了会员券 → 标记为 USED(非致命,失败仅记日志)
    if (e.grantedRewardId) {
      await useGrantedReward({
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
