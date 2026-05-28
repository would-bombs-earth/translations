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

async function getMicrosoftToken() {
    if (_msToken && Date.now() < _msTokenExpiry) return _msToken;
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
// 双引擎协同翻译 — 按 marker 条目平量拆分，两引擎并行处理各一半
// ═══════════════════════════════════════════════════════════

async function collaborativeTranslate(clean, sl, domain, tabId, groupId) {
    // 解析所有 marker 条目
    const entryRegex = new RegExp(
        MARK_L + '(\\d+)' + MARK_R + '[\\s\\S]*?(?=' + MARK_L + '\\d+' + MARK_R + '|$)',
        'g'
    );
    const entries = [];
    let m;
    while ((m = entryRegex.exec(clean)) !== null) {
        entries.push({ id: parseInt(m[1], 10), text: m[0] });
    }

    if (entries.length === 0) {
        // 无 marker — 降级为微软单引擎，结果推送到 content script
        try {
            const result = await enqueueFetch(() => translateViaEngine(clean, sl, domain, 'microsoft'));
            if (result?.translation && tabId) {
                chrome.tabs.sendMessage(tabId, {
                    action: 'apply_translation',
                    translation: result.translation,
                    engine: 'microsoft',
                    groupId: groupId
                }).catch(() => {});
            }
        } catch (e) {
            ERR('MS 降级失败:', e?.message || String(e));
        }
        return;
    }

    // 按文本长度降序排列，贪心分配 → 两个引擎拿到总量接近的文本
    entries.sort((a, b) => b.text.length - a.text.length);
    const msEntries = [];
    const wkEntries = [];
    let msLen = 0, wkLen = 0;
    for (const entry of entries) {
        if (msLen <= wkLen) {
            msEntries.push(entry);
            msLen += entry.text.length;
        } else {
            wkEntries.push(entry);
            wkLen += entry.text.length;
        }
    }

    const msText = msEntries.map(e => e.text).join('\n');
    const wkText = wkEntries.map(e => e.text).join('\n');

    LOG('协同翻译(流式): MS ' + msEntries.length + '条(' + msText.length + '字) | WK '
        + wkEntries.length + '条(' + wkText.length + '字) | sl=' + sl);

    // 辅助：分块后并行发送
    async function translateWithChunking(text, engine) {
        if (!text) return '';
        const chunks = splitMarkerChunks(text, GOOGLE_LIMIT);
        if (chunks.length === 1) {
            const r = await enqueueFetch(() => translateViaEngine(chunks[0], sl, domain, engine));
            return r?.translation || '';
        }
        const results = await Promise.all(
            chunks.map(chunk =>
                enqueueFetch(() => translateViaEngine(chunk, sl, domain, engine))
                    .catch(e => { ERR(engine + ' chunk failed:', e?.message || String(e)); return null; })
            )
        );
        return results.filter(Boolean).map(r => r.translation).filter(Boolean).join('\n');
    }

    // 辅助：翻译文本并通过 sendMessage 推送结果到 content script
    async function translateAndPush(text, engine) {
        if (!text) return { ok: true, engine, text: '' };
        try {
            const result = await translateWithChunking(text, engine);
            if (result && tabId) {
                chrome.tabs.sendMessage(tabId, {
                    action: 'apply_translation',
                    translation: result,
                    engine: engine,
                    groupId: groupId
                }).catch(() => {});
            }
            return { ok: true, engine, text: result };
        } catch (e) {
            ERR(engine + ' 失败:', e?.message || String(e));
            return { ok: false, engine, text: '', error: e };
        }
    }

    // 并行启动两个引擎，各自完成后立即推送结果
    const [msOutcome, wkOutcome] = await Promise.all([
        translateAndPush(msText, 'microsoft'),
        translateAndPush(wkText, 'worker-proxy')
    ]);

    // 容错：一个引擎挂了，另一个接管它的部分
    if (!msOutcome.ok && wkOutcome.ok && msText) {
        LOG('MS 失败 → WK 接管 MS 部分');
        try {
            const retry = await translateWithChunking(msText, 'worker-proxy');
            if (retry && tabId) {
                chrome.tabs.sendMessage(tabId, {
                    action: 'apply_translation',
                    translation: retry,
                    engine: 'worker-proxy',
                    groupId: groupId
                }).catch(() => {});
            }
        } catch (e) { ERR('WK 重试失败:', e?.message || String(e)); }
    }

    if (!wkOutcome.ok && msOutcome.ok && wkText) {
        LOG('WK 失败 → MS 接管 WK 部分');
        try {
            const retry = await translateWithChunking(wkText, 'microsoft');
            if (retry && tabId) {
                chrome.tabs.sendMessage(tabId, {
                    action: 'apply_translation',
                    translation: retry,
                    engine: 'microsoft',
                    groupId: groupId
                }).catch(() => {});
            }
        } catch (e) { ERR('MS 重试失败:', e?.message || String(e)); }
    }

    if (!msOutcome.ok && !wkOutcome.ok) {
        ERR('双引擎全部失败');
    }
}

// ═══════════════════════════════════════════════════════════
// 主翻译入口 (export) — 智能路由
// ═══════════════════════════════════════════════════════════

export async function google(text, sl = 'auto', domain = '', tabId = null, groupId = null) {
    const clean = sanitizeText(text);
    const cacheKey = domain ? domain + '::' + clean : clean;

    const cached = cacheGet(cacheKey);
    if (cached !== undefined) {
        return { translation: cached, engine: '(cache)' };
    }

    const { url } = await getWorkerConfig();
    const hasWorker = !!url;

    // Worker 可用 → 双引擎协同，流式推送结果
    if (hasWorker) {
        collaborativeTranslate(clean, sl, domain, tabId, groupId).catch(e => {
            ERR('协同翻译失败:', e?.message || String(e));
        });
        return { accepted: true };
    }

    // 无 Worker → 微软单引擎
    let result;
    try {
        result = await enqueueFetch(() => translateViaEngine(clean, sl, domain, 'microsoft'));
    } catch (e) {
        ERR('Microsoft 失败:', e?.message || String(e));
    }

    if (!result?.translation) {
        throw new Error('all endpoints failed');
    }

    cacheSet(cacheKey, result.translation);
    return { translation: result.translation, engine: 'microsoft' };
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
