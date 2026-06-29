// background-api.js
// 翻译 API 模块 — Google 翻译 + 微软翻译 / 缓存 / 并发控制
// 由 background.js (ES Module) import

// ═══════════════════════════════════════════════════════════
// 全局配置
// ═══════════════════════════════════════════════════════════

export const MS_LIMIT = 4500;
export const FETCH_CONCURRENT = 5; // 预翻译 + 常规批次共享队列，提高并发度加速整页流式翻译
export const CACHE_MAX = 10000;
export const CACHE_CLEAN = 1000;
export const FETCH_COOLDOWN_MS = 900; // 触发限流后冷却时间

export const MARK_L = '\u27EA';
export const MARK_R = '\u27EB';

const _apiBuf = [];
const _apiBufMax = 500;
const _S_API = 'background:#0891b2;color:#fff;padding:1px 7px;border-radius:3px;font-weight:600';
const _S_API_ERR = 'background:#ef4444;color:#fff;padding:1px 7px;border-radius:3px;font-weight:600';
const _S_TS = 'color:#6b7280;font-weight:normal';
function _apiLog(method, tag, a) {
    const ts = new Date().toISOString().slice(11, 23);
    const badge = tag === 'E' ? _S_API_ERR : _S_API;
    console[method]('%c 极译·API %c' + ts, badge, _S_TS, ...a);
    const prefix = `[${ts}][${tag}][BG-API]`;
    const line = prefix + ' ' + a.map(x => {
        if (x === null || x === undefined) return String(x);
        if (typeof x === 'object') { try { return JSON.stringify(x); } catch (_) { return String(x); } }
        return String(x);
    }).join(' ');
    _apiBuf.push(line);
    if (_apiBuf.length > _apiBufMax) _apiBuf.shift();
}
export function getApiLogs() { return _apiBuf.slice(); }
const LOG = (...a) => _apiLog('log', 'I', a);
const ERR = (...a) => _apiLog('error', 'E', a);

// ═══════════════════════════════════════════════════════════
// 全局翻译缓存 (LRU)
// ═══════════════════════════════════════════════════════════

const translationCache = new Map();

function cacheGet(key) {
    if (!translationCache.has(key)) return undefined;
    const value = translationCache.get(key);
    translationCache.delete(key);
    translationCache.set(key, value);
    return value;
}

function cacheSet(key, value) {
    if (translationCache.has(key)) translationCache.delete(key);
    translationCache.set(key, value);
    if (translationCache.size > CACHE_MAX) {
        const keys = translationCache.keys();
        for (let i = 0; i < CACHE_CLEAN; i++) {
            const k = keys.next().value;
            if (k === undefined) break;
            translationCache.delete(k);
        }
    }
}

// ═══════════════════════════════════════════════════════════
// IndexedDB 永久缓存 (L2)
// ═══════════════════════════════════════════════════════════

const IDB_NAME = 'TranslationsProDB';
const IDB_STORE = 'translations';
const IDB_MAX = 50000;
let _idbPromise = null;

function getIDB() {
    if (_idbPromise) return _idbPromise;
    _idbPromise = new Promise((resolve, reject) => {
        try {
            const req = indexedDB.open(IDB_NAME, 1);
            req.onupgradeneeded = e => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(IDB_STORE)) {
                    const store = db.createObjectStore(IDB_STORE, { keyPath: 'key' });
                    store.createIndex('ts', 'ts', { unique: false });
                }
            };
            req.onsuccess = e => resolve(e.target.result);
            req.onerror = () => { _idbPromise = null; resolve(null); };
        } catch (_) { _idbPromise = null; resolve(null); }
    });
    return _idbPromise;
}

async function idbGet(key) {
    const db = await getIDB();
    if (!db) return undefined;
    return new Promise(resolve => {
        try {
            const tx = db.transaction(IDB_STORE, 'readonly');
            const req = tx.objectStore(IDB_STORE).get(key);
            req.onsuccess = () => resolve(req.result ? req.result.val : undefined);
            req.onerror = () => resolve(undefined);
        } catch (_) { resolve(undefined); }
    });
}

