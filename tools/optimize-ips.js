// 一键重新优选 IP：扫描候选 IP -> 实测 -> 生成配置 -> 验证 -> 发布
//
// 把原先「四个脚本按顺序手动跑」合并成一条命令，避免记错顺序。
//
// 用法:
//   node tools/optimize-ips.js                    # 用内置候选 IP 全流程跑一遍
//   node tools/optimize-ips.js --top 4            # 取最快的 4 个 IP
//   node tools/optimize-ips.js --config my.json   # 指定配置文件
//   node tools/optimize-ips.js --ips 1.2.3.4,5.6.7.8   # 只测指定的候选 IP
//   node tools/optimize-ips.js --core /path/mihomo     # 指定内核
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const TOP = parseInt(arg('top', '3'), 10);

// ── 配置驱动（不再有任何硬编码的账号/域名/UUID）──────────
const configMod = require('../src/config');
const cfg = configMod.load(arg('config'));
const DIST = cfg.distDir;

// 内核：优先 --core → 环境变量 MIHOMO → data/mihomo → PATH
function findCore() {
  for (const c of [arg('core', ''), process.env.MIHOMO, path.join(DATA, 'mihomo'), 'mihomo']) {
    if (!c) continue;
    try { spawnSync(c, ['-v'], { stdio: 'ignore' }); return c; } catch (e) { /* 试下一个 */ }
  }
  console.error('❌ 找不到内核。请下载 mihomo 放到 data/mihomo，或用 --core <路径> 指定。');
  console.error('   https://github.com/MetaCubeX/mihomo/releases');
  process.exit(1);
}
const CORE = findCore();
// 关键：把内核路径通过环境变量传给子进程（verify-config.js 也要用它）。
// 否则子进程会各自去找内核，找不到就整体失败（踩过：/sdcard 是 noexec，data/mihomo 无法执行）。
process.env.MIHOMO = CORE;

// 内置候选 IP（历次实测稳定可达的 CF 边缘 IP）
const DEFAULT_CANDIDATES = [
  '172.66.0.1', '104.20.0.1', '104.25.0.1', '104.18.0.1', '104.21.0.1',
  '104.17.0.1', '188.114.96.1', '104.26.0.1', '104.24.0.1', '104.27.0.1',
  '162.159.0.1', '104.16.132.229', '104.19.192.174',
];

// 把「上一轮配置里正在用的 IP」并进候选。
// 目的：优选噪声很大，上一轮选出来的好 IP 如果这次没进候选，就会被白白丢掉，
// 结果配置越维护越差（实测出现过：只测扫描前 8 名，反而把 381ms 的 IP 换成了 1161ms 的）。
function prevIps() {
  for (const f of [path.join(DIST, 'clash-nodes.yaml'), path.join(DIST, 'ClashMeta-FlClash.yaml')]) {
    try {
      const yml = require(path.join(ROOT, 'src', 'yaml-mini.js'));
      const d = yml.parse(fs.readFileSync(f, 'utf8'));
      const ips = [...new Set((d.proxies || []).map((p) => p.server).filter(Boolean))];
      if (ips.length) return ips;
    } catch (e) { /* 试下一个 */ }
  }
  return [];
}
const PREV = prevIps();
const CANDIDATES = arg('ips', '').split(',').filter(Boolean).length
  ? arg('ips', '').split(',').map((s) => s.trim()).filter(Boolean)
  : [...new Set([...DEFAULT_CANDIDATES, ...(cfg.edge_ips || []), ...PREV])];
console.log(`候选 IP: ${CANDIDATES.length} 个${PREV.length ? `（含上轮在用的 ${PREV.length} 个: ${PREV.join(', ')}）` : ''}`);

// 扫描用的探针节点：取配置里第一个 Worker
const PROBE = (() => {
  const w = cfg.workers[0];
  return { host: w.host, uuid: w.uuid };
})();

