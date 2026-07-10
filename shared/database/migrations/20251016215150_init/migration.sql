-- CreateEnum
CREATE TYPE "OrderType" AS ENUM ('DINE_IN', 'TAKEOUT', 'DELIVERY');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PENDING', 'CONFIRMED', 'PREPARING', 'READY', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "NoteType" AS ENUM ('GENERAL', 'KITCHEN', 'CUSTOMER', 'INTERNAL');

-- CreateEnum
CREATE TYPE "PrintType" AS ENUM ('RECEIPT', 'KITCHEN_TICKET', 'LABEL');

-- CreateEnum
CREATE TYPE "PrintStatus" AS ENUM ('SUCCESS', 'FAILED');

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "order_number" VARCHAR(50) NOT NULL,
    "customer_name" VARCHAR(255),
    "customer_phone" VARCHAR(50),
    "order_type" "OrderType" NOT NULL DEFAULT 'DINE_IN',
    "status" "OrderStatus" NOT NULL DEFAULT 'PENDING',
    "table_number" VARCHAR(50),
    "total_amount" DECIMAL(10,2) NOT NULL,
    "subtotal" DECIMAL(10,2) NOT NULL,
    "tax_amount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "discount_amount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "notes" TEXT,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_items" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "item_name" VARCHAR(255) NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unit_price" DECIMAL(10,2) NOT NULL,
    "total_price" DECIMAL(10,2) NOT NULL,
    "attributes" JSON,
    "addons" JSON,
    "special_notes" TEXT,

    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_notes" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "note_type" "NoteType" NOT NULL DEFAULT 'GENERAL',
    "content" TEXT NOT NULL,
    "color" VARCHAR(20),
    "is_pinned" BOOLEAN NOT NULL DEFAULT false,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "print_records" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "print_type" "PrintType" NOT NULL,
    "printer_name" VARCHAR(255),
    "printed_by" UUID NOT NULL,
    "printed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "PrintStatus" NOT NULL DEFAULT 'SUCCESS',

    CONSTRAINT "print_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "note_templates" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "content" TEXT NOT NULL,
    "color" VARCHAR(20),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "note_templates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "orders_order_number_key" ON "orders"("order_number");

-- CreateIndex
CREATE INDEX "orders_tenant_id_created_at_idx" ON "orders"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "orders_order_number_idx" ON "orders"("order_number");

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_notes" ADD CONSTRAINT "order_notes_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "print_records" ADD CONSTRAINT "print_records_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
