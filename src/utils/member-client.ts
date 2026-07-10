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
