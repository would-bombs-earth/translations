// options.js - 弹出面板 v3 (双引擎卡片)

const $ = id => document.getElementById(id);

const autoChk = $('autoTranslate');
const actionBtn = $('action');
const actionLabel = $('actionLabel');
const statusEl = $('status');
const stateIcon = $('stateIcon');
const stateText = $('stateText');
const cardGG = $('cardGG');
const cardMS = $('cardMS');
const latencyMS = $('latencyMS');
const latencyGG = $('latencyGG');
const netError = $('netError');

let selectedEngine = 'google';

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

function renderEngineSelection() {
  cardMS.classList.toggle('selected', selectedEngine === 'microsoft');
  cardGG.classList.toggle('selected', selectedEngine === 'google');
}

async function selectEngine(engine) {
  if (selectedEngine === engine) return;
  selectedEngine = engine;
  renderEngineSelection();
  await chrome.storage.local.set({ selectedEngine: engine });
  chrome.runtime.sendMessage({ type: 'engine_selected', engine: engine }).catch(() => { });
  var names = { google: 'Google 翻译', microsoft: '微软翻译' };
  showStatus('✅ 已切换至' + (names[engine] || engine));
}

async function pingAndRender() {
  // 重置卡片状态
  latencyMS.textContent = '—';
  latencyMS.className = 'eng-card-latency testing';
  cardMS.classList.remove('dead-card');
  latencyGG.textContent = '—';
  latencyGG.className = 'eng-card-latency testing';
  cardGG.classList.remove('dead-card');
  netError.classList.remove('show');

  renderEngineSelection();

  try {
    const resp = await chrome.runtime.sendMessage({ type: 'ping_engines' });
    if (!resp || !resp.results || !resp.results.length) {
      showBothDead();
      return;
    }

    const results = resp.results;
    const msResult = results.find(r => r.name === 'microsoft');
    const ggResult = results.find(r => r.name === 'google');

    // 渲染微软卡片
    if (msResult?.ok) {
      latencyMS.textContent = msResult.ms + 'ms';
      latencyMS.className = 'eng-card-latency ' + latencyClass(msResult.ms);
      latencyMS.removeAttribute('data-tooltip');
    } else {
      latencyMS.textContent = '不可用';
      latencyMS.className = 'eng-card-latency dead';
      cardMS.classList.add('dead-card');
      if (msResult?.error) latencyMS.setAttribute('data-tooltip', msResult.error);
    }

    // 渲染 Google 卡片
    if (ggResult?.ok) {
      latencyGG.textContent = ggResult.ms + 'ms';
      latencyGG.className = 'eng-card-latency ' + latencyClass(ggResult.ms);
      latencyGG.removeAttribute('data-tooltip');
    } else {
      latencyGG.textContent = '不可用';
      latencyGG.className = 'eng-card-latency dead';
      cardGG.classList.add('dead-card');
      if (ggResult?.error) latencyGG.setAttribute('data-tooltip', ggResult.error);
    }

    const msOk = msResult?.ok;
    const ggOk = ggResult?.ok;

    if (!msOk && !ggOk) {
      netError.classList.add('show');
      actionBtn.classList.add('disabled');
    } else {
      netError.classList.remove('show');
      actionBtn.classList.remove('disabled');
    }
  } catch (e) {
    showBothDead();
  }
}

function showBothDead() {
  latencyMS.textContent = '不可用';
  latencyMS.className = 'eng-card-latency dead';
  cardMS.classList.add('dead-card');
  latencyGG.textContent = '不可用';
  latencyGG.className = 'eng-card-latency dead';
  cardGG.classList.add('dead-card');
  netError.classList.add('show');
  actionBtn.classList.add('disabled');
}

// ══════════════════════════════════════════════════════
// ── 引擎卡片点击 ──
// ══════════════════════════════════════════════════════

cardMS.addEventListener('click', () => selectEngine('microsoft'));
cardGG.addEventListener('click', () => selectEngine('google'));

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

    const { selectedEngine: stored } = await chrome.storage.local.get('selectedEngine');
    if (stored === 'microsoft' || stored === 'google') {
      selectedEngine = stored;
    }
    renderEngineSelection();

    isTranslated = await getTabTranslatedState(currentTabId);

    updateUI();
    pingAndRender();
  } catch (e) {
    setUnavailable('初始化失败，请刷新页面后重试');
  }
})();

// ══════════════════════════════════════════════════════
// ── KV 配置 (保存/读取) ──
// ══════════════════════════════════════════════════════

const cfApiTokenInput = $('cfApiToken');
const cfAccountIdInput = $('cfAccountId');
const cfNamespaceIdInput = $('cfNamespaceId');
const kvCfgExportBtn = $('kvCfgExport');
const kvCfgImportBtn = $('kvCfgImport');
const kvCfgImportInput = $('kvCfgImportInput');
const kvStatusBadge = $('kvStatusBadge');
const kvSyncBox = $('kvSyncBox');
const kvSyncHeader = $('kvSyncHeader');


