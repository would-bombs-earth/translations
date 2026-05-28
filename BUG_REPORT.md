# 极译 — 代码 Bug 审查 (已全部修复 ✅)

> 日期: 2026-05-27 | 范围: 全部 7 个 JS 文件 | 仅基于代码逻辑

--- 

## 🔴 高危 — 已修复

### 1. 域名同步过滤逻辑不一致，触发无限循环写入

**文件**: `background.js` 第 66-75 行

```javascript
// line 66: 云端域名 — 无过滤
const cloudDomains = await kvList();

// line 70: 本地域名 — 过滤掉不含 '.' 的条目
const localDomains = Array.isArray(r.excludedDomains)
    ? r.excludedDomains.filter(d => typeof d === 'string' && d.includes('.'))
    : [];

// line 73: 用未过滤的云端和已过滤的本地做比较
const sorted = [...cloudDomains].sort();
```

**问题**: 云端域名列表不经过滤直接用于比较和存储，但本地列表被过滤。如果 KV 中存在不含 `.` 的域名（如 `localhost`、`intranet`），则每次心跳（1 分钟）都会检测到列表长度不等，触发 `chrome.storage.local.set()`，形成**永久高频写入循环**。

**修复**: 对 `sorted` 也应用相同过滤规则。

---

### 2. `save_logs` / `downloadLogs` 在无 body 页面会崩溃

**文件**: `content.js` 第 1014-1022 行, `content-globals.js` 第 35-43 行

```javascript
// content.js:1018
document.body.appendChild(logA);  // body 可能为 null

// content-globals.js:40
document.body.appendChild(a);     // 同上
```

**问题**: `save_logs` 消息处理器和 `downloadLogs` 函数直接使用 `document.body`，但未检查是否为空。虽然大多数页面都有 body，但在边缘情况下（XML 文档、某些 about: 页面、或页面加载的极端时机），`document.body` 可能为 null，导致 `Uncaught TypeError: Cannot read properties of null`。

**修复**: 添加 `if (!document.body) return;` 守卫。

---

### 3. `observeShadowRoot` 对普通 DocumentFragment 创建无效 Observer

**文件**: `content.js` 第 23-24 行, 第 273-285 行

```javascript
// enqueueNode
if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
    observeShadowRoot(node);  // 不区分 ShadowRoot 与普通 DocumentFragment
    ...
}

// observeShadowRoot
function observeShadowRoot(sr) {
    if (!sr || observedShadows.has(sr)) return;
    observedShadows.add(sr);
    const obs = new MutationObserver(onMutation);
    obs.observe(sr, { childList: true, subtree: true, ... });
    _shadowObservers.push({ root: sr, observer: obs });
}
```

**问题**: `Node.DOCUMENT_FRAGMENT_NODE` 既匹配 ShadowRoot 也匹配普通 DocumentFragment。对于普通 DocumentFragment（如 `document.createDocumentFragment()`），创建的 MutationObserver 永远不会触发（fragment 已脱离 DOM），且 `_shadowObservers` 数组中的条目**永不清理**——清理逻辑在 `onMutation` 第 248-258 行依赖 `entry.root.host` 属性，但普通 DocumentFragment **没有 `host`**。这导致**内存泄漏**：observer 对象和数组条目永久驻留。

**修复**: 在 `observeShadowRoot` 中检查 `sr.host` 或 `sr.mode`，只对真正的 ShadowRoot 创建 observer。

---

## 🟡 中危 — 已修复

### 4. Worker `refreshActiveBackend` 无并发控制（惊群效应）

**文件**: `worker.js` 第 138-154 行

每次翻译请求都调用 `refreshActiveBackend()`（第 362 行），在 PING_INTERVAL 到期后的第一个请求，多个并发的翻译请求会各自独立触发 `Promise.all(BACKENDS.map(pingBackend))`。在扩展的 32 并发下，对 4 个后端短时间内各发起多次 ping，浪费出站请求和可能触发后端限流。

**修复**: 将正在进行的 ping Promise 缓存，后续并发请求复用同一个结果。

---

### 5. `detectSourceLang` 遗漏补充平面 CJK 字符

**文件**: `content-lang.js` 第 30 行, 第 206-208 行

