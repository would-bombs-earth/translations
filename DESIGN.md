# 极译 — 系统设计文档

## 概述

极译是一款 Chrome 浏览器扩展（Manifest V3），可自动将任意网页中的外文内容翻译为简体中文。采用双引擎架构：Microsoft Translator（直连，默认）和 Cloudflare Worker 代理（内部轮换 googleapis/google/clients5/mymemory）。核心特征是高并发、低延迟、对页面 DOM 无侵入。

**版本**: 1.0.3
**最低 Chrome 版本**: 110
**目标语言**: 简体中文（zh-CN）

---

## 架构总览

```
┌─────────────────────────────────────────────────────┐
│                     Popup (options.html)              │
│  ┌───────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │ 状态指示灯  │  │ 双引擎卡片     │  │ Worker 配置   │  │
│  │ 域名管理    │  │ 引擎延迟      │  │ 日志导出      │  │
│  └───────────┘  └──────────────┘  └──────────────┘  │
└──────────────────────┬──────────────────────────────┘
                       │ chrome.tabs.sendMessage
                       │ chrome.storage.session
┌──────────────────────▼──────────────────────────────┐
│            Content Script (4 文件)                    │
│  content-globals.js: 状态、缓存、去重、常量、日志     │
│  content-lang.js:    语言检测引擎 (15+ 语种)          │
│  content.js:         DOM 扫描 / 批量翻译 / 还原 / Obsvr│
│  debug.js:           调试日志 & 连通性检测             │
└──────────────────────┬──────────────────────────────┘
                       │ chrome.runtime.sendMessage
┌──────────────────────▼──────────────────────────────┐
│            Service Worker (2 文件, ES Module)        │
│  background.js:      引擎初始化 / 心跳域名同步 / 消息路由│
│  background-api.js:  双引擎翻译 / 缓存 / 并发 / KV同步 │
└──────────────────────┬──────────────────────────────┘
                       │
      ┌────────────────┼──────────────────────┐
      ▼                                     ▼
Microsoft                      Cloudflare Worker
Translator                     (googleapis/google/clients5
                                  /mymemory 内部轮换)
                                  │
                                  ▼
                          Workers KV (域名存储)
```

| 组件 | 运行环境 | 文件 | 职责 |
|------|---------|------|------|
| Popup | 扩展弹窗 | options.html / options.js | 引擎状态、延迟显示、引擎切换、Worker 配置、域名管理、日志导出 |
| Content Script | 网页上下文 | content-globals.js / content-lang.js / content.js / debug.js | DOM 文本扫描、语言检测、批量翻译请求、译文回填、原文还原、调试日志 |
| Service Worker | 扩展后台 | background.js / background-api.js | 引擎选择、右键菜单、标签状态、消息路由、双引擎翻译 API、心跳域名同步 |
| Worker Proxy | Cloudflare | worker.js | 代理转发：内部 4 源轮换并自动优选；KV 域名增删查 |

---

## 核心设计

### 1. 双引擎架构

**默认引擎**: Microsoft Translator，通过 `edge.microsoft.com/translate/auth` 获取临时 JWT token，调用 `api.cognitive.microsofttranslator.com`。

**Worker 代理**: 用户自部署 Cloudflare Worker，内部自动优选 googleapis、google、clients5、mymemory 中延迟最低的翻译源。

```
翻译请求
  │
  ├─► Microsoft (默认，优先)
  │     ├─ 成功 → 返回
  │     └─ 失败 → 降级
  │
  └─► Worker 代理 (降级/手动切换)
        ├─ 成功 → 返回
        └─ 失败 → throw (所有端点耗尽)
```

**引擎选择规则**:
- `activeEndpointIdx` 控制首试引擎：0=microsoft，1=worker-proxy
- 默认始终为 microsoft，不自动优选延迟最低的引擎
- 用户手动点击 Worker 卡片后切换并持久化（`preferredManual: true`）
- 降级成功不会覆盖手动选择
- Service Worker 每次启动时通过 `initEngine()` 恢复之前的选择

**Worker 内部优选**:
- Worker 每 5 分钟并行 ping 4 个翻译源
- 翻译时优先使用延迟最低的源，失败则轮换其余
- 对扩展透明——扩展只看到 Worker 这一个端点

### 2. Worker 代理配置

用户通过 Popup 底部面板配置：

| 配置项 | 存储位置 | 说明 |
|--------|---------|------|
| Worker URL | `chrome.storage.local.workerUrl` | 自动补全 `https://`，去除尾部斜杠 |
| Auth Token | `chrome.storage.local.workerToken` | 与 Worker 部署时设置的 `AUTH_TOKEN` 一致 |

