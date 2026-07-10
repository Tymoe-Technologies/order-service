import { Router } from 'express';
import printController from '../controllers/print.controller';
import { authenticate } from '../middleware/auth';
import { validate } from '../middleware/validation';
import { printOrderSchema } from '../validators/order.validator';

const router = Router();

router.post(
  '/:orderId/print',
  authenticate,
  validate(printOrderSchema),
  printController.printOrder
);
router.get('/:orderId/print-records', authenticate, printController.getPrintRecords);
router.get('/:orderId/receipt/pdf', authenticate, printController.generateReceiptPDF);

export default router;
