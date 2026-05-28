// options.js - 弹出面板 v3 (双引擎卡片)

const $ = id => document.getElementById(id);

const autoChk = $('autoTranslate');
const actionBtn = $('action');
const actionLabel = $('actionLabel');
const statusEl = $('status');
const stateIcon = $('stateIcon');
const stateText = $('stateText');
const cardDual = $('cardDual');
const latencyDualMs = $('latencyDualMs');
const latencyDualWk = $('latencyDualWk');
const netError = $('netError');

let currentTabId = null;
let isTranslated = false;
let busy = false;

// ══════════════════════════════════════════════════════
// ── 引擎卡片延迟渲染 ──
// ══════════════════════════════════════════════════════

function latencyClass(ms) {
  if (ms <= 200) return 'fast';
  if (ms <= 600) return 'mid';
  if (ms <= 2000) return 'slow';
  return 'dead';
}

async function pingAndRender() {
  const { workerUrl } = await chrome.storage.local.get('workerUrl');

  latencyDualMs.textContent = 'MS —';
  latencyDualMs.className = 'eng-card-latency testing';
  latencyDualWk.textContent = 'WK —';
  latencyDualWk.className = 'eng-card-latency testing';
  cardDual.classList.remove('selected');
  netError.classList.remove('show');

  if (!workerUrl) {
    latencyDualMs.textContent = 'MS —';
    latencyDualMs.className = 'eng-card-latency testing';
    latencyDualWk.textContent = 'WK 未配置';
    latencyDualWk.className = 'eng-card-latency dead';
    netError.classList.add('show');
    return;
  }

  try {
    const resp = await chrome.runtime.sendMessage({ type: 'ping_engines' });
    if (!resp || !resp.results || !resp.results.length) {
      showBothDead();
      return;
    }

    const results = resp.results;
    const msResult = results.find(r => r.name === 'microsoft');
    const workerResult = results.find(r => r.name === 'worker-proxy');

    // 渲染微软延迟
    if (msResult?.ok) {
      latencyDualMs.textContent = 'MS ' + msResult.ms + 'ms';
      latencyDualMs.className = 'eng-card-latency ' + latencyClass(msResult.ms);
      latencyDualMs.removeAttribute('data-tooltip');
    } else {
      latencyDualMs.textContent = 'MS 不可用';
      latencyDualMs.className = 'eng-card-latency dead';
      if (msResult?.error) latencyDualMs.setAttribute('data-tooltip', msResult.error);
    }

    // 渲染 Worker 延迟
    if (workerResult?.ok) {
      latencyDualWk.textContent = 'WK ' + workerResult.ms + 'ms';
      latencyDualWk.className = 'eng-card-latency ' + latencyClass(workerResult.ms);
      latencyDualWk.removeAttribute('data-tooltip');
    } else {
      latencyDualWk.textContent = 'WK 不可用';
      latencyDualWk.className = 'eng-card-latency dead';
      if (workerResult?.error) latencyDualWk.setAttribute('data-tooltip', workerResult.error);
    }

    const msOk = msResult?.ok;
    const wkOk = workerResult?.ok;

    if (msOk && wkOk) {
      cardDual.classList.add('selected');
    } else if (!msOk && !wkOk) {
      netError.classList.add('show');
      actionBtn.classList.add('disabled');
    } else {
      // 部分可用 — 仍然 selected，但提示降级
      cardDual.classList.add('selected');
    }
  } catch (e) {
    showBothDead();
  }
}

function showBothDead() {
  latencyDualMs.textContent = 'MS 不可用';
  latencyDualMs.className = 'eng-card-latency dead';
  latencyDualWk.textContent = 'WK 不可用';
  latencyDualWk.className = 'eng-card-latency dead';
  netError.classList.add('show');
  actionBtn.classList.add('disabled');
}

// ══════════════════════════════════════════════════════
// ── 初始化 ──
// ══════════════════════════════════════════════════════

(async function init() {
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true
    });

    if (!tab?.id) {
      setUnavailable('无法获取页面信息');
      return;
    }

    currentTabId = tab.id;

    const { autoTranslate } = await chrome.storage.sync.get('autoTranslate');
    autoChk.checked = autoTranslate !== false;

    isTranslated = await getTabTranslatedState(currentTabId);

    updateUI();
    pingAndRender();
  } catch (e) {
    setUnavailable('初始化失败，请刷新页面后重试');
  }
})();

