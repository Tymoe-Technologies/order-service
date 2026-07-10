-- 为所有已有租户补充系统预设外卖平台渠道
-- 新租户通过 initializeDefaultChannels() 自动创建，此迁移只处理存量数据
INSERT INTO order_source_configs (
  id, tenant_id, source_type, source_name, description,
  display_order, is_active, is_system_channel, platform_type,
  access_mode, checkout_mode, created_at, updated_at
)
SELECT
  gen_random_uuid(),
  t.tenant_id,
  platform.source_type,
  platform.source_name,
  platform.description,
  platform.display_order,
  false,
  true,
  platform.platform_type::"DeliveryPlatform",
  'PUBLIC'::"ChannelAccessMode",
  'NORMAL'::"CheckoutMode",
  now(),
  now()
FROM
  (SELECT DISTINCT tenant_id FROM order_source_configs) t
CROSS JOIN (VALUES
  ('UBER_EATS',       'Uber Eats',        'Uber Eats 外卖平台手动录单',       10, 'UBER_EATS'),
  ('DOORDASH',        'DoorDash',         'DoorDash 外卖平台手动录单',         11, 'DOORDASH'),
  ('SKIP_THE_DISHES', 'Skip The Dishes',  'Skip The Dishes 外卖平台手动录单', 12, 'SKIP_THE_DISHES'),
  ('GRUBHUB',         'Grubhub',          'Grubhub 外卖平台手动录单',         13, 'GRUBHUB'),
  ('RITUAL',          'Ritual',           'Ritual 外卖平台手动录单',          14, 'RITUAL'),
  ('FANTUAN',         '饭团',             '饭团外卖平台手动录单',             15, 'FANTUAN')
) AS platform(source_type, source_name, description, display_order, platform_type)
WHERE NOT EXISTS (
  SELECT 1 FROM order_source_configs osc
  WHERE osc.tenant_id = t.tenant_id
    AND osc.source_type = platform.source_type
);
