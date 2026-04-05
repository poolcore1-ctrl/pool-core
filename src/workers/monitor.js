// src/workers/monitor.js

import { requireAuth, json, error } from '../lib/auth-middleware.js';
import { PoolManager } from '../lib/pool-manager.js';
import { getStorageQuota } from '../lib/drive-client.js';

export async function handleMonitor(request, env, pathname) {
  const auth = await requireAuth(request, env);
  if (auth.error) return error(auth.error, auth.status);
  const { user } = auth;
  const pm = new PoolManager(env);

  // GET /api/monitor/dashboard — full system overview
  if (pathname === '/api/monitor/dashboard') {
    const { results: pools } = await env.DB.prepare(
      'SELECT * FROM pools WHERE user_id = ?'
    ).bind(user.id).all();

    const { results: accounts } = await env.DB.prepare(
      'SELECT id, pool_id, email, active, storage_limit_bytes, daily_upload_limit_bytes FROM accounts WHERE user_id = ?'
    ).bind(user.id).all();

    // Get live stats from Durable Objects for each account
    const accountStats = await Promise.all((accounts || []).map(async acc => {
      try {
        const stats = await pm.getAccountStats(acc.id);
        return { ...acc, ...stats };
      } catch {
        return { ...acc, healthy: false, error: true };
      }
    }));

    // Get file counts and sizes
    const { results: storageStats } = await env.DB.prepare(
      `SELECT pool_id, data_type, COUNT(*) as count, SUM(size_bytes) as total_bytes
       FROM files_index WHERE user_id = ?
       GROUP BY pool_id, data_type`
    ).bind(user.id).all();

    // Audit summary
    const oneDayAgo = Date.now() - 86400000;
    const oneHourAgo = Date.now() - 3600000;

    const { results: auditSummary } = await env.DB.prepare(
      `SELECT status, COUNT(*) as count, SUM(bytes) as total_bytes
       FROM audit_log WHERE user_id = ? AND created_at > ?
       GROUP BY status`
    ).bind(user.id, oneDayAgo).all();

    const { results: recentErrors } = await env.DB.prepare(
      `SELECT action, error_message, created_at FROM audit_log
       WHERE user_id = ? AND status = 'error' AND created_at > ?
       ORDER BY created_at DESC LIMIT 10`
    ).bind(user.id, oneHourAgo).all();

    const poolsEnriched = (pools || []).map(pool => {
      const poolAccounts = accountStats.filter(a => a.pool_id === pool.id);
      const poolStorage = (storageStats || []).filter(s => s.pool_id === pool.id);
      return {
        ...pool,
        routing_rules: JSON.parse(pool.routing_rules || '[]'),
        accounts: poolAccounts,
        storage_by_type: poolStorage,
        total_files: poolStorage.reduce((sum, s) => sum + s.count, 0),
        total_bytes: poolStorage.reduce((sum, s) => sum + (s.total_bytes || 0), 0),
        healthy_accounts: poolAccounts.filter(a => a.healthy).length,
      };
    });

    const totalBytes = (storageStats || []).reduce((sum, s) => sum + (s.total_bytes || 0), 0);
    const totalCapacity = (accounts || []).reduce((sum, a) => sum + a.storage_limit_bytes, 0);

    return json({
      user: { id: user.id, email: user.email, plan: user.plan },
      summary: {
        total_pools: pools?.length || 0,
        total_accounts: accounts?.length || 0,
        total_storage_used_bytes: totalBytes,
        total_storage_capacity_bytes: totalCapacity,
        storage_pct: totalCapacity > 0 ? Math.round((totalBytes / totalCapacity) * 100) : 0,
      },
      pools: poolsEnriched,
      audit: {
        last_24h: auditSummary || [],
        recent_errors: recentErrors || [],
      },
    });
  }

  // GET /api/monitor/accounts — per-account live stats
  if (pathname === '/api/monitor/accounts') {
    const { results: accounts } = await env.DB.prepare(
      'SELECT * FROM accounts WHERE user_id = ?'
    ).bind(user.id).all();

    const enriched = await Promise.all((accounts || []).map(async acc => {
      const stats = await pm.getAccountStats(acc.id).catch(() => ({}));

      // Optionally fetch real quota from Drive (slower, use sparingly)
      const url = new URL(request.url);
      const live = url.searchParams.get('live') === 'true';
      let driveQuota = null;
      if (live) {
        try {
          driveQuota = await getStorageQuota(acc, env);
        } catch { /* ignore */ }
      }

      return {
        id: acc.id,
        pool_id: acc.pool_id,
        email: acc.email,
        active: acc.active,
        storage_limit_bytes: acc.storage_limit_bytes,
        daily_upload_limit_bytes: acc.daily_upload_limit_bytes,
        live_stats: stats,
        drive_quota: driveQuota,
      };
    }));

    return json({ accounts: enriched });
  }

  // GET /api/monitor/audit — paginated audit log
  if (pathname === '/api/monitor/audit') {
    const url = new URL(request.url);
    const limit = parseInt(url.searchParams.get('limit') || '50');
    const offset = parseInt(url.searchParams.get('offset') || '0');
    const status = url.searchParams.get('status');
    const action = url.searchParams.get('action');

    let query = 'SELECT * FROM audit_log WHERE user_id = ?';
    const binds = [user.id];
    if (status) { query += ' AND status = ?'; binds.push(status); }
    if (action) { query += ' AND action LIKE ?'; binds.push(`${action}%`); }
    query += ` ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`;

    const { results } = await env.DB.prepare(query).bind(...binds).all();
    return json({ logs: results || [], limit, offset });
  }

  // GET /api/monitor/storage — storage breakdown by type
  if (pathname === '/api/monitor/storage') {
    const { results } = await env.DB.prepare(
      `SELECT data_type, COUNT(*) as count, SUM(size_bytes) as total_bytes, pool_id
       FROM files_index WHERE user_id = ?
       GROUP BY data_type, pool_id ORDER BY total_bytes DESC`
    ).bind(user.id).all();

    return json({ breakdown: results || [] });
  }

  return error('Not found', 404);
}
