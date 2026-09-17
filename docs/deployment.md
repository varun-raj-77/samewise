# Public demo deployment

## Public demo architecture

- Vercel hosts the React/Vite frontend.
- Railway runs the Fastify API and the installed Python matcher together in one container.
- The frontend continues to call relative `/api/...` URLs. A Vercel proxy can be configured after Railway provides the production backend domain.

This is a constrained portfolio demo, not a multi-user production SaaS. Run state is process-local, uploaded files are ephemeral, and a restart or redeploy loses active runs. No persistent Railway volume is used.