function step(n, total, title) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`[${n}/${total}] ${title}`);
  console.log('─'.repeat(60));
}
function fail(msg, detail) {
  console.error('❌ ' + msg + (detail ? '\n' + detail : ''));
  process.exit(1);
}
function run(cmd, args, env) {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ...(env || {}) } });
  return r.status === 0;
}

// ── 1. 生成 IP 扫描配置 ──
function buildSweepConfig() {
  const L = [
    'mixed-port: 7897', 'allow-lan: false', 'mode: rule', 'log-level: warning', 'ipv6: true', 'proxies:',
  ];
  const names = [];
  CANDIDATES.forEach((ip, i) => {
    const tag = 'ip' + String(i).padStart(2, '0') + '-' + ip.replace(/\./g, '_');
    names.push(tag);
    L.push(
      `  - name: "${tag}"`,
      '    type: vless',
      `    server: ${ip}`,
      '    port: 2052',
      `    uuid: ${PROBE.uuid}`,
      '    network: ws',
      '    tls: false',
      '    udp: true',
      '    ws-opts:',
      '      path: "/?ed=2048"',
      '      headers:',
      `        Host: ${PROBE.host}`,
      '        User-Agent: Mozilla/5.0'
    );
  });
  L.push('', 'proxy-groups:', '  - name: "T"', '    type: select', '    proxies:');
  names.forEach((n) => L.push(`      - "${n}"`));
  L.push('', 'rules:', '  - MATCH,T', '');
  const f = path.join(DATA, 'ip-sweep.yaml');
  fs.writeFileSync(f, L.join('\n'));
  return { file: f, names };
}

function killMihomo() {
  try {
    const ps = spawnSync('sh', ['-c', "ps -A 2>/dev/null | grep '[m]ihomo' | awk '{print $2}'"], { encoding: 'utf8' });
    for (const pid of (ps.stdout || '').trim().split('\n').filter(Boolean)) {
      try { process.kill(Number(pid), 'SIGKILL'); } catch (e) { /* ignore */ }
    }
  } catch (e) { /* ignore */ }
}

// ── 主流程 ──
const TOTAL = 5;
const t0 = Date.now();

if (!fs.existsSync(CORE)) fail('缺少 mihomo 内核: ' + CORE);
if (!fs.existsSync(path.join(DATA, 'ca-bundle.pem'))) fail('缺少 data/ca-bundle.pem（CA 包）');

step(1, TOTAL, `扫描 ${CANDIDATES.length} 个候选 IP（真实 HTTPS 实测）`);
killMihomo();
const sweep = buildSweepConfig();
console.log('候选: ' + CANDIDATES.join(', '));
if (!run(process.execPath, ['tools/verify-config.js', sweep.file, path.join(DATA, 'verify-ipsweep.json')])) {
  fail('IP 扫描失败');
}

// 解析排名
const sweepRes = JSON.parse(fs.readFileSync(path.join(DATA, 'verify-ipsweep.json'), 'utf8'));
const nameToIp = new Map(sweep.names.map((n, i) => [n, CANDIDATES[i]]));
const ranked = sweepRes.ok
  .map((o) => ({ ip: nameToIp.get(o.name), ms: o.delay }))
  .filter((x) => x.ip)
  .sort((a, b) => a.ms - b.ms);

if (!ranked.length) fail('没有任何候选 IP 可用（检查网络或候选列表）');

console.log(`\n实测排名（前 ${Math.min(10, ranked.length)}）:`);
ranked.slice(0, 10).forEach((r, i) => console.log(`  ${String(i + 1).padStart(2)}. ${r.ip.padEnd(18)} ${r.ms}ms`));

// 关键改动：**所有候选 IP 全部实测**，再用「实测延迟」选最优，而不是用扫描排名选。
//
// 为什么不能只测扫描前几名：
//   扫描阶段是单次连接测量，噪声极大。实测出现过：只测扫描前 8 名，
//   结果把上一轮 381ms 的 IP 换成了 1161ms 的，配置越维护越差。
//   候选只有十几个，全测一遍也就多花一分钟，换来的是「以真数据选 IP」。
const SCAN = Math.min(ranked.length, 16);
const scanSet = ranked.slice(0, SCAN);
step(2, TOTAL, `实测全部 ${scanSet.length} 个候选 IP（按实测延迟反选最优 ${TOP} 个）`);
console.log(scanSet.map((x) => `${x.ip} (${x.ms}ms)`).join('  ·  '));

