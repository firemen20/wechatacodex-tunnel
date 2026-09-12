// 生成 Clash(mihomo) 配置 —— 从 config.json 读节点定义，代码里不硬编码
//
// 两种模式（自动判断）：
//   自定义域名模式：server = 优选IP, port = 443, tls = true, SNI/Host = 你绑的域名
//                   → 加密；且自定义域名没被墙，所以不需要入口节点
//   明文端口模式  ：server = 优选IP, port = 明文端口, tls = false, Host = *.workers.dev
//                   → 不加密；用来绕开 workers.dev 的 DNS 污染与 SNI 阻断
//
// 用法:
//   node tools/build-nodes.js [输出文件] [--config config.json] [--ips "1.2.3.4:300,5.6.7.8:400"]
//     --ips 不传则用 config.edge_ips；再空则用内置默认
'use strict';
const fs = require('fs');
const path = require('path');

// 简单参数解析（避免 --config 的值被当成位置参数）
function argVal(name) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}
const positional = process.argv.slice(2).filter((a, i, arr) => {
  if (a.startsWith('--')) return false;
  const prev = arr[i - 1];
  return !(prev === '--config' || prev === '--ips');
});

const configMod = require('../src/config');
const cfg = configMod.load(argVal('config'));
const { isCustomDomainMode } = configMod;

const outFile = positional[0] || path.join(cfg.distDir, 'clash-nodes.yaml');

// ── 优选 IP 结果 ───────────────────────────────────────────
const DEFAULT_IP_RESULT = [{ ip: '172.66.0.1', ms: 500 }, { ip: '104.26.0.1', ms: 600 }];

function parseIpsArg() {
  const i = process.argv.indexOf('--ips');
  if (i < 0 || !process.argv[i + 1]) return null;
  const list = process.argv[i + 1].split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    const [ip, ms] = s.split(':');
    return { ip, ms: Number(ms) || 0 };
  }).filter((x) => x.ip);
  if (!list.length) { console.error('❌ --ips 解析为空'); process.exit(1); }
  return list;
}

const fromConfig = (cfg.edge_ips || []).map((ip) => ({ ip, ms: 0 }));
const IP_RESULT = parseIpsArg() || (fromConfig.length ? fromConfig : DEFAULT_IP_RESULT);

const domainMode = isCustomDomainMode(cfg);
const picks = IP_RESULT.slice(0, cfg.ips_per_worker);

if (!picks.length) { console.error('❌ 没有可用的优选 IP'); process.exit(1); }

console.log(`模式: ${domainMode ? '自定义域名（443 + TLS 加密）' : '明文端口（不需域名）'}`);
console.log(`Worker ${cfg.workers.length} 个 × IP ${picks.length} 个${domainMode ? '' : ` × 端口 ${cfg.ports.length} 个`}`);

// ── 生成节点 ───────────────────────────────────────────────
const proxies = [];
const groups = {};

for (const w of cfg.workers) {
  groups[w.tag] = [];
  for (const { ip } of picks) {
    if (domainMode) {
      const name = `${w.tag}-${ip.replace(/\./g, '-')}-443tls`;
      proxies.push({
        name, type: 'vless', server: ip, port: 443, uuid: w.uuid,
        network: 'ws', tls: true, udp: true, servername: w.host,
        wsOptsPath: '/?ed=2048', wsHost: w.host,
      });
      groups[w.tag].push(name);
    } else {
      for (const port of cfg.ports) {
        const name = `${w.tag}-${ip.replace(/\./g, '-')}-${port}`;
        proxies.push({
          name, type: 'vless', server: ip, port, uuid: w.uuid,
          network: 'ws', tls: false, udp: true,
          wsOptsPath: '/?ed=2048', wsHost: w.host,
        });
        groups[w.tag].push(name);
      }
    }
  }
}

console.log(`生成节点: ${proxies.length} 个`);