async function idbSet(key, val) {
    const db = await getIDB();
    if (!db) return;
    return new Promise(resolve => {
        try {
            const tx = db.transaction(IDB_STORE, 'readwrite');
            const store = tx.objectStore(IDB_STORE);
            store.put({ key, val, ts: Date.now() });
            tx.oncomplete = () => {
                // 容量控制: 简单随机/批量清理（避免复杂的游标删除影响性能）
                try {
                    const tx2 = db.transaction(IDB_STORE, 'readwrite');
                    const store2 = tx2.objectStore(IDB_STORE);
                    const countReq = store2.count();
                    countReq.onsuccess = () => {
                        if (countReq.result > IDB_MAX) store2.clear();
                    };
                } catch (_) {}
                resolve();
            };
            tx.onerror = () => resolve();
        } catch (_) { resolve(); }
    });
}

// ═══════════════════════════════════════════════════════════
// fetch 并发调度
// ═══════════════════════════════════════════════════════════

let activeFetches = 0;
const fetchQueue = [];
let _lastFetchAt = 0;
let _fetchPumpScheduled = false;
let _rateLimitCooldownUntil = 0; // 触发 RequestLimitExceeded 后强制冷却
const MIN_FETCH_MS = 100; // 100ms = 10 次/秒，降低限制以配合前端更快的并发流式翻译

function enqueueFetch(task) {
    return new Promise((resolve, reject) => {
        fetchQueue.push({ task, resolve, reject });
        pumpFetchQueue();
    });
}

function _setRateLimitCooldown() {
    _rateLimitCooldownUntil = Date.now() + FETCH_COOLDOWN_MS;
    LOG('触发限流冷却，暂停 ' + FETCH_COOLDOWN_MS + 'ms');
}

function pumpFetchQueue() {
    if (_rateLimitCooldownUntil > Date.now()) {
        // 仍在冷却期，延迟重试
        if (!_fetchPumpScheduled) {
            _fetchPumpScheduled = true;
            setTimeout(() => {
                _fetchPumpScheduled = false;
                pumpFetchQueue();
            }, 200);
        }
        return;
    }

    if (activeFetches >= FETCH_CONCURRENT) return;
    if (fetchQueue.length === 0) return;

    const wait = MIN_FETCH_MS - (Date.now() - _lastFetchAt);
    if (wait > 0) {
        if (!_fetchPumpScheduled) {
            _fetchPumpScheduled = true;
            setTimeout(() => {
                _fetchPumpScheduled = false;
                pumpFetchQueue();
            }, wait + 1);
        }
        return;
    }

    const item = fetchQueue.shift();
    if (!item) return;

    _lastFetchAt = Date.now();
    activeFetches++;

    Promise.resolve()
        .then(() => item.task())
        .then(result => { item.resolve(result); })
        .catch(e => {
            // 检测到限流错误 → 触发冷却
            var msg = e?.message || String(e);
            if (msg.indexOf('RequestLimitExceeded') !== -1) {
                _setRateLimitCooldown();
            }
            item.reject(e);
        })
        .finally(() => {
            activeFetches--;
            pumpFetchQueue();
        });
}

// ═══════════════════════════════════════════════════════════
// 文本处理
// ═══════════════════════════════════════════════════════════

function sanitizeText(text) {
    return text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
}

