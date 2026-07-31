/**
 * aria2Client.js
 *
 * Minimal JSON-RPC 2.0 client for talking to a locally (or remotely)
 * running aria2c daemon started with:
 *
 *   aria2c --enable-rpc --rpc-listen-all --rpc-allow-origin-all --rpc-listen-port=6800
 *
 * No external dependency - plain http/https POST requests to the RPC
 * endpoint, e.g. http://localhost:6800/jsonrpc
 */

const http = require('http');
const https = require('https');

class Aria2Client {
  constructor({ url, secret } = {}) {
    this.url = url || 'http://localhost:6800/jsonrpc';
    this.secret = secret || '';
    this._idCounter = 0;
  }

  _call(method, params = []) {
    return new Promise((resolve, reject) => {
      const id = String(++this._idCounter);
      const finalParams = this.secret ? [`token:${this.secret}`, ...params] : params;
      const payload = JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: `aria2.${method}`,
        params: finalParams,
      });

      let parsed;
      try {
        parsed = new URL(this.url);
      } catch (e) {
        return reject(new Error(`Invalid ARIA2_RPC_URL "${this.url}": ${e.message}`));
      }

      const proto = parsed.protocol === 'https:' ? https : http;

      const req = proto.request(
        {
          hostname: parsed.hostname,
          port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
          path: parsed.pathname + parsed.search,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
          },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            try {
              const json = JSON.parse(data);
              if (json.error) {
                return reject(new Error(json.error.message || 'aria2 RPC error'));
              }
              resolve(json.result);
            } catch (e) {
              reject(new Error('Invalid JSON from aria2 RPC: ' + e.message));
            }
          });
        }
      );

      req.on('error', (e) => {
        reject(
          new Error(
            `Could not reach aria2 RPC at ${this.url} (${e.message}). Make sure aria2c is running with --enable-rpc --rpc-listen-port matching ARIA2_RPC_URL.`
          )
        );
      });

      req.setTimeout(15000, () => {
        req.destroy();
        reject(new Error(`aria2 RPC request timed out (${this.url})`));
      });

      req.write(payload);
      req.end();
    });
  }

  addUri(uris, options = {}) {
    return this._call('addUri', [uris, options]);
  }

  pause(gid) {
    return this._call('pause', [gid]);
  }

  unpause(gid) {
    return this._call('unpause', [gid]);
  }

  remove(gid) {
    return this._call('remove', [gid]);
  }

  forceRemove(gid) {
    return this._call('forceRemove', [gid]);
  }

  tellStatus(gid, keys) {
    return keys ? this._call('tellStatus', [gid, keys]) : this._call('tellStatus', [gid]);
  }

  removeDownloadResult(gid) {
    return this._call('removeDownloadResult', [gid]);
  }

  getVersion() {
    return this._call('getVersion', []);
  }
}

module.exports = Aria2Client;