import axios from 'axios';
import logger from '../utils/logger';
import { AppError } from '../middleware/errorHandler';

// 通过 API Gateway 访问 Item Service
const ITEM_SERVICE_URL = process.env.API_GATEWAY_URL ?
  `${process.env.API_GATEWAY_URL}/api/item` :
  'http://localhost:8000/api/item';
const SERVICE_TOKEN = process.env.SERVICE_TOKEN || '';
const TENANT_ID = process.env.TENANT_ID || '';

/**
 * 商品代理服务
 * 负责与 Item Management Service 通信
 */
class ItemProxyService {
  /**
   * 获取商家的所有商品
   * @param merchantId 商家ID (用于日志记录,实际通过 JWT token 的 tenantId 隔离)
   * @param limit 返回数量限制
   * @param offset 偏移量
   * @returns 商品列表
   */
  async getItemsByMerchantId(merchantId: string, limit: number = 100, offset: number = 0) {
    try {
      logger.info('Fetching items from Item Management Service', { merchantId, limit, offset });

      // Item Service 使用租户ID进行数据隔离
      // 在开发环境中,通过 x-tenant-id 请求头传递租户ID
      const headers: any = {
        'Content-Type': 'application/json',
      };

      // 添加认证 token (如果配置了)
      if (SERVICE_TOKEN) {
        headers['Authorization'] = `Bearer ${SERVICE_TOKEN}`;
      }

      // 添加租户ID (优先使用 merchantId,其次使用环境变量)
      const tenantId = merchantId || TENANT_ID;
      if (tenantId) {
        headers['x-tenant-id'] = tenantId;
      }

      const response = await axios.get(`${ITEM_SERVICE_URL}/v1/items`, {
        params: {
          limit,
          offset,
        },
        headers,
        timeout: 10000, // 10秒超时
      });

      logger.info('Successfully fetched items', { 
        merchantId, 
        itemCount: response.data?.items?.length || 0,
        totalCount: response.data?.count || 0
      });

      return response.data;
    } catch (error: any) {
      logger.error('Error fetching items from Item Management Service', {
        merchantId,
        errorMessage: error.message,
        errorCode: error.code,
        status: error.response?.status,
        data: error.response?.data,
        hasRequest: !!error.request,
        hasResponse: !!error.response,
        url: `${ITEM_SERVICE_URL}/v1/items`,
      });

      // 处理不同的错误情况
      if (error.response) {
        // Item Service 返回了错误响应
        throw new AppError(
          error.response.status,
          'ITEM_SERVICE_ERROR',
          error.response.data?.message || 'Failed to fetch items from Item Management Service'
        );
      } else if (error.request) {
        // 请求已发送但没有收到响应
        throw new AppError(503, 'SERVICE_UNAVAILABLE', 'Item Management Service is not responding');
      } else {
        // 其他错误
        throw new AppError(500, 'COMMUNICATION_ERROR', 'Failed to communicate with Item Management Service');
      }
    }
  }
}

export default new ItemProxyService();
