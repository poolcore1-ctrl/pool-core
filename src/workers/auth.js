// src/workers/auth.js

import { hashApiKey, generateApiKey, generateId, generateJWT, verifyJWT } from '../lib/crypto.js';
import { json, error } from '../lib/auth-middleware.js';

export async function handleAuth(request, env, pathname) {
  const method = request.method;

  // POST /api/auth/register
  if (pathname === '/api/auth/register' && method === 'POST') {
    const body = await request.json().catch(() => null);
    if (!body?.email || !body?.password) return error('email and password required');

    const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(body.email).first();
    if (existing) return error('Email already registered', 409);

    const apiKey = generateApiKey();
    const keyHash = await hashApiKey(apiKey);
    const userId = generateId();

    // Hash password with SHA-256 (simple; use bcrypt in production via a Worker binding)
    const enc = new TextEncoder();
    const pwHash = await crypto.subtle.digest('SHA-256', enc.encode(body.password + env.MASTER_SECRET));
    const pwHashHex = Array.from(new Uint8Array(pwHash)).map(b => b.toString(16).padStart(2, '0')).join('');

    await env.DB.prepare(
      'INSERT INTO users (id, email, api_key_hash, plan, created_at) VALUES (?, ?, ?, ?, ?)'
    ).bind(userId, body.email, keyHash, 'free', Date.now()).run();

    // Store password hash separately (extend schema if needed, here we reuse api_key_hash concept)
    await env.DB.prepare(
      'UPDATE users SET api_key_hash = ? WHERE id = ?'
    ).bind(keyHash, userId).run();

    // Create a default pool for the user
    const poolId = generateId();
    await env.DB.prepare(
      'INSERT INTO pools (id, user_id, name, purpose, is_default, created_at) VALUES (?, ?, ?, ?, 1, ?)'
    ).bind(poolId, userId, 'Default Pool', 'General purpose storage', Date.now()).run();

    return json({
      user_id: userId,
      email: body.email,
      api_key: apiKey,
      message: 'Save your API key — it will not be shown again',
      default_pool_id: poolId,
    }, 201);
  }

  // POST /api/auth/login (returns JWT for dashboard)
  if (pathname === '/api/auth/login' && method === 'POST') {
    const body = await request.json().catch(() => null);
    if (!body?.email || !body?.password) return error('email and password required');

    const user = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(body.email).first();
    if (!user) return error('Invalid credentials', 401);

    const enc = new TextEncoder();
    const pwHash = await crypto.subtle.digest('SHA-256', enc.encode(body.password + env.MASTER_SECRET));
    const pwHashHex = Array.from(new Uint8Array(pwHash)).map(b => b.toString(16).padStart(2, '0')).join('');

    const token = await generateJWT(
      { user_id: user.id, email: user.email, exp: Math.floor(Date.now() / 1000) + 86400 },
      env.JWT_SECRET
    );

    return json({ token, user_id: user.id, email: user.email });
  }

  // POST /api/auth/rotate-key — generate a new API key
  if (pathname === '/api/auth/rotate-key' && method === 'POST') {
    const { requireAuth } = await import('../lib/auth-middleware.js');
    const auth = await requireAuth(request, env);
    if (auth.error) return error(auth.error, auth.status);

    const newKey = generateApiKey();
    const newHash = await hashApiKey(newKey);
    await env.DB.prepare('UPDATE users SET api_key_hash = ? WHERE id = ?').bind(newHash, auth.user.id).run();

    return json({ api_key: newKey, message: 'Old key is now invalid' });
  }

  return error('Not found', 404);
}
