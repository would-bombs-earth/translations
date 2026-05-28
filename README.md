# 极译 — 智能多引擎网页翻译

⚡ 极速网页翻译扩展，支持 15+ 语种自动翻译为简体中文。双引擎架构（Microsoft + 自部署 Worker 代理），非侵入式 DOM 替换。

## ✨ 特性

- 🚀 极速翻译 — 32 并发 + 批量 Marker 协议（64条/批）
- 🔌 双引擎 — Microsoft Translator（默认）+ 自部署 Cloudflare Worker 代理
- 🎯 精准检测 — 纯正则 15+ 语种，区分日中韩繁简
- 👻 无侵入 — 仅替换 Text Node，不动 DOM 结构
- 🔄 一键恢复 — O(n) 还原原文
- 🧩 Worker 代理 — 内部 Google×3 + MyMemory 自适应优选，国内友好
- 🛡 React 水合保护 — 自动检测 SPA 框架，延迟扫描防止冲突
- 💓 心跳域名同步 — 自适应轮询（1min → 30min 休眠），多设备域名一致
- 📋 增强日志 — 时间戳 + 分级（DEBUG/INFO/WARN/ERROR）+ 环形缓冲 + 一键导出

## 📦 安装 

1. Chrome 地址栏输入 `chrome://extensions`
2. 开启右上角 **开发者模式**
3. 点击 **加载已解压的扩展程序**，选择项目文件夹
4. 完成

### 部署 Worker 代理（可选）

如需在国内网络环境使用或自定义翻译后端：

```bash
npx wrangler deploy worker.js
```

部署后在扩展弹窗底部填入 Worker URL 和 Token。

## 🎮 使用

| 操作 | 方式 |
|------|------|
| 自动翻译 | 默认开启，打开外文网页即译 |
| 手动翻译 | 右键 → 极译此页 |
| 恢复原文 | 右键 → ↩️ 恢复原文 |
| 切换引擎 | 点击弹窗中的引擎卡片 |
| 配置 Worker | 弹窗底部填入 URL 和 Token |
| 域名管理 | 弹窗中添加/移除排除域名，自动同步云端 |
| 导出日志 | 弹窗底部点击「导出日志」按钮 |

## 🔌 翻译引擎

| 引擎 | 类型 | 说明 |
|------|------|------|
| Microsoft | 直连 | 微软翻译 API，默认引擎 |
| Worker 代理 | 自部署 | Cloudflare Worker 代理，内部轮换 googleapis/google/clients5/mymemory |

## 🔄 域名同步

扩展支持通过 Worker KV 在多设备间同步排除域名列表：

- **云端权威**: 云端数据为主，本地在每次同步时替换为云端列表
- **自适应心跳**: 快速轮询（1分钟）→ 连续 10 次无变化 → 自动休眠（30分钟）→ 唤醒继续
- **即时同步**: 在弹窗中添加/移除域名即时上传云端，Worker 配置变更时立即触发全量同步

## 🛠 开发

无需构建，纯原生 JS。修改后到 `chrome://extensions` 刷新即可。

### 调试

打开网页控制台（F12 → Console），可看到带时间戳和分级标记的日志：

```
[14:32:01.234][I][Translate] 诊断统计: {...}
[14:32:01.456][D][Translate] 连通性: https://xxx.workers.dev/health → OK 1263ms
[14:32:02.100][W][Translate] 批次 #1 ✅ 32 条译文 (450ms) microsoft
```

引擎标签: `microsoft` 靛蓝、`worker-proxy` 青色、`(cache)` 灰色。

### 日志导出

- **弹窗导出**: 点击弹窗底部「导出日志」按钮，自动收集 Content Script + Background 日志并下载为 `.txt` 文件
- **浏览器控制台**: 调用 `window.__gt_debug` 查看调试事件

## 🔧 最近更新

- **v1.0.3** — 自适应心跳域名同步（云端权威 + 休眠唤醒）、增强日志系统（时间戳/分级/缓冲/导出）、Worker KV 域名增删接口、多项 bug 修复
- 双引擎架构：Microsoft + Worker 代理，替代旧版 Google×3 + MyMemory 直连
- 默认引擎为微软，支持用户手动切换引擎
- 用户可自部署 Cloudflare Worker 代理
- React/Next.js/Vue 水合保护
- SPA 导航自动检测与重新翻译
- UI Midnight Teal 毛玻璃主题

## 常见问题

**Q: 如何切换翻译引擎？**
A: 点击工具栏图标，在弹窗中点击「微软翻译」或「Worker 代理」卡片。

**Q: Worker 代理是什么？**
A: 部署在 Cloudflare 上的翻译网关，内部轮换 googleapis、google、clients5、mymemory 四个翻译源，自动选择最快可用源。适合国内网络环境。

**Q: 如何部署 Worker？**
A: 安装 wrangler CLI 后执行 `npx wrangler deploy worker.js`，将得到的 URL 和 token 填入扩展弹窗。部署前务必修改 `worker.js` 中的 `AUTH_TOKEN` 为随机长字符串。

**Q: 域名同步如何工作？**
A: 配置 Worker 后，扩展自动通过 `/kv/list` 从云端拉取排除域名列表。快速轮询每 1 分钟检查一次，连续 10 次无变化后休眠 30 分钟再恢复。添加/删除域名即时上传云端，确保多设备一致。

**Q: 翻译后页面报错？**
A: 可能是 React/Next.js 水合冲突。扩展已自动检测 SPA 框架并延迟翻译，如仍有问题请反馈。

**Q: 恢复原文不完整？**
A: 扩展将原文存储在 DOM 节点上，恢复时 O(n) 遍历。如果页面 JS 替换了 DOM 节点则原文丢失，刷新页面可完全恢复。

**Q: Worker 显示不可用？**
A: 检查 URL 是否以 `https://` 开头，确认 Worker 已部署（`curl https://xxx.workers.dev/health` 应返回 `ok`），确认扩展 `chrome://extensions` 中网站访问设为「在所有网站上」。

## 📄 License

MIT
