/**
 * 订单事件类型定义
 * 所有订单状态变更通过事件驱动副作用（打印、配送、分析等）
 */

// 所有事件的基础接口
export interface BaseEvent {
  eventId: string;
  type: string;
  timestamp: Date;
  tenantId: string;
  orderId: string;
  orderNumber: string;
}

// 订单已创建（POS/KIOSK，可能直接 PAID）
export interface OrderCreatedEvent extends BaseEvent {
  type: 'ORDER_CREATED';
  clientOrigin: string;
  orderType: string;
  paymentStatus: string;
  items: any[];       // 原始 CreateOrderItem[]
  order: any;         // 完整 order 对象（含 orderItems）
}

// 从快照创建订单（Webhook 路径，支付已成功）
export interface OrderCreatedFromSnapshotEvent extends BaseEvent {
  type: 'ORDER_CREATED_FROM_SNAPSHOT';
  snapshotId: string;
  snapshotItems: any[];
  order: any;
}

// 临时订单已创建（支付前，PENDING 状态）
export interface TemporaryOrderCreatedEvent extends BaseEvent {
  type: 'TEMPORARY_ORDER_CREATED';
  snapshotId: string;
  snapshotItems: any[];
  order: any;
  skipModifiers: boolean;
}

// 订单支付成功
export interface OrderPaidEvent extends BaseEvent {
  type: 'ORDER_PAID';
  clientOrigin: string;
  orderType: string;
  /**
   * 谁负责配送（见 Order.deliveryProvider）。只有 MERCHANT 才要去叫 Uber Direct 骑手。
   *
   * 必须带在事件里而不是让消费者按 orderType 猜：平台单同样是 DELIVERY，
   * 单靠 orderType 判断会让平台单支付成功后也去下 Uber 配送单。
   */
  deliveryProvider?: 'MERCHANT' | 'PLATFORM' | null;
  previousStatus: string;     // 旧的 order.status（判断 PENDING → CONFIRMED）
  paymentIntentId?: string;
  snapshot?: any;             // 快照数据（含 deliveryAddress）
  memberId?: string | null;   // 会员 ID（用于在线订单支付后立即加积分）
  subtotal?: number;                // 税前小计（不含 tax/tip/配送费），单位：分,折扣前
  discountAmount?: number;          // 订单层折扣总额(包含会员券折扣)，单位:分
  channelDiscountAmount?: number;   // 渠道折扣，单位：分
  totalAmount?: number;             // 订单总额，单位：分
  paymentMethod?: string;           // 支付方式
  grantedRewardId?: string | null;
}

// 订单已完成（触发积分累积等副作用）
export interface OrderCompletedEvent extends BaseEvent {
  type: 'ORDER_COMPLETED';
  memberId: string | null;
  subtotal: number;
  discountAmount?: number;
  channelDiscountAmount?: number;   // 渠道折扣，单位：分
  totalAmount: number;
  clientOrigin: string;
  paymentStatus: string;
  paymentMethod?: string;
  grantedRewardId?: string | null;
}

// 事件联合类型
export type OrderEvent =
  | OrderCreatedEvent
  | OrderCreatedFromSnapshotEvent
  | TemporaryOrderCreatedEvent
  | OrderPaidEvent
  | OrderCompletedEvent;
