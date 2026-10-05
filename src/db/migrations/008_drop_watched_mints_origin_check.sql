-- 008_drop_watched_mints_origin_check.sql — the shared DB's watched_mints table
-- carries Launchfolio's CHECK constraint on origin, which rejects 'TAMASTREAM'.
-- Launchfolio is retired; drop the constraint so Tamastream can record its mints.
ALTER TABLE watched_mints DROP CONSTRAINT IF EXISTS watched_mints_origin_check;
