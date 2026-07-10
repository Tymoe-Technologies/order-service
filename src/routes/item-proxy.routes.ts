import { Router } from 'express';
import itemProxyController from '../controllers/item-proxy.controller';

const router = Router();

/**
 * @swagger
 * /merchants/{merchantId}/items:
 *   get:
 *     summary: 获取商家的所有商品（代理到 Item Management Service）
 *     description: |
 *       代理请求到 Item Management Service 的 GET /items 端点。
 *       注意: Item Service 通过 JWT token 中的 tenantId 进行租户隔离，
 *       merchantId 参数仅用于 Order Service 的日志记录。
 *     tags: [Items]
 *     parameters:
 *       - in: path
 *         name: merchantId
 *         required: true
 *         schema:
 *           type: string
 *         description: 商家ID (用于日志记录)
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 100
 *         description: 返回数量限制
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *         description: 偏移量
 *     responses:
 *       200:
 *         description: 成功获取商品列表
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 items:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                       name:
 *                         type: string
 *                       displayName:
 *                         type: string
 *                       description:
 *                         type: string
 *                       basePrice:
 *                         type: number
 *                       categoryId:
 *                         type: string
 *                       isActive:
 *                         type: boolean
 *                 count:
 *                   type: integer
 *                   description: 总商品数量
 *       401:
 *         description: 未授权 - SERVICE_TOKEN 无效
 *       503:
 *         description: Item Management Service 不可用
 */
router.get(
  '/merchants/:merchantId/items',
  itemProxyController.getItemsByMerchantId
);

export default router;
