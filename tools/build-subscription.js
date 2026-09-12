// 从「明文优选IP」Clash 配置生成各客户端可直接使用的配置文件
//
// 输出：
//   1. Clash Meta / FlClash  → Clash YAML
//   2. v2rayng / Nekoray     → base64 订阅（分享链接）
//   3. 手动导入              → 明文链接清单
//   4. Hiddify / Nekoray     → sing-box JSON
//
// 为什么用「明文优选IP」而不是「链式」：
//   链式依赖 mihomo 专有的 dialer-proxy，v2rayng(Xray)/Hiddify(sing-box) 表达不了；
//   明文方案（裸 IP + 明文端口 + ws Host 头）任何客户端都能表达，且不需要入口节点。
//
// 用法: node tools/build-multi-format.js <明文clash.yaml> [输出目录]
'use strict';
const fs = require('fs');
const path = require('path');
const yaml = require('../src/yaml-mini');
const N = require('../src/nodes');

const ROOT = path.join(__dirname, '..');
const SRC = process.argv[2] || path.join(cfg.distDir, 'clash-nodes.yaml');
const cfg = require('../src/config').load(null, { optional: true });
const OUTDIR = process.argv[3] || cfg.distDir;

if (!fs.existsSync(SRC)) {
  console.error('❌ 找不到源配置: ' + SRC);
  process.exit(1);
}

const doc = yaml.parse(fs.readFileSync(SRC, 'utf8'));
const proxies = (doc.proxies || []).filter((p) => p && p.server && p.port);
if (!proxies.length) {
  console.error('❌ 源配置里没有 proxies');
  process.exit(1);
}

// ── 1. 归一化 ────────────────────────────────────────────────
const nodes = [];
for (const p of proxies) {
  const n = N.fromClash(p);
  if (n) nodes.push(n);
}
console.log(`读入 ${proxies.length} 个节点，归一化成功 ${nodes.length} 个`);

const wsWorkers = [...new Set(nodes.map((n) => n.wsHost).filter(Boolean))];
console.log(`涉及 Worker: ${wsWorkers.length} 个`);
console.log(`协议: ${[...new Set(nodes.map((n) => n.type))].join(', ')}`);

// ── 2. 分享链接（v2rayng / Nekoray）─────────────────────────
const links = nodes.map((n) => N.toUri(n)).filter(Boolean);
if (links.length !== nodes.length) {
  console.warn(`⚠️ ${nodes.length - links.length} 个节点无法转成链接（已跳过）`);
}

// base64（RFC4648，UTF-8 安全）
function b64(str) {
  return Buffer.from(str, 'utf8').toString('base64');
}
const subBase64 = b64(links.join('\n'));

// ── 3. sing-box JSON（Hiddify / Nekoray）────────────────────
// 用扁平成员，不嵌套策略组 —— 和 mihomo 那边踩过的坑同理，兼容性最好。
function sbOutbound(n) {
  const o = {
    type: n.type,
    tag: n.name,
    server: n.server,
    server_port: n.port,
  };
  if (n.type === 'vless') {
    o.uuid = n.uuid;
    if (n.flow) o.flow = n.flow;
  }
  if (n.network === 'ws') {
    o.transport = {
      type: 'ws',
      path: n.wsPath || '/',
      headers: {},
    };
    if (n.wsHost) o.transport.headers.Host = n.wsHost;
    // 部分 CF Worker 对默认 UA 有差别，固定一个常见 UA 更稳
    o.transport.headers['User-Agent'] = 'Mozilla/5.0';
  }
  if (n.tls) {
    o.tls = { enabled: true };
    if (n.sni) o.tls.server_name = n.sni;
    if (n.skipCertVerify) o.tls.insecure = true;
  }
  return o;
}

const nodeTags = nodes.map((n) => n.name);
const singbox = {
  log: { level: 'warn', timestamp: true },
  dns: {
    // 必须用 sing-box 1.12+ 的新格式（type + server）：
    // 旧写法 { address: "https://..." } 在 1.14.0 已被移除，check 会直接 FATAL
    servers: [
      { type: 'https', tag: 'dns-remote', server: '1.1.1.1', detour: '🚀 代理' },
      { type: 'udp', tag: 'dns-local', server: '223.5.5.5' },
    ],
    rules: [],
    final: 'dns-remote',
    strategy: 'prefer_ipv4',
  },
  inbounds: [
    {
      type: 'mixed',
      tag: 'mixed-in',
      listen: '127.0.0.1',
      listen_port: 2080,
    },
  ],
  outbounds: [
    {
      type: 'selector',
      tag: '🚀 代理',
      outbounds: ['⚡ 自动选择', ...nodeTags],
      default: '⚡ 自动选择',
      interrupt_exist_connections: false,
    },
    {
      type: 'urltest',
      tag: '⚡ 自动选择',
      outbounds: nodeTags,
      url: 'http://cp.cloudflare.com/generate_204',
      interval: '5m',
      tolerance: 100,
      interrupt_exist_connections: false,
    },
    ...nodes.map(sbOutbound),
    { type: 'direct', tag: 'direct' },
  ],
  route: {
    // sinb-box 1.12+ 要求：出站需要解析域名时必须显式指定解析器，
    // 否则 1.14.0 直接 FATAL（需设 ENABLE_DEPRECATED_MISSING_DOMAIN_RESOLVER 才能绕过）
    default_domain_resolver: { server: 'dns-remote' },
    rules: [
      { protocol: 'dns', outbound: '🚀 代理' },
      { ip_is_private: true, outbound: 'direct' },
    ],
    final: '🚀 代理',
    auto_detect_interface: true,
  },
};

// ── 4. 写出 ────────────────────────────────────────────────
fs.mkdirSync(OUTDIR, { recursive: true });
const written = [];

function w(name, content) {
  const p = path.join(OUTDIR, name);
  fs.writeFileSync(p, content);
  written.push([name, Buffer.byteLength(content)]);
}

w('ClashMeta-FlClash.yaml', fs.readFileSync(SRC, 'utf8'));
w('通用订阅-base64.txt', subBase64);
w('节点链接.txt', links.join('\n') + '\n');
w('Hiddify-Nekoray-singbox.json', JSON.stringify(singbox, null, 2) + '\n');

// 也放一份到 data/ 供 Worker 打包用
fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'data', 'multi-format.json'), JSON.stringify(singbox, null, 2));
fs.writeFileSync(path.join(ROOT, 'data', 'multi-base64.txt'), subBase64);
fs.writeFileSync(path.join(ROOT, 'data', 'multi-links.txt'), links.join('\n') + '\n');

console.log('');
console.log(`✅ 已输出到 ${OUTDIR}`);
for (const [n, b] of written) console.log(`   ${n.padEnd(34)} ${b} B`);
console.log('');
console.log(`节点数: ${nodes.length}`);
console.log(`示例链接:\n   ${links[0]}`);
