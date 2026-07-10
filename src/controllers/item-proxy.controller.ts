import { Request, Response, NextFunction } from 'express';
import itemProxyService from '../services/item-proxy.service';
import logger from '../utils/logger';

/**
 * 商品代理控制器
 * 代理转发商品相关请求到 Item Management Service
 */
class ItemProxyController {
  /**
   * 获取商家的所有商品
   * GET /merchants/:merchantId/items?limit=100&offset=0
   */
  async getItemsByMerchantId(req: Request, res: Response, next: NextFunction) {
    try {
      const { merchantId } = req.params;
      const limit = parseInt(req.query.limit as string) || 100;
      const offset = parseInt(req.query.offset as string) || 0;

      logger.info('Proxying request to get items', { merchantId, limit, offset });

      const result = await itemProxyService.getItemsByMerchantId(merchantId, limit, offset);

      // 返回 items 数组以兼容前端期望的格式
      // Item Service 返回 { items: [...], count: ... }
      // 需要进行字段转换: snake_case -> camelCase, 价格从分转为元
      const items = (result.items || []).map((item: any) => {
        // 价格从分(字符串)转换为元(数字)
        const basePrice = item.base_price ? parseFloat(item.base_price) / 100 : 0;
        const cost = item.cost ? parseFloat(item.cost) / 100 : 0;

        // 转换分类信息
        let category = null;
        let categoryName = null;
        if (item.categories) {
          category = {
            id: item.categories.id,
            name: item.categories.name,
            displayName: item.categories.display_name || item.categories.name,
          };
          categoryName = item.categories.display_name || item.categories.name;
        }

        return {
          id: item.id,
          tenantId: item.tenant_id,
          categoryId: item.category_id,
          primaryCategoryId: item.primary_category_id,
          name: item.name,
          description: item.description,
          basePrice,              // 转换后的价格(元)
          price: basePrice,       // 前端显示用
          cost,                   // 转换后的成本(元)
          customFields: item.custom_fields,
          aiTags: item.ai_tags,
          imageUrl: item.image_url,
          isActive: item.is_active,
          createdAt: item.created_at,
          updatedAt: item.updated_at,
          // 分类信息 (camelCase)
          category,               // 完整分类对象
          categoryName,           // 分类名称(便于前端直接使用)
          // 保留关联数据(如果存在)
          itemModifierGroups: item.item_modifier_groups,
          itemTaxRates: item.item_tax_rates,
        };
      });

      res.json(items);
    } catch (error) {
      next(error);
    }
  }
}

export default new ItemProxyController();