```javascript
var CJK_RE = /[一-鿿㐀-䶿豈-﫿]/;

// 在 detectSourceLang 中：
else if ((c >= 0x4E00 && c <= 0x9FFF) || (c >= 0x3400 && c <= 0x4DBF) ||
    (c >= 0xF900 && c <= 0xFAFF)) {
```

**问题**: Unicode 补充平面（U+20000 以上，如 𠀀、𪜶 等扩展汉字）不被计入 CJK。在包含这些字符的页面（古籍数字化、字书类网站）中，`foreign/cjk` 比值计算偏差，可能导致 `detectSourceLang` 返回错误的源语言（如将中文误判为 `auto` 走通用翻译路径）。

**修复**: 扩展 CJK 检测范围，或使用 `\p{Unified_Ideograph}`（需要 Chrome 110+）。

---

### 6. `activeBackend` 在每次翻译成功时都更新

**文件**: `worker.js` 第 178 行

```javascript
if (translation) {
    activeBackend = backend; // 每次成功都更新 active
    return translation;
}
```

**问题**: `translateText` 轮换后端时，第一个成功的后端就成为新的 `activeBackend`，而不是通过 5 分钟 ping 找出延迟最低的。在网络波动时，一个偶尔快但通常慢的后端可能在竞态中偶然获胜，成为"首选"，导致后续翻译平均延迟上升。

**修复**: `activeBackend` 应仅由 `refreshActiveBackend` 的 ping 结果决定，翻译过程中的后端选择不应改变 active。

---

### 7. SKIP_TAGS 缺少 `TEMPLATE`

**文件**: `content-globals.js` 第 74-78 行

```javascript
var SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT',
    'CODE', 'PRE', 'SVG', 'IFRAME', 'CANVAS',
    'VIDEO', 'AUDIO', 'OBJECT', 'SELECT'
]);
```

**问题**: `<template>` 标签不在跳过列表中。其内容是惰性的 DocumentFragment，通常不会被渲染，但 textContent 仍可被 TreeWalker 遍历到。如果页面使用了大量 `<template>` 元素（如 Lit、Stencil.js 等 Web Component 库），这些内容会被扫描、加入翻译队列，浪费性能且产生无意义的翻译请求。

**修复**: 将 `TEMPLATE` 加入 SKIP_TAGS。

---

### 8. 归档 fallback 中的数字 ID 匹配可能产生误译

**文件**: `content.js` 第 539-555 行

```javascript
// 在 Marker 解析完全失败时，回退到搜索数字 ID：
const idStr = String(item.id);       // e.g. "42"
const idx = result.translation.indexOf(idStr);
if (idx !== -1) {
    const tail = result.translation.slice(idx + idStr.length);
    ...
    const snippet = ...tail.slice(0, end).trim();
    const translated = cleanTranslation(snippet);
    applyTranslation(item.node, item.raw, translated);
}
```

**问题**: 如果翻译结果正文中恰好包含与 marker ID 相同的数字（如 "42 号公路" → 匹配到 ID 42），会导致将正文片段错误地用作译文。虽然概率不高（ID 通常较小且正文不常出现独立数字），但一旦发生用户会看到错误的翻译内容。

**修复**: 优先回退到逐行顺序匹配；仅在两种方法都失败时才使用弱匹配。

---

## 🟢 低危 — 已修复

### 9. `init()` 中等待 `document.body` 的 `load` 事件可能永不触发

**文件**: `content.js` 第 1132-1136 行

```javascript
if (!document.body) {
    await new Promise(r => {
        window.addEventListener('load', r, { once: true });
    });
}
```

**问题**: content script 的 `run_at` 为 `document_idle`（对应 `document.readyState === 'complete'`），此时 `load` 事件早已触发。如果 `document.body` 为 null（理论上不会，但代码预防了这种情况），则 `load` 监听器永远不会触发，导致 Promise **永久 pending**。

**修复**: 同时检查 `document.readyState`，如果已经是 complete 则直接重试获取 body，或用 `requestAnimationFrame` 轮询。

---

### 10. `isSkippable` 对每个节点遍历完整祖先链

**文件**: `content-globals.js` 第 194-200 行

```javascript
function isSkippable(el) {
    while (el) {
        if (SKIP_TAGS.has(el.tagName) || el.isContentEditable) return true;
        el = el.parentElement;
    }
    return false;
}
```

