-- AlterTable
ALTER TABLE "order_items" ADD COLUMN     "combo_id" UUID,
ADD COLUMN     "combo_selections" JSON;
