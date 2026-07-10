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
  on(eventType: string, handler: EventHandler): void;
}

/**
 * 进程内 Event Bus
 * - emit() fire-and-forget，不阻塞调用方
 * - 每个 handler 独立执行，一个失败不影响其他
 * - 所有异常只记录日志，不向上抛出
 */
export class InProcessEventBus implements IEventBus {
  private handlers = new Map<string, EventHandler[]>();

  emit(event: OrderEvent): void {
    const list = this.handlers.get(event.type) || [];
    if (list.length === 0) return;

    // fire-and-forget：不阻塞调用方
    Promise.allSettled(
      list.map(handler =>
        handler(event).catch(err => {
          logger.error(`[EventBus] Handler failed for ${event.type}`, {
            eventId: event.eventId,
            orderId: event.orderId,
            error: err instanceof Error ? err.message : String(err),
          });
        })
      )
    );
  }

  on(eventType: string, handler: EventHandler): void {
    const list = this.handlers.get(eventType) || [];
    list.push(handler);
    this.handlers.set(eventType, list);
  }
}
