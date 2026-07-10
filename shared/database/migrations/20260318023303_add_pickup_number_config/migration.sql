-- CreateTable
CREATE TABLE "pickup_number_configs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "order_source" VARCHAR(20) NOT NULL,
    "start_at" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pickup_number_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pickup_counters" (
    "tenant_id" UUID NOT NULL,
    "order_source" VARCHAR(20) NOT NULL,
    "date" DATE NOT NULL,
    "counter" INTEGER NOT NULL,

    CONSTRAINT "pickup_counters_pkey" PRIMARY KEY ("tenant_id","order_source","date")
);

-- CreateIndex
CREATE UNIQUE INDEX "pickup_number_configs_tenant_id_order_source_key" ON "pickup_number_configs"("tenant_id", "order_source");
