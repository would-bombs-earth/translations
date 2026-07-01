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

// ═══════════════════════════════════════════════════════════
// 双引擎调度状态
// ═══════════════════════════════════════════════════════════

const _engineCD = { google: 0, microsoft: 0, google_basic: 0 };
const _engineBusy = { google: 0, microsoft: 0, google_basic: 0 };

function _markEngineCooldown(engine) {
  _engineCD[engine] = Date.now() + FETCH_COOLDOWN_MS;
  LOG(`引擎冷却: ${engine} ${FETCH_COOLDOWN_MS}ms`);
}

function _pickEngine(prefer) {
  const now = Date.now();
  const gAvail = _engineCD.google <= now;
  const mAvail = _engineCD.microsoft <= now;
  const bAvail = _engineCD.google_basic <= now;

  const avail = [];
  if (gAvail) avail.push('google');
  if (mAvail) avail.push('microsoft');
  if (bAvail) avail.push('google_basic');

  if (avail.length === 0) {
    return Object.keys(_engineCD).sort((a, b) => _engineCD[a] - _engineCD[b])[0];
  }

  if (avail.length === 1) return avail[0];

  if (prefer && avail.includes(prefer) && _engineBusy[prefer] === 0) return prefer;

  avail.sort((a, b) => {
    const d = _engineBusy[a] - _engineBusy[b];
    if (d !== 0) return d;
    return a < b ? -1 : 1;
  });
  return avail[0];
}

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
async function idbDel(key) {
    const db = await getIDB();
    if (!db) return;
    return new Promise(resolve => {
        try {
            const tx = db.transaction(IDB_STORE, 'readwrite');
            tx.objectStore(IDB_STORE).delete(key);
            tx.oncomplete = () => resolve();
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
const MIN_FETCH_MS = 100; // 100ms = 10 次/秒，降低限制以配合前端更快的并发流式翻译

function enqueueFetch(task) {
    return new Promise((resolve, reject) => {
        fetchQueue.push({ task, resolve, reject });
        pumpFetchQueue();
    });
}

function pumpFetchQueue() {
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
        .catch(e => { item.reject(e); })
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
        var pTranslate = quickTranslate(clean).catch(function() { return { translation: '' }; });
        var ctrl = new AbortController();
        var timer = setTimeout(function() { ctrl.abort(); }, 1200);
        var pDict = fetch('https://dict.youdao.com/jsonapi?q=' + encodeURIComponent(clean), { signal: ctrl.signal })
            .then(function(res) { return res.json(); })
            .catch(function() { return null; })
            .finally(function() { clearTimeout(timer); });

        var dRes = await pDict;

        var dict = null;
        var youdaoMeanings = [];
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
                        youdaoMeanings.push(posMatch[2]);
                    } else {
                        dict.push({ pos: "", meanings: [rawStr] });
                        youdaoMeanings.push(rawStr);
                    }
                }
            }
            if (dict.length === 0) dict = null;
        }

        if (youdaoMeanings.length > 0) {
            return { translation: youdaoMeanings.join('；'), dict: dict };
        }

        var tRes = await pTranslate;
        return { translation: (tRes && tRes.translation) ? tRes.translation : clean, dict: dict };
    } catch (e) {
        return { translation: clean, dict: null };
    }
}

