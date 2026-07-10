/**
 * 事件系统入口
 * 导出全局 eventBus 单例 + 注册所有 handler
 */

import { InProcessEventBus } from './event-bus';
import { registerPrintHandler } from './handlers/print.handler';
import { registerDeliveryHandler } from './handlers/delivery.handler';
import { registerSnapshotHandler } from './handlers/snapshot.handler';
import { registerAnalyticsHandler } from './handlers/analytics.handler';
import { registerMemberHandler } from './handlers/member.handler';
import { registerQueueDisplayHandler } from './handlers/queue-display.handler';
import logger from '../utils/logger';

// 全局单例（未来换 RabbitMQ 只改这一行）
export const eventBus = new InProcessEventBus();

export function registerAllHandlers(): void {
  registerPrintHandler(eventBus);
  registerDeliveryHandler(eventBus);
  registerSnapshotHandler(eventBus);
  registerAnalyticsHandler(eventBus);
  registerMemberHandler(eventBus);
  registerQueueDisplayHandler(eventBus);
  logger.info('[EventBus] 所有事件 handler 已注册');
}

export type { IEventBus } from './event-bus';
export type { OrderEvent } from './types';
