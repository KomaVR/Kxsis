// /api/service.js
// Node serverless HTML rewriter
// - fetch HTML
// - remove CSP meta tags
// - insert <base href="...">
// - rewrite script/src, link[href rel=stylesheet], img[src], source[src], srcset, inline style url(...)
// - inject navigation shim to postMessage navigations to parent
// - return text/html

const TIMEOUT_MS = 15000;
const MAX_HTML_BYTES = 3 * 1024 * 1024; // 3MB
const CACHE_TTL = 60 * 1000; // 60s in-memory cache (warm instances only)

if (!global.__kxsis_cache) global.__kxsis_cache = new Map();

function isPrivateHost(h) {
  if (!h) return true;
  const host = h.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (/^(127|10|192\.168|169\.254)\./.test(host)) return true;
  if (/^::1$/.test(host)) return true;
  return false;
}

function rewriteResourceUrlAbsolute(orig) {
  return `/api/resource?url=${encodeURIComponent(orig)}`;
}

// remove meta CSP tags from HTML string (simple but effective)
function stripCspMeta(html) {
  return html.replace(/<meta[^>]+http-equiv=["']?content-security-policy["']?[^>]*>/ig, '')
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
  function resolveHref(el){ try{ return new URL(el.getAttribute('href')||'', document.baseURI).href }catch(e){ return null }
  }
  document.addEventListener('click',function(e){
    const a = e.target.closest && e.target.closest('a');
    if(a && a.href){ e.preventDefault(); const href = resolveHref(a); if(href) window.parent.postMessage({type:'kxsis:navigate', href: href}, '*'); }
  }, true);
  document.addEventListener('submit', function(e){
    e.preventDefault();
    const f = e.target;
    const action = f.getAttribute('action') || document.baseURI;
    const method = (f.getAttribute('method') || 'GET').toUpperCase();
    const fd = new FormData(f), obj={};
    fd.forEach((v,k)=>{ if(obj[k]===undefined) obj[k]=v; else { if(!Array.isArray(obj[k])) obj[k]=[obj[k]]; obj[k].push(v); } });
    if(method === 'GET'){ const params = new URLSearchParams(obj).toString(); const url = action + (action.includes('?')? '&' : '?') + params; window.parent.postMessage({type:'kxsis:navigate', href: url}, '*'); }
    else { window.parent.postMessage({type:'kxsis:post', href: action, method:'POST', body: obj}, '*'); }
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
    if (!resp.ok) throw new Error('upstream:' + resp.status);
    const contentType = resp.headers.get('content-type') || '';
    if (!contentType.includes('text/html')) {
      // if upstream isn't HTML, return its text as-is (caller may prefer raw)
      const txt = await resp.text();
      return { html: txt, headers: resp.headers, isHtml: false };
    }
    // size guard
    const cl = resp.headers.get('content-length');
    if (cl && Number(cl) > MAX_HTML_BYTES) throw new Error('upstream html too large');
    const txt = await resp.text();
    if (txt.length > MAX_HTML_BYTES) throw new Error('upstream html too large');
    return { html: txt, headers: resp.headers, isHtml: true };
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

export default async function handler(req, res) {
  try {
    const url = (req.query.url || req.query.u || '').trim();
    if (!url) return res.status(400).send('missing url');
    if (!/^https?:\/\//i.test(url)) return res.status(400).send('invalid url protocol');

    const parsed = new URL(url);
    if (isPrivateHost(parsed.hostname)) return res.status(403).send('forbidden host');

    // cache key
    const key = url;
    const now = Date.now();
    if (global.__kxsis_cache.has(key)) {
      const entry = global.__kxsis_cache.get(key);
      if (now - entry.ts < CACHE_TTL) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Access-Control-Allow-Origin', '*');
        return res.status(200).send(entry.html);
      } else {
        global.__kxsis_cache.delete(key);
      }
    }

    // fetch upstream
    const { html, headers: upstreamHeaders, isHtml } = await fetchText(url);

    if (!isHtml) {
      // fallback: upstream didn't return HTML — return a friendly message or redirect to raw
      const fallbackHtml = `<!doctype html><html><body><p>Resource is not HTML. Opening raw endpoint...</p><script>window.location.href='/api/raw?url=${encodeURIComponent(url)}'</script></body></html>`;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.status(200).send(fallbackHtml);
    }

    // strip CSP meta tags
    let out = stripCspMeta(html);

    // inject base
    out = injectBase(out, url);

    // rewrite src/href attributes for many common tags via regex
    // script src
    out = out.replace(/<script\b([^>]*?)\bsrc=(["'])(.*?)\2/ig, (m, g1, q, src) => {
      try {
        const abs = new URL(src, url).href;
        return `<script${g1} src="${rewriteResourceUrlAbsolute(abs)}`;
      } catch { return m; }
    });

    // link rel=stylesheet
    out = out.replace(/<link\b([^>]*?)\bhref=(["'])(.*?)\2/ig, (m,g1,q,href) => {
      if(/rel\s*=\s*["']?stylesheet/i.test(m)){
        try { const abs = new URL(href, url).href; return `<link${g1} href="${rewriteResourceUrlAbsolute(abs)}`; } catch { return m; }
      }
      return m;
    });

    // img src
    out = out.replace(/<img\b([^>]*?)\bsrc=(["'])(.*?)\2/ig, (m,g1,q,src) => {
      try { const abs = new URL(src, url).href; return `<img${g1} src="${rewriteResourceUrlAbsolute(abs)}`; } catch { return m; }
    });

    // source[src]
    out = out.replace(/<source\b([^>]*?)\bsrc=(["'])(.*?)\2/ig, (m,g1,q,src) => {
      try { const abs = new URL(src, url).href; return `<source${g1} src="${rewriteResourceUrlAbsolute(abs)}`; } catch { return m; }
    });

    // srcset (images)
    out = out.replace(/\ssrcset=(["'])(.*?)\1/ig, (m, q, srcset) => {
      try {
        const parts = srcset.split(',').map(p=>{
          const seg = p.trim().split(/\s+/);
          const urlPart = seg[0];
          const abs = new URL(urlPart, url).href;
          const proxy = rewriteResourceUrlAbsolute(abs);
          return [proxy, ...seg.slice(1)].join(' ');
        });
        return ' srcset=' + q + parts.join(', ') + q;
      } catch { return m; }
    });

    // inline style url(...)
    out = out.replace(/style=(["'])(.*?)\1/ig, (m, q, styleContent) => {
      try {
        const replaced = styleContent.replace(/url\((['"]?)(.*?)\1\)/ig, (mm, qq, inner) => {
          try { const abs = new URL(inner, url).href; return `url("${rewriteResourceUrlAbsolute(abs)}")`; } catch { return mm; }
        });
        return `style=${q}${replaced}${q}`;
      } catch { return m; }
    });

    // rewrite CSS inside <style> blocks (best-effort)
    out = out.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/ig, (m, css) => {
      try {
        const replaced = css.replace(/url\((['"]?)(.*?)\1\)/ig, (mm, qq, inner) => {
          try { const abs = new URL(inner, url).href; return `url("${rewriteResourceUrlAbsolute(abs)}")`; } catch { return mm; }
        });
        return m.replace(css, replaced);
      } catch { return m; }
    });

    // make anchors absolute and remove target
    out = out.replace(/<a\b([^>]*?)\bhref=(["'])(.*?)\2/ig, (m,g1,q,href) => {
      try { const abs = new URL(href, url).href; return `<a${g1} href="${abs}`; } catch { return m; }
    });

    // inject navigation shim before </body>
    if (/<\/body>/i.test(out)) out = out.replace(/<\/body>/i, navShim() + '</body>');
    else out += navShim();

    // strip some dangerous response headers (we control headers sent)
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=30');

    // cache in memory (per cold instance)
    try { global.__kxsis_cache.set(key, { html: out, ts: now }); } catch(e){ /* ignore caching errors */ }

    return res.status(200).send(out);
  } catch (err) {
    console.error('service error:', err && err.message);
    if (err.name === 'AbortError') return res.status(504).send('timeout fetching upstream');
    return res.status(500).send('rewriter failed: ' + (err && err.message));
  }
}
