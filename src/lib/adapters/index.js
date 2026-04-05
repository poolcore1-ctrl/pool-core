// src/lib/adapters/index.js
// All storage type adapters

import { uploadFile, downloadFile, deleteFile, updateFile, getOrCreateFolder } from '../drive-client.js';
import { generateId } from '../crypto.js';

// ─── FILE ADAPTER ────────────────────────────────────────────────────────────

export async function storeFile(account, env, db, { userId, poolId, appId, filename, mimeType, content, sizeBytes }) {
  const folderId = await ensureAppFolder(account, env, userId, appId, 'files');
  const driveFile = await uploadFile(account, env, {
    name: filename,
    mimeType: mimeType || 'application/octet-stream',
    content,
    parentFolderId: folderId,
  });

  const fileId = generateId();
  await db.prepare(
    `INSERT INTO files_index (id, user_id, pool_id, account_id, drive_file_id, data_type, app_id, filename, mime_type, size_bytes, created_at)
     VALUES (?, ?, ?, ?, ?, 'file', ?, ?, ?, ?, ?)`
  ).bind(fileId, userId, poolId, account.id, driveFile.id, appId, filename, mimeType, sizeBytes || 0, Date.now()).run();

  return { id: fileId, filename, size_bytes: sizeBytes };
}

export async function retrieveFile(account, env, driveFileId) {
  return downloadFile(account, env, driveFileId);
}

// ─── JSON ADAPTER ─────────────────────────────────────────────────────────────

export async function storeJson(account, env, db, { userId, poolId, appId, collection, docId, data }) {
  const folderId = await ensureAppFolder(account, env, userId, appId, `json/${collection}`);
  const id = docId || generateId();
  const content = JSON.stringify({ _id: id, ...data, _updated_at: Date.now() });

  // Check if doc exists
  const existing = await db.prepare(
    'SELECT drive_file_id FROM files_index WHERE user_id = ? AND collection = ? AND id = ?'
  ).bind(userId, collection, id).first();

  let driveFileId;
  if (existing) {
    await updateFile(account, env, existing.drive_file_id, content, 'application/json');
    driveFileId = existing.drive_file_id;
  } else {
    const driveFile = await uploadFile(account, env, {
      name: `${id}.json`,
      mimeType: 'application/json',
      content,
      parentFolderId: folderId,
    });
    driveFileId = driveFile.id;

    await db.prepare(
      `INSERT INTO files_index (id, user_id, pool_id, account_id, drive_file_id, data_type, app_id, collection, size_bytes, created_at)
       VALUES (?, ?, ?, ?, ?, 'json', ?, ?, ?, ?)`
    ).bind(id, userId, poolId, account.id, driveFileId, appId, collection, content.length, Date.now()).run();
  }

  return { id, collection };
}

export async function retrieveJson(account, env, driveFileId) {
  const res = await downloadFile(account, env, driveFileId);
  return res.json();
}

export async function listJsonCollection(db, { userId, collection, limit = 50, offset = 0 }) {
  const { results } = await db.prepare(
    'SELECT id, account_id, drive_file_id, created_at FROM files_index WHERE user_id = ? AND collection = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'
  ).bind(userId, collection, limit, offset).all();
  return results || [];
}

// ─── KEY-VALUE ADAPTER ────────────────────────────────────────────────────────

export async function kvSet(account, env, db, { userId, poolId, appId, key, value, ttlSeconds }) {
  const folderId = await ensureAppFolder(account, env, userId, appId, 'kv');
  const expiresAt = ttlSeconds ? Date.now() + ttlSeconds * 1000 : null;
  const content = JSON.stringify({ key, value, expires_at: expiresAt });

  const existing = await db.prepare(
    'SELECT id, drive_file_id FROM files_index WHERE user_id = ? AND kv_key = ? AND data_type = ?'
  ).bind(userId, key, 'kv').first();

  if (existing) {
    await updateFile(account, env, existing.drive_file_id, content, 'application/json');
    if (expiresAt !== null) {
      await db.prepare('UPDATE files_index SET expires_at = ? WHERE id = ?').bind(expiresAt, existing.id).run();
    }
    return { key, updated: true };
  }

  const driveFile = await uploadFile(account, env, {
    name: `kv_${key.replace(/[^a-zA-Z0-9]/g, '_')}.json`,
    mimeType: 'application/json',
    content,
    parentFolderId: folderId,
  });

  const id = generateId();
  await db.prepare(
    `INSERT INTO files_index (id, user_id, pool_id, account_id, drive_file_id, data_type, app_id, kv_key, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, 'kv', ?, ?, ?, ?)`
  ).bind(id, userId, poolId, account.id, driveFile.id, appId, key, expiresAt, Date.now()).run();

  return { key, created: true };
}