**Worker 端点**:

| 端点 | 方法 | 鉴权 | 说明 |
|------|------|------|------|
| `/health` | GET | 无 | 返回 `ok`，扩展用于连通性探测 |
| `/ping` | GET | Bearer token | 返回 4 个后端各自延迟和可用性 |
| `/` | POST | Bearer token | 翻译 `{ text, sl }` → `{ translation }` |
| `/kv/list` | GET | Bearer token | 列出 KV 中存储的排除域名 |
| `/kv/add` | POST | Bearer token | 添加域名到 KV |
| `/kv/del` | POST | Bearer token | 从 KV 删除域名 |

**Worker 代码**: [worker.js](worker.js)，部署命令 `npx wrangler deploy worker.js`。部署前务必修改 `AUTH_TOKEN` 为随机长字符串（`openssl rand -hex 32`）。

### 3. 语言检测：正则引擎

纯正则方案，零依赖、同步执行：

- **检测语种**: 拉丁字母、日文假名、韩文谚文、西里尔文、阿拉伯文、泰文、天城文、希腊文、希伯来文、格鲁吉亚文、缅文、高棉文、老挝文、藏文、越南文
- **判断**: 连续 2 个以上外文字符 → 需翻译
- **假名/谚文优先**: 检出日文假名或韩文谚文直接返回 `ja`/`ko`
- **CJK 占比**: 无假名/谚文时，若外文字符占比 < 43% 则回退 `sl=auto`
- **繁体检测**: 内置 400+ 繁体字符集，检出繁体且无假名/谚文时返回 `zh-TW`
- **简体中文跳过**: `isPageSimplifiedChinese()` 采样页面可见文本，`zh-CN`/`zh-Hans`/`zh-SG` html lang 走快速路径验证

### 4. Marker-Based 批量翻译协议

使用数学括号标记合并多条短文本为单个 HTTP 请求：

```
发送:  ⟪1⟫Hello World⟪2⟫Click Here
返回:  ⟪1⟫你好世界⟪2⟫点击此处
```

- 标记: `U+27EA` ⟪ — ID 开始，`U+27EB` ⟫ — ID 结束
- Google 可能转为 `[N]`/`【N】` → `parseTranslated()` 归一化
- 长文本（>150 字符）或含 CJK 文本走 Solo 模式，绕过标记协议
- 标记解析失败时 fallback 按行号顺序匹配

**译文清理管道 (cleanTranslation)**:
1. 清除标记残余 `⟪N⟫` 和行首 `[N]`
2. 修剪首尾空格
3. 清除前导和尾随冗余标点
4. 清除孤立标记括号
5. 再次修剪

### 5. React 水合保护

避免在 React/Vue/Next.js 等 SPA 水合完成前修改 DOM 文本节点（导致 React error #418/#425）。

**检测策略**:
- DOM 容器: `#__next`、`#__docusaurus`、`#___gatsby`、`#app`、`[data-reactroot]`
- 全局变量: `__NEXT_DATA__`、`__NUXT__`、`__GATSBY__`、`__REACT_DEVTOOLS_GLOBAL_HOOK__`
- 脚本特征: `<script>` 标签 src/content 包含 `react|next|vue|angular|svelte|docusaurus|nuxt|gatsby`

**延迟**: 检测到 SPA 框架后，初始扫描延迟 `HYDRATION_DELAY_MS`（3.5 秒），空闲超时 800ms。MutationObserver 不受影响，持续捕获动态内容。SPA 客户端导航通过 Navigation API / history.pushState 拦截检测，自动触发重新翻译。

### 6. 并发调度与缓存

| 层级 | 缓存类型 | 容量 | 并发数 |
|------|---------|------|--------|
| Content Script | Set (去重) | 5,000 | 32 Worker |
| Service Worker | LRU Map | 10,000 | 32 fetch |

SW 大文本（>4500 字符）自动分块并行翻译后拼接。LRU 缓存通过 delete + reinsert 实现 promotion。

### 7. 原文还原

双层追踪，O(n) 遍历还原：

- **直接标记**: `node.__gt_orig`（文本）和 `el.__gt_orig_attrs`（属性）
- **WeakMap**: `origTextMap`、`origAttrMap` 辅助去重

竞态保护: 还原时递增 `_flushGen`，翻译批次检测到 `gen` 不匹配即中止，防止译文覆盖已还原节点。

### 8. 自适应心跳域名同步

通过 `chrome.alarms` API 实现自适应轮询，保持多设备间排除域名列表一致。

