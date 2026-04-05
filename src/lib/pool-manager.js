// src/lib/pool-manager.js
// Routes requests to the best available Drive account across pools

export class PoolManager {
  constructor(env) {
    this.env = env;
  }

  // Get Durable Object for an account
  getAccountDO(accountId) {
    const id = this.env.ACCOUNT_STATE.idFromName(accountId);
    return this.env.ACCOUNT_STATE.get(id);
  }

  // Check if an account is available and increment its counter
  async checkAccount(accountId) {
    const stub = this.getAccountDO(accountId);
    const res = await stub.fetch('https://do/check-and-increment');
    return res.json();
  }

  // Record bytes uploaded to an account
  async recordBytes(accountId, bytes) {
    const stub = this.getAccountDO(accountId);
    await stub.fetch('https://do/record-bytes', {
      method: 'POST',
      body: JSON.stringify({ bytes }),
    });
  }

  // Record a Drive API error
  async recordError(accountId) {
    const stub = this.getAccountDO(accountId);
    await stub.fetch('https://do/record-error');
  }

  // Record a successful Drive API call
  async recordSuccess(accountId) {
    const stub = this.getAccountDO(accountId);
    await stub.fetch('https://do/record-success');
  }

  // Get live stats for an account
  async getAccountStats(accountId) {
    const stub = this.getAccountDO(accountId);
    const res = await stub.fetch('https://do/get-stats');
    return res.json();
  }

  // Select the best account from a pool for a write operation
  async selectAccount(poolId, userId) {
    const accounts = await this.env.DB.prepare(
      'SELECT * FROM accounts WHERE pool_id = ? AND user_id = ? AND active = 1'
    ).bind(poolId, userId).all();

    if (!accounts.results || accounts.results.length === 0) {
      throw new Error('No active accounts in pool');
    }

    // Try each account, pick the first available one with lowest load
    const candidates = [];
    for (const account of accounts.results) {
      const check = await this.checkAccount(account.id);
      if (check.allowed) {
        candidates.push({ account, stats: check });
      }
    }

    if (candidates.length === 0) {
      throw Object.assign(new Error('All accounts are rate limited or at quota'), {
        code: 'ALL_ACCOUNTS_BUSY',
      });
    }

    // Pick candidate with fewest requests this minute
    candidates.sort((a, b) => a.stats.requests_this_minute - b.stats.requests_this_minute);
    return candidates[0].account;
  }

  // Select pool based on routing rules, then select account within that pool
  async selectPool(userId, { dataType, appId, sizeBytes, explicitPoolId }) {
    // If caller specifies a pool, use it directly
    if (explicitPoolId) {
      const pool = await this.env.DB.prepare(
        'SELECT * FROM pools WHERE id = ? AND user_id = ?'
      ).bind(explicitPoolId, userId).first();
      if (!pool) throw new Error('Pool not found');
      return pool;
    }

    // Load all user pools with routing rules
    const { results: pools } = await this.env.DB.prepare(
      'SELECT * FROM pools WHERE user_id = ? ORDER BY is_default ASC'
    ).bind(userId).all();

    if (!pools || pools.length === 0) throw new Error('No pools configured');

    // Apply routing rules
    for (const pool of pools) {
      const rules = JSON.parse(pool.routing_rules || '[]');
      for (const rule of rules) {
        if (rule.match.data_type && rule.match.data_type !== dataType) continue;
        if (rule.match.app_id && rule.match.app_id !== appId) continue;
        if (rule.match.size_bytes_lt && sizeBytes >= rule.match.size_bytes_lt) continue;
        if (rule.match.size_bytes_gte && sizeBytes < rule.match.size_bytes_gte) continue;
        return pool; // matched
      }
    }

    // Fall back to default pool
    const defaultPool = pools.find(p => p.is_default) || pools[0];
    return defaultPool;
  }

  // Full selection: pool + account, with overflow support
  async route(userId, options = {}) {
    const pool = await this.selectPool(userId, options);

    try {
      const account = await this.selectAccount(pool.id, userId);
      return { pool, account };
    } catch (err) {
      if (err.code === 'ALL_ACCOUNTS_BUSY' && pool.overflow_pool_id) {
        // Try overflow pool
        const overflowPool = await this.env.DB.prepare(
          'SELECT * FROM pools WHERE id = ? AND user_id = ?'
        ).bind(pool.overflow_pool_id, userId).first();

        if (overflowPool) {
          const account = await this.selectAccount(overflowPool.id, userId);
          return { pool: overflowPool, account, overflowed: true };
        }
      }
      throw err;
    }
  }

  // Ensure folder path exists on Drive, returns leaf folder ID
  async ensureFolderPath(account, env, pathParts) {
    const { getOrCreateFolder } = await import('./drive-client.js');
    let parentId = null;
    for (const part of pathParts) {
      const folder = await getOrCreateFolder(account, env, { name: part, parentFolderId: parentId });
      parentId = folder.id;
    }
    return parentId;
  }
}
