import prisma from '../utils/prisma'
import { AppError } from '../middleware/errorHandler'
import logger from '../utils/logger'

/** 根据 billingCycle 计算当前周期的起始时间 */
function getCycleStartDate(billingCycle: 'WEEKLY' | 'BIWEEKLY' | 'MONTHLY'): Date {
  const now = new Date()
  if (billingCycle === 'WEEKLY') {
    // 本周一 00:00:00
    const day = now.getDay() === 0 ? 6 : now.getDay() - 1 // 0=周日
    const start = new Date(now)
    start.setDate(now.getDate() - day)
    start.setHours(0, 0, 0, 0)
    return start
  } else if (billingCycle === 'BIWEEKLY') {
    // 以本月1日为锚点，每两周一个周期
    const start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0)
    const dayOfMonth = now.getDate()
    if (dayOfMonth > 14) start.setDate(15)
    return start
  } else {
    // MONTHLY：本月1日
    return new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0)
  }
}

export interface CreditStatus {
  cycleLimit: number        // 周期总额度（分）
  usedAmount: number        // 当前周期已使用（分）
  availableAmount: number   // 剩余可用额度（分）
  cycleStart: Date          // 当前周期起始时间
  billingCycle: string
  previousUnpaid: number    // 上期未结清金额（分），>0 表示上期有欠款未结清
}

/**
 * 查询某渠道当前周期的授信使用情况
 */
export async function getChannelCreditStatus(
  tenantId: string,
  channelConfigId: string
): Promise<CreditStatus | null> {
  const channel = await prisma.orderSourceConfig.findFirst({
    where: { id: channelConfigId, tenantId, isActive: true },
  })

  if (!channel || channel.checkoutMode !== 'CREDIT_ACCOUNT') return null

  const creditConfig = channel.creditConfig as any
  if (!creditConfig?.cycleLimit || !creditConfig?.billingCycle) return null

  const cycleLimit: number = creditConfig.cycleLimit   // 单位：分
  const billingCycle: 'WEEKLY' | 'BIWEEKLY' | 'MONTHLY' = creditConfig.billingCycle
  const cycleStart = getCycleStartDate(billingCycle)

  const baseWhere = {
    tenantId,
    channelConfigId,
    paymentMethod: 'ACCOUNT',
    creditSettledAt: null,
    status: { notIn: ['CANCELLED'] },
  }

  // 并行查询：当前周期已用额度 + 上期未结清金额
  const [currentAgg, previousAgg] = await Promise.all([
    prisma.order.aggregate({
      where: { ...baseWhere, createdAt: { gte: cycleStart } },
      _sum: { totalAmount: true },
    }),
    prisma.order.aggregate({
      where: { ...baseWhere, createdAt: { lt: cycleStart } },
      _sum: { totalAmount: true },
    }),
  ])

  const usedAmount = currentAgg._sum.totalAmount ?? 0
  const previousUnpaid = previousAgg._sum.totalAmount ?? 0

  return {
    cycleLimit,
    usedAmount,
    availableAmount: Math.max(0, cycleLimit - usedAmount),
    cycleStart,
    billingCycle,
    previousUnpaid,
  }
}

/**
 * 下单前校验授信额度
 * 不足时抛 AppError(402)
 */
export async function assertCreditAvailable(
  tenantId: string,
  channelConfigId: string,
  orderAmount: number   // 本次订单金额（分）
): Promise<CreditStatus> {
  const status = await getChannelCreditStatus(tenantId, channelConfigId)

  if (!status) {
    // 没有配置额度 = 不限额，直接放行
    return { cycleLimit: 0, usedAmount: 0, availableAmount: Infinity, cycleStart: new Date(), billingCycle: 'MONTHLY', previousUnpaid: 0 }
  }

  // 上期有未结清账单，禁止本期继续下单
  if (status.previousUnpaid > 0) {
    logger.warn('[Credit] 上期账单未结清', {
      tenantId, channelConfigId, previousUnpaid: status.previousUnpaid,
    })
    throw new AppError(
      402,
      'PREVIOUS_CYCLE_UNPAID',
      '上期账单尚未结清，请联系管理员结清后再下单'
    )
  }

  if (status.availableAmount < orderAmount) {
    logger.warn('[Credit] 授信额度不足', {
      tenantId, channelConfigId, cycleLimit: status.cycleLimit,
      usedAmount: status.usedAmount, orderAmount,
    })
    throw new AppError(
      402,
      'CREDIT_LIMIT_EXCEEDED',
      '授信额度不足，请联系管理员'
    )
  }

  return status
}

/**
 * finance-service 结清回调：标记订单为已结清，释放额度
 * 支持按 channelConfigId 批量结清（结清一个周期的所有未结清订单）
 */
export async function markOrdersCreditSettled(params: {
  tenantId: string
  channelConfigId: string
  orderIds?: string[]   // 指定订单ID；不传则结清该渠道所有未结清记账订单
}): Promise<{ settledCount: number; totalAmount: number }> {
  const { tenantId, channelConfigId, orderIds } = params

  const where: any = {
    tenantId,
    channelConfigId,
    paymentMethod: 'ACCOUNT',
    creditSettledAt: null,
    status: { notIn: ['CANCELLED'] },
  }
  if (orderIds?.length) {
    where.id = { in: orderIds }
  }

  const orders = await prisma.order.findMany({ where, select: { id: true, totalAmount: true } })

  if (orders.length === 0) {
    return { settledCount: 0, totalAmount: 0 }
  }

  const now = new Date()
  await prisma.order.updateMany({
    where: { id: { in: orders.map(o => o.id) } },
    data: { creditSettledAt: now },
  })

  const totalAmount = orders.reduce((sum, o) => sum + o.totalAmount, 0)

  logger.info('[Credit] 记账订单已标记结清', {
    tenantId, channelConfigId, settledCount: orders.length, totalAmount,
  })

  return { settledCount: orders.length, totalAmount }
}
