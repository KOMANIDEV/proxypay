-- Track payment link expiration notification delivery status
CREATE TABLE IF NOT EXISTS payment_link_expiration_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_link_id UUID NOT NULL REFERENCES payment_links(id) ON DELETE CASCADE,
  notification_type VARCHAR(20) NOT NULL CHECK (notification_type IN ('warning_24h', 'expired')),
  sent_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  UNIQUE(payment_link_id, notification_type)
);

CREATE INDEX idx_payment_link_expiration_notifications_link_id 
  ON payment_link_expiration_notifications(payment_link_id);

CREATE INDEX idx_payment_link_expiration_notifications_sent_at 
  ON payment_link_expiration_notifications(sent_at);
