// background-api.js
// 翻译 API 模块 — 双引擎 (Microsoft 直连 + Worker 代理) / 缓存 / 并发控制
// 由 background.js (ES Module) import

// ═══════════════════════════════════════════════════════════
// Worker 代理配置 — 用户通过 popup 面板自行填入 (存于 chrome.storage.local)
// ═══════════════════════════════════════════════════════════

async function getWorkerConfig() {
    const data = await chrome.storage.local.get(['workerUrl', 'workerToken']);
    let raw = (data.workerUrl || '').replace(/\/+$/, '');
    // 自动补全协议
    if (raw && !/^https?:\/\//i.test(raw)) {
        raw = 'https://' + raw;
    }
    return {
        url: raw,
        token: data.workerToken || ''
    };
}

export const GOOGLE_LIMIT = 4500;
export const FETCH_CONCURRENT = 9999;
export const CACHE_MAX = 10000;
export const CACHE_CLEAN = 1000;

export const MARK_L = '\u27EA';
export const MARK_R = '\u27EB';

const _apiBuf = [];
const _apiBufMax = 500;
function _apiLog(method, tag, a) {
    const ts = new Date().toISOString().slice(11, 23);
    const prefix = `[${ts}][${tag}][BG-API]`;
    console[method](prefix, ...a);
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
// fetch 并发调度
// ═══════════════════════════════════════════════════════════

let activeFetches = 0;
const fetchQueue = [];

function enqueueFetch(task) {
    return new Promise((resolve, reject) => {
        fetchQueue.push({ task, resolve, reject });
        pumpFetchQueue();
    });
}

async function pumpFetchQueue() {
    if (activeFetches >= FETCH_CONCURRENT) return;
    const item = fetchQueue.shift();
    if (!item) return;
    activeFetches++;
    try {
        const result = await item.task();
        item.resolve(result);
    } catch (e) {
        item.reject(e);
    } finally {
        activeFetches--;
        pumpFetchQueue();
    }
}

// ═══════════════════════════════════════════════════════════
// 文本处理
// ═══════════════════════════════════════════════════════════

function sanitizeText(text) {
    return text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
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
                chunks.push(current.slice(0, limit));
                current = current.slice(limit);
            }
        }
        if (current) chunks.push(current);
        return chunks;
    }

    const chunks = [];
    let current = '';
    for (const item of entries) {
        // 单个条目本身超过限制：强制拆分
        if (item.length > limit) {
            // 先刷出 current
            if (current) { chunks.push(current); current = ''; }
            // 提取标记前缀 (⟪N⟫) 并在拆分时保留
            const markerMatch = item.match(new RegExp('^(' + MARK_L + '\\d+' + MARK_R + ')'));
            const marker = markerMatch ? markerMatch[1] : '';
            const content = marker ? item.slice(marker.length) : item;
            const chunkLimit = limit - marker.length;
            if (chunkLimit <= 0) {
                // Marker itself exceeds limit (extremely unlikely) — push raw
                chunks.push(item);
                continue;
            }
            let remaining = content;
            while (remaining.length > chunkLimit) {
                chunks.push(marker + remaining.slice(0, chunkLimit));
                remaining = remaining.slice(chunkLimit);
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
// 端点定义与轮换
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
let _msTokenPromise = null; // HI-1: Promise 锁防止并发 token 请求

async function getMicrosoftToken() {
    if (_msToken && Date.now() < _msTokenExpiry) return _msToken;
    if (_msTokenPromise) return _msTokenPromise; // 复用进行中的请求
    _msTokenPromise = (async () => {
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
    })();
    return _msTokenPromise.finally(() => { _msTokenPromise = null; });
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
        return { translation };
    } finally {
        clearTimeout(timer);
    }
}

// ═══════════════════════════════════════════════════════════
// ─── Worker 代理翻译 ───
// ═══════════════════════════════════════════════════════════

async function fetchWithAbort(url, opts = {}, timeoutMs = 10000) {
    // LO-2: 使用 AbortSignal.timeout 替代手动 setTimeout，避免已完成请求的冗余 abort
    if (typeof AbortSignal.timeout === 'function') {
        const existingSignal = opts.signal;
        const timeoutSignal = AbortSignal.timeout(timeoutMs);
        const combinedSignal = existingSignal
            ? AbortSignal.any([existingSignal, timeoutSignal])
            : timeoutSignal;
        return await fetch(url, { ...opts, signal: combinedSignal });
    }
    // Fallback for older environments
    const ctrl = new AbortController();
    const id = setTimeout(() => ctrl.abort(new DOMException('timeout', 'TimeoutError')), timeoutMs);
    try {
        return await fetch(url, { ...opts, signal: ctrl.signal });
    } finally {
        clearTimeout(id);
    }
}

async function translateViaWorker(text, sl, domain = '') {
    const { url, token } = await getWorkerConfig();
    if (!url) throw new Error('Worker 未配置');
    const res = await fetchWithAbort(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + token
        },
        body: JSON.stringify({ text, sl, domain })
    }, 15000);
    if (!res.ok) {
        let detail = 'HTTP ' + res.status;
        try { const d = await res.json(); if (d.error) detail += ': ' + d.error; } catch (_) { }
        throw new Error('Worker ' + detail);
    }
    const data = await res.json();
    if (!data.translation) throw new Error('Worker empty');
    return { translation: data.translation };
}

