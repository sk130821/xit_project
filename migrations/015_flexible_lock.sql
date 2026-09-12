-- 20% of a Flexible buy is stored as Flexible Lock (not Lock Plan)
ALTER TABLE investments
  MODIFY plan_type ENUM('lock', 'flexible', 'flexible_lock') NOT NULL;
