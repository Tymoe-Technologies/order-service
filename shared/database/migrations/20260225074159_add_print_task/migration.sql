-- CreateEnum
CREATE TYPE "PrintTaskStatus" AS ENUM ('PENDING', 'SENT', 'RECEIVED', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "PrintTaskSource" AS ENUM ('POS', 'ONLINE', 'KIOSK');

-- CreateTable
CREATE TABLE "print_tasks" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "ticket_type" "TicketType" NOT NULL,
    "source" "PrintTaskSource" NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 2,
    "status" "PrintTaskStatus" NOT NULL DEFAULT 'PENDING',
    "payload" JSON NOT NULL,
    "device_id" VARCHAR(255),
    "sent_at" TIMESTAMP(3),
    "received_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "failed_at" TIMESTAMP(3),
    "error" TEXT,
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "print_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "print_tasks_tenant_id_status_idx" ON "print_tasks"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "print_tasks_order_id_idx" ON "print_tasks"("order_id");

-- CreateIndex
CREATE INDEX "print_tasks_device_id_status_idx" ON "print_tasks"("device_id", "status");

-- AddForeignKey
ALTER TABLE "print_tasks" ADD CONSTRAINT "print_tasks_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
