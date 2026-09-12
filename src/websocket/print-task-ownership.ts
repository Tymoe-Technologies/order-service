/**
 * POS 单：哪些票**不该**由下单那台机自己打。
 *
 * ## 背景
 * 原来 POS 单完全不经过服务端（print.handler 里 `clientOrigin === 'POS'` 直接
 * return），全靠下单那台机本地绑定。于是备餐站的打印机挂在设备 A 上时，
 * 从设备 B 下的单打不到 A —— 要么落到 B 自己某台厨房打印机上，
 * 要么 B 一台都没配就是「No printer bound」，那几个菜不出票。
 *
 * 现在 POS 单也生成任务，但**只生成下单设备打不了的那些**，
 * 由 dispatcher 定向推给负责的设备。下单设备自己负责的仍然本地打
 * —— 这条很重要：后端挂了它照样出票。
 *
 * ## 两端必须用同一条规则
 * POS 那边（localPrintTasks）判的是「这个 scope 归不归我」，
 * 这边判的是它的补集。两边错开一点就是**重复出单**或**漏单**，
 * 所以规则只有一句，两边各自钉一条测试：
 *
 *   归属存在 且 归属设备 ≠ 下单设备  →  服务端生成，定向推
 *   其余（没登记归属 / 归属就是自己）→  下单设备本地打
 *
 * ## 收据和标签永远不转交
 * 收据要从顾客面前那台出，标签贴在下单那台旁边。哪怕它们也登记了归属
 * （设置界面对每种票据都会上报），POS 单的这两类也一律本地。
 * 非 POS 来源（Web/Uber）不走这里，仍然按归属定向推 —— 那时候
 * 「顾客面前那台」不存在，收据本来就该去登记的那台。
 */

import { assignmentScope } from '../services/print-routing';

/** 只有厨房单可以转交给别的设备 */
const TRANSFERABLE = new Set(['KITCHEN_TICKET']);

export interface OwnableTask {
  ticketType: string;
  stationId?: string | null;
}

/**
 * 从一单的全部任务里，挑出**要交给别的设备**的那些。
 *
 * @param assignments scope → 负责设备码
 * @param orderDeviceId 下单设备码。为空表示不知道是谁开的单 ——
 *   那时候一张都不转交（调用方也应该先拦住，见 print.handler）
 */
export function tasksForOtherDevices<T extends OwnableTask>(
  tasks: T[],
  assignments: Map<string, string>,
  orderDeviceId: string | null | undefined,
): T[] {
  if (!orderDeviceId) return [];
  return tasks.filter((t) => {
    if (!TRANSFERABLE.has(t.ticketType)) return false;
    const owner = assignments.get(assignmentScope(t as any));
    return !!owner && owner !== orderDeviceId;
  });
}
