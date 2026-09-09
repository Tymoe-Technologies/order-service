/**
 * POS 本机打印结果的补报。
 *
 * ## 为什么需要它
 * POS 本机下的单**不等后端**，收款完成就直接出票（架构文档 §6.2）。
 * 好处是后端挂了也照样出单，代价是后端对这部分打印**一无所知** ——
 * 而日常收银的绝大多数单都是本机单。于是：
 *   · 打印状态面板只看得到 Web / 第三方那一半（文档 §8.4）
 *   · 「这单到底打没打」事后查不了
 *   · 打印机坏了一整天，后台没有任何信号
 *
 * ## 幂等靠 clientTaskId
 * POS 打完先落本地待发件箱，网络恢复后补报 —— 也就是说**同一条会被报多次**
 * （补报成功但划待办前 POS 关机、重试、多次恢复）。
 * 按 `(tenantId, clientTaskId)` upsert，重复报只更新状态。
 *
 * 原来的 `POST /orders/:id/print` 是无条件 `create`，重试会留一堆重复记录，
 * 所以补报不能走它。
 */

import prisma from '../utils/prisma';
import logger from '../utils/logger';
import { AppError } from '../middleware/errorHandler';

const TICKET_TYPES = ['CUSTOMER_RECEIPT', 'KITCHEN_TICKET', 'ITEM_LABEL', 'CUSTOM_LABEL'] as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 票据类型 → PrintRecord.printType。报表类不落 PrintRecord（它是按订单挂的） */
const RECORD_TYPE: Record<string, 'RECEIPT' | 'KITCHEN_TICKET' | 'LABEL' | undefined> = {
  CUSTOMER_RECEIPT: 'RECEIPT',
  KITCHEN_TICKET: 'KITCHEN_TICKET',
  ITEM_LABEL: 'LABEL',
  CUSTOM_LABEL: 'LABEL',
};

export interface PrintResultReport {
  /** POS 发号，形如 `<orderId>:<ticketType>[:<stationId>]`。幂等键 */
  clientTaskId: string;
  orderId: string;
  ticketType: string;
  stationId?: string | null;
  status: 'COMPLETED' | 'FAILED';
  error?: string | null;
  retryCount?: number;
  /** POS 上的完成/失败时刻。**用它而不用服务端时间** —— 补报可能晚好几小时 */
  finishedAt?: string;
  printerName?: string | null;
  deviceId?: string | null;
}

/**
 * 批量补报。**一条失败不影响其他条** —— 补报是尽力而为的留痕，
 * 让一条脏数据（比如订单已经被删了）把整批卡住，那批就永远补不上去。
 */
export async function reportPrintResults(
  tenantId: string,
  userId: string | undefined,
  reports: PrintResultReport[],
): Promise<{ accepted: string[]; rejected: Array<{ clientTaskId: string; reason: string }> }> {
  if (!Array.isArray(reports) || reports.length === 0) {
    throw new AppError(400, 'INVALID_PAYLOAD', 'results 不能为空');
  }
  if (reports.length > 200) {
    throw new AppError(400, 'TOO_MANY_RESULTS', '一次最多补报 200 条');
  }

  const accepted: string[] = [];
  const rejected: Array<{ clientTaskId: string; reason: string }> = [];

  for (const r of reports) {
    try {
      validate(r);
      await upsertOne(tenantId, userId, r);
      accepted.push(r.clientTaskId);
    } catch (e: any) {
      /*
        被拒的也算「处理过了」—— POS 收到 rejected 会把它划掉，不再重试。
        不划掉的话一条永远无法接受的记录会卡在队列里反复重发。
        理由回传给 POS 记日志。
      */
      rejected.push({ clientTaskId: r?.clientTaskId ?? '(缺失)', reason: e?.message ?? String(e) });
    }
  }

  logger.info('[PrintReport] 本机打印结果已补报', {
    tenantId, accepted: accepted.length, rejected: rejected.length,
  });
  return { accepted, rejected };
}