async function loadKvConfig() {
  const data = await chrome.storage.local.get(['cfApiToken', 'cfAccountId', 'cfNamespaceId']);
  if (data.cfApiToken) cfApiTokenInput.value = data.cfApiToken;
  if (data.cfAccountId) cfAccountIdInput.value = data.cfAccountId;
  if (data.cfNamespaceId) cfNamespaceIdInput.value = data.cfNamespaceId;
  if (data.cfApiToken && data.cfAccountId && data.cfNamespaceId) {
    pingKv();
  } else {
    kvStatusBadge.className = 'kv-status-badge idle';
    kvStatusBadge.textContent = '未配置';
  }
}

// KV 卡片展开/折叠
kvSyncHeader.addEventListener('click', () => {
  kvSyncBox.classList.toggle('open');
});

async function pingKv() {
  kvStatusBadge.className = 'kv-status-badge idle';
  kvStatusBadge.textContent = '检测中…';
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'ping_kv' });
    if (resp?.ok) {
      kvStatusBadge.className = 'kv-status-badge ok';
      kvStatusBadge.textContent = '已连接';
    } else {
      kvStatusBadge.className = 'kv-status-badge err';
      kvStatusBadge.textContent = '连接失败';
    }
  } catch (e) {
    kvStatusBadge.className = 'kv-status-badge err';
    kvStatusBadge.textContent = '连接失败';
  }
}

async function saveKvConfig() {
  await chrome.storage.local.set({
    cfApiToken: cfApiTokenInput.value.trim(),
    cfAccountId: cfAccountIdInput.value.trim(),
    cfNamespaceId: cfNamespaceIdInput.value.trim()
  });
}

// KV 配置 — 离开输入框时自动保存
cfApiTokenInput.addEventListener('blur', async () => {
  await saveKvConfig();
  chrome.runtime.sendMessage({ type: 'kv_config_updated' }).catch(() => { });
  pingKv();
});
cfAccountIdInput.addEventListener('blur', async () => {
  await saveKvConfig();
  chrome.runtime.sendMessage({ type: 'kv_config_updated' }).catch(() => { });
  pingKv();
});
cfNamespaceIdInput.addEventListener('blur', async () => {
  await saveKvConfig();
  chrome.runtime.sendMessage({ type: 'kv_config_updated' }).catch(() => { });
  pingKv();
});

// KV 配置导出
kvCfgExportBtn.addEventListener('click', async () => {
  const data = await chrome.storage.local.get(['cfApiToken', 'cfAccountId', 'cfNamespaceId']);
  const config = {
    cfApiToken: data.cfApiToken || '',
    cfAccountId: data.cfAccountId || '',
    cfNamespaceId: data.cfNamespaceId || '',
    _exportedAt: new Date().toISOString()
  };
  const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  try {
    await chrome.downloads.download({ url, filename: 'jiyi-kv-config.json', saveAs: true });
  } catch (_) {
    const a = document.createElement('a');
    a.href = url;
    a.download = 'jiyi-kv-config.json';
    a.click();
  }
  URL.revokeObjectURL(url);
});

// KV 配置导入
kvCfgImportBtn.addEventListener('click', () => {
  kvCfgImportInput.value = '';
  kvCfgImportInput.click();
});

kvCfgImportInput.addEventListener('change', async () => {
  const file = kvCfgImportInput.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const config = JSON.parse(text);
    if (!config.cfApiToken || !config.cfAccountId || !config.cfNamespaceId) {
      showStatus('⚠️ KV 配置文件格式无效，缺少必填字段', true);
      return;
    }
    cfApiTokenInput.value = config.cfApiToken || '';
    cfAccountIdInput.value = config.cfAccountId || '';
    cfNamespaceIdInput.value = config.cfNamespaceId || '';
    await saveKvConfig();
    chrome.runtime.sendMessage({ type: 'kv_config_updated' }).catch(() => { });
    pingKv();
    showStatus('✅ KV 配置已导入并保存');
  } catch (e) {
    showStatus('⚠️ 文件解析失败: ' + (e?.message || '未知错误'), true);
  }
});


const oxfordAppIdInput = $('oxfordAppId');
const oxfordAppKeyInput = $('oxfordAppKey');
const oxfordStatusBadge = $('oxfordStatusBadge');
const oxfordBox = $('oxfordBox');
const oxfordHeader = $('oxfordHeader');

async function loadOxfordConfig() {
  const data = await chrome.storage.local.get(['oxfordAppId', 'oxfordAppKey']);
  if (data.oxfordAppId) oxfordAppIdInput.value = data.oxfordAppId;
  if (data.oxfordAppKey) oxfordAppKeyInput.value = data.oxfordAppKey;
  updateOxfordStatus(data.oxfordAppId, data.oxfordAppKey);
}

