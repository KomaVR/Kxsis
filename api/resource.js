export const config = { runtime: "nodejs" };

export default async function handler(req, res){
  try{
    const url = req.query.url;
    if(!url) return res.status(400).send("missing url");

    const upstream = await fetch(url, {
      headers: { "user-agent": "kxsis-resource" }
    });

    if(!upstream.ok) return res.status(502).send("upstream error");

    const ct = upstream.headers.get("content-type") || "application/octet-stream";
    res.setHeader("Content-Type", ct);
    res.setHeader("Access-Control-Allow-Origin", "*");

    const buf = Buffer.from(await upstream.arrayBuffer());
    res.send(buf);

  }catch(err){
    console.error(err);
    res.status(500).send("resource fetch failed");
  }
}
