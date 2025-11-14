// /api/service.js
// Node serverless HTML rewriter with structured logging, SSRF protection, timeouts, size guards, and rewrite telemetry.
// Overwrites any broken/truncated file currently in your repo.

const TIMEOUT_MS = 15_000;
const MAX_HTML_BYTES = 3 * 1024 * 1024; // 3MB
const CACHE_TTL = 60 * 1000;

// simple in-memory cache per warm instance (not shared between instances)
if (!global.__kxsis_cache) global.__kxsis_cache = new Map();

function safeId() {
  try { return (globalThis.crypto && crypto.randomUUID && crypto.randomUUID()) || `rid-${Date.now()}-${Math.floor(Math.random()*1e6)}`; }
  catch { return `rid-${Date.now()}-${Math.floor(Math.random()*1e6)}`; }
}
function makeLogger(req, rid){
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
  return {
    info: (obj) => console.log(JSON.stringify({ ts: new Date().toISOString(), rid, level: 'info', ip, ...obj })),
    warn: (obj) => console.warn(JSON.stringify({ ts: new Date().toISOString(), rid, level: 'warn', ip, ...obj })),
    error: (obj) => console.error(JSON.stringify({ ts: new Date().toISOString(), rid, level: 'error', ip, ...obj }))
  };
}
function isPrivateHost(h) {
  if (!h) return true;
  const host = h.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (/^(127|10|192\.168|169\.254)\./.test(host)) return true;
  if (/^::1$/.test(host)) return true;
  return false;
}
function rewriteResourceUrlAbsolute(orig) {
  // Keep this relative (frontend and functions use same domain)
  return `/api/resource?url=${encodeURIComponent(orig)}`;
}

