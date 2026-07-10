-- AlterTable
ALTER TABLE "order_items" ADD COLUMN     "discount_amount" DECIMAL(10,2) DEFAULT 0,
ADD COLUMN     "discount_reason" VARCHAR(100),
ADD COLUMN     "discount_type" VARCHAR(20),
ADD COLUMN     "discount_value" DECIMAL(10,2);