// Mojibake 检测：UTF-8 被错误解码为 Latin-1/Windows-1252 时产生的乱码字符
// 关键判据：合法中文翻译必然包含 CJK 字符（0x4E00-0x9FFF），乱码不会
function hasMojibake(text) {
    if (!text) return false;
    var bad = 0, cjk = 0, meaningful = 0;
    for (var i = 0; i < text.length; i++) {
        var c = text.charCodeAt(i);
        if (c <= 0x20) continue;
        meaningful++;
        // 只将真正的 Latin-1 乱码范围 (0x80-0xFF) 计入 bad
        // 排除 Unicode 标点 (0x2000-0x206F)、通用标点 (0x2010-0x2027) 等常在
        // 英文文本中出现的合法字符，避免误判英文原文为乱码
        if (c >= 0x80 && c <= 0xFF) bad++;
        else if (c >= 0x4E00 && c <= 0x9FFF) cjk++;
    }
    if (meaningful === 0) return false;
    // 含 CJK → 合法中文译文，不可能是乱码（乱码由 Latin-1 误解码产生，不含 CJK）
    if (cjk > 0) return false;
    // 无 CJK 且 Latin-1 乱码字符占比 > 40% → 判定为乱码
    if (bad > meaningful * 0.40) return true;
    return false;
}

// 通用翻译前预处理：提升译文自然度
// - 合并多余换行为段落分隔
// - 规范化空白字符
// - 保护特殊模式不被断句破坏
function preprocessForEngine(text) {
    // 合并 3+ 连续换行为双换行（保留段落边界）
    text = text.replace(/\n{3,}/g, '\n\n');
    // 空格/Tab 规范化
    text = text.replace(/[\t\r]+/g, ' ');
    // 去除行首尾空白但保留换行结构
    text = text.replace(/[ \t]+\n/g, '\n');
    text = text.replace(/\n[ \t]+/g, '\n');
    return text;
}

// 从 target 位置往回找最近的句子边界 (200 字符窗口)
// 英文: . ! ? 后跟空格/换行; 中文: 。！？；后跟换行; 段落边界: \n\n
function findSentenceSplit(text, target) {
    var searchStart = Math.max(0, target - 200);
    var window = text.slice(searchStart, target);
    var best = -1;
    var breaks = ['. ', '! ', '? ', '.\n', '!\n', '?\n', '\n\n', '\n'];
    for (var b = 0; b < breaks.length; b++) {
        var idx = window.lastIndexOf(breaks[b]);
        if (idx > best) best = idx;
    }
    // 中文标点
    for (var ci = 0; ci < ['。', '！', '？', '，', '、'].length; ci++) {
        var cidx = window.lastIndexOf(['。', '！', '？', '，', '、'][ci]);
        if (cidx > best) best = cidx;
    }
    return best > 0 ? searchStart + best + 1 : target;
}

function splitMarkerChunks(text, limit) {
    const regex = new RegExp(
        MARK_L + '\\d+' + MARK_R + '[\\s\\S]*?(?=' + MARK_L + '\\d+' + MARK_R + '|$)',
        'g'
    );
    const entries = text.match(regex);

    if (!entries) {
        const chunks = [];
        const lines = text.split(/\n/);
        let current = '';
        for (const line of lines) {
            if (current && current.length + line.length + 1 > limit) {
                chunks.push(current);
                current = '';
            }
            current += (current ? '\n' : '') + line;
            while (current.length > limit) {
                var splitAt = findSentenceSplit(current, limit);
                chunks.push(current.slice(0, splitAt));
                current = current.slice(splitAt);
            }
        }
        if (current) chunks.push(current);
        return chunks;
    }

    const chunks = [];
    let current = '';
    for (const item of entries) {
        if (item.length > limit) {
            if (current) { chunks.push(current); current = ''; }
            const markerMatch = item.match(new RegExp('^(' + MARK_L + '\\d+' + MARK_R + ')'));
            const marker = markerMatch ? markerMatch[1] : '';
            const content = marker ? item.slice(marker.length) : item;
            const chunkLimit = limit - marker.length;
            if (chunkLimit <= 0) {
                chunks.push(item);
                continue;
            }
            let remaining = content;
            while (remaining.length > chunkLimit) {
                var splitAt2 = findSentenceSplit(remaining, chunkLimit);
                chunks.push(marker + remaining.slice(0, splitAt2));
                remaining = remaining.slice(splitAt2);
            }
            if (remaining) current = marker + remaining + '\n';
            continue;
        }
        if (current && current.length + item.length + 1 > limit) {
            chunks.push(current);
            current = '';
        }
        current += item + '\n';
    }
    if (current) chunks.push(current);
    return chunks;
}