function buildWith(set, out) {
  const ipArg = set.map((x) => `${x.ip}:${x.ms}`).join(',');
  return run(process.execPath, ['tools/build-nodes.js', out, '--ips', ipArg]);
}

const finalFile = path.join(DATA, 'clash-nodes.yaml');
if (!buildWith(scanSet, finalFile)) fail('生成配置失败');

step(3, TOTAL, '验证生成的配置（真实 HTTPS，必做）');
if (!run(process.execPath, ['tools/verify-config.js', finalFile, path.join(DATA, 'verify-final.json')])) {
  console.log('⚠️ 验证脚本返回非 0（可能有个别节点失败），继续看结果');
}
let finalRes = JSON.parse(fs.readFileSync(path.join(DATA, 'verify-final.json'), 'utf8'));
let totalNodes = finalRes.ok.length + finalRes.bad.length;
console.log(`\n验证结果: 可用 ${finalRes.ok.length}/${totalNodes}`);
if (!finalRes.ok.length) fail('生成的配置没有任何可用节点');

// ── 按实测结果反选 IP ──────────────────────────────────────
// 每个 IP 有 4 个 Worker 节点，取各节点实测延迟的中位数作为该 IP 的成绩
const yamlMod = require(path.join(ROOT, 'src', 'yaml-mini.js'));
function ipScores(res, file) {
  const doc = yamlMod.parse(fs.readFileSync(file, 'utf8'));
  const nameToIp = new Map((doc.proxies || []).map((p) => [p.name, p.server]));
  const byIp = new Map();
  for (const o of res.ok) {
    const ip = nameToIp.get(o.name);
    if (!ip) continue;
    (byIp.get(ip) || byIp.set(ip, []).get(ip)).push(o.delay);
  }
  return [...byIp.entries()]
    .map(([ip, arr]) => {
      arr.sort((a, b) => a - b);
      return { ip, ms: arr[Math.floor(arr.length / 2)], n: arr.length };
    })
    .sort((a, b) => a.ms - b.ms);
}

let scores = ipScores(finalRes, finalFile);
console.log('\n实测 IP 排名（按各 Worker 节点延迟中位数）:');
scores.slice(0, 10).forEach((s, i) => console.log(`  ${String(i + 1).padStart(2)}. ${s.ip.padEnd(18)} ${s.ms}ms  (${s.n} 个节点)`));

const best = scores.slice(0, TOP);
const chosen = new Set(best.map((b) => b.ip));
const scanned = new Set(scanSet.map((s) => s.ip));
if (chosen.size === scanned.size && [...chosen].every((x) => scanned.has(x))) {
  console.log('实测反选结果与初选一致，无需重建');
} else {
  console.log(`\n实测反选改变了选择，用更优的 ${best.length} 个 IP 重建并复验`);
  console.log('  ' + best.map((x) => `${x.ip} (${x.ms}ms)`).join('  ·  '));
  if (!buildWith(best, finalFile)) fail('重建配置失败');
  if (!run(process.execPath, ['tools/verify-config.js', finalFile, path.join(DATA, 'verify-final.json')])) {
    console.log('⚠️ 复验脚本返回非 0，继续看结果');
  }
  finalRes = JSON.parse(fs.readFileSync(path.join(DATA, 'verify-final.json'), 'utf8'));
  totalNodes = finalRes.ok.length + finalRes.bad.length;
  console.log(`\n复验结果: 可用 ${finalRes.ok.length}/${totalNodes}`);
  scores = ipScores(finalRes, finalFile);
}

const top = best;

