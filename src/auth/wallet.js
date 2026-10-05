// src/auth/wallet.js — sign-in with wallet.
//
// Flow:
//   POST /auth/nonce   { pubkey }                     -> { nonce, message }
//   client signs "SIGN IN TO TAMASTREAM\n<nonce>" with their wallet
//   POST /auth/verify  { pubkey, nonce, signature }   -> { token, user }
//
// Rules:
//   * Nonces are single-use and expire after 10 minutes.
//   * Private keys / seed phrases are NEVER accepted anywhere in this flow.
//   * We only ever accept a 64-byte ed25519 signature, never a secret.

import nacl from 'tweetnacl';
import jwt from 'jsonwebtoken';
import { pool } from '../db/pool.js';

export const SIGN_IN_PREFIX = 'SIGN IN TO TAMASTREAM';
export const NONCE_TTL_MS = 10 * 60 * 1000;

function signInMessage(nonce) {
  return `${SIGN_IN_PREFIX}\n${nonce}`;
}

function randomNonce() {
  return Buffer.from(nacl.randomBytes(16)).toString('hex');
}

/** POST /auth/nonce — issue a fresh single-use nonce for a pubkey. */
export async function issueNonce(req, res) {
  const { pubkey } = req.body ?? {};
  if (typeof pubkey !== 'string' || pubkey.length < 32 || pubkey.length > 64) {
    return res.status(400).json({ error: 'invalid pubkey' });
  }
  const nonce = randomNonce();
  const expiresAt = new Date(Date.now() + NONCE_TTL_MS);
  await pool.query(`DELETE FROM auth_nonces WHERE expires_at < now() - interval '1 hour'`);
  await pool.query(
    `INSERT INTO auth_nonces (pubkey, nonce, expires_at, used)
     VALUES ($1, $2, $3, false)`,
    [pubkey, nonce, expiresAt]
  );
  res.json({ nonce, message: signInMessage(nonce), expires_at: expiresAt.toISOString() });
}

/** POST /auth/verify — verify signature, create session. */
export async function verifySignature(req, res) {
  const { pubkey, nonce, signature } = req.body ?? {};
  if (!pubkey || !nonce || !signature) {
    return res.status(400).json({ error: 'pubkey, nonce and signature are required' });
  }
  // Reject anything that smells like a private key.
  if (typeof signature !== 'string' || signature.length > 200) {
    return res.status(400).json({ error: 'invalid signature format' });
  }

  const { rows } = await pool.query(
    'SELECT * FROM auth_nonces WHERE pubkey = $1 AND nonce = $2',
    [pubkey, nonce]
  );
  const row = rows[0];
  if (!row || row.used || new Date(row.expires_at) < new Date()) {
    return res.status(401).json({ error: 'nonce invalid, used, or expired' });
  }

  let sigBytes;
  try {
    sigBytes = Buffer.from(signature, 'base64');
  } catch {
    return res.status(400).json({ error: 'signature must be base64' });
  }
  if (sigBytes.length !== 64) {
    return res.status(400).json({ error: 'signature must be 64 bytes (ed25519)' });
  }

  let pubkeyBytes;
  try {
    const { PublicKey } = await import('@solana/web3.js');
    pubkeyBytes = new PublicKey(pubkey).toBytes();
  } catch {
    return res.status(400).json({ error: 'invalid pubkey' });
  }

  const message = new TextEncoder().encode(signInMessage(nonce));
  const ok = nacl.sign.detached.verify(message, sigBytes, pubkeyBytes);
  if (!ok) {
    return res.status(401).json({ error: 'signature verification failed' });
  }

  await pool.query('UPDATE auth_nonces SET used = true WHERE pubkey = $1 AND nonce = $2', [pubkey, nonce]);

  // Find-or-create user, link wallet.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let user;
    const existing = await client.query(
      'SELECT u.* FROM users u JOIN wallets w ON w.user_id = u.id WHERE w.pubkey = $1',
      [pubkey]
    );
    if (existing.rows.length) {
      user = existing.rows[0];
    } else {
      const created = await client.query('INSERT INTO users DEFAULT VALUES RETURNING *');
      user = created.rows[0];
    }
    await client.query(
      `INSERT INTO wallets (user_id, pubkey, is_primary, verified_method)
       VALUES ($1, $2, true, 'signed_message')
       ON CONFLICT (pubkey) DO UPDATE
       SET verified_at = now(), verified_method = 'signed_message'`,
      [user.id, pubkey]
    );
    await client.query('COMMIT');

    const secret = process.env.JWT_SECRET;
    if (!secret) {
      return res.status(500).json({ error: 'JWT_SECRET is not configured' });
    }
    const token = jwt.sign({ sub: user.id, pubkey }, secret, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id } });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Express middleware: require a valid JWT session for user-scoped writes. */
export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'authentication required' });
  const secret = process.env.JWT_SECRET;
  if (!secret) return res.status(500).json({ error: 'JWT_SECRET is not configured' });
  try {
    req.auth = jwt.verify(token, secret); // { sub: userId, pubkey }
    next();
  } catch {
    return res.status(401).json({ error: 'invalid or expired session' });
  }
}
