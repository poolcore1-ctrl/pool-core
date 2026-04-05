// src/index.js
// Main Cloudflare Worker entry point

import { handleAuth } from './workers/auth.js';
import { handlePools, handleAccounts } from './workers/pools.js';
import { handleStorage } from './workers/storage.js';
import { handleMonitor } from './workers/monitor.js';
import { AccountState } from './durable-objects/AccountState.js';
import { json } from './lib/auth-middleware.js';

export { AccountState };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Authorization, Content-Type',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    // Dashboard (static HTML — served from this worker)
    if (pathname === '/' || pathname === '/dashboard' || pathname === '/dashboard/') {
      return serveDashboard(env);
    }

    // Route to handlers
    try {
      if (pathname.startsWith('/api/auth/')) return handleAuth(request, env, pathname);
      if (pathname.startsWith('/api/pools')) return handlePools(request, env, pathname);
      if (pathname.startsWith('/api/accounts')) return handleAccounts(request, env, pathname);
      if (pathname.startsWith('/api/storage')) return handleStorage(request, env, pathname);
      if (pathname.startsWith('/api/monitor')) return handleMonitor(request, env, pathname);

      // Health check
      if (pathname === '/api/health') {
        return json({ status: 'ok', version: '1.0.0', timestamp: Date.now() });
      }

      return json({ error: 'Not found' }, 404);
    } catch (err) {
      console.error('Unhandled error:', err);
      return json({ error: 'Internal server error', message: err.message }, 500);
    }
  },

  // Cron trigger — runs every 5 minutes
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runHealthChecks(env));
  },

  // Queue consumer — background jobs
  async queue(batch, env) {
    for (const msg of batch.messages) {
      try {
        await processJob(msg.body, env);
        msg.ack();
      } catch (err) {
        console.error('Job failed:', err);
        msg.retry();
      }
    }
  },
};

async function runHealthChecks(env) {
  // Reset daily byte counters at midnight UTC
  const now = new Date();
  if (now.getUTCHours() === 0 && now.getUTCMinutes() < 5) {
    const { results: accounts } = await env.DB.prepare('SELECT id FROM accounts WHERE active = 1').all();
    const id = env.ACCOUNT_STATE.idFromName;
    for (const acc of accounts || []) {
      try {
        const doId = env.ACCOUNT_STATE.idFromName(acc.id);
        const stub = env.ACCOUNT_STATE.get(doId);
        await stub.fetch('https://do/reset-daily');
      } catch { /* continue */ }
    }
  }

  // Clean expired oauth states
  const oneDayAgo = Date.now() - 86400000;
  await env.DB.prepare('DELETE FROM oauth_state WHERE created_at < ?').bind(oneDayAgo).run();

  // Clean expired cache/kv entries
  await env.DB.prepare(
    `DELETE FROM files_index WHERE expires_at IS NOT NULL AND expires_at < ? AND data_type IN ('kv', 'cache')`
  ).bind(Date.now()).run();
}

async function processJob(job, env) {
  if (job.type === 'sync-storage-quota') {
    // Fetch real storage quota from Drive and update DB
    const { accountId } = job;
    const account = await env.DB.prepare('SELECT * FROM accounts WHERE id = ?').bind(accountId).first();
    if (!account) return;
    const { getStorageQuota } = await import('./lib/drive-client.js');
    const quota = await getStorageQuota(account, env);
    if (quota?.limit) {
      await env.DB.prepare('UPDATE accounts SET storage_limit_bytes = ? WHERE id = ?')
        .bind(parseInt(quota.limit), accountId).run();
    }
  }
}

