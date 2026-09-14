-- Required by createInvestmentForUser INSERT
ALTER TABLE investments
  ADD COLUMN income_eligible TINYINT(1) NOT NULL DEFAULT 1 AFTER status;
