'use strict';
const os = require('os');

const SKIP_IFACE = /vEthernet|WSL|Hyper-V|VirtualBox|VMware|Docker|Loopback|Tailscale|ZeroTier|VPN|TAP|Cisco|AnyConnect|GlobalProtect|Zscaler|Bluetooth/i;
const PREFER_IFACE = /Wi-?Fi|Wireless|WLAN|Ethernet/i;

function isPrivate(ip) {
  if (/^192\.168\./.test(ip)) return 3;
  if (/^10\./.test(ip)) return 2;
  const m = /^172\.(\d+)\./.exec(ip);
  if (m && +m[1] >= 16 && +m[1] <= 31) return 1;
  return 0;
}

/**
 * List usable LAN IPv4 candidates, best first.
 * @param {object} [ifaces] os.networkInterfaces() shape (injectable for tests)
 * @returns {{address:string, iface:string, score:number}[]}
 */
function lanCandidates(ifaces = os.networkInterfaces()) {
  const out = [];
  for (const [name, list] of Object.entries(ifaces || {})) {
    if (SKIP_IFACE.test(name)) continue;
    for (const a of list || []) {
      const fam = a.family === 4 ? 'IPv4' : a.family;
      if (fam !== 'IPv4' || a.internal) continue;
      if (/^169\.254\./.test(a.address) || /^127\./.test(a.address)) continue;
      let score = 0;
      if (PREFER_IFACE.test(name)) score += 10;
      if (/Wi-?Fi|Wireless|WLAN/i.test(name)) score += 2; // phones are on Wi-Fi
      score += isPrivate(a.address) * 3;
      out.push({ address: a.address, iface: name, score });
    }
  }
  out.sort((x, y) => y.score - x.score);
  return out;
}

/**
 * Pick the address phones should use. HOST_IP env wins.
 * @returns {{address:string, candidates:{address,iface,score}[]}}
 */
function pickLanAddress(ifaces, env = process.env) {
  const candidates = lanCandidates(ifaces);
  const override = env && env.HOST_IP && String(env.HOST_IP).trim();
  if (override) {
    if (!candidates.some((c) => c.address === override)) candidates.unshift({ address: override, iface: 'HOST_IP', score: 999 });
    return { address: override, candidates };
  }
  return { address: candidates.length ? candidates[0].address : 'localhost', candidates };
}

module.exports = { pickLanAddress, lanCandidates, SKIP_IFACE };
