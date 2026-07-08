'use strict';

const net = require('net');
const crypto = require('crypto');
const { EventEmitter } = require('events');

class StratumServer extends EventEmitter {
  constructor(config) {
    super();
    this.host = config.stratum.host;
    this.port = config.stratum.port;
    this.server = null;
    this.clients = new Map();
    this.jobCounter = 0;
    this.currentJob = null;
    // FIX: rate limiting + connection limits
    this.config = config.stratum;
    this.vardiff = config.vardiff;
    this.ipCounts = new Map();
    this.bannedIPs = new Map();       // IP -> banExpiry
    this.connectionCount = 0;
  }

  start() {
    this.server = net.createServer((s) => this._onConnection(s));
    this.server.listen(this.port, this.host, () => {
      console.log('[Stratum] Listening on ' + this.host + ':' + this.port);
      console.log('[Stratum] Max connections: ' + this.config.maxConnections);
      console.log('[Stratum] Per-IP limit: ' + this.config.perIPLimit);
    });
    this.server.on('error', (e) => console.error('[Stratum] Error:', e.message));
    // FIX: periodic cleanup of stale clients
    setInterval(() => this._cleanup(), 60000);
  }

  _isIPAllowed(ip) {
    // Check banned
    const banExpiry = this.bannedIPs.get(ip);
    if (banExpiry && Date.now() < banExpiry) return false;
    if (banExpiry && Date.now() >= banExpiry) this.bannedIPs.delete(ip);
    // Check per-IP limit
    const count = this.ipCounts.get(ip) || 0;
    if (count >= this.config.perIPLimit) return false;
    // Check total
    if (this.connectionCount >= this.config.maxConnections) return false;
    return true;
  }

  _cleanup() {
    const now = Date.now();
    for (const [id, c] of this.clients) {
      // Disconnect idle clients (no share in 5 min, connected > 2 min)
      if (now - c.connectedAt > 120000 && now - c.lastShareTime > 300000) {
        try { c.socket.destroy(); } catch(e) {}
        this.clients.delete(id);
        console.log('[Stratum] Cleaned idle: ' + id);
      }
    }
    // Expire old bans
    for (const [ip, expiry] of this.bannedIPs) {
      if (now >= expiry) this.bannedIPs.delete(ip);
    }
  }

