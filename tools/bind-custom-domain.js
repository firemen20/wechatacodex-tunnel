// 把 Worker 绑定到自定义域名（Workers Custom Domain）
//
// 用途：*.workers.dev 在国内被 SNI 阻断，只有绑上自定义域名才能用加密的 443。
//
// 前置条件：
//   - 域名（zone）必须在本账号下，且状态为 active
//   - token 需要 Workers Custom Domains 写权限
//
// 用法:
//   CF_API_TOKEN=xxx CF_ACCOUNT_ID=yyy node tools/bind-custom-domain.js <域名> <worker名> [更多worker...]
//   例: node tools/bind-custom-domain.js example.com my-worker-a my-worker-b
//       → 会分配 my-worker-a.<域名> 和 my-worker-b.<域名>
//
//   --prefix <前缀>   所有 worker 共用一个前缀，用序号区分（例：--prefix node → node1.x.com, node2.x.com）
//   --list            只列出当前已绑定的自定义域名
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CA = path.join(ROOT, 'data', 'ca-bundle.pem');
const PROXY = process.env.CF_PROXY || 'http://127.0.0.1:7896';
const TOKEN = process.env.CF_API_TOKEN || '';
const ACC = process.env.CF_ACCOUNT_ID || '';
const API = 'https://api.cloudflare.com/client/v4';

if (!TOKEN || !ACC) { console.error('需要 CF_API_TOKEN / CF_ACCOUNT_ID'); process.exit(1); }

function req(method, p, body) {
  const args = ['-sS', '-m', '60', '--cacert', CA, '-x', PROXY, '-X', method, API + p,
    '-H', `Authorization: Bearer ${TOKEN}`];
  if (body) args.push('-H', 'Content-Type: application/json', '-d', JSON.stringify(body));
  const r = spawnSync('curl', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  try { return JSON.parse(r.stdout); } catch (e) { return { success: false, errors: [{ message: (r.stdout || r.stderr || '').slice(0, 160) }] }; }
}

// ── --list：列出已绑定的自定义域名 ──
if (process.argv.includes('--list')) {
  const j = req('GET', `/accounts/${ACC}/workers/domains`);
  console.log('=== 已绑定的 Worker 自定义域名 ===');
  if (!j.success) { console.log('  ❌ ' + JSON.stringify(j.errors).slice(0, 200)); process.exit(1); }
  if (!(j.result || []).length) { console.log('  （无）'); process.exit(0); }
  for (const d of j.result) console.log(`  ${d.hostname.padEnd(38)} → ${d.service.padEnd(24)} 环境=${d.environment}`);
  process.exit(0);
}

// ⚠️ --prefix 的「值」也是不带 -- 的普通参数，会被 filter 留下来当成 Worker 名。
// 之前就踩过：--prefix n 时 workers 变成 [...,'n']，多绑了一个不存在的 Worker。
const pi = process.argv.indexOf('--prefix');
const prefix = pi >= 0 ? process.argv[pi + 1] : '';
const args = process.argv.slice(2).filter((a) => !a.startsWith('--') && a !== prefix);
const zoneName = args[0];
const workers = args.slice(1);

if (!zoneName || !workers.length) {
  console.error('用法: node tools/bind-custom-domain.js <域名> <worker名> [更多worker...] [--prefix 前缀]');
  process.exit(1);
}

// ── 1. 找 zone ──
const zj = req('GET', `/zones?name=${encodeURIComponent(zoneName)}`);
if (!zj.success || !(zj.result || []).length) {
  console.error(`❌ 账号下找不到域名 ${zoneName}`);
  console.error('   （自定义域名必须和 Worker 在同一个账号下）');
  console.error('   错误: ' + JSON.stringify(zj.errors || '').slice(0, 160));
  process.exit(1);
}
const zone = zj.result[0];
console.log(`✅ 找到域名: ${zone.name}   状态=${zone.status}   zone_id=${zone.id}`);
if (zone.status !== 'active') {
  console.log(`⚠️ 域名状态是 ${zone.status}（不是 active）。自定义域名可能无法立即生效，`);
  console.log('   通常需要等 NS 委派生效后 CF 才会把它标为 active。');
}

// ── 2. 逐个绑定 ──
console.log('');
let okCount = 0;
for (let i = 0; i < workers.length; i++) {
  const w = workers[i];
  const hostname = prefix ? `${prefix}${i + 1}.${zoneName}` : `${w}.${zoneName}`;
  const existing = req('GET', `/accounts/${ACC}/workers/domains`);
  const already = (existing.result || []).find((d) => d.hostname === hostname);
  if (already) {
    console.log(`  ↷ ${hostname.padEnd(38)} 已存在（→ ${already.service}），跳过`);
    okCount++;
    continue;
  }
  const r = req('POST', `/accounts/${ACC}/workers/domains`, {
    environment: 'production', hostname, service: w, zone_id: zone.id,
  });
  if (r.success) {
    console.log(`  ✅ ${hostname.padEnd(38)} → ${w}`);
    okCount++;
  } else {
    console.log(`  ❌ ${hostname.padEnd(38)} ${JSON.stringify(r.errors).slice(0, 120)}`);
  }
}

console.log(`\n完成: ${okCount}/${workers.length}`);
if (okCount) {
  console.log('\n下一步：绑定后 CF 会自动签发证书（几分钟）。然后用这个命令验证：');
  console.log(`  node tools/verify-https.js <配置> <输出>`);
}
