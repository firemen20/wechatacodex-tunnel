# 贡献指南

感谢你有兴趣改进这个项目。本文档说明如何提交问题与代码。

---

## 提交 Issue

**提交前请先搜索已有 issue**，避免重复。

- 🐛 **Bug** → 用 [Bug 报告模板](https://github.com/firemen20/wechatacodex-tunnel/issues/new?template=bug_report.yml)
- 💡 **功能建议** → 用 [功能请求模板](https://github.com/firemen20/wechatacodex-tunnel/issues/new?template=feature_request.yml)

**⚠️ 提交 issue 时绝对不要贴出：**

- 你的 `config.json` 内容（含 UUID 和域名）
- 任何 `vless://` 开头的完整链接（**链接本身就是凭据**）
- API Token、订阅地址
- 你的域名（如果介意被关联）

需要贴配置时，**把 UUID 和域名替换成 `xxxx`**。

---

## 提交代码

### 基本要求

1. **不引入第三方 npm 依赖** —— 本项目刻意只用 Node 标准库，保持零依赖、可审计
2. **保持配置驱动** —— 代码里不允许出现任何具体的 UUID / 域名 / 账号 ID
3. **提交前跑一遍自检**：

```bash
npm test
```

自检覆盖：语法、配置校验、配置生成、三格式往返一致性。
**CI 会在 Node 18 / 20 / 22 上跑同样的检查**，本地过了基本就能过。

### 分支与提交信息

```bash
git checkout -b fix/简短描述
```

提交信息建议用前缀标明类型：

| 前缀 | 用途 |
|---|---|
| `feat:` | 新功能 |
| `fix:` | 修 bug |
| `docs:` | 只改文档 |
| `refactor:` | 重构（不改行为） |
| `test:` | 加/改测试 |
| `chore:` | 杂项 |

### 代码风格

- 缩进 2 空格，单引号，语句结尾带分号
- 参见 `.editorconfig`
- **注释写「为什么」，不写「做什么」** —— 这个项目里很多坑是靠注释传承的
  （比如为什么不能用 `LD_LIBRARY_PATH`、为什么端口不能用延迟阈值裁剪）

### 特别注意：不要在代码里硬编码

```js
// ❌ 不要这样
const WORKERS = [{ tag: 'youxuan', uuid: '3b3a8fc2-...' }];

// ✅ 这样
const cfg = require('../src/config').load();
const WORKERS = cfg.workers;
```

CI 里有一步「敏感信息检查」，硬编码会被自动拦下。

---

## 文档

文档同样重要。如果你踩了一个坑并解决了，**请写进 `docs/04-踩坑记录.md`**：

- 写清**现象**（别人能对号入座）
- 写清**根因**（不是「改成这样就好了」，而是为什么会这样）
- 有实测数据更好

---

## 许可证

提交代码即表示你同意以 [MIT 许可证](LICENSE) 授权你的贡献。