// ═══════════════════════════════════════════════════════════
// 单引擎翻译 — 指定引擎名，直接调用对应后端
// ═══════════════════════════════════════════════════════════

async function translateViaEngine(text, sl, domain, engine) {
    if (engine === 'microsoft') {
        const res = await translateViaMicrosoft(text, sl);
        return { translation: res.translation, engine: 'microsoft' };
    }
    if (engine === 'worker-proxy') {
        const res = await translateViaWorker(text, sl, domain);
        return { translation: res.translation, engine: 'worker-proxy' };
    }
    throw new Error('Unknown engine: ' + engine);
}

// ═══════════════════════════════════════════════════════════
// 主翻译入口 (export) — 单引擎模式，用户自行选择
// ═══════════════════════════════════════════════════════════

// CR-1: keepAlive port 集合，防止 SW 在翻译中途被终止
const _keepAlivePorts = new Map();

function _acquireKeepAlive() {
    const port = chrome.runtime.connect({ name: 'keepAlive' });
    const id = Date.now() + '-' + Math.random().toString(36).slice(2);
    _keepAlivePorts.set(id, port);
    return { port, id };
}

function _releaseKeepAlive(id) {
    const port = _keepAlivePorts.get(id);
    if (port) {
        _keepAlivePorts.delete(id);
        port.disconnect();
    }
}

export async function google(text, sl = 'auto', domain = '', tabId = null, groupId = null) {
    // CR-1: 获取 keepAlive port 防止 SW 被终止
    const ka = typeof chrome !== 'undefined' && chrome.runtime?.connect
        ? _acquireKeepAlive() : null;
    try {
    const clean = sanitizeText(text);
    const cacheKey = domain ? domain + '::' + clean : clean;

    const cached = cacheGet(cacheKey);
    if (cached !== undefined) {
        return { translation: cached, engine: '(cache)' };
    }

    // 读取用户选择的引擎，默认 Worker 代理
    const { selectedEngine } = await chrome.storage.local.get('selectedEngine');
    let engine = selectedEngine || 'worker-proxy';

    // 如果选了 Worker 但未配置，降级到微软
    if (engine === 'worker-proxy') {
        const { url } = await getWorkerConfig();
        if (!url) {
            LOG('Worker 未配置，降级到微软翻译');
            engine = 'microsoft';
        }
    }

    // 单引擎翻译（含大文本分块）
    let result = null; // HI-3: 显式初始化为 null
    try {
        result = await translateWithChunking(clean, sl, domain, engine);
    } catch (e) {
        ERR(engine + ' 翻译失败:', e?.message || String(e));
        // 尝试降级到另一引擎
        const fallback = engine === 'microsoft' ? 'worker-proxy' : 'microsoft';
        try {
            const { url: fbUrl } = await getWorkerConfig();
            if (fallback === 'worker-proxy' && !fbUrl) throw new Error('Worker 未配置');
            LOG(engine + ' 失败 → 降级到 ' + fallback);
            result = await translateWithChunking(clean, sl, domain, fallback);
            engine = fallback;
        } catch (e2) {
            ERR('降级也失败:', e2?.message || String(e2));
            result = null; // HI-3: 确保失败后 result 为 null
        }
    }

    if (!result?.translation) {
        throw new Error('all endpoints failed');
    }

    cacheSet(cacheKey, result.translation);
    return { translation: result.translation, engine: engine };
    } finally {
        // CR-1: 释放 keepAlive，但延迟 200ms 确保 sendResponse 先发送
        if (ka) setTimeout(() => _releaseKeepAlive(ka.id), 200);
    }
}

