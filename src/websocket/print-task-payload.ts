/**
 * 数据库 PrintTask → 推给 POS 的任务形状。
 *
 * **只有这一个序列化函数。** 原来分发（dispatchPrintTasks）和补拉
 * （FETCH_PENDING）各写了一份字段列表，其中一份漏了 `stationId` ——
 * 于是线上单的厨房单在 POS 上找不到打印机（商家按备餐站绑的机器，
 * 没有站就只能回退到「不带站的绑定」，而那条绑定根本不存在），
 * 表现是「同一个站，POS 的单打得出来、网店的单打不出来」。
 *
 * 少一个字段不会报错，只会让某个来源的单静默打不出来 —— 所以收成一处。
 */

import type { PrintTaskPayloadForClient } from './types';

export function taskToClientPayload(task: any): PrintTaskPayloadForClient {
  return {
    id: task.id,
    orderId: task.orderId,
    ticketType: task.ticketType,
    source: task.source,
    priority: task.priority,
    payload: task.payload,
    createdAt: task.createdAt instanceof Date ? task.createdAt.toISOString() : task.createdAt,
    // 厨房单按备餐站绑打印机，客户端靠它找目标机器
    stationId: task.stationId ?? null,
  };
}
