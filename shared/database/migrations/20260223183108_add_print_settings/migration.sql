-- CreateEnum
CREATE TYPE "TicketType" AS ENUM ('CUSTOMER_RECEIPT', 'KITCHEN_TICKET', 'ITEM_LABEL', 'DAILY_REPORT', 'SHIFT_REPORT');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "PrintType" ADD VALUE 'DAILY_REPORT';
ALTER TYPE "PrintType" ADD VALUE 'SHIFT_REPORT';

-- CreateTable
CREATE TABLE "print_settings" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "ticket_type" "TicketType" NOT NULL,
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "copies" INTEGER NOT NULL DEFAULT 1,
    "config" JSON NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "print_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "print_settings_tenant_id_idx" ON "print_settings"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "print_settings_tenant_id_ticket_type_key" ON "print_settings"("tenant_id", "ticket_type");