/** 导出只为单测。入参来自 POS，是信任边界，每一条都不能省 */
export function validate(r: PrintResultReport): void {
  // 128 = 库里的列宽。POS 的 id 是 `<orderId>:<ticketType>:<stationId>`，两个 uuid 就 88 字符
  if (!r?.clientTaskId || r.clientTaskId.length > 128) {
    throw new AppError(400, 'INVALID_CLIENT_TASK_ID', `clientTaskId 不合法: ${r?.clientTaskId}`);
  }
  if (!UUID_RE.test(r.orderId || '')) {
    throw new AppError(400, 'INVALID_ORDER_ID', `orderId 不合法: ${r.orderId}`);
  }
  if (!TICKET_TYPES.includes(r.ticketType as any)) {
    throw new AppError(400, 'INVALID_TICKET_TYPE', `ticketType 不合法: ${r.ticketType}`);
  }
  if (r.status !== 'COMPLETED' && r.status !== 'FAILED') {
    throw new AppError(400, 'INVALID_STATUS', `status 只能是 COMPLETED/FAILED，收到 ${r.status}`);
  }
  if (r.stationId && !UUID_RE.test(r.stationId)) {
    throw new AppError(400, 'INVALID_STATION_ID', `stationId 不合法: ${r.stationId}`);
  }
}

async function upsertOne(tenantId: string, userId: string | undefined, r: PrintResultReport): Promise<void> {
  // 订单必须属于本店。不校验的话可以拿别家的 orderId 往自己店里塞记录
  const order = await prisma.order.findFirst({
    where: { id: r.orderId, tenantId },
    select: { id: true },
  });
  if (!order) throw new AppError(404, 'ORDER_NOT_FOUND', `订单不存在或不属于本店: ${r.orderId}`);

  const finishedAt = parseTime(r.finishedAt);
  const isDone = r.status === 'COMPLETED';
  const common = {
    status: r.status as any,
    error: r.error ?? null,
    retryCount: r.retryCount ?? 0,
    deviceId: r.deviceId ?? null,
    completedAt: isDone ? finishedAt : null,
    failedAt: isDone ? null : finishedAt,
  };

  const existing = await prisma.printTask.findUnique({
    where: { tenantId_clientTaskId: { tenantId, clientTaskId: r.clientTaskId } },
    select: { id: true },
  });

  if (existing) {
    await prisma.printTask.update({ where: { id: existing.id }, data: common });
    // PrintRecord 只在首次落 —— 它没有唯一键，重复报会堆出一串假的「打印了 5 次」
    return;
  }

  await prisma.printTask.create({
    data: {
      tenantId,
      orderId: r.orderId,
      ticketType: r.ticketType as any,
      stationId: r.stationId ?? null,
      clientTaskId: r.clientTaskId,
      source: 'POS',
      /*
        payload 空对象：这一列的用途是「把渲染要的数据交给客户端」，
        而这条任务是客户端自己生成、自己打完的，回传一份完整订单快照
        只是白占空间，订单本身库里就有。
      */
      payload: {},
      // POS 本机单不经过服务端推送，sentAt 留空是准确的（服务端从没发过它）
      ...common,
    },
  });

  const recordType = isDone ? RECORD_TYPE[r.ticketType] : undefined;
  if (recordType) {
    await prisma.printRecord.create({
      data: {
        orderId: r.orderId,
        printType: recordType,
        printerName: r.printerName ?? null,
        printedBy: userId ?? null,
        status: 'SUCCESS',
      },
    });
  }
}

/** 客户端时间可能是脏的（时钟错、字段缺）。解析不出来就用服务端时刻，不抛 */
export function parseTime(v?: string): Date {
  if (!v) return new Date();
  const t = new Date(v);
  return isNaN(t.getTime()) ? new Date() : t;
}
