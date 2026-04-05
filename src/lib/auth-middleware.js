// src/lib/auth-middleware.js

import { hashApiKey } from './crypto.js';

export async function requireAuth(request, env) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { error: 'Missing Authorization header', status: 401 };
  }

  const apiKey = authHeader.slice(7).trim();
  if (!apiKey.startsWith('dp_')) {
    return { error: 'Invalid API key format', status: 401 };
  }

  const keyHash = await hashApiKey(apiKey);
  const user = await env.DB.prepare(
    'SELECT id, email, plan FROM users WHERE api_key_hash = ?'
  ).bind(keyHash).first();

  if (!user) {
    return { error: 'Invalid API key', status: 401 };
  }

  return { user };
}

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    },
  });
}

export function error(message, status = 400) {
  return json({ error: message }, status);
}
