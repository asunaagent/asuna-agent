'use strict';

const fs = require('fs');
const path = require('path');

class Database {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.tmpPath = dbPath + '.tmp';
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    this._dirty = false;
    this._load();
    // FIX: flush every 15 seconds instead of 10 (less I/O)
    setInterval(() => this._flush(), 15000);
    process.on('SIGTERM', () => this._flush());
    process.on('SIGINT', () => this._flush());
    process.on('exit', () => this._flush());
  }

  _load() {
    const p = this.dbPath + '.json';
    if (fs.existsSync(p)) {
      try {
        this._data = JSON.parse(fs.readFileSync(p, 'utf8'));
        console.log('[DB] Loaded from disk: ' + Object.keys(this._data.miners || {}).length + ' miners');
      } catch(e) {
        // FIX: try backup file if main is corrupted
        const bak = p + '.bak';
        if (fs.existsSync(bak)) {
          try {
            this._data = JSON.parse(fs.readFileSync(bak, 'utf8'));
            console.log('[DB] WARNING: recovered from backup');
          } catch(e2) {
            this._data = this._default();
            console.log('[DB] CRITICAL: backup also corrupted, starting fresh');
          }
        } else {
          this._data = this._default();
          console.log('[DB] CRITICAL: corrupted, starting fresh');
        }
      }
    } else {
      this._data = this._default();
    }
    // Ensure all fields
    if (!this._data.miners) this._data.miners = {};
    if (!this._data.blocks) this._data.blocks = [];
    if (!this._data.payouts) this._data.payouts = [];
    if (!this._data.shares) this._data.shares = [];
    if (!this._data.stats) this._data.stats = { totalBlocks: 0, totalShares: 0 };
    if (!this._data.hashrateHistory) this._data.hashrateHistory = [];
    if (!this._data.blockHistory) this._data.blockHistory = [];
  }

  _default() {
    return { miners: {}, blocks: [], payouts: [], shares: [], stats: { totalBlocks: 0, totalShares: 0 }, hashrateHistory: [], blockHistory: [] };
  }

  _flush() {
    if (!this._dirty) return;
    try {
      const tmp = this.dbPath + '.tmp';
      const bak = this.dbPath + '.json.bak';
      // FIX: atomic write — write to tmp, then rename
      fs.writeFileSync(tmp, JSON.stringify(this._data, null, 0));
      // Backup current
      if (fs.existsSync(this.dbPath + '.json')) {
        try { fs.copyFileSync(this.dbPath + '.json', bak); } catch(e) {}
      }
      // Atomic rename
      fs.renameSync(tmp, this.dbPath + '.json');
      this._dirty = false;
    } catch (e) {
      console.error('[DB] Write error:', e.message);
    }
  }

  _save() { this._dirty = true; }

  getMiner(address) {
    if (!this._data.miners[address]) {
      this._data.miners[address] = {
        address,
        shares_total: 0,
        shares_accepted: 0,
        shares_rejected: 0,
        hashrate: 0,
        difficulty: 64,
        pending_balance: 0,
        paid_balance: 0,
        last_share_time: 0,
        connected_at: Date.now(),
        worker_name: '',
      };
      this._save();
    }
    return this._data.miners[address];
  }

  updateMiner(address, fields) {
    const m = this.getMiner(address);
    Object.assign(m, fields);
    this._data.miners[address] = m;
    this._save();
  }

  getAllMiners() { return Object.values(this._data.miners); }

  addShare(address, difficulty, valid) {
    this._data.shares.push({ address, difficulty, timestamp: Date.now(), valid });
    if (this._data.shares.length > 50000) this._data.shares = this._data.shares.slice(-25000);
    this._data.stats.totalShares++;
    this._save();
  }

  getPPLNSWindow(windowSize) {
    return this._data.shares.slice(-windowSize);
  }

  addBlock(height, hash, reward, difficulty, finder, status) {
    this._data.blocks.push({
      height, hash, timestamp: Date.now(), reward: reward || 0,
      difficulty: difficulty || 0, finder: finder || '', status: status || 'pending',
    });
    this._data.stats.totalBlocks++;
    this._save();
  }

  updateBlockStatus(height, status) {
    const block = this._data.blocks.find(b => b.height === height);
    if (block) { block.status = status; this._save(); }
  }

  getBlocks() { return this._data.blocks.slice(-100).reverse(); }

  addPayout(address, amount, txHash) {
    this._data.payouts.push({ address, amount, tx_hash: txHash, timestamp: Date.now() });
    this._save();
  }

  getPayouts() { return this._data.payouts.slice(-100).reverse(); }

  addHashratePoint(poolHashrate, networkHashrate, difficulty) {
    this._data.hashrateHistory.push({ timestamp: Date.now(), pool: poolHashrate, network: networkHashrate, difficulty });
    if (this._data.hashrateHistory.length > 500) this._data.hashrateHistory = this._data.hashrateHistory.slice(-250);
    this._save();
  }

  getHashrateHistory() { return this._data.hashrateHistory; }

  addBlockHistory(poolBlocks, networkBlocks) {
    this._data.blockHistory.push({ timestamp: Date.now(), pool: poolBlocks, network: networkBlocks });
    if (this._data.blockHistory.length > 500) this._data.blockHistory = this._data.blockHistory.slice(-250);
    this._save();
  }

  getBlockHistory() { return this._data.blockHistory; }

  getPoolStats() {
    const miners = Object.values(this._data.miners);
    return {
      miners: miners.length,
      totalShares: this._data.stats.totalShares,
      totalBlocks: this._data.stats.totalBlocks,
      totalHashrate: miners.reduce((s, m) => s + (m.hashrate || 0), 0),
    };
  }

  // FIX: periodic data integrity check
  integrityCheck() {
    let issues = 0;
    const miners = this._data.miners;
    for (const [addr, m] of Object.entries(miners)) {
      if (m.shares_accepted > m.shares_total) {
        console.log('[DB] Integrity: ' + addr.substring(0, 16) + ' accepted > total, fixing');
        m.shares_accepted = m.shares_total;
        issues++;
      }
      if (!m.address) {
        console.log('[DB] Integrity: removing empty miner record');
        delete miners[addr];
        issues++;
      }
    }
    if (this._data.shares.length > 50000) {
      this._data.shares = this._data.shares.slice(-25000);
      issues++;
    }
    return issues;
  }
}

module.exports = Database;
