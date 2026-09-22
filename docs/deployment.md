# Public demo deployment

Canonical UI: https://trysamewise.vercel.app. The frontend's relative `/api` requests are rewritten by `apps/web/vercel.json` to the Railway Fastify API. `GET /api/health` is the health endpoint used through that proxy.

## Public demo architecture

- Vercel hosts the React/Vite frontend.
- Railway runs the Fastify API and the installed Python matcher together in one container.
- The frontend calls relative `/api/...` URLs through the configured Vercel rewrite to Railway.

This is a constrained portfolio demo, not a multi-user production SaaS. Run state is process-local, uploaded files are ephemeral, and a restart or redeploy loses active runs. No persistent Railway volume is used.
