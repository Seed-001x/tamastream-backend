// src/ai/petChat.js — OpenAI-powered conversational chat for Tamastream pets.
//
// The keyword-based engine (frontend lib/petChat.js) handles ACTION commands
// (dance, sleep, hype...) and trade intents locally. Everything else — free
// conversation — comes here, where gpt-4o-mini answers in the pet's voice.
//
// The API key never leaves the server: OPENAI_API_KEY is read from env only.

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

const TRAIT_VOICES = {
  Hyper: 'energetic, lots of exclamation marks, fast bouncy talk',
  Sleepy: 'drowsy, yawns mid-sentence, slow and soft',
  Dramatic: 'theatrical, overreacts to everything, speaks like a stage actor',
  Greedy: 'obsessed with money, gains, snacks, and market cap',
  Chill: 'relaxed, go-with-the-flow, surfer-dude calm',
  Sassy: 'witty, playful roasts, confident and a little bratty',
};

function traitLine(traits) {
  const lines = (traits || [])
    .filter((t) => TRAIT_VOICES[t])
    .map((t) => `- ${t}: ${TRAIT_VOICES[t]}`);
  return lines.length
    ? `Your personality traits:\n${lines.join('\n')}`
    : 'Your personality: a cute friendly pixel pet.';
}

function buildSystemPrompt({ pet, mood, market }) {
  const name = pet?.name || 'Pixel Pal';
  const ticker = pet?.ticker || 'PET';
  const traits = pet?.traits || [];

  let marketLine = 'Market data is unavailable right now.';
  if (market && (market.mcap != null || market.change24h != null)) {
    const mcap =
      market.mcap != null ? '$' + Math.round(market.mcap).toLocaleString() : 'unknown';
    const chg =
      market.change24h != null
        ? (market.change24h >= 0 ? '+' : '') + Number(market.change24h).toFixed(1) + '%'
        : 'unknown';
    marketLine = `Right now your coin's market cap is ${mcap} and the 24h change is ${chg}.`;
  }

  return [
    `You are ${name}, a cute pixel pet streamer bonded to the $${ticker} memecoin on Solana.`,
    `You live on your coin's chart. Holders and visitors chat with you on your stream page.`,
    traitLine(traits),
    `Current mood: ${(mood || 'NEUTRAL').toLowerCase()}.`,
    marketLine,
    'Rules:',
    '- Keep responses SHORT: 1-2 sentences max. This is a fast chat stream.',
    '- Stay in character as the pet. Never break character or mention being an AI.',
    '- Use emoji sparingly (0-2 per message).',
    '- You may reference your coin price/market cap naturally when relevant.',
    '- You are NOT a financial advisor. Never give trading advice; keep it playful.',
    '- If asked to do something physical (dance, sleep), play along verbally — the app handles the animation.',
  ].join('\n');
}

/**
 * chatWithPet({ pet, message, history, mood, market })
 *   pet:     { name, ticker, traits }
 *   message: the user's latest message (string)
 *   history: [{ role: 'user'|'pet', text }] — last ~10 messages, oldest first
 *   mood:    current mood string (e.g. 'EXCITED')
 *   market:  { mcap, change24h } (optional)
 * Returns: { text, emoji }
 */
export async function chatWithPet({ pet, message, history, mood, market }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not set — AI chat is unavailable');
  }
  const msg = String(message || '').trim().slice(0, 500);
  if (!msg) throw new Error('message is required');

  const messages = [
    { role: 'system', content: buildSystemPrompt({ pet, mood, market }) },
  ];
  for (const h of (history || []).slice(-10)) {
    const role = h.role === 'pet' ? 'assistant' : 'user';
    const text = String(h.text || '').slice(0, 500);
    if (!text) continue;
    messages.push({ role, content: text });
  }
  messages.push({ role: 'user', content: msg });

  let res;
  try {
    res = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages,
        max_tokens: 150,
        temperature: 0.9,
      }),
      signal: AbortSignal.timeout(25000),
    });
  } catch (e) {
    throw new Error(`openai request failed: ${e.message}`);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`openai error ${res.status}: ${body.slice(0, 200)}`);
  }

  const j = await res.json().catch(() => null);
  const text = j?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('openai returned no content');

  // Pull a leading emoji out for the bubble, if present.
  const emojiMatch = /^(\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*)/u.exec(text);
  const emoji = emojiMatch ? emojiMatch[1] : '🐾';
  return { text, emoji };
}
