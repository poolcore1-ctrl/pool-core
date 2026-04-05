# Drive Pool

Unified Google Drive storage pool — runs on Cloudflare Workers. Supports files, JSON, SQL, key-value, API cache, and folders across multiple Drive accounts with automatic quota-aware routing.

---

## Features

- **Multiple Drive accounts** pooled together with automatic routing
- **Rate limit aware** — tracks per-minute, per-second, and daily quotas using Durable Objects
- **All data types** — files, JSON documents, KV store, SQL (JSON-backed), API response cache, folders
- **Multi-pool** — group accounts into pools, set routing rules, configure overflow
- **Monitoring dashboard** — live account health, quota meters, audit log
- **Serverless** — deploys to Cloudflare Workers, zero server management
- **Auto-deploys** from GitHub on every push to main

---

## Prerequisites

- Cloudflare account (free tier works)
- Google Cloud account (free)
- Node.js 18+ and npm
- Wrangler CLI

---

## Step 1 — Google Cloud OAuth Setup

1. Go to https://console.cloud.google.com
2. Create a new project (or use existing)
3. Enable the **Google Drive API**:
   - APIs & Services → Library → search "Google Drive API" → Enable
4. Create OAuth credentials:
   - APIs & Services → Credentials → Create Credentials → OAuth 2.0 Client ID
   - Application type: **Web application**
   - Name: Drive Pool
   - Authorized redirect URIs: `https://your-worker.workers.dev/api/accounts/oauth-callback`
     (you'll update this after deployment)
5. Copy your **Client ID** and **Client Secret**
6. Configure OAuth consent screen:
   - APIs & Services → OAuth consent screen
   - User type: External
   - Add your email as a test user
   - Scopes: `../auth/drive.file` and `../auth/drive.metadata.readonly`

---

## Step 2 — Cloudflare Setup

Install Wrangler and authenticate:
```bash
npm install -g wrangler
wrangler login
```

Get your Cloudflare Account ID:
```bash
wrangler whoami
```

---

## Step 3 — Deploy

```bash
# Clone the repo
git clone https://github.com/YOUR_USERNAME/drive-pool
cd drive-pool
npm install

# Create Cloudflare resources
npm run db:create        # Creates D1 database
npm run r2:create        # Creates R2 bucket
npm run queue:create     # Creates Queue

# Update wrangler.toml with the D1 database_id from the output above

# Run database migrations
npm run db:migrate:remote

# Set secrets (you'll be prompted for each value)
wrangler secret put MASTER_SECRET       # Any random 32+ char string
wrangler secret put GOOGLE_CLIENT_ID    # From Google Cloud Console
wrangler secret put GOOGLE_CLIENT_SECRET
wrangler secret put JWT_SECRET          # Any random string for dashboard sessions

# Deploy
npm run deploy
```

Your Worker URL will be: `https://drive-pool.YOUR_SUBDOMAIN.workers.dev`

---

## Step 4 — Update Google OAuth Redirect URI

1. Go back to Google Cloud Console → Credentials → your OAuth client
2. Update Authorized redirect URIs to:
   `https://drive-pool.YOUR_SUBDOMAIN.workers.dev/api/accounts/oauth-callback`
3. Save

---

## Step 5 — GitHub Auto-Deploy

1. Push this repo to GitHub
2. Go to your repo → Settings → Secrets and variables → Actions
3. Add secrets:
   - `CF_API_TOKEN` — from https://dash.cloudflare.com/profile/api-tokens (use "Edit Cloudflare Workers" template)
   - `CF_ACCOUNT_ID` — your Cloudflare account ID
4. Every push to `main` now auto-deploys and runs migrations

---

## Step 6 — First Login

1. Open `https://drive-pool.YOUR_SUBDOMAIN.workers.dev`
2. Click "Create account"
3. Enter email and password
4. **Save your API key** — it's shown only once
5. Create a pool in the Pools tab
6. Connect a Google Drive account via OAuth in the Accounts tab
7. Start storing data

---

## API Reference

All requests require: `Authorization: Bearer YOUR_API_KEY`

### Files
```
POST   /api/storage/upload          multipart/form-data, field: file
GET    /api/storage/files/:id       download file
DELETE /api/storage/files/:id       delete file
```

### JSON Documents
```
POST   /api/storage/json            { collection, data, id? }
GET    /api/storage/json/:collection         list documents
GET    /api/storage/json/:collection/:id     get document
```

### Key-Value
```
POST   /api/storage/kv              { key, value, ttl? }
GET    /api/storage/kv/:key         get value
DELETE /api/storage/kv/:key         delete key
```

### SQL
```
POST   /api/storage/sql             { db, sql, params? }
```

### API Cache
```
POST   /api/storage/cache           { key, response, ttl? }
GET    /api/storage/cache/:key      check and get cached response
```

### Folders
```
POST   /api/storage/folders         { path }
```

### Pools
```
GET    /api/pools                   list pools
POST   /api/pools                   { name, purpose, is_default, routing_rules }
GET    /api/pools/:id
PUT    /api/pools/:id
DELETE /api/pools/:id
```

### Accounts
```
GET    /api/accounts                list Drive accounts
POST   /api/accounts/oauth-init     { pool_id } → returns auth_url
GET    /api/accounts/oauth-callback (Google redirects here)
DELETE /api/accounts/:id
```

### Auth
```
POST   /api/auth/register           { email, password }
POST   /api/auth/login              { email, password }
POST   /api/auth/rotate-key
```

### Monitor
```
GET    /api/monitor/dashboard       full system overview
GET    /api/monitor/accounts        per-account live stats
GET    /api/monitor/audit           ?status=ok|error &action=file|json|kv
GET    /api/monitor/storage         storage breakdown by type
```

---

## Query Parameters

All storage endpoints accept:
- `?app_id=myapp` — namespace data by application
- `?pool_id=pool_xxx` — force a specific pool (optional, router picks automatically)

---

## Rate Limits (per Drive account)

| Limit | Value | Notes |
|-------|-------|-------|
| Requests/minute | 9,600 | 80% of Google's 12,000 |
| Writes/second | 3 | Google's sustained write limit |
| Daily upload | 700 GB | Buffer before Google's 750 GB wall |

Accounts exceeding limits enter automatic exponential backoff. Requests overflow to other healthy accounts automatically.

---

## Adding More Drive Accounts

Just connect more accounts via the dashboard → Accounts tab → Connect via Google OAuth. The router picks them up immediately. No code changes needed.

## Adding More Pools

Create a pool in the dashboard → Pools tab, then connect accounts to it. Set routing rules to route specific app IDs, data types, or file sizes to specific pools.
