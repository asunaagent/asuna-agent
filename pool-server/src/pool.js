'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const Database = require('./db');
const PRLRpc = require('./rpc');
const StratumServer = require('./stratum');

class Pool {
  constructor() {
    this.db = new Database(config.db.path);
    this.rpc = new PRLRpc(config);
    this.stratum = new StratumServer(config);
    this.networkInfo = { height: 0, difficulty: 0, hashrate: 0, syncing: true };
    this.poolStats = {
      uptime: Date.now(), totalHashrate: 0, blocksFound: 0,
      sharesTotal: 0, sharesAccepted: 0, sharesRejected: 0,
      shareDuplicateReject: 0, shareLowDiffReject: 0,
      // per-port tracking
      sharesByPort: { easy: 0, medium: 0, hard: 0 },
    };
    this.lastBlockHash = null;
    this.currentJobId = 0;
    this.lastJobHash = '';
    this.dashboardHtml = null;
    this.recentShares = new Map();
    this.shareCleanupInterval = setInterval(() => {
      const cutoff = Date.now() - 60000;
      for (const [h, t] of this.recentShares) {
        if (t < cutoff) this.recentShares.delete(h);
      }
    }, 30000);
  }

  async start() {
    console.log('\n=== PRL Mining Pool v2.2.0 ===');
    console.log('=== 3-Port Stratum: Easy/Medium/Hard ===');
    console.log('=== Vardiff + Share-Validation + Rate-Limit ===\n');
    try {
      const info = await this.rpc.getBlockchainInfo();
      this.networkInfo.height = info.blocks;
      this.networkInfo.difficulty = info.difficulty;
      this.networkInfo.syncing = false;
      console.log('[Pool] Connected - Chain: ' + info.chain + ', Height: ' + info.blocks);
    } catch (e) {
      console.error('[Pool] RPC warning: ' + e.message);
    }

    this.stratum.start();
    this._setupHandlers();
    this._startApi();
    this._startScanner();
    this._startJobPoller();
    this._startHashrateUpdater();

    // DB integrity check every 5 min
    setInterval(() => {
      const issues = this.db.integrityCheck();
      if (issues > 0) console.log('[Pool] DB integrity fixed: ' + issues + ' issues');
    }, 300000);

    const ports = config.stratum.ports;
    console.log('\n[Pool] Stratum ports:');
    console.log(`  Easy   :${ports.easy.port}  (diff ${ports.easy.difficulty})  — CPU / low hashrate`);
    console.log(`  Medium :${ports.medium.port} (diff ${ports.medium.difficulty}) — mid GPU`);
    console.log(`  Hard   :${ports.hard.port}  (diff ${ports.hard.difficulty}) — high-end / MI300X`);
    console.log('[Pool] Dashboard: http://0.0.0.0:' + config.api.port);
    console.log('[Pool] Wallet: ' + config.pool.wallet.substring(0, 20) + '...');
    console.log('[Pool] Fee: ' + (config.pool.fee * 100) + '%\n');
  }

  _setupHandlers() {
    this.stratum.on('authorize', (client) => {
      this.db.getMiner(client.address);
      this.db.updateMiner(client.address, {
        connected_at: Date.now(),
        worker_name: client.worker || 'default',
        port: client.port,
        port_name: client.portName,
      });
      console.log('[Pool] Miner joined: ' + client.address.substring(0, 20) + ' on :${client.port} (' + client.portName + ')');
      this._fetchAndBroadcast(true);
      setTimeout(() => this._sendJobToClient(client), 500);
    });

    this.stratum.on('share', (share, cb) => {
      this.poolStats.sharesTotal++;
      if (share.portName && this.poolStats.sharesByPort[share.portName] !== undefined) {
        this.poolStats.sharesByPort[share.portName]++;
      }
      this._validateShare(share, cb);
    });

    this.stratum.on('disconnect', (client) => {
      if (client.address) console.log('[Pool] Miner left: ' + client.address.substring(0, 20) + ' from :${client.port}');
    });
  }

