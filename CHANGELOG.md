# 更新日志

本项目遵循[语义化版本](https://semver.org/lang/zh-CN/)。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

---

## [1.0.0] — 2026-09-12

首个公开版本。从实践中提炼而成，不是纸上设计。

### 新增

- **配置驱动架构** —— `src/config.js` 负责加载与校验，代码中零硬编码凭据
- **两种模式自动切换**
  - 自定义域名模式：TLS 443 加密，不需要入口节点
  - 明文端口模式：不需要域名，用裸 IP 绕开封锁
- **实测优选 IP**（`tools/optimize-ips.js`）
  - 全候选实测 → 按实测延迟反选 → 双轮复验剔除不稳定节点
  - 上一轮在用的 IP 自动并入候选，避免好 IP 被丢掉
- **多客户端输出**（`tools/build-subscription.js`）
  - Clash YAML / base64 订阅 / sing-box JSON / 明文链接清单
- **往返一致性校验**（`tools/verify-roundtrip.js`）
  - 生成是一回事，客户端解析回来是不是同一个节点是另一回事
- **真实流量验证**（`tools/verify-config.js`）
  - 走内核实测 HTTPS，不用内核自带的 `/delay` 接口
- **权威 DNS 查询**（`tools/dns-query.js`）
  - 公共 DoH 只回 SERVFAIL 时，直接问权威服务器看真实委派
- **域名绑定**（`tools/bind-custom-domain.js`）
- **离线自检**（`tools/selftest.js`）—— 17 项检查，不需要网络和真实节点
- **CI**（GitHub Actions）—— Node 18/20/22 矩阵 + 独立的敏感信息扫描

### 文档

- `docs/01-原理与架构.md` —— 节点到底在哪、为什么需要优选、反代IP 是什么
- `docs/02-自定义域名.md` —— PSL 判断、四步上线、权限受限时的替代路径
- `docs/03-多客户端.md` —— 各客户端能力差异、sing-box 1.12+ 的破坏性变更
- `docs/04-踩坑记录.md` —— 14 条实测踩过的坑

### 已知限制

- **Hysteria2 不可行** —— 它是 QUIC/UDP，而 Cloudflare Workers 只能处理 HTTP/WebSocket（TCP），没有 UDP 入站能力
- **sing-box 配置只做到 `check` 通过** —— Android 禁止普通 App 使用 netlink，内核无法本地实跑
- **明文模式可能被应用层干扰** —— 实测出现过持续传输被压到 0 的情况，所以推荐自定义域名模式

### 设计取舍（记录在这里，避免以后被"优化"掉）

- **不做第三方依赖** —— 只用 Node 标准库。内置的 `yaml-mini.js` 就是为此写的
- **不用延迟阈值裁剪端口** —— 端口多样性是鲁棒性手段，用延迟阈值裁剪会在网络变差时把退路全砍掉（踩过）
- **不按扫描排名选 IP** —— 扫描是单次测量，噪声极大，会把配置越维护越差（踩过）

---

## 版本号约定

| 变更 | 版本 |
|---|---|
| 破坏性变更（改了 `config.json` 格式、生成的配置不再兼容旧客户端） | 主版本 |
| 新增功能、新增客户端支持 | 次版本 |
| 修 bug、改文档、优化逻辑 | 修订号 |
