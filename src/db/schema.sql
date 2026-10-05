// src/db/schema.sql — Tamastream base schema (idempotent).
// Pets are Tamagotchi companions bonded to pump.fun tokens.

-- ---------------------------------------------------------------- users
CREATE TABLE IF NOT EXISTS users (
  id         SERIAL PRIMARY KEY,
  handle     TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- wallets
CREATE TABLE IF NOT EXISTS wallets (
  pubkey          TEXT PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id),
  is_primary      BOOLEAN NOT NULL DEFAULT false,
  verified_method TEXT,
  verified_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- auth_nonces
CREATE TABLE IF NOT EXISTS auth_nonces (
  pubkey     TEXT NOT NULL,
  nonce      TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used       BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (pubkey, nonce)
);

-- ---------------------------------------------------------------- launch_intents
-- Forge sessions between /prepare and /submit. 24h TTL; the auto flow
-- consumes them on submit, the pet is inserted then.
CREATE TABLE IF NOT EXISTS launch_intents (
  mint            TEXT PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id),
  launcher_wallet TEXT NOT NULL,
  name            TEXT NOT NULL,
  symbol          TEXT NOT NULL,
  metadata_uri    TEXT NOT NULL,
  traits          JSONB NOT NULL DEFAULT '[]'::jsonb,
  bio             TEXT NOT NULL DEFAULT '',
  image_url       TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_launch_intents_expires ON launch_intents(expires_at);

-- ---------------------------------------------------------------- pets
-- One row per launched pet, bonded to its pump.fun token mint.
CREATE TABLE IF NOT EXISTS pets (
  mint            TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  ticker          TEXT NOT NULL,
  traits          JSONB NOT NULL DEFAULT '[]'::jsonb,
  bio             TEXT NOT NULL DEFAULT '',
  image_url       TEXT,
  creator_wallet  TEXT NOT NULL,
  launch_signature TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pets_created ON pets(created_at DESC);

-- ---------------------------------------------------------------- watched_mints
-- The indexer watchlist: mints the trade indexer should poll.
CREATE TABLE IF NOT EXISTS watched_mints (
  mint     TEXT PRIMARY KEY,
  origin   TEXT NOT NULL DEFAULT 'TAMASTREAM',
  active   BOOLEAN NOT NULL DEFAULT true,
  added_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
