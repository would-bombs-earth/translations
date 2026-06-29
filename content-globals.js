// content-globals.js
// 全局状态、常量、工具函数 — 供 content-lang.js 和 content.js 共用
// 注意: 经典脚本模式下，var 声明的变量在后续加载的文件中均可访问

// ── 日志 (增强版: 时间戳 + 分级 + 样式徽标 + 环形缓冲 + 导出) ──
var LOG_LEVEL = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3, NONE: 4 };
var _logThreshold = LOG_LEVEL.INFO;
var _logBuf = [];
var LOG_BUF_MAX = 500;

var _S_LOG = 'background:#3b82f6;color:#fff;padding:1px 7px;border-radius:3px;font-weight:600';
var _S_WARN = 'background:#f59e0b;color:#fff;padding:1px 7px;border-radius:3px;font-weight:600';
var _S_ERR = 'background:#ef4444;color:#fff;padding:1px 7px;border-radius:3px;font-weight:600';
var _S_DBG = 'background:#6b7280;color:#fff;padding:1px 7px;border-radius:3px;font-weight:600';
var _S_API = 'background:#8b5cf6;color:#fff;padding:1px 7px;border-radius:3px;font-weight:600';
var _S_DOM = 'background:#ec4899;color:#fff;padding:1px 7px;border-radius:3px;font-weight:600';
var _S_STATE = 'background:#f59e0b;color:#fff;padding:1px 7px;border-radius:3px;font-weight:600';
var _S_CACHE = 'background:#2dd4a8;color:#fff;padding:1px 7px;border-radius:3px;font-weight:600';
var _S_TS = 'color:#6b7280;font-weight:normal';

function _logWrite(method, tag, args, catStyle) {
    var ts = new Date().toISOString().slice(11, 23);
    var badge = tag === 'E' ? _S_ERR : tag === 'W' ? _S_WARN : tag === 'D' ? _S_DBG : (catStyle || _S_LOG);
    console[method].apply(console, ['%c 极译·页面 %c' + ts, badge, _S_TS].concat(args));
    var prefix = '[' + ts + '][' + tag + '][Translate]';
    var line = prefix;
    for (var i = 0; i < args.length; i++) {
        var a = args[i];
        if (a === null || a === undefined) { line += ' ' + String(a); }
        else if (typeof a === 'object') { try { line += ' ' + JSON.stringify(a); } catch (_) { line += ' ' + String(a); } }
        else { line += ' ' + a; }
    }
    _logBuf.push(line);
    if (_logBuf.length > LOG_BUF_MAX) _logBuf.shift();
}

var LOG = function () { _logWrite('log', 'I', Array.prototype.slice.call(arguments)); };
var WARN = function () { _logWrite('warn', 'W', Array.prototype.slice.call(arguments)); };
var ERR = function () { _logWrite('error', 'E', Array.prototype.slice.call(arguments)); };
var DEBUG = function () { if (_logThreshold <= LOG_LEVEL.DEBUG) _logWrite('debug', 'D', Array.prototype.slice.call(arguments)); };
var LOG_API = function () { _logWrite('log', 'I', Array.prototype.slice.call(arguments), _S_API); };
var LOG_DOM = function () { _logWrite('log', 'I', Array.prototype.slice.call(arguments), _S_DOM); };
var LOG_STATE = function () { _logWrite('log', 'I', Array.prototype.slice.call(arguments), _S_STATE); };
var LOG_CACHE = function () { _logWrite('log', 'I', Array.prototype.slice.call(arguments), _S_CACHE); };

function setLogThreshold(level) { _logThreshold = level; }
function getLogBuffer() { return _logBuf.slice(); }
function clearLogBuffer() { _logBuf.length = 0; }

function downloadLogs(filename) {
    if (!document.body) return;
    var blob = new Blob([_logBuf.join('\n')], { type: 'text/plain;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename || ('jiyi-' + location.hostname + '-' + new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-') + '.txt');
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(a.href); }, 200);
}

// ── 诊断计数器 ──
var diag = { scanned: 0, tooShort: 0, skipRe: 0, skipCnRe: 0, alreadyChinese: 0, cached: 0, queued: 0, translated: 0, failed: 0, apiErrors: [] };
function _diagReset() { Object.keys(diag).forEach(function (k) { if (k === 'apiErrors') diag[k] = []; else diag[k] = 0; }); }
function _diagLog() {
    LOG('诊断统计:', JSON.stringify(diag), '| queue剩余:', queue.size);
}

