# Kxsis Proxy Browser (Vercel)

## Files
- index.html (frontend)
- /api/service.js (Edge rewriter)
- /api/resource.js (serverless resource proxy)
- /api/raw.js (serverless passthrough)
- /public/favicon.svg
- vercel.json

## Deploy
1. Create a new GitHub repo and push these files (root-level).
2. Connect repo to Vercel and deploy (Vercel will detect vercel.json).
3. Visit the deployed site.

## Notes
- Edge function rewrites HTML and strips CSP/X-Frame-Options.
- Resource proxy streams scripts/styles/images via `/api/resource`.
- For extremely stubborn sites that require full JS execution (complex bot-checks), Vercel cannot run Playwright; you will need an external renderer (e.g., Render, Fly, Railway) and a `/api/render` endpoint that the frontend can call as an optional fallback.
- Add rate limits and auth if exposing to the public.
