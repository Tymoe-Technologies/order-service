-- CreateTable
CREATE TABLE "print_brand_profiles" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "logo_url" VARCHAR(500),
    "logo_public_id" VARCHAR(500),
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "print_brand_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "print_brand_profiles_tenant_id_key" ON "print_brand_profiles"("tenant_id");
