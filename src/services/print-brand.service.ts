import prisma from '../utils/prisma';
import logger from '../utils/logger';

export class PrintBrandService {
  /**
   * 获取租户的品牌配置
   * 如果不存在则返回 null（前端可展示"未配置"状态）
   */
  async getBrandProfile(tenantId: string) {
    return prisma.printBrandProfile.findUnique({
      where: { tenantId },
    });
  }

  /**
   * 更新（或创建）租户的品牌 Logo
   * 使用 upsert 保证幂等性
   */
  async upsertLogo(tenantId: string, logoUrl: string, logoPublicId: string) {
    const profile = await prisma.printBrandProfile.upsert({
      where: { tenantId },
      create: { tenantId, logoUrl, logoPublicId },
      update: { logoUrl, logoPublicId },
    });

    logger.info('品牌 Logo 已更新', { tenantId, logoUrl });
    return profile;
  }

  /**
   * 清除品牌 Logo（保留 profile 记录，只清空 Logo 字段）
   */
  async clearLogo(tenantId: string) {
    // 若记录不存在则无需操作
    const existing = await prisma.printBrandProfile.findUnique({ where: { tenantId } });
    if (!existing) return null;

    const profile = await prisma.printBrandProfile.update({
      where: { tenantId },
      data: { logoUrl: null, logoPublicId: null },
    });

    logger.info('品牌 Logo 已清除', { tenantId });
    return profile;
  }

  /**
   * 获取有效 Logo URL
   * 优先使用模板自身的 logoUrl，为空则回退到品牌配置
   */
  async resolveLogoUrl(tenantId: string, templateLogoUrl?: string | null): Promise<string | null> {
    if (templateLogoUrl) return templateLogoUrl;

    const profile = await prisma.printBrandProfile.findUnique({
      where: { tenantId },
      select: { logoUrl: true },
    });

    return profile?.logoUrl ?? null;
  }
}

export default new PrintBrandService();
