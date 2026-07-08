'use strict';

const path = require('path');

const config = {
  stratum: {
    host: process.env.POOL_HOST || '0.0.0.0',
    port: parseInt(process.env.POOL_PORT || '3333'),
    maxConnections: parseInt(process.env.MAX_CONN || '500'),  // FIX: connection limit
    perIPLimit: parseInt(process.env.PER_IP_LIMIT || '5'),     // FIX: per-IP limit
    maxMessageSize: parseInt(process.env.MAX_MSG || '2048'),    // FIX: max msg size
    pingInterval: parseInt(process.env.PING_INTERVAL || '30000'), // FIX: keepalive
  },
  api: {
    host: process.env.API_HOST || '0.0.0.0',
    port: parseInt(process.env.API_PORT || '8080'),
  },
  rpc: {
    url: process.env.RPC_URL || 'https://127.0.0.1:44107',
    user: process.env.RPC_USER || 'pearlpool',
    pass: process.env.RPC_PASS || 'PrL_P00l_2026_Secur3',
    cert: process.env.RPC_CERT || path.join(process.env.HOME || '/root', '.pearld', 'rpc.cert'),
  },
  pool: {
    wallet: process.env.POOL_WALLET || 'prl1paf83uwplzy4r3s4ukkud649009fwzgunmgh7phv8hdhu2jg2pnasua4t5k',
    fee: 0.015,
    operatorFee: 0.01,
    txReserve: 0.005,
    minPayout: 100000000,
    payoutInterval: 3600,
  },
  vardiff: {                          // FIX: adaptive difficulty
    minDifficulty: 16,
    maxDifficulty: 2048,
    targetShareTime: 15,              // seconds between shares
    retargetInterval: 60,             // seconds between retargets
    variancePercent: 0.3,             // 30% tolerance
  },
  pplns: {
    windowSize: 120,
    timeDecay: 1800,
  },
  db: {
    path: process.env.DB_PATH || path.join(__dirname, '..', 'data', 'pool.db.json'),
  },
};

module.exports = config;
