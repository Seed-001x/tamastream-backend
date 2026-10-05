-- 007_pair_mint_nullable.sql — launch_intents.pair_mint is a Launchfolio column;
-- Tamastream doesn't use pairing. Make it nullable so Tamastream inserts work.
ALTER TABLE launch_intents ALTER COLUMN pair_mint DROP NOT NULL;
