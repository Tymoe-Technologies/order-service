-- AlterTable
ALTER TABLE "order_item_modifiers" ADD COLUMN     "option_code" VARCHAR(255);

-- AlterTable
ALTER TABLE "print_brand_profiles" ALTER COLUMN "id" DROP DEFAULT;
