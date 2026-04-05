// src/workers/storage.js

import { requireAuth, json, error } from '../lib/auth-middleware.js';
import { PoolManager } from '../lib/pool-manager.js';
import { generateId } from '../lib/crypto.js';
import {
  storeFile, retrieveFile,
  storeJson, retrieveJson, listJsonCollection,
  kvSet, kvGet,
  cacheSet,
  sqlQuery,
  createAppFolder,
} from '../lib/adapters/index.js';
import { deleteFile } from '../lib/drive-client.js';

async function logAudit(env, { userId, poolId, accountId, action, bytes, status, error: errMsg, latencyMs }) {
  await env.DB.prepare(
    'INSERT INTO audit_log (id, user_id, pool_id, account_id, action, bytes, status, error_message, latency_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(generateId(), userId, poolId || null, accountId || null, action, bytes || 0, status, errMsg || null, latencyMs || 0, Date.now()).run();
}

export async function handleStorage(request, env, pathname) {
  const auth = await requireAuth(request, env);
  if (auth.error) return error(auth.error, auth.status);
  const { user } = auth;
  const method = request.method;
  const pm = new PoolManager(env);
  const url = new URL(request.url);
  const poolId = url.searchParams.get('pool_id');
  const appId = url.searchParams.get('app_id') || 'default';

  // ── FILE UPLOAD ─────────────────────────────────────────────────────────────
  if (pathname === '/api/storage/upload' && method === 'POST') {
    const start = Date.now();
    try {
      const formData = await request.formData();
      const file = formData.get('file');
      if (!file) return error('file field is required');

      const content = await file.arrayBuffer();
      const sizeBytes = content.byteLength;

      const { pool, account } = await pm.route(user.id, {
        dataType: 'file', appId, sizeBytes, explicitPoolId: poolId
      });

      const result = await storeFile(account, env, env.DB, {
        userId: user.id, poolId: pool.id, appId,
        filename: file.name, mimeType: file.type,
        content, sizeBytes,
      });

      await pm.recordBytes(account.id, sizeBytes);
      await pm.recordSuccess(account.id);
      await logAudit(env, { userId: user.id, poolId: pool.id, accountId: account.id, action: 'file.upload', bytes: sizeBytes, status: 'ok', latencyMs: Date.now() - start });

      return json({ ...result, pool_id: pool.id }, 201);
    } catch (err) {
      await logAudit(env, { userId: user.id, action: 'file.upload', status: 'error', error: err.message, latencyMs: Date.now() - start });
      return error(err.message, 500);
    }
  }

  // ── FILE DOWNLOAD ───────────────────────────────────────────────────────────
  if (pathname.startsWith('/api/storage/files/') && method === 'GET') {
    const fileId = pathname.split('/').pop();
    const start = Date.now();
    try {
      const record = await env.DB.prepare(
        'SELECT * FROM files_index WHERE id = ? AND user_id = ?'
      ).bind(fileId, user.id).first();
      if (!record) return error('File not found', 404);

      const account = await env.DB.prepare('SELECT * FROM accounts WHERE id = ?').bind(record.account_id).first();
      const driveRes = await retrieveFile(account, env, record.drive_file_id);

      await logAudit(env, { userId: user.id, poolId: record.pool_id, accountId: account.id, action: 'file.download', status: 'ok', latencyMs: Date.now() - start });

      return new Response(driveRes.body, {
        headers: {
          'Content-Type': record.mime_type || 'application/octet-stream',
          'Content-Disposition': `attachment; filename="${record.filename}"`,
          'Access-Control-Allow-Origin': '*',
        },
      });
    } catch (err) {
      return error(err.message, 500);
    }
  }

  // ── FILE DELETE ─────────────────────────────────────────────────────────────
  if (pathname.startsWith('/api/storage/files/') && method === 'DELETE') {
    const fileId = pathname.split('/').pop();
    try {
      const record = await env.DB.prepare('SELECT * FROM files_index WHERE id = ? AND user_id = ?').bind(fileId, user.id).first();
      if (!record) return error('File not found', 404);
      const account = await env.DB.prepare('SELECT * FROM accounts WHERE id = ?').bind(record.account_id).first();
      await deleteFile(account, env, record.drive_file_id);
      await env.DB.prepare('DELETE FROM files_index WHERE id = ?').bind(fileId).run();
      return json({ ok: true });
    } catch (err) {
      return error(err.message, 500);
    }
  }

  // ── JSON STORE ──────────────────────────────────────────────────────────────
  if (pathname === '/api/storage/json' && method === 'POST') {
    const start = Date.now();
    try {
      const body = await request.json();
      if (!body.collection) return error('collection is required');

      const { pool, account } = await pm.route(user.id, { dataType: 'json', appId, explicitPoolId: poolId });
      const result = await storeJson(account, env, env.DB, {
        userId: user.id, poolId: pool.id, appId,
        collection: body.collection, docId: body.id, data: body.data || body,
      });

      await pm.recordSuccess(account.id);
      await logAudit(env, { userId: user.id, poolId: pool.id, accountId: account.id, action: 'json.write', status: 'ok', latencyMs: Date.now() - start });
      return json(result, 201);
    } catch (err) {
      await logAudit(env, { userId: user.id, action: 'json.write', status: 'error', error: err.message });
      return error(err.message, 500);
    }
  }

  if (pathname.startsWith('/api/storage/json/') && method === 'GET') {
    const parts = pathname.replace('/api/storage/json/', '').split('/');
    const collection = parts[0];
    const docId = parts[1];

    if (!docId) {
      // List collection
      const items = await listJsonCollection(env.DB, { userId: user.id, collection });
      return json({ collection, count: items.length, items });
    }

    const record = await env.DB.prepare(
      'SELECT * FROM files_index WHERE id = ? AND user_id = ? AND collection = ?'
    ).bind(docId, user.id, collection).first();
    if (!record) return error('Document not found', 404);

    const account = await env.DB.prepare('SELECT * FROM accounts WHERE id = ?').bind(record.account_id).first();
    const data = await retrieveJson(account, env, record.drive_file_id);
    return json(data);
  }

  // ── KEY-VALUE ───────────────────────────────────────────────────────────────
  if (pathname === '/api/storage/kv' && method === 'POST') {
    const start = Date.now();
    try {
      const body = await request.json();
      if (!body.key) return error('key is required');

      const { pool, account } = await pm.route(user.id, { dataType: 'kv', appId, explicitPoolId: poolId });
      const result = await kvSet(account, env, env.DB, {
        userId: user.id, poolId: pool.id, appId,
        key: body.key, value: body.value, ttlSeconds: body.ttl,
      });

      await logAudit(env, { userId: user.id, poolId: pool.id, accountId: account.id, action: 'kv.set', status: 'ok', latencyMs: Date.now() - start });
      return json(result);
    } catch (err) {
      return error(err.message, 500);
    }
  }

  if (pathname.startsWith('/api/storage/kv/') && method === 'GET') {
    const key = decodeURIComponent(pathname.replace('/api/storage/kv/', ''));
    const record = await env.DB.prepare(
      `SELECT * FROM files_index WHERE user_id = ? AND kv_key = ? AND data_type = 'kv'`
    ).bind(user.id, key).first();
    if (!record) return error('Key not found', 404);

    const account = await env.DB.prepare('SELECT * FROM accounts WHERE id = ?').bind(record.account_id).first();
    const result = await kvGet(account, env, record.drive_file_id, record.expires_at);
    if (result.expired) return error('Key expired', 410);
    return json({ key, ...result });
  }

  if (pathname.startsWith('/api/storage/kv/') && method === 'DELETE') {
    const key = decodeURIComponent(pathname.replace('/api/storage/kv/', ''));
    const record = await env.DB.prepare(
      `SELECT * FROM files_index WHERE user_id = ? AND kv_key = ? AND data_type = 'kv'`
    ).bind(user.id, key).first();
    if (!record) return error('Key not found', 404);
    const account = await env.DB.prepare('SELECT * FROM accounts WHERE id = ?').bind(record.account_id).first();
    await deleteFile(account, env, record.drive_file_id);
    await env.DB.prepare('DELETE FROM files_index WHERE id = ?').bind(record.id).run();
    return json({ ok: true, key });
  }

  // ── API CACHE ───────────────────────────────────────────────────────────────
  if (pathname === '/api/storage/cache' && method === 'POST') {
    const body = await request.json();
    if (!body.key) return error('key is required');
    const { pool, account } = await pm.route(user.id, { dataType: 'cache', appId, explicitPoolId: poolId });
    const result = await cacheSet(account, env, env.DB, {
      userId: user.id, poolId: pool.id, appId,
      cacheKey: body.key, response: body.response, ttlSeconds: body.ttl,
    });
    return json(result);
  }

  if (pathname.startsWith('/api/storage/cache/') && method === 'GET') {
    const cacheKey = decodeURIComponent(pathname.replace('/api/storage/cache/', ''));
    const record = await env.DB.prepare(
      `SELECT * FROM files_index WHERE user_id = ? AND kv_key = ? AND data_type = 'cache'`
    ).bind(user.id, cacheKey).first();
    if (!record) return json({ hit: false });
    if (record.expires_at && record.expires_at < Date.now()) return json({ hit: false, expired: true });

    const account = await env.DB.prepare('SELECT * FROM accounts WHERE id = ?').bind(record.account_id).first();
    const res = await (await retrieveFile(account, env, record.drive_file_id)).json();
    return json({ hit: true, response: res.response, cached_at: res.cached_at });
  }

  // ── SQL ─────────────────────────────────────────────────────────────────────
  if (pathname === '/api/storage/sql' && method === 'POST') {
    const start = Date.now();
    try {
      const body = await request.json();
      if (!body.db || !body.sql) return error('db and sql are required');

      const { pool, account } = await pm.route(user.id, { dataType: 'sql', appId, explicitPoolId: poolId });
      const result = await sqlQuery(account, env, env.DB, {
        userId: user.id, poolId: pool.id, appId,
        dbName: body.db, sql: body.sql, params: body.params,
      });

      await logAudit(env, { userId: user.id, poolId: pool.id, accountId: account.id, action: 'sql.query', status: 'ok', latencyMs: Date.now() - start });
      return json(result);
    } catch (err) {
      return error(err.message, 500);
    }
  }

  // ── FOLDERS ─────────────────────────────────────────────────────────────────
  if (pathname === '/api/storage/folders' && method === 'POST') {
    const body = await request.json();
    if (!body.path) return error('path is required');
    const { pool, account } = await pm.route(user.id, { appId, explicitPoolId: poolId });
    const result = await createAppFolder(account, env, env.DB, {
      userId: user.id, poolId: pool.id, appId, folderPath: body.path,
    });
    return json(result, 201);
  }

  return error('Not found', 404);
}
