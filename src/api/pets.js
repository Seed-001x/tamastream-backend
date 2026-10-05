// src/api/pets.js — Tamastream pet launch pipeline (server side).
//
// Flow:
//   1. POST /pets/upload         (auth) — pet portrait PNG -> pump.fun IPFS
//      -> metadata JSON -> IPFS. Returns { imageUri, metadataUri }.
//   2. POST /pets/launch/prepare (auth) — validates params, generates the
//      pet's own Solana wallet (encrypted at rest), and builds an UNSIGNED
//      v0 transaction (pump create_v2) with the pet wallet as `creator`
//      (so all creator fees flow to the pet). The client signs it with
//      the user's wallet AND the client-generated mint keypair, then POSTs
//      the signed bytes to /submit. The backend never holds USER keys.
//   3. POST /pets/launch/submit  (auth) — sends the signed tx via the
//      backend's RPC, confirms, then inserts the pet row and adds the mint
//      to watched_mints. Returns { mint, signature }.
//
// Boundaries:
//   * creator is the PET's own wallet (auto-generated at prepare time). ALL of
//     the coin's creator fees flow to the pet's wallet by pump.fun protocol —
//     the launcher does nothing extra; they just sign the same transaction.
//     The backend holds the pet's encrypted key (WALLET_ENCRYPTION_KEY);
//     private material is NEVER logged or returned to clients.
//   * 10mb JSON body limit: pet portraits are phone photos as base64.

