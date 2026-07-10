/**
 * WebSocket 打印队列服务器
 * 路径: /ws/print-queue
 *
 * 处理 POS 设备的连接、注册、心跳、打印任务分发
 */

import { WebSocketServer, WebSocket } from 'ws';
import { Server } from 'http';
import jwt from 'jsonwebtoken';
import logger from '../utils/logger';
import prisma from '../utils/prisma';
import { jwksClient } from '../utils/jwks';
import { deviceRegistry } from './device-registry';
import type {
  WSMessage,
  WSRegisterMessage,
  WSTaskAckMessage,
  WSTaskResultMessage,
  WSFetchPendingMessage,
  PrintTaskPayloadForClient,
} from './types';

let wss: WebSocketServer | null = null;

/**
 * 初始化 WebSocket 服务器，挂载到 HTTP Server
 */
export function initWebSocketServer(httpServer: Server): WebSocketServer {
  wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url || '', `http://${request.headers.host}`);
    if (url.pathname !== '/ws/print-queue') return;

    wss!.handleUpgrade(request, socket, head, (ws) => {
      wss!.emit('connection', ws, request);
    });
  });

  wss.on('connection', (ws: WebSocket) => {
    logger.info('[WS] 新连接');

    // 60s 内必须完成 REGISTER，否则关闭
    const authTimeout = setTimeout(() => {
      logger.warn('[WS] 认证超时，关闭连接');
      ws.close(4001, 'Authentication timeout');
    }, 60_000);

    ws.on('message', (data) => {
      try {
        const msg: WSMessage = JSON.parse(data.toString());
        handleMessage(ws, msg, authTimeout);
      } catch (e: any) {
        logger.error('[WS] 消息解析失败', { error: e.message });
      }
    });

    ws.on('close', (code, reason) => {
      clearTimeout(authTimeout);
      const device = deviceRegistry.getDeviceByWs(ws);
      if (device) {
        logger.info('[WS] 设备断开连接', {
          deviceId: device.deviceId,
          storeId: device.storeId,
          code,
          reason: reason.toString(),
        });
      }
      deviceRegistry.unregister(ws);
    });

    ws.on('error', (err) => {
      logger.error('[WS] 连接错误', { error: err.message });
    });
  });

  logger.info('[WS] WebSocket 打印队列服务已启动', { path: '/ws/print-queue' });
  return wss;
}

/**
 * 获取 WebSocket Server 实例（供外部分发任务使用）
 */
export function getWss(): WebSocketServer | null {
  return wss;
}

/**
 * 关闭 WebSocket 服务器
 */
export function closeWebSocketServer(): Promise<void> {
  return new Promise((resolve) => {
    if (!wss) {
      resolve();
      return;
    }

    // 向所有客户端发送关闭消息
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.close(1001, 'Server shutting down');
      }
    });

    wss.close(() => {
      logger.info('[WS] WebSocket 服务已关闭');
      wss = null;
      resolve();
    });
  });
}

// ========== 消息路由 ==========

function handleMessage(ws: WebSocket, msg: WSMessage, authTimeout: NodeJS.Timeout): void {
  switch (msg.type) {
    case 'REGISTER':
      handleRegister(ws, msg as WSRegisterMessage, authTimeout);
      break;
    case 'PING':
      handlePing(ws);
      break;
    case 'TASK_ACK':
      handleTaskAck(msg as WSTaskAckMessage);
      break;
    case 'TASK_RESULT':
      handleTaskResult(msg as WSTaskResultMessage);
      break;
    case 'FETCH_PENDING':
      handleFetchPending(ws, msg as WSFetchPendingMessage);
      break;
    default:
      logger.warn('[WS] 未知消息类型', { type: msg.type });
  }
}

// ========== REGISTER ==========

