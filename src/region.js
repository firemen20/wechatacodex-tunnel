// 节点地区识别：只认 美国(US) / 新加坡(SG) / 日本(JP) / 香港(HK) 四个目标地区
// 两轮匹配：先严格（旗帜/多字关键词/带边界的缩写），再宽松（单字兜底），避免"完美/今日"这类误判
'use strict';

const FLAGS = {
  US: '\u{1F1FA}\u{1F1F8}',
  SG: '\u{1F1F8}\u{1F1EC}',
  JP: '\u{1F1EF}\u{1F1F5}',
  HK: '\u{1F1ED}\u{1F1F0}',
};

// 第一轮：严格关键词
const STRICT_LATIN = {
  US: ['USA', 'United States', 'Los Angeles', 'San Jose', 'Seattle', 'New York', 'Dallas', 'Chicago', 'Miami', 'Phoenix', 'Ashburn', 'Silicon Valley', 'San Francisco', 'Las Vegas', 'Portland', 'Atlanta', 'Denver', 'US'],
  SG: ['SGP', 'Singapore', 'SG'],
  JP: ['JPN', 'Japan', 'Tokyo', 'Osaka', 'Nagoya', 'Yokohama', 'JP'],
  HK: ['HKG', 'Hong Kong', 'HongKong', 'Kowloon', 'HK'],
};
const STRICT_CJK = {
  US: ['美国', '美利坚', '洛杉矶', '圣何塞', '西雅图', '纽约', '达拉斯', '芝加哥', '迈阿密', '凤凰城', '硅谷', '圣克拉拉', '拉斯维加斯', '波特兰', '亚特兰大', '丹佛'],
  SG: ['新加坡', '狮城'],
  JP: ['日本', '东京', '大阪', '名古屋', '横滨'],
  HK: ['香港', '九龙', '沪港', '深港', '京港'],
};

// 第二轮：宽松兜底（单字/极短）
const LOOSE_CJK = { US: ['美'], SG: ['坡', '新'], JP: ['日'], HK: ['港'] };

function cleanName(name) {
  return String(name || '')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\b(t\.me|telegram)\b\S*/gi, ' ')
    .trim();
}

function esc(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchStrict(n) {
  for (const code of Object.keys(FLAGS)) {
    if (n.includes(FLAGS[code])) return code;
  }
  for (const code of Object.keys(STRICT_LATIN)) {
    for (const kw of STRICT_LATIN[code]) {
      const re = new RegExp(`(^|[^A-Za-z0-9])${esc(kw)}([^A-Za-z0-9]|$)`, 'i');
      if (re.test(n)) return code;
    }
  }
  for (const code of Object.keys(STRICT_CJK)) {
    for (const kw of STRICT_CJK[code]) {
      if (n.includes(kw)) return code;
    }
  }
  return null;
}

function matchLoose(n) {
  for (const code of Object.keys(LOOSE_CJK)) {
    for (const kw of LOOSE_CJK[code]) {
      if (n.includes(kw)) return code;
    }
  }
  return null;
}

// 返回 'US'|'SG'|'JP'|'HK'|null
function classify(name) {
  const n = cleanName(name);
  if (!n) return null;
  return matchStrict(n) || matchLoose(n);
}

const LABEL = { US: '美国', SG: '新加坡', JP: '日本', HK: '香港' };
const FLAG = { US: '🇺🇸', SG: '🇸🇬', JP: '🇯🇵', HK: '🇭🇰' };
const ORDER = ['HK', 'JP', 'SG', 'US'];

module.exports = { classify, cleanName, LABEL, FLAG, ORDER };