// ── 输出 Clash YAML ────────────────────────────────────────
function esc(v) {
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  const s = String(v);
  return /^[A-Za-z0-9._/=+-]+$/.test(s) && !/^(true|false|null|yes|no|on|off)$/i.test(s) ? s : JSON.stringify(s);
}

const L = [];
L.push('# =========================================================');
L.push('# CF Worker 隧道节点（由 wechatacodex-tunnel 生成）');
L.push('# 生成时间: ' + new Date().toISOString());
L.push(`# 模式: ${domainMode ? '自定义域名 + TLS 443（加密）' : '明文端口（不加密）'}`);
L.push(`# 节点: ${proxies.length} 个（${cfg.workers.length} Worker × ${picks.length} IP${domainMode ? '' : ` × ${cfg.ports.length} 端口`}）`);
L.push('# =========================================================');
L.push('');
L.push(`mixed-port: ${cfg.client.mixed_port}`);
L.push('allow-lan: false');
L.push('mode: rule');
L.push('log-level: warning');
L.push('ipv6: true');
L.push('unified-delay: true');
L.push('tcp-concurrent: true');
L.push('');
L.push('profile:');
L.push('  store-selected: true');
L.push('  store-fake-ip: true');
L.push('');
L.push('dns:');
L.push('  enable: true');
L.push('  ipv6: false');
L.push('  enhanced-mode: fake-ip');
L.push('  fake-ip-range: 198.18.0.1/16');
L.push('  default-nameserver:');
for (const s of cfg.client.dns_default || ['223.5.5.5']) L.push(`    - ${s}`);
L.push('  nameserver:');
for (const s of cfg.client.dns_nameserver || ['https://doh.pub/dns-query']) L.push(`    - ${s}`);
L.push('');
L.push('proxies:');
for (const p of proxies) {
  L.push(`  - name: ${esc(p.name)}`);
  L.push('    type: vless');
  L.push(`    server: ${p.server}`);
  L.push(`    port: ${p.port}`);
  L.push(`    uuid: ${p.uuid}`);
  L.push('    network: ws');
  L.push(`    tls: ${p.tls}`);
  L.push('    udp: true');
  if (p.servername) L.push(`    servername: ${p.servername}`);
  if (p.tls) L.push('    skip-cert-verify: false');
  L.push('    ws-opts:');
  L.push(`      path: ${esc(p.wsOptsPath)}`);
  L.push('      headers:');
  L.push(`        Host: ${p.wsHost}`);
  L.push('        User-Agent: Mozilla/5.0');
}
L.push('');
L.push('proxy-groups:');
L.push('  - name: "🚀 代理"');
L.push('    type: select');
L.push('    proxies:');
L.push('      - "⚡ 自动选择"');
for (const w of cfg.workers) L.push(`      - "${w.tag}"`);
L.push('      - DIRECT');
L.push('');
L.push('  - name: "⚡ 自动选择"');
L.push('    type: url-test');
L.push(`    url: ${cfg.verify.url.replace('https://', 'http://')}`);
L.push('    interval: 180');
L.push('    tolerance: 100');
L.push('    proxies:');
for (const p of proxies) L.push('      - ' + JSON.stringify(p.name));
for (const w of cfg.workers) {
  if (!groups[w.tag] || !groups[w.tag].length) continue;
  L.push('');
  L.push(`  - name: "${w.tag}"`);
  L.push('    type: url-test');
  L.push(`    url: ${cfg.verify.url.replace('https://', 'http://')}`);
  L.push('    interval: 180');
  L.push('    tolerance: 100');
  L.push('    proxies:');
  for (const n of groups[w.tag]) L.push('      - ' + JSON.stringify(n));
}
L.push('');
L.push('rules:');
L.push('  - DOMAIN-SUFFIX,cn,DIRECT');
L.push('  - GEOIP,CN,DIRECT,no-resolve');
L.push('  - MATCH,🚀 代理');
L.push('');

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, L.join('\n'));
console.log(`✅ Clash 配置: ${outFile}`);