async function handleRegister(
  ws: WebSocket,
  msg: WSRegisterMessage,
  authTimeout: NodeJS.Timeout,
): Promise<void> {
  try {
    const { deviceId, storeId, token } = msg;

    if (!deviceId || !storeId) {
      sendMessage(ws, {
        type: 'REGISTER_ACK',
        success: false,
        error: 'Missing deviceId or storeId',
        timestamp: new Date().toISOString(),
      });
      ws.close(4003, 'Missing required fields');
      return;
    }

    // 验证 JWT token
    if (token) {
      try {
        await verifyToken(token, storeId);
      } catch (err: any) {
        const errMsg = err.message || '';
        // 区分：token 本身无效 vs JWKS 拉取失败（网络/服务不可达）
        const isTokenInvalid =
          errMsg.includes('invalid signature') ||
          errMsg.includes('jwt expired') ||
          errMsg.includes('Store ID mismatch') ||
          errMsg.includes('malformed') ||
          errMsg.includes('invalid token');

        if (isTokenInvalid) {
          // token 真的有问题，拒绝连接
          logger.warn('[WS] Token 无效，拒绝注册', { deviceId, error: errMsg });
          sendMessage(ws, {
            type: 'REGISTER_ACK',
            success: false,
            error: 'Invalid token',
            timestamp: new Date().toISOString(),
          });
          ws.close(4003, 'Invalid token');
          return;
        } else {
          // JWKS 拉取失败等网络问题，允许连接但记录警告
          logger.warn('[WS] Token 验证跳过（JWKS 不可达），设备已允许注册', { deviceId, error: errMsg });
        }
      }
    }

    // 注册设备
    clearTimeout(authTimeout);
    deviceRegistry.register(deviceId, storeId, ws);

    sendMessage(ws, {
      type: 'REGISTER_ACK',
      success: true,
      timestamp: new Date().toISOString(),
    });

    logger.info('[WS] 设备注册成功', { deviceId, storeId });
  } catch (err: any) {
    logger.error('[WS] 注册处理异常', { error: err.message });
    sendMessage(ws, {
      type: 'REGISTER_ACK',
      success: false,
      error: 'Internal server error',
      timestamp: new Date().toISOString(),
    });
  }
}

// ========== PING / PONG ==========

function handlePing(ws: WebSocket): void {
  deviceRegistry.updatePing(ws);
  sendMessage(ws, {
    type: 'PONG',
    timestamp: new Date().toISOString(),
  });
}

// ========== TASK_ACK ==========

async function handleTaskAck(msg: WSTaskAckMessage): Promise<void> {
  const { taskId } = msg;
  if (!taskId) return;

  try {
    await prisma.printTask.update({
      where: { id: taskId },
      data: {
        status: 'RECEIVED',
        receivedAt: new Date(),
      },
    });
    logger.info('[WS] 任务已确认接收', { taskId });
  } catch (err: any) {
    logger.error('[WS] 更新任务 ACK 失败', { taskId, error: err.message });
  }
}

// ========== TASK_RESULT ==========

async function handleTaskResult(msg: WSTaskResultMessage): Promise<void> {
  const { taskId, status, error } = msg;
  if (!taskId) return;

  // ticketType → printType 映射
  const TICKET_TO_PRINT_TYPE: Record<string, string> = {
    CUSTOMER_RECEIPT: 'RECEIPT',
    KITCHEN_TICKET:   'KITCHEN_TICKET',
    ITEM_LABEL:       'LABEL',
    CUSTOM_LABEL:     'LABEL',
    DAILY_REPORT:     'DAILY_REPORT',
    SHIFT_REPORT:     'SHIFT_REPORT',
  };

  try {
    if (status === 'COMPLETED') {
      // 查询任务详情，用于创建打印记录
      const task = await prisma.printTask.findUnique({ where: { id: taskId } });

      await prisma.printTask.update({
        where: { id: taskId },
        data: {
          status: 'COMPLETED',
          completedAt: new Date(),
        },
      });

      // 创建打印记录（WEB/KIOSK 订单通过 WebSocket 打印的记录）
      if (task) {
        const printType = TICKET_TO_PRINT_TYPE[task.ticketType] || 'RECEIPT';
        await prisma.printRecord.create({
          data: {
            orderId:     task.orderId,
            printType:   printType as any,
            printerName: task.deviceId || null,
            printedBy:   null,   // 系统自动打印，无用户
            status:      'SUCCESS',
          },
        });
      }

      logger.info('[WS] 打印任务完成，已写入打印记录', { taskId });
    } else if (status === 'FAILED') {
      // 查询任务详情，用于创建失败记录
      const task = await prisma.printTask.findUnique({ where: { id: taskId } });

      await prisma.printTask.update({
        where: { id: taskId },
        data: {
          status: 'FAILED',
          failedAt: new Date(),
          error: error || 'Unknown error',
        },
      });

      // 创建失败打印记录
      if (task) {
        const printType = TICKET_TO_PRINT_TYPE[task.ticketType] || 'RECEIPT';
        await prisma.printRecord.create({
          data: {
            orderId:     task.orderId,
            printType:   printType as any,
            printerName: task.deviceId || null,
            printedBy:   null,
            status:      'FAILED',
          },
        });
      }

      logger.warn('[WS] 打印任务失败，已写入失败记录', { taskId, error });
    }
  } catch (err: any) {
    logger.error('[WS] 更新任务结果失败', { taskId, error: err.message });
  }
}

