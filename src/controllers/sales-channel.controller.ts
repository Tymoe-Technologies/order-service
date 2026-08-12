import { Request, Response, NextFunction } from 'express';
import salesChannelService from '../services/sales-channel.service';
import { successResponse } from '../utils/response';
import logger from '../utils/logger';

export class SalesChannelController {
  async getSalesChannels(req: Request, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user!.tenantId;
      const isActive = req.query.isActive === 'true' ? true :
        req.query.isActive === 'false' ? false : undefined;

      logger.info('Fetching sales channels', { tenantId, isActive });
      const channels = await salesChannelService.getSalesChannels(tenantId, isActive);

      logger.info('Sales channels fetched', { count: channels.length, tenantId });
      successResponse(res, channels);
    } catch (error) {
      logger.error('Error fetching sales channels', error);
      next(error);
    }
  }

  async getSalesChannelById(req: Request, res: Response, next: NextFunction) {
    try {
      const { channelId } = req.params;
      const tenantId = req.user!.tenantId;

      logger.info('Fetching sales channel', { channelId, tenantId });
      const channel = await salesChannelService.getSalesChannelById(channelId, tenantId);

      successResponse(res, channel);
    } catch (error) {
      next(error);
    }
  }

  async createSalesChannel(req: Request, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user!.tenantId;
      const {
        channelCode, channelName, description, isActive, displayOrder,
        accessMode, checkoutMode, creditConfig, checkoutRules,
        commissionRate, platformType,
      } = req.body;

      logger.info('Creating sales channel', { tenantId, channelCode, channelName });

      const channel = await salesChannelService.createSalesChannel(
        {
          channelCode,
          channelName,
          description,
          isActive,
          displayOrder,
          accessMode,
          checkoutMode,
          creditConfig,
          checkoutRules,
          commissionRate,
          platformType,
        },
        tenantId
      );

      logger.info('Sales channel created', { channelId: channel.id, tenantId });
      successResponse(res, channel, 201);
    } catch (error) {
      logger.error('Error creating sales channel', error);
      next(error);
    }
  }

  async updateSalesChannel(req: Request, res: Response, next: NextFunction) {
    try {
      const { channelId } = req.params;
      const tenantId = req.user!.tenantId;
      const {
        channelName, description, isActive, displayOrder,
        accessMode, checkoutMode, creditConfig, checkoutRules,
        commissionRate,
      } = req.body;

      logger.info('Updating sales channel', { channelId, tenantId });

      const channel = await salesChannelService.updateSalesChannel(
        channelId,
        {
          channelName,
          description,
          isActive,
          displayOrder,
          accessMode,
          checkoutMode,
          creditConfig,
          checkoutRules,
          commissionRate,
        },
        tenantId
      );

      logger.info('Sales channel updated', { channelId, tenantId });
      successResponse(res, channel);
    } catch (error) {
      logger.error('Error updating sales channel', error);
      next(error);
    }
  }

  async deleteSalesChannel(req: Request, res: Response, next: NextFunction) {
    try {
      const { channelId } = req.params;
      const tenantId = req.user!.tenantId;

      logger.info('Deleting sales channel', { channelId, tenantId });
      await salesChannelService.deleteSalesChannel(channelId, tenantId);

      logger.info('Sales channel deleted', { channelId, tenantId });
      successResponse(res, { message: '销售渠道已删除' });
    } catch (error) {
      logger.error('Error deleting sales channel', error);
      next(error);
    }
  }

  async initializeDefaultChannels(req: Request, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user!.tenantId;

      logger.info('Initializing default sales channels', { tenantId });
      const channels = await salesChannelService.initializeDefaultChannels(tenantId);

      logger.info('Default sales channels initialized', { count: channels.length, tenantId });
      successResponse(res, channels, 201);
    } catch (error) {
      logger.error('Error initializing default sales channels', error);
      next(error);
    }
  }

  async getChannelMembers(req: Request, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user!.tenantId;
      const { channelId } = req.params;
      const members = await salesChannelService.getChannelMembers(channelId, tenantId);
      successResponse(res, members);
    } catch (error) { next(error); }
  }

  async addChannelMember(req: Request, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user!.tenantId;
      const { channelId } = req.params;
      const { phone, name, note } = req.body;
      if (!phone) { res.status(400).json({ success: false, message: 'phone 必填' }); return; }
      const member = await salesChannelService.addChannelMember(channelId, tenantId, { phone, name, note });
      successResponse(res, member, 201);
    } catch (error) { next(error); }
  }

  async batchAddChannelMembers(req: Request, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user!.tenantId;
      const { channelId } = req.params;
      const { members } = req.body;
      if (!Array.isArray(members) || members.length === 0) {
        res.status(400).json({ success: false, message: 'members 数组必填' }); return;
      }
      const result = await salesChannelService.batchAddChannelMembers(channelId, tenantId, members);
      successResponse(res, result);
    } catch (error) { next(error); }
  }

  async updateChannelMember(req: Request, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user!.tenantId;
      const { memberId } = req.params;
      const { name, note, isActive } = req.body;
      const member = await salesChannelService.updateChannelMember(memberId, tenantId, { name, note, isActive });
      successResponse(res, member);
    } catch (error) { next(error); }
  }

  async removeChannelMember(req: Request, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user!.tenantId;
      const { memberId } = req.params;
      await salesChannelService.removeChannelMember(memberId, tenantId);
      successResponse(res, null);
    } catch (error) { next(error); }
  }

  async lookupChannelByPhone(req: Request, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user!.tenantId;
      const { phone } = req.query as { phone: string };
      if (!phone) { res.status(400).json({ success: false, message: 'phone 必填' }); return; }
      const result = await salesChannelService.lookupChannelByPhone(tenantId, phone);
      successResponse(res, result);
    } catch (error) { next(error); }
  }

  async getChannelCreditStatus(req: Request, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user!.tenantId;
      const { channelId } = req.params;
      const { getChannelCreditStatus } = await import('../services/credit.service');
      const status = await getChannelCreditStatus(tenantId, channelId);
      successResponse(res, status);
    } catch (error) { next(error); }
  }
}

export default new SalesChannelController();