**同步模型**: 云端权威（Cloud Authority）。本地数据在每次同步时被云端数据**替换**（非合并），确保删除操作跨设备传播。

**自适应节奏**:
```
快速轮询 (1min) ──连续10次无变化──► 休眠 (30min) ──唤醒──► 快速轮询 (1min) ──► ...
     ▲                                  │
     └──────── 有变化 / 配置更新 ────────┘
```

**触发条件**:
- Service Worker 启动时立即全量同步一次
- 定期 alarm 触发心跳检查
- Popup 中 Worker 配置变更时重置心跳状态并立即同步

**Worker KV 接口**:

| 函数 | Worker 端点 | 说明 |
|------|-----------|------|
| `kvList()` | `GET /kv/list` | 返回 `{ domains: [...] }` |
| `kvAdd(domain)` | `POST /kv/add` | 添加域名，body `{ domain }` |
| `kvDel(domain)` | `POST /kv/del` | 删除域名，body `{ domain }` |

**存储**: 域名列表存储于 `chrome.storage.local.excludedDomains`，由心跳同步保持与云端一致。Popup 打开时先读取本地立即渲染，再异步拉取云端更新。

### 9. 增强日志系统

全组件统一的增强日志，支持分级、时间戳、环形缓冲和导出。

**日志级别**:
| 级别 | 值 | 宏 | 说明 |
|------|----|-----|------|
| DEBUG | 0 | `DEBUG(...)` | 详细调试信息，默认关闭 |
| INFO | 1 | `LOG(...)` | 常规信息，默认开启 |
| WARN | 2 | `WARN(...)` | 警告，始终输出 |
| ERROR | 3 | `ERR(...)` | 错误，始终输出 |
| NONE | 4 | — | 关闭所有日志 |

**日志格式**: `[HH:MM:SS.mmm][级别][组件] 消息内容`

**组件标识**:
- Content Script: `[I][Translate]` / `[W][Translate]` / `[E][Translate]`
- Background: `[I][BG]` / `[E][BG]`
- Background API: `[I][BG-API]` / `[E][BG-API]`

**环形缓冲**: 每个组件独立 500 条环形缓冲，满后自动丢弃最旧条目。

**日志导出**: Popup 点击「导出日志」按钮 → 收集 Background + API 缓冲区 → 合并 Content Script 缓冲区（通过 `chrome.tabs.sendMessage`）→ 下载为 `jiyi-{hostname}-{timestamp}.txt`。

**debug.js**: 保留独立调试通道，通过 `window.__gt_debug` 注册回调，输出批次级翻译摘要和原文明细。

---

## 状态同步

### 翻译状态

```
Content Script                  Background                    Popup
     │                              │                           │
     ├── notifyTranslatedState ────►│                           │
     │   {type:'update_state'}      │                           │
     │                              ├── session.set(tab_N) ────►│
     │                              ├── updateContextMenu()    │
```

### 引擎状态

```
Popup 打开 → pingAndRender()
  ├─ 读取 storage: preferredEngine / preferredManual
  ├─ 手动选择 → userSelectedEngine = preferredEngine
  └─ 无手动 → userSelectedEngine = null → UI 默认高亮 microsoft

SW 启动 → initEngine()
  ├─ 读取 storage: preferredManual
  ├─ true  → setPreferredEndpoint(preferredEngine, true)
  └─ false → setPreferredEndpoint('microsoft', false)
```

### 域名同步

```
Popup 打开 → loadDomains()
  ├─ 读取 chrome.storage.local.excludedDomains → 立即渲染 UI
  └─ kvList() 拉取云端 → 替换本地存储 → 触发 storage.onChanged → UI 刷新

心跳 → syncDomainsFromCloud()
  ├─ kvList() 拉取云端
  ├─ 与本地比较
  └─ 有差异 → 替换本地存储 → chrome.storage.local.set()

添加/删除域名
  ├─ Popup 调用 kvAdd/kvDel 上传云端
  └─ 云端权威 → 下次心跳 (或立即) 同步回本地
```

---

## 配置项

| 配置项 | 存储位置 | 默认值 | 说明 |
|--------|---------|--------|------|
| `autoTranslate` | `sync` | `true` | 自动翻译开关 |
| `tab_${id}` | `session` | `false` | 标签翻译状态 |
| `preferredEngine` | `local` | — | 首选引擎名 |
| `preferredManual` | `local` | `false` | 是否手动选择 |
| `workerUrl` | `local` | — | Worker 代理 URL |
| `workerToken` | `local` | — | Worker 认证 Token |
| `excludedDomains` | `local` | 种子 | 排除域名列表（云端权威同步） |

