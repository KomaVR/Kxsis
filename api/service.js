// /api/service.js
export const config = { runtime: 'nodejs' };

const NAV_SHIM = `<script>
(function(){
  function resolveHref(el){ try{ return new URL(el.getAttribute('href')||'', document.baseURI).href }catch(e){ return null } }
  document.addEventListener('click',function(e){
    const a = e.target.closest && e.target.closest('a');
    if(a && a.href){ e.preventDefault(); const href = resolveHref(a); if(href) window.parent.postMessage({type:'kxsis:navigate', href: href}, '*'); }
  }, true);
  document.addEventListener('submit',function(e){ e.preventDefault(); const f=e.target; const action=f.getAttribute('action')||document.baseURI; const method=(f.getAttribute('method')||'GET').toUpperCase(); const fd=new FormData(f); const obj={}; fd.forEach((v,k)=>{ if(obj[k]===undefined) obj[k]=v; else { if(!Array.isArray(obj[k])) obj[k]=[obj[k]]; obj[k].push(v); } }); if(method==='GET'){ const params=new URLSearchParams(obj).toString(); const url = action + (action.includes('?')? '&' : '?') + params; window.parent.postMessage({type:'kxsis:navigate', href:url}, '*'); } else { window.parent.postMessage({type:'kxsis:post', href: action, method: 'POST', body: obj}, '*'); } }, true);
  document.querySelectorAll('a[target]').forEach(a=>a.removeAttribute('target'));
})();
<\/script>`;

function rewriteResourceUrl(orig){
  return '/api/resource?url=' + encodeURIComponent(orig);
}

async function fetchText(url){
  const res = await fetch(url, { headers: { 'user-agent': 'kxsis-rewriter' } });
  if(!res.ok) throw new Error('upstream fetch failed: ' + res.status);
  return { text: await res.text(), headers: res.headers };
}

function stripBlockingHeaders(headers){
  const out = {};
  for(const [k,v] of headers.entries()){
    const key = k.toLowerCase();
    if(key === 'content-security-policy' || key === 'x-frame-options' || key === 'frame-options' || key === 'x-content-security-policy') continue;
    out[k] = v;
  }
  out['access-control-allow-origin'] = '*';
  return out;
}

function resolveAttr(base, attr){
  try{ return new URL(attr, base).href }catch(e){ return attr }
}

// small naive rewrite using regex (fast enough in Edge)
function rewriteHtml(html, baseUrl){
  // inject <base>
  if(/<head[\s\S]*?>/i.test(html)){
    html = html.replace(/<head([\s\S]*?)>/i, (m, g1) => `<head${g1}><base href="${baseUrl}">`);
  } else {
    html = `<base href="${baseUrl}">` + html;
  }

  // rewrite src/href for common resources: scripts/styles/images
  // script src
  html = html.replace(/<script\b([^>]*?)\bsrc=(["'])(.*?)\2/ig, (m, g1, q, src) => {
    const r = resolveAttr(baseUrl, src);
    return `<script${g1} src="${rewriteResourceUrl(r)}`;
  });

  // link rel=stylesheet
  html = html.replace(/<link\b([^>]*?)\bhref=(["'])(.*?)\2/ig, (m,g1,q,href) => {
    if(/rel\s*=\s*["']?stylesheet/i.test(m)) {
      const r = resolveAttr(baseUrl, href);
      return `<link${g1} href="${rewriteResourceUrl(r)}`;
    }
    return m;
  });

  // images
  html = html.replace(/<img\b([^>]*?)\bsrc=(["'])(.*?)\2/ig, (m,g1,q,src) => {
    const r = resolveAttr(baseUrl, src);
    return `<img${g1} src="${rewriteResourceUrl(r)}`;
  });

  // anchors: convert relative to absolute (so clicks post back correct URL)
  html = html.replace(/<a\b([^>]*?)\bhref=(["'])(.*?)\2/ig, (m,g1,q,href)=>{
    const r = resolveAttr(baseUrl, href);
    return `<a${g1} href="${r}"`; // remove targets elsewhere
  });

  // inject nav shim just before </body>
  if(/<\/body>/i.test(html)){
    html = html.replace(/<\/body>/i, NAV_SHIM + '</body>');
  } else {
    html += NAV_SHIM;
  }
  return html;
}

export default async function handler(req){
  try{
    const url = new URL(req.url).searchParams.get('url') || new URL(req.url).searchParams.get('u');
    if(!url) return new Response('missing url', { status: 400 });
    // prefer service rewrite; if url looks like croxy/uv/corrosion we let that be handled by engine selection at frontend
    const { text, headers: upstreamHeaders } = await fetchText(url);
    let html = text;
    html = rewriteHtml(html, url);
    const outHeaders = stripBlockingHeaders(upstreamHeaders);
    outHeaders['content-type'] = 'text/html; charset=utf-8';
    return new Response(html, { status: 200, headers: outHeaders });
  }catch(err){
    return new Response('rewriter error: ' + err.message, { status: 502 });
  }
}
