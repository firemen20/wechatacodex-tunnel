// 真实 HTTPS 可用性验证（业界最可信的判定方式）
//
// 为什么不用 mihomo 的 /delay 接口：
//   实测发现 mihomo 的 HTTPS 延迟测试在本机环境下对**所有**节点都报
//   "An error occurred in the delay test"，而同样节点用 curl 走同一个 mihomo
//   代理端口发真实 HTTPS 请求却完全正常 —— 说明是这个测速接口自身有问题，不能作为判据。
//   （根因大概率是 Android 上没有 /etc/ssl/certs，Go 的证书池为空；SSL_CERT_FILE 也未能救活该路径）
//
// 做法：在配置里加一个包含全部节点的 select 组，逐个切换后用 curl 经代理端口
//       发真实 HTTPS 请求。慢一些，但这是唯一可信的口径。
//
// 用法: node tools/verify-https.js <候选配置> <输出json> [--url https://...] [--conc 1]
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');
// 内核：优先 --core 参数 → 环境变量 MIHOMO → data/mihomo → PATH 里的 mihomo/mihomo.exe
function findCore() {
  const i = process.argv.indexOf('--core');
  const cands = [i >= 0 ? process.argv[i + 1] : null, process.env.MIHOMO, path.join(DATA, 'mihomo'), 'mihomo'];
  for (const c of cands) {
    if (!c) continue;
    try { require('child_process').execFileSync(c, ['-v'], { stdio: 'ignore' }); return c; } catch (e) { /* 试下一个 */ }
  }
  console.error('❌ 找不到内核。请下载 mihomo 放到 data/mihomo，或用 --core <路径> 指定。');
  console.error('   下载: https://github.com/MetaCubeX/mihomo/releases');
  process.exit(1);
}
const CORE = findCore();
// CA：优先 data/ca-bundle.pem；缺失时由系统证书目录合成（Android/Termux 的 curl 默认锚点常是坏的）
function findCA() {
  const p = path.join(DATA, 'ca-bundle.pem');
  if (fs.existsSync(p)) return p;
  try {
    const dir = '/system/etc/security/cacerts';
    if (fs.existsSync(dir)) {
      const parts = fs.readdirSync(dir).map((f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch (e) { return ''; } });
      fs.mkdirSync(DATA, { recursive: true });
      fs.writeFileSync(p, parts.join('\n'));
      return p;
    }
  } catch (e) { /* 用系统默认 */ }
  return null;
}
const CA = findCA();
const HOME = path.join(DATA, 'mihomo-https');
const MIXED_PORT = 7897;
const API_PORT = 19876;
const API = `http://127.0.0.1:${API_PORT}`;

const cfgFile = process.argv[2] || path.join(DATA, 'valid-candidates.yaml');
const outFile = process.argv[3] || path.join(DATA, 'verify-https.json');
const TEST_URL = process.env.VERIFY_URL || 'https://www.gstatic.com/generate_204';
const TIMEOUT = parseInt(process.env.VERIFY_TIMEOUT || '10', 10);
const GROUP = 'HTTPS-TEST';

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const URLS = arg('url', TEST_URL).split(',');

