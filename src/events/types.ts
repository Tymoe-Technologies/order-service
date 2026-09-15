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
  /**
   * 耗材小计（分）。subtotal 里含着它，算积分时要减掉 ——
   * 餐具/购物袋是按份收的成本转嫁，不是拿来做促销也不该攒分的商品。
   * 和折扣口径一致（见 POS 的 calculateOrderTax：耗材行折扣比例恒为 1）。
   */
  supplySubtotal?: number;
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
  /** 耗材小计（分）。算积分时要从 subtotal 里减掉，理由见 OrderPaidEvent */
  supplySubtotal?: number;
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

/**
 * 「把这张券标掉」。
 *
 * 为什么要一个**专门**的事件，而不是复用 ORDER_PAID：
 * 挂账 / 平台单建单即 PAID，从不走 updatePaymentStatus，所以 ORDER_PAID
 * 这类单压根不发。而补发一个 ORDER_PAID 会顺带唤醒打印、配送、finance
 * 那一串 handler —— 那些在建单流程里已经各自做过了，再跑一遍是重复。
 *
 * 拆成独立事件，投递范围就正好是「核销这一件事」。
 */
export interface CouponUseRequestedEvent extends BaseEvent {
  type: 'COUPON_USE_REQUESTED';
  grantedRewardId: string;
}

/**
 * 「把这张券退回去」。整单取消 / 全额退款时发。
 *
 * 和核销走同一套发件箱：直接 fetch 是 fire-and-forget，member-service
 * 那一刻不可达就永久丢了，顾客白搭一张券。
 *
 * 有效期由 member-service 按「被占用的时长」补偿，这里不用带。
 */
export interface CouponRestoreRequestedEvent extends BaseEvent {
  type: 'COUPON_RESTORE_REQUESTED';
  grantedRewardId: string;
}

/**
 * 「把这单的积分冲掉」。整单取消 / 全额退款时发。
 *
 * 和券退回同一个道理：只有真给了钱才该有积分，钱退了分就不该留着，
 * 否则能反复刷。member-service 那边是**定点作废那个批次**
 * （见 reversePointsForOrder），所以这里不用带金额。
 */
export interface PointsReverseRequestedEvent extends BaseEvent {
  type: 'POINTS_REVERSE_REQUESTED';
  memberId: string;
}

// 事件联合类型
export type OrderEvent =
  | OrderCreatedEvent
  | OrderCreatedFromSnapshotEvent
  | TemporaryOrderCreatedEvent
  | OrderPaidEvent
  | OrderCompletedEvent
  | CouponUseRequestedEvent
  | CouponRestoreRequestedEvent
  | PointsReverseRequestedEvent;
