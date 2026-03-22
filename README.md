# arXiv daily digest → Feishu + WeChat 公众号

Admin UI and API to configure **keywords** and **push targets**, then send **once per day** (intended **12:00 Asia/Shanghai**) a digest of **keyword-matched** arXiv papers whose **v1 published** date falls on the **previous calendar day** in Beijing time.

## Requirements

- Python **3.12+** (via **Conda** or **venv**)
- Node.js 18+ and npm (for building the frontend)

## Backend

### Option A: Conda (recommended if you already use conda)

From the repo root or `backend/`:

```bash
cd /Users/chenxiang/apps/backend
conda env create -f environment.yml   # first time
conda activate arxiv-digest
cp .env.example .env
# Edit .env — set ADMIN_TOKEN and optional ARXIV_QUERY_BASE / WeChat vars
# You may instead put .env in the repo root (`apps/.env`); backend/.env overrides root for duplicate keys.
cd /Users/chenxiang/apps/backend
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

After dependency changes: `conda env update -f environment.yml --prune`.

Your `uvicorn` binary lives inside the env (e.g. `$(conda info --base)/envs/arxiv-digest/bin/uvicorn`). Use that path in **systemd** if the service runs under conda.

### Option B: venv + pip

```bash
cd /Users/chenxiang/apps/backend
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp .env.example .env
# Edit .env — set ADMIN_TOKEN and optional ARXIV_QUERY_BASE / WeChat vars
# Optional: place `.env` in the repo root instead; `backend/.env` overrides on conflicts.
.venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000
```

SQLite file path is relative to the process working directory (use `backend/` as cwd so `data/app.db` is created under `backend/data/`).

## Frontend

Development (proxies `/api` to port 8000):

```bash
cd /Users/chenxiang/apps/frontend
npm install
npm run dev
```

Production: build and serve from the same FastAPI process:

```bash
cd /Users/chenxiang/apps/frontend
npm install
npm run build
```

Then start `uvicorn` from `backend/` as above. If `frontend/dist` exists, the UI is served at `/` and API stays under `/api` and `/health`.

### Run backend via conda startup script

```bash
cd /Users/chenxiang/apps
./deploy/start-backend-conda.sh
```

## Feishu

1. In a Feishu group: **Settings → Bots → Custom bot → Webhook**.
2. Add a target in the admin UI with the **https** webhook URL.
3. **Test webhook** sends a short text message.

## WeChat Official Account

1. Register a 公众号 and create a **template message** (or 订阅通知 per your account type). Note **template_id** and placeholder keys (e.g. `thing1`, `thing2`, `url`).
2. Set **AppID**, **AppSecret**, **template_id** in the UI (or `.env`). Default JSON **field mapping** maps logical fields to template keys:

   `{"digest_title":"thing1","digest_body":"thing2","link":"url"}`

3. Collect each follower’s **openid** (MVP: paste from MP debug tools) and add as a **subscriber**.
4. **Test template** sends one message to that openid.
5. Message length strategy in code: each template field is truncated (`digest_title` 120 chars, `digest_body` 500 chars, `link` 500 chars) to avoid oversized payloads.

## Daily run (12:00 Beijing)

Call the protected endpoint once per day:

```bash
curl -sS -X POST "https://YOUR_HOST/api/digest/run" \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"dry_run":false,"force":false}'
```

### systemd timer (Asia/Shanghai)

Example unit files are in [`deploy/`](deploy/). Adjust `User`, paths, and `YOUR_ADMIN_TOKEN` (prefer a root-only file and `EnvironmentFile=`).

```bash
sudo cp deploy/arxiv-web.service /etc/systemd/system/
sudo cp deploy/arxiv-digest.service /etc/systemd/system/
sudo cp deploy/arxiv-digest.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now arxiv-web.service
sudo systemctl enable --now arxiv-digest.timer
```

### cron

```cron
CRON_TZ=Asia/Shanghai
0 12 * * * curl -sS -X POST http://127.0.0.1:8000/api/digest/run -H "Authorization: Bearer TOKEN" -H "Content-Type: application/json" -d '{"dry_run":false,"force":false}'
```

## Idempotency

Successful sends record a row in **`digest_runs`** for `(digest_date, recipient_type, recipient_id)`. Re-running the same day **without** `force` skips recipients already marked **success**. Use **`force: true`** only to re-send.

## TLS

Put **Caddy** or **nginx** in front with HTTPS. The admin UI and token must not be exposed on plain HTTP on the public Internet.

### Local HTTPS test with Caddy (macOS)

Install Caddy:

```bash
brew install caddy
```

Start backend in one terminal:

```bash
cd /Users/chenxiang/apps
./deploy/start-backend-conda.sh
```

Start Caddy in another terminal:

```bash
cd /Users/chenxiang/apps
./deploy/start-caddy-local.sh
```

Verify HTTPS proxy:

```bash
curl -k https://127.0.0.1:8443/health
```

### Production HTTPS with Caddy (VPS)

1. Copy `deploy/Caddyfile.prod.example` to `/etc/caddy/Caddyfile` and replace domain.
2. Ensure DNS A record points domain to your VPS.
3. Install Caddy and service units:

```bash
sudo cp deploy/arxiv-web.service /etc/systemd/system/
sudo cp deploy/arxiv-caddy.service /etc/systemd/system/
sudo cp deploy/arxiv-digest.service /etc/systemd/system/
sudo cp deploy/arxiv-digest.timer /etc/systemd/system/
sudo cp deploy/Caddyfile.prod.example /etc/caddy/Caddyfile
sudo systemctl daemon-reload
sudo systemctl enable --now arxiv-web.service
sudo systemctl enable --now arxiv-caddy.service
sudo systemctl enable --now arxiv-digest.timer
```

## arXiv scope

`ARXIV_QUERY_BASE` should narrow categories if `ARXIV_MAX_FETCH` is too small for “all of arXiv” for a single day. Increase `ARXIV_MAX_FETCH` only as needed (be polite to arXiv).