function buildConfig(text) {
  // 从第一个 proxy-groups:/rules: 处截断（不能只删顶层那一行，否则缩进的规则条目会残留成孤儿）
  const all = text.split('\n');
  let cut = all.length;
  for (let i = 0; i < all.length; i++) {
    if (/^(proxy-groups|rules):/.test(all[i])) { cut = i; break; }
  }
  let t = all.slice(0, cut).join('\n');
  t = t.replace(/^mixed-port:.*$/m, `mixed-port: ${MIXED_PORT}`);
  // 收集所有节点名
  const names = [];
  for (const m of t.matchAll(/^\s*-\s*name:\s*(.+?)\s*$/gm)) names.push(m[1].replace(/^["']|["']$/g, ''));
  const g = ['proxy-groups:', `  - name: "${GROUP}"`, '    type: select', '    proxies:'];
  for (const n of names) g.push('      - ' + JSON.stringify(n));
  g.push('', 'rules:', `  - MATCH,${GROUP}`, '');
  // 必须显式写 external-controller，否则 API 不监听，脚本会误判内核没起来
  g.push('', `external-controller: 127.0.0.1:${API_PORT}`, 'secret: ""', '');
  return { text: t + '\n' + g.join('\n'), names };
}

function api(pathname, method = 'GET', body = null, timeout = 8000) {
  const args = ['-sS', '-m', String(Math.ceil(timeout / 1000)), '-X', method, API + pathname];
  if (body) { args.push('-H', 'Content-Type: application/json', '-d', JSON.stringify(body)); }
  const r = spawnSync('curl', args, { encoding: 'utf8' });
  return r.stdout || '';
}

function curlThroughProxy(url, timeoutSec) {
  const t0 = Date.now();
  const r = spawnSync('curl', [
    '-sS', '-m', String(timeoutSec), '--cacert', CA,
    '-x', `http://127.0.0.1:${MIXED_PORT}`,
    '-o', '/dev/null', '-w', '%{http_code}',
    url,
  ], { encoding: 'utf8' });
  const code = parseInt((r.stdout || '').trim(), 10) || 0;
  return { ok: code >= 200 && code < 400, code, ms: Date.now() - t0, err: (r.stderr || '').trim().split('\n').pop() || '' };
}

function waitApi(maxMs = 25000) {
  const t0 = Date.now();
  return new Promise((resolve) => {
    (function tick() {
      const v = api('/version', 'GET', null, 2000);
      if (v.includes('"meta"')) return resolve(true);
      if (Date.now() - t0 > maxMs) return resolve(false);
      setTimeout(tick, 500);
    })();
  });
}

(async () => {
  if (!fs.existsSync(cfgFile)) { console.error('找不到配置: ' + cfgFile); process.exit(1); }
  fs.mkdirSync(HOME, { recursive: true });
  const { text, names } = buildConfig(fs.readFileSync(cfgFile, 'utf8'));
  const cfgPath = path.join(HOME, 'config.yaml');
  fs.writeFileSync(cfgPath, text);

  const chk = spawnSync(CORE, ['-t', '-d', HOME, '-f', cfgPath], { encoding: 'utf8' });
  if (!/test is successful/.test((chk.stdout || '') + (chk.stderr || ''))) {
    console.error('❌ 配置预检失败:\n' + ((chk.stdout || '') + (chk.stderr || '')).split('\n').slice(-5).join('\n'));
    process.exit(1);
  }

  console.log(`启动 mihomo（HTTPS 验证模式）: ${names.length} 个节点`);
  console.log(`判定 URL: ${URLS.join(' , ')}`);
  const child = spawn(CORE, ['-d', HOME, '-f', cfgPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, SSL_CERT_FILE: CA },
  });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));

  if (!(await waitApi())) {
    console.error('❌ mihomo 未就绪:\n' + log.split('\n').slice(-8).join('\n'));
    child.kill('SIGKILL');
    process.exit(1);
  }

  const t0 = Date.now();
  const results = [];
  let done = 0;
  let okCount = 0;

  for (const name of names) {
    // 切换选择器到该节点
    api(`/proxies/${encodeURIComponent(GROUP)}`, 'PUT', { name });
    let best = null;
    for (const u of URLS) {
      const r = curlThroughProxy(u, TIMEOUT);
      if (!best || r.ms < best.ms) best = { ...r, url: u };
      if (r.ok) break;
    }
    results.push({ name, ok: best.ok, ms: best.ok ? best.ms : 0, code: best.code, url: best.url, err: best.ok ? '' : best.err });
    if (best.ok) okCount++;
    done++;
    if (done % 5 === 0) process.stderr.write(`\r进度 ${done}/${names.length}  可用 ${okCount}  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
  process.stderr.write('\n');

  child.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 500));
  try { child.kill('SIGKILL'); } catch (e) { /* ignore */ }

  const ok = results.filter((r) => r.ok).sort((a, b) => a.ms - b.ms);
  console.log(`\n──────── 真实 HTTPS 验证结果（${((Date.now() - t0) / 1000).toFixed(0)}s）────────`);
  console.log(`可用 ${ok.length} / ${results.length}`);
  console.log('\n可用节点（按延迟）:');
  for (const r of ok.slice(0, 30)) console.log(`  ${String(r.ms + 'ms').padStart(7)}  ${r.name}`);

  fs.writeFileSync(outFile, JSON.stringify({
    generated: new Date().toISOString(),
    method: 'curl 经 mihomo 代理发真实 HTTPS 请求（非 /delay 接口）',
    testUrls: URLS,
    ok: ok.map((r) => ({ name: r.name, delay: r.ms, code: r.code })),
    bad: results.filter((r) => !r.ok),
  }, null, 1));
  console.log(`\n输出: ${outFile}`);
})().catch((e) => { console.error('❌ ' + (e.stack || e.message)); process.exit(1); });
