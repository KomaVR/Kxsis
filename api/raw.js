// /api/raw.js
// Node serverless handler (Vercel) - simple passthrough of remote text/html/JSON
// Replaces earlier brittle versions. Protects against SSRF, adds timeout and size limits.

const MAX_BYTES = 12 * 1024 * 1024; // 12 MB max
const TIMEOUT_MS = 15000;

function isPrivateHost(hostname) {
  if (!hostname) return true;
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return true;
  // ip-literals
  if (/^(127|10|192\.168|169\.254)\./.test(h)) return true;
  if (/^::1$/.test(h)) return true;
  if (/^fc00:|^fe80:/.test(h)) return true;
  return false;
}

export default async function handler(req, res) {
  try {
    const url = (req.query.url || req.query.u || '').trim();
    if (!url) return res.status(400).send('missing url');

    if (!/^https?:\/\//i.test(url)) return res.status(400).send('invalid url protocol');

    const parsed = new URL(url);
    if (isPrivateHost(parsed.hostname)) return res.status(403).send('forbidden host');

    // simple rate-limiter (per IP) - lightweight
    // Note: In serverless this is per-instance; consider external store for global rate-limiting
    if (!global.__kxsis_rate) global.__kxsis_rate = new Map();
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'anon';
    const now = Date.now();
    const entry = global.__kxsis_rate.get(ip) || { count: 0, ts: now };
    if (now - entry.ts > 60_000) { entry.count = 0; entry.ts = now; }
    entry.count++;
    global.__kxsis_rate.set(ip, entry);
    if (entry.count > 120) return res.status(429).send('rate limit exceeded');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const upstream = await fetch(url, {
      headers: {
        'user-agent': req.headers['user-agent'] || 'kxsis-raw',
        accept: req.headers.accept || '*/*'
      },
      signal: controller.signal
    });

    clearTimeout(timer);

    if (!upstream.ok) {
      return res.status(502).send('upstream error: ' + upstream.status);
    }

    // check content-length header before downloading large files
    const contentLength = upstream.headers.get('content-length');
    if (contentLength && Number(contentLength) > MAX_BYTES) {
      return res.status(413).send('upstream resource too large');
    }

    // read response as text (raw endpoint used for HTML/JSON typically)
    const buf = await upstream.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) {
      return res.status(413).send('response exceeded max size');
    }

    const ct = upstream.headers.get('content-type') || 'text/plain; charset=utf-8';
    res.setHeader('Content-Type', ct);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=60');

    // send buffer — keep original encoding
    return res.status(200).send(Buffer.from(buf));
  } catch (err) {
    console.error('raw proxy error:', err && err.message);
    if (err.name === 'AbortError') return res.status(504).send('timeout fetching upstream');
    return res.status(500).send('raw proxy failed: ' + (err && err.message));
  }
}