// ═══════════════════════════════════════════════════════════
// 微软翻译
// ═══════════════════════════════════════════════════════════

function extractMicrosoftText(data) {
    if (!Array.isArray(data)) return '';
    const first = data[0];
    if (first && Array.isArray(first.translations) && first.translations[0]?.text) {
        return first.translations[0].text;
    }
    return '';
}

let _msToken = null;
let _msTokenExpiry = 0;
let _msTokenPromise = null;

async function getMicrosoftToken() {
    if (_msToken && Date.now() < _msTokenExpiry) return _msToken;
    if (_msTokenPromise) return _msTokenPromise;
    _msTokenPromise = (async () => {
        try {
            const res = await fetchWithAbort('https://edge.microsoft.com/translate/auth', {}, 5000);
            if (!res.ok) throw new Error('MS token HTTP ' + res.status);
            _msToken = await res.text();
            try {
                const payload = JSON.parse(atob(_msToken.split('.')[1]));
                _msTokenExpiry = (payload.exp - 300) * 1000;
            } catch (_) {
                _msTokenExpiry = Date.now() + 300000;
            }
            return _msToken;
        } finally {
            _msTokenPromise = null;
        }
    })();
    return _msTokenPromise;
}

async function translateViaMicrosoft(text, sl, retry) {
    const token = await getMicrosoftToken();
    const url = 'https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&to=zh-Hans' +
        (sl !== 'auto' ? '&from=' + sl : '');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException('timeout', 'TimeoutError')), 8000);
    try {
        const res = await fetch(url, {
            method: 'POST',
            signal: controller.signal,
            headers: {
                'Authorization': 'Bearer ' + token,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify([{ Text: text }])
        });
        if (res.status === 401 && !retry) {
            _msToken = null;
            _msTokenExpiry = 0;
            return await translateViaMicrosoft(text, sl, true);
        }
        if (!res.ok) throw new Error('MS HTTP ' + res.status);
        const data = await res.json();
        const translation = extractMicrosoftText(data);
        if (!translation) throw new Error('MS empty');
        if (hasMojibake(translation)) throw new Error('MS response encoding corruption detected');
        return { translation };
    } finally {
        clearTimeout(timer);
    }
}

// ═══════════════════════════════════════════════════════════
// fetch 工具
// ═══════════════════════════════════════════════════════════

async function fetchWithAbort(url, opts = {}, timeoutMs = 10000) {
    if (typeof AbortSignal.timeout === 'function') {
        const existingSignal = opts.signal;
        const timeoutSignal = AbortSignal.timeout(timeoutMs);
        const combinedSignal = existingSignal
            ? AbortSignal.any([existingSignal, timeoutSignal])
            : timeoutSignal;
        return await fetch(url, { ...opts, signal: combinedSignal });
    }
    const ctrl = new AbortController();
    const id = setTimeout(() => ctrl.abort(new DOMException('timeout', 'TimeoutError')), timeoutMs);
    try {
        return await fetch(url, { ...opts, signal: ctrl.signal });
    } finally {
        clearTimeout(id);
    }
}

// ═══════════════════════════════════════════════════════════
// Google 翻译 (网页端 batchexecute 接口)
// ═══════════════════════════════════════════════════════════