// ========== FETCH_PENDING ==========

async function handleFetchPending(ws: WebSocket, _msg: WSFetchPendingMessage): Promise<void> {
  const device = deviceRegistry.getDeviceByWs(ws);
  if (!device) {
    logger.warn('[WS] 未注册设备请求 PENDING 任务');
    return;
  }

  try {
    // 查询该租户的待处理任务
    const pendingTasks = await prisma.printTask.findMany({
      where: {
        tenantId: device.storeId,
        status: { in: ['PENDING', 'SENT'] },
      },
      orderBy: [
        { priority: 'asc' },
        { createdAt: 'asc' },
      ],
      take: 50, // 限制一次最多返回 50 个
    });

    // 转换为客户端格式
    const tasks: PrintTaskPayloadForClient[] = pendingTasks.map(taskToClientPayload);

    sendMessage(ws, {
      type: 'PENDING_TASKS',
      tasks,
      timestamp: new Date().toISOString(),
    });

    // 更新这些任务状态为 SENT
    if (pendingTasks.length > 0) {
      const taskIds = pendingTasks.filter(t => t.status === 'PENDING').map(t => t.id);
      if (taskIds.length > 0) {
        await prisma.printTask.updateMany({
          where: { id: { in: taskIds } },
          data: { status: 'SENT', sentAt: new Date(), deviceId: device.deviceId },
        });
      }
    }

    logger.info('[WS] 返回待处理任务', {
      deviceId: device.deviceId,
      count: pendingTasks.length,
    });
  } catch (err: any) {
    logger.error('[WS] 查询 PENDING 任务失败', { error: err.message });
  }
}

// ========== 工具函数 ==========

/**
 * 发送 WebSocket 消息
 */
export function sendMessage(ws: WebSocket, msg: WSMessage): boolean {
  if (ws.readyState !== WebSocket.OPEN) return false;
  try {
    ws.send(JSON.stringify(msg));
    return true;
  } catch (e: any) {
    logger.error('[WS] 发送消息失败', { error: e.message });
    return false;
  }
}

/**
 * 验证 JWT token，并校验 storeId 与 token 中的组织匹配
 *
 * JWT 结构（auth-service）：
 *   ACCOUNT 用户（POS 员工）→ decoded.organization.id
 *   USER 用户（多组织管理）  → decoded.organizations[].id
 *   CONSUMER               → decoded.organizationId（旧格式兜底）
 */
async function verifyToken(token: string, expectedStoreId: string): Promise<void> {
  let publicKey = process.env.JWT_PUBLIC_KEY;
  if (!publicKey) {
    publicKey = await jwksClient.getPublicKey();
  }

  const decoded = jwt.verify(token, publicKey, {
    algorithms: ['RS256'],
  }) as any;

  // 提取 token 中所有关联的组织 ID
  const allOrgIds: string[] = [];

  // ACCOUNT 用户：organization.id（POS 员工最常见场景）
  if (decoded.organization?.id) {
    allOrgIds.push(decoded.organization.id);
  }

  // USER 用户：organizations[]（多组织管理员）
  if (Array.isArray(decoded.organizations)) {
    for (const org of decoded.organizations) {
      if (org?.id && !allOrgIds.includes(org.id)) {
        allOrgIds.push(org.id);
      }
    }
  }

  // 旧格式兜底：organizationId（CONSUMER 或早期版本）
  if (decoded.organizationId && !allOrgIds.includes(decoded.organizationId)) {
    allOrgIds.push(decoded.organizationId);
  }

  // 如果 token 中没有任何组织信息，允许连接（避免意外封锁合法设备）
  if (allOrgIds.length === 0) {
    return;
  }

  // 验证 storeId 必须在 token 允许的组织列表内
  if (!allOrgIds.includes(expectedStoreId)) {
    throw new Error(`Store ID mismatch: expected ${expectedStoreId}, token orgs=[${allOrgIds.join(',')}]`);
  }
}

/**
 * 将数据库 PrintTask 转换为客户端格式
 */
function taskToClientPayload(task: any): PrintTaskPayloadForClient {
  return {
    id: task.id,
    orderId: task.orderId,
    ticketType: task.ticketType,
    source: task.source,
    priority: task.priority,
    payload: task.payload as any,
    createdAt: task.createdAt.toISOString(),
  };
}
