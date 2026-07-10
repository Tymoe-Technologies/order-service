import { Request, Response, NextFunction } from 'express';
import printService from '../services/print.service';
import { successResponse } from '../utils/response';

export class PrintController {
  async printOrder(req: Request, res: Response, next: NextFunction) {
    try {
      const { orderId } = req.params;
      const userId = req.user!.userId;
      const tenantId = req.user!.tenantId;
      const result = await printService.printOrder(orderId, req.body, userId, tenantId);
      successResponse(res, result);
    } catch (error) {
      next(error);
    }
  }

  async getPrintRecords(req: Request, res: Response, next: NextFunction) {
    try {
      const { orderId } = req.params;
      const tenantId = req.user!.tenantId;
      const result = await printService.getPrintRecords(orderId, tenantId);
      successResponse(res, result);
    } catch (error) {
      next(error);
    }
  }

  async generateReceiptPDF(req: Request, res: Response, next: NextFunction) {
    try {
      const { orderId } = req.params;
      const tenantId = req.user!.tenantId;
      const pdfBuffer = await printService.generateReceiptPDF(orderId, tenantId);

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename=receipt-${orderId}.pdf`);
      res.send(pdfBuffer);
    } catch (error) {
      next(error);
    }
  }
}

export default new PrintController();