**问题**: 对每个扫描到的文本节点，`isSkippable` 都从父元素遍历到根节点。在深层嵌套页面（如 50+ 层），每次调用都是 O(depth)。若一次扫描有数千个节点，累积开销可观。可以通过标记已检查过的祖先路径来优化。

---

### 11. `seenAdd` 无返回值会导致 `undefined` 传播

**文件**: `content-globals.js` 第 125-136 行

```javascript
function seenAdd(text) {
    if (seenText.has(text)) return;
    ...
    seenText.add(text);
    // 隐式返回 undefined
}
```

**问题**: 函数无显式返回值。虽然当前所有调用点都不使用返回值，但如果未来代码依赖其返回值做判断（如 `if (seenAdd(text))`），`undefined` 会被当作 falsy，导致逻辑错误。

**修复**: 返回 `true` 表示已添加。

---

### 12. `fetchWithTimeout` 和 `fetchWithAbort` 功能重复

**文件**: `background-api.js` 第 178-192 行, 第 278-286 行

两个函数实现了几乎相同的功能（带超时的 fetch），但一个用 `AbortController` 在调用方创建，另一个内部创建。`fetchWithTimeout` 只在 `getMicrosoftToken` 中使用，而 `fetchWithAbort` 被其他所有函数使用。存在代码重复和维护负担——如果超时逻辑需要修改，两处都要改。

**修复**: 统一使用 `fetchWithAbort`，删除 `fetchWithTimeout`。

---

## 🔧 重构 (额外)

### 双引擎协同翻译架构

原来的 `googleOnce` 使用 `Promise.any` 同时竞速两个引擎——每个引擎都收到完整文本，谁先返回就用谁，另一个的结果被丢弃。这导致三个问题：
1. 两个引擎重复处理相同文本，浪费带宽和配额
2. 用户手动选择的引擎偏好被完全无视
3. 两个引擎的能力没有被真正组合利用

重构后的架构：

```
Content Script 发来 marker 文本
         │
         ▼
   google() 智能路由
         │
    ┌────┴──── Marker 格式 + Worker 可用？
    │              │
    │ 是           │ 否
    ▼              ▼
collaborativeTranslate   translateViaEngine
    │                    (Microsoft 优先→Worker 降级)
    │
    ├─ splitMarkerChunks
    ├─ 偶数 chunk → Microsoft ─┐
    ├─ 奇数 chunk → Worker   ─┤
    │                          │
    │         Promise.all 并行 │
    │                          │
    ├── 单引擎失败 → 另一引擎接管重试
    │
    ▼
  合并结果（marker ID 各自保留）
  engine: 'dual'
```

**改动文件**:
- `background-api.js`: 删除 `googleOnce`，新增 `translateViaEngine` + `collaborativeTranslate`，重写 `google`
- `debug.js`: 新增 `dual` 引擎标签样式（紫色）

| # | 严重度 | 文件 | 问题 | 状态 |
|---|--------|------|------|------|
| 1 | 🔴 高 | background.js | 域名同步过滤不一致 → 无限存储写入 | ✅ 已修复 |
| 2 | 🔴 高 | content.js | save_logs 在无 body 页面崩溃 | ✅ 已修复 |
| 3 | 🔴 高 | content.js | 普通 DocumentFragment 导致 observer 泄漏 | ✅ 已修复 |
| 4 | 🟡 中 | worker.js | refreshActiveBackend 惊群效应 | ✅ 已修复 |
| 5 | 🟡 中 | content-lang.js | 补充平面 CJK 字符漏检 | ✅ 已修复 |
| 6 | 🟡 中 | worker.js | activeBackend 翻译成功即更新 | ✅ 已修复 |
| 7 | 🟡 中 | content-globals.js | TEMPLATE 标签未跳过 | ✅ 已修复 |
| 8 | 🟡 中 | content.js | 数字 ID 弱匹配可能误译 | ✅ 已修复 |
| 9 | 🟢 低 | content.js | load 事件 deadlock 风险 | ✅ 已修复 |
| 10 | 🟢 低 | content-globals.js | isSkippable 性能 | ✅ 已优化 |
| 11 | 🟢 低 | content-globals.js | seenAdd 无返回值 | ✅ 已修复 |
| 12 | 🟢 低 | background-api.js | fetchWithTimeout 重复代码 | ✅ 已修复 |
