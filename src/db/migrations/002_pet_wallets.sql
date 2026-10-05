-- 002_pet_wallets.sql — per-pet Solana wallets.
-- Every launched pet gets its own wallet; the wallet is set as the coin's
-- `creator` so creator fees flow to the pet automatically.
-- pet_wallet_encrypted holds the AES-256-GCM blob (never exposed to clients).

ALTER TABLE pets ADD COLUMN IF NOT EXISTS pet_wallet_pubkey TEXT;
ALTER TABLE pets ADD COLUMN IF NOT EXISTS pet_wallet_encrypted TEXT;
ALTER TABLE launch_intents ADD COLUMN IF NOT EXISTS pet_wallet_pubkey TEXT;
ALTER TABLE launch_intents ADD COLUMN IF NOT EXISTS pet_wallet_encrypted TEXT;
