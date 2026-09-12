// 启动本地代理：用聚合优选出来的节点跑一个 mihomo 实例，供后续访问被 SNI 阻断的接口（如 api.cloudflare.com）
// 用法: node tools/proxy-start.js [配置来源] [端口]
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const net = require('net');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const HOME = path.join(DATA, 'mihomo-home');
const CORE = path.join(DATA, 'mihomo');

const src = process.argv[2] || path.join(DATA, 'clash-final.yaml');
const PORT = parseInt(process.argv[3] || '7899', 10);
const API_PORT = PORT + 1;   // 避开 9090（已被本机其它服务占用）

function buildProxyConfig(text) {
  let lines = text.split('\n');
  // 无头环境没有 geoip 数据库，去掉 GEOIP 规则
  lines = lines.filter((l) => !/^\s*-\s*GEOIP,/i.test(l));
  let out = lines.join('\n');
  out = out.replace(/^mixed-port:.*$/m, `mixed-port: ${PORT}`);
  // 把默认代理组改成 url-test，自动选一个活着的节点，避免选到已死节点
  out = out.replace(/- name: "🚀 代理"\n    type: select\n/, '- name: "🚀 代理"\n    type: url-test\n    url: http://www.gstatic.com/generate_204\n    interval: 120\n    tolerance: 50\n');
  // 清掉指向 select 组的组内引用（url-test 组不能引用组名）
  out = out.replace(/(\n\s+- "⚡ 自动选择")/g, '');
  out = out.replace(/\n\s+- "🇭🇰 香港"/g, '').replace(/\n\s+- "🇯🇵 日本"/g, '')
    .replace(/\n\s+- "🇸🇬 新加坡"/g, '').replace(/\n\s+- "🇺🇸 美国"/g, '');
  out += `\nexternal-controller: 127.0.0.1:${API_PORT}\nsecret: ""\n`;
  return out;
}

function waitPort(port, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    (function tryOnce() {
      const s = net.connect(port, '127.0.0.1');
      s.once('connect', () => { s.destroy(); resolve(true); });
      s.once('error', () => {
        s.destroy();
        if (Date.now() - t0 > timeoutMs) return resolve(false);
        setTimeout(tryOnce, 400);
      });
    })();
  });
}

(async () => {
  if (!fs.existsSync(CORE)) { console.error('缺少 mihomo 内核'); process.exit(1); }
  if (!fs.existsSync(src)) { console.error('缺少配置: ' + src); process.exit(1); }
  fs.mkdirSync(HOME, { recursive: true });
  const cfgPath = path.join(HOME, 'proxy-config.yaml');
  fs.writeFileSync(cfgPath, buildProxyConfig(fs.readFileSync(src, 'utf8')));

  // 预检
  const chk = require('child_process').spawnSync(CORE, ['-t', '-d', HOME, '-f', cfgPath], { encoding: 'utf8' });
  const chkOut = (chk.stdout || '') + (chk.stderr || '');
  if (!/test is successful/.test(chkOut)) {
    console.error('❌ 代理配置预检失败:\n' + chkOut.split('\n').slice(-6).join('\n'));
    process.exit(1);
  }

  console.log(`启动 mihomo 代理 (mixed-port ${PORT}, api ${API_PORT})`);
  const child = spawn(CORE, ['-d', HOME, '-f', cfgPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));

  const ok = await waitPort(PORT, 25000);
  if (!ok) {
    console.error('❌ 代理端口未就绪:\n' + log.split('\n').slice(-10).join('\n'));
    child.kill('SIGKILL');
    process.exit(1);
  }
  console.log(`✅ 代理就绪: http://127.0.0.1:${PORT}`);
  console.log(`   用法: curl -x http://127.0.0.1:${PORT} https://api.cloudflare.com/...`);

  // 保持存活
  process.on('SIGTERM', () => { child.kill('SIGKILL'); process.exit(0); });
  child.on('exit', (c) => { console.log('mihomo 退出，code=' + c); process.exit(1); });
})();
