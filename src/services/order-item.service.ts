import { PrismaClient } from '.prisma/client-order'
import { AppError } from '../middleware/errorHandler'
import logger from '../utils/logger'

const prisma = new PrismaClient()

/**
 * 标记 order item 为完成（READY）
 * 若该订单所有 item 均已完成，自动将订单置为 COMPLETED
 */
export async function markItemReady(
  orderItemId: string,
  completedBy?: string
): Promise<{ allComplete: boolean }> {
  const item = await prisma.orderItem.findUnique({
    where: { id: orderItemId },
    include: { order: true },
  })

  if (!item) {
    throw new AppError(404, 'ORDER_ITEM_NOT_FOUND', '订单商品不存在')
  }

  const order = item.order

  if (order.status === 'CANCELLED') {
    throw new AppError(400, 'ORDER_CANCELLED', '订单已取消')
  }
  if (order.status === 'COMPLETED') {
    throw new AppError(400, 'ORDER_COMPLETED', '订单已完成')
  }

  // 幂等：已经 READY 直接返回
  if ((item as any).status === 'READY') {
    const allComplete = await checkAllItemsReady(order.id)
    return { allComplete }
  }

  const now = new Date()

  await prisma.$transaction(async (tx) => {
    await (tx.orderItem as any).update({
      where: { id: orderItemId },
      data: {
        status: 'READY',
        completedAt: now,
        completedBy: completedBy ?? null,
      },
    })

    // 检查订单下所有 item 是否全部 READY
    const pendingCount = await (tx.orderItem as any).count({
      where: { orderId: order.id, status: 'PENDING' },
    })

    if (pendingCount === 0) {
      await tx.order.update({
        where: { id: order.id },
        data: { status: 'COMPLETED', completedAt: now },
      })
      await tx.orderStatusHistory.create({
        data: {
          orderId: order.id,
          fromStatus: order.status as any,
          toStatus: 'COMPLETED' as any,
          reason: 'All items completed',
          changedAt: now,
        },
      })
      logger.info(`[OrderItem] 所有 item 完成，订单自动完成: ${order.id}`)
    }
  })

  const allComplete = await checkAllItemsReady(order.id)
  return { allComplete }
}

/**
 * 直接完成订单时，同步将所有 item 标为 READY
 */
export async function markAllItemsReady(orderId: string): Promise<void> {
  await (prisma.orderItem as any).updateMany({
    where: { orderId, status: 'PENDING' },
    data: { status: 'READY', completedAt: new Date() },
  })
}

async function checkAllItemsReady(orderId: string): Promise<boolean> {
  const pendingCount = await (prisma.orderItem as any).count({
    where: { orderId, status: 'PENDING' },
  })
  return pendingCount === 0
}