function updateOxfordStatus(id, key) {
  if (id && key) {
    oxfordStatusBadge.className = 'kv-status-badge ok';
    oxfordStatusBadge.textContent = '已配置';
  } else {
    oxfordStatusBadge.className = 'kv-status-badge idle';
    oxfordStatusBadge.textContent = '未配置';
  }
}

if (oxfordHeader) {
  oxfordHeader.addEventListener('click', () => {
    oxfordBox.classList.toggle('open');
  });
}

async function saveOxfordConfig() {
  const id = oxfordAppIdInput.value.trim();
  const key = oxfordAppKeyInput.value.trim();
  await chrome.storage.local.set({ oxfordAppId: id, oxfordAppKey: key });
  updateOxfordStatus(id, key);
}

if (oxfordAppIdInput) oxfordAppIdInput.addEventListener('blur', saveOxfordConfig);
if (oxfordAppKeyInput) oxfordAppKeyInput.addEventListener('blur', saveOxfordConfig);

loadOxfordConfig();
loadKvConfig();

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
  statusEl.style.opacity = '1';
  statusEl.className = isErr ? 'err' : '';

  clearTimeout(showStatus._timer);
  showStatus._timer = setTimeout(() => {
    statusEl.style.opacity = '0';
    setTimeout(() => {
      statusEl.textContent = '';
      statusEl.className = '';
    }, 200);
  }, 2800);
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
  // 域名列表被 KV 同步更新
  if (area === 'local' && changes.excludedDomains) {
    domains = changes.excludedDomains.newValue || [];
    renderDomains(domainInput.value.trim());
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
let currentDomain = '';
let _domainExpanded = false;
const DOMAIN_PREVIEW = 3;

async function loadDomains() {
  const r = await chrome.storage.local.get('excludedDomains');
  domains = Array.isArray(r.excludedDomains) ? r.excludedDomains.filter(d => typeof d === 'string' && d.includes('.')) : [];
  renderDomains();

  // 后台从 KV 拉取最新列表
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'kv_sync' });
    if (resp?.ok) {
      const r2 = await chrome.storage.local.get('excludedDomains');
      const cloud = Array.isArray(r2.excludedDomains) ? r2.excludedDomains.filter(d => typeof d === 'string' && d.includes('.')) : [];
      if (cloud.length !== domains.length || cloud.some((d, i) => d !== domains[i])) {
        domains = cloud;
        renderDomains();
      }
    }
  } catch (_) { }
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

  const isFiltering = !!filter;
  const showAll = isFiltering || _domainExpanded;
  const visible = showAll ? list : list.slice(0, DOMAIN_PREVIEW);

  var safePattern = filter ? filter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '';

  let html = '<table class="domain-table">';
  for (let i = 0; i < visible.length; i++) {
    const d = visible[i];
    const escapedD = escapeHtml(d);
    const display = filter ? escapedD.replace(new RegExp('(' + safePattern + ')', 'gi'), '<mark>$1</mark>') : escapedD;
    html += '<tr><td>' + (i + 1) + '</td><td>' + display + '</td><td><span class="del" data-domain="' + escapedD + '">✕</span></td></tr>';
  }
  html += '</table>';

  if (!isFiltering && list.length > DOMAIN_PREVIEW) {
    if (!_domainExpanded) {
      html += '<button class="domain-toggle-btn" id="domainExpandBtn">查看全部 ' + list.length + ' 个 ▾</button>';
    } else {
      html += '<button class="domain-toggle-btn" id="domainExpandBtn">收起 ▴</button>';
    }
  }

  domainList.innerHTML = html;

  const expandBtn = domainList.querySelector('#domainExpandBtn');
  if (expandBtn) {
    expandBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      _domainExpanded = !_domainExpanded;
      renderDomains(domainInput.value.trim());
    });
  }

  const dels = domainList.querySelectorAll('.del');
  for (let j = 0; j < dels.length; j++) {
    dels[j].addEventListener('click', function (e) {
      e.stopPropagation();
      removeDomain(this.getAttribute('data-domain'));
    });
  }
}

async function addDomain(d) {
  d = String(d || '').trim().toLowerCase();
  if (!d || !d.includes('.')) return;
  var domainSet = new Set(domains);
  if (domainSet.has(d)) {
    showStatus('⚠️ 域名已存在', true);
    return;
  }
  var newList = [...new Set([...domains, d])].sort();
  domainInput.value = '';
  domainClear.classList.remove('show');
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'kv_put_domains', domains: newList });
    if (!resp?.ok) {
      showStatus('⚠️ KV 上传失败: ' + (resp?.error || '服务器错误'), true);
    }
  } catch (e) {
    showStatus('⚠️ KV 通讯失败: ' + (e?.message || '未知错误'), true);
  }
}

