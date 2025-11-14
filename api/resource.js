// /api/resource.js
// Node serverless handler - proxy for images, css, js, fonts
// Uses arrayBuffer to return bytes (safe for Vercel).

const MAX_RESOURCE_BYTES = 20 * 1024 * 1024; // 20MB
const RESOURCE_TIMEOUT_MS = 20000;

function isPrivateHost(hostname) {
  if (!hostname) return true;
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (/^(127|10|192\.168|169\.254)\./.test(h)) return true;
  if (/^::1$/.test(h)) return true;
  if (/^fc00:|^fe80:/.test(h)) return true;
  return false;
}

export default async function handler(req, res) {
  try {
    const url = (req.query.url || '').trim();
    if (!url) return res.status(400).send('missing url');
    if (!/^https?:\/\//i.test(url)) return res.status(400).send('invalid url protocol');

    const parsed = new URL(url);
    if (isPrivateHost(parsed.hostname)) return res.status(403).send('forbidden host');

    // Basic per-IP rate limit
    if (!global.__kxsis_rl) global.__kxsis_rl = new Map();
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'anon';
    const now = Date.now();
    const entry = global.__kxsis_rl.get(ip) || { count: 0, ts: now };
    if (now - entry.ts > 60_000) { entry.count = 0; entry.ts = now; }
    entry.count++;
    global.__kxsis_rl.set(ip, entry);
    if (entry.count > 600) return res.status(429).send('rate limit exceeded');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RESOURCE_TIMEOUT_MS);

    const upstream = await fetch(url, {
      headers: {
        'user-agent': req.headers['user-agent'] || 'kxsis-resource',
        accept: req.headers.accept || '*/*'
      },
      signal: controller.signal
    });

    clearTimeout(timer);

    if (!upstream.ok) return res.status(502).send('upstream error: ' + upstream.status);

    // check content-length header quickly
    const contentLength = upstream.headers.get('content-length');
    if (contentLength && Number(contentLength) > MAX_RESOURCE_BYTES) {
      return res.status(413).send('resource too large');
    }

    // read bytes
    const buf = Buffer.from(await upstream.arrayBuffer());
    if (buf.length > MAX_RESOURCE_BYTES) return res.status(413).send('resource too large');

    // set appropriate headers
    const ct = upstream.headers.get('content-type') || 'application/octet-stream';
    res.setHeader('Content-Type', ct);
    res.setHeader('Access-Control-Allow-Origin', '*');
    // cache for a short while — safe for static assets
    res.setHeader('Cache-Control', 'public, max-age=600, stale-while-revalidate=60');

    return res.status(200).send(buf);

  } catch (err) {
    console.error('resource proxy error:', err && err.message);
    if (err.name === 'AbortError') return res.status(504).send('timeout fetching resource');
    return res.status(500).send('resource proxy failed: ' + (err && err.message));
  }
}
