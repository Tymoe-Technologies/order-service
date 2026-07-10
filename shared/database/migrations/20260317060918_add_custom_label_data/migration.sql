-- AlterEnum
ALTER TYPE "TicketType" ADD VALUE 'CUSTOM_LABEL';

-- AlterTable
ALTER TABLE "checkout_snapshots" ADD COLUMN     "custom_label_data" JSON;

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "custom_label_data" JSON;