// ── 稳定性复验：同一份配置再测一轮，两轮都通过的节点才留下 ──
// 单轮通过 ≠ 稳定。实测出现过某 IP 首轮正常、复验飙到 8440ms 的情况，
// 这种节点混进配置就是「时好时坏」，客户端健康检查会被拖垮。
console.log(`\n${'─'.repeat(60)}`);
console.log('稳定性复验（同一份配置再测一轮，两轮都通过才保留）');
console.log('─'.repeat(60));
const round2File = path.join(DATA, 'verify-round2.json');
try { run(process.execPath, ['tools/verify-config.js', finalFile, round2File]); } catch (e) { /* 下面按失败处理 */ }
let round2 = null;
try { round2 = JSON.parse(fs.readFileSync(round2File, 'utf8')); } catch (e) { round2 = null; }
if (round2 && Array.isArray(round2.ok)) {
  const pass1 = new Set(finalRes.ok.map((o) => o.name));
  const pass2 = new Set(round2.ok.map((o) => o.name));
  const stable = new Set([...pass1].filter((n) => pass2.has(n)));
  const unstable = [...pass1].filter((n) => !pass2.has(n));
  console.log(`  第1轮通过 ${pass1.size} / 第2轮通过 ${pass2.size} / 两轮均通过 ${stable.size}`);
  if (unstable.length) console.log(`  ⚠️ 不稳定、将剔除: ${unstable.join(', ')}`);
  if (!stable.size) {
    console.log('  ⚠️ 两轮没有交集（网络抖动严重），保留第1轮结果不再过滤');
  } else {
    finalRes = { ...finalRes, ok: finalRes.ok.filter((o) => stable.has(o.name)) };
    scores = ipScores(finalRes, finalFile);
  }
} else {
  console.log('  ⚠️ 第二轮结果不可用，跳过稳定性过滤');
}

