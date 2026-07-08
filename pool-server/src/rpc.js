'use strict';

const https = require('https');
const fs = require('fs');

class PRLRpc {
  constructor(config) {
    this.url = config.rpc.url;
    this.user = config.rpc.user;
    this.pass = config.rpc.pass;
    this.certPath = config.rpc.cert;
    this.ca = null;
    try {
      if (this.certPath && fs.existsSync(this.certPath)) {
        this.ca = fs.readFileSync(this.certPath);
      }
    } catch (e) {}
  }

  async call(method, params) {
    const body = JSON.stringify({
      jsonrpc: '1.0', id: Date.now(), method, params: params || [],
    });
    const u = new URL(this.url);
    const auth = Buffer.from(this.user + ':' + this.pass).toString('base64');
    const opts = {
      hostname: u.hostname, port: u.port, path: '/', method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Basic ' + auth,
        'Content-Length': Buffer.byteLength(body),
      },
      rejectUnauthorized: false,
    };
    if (this.ca) opts.ca = this.ca;

    return new Promise((resolve, reject) => {
      const req = https.request(opts, (res) => {
        let data = '';
        res.on('data', (c) => data += c);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json.error) reject(new Error(json.error.message));
            else resolve(json.result);
          } catch (e) { reject(e); }
        });
      });
      req.on('error', reject);
      req.setTimeout(15000, () => { req.destroy(); reject(new Error('RPC timeout')); });
      req.write(body);
      req.end();
    });
  }

  async getBlockchainInfo() { return this.call('getblockchaininfo'); }
  async getBlockTemplate(rules) { return this.call('getblocktemplate', [rules || { rules: [] }]); }
  async submitBlock(hex) { return this.call('submitblock', [hex]); }
  async getBlock(hash) { return this.call('getblock', [hash, 1]); }
  async getBlockHex(hash) { return this.call('getblock', [hash, 0]); }
  async getNetworkHashps() { return this.call('getnetworkhashps'); }
  async getDifficulty() { return this.call('getdifficulty'); }
  async getBestBlockHash() { return this.call('getbestblockhash'); }
  async getBlockCount() { return this.call('getblockcount'); }
  async getRawTransaction(txid) { return this.call('getrawtransaction', [txid, true]); }
  async sendToAddress(addr, amt) { return this.call('sendtoaddress', [addr, amt]); }
  async getBalance() { return this.call('getbalance'); }
  async getNewAddress(label) { return this.call('getnewaddress', [label || 'pool']); }
  async getRawMempool() { return this.call('getrawmempool'); }
}

module.exports = PRLRpc;
