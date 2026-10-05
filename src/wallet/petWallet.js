// src/wallet/petWallet.js — Per-pet Solana wallets.
//
// Every launched pet gets its own Solana wallet. The wallet is set as the
// `creator` on the pump.fun coin, so ALL of the coin's creator fees flow to
// the pet automatically (protocol-level, no forwarding needed).
//
// The 64-byte secret key is encrypted with AES-256-GCM using the
// WALLET_ENCRYPTION_KEY env var (32-byte hex string) before storage.
// Only the pubkey ever leaves the server — the encrypted secret is stored
// in Postgres and is only decrypted in-memory when the pet needs to sign
// (e.g. future trading worker).
//
// Security boundaries:
//   * NEVER log, return, or expose the secret key or encrypted blob to clients.
//   * The /pets/:mint/wallet endpoint returns pubkey + balance ONLY.
//   * WALLET_ENCRYPTION_KEY must be set before any wallet is generated.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Keypair } from '@solana/web3.js';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12; // GCM standard nonce length
const TAG_LEN = 16;

function getKey() {
  const hex = process.env.WALLET_ENCRYPTION_KEY;
  if (!hex) throw new Error('WALLET_ENCRYPTION_KEY is not set');
  const key = Buffer.from(hex, 'hex');
  if (key.length !== 32) {
    throw new Error('WALLET_ENCRYPTION_KEY must be a 32-byte hex string (64 hex chars)');
  }
  return key;
}

/**
 * Generate a new pet wallet.
 * @returns {{ pubkey: string, encryptedSecret: string }}
 *   pubkey — base58 Solana address (safe to expose)
 *   encryptedSecret — base64 blob (iv + authTag + ciphertext), store in DB
 */
export function generatePetWallet() {
  const key = getKey(); // throws if not set — fail loud, never store plaintext
  const kp = Keypair.generate();
  const secret = Buffer.from(kp.secretKey); // 64 bytes

  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(secret), cipher.final()]);
  const tag = cipher.getAuthTag();

  // Layout: [iv(12) | tag(16) | ciphertext(64)] -> base64
  const blob = Buffer.concat([iv, tag, ciphertext]).toString('base64');
  // Wipe the plaintext secret from memory ASAP.
  secret.fill(0);

  return {
    pubkey: kp.publicKey.toBase58(),
    encryptedSecret: blob,
  };
}

/**
 * Decrypt a stored wallet blob back into a Keypair.
 * @param {string} encryptedSecret — base64 blob from generatePetWallet()
 * @returns {Keypair}
 */
export function decryptPetWallet(encryptedSecret) {
  const key = getKey();
  if (typeof encryptedSecret !== 'string' || !encryptedSecret) {
    throw new Error('encryptedSecret is required');
  }
  const blob = Buffer.from(encryptedSecret, 'base64');
  if (blob.length < IV_LEN + TAG_LEN + 64) {
    throw new Error('malformed encrypted wallet blob');
  }
  const iv = blob.subarray(0, IV_LEN);
  const tag = blob.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ciphertext = blob.subarray(IV_LEN + TAG_LEN);

  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const secret = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  if (secret.length !== 64) {
    secret.fill(0);
    throw new Error('decrypted secret has wrong length');
  }
  // NB: Keypair.fromSecretKey slices views into the input buffer (it does NOT
  // copy), so pass a copy — the original is zeroed below for hygiene.
  const kp = Keypair.fromSecretKey(Buffer.from(secret));
  secret.fill(0);
  return kp;
}
