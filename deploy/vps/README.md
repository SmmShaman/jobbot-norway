# job.vitalii.no and promo.job.vitalii.no on the VPS

Since 2026-09-26 both sites run on the Contabo VPS instead of Netlify (Netlify Free blocked the
whole account after vitalii.no exhausted its function invocations).

- **job.vitalii.no** — `.github/workflows/build-frontend.yml` builds `dist/` on every push to `main`
  (frontend paths only) and uploads `site-dist`. `jobbot-frontend-deploy.timer` runs
  `/opt/static-sites/deploy-static.sh` every 2 min: download, unpack into
  `/opt/static-sites/job.vitalii.no/releases/<sha>`, flip `current`, health-check, roll back on failure.
  Build env comes from repo secrets `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_API_URL`.
- **promo.job.vitalii.no** — plain files in `promo/` (were only on Netlify until 2026-09-26). No CI:
  `rsync -a promo/ root@VPS:/opt/static-sites/promo.job.vitalii.no/current/`.
- **Serving** — nginx container `static-sites` (`127.0.0.1:3200`, config `static-sites.conf`,
  `/opt/static-sites` mounted read-only at `/sites`) behind the cloudflared tunnel `b5c0ecc5`.

```bash
docker run -d --name static-sites --restart unless-stopped -p 127.0.0.1:3200:80 \
  -v /opt/static-sites:/sites:ro -v /opt/static-sites/static-sites.conf:/etc/nginx/conf.d/default.conf:ro \
  nginx:alpine
```
