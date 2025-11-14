// /api/raw.js
const MAX_BYTES = 12 * 1024 * 1024; // 12MB
const TIMEOUT_MS = 15_000;

function safeId(){ try { return (globalThis.crypto && crypto.randomUUID && crypto.randomUUID()) || `rid-${Date.now()}-${Math.floor(Math.random()*1e6)}` } catch { return `rid-${Date.now()}-${Math.floor(Math.random()*1e6)}` } }
function makeLogger(req, rid){
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
  return {
    info: (obj)=> console.log(JSON.stringify({ ts: new Date().toISOString(), rid, level:'info', ip, ...obj })),
    warn: (obj)=> console.warn(JSON.stringify({ ts: new Date().toISOString(), rid, level:'warn', ip, ...obj })),
    error: (obj)=> console.error(JSON.stringify({ ts: new Date().toISOString(), rid, level:'error', ip, ...obj }))
  };
}
function isPrivateHost(hostname){
  if(!hostname) return true;
  if(/^(localhost|127\.0\.0\.1|10\.|192\.168\.|169\.254\.)/i.test(hostname)) return true;
  if(hostname.endsWith('.local') || hostname.endsWith('.internal')) return true;
  return false;
}

export default async function handler(req, res){
  const rid = safeId();
  const log = makeLogger(req, rid);
  res.setHeader('X-KXSIS-LogId', rid);

  try {
    const url = (req.query.url || req.query.u || '').trim();
    if(!url) { log.warn({ event: 'missing_url' }); return res.status(400).send('missing url'); }
    if(!/^https?:\/\//i.test(url)) { log.warn({ event: 'invalid_protocol', url }); return res.status(400).send('invalid url protocol'); }
    const parsed = new URL(url);
    if(isPrivateHost(parsed.hostname)) { log.warn({ event:'forbidden_host', host: parsed.hostname }); return res.status(403).send('forbidden host'); }

    log.info({ event:'fetch_start', url });
    const controller = new AbortController();
    const timer = setTimeout(()=>controller.abort(), TIMEOUT_MS);

    let upstream;
    try {
      upstream = await fetch(url, { headers: { 'user-agent': req.headers['user-agent'] || 'kxsis-raw', accept: req.headers.accept || '*/*' }, signal: controller.signal });
    } catch(err) {
      clearTimeout(timer);
      log.error({ event:'fetch_error', err: err && err.message });
      if(err.name === 'AbortError') return res.status(504).send('timeout fetching upstream');
      return res.status(502).send('upstream fetch failed');
    }
    clearTimeout(timer);

    if(!upstream.ok) { log.warn({ event:'upstream_not_ok', status: upstream.status }); return res.status(502).send('upstream error: ' + upstream.status); }

    const contentLength = upstream.headers.get('content-length');
    if(contentLength && Number(contentLength) > MAX_BYTES) { log.warn({ event:'upstream_too_large', contentLength }); return res.status(413).send('upstream resource too large'); }

    const buf = Buffer.from(await upstream.arrayBuffer());
    if(buf.length > MAX_BYTES) { log.warn({ event:'response_exceeded_max', bytes: buf.length }); return res.status(413).send('response exceeded max size'); }

    const ct = upstream.headers.get('content-type') || 'application/octet-stream';
    res.setHeader('Content-Type', ct);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=60');

    log.info({ event:'respond', bytes: buf.length, ct });
    return res.status(200).send(buf);
  } catch (err) {
    log.error({ event:'raw_unhandled', err: err && (err.stack || err.message) });
    return res.status(500).send('raw proxy failed: ' + (err && err.message));
  }
}
