// content-globals.js
// 全局状态、常量、工具函数 — 供 content-lang.js 和 content.js 共用
// 注意: 经典脚本模式下，var 声明的变量在后续加载的文件中均可访问

// ── 日志 (增强版: 时间戳 + 分级 + 环形缓冲 + 导出) ──
var LOG_LEVEL = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3, NONE: 4 };
var _logThreshold = LOG_LEVEL.INFO;
var _logBuf = [];
var LOG_BUF_MAX = 500;

function _logWrite(method, tag, args) {
    var ts = new Date().toISOString().slice(11, 23);
    var prefix = '[' + ts + '][' + tag + '][Translate]';
    console[method].apply(console, [prefix].concat(args));
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
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT',
    'CODE', 'PRE', 'SVG', 'IFRAME', 'CANVAS',
    'VIDEO', 'AUDIO', 'OBJECT', 'SELECT', 'TEMPLATE'
]);

// ── 调优参数 ──
var MAX_QUEUE = 50000;
var BATCH_SIZE = 128;
var BATCH_CHARS = 8400;
var CONCURRENT = 32;
var FLUSH_MS = 0;
var HYDRATION_DELAY_MS = 3500; // React/Vue/Next.js 水合等待
var SOLO_THRESHOLD = 150;
var INCREMENTAL_THRESHOLD = 10; // 队列累积到达此数即触发增量发送

// ── 排除域名（跨模块共享：init / SPA 导航检测） ──
var _excludedDomains = [];
var KANA_RE = /[\u3040-\u309F\u30A0-\u30FF\u31F0-\u31FF\uFF65-\uFF9F]/;
var HANGUL_RE = /[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/;

// ── 标记 ──
// 使用数学符号 ⟪⟫ (U+27EA/U+27EB) 而非中文括号 【】
// 因为 Google 翻译中文时会产出 【】，导致标记冲突
var MARK_L = '\u27EA';
var MARK_R = '\u27EB';
var MARKER_SEQ_RE = /\u27EA\d+\u27EB|(?<=^|\n)\[\d+\]/g;
function stripMarkerSeqs(s) { return s.replace(MARKER_SEQ_RE, ''); }

// 清理翻译结果中的标记残余和前导/尾随标点
var LEADING_PUNCT_RE = /^[\u3002\uFF0C\u3001\uFF1B\uFF1A\s]+/;
var TRAILING_PUNCT_RE = /[\u3002\uFF0C\u3001\uFF1B\uFF1A\s]+$/;
var LONE_MARKER_RE = /[\u27EA\u27EB\u3010\u3011]/g;
function cleanTranslation(s) {
    s = stripMarkerSeqs(s).trim();
    s = s.replace(LEADING_PUNCT_RE, '');
    s = s.replace(TRAILING_PUNCT_RE, '');
    s = s.replace(LONE_MARKER_RE, '').trim();
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

// ── 状态 ──
var observer = null;
var translating = false;
var _muteDepth = 0;
var uid = 1;
var batchSeq = 0;
var translationMode = 'off';

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
function mute(fn) {
    _muteDepth++;
    try { fn(); }
    finally { _muteDepth--; }
}

// ── DOM 辅助 ──
var _skipChecked = new WeakSet();
function isSkippable(el) {
    // Fast path: this exact element was already checked and is skippable
    if (_skipChecked.has(el)) return true;
    var cur = el;
    while (cur) {
        if (SKIP_TAGS.has(cur.tagName) || cur.isContentEditable) {
            _skipChecked.add(el); // cache: any ancestor that makes this node skippable
            return true;
        }
        cur = cur.parentElement;
    }
    return false;
}

function normalize(text) {
    return text.replace(/\s+/gu, ' ').trim();
}

// ── Shadow DOM ──
var observedShadows = new WeakSet();
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

function querySelectorAllDeep(root, selector) {
    var results = [].slice.call(root.querySelectorAll(selector));
    var roots = shadowRootsIn(root);
    for (var i = 0; i < roots.length; i++) {
        results.push.apply(results, querySelectorAllDeep(roots[i], selector));
    }
    return results;
}

// ── 可翻译属性 ──
var TRANSLATABLE_ATTRS = ['title', 'alt', 'placeholder', 'aria-label'];
var translatedAttrs = new WeakMap();