import {
  PUMP_SDK,
  holderRewardsPda,
} from '@nirholas/pump-sdk';
import {
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import BN from 'bn.js';
import { generatePetWallet, decryptPetWallet } from '../wallet/petWallet.js';
import { getQuote, executeSwap, SOL_MINT } from '../trading/jupiter.js';
import { chatWithPet } from '../ai/petChat.js';

// Simple in-memory rate limiter: max 30 AI chats per pet per hour.
const chatBuckets = new Map(); // mint -> [timestamps]
function chatRateOk(mint) {
  const now = Date.now();
  const windowMs = 60 * 60 * 1000;
  let hits = chatBuckets.get(mint) || [];
  hits = hits.filter((t) => now - t < windowMs);
  if (hits.length >= 30) {
    chatBuckets.set(mint, hits);
    return false;
  }
  hits.push(now);
  chatBuckets.set(mint, hits);
  return true;
}

function isPubkey(s) {
  try {
    new PublicKey(s);
    return true;
  } catch {
    return false;
  }
}

/** Upload a buffer to pump.fun's IPFS. Returns the URI. */
export async function ipfsUpload(fileBuffer, filename, contentType) {
  const blob = new Blob([fileBuffer], { type: contentType });
  const fd = new FormData();
  fd.append('file', blob, filename);
  const res = await fetch('https://pump.fun/api/ipfs', {
    method: 'POST',
    body: fd,
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) throw new Error(`ipfs upload failed: ${res.status}`);
  const j = await res.json();
  const uri = j?.metadataUri || j?.metadata?.image;
  if (!uri) throw new Error('ipfs upload returned no URI');
  // Pump's API wraps image uploads in a metadata JSON. If we uploaded an
  // image but got a metadata URI back, resolve it to the actual image URL.
  if (contentType.startsWith('image/')) {
    try {
      const head = await fetch(uri, { method: 'HEAD', signal: AbortSignal.timeout(15000) });
      const ct = head.headers.get('content-type') || '';
      if (!ct.startsWith('image/')) {
        const meta = await (await fetch(uri, { signal: AbortSignal.timeout(15000) })).json();
        if (meta?.image && typeof meta.image === 'string') return meta.image;
      }
    } catch {
      // fall through — frontend has gateway fallback
    }
  }
  return uri;
}

export function registerPetRoutes(app, { pool, rpcConnection, requireAuth }) {
  // ---------------------------------------------------------------- public

  // List all pets, newest first.
  app.get('/pets', async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT mint, name, ticker, traits, bio, image_url, creator_wallet, created_at
         FROM pets ORDER BY created_at DESC LIMIT 100`
      );
      res.json({ data: rows });
    } catch (e) {
      res.status(500).json({ error: 'failed to list pets', detail: e.message });
    }
  });

  // Single pet.
  app.get('/pets/:mint', async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT mint, name, ticker, traits, bio, image_url, creator_wallet,
                launch_signature, created_at
         FROM pets WHERE mint = $1`,
        [req.params.mint]
      );
      if (!rows.length) return res.status(404).json({ error: 'pet not found' });
      res.json({ data: rows[0] });
    } catch (e) {
      res.status(500).json({ error: 'failed to fetch pet', detail: e.message });
    }
  });

  // Pet wallet (public). Returns the pet's own Solana wallet address and SOL
  // balance. NEVER exposes private key material.
  app.get('/pets/:mint/wallet', async (req, res) => {
    try {
      const { rows } = await pool.query(
        'SELECT pet_wallet_pubkey FROM pets WHERE mint = $1',
        [req.params.mint]
      );
      if (!rows.length) return res.status(404).json({ error: 'pet not found' });
      const pubkey = rows[0].pet_wallet_pubkey || null;
      if (!pubkey) return res.json({ data: { pubkey: null, balanceSol: null, balanceLamports: null } });

      let balanceLamports = null;
      try {
        const conn = await rpcConnection();
        if (conn && isPubkey(pubkey)) {
          balanceLamports = await conn.getBalance(new PublicKey(pubkey));
        }
      } catch {
        // balance unavailable — still return the pubkey
      }
      res.json({
        data: {
          pubkey,
          balanceLamports,
          balanceSol: balanceLamports == null ? null : balanceLamports / 1e9,
        },
      });
    } catch (e) {
      res.status(500).json({ error: 'failed to fetch pet wallet', detail: e.message });
    }
  });

  // ---------------------------------------------------------------- authed

  // Upload a pet portrait (PNG data URL from the canvas) + build metadata.
  // Body: { image, name, ticker, bio }. Returns { imageUri, metadataUri }.
  app.post('/pets/upload', requireAuth, async (req, res) => {
    try {
      const { image, name, ticker, bio, traits } = req.body || {};
      if (typeof image !== 'string' || !image.startsWith('data:image/')) {
        return res.status(400).json({ error: 'image must be a data URL' });
      }
      const m = /^data:(image\/(png|jpeg|gif|webp));base64,(.+)$/.exec(image);
      if (!m) return res.status(400).json({ error: 'unsupported image format (png/jpeg/gif/webp)' });
      const buf = Buffer.from(m[3], 'base64');
      if (buf.length > 5 * 1024 * 1024) return res.status(400).json({ error: 'image too large (5MB max)' });
      const nm = String(name || '').slice(0, 32);
      const sym = String(ticker || '').slice(0, 10);
      if (!nm || !sym) return res.status(400).json({ error: 'name and ticker are required' });

      const imageUri = await ipfsUpload(buf, 'pet.png', m[1]);
      const metadata = {
        name: nm,
        symbol: sym,
        description: String(bio || '').slice(0, 1000),
        image: imageUri,
        traits: Array.isArray(traits) ? traits.slice(0, 3) : [],
        createdOn: 'https://tamastream.netlify.app',
      };
      const metadataUri = await ipfsUpload(
        Buffer.from(JSON.stringify(metadata)), 'metadata.json', 'application/json'
      );
      res.json({ data: { imageUri, metadataUri } });
    } catch (e) {
      console.error('[pets] upload failed:', e.message);
      res.status(502).json({ error: 'upload failed', detail: e.message });
    }
  });

  // Build the UNSIGNED create transaction.
  // Body: { mint, name, ticker, traits[], bio, metadataUri, imageUri }.
  app.post('/pets/launch/prepare', requireAuth, async (req, res) => {
    try {
      const conn = await rpcConnection();
      if (!conn) return res.status(503).json({ error: 'RPC unavailable' });

      const b = req.body || {};
      const mintStr = b.mint;
      const name = String(b.name || '').trim();
      const symbol = String(b.ticker || '').trim().toUpperCase();
      const metadataUri = String(b.metadataUri || '').trim();
      const traits = Array.isArray(b.traits) ? b.traits.map(String).slice(0, 3) : [];
      const bio = String(b.bio || '').slice(0, 1000);
      const imageUri = String(b.imageUri || '');

      if (!isPubkey(mintStr)) return res.status(400).json({ error: 'invalid mint pubkey' });
      if (!name || name.length > 32) return res.status(400).json({ error: 'name: 1-32 chars' });
      if (!symbol || symbol.length > 10) return res.status(400).json({ error: 'ticker: 1-10 chars' });
      if (!/^https:\/\//.test(metadataUri)) return res.status(400).json({ error: 'metadataUri must be https' });

      // The mint must be fresh (client-generated keypair, unused).
      const mintInfo = await conn.getAccountInfo(new PublicKey(mintStr));
      if (mintInfo) return res.status(400).json({ error: 'mint already exists on-chain' });

      // Launcher must hold enough SOL for rent + fees.
      const launcher = new PublicKey(req.auth.pubkey);
      const bal = await conn.getBalance(launcher);
      if (bal < 0.03 * 1e9) {
        return res.status(400).json({
          error: 'insufficient SOL',
          detail: 'The launcher wallet needs ~0.03 SOL for mint rent and fees.',
        });
      }

      // Generate the pet's own wallet. It becomes the coin's `creator`, so
      // ALL creator fees flow to the pet automatically (pump.fun protocol).
      // The launcher does nothing extra — they just sign as usual.
      let petWallet;
      try {
        petWallet = generatePetWallet();
      } catch (e) {
        console.error('[pets] pet wallet generation failed:', e.message);
        return res.status(500).json({
          error: 'pet wallet unavailable',
          detail: e.message,
        });
      }
      const petCreator = new PublicKey(petWallet.pubkey);

      const createIx = await PUMP_SDK.createV2Instruction({
        mint: new PublicKey(mintStr),
        name,
        symbol,
        uri: metadataUri,
        creator: petCreator,
        user: launcher,
        mayhemMode: false,
        creatorFeeBps: new BN(0),
        holderReward: false,
      });

      const { blockhash } = await conn.getLatestBlockhash('confirmed');
      const tx = new VersionedTransaction(
        new TransactionMessage({
          payerKey: launcher,
          recentBlockhash: blockhash,
          instructions: [
            ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
            createIx,
          ],
        }).compileToV0Message()
      );
      const txBase64 = Buffer.from(tx.serialize()).toString('base64');

      await pool.query(
        `INSERT INTO launch_intents (mint, user_id, launcher_wallet, name, symbol,
                                     metadata_uri, traits, bio,
                                     pet_wallet_pubkey, pet_wallet_encrypted,
                                     expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10, now() + interval '24 hours')
         ON CONFLICT (mint) DO UPDATE SET
           user_id = EXCLUDED.user_id, launcher_wallet = EXCLUDED.launcher_wallet,
           name = EXCLUDED.name, symbol = EXCLUDED.symbol,
           metadata_uri = EXCLUDED.metadata_uri,
           traits = EXCLUDED.traits, bio = EXCLUDED.bio,
           pet_wallet_pubkey = EXCLUDED.pet_wallet_pubkey,
           pet_wallet_encrypted = EXCLUDED.pet_wallet_encrypted,
           created_at = now(), expires_at = now() + interval '24 hours'`,
        [
          mintStr, req.auth.sub, req.auth.pubkey, name, symbol, metadataUri,
          JSON.stringify(traits), bio,
          petWallet.pubkey, petWallet.encryptedSecret,
        ]
      );

      // Stash the portrait URL on the intent row so submit can copy it to pets.
      await pool.query(
        `UPDATE launch_intents SET image_url = $2 WHERE mint = $1`,
        [mintStr, imageUri || null]
      );

      // Return the pet wallet pubkey only — NEVER the encrypted secret.
      res.json({ data: { txBase64, mint: mintStr, petWallet: petWallet.pubkey } });
    } catch (e) {
      console.error('[pets] prepare failed:', e.message);
      res.status(500).json({ error: 'prepare failed', detail: e.message });
    }
  });

  // Submit a signed launch transaction. The wallet signs in the browser; the
  // backend sends + confirms via its RPC, then records the pet.
  // Body: { mint, signedTxBase64 }. Returns { mint, signature }.
  app.post('/pets/launch/submit', requireAuth, async (req, res) => {
    try {
      const conn = await rpcConnection();
      if (!conn) return res.status(503).json({ error: 'RPC unavailable' });
      const { mint, signedTxBase64 } = req.body || {};
      if (!isPubkey(mint) || typeof signedTxBase64 !== 'string' || !signedTxBase64) {
        return res.status(400).json({ error: 'mint and signedTxBase64 are required' });
      }

      const { rows: intents } = await pool.query(
        'SELECT * FROM launch_intents WHERE mint = $1 AND expires_at > now()',
        [mint]
      );
      if (!intents.length) {
        return res.status(400).json({ error: 'no live launch intent for this mint (expired or unknown)' });
      }
      const intent = intents[0];
      if (intent.launcher_wallet !== req.auth.pubkey) {
        return res.status(403).json({ error: 'intent belongs to a different wallet' });
      }

      let tx;
      try {
        tx = VersionedTransaction.deserialize(Buffer.from(signedTxBase64, 'base64'));
      } catch {
        return res.status(400).json({ error: 'invalid signed transaction' });
      }
      const mintPk = new PublicKey(mint);
      const keys = tx.message.staticAccountKeys || [];
      if (!keys.some((k) => k.equals(mintPk))) {
        return res.status(400).json({ error: 'transaction does not touch this mint' });
      }

      const signature = await conn.sendRawTransaction(tx.serialize(), {
        skipPreflight: false,
        preflightCommitment: 'confirmed',
        maxRetries: 3,
      });
      try {
        const latest = await conn.getLatestBlockhash('confirmed');
        await conn.confirmTransaction(
          { signature, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight },
          'confirmed'
        );
      } catch (confirmErr) {
        console.warn('[pets] submit confirm timed out:', confirmErr.message);
      }

      // Verify the mint now exists before recording.
      // RPC nodes can lag right after submit — retry with backoff, and fall
      // back to the transaction's confirmation status (if the tx landed, the
      // mint must exist; the account may just not be visible yet).
      let mintInfo = null;
      let txConfirmed = false;
      for (let i = 0; i < 10; i++) {
        try {
          mintInfo = await conn.getAccountInfo(mintPk, 'confirmed');
        } catch { /* retry */ }
        if (mintInfo) break;
        try {
          const st = await conn.getSignatureStatus(signature);
          const cs = st && st.value && st.value.confirmationStatus;
          if (cs === 'confirmed' || cs === 'finalized') txConfirmed = true;
        } catch { /* retry */ }
        await new Promise((r) => setTimeout(r, 2000));
      }
      if (!mintInfo && !txConfirmed) {
        return res.status(400).json({ error: 'mint not found on-chain after submit (tx may have failed)' });
      }
      if (!mintInfo && txConfirmed) {
        console.warn('[pets] tx confirmed but mint account not yet visible; recording anyway:', mint);
      }

      const imageUrl = intent.image_url || null;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO pets (mint, name, ticker, traits, bio, image_url, creator_wallet,
                             launch_signature, pet_wallet_pubkey, pet_wallet_encrypted)
           VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10)
           ON CONFLICT (mint) DO UPDATE SET
             name = EXCLUDED.name, ticker = EXCLUDED.ticker,
             traits = EXCLUDED.traits, bio = EXCLUDED.bio,
             image_url = COALESCE(EXCLUDED.image_url, pets.image_url),
             launch_signature = EXCLUDED.launch_signature,
             pet_wallet_pubkey = COALESCE(EXCLUDED.pet_wallet_pubkey, pets.pet_wallet_pubkey),
             pet_wallet_encrypted = COALESCE(EXCLUDED.pet_wallet_encrypted, pets.pet_wallet_encrypted)`,
          [
            mint, intent.name, intent.symbol,
            JSON.stringify(intent.traits || []),
            intent.bio || '', imageUrl,
            intent.launcher_wallet, signature,
            intent.pet_wallet_pubkey || null,
            intent.pet_wallet_encrypted || null,
          ]
        );
        await client.query(
          `INSERT INTO watched_mints (mint, origin, active) VALUES ($1,'TAMASTREAM',true)
           ON CONFLICT (mint) DO UPDATE SET active = true, origin = 'TAMASTREAM'`,
          [mint]
        );
        await client.query('DELETE FROM launch_intents WHERE mint = $1', [mint]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }

      res.json({ data: { mint, signature } });
    } catch (e) {
      console.error('[pets] submit failed:', e.message);
      res.status(500).json({ error: 'submit failed', detail: e.message });
    }
  });

  // List the caller's pending (unrecorded) launch intents so the UI can offer recovery.
  app.get('/pets/launch/pending', requireAuth, async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT mint, name, symbol, image_url, created_at
         FROM launch_intents WHERE launcher_wallet = $1 AND expires_at > now()
         ORDER BY created_at DESC`,
        [req.auth.pubkey]
      );
      res.json({ data: rows });
    } catch (e) {
      res.status(500).json({ error: 'failed to list pending launches' });
    }
  });

  // Recover a launch whose tx landed but whose pet record was never written
  // (e.g. the post-submit verification flaked on RPC lag). Auth: launcher only.
  app.post('/pets/launch/recover', requireAuth, async (req, res) => {
    try {
      const conn = await rpcConnection();
      if (!conn) return res.status(503).json({ error: 'RPC unavailable' });
      const { mint } = req.body || {};
      if (!isPubkey(mint)) return res.status(400).json({ error: 'mint is required' });

      const { rows: existing } = await pool.query('SELECT mint FROM pets WHERE mint = $1', [mint]);
      if (existing.length) return res.json({ data: { mint, recovered: false, reason: 'already recorded' } });

      const { rows: intents } = await pool.query(
        'SELECT * FROM launch_intents WHERE mint = $1',
        [mint]
      );
      if (!intents.length) return res.status(404).json({ error: 'no launch intent for this mint' });
      const intent = intents[0];
      if (intent.launcher_wallet !== req.auth.pubkey) {
        return res.status(403).json({ error: 'intent belongs to a different wallet' });
      }

      // Confirm the mint actually exists on-chain (retry for RPC lag).
      const mintPk = new PublicKey(mint);
      let mintInfo = null;
      for (let i = 0; i < 10 && !mintInfo; i++) {
        try { mintInfo = await conn.getAccountInfo(mintPk, 'confirmed'); } catch { /* retry */ }
        if (!mintInfo) await new Promise((r) => setTimeout(r, 2000));
      }
      if (!mintInfo) return res.status(400).json({ error: 'mint not found on-chain' });

      const imageUrl = intent.image_url || null;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO pets (mint, name, ticker, traits, bio, image_url, creator_wallet,
                             launch_signature, pet_wallet_pubkey, pet_wallet_encrypted)
           VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10)
           ON CONFLICT (mint) DO NOTHING`,
          [
            mint, intent.name, intent.symbol,
            JSON.stringify(intent.traits || []),
            intent.bio || '', imageUrl,
            intent.launcher_wallet, intent.launch_signature || null,
            intent.pet_wallet_pubkey || null,
            intent.pet_wallet_encrypted || null,
          ]
        );
        await client.query(
          `INSERT INTO watched_mints (mint, origin, active) VALUES ($1,'TAMASTREAM',true)
           ON CONFLICT (mint) DO UPDATE SET active = true, origin = 'TAMASTREAM'`,
          [mint]
        );
        await client.query('DELETE FROM launch_intents WHERE mint = $1', [mint]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
      res.json({ data: { mint, recovered: true } });
    } catch (e) {
      console.error('[pets] recover failed:', e.message);
      res.status(500).json({ error: 'recover failed', detail: e.message });
    }
  });

  // Import a coin launched directly on pump.fun as a Tamastream pet.
  // Takes a mint (CA); verifies it on-chain, pulls name/symbol/image from
  // pump.fun metadata when not supplied, generates the pet's own wallet
  // (user funds it manually — fees are NOT auto-routed for imports).
  app.post('/pets/launch/import', requireAuth, async (req, res) => {
    try {
      const conn = await rpcConnection();
      if (!conn) return res.status(503).json({ error: 'RPC unavailable' });
      const { mint, name, ticker, traits, bio, image_url } = req.body || {};
      if (!isPubkey(mint)) return res.status(400).json({ error: 'mint (CA) is required' });

      const { rows: existing } = await pool.query('SELECT mint FROM pets WHERE mint = $1', [mint]);
      if (existing.length) return res.status(409).json({ error: 'this coin is already a pet' });

      // Verify the mint exists on-chain (retry for RPC lag).
      const mintPk = new PublicKey(mint);
      let mintInfo = null;
      for (let i = 0; i < 8 && !mintInfo; i++) {
        try { mintInfo = await conn.getAccountInfo(mintPk, 'confirmed'); } catch { /* retry */ }
        if (!mintInfo) await new Promise((r) => setTimeout(r, 1500));
      }
      if (!mintInfo) return res.status(400).json({ error: 'mint not found on-chain' });

      // Pull token metadata from pump.fun when the caller didn't supply it.
      let meta = {};
      try {
        const r = await fetch(`https://frontend-api.pump.fun/coins/${mint}`, { signal: AbortSignal.timeout(10000) });
        if (r.ok) meta = await r.json();
      } catch { /* fall back to supplied values */ }

      const petName = (name || meta.name || 'Nameless').toString().slice(0, 24);
      const petTicker = (ticker || meta.symbol || 'PET').toString().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10) || 'PET';
      const petBio = (bio ?? meta.description ?? '').toString().slice(0, 280);
      const petTraits = Array.isArray(traits) && traits.length ? traits.slice(0, 3) : ['Hyper'];
      const petImage = image_url || meta.image_uri || null;

      const petWallet = generatePetWallet();

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO pets (mint, name, ticker, traits, bio, image_url, creator_wallet,
                             launch_signature, pet_wallet_pubkey, pet_wallet_encrypted)
           VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10)
           ON CONFLICT (mint) DO NOTHING`,
          [
            mint, petName, petTicker, JSON.stringify(petTraits), petBio, petImage,
            req.auth.pubkey, null,
            petWallet.pubkey, petWallet.encryptedSecret,
          ]
        );
        await client.query(
          `INSERT INTO watched_mints (mint, origin, active) VALUES ($1,'TAMASTREAM',true)
           ON CONFLICT (mint) DO UPDATE SET active = true, origin = 'TAMASTREAM'`,
          [mint]
        );
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
      res.json({ data: { mint, name: petName, ticker: petTicker, petWallet: petWallet.pubkey, image: petImage } });
    } catch (e) {
      console.error('[pets] import failed:', e.message);
      res.status(500).json({ error: 'import failed', detail: e.message });
    }
  });

  // ---------------------------------------------------------------- trading

  // Trade history (public). Last 20 trades for a pet.
  app.get('/pets/:mint/trades', async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT id, pet_mint, action, input_mint, output_mint,
                input_amount_lamports, output_amount_approx, signature, created_at
         FROM pet_trades WHERE pet_mint = $1 ORDER BY created_at DESC LIMIT 20`,
        [req.params.mint]
      );
      res.json({ data: rows });
    } catch (e) {
      res.status(500).json({ error: 'failed to fetch trades', detail: e.message });
    }
  });

  // Execute a trade with the pet's own wallet (auth — launcher only).
  // Body: { action: 'buy', tokenMint, amountSol }.
  // Conservative: SOL -> token buys only, 0.5 SOL max per trade,
  // max 5 trades per pet per hour.
  app.post('/pets/:mint/trade', requireAuth, async (req, res) => {
    try {
      const conn = await rpcConnection();
      if (!conn) return res.status(503).json({ error: 'RPC unavailable' });

      const { action, tokenMint, amountSol } = req.body || {};
      if (action !== 'buy') {
        return res.status(400).json({ error: "action must be 'buy' (sells coming later)" });
      }
      if (!isPubkey(tokenMint)) {
        return res.status(400).json({ error: 'invalid tokenMint' });
      }
      const amt = Number(amountSol);
      if (!Number.isFinite(amt) || amt < 0.001 || amt > 0.5) {
        return res.status(400).json({ error: 'amountSol must be between 0.001 and 0.5' });
      }

      // Pet must exist, have a wallet, and the caller must be the launcher.
      const { rows } = await pool.query(
        `SELECT mint, creator_wallet, pet_wallet_pubkey, pet_wallet_encrypted
         FROM pets WHERE mint = $1`,
        [req.params.mint]
      );
      if (!rows.length) return res.status(404).json({ error: 'pet not found' });
      const pet = rows[0];
      if (pet.creator_wallet !== req.auth.pubkey) {
        return res.status(403).json({ error: 'only the pet launcher can trigger trades' });
      }
      if (!pet.pet_wallet_pubkey || !pet.pet_wallet_encrypted) {
        return res.status(400).json({ error: 'this pet has no wallet yet' });
      }

      // Rate limit: max 5 trades per pet per hour.
      const { rows: recent } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM pet_trades
         WHERE pet_mint = $1 AND created_at > now() - interval '1 hour'`,
        [req.params.mint]
      );
      if (recent[0].n >= 5) {
        return res.status(429).json({ error: 'trade rate limit: max 5 trades per hour per pet' });
      }

      // Balance check: need amount + 0.01 SOL buffer for fees/rent.
      const petKeypair = decryptPetWallet(pet.pet_wallet_encrypted);
      const balance = await conn.getBalance(petKeypair.publicKey);
      const lamports = Math.floor(amt * 1e9);
      if (balance < lamports + 0.01 * 1e9) {
        return res.status(400).json({
          error: 'insufficient pet wallet balance',
          detail: `Pet wallet holds ${(balance / 1e9).toFixed(4)} SOL; needs ${amt} + 0.01 buffer.`,
        });
      }

      // Quote + execute via Jupiter.
      const quote = await getQuote(SOL_MINT, tokenMint, lamports, 100);
      const { signature, outAmount } = await executeSwap(petKeypair, quote, conn);

      await pool.query(
        `INSERT INTO pet_trades
           (pet_mint, action, input_mint, output_mint, input_amount_lamports,
            output_amount_approx, signature)
         VALUES ($1,'buy',$2,$3,$4,$5,$6)`,
        [
          req.params.mint, SOL_MINT, tokenMint, lamports,
          outAmount ? BigInt(outAmount).toString() : null, signature,
        ]
      );

      res.json({
        data: {
          signature,
          inputAmountSol: amt,
          outputMint: tokenMint,
          outputAmountApprox: outAmount,
          explorerUrl: `https://solscan.io/tx/${signature}`,
        },
      });
    } catch (e) {
      console.error('[pets] trade failed:', e.message);
      res.status(500).json({ error: 'trade failed', detail: e.message });
    }
  });

  // AI chat with the pet (auth). Conversational messages go to OpenAI;
  // action commands (dance, sleep, ...) are handled client-side and never
  // reach this endpoint.
  // Body: { message, history: [{role: 'user'|'pet', text}], mood, market: {mcap, change24h} }.
  // Returns { text, emoji }. Rate limited: 30 msgs / pet / hour.
  app.post('/pets/:mint/chat', requireAuth, async (req, res) => {
    try {
      const { message, history, mood, market } = req.body || {};
      if (typeof message !== 'string' || !message.trim()) {
        return res.status(400).json({ error: 'message is required' });
      }
      if (message.length > 500) {
        return res.status(400).json({ error: 'message too long (500 chars max)' });
      }

      const { rows } = await pool.query(
        `SELECT name, ticker, traits FROM pets WHERE mint = $1`,
        [req.params.mint]
      );
      if (!rows.length) return res.status(404).json({ error: 'pet not found' });
      const pet = rows[0];

      if (!chatRateOk(req.params.mint)) {
        return res.status(429).json({ error: 'chat rate limit: max 30 AI messages per hour per pet' });
      }

      const reply = await chatWithPet({
        pet: { name: pet.name, ticker: pet.ticker, traits: pet.traits || [] },
        message,
        history: Array.isArray(history) ? history.slice(-10) : [],
        mood: typeof mood === 'string' ? mood : 'NEUTRAL',
        market: market && typeof market === 'object' ? market : null,
      });
      res.json({ data: reply });
    } catch (e) {
      console.error('[pets] chat failed:', e.message);
      const status = /not set|unavailable/i.test(e.message) ? 503 : 500;
      res.status(status).json({ error: 'chat failed', detail: e.message });
    }
  });
}
