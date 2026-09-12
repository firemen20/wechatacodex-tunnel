# wechatacodex-tunnel

> 把 Cloudflare Workers 变成你自己的代理节点，并自动生成**多客户端可用**的配置。
>
> 支持 Clash Meta / FlClash / v2rayng / Nekoray / Hiddify。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

---

## 这是什么

用你**自己的** Cloudflare 账号做节点，不依赖任何第三方机场。核心解决三件事：

| 问题 | 本项目的做法 |
|---|---|
| `*.workers.dev` 被 DNS 污染 + SNI 阻断 | ① 自定义域名 ② 裸 IP + 明文端口，两条路都行 |
| 哪个 CF 边缘 IP 快？靠猜 | **真实 HTTPS 实测**全部候选，按实测延迟反选 |
| 五种客户端各要一种配置格式 | 一次生成 Clash YAML / base64 订阅 / sing-box JSON / 链接清单 |

**零成本**：只用 Cloudflare 免费额度（Workers 10 万请求/天）。

---

## 特性

- **配置驱动** —— 代码里没有任何个人数据，全部从 `config.json` 读
- **两种模式自动切换**
  - *自定义域名模式*：`TLS 443` 加密，不需要入口节点，**五种客户端全支持**
  - *明文端口模式*：不需要域名，用裸 IP 绕开封锁
- **实测优选** —— 全候选实测 → 反选最优 → **双轮复验**剔除不稳定节点
- **四种输出格式**，并做**往返一致性校验**（生成是一回事，客户端解析回来是不是同一个节点是另一回事）
- **诊断工具** —— 直接查权威 DNS 服务器看真实委派；绑定 Worker 自定义域名

---

## 依赖

