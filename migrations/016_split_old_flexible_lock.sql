-- Split old Flexible 20% lock into Flexible Lock rows.
-- Safe to run once. Second run does nothing (locked_amount already 0).
-- Does not change roi_received.

ALTER TABLE investments
  MODIFY plan_type ENUM('lock', 'flexible', 'flexible_lock') NOT NULL;

INSERT INTO investments (
  user_id, plan_type, token_amount, total_return, daily_roi_rate, roi_received,
  sellable_amount, locked_amount, start_date, end_date, last_roi_date,
  status, created_at
)
SELECT
  user_id,
  'flexible_lock',
  locked_amount,
  ROUND(locked_amount * 4, 8),
  0.82,
  0,
  0,
  locked_amount,
  start_date,
  end_date,
  last_roi_date,
  status,
  created_at
FROM investments
WHERE plan_type = 'flexible'
  AND locked_amount > 0;

-- Assign total_return / sellable from original columns, then shrink token + clear lock.
UPDATE investments
SET
  total_return = ROUND((token_amount - locked_amount) * 3, 8),
  sellable_amount = LEAST(sellable_amount, token_amount - locked_amount),
  token_amount = token_amount - locked_amount,
  locked_amount = 0
WHERE plan_type = 'flexible'
  AND locked_amount > 0;
