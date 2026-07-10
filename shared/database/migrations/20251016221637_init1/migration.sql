-- CreateTable
CREATE TABLE "receipt_templates" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "description" TEXT,
    "paper_width" INTEGER NOT NULL DEFAULT 80,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "config" JSON NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "receipt_templates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "receipt_templates_tenant_id_is_default_idx" ON "receipt_templates"("tenant_id", "is_default");

-- CreateIndex
CREATE INDEX "receipt_templates_tenant_id_is_active_idx" ON "receipt_templates"("tenant_id", "is_active");