// ══════════════════════════════════════════════════════
// ── Worker 配置 (保存/读取) ──
// ══════════════════════════════════════════════════════

const workerUrlInput = $('workerUrl');
const workerTokenInput = $('workerToken');
const workerSaveBtn = $('workerSave');

async function loadWorkerConfig() {
  const data = await chrome.storage.local.get(['workerUrl', 'workerToken']);
  if (data.workerUrl) workerUrlInput.value = data.workerUrl;
  if (data.workerToken) workerTokenInput.value = data.workerToken;
}

workerSaveBtn.addEventListener('click', async () => {
  let url = workerUrlInput.value.trim();
  const token = workerTokenInput.value.trim();
  if (!url) { showStatus('⚠️ 请填入 Worker URL', true); return; }
  // 自动补齐协议
  if (!/^https?:\/\//i.test(url)) {
    url = 'https://' + url;
    workerUrlInput.value = url;
  }
  await chrome.storage.local.set({ workerUrl: url, workerToken: token });
  // 通知 background 刷新配置缓存
  chrome.runtime.sendMessage({ type: 'worker_config_updated' }).catch(() => { });
  showStatus('✅ Worker 配置已保存');

  // 重新 ping 引擎
  pingAndRender();
});

// 初始化时加载
loadWorkerConfig();

async function getTabTranslatedState(tabId) {
  try {
    const key = `tab_${tabId}`;
    const r = await chrome.storage.session.get(key);
    return r[key] ?? false;
  } catch (_) {
    return false;
  }
}

async function setTabTranslatedState(tabId, value) {
  try {
    await chrome.storage.session.set({ [`tab_${tabId}`]: value });
  } catch (_) { }
}

// ══════════════════════════════════════════════════════
// ── UI ──
// ══════════════════════════════════════════════════════

function updateUI() {
  if (!currentTabId) return;

  if (busy) {
    actionBtn.classList.add('disabled');
    return;
  }

  actionBtn.classList.remove('disabled');

  if (isTranslated) {
    stateIcon.className = 'menu-icon on';
    stateText.innerHTML = '已翻译为中文';
    actionLabel.textContent = '恢复原文';
  } else {
    stateIcon.className = 'menu-icon';
    stateText.innerHTML = '原文';
    actionLabel.textContent = '翻译此页';
  }
}

function setBusy(text) {
  busy = true;
  actionBtn.classList.add('disabled');
  actionLabel.textContent = text;
}

function clearBusy() {
  busy = false;
  updateUI();
}

function setUnavailable(text) {
  stateIcon.className = 'menu-icon';
  stateText.innerHTML = escapeHtml(text);
  actionBtn.classList.add('disabled');
}

function showStatus(msg, isErr = false) {
  statusEl.textContent = msg;
  statusEl.className = isErr ? 'err' : '';

  clearTimeout(showStatus._timer);
  showStatus._timer = setTimeout(() => {
    statusEl.textContent = '';
    statusEl.className = '';
  }, 3000);
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, s => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[s]));
}

function bindClearButton(input, clearBtn, onClear) {
  const update = () => {
    const isFocused = document.activeElement === input;
    clearBtn.classList.toggle('show', isFocused && input.value.trim().length > 0);
  };
  input.addEventListener('input', update);
  input.addEventListener('focus', update);
  input.addEventListener('blur', () => {
    setTimeout(() => {
      if (document.activeElement !== input) {
        clearBtn.classList.remove('show');
      }
    }, 150);
  });
  clearBtn.addEventListener('mousedown', (e) => {
    e.preventDefault();
  });
  clearBtn.addEventListener('click', () => {
    input.value = '';
    clearBtn.classList.remove('show');
    input.focus();
    if (onClear) onClear();
  });
}

// ══════════════════════════════════════════════════════
// ── 保存设置 ──
// ══════════════════════════════════════════════════════

async function saveAutoTranslateSetting() {
  await chrome.storage.sync.set({ autoTranslate: autoChk.checked });
}

autoChk.addEventListener('change', async () => {
  try {
    autoChk.disabled = true;
    await saveAutoTranslateSetting();
    showStatus(autoChk.checked ? '✅ 已开启自动翻译' : '✅ 已关闭自动翻译');
  } catch (_) {
    autoChk.checked = !autoChk.checked;
    showStatus('❌ 保存失败', true);
  } finally {
    autoChk.disabled = false;
  }
});