async function removeDomain(d) {
  var newList = domains.filter(x => x !== d);
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'kv_put_domains', domains: newList });
    if (!resp?.ok) {
      showStatus('⚠️ KV 上传失败: ' + (resp?.error || '服务器错误'), true);
    }
  } catch (e) {
    showStatus('⚠️ KV 通讯失败: ' + (e?.message || '未知错误'), true);
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
// ── 展开 / 折叠 ──
// ══════════════════════════════════════════════════════

(function setupToggles() {
  const groups = [
    { toggle: $('engineToggle'), content: $('engineContent') },
    { toggle: $('dictToggle'), content: $('dictContent') },
    { toggle: $('domainToggle'), content: $('domainContent') },
  ].filter(g => g.toggle && g.content);

  function closeAll(except) {
    groups.forEach(g => {
      if (g === except) return;
      g.content.classList.remove('show');
      g.toggle.classList.remove('open');
    });
  }

  groups.forEach(g => {
    g.toggle.addEventListener('click', () => {
      const isOpen = g.toggle.classList.contains('open');
      closeAll(g);
      if (!isOpen) {
        g.content.classList.add('show');
        g.toggle.classList.add('open');
      } else {
        g.content.classList.remove('show');
        g.toggle.classList.remove('open');
      }
    });
  });
})();

// ══════════════════════════════════════════════════════
// ── 全局极速自定义提示 ──
// ══════════════════════════════════════════════════════
(function setupCustomTooltips() {
  const tooltip = $('tooltip');
  if (!tooltip) return;

  let activeTarget = null;

  document.addEventListener('mouseover', (e) => {
    const target = e.target.closest && e.target.closest('[data-tooltip], [data-tooltip-html]');
    if (!target) {
      if (activeTarget) {
        tooltip.classList.remove('show');
        activeTarget = null;
      }
      return;
    }

    if (target === activeTarget) return;
    activeTarget = target;

    const html = target.getAttribute('data-tooltip-html');
    const text = html || target.getAttribute('data-tooltip');
    if (!text) {
      tooltip.classList.remove('show');
      return;
    }

    if (html) {
      tooltip.innerHTML = html;
    } else {
      tooltip.textContent = text;
    }
    tooltip.classList.add('show');

    const rect = target.getBoundingClientRect();
    const tooltipWidth = tooltip.offsetWidth;
    const tooltipHeight = tooltip.offsetHeight;

    let top = rect.top - tooltipHeight - 8;
    let left = rect.left + rect.width / 2;
    let isBottom = false;

    if (top < 4) {
      top = rect.bottom + 8;
      isBottom = true;
    }

    const minLeft = tooltipWidth / 2 + 8;
    const maxLeft = window.innerWidth - tooltipWidth / 2 - 8;
    left = Math.max(minLeft, Math.min(left, maxLeft));

    tooltip.style.left = left + 'px';
    tooltip.style.top = top + 'px';

    tooltip.classList.toggle('bottom', isBottom);

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
// ── 导出译文 ──
// ══════════════════════════════════════════════════════

$('exportTranslations').addEventListener('click', async () => {
  if (!currentTabId) return;
  setBusy('🔄 导出中…');
  try {
    const res = await chrome.tabs.sendMessage(currentTabId, { action: 'export_translations' });
    if (res?.pairs?.length) {
      const lines = res.pairs.map(function (p, i) {
        return (i + 1) + '. 原文: ' + p.raw + '，译文: ' + p.translated;
      });
      const text = lines.join('\n');
      const ts = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
      const filename = 'jiyi-translations-' + ts + '.txt';
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      showStatus('✅ 已导出 ' + res.pairs.length + ' 条译文');
    } else {
      showStatus('⚠️ 没有找到已翻译的内容', true);
    }
  } catch (_) {
    showStatus('⚠️ 导出失败', true);
  } finally {
    clearBusy();
  }
});

// ══════════════════════════════════════════════════════
// ── 导出日志 ──
// ══════════════════════════════════════════════════════

$('exportLogs').addEventListener('click', async () => {
  let all = [];

  if (currentTabId) {
    try {
      const r = await chrome.tabs.sendMessage(currentTabId, { action: 'get_logs' });
      if (r?.logs?.length) {
        all.push('═══ 页面日志 ═══');
        all = all.concat(r.logs);
      }
    } catch (_) { }
  }

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
    if (r?.kv?.length) {
      all.push('');
      all.push('═══ KV 同步 ═══');
      all = all.concat(r.kv);
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

  try {
    await navigator.clipboard.writeText(text);
    showStatus('📋 日志已复制到剪贴板');
  } catch (_) {
    showStatus('⚠️ 导出失败，请在页面中按 F12 查看控制台', true);
  }
});