async function _googleBatchexecuteRequest(text, sl) {
    const url = 'https://translate.google.com/_/TranslateWebserverUi/data/batchexecute?rpcids=MkEWBc';
    const innerPayload = JSON.stringify([[text, sl === 'auto' ? 'auto' : sl, "zh-CN", true], [null]]);
    const reqData = `f.req=${encodeURIComponent(JSON.stringify([[["MkEWBc", innerPayload, null, "generic"]]]))}&`;

    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
        body: reqData,
        credentials: 'omit'
    });
    
    if (!res.ok) {
        if (res.status === 429) {
            const err = new Error('429');
            err.status = 429;
            throw err;
        }
        throw new Error('Google HTTP ' + res.status);
    }
    
    const rawText = await res.text();
    let innerJsonString = null;
    
    try {
        const jsonStart = rawText.indexOf('[');
        if (jsonStart !== -1) {
            const outerArray = JSON.parse(rawText.slice(jsonStart));
            for (const arr of outerArray) {
                if (Array.isArray(arr) && arr[0] === 'wrb.fr' && arr[1] === 'MkEWBc') {
                    innerJsonString = arr[2];
                    break;
                }
            }
            if (!innerJsonString && Array.isArray(outerArray[0])) innerJsonString = outerArray[0][2];
        }
    } catch (e) {
        // Fallback for custom chunked responses (e.g. trailing chunk numbers)
        const lines = rawText.split('\n');
        for (const line of lines) {
            if (line.includes('"wrb.fr"')) {
                try {
                    const startIdx = line.indexOf('[');
                    const parsed = JSON.parse(line.slice(startIdx));
                    for (const arr of parsed) {
                        if (Array.isArray(arr) && arr[0] === 'wrb.fr') {
                            innerJsonString = arr[2];
                            break;
                        }
                    }
                } catch(e2) {}
            }
            if (innerJsonString) break;
        }
    }
    
    if (!innerJsonString) throw new Error('No inner data');
    
    const innerArray = JSON.parse(innerJsonString);
    let translatedText = '';
    
    if (innerArray && innerArray[1] && innerArray[1][0] && innerArray[1][0][0]) {
        const segments = innerArray[1][0][0][5];
        if (Array.isArray(segments)) {
            translatedText = segments.map(item => (item && item[0]) ? item[0] : '').join('');
        } else if (innerArray[1][0][0][0]) {
            translatedText = innerArray[1][0][0][0]; 
        }
    }
    if (!translatedText) throw new Error('Google batchexecute returned empty translation or unrecognized format');
    return translatedText;
}

async function translateViaGoogle(text, sl) {
    if (!text || !text.trim()) return { translation: '' };
    
    let translatedText = '';
    for (let retry = 0; retry < 2; retry++) {
        try {
            translatedText = await _googleBatchexecuteRequest(text, sl);
            break;
        } catch (e) {
            if (e.status === 429) {
                if (retry < 1) { await new Promise(r => setTimeout(r, 300 * (retry + 1))); continue; }
                throw e;
            }
            if (retry >= 1) { throw e; } else { await new Promise(r => setTimeout(r, 150)); }
        }
    }
    return { translation: translatedText };
}

// ═══════════════════════════════════════════════════════════
// 单词词典查询 — 获取翻译 + 词性标注
// ═══════════════════════════════════════════════════════════

export async function lookupWord(text) {
    var clean = sanitizeText(text.trim());
    if (!clean || !/^[a-zA-Z-]+$/.test(clean) || clean.length > 40) {
        return { translation: '', dict: null };
    }

    try {
        var pTranslate = quickTranslate(clean);
        var pDict = fetch('https://dict.youdao.com/jsonapi?q=' + encodeURIComponent(clean))
            .then(function(res) { return res.json(); })
            .catch(function() { return null; });

        var results = await Promise.all([pTranslate, pDict]);
        var tRes = results[0];
        var dRes = results[1];

        var dict = null;
        if (dRes && dRes.ec && dRes.ec.word && dRes.ec.word[0] && dRes.ec.word[0].trs) {
            dict = [];
            var POS_MAP = { 'n.':'noun','v.':'verb','vt.':'verb','vi.':'verb','adj.':'adjective','adv.':'adverb','prep.':'preposition','conj.':'conjunction','pron.':'pronoun','interj.':'interjection','art.':'article','num.':'noun','int.':'interjection','pl.':'noun' };
            var trs = dRes.ec.word[0].trs;
            for (var i = 0; i < trs.length; i++) {
                if (trs[i].tr && trs[i].tr[0] && trs[i].tr[0].l && trs[i].tr[0].l.i && trs[i].tr[0].l.i[0]) {
                    var rawStr = trs[i].tr[0].l.i[0];
                    var posMatch = rawStr.match(/^([a-zA-Z]+\.)\s*(.+)$/);
                    if (posMatch) {
                        dict.push({ pos: POS_MAP[posMatch[1]] || posMatch[1], meanings: [posMatch[2]] });
                    } else {
                        dict.push({ pos: "", meanings: [rawStr] });
                    }
                }
            }
            if (dict.length === 0) dict = null;
        }

        return { translation: tRes.translation || clean, dict: dict };
    } catch (e) {
        return { translation: clean, dict: null };
    }
}