// ══════════════════════════════════════════════════════
// ── 翻译 / 还原 ──
// ══════════════════════════════════════════════════════

actionBtn.addEventListener('click', async () => {
  if (!currentTabId || busy) return;

  if (isTranslated) {
    await restoreCurrentPage();
  } else {
    await translateCurrentPage();
  }
});

async function translateCurrentPage() {
  setBusy('🔄 翻译中…');

  try {
    const res = await chrome.tabs.sendMessage(currentTabId, { action: 'translate_page' });
    if (res?.success === true) {
      isTranslated = true;
      await setTabTranslatedState(currentTabId, true);
      showStatus(formatTranslateSuccess(res));
    } else if (res?.reason === 'busy') {
      showStatus('🔄 翻译进行中，请稍候…', true);
    } else {
      showStatus('⚠️ 翻译失败，请刷新页面后重试', true);
    }
  } catch (_) {
    showStatus('❌ 当前页面无法翻译，请刷新或换页面重试', true);
  } finally {
    clearBusy();
  }
}

async function restoreCurrentPage() {
  setBusy('🔄 恢复中…');

  try {
    const res = await chrome.tabs.sendMessage(currentTabId, { action: 'restore_page' });
    if (res?.success === true) {
      isTranslated = false;
      await setTabTranslatedState(currentTabId, false);
      showStatus('✅ 已恢复原文');
    } else {
      showStatus('⚠️ 恢复失败，请刷新页面后重试', true);
    }
  } catch (_) {
    showStatus('❌ 当前页面无法恢复，请刷新页面后重试', true);
  } finally {
    clearBusy();
  }
}

function formatTranslateSuccess(res) {
  if (typeof res?.count === 'number') {
    return `✨ 已翻译${res.count} 处`;
  }
  return '✨ 已翻译当前页面';
}

// ══════════════════════════════════════════════════════
// ── 状态同步 ──
// ══════════════════════════════════════════════════════

chrome.storage.onChanged.addListener((changes, area) => {
  // 域名列表被心跳同步更新 — 刷新 UI
  if (area === 'local' && changes.excludedDomains) {
    if (!_domainBusy) {
      domains = changes.excludedDomains.newValue || [];
      renderDomains(domainInput.value.trim());
    } else {
      _pendingCloudDomains = changes.excludedDomains.newValue || [];
    }
    return;
  }

  if (area !== 'session' || !currentTabId) return;
  const key = `tab_${currentTabId}`;
  if (!changes[key]) return;
  isTranslated = changes[key].newValue ?? false;
  if (!busy) updateUI();
});

// ══════════════════════════════════════════════════════
// ── 域名管理 ──
// ══════════════════════════════════════════════════════

const domainInput = $('domainInput');
const domainClear = $('domainClear');
const domainList = $('domainList');
const domainCount = $('domainCount');
const domainAdd = $('domainAdd');
const domainAddCurrent = $('domainAddCurrent');

let domains = [];
let _domainBusy = false;
let _pendingCloudDomains = null;
let currentDomain = '';

async function loadDomains() {
  // 先用本地数据渲染
  const r = await chrome.storage.local.get('excludedDomains');
  domains = Array.isArray(r.excludedDomains) ? r.excludedDomains.filter(d => typeof d === 'string' && d.includes('.')) : [];
  renderDomains();

  // 异步从 Worker KV 拉取云端数据
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'kv_list' });
    if (resp && !resp.error && Array.isArray(resp.domains)) {
      const cloudDomains = resp.domains.filter(d => typeof d === 'string' && d.includes('.'));
      const sorted = [...cloudDomains].sort();
      if (sorted.length !== domains.length || sorted.some((d, i) => d !== domains[i])) {
        if (!_domainBusy) {
          domains = sorted;
          await saveDomains();
          renderDomains();
        }
      }
    }
  } catch (_) {
    // Worker 不可达，保留本地数据
  }
}

async function saveDomains() {
  await chrome.storage.local.set({ excludedDomains: domains });
}

