-- Remove investments (and related txs via SET NULL) whose user no longer exists
DELETE i
FROM investments i
LEFT JOIN users u ON u.id = i.user_id
WHERE u.id IS NULL;

-- Cancel any leftover active rows that somehow remain orphaned (safety)
UPDATE investments i
LEFT JOIN users u ON u.id = i.user_id
SET i.status = 'cancelled'
WHERE u.id IS NULL AND i.status = 'active';
