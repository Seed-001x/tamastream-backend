// src/api/pets.js — Tamastream pet launch pipeline (server side).
//
// Flow:
//   1. POST /pets/upload         (auth) — pet portrait PNG -> pump.fun IPFS
//      -> metadata JSON -> IPFS. Returns { imageUri, metadataUri }.
//   2. POST /pets/launch/prepare (auth) — validates params and builds an
//      UNSIGNED v0 transaction (pump create_v2). The client signs it with
//      the user's wallet AND the client-generated mint keypair, then POSTs
//      the signed bytes to /submit. The backend never holds keys.
//   3. POST /pets/launch/submit  (auth) — sends the signed tx via the
//      backend's RPC, confirms, then inserts the pet row and adds the mint
//      to watched_mints. Returns { mint, signature }.
//
// Boundaries:
//   * creator is the launcher's own wallet (they keep their creator fees).
//     TODO: route creator fees to a platform wallet when monetization lands.
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

      // Creator = the launcher (they keep their own creator fees).
      const createIx = await PUMP_SDK.createV2Instruction({
        mint: new PublicKey(mintStr),
        name,
        symbol,
        uri: metadataUri,
        creator: launcher,
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
                                     metadata_uri, traits, bio, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8, now() + interval '24 hours')
         ON CONFLICT (mint) DO UPDATE SET
           user_id = EXCLUDED.user_id, launcher_wallet = EXCLUDED.launcher_wallet,
           name = EXCLUDED.name, symbol = EXCLUDED.symbol,
           metadata_uri = EXCLUDED.metadata_uri,
           traits = EXCLUDED.traits, bio = EXCLUDED.bio,
           created_at = now(), expires_at = now() + interval '24 hours'`,
        [
          mintStr, req.auth.sub, req.auth.pubkey, name, symbol, metadataUri,
          JSON.stringify(traits), bio,
        ]
      );

      // Stash the portrait URL on the intent row so submit can copy it to pets.
      await pool.query(
        `UPDATE launch_intents SET image_url = $2 WHERE mint = $1`,
        [mintStr, imageUri || null]
      );

      res.json({ data: { txBase64, mint: mintStr } });
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
      const mintInfo = await conn.getAccountInfo(mintPk, 'confirmed');
      if (!mintInfo) {
        return res.status(400).json({ error: 'mint not found on-chain after submit (tx may have failed)' });
      }

      const imageUrl = intent.image_url || null;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO pets (mint, name, ticker, traits, bio, image_url, creator_wallet, launch_signature)
           VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8)
           ON CONFLICT (mint) DO UPDATE SET
             name = EXCLUDED.name, ticker = EXCLUDED.ticker,
             traits = EXCLUDED.traits, bio = EXCLUDED.bio,
             image_url = COALESCE(EXCLUDED.image_url, pets.image_url),
             launch_signature = EXCLUDED.launch_signature`,
          [
            mint, intent.name, intent.symbol,
            JSON.stringify(intent.traits || []),
            intent.bio || '', imageUrl,
            intent.launcher_wallet, signature,
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
}