// ── 可见错误横幅 ──
var _errorBanner = null;
function showErrorBanner(msg) {
    if (_errorBanner) _errorBanner.remove();
    _errorBanner = document.createElement('div');
    _errorBanner.style.cssText =
        'position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:2147483647;' +
        'background:#f44336;color:#fff;padding:8px 16px;border-radius:8px;' +
        'font-size:13px;font-family:sans-serif;box-shadow:0 2px 12px rgba(0,0,0,0.2);' +
        'cursor:pointer;max-width:90vw;text-align:center;';
    _errorBanner.textContent = '❌ ' + msg + ' （点击关闭）';
    _errorBanner.onclick = function () { _errorBanner.remove(); _errorBanner = null; };
    document.body.appendChild(_errorBanner);
    setTimeout(function () { if (_errorBanner) { _errorBanner.remove(); _errorBanner = null; } }, 8000);
}

// ── Debug hook ──
function _dbg(event, data) {
    try { window.__gt_debug?.[event]?.(data); } catch (_) { }
}

// ── 跳过标签 ──
var SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA',
    'CODE', 'PRE', 'IFRAME', 'CANVAS',
    'VIDEO', 'AUDIO', 'OBJECT', 'TEMPLATE'
]);

// ── 调优参数 ──
var MAX_QUEUE = 200000;
var BATCH_SIZE = 150;
var BATCH_CHARS = 4000; // 降低每批字符数，实现真正的增量流式渲染，避免页面长时间等待整体翻译完成
var CONCURRENT = 5; // 匹配 background fetch 并发数，加速大批次页面翻译
var FLUSH_MS = 50; // 降低延迟打包等待时间，使滚动或新出现的节点几乎瞬间触发翻译
var INCREMENTAL_THRESHOLD = 2; // 极大地降低动态节点触发阈值，使新出现的零散弹窗/动态文本能瞬间被送去翻译
var SOLO_THRESHOLD = 3000; // 超过此长度的文本单独成批（避免大段落导致标记损坏），配合较小的 BATCH_CHARS 可适当调高

