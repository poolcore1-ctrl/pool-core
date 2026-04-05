// src/workers/pools.js

import { requireAuth, json, error } from '../lib/auth-middleware.js';
import { generateId, encrypt, decrypt } from '../lib/crypto.js';

// ─── POOLS ───────────────────────────────────────────────────────────────────

export async function handlePools(request, env, pathname) {
  const auth = await requireAuth(request, env);
  if (auth.error) return error(auth.error, auth.status);
  const { user } = auth;
  const method = request.method;

  // GET /api/pools — list all pools
  if (pathname === '/api/pools' && method === 'GET') {
    const { results } = await env.DB.prepare(
      'SELECT * FROM pools WHERE user_id = ? ORDER BY is_default DESC, created_at ASC'
    ).bind(user.id).all();

    // Attach account counts
    const pools = await Promise.all((results || []).map(async pool => {
      const { results: accounts } = await env.DB.prepare(
        'SELECT id, email, active FROM accounts WHERE pool_id = ?'
      ).bind(pool.id).all();
      return { ...pool, routing_rules: JSON.parse(pool.routing_rules || '[]'), accounts: accounts || [] };
    }));

    return json({ pools });
  }

  // POST /api/pools — create pool
  if (pathname === '/api/pools' && method === 'POST') {
    const body = await request.json().catch(() => null);
    if (!body?.name) return error('name is required');

    const id = generateId();
    await env.DB.prepare(
      'INSERT INTO pools (id, user_id, name, purpose, is_default, overflow_pool_id, routing_rules, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(id, user.id, body.name, body.purpose || '', body.is_default ? 1 : 0, body.overflow_pool_id || null, JSON.stringify(body.routing_rules || []), Date.now()).run();

    return json({ id, name: body.name }, 201);
  }

  // GET /api/pools/:id
  const poolMatch = pathname.match(/^\/api\/pools\/([^/]+)$/);
  if (poolMatch) {
    const poolId = poolMatch[1];
    const pool = await env.DB.prepare('SELECT * FROM pools WHERE id = ? AND user_id = ?').bind(poolId, user.id).first();
    if (!pool) return error('Pool not found', 404);

    if (method === 'GET') {
      const { results: accounts } = await env.DB.prepare('SELECT id, email, active, created_at FROM accounts WHERE pool_id = ?').bind(poolId).all();
      return json({ ...pool, routing_rules: JSON.parse(pool.routing_rules || '[]'), accounts: accounts || [] });
    }

    if (method === 'PUT') {
      const body = await request.json().catch(() => null);
      await env.DB.prepare(
        'UPDATE pools SET name = ?, purpose = ?, is_default = ?, overflow_pool_id = ?, routing_rules = ? WHERE id = ?'
      ).bind(body.name || pool.name, body.purpose ?? pool.purpose, body.is_default !== undefined ? (body.is_default ? 1 : 0) : pool.is_default, body.overflow_pool_id ?? pool.overflow_pool_id, JSON.stringify(body.routing_rules || JSON.parse(pool.routing_rules || '[]')), poolId).run();
      return json({ ok: true });
    }

    if (method === 'DELETE') {
      await env.DB.prepare('DELETE FROM pools WHERE id = ? AND user_id = ?').bind(poolId, user.id).run();
      return json({ ok: true });
    }
  }

  return error('Not found', 404);
}

// ─── ACCOUNTS ─────────────────────────────────────────────────────────────────

export async function handleAccounts(request, env, pathname) {
  const auth = await requireAuth(request, env);
  if (auth.error) return error(auth.error, auth.status);
  const { user } = auth;
  const method = request.method;

  // GET /api/accounts — list all Drive accounts
  if (pathname === '/api/accounts' && method === 'GET') {
    const { results } = await env.DB.prepare(
      'SELECT id, pool_id, email, active, storage_limit_bytes, daily_upload_limit_bytes, created_at FROM accounts WHERE user_id = ?'
    ).bind(user.id).all();
    return json({ accounts: results || [] });
  }

  // POST /api/accounts/oauth-init — start OAuth flow for adding a Drive account
  if (pathname === '/api/accounts/oauth-init' && method === 'POST') {
    const body = await request.json().catch(() => null);
    if (!body?.pool_id) return error('pool_id is required');

    // Verify pool belongs to user
    const pool = await env.DB.prepare('SELECT id FROM pools WHERE id = ? AND user_id = ?').bind(body.pool_id, user.id).first();
    if (!pool) return error('Pool not found', 404);

    // Store OAuth state for CSRF protection
    const state = generateId();
    await env.DB.prepare(
      'INSERT INTO oauth_state (state, user_id, pool_id, created_at) VALUES (?, ?, ?, ?)'
    ).bind(state, user.id, body.pool_id, Date.now()).run();

    const params = new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      redirect_uri: `${new URL(request.url).origin}/api/accounts/oauth-callback`,
      response_type: 'code',
      scope: 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.metadata.readonly',
      access_type: 'offline',
      prompt: 'consent',
      state,
    });

    return json({ auth_url: `https://accounts.google.com/o/oauth2/v2/auth?${params}` });
  }

  // GET /api/accounts/oauth-callback — Google redirects here
  if (pathname === '/api/accounts/oauth-callback' && method === 'GET') {
    const url = new URL(request.url);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const oauthError = url.searchParams.get('error');

    if (oauthError) {
      return new Response(`<html><body><h2>OAuth Error: ${oauthError}</h2><p>Close this tab and try again.</p></body></html>`, {
        headers: { 'Content-Type': 'text/html' },
      });
    }

    // Validate state
    const storedState = await env.DB.prepare('SELECT * FROM oauth_state WHERE state = ?').bind(state).first();
    if (!storedState) {
      return new Response('<html><body><h2>Invalid state</h2><p>Please try again.</p></body></html>', {
        headers: { 'Content-Type': 'text/html' },
        status: 400,
      });
    }

    // Exchange code for tokens
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: `${new URL(request.url).origin}/api/accounts/oauth-callback`,
        grant_type: 'authorization_code',
        code,
      }),
    });

    const tokens = await tokenRes.json();
    if (!tokens.refresh_token) {
      return new Response('<html><body><h2>No refresh token received</h2><p>Please ensure you are granting offline access.</p></body></html>', {
        headers: { 'Content-Type': 'text/html' },
        status: 400,
      });
    }

    // Get user email from Google
    const userInfoRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const userInfo = await userInfoRes.json();

    // Encrypt tokens
    const refreshTokenEnc = await encrypt(tokens.refresh_token, env.MASTER_SECRET);
    const accessTokenEnc = await encrypt(tokens.access_token, env.MASTER_SECRET);

    const accountId = generateId();
    await env.DB.prepare(
      'INSERT INTO accounts (id, pool_id, user_id, email, refresh_token_enc, access_token_enc, access_token_expires, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)'
    ).bind(accountId, storedState.pool_id, storedState.user_id, userInfo.email, refreshTokenEnc, accessTokenEnc, Date.now() + (tokens.expires_in - 60) * 1000, Date.now()).run();

    // Clean up state
    await env.DB.prepare('DELETE FROM oauth_state WHERE state = ?').bind(state).run();

    // Redirect to dashboard success
    return new Response(
      `<html><head><meta http-equiv="refresh" content="3;url=/dashboard"></head>
       <body style="font-family:sans-serif;padding:40px">
         <h2>✅ Drive account connected!</h2>
         <p><strong>${userInfo.email}</strong> has been added to your pool.</p>
         <p>Redirecting to dashboard...</p>
       </body></html>`,
      { headers: { 'Content-Type': 'text/html' } }
    );
  }

  // DELETE /api/accounts/:id
  const accMatch = pathname.match(/^\/api\/accounts\/([^/]+)$/);
  if (accMatch && method === 'DELETE') {
    const accountId = accMatch[1];
    await env.DB.prepare('UPDATE accounts SET active = 0 WHERE id = ? AND user_id = ?').bind(accountId, user.id).run();
    return json({ ok: true });
  }

  return error('Not found', 404);
}