export async function kvGet(account, env, driveFileId, expiresAt) {
  if (expiresAt && expiresAt < Date.now()) return { expired: true };
  const res = await downloadFile(account, env, driveFileId);
  const data = await res.json();
  return { value: data.value, expires_at: data.expires_at };
}

// ─── API CACHE ADAPTER ────────────────────────────────────────────────────────

export async function cacheSet(account, env, db, { userId, poolId, appId, cacheKey, response, ttlSeconds }) {
  const folderId = await ensureAppFolder(account, env, userId, appId, 'cache');
  const expiresAt = Date.now() + (ttlSeconds || 3600) * 1000;
  const content = JSON.stringify({ key: cacheKey, response, cached_at: Date.now(), expires_at: expiresAt });

  const existing = await db.prepare(
    `SELECT id, drive_file_id FROM files_index WHERE user_id = ? AND kv_key = ? AND data_type = 'cache'`
  ).bind(userId, cacheKey).first();

  if (existing) {
    await updateFile(account, env, existing.drive_file_id, content, 'application/json');
    await db.prepare('UPDATE files_index SET expires_at = ? WHERE id = ?').bind(expiresAt, existing.id).run();
    return { key: cacheKey, updated: true };
  }

  const driveFile = await uploadFile(account, env, {
    name: `cache_${cacheKey.replace(/[^a-zA-Z0-9]/g, '_')}.json`,
    mimeType: 'application/json',
    content,
    parentFolderId: folderId,
  });

  const id = generateId();
  await db.prepare(
    `INSERT INTO files_index (id, user_id, pool_id, account_id, drive_file_id, data_type, app_id, kv_key, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, 'cache', ?, ?, ?, ?)`
  ).bind(id, userId, poolId, account.id, driveFile.id, appId, cacheKey, expiresAt, Date.now()).run();

  return { key: cacheKey, created: true };
}

// ─── SQL ADAPTER ──────────────────────────────────────────────────────────────
// Stores SQLite .db files on Drive. Downloads, queries, re-uploads if mutated.
// Best for small-to-medium structured datasets per app.

export async function sqlQuery(account, env, db, { userId, poolId, appId, dbName, sql, params }) {
  // This requires the @cloudflare/workers-wasm-sqlite package or similar
  // For simplicity, we store as JSON tables (array of row objects)
  const folderId = await ensureAppFolder(account, env, userId, appId, 'sql');
  const safeDbName = dbName.replace(/[^a-zA-Z0-9_]/g, '_');

  const existing = await db.prepare(
    `SELECT id, drive_file_id FROM files_index WHERE user_id = ? AND collection = ? AND data_type = 'sql'`
  ).bind(userId, safeDbName).first();

  let tableData = {};
  if (existing) {
    const res = await downloadFile(account, env, existing.drive_file_id);
    tableData = await res.json();
  }

  const result = executeSqlOnJson(tableData, sql, params || []);

  if (result.mutated) {
    const content = JSON.stringify(tableData);
    if (existing) {
      await updateFile(account, env, existing.drive_file_id, content, 'application/json');
    } else {
      const driveFile = await uploadFile(account, env, {
        name: `${safeDbName}.db.json`,
        mimeType: 'application/json',
        content,
        parentFolderId: folderId,
      });
      const id = generateId();
      await db.prepare(
        `INSERT INTO files_index (id, user_id, pool_id, account_id, drive_file_id, data_type, app_id, collection, created_at)
         VALUES (?, ?, ?, ?, ?, 'sql', ?, ?, ?)`
      ).bind(id, userId, poolId, account.id, driveFile.id, appId, safeDbName, Date.now()).run();
    }
  }

  return result;
}