// ═══════════════════════════════════════════════════════════
// 轻量划词翻译 — 绕过 google() 全量流水线，直接 fetch
// ═══════════════════════════════════════════════════════════
export async function quickTranslate(text) {
    var clean = sanitizeText(text.trim());
    if (!clean) return { translation: '' };

    try {
        var translation = await _googleBatchexecuteRequest(clean, 'auto');
        return { translation: translation };
    } catch (e) {
        try {
            var gbasic = await translateViaGoogleBasic(clean, 'auto');
            return { translation: gbasic.translation };
        } catch (ebasic) {
            return { translation: '' };
        }
    }
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

async function translateViaGoogleBasic(text, sl) {
    const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=' + (sl === 'auto' ? 'auto' : sl) + '&tl=zh-CN&dt=t&q=' + encodeURIComponent(text);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException('timeout', 'TimeoutError')), 3000);
    try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) throw new Error('Google Basic HTTP ' + res.status);
        const data = await res.json();
        let translated = '';
        if (data && data[0]) {
            data[0].forEach(item => {
                if (item && item[0]) translated += item[0];
            });
        }
        if (!translated) throw new Error('Google Basic empty');
        return { translation: translated };
    } finally {
        clearTimeout(timer);
    }
}

function parseMarkers(text) {
    const result = new Map();
    const regex = new RegExp(
        MARK_L + '(\\d+)' + MARK_R + '?([\\s\\S]*?)(?=' + MARK_L + '\\d+' + MARK_R + '?|$)',
        'g'
    );
    let match;
    while ((match = regex.exec(text)) !== null) {
        result.set(parseInt(match[1], 10), match[2].trim());
    }
    return result;
}

async function translateViaEngine(text, sl, engine) {
    _engineBusy[engine] = (_engineBusy[engine] || 0) + 1;
    try {
      if (engine === 'microsoft') {
          const res = await translateViaMicrosoft(text, sl);
          return { translation: res.translation, engine: 'microsoft' };
      }
      if (engine === 'google_basic') {
          const res = await translateViaGoogleBasic(text, sl);
          return { translation: res.translation, engine: 'google_basic' };
      }
      if (engine === 'google') {
          const gres = await translateViaGoogle(text, sl);
          var gsingle = gres.translation || '';
          gsingle = gsingle.replace(/⟪\s*(\d+)\s*⟫/g, '⟪$1⟫');

          const rawMap = parseMarkers(text);
          const transMap = parseMarkers(gsingle);
          let mutatedAny = false;

          if (rawMap.size > 0 && transMap.size > 0) {
              for (const [id, rawVal] of rawMap.entries()) {
                  const transVal = transMap.get(id) || '';
                  if (rawVal && /[a-zA-Z]{3,}/.test(rawVal) && (!transVal || !/[一-鿿]/.test(transVal))) {
                      LOG('检测到批次内单项拒译:', rawVal.slice(0, 50));
                      try {
                          const mutatedText = rawVal.replace(/[\(\)\[\]]/g, '') + '.';
                          const gresMutated = await translateViaGoogle(mutatedText, sl);
                          let mutatedTrans = gresMutated.translation || '';
                          mutatedTrans = mutatedTrans.replace(/⟪\s*(\d+)\s*⟫/g, '⟪$1⟫');
                          mutatedTrans = mutatedTrans.replace(new RegExp(MARK_L + '\\d+' + MARK_R, 'g'), '');
                          
                          if (mutatedTrans && /[一-鿿]/.test(mutatedTrans)) {
                              mutatedTrans = mutatedTrans.replace(/。$/, '').trim();
                              transMap.set(id, mutatedTrans);
                              mutatedAny = true;
                              LOG('✅ 批次内单项变异重试成功:', mutatedTrans.slice(0, 50));
                          }
                      } catch (e) {
                          ERR('批次内单项变异重试失败:', e?.message);
                      }
                  }
              }
              if (mutatedAny) {
                  const reconstructed = [];
                  for (const [id, transVal] of transMap.entries()) {
                      reconstructed.push(`${MARK_L}${id}${MARK_R}${transVal}`);
                  }
                  gsingle = reconstructed.join('\n');
              }
          } else {
              if (gsingle && !/[一-鿿]/.test(gsingle) && text && /[a-zA-Z]{3,}/.test(text)) {
                  LOG('触发 Neural MT 拒译，尝试移除括号变异重试...');
                  const mutatedText = text.replace(/[\(\)\[\]]/g, '') + '.';
                  const gresMutated = await translateViaGoogle(mutatedText, sl);
                  var gsingleMutated = gresMutated.translation || '';
                  gsingleMutated = gsingleMutated.replace(/⟪\s*(\d+)\s*⟫/g, '⟪$1⟫');
                  
                  if (gsingleMutated && /[一-鿿]/.test(gsingleMutated)) {
                      gsingleMutated = gsingleMutated.replace(/。$/, '');
                      LOG('✅ 变异重试成功：', gsingleMutated.slice(0, 50));
                      return { translation: gsingleMutated, engine: 'google' };
                  }
                  
                  throw new Error('Google batchexecute returned no Chinese characters (Neural MT fallback issue)');
              }
          }
          return { translation: gsingle, engine: 'google' };
      }
      throw new Error('Unknown engine: ' + engine);
    } catch (e) {
      if (e?.status === 429 || String(e?.message || '').includes('429')) {
          _markEngineCooldown('google');
      }
      if (String(e?.message || '').includes('MS HTTP')) {
          _markEngineCooldown('microsoft');
      }
      if (String(e?.message || '').includes('Google Basic')) {
          _markEngineCooldown('google_basic');
      }
      throw e;
    } finally {
      _engineBusy[engine] = Math.max(0, (_engineBusy[engine] || 1) - 1);
    }
}