  _validateShare(share, cb) {
    const { address, worker, jobId, extranonce2, ntime, nonce, difficulty, portName } = share;

    if (!address || !jobId || !ntime || !nonce) {
      this.poolStats.sharesRejected++;
      this.poolStats.shareLowDiffReject++;
      console.log('[Share] REJECT missing fields from ' + address.substring(0, 16) + ' (:${portName || "?"})');
      cb(false, 'Invalid share data');
      return;
    }

    const job = this.stratum.currentJob;
    if (!job || job.jobId !== jobId) {
      this.poolStats.sharesRejected++;
      console.log('[Share] REJECT stale job ' + jobId + ' from ' + address.substring(0, 16));
      cb(false, 'Stale job');
      return;
    }

    const shareHash = crypto.createHash('sha256')
      .update(address + ':' + jobId + ':' + (extranonce2 || '') + ':' + ntime + ':' + nonce)
      .digest('hex');
    if (this.recentShares.has(shareHash)) {
      this.poolStats.sharesRejected++;
      this.poolStats.shareDuplicateReject++;
      console.log('[Share] REJECT duplicate from ' + address.substring(0, 16));
      cb(false, 'Duplicate share');
      return;
    }
    this.recentShares.set(shareHash, Date.now());

    const now = Math.floor(Date.now() / 1000);
    const shareTime = parseInt(ntime, 16);
    if (isNaN(shareTime) || shareTime < now - 600 || shareTime > now + 60) {
      this.poolStats.sharesRejected++;
      console.log('[Share] REJECT bad ntime from ' + address.substring(0, 16));
      cb(false, 'Invalid ntime');
      return;
    }

    if (!/^[0-9a-fA-F]+$/.test(nonce) || nonce.length < 1 || nonce.length > 16) {
      this.poolStats.sharesRejected++;
      console.log('[Share] REJECT bad nonce from ' + address.substring(0, 16));
      cb(false, 'Invalid nonce');
      return;
    }

    const minDiff = this.networkInfo.difficulty * 0.0001;  // 0.01% of network diff
    if (difficulty < minDiff) {
      this.poolStats.sharesRejected++;
      this.poolStats.shareLowDiffReject++;
      console.log('[Share] REJECT low diff ' + difficulty + ' < ' + minDiff.toFixed(2));
      cb(false, 'Difficulty too low');
      return;
    }

    this.poolStats.sharesAccepted++;
    this.db.addShare(address, difficulty || 64, 1);
    const m = this.db.getMiner(address);
    this.db.updateMiner(address, {
      shares_total: m.shares_total + 1,
      shares_accepted: m.shares_accepted + 1,
      last_share_time: Date.now(),
      difficulty: difficulty,
      port: portName || m.port || 'unknown',
    });
    console.log('[Share] ACCEPT ' + address.substring(0, 16) + '... diff=' + (difficulty || 64) + ' port=' + (portName || '?'));
    cb(true);
  }

  _sendJobToClient(client) {
    const job = this.stratum.currentJob;
    if (!job || !client.socket || client.socket.destroyed) return;
    try {
      const msg = JSON.stringify({
        id: null,
        method: 'mining.notify',
        params: [job.jobId, job.prevHash, job.coinb1, job.coinb2,
                 job.merkleBranches, job.version, job.nBits, job.nTime, true],
      });
      client.socket.write(msg + '\n');
      console.log('[Job] Sent to ' + client.address.substring(0, 16) + ' on :${client.port}');
    } catch (e) {}
  }

  async _fetchAndBroadcast(force) {
    try {
      const tmpl = await this.rpc.getBlockTemplate({ rules: [] });
      if (!tmpl || !tmpl.previousblockhash) return;
      if (!force && tmpl.previousblockhash === this.lastJobHash) return;
      this.lastJobHash = tmpl.previousblockhash;
      this.currentJobId++;

      const coinb1 = tmpl.coinbasetxn ? (tmpl.coinbasetxn.data || '') : '';
      const jobObj = {
        jobId: String(this.currentJobId),
        prevHash: tmpl.previousblockhash,
        coinb1: coinb1,
        coinb2: '',
        merkleBranches: tmpl.merklebranch || [],
        version: (tmpl.version || 2).toString(16).padStart(8, '0'),
        nBits: tmpl.bits || '1a022929',
        nTime: Math.floor(Date.now() / 1000).toString(16),
        msg: null,  // will be set by broadcastJob
      };

      this.networkInfo.height = tmpl.height || this.networkInfo.height;
      this.stratum.broadcastJob(jobObj);
      console.log('[Job] Block #' + (tmpl.height || '?') + ' job=' + jobObj.jobId);
    } catch (e) {
      if (e.message && !e.message.includes('downloading') && !e.message.includes('sync')) {
        console.error('[Job] ' + e.message);
      }
    }
  }

  async _startScanner() {
    setInterval(async () => {
      try {
        const info = await this.rpc.getBlockchainInfo();
        const wasSyncing = this.networkInfo.syncing;
        this.networkInfo.height = info.blocks;
        this.networkInfo.difficulty = info.difficulty;
        this.networkInfo.syncing = false;
        if (wasSyncing) console.log('[Sync] Complete at height ' + info.blocks);

        const hash = await this.rpc.getBestBlockHash();
        if (hash && hash !== this.lastBlockHash) {
          this.lastBlockHash = hash;
          console.log('[Scanner] Block #' + info.blocks);
          this.lastJobHash = '';
          this._fetchAndBroadcast(true);
        }

        try {
          const nh = await this.rpc.getNetworkHashps();
          if (nh) this.networkInfo.hashrate = nh;
        } catch(e) {}
      } catch (e) {}
    }, 15000);
  }