function renderDomains(filter) {
  domainCount.textContent = domains.length + ' 个域名';
  let list = domains;
  if (filter) {
    const lower = filter.toLowerCase();
    list = domains.filter(d => d.toLowerCase().includes(lower));
  }
  if (!list.length) {
    domainList.innerHTML = filter
      ? '<div class="domain-empty">无匹配域名</div>'
      : '<div class="domain-empty">暂无排除域名</div>';
    return;
  }
  let html = '<table class="domain-table">';
  for (let i = 0; i < list.length; i++) {
    const d = list[i];
    const escapedD = escapeHtml(d);
    const display = filter ? escapedD.replace(new RegExp('(' + filter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi'), '<mark>$1</mark>') : escapedD;
    html += '<tr><td>' + (i + 1) + '</td><td>' + display + '</td><td><span class="del" data-domain="' + escapedD + '">✕</span></td></tr>';
  }
  html += '</table>';
  domainList.innerHTML = html;

  const dels = domainList.querySelectorAll('.del');
  for (let j = 0; j < dels.length; j++) {
    dels[j].addEventListener('click', function (e) {
      e.stopPropagation();
      removeDomain(this.getAttribute('data-domain'));
    });
  }
}

async function addDomain(d) {
  if (_domainBusy) return;
  _domainBusy = true;
  try {
    d = String(d || '').trim().toLowerCase();
    if (!d || !d.includes('.')) return;
    if (domains.includes(d)) {
      showStatus('⚠️ 域名已存在', true);
      return;
    }
    domains.push(d);
    domains.sort();
    await saveDomains();
    renderDomains();
    domainInput.value = '';
    domainClear.classList.remove('show');

    // 同步到 Worker KV
    try {
      await chrome.runtime.sendMessage({ type: 'kv_add', domain: d });
    } catch (_) {
      showStatus('⚠️ 云端同步失败', true);
    }
  } finally {
    _domainBusy = false;
    _applyPendingCloudDomains();
  }
}

async function removeDomain(d) {
  if (_domainBusy) return;
  _domainBusy = true;
  try {
    domains = domains.filter(x => x !== d);
    await saveDomains();
    renderDomains();

    // 同步到 Worker KV
    try {
      await chrome.runtime.sendMessage({ type: 'kv_del', domain: d });
    } catch (_) {
      showStatus('⚠️ 云端同步失败', true);
    }
  } finally {
    _domainBusy = false;
    _applyPendingCloudDomains();
  }
}

function _applyPendingCloudDomains() {
  if (_pendingCloudDomains) {
    // Merge instead of replace: keep locally-added domains, pick up cloud additions
    const pending = _pendingCloudDomains;
    _pendingCloudDomains = null;
    const currentSet = new Set(domains);
    let changed = false;
    for (const d of pending) {
      if (!currentSet.has(d)) {
        domains.push(d);
        changed = true;
      }
    }
    if (changed) {
      domains.sort();
      saveDomains().catch(() => {});
      renderDomains(domainInput.value.trim());
    }
  }
}

domainAdd.addEventListener('click', () => addDomain(domainInput.value));
domainAddCurrent.addEventListener('click', () => {
  domainInput.value = currentDomain;
  domainClear.classList.add('show');
  addDomain(currentDomain);
});

bindClearButton(domainInput, domainClear, () => {
  renderDomains();
});

domainInput.addEventListener('input', () => {
  renderDomains(domainInput.value.trim());
});

domainInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') addDomain(domainInput.value);
});

(async function () {
  await loadDomains();
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url) {
      const u = new URL(tab.url);
      currentDomain = u.hostname.replace(/^www\./, '');
      domainAddCurrent.setAttribute('data-tooltip', '添加当前站点: ' + currentDomain);
    }
  } catch (_) { }
})();

// ══════════════════════════════════════════════════════
// ── 展开 / 折叠（域名区域 hover 展开收起）──
// ══════════════════════════════════════════════════════

(function setupToggles() {
  function hoverGroup(toggle, content) {
    var timer = null;
    function show() {
      clearTimeout(timer);
      content.classList.add('show');
      toggle.classList.add('open');
    }
    function scheduleHide() {
      timer = setTimeout(function () {
        content.classList.remove('show');
        toggle.classList.remove('open');
      }, 120);
    }
    toggle.addEventListener('mouseenter', show);
    toggle.addEventListener('mouseleave', scheduleHide);
    content.addEventListener('mouseenter', show);
    content.addEventListener('mouseleave', scheduleHide);
  }

  hoverGroup($('engineToggle'), $('engineContent'));
  hoverGroup($('domainToggle'), $('domainContent'));
  hoverGroup($('workerToggle'), $('workerContent'));
})();

