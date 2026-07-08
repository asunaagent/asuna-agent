'use strict';

const path = require('path');

const config = {
  // FIX: 3 stratum ports (easy/medium/hard)
  stratum: {
    host: process.env.POOL_HOST || '0.0.0.0',
    ports: {
      easy: {
        port: parseInt(process.env.STRATUM_EASY || '3333'),
        difficulty: parseInt(process.env.DIFF_EASY || '32'),
        maxConnections: parseInt(process.env.MAX_CONN_EASY || '300'),
        label: 'Low difficulty',
      },
      medium: {
        port: parseInt(process.env.STRATUM_MEDIUM || '4444'),
        difficulty: parseInt(process.env.DIFF_MEDIUM || '128'),
        maxConnections: parseInt(process.env.MAX_CONN_MEDIUM || '200'),
        label: 'Medium difficulty',
      },
      hard: {
        port: parseInt(process.env.STRATUM_HARD || '5555'),
        difficulty: parseInt(process.env.DIFF_HARD || '512'),
        maxConnections: parseInt(process.env.MAX_CONN_HARD || '100'),
        label: 'High difficulty',
      },
    },
    perIPLimit: parseInt(process.env.PER_IP_LIMIT || '10'),
    maxMessageSize: parseInt(process.env.MAX_MSG || '2048'),
    pingInterval: parseInt(process.env.PING_INTERVAL || '30000'),
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
  vardiff: {
    minDifficulty: parseInt(process.env.VARDIFF_MIN || '16'),
    maxDifficulty: parseInt(process.env.VARDIFF_MAX || '2048'),
    targetShareTime: parseInt(process.env.VARDIFF_TARGET || '15'),
    retargetInterval: parseInt(process.env.VARDIFF_INTERVAL || '60'),
    variancePercent: 0.3,
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