function serveDashboard(env) {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Drive Pool — Dashboard</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg: #0f0f11; --surface: #1a1a1f; --border: #2a2a32;
      --text: #e8e8f0; --muted: #888899; --accent: #6c63ff;
      --green: #22c55e; --red: #ef4444; --amber: #f59e0b;
      --radius: 10px; --font: system-ui, -apple-system, sans-serif;
    }
    body { background: var(--bg); color: var(--text); font-family: var(--font); min-height: 100vh; }
    header { background: var(--surface); border-bottom: 1px solid var(--border); padding: 16px 32px; display: flex; align-items: center; justify-content: space-between; }
    header h1 { font-size: 18px; font-weight: 600; color: var(--text); letter-spacing: -0.3px; }
    header h1 span { color: var(--accent); }
    .badge { background: var(--accent); color: #fff; font-size: 11px; padding: 2px 8px; border-radius: 20px; font-weight: 500; }
    nav { display: flex; gap: 4px; }
    nav button { background: none; border: none; color: var(--muted); padding: 8px 16px; border-radius: var(--radius); cursor: pointer; font-size: 14px; transition: all .15s; }
    nav button:hover, nav button.active { background: var(--border); color: var(--text); }
    main { max-width: 1200px; margin: 0 auto; padding: 32px; }
    .page { display: none; } .page.active { display: block; }
    h2 { font-size: 22px; font-weight: 600; margin-bottom: 6px; }
    p.sub { color: var(--muted); font-size: 14px; margin-bottom: 28px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; margin-bottom: 32px; }
    .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 20px; }
    .card .label { font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: .5px; margin-bottom: 8px; }
    .card .value { font-size: 28px; font-weight: 700; }
    .card .sub { font-size: 13px; color: var(--muted); margin-top: 4px; }
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    th { text-align: left; padding: 10px 12px; color: var(--muted); font-size: 12px; font-weight: 500; text-transform: uppercase; border-bottom: 1px solid var(--border); }
    td { padding: 12px; border-bottom: 1px solid var(--border); vertical-align: middle; }
    tr:last-child td { border-bottom: none; }
    .tag { display: inline-block; padding: 2px 8px; border-radius: 20px; font-size: 12px; font-weight: 500; }
    .tag.ok { background: rgba(34,197,94,.15); color: var(--green); }
    .tag.warn { background: rgba(245,158,11,.15); color: var(--amber); }
    .tag.err { background: rgba(239,68,68,.15); color: var(--red); }
    .tag.cool { background: rgba(108,99,255,.15); color: var(--accent); }
    .bar-wrap { background: var(--border); border-radius: 4px; height: 6px; width: 100%; }
    .bar { height: 6px; border-radius: 4px; background: var(--accent); transition: width .3s; }
    .bar.warn { background: var(--amber); }
    .bar.danger { background: var(--red); }
    btn, .btn { display: inline-flex; align-items: center; gap: 6px; padding: 9px 16px; border-radius: var(--radius); font-size: 14px; font-weight: 500; cursor: pointer; border: none; transition: all .15s; }
    .btn-primary { background: var(--accent); color: #fff; }
    .btn-primary:hover { opacity: .88; }
    .btn-ghost { background: var(--border); color: var(--text); }
    .btn-ghost:hover { background: #333; }
    .btn-danger { background: rgba(239,68,68,.15); color: var(--red); border: 1px solid rgba(239,68,68,.3); }
    input, select, textarea { background: var(--surface); border: 1px solid var(--border); color: var(--text); padding: 9px 12px; border-radius: 8px; font-size: 14px; width: 100%; outline: none; font-family: inherit; }
    input:focus, select:focus, textarea:focus { border-color: var(--accent); }
    label { font-size: 13px; color: var(--muted); display: block; margin-bottom: 6px; margin-top: 14px; }
    .form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    .actions { display: flex; gap: 10px; margin-top: 20px; }
    #login-wrap { max-width: 400px; margin: 80px auto; }
    .section-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
    .pool-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); margin-bottom: 16px; overflow: hidden; }
    .pool-header { padding: 16px 20px; display: flex; align-items: center; gap: 12px; border-bottom: 1px solid var(--border); }
    .pool-header .name { font-weight: 600; flex: 1; }
    .pool-body { padding: 16px 20px; }
    .acc-row { display: flex; align-items: center; gap: 12px; padding: 10px 0; border-bottom: 1px solid var(--border); }
    .acc-row:last-child { border: none; }
    .acc-email { flex: 1; font-size: 14px; }
    .meter { flex: 1; }
    .meter-label { font-size: 11px; color: var(--muted); margin-bottom: 4px; }
    .empty { color: var(--muted); font-size: 14px; text-align: center; padding: 40px; }
    .toast { position: fixed; bottom: 24px; right: 24px; background: var(--surface); border: 1px solid var(--border); padding: 12px 18px; border-radius: var(--radius); font-size: 14px; z-index: 999; opacity: 0; transition: opacity .2s; }
    .toast.show { opacity: 1; }
    .code-block { background: #111; border: 1px solid var(--border); border-radius: 8px; padding: 16px; font-family: monospace; font-size: 13px; color: #a8f0a8; overflow-x: auto; white-space: pre; margin-top: 12px; }
    .tabs { display: flex; gap: 0; margin-bottom: 20px; border-bottom: 1px solid var(--border); }
    .tabs button { background: none; border: none; color: var(--muted); padding: 10px 20px; cursor: pointer; font-size: 14px; border-bottom: 2px solid transparent; margin-bottom: -1px; transition: all .15s; }
    .tabs button.active { color: var(--text); border-bottom-color: var(--accent); }
    .api-section { display: none; } .api-section.active { display: block; }
    @media (max-width: 700px) { main { padding: 16px; } .form-row { grid-template-columns: 1fr; } }
  </style>
</head>
<body>

<!-- LOGIN SCREEN -->
<div id="login-screen">
  <div id="login-wrap" class="card">
    <div style="text-align:center;margin-bottom:24px">
      <h1 style="font-size:22px">Drive<span style="color:var(--accent)">Pool</span></h1>
      <p style="color:var(--muted);font-size:14px;margin-top:6px">Unified Google Drive storage</p>
    </div>
    <div id="login-form">
      <label>Email</label>
      <input type="email" id="email" placeholder="you@example.com">
      <label>Password</label>
      <input type="password" id="password" placeholder="••••••••">
      <div class="actions" style="flex-direction:column">
        <button class="btn btn-primary" style="width:100%;justify-content:center" onclick="login()">Sign in</button>
        <button class="btn btn-ghost" style="width:100%;justify-content:center" onclick="showRegister()">Create account</button>
      </div>
    </div>
    <div id="register-form" style="display:none">
      <label>Email</label>
      <input type="email" id="reg-email" placeholder="you@example.com">
      <label>Password</label>
      <input type="password" id="reg-password" placeholder="Min 8 characters">
      <div class="actions" style="flex-direction:column">
        <button class="btn btn-primary" style="width:100%;justify-content:center" onclick="register()">Create account</button>
        <button class="btn btn-ghost" style="width:100%;justify-content:center" onclick="showLogin()">Back to sign in</button>
      </div>
    </div>
    <div id="api-key-display" style="display:none">
      <p style="color:var(--green);font-size:14px;margin-bottom:12px">✅ Account created successfully!</p>
      <label>Your API Key (save this — shown once)</label>
      <div class="code-block" id="api-key-text" style="cursor:pointer" onclick="copyApiKey()"></div>
      <p style="font-size:12px;color:var(--muted);margin-top:8px">Click to copy. Store this securely.</p>
      <button class="btn btn-primary" style="margin-top:16px;width:100%;justify-content:center" onclick="proceedToDashboard()">Go to Dashboard</button>
    </div>
  </div>
</div>

<!-- MAIN APP -->
<div id="app" style="display:none">
  <header>
    <h1>Drive<span>Pool</span> <span class="badge">Beta</span></h1>
    <nav>
      <button class="active" onclick="showPage('overview', this)">Overview</button>
      <button onclick="showPage('pools', this)">Pools</button>
      <button onclick="showPage('accounts', this)">Accounts</button>
      <button onclick="showPage('storage', this)">Storage</button>
      <button onclick="showPage('apikeys', this)">API Keys</button>
      <button onclick="showPage('audit', this)">Audit Log</button>
    </nav>
    <button class="btn btn-ghost" onclick="logout()" style="font-size:13px">Sign out</button>
  </header>

  <main>
    <!-- OVERVIEW PAGE -->
    <div id="page-overview" class="page active">
      <h2>Overview</h2>
      <p class="sub">Live status of your storage pools and Drive accounts.</p>
      <div class="grid" id="stat-cards">
        <div class="card"><div class="label">Total Pools</div><div class="value" id="stat-pools">—</div></div>
        <div class="card"><div class="label">Drive Accounts</div><div class="value" id="stat-accounts">—</div></div>
        <div class="card"><div class="label">Storage Used</div><div class="value" id="stat-used">—</div></div>
        <div class="card"><div class="label">Storage Capacity</div><div class="value" id="stat-cap">—</div></div>
      </div>
      <div class="section-header"><h3 style="font-size:16px">Pool Health</h3><button class="btn btn-ghost" style="font-size:13px" onclick="loadDashboard()">↻ Refresh</button></div>
      <div id="pool-health-list"><div class="empty">Loading...</div></div>
      <div class="section-header" style="margin-top:32px"><h3 style="font-size:16px">Recent Errors</h3></div>
      <div id="recent-errors"><div class="empty">Loading...</div></div>
    </div>

    <!-- POOLS PAGE -->
    <div id="page-pools" class="page">
      <div class="section-header">
        <div><h2>Pools</h2><p class="sub" style="margin:0">Manage your storage pool groups.</p></div>
        <button class="btn btn-primary" onclick="showCreatePool()">+ New Pool</button>
      </div>
      <div id="create-pool-form" class="card" style="display:none;margin-bottom:20px">
        <h3 style="font-size:16px;margin-bottom:16px">Create Pool</h3>
        <label>Pool Name</label><input id="pool-name" placeholder="e.g. Fast Pool">
        <label>Purpose (optional)</label><input id="pool-purpose" placeholder="e.g. Hot data for AI apps">
        <div class="actions">
          <button class="btn btn-primary" onclick="createPool()">Create</button>
          <button class="btn btn-ghost" onclick="hideCreatePool()">Cancel</button>
        </div>
      </div>
      <div id="pools-list"><div class="empty">Loading...</div></div>
    </div>

    <!-- ACCOUNTS PAGE -->
    <div id="page-accounts" class="page">
      <div class="section-header">
        <div><h2>Drive Accounts</h2><p class="sub" style="margin:0">Connect Google Drive accounts to your pools.</p></div>
      </div>
      <div class="card" style="margin-bottom:24px">
        <h3 style="font-size:15px;margin-bottom:12px">Connect a Drive Account</h3>
        <label>Select Pool</label>
        <select id="connect-pool-select"><option value="">Loading pools...</option></select>
        <div class="actions"><button class="btn btn-primary" onclick="connectDriveAccount()">Connect via Google OAuth →</button></div>
      </div>
      <div id="accounts-list"><div class="empty">Loading...</div></div>
    </div>

    <!-- STORAGE PAGE -->
    <div id="page-storage" class="page">
      <h2>Storage Browser</h2>
      <p class="sub">View and manage stored data across your pools.</p>
      <div class="grid" id="storage-by-type"></div>
      <div class="section-header" style="margin-top:8px">
        <h3 style="font-size:16px">Recent Files</h3>
        <select id="storage-type-filter" onchange="loadStorage()" style="width:auto">
          <option value="">All types</option>
          <option value="file">Files</option>
          <option value="json">JSON</option>
          <option value="kv">Key-Value</option>
          <option value="sql">SQL</option>
          <option value="cache">Cache</option>
        </select>
      </div>
      <div class="card"><table>
        <thead><tr><th>ID</th><th>Type</th><th>App</th><th>Collection/Key</th><th>Size</th><th>Created</th></tr></thead>
        <tbody id="storage-table-body"><tr><td colspan="6" style="text-align:center;color:var(--muted);padding:24px">Loading...</td></tr></tbody>
      </table></div>
    </div>

    <!-- API KEYS PAGE -->
    <div id="page-apikeys" class="page">
      <h2>API Keys & Integration</h2>
      <p class="sub">Your API key and code examples for all storage types.</p>
      <div class="card" style="margin-bottom:20px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
          <h3 style="font-size:15px">Your API Key</h3>
          <button class="btn btn-ghost" style="font-size:13px" onclick="rotateKey()">Rotate Key</button>
        </div>
        <div class="code-block" id="display-api-key" style="cursor:pointer" onclick="copyCurrentKey()">Click "Show Key" to reveal</div>
        <button class="btn btn-ghost" style="margin-top:10px;font-size:13px" onclick="showKey()">Show Key</button>
      </div>
      <div class="tabs">
        <button class="active" onclick="switchApiTab('file', this)">File Upload</button>
        <button onclick="switchApiTab('json', this)">JSON</button>
        <button onclick="switchApiTab('kv', this)">Key-Value</button>
        <button onclick="switchApiTab('sql', this)">SQL</button>
        <button onclick="switchApiTab('cache', this)">Cache</button>
      </div>
      <div id="api-file" class="api-section active">
        <p style="font-size:14px;color:var(--muted);margin-bottom:8px">Upload any file (binary, images, documents, etc.)</p>
        <div class="code-block" id="code-file"></div>
      </div>
      <div id="api-json" class="api-section">
        <div class="code-block" id="code-json"></div>
      </div>
      <div id="api-kv" class="api-section">
        <div class="code-block" id="code-kv"></div>
      </div>
      <div id="api-sql" class="api-section">
        <div class="code-block" id="code-sql"></div>
      </div>
      <div id="api-cache" class="api-section">
        <div class="code-block" id="code-cache"></div>
      </div>
    </div>

    <!-- AUDIT LOG PAGE -->
    <div id="page-audit" class="page">
      <div class="section-header">
        <div><h2>Audit Log</h2><p class="sub" style="margin:0">All storage operations.</p></div>
        <select id="audit-status-filter" onchange="loadAudit()" style="width:auto">
          <option value="">All statuses</option>
          <option value="ok">Success</option>
          <option value="error">Errors</option>
        </select>
      </div>
      <div class="card"><table>
        <thead><tr><th>Action</th><th>Status</th><th>Pool</th><th>Bytes</th><th>Latency</th><th>Time</th></tr></thead>
        <tbody id="audit-table-body"><tr><td colspan="6" style="text-align:center;color:var(--muted);padding:24px">Loading...</td></tr></tbody>
      </table></div>
    </div>
  </main>
</div>

<div class="toast" id="toast"></div>

<script>
  const BASE = window.location.origin;
  let apiKey = localStorage.getItem('dp_api_key') || '';
  let newlyCreatedKey = '';

  function headers() {
    return { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' };
  }

  async function api(method, path, body) {
    const res = await fetch(BASE + path, {
      method, headers: headers(),
      body: body ? JSON.stringify(body) : undefined
    });
    return res.json();
  }

  function fmt(bytes) {
    if (!bytes) return '0 B';
    const u = ['B','KB','MB','GB','TB'];
    let i = 0, b = bytes;
    while (b >= 1024 && i < u.length-1) { b /= 1024; i++; }
    return b.toFixed(1) + ' ' + u[i];
  }

  function timeAgo(ts) {
    const d = Math.floor((Date.now() - ts) / 1000);
    if (d < 60) return d + 's ago';
    if (d < 3600) return Math.floor(d/60) + 'm ago';
    if (d < 86400) return Math.floor(d/3600) + 'h ago';
    return Math.floor(d/86400) + 'd ago';
  }

  function toast(msg, color='var(--green)') {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.style.borderColor = color;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 2500);
  }

  // Auth
  function showRegister() {
    document.getElementById('login-form').style.display = 'none';
    document.getElementById('register-form').style.display = 'block';
  }
  function showLogin() {
    document.getElementById('login-form').style.display = 'block';
    document.getElementById('register-form').style.display = 'none';
  }

  async function login() {
    const email = document.getElementById('email').value;
    const password = document.getElementById('password').value;
    if (!email || !password) { toast('Fill in all fields', 'var(--red)'); return; }
    if (!apiKey) { apiKey = prompt('Enter your API key:') || ''; localStorage.setItem('dp_api_key', apiKey); }
    initApp();
  }

  async function register() {
    const email = document.getElementById('reg-email').value;
    const password = document.getElementById('reg-password').value;
    if (!email || !password) { toast('Fill in all fields', 'var(--red)'); return; }
    const res = await fetch(BASE + '/api/auth/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    }).then(r => r.json());
    if (res.api_key) {
      newlyCreatedKey = res.api_key;
      document.getElementById('api-key-text').textContent = res.api_key;
      document.getElementById('register-form').style.display = 'none';
      document.getElementById('api-key-display').style.display = 'block';
    } else {
      toast(res.error || 'Registration failed', 'var(--red)');
    }
  }

  function copyApiKey() {
    navigator.clipboard.writeText(newlyCreatedKey);
    toast('API key copied!');
  }

  function proceedToDashboard() {
    apiKey = newlyCreatedKey;
    localStorage.setItem('dp_api_key', apiKey);
    initApp();
  }

  function logout() {
    localStorage.removeItem('dp_api_key');
    apiKey = '';
    document.getElementById('app').style.display = 'none';
    document.getElementById('login-screen').style.display = 'block';
  }

  function initApp() {
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('app').style.display = 'block';
    loadDashboard();
    loadPoolsForConnect();
    updateCodeExamples();
  }

  // Navigation
  function showPage(name, btn) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('nav button').forEach(b => b.classList.remove('active'));
    document.getElementById('page-' + name).classList.add('active');
    btn.classList.add('active');
    if (name === 'pools') loadPools();
    if (name === 'accounts') { loadAccounts(); loadPoolsForConnect(); }
    if (name === 'storage') loadStorage();
    if (name === 'audit') loadAudit();
  }

  // Dashboard
  async function loadDashboard() {
    const data = await api('GET', '/api/monitor/dashboard');
    if (data.error) { toast(data.error, 'var(--red)'); return; }

    document.getElementById('stat-pools').textContent = data.summary.total_pools;
    document.getElementById('stat-accounts').textContent = data.summary.total_accounts;
    document.getElementById('stat-used').textContent = fmt(data.summary.total_storage_used_bytes);
    document.getElementById('stat-cap').textContent = fmt(data.summary.total_storage_capacity_bytes);

    // Pool health cards
    const poolHtml = (data.pools || []).map(pool => {
      const accHtml = (pool.accounts || []).map(acc => {
        const qPct = Math.min(100, Math.round((acc.requests_this_minute || 0) / 96));
        const bytesPct = Math.min(100, Math.round(((acc.daily_bytes_used || 0) / 700e9) * 100));
        const barClass = qPct > 80 ? 'danger' : qPct > 60 ? 'warn' : '';
        const status = acc.cooling ? 'cool' : acc.healthy ? 'ok' : 'err';
        const statusLabel = acc.cooling ? 'Cooling' : acc.healthy ? 'Healthy' : 'Error';
        return \`<div class="acc-row">
          <div class="acc-email">\${acc.email}</div>
          <div class="meter" style="max-width:160px">
            <div class="meter-label">API: \${acc.requests_this_minute||0}/min</div>
            <div class="bar-wrap"><div class="bar \${barClass}" style="width:\${qPct}%"></div></div>
          </div>
          <div class="meter" style="max-width:140px">
            <div class="meter-label">Daily: \${fmt(acc.daily_bytes_used||0)}</div>
            <div class="bar-wrap"><div class="bar \${bytesPct>80?'danger':''}" style="width:\${bytesPct}%"></div></div>
          </div>
          <span class="tag \${status}">\${statusLabel}</span>
        </div>\`;
      }).join('');
      return \`<div class="pool-card">
        <div class="pool-header">
          <div class="name">\${pool.name}</div>
          <span class="tag ok">\${pool.healthy_accounts}/\${pool.accounts.length} healthy</span>
          <span style="color:var(--muted);font-size:13px">\${fmt(pool.total_bytes)} · \${pool.total_files} files</span>
        </div>
        <div class="pool-body">\${accHtml || '<div class="empty">No accounts in this pool</div>'}</div>
      </div>\`;
    }).join('') || '<div class="empty">No pools yet. Create a pool and connect Drive accounts.</div>';
    document.getElementById('pool-health-list').innerHTML = poolHtml;

    // Recent errors
    const errors = data.audit?.recent_errors || [];
    document.getElementById('recent-errors').innerHTML = errors.length === 0
      ? '<div class="empty" style="padding:20px">No errors in the last hour ✅</div>'
      : \`<div class="card"><table><thead><tr><th>Action</th><th>Error</th><th>Time</th></tr></thead><tbody>
          \${errors.map(e => \`<tr><td>\${e.action}</td><td style="color:var(--red)">\${e.error_message||'—'}</td><td style="color:var(--muted)">\${timeAgo(e.created_at)}</td></tr>\`).join('')}
        </tbody></table></div>\`;
  }

  // Pools
  async function loadPools() {
    const data = await api('GET', '/api/pools');
    const pools = data.pools || [];
    document.getElementById('pools-list').innerHTML = pools.length === 0
      ? '<div class="empty">No pools yet.</div>'
      : pools.map(p => \`<div class="pool-card">
          <div class="pool-header">
            <div class="name">\${p.name} \${p.is_default ? '<span class="tag ok">Default</span>' : ''}</div>
            <span style="color:var(--muted);font-size:13px">\${p.accounts.length} accounts · \${p.purpose||''}</span>
            <button class="btn btn-danger" style="padding:5px 10px;font-size:12px" onclick="deletePool('\${p.id}')">Delete</button>
          </div>
          <div class="pool-body">
            <p style="font-size:12px;color:var(--muted);margin-bottom:8px">Pool ID: <code>\${p.id}</code></p>
            \${p.accounts.map(a => \`<div class="acc-row"><div class="acc-email">\${a.email}</div><span class="tag \${a.active?'ok':'err'}">\${a.active?'Active':'Disabled'}</span></div>\`).join('') || '<div class="empty">No accounts. Add one in the Accounts tab.</div>'}
          </div>
        </div>\`).join('');
  }

  function showCreatePool() { document.getElementById('create-pool-form').style.display = 'block'; }
  function hideCreatePool() { document.getElementById('create-pool-form').style.display = 'none'; }

  async function createPool() {
    const name = document.getElementById('pool-name').value;
    const purpose = document.getElementById('pool-purpose').value;
    if (!name) { toast('Pool name required', 'var(--red)'); return; }
    const res = await api('POST', '/api/pools', { name, purpose });
    if (res.id) { toast('Pool created!'); hideCreatePool(); loadPools(); }
    else toast(res.error || 'Error', 'var(--red)');
  }

  async function deletePool(id) {
    if (!confirm('Delete this pool?')) return;
    await api('DELETE', '/api/pools/' + id);
    loadPools();
  }

  // Accounts
  async function loadAccounts() {
    const data = await api('GET', '/api/accounts');
    const accounts = data.accounts || [];
    document.getElementById('accounts-list').innerHTML = accounts.length === 0
      ? '<div class="empty">No Drive accounts connected yet.</div>'
      : \`<div class="card"><table>
          <thead><tr><th>Email</th><th>Pool</th><th>Status</th><th>Storage Limit</th><th>Daily Limit</th><th></th></tr></thead>
          <tbody>\${accounts.map(a => \`<tr>
            <td>\${a.email}</td>
            <td style="color:var(--muted);font-size:13px">\${a.pool_id}</td>
            <td><span class="tag \${a.active?'ok':'err'}">\${a.active?'Active':'Disabled'}</span></td>
            <td>\${fmt(a.storage_limit_bytes)}</td>
            <td>\${fmt(a.daily_upload_limit_bytes)}/day</td>
            <td><button class="btn btn-danger" style="padding:4px 10px;font-size:12px" onclick="removeAccount('\${a.id}')">Remove</button></td>
          </tr>\`).join('')}</tbody>
        </table></div>\`;
  }

  async function loadPoolsForConnect() {
    const data = await api('GET', '/api/pools');
    const sel = document.getElementById('connect-pool-select');
    if (sel && data.pools) {
      sel.innerHTML = data.pools.map(p => \`<option value="\${p.id}">\${p.name}</option>\`).join('');
    }
  }

  async function connectDriveAccount() {
    const poolId = document.getElementById('connect-pool-select').value;
    if (!poolId) { toast('Select a pool', 'var(--red)'); return; }
    const res = await api('POST', '/api/accounts/oauth-init', { pool_id: poolId });
    if (res.auth_url) window.open(res.auth_url, '_blank', 'width=500,height=600');
    else toast(res.error || 'Error', 'var(--red)');
  }

  async function removeAccount(id) {
    if (!confirm('Remove this account?')) return;
    await api('DELETE', '/api/accounts/' + id);
    loadAccounts();
  }

  // Storage
  async function loadStorage() {
    const type = document.getElementById('storage-type-filter')?.value || '';
    const data = await api('GET', '/api/monitor/storage');
    const breakdown = data.breakdown || [];

    document.getElementById('storage-by-type').innerHTML = ['file','json','kv','sql','cache'].map(t => {
      const s = breakdown.filter(b => b.data_type === t);
      const count = s.reduce((sum,b) => sum+b.count, 0);
      const bytes = s.reduce((sum,b) => sum+(b.total_bytes||0), 0);
      return \`<div class="card"><div class="label">\${t.toUpperCase()}</div><div class="value">\${count}</div><div class="sub">\${fmt(bytes)}</div></div>\`;
    }).join('');

    const path = type ? \`/api/monitor/audit?action=\${type}\` : '/api/monitor/audit';
    const logs = await api('GET', path);
    const tbody = document.getElementById('storage-table-body');
    const rows = (logs.logs || []).slice(0,50);
    tbody.innerHTML = rows.length === 0
      ? '<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:24px">No data yet</td></tr>'
      : rows.map(r => \`<tr>
          <td style="font-family:monospace;font-size:12px">\${r.id?.slice(0,8)}…</td>
          <td><span class="tag ok">\${r.action?.split('.')[0]||'—'}</span></td>
          <td style="color:var(--muted)">\${r.user_id?.slice(0,8)||'—'}</td>
          <td style="color:var(--muted)">—</td>
          <td>\${fmt(r.bytes)}</td>
          <td style="color:var(--muted)">\${timeAgo(r.created_at)}</td>
        </tr>\`).join('');
  }

  // Audit log
  async function loadAudit() {
    const status = document.getElementById('audit-status-filter')?.value || '';
    const path = '/api/monitor/audit' + (status ? '?status=' + status : '');
    const data = await api('GET', path);
    const tbody = document.getElementById('audit-table-body');
    const logs = data.logs || [];
    tbody.innerHTML = logs.length === 0
      ? '<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:24px">No logs yet</td></tr>'
      : logs.map(l => \`<tr>
          <td><code style="font-size:12px">\${l.action}</code></td>
          <td><span class="tag \${l.status==='ok'?'ok':'err'}">\${l.status}</span></td>
          <td style="color:var(--muted);font-size:12px">\${l.pool_id?.slice(0,8)||'—'}</td>
          <td>\${fmt(l.bytes)}</td>
          <td style="color:var(--muted)">\${l.latency_ms}ms</td>
          <td style="color:var(--muted)">\${timeAgo(l.created_at)}</td>
        </tr>\`).join('');
  }

  // API Keys page
  function showKey() {
    document.getElementById('display-api-key').textContent = apiKey || '(no key stored)';
  }

  function copyCurrentKey() {
    navigator.clipboard.writeText(apiKey);
    toast('Copied!');
  }

  async function rotateKey() {
    if (!confirm('This will invalidate your current API key. Continue?')) return;
    const res = await api('POST', '/api/auth/rotate-key');
    if (res.api_key) {
      apiKey = res.api_key;
      localStorage.setItem('dp_api_key', apiKey);
      document.getElementById('display-api-key').textContent = apiKey;
      updateCodeExamples();
      toast('Key rotated! Save the new key.');
    }
  }

  function switchApiTab(name, btn) {
    document.querySelectorAll('.api-section').forEach(s => s.classList.remove('active'));
    document.querySelectorAll('.tabs button').forEach(b => b.classList.remove('active'));
    document.getElementById('api-' + name).classList.add('active');
    btn.classList.add('active');
  }

  function updateCodeExamples() {
    const base = window.location.origin;
    const key = apiKey || 'YOUR_API_KEY';
    document.getElementById('code-file').textContent =
\`// Upload a file
const form = new FormData();
form.append('file', fileInput.files[0]);

const res = await fetch('\${base}/api/storage/upload?app_id=myapp', {
  method: 'POST',
  headers: { 'Authorization': 'Bearer \${key}' },
  body: form
});
const { id } = await res.json();

// Download
const file = await fetch('\${base}/api/storage/files/' + id, {
  headers: { 'Authorization': 'Bearer \${key}' }
});\`;

    document.getElementById('code-json').textContent =
\`// Store a JSON document
const res = await fetch('\${base}/api/storage/json?app_id=myapp', {
  method: 'POST',
  headers: { 'Authorization': 'Bearer \${key}', 'Content-Type': 'application/json' },
  body: JSON.stringify({ collection: 'users', data: { name: 'Alice', age: 30 } })
});
const { id } = await res.json();

// Retrieve
const doc = await fetch('\${base}/api/storage/json/users/' + id, {
  headers: { 'Authorization': 'Bearer \${key}' }
}).then(r => r.json());\`;

    document.getElementById('code-kv').textContent =
\`// Set a key-value pair (with optional TTL in seconds)
await fetch('\${base}/api/storage/kv?app_id=myapp', {
  method: 'POST',
  headers: { 'Authorization': 'Bearer \${key}', 'Content-Type': 'application/json' },
  body: JSON.stringify({ key: 'user:123:prefs', value: { theme: 'dark' }, ttl: 3600 })
});

// Get
const res = await fetch('\${base}/api/storage/kv/user:123:prefs', {
  headers: { 'Authorization': 'Bearer \${key}' }
}).then(r => r.json());
console.log(res.value); // { theme: 'dark' }\`;

    document.getElementById('code-sql').textContent =
\`// Create table
await fetch('\${base}/api/storage/sql?app_id=myapp', {
  method: 'POST',
  headers: { 'Authorization': 'Bearer \${key}', 'Content-Type': 'application/json' },
  body: JSON.stringify({ db: 'mydb', sql: 'CREATE TABLE IF NOT EXISTS users (name TEXT, email TEXT)' })
});

// Insert
await fetch('\${base}/api/storage/sql?app_id=myapp', {
  method: 'POST',
  headers: { 'Authorization': 'Bearer \${key}', 'Content-Type': 'application/json' },
  body: JSON.stringify({ db: 'mydb', sql: 'INSERT INTO users (name, email) VALUES (?, ?)', params: ['Alice', 'alice@example.com'] })
});

// Query
const { rows } = await fetch('\${base}/api/storage/sql?app_id=myapp', {
  method: 'POST',
  headers: { 'Authorization': 'Bearer \${key}', 'Content-Type': 'application/json' },
  body: JSON.stringify({ db: 'mydb', sql: 'SELECT * FROM users WHERE name = ?', params: ['Alice'] })
}).then(r => r.json());\`;

    document.getElementById('code-cache').textContent =
\`// Cache an API response
await fetch('\${base}/api/storage/cache?app_id=myapp', {
  method: 'POST',
  headers: { 'Authorization': 'Bearer \${key}', 'Content-Type': 'application/json' },
  body: JSON.stringify({ key: 'weather:london', response: { temp: 18, unit: 'C' }, ttl: 600 })
});

// Get cached response
const { hit, response } = await fetch('\${base}/api/storage/cache/weather:london', {
  headers: { 'Authorization': 'Bearer \${key}' }
}).then(r => r.json());

if (hit) console.log(response); // { temp: 18, unit: 'C' }\`;
  }

  // Boot
  if (apiKey) initApp();
</script>
</body>
</html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html;charset=utf-8' } });
}