| 需要 | 说明 |
|---|---|
| **Node.js** ≥ 18 | 无第三方 npm 依赖，纯标准库 |
| **mihomo 内核** | 用于实测验证。从 [MetaCubeX/mihomo Releases](https://github.com/MetaCubeX/mihomo/releases) 下载，放到 `data/mihomo` 或用 `--core <路径>` 指定 |
| **Cloudflare 账号** | 免费版即可 |
| **一个域名**（可选） | 想用加密 443 才需要；明文模式不需要 |

---

## 快速开始

### 0. 准备 Worker

先在你的 Cloudflare 账号上部署一个支持 VLESS + WebSocket 的 Worker，记下它的 **UUID**。

> 本项目**不附带** Worker 源码。社区有多个成熟实现（搜索 `edgetunnel` / `vless worker`），
> 选一个部署即可。本框架只负责「优选 + 生成配置 + 验证」。

### 1. 安装

```bash
git clone https://github.com/wechatacodex/wechatacodex-tunnel.git
cd wechatacodex-tunnel
cp config.example.json config.json
```

### 2. 填配置

编辑 `config.json`：

```jsonc
{
  "domain": "example.com",          // 有自定义域名就填，没有就删掉这行（走明文模式）
  "proxyip": "proxyip.cmliussss.net",
  "workers": [
    {
      "tag": "node1",               // 短标识，用于节点命名
      "script": "my-worker-a",      // CF 上的 Worker 名
      "uuid": "你的-UUID",
      "host": "node1.example.com"   // 自定义域名模式填绑定的域名；
                                    // 明文模式填 <worker名>.<子域>.workers.dev
    }
  ],
  "edge_ips": [],                   // 留空 = 自动优选
  "ips_per_worker": 3
}
```

### 3. 跑一条命令

```bash
node tools/optimize-ips.js --top 3
```

它会依次完成：

```
[1/5] 扫描候选 IP（真实 HTTPS 实测）
[2/5] 实测全部候选，按延迟反选最优 N 个
[3/5] 验证生成的配置
[4/5] 生成各客户端格式
[5/5] 完成
```

产物在 `dist/`：

| 文件 | 给谁用 |
|---|---|
| `ClashMeta-FlClash.yaml` | Clash Meta / FlClash |
| `通用订阅-base64.txt` | v2rayng / Nekoray / Hiddify |
| `Hiddify-Nekoray-singbox.json` | Hiddify / Nekoray |
| `节点链接.txt` | 手动导入 |

---

## 项目结构

```
wechatacodex-tunnel/
├── config.example.json     配置模板（复制成 config.json 使用）
├── src/
│   ├── config.js           ★ 配置加载与校验（框架核心）
│   ├── nodes.js            节点归一化：URI ↔ Clash 对象互转
│   ├── yaml-mini.js        迷你 YAML 解析器（无第三方依赖）
│   └── region.js           地区识别
├── tools/
│   ├── optimize-ips.js     ★ 一键全流程：优选 → 生成 → 验证
│   ├── build-nodes.js      生成 Clash 配置
│   ├── build-subscription.js  生成 base64 / sing-box / 链接清单
│   ├── verify-config.js    真实 HTTPS 验证任何配置
│   ├── verify-roundtrip.js 往返一致性校验
│   ├── bind-custom-domain.js  绑定 Worker 自定义域名
│   ├── dns-query.js        直接查权威 DNS（看真实委派）
│   └── proxy-start.js      起本地代理（访问被 SNI 阻断的 API）
└── docs/
    ├── 01-原理与架构.md
    ├── 02-自定义域名.md
    ├── 03-多客户端.md
    └── 04-踩坑记录.md
```

---

## 工具速查

```bash
# 全流程（最常用）
node tools/optimize-ips.js --top 3

# 只生成配置（不实测）
node tools/build-nodes.js dist/clash-nodes.yaml

# 验证某个配置的可用性
node tools/verify-config.js dist/ClashMeta-FlClash.yaml dist/verify.json

# 校验产物一致性
node tools/verify-roundtrip.js dist

# 绑定自定义域名到 Worker
CF_API_TOKEN=xxx CF_ACCOUNT_ID=yyy node tools/bind-custom-domain.js example.com my-worker-a

# 查域名真实的 NS 委派（公共 DoH 只回 SERVFAIL，查不出原因）
node tools/dns-query.js example.com NS a.ns.dnshe.org
```

---

## 核心原理（三句话）

1. **CF 边缘 IP ≠ 你的服务器**。你的 Worker 部署在 Cloudflare 全球网络上，客户端连的是**边缘节点 IP**。不同边缘 IP 的质量差别很大，所以要优选。

2. **`*.workers.dev` 在国内被封锁**（DNS 污染 + SNI 阻断）。两条出路：绑自定义域名走 TLS 443，或者用**裸 IP + 明文端口**绕开。

3. **反代IP（PROXYIP）是第二层依赖**。当目标网站**自己也在 Cloudflare 上**时，Worker 直连会回环，所以要绕一个中转 IP。它只影响 CF 托管的站点，普通网站不走这条路。

详见 [`docs/01-原理与架构.md`](docs/01-原理与架构.md)。

---

## 常见问题

**Q: 明文模式还是自定义域名模式？**

| | 明文端口 | 自定义域名 + TLS |
|---|---|---|
| 需要域名 | ❌ | ✅ |
| 加密 | ❌（手机→CF 边缘明文） | ✅ TLS |
| 客户端支持 | 全部 | 全部 |
| 稳定性 | 可能被针对性干扰 | 更稳 |

有条件就上自定义域名。

**Q: 节点多久要重新优选一次？**

CF 边缘 IP 质量是**几天~几周**尺度变化的，不是分钟级。建议每天或每周跑一次 `optimize-ips.js`，不用高频刷新。

**Q: 为什么 `verify-config.js` 说找不到内核？**

下载 mihomo 放到 `data/mihomo`，或用 `--core /path/to/mihomo`。
**Android 用户注意**：`/sdcard` 通常是 `noexec` 挂载，内核放那里无法执行，要放到应用私有目录并用 `--core` 指定。

**Q: 生成的配置里 UUID 是明文，会泄露吗？**

`vless://<uuid>@<ip>` **本身就是凭据** —— 分享配置 = 分享节点。所以 `dist/` 和 `config.json` 都已在 `.gitignore` 里，别提交、别外传。

---

## 安全提醒

- `config.json` 含你的 UUID 和域名 —— **绝不提交**（`.gitignore` 已排除）
- `dist/` 里的配置等价于节点密码 —— 同样别提交
- API Token 只通过环境变量传，不要写进文件
- 如果怀疑 UUID 泄露：改 Worker 的环境变量 `UUID` 并重新部署，旧 UUID 立即失效

---

## 致谢

- [MetaCubeX/mihomo](https://github.com/MetaCubeX/mihomo) —— 用于实测验证的内核
- Worker 端实现请使用社区成熟项目（本项目不含 Worker 代码）

## 许可

[MIT](LICENSE)
