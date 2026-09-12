/**
 * 断线重连后「这台设备该补拉哪些任务」。
 *
 * ## 为什么要有这个判断
 * 原来 FETCH_PENDING 是 `WHERE tenant_id = ? AND status IN ('PENDING','SENT')` ——
 * **完全不看是谁在问**。而每台设备注册成功都会调它一次，WS 断线又是家常便饭
 * （休眠、网络抖动、服务重启）。于是设备 B 重连一次，就把定向推给设备 A 的
 * 厨房单拉过来打一遍。
 *
 * 客户端确实有去重（printedCombos），但那是**每台机各存各的**，
 * B 从没打过这张，拦不住 —— 这正是 dispatcher 改成定向推送时要消灭的
 * 「同一张单打好几份」，从补拉这条路又漏了回来。
 *
 * ## 三条规则
 *   1. 有归属的任务只回给**负责设备或它的 fallback**
 *   2. 没归属的任务谁问都给 —— 保持 dispatcher 里广播兜底的语义一致
 *      （归属记录要等 POS 设置界面上报才有，那之前一条都没有）
 *   3. SENT 只有**超时**的才回收。没超时说明那台机正拿着打（10 张标签慢慢出），
 *      这时候给第二台就是重复出单
 *
 * 外加一条时间闸：太老的不补。厨房单隔了几小时再印出来是噪音，
 * 而且会让厨师以为来了新单 —— 原来那个查询一条时间过滤都没有，
 * 设备离线一天再上线会把一整天的票吐出来。
 */

/** SENT 多久没回报就认为那台设备没打成（崩溃、断电、进程被杀） */
export const SENT_TIMEOUT_MS = 3 * 60_000;

/**
 * 超过这个时长的任务不再补印。
 *
 * ponytail: 固定 2 小时，不按票据类型分。真要精细的话收据可以更长
 * （补打小票有意义）、厨房单该更短（菜早做完了），等有人抱怨再拆。
 */
export const MAX_REPRINT_AGE_MS = 2 * 60 * 60_000;

export interface SelectableTask {
  id: string;
  status: string;
  /** `station:<id>` | `ticket:<type>`，由 assignmentScope 算出来 */
  scope: string;
  /** 已经推给过哪台设备（PENDING 时为空） */
  deviceId?: string | null;
  sentAt?: Date | null;
  createdAt: Date;
}

export interface ScopeOwner {
  deviceId: string;
  fallbackDeviceId?: string | null;
}

/**
 * 挑出该回给这台设备的任务。
 *
 * @param assignments scope → 负责设备。查不到 = 这个 scope 没登记过归属
 */
export function selectTasksForDevice<T extends SelectableTask>(
  tasks: T[],
  assignments: Map<string, ScopeOwner>,
  deviceId: string,
  now: number = Date.now(),
): T[] {
  return tasks.filter((task) => {
    // 太老的不补印
    if (now - task.createdAt.getTime() > MAX_REPRINT_AGE_MS) return false;

    const owner = assignments.get(task.scope);
    /*
      没登记归属 → 谁问都给。这一条是**升级期必需**：归属记录要等 POS
      设置界面上报才有，切断的话那些店会一张都补不回来。
      代价是这类任务仍可能被两台机同时领走 —— 和 dispatcher 的广播兜底
      同一个取舍，等归属全量登记后两处一起收。
    */
    const mine = !owner || owner.deviceId === deviceId || owner.fallbackDeviceId === deviceId;
    if (!mine) return false;

    if (task.status === 'PENDING') return true;

    if (task.status === 'SENT') {
      /*
        没超时就不动它 —— 那台机正拿着打。
        sentAt 为空属于脏数据（正常路径一定会写），按超时处理：
        宁可多打一张，也不要一张永远卡在 SENT 没人管。
      */
      const sentAgo = task.sentAt ? now - task.sentAt.getTime() : Infinity;
      return sentAgo > SENT_TIMEOUT_MS;
    }

    return false;
  });
}
