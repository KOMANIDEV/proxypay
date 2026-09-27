-- Rollback: 20260905_notification_delivery_tracking
-- Drops notification delivery tracking and channel health snapshots.

DROP INDEX IF EXISTS idx_notification_channel_health_status;
DROP TABLE IF EXISTS notification_channel_health;

DROP INDEX IF EXISTS idx_notification_deliveries_failed;
DROP INDEX IF EXISTS idx_notification_deliveries_channel_created;
DROP INDEX IF EXISTS idx_notification_deliveries_key;
DROP TABLE IF EXISTS notification_deliveries;
