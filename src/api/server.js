// src/api/server.js — Tamastream API entrypoint.
import express from 'express';
import { pool } from '../db/pool.js';
import { issueNonce, verifySignature, requireAuth } from '../auth/wallet.js';
import { registerPetRoutes } from './pets.js';

const PORT = Number(process.env.PORT || 3000);

const app = express();

// CORS — allow the frontend to call the API from browsers.
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: '10mb' })); // pet portraits ride as base64 data URLs

// Express 4 does not catch errors thrown in async route handlers — wrap every
// route so async failures become 500s, never process crashes.
for (const m of ['get', 'post', 'patch', 'put', 'delete']) {
  const orig = app[m].bind(app);
  app[m] = (path, ...handlers) =>
    orig(
      path,
      ...handlers.map((h) => (req, res, next) =>
        Promise.resolve(h(req, res, next)).catch(next)
      )
    );
}

async function rpcConnection() {
  if (!process.env.RPC_URL) return null;
  const { Connection } = await import('@solana/web3.js');
  return new Connection(process.env.RPC_URL, 'confirmed');
}

// ---------------------------------------------------------------- auth
app.post('/auth/nonce', issueNonce);
app.post('/auth/verify', verifySignature);

// ---------------------------------------------------------------- pets
registerPetRoutes(app, { pool, rpcConnection, requireAuth });

// ---------------------------------------------------------------- health
app.get('/health', async (req, res) => {
  let pets = null;
  try {
    const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM pets');
    pets = rows[0].n;
  } catch { /* db may be unreachable */ }
  res.json({ ok: true, pets, rpc: Boolean(process.env.RPC_URL) });
});

// ---------------------------------------------------------------- errors
// (Registered last, after all routes.)
app.use((err, req, res, _next) => {
  console.error('[api] request failed:', err.message);
  res.status(500).json({ error: 'internal error' });
});

// ---------------------------------------------------------------- boot
app.listen(PORT, () => {
  console.log(`[api] listening on :${PORT}`);
  if (!process.env.DATABASE_URL) console.warn('[api] DATABASE_URL is not set — requests will fail');
  if (!process.env.JWT_SECRET) console.warn('[api] JWT_SECRET is not set — auth will fail');
  if (!process.env.RPC_URL) console.warn('[api] RPC_URL is not set — launch endpoints will 503');
});
