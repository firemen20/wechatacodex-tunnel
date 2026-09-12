// 节点归一化：URI(vless/vmess/trojan/ss/hysteria2) <-> Clash proxy 对象互转 + 去重键
'use strict';

function b64decode(s) {
  s = String(s).trim().replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64').toString('utf8');
}
function b64encode(s) {
  return Buffer.from(s, 'utf8').toString('base64');
}
function safeDecodeURIComponent(s) {
  try { return decodeURIComponent(s); } catch (e) { return s; }
}
function stripFragment(uri) {
  const i = uri.indexOf('#');
  return i < 0 ? { main: uri, name: '' } : { main: uri.slice(0, i), name: safeDecodeURIComponent(uri.slice(i + 1)) };
}
function parseQuery(q) {
  const out = {};
  if (!q) return out;
  for (const part of q.split('&')) {
    if (!part) continue;
    const i = part.indexOf('=');
    const k = i < 0 ? part : part.slice(0, i);
    const v = i < 0 ? '' : safeDecodeURIComponent(part.slice(i + 1));
    out[k] = v;
  }
  return out;
}

const TRUEISH = new Set(['1', 'true', 'yes', 'y', 'on']);

// ── URI -> 归一化节点 ───────────────────────────────────────────
function parseUri(uri) {
  uri = uri.trim();
  const scheme = (uri.match(/^([a-z0-9]+):\/\//i) || [])[1];
  if (!scheme) return null;
  const s = scheme.toLowerCase();

  if (s === 'vmess') {
    try {
      const raw = uri.slice('vmess://'.length);
      const j = JSON.parse(b64decode(raw.replace(/#.*$/, '')));
      return {
        type: 'vmess',
        name: j.ps || '',
        server: String(j.add || '').trim(),
        port: parseInt(j.port, 10),
        uuid: j.id,
        alterId: parseInt(j.aid || 0, 10) || 0,
        cipher: j.scy || 'auto',
        network: (j.net || 'tcp').toLowerCase(),
        tls: TRUEISH.has(String(j.tls || '').toLowerCase()),
        sni: j.sni || '',
        wsPath: j.path || '',
        wsHost: j.host || '',
        alpn: j.alpn || '',
        fp: j.fp || '',
        raw: uri,
      };
    } catch (e) { return null; }
  }

  const { main, name } = stripFragment(uri);
  const m = main.match(/^([a-z0-9]+):\/\/([^@]*)@?([^/?#]*)(\?[^#]*)?$/i);
  if (!m) return null;
  const body = m[2] || '';
  let hostport = m[3] || '';
  const q = parseQuery((m[4] || '').replace(/^\?/, ''));

  // ss:// 可能整体是 base64
  let userinfo = body;
  if (s === 'ss' && !hostport) {
    const dec = b64decode(body);
    const at = dec.lastIndexOf('@');
    if (at > 0) { userinfo = dec.slice(0, at); hostport = dec.slice(at + 1); }
  }

  let host = hostport, port = NaN;
  const hp = hostport.match(/^\[([0-9a-f:]+)\]:(\d+)$/i) || hostport.match(/^(.*):(\d+)$/);
  if (hp) { host = hp[1]; port = parseInt(hp[2], 10); }

  if (!host || !port) return null;
  const common = { name, server: host, port, raw: uri };

  if (s === 'vless') {
    return {
      ...common, type: 'vless', uuid: userinfo,
      network: (q.type || 'tcp').toLowerCase(),
      tls: ['tls', 'reality', 'xtls'].includes((q.security || '').toLowerCase()),
      security: (q.security || '').toLowerCase(),
      sni: q.sni || q.host || '',
      wsPath: q.path || '',
      wsHost: q.host || '',
      flow: q.flow || '',
      fp: q.fp || '',
      pbk: q.pbk || '',
      sid: q.sid || '',
      serviceName: q.serviceName || '',
      alpn: q.alpn || '',
    };
  }
  if (s === 'trojan') {
    return {
      ...common, type: 'trojan', password: safeDecodeURIComponent(userinfo),
      network: (q.type || 'tcp').toLowerCase(),
      tls: true,
      sni: q.sni || q.peer || q.host || '',
      wsPath: q.path || '',
      wsHost: q.host || '',
      skipCertVerify: TRUEISH.has(String(q.allowInsecure || q.insecure || '').toLowerCase()),
    };
  }
  if (s === 'ss') {
    let method = '', password = '';
    const ui = safeDecodeURIComponent(userinfo);
    const ci = ui.indexOf(':');
    if (ci > 0) { method = ui.slice(0, ci); password = ui.slice(ci + 1); }
    else { const d = b64decode(userinfo); const j = d.indexOf(':'); method = d.slice(0, j); password = d.slice(j + 1); }
    // ss 的 plugin 参数形如 `obfs-local;obfs=http;obfs-host=x`，必须完整解析，
    // 否则生成的 Clash 配置会缺字段导致内核解析失败
    let plugin = '';
    let pluginOpts = null;
    let unsupported = '';
    if (q.plugin) {
      const parts = safeDecodeURIComponent(q.plugin).split(';').filter(Boolean);
      const pname = (parts[0] || '').toLowerCase();
      const kv = {};
      for (const seg of parts.slice(1)) {
        const i = seg.indexOf('=');
        if (i > 0) kv[seg.slice(0, i)] = seg.slice(i + 1);
      }
      if (pname === 'obfs-local' || pname === 'simple-obfs' || pname === 'obfs') {
        plugin = 'obfs';
        pluginOpts = { mode: kv.obfs || 'http' };
        if (kv['obfs-host']) pluginOpts.host = kv['obfs-host'];
      } else if (pname === 'v2ray-plugin') {
        plugin = 'v2ray-plugin';
        pluginOpts = { mode: kv.mode || 'websocket' };
        if (kv.host) pluginOpts.host = kv.host;
        if (kv.path) pluginOpts.path = kv.path;
        if (kv.tls !== undefined) pluginOpts.tls = true;
      } else {
        // 未知插件无法可靠还原，标记为不支持
        unsupported = 'unknown-plugin:' + pname;
      }
    }
    return {
      ...common, type: 'ss', cipher: method, password,
      plugin, pluginOpts, unsupported,
    };
  }
  if (s === 'hysteria2' || s === 'hy2') {
    return {
      ...common, type: 'hysteria2', password: safeDecodeURIComponent(userinfo),
      sni: q.sni || '',
      skipCertVerify: TRUEISH.has(String(q.insecure || '').toLowerCase()),
      obfs: q.obfs || '',
      obfsPassword: q['obfs-password'] || '',
    };
  }
  return null;
}

// ── 归一化节点 -> Clash proxy 对象 ──────────────────────────────
function toClash(n) {
  const base = { name: n.name || `${n.type}-${n.server}`, type: n.type, server: n.server, port: n.port };
  const ws = () => {
    const o = { path: n.wsPath || '/' };
    if (n.wsHost) o.headers = { Host: n.wsHost };
    return o;
  };
  if (n.type === 'vless') {
    const p = { ...base, uuid: n.uuid, udp: true };
    if (n.network && n.network !== 'tcp') p.network = n.network;
    if (n.tls) p.tls = true;
    if (n.security === 'reality') {
      p.tls = true;
      p['reality-opts'] = { 'public-key': n.pbk, 'short-id': n.sid || '' };
      p['client-fingerprint'] = n.fp || 'chrome';
    } else if (n.fp) p['client-fingerprint'] = n.fp;
    if (n.sni) p.servername = n.sni;
    if (n.flow) p.flow = n.flow;
    if (n.alpn) p.alpn = n.alpn.split(',').filter(Boolean);
    if (n.network === 'ws') p['ws-opts'] = ws();
    if (n.network === 'grpc') p['grpc-opts'] = { 'grpc-service-name': n.serviceName || n.wsPath || '' };
    if (n.tls && (n.skipCertVerify || n.security === 'reality')) p['skip-cert-verify'] = true;
    return p;
  }
  if (n.type === 'vmess') {
    const p = { ...base, uuid: n.uuid, alterId: n.alterId || 0, cipher: n.cipher || 'auto', udp: true };
    if (n.network && n.network !== 'tcp') p.network = n.network;
    if (n.tls) p.tls = true;
    if (n.sni) p.servername = n.sni;
    if (n.network === 'ws') p['ws-opts'] = ws();
    return p;
  }
  if (n.type === 'trojan') {
    const p = { ...base, password: n.password, udp: true };
    if (n.sni) p.sni = n.sni;
    if (n.skipCertVerify) p['skip-cert-verify'] = true;
    if (n.network === 'ws') { p.network = 'ws'; p['ws-opts'] = ws(); }
    return p;
  }
  if (n.type === 'ss') {
    const p = { ...base, cipher: n.cipher, password: n.password, udp: true };
    if (n.plugin) {
      p.plugin = n.plugin;
      if (n.pluginOpts) p['plugin-opts'] = n.pluginOpts;
    }
    return p;
  }
  if (n.type === 'hysteria2') {
    const p = { ...base, password: n.password };
    if (n.sni) p.sni = n.sni;
    if (n.skipCertVerify) p['skip-cert-verify'] = true;
    if (n.obfs) { p.obfs = n.obfs; p['obfs-password'] = n.obfsPassword; }
    return p;
  }
  return base;
}

// ── Clash proxy 对象 -> 归一化节点 ──────────────────────────────
function fromClash(p) {
  if (!p || !p.type || !p.server || !p.port) return null;
  const t = String(p.type).toLowerCase();
  const wsOpts = p['ws-opts'] || {};
  const n = {
    type: t,
    name: p.name || '',
    server: String(p.server),
    port: parseInt(p.port, 10),
    network: p.network || 'tcp',
    tls: !!p.tls,
    sni: p.servername || p.sni || '',
    skipCertVerify: !!p['skip-cert-verify'],
    wsPath: wsOpts.path || '',
    wsHost: (wsOpts.headers && (wsOpts.headers.Host || wsOpts.headers.host)) || '',
  };
  if (t === 'vless') { n.uuid = p.uuid; n.flow = p.flow || ''; n.fp = p['client-fingerprint'] || ''; }
  else if (t === 'vmess') { n.uuid = p.uuid; n.alterId = p.alterId || 0; n.cipher = p.cipher || 'auto'; }
  else if (t === 'trojan') n.password = p.password;
  else if (t === 'ss') {
    n.cipher = p.cipher;
    n.password = p.password;
    n.plugin = p.plugin || '';
    n.pluginOpts = p['plugin-opts'] || null;
    // 有插件但缺参数（源配置本身就不完整）→ 直接标记不支持，否则内核解析会失败
    if (n.plugin && (!n.pluginOpts || (!n.pluginOpts.mode && n.plugin !== 'obfs'))) {
      n.unsupported = 'ss-plugin-missing-opts:' + n.plugin;
    }
    if (n.plugin === 'v2ray-plugin' && n.pluginOpts && !n.pluginOpts.mode) {
      n.unsupported = 'ss-v2ray-plugin-no-mode';
    }
  }
  else if (t === 'hysteria2' || t === 'hy2') { n.type = 'hysteria2'; n.password = p.password; n.obfs = p.obfs || ''; n.obfsPassword = p['obfs-password'] || ''; }
  else if (t !== 'ss') return null;
  return n;
}

// ── 归一化节点 -> URI（用于 base64 订阅输出）────────────────────
function toUri(n) {
  const tag = '#' + encodeURIComponent(n.name || n.server);
  if (n.type === 'vless') {
    const q = new URLSearchParams();
    q.set('encryption', 'none');
    q.set('security', n.tls ? (n.pbk ? 'reality' : 'tls') : 'none');
    q.set('type', n.network || 'tcp');
    if (n.sni) q.set('sni', n.sni);
    if (n.wsHost) q.set('host', n.wsHost);
    if (n.wsPath) q.set('path', n.wsPath);
    if (n.flow) q.set('flow', n.flow);
    if (n.fp) q.set('fp', n.fp);
    if (n.pbk) { q.set('pbk', n.pbk); q.set('sid', n.sid || ''); }
    return `vless://${n.uuid}@${n.server}:${n.port}?${q.toString()}${tag}`;
  }
  if (n.type === 'vmess') {
    const j = {
      v: '2', ps: n.name || '', add: n.server, port: String(n.port), id: n.uuid,
      aid: String(n.alterId || 0), scy: n.cipher || 'auto', net: n.network || 'tcp',
      type: 'none', host: n.wsHost || '', path: n.wsPath || '', tls: n.tls ? 'tls' : '',
      sni: n.sni || '',
    };
    return 'vmess://' + b64encode(JSON.stringify(j));
  }
  if (n.type === 'trojan') {
    const q = new URLSearchParams();
    if (n.network && n.network !== 'tcp') q.set('type', n.network);
    if (n.sni) q.set('sni', n.sni);
    if (n.wsHost) q.set('host', n.wsHost);
    if (n.wsPath) q.set('path', n.wsPath);
    if (n.skipCertVerify) q.set('allowInsecure', '1');
    const qs = q.toString();
    return `trojan://${encodeURIComponent(n.password)}@${n.server}:${n.port}${qs ? '?' + qs : ''}${tag}`;
  }
  if (n.type === 'ss') {
    const userinfo = b64encode(`${n.cipher}:${n.password}`).replace(/=+$/, '');
    let qs = '';
    if (n.plugin) qs = '?plugin=' + encodeURIComponent(n.plugin);
    return `ss://${userinfo}@${n.server}:${n.port}${qs}${tag}`;
  }
  if (n.type === 'hysteria2') {
    const q = new URLSearchParams();
    if (n.sni) q.set('sni', n.sni);
    if (n.skipCertVerify) q.set('insecure', '1');
    if (n.obfs) { q.set('obfs', n.obfs); q.set('obfs-password', n.obfsPassword || ''); }
    const qs = q.toString();
    return `hysteria2://${encodeURIComponent(n.password)}@${n.server}:${n.port}${qs ? '?' + qs : ''}${tag}`;
  }
  return null;
}

// 去重键：协议 + 服务器 + 端口 + 凭据 + 传输特征
function nodeKey(n) {
  const cred = n.uuid || n.password || '';
  const extra = [n.network || '', n.wsPath || '', n.wsHost || '', n.sni || '', n.tls ? 't' : '', n.cipher || ''].join('|');
  return `${n.type}|${n.server}|${n.port}|${cred}|${extra}`.toLowerCase();
}

module.exports = { parseUri, toClash, fromClash, toUri, nodeKey, b64decode, b64encode };