function stripCspMeta(html) {
  return html
    .replace(/<meta[^>]+http-equiv=["']?content-security-policy["']?[^>]*>/ig, '')
    .replace(/<meta[^>]+name=["']?content-security-policy["']?[^>]*>/ig, '')
    .replace(/<meta[^>]+http-equiv=["']?x-frame-options["']?[^>]*>/ig, '');
}

function injectBase(html, baseUrl) {
  if (/<base\s/i.test(html)) return html;
  if (/<head[\s\S]*?>/i.test(html)) {
    return html.replace(/<head([\s\S]*?)>/i, `<head$1><base href="${baseUrl}">`);
  } else {
    return `<base href="${baseUrl}">` + html;
  }
}

function navShim() {
  return `<script>
(function(){
  function resolveHref(el){ try{ return new URL(el.getAttribute('href')||'', document.baseURI).href }catch(e){ return null } }
  document.addEventListener('click',function(e){
    const a = e.target.closest && e.target.closest('a');
    if(a && a.href){ e.preventDefault(); const href = resolveHref(a); if(href) window.parent.postMessage({type:'kxsis:navigate', href: href}, '*'); }
  }, true);
  document.addEventListener('submit', function(e){
    e.preventDefault();
    const f = e.target;
    const action = f.getAttribute('action') || document.baseURI;
    const method = (f.getAttribute('method') || 'GET').toUpperCase();
    const fd = new FormData(f);
    const obj = {};
    fd.forEach((v,k)=>{ if(obj[k]===undefined) obj[k]=v; else { if(!Array.isArray(obj[k])) obj[k]=[obj[k]]; obj[k].push(v); } });
    if(method === 'GET'){
      const params = new URLSearchParams(obj).toString();
      const url = action + (action.includes('?') ? '&' : '?') + params;
      window.parent.postMessage({type:'kxsis:navigate', href: url}, '*');
    } else {
      window.parent.postMessage({type:'kxsis:post', href: action, method: 'POST', body: obj}, '*');
    }
  }, true);
  document.querySelectorAll('a[target]').forEach(a=>a.removeAttribute('target'));
})();
<\/script>`;
}

async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(()=>controller.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(url, { headers: { 'user-agent': 'kxsis-service', accept: 'text/html,*/*' }, signal: controller.signal });
    clearTimeout(timer);
    if (!resp.ok) throw new Error('upstream_status_' + resp.status);
    const ct = resp.headers.get('content-type') || '';
    const txt = await resp.text();
    if (txt.length > MAX_HTML_BYTES) throw new Error('upstream_html_too_large');
    return { text: txt, headers: resp.headers, contentType: ct };
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

export default async function handler(req, res) {
  const rid = safeId();
  const log = makeLogger(req, rid);
  res.setHeader('X-KXSIS-LogId', rid);

  try {
    const rawUrl = (req.query.url || req.query.u || '').trim();
    if (!rawUrl) { log.warn({ event: 'missing_url' }); return res.status(400).send('missing url'); }
    if (!/^https?:\/\//i.test(rawUrl)) { log.warn({ event: 'invalid_protocol', url: rawUrl }); return res.status(400).send('invalid url protocol'); }
    const parsed = new URL(rawUrl);
    if (isPrivateHost(parsed.hostname)) { log.warn({ event: 'forbidden_host', host: parsed.hostname }); return res.status(403).send('forbidden host'); }

    // cache
    const key = rawUrl;
    const now = Date.now();
    if (global.__kxsis_cache.has(key)) {
      const entry = global.__kxsis_cache.get(key);
      if (now - entry.ts < CACHE_TTL) {
        log.info({ event: 'cache_hit', url: rawUrl });
        res.setHeader('Content-Type','text/html; charset=utf-8');
        res.setHeader('Access-Control-Allow-Origin','*');
        return res.status(200).send(entry.html);
      } else global.__kxsis_cache.delete(key);
    }

    log.info({ event: 'fetch_start', url: rawUrl });
    const { text, headers: upstreamHeaders, contentType } = await fetchText(rawUrl);
    log.info({ event: 'fetch_ok', url: rawUrl, contentType });

    if (!contentType.includes('text/html')) {
      log.warn({ event: 'non_html_upstream', contentType });
      // Fallback: instruct frontend to open raw endpoint
      const fallbackHtml = `<!doctype html><html><body><p>Upstream is not HTML. Redirecting to raw endpoint...</p><script>window.location.href='/api/raw?url=${encodeURIComponent(rawUrl)}'</script></body></html>`;
      res.setHeader('Content-Type','text/html; charset=utf-8');
      res.setHeader('Access-Control-Allow-Origin','*');
      return res.status(200).send(fallbackHtml);
    }

    let out = text;
    out = stripCspMeta(out);
    out = injectBase(out, rawUrl);

    // rewrite counters
    let rewriteCount = 0;

    // scripts
    out = out.replace(/<script\b([^>]*?)\bsrc=(["'])(.*?)\2/ig, (m, g1, q, src) => {
      try { const abs = new URL(src, rawUrl).href; rewriteCount++; return `<script${g1} src="${rewriteResourceUrlAbsolute(abs)}`; } catch(e) { log.warn({ event: 'rewrite_script_failed', src }); return m; }
    });

    // stylesheets
    out = out.replace(/<link\b([^>]*?)\bhref=(["'])(.*?)\2/ig, (m,g1,q,href) => {
      try { if(/rel\s*=\s*["']?stylesheet/i.test(m)){ const abs = new URL(href, rawUrl).href; rewriteCount++; return `<link${g1} href="${rewriteResourceUrlAbsolute(abs)}`; } return m; } catch(e){ log.warn({ event:'rewrite_link_failed', href }); return m; }
    });

    // images
    out = out.replace(/<img\b([^>]*?)\bsrc=(["'])(.*?)\2/ig, (m,g1,q,src) => {
      try { const abs = new URL(src, rawUrl).href; rewriteCount++; return `<img${g1} src="${rewriteResourceUrlAbsolute(abs)}`; } catch(e){ log.warn({ event:'rewrite_img_failed', src }); return m; }
    });

    // source[src]
    out = out.replace(/<source\b([^>]*?)\bsrc=(["'])(.*?)\2/ig, (m,g1,q,src) => {
      try { const abs = new URL(src, rawUrl).href; rewriteCount++; return `<source${g1} src="${rewriteResourceUrlAbsolute(abs)}`; } catch(e){ log.warn({ event:'rewrite_source_failed', src }); return m; }
    });

    // srcset
    out = out.replace(/\ssrcset=(["'])(.*?)\1/ig, (m,q,srcset) => {
      try {
        const parts = srcset.split(',').map(p=>{
          const seg = p.trim().split(/\s+/);
          const urlPart = seg[0];
          const abs = new URL(urlPart, rawUrl).href;
          rewriteCount++;
          return [rewriteResourceUrlAbsolute(abs), ...seg.slice(1)].join(' ');
        });
        return ' srcset=' + q + parts.join(', ') + q;
      } catch(e){ log.warn({ event:'rewrite_srcset_failed', srcset }); return m; }
    });

    // inline style attr url(...)
    out = out.replace(/style=(["'])(.*?)\1/ig, (m,q,styleContent) => {
      try {
        const replaced = styleContent.replace(/url\((['"]?)(.*?)\1\)/ig, (mm,qq,inner) => {
          try { const abs = new URL(inner, rawUrl).href; rewriteCount++; return `url("${rewriteResourceUrlAbsolute(abs)}")`; } catch(e){ return mm; }
        });
        return `style=${q}${replaced}${q}`;
      } catch(e){ log.warn({ event:'rewrite_inline_style_failed' }); return m; }
    });

    // style blocks
    out = out.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/ig, (m, css) => {
      try {
        const replaced = css.replace(/url\((['"]?)(.*?)\1\)/ig, (mm,qq,inner) => {
          try { const abs = new URL(inner, rawUrl).href; rewriteCount++; return `url("${rewriteResourceUrlAbsolute(abs)}")`; } catch(e){ return mm; }
        });
        return m.replace(css, replaced);
      } catch(e){ log.warn({ event:'rewrite_style_block_failed' }); return m; }
    });

    // anchors -> absolute
    out = out.replace(/<a\b([^>]*?)\bhref=(["'])(.*?)\2/ig, (m,g1,q,href) => {
      try { const abs = new URL(href, rawUrl).href; return `<a${g1} href="${abs}`; } catch(e){ return m; }
    });

    // inject nav shim
    if (/<\/body>/i.test(out)) out = out.replace(/<\/body>/i, navShim() + '</body>');
    else out += navShim();

    // final headers
    res.setHeader('Content-Type','text/html; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin','*');
    res.setHeader('Cache-Control','public, max-age=30');

    // cache
    try { global.__kxsis_cache.set(key, { html: out, ts: now }); } catch(e){ /* ignore */ }

    log.info({ event: 'rewrite_complete', url: rawUrl, rewrites: rewriteCount, bytes: out.length });
    return res.status(200).send(out);

  } catch (err) {
    const rid = res.getHeader('X-KXSIS-LogId') || 'unknown';
    console.error(JSON.stringify({ ts: new Date().toISOString(), rid, level: 'error', event: 'service_unhandled', err: err && (err.stack || err.message) }));
    if (err.name === 'AbortError') return res.status(504).send('timeout fetching upstream');
    return res.status(500).send('rewriter failed: ' + (err && err.message));
  }
}
