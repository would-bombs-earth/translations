// background.js
// Service Worker — 右键菜单 / 标签状态 / 消息路由
// 翻译 API 逻辑在 background-api.js

import { google, pingBoth, kvList, kvAdd, kvDel, getApiLogs } from './background-api.js';

const _bgBuf = [];
const _bgBufMax = 500;
function _bgLog(method, tag, a) {
  const ts = new Date().toISOString().slice(11, 23);
  const prefix = `[${ts}][${tag}][BG]`;
  console[method](prefix, ...a);
  const line = prefix + ' ' + a.map(x => {
    if (x === null || x === undefined) return String(x);
    if (typeof x === 'object') { try { return JSON.stringify(x); } catch (_) { return String(x); } }
    return String(x);
  }).join(' ');
  _bgBuf.push(line);
  if (_bgBuf.length > _bgBufMax) _bgBuf.shift();
}
function getBgLogs() { return _bgBuf.slice(); }
const LOG = (...a) => _bgLog('log', 'I', a);
const ERR = (...a) => _bgLog('error', 'E', a);

// ═══════════════════════════════════════════════════════════
// 自适应心跳域名同步
// 快速轮询 (1min) → 连续 N 次无变化 → 休眠 (30min) → 唤醒 → 循环
// ═══════════════════════════════════════════════════════════

const HEARTBEAT_ALARM = 'domain_sync';
const FAST_MINUTES = 1;        // 快速轮询间隔 (Chrome alarms 下限)
const SLEEP_MINUTES = 30;      // 休眠时长
const STABLE_LIMIT = 10;       // 连续无变化次数阈值

let _stableCount = 0;
let _asleep = false;

async function syncDomainsFromCloud() {
  try {
    const { workerUrl } = await chrome.storage.local.get('workerUrl');
    if (!workerUrl) return false;

    const cloudDomains = await kvList();
    if (!Array.isArray(cloudDomains)) return false;

    const r = await chrome.storage.local.get('excludedDomains');
    const localDomains = Array.isArray(r.excludedDomains)
      ? r.excludedDomains.filter(d => typeof d === 'string' && d.includes('.'))
      : [];

    const sorted = [...cloudDomains].filter(d => typeof d === 'string' && d.includes('.')).sort();
    if (sorted.length !== localDomains.length || sorted.some((d, i) => d !== localDomains[i])) {
      await chrome.storage.local.set({ excludedDomains: sorted });
      LOG('心跳同步: 域名列表已更新, 共 ' + sorted.length + ' 个');
      return true;
    }
    return false;
  } catch (_) {
    return false;
  }
}

async function setAlarmPeriod(minutes) {
  if (!chrome.alarms) return;
  await chrome.alarms.clear(HEARTBEAT_ALARM);
  chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: minutes });
}

async function onHeartbeat() {
  const changed = await syncDomainsFromCloud();

  if (_asleep) {
    // 休眠结束，切回快速模式
    _asleep = false;
    _stableCount = 0;
    LOG('心跳: 休眠结束，恢复快速轮询 (' + FAST_MINUTES + 'min)');
    await setAlarmPeriod(FAST_MINUTES);
    return;
  }

  _stableCount = changed ? 0 : _stableCount + 1;

  if (_stableCount >= STABLE_LIMIT) {
    _asleep = true;
    _stableCount = 0;
    LOG('心跳: 连续' + STABLE_LIMIT + '次无变化，进入休眠 ' + SLEEP_MINUTES + 'min');
    await setAlarmPeriod(SLEEP_MINUTES);
  }
}

if (chrome.alarms) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === HEARTBEAT_ALARM) onHeartbeat();
  });
}

// 启动: 先同步一次，再开始快速轮询
(async () => {
  await syncDomainsFromCloud();
  await setAlarmPeriod(FAST_MINUTES);
})();

// ═══════════════════════════════════════════════════════════
// 安装
// ═══════════════════════════════════════════════════════════

chrome.runtime.onInstalled.addListener(async () => {
  setupContextMenu();
  chrome.storage.sync.get('autoTranslate', d => {
    if (d.autoTranslate === undefined) {
      chrome.storage.sync.set({ autoTranslate: true });
    }
  });
});

chrome.runtime.onStartup.addListener(() => {
  setupContextMenu();
});

function setupContextMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'toggle_translation',
      title: '极译此页',
      contexts: ['page']
    });
  });
}

// ═══════════════════════════════════════════════════════════
// 标签状态
// ═══════════════════════════════════════════════════════════

async function getTabState(tabId) {
  const key = `tab_${tabId}`;
  const r = await chrome.storage.session.get(key);
  return r[key] ?? false;
}

