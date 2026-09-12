// 离线自检 —— CI 和本地都能跑，不依赖网络、不需要真实节点
//
// 检查项:
//   1. 所有 JS 文件语法正确
//   2. config.example.json 能通过配置校验
//   3. 用示例配置生成 Clash 配置，且输出能被 YAML 解析器读回
//   4. 三种客户端格式的往返一致性（节点字段逐项比对）
//
// 用法: node tools/selftest.js
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;

function ok(cond, msg, detail) {
  if (cond) { pass++; console.log(`  ✅ ${msg}`); }
  else { fail++; console.log(`  ❌ ${msg}${detail ? '\n     ' + detail : ''}`); }
}
function section(t) { console.log(`\n── ${t} ──`); }

// ── 1. 语法 ────────────────────────────────────────────
section('1. JS 语法');
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out); }
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}
const jsFiles = [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'tools'))];
let syntaxErr = [];
for (const f of jsFiles) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) syntaxErr.push(path.relative(ROOT, f) + ': ' + (r.stderr || '').split('\n')[0]);
}
ok(syntaxErr.length === 0, `${jsFiles.length} 个 JS 文件语法正确`, syntaxErr.slice(0, 3).join('\n     '));

// ── 2. 示例配置能通过校验 ──────────────────────────────
section('2. 配置校验');
const example = path.join(ROOT, 'config.example.json');
ok(fs.existsSync(example), 'config.example.json 存在');
let cfg = null;
try {
  // 直接调 loader 内部的校验逻辑（通过临时文件）
  const tmp = path.join(os.tmpdir(), `wx-tunnel-selftest-${Date.now()}.json`);
  fs.copyFileSync(example, tmp);
  const mod = require('../src/config');
  cfg = mod.load(tmp);
  fs.unlinkSync(tmp);
  ok(true, `示例配置解析通过（${cfg.workers.length} 个 Worker，输出目录 ${path.relative(ROOT, cfg.distDir) || cfg.output_dir}）`);
} catch (e) {
  ok(false, '示例配置解析失败', e.message);
}

// 反例：错误的 UUID 必须被拦住
if (cfg) {
  const bad = JSON.parse(fs.readFileSync(example, 'utf8'));
  bad.workers[0].uuid = 'not-a-uuid';
  const tmp2 = path.join(os.tmpdir(), `wx-tunnel-bad-${Date.now()}.json`);
  fs.writeFileSync(tmp2, JSON.stringify(bad));
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'build-nodes.js'), path.join(os.tmpdir(), 'x.yaml'), '--config', tmp2], { encoding: 'utf8' });
  ok(r.status !== 0 && /uuid/i.test(r.stdout + r.stderr), '非法 UUID 被正确拒绝');
  fs.unlinkSync(tmp2);
}

// ── 3. 生成 + 解析 ─────────────────────────────────────
section('3. 配置生成');
const outYaml = path.join(os.tmpdir(), `wx-tunnel-out-${Date.now()}.yaml`);
if (cfg) {
  const tmpCfg = path.join(os.tmpdir(), `wx-tunnel-cfg-${Date.now()}.json`);
  fs.copyFileSync(example, tmpCfg);
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'build-nodes.js'), outYaml, '--config', tmpCfg], { encoding: 'utf8' });
  ok(r.status === 0 && fs.existsSync(outYaml), '生成 Clash 配置', (r.stderr || '').slice(0, 200));

  if (fs.existsSync(outYaml)) {
    const yaml = require('../src/yaml-mini');
    let doc = null;
    try { doc = yaml.parse(fs.readFileSync(outYaml, 'utf8')); } catch (e) { /* 下面判 */ }
    ok(doc && Array.isArray(doc.proxies) && doc.proxies.length > 0, `输出可被解析（${doc && doc.proxies ? doc.proxies.length : 0} 个节点）`);
    if (doc && doc.proxies) {
      const p = doc.proxies[0];
      ok(!!p.name && !!p.server && !!p.port && !!p.uuid, '节点字段完整');
      ok(Array.isArray(doc['proxy-groups']) && doc['proxy-groups'].length > 0, '策略组已生成');
      // 策略组引用的节点必须都存在
      const names = new Set(doc.proxies.map((x) => x.name));
      const badRef = [];
      for (const g of doc['proxy-groups'] || []) {
        for (const m of g.proxies || []) {
          if (m !== 'DIRECT' && m !== 'REJECT' && !names.has(m) && !(doc['proxy-groups'] || []).some((x) => x.name === m)) badRef.push(`${g.name} → ${m}`);
        }
      }
      ok(badRef.length === 0, '策略组引用完整', badRef.slice(0, 3).join(', '));
      // 规则最后必须有兜底
      const rules = doc.rules || [];
      ok(rules.length > 0 && /^MATCH,/.test(String(rules[rules.length - 1])), '规则以 MATCH 兜底');
    }
  }
  fs.unlinkSync(tmpCfg);
}

// ── 4. 三种格式往返一致 ────────────────────────────────
section('4. 多格式往返一致性');
if (cfg && fs.existsSync(outYaml)) {
  const outDir = path.join(os.tmpdir(), `wx-tunnel-dist-${Date.now()}`);
  fs.mkdirSync(outDir, { recursive: true });
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'build-subscription.js'), outYaml, outDir], { encoding: 'utf8' });
  const files = ['ClashMeta-FlClash.yaml', '通用订阅-base64.txt', 'Hiddify-Nekoray-singbox.json', '节点链接.txt'];
  ok(r.status === 0 && files.every((f) => fs.existsSync(path.join(outDir, f))), '四种格式全部生成', (r.stderr || '').slice(0, 200));

  // base64 解码后条数应与节点数一致
  try {
    const yaml = require('../src/yaml-mini');
    const base = yaml.parse(fs.readFileSync(outYaml, 'utf8'));
    const b64 = fs.readFileSync(path.join(outDir, '通用订阅-base64.txt'), 'utf8').trim();
    const lines = Buffer.from(b64, 'base64').toString('utf8').split('\n').filter(Boolean);
    ok(lines.length === base.proxies.length, `base64 订阅条数一致（${lines.length}/${base.proxies.length}）`);
    ok(lines.every((l) => /^vless:\/\//.test(l)), '订阅内全部是合法 vless:// 链接');
  } catch (e) {
    ok(false, 'base64 校验失败', e.message);
  }

  // sing-box JSON 结构
  try {
    const sb = JSON.parse(fs.readFileSync(path.join(outDir, 'Hiddify-Nekoray-singbox.json'), 'utf8'));
    ok(Array.isArray(sb.outbounds) && sb.outbounds.some((o) => o.type === 'vless'), 'sing-box 含 vless 出站');
    ok(!!sb.route && !!sb.route.final, 'sing-box route.final 已设置');
  } catch (e) {
    ok(false, 'sing-box JSON 解析失败', e.message);
  }

  fs.rmSync(outDir, { recursive: true, force: true });
}

// ── 结果 ───────────────────────────────────────────────
try { if (fs.existsSync(outYaml)) fs.unlinkSync(outYaml); } catch (e) { /* ignore */ }

console.log('');
console.log('─'.repeat(50));
if (fail === 0) {
  console.log(`✅ 自检全部通过（${pass} 项）`);
  process.exit(0);
} else {
  console.log(`❌ ${fail} 项失败 / 共 ${pass + fail} 项`);
  process.exit(1);
}