// ── 单引擎翻译 + 大文本自动分块 ──
async function translateWithChunking(text, sl, domain, engine) {
    const chunks = splitMarkerChunks(text, GOOGLE_LIMIT);
    if (chunks.length === 1) {
        return await enqueueFetch(() => translateViaEngine(chunks[0], sl, domain, engine));
    }
    LOG('大文本分块: ' + chunks.length + ' 块, engine=' + engine);
    const results = await Promise.all(
        chunks.map(chunk =>
            enqueueFetch(() => translateViaEngine(chunk, sl, domain, engine))
                .catch(e => { ERR(engine + ' chunk:', e?.message || String(e)); return null; })
        )
    );
    // HI-3: 使用 .filter(r => r && r.translation) 避免空字符串被滤掉
    const valid = results.filter(r => r && r.translation != null).map(r => r.translation);
    if (!valid.length) throw new Error('all chunks failed');
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
        return { name: 'microsoft', ms: Math.round(performance.now() - t0), ok: false, error: e.message };
    }
}

export async function pingWorker() {
    const { url, token } = await getWorkerConfig();
    if (!url) {
        return { name: 'worker-proxy', ms: 0, ok: false, error: '未配置' };
    }
    const t0 = performance.now();
    const healthUrl = url.replace(/\/+$/, '') + '/health';
    LOG('pingWorker →', healthUrl);
    try {
        const res = await fetchWithAbort(healthUrl, {}, 10000);
        const ms = Math.round(performance.now() - t0);
        LOG('pingWorker ←', res.status, ms + 'ms');
        if (res.ok) {
            return { name: 'worker-proxy', ms, ok: true };
        }
        return { name: 'worker-proxy', ms, ok: false, error: 'HTTP ' + res.status };
    } catch (e) {
        ERR('pingWorker ✗', healthUrl, e?.message || String(e));
        return { name: 'worker-proxy', ms: Math.round(performance.now() - t0), ok: false, error: e.message };
    }
}

export async function pingBoth() {
    const [ms, worker] = await Promise.all([pingMicrosoft(), pingWorker()]);
    const results = [ms, worker];
    results.sort((a, b) => {
        if (a.ok !== b.ok) return a.ok ? -1 : 1;
        return a.ms - b.ms;
    });
    return results;
}

// ═══════════════════════════════════════════════════════════
// KV 域名列表同步 (export)
// ═══════════════════════════════════════════════════════════

export async function kvList() {
    const { url, token } = await getWorkerConfig();
    if (!url) throw new Error('Worker 未配置');
    const res = await fetchWithAbort(url + '/kv/list', {
        headers: { 'Authorization': 'Bearer ' + token }
    }, 10000);
    if (!res.ok) throw new Error('KV list HTTP ' + res.status);
    const data = await res.json();
    return Array.isArray(data.domains) ? data.domains : [];
}

export async function kvAdd(domain) {
    const { url, token } = await getWorkerConfig();
    if (!url) throw new Error('Worker 未配置');
    const res = await fetchWithAbort(url + '/kv/add', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + token
        },
        body: JSON.stringify({ domain })
    }, 10000);
    if (!res.ok) throw new Error('KV add HTTP ' + res.status);
    return await res.json();
}

export async function kvDel(domain) {
    const { url, token } = await getWorkerConfig();
    if (!url) throw new Error('Worker 未配置');
    const res = await fetchWithAbort(url + '/kv/del', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + token
        },
        body: JSON.stringify({ domain })
    }, 10000);
    if (!res.ok) throw new Error('KV del HTTP ' + res.status);
    return await res.json();
}