// ═══════════════════════════════════════════════════════════
// 轻量划词翻译 — 绕过 google() 全量流水线，直接 fetch
// ═══════════════════════════════════════════════════════════
export async function quickTranslate(text) {
    var clean = sanitizeText(text);
    if (!clean) return { translation: '' };

    for (var retry = 0; retry < 2; retry++) {
        try {
            var translation = await _googleBatchexecuteRequest(clean, 'auto');
            return { translation: translation };
        } catch (e) {
            if (e.status === 429) {
                if (retry < 1) { await new Promise(function (r) { setTimeout(r, 300); }); continue; }
                return { translation: '' };
            }
            if (retry >= 1) return { translation: '' };
            await new Promise(function (r) { setTimeout(r, 100); });
        }
    }
    return { translation: '' };
}

// ═══════════════════════════════════════════════════════════
// 快速语言检测 (背景层，无 content-lang.js 依赖) — 用于 API 报 LanguageRecognitionErr 时回退
function _detectSlFromText(text) {
    var kana = 0, hangul = 0, cyrillic = 0, arabic = 0, thai = 0, latin = 0;
    for (var i = 0; i < Math.min(text.length, 500); i++) {
        var c = text.charCodeAt(i);
        if (c >= 0x3040 && c <= 0x30FF) kana++;
        else if (c >= 0xAC00 && c <= 0xD7AF) hangul++;
        else if (c >= 0x0400 && c <= 0x052F) cyrillic++;
        else if (c >= 0x0600 && c <= 0x06FF) arabic++;
        else if (c >= 0x0E00 && c <= 0x0E7F) thai++;
        else if ((c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A)) latin++;
    }
    if (kana > 0) return 'ja';
    if (hangul > 0) return 'ko';
    if (cyrillic > latin && cyrillic > 2) return 'ru';
    if (arabic > latin && arabic > 2) return 'ar';
    if (thai > latin && thai > 2) return 'th';
    return 'en';
}


// 引擎路由
// ═══════════════════════════════════════════════════════════

async function translateViaEngine(text, sl, engine) {
    if (engine === 'microsoft') {
        const res = await translateViaMicrosoft(text, sl);
        return { translation: res.translation, engine: 'microsoft' };
    }
    if (engine === 'google') {
        // batchexecute 接口能够很好地保留 ⟪⟫ 标记，无需再切碎为几十个短句发送，避免触发 Google 400/429 风控
        const gres = await translateViaGoogle(text, sl);
        var gsingle = gres.translation || '';
        
        // 修复引擎可能在标记周围添加的空格
        gsingle = gsingle.replace(/⟪\s*(\d+)\s*⟫/g, '⟪$1⟫');

        if (gsingle && !/[一-鿿]/.test(gsingle) && text && /[a-zA-Z]{3,}/.test(text)) {
            gsingle = text;
        }
        return { translation: gsingle, engine: 'google' };
    }
    throw new Error('Unknown engine: ' + engine);
}

// ═══════════════════════════════════════════════════════════
// 主翻译入口 (export)
// ═══════════════════════════════════════════════════════════