// ═══════════════════════════════════════════════════════════
// 主翻译入口 (export)
// ═══════════════════════════════════════════════════════════

export async function google(text, sl = 'auto', domain = '', tabId = null, groupId = null) {
    const clean = sanitizeText(text);
    const cacheKey = (domain ? domain + '::' : '') + sl + '::' + clean;

    const cached = cacheGet(cacheKey);
    if (cached !== undefined) {
        // 自愈机制：如果缓存内容与原文相同，或者对于含有英文词的原文缓存中没有任何中文，判定为损坏缓存
        if (cached === clean || (!/[一-鿿]/.test(cached) && /[a-zA-Z]{3,}/.test(clean))) {
            translationCache.delete(cacheKey);
        } else {
            return { translation: cached, engine: '(cache)' };
        }
    }

    const idbCached = await idbGet(cacheKey);
    if (idbCached !== undefined) {
        if (idbCached === clean || (!/[一-鿿]/.test(idbCached) && /[a-zA-Z]{3,}/.test(clean))) {
            idbDel(cacheKey).catch(() => {});
        } else {
            cacheSet(cacheKey, idbCached); // 回填到内存
            return { translation: idbCached, engine: '(idb)' };
        }
    }

    const { selectedEngine } = await chrome.storage.local.get('selectedEngine');
    const prefer = selectedEngine && selectedEngine !== 'dual' ? selectedEngine : null;
    const allEngines = ['google', 'microsoft', 'google_basic'];
    const engineOrder = prefer && allEngines.includes(prefer)
      ? [prefer, ...allEngines.filter(e => e !== prefer)]
      : allEngines;

    let result = null;
    let engine = engineOrder[0];
    for (const eng of engineOrder) {
      if (_engineCD[eng] > Date.now()) continue;
      try {
        result = await translateWithChunking(clean, sl, eng);
        if (result?.translation) { engine = eng; break; }
      } catch (e) {
        LOG(`⚡ ${eng} 失败:`, e?.message || String(e));
      }
    }

    if (!result?.translation) {
        throw new Error('all endpoints failed');
    }

    if (result.translation) {
        cacheSet(cacheKey, result.translation);
        idbSet(cacheKey, result.translation).catch(() => {});
    }
    return { translation: result.translation, engine: engine };
}

async function translateWithChunking(text, sl, engine) {
    // 发送前预处理，提升译文自然度
    var processed = (engine === 'google' || engine === 'microsoft') ? preprocessForEngine(text) : text;

    // Google / 微软引擎：使用标记文本分块
    var limit = MS_LIMIT;
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
