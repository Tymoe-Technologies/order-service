-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "cash_received" DECIMAL(10,2),
ADD COLUMN     "cashier_id" UUID,
ADD COLUMN     "change_given" DECIMAL(10,2);
