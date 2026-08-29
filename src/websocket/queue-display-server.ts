/**
 * 叫号屏 WebSocket 服务器
 * 路径: /ws/queue-display
 *
 * 叫号屏连接后通过 X-Device-ID / X-Session-Token 认证，
 * 订单状态变更时广播给对应租户的所有叫号屏。
 */

import { WebSocketServer, WebSocket } from 'ws';
import { IN_STORE_PICKUP_TYPES, isInStorePickup } from '../services/fulfillment-option.service';
import { Server, IncomingMessage } from 'http';
import logger from '../utils/logger';
import prisma from '../utils/prisma';

// 叫号屏活跃订单的滚动时间窗口（小时）。
// 只显示这个窗口内创建的进行中订单，避免跨午夜误伤又能挡掉昨天的旧数据。
const ACTIVE_WINDOW_HOURS = 6;

interface DisplayClient {
  ws: WebSocket;
  deviceId: string;
  tenantId: string;
  connectedAt: Date;
}

// tenantId -> DisplayClient[]
const displayClients = new Map<string, DisplayClient[]>();

let wss: WebSocketServer | null = null;

/**
 * 初始化叫号屏 WebSocket 服务器
 */
export function initQueueDisplayServer(httpServer: Server): void {
  wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (request: IncomingMessage, socket, head) => {
    const url = new URL(request.url || '', `http://${request.headers.host}`);
    if (url.pathname !== '/ws/queue-display') return;

    wss!.handleUpgrade(request, socket, head, (ws) => {
      wss!.emit('connection', ws, request);
    });
  });

  wss.on('connection', async (ws: WebSocket, request: IncomingMessage) => {
    const url = new URL(request.url || '', `http://${request.headers.host}`);
    const deviceId = url.searchParams.get('deviceId');
    const sessionToken = url.searchParams.get('sessionToken');

    if (!deviceId || !sessionToken) {
      ws.close(4001, 'Missing deviceId or sessionToken');
      return;
    }

    // 验证设备 session
    const tenantId = await validateDeviceSession(deviceId, sessionToken);
    if (!tenantId) {
      ws.close(4003, 'Invalid device session');
      return;
    }

    // 注册客户端
    const client: DisplayClient = { ws, deviceId, tenantId, connectedAt: new Date() };
    if (!displayClients.has(tenantId)) {
      displayClients.set(tenantId, []);
    }
    displayClients.get(tenantId)!.push(client);

    logger.info('[QueueDisplay] 叫号屏已连接', { deviceId, tenantId });

    // 发送当前活跃订单
    await sendActiveOrders(ws, tenantId);

    // 心跳
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'PING') {
          ws.send(JSON.stringify({ type: 'PONG', timestamp: new Date().toISOString() }));
        }
      } catch {}
    });

    ws.on('close', () => {
      const clients = displayClients.get(tenantId);
      if (clients) {
        const idx = clients.indexOf(client);
        if (idx >= 0) clients.splice(idx, 1);
        if (clients.length === 0) displayClients.delete(tenantId);
      }
      logger.info('[QueueDisplay] 叫号屏已断开', { deviceId, tenantId });
    });

    ws.on('error', (err) => {
      logger.error('[QueueDisplay] 连接错误', { deviceId, error: err.message });
    });
  });

  logger.info('[QueueDisplay] 叫号屏 WebSocket 服务已启动', { path: '/ws/queue-display' });
}

/**
 * 验证设备 session，返回 tenantId
 */
async function validateDeviceSession(deviceId: string, sessionToken: string): Promise<string | null> {
  try {
    const AUTH_BASE_URL = process.env.AUTH_SERVICE_URL || 'http://localhost:8081';
    const response = await fetch(`${AUTH_BASE_URL}/api/auth-service/v1/devices/me/validate-session`, {
      headers: {
        'X-Device-ID': deviceId,
        'X-Session-Token': sessionToken,
      },
    });

    if (!response.ok) return null;

    const data = await response.json() as any;
    return data.device?.orgId || null;
  } catch (err: any) {
    logger.error('[QueueDisplay] 验证设备 session 失败', { deviceId, error: err.message });
    return null;
  }
}

/**
 * 发送当前活跃订单（制作中 + 待取餐）
 */
async function sendActiveOrders(ws: WebSocket, tenantId: string): Promise<void> {
  try {
    // 滚动时间窗口：只显示最近 N 小时内创建的活跃订单。
    // 用滚动窗口而非自然日，避免跨午夜误伤（如 23:58 下单凌晨还没取）；
    // 同时挡掉重启/重连时把昨天卡住的旧单拉出来。
    const windowStart = new Date(Date.now() - ACTIVE_WINDOW_HOURS * 60 * 60 * 1000);

    const orders = await prisma.order.findMany({
      where: {
        tenantId,
        status: { in: ['CONFIRMED', 'PREPARING', 'READY'] },
        createdAt: { gte: windowStart },
        // 只显示顾客在店内等餐的单。用白名单而不是「排除 DELIVERY」：
        // 黑名单模式下新加的履约方式会默认混进叫号屏 —— 路边取餐就这么错进来过，
        // 而那些顾客坐在车里，根本看不到这块屏幕
        orderType: { in: [...IN_STORE_PICKUP_TYPES] },
        orderSource: { not: 'UBER_EATS' },
      },
      select: {
        id: true,
        orderNumber: true,
        pickupNumber: true,
        status: true,
        customerName: true,
        customerPhone: true,
        memberId: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    ws.send(JSON.stringify({
      type: 'orders:sync',
      orders: orders.map(formatOrder),
      timestamp: new Date().toISOString(),
    }));
  } catch (err: any) {
    logger.error('[QueueDisplay] 发送活跃订单失败', { error: err.message });
  }
}

/**
 * 广播订单状态变更给对应租户的叫号屏
 */
export function broadcastOrderUpdate(tenantId: string, order: any): void {
  const clients = displayClients.get(tenantId);
  if (!clients || clients.length === 0) return;

  // 与上面的查询同一套口径：只有店内等餐的单才推给叫号屏。
  // 路边取餐的顾客在车里，配送的顾客压根不在店里，推给他们看不到的屏幕没有意义
  if (!isInStorePickup(order.orderType) || order.orderSource === 'UBER_EATS') return;

  const message = JSON.stringify({
    type: 'order:update',
    order: formatOrder(order),
    timestamp: new Date().toISOString(),
  });

  let sent = 0;
  for (const client of clients) {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(message);
      sent++;
    }
  }

  if (sent > 0) {
    logger.info('[QueueDisplay] 广播订单更新', {
      tenantId,
      orderNumber: order.orderNumber,
      status: order.status,
      displays: sent,
    });
  }
}

function formatOrder(order: any) {
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    pickupNumber: order.pickupNumber || null,
    status: order.status,
    customerName: order.customerName || null,
    customerPhone: order.customerPhone || null,
    memberId: order.memberId || null,
    createdAt: order.createdAt instanceof Date ? order.createdAt.toISOString() : order.createdAt,
  };
}
