-- 003_pet_trades.sql — log of trades executed by pet wallets.
CREATE TABLE IF NOT EXISTS pet_trades (
  id                    SERIAL PRIMARY KEY,
  pet_mint              TEXT NOT NULL,
  action                TEXT NOT NULL,          -- 'buy' (sells come later)
  input_mint            TEXT NOT NULL,
  output_mint           TEXT NOT NULL,
  input_amount_lamports BIGINT NOT NULL,
  output_amount_approx  BIGINT,                 -- from Jupiter quote (approx)
  signature             TEXT NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pet_trades_pet ON pet_trades(pet_mint, created_at DESC);
