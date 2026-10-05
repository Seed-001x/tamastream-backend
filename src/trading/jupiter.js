// src/trading/jupiter.js — Jupiter Lite swap integration for pet wallets.
//
// Pets trade with their own SOL (creator-fee revenue). Conservative by design:
// SOL -> token buys only, small sizes, explicit slippage.
//
// Flow:
//   1. getQuote(inputMint, outputMint, amountLamports, slippageBps) -> quote JSON
//   2. buildSwapTransaction(quote, userPublicKey) -> base64 unsigned tx (Jupiter builds it)
//   3. executeSwap(petKeypair, quote) -> signs + sends via backend RPC, returns signature
//
// Jupiter Lite API: https://lite-api.jup.ag (no API key needed).

import { VersionedTransaction } from '@solana/web3.js';

const JUP_BASE = 'https://lite-api.jup.ag/swap/v1';

export const SOL_MINT = 'So11111111111111111111111111111111111111112';

/**
 * Get a swap quote from Jupiter.
 * @param {string} inputMint  base58 mint (SOL for buys)
 * @param {string} outputMint base58 mint (token to buy)
 * @param {number} amountLamports integer lamports of input
 * @param {number} slippageBps e.g. 100 = 1%
 * @returns {object} Jupiter quote response
 */
export async function getQuote(inputMint, outputMint, amountLamports, slippageBps = 100) {
  const url =
    `${JUP_BASE}/quote?inputMint=${encodeURIComponent(inputMint)}` +
    `&outputMint=${encodeURIComponent(outputMint)}` +
    `&amount=${Math.floor(amountLamports)}` +
    `&slippageBps=${slippageBps}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`jupiter quote failed: ${res.status} ${text.slice(0, 200)}`);
  }
  const quote = await res.json();
  if (quote.error) throw new Error(`jupiter quote error: ${quote.error}`);
  if (!quote.outAmount || !quote.routePlan?.length) {
    throw new Error('jupiter returned no route for this pair');
  }
  return quote;
}

/**
 * Ask Jupiter to build the swap transaction for a quote.
 * @param {object} quoteResponse the quote from getQuote()
 * @param {string} userPublicKey base58 — the pet wallet (fee payer + signer)
 * @returns {string} base64-encoded unsigned VersionedTransaction
 */
export async function buildSwapTransaction(quoteResponse, userPublicKey) {
  const res = await fetch(`${JUP_BASE}/swap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quoteResponse,
      userPublicKey,
      wrapAndUnwrapSol: true, // handle wSOL automatically
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 'auto',
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`jupiter swap build failed: ${res.status} ${text.slice(0, 200)}`);
  }
  const j = await res.json();
  if (j.error) throw new Error(`jupiter swap error: ${j.error}`);
  if (!j.swapTransaction) throw new Error('jupiter returned no swapTransaction');
  return j.swapTransaction;
}

/**
 * Execute a SOL -> token buy for a pet.
 * @param {Keypair} petKeypair the pet's wallet (signs)
 * @param {object} quoteResponse from getQuote()
 * @param {import('@solana/web3.js').Connection} connection backend RPC
 * @returns {{ signature: string, outAmount: string }}
 */
export async function executeSwap(petKeypair, quoteResponse, connection) {
  const txBase64 = await buildSwapTransaction(
    quoteResponse,
    petKeypair.publicKey.toBase58()
  );
  const tx = VersionedTransaction.deserialize(Buffer.from(txBase64, 'base64'));
  tx.sign([petKeypair]);

  const signature = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
    maxRetries: 3,
  });

  // Best-effort confirmation (don't fail the trade record on timeout).
  try {
    const latest = await connection.getLatestBlockhash('confirmed');
    await connection.confirmTransaction(
      {
        signature,
        blockhash: latest.blockhash,
        lastValidBlockHeight: latest.lastValidBlockHeight,
      },
      'confirmed'
    );
  } catch (e) {
    console.warn('[trading] confirm timed out:', e.message);
  }

  return { signature, outAmount: quoteResponse.outAmount };
}
