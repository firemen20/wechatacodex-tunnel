// 配置加载与校验 —— 本框架的核心
//
// 设计原则：**代码里不出现任何个人数据**。
// 账号 ID、域名、Worker 名、UUID 全部从 config.json 读，config.json 不纳入版本控制。
//
// 用法:
//   const cfg = require('../src/config').load();       // 读 ./config.json
//   const cfg = require('../src/config').load('my.json');
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DEFAULT_FILE = path.join(ROOT, 'config.json');
const EXAMPLE_FILE = path.join(ROOT, 'config.example.json');

const DEFAULTS = {
  // Worker 的反代IP（目标站点也在 CF 上时用）。留空则用 Worker 内置的按机房就近地址。
  proxyip: 'proxyip.cmliussss.net',
  // 明文端口（不需要自定义域名时用；CF 只在这些端口上收明文 HTTP）
  ports: [2052, 80, 8080],
  // 优选 CF 边缘 IP 的候选池。留空则用 tools/optimize-ips.js 里的内置候选。
  edge_ips: [],
  // 每个 IP 展开成多少个端口（明文模式）。IP 越多节点越多，健康检查负担越大。
  ips_per_worker: 3,
  verify: {
    url: 'https://www.gstatic.com/generate_204',
    timeout_ms: 8000,
  },
  client: {
    mixed_port: 7890,
    external_controller: '127.0.0.1:9090',
    dns_nameserver: ['https://doh.pub/dns-query', 'https://dns.alidns.com/dns-query'],
    dns_default: ['223.5.5.5', '119.29.29.29'],
  },
  output_dir: 'dist',
};

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function die(msg, hint) {
  console.error('\n❌ 配置错误: ' + msg);
  if (hint) console.error('   ' + hint);
  console.error('');
  process.exit(1);
}

// 递归合并默认值（数组整体替换，不做元素合并）
function merge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) out[k] = v;
    else if (typeof v === 'object' && typeof base[k] === 'object' && !Array.isArray(base[k])) out[k] = merge(base[k], v);
    else out[k] = v;
  }
  return out;
}

function load(file, opts = {}) {
  const f = file ? path.resolve(file) : DEFAULT_FILE;

  if (!fs.existsSync(f)) {
    // optional 模式：某些工具（如只做格式转换的 build-subscription）并不真的需要
    // 配置，只是拿它来定默认输出目录。找不到配置不该让它们直接退出。
    // 踩过：CI 里没有 config.json，这些工具全崩，而本地因为有文件所以测不出来。
    if (opts.optional) return { ...DEFAULTS, workers: [], __file: null, __optional: true };
    die(`找不到配置文件 ${f}`, `复制一份模板开始: cp ${path.relative(process.cwd(), EXAMPLE_FILE)} ${path.relative(process.cwd(), DEFAULT_FILE)}`);
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (e) {
    die(`${f} 不是合法 JSON: ${e.message}`);
  }

  const cfg = merge(DEFAULTS, raw);
  cfg.__file = f;

  // ── 校验 ──────────────────────────────────────────────
  if (!Array.isArray(cfg.workers) || !cfg.workers.length) {
    die('workers 必须是非空数组', '至少配置一个 Worker，见 config.example.json');
  }

  const seen = new Set();
  cfg.workers.forEach((w, i) => {
    const at = `workers[${i}]`;
    if (!w || typeof w !== 'object') die(`${at} 不是对象`);
    if (!w.tag) die(`${at} 缺少 tag`, 'tag 是短标识，用于节点命名，如 node1');
    if (seen.has(w.tag)) die(`${at}.tag 重复: ${w.tag}`);
    seen.add(w.tag);
    if (!UUID_RE.test(String(w.uuid || ''))) die(`${at}.uuid 不是合法 UUID: ${w.uuid}`);
    // 两种模式二选一：
    //   自定义域名模式 → host 是绑定的域名（host 必填）
    //   明文模式       → host 是 *.workers.dev（host 必填，作为 WS 握手头）
    if (!w.host) die(`${at}.host 必填`, '自定义域名模式填绑定的域名；明文模式填 <worker>.<子域>.workers.dev');
  });

  if (!Array.isArray(cfg.ports) || !cfg.ports.length) die('ports 必须是非空数组');
  cfg.ports.forEach((p) => {
    if (!Number.isInteger(p) || p <= 0 || p > 65535) die(`ports 含非法端口: ${p}`);
  });

  if (cfg.domain && !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(cfg.domain)) {
    die(`domain 格式可疑: ${cfg.domain}`, '应形如 example.com（不要带 https:// 或路径）');
  }

  cfg.distDir = path.isAbsolute(cfg.output_dir) ? cfg.output_dir : path.join(ROOT, cfg.output_dir);
  cfg.root = ROOT;
  return cfg;
}

// Worker 列表 → nodes.js 认识的节点描述（明文 or 自定义域名两种模式）
function isCustomDomainMode(cfg) {
  return !!(cfg.domain && cfg.workers.every((w) => w.host && !/\.workers\.dev$/i.test(w.host)));
}

module.exports = { load, DEFAULTS, ROOT, UUID_RE, isCustomDomainMode };
