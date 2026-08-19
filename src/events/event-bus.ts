/**
 * Event Bus 抽象 + 进程内实现
 * 当前：InProcessEventBus（零依赖，同进程异步执行）
 * 未来：替换为 RabbitMQEventBus（只改一行初始化代码，handler 不动）
 */

import logger from '../utils/logger';
import type { OrderEvent } from './types';

export type EventHandler<T = OrderEvent> = (event: T) => Promise<void>;

// Event Bus 接口（未来 RabbitMQ 实现只需实现此接口）
export interface IEventBus {
  emit(event: OrderEvent): void;
  on(eventType: string, handler: EventHandler, name?: string): void;
  handlerNamesFor(eventType: string): string[];
  runHandler(name: string, event: OrderEvent): Promise<void>;
}

/**
 * 进程内 Event Bus
 * - emit() fire-and-forget，不阻塞调用方
 * - 每个 handler 独立执行，一个失败不影响其他
 * - 所有异常只记录日志，不向上抛出
 */
export class InProcessEventBus implements IEventBus {
  private handlers = new Map<string, Array<{ name: string; fn: EventHandler }>>();

  emit(event: OrderEvent): void {
    const list = this.handlers.get(event.type) || [];
    if (list.length === 0) return;

    // fire-and-forget：不阻塞调用方
    Promise.allSettled(
      list.map(({ name, fn }) =>
        fn(event).catch(err => {
          logger.error(`[EventBus] Handler failed for ${event.type}`, {
            handler: name,
            eventId: event.eventId,
            orderId: event.orderId,
            error: err instanceof Error ? err.message : String(err),
          });
        })
      )
    );
  }

  /**
   * @param name 用于**通知板**按 handler 拆行和重投。不给就退回函数名，
   *   但匿名箭头函数的 name 是空串 —— 那样重投时对不上，所以注册时应当显式给。
   */
  on(eventType: string, handler: EventHandler, name?: string): void {
    const list = this.handlers.get(eventType) || [];
    list.push({ name: name || handler.name || `anon_${list.length}`, fn: handler });
    this.handlers.set(eventType, list);
  }

  /** 这个事件类型上挂了哪些 handler。入板时按它拆行 */
  handlerNamesFor(eventType: string): string[] {
    return (this.handlers.get(eventType) || []).map(h => h.name);
  }

  /**
   * 只跑指定的那一个 handler，**异常向上抛**。
   *
   * 和 emit 的区别是这两点：emit 是 fire-and-forget + 吞异常（调用方不等结果），
   * 而通知板需要知道成没成才能决定标记还是重投；而且必须能只重投失败的那个，
   * 不能整批重跑 —— 否则已经成功的 handler（比如加积分）会再执行一遍。
   */
  async runHandler(name: string, event: OrderEvent): Promise<void> {
    const found = (this.handlers.get(event.type) || []).find(h => h.name === name);
    if (!found) {
      // handler 被改名或删了，而板上还有它的待办。抛出去让 relay 记错误，人来处理
      throw new Error(`未注册的 handler：${name}（事件 ${event.type}）`);
    }
    await found.fn(event);
  }
}
