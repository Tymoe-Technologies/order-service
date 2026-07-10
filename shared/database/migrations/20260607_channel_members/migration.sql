CREATE TABLE "channel_members" (
  "id"          UUID         NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id"   UUID         NOT NULL,
  "channel_id"  UUID         NOT NULL,
  "phone"       VARCHAR(30)  NOT NULL,
  "name"        VARCHAR(100),
  "note"        VARCHAR(255),
  "is_active"   BOOLEAN      NOT NULL DEFAULT true,
  "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "channel_members_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "channel_members_channel_phone_key" UNIQUE ("channel_id", "phone"),
  CONSTRAINT "channel_members_channel_id_fkey"
    FOREIGN KEY ("channel_id") REFERENCES "order_source_configs"("id") ON DELETE CASCADE
);

CREATE INDEX "channel_members_tenant_phone_idx" ON "channel_members"("tenant_id", "phone");