export async function google(text, sl = 'auto', domain = '', tabId = null, groupId = null) {
    const clean = sanitizeText(text);
    const cacheKey = (domain ? domain + '::' : '') + sl + '::' + clean;

    const cached = cacheGet(cacheKey);
    if (cached !== undefined) {
        return { translation: cached, engine: '(cache)' };
    }

    const idbCached = await idbGet(cacheKey);
    if (idbCached !== undefined) {
        cacheSet(cacheKey, idbCached); // 回填到内存
        return { translation: idbCached, engine: '(idb)' };
    }

    const { selectedEngine } = await chrome.storage.local.get('selectedEngine');
    let engine = selectedEngine || 'google';

    let result = null;
    try {
        result = await translateWithChunking(clean, sl, engine);
    } catch (e) {
        ERR(engine + ' 翻译失败:', e?.message || String(e));

        // 自动降级链: google → microsoft
        var fallback = engine === 'google' ? 'microsoft' : 'google';
        LOG(engine + ' 失败 → 降级到 ' + fallback);
        try {
            result = await translateWithChunking(clean, sl, fallback);
            engine = fallback;
        } catch (e2) {
            ERR('降级也失败:', e2?.message || String(e2));
            result = null;
        }
    }

    if (!result?.translation) {
        throw new Error('all endpoints failed');
    }

    if (result && result.translation) {
        cacheSet(cacheKey, result.translation);
        idbSet(cacheKey, result.translation).catch(() => {});
    }
    return { translation: result.translation, engine: engine };
}

async function translateWithChunking(text, sl, engine) {
    // 发送前预处理，提升译文自然度
    var processed = (engine === 'google' || engine === 'microsoft') ? preprocessForEngine(text) : text;

    // Google / 微软引擎：使用标记文本分块
    var limit = engine === 'google' ? MS_LIMIT : MS_LIMIT; // Google batchexecute 支持更大分块，统一使用 4500
    var chunks = splitMarkerChunks(processed, limit);
    if (chunks.length === 1) {
        return await enqueueFetch(() => translateViaEngine(chunks[0], sl, engine));
    }
    LOG('大文本分块: ' + chunks.length + ' 块, engine=' + engine);

    const results = await Promise.all(
        chunks.map(chunk =>
            enqueueFetch(() => translateViaEngine(chunk, sl, engine))
                .catch(e => { ERR(engine + ' chunk:', e?.message || String(e)); return null; })
        )
    );
    if (results.some(r => !r || r.translation == null)) {
        throw new Error('some chunks failed');
    }
    const valid = results.map(r => r.translation);
    return { translation: valid.join('\n'), engine: engine };
}

// ═══════════════════════════════════════════════════════════
// 引擎延迟测试 (export)
// ═══════════════════════════════════════════════════════════

export async function pingMicrosoft() {
    const t0 = performance.now();
    try {
        const result = await translateViaMicrosoft('hi', 'en');
        if (result.translation) {
            return { name: 'microsoft', ms: Math.round(performance.now() - t0), ok: true };
        }
        return { name: 'microsoft', ms: Math.round(performance.now() - t0), ok: false, error: 'empty' };
    } catch (e) {
        return { name: 'microsoft', ms: Math.round(performance.now() - t0), ok: false, error: e?.message || String(e) };
    }
}

export async function pingGoogle() {
    const t0 = performance.now();
    try {
        const result = await translateViaGoogle('hello', 'en');
        if (result.translation) {
            return { name: 'google', ms: Math.round(performance.now() - t0), ok: true };
        }
        return { name: 'google', ms: Math.round(performance.now() - t0), ok: false, error: 'empty' };
    } catch (e) {
        return { name: 'google', ms: Math.round(performance.now() - t0), ok: false, error: e?.message || String(e) };
    }
}

export async function pingBoth() {
    const [gg, ms] = await Promise.all([pingGoogle(), pingMicrosoft()]);
    const results = [gg, ms];
    results.sort((a, b) => {
        if (a.ok !== b.ok) return a.ok ? -1 : 1;
        return a.ms - b.ms;
    });
    return results;
}
