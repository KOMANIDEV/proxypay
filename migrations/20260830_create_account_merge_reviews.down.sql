-- Rollback: 20260830_create_account_merge_reviews
--
-- Drops the table. This one is genuinely destructive in a way the asset
-- migration was not: a dropped review row is a lost audit record of who
-- approved moving a merchant's funds, and there is no way to reconstruct it
-- from anything else in the database.
--
-- So, unlike the asset requests, a deployment that may already have real
-- decisions in here should archive the table before rolling back:
--
--   CREATE TABLE account_merge_reviews_backup AS SELECT * FROM account_merge_reviews;
--
-- A migration cannot decide that for you, and it should not pretend to. The
-- feature is inoperable without the table, which is the trade being made by
-- rolling back at all.

DROP TABLE IF EXISTS account_merge_reviews;
