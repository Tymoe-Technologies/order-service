/**
 * 设备注册表（内存管理）
 * 管理已连接的 POS 设备，按 storeId(tenantId) 索引
 */

import WebSocket from 'ws';
import logger from '../utils/logger';
import { ConnectedDevice } from './types';

class DeviceRegistry {
  // deviceId -> 设备信息
  private deviceMap: Map<string, ConnectedDevice> = new Map();
  // storeId -> deviceId 集合
  private storeMap: Map<string, Set<string>> = new Map();
  // ws 引用 -> deviceId（用于连接关闭时反查）
  private wsMap: Map<WebSocket, string> = new Map();

  /**
   * 注册设备
   * 如果该 deviceId 已有旧连接，先关闭旧连接
   */
  register(deviceId: string, storeId: string, ws: WebSocket): void {
    // 如果已存在旧连接，先清理
    const existing = this.deviceMap.get(deviceId);
    if (existing) {
      logger.warn('[DeviceRegistry] 设备重复注册，关闭旧连接', { deviceId, storeId });
      this.removeDevice(existing);
      try {
        existing.ws.close(4002, 'Replaced by new connection');
      } catch {
        // 忽略关闭错误
      }
    }

    const device: ConnectedDevice = {
      deviceId,
      storeId,
      ws,
      registeredAt: new Date(),
      lastPingAt: new Date(),
    };

    // 双向索引
    this.deviceMap.set(deviceId, device);
    this.wsMap.set(ws, deviceId);

    if (!this.storeMap.has(storeId)) {
      this.storeMap.set(storeId, new Set());
    }
    this.storeMap.get(storeId)!.add(deviceId);

    logger.info('[DeviceRegistry] 设备已注册', {
      deviceId,
      storeId,
      totalDevices: this.deviceMap.size,
      storeDevices: this.storeMap.get(storeId)!.size,
    });
  }

  /**
   * 注销设备（连接断开时调用）
   */
  unregister(ws: WebSocket): void {
    const deviceId = this.wsMap.get(ws);
    if (!deviceId) return;

    const device = this.deviceMap.get(deviceId);
    if (device) {
      this.removeDevice(device);
      logger.info('[DeviceRegistry] 设备已注销', {
        deviceId: device.deviceId,
        storeId: device.storeId,
      });
    }
  }

  /**
   * 获取门店下所有在线设备
   */
  getDevicesByStore(storeId: string): ConnectedDevice[] {
    const deviceIds = this.storeMap.get(storeId);
    if (!deviceIds || deviceIds.size === 0) return [];

    const devices: ConnectedDevice[] = [];
    for (const id of deviceIds) {
      const device = this.deviceMap.get(id);
      if (device && device.ws.readyState === WebSocket.OPEN) {
        devices.push(device);
      }
    }
    return devices;
  }

  /**
   * 按设备码查找（定向推送打印任务用）
   */
  getDevice(deviceId: string): ConnectedDevice | undefined {
    return this.deviceMap.get(deviceId);
  }

  /**
   * 按 WebSocket 引用查找设备
   */
  getDeviceByWs(ws: WebSocket): ConnectedDevice | undefined {
    const deviceId = this.wsMap.get(ws);
    if (!deviceId) return undefined;
    return this.deviceMap.get(deviceId);
  }

  /**
   * 检查设备是否在线
   */
  isOnline(deviceId: string): boolean {
    const device = this.deviceMap.get(deviceId);
    return !!device && device.ws.readyState === WebSocket.OPEN;
  }

  /**
   * 更新心跳时间
   */
  updatePing(ws: WebSocket): void {
    const deviceId = this.wsMap.get(ws);
    if (!deviceId) return;
    const device = this.deviceMap.get(deviceId);
    if (device) {
      device.lastPingAt = new Date();
    }
  }

  /**
   * 获取统计信息
   */
  getStats(): { totalDevices: number; totalStores: number } {
    return {
      totalDevices: this.deviceMap.size,
      totalStores: this.storeMap.size,
    };
  }

  /**
   * 内部方法：移除设备的所有索引
   */
  private removeDevice(device: ConnectedDevice): void {
    this.deviceMap.delete(device.deviceId);
    this.wsMap.delete(device.ws);

    const storeDevices = this.storeMap.get(device.storeId);
    if (storeDevices) {
      storeDevices.delete(device.deviceId);
      if (storeDevices.size === 0) {
        this.storeMap.delete(device.storeId);
      }
    }
  }
}

// 单例导出
export const deviceRegistry = new DeviceRegistry();
