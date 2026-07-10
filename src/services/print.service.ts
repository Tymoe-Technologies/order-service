import prisma from '../utils/prisma';
import { AppError } from '../middleware/errorHandler';
import logger from '../utils/logger';
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';

interface PrintOrderData {
  printType: 'RECEIPT' | 'KITCHEN_TICKET' | 'LABEL';
  printerName?: string;
  copies?: number;
}

export class PrintService {
  async printOrder(
    orderId: string,
    data: PrintOrderData,
    userId: string,
    tenantId: string
  ) {
    const order = await prisma.order.findFirst({
      where: { id: orderId, tenantId },
      include: {
        orderItems: true,
      },
    });

    if (!order) {
      throw new AppError(404, 'ORDER_NOT_FOUND', '订单不存在');
    }

    const printRecord = await prisma.printRecord.create({
      data: {
        orderId,
        printType: data.printType,
        printerName: data.printerName || null,
        printedBy: userId,
        status: 'SUCCESS',
      },
    });

    logger.info(`Print record created for order: ${orderId}`, {
      printRecordId: printRecord.id,
      printType: data.printType,
    });

    return {
      printRecordId: printRecord.id,
      status: printRecord.status,
      printedAt: printRecord.printedAt,
    };
  }

  async getPrintRecords(orderId: string, tenantId: string) {
    const order = await prisma.order.findFirst({
      where: { id: orderId, tenantId },
    });

    if (!order) {
      throw new AppError(404, 'ORDER_NOT_FOUND', '订单不存在');
    }

    const records = await prisma.printRecord.findMany({
      where: { orderId },
      orderBy: { printedAt: 'desc' },
    });

    return records;
  }

  async generateReceiptPDF(orderId: string, tenantId: string): Promise<Buffer> {
    const order = await prisma.order.findFirst({
      where: { id: orderId, tenantId },
      include: {
        orderItems: true,
      },
    });

    if (!order) {
      throw new AppError(404, 'ORDER_NOT_FOUND', '订单不存在');
    }

    return new Promise(async (resolve, reject) => {
      try {
        const doc = new PDFDocument({ size: 'A4', margin: 50 });
        const chunks: Buffer[] = [];

        doc.on('data', (chunk) => chunks.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        // Generate QR code
        const qrCodeDataUrl = await QRCode.toDataURL(order.orderNumber);
        const qrCodeBuffer = Buffer.from(qrCodeDataUrl.split(',')[1], 'base64');

        // Header
        doc.fontSize(20).text('订单小票', { align: 'center' });
        doc.moveDown();

        // QR Code
        doc.image(qrCodeBuffer, doc.page.width / 2 - 50, doc.y, { width: 100 });
        doc.moveDown(6);

        // Order Info
        doc.fontSize(12);
        doc.text(`订单号: ${order.orderNumber}`);
        doc.text(`订单类型: ${this.translateOrderType(order.orderType)}`);
        if (order.tableNumber) {
          doc.text(`桌号: ${order.tableNumber}`);
        }
        if (order.customerName) {
          doc.text(`客户姓名: ${order.customerName}`);
        }
        doc.text(`下单时间: ${order.createdAt.toLocaleString('zh-CN')}`);
        doc.moveDown();

        // Items
        doc.fontSize(14).text('订单明细', { underline: true });
        doc.moveDown(0.5);
        doc.fontSize(10);

        order.orderItems.forEach((item) => {
          doc.text(
            `${item.itemName} x ${item.quantity} = ¥${item.totalPrice.toString()}`,
            { indent: 20 }
          );
          if (item.specialNotes) {
            doc.fontSize(9).text(`备注: ${item.specialNotes}`, { indent: 40 });
            doc.fontSize(10);
          }
        });

        doc.moveDown();

        // Totals
        doc.fontSize(12);
        doc.text(`小计: ¥${order.subtotal.toString()}`, { align: 'right' });
        if (parseFloat(order.discountAmount.toString()) > 0) {
          doc.text(`折扣: -¥${order.discountAmount.toString()}`, { align: 'right' });
        }
        doc.fontSize(14).text(`总计: ¥${order.totalAmount.toString()}`, { align: 'right' });

        if (order.notes) {
          doc.moveDown();
          doc.fontSize(10).text(`备注: ${order.notes}`);
        }

        // Footer
        doc.moveDown(2);
        doc.fontSize(10).text('感谢您的光临!', { align: 'center' });

        doc.end();
      } catch (error) {
        reject(error);
      }
    });
  }

  private translateOrderType(type: string): string {
    const map: Record<string, string> = {
      DINE_IN: '堂食',
      TAKEOUT: '外带',
      DELIVERY: '配送',
    };
    return map[type] || type;
  }
}

export default new PrintService();