---

## 关键常量

| 常量 | 值 | 说明 |
|------|----|------|
| MAX_QUEUE | 50000 | 最大队列容量 |
| BATCH_SIZE | 64 | 每批最大条目数 |
| BATCH_CHARS | 8400 | 每批最大字符数 |
| CONCURRENT | 32 | Content Script 并发 Worker 数 |
| FLUSH_MS | 50 | 刷新延迟 (ms) |
| SOLO_THRESHOLD | 150 | Solo 模式触发长度 |
| GOOGLE_LIMIT | 4500 | 单次翻译最大字符 |
| FETCH_CONCURRENT | 32 | Service Worker 并发请求数 |
| THROTTLE_MS | 50 | fetch 节流间隔 (ms) |
| CACHE_MAX | 10000 | SW 缓存容量 |
| CACHE_CLEAN | 1000 | LRU 清理批次 |
| SEEN_MAX | 5000 | 去重集合容量 |
| SEEN_CLEAN | 1000 | 去重清理批次 |
| HYDRATION_DELAY_MS | 3500 | React 水合等待 (ms) |
| LOG_BUF_MAX | 500 | 日志环形缓冲容量 |
| MARK_L / MARK_R | U+27EA / U+27EB | 批量标记分隔符 |
| FAST_MINUTES | 1 | 心跳快速轮询间隔 (min) |
| SLEEP_MINUTES | 30 | 心跳休眠时长 (min) |
| STABLE_LIMIT | 10 | 触发休眠的连续无变化次数 |

---

## 目录结构

```
translations_pro/
├── manifest.json          # MV3 清单
├── background.js          # Service Worker — 引擎初始化、心跳域名同步、右键菜单、消息路由
├── background-api.js      # ES Module — 双引擎翻译、缓存、并发、KV 同步
├── content-globals.js     # 全局状态、常量、增强日志、缓存、去重
├── content-lang.js        # 语言检测引擎
├── content.js             # DOM 扫描、批量翻译、还原、Observer、初始化、SPA 检测
├── debug.js               # 调试日志、连通性自检
├── options.html           # Popup 界面
├── options.js             # Popup 逻辑（引擎管理、域名管理、日志导出）
├── worker.js              # Cloudflare Worker — 翻译代理网关 + KV 域名存储
├── excluded-domains.json  # 排除域名种子（可选）
├── test_dedup.mjs         # 去重测试
├── DESIGN.md              # 本文件
├── README.md              # 用户文档
└── icons/                 # 扩展图标
```

---

## CSP 与权限

```json
{
  "permissions": ["storage", "tabs", "activeTab", "contextMenus", "scripting", "alarms"],
  "host_permissions": ["<all_urls>"],
  "content_security_policy": {
    "extension_pages": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src *"
  }
}
```
 
`connect-src: *` 是必需的——Service Worker 需要 fetch 用户配置的任意 Worker URL。`alarms` 权限用于心跳域名同步的定时触发。

--- 

## 变更日志 

### v1.0.3（当前）
- 自适应心跳域名同步：云端权威 + 快速轮询 (1min) → 休眠 (30min) 自适应节奏
- Worker KV 域名接口：`/kv/list`、`/kv/add`、`/kv/del`，支持多设备域名同步
- 增强日志系统：时间戳 + DEBUG/INFO/WARN/ERROR 四级 + 环形缓冲（500条）+ Popup 一键导出
- 修复 SPA 快速导航时的翻译竞态条件（`translating` 锁释放）
- 修复 zh-CN html lang 伪阳性（添加采样验证）
- 修复 popup sendMessage 未处理 disconnected 异常
- 修复属性节点二次翻译时多余 cacheGet 调用
- 修复域名管理 reentrancy 重复操作
- 调优参数：CONCURRENT 64→32、FLUSH_MS 0→50
- 修复 Worker 默认 AUTH_TOKEN 安全警告

### v1.0.2（重构）
- 双引擎架构：Microsoft + Worker 代理，替代 Google×3 + MyMemory 直连
- 默认引擎固定为微软，不再自动优选延迟最低的引擎（除非用户手动切换）
- 用户可通过 Popup 配置自部署 Worker 的 URL 和 Token
- Worker 内部 4 翻译源自适应优选，对扩展透明
- 新增 React/Next.js/Vue 水合保护和延迟扫描
- 新增 debug.js：浏览器控制台引擎标签 + 连通性自检
- CSP `connect-src` 改为 `*` 以支持任意 Worker URL
- Worker `/health` 健康检查端点供扩展探活
