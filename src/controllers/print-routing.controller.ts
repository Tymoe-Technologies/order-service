import { Request, Response, NextFunction } from 'express';
import * as service from '../services/print-routing.service';
import { successResponse } from '../utils/response';

/**
 * 备餐站与打印路由配置。
 *
 * 配置写后端而不是各 POS 本地：一家店可能有多台 POS，还会有没打印机的手持设备，
 * 「哪个商品进哪个站」必须全店一份。**只有打印机归属是设备各自登记的**
 * （那部分才是本机事实），归属之外的都同步下来。
 */
export class PrintRoutingController {
  /** GET /print-routing —— 一次拿全（POS 会整份缓存到本地，后端挂了时自己拆单） */
  async getConfig(req: Request, res: Response, next: NextFunction) {
    try {
      successResponse(res, await service.getRoutingConfig(req.user!.tenantId));
    } catch (error) {
      next(error);
    }
  }

  /** PUT /print-routing —— 整体替换站与规则（站 id 由客户端发号） */
  async replaceConfig(req: Request, res: Response, next: NextFunction) {
    try {
      const { stations, routes } = req.body || {};
      const result = await service.replaceRoutingConfig(req.user!.tenantId, stations, routes || []);
      successResponse(res, result);
    } catch (error) {
      next(error);
    }
  }

  /** PUT /print-routing/assignments —— 登记打印机归属，只动传进来的 scope */
  async putAssignments(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await service.upsertAssignments(req.user!.tenantId, req.body?.assignments);
      successResponse(res, result);
    } catch (error) {
      next(error);
    }
  }

  /** DELETE /print-routing/assignments/:scope */
  async deleteAssignment(req: Request, res: Response, next: NextFunction) {
    try {
      await service.deleteAssignment(req.user!.tenantId, req.params.scope);
      successResponse(res, { deleted: req.params.scope });
    } catch (error) {
      next(error);
    }
  }
}

export default new PrintRoutingController();