async function setTabState(tabId, v) {
  await chrome.storage.session.set({ [`tab_${tabId}`]: v });
}

async function updateContextMenu(tabId) {
  try {
    const translated = await getTabState(tabId);
    await chrome.contextMenus.update('toggle_translation', {
      title: translated ? '↩️ 恢复原文' : '极译此页'
    });
  } catch (_) { }
}

// ═══════════════════════════════════════════════════════════
// 标签事件
// ═══════════════════════════════════════════════════════════

chrome.tabs.onActivated.addListener(info => {
  updateContextMenu(info.tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    setTabState(tabId, false).then(() => updateContextMenu(tabId));
  }
});

// 清理已关闭标签页的 session storage，防止泄漏
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(`tab_${tabId}`).catch(() => { });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'session') return;
  for (const key of Object.keys(changes)) {
    if (!key.startsWith('tab_')) continue;
    const tabId = parseInt(key.slice(4), 10);
    if (isNaN(tabId)) continue;
    // 直接按 ID 获取 tab，避免查询 active tab 时的竞态
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) return;
      if (tab?.active) updateContextMenu(tabId);
    });
  }
});

// ═══════════════════════════════════════════════════════════
// 右键菜单
// ═══════════════════════════════════════════════════════════

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id || info.menuItemId !== 'toggle_translation') return;

  const translated = await getTabState(tab.id);
  const newState = !translated;

  try {
    const res = await chrome.tabs.sendMessage(tab.id, {
      action: newState ? 'translate_page' : 'restore_page'
    });
    if (res?.success === true && (newState === false || (res?.count ?? 0) > 0)) {
      await setTabState(tab.id, newState);
    }
  } catch (_) { }

  await updateContextMenu(tab.id);
});

// ═══════════════════════════════════════════════════════════
// 保持 Service Worker 存活
// ═══════════════════════════════════════════════════════════

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'keepAlive') return;
  port.onDisconnect.addListener(() => { chrome.runtime.lastError; });
});

// ═══════════════════════════════════════════════════════════
// 消息路由
// ═══════════════════════════════════════════════════════════

chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
  // 状态同步
  if (req.type === 'update_state') {
    const tabId = sender.tab?.id;
    if (tabId) {
      setTabState(tabId, req.translated)
        .then(() => sendResponse({ ok: true }))
        .catch(() => sendResponse({ ok: false }));
    } else {
      sendResponse({ ok: false });
    }
    return true;
  }

  // 翻译请求 → 委托给 background-api.js（单引擎模式）
  if (req.type === 'translate') {
    const tabId = sender.tab?.id;
    LOG('收到翻译请求, sl=', req.sl, 'text长度=', (req.text || '').length);

    google(req.text || '', req.sl || 'auto', req.domain, tabId, req.groupId)
      .then(r => {
        LOG('翻译成功, 引擎=', r.engine, '结果长度=', (r.translation || '').length);
        sendResponse(r);
      })
      .catch(e => {
        ERR('翻译失败:', e?.message || String(e));
        sendResponse({ error: e?.message || String(e) });
      });

    return true;
  }

  // 引擎延迟测试
  if (req.type === 'ping_engines') {
    pingBoth()
      .then(results => sendResponse({ results }))
      .catch(e => sendResponse({ error: e.message }));
    return true;
  }

  // Worker 配置更新 — 刷新心跳并立即同步域名
  if (req.type === 'worker_config_updated') {
    _asleep = false;
    _stableCount = 0;
    syncDomainsFromCloud().catch(() => { });
    setAlarmPeriod(FAST_MINUTES).catch(() => { });
    sendResponse({ ok: true });
    return false;
  }

  // 引擎选择变更 — 记录到 storage（popup 已写入，此处做日志）
  if (req.type === 'engine_selected') {
    LOG('引擎切换:', req.engine);
    sendResponse({ ok: true });
    return false;
  }

  // KV 域名列表
  if (req.type === 'kv_list') {
    kvList()
      .then(domains => sendResponse({ domains }))
      .catch(e => sendResponse({ error: e.message }));
    return true;
  }

  if (req.type === 'kv_add') {
    kvAdd(req.domain)
      .then(r => sendResponse(r))
      .catch(e => sendResponse({ error: e.message }));
    return true;
  }

  // 导出日志 (合并 background + api 缓冲)
  if (req.type === 'get_logs') {
    sendResponse({ bg: getBgLogs(), api: getApiLogs() });
    return false;
  }

  if (req.type === 'kv_del') {
    kvDel(req.domain)
      .then(r => sendResponse(r))
      .catch(e => sendResponse({ error: e.message }));
    return true;
  }

});
