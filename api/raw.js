export const config = { runtime: "nodejs" };

export default async function handler(req, res){
  try{
    const url = req.query.url || req.query.u;
    if(!url) return res.status(400).send("missing url");

    const upstream = await fetch(url, {
      headers: { "user-agent": "kxsis-raw" }
    });

    const text = await upstream.text();
    const ct = upstream.headers.get("content-type") || "text/html";

    res.setHeader("Content-Type", ct);
    res.setHeader("Access-Control-Allow-Origin", "*");

    res.send(text);
  }catch(err){
    console.error(err);
    res.status(500).send("raw fetch failed");
  }
}
