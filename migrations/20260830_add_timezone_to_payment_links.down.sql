-- Rollback: 20260830_add_timezone_to_payment_links

ALTER TABLE payment_links
  DROP COLUMN IF EXISTS timezone;