  _onConnection(socket) {
    const rawIp = socket.remoteAddress || 'unknown';
    const ip = rawIp.replace('::ffff:', '');
    const id = ip + ':' + socket.remotePort;

    // FIX: rate limit check
    if (!this._isIPAllowed(ip)) {
      console.log('[Stratum] Rejected (limit): ' + id);
      socket.destroy();
      return;
    }

    this.connectionCount++;
    this.ipCounts.set(ip, (this.ipCounts.get(ip) || 0) + 1);

    const client = {
      socket, id, ip, address: null, worker: null,
      subscribed: false, authorized: false,
      difficulty: this.vardiff.minDifficulty,  // FIX: start with min difficulty
      sharesAccepted: 0, sharesTotal: 0,
      lastShareTime: 0, connectedAt: Date.now(),
      extranonce1: null,
      // FIX: vardiff tracking
      vardiffLastRetarget: Date.now(),
      vardiffShares: 0,
      vardiffTimeWindow: [],
    };
    this.clients.set(id, client);
    console.log('[Stratum] Connected: ' + id + ' (total: ' + this.connectionCount + ')');

    // FIX: ping keepalive
    const pingInterval = setInterval(() => {
      if (client.socket && !client.socket.destroyed) {
        try { client.socket.write(JSON.stringify({ id: null, method: 'mining.ping', params: [] }) + '\n'); } catch(e) {}
      } else {
        clearInterval(pingInterval);
      }
    }, this.config.pingInterval || 30000);

    let buffer = '';
    let messageSize = 0;
    socket.on('data', (data) => {
      buffer += data.toString();
      messageSize += data.length;
      // FIX: max message size check
      if (messageSize > (this.config.maxMessageSize || 2048) * 10) {
        console.log('[Stratum] Message overflow: ' + id);
        socket.destroy();
        this._removeClient(id, ip);
        return;
      }
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      messageSize = buffer.length;
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          this._onMessage(client, JSON.parse(line));
        } catch (e) {
          console.error('[Stratum] Bad JSON from ' + id + ': ' + line.substring(0, 80));
        }
      }
    });

    socket.on('close', () => {
      clearInterval(pingInterval);
      this._removeClient(id, ip);
      if (client.address) this.emit('disconnect', client);
      console.log('[Stratum] Disconnected: ' + id);
    });

    socket.on('error', (e) => {
      if (e.code !== 'ECONNRESET') {
        console.error('[Stratum] Socket error ' + id + ': ' + e.message);
      }
    });
  }

  _removeClient(id, ip) {
    this.clients.delete(id);
    this.connectionCount = Math.max(0, this.connectionCount - 1);
    this.ipCounts.set(ip, Math.max(0, (this.ipCounts.get(ip) || 1) - 1));
    if (this.ipCounts.get(ip) === 0) this.ipCounts.delete(ip);
  }

  _onMessage(client, msg) {
    const { id, method, params } = msg;

    if (method === 'mining.subscribe') {
      const extranonce1 = crypto.randomBytes(4).toString('hex');
      client.extranonce1 = extranonce1;
      this._send(client, {
        id,
        result: [[['mining.notify', extranonce1, 4]], extranonce1, 4],
        error: null,
      });
      client.subscribed = true;
      this._send(client, { id: null, method: 'mining.set_difficulty', params: [client.difficulty] });
      return;
    }

    if (method === 'mining.authorize') {
      let walletAddr = '';
      let workerName = 'default';

      if (params && typeof params === 'object' && !Array.isArray(params)) {
        walletAddr = params.wallet || params[0] || '';
        workerName = params.agent || params[1] || 'default';
        client.worker = workerName;
      } else if (Array.isArray(params)) {
        workerName = params[0] || '';
        const parts = workerName.split('.');
        walletAddr = parts[0];
        client.worker = parts[1] || 'default';
      }

      // FIX: validate wallet address format
      if (!walletAddr || typeof walletAddr !== 'string' || walletAddr.length < 10) {
        this._send(client, { id, result: false, error: [24, 'Invalid wallet address'] });
        return;
      }

      client.address = walletAddr;
      client.authorized = true;
      this._send(client, { id, result: true, error: null });
      this.emit('authorize', client);
      console.log('[Stratum] Authorized: ' + client.worker + ' -> ' + walletAddr.substring(0, 20) + '...');
      if (this.currentJob) {
        this._send(client, this.currentJob.msg);
      }
      return;
    }

    if (method === 'mining.submit') {
      if (!client.authorized) {
        this._send(client, { id, result: false, error: [24, 'Not authorized'] });
        return;
      }

      const now = Date.now();
      // FIX: share rate limit (max 1 per 500ms per client)
      if (now - client.lastShareTime < 500) {
        console.log('[Stratum] Rate limit hit: ' + client.address.substring(0, 16));
        this._send(client, { id, result: false, error: [24, 'Rate limited'] });
        return;
      }

      client.sharesTotal++;
      client.lastShareTime = now;
      this.emit('share', {
        address: client.address,
        worker: client.worker,
        jobId: params ? (params.jobId || params[1]) : null,
        extranonce2: params ? (params.extranonce2 || params[2]) : null,
        ntime: params ? (params.ntime || params[3]) : null,
        nonce: params ? (params.nonce || params[4] || params.nonce) : null,
        difficulty: client.difficulty,
      }, (accepted, reason) => {
        if (accepted) {
          client.sharesAccepted++;
          // FIX: vardiff — track timing
          client.vardiffShares++;
          client.vardiffTimeWindow.push(now);
        }
        this._send(client, accepted
          ? { id, result: true, error: null }
          : { id, result: false, error: [23, reason || 'Low difficulty'] }
        );
      });
      // FIX: vardiff retarget check
      this._checkVardiff(client);
      return;
    }

    if (method === 'mining.ping') {
      this._send(client, { id, result: true, error: null });
      return;
    }

    if (id !== undefined) {
      this._send(client, { id, result: null, error: [20, 'Unknown method'] });
    }
  }

  // FIX: Vardiff - adaptive difficulty adjustment
  _checkVardiff(client) {
    const now = Date.now();
    if (now - client.vardiffLastRetarget < this.vardiff.retargetInterval * 1000) return;

    const recentShares = client.vardiffTimeWindow.filter(t => t > now - this.vardiff.retargetInterval * 1000);
    if (recentShares.length < 3) return;  // need minimum shares

    const avgShareTime = (now - recentShares[0]) / recentShares.length;
    const targetShareTime = this.vardiff.targetShareTime * 1000;
    const tolerance = this.vardiff.variancePercent;

    let newDiff = client.difficulty;
    if (avgShareTime < targetShareTime * (1 - tolerance)) {
      // Shares too fast → increase difficulty
      newDiff = Math.min(client.difficulty * 1.5, this.vardiff.maxDifficulty);
    } else if (avgShareTime > targetShareTime * (1 + tolerance)) {
      // Shares too slow → decrease difficulty
      newDiff = Math.max(client.difficulty * 0.7, this.vardiff.minDifficulty);
    }

    newDiff = Math.floor(newDiff);
    if (newDiff !== client.difficulty) {
      console.log('[Vardiff] ' + client.address.substring(0, 16) + ': ' + client.difficulty + ' -> ' + newDiff);
      client.difficulty = newDiff;
      this._send(client, { id: null, method: 'mining.set_difficulty', params: [newDiff] });
    }

    client.vardiffLastRetarget = now;
    client.vardiffTimeWindow = recentShares;
  }

  broadcastJob(jobObj) {
    this.currentJob = jobObj;
    for (const c of this.clients.values()) {
      if (c.authorized && c.subscribed) {
        this._send(c, {
          id: null,
          method: 'mining.notify',
          params: [jobObj.jobId, jobObj.prevHash, jobObj.coinb1, jobObj.coinb2,
                   jobObj.merkleBranches, jobObj.version, jobObj.nBits, jobObj.nTime, true],
        });
      }
    }
    console.log('[Stratum] Job ' + jobObj.jobId + ' sent to ' + this.clients.size + ' miners');
  }

  _send(client, msg) {
    if (client.socket && !client.socket.destroyed) {
      try { client.socket.write(JSON.stringify(msg) + '\n'); } catch (e) {}
    }
  }

  getClientCount() { return this.clients.size; }
  getAllClients() {
    return Array.from(this.clients.values()).filter(c => c.address).map(c => ({
      address: c.address, worker: c.worker, difficulty: c.difficulty,
      sharesAccepted: c.sharesAccepted, sharesTotal: c.sharesTotal,
      lastShareTime: c.lastShareTime, ip: c.ip,
    }));
  }

  stop() {
    for (const c of this.clients.values()) { try { c.socket.destroy(); } catch(e) {} }
    this.clients.clear();
    if (this.server) this.server.close();
  }
}

module.exports = StratumServer;
