// 极简 DNS 查询客户端（raw UDP）——查询指定权威服务器，看真实的委派情况
//
// 为什么需要：
//   公共 DoH（阿里/腾讯）只返回解析结果，查不到"上级到底委派了哪两个 NS"。
//   当域名 NS 设错时（典型：NS 指向 Cloudflare，但 zone 根本没在 CF 建），
//   公共解析器只会回 SERVFAIL，什么线索都没有。必须直接问权威服务器。
//
// 用法: node tools/dns-query.js <域名> <类型> [权威服务器]
//   例: node tools/dns-query.js example.com NS a.ns.example-registrar.net
'use strict';
const dgram = require('dgram');

const NAME = process.argv[2];
const TYPE = (process.argv[3] || 'A').toUpperCase();
const SERVER = process.argv[4] || '223.5.5.5';
const PORT = 53;

const TYPES = { A: 1, NS: 2, CNAME: 5, SOA: 6, AAAA: 28, TXT: 16, MX: 15 };
const TYPE_NAMES = Object.fromEntries(Object.entries(TYPES).map(([k, v]) => [v, k]));
const RCODES = { 0: 'NOERROR', 1: 'FORMERR', 2: 'SERVFAIL', 3: 'NXDOMAIN', 4: 'NOTIMP', 5: 'REFUSED' };

function encodeName(name) {
  const parts = name.replace(/\.$/, '').split('.');
  const bufs = parts.map((p) => {
    const b = Buffer.from(p, 'utf8');
    return Buffer.concat([Buffer.from([b.length]), b]);
  });
  return Buffer.concat([...bufs, Buffer.from([0])]);
}

function decodeName(buf, off) {
  const labels = [];
  let jumped = false;
  let origOff = off;
  let guard = 0;
  while (guard++ < 128) {
    if (off >= buf.length) break;
    const len = buf[off];
    if (len === 0) { off += 1; break; }
    if ((len & 0xc0) === 0xc0) {           // 压缩指针
      const ptr = ((len & 0x3f) << 8) | buf[off + 1];
      if (!jumped) { origOff = off + 2; jumped = true; }
      off = ptr;
      continue;
    }
    labels.push(buf.slice(off + 1, off + 1 + len).toString('utf8'));
    off += 1 + len;
  }
  return { name: labels.join('.'), next: jumped ? origOff : off };
}

function buildQuery(name, type) {
  const id = Math.floor(Math.random() * 65535);
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(0x0100, 2);   // RD=1
  header.writeUInt16BE(1, 4);        // QDCOUNT
  const q = Buffer.concat([
    encodeName(name),
    Buffer.from([(TYPES[type] || 1) >> 8, (TYPES[type] || 1) & 0xff, 0, 1]),
  ]);
  return { id, packet: Buffer.concat([header, q]) };
}

function parseRecords(buf, off, count, section) {
  const out = [];
  for (let i = 0; i < count && off < buf.length; i++) {
    const n = decodeName(buf, off);
    off = n.next;
    if (off + 10 > buf.length) break;
    const type = buf.readUInt16BE(off);
    const ttl = buf.readUInt32BE(off + 4);
    const rdlen = buf.readUInt16BE(off + 8);
    off += 10;
    const rdataOff = off;
    let data = '';
    if (type === 2 || type === 5) data = decodeName(buf, rdataOff).name;       // NS / CNAME
    else if (type === 6) {                                                     // SOA
      const m = decodeName(buf, rdataOff);
      const r = decodeName(buf, m.next);
      const serial = buf.readUInt32BE(r.next);
      data = `${m.name} ${r.name} serial=${serial}`;
    } else if (type === 1) data = Array.from(buf.slice(rdataOff, rdataOff + 4)).join('.');
    else if (type === 28) data = buf.slice(rdataOff, rdataOff + 16).toString('hex').match(/.{4}/g).join(':');
    else if (type === 16) data = buf.slice(rdataOff + 1, rdataOff + rdlen).toString('utf8');
    else data = buf.slice(rdataOff, rdataOff + rdlen).toString('hex');
    out.push({ section, type: TYPE_NAMES[type] || type, ttl, data });
    off = rdataOff + rdlen;
  }
  return { records: out, off };
}

const { id, packet } = buildQuery(NAME, TYPE);
const sock = dgram.createSocket('udp4');
const timer = setTimeout(() => { console.log(`  ❌ ${SERVER} 无响应（超时）`); sock.close(); process.exit(1); }, 8000);

sock.on('message', (msg) => {
  clearTimeout(timer);
  if (msg.readUInt16BE(0) !== id) return;
  const flags = msg.readUInt16BE(2);
  const rcode = flags & 0x0f;
  const aa = (flags >> 10) & 1;
  console.log(`  服务器 ${SERVER}   状态=${RCODES[rcode] || rcode}${aa ? '  (权威应答 AA=1)' : ''}`);
  let off = 12;
  const qd = msg.readUInt16BE(4), an = msg.readUInt16BE(6), ns = msg.readUInt16BE(8), ar = msg.readUInt16BE(10);
  for (let i = 0; i < qd; i++) { const n = decodeName(msg, off); off = n.next + 4; }
  const all = [];
  let r = parseRecords(msg, off, an, 'ANSWER');
  all.push(...r.records);
  off = r.off;
  r = parseRecords(msg, off, ns, 'AUTHORITY');
  all.push(...r.records);
  off = r.off;
  r = parseRecords(msg, off, ar, 'ADDITIONAL');
  all.push(...r.records);
  if (!all.length) console.log('    （无记录）');
  for (const rec of all) console.log(`    [${rec.section}] ${rec.type.padEnd(6)} ${rec.data}`);
  sock.close();
});

sock.send(packet, PORT, SERVER, (err) => { if (err) { clearTimeout(timer); console.log('  发送失败: ' + err.message); sock.close(); } });