// ── 关键一步：把验证失败的节点从配置里剔除 ──
// 不剔除的话，配置里会混着已知不能用的节点，客户端健康检查会白费力气
const yaml = require(path.join(ROOT, 'src', 'yaml-mini.js'));
const doc = yaml.parse(fs.readFileSync(finalFile, 'utf8'));
const okNames = new Set(finalRes.ok.map((o) => o.name));
const kept = (doc.proxies || []).filter((p) => okNames.has(p.name));
const dropped = (doc.proxies || []).filter((p) => !okNames.has(p.name));
if (dropped.length) {
  console.log(`剔除验证失败的 ${dropped.length} 个节点: ${dropped.map((p) => p.name).join(', ')}`);

  const esc = (v) => (typeof v === 'boolean' || typeof v === 'number')
    ? String(v)
    : (/^[A-Za-z0-9._/=+-]+$/.test(String(v)) && !/^(true|false|null|yes|no|on|off)$/i.test(String(v)) ? String(v) : JSON.stringify(String(v)));

  const lines = [];
  // 头部注释沿用原配置
  for (const l of fs.readFileSync(finalFile, 'utf8').split('\n')) {
    if (l.startsWith('#')) lines.push(l); else break;
  }
  lines.push('#', `# 已剔除验证失败的节点（原始 ${doc.proxies.length} 个 -> 保留 ${kept.length} 个）`, '');
  lines.push('mixed-port: 7890', 'allow-lan: false', 'mode: rule', 'log-level: warning', 'ipv6: true', 'unified-delay: true', 'tcp-concurrent: true', '');
  lines.push('profile:', '  store-selected: true', '  store-fake-ip: true', '');
  lines.push('dns:', '  enable: true', '  ipv6: false', '  enhanced-mode: fake-ip', '  fake-ip-range: 198.18.0.1/16');
  lines.push('  default-nameserver:', '    - 223.5.5.5', '    - 119.29.29.29');
  lines.push('  nameserver:', '    - https://doh.pub/dns-query', '    - https://dns.alidns.com/dns-query', '');
  lines.push('proxies:');
  for (const p of kept) {
    lines.push(`  - name: ${esc(p.name)}`);
    for (const [k, v] of Object.entries(p)) {
      if (k === 'name') continue;
      if (v && typeof v === 'object') {
        lines.push(`    ${k}:`);
        for (const [k2, v2] of Object.entries(v)) {
          if (v2 && typeof v2 === 'object') {
            lines.push(`      ${k2}:`);
            for (const [k3, v3] of Object.entries(v2)) lines.push(`        ${k3}: ${esc(v3)}`);
          } else lines.push(`      ${k2}: ${esc(v2)}`);
        }
      } else lines.push(`    ${k}: ${esc(v)}`);
    }
  }
  lines.push('');
  lines.push('proxy-groups:');
  lines.push('  - name: "🚀 代理"', '    type: select', '    proxies:', '      - "⚡ 自动选择"');
  const tags = [...new Set(kept.map((p) => String(p.name).split('-')[0]))];
  for (const t of tags) lines.push(`      - "${t}"`);
  lines.push('      - DIRECT', '');
  lines.push('  - name: "⚡ 自动选择"', '    type: url-test', '    url: http://www.gstatic.com/generate_204', '    interval: 180', '    tolerance: 100', '    proxies:');
  for (const p of kept) lines.push('      - ' + JSON.stringify(p.name));
  for (const t of tags) {
    const sub = kept.filter((p) => String(p.name).startsWith(t + '-'));
    if (!sub.length) continue;
    lines.push('', `  - name: "${t}"`, '    type: url-test', '    url: http://www.gstatic.com/generate_204', '    interval: 180', '    tolerance: 100', '    proxies:');
    for (const p of sub) lines.push('      - ' + JSON.stringify(p.name));
  }
  lines.push('', 'rules:', '  - DOMAIN-SUFFIX,cn,DIRECT', '  - DOMAIN-KEYWORD,baidu,DIRECT', '  - GEOIP,CN,DIRECT,no-resolve', '  - MATCH,🚀 代理', '');
  fs.writeFileSync(finalFile, lines.join('\n'));
  console.log(`已重写配置: 保留 ${kept.length} 个实测通过的节点`);

  // 重新生成 base64 订阅
  const uris = kept.map((p) => {
    const q = new URLSearchParams();
    q.set('encryption', 'none'); q.set('security', 'none'); q.set('type', 'ws');
    q.set('host', (p['ws-opts'] && p['ws-opts'].headers && p['ws-opts'].headers.Host) || '');
    q.set('path', (p['ws-opts'] && p['ws-opts'].path) || '/');
    return `vless://${p.uuid}@${p.server}:${p.port}?${q.toString()}#${encodeURIComponent(p.name)}`;
  });
  fs.writeFileSync(finalFile.replace(/\.yaml$/, '.sub.txt'), Buffer.from(uris.join('\n'), 'utf8').toString('base64'));
}

// ── 收尾：刷新各客户端格式 ─────────────────────────────────
// 保证 Clash / base64 订阅 / sing-box JSON 三种格式永远是同一批节点
step(4, TOTAL, '生成各客户端格式');
const rs = spawnSync(process.execPath, [path.join(__dirname, 'build-subscription.js'), finalFile, DIST], { encoding: 'utf8' });
if (rs.status !== 0) console.log('⚠️ 多格式生成失败:\n' + (rs.stderr || rs.stdout || '').slice(0, 400));
else console.log('已生成 base64 订阅 / sing-box JSON / 链接清单');

step(5, TOTAL, '完成');
console.log(`总耗时 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
console.log(`最快 IP: ${(scores[0] && scores[0].ip) || top[0].ip} (${(scores[0] && scores[0].ms) || top[0].ms}ms，最终复验值)`);
console.log(`最终 IP 实测排名: ${scores.map((s) => `${s.ip}=${s.ms}ms`).join('  ')}`);
console.log(`\n输出目录: ${DIST}`);
console.log(`  ClashMeta-FlClash.yaml          → Clash Meta / FlClash`);
console.log(`  通用订阅-base64.txt              → v2rayng / Nekoray / Hiddify`);
console.log(`  Hiddify-Nekoray-singbox.json    → Hiddify / Nekoray`);
console.log(`  节点链接.txt                     → 手动导入`);
