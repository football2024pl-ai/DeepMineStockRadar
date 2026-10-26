'use strict';

const express = require('express');
const crypto = require('crypto');
const path = require('path');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const API_KEY = String(process.env.STOCK_API_KEY || '');
let latestSnapshot = null;
let latestReceivedAt = null;

app.disable('x-powered-by');
app.use(express.json({ limit: '256kb', strict: true }));
app.use(express.static(path.join(__dirname, 'public'), { etag: true, maxAge: '1h' }));

function secureEqual(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

function requireRobloxKey(req, res, next) {
  if (!API_KEY || API_KEY === 'replace-this-with-a-long-random-secret') {
    return res.status(503).json({ ok: false, error: 'STOCK_API_KEY is not configured on the website server.' });
  }
  if (!secureEqual(req.get('x-api-key'), API_KEY)) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  next();
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function cleanText(value, maxLength = 180) {
  return String(value ?? '').slice(0, maxLength);
}

function cleanColor(value) {
  if (!Array.isArray(value) || value.length < 3) return null;
  return value.slice(0, 3).map((v) => Math.max(0, Math.min(255, Math.round(finiteNumber(v, 0)))));
}

function cleanItems(category, source) {
  if (!Array.isArray(source)) return null;
  const max = category === 'pickaxes' ? 120 : category === 'eggs' ? 8 : 20;
  if (source.length > max) return null;
  return source.map((item) => {
    if (!item || typeof item !== 'object') return null;
    const clean = {
      id: cleanText(item.id ?? (category === 'pickaxes' ? `pick-${item.level}` : ''), 80),
      name: cleanText(item.name, 140),
      emoji: cleanText(item.emoji || (category === 'pickaxes' ? '⛏️' : '✨'), 12),
      price: Math.max(0, finiteNumber(item.price, 0)),
      quantity: Math.max(0, Math.floor(finiteNumber(item.quantity, 0))),
      color: cleanColor(item.color),
      rarity: cleanText(item.rarity || '', 50),
      effect: cleanText(item.effect || '', 180),
      description: cleanText(item.description || '', 240),
      chance: Math.max(0, Math.min(1, finiteNumber(item.chance ?? item.stockChance, 0))),
      level: category === 'pickaxes' ? Math.max(1, Math.floor(finiteNumber(item.level, 1))) : undefined,
      hatchSeconds: category === 'eggs' ? Math.max(0, Math.floor(finiteNumber(item.hatchSeconds, 0))) : undefined,
      stats: category === 'auras' && item.stats && typeof item.stats === 'object' ? {
        strength: finiteNumber(item.stats.strength, 0),
        coins: finiteNumber(item.stats.coins, 0),
        luck: finiteNumber(item.stats.luck, 0)
      } : undefined
    };
    return clean.id && clean.name ? clean : null;
  }).filter(Boolean);
}

app.get('/api/health', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, connectedToGame: Boolean(latestSnapshot), lastReceivedAt: latestReceivedAt });
});

app.get('/api/stock', (req, res) => {
  res.set('Cache-Control', 'no-store, max-age=0');
  if (!latestSnapshot) {
    return res.status(200).json({
      ok: true,
      connected: false,
      message: 'Ожидается первая синхронизация от сервера Roblox.',
      receivedAt: null,
      snapshot: null
    });
  }
  res.json({ ok: true, connected: true, receivedAt: latestReceivedAt, snapshot: latestSnapshot });
});

app.post('/api/roblox-stock', requireRobloxKey, (req, res) => {
  const input = req.body;
  if (!input || input.source !== 'DeepMine' || !Number.isInteger(Number(input.cycle)) || !input.stocks) {
    return res.status(400).json({ ok: false, error: 'Invalid stock snapshot.' });
  }

  const cleanStocks = {};
  for (const category of ['auras', 'eggs', 'pickaxes']) {
    const group = input.stocks[category];
    if (!group || !Array.isArray(group.items)) {
      return res.status(400).json({ ok: false, error: `Missing ${category} stock.` });
    }
    const items = cleanItems(category, group.items);
    if (!items) return res.status(400).json({ ok: false, error: `Invalid ${category} items.` });
    cleanStocks[category] = {
      refreshAt: Math.max(0, Math.floor(finiteNumber(group.refreshAt, 0))),
      items
    };
  }

  const cycle = Math.floor(Number(input.cycle));
  if (latestSnapshot && cycle < latestSnapshot.cycle) {
    return res.status(409).json({ ok: false, error: 'A newer global stock cycle is already published.' });
  }

  latestSnapshot = {
    schemaVersion: 1,
    source: 'DeepMine',
    cycle,
    serverTime: Math.floor(finiteNumber(input.serverTime, Date.now() / 1000)),
    placeId: cleanText(input.placeId || '', 48),
    stocks: cleanStocks
  };
  latestReceivedAt = new Date().toISOString();
  res.json({ ok: true, cycle, receivedAt: latestReceivedAt });
});

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  console.error('[DeepMineStockWebsite]', error?.message || error);
  res.status(error?.status === 413 ? 413 : 400).json({ ok: false, error: 'Invalid request.' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`DeepMine Stock Website listening on port ${PORT}`);
  if (!API_KEY || API_KEY === 'replace-this-with-a-long-random-secret') {
    console.warn('STOCK_API_KEY is not configured. Website can open, but Roblox posts will be rejected.');
  }
});
