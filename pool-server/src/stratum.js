'use strict';

const net = require('net');
const crypto = require('crypto');
const { EventEmitter } = require('events');

class StratumServer extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.servers = new Map();       // portName -> net.Server
    this.clients = new Map();       // clientId -> client
    this.currentJob = null;
    this.ipCounts = new Map();
    this.bannedIPs = new Map();
    this.connectionCount = 0;
    this.portStats = { easy: { conn: 0, shares: 0 }, medium: { conn: 0, shares: 0 }, hard: { conn: 0, shares: 0 } };
  }

  start() {
    const ports = this.config.stratum.ports;
    for (const [name, cfg] of Object.entries(ports)) {
      const server = net.createServer((s) => this._onConnection(s, name, cfg));
      server.listen(cfg.port, this.config.stratum.host, () => {
        console.log(`[Stratum] ${name} (${cfg.label}) on :${cfg.port} — start diff ${cfg.difficulty}, max ${cfg.maxConnections} conn`);
      });
      server.on('error', (e) => console.error(`[Stratum] ${name} error:`, e.message));
      this.servers.set(name, server);
    }
    console.log(`[Stratum] Per-IP limit: ${this.config.stratum.perIPLimit}`);
    console.log(`[Stratum] Vardiff: ${this.config.vardiff.minDifficulty}-${this.config.vardiff.maxDifficulty}`);
    // Cleanup stale clients every 60s
    setInterval(() => this._cleanup(), 60000);
  }

  _isIPAllowed(ip) {
    const banExpiry = this.bannedIPs.get(ip);
    if (banExpiry && Date.now() < banExpiry) return false;
    if (banExpiry && Date.now() >= banExpiry) this.bannedIPs.delete(ip);
    const count = this.ipCounts.get(ip) || 0;
    if (count >= this.config.stratum.perIPLimit) return false;
    return true;
  }

  _cleanup() {
    const now = Date.now();
    for (const [id, c] of this.clients) {
      // Disconnect idle (no share in 5 min, connected > 2 min)
      if (now - c.connectedAt > 120000 && now - c.lastShareTime > 300000) {
        try { c.socket.destroy(); } catch(e) {}
        this._removeClient(c.id, c.ip, c.portName);
        console.log('[Stratum] Cleaned idle: ' + c.id);
      }
    }
    // Expire bans
    for (const [ip, expiry] of this.bannedIPs) {
      if (now >= expiry) this.bannedIPs.delete(ip);
    }
  }

  _onConnection(socket, portName, portCfg) {
    const rawIp = socket.remoteAddress || 'unknown';
    const ip = rawIp.replace('::ffff:', '');
    const id = ip + ':' + socket.remotePort;

    if (!this._isIPAllowed(ip)) {
      console.log(`[Stratum] Rejected (limit): ${id} on :${portCfg.port}`);
      socket.destroy();
      return;
    }

    // Per-port max connection check
    const portClients = Array.from(this.clients.values()).filter(c => c.portName === portName).length;
    if (portClients >= portCfg.maxConnections) {
      console.log(`[Stratum] Rejected (port ${portName} full): ${id}`);
      socket.destroy();
      return;
    }

    this.connectionCount++;
    this.ipCounts.set(ip, (this.ipCounts.get(ip) || 0) + 1);
    if (this.portStats[portName]) this.portStats[portName].conn++;

    const client = {
      socket, id, ip, portName, port: portCfg.port,
      address: null, worker: null,
      subscribed: false, authorized: false,
      difficulty: portCfg.difficulty,  // start difficulty based on port
      startDifficulty: portCfg.difficulty,
      sharesAccepted: 0, sharesTotal: 0,
      lastShareTime: 0, connectedAt: Date.now(),
      extranonce1: null,
      // vardiff tracking
      vardiffLastRetarget: Date.now(),
      vardiffTimeWindow: [],
      // ping tracking
      lastPingResponse: Date.now(),
      pendingPing: false,
    };
    this.clients.set(id, client);
    console.log(`[Stratum] ${id} -> ${portName} (diff ${portCfg.difficulty}) [${this.connectionCount} total]`);

    // Ping keepalive
    const pingInterval = setInterval(() => {
      if (!client.socket || client.socket.destroyed) {
        clearInterval(pingInterval);
        return;
      }
      // If last ping wasn't responded, kill connection
      if (client.pendingPing && Date.now() - client.lastPingResponse > 60000) {
        console.log(`[Stratum] Ping timeout: ${id}`);
        try { client.socket.destroy(); } catch(e) {}
        clearInterval(pingInterval);
        return;
      }
      try {
        client.socket.write(JSON.stringify({ id: null, method: 'mining.ping', params: [] }) + '\n');
        client.pendingPing = true;
      } catch(e) { clearInterval(pingInterval); }
    }, this.config.stratum.pingInterval || 30000);

    let buffer = '';
    let bufferSize = 0;
    socket.on('data', (data) => {
      buffer += data.toString();
      bufferSize += data.length;
      if (bufferSize > (this.config.stratum.maxMessageSize || 2048) * 10) {
        console.log(`[Stratum] Overflow: ${id}`);
        socket.destroy();
        this._removeClient(id, ip, portName);
        clearInterval(pingInterval);
        return;
      }
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      bufferSize = buffer.length;
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          this._onMessage(client, JSON.parse(line));
        } catch (e) {
          console.error(`[Stratum] Bad JSON from ${id}: ${line.substring(0, 80)}`);
        }
      }
    });

    socket.on('close', () => {
      clearInterval(pingInterval);
      this._removeClient(id, ip, portName);
      if (client.address) this.emit('disconnect', client);
      console.log(`[Stratum] Disconnected: ${id} (${portName})`);
    });

    socket.on('error', (e) => {
      if (e.code !== 'ECONNRESET') {
        console.error(`[Stratum] Error ${id}: ${e.message}`);
      }
    });
  }

  _removeClient(id, ip, portName) {
    this.clients.delete(id);
    this.connectionCount = Math.max(0, this.connectionCount - 1);
    this.ipCounts.set(ip, Math.max(0, (this.ipCounts.get(ip) || 1) - 1));
    if (this.ipCounts.get(ip) === 0) this.ipCounts.delete(ip);
    if (this.portStats[portName]) this.portStats[portName].conn = Math.max(0, this.portStats[portName].conn - 1);
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
      // Send difficulty for this port
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

      // Validate wallet
      if (!walletAddr || typeof walletAddr !== 'string' || walletAddr.length < 10) {
        this._send(client, { id, result: false, error: [24, 'Invalid wallet address'] });
        return;
      }

      client.address = walletAddr;
      client.authorized = true;
      this._send(client, { id, result: true, error: null });
      this.emit('authorize', client);
      console.log(`[Stratum] Authorized: ${client.worker} -> ${walletAddr.substring(0, 20)}... (port ${client.portName})`);
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
      // Rate limit: max 1 share per 500ms
      if (now - client.lastShareTime < 500) {
        console.log(`[Stratum] Rate limit: ${client.address.substring(0, 16)}`);
        this._send(client, { id, result: false, error: [24, 'Rate limited'] });
        return;
      }

      client.sharesTotal++;
      client.lastShareTime = now;
      if (this.portStats[client.portName]) this.portStats[client.portName].shares++;

      this.emit('share', {
        address: client.address,
        worker: client.worker,
        jobId: params ? (params.jobId || params[1]) : null,
        extranonce2: params ? (params.extranonce2 || params[2]) : null,
        ntime: params ? (params.ntime || params[3]) : null,
        nonce: params ? (params.nonce || params[4] || params.nonce) : null,
        difficulty: client.difficulty,
        portName: client.portName,
        port: client.port,
      }, (accepted, reason) => {
        if (accepted) {
          client.sharesAccepted++;
          client.vardiffTimeWindow.push(now);
        }
        this._send(client, accepted
          ? { id, result: true, error: null }
          : { id, result: false, error: [23, reason || 'Low difficulty'] }
        );
      });
      this._checkVardiff(client);
      return;
    }

    if (method === 'mining.ping') {
      client.lastPingResponse = Date.now();
      client.pendingPing = false;
      this._send(client, { id, result: true, error: null });
      return;
    }

    if (id !== undefined) {
      this._send(client, { id, result: null, error: [20, 'Unknown method'] });
    }
  }

  _checkVardiff(client) {
    const now = Date.now();
    const v = this.config.vardiff;
    if (now - client.vardiffLastRetarget < v.retargetInterval * 1000) return;

    const recentShares = client.vardiffTimeWindow.filter(t => t > now - v.retargetInterval * 1000);
    if (recentShares.length < 3) return;

    const avgShareTime = (now - recentShares[0]) / recentShares.length;
    const targetShareTime = v.targetShareTime * 1000;
    const tolerance = v.variancePercent;

    let newDiff = client.difficulty;
    if (avgShareTime < targetShareTime * (1 - tolerance)) {
      newDiff = Math.min(client.difficulty * 1.5, v.maxDifficulty);
    } else if (avgShareTime > targetShareTime * (1 + tolerance)) {
      newDiff = Math.max(client.difficulty * 0.7, v.minDifficulty);
    }

    newDiff = Math.floor(newDiff);
    if (newDiff !== client.difficulty) {
      console.log(`[Vardiff] ${client.address.substring(0, 16)}: ${client.difficulty} -> ${newDiff} (${client.portName})`);
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
    console.log(`[Stratum] Job ${jobObj.jobId} sent to ${this.clients.size} miners`);
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
      port: c.port, portName: c.portName,
    }));
  }

  getPortStats() {
    return this.portStats;
  }

  stop() {
    for (const c of this.clients.values()) { try { c.socket.destroy(); } catch(e) {} }
    this.clients.clear();
    for (const [name, server] of this.servers) {
      try { server.close(); } catch(e) {}
      console.log(`[Stratum] ${name} stopped`);
    }
  }
}

module.exports = StratumServer;
