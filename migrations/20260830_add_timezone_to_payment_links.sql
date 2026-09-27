-- Migration: 20260830_add_timezone_to_payment_links
-- Issue #644: Store user timezone with payment links for expiration display

ALTER TABLE payment_links
  ADD COLUMN IF NOT EXISTS timezone VARCHAR(100);