// ══════════════════════════════════════════════════════
// ── Worker 清除按钮交互 ──
// ══════════════════════════════════════════════════════
(function setupWorkerClearBtns() {
  bindClearButton(workerUrlInput, $('workerUrlClear'));
  bindClearButton(workerTokenInput, $('workerTokenClear'));
})();

// ══════════════════════════════════════════════════════
// ── 全局极速自定义提示 ──
// ══════════════════════════════════════════════════════
(function setupCustomTooltips() {
  const tooltip = $('tooltip');
  if (!tooltip) return;

  let activeTarget = null;

  document.addEventListener('mouseover', (e) => {
    const target = e.target.closest && e.target.closest('[data-tooltip]');
    if (!target) {
      if (activeTarget) {
        tooltip.classList.remove('show');
        activeTarget = null;
      }
      return;
    }

    if (target === activeTarget) return;
    activeTarget = target;

    const text = target.getAttribute('data-tooltip');
    if (!text) {
      tooltip.classList.remove('show');
      return;
    }

    tooltip.textContent = text;
    tooltip.classList.add('show');

    // 位置与边界智能计算
    const rect = target.getBoundingClientRect();
    const tooltipWidth = tooltip.offsetWidth;
    const tooltipHeight = tooltip.offsetHeight;

    // 默认在上方
    let top = rect.top - tooltipHeight - 8;
    let left = rect.left + rect.width / 2;
    let isBottom = false;

    // 如果上方溢出视区，则显示在下方
    if (top < 4) {
      top = rect.bottom + 8;
      isBottom = true;
    }

    // 水平方向限制在视区内，留有 8px 边距
    const minLeft = tooltipWidth / 2 + 8;
    const maxLeft = window.innerWidth - tooltipWidth / 2 - 8;
    left = Math.max(minLeft, Math.min(left, maxLeft));

    tooltip.style.left = left + 'px';
    tooltip.style.top = top + 'px';

    // 切换朝向类以翻转箭头
    tooltip.classList.toggle('bottom', isBottom);

    // 动态调整箭头水平偏移以对齐按钮中心
    const chevronOffset = (rect.left + rect.width / 2) - left;
    tooltip.style.setProperty('--chevron-offset', `calc(50% + ${chevronOffset}px)`);
  });

  document.addEventListener('mouseout', (e) => {
    if (!activeTarget) return;

    const related = e.relatedTarget;
    if (!related || !activeTarget.contains(related)) {
      tooltip.classList.remove('show');
      activeTarget = null;
    }
  });
})();

// ══════════════════════════════════════════════════════
// ── 导出日志 ──
// ══════════════════════════════════════════════════════

$('exportLogs').addEventListener('click', async () => {
  let all = [];

  // 1. 页面日志 (content script)
  if (currentTabId) {
    try {
      const r = await chrome.tabs.sendMessage(currentTabId, { action: 'get_logs' });
      if (r?.logs?.length) {
        all.push('═══ 页面日志 ═══');
        all = all.concat(r.logs);
      }
    } catch (_) { }
  }

  // 2. 后台日志 (background + api)
  try {
    const r = await chrome.runtime.sendMessage({ type: 'get_logs' });
    if (r?.bg?.length) {
      all.push('');
      all.push('═══ 后台 (Background) ═══');
      all = all.concat(r.bg);
    }
    if (r?.api?.length) {
      all.push('');
      all.push('═══ API (BG-API) ═══');
      all = all.concat(r.api);
    }
  } catch (_) { }

  if (!all.length) {
    showStatus('⚠️ 暂无日志', true);
    return;
  }

  const text = all.join('\n');
  const ts = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
  const filename = 'jiyi-export-' + ts + '.txt';

  if (currentTabId) {
    try {
      await chrome.tabs.sendMessage(currentTabId, { action: 'save_logs', text: text, filename: filename });
      showStatus('✅ 日志已导出: ' + filename);
      return;
    } catch (_) { }
  }

  // 降级: 复制到剪贴板
  try {
    await navigator.clipboard.writeText(text);
    showStatus('📋 日志已复制到剪贴板');
  } catch (_) {
    showStatus('⚠️ 导出失败，请在页面中按 F12 查看控制台', true);
  }
});

