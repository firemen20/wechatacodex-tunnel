// 多格式产物的往返一致性校验
//
// 为什么需要：
//   生成是一回事，「各客户端解析回来是不是同一个节点」是另一回事。
//   这类错误（字段名写错、base64 编码错、主机头丢字段）肉眼看不出来，
//   但到了客户端就是连不上。
//
// 校验项：
//   1. base64 订阅 → 解码 → 逐条 parseUri → 与原节点逐字段比对
//   2. sing-box JSON → 逐字段比对 server/port/uuid/transport
//   3. Clash YAML → 字段比对 + 交给 mihomo -t 做语法/语义校验
'use strict';
const fs = require('fs');
const path = require('path');
const yaml = require('../src/yaml-mini');
const N = require('../src/nodes');

const ROOT = path.join(__dirname, '..');
const cfg = require('../src/config').load();
const DIR = process.argv[2] || cfg.distDir;
const SRC = path.join(DIR, 'ClashMeta-FlClash.yaml');

let fail = 0;
function ok(cond, msg) {
  console.log(`   ${cond ? '✅' : '❌'} ${msg}`);
  if (!cond) fail++;
}

// ── 基准：源 Clash YAML ─────────────────────────────────────
const doc = yaml.parse(fs.readFileSync(SRC, 'utf8'));
const base = doc.proxies.map((p) => N.fromClash(p)).filter(Boolean);
console.log(`基准节点数: ${base.length}（来自 ${path.basename(SRC)}）`);
// 注意：4 个 Worker 共用同一批 IP:端口，所以键必须带上 Host，
// 否则会拿 worker-a 的节点去比 worker-b 的（第一版就是这么误报的）
const key = (n) => `${n.server}:${n.port}|${n.wsHost || ''}`;

// ── 1. base64 订阅往返 ─────────────────────────────────────
console.log('\n[1] base64 订阅 → 解析回来');
const b64txt = fs.readFileSync(path.join(DIR, '通用订阅-base64.txt'), 'utf8').trim();
const decoded = Buffer.from(b64txt, 'base64').toString('utf8');
const uriLines = decoded.split('\n').map((s) => s.trim()).filter(Boolean);
ok(uriLines.length === base.length, `条数一致: 订阅 ${uriLines.length} / 基准 ${base.length}`);

const back = uriLines.map((u) => N.parseUri(u)).filter(Boolean);
ok(back.length === uriLines.length, `全部可解析: ${back.length}/${uriLines.length}`);

let mismatch = 0;
for (const b of base) {
  const m = back.find((x) => key(x) === key(b));
  if (!m) { console.log(`   缺少 ${key(b)}`); mismatch++; continue; }
  const bad = [];
  if (m.uuid !== b.uuid) bad.push('uuid');
  if (m.network !== b.network) bad.push(`network(${m.network}≠${b.network})`);
  if (!!m.tls !== !!b.tls) bad.push(`tls(${m.tls}≠${b.tls})`);
  if ((m.wsHost || '') !== (b.wsHost || '')) bad.push(`wsHost(${m.wsHost}≠${b.wsHost})`);
  if ((m.wsPath || '') !== (b.wsPath || '')) bad.push(`wsPath(${m.wsPath}≠${b.wsPath})`);
  if (bad.length) { console.log(`   ${key(b)} 字段不符: ${bad.join(', ')}`); mismatch++; }
}
ok(mismatch === 0, `逐字段比对: ${base.length - mismatch}/${base.length} 完全一致`);

// ── 2. sing-box JSON ──────────────────────────────────────
console.log('\n[2] sing-box JSON 出站');
const sb = JSON.parse(fs.readFileSync(path.join(DIR, 'Hiddify-Nekoray-singbox.json'), 'utf8'));
const sbNodes = sb.outbounds.filter((o) => o.type === 'vless');
ok(sbNodes.length === base.length, `出站节点数: ${sbNodes.length} / ${base.length}`);

let sbBad = 0;
for (const b of base) {
  const o = sbNodes.find((x) => `${x.server}:${x.server_port}|${(x.transport && x.transport.headers && x.transport.headers.Host) || ""}` === key(b));
  if (!o) { console.log(`   缺少 ${key(b)}`); sbBad++; continue; }
  const bad = [];
  if (o.uuid !== b.uuid) bad.push('uuid');
  if (!o.transport || o.transport.type !== 'ws') bad.push('transport≠ws');
  else {
    if (o.transport.path !== b.wsPath) bad.push(`path(${o.transport.path}≠${b.wsPath})`);
    const h = (o.transport.headers || {}).Host;
    if (h !== b.wsHost) bad.push(`Host(${h}≠${b.wsHost})`);
  }
  if (bad.length) { console.log(`   ${key(b)} 字段不符: ${bad.join(', ')}`); sbBad++; }
}
ok(sbBad === 0, `逐字段比对: ${base.length - sbBad}/${base.length} 完全一致`);

// 策略组引用完整性
const tags = new Set(sb.outbounds.map((o) => o.tag));
let refBad = [];
for (const o of sb.outbounds) {
  if (o.type === 'selector' || o.type === 'urltest') {
    for (const t of o.outbounds) if (!tags.has(t)) refBad.push(`${o.tag} → ${t}`);
  }
}
ok(refBad.length === 0, `策略组引用完整${refBad.length ? ': ' + refBad.join(', ') : ''}`);
ok(!!sb.route && !!sb.route.final && tags.has(sb.route.final), `route.final="${sb.route && sb.route.final}" 存在`);

// ── 3. Clash YAML 交 mihomo -t ────────────────────────────
console.log('\n[3] ClashMeta-FlClash.yaml 交 mihomo -t');
const { spawnSync } = require('child_process');
// 内核与 verify-config.js 用同一套探测逻辑（--core / MIHOMO / data/mihomo / PATH）
function findCore() {
  const i = process.argv.indexOf('--core');
  for (const c of [i >= 0 ? process.argv[i + 1] : null, process.env.MIHOMO, path.join(ROOT, 'data', 'mihomo')]) {
    if (!c) continue;
    try { const t = spawnSync(c, ['-v'], { encoding: 'utf8' }); if (t.status === 0 || t.stdout || t.stderr) return c; } catch (e) { /* 下一个 */ }
  }
  return path.join(ROOT, 'data', 'mihomo');
}
const CORE = findCore();
const r = spawnSync(CORE, ['-d', path.join(ROOT, 'data'), '-t', '-f', SRC], { encoding: 'utf8' });
const tail = (r.stdout || '').trim().split('\n').slice(-1)[0] || (r.error ? String(r.error.message) : '');
ok(/successful/i.test(tail) || /successful/i.test(r.stdout || ''), `mihomo -t: ${tail.slice(0, 110)}`);

console.log('');
console.log(fail === 0 ? `✅ 全部校验通过` : `❌ ${fail} 项校验失败`);
process.exit(fail === 0 ? 0 : 1);