function executeSqlOnJson(data, sql, params) {
  const normalized = sql.trim().toUpperCase();
  let result = { rows: [], mutated: false };

  if (normalized.startsWith('CREATE TABLE')) {
    const match = sql.match(/CREATE TABLE (?:IF NOT EXISTS )?(\w+)\s*\((.+)\)/is);
    if (match) {
      const tableName = match[1];
      if (!data[tableName]) {
        data[tableName] = { columns: match[2].split(',').map(c => c.trim().split(/\s+/)[0]), rows: [] };
        result.mutated = true;
      }
    }
  } else if (normalized.startsWith('INSERT INTO')) {
    const match = sql.match(/INSERT INTO (\w+)\s*(?:\((.+?)\))?\s*VALUES\s*\((.+)\)/is);
    if (match) {
      const tableName = match[1];
      const cols = match[2] ? match[2].split(',').map(c => c.trim()) : (data[tableName]?.columns || []);
      const vals = params.length > 0 ? params : match[3].split(',').map(v => v.trim().replace(/^['"]|['"]$/g, ''));
      if (!data[tableName]) data[tableName] = { columns: cols, rows: [] };
      const row = {};
      cols.forEach((col, i) => { row[col] = vals[i]; });
      row._id = generateId();
      data[tableName].rows.push(row);
      result.mutated = true;
      result.rows = [row];
    }
  } else if (normalized.startsWith('SELECT')) {
    const match = sql.match(/FROM (\w+)(?:\s+WHERE (.+?))?(?:\s+LIMIT (\d+))?/is);
    if (match && data[match[1]]) {
      let rows = data[match[1]].rows;
      if (match[2]) {
        const cond = match[2].trim();
        const condMatch = cond.match(/(\w+)\s*=\s*['"]?(.+?)['"]?$/);
        if (condMatch) rows = rows.filter(r => String(r[condMatch[1]]) === String(condMatch[2]));
      }
      if (match[3]) rows = rows.slice(0, parseInt(match[3]));
      result.rows = rows;
    }
  } else if (normalized.startsWith('DELETE FROM')) {
    const match = sql.match(/DELETE FROM (\w+)(?:\s+WHERE (.+))?/is);
    if (match && data[match[1]]) {
      if (match[2]) {
        const cond = match[2].trim();
        const condMatch = cond.match(/(\w+)\s*=\s*['"]?(.+?)['"]?$/);
        if (condMatch) {
          const before = data[match[1]].rows.length;
          data[match[1]].rows = data[match[1]].rows.filter(r => String(r[condMatch[1]]) !== String(condMatch[2]));
          result.rows_affected = before - data[match[1]].rows.length;
        }
      } else {
        result.rows_affected = data[match[1]].rows.length;
        data[match[1]].rows = [];
      }
      result.mutated = true;
    }
  }

  return result;
}

// ─── FOLDER ADAPTER ───────────────────────────────────────────────────────────

export async function createAppFolder(account, env, db, { userId, poolId, appId, folderPath }) {
  const parts = ['drive-pool', userId, appId, ...folderPath.split('/').filter(Boolean)];
  let parentId = null;
  for (const part of parts) {
    const folder = await getOrCreateFolder(account, env, { name: part, parentFolderId: parentId });
    parentId = folder.id;
  }
  return { folder_id: parentId, path: folderPath };
}

// ─── HELPER ───────────────────────────────────────────────────────────────────

async function ensureAppFolder(account, env, userId, appId, subPath) {
  const parts = ['drive-pool', userId, appId, ...subPath.split('/').filter(Boolean)];
  let parentId = null;
  for (const part of parts) {
    const folder = await getOrCreateFolder(account, env, { name: part, parentFolderId: parentId });
    parentId = folder.id;
  }
  return parentId;
}