// ── 排除域名（跨模块共享：init / SPA 导航检测） ──
var _excludedDomains = [];
function _isDomainExcluded(hostname) {
    if (!hostname) return false;
    var h = hostname.replace(/^www\./, '');
    for (var i = 0; i < _excludedDomains.length; i++) {
        if (_excludedDomains[i] === hostname) return true;
        if (_excludedDomains[i].replace(/^www\./, '') === h) return true;
    }
    return false;
}
var KANA_RE = /[\u3040-\u309F\u30A0-\u30FF\u31F0-\u31FF\uFF65-\uFF9F\u3005\u3031-\u3035]/;
var HANGUL_RE = /[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/;

// ── 标记 ──
// 使用数学符号 ⟪⟫ (U+27EA/U+27EB) 而非中文括号 【】
// 因为 Google 翻译中文时会产出 【】，导致标记冲突
var MARK_L = '\u27EA';
var MARK_R = '\u27EB';
var MARKER_SEQ_RE = /\u27EA\d+\u27EB|(?<=^|\n)\[\d+\]|(?:^|\n)(?:=>|->|>>)\s*\d+\b/g;
function stripMarkerSeqs(s) { return s.replace(MARKER_SEQ_RE, ''); }

// 清理翻译结果中的标记残余和前导/尾随标点符号
// Google 翻译可能将标记 ⟪N⟫ 破坏为 =>、-> 等形式，一并清理
var LEADING_JUNK_RE = /^[。，、；：\s-–—•·◦※＊‣−=>."'\(\)\[\]\{\}<>«»‹›|\\\/@#!~`^+*−–—]+/;
var TRAILING_JUNK_RE = /[。，、；：\s-–—•·◦※＊‣−=>.\"'()\[\]{}<>«»‹›|\\/@#!~`^+*−–—]+$/;
var LONE_MARKER_RE = /[⟪⟫【】\[\]]/g;
var HTML_TAG_RE = /<\/?[a-zA-Z][\w-]*(?:\s[^>]*)?\/?>/g;
var HAS_CJK_RE = /[一-鿿㐀-䶿豈-﫿]/;

var _cleanCache = new Map();
var _CLEAN_CACHE_MAX = 2000;

function cleanTranslation(s) {
    var cached = _cleanCache.get(s);
    if (cached !== undefined) return cached;
    var result = _cleanTranslationImpl(s);
    if (_cleanCache.size >= _CLEAN_CACHE_MAX) {
        var iter = _cleanCache.keys(), del = _CLEAN_CACHE_MAX >> 2;
        for (var i = 0; i < del; i++) _cleanCache.delete(iter.next().value);
    }
    _cleanCache.set(s, result);
    return result;
}

function clearCleanCache() {
    _cleanCache.clear();
}

function _cleanTranslationImpl(s) {
    // 快速路径：无标记符号则跳过 stripMarkerSeqs 和 while 循环
    if (s.indexOf('\u27EA') === -1 && s.indexOf('=>') === -1 && s.indexOf('->') === -1) {
        s = s.trim();
    } else {
        s = stripMarkerSeqs(s).trim();
        // Google 翻译可能将标记破坏为 "=>" 前缀
        while (/^(=>|->|>>)\s*/.test(s)) { s = s.replace(/^(=>|->|>>)\s*/, ''); }
    }
    s = s.replace(LEADING_JUNK_RE, '');
    s = s.replace(TRAILING_JUNK_RE, '');
    s = s.replace(LONE_MARKER_RE, '');
    s = s.replace(HTML_TAG_RE, '');
    s = s.trim();
    if (/^\d+$/.test(s)) return '';
    if (/^[\p{P}\p{S}\s]+$/u.test(s)) return '';
    s = s.trim();
    if (HAS_CJK_RE.test(s)) s = polishChineseText(s);
    return s;
}

// ── 中文译文自然度润色 ──
function polishChineseText(s) {
    s = s.replace(/\.{3,}/g, '…');
    s = s.replace(/。{2,}/g, '…');
    s = s.replace(/([一-鿿㐀-䶿豈-﫿぀-ゟ゠-ヿ]),/g, '$1，');
    s = s.replace(/,([一-鿿㐀-䶿豈-﫿぀-ゟ゠-ヿ])/g, '，$1');
    s = s.replace(/([一-鿿㐀-䶿豈-﫿]);/g, '$1；');
    s = s.replace(/;([一-鿿㐀-䶿豈-﫿])/g, '；$1');
    s = s.replace(/([一-鿿㐀-䶿豈-﫿])\?/g, '$1？');
    s = s.replace(/([一-鿿㐀-䶿豈-﫿])!/g, '$1！');
    s = s.replace(/([一-鿿㐀-䶿豈-﫿]):(?!\/\/|\d)/g, '$1：');
    s = s.replace(/([一-鿿㐀-䶿豈-﫿])\(/g, '$1（');
    s = s.replace(/\)([一-鿿㐀-䶿豈-﫿])/g, '）$1');
    s = s.replace(/([一-鿿㐀-䶿豈-﫿　-〿＀-￯])\s+([一-鿿㐀-䶿豈-﫿　-〿＀-￯])/g, '$1$2');
    s = s.replace(/[０-９]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); });
    s = s.replace(/[Ａ-Ｚ]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); });
    s = s.replace(/[ａ-ｚ]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); });
    s = s.replace(/([一-鿿㐀-䶿豈-﫿])([a-zA-Z0-9])/g, '$1 $2');
    s = s.replace(/([a-zA-Z0-9])([一-鿿㐀-䶿豈-﫿])/g, '$1 $2');
    s = s.replace(/([一-鿿㐀-䶿豈-﫿])\s+([　-〿＀-￯])/g, '$1$2');
    s = s.replace(/([　-〿＀-￯])\s+([一-鿿㐀-䶿豈-﫿])/g, '$1$2');
    s = s.replace(/([。，！？；：])\1+/g, '$1');
    s = s.replace(/"([^"]*[一-鿿㐀-䶿豈-﫿][^"]*)"/g, '“$1”');
    s = s.replace(/'([^']*[一-鿿㐀-䶿豈-﫿][^']*)'/g, '‘$1’');
    s = s.replace(/\s+([。，、；：！？”’）])/g, '$1');
    s = s.replace(/([（“‘])\s+/g, '$1');
    return s;
}

// ── 扩展上下文存活检测 ──
function isAlive() {
    try { return !!chrome.runtime?.id; }
    catch (_) { return false; }
}

// ── 去重 ──
var SEEN_MAX = 5000;
var SEEN_CLEAN = 1000;
var seenText = new Set();

function seenAdd(text) {
    // ME-4: LRU-style eviction — re-add to mark as recently used
    if (seenText.has(text)) {
        seenText.delete(text);
        seenText.add(text);
        return false;
    }
    if (seenText.size >= SEEN_MAX) {
        var iter = seenText.values();
        for (var i = 0; i < SEEN_CLEAN; i++) {
            var v = iter.next().value;
            if (v === undefined) break;
            seenText.delete(v);
        }
    }
    seenText.add(text);
    return true;
}

