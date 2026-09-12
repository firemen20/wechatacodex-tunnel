// 极简 YAML 子集解析器：够用于 Clash 配置（映射/列表/标量/行内数组）
// 不依赖任何第三方库。支持: # 注释、2 空格缩进、引号、行内 [a, b]、多行标量用 | 不做支持
'use strict';

function parseScalar(s) {
  let v = s.trim();
  if (v === '') return null;
  // 去掉行尾注释（不在引号内的 # 且前面有空格）
  let out = '';
  let quote = null;
  for (let i = 0; i < v.length; i++) {
    const c = v[i];
    if (quote) {
      if (c === quote) quote = null;
      out += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; out += c; continue; }
    if (c === '#' && (i === 0 || v[i - 1] === ' ')) break;
    out += c;
  }
  v = out.trim();
  if (v === '') return null;

  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    const inner = v.slice(1, -1);
    return v[0] === '"' ? inner.replace(/\\"/g, '"').replace(/\\\\/g, '\\') : inner.replace(/''/g, "'");
  }
  if (v.startsWith('[') && v.endsWith(']')) {
    const body = v.slice(1, -1).trim();
    if (!body) return [];
    return body.split(',').map((x) => parseScalar(x));
  }
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null' || v === '~') return null;
  if (/^-?\d+$/.test(v)) return parseInt(v, 10);
  if (/^-?\d*\.\d+$/.test(v)) return parseFloat(v);
  return v;
}

// 支持引号包裹的 key（如 "geosite:cn"）：普通 key 到第一个冒号为止
const KEY_RE = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^:\s][^:]*):\s*(.*)$/;

function isSeqToken(t) {
  return t.text.startsWith('- ') || t.text === '-';
}

function tokenize(text) {
  const out = [];
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.includes('\t')) throw new Error(`第 ${i + 1} 行含制表符`);
    const trimmed = raw.trim();
    if (!trimmed) continue;
    // 整行注释（缩进任意）
    if (/^#/.test(trimmed) && !/^\s*-\s/.test(raw)) continue;
    const indent = raw.length - raw.trimStart().length;
    out.push({ indent, text: trimmed, line: i + 1 });
  }
  return out;
}

// 把某个 key 的值写入 obj，返回下一个待处理 token 的下标
// parentIndent: key 所在层级；allowSameIndentSeq: 是否允许块序列与父键同缩进（YAML 合法写法）
function attach(toks, i, key, rawVal, parentIndent, obj, allowSameIndentSeq) {
  if (rawVal.trim() !== '') {
    obj[key] = parseScalar(rawVal);
    return i + 1;
  }
  const nxt = toks[i + 1];
  if (nxt && nxt.indent > parentIndent) {
    const [child, next] = parseBlock(toks, i + 1, nxt.indent);
    obj[key] = child;
    return next;
  }
  if (allowSameIndentSeq && nxt && nxt.indent === parentIndent && isSeqToken(nxt)) {
    const [child, next] = parseBlock(toks, i + 1, parentIndent);
    obj[key] = child;
    return next;
  }
  obj[key] = null;
  return i + 1;
}

// 解析一个同缩进级别的块
function parseBlock(toks, start, indent) {
  const isList = toks[start].text.startsWith('- ') || toks[start].text === '-';
  const value = isList ? [] : {};
  let i = start;
  while (i < toks.length) {
    const t = toks[i];
    if (t.indent < indent) break;
    if (t.indent > indent) throw new Error(`第 ${t.line} 行缩进异常（期望 ${indent}，实际 ${t.indent}）`);
    if (isList) {
      if (!(t.text.startsWith('- ') || t.text === '-')) break;
      const rest = t.text === '-' ? '' : t.text.slice(2).trim();
      if (rest === '') {
        // 嵌套块
        const [child, next] = parseBlock(toks, i + 1, toks[i + 1] ? toks[i + 1].indent : indent + 2);
        value.push(child);
        i = next;
        continue;
      }
      const kv = rest.match(KEY_RE);
      if (kv) {
        // 列表项本身是映射：以该项的缩进 + 2 作为子块缩进
        const obj = {};
        const itemIndent = t.indent + 2;
        i = attach(toks, i, kv[1].trim(), kv[2], t.indent, obj, false);
        // 继续吃掉属于同一项的后续键
        while (i < toks.length && toks[i].indent === itemIndent && !isSeqToken(toks[i])) {
          const kv2 = toks[i].text.match(KEY_RE);
          if (!kv2) break;
          i = attach(toks, i, kv2[1].trim(), kv2[2], itemIndent, obj, true);
        }
        value.push(obj);
        continue;
      }
      value.push(parseScalar(rest));
      i++;
    } else {
      if (isSeqToken(t)) break;
      const kv = t.text.match(KEY_RE);
      if (!kv) {
        i++;
        continue;
      }
      i = attach(toks, i, kv[1].trim(), kv[2], indent, value, true);
    }
  }
  return [value, i];
}

function parse(text) {
  const toks = tokenize(text);
  if (!toks.length) return {};
  const [v, next] = parseBlock(toks, 0, toks[0].indent);
  if (next < toks.length) {
    throw new Error(`第 ${toks[next].line} 行未被解析（顶层结构异常）`);
  }
  return v;
}

module.exports = { parse, parseScalar };
