/**
 * WebSocket 打印队列协议类型定义
 * 与 POS 前端 printer/types.ts 保持一致
 */

import WebSocket from 'ws';

// ========== 消息协议 ==========

export type WSMessageType =
  | 'REGISTER'        // POS → Server: 注册设备
  | 'REGISTER_ACK'    // Server → POS: 注册确认
  | 'PRINT_TASK'      // Server → POS: 新打印任务
  | 'TASK_ACK'        // POS → Server: 已接收任务
  | 'TASK_RESULT'     // POS → Server: 打印结果
  | 'FETCH_PENDING'   // POS → Server: 请求待处理任务
  | 'PENDING_TASKS'   // Server → POS: 待处理任务列表
  | 'DELIVERY_ORDER'          // Server → POS: Uber Direct 新配送订单（需要选择准备时间 → 创建配送单）
  | 'DELIVERY_STATUS_UPDATE'  // Server → POS: Uber Direct 配送状态变更
  | 'THIRD_PARTY_ORDER'       // Server → POS: 第三方平台来单（Uber Eats 等，需要接单/拒单）
  | 'ORDER_STATUS_CHANGED'    // Server → POS: 任意订单状态变更（用于多设备同步）
  | 'PING'            // 心跳请求
  | 'PONG';           // 心跳响应

export interface WSMessage {
  type: WSMessageType;
  timestamp: string;
  [key: string]: any;
}

// POS → Server: 注册设备
export interface WSRegisterMessage extends WSMessage {
  type: 'REGISTER';
  deviceId: string;
  storeId: string;
  token: string;
}

// Server → POS: 注册确认
export interface WSRegisterAckMessage extends WSMessage {
  type: 'REGISTER_ACK';
  success: boolean;
  error?: string;
}

// Server → POS: 新打印任务
export interface WSPrintTaskMessage extends WSMessage {
  type: 'PRINT_TASK';
  task: PrintTaskPayloadForClient;
}

// POS → Server: 已接收任务
export interface WSTaskAckMessage extends WSMessage {
  type: 'TASK_ACK';
  taskId: string;
}

// POS → Server: 打印结果
export interface WSTaskResultMessage extends WSMessage {
  type: 'TASK_RESULT';
  taskId: string;
  status: 'COMPLETED' | 'FAILED';
  error?: string;
}

// POS → Server: 请求待处理任务
export interface WSFetchPendingMessage extends WSMessage {
  type: 'FETCH_PENDING';
  deviceId: string;
}

// Server → POS: 待处理任务列表
export interface WSPendingTasksMessage extends WSMessage {
  type: 'PENDING_TASKS';
  tasks: PrintTaskPayloadForClient[];
}

// ========== 打印任务（发送给客户端的格式） ==========

export type TicketType = 'CUSTOMER_RECEIPT' | 'KITCHEN_TICKET' | 'ITEM_LABEL' | 'CUSTOM_LABEL';
export type PrintTaskSource = 'POS' | 'ONLINE' | 'KIOSK';

// 发送给 POS 客户端的打印任务格式
export interface PrintTaskPayloadForClient {
  id: string;
  orderId: string;
  ticketType: TicketType;
  source: PrintTaskSource;
  priority: number;
  payload: {
    receiptData?: any;
    labelData?: any;
    kitchenData?: any;
    rawData?: any;
  };
  createdAt: string;
  /**
   * 厨房单专用：这张单属于哪个备餐站。
   * 客户端按 (ticketType, stationId) 找打印机 —— 不带的话只能回退到
   * 「不带站的绑定」，而按站配过打印机的商家没有那条绑定。
   */
  stationId?: string | null;
}

// Server → POS: 新配送订单（POS 选择备餐时间后调用 uber service 创建配送单）
export interface WSDeliveryOrderMessage extends WSMessage {
  type: 'DELIVERY_ORDER';
  delivery: {
    orderId: string;
    orderNumber: string;
    tenantId: string;
    customerName: string;
    customerPhone: string;
    dropoffAddress: string;
    dropoffNotes?: string;  // 单元号/buzzer/配送指引（给骑手）
    items: Array<{ name: string; quantity: number }>;
    createdAt: string;
    pickupNumber?: number;   // 取餐号原始数字
    pickupDisplay?: string;  // 取餐号展示文本（带渠道前缀，如 P-42）
  };
}

// Server → POS: 配送状态变更
export interface WSDeliveryStatusUpdateMessage extends WSMessage {
  type: 'DELIVERY_STATUS_UPDATE';
  deliveryId: string;
  orderId?: string;
  status: string;           // pending, pickup, dropoff, delivered, canceled, returned
  courier?: {
    name?: string;
    phone_number?: string;
    vehicle_type?: string;
    location?: { lat: number; lng: number };
  };
  dropoff_eta?: string;
  pickup_eta?: string;
  tracking_url?: string;
  // Uber Direct 取消/无法送达原因，仅在 status 为 canceled/returned 时可能出现
  cancelation_reason?: { primary_reason?: string; secondary_reason?: string };
  undeliverable_reason?: string;
  undeliverable_action?: string;
}

// Server → POS: 第三方平台来单（Uber Eats 等）
// POS 收到后弹窗展示订单内容，员工选择接单或拒单
// 接单/拒单通过 REST API 调用 order-service，order-service 再转发给 uber-service
export interface WSThirdPartyOrderMessage extends WSMessage {
  type: 'THIRD_PARTY_ORDER';
  order: {
    orderId: string;            // order-service 内部订单 ID
    orderNumber: string;        // 系统订单号
    externalOrderId: string;    // 平台订单 ID（如 Uber 的 UUID）
    externalDisplayId: string;  // 平台展示 ID（如 Uber 的 "44BCD"）
    platform: 'UBER_EATS';      // 来源平台（后续支持 DOORDASH 等）
    tenantId: string;
    customerName: string;
    customerPhone: string;
    items: Array<{
      name: string;
      quantity: number;
      unitPrice: number;        // 单价（分）
      specialInstructions?: string;
      modifiers?: Array<{
        groupName: string;
        options: Array<{ name: string; price: number }>;
      }>;
    }>;
    totalAmount: number;        // 总金额（分）
    currency: string;           // "CAD"
    estimatedPickupTime: string; // Uber 预计取货时间 ISO
    timeoutAt: string;           // 必须在此时间前接单，否则超时（ISO）
    createdAt: string;
  };
}

// Server → POS（广播）: 任意订单状态变更
// 用于多设备同步（如设备 A 操作后，设备 B/C 自动刷新）
export interface WSOrderStatusChangedMessage extends WSMessage {
  type: 'ORDER_STATUS_CHANGED';
  orderId: string;              // order-service 内部订单 ID
  orderNumber: string;
  externalOrderId?: string;     // 第三方平台订单 ID（如适用）
  platform?: string;            // 来源平台（如适用）
  status: string;               // 新状态
  previousStatus: string;       // 旧状态
  tenantId: string;
}

// ========== 设备注册表 ==========

export interface ConnectedDevice {
  deviceId: string;
  storeId: string;    // 即 tenantId
  ws: WebSocket;
  registeredAt: Date;
  lastPingAt: Date;
}