// ── 跳过模式 ──
var SKIP_RE = /^(?:@[\w.\-]+|#\w+|https?:\/\/\S*|t\.me\/\S*|[\w.\-]+\.(?:com|org|net|io|co|jp|ai|gg|ly|dev|app|xyz|info|me|tv|html|htm|php|pdf|png|jpg|gif|svg|css|js|xml|json)\S*|[=?&\/][\w.\-=?&\/]*|\d[\d:.,\/%+\-\u00d7\u00f7]*[KkMmBb%+]?|[\s\p{P}\p{S}]+)$/u;
var SKIP_CN_RE = /^(?:[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF]{1,10}\s*[a-zA-Z0-9_\-@\.]+|\d[\d.,]*[KkMmBb]?\s+[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF]{1,10})$/u;
var SKIP_COMBINED_RE = /^(?:@[\w.\-]+|#\w+|https?:\/\/\S*|t\.me\/\S*|[\w.\-]+\.(?:com|org|net|io|co|jp|ai|gg|ly|dev|app|xyz|info|me|tv|html|htm|php|pdf|png|jpg|gif|svg|css|js|xml|json)\S*|[=?&\/][\w.\-=?&\/]*|\d[\d:.,\/%+\-\u00d7\u00f7]*[KkMmBb%+]?|[\s\p{P}\p{S}]+|[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF]{1,10}\s*[a-zA-Z0-9_\-@\.]+|\d[\d.,]*[KkMmBb]?\s+[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF]{1,10})$/u;

// \u2500\u2500 ASCII \u975E\u81EA\u7136\u8BED\u8A00\u68C0\u6D4B \u2500\u2500
// \u77ED\u7EAF ASCII \u5B57\u7B26\u4E32\u82E5\u4E0D\u5305\u542B\u81EA\u7136\u8BED\u8A00\u7279\u5F81\uFF08\u7A7A\u683C/\u591A\u5B57\u6BCD\u5355\u8BCD\uFF09\uFF0C\u4E0D\u5E94\u9001\u7FFB\u8BD1\u5F15\u64CE\u3002
// \u8FD9\u4E9B\u662F\u65F6\u95F4\u6233 ("1h")\u3001\u6807\u8BC6\u7B26 ("CS101")\u3001\u7248\u672C\u53F7 ("v2.0") \u7B49\uFF0C\u7FFB\u8BD1\u5F15\u64CE\u4F1A\u7834\u574F\u5B83\u4EEC
var ASCII_NONTEXT_RE = /^[\x00-\x7F]{1,20}$/;
function isAsciiNonText(text) {
    if (!ASCII_NONTEXT_RE.test(text)) return false; // 含非 ASCII 或过长 → 可能是自然语言
    if (/\s/.test(text)) return false;               // 含空格 → 可能是短语
    // 纯字母 3+ 字符 → 可能是单词（如 "Soldier"）
    if (/^[a-zA-Z]{3,}$/.test(text)) return false;
    // 以标点结尾的纯字母+标点（如 "Soldier." / "USG/DoD)"） → 可能是句子片段，应翻译
    if (/^[a-zA-Z][a-zA-Z0-9&\/\-',:;]*[.!?)»"']{1,2}$/.test(text) && text.replace(/[^a-zA-Z]/g, '').length >= 3) return false;
    return true;
}

// UI 品牌/产品名称跳过：短首字母大写单词，常为平台专有名词不应翻译
var _UI_BRAND_SET = new Set([
    'Premium', 'Grok', 'Posts', 'Replies', 'Media', 'Likes',
    'Following', 'Followers', 'Verified', 'Subscribe', 'Chat',
    'Home', 'Explore', 'Notifications', 'Messages', 'Bookmarks',
    'Lists', 'Topics', 'Spaces', 'Settings', 'More', 'Post',
    'Repost', 'Quote', 'Follow', 'Unfollow', 'Block', 'Mute', 'Report',
    'Sign', 'Account', 'Profile', 'Log', 'Help', 'About'
]);
function _isUiBrandName(text) {
    if (text.length > 15 || !/^[A-Z][a-z]*$/.test(text)) return false;
    return _UI_BRAND_SET.has(text);
}

// ── 状态 ──
var observer = null;
var translating = false;
var _muteDepth = 0;
var uid = 1;
var batchSeq = 0;
var tMode = 'off';

var queue = new Set();
var CACHE_MAX = 5000;
var CACHE_CLEAN = 1000;
var cache = new Map();

// ── 还原追踪 ──
var origTextMap = new WeakMap();
var origAttrMap = new WeakMap();

function unregisterTextRestore(node) {
    origTextMap.delete(node);
    delete node.__gt_orig;
}

// ── 缓存 ──
function cacheGet(key) {
    if (!cache.has(key)) return undefined;
    var value = cache.get(key);
    cache.delete(key);
    cache.set(key, value);
    return value;
}

function cacheSet(key, value) {
    if (cache.has(key)) cache.delete(key);
    cache.set(key, value);
    if (cache.size > CACHE_MAX) {
        var iter = cache.keys();
        for (var i = 0; i < CACHE_CLEAN; i++) {
            var k = iter.next().value;
            if (k === undefined) break;
            cache.delete(k);
        }
    }
}

// ── Observer 静默（引用计数，支持嵌套调用） ──
var _onMuteReleased = null; // hook，由 content.js 设置，mute 释放时调用以调度恢复扫描
var _missedMutations = false; // content.js 在 mute 期间丢弃 charData/attr 变更时设为 true
function mute(fn) {
    _muteDepth++;
    try { fn(); }
    finally {
        _muteDepth--;
        if (_muteDepth === 0 && _missedMutations) {
            _missedMutations = false;
            if (typeof _onMuteReleased === 'function') _onMuteReleased();
        }
    }
}

// ── DOM 辅助 ──
var _skipChecked = new WeakSet();
// 已知不可跳过的元素缓存（反向缓存，避免对深层 DOM 重复爬父链）
// 注意：此缓存仅对元素标签检测有效，不缓存 contentEditable 结果
var _notSkippable = new WeakSet();
var _MAX_SKIP_DEPTH = 20; // 父链向上爬的最大深度（推特 DOM 层级可超过 15 层）
function isSkippable(el) {
    // Fast path: this exact element was already checked by tag-based skip and is skippable
    if (_skipChecked.has(el)) return true;
    // Fast path: this element was recently checked and is NOT skippable (avoids deep parent walks)
    // Only trust this cache if _MAX_SKIP_DEPTH was sufficient to reach BODY — otherwise
    // a SKIP_TAGS ancestor or contentEditable could be lurking beyond the depth limit
    if (_notSkippable.has(el)) return false;
    var cur = el;
    var depth = 0;
    while (cur && depth < _MAX_SKIP_DEPTH) {
        // contentEditable 检测不缓存——Twitter 等 React SPA 可能复用 DOM 元素，
        // 导致之前位于 contenteditable 区域内的元素被永久标记为可跳过
        if (cur.isContentEditable) return true;
        if (SKIP_TAGS.has(cur.tagName)) {
            _skipChecked.add(el); // 仅缓存标签检测结果（标签在元素生命周期内不变）
            return true;
        }
        cur = cur.parentElement;
        depth++;
    }
    // 爬到深度上限仍未匹配 → 大概率不跳过。
    // 只有真正到达 document.body 或 document.documentElement 时才缓存，
    // 避免缓存因 DOM 层级限制而可能漏掉 SKIP_TAGS 祖先的情况
    if (!cur || cur === document.body || cur === document.documentElement) {
        _notSkippable.add(el);
    }
    el.__gtSafe = true;
    return false;
}

function normalize(text) {
    return text.replace(/\s+/gu, ' ').trim();
}

// ── Shadow DOM ──
var _oS = new WeakSet();
var _shadowObservers = [];

// Find all open shadow roots within a subtree
function shadowRootsIn(root) {
    var roots = [];
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    while (walker.nextNode()) {
        if (walker.currentNode.shadowRoot) {
            roots.push(walker.currentNode.shadowRoot);
        }
    }
    return roots;
}

// Deep querySelectorAll including shadow DOM
function querySelectorAllDeep(root, selector) {
    var results = [];
    try {
        var nodes = root.querySelectorAll(selector);
        for (var i = 0; i < nodes.length; i++) results.push(nodes[i]);
    } catch (_) { }
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    while (walker.nextNode()) {
        if (walker.currentNode.shadowRoot) {
            var deeper = querySelectorAllDeep(walker.currentNode.shadowRoot, selector);
            for (var k = 0; k < deeper.length; k++) results.push(deeper[k]);
        }
    }
    return results;
}

// ── 可翻译属性 ──
var TRANSLATABLE_ATTRS = ['title', 'alt', 'placeholder', 'aria-label', 'aria-description', 'aria-roledescription', 'aria-valuetext', 'label', 'value'];

function isButtonInput(el) {
    if (!el || el.tagName !== 'INPUT') return false;
    var type = (el.getAttribute('type') || 'text').toLowerCase();
    return type === 'submit' || type === 'button' || type === 'reset';
}

function isSvgMeta(el) {
    if (!el || el.namespaceURI !== 'http://www.w3.org/2000/svg') return false;
    var tag = el.tagName.toLowerCase();
    return tag === 'title' || tag === 'desc';
}
var translatedAttrs = new WeakMap();