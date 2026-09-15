import logger from './logger';

const MEMBER_SERVICE_URL = process.env.MEMBER_SERVICE_URL || 'http://localhost:7006';
const INTERNAL_SERVICE_KEY = process.env.INTERNAL_SERVICE_KEY || '';

export interface ValidateGrantedRewardResult {
  valid: boolean;
  reason?: string;
}

/**
 * 校验 GrantedReward 是否仍可使用(状态为 ACTIVE 且属于该会员)。
 * 用于 POS 同步下单前的防 double-spend 关卡:同张券若已被其它端用过,
 * 这里会拒绝创建带折扣的订单。
 *
 * member-service 服务不可达时(网络故障/服务停)按"通过"处理避免阻断下单,
 * 同时打 warn 日志—— /use 端点的状态检查仍然是兜底的最终关卡。
 */
export async function validateGrantedRewardForMember(
  grantedRewardId: string,
  memberId: string,
): Promise<ValidateGrantedRewardResult> {
  if (!grantedRewardId || !memberId) return { valid: false, reason: 'missing_params' };

  try {
    const url = `${MEMBER_SERVICE_URL}/internal/rewards/validate/${encodeURIComponent(grantedRewardId)}?memberId=${encodeURIComponent(memberId)}`;
    const response = await fetch(url, {
      headers: { 'x-service-api-key': INTERNAL_SERVICE_KEY },
    });
    if (!response.ok) {
      logger.warn('[MemberClient] validate reward failed (treat as pass)', {
        grantedRewardId, memberId, status: response.status,
      });
      return { valid: true };
    }
    const body = await response.json() as any;
    return body?.data ?? { valid: false, reason: 'no_data' };
  } catch (error) {
    logger.warn('[MemberClient] validate reward unreachable, treat as pass', { grantedRewardId, error });
    return { valid: true };
  }
}

/**
 * 通过 consumerId 查询对应的 memberId（服务间内部调用）
 * 找不到会员时返回 null，不抛出错误（会员是可选的）
 */
export async function getMemberIdByConsumerId(consumerId: string): Promise<string | null> {
  if (!consumerId) return null;

  try {
    const url = `${MEMBER_SERVICE_URL}/internal/members/by-consumer?consumerId=${encodeURIComponent(consumerId)}`;
    const response = await fetch(url, {
      headers: {
        'x-service-api-key': INTERNAL_SERVICE_KEY,
      },
    });

    if (!response.ok) {
      logger.warn('[MemberClient] 查询会员失败', { consumerId, status: response.status });
      return null;
    }

    const body = await response.json() as any;
    return body?.data?.id || null;
  } catch (error) {
    // 会员服务不可用时不影响下单流程
    logger.warn('[MemberClient] 会员服务不可达，跳过 memberId 绑定', { consumerId, error });
    return null;
  }
}

/**
 * 通过 memberId 反查它绑定的 consumerId（服务间内部调用）。
 *
 * ## 为什么建单时要多这一跳
 * POS 收银台只认「会员」（店员输手机号 → memberId），而 consumer app 的订单列表
 * 是按 `orders.consumer_id` 查的。不在建单时把这个 id 落下来，那笔单在顾客自己的
 * 订单记录里**永远看不到** —— 实际发生过：同一个人同一天的两笔网单看得到、
 * 一笔 POS 单看不到，差别就在这一列。
 *
 * ## 拿不到就算了，绝不挡住建单
 * 会员服务不可达、或者这是个还没绑账号的纯线下会员 —— 两种都返回 null。
 * 订单照常建，`consumer_id` 留空，由读取侧的自愈补上（见 getConsumerOrders）。
 * 收银台上任何外部依赖都不能变成"收不了钱"。
 */
export async function getConsumerIdByMemberId(memberId: string): Promise<string | null> {
  if (!memberId) return null;
  try {
    const url = `${MEMBER_SERVICE_URL}/internal/members/${encodeURIComponent(memberId)}/consumer`;
    const response = await fetch(url, { headers: { 'x-service-api-key': INTERNAL_SERVICE_KEY } });
    if (!response.ok) {
      logger.warn('[MemberClient] 查询会员绑定的 consumer 失败', { memberId, status: response.status });
      return null;
    }
    const body = await response.json() as any;
    return body?.data?.consumerId || null;
  } catch (error) {
    logger.warn('[MemberClient] 会员服务不可达，consumer_id 留空由读取侧自愈', { memberId, error });
    return null;
  }
}

/**
 * 标记 GrantedReward 为 USED。失败只记日志（非致命）。
 *
 * 两个调用方，别只改一处：
 *   · member.handler 的 ORDER_PAID / ORDER_COMPLETED 事件链（现金、刷卡、Web 单）
 *   · order.service 建单流程里的**挂账 / 平台单** —— 那类单建单即 PAID
 *     （见 isAccountPayment 那段），压根不走 updatePaymentStatus，
 *     ORDER_PAID 事件从来不发，事件链核销不到它们。
 *
 * member-service 的 /use 端点自身是幂等的（状态机只认 ACTIVE→USED），
 * 所以两条路都调也不会出问题。
 */
export async function useGrantedReward(params: {
  grantedRewardId: string;
  orderId: string;
}): Promise<void> {
  if (!INTERNAL_SERVICE_KEY) {
    logger.warn('[MemberClient] INTERNAL_SERVICE_KEY 未配置，跳过奖励标记');
    return;
  }

  const res = await fetch(`${MEMBER_SERVICE_URL}/internal/rewards/use`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-service-api-key': INTERNAL_SERVICE_KEY },
    body: JSON.stringify({ grantedRewardId: params.grantedRewardId, orderId: params.orderId }),
  });

  /*
    ★ 失败**抛出**，由调用方决定怎么办。

    原来这里是「只记 warn 不抛」，于是事件 handler 外面那层 `.catch` 成了摆设：
    handler 不抛 → outbox 判定投递成功 → **永远不会重试** → 券就此漏掉。
    而隔壁 callEarnPoints 是抛的，所以积分反而有重试保障 —— 后果轻的那个
    有兜底，后果重的那个没有。

    现在两个调用方各按自己的场景处理：
      · 事件 handler  —— 不 catch，让它抛，outbox 会退避重试直到成功
      · 建单流程      —— catch 掉，钱和订单已经落定，不能因为核销失败回滚下单
  */
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      `useGrantedReward failed: ${res.status} ${JSON.stringify(body)} (grantedRewardId=${params.grantedRewardId})`,
    );
  }
  logger.info('[MemberClient] 奖励已标记为 USED', {
    grantedRewardId: params.grantedRewardId, orderId: params.orderId,
  });
}

/** 从 `GrantedReward:<id>` 这种 discountReason 里抠出券 id。不是这个形状就返回 null */
export function parseGrantedRewardId(discountReason?: string | null): string | null {
  return discountReason?.startsWith('GrantedReward:')
    ? discountReason.slice('GrantedReward:'.length)
    : null;
}
