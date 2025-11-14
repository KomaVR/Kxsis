// /api/resource.js
export default async function handler(req, res){
  try{
    const url = req.query.url || req.query.get('url'); // Vercel Node style
    if(!url) { res.status(400).send('missing url'); return; }

    const upstream = await fetch(url, { headers: { 'user-agent': 'kxsis-resource' } });
    if(!upstream.ok) { res.status(502).send('upstream error'); return; }

    // forward content-type and permissive CORS
    const ct = upstream.headers.get('content-type') || 'application/octet-stream';
    res.setHeader('Content-Type', ct);
    res.setHeader('Access-Control-Allow-Origin', '*');

    const body = upstream.body;
    if(body && body.pipe) {
      // node stream support (if using Node runtime)
      body.pipe(res);
    } else {
      const buffer = await upstream.arrayBuffer();
      res.send(Buffer.from(buffer));
    }
  }catch(err){
    console.error('resource proxy err', err);
    res.status(500).send('resource proxy failed');
  }
}
