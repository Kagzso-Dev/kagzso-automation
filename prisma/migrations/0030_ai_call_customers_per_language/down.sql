-- Rollback for 0030_ai_call_customers_per_language (not run by Prisma; apply by hand, then run
--   npx prisma migrate resolve --rolled-back 0030_ai_call_customers_per_language
-- ). Back to "one live customer per number in all lists".
--
-- Only possible while no number is live in two language lists. Check first; this must return no rows:
--   SELECT activePhone, COUNT(*) FROM ai_call_customers WHERE activePhone IS NOT NULL GROUP BY activePhone HAVING COUNT(*) > 1;
-- If it returns rows, delete the extra copies in the app first (Delete keeps their history and do-not-call).
-- The old index is created first: if a number is still in two lists it fails here and nothing is changed.
CREATE UNIQUE INDEX `ai_call_customers_activePhone_key` ON `ai_call_customers`(`activePhone`);
DROP INDEX `ai_call_customers_activePhone_language_key` ON `ai_call_customers`;