  async _startJobPoller() {
    await this._fetchAndBroadcast(true);
    setInterval(() => this._fetchAndBroadcast(false), 3000);
  }

  _startHashrateUpdater() {
    setInterval(() => {
      const miners = this.db.getAllMiners();
      let total = 0;
      const now = Date.now();
      for (const m of miners) {
        const elapsed = Math.max((now - (m.connected_at || now)) / 1000, 1);
        const recentShares = m.shares_accepted || 0;
        const windowSec = Math.min(elapsed, 600);
        const hr = (recentShares * (m.difficulty || 64) * 65536) / (windowSec * 1000000);  // MH/s
        this.db.updateMiner(m.address, { hashrate: Math.round(hr * 100) / 100 });
        total += hr;
      }
      this.poolStats.totalHashrate = Math.round(total * 100) / 100;
    }, 30000);
  }

  _startApi() {
    const server = http.createServer((req, res) => {
      const parsed = require('url').parse(req.url, true);
      const p = parsed.pathname;
      res.setHeader('Access-Control-Allow-Origin', '*');

      if (p === '/api/stats') {
        const portStats = this.stratum.getPortStats();
        this._json(res, {
          pool: {
            name: 'PRL Mining Pool', version: '2.2.0',
            uptime: Date.now() - this.poolStats.uptime,
            hashrate: this.poolStats.totalHashrate,
            miners: this.stratum.getClientCount(),
            blocksFound: this.db.getPoolStats().totalBlocks,
            fee: (config.pool.fee * 100).toFixed(1) + '%',
            shares: {
              accepted: this.poolStats.sharesAccepted,
              rejected: this.poolStats.sharesRejected,
              duplicate: this.poolStats.shareDuplicateReject,
              lowDiff: this.poolStats.shareLowDiffReject,
              byPort: this.poolStats.sharesByPort,
            },
            stratum: {
              easy: { port: config.stratum.ports.easy.port, difficulty: config.stratum.ports.easy.difficulty, connections: portStats.easy?.conn || 0, shares: portStats.easy?.shares || 0 },
              medium: { port: config.stratum.ports.medium.port, difficulty: config.stratum.ports.medium.difficulty, connections: portStats.medium?.conn || 0, shares: portStats.medium?.shares || 0 },
              hard: { port: config.stratum.ports.hard.port, difficulty: config.stratum.ports.hard.difficulty, connections: portStats.hard?.conn || 0, shares: portStats.hard?.shares || 0 },
            },
          },
          network: this.networkInfo,
        });
      } else if (p === '/api/miners') {
        this._json(res, this.db.getAllMiners());
      } else if (p && p.startsWith('/api/miner/')) {
        this._json(res, this.db.getMiner(decodeURIComponent(p.slice(11))));
      } else if (p === '/api/blocks') {
        this._json(res, this.db.getBlocks());
      } else if (p === '/api/payouts') {
        this._json(res, this.db.getPayouts());
      } else if (p === '/api/connections') {
        this._json(res, this.stratum.getAllClients());
      } else if (p === '/api/ports') {
        this._json(res, {
          easy: { port: config.stratum.ports.easy.port, difficulty: config.stratum.ports.easy.difficulty, label: 'CPU / low hashrate' },
          medium: { port: config.stratum.ports.medium.port, difficulty: config.stratum.ports.medium.difficulty, label: 'Mid GPU' },
          hard: { port: config.stratum.ports.hard.port, difficulty: config.stratum.ports.hard.difficulty, label: 'High-end / MI300X' },
        });
      } else if (p === '/api/vardiff') {
        this._json(res, {
          min: config.vardiff.minDifficulty,
          max: config.vardiff.maxDifficulty,
          target: config.vardiff.targetShareTime,
          interval: config.vardiff.retargetInterval,
        });
      } else if (p === '/' || p === '/index.html') {
        this._serveDashboard(res);
      } else {
        res.writeHead(404); res.end('Not found');
      }
    });
    server.listen(config.api.port, config.api.host, () => {
      console.log('[API] Dashboard on port ' + config.api.port);
    });
  }

  _json(res, data) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data, null, 2));
  }
  _serveDashboard(res) {
    try {
      if (!this.dashboardHtml) this.dashboardHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(this.dashboardHtml);
    } catch (e) { res.writeHead(500); res.end('Dashboard not found'); }
  }
}

const pool = new Pool();
pool.start().catch(e => { console.error('[Pool] Fatal:', e); process.exit(1); });
process.on('SIGINT', () => { pool.stratum.stop(); process.exit(0); });
process.on('SIGTERM', () => { pool.stratum.stop(); process.exit(0); });
