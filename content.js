
// content.js
// Translation Engine v3 — 核心: DOM 处理 / 翻译管线 / 还原 / Observer / 初始化
// 依赖: content-globals.js (全局状态), content-lang.js (语言检测)

// ═══════════════════════════════════════════════════════════
// manual flush promise (Fix 1+6: real count from translatePage)
// ═══════════════════════════════════════════════════════════

var _manualFlushResolvers = [];
var _flushGen = 0;
var _inflightBatches = {}; // groupId → { batch, gen, seq, isSolo, t0, applied, total }
var _incrementalApplied = 0; // 增量调度期间成功翻译的节点数

// ═══════════════════════════════════════════════════════════
// node processing
// ═══════════════════════════════════════════════════════════

function enqueueNode(node) {
  if (translationMode === 'off') return;
  if (!node) return;
  if (queue.size > MAX_QUEUE) return;

  // ShadowRoot / DocumentFragment — walk children, then recurse into nested shadows
  if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
    observeShadowRoot(node);
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      processTextNode(walker.currentNode);
    }
    for (const sr of shadowRootsIn(node)) enqueueNode(sr);
    return;
  }

  if (node.nodeType === Node.TEXT_NODE) {
    processTextNode(node);
    return;
  }

  if (node.nodeType !== Node.ELEMENT_NODE) return;
  if (isSkippable(node)) return;

  const walker = document.createTreeWalker(
    node, NodeFilter.SHOW_TEXT
  );

  while (walker.nextNode()) {
    processTextNode(walker.currentNode);
  }

  // Scan translatable attributes on this element only
  processElementAttrs(node);

  // Traverse into open shadow roots (Web Components)
  for (const sr of shadowRootsIn(node)) enqueueNode(sr);
}

// Translatable attributes — 已移至 content-globals.js

function processElementAttrs(el, onlyAttr) {
  if (translationMode === 'off') return;
  if (!el || el.nodeType !== Node.ELEMENT_NODE) return;
  if (isSkippable(el)) return;

  const done = translatedAttrs.get(el);

  for (const attr of TRANSLATABLE_ATTRS) {
    // When triggered by MutationObserver attribute change, only process the changed attr
    if (onlyAttr && attr !== onlyAttr) continue;
    const val = el.getAttribute(attr);
    if (!val) continue;

    const text = normalize(val);
    if (text.length < 2) continue;
    if (SKIP_RE.test(text)) continue;
    if (SKIP_CN_RE.test(text)) continue;

    // Cache hit → apply immediately (before language check — faster)
    var cachedTrans = cacheGet(text);
    if (cachedTrans !== undefined) {
      if (cachedTrans !== text) {
        // Create wrapper, apply, and skip queue
        const attrNode = {
          __isAttr: true, __el: el, __attr: attr,
          get textContent() { return el.getAttribute(attr) || ''; },
          get parentElement() { return el; }
        };
        mute(() => applyTranslation(attrNode, text, cachedTrans));
      }
      continue;
    }

    if (isAlreadyChinese(text)) continue;

    // Already translated this attr on this element with the SAME value
    if (done && done.has(attr)) {
      const record = done.get(attr);
      if (normalize(record.translated) === text) continue;
      // Content changed externally — remove old translation mapping
      done.delete(attr);
      if (el.__gt_orig_attrs && attr in el.__gt_orig_attrs) {
        delete el.__gt_orig_attrs[attr];
      }
    }

    // From here on, this is new/changed foreign text — allow re-processing

    // Create a lightweight wrapper that mimics a text node
    const attrNode = {
      __isAttr: true,
      __el: el,
      __attr: attr,
      get textContent() { return el.getAttribute(attr) || ''; },
      get parentElement() { return el; }
    };

    if (seenText.has(text)) {
      attrNode.__gtRaw = text;
      queue.add(attrNode);
      continue;
    }

    seenAdd(text);
    attrNode.__gtRaw = text;
    queue.add(attrNode);
    dispatchIncremental();
    _dbg('detect', { text: `[${attr}] ${text}` });
  }
}

function processTextNode(node) {
  if (translationMode === 'off') return;
  if (!node.parentElement) return;
  if (isSkippable(node.parentElement)) return;

  diag.scanned++;
  const raw = node.textContent;
  if (!raw) return;

  const text = normalize(raw);
  if (text.length < 2) { diag.tooShort++; return; }

  // Skip @mentions, URLs, pure numbers/symbols
  if (SKIP_RE.test(text)) { diag.skipRe++; return; }

  // Skip Chinese UI patterns (e.g. 点击 关注 username)
  if (SKIP_CN_RE.test(text)) { diag.skipCnRe++; return; }

  // Cache hit → apply immediately without queuing (before language check — faster)
  var cachedTrans2 = cacheGet(text);
  if (cachedTrans2 !== undefined) {
    if (cachedTrans2 !== text) {
      diag.cached++;
      // Capture original text content now; applyTranslation won't overwrite it
      if (node.__gt_orig === undefined) {
        node.__gt_orig = node.textContent;
      }
      mute(() => applyTranslation(node, text, cachedTrans2));
    }
    return;
  }

  if (isAlreadyChinese(text)) { diag.alreadyChinese++; return; }

  // Node was previously translated but content has changed externally
  // (e.g. "show more" expanded the textContent of the same node).
  // Re-process it; applyTranslation will update origTextMap with the new raw.
  if (origTextMap.has(node)) {
    if (normalize(origTextMap.get(node).translated) === text) return;
    unregisterTextRestore(node);
  }

  // Dedup: same text already queued → track node for later apply
  if (seenText.has(text)) {
    // still queue so buildBatches can apply from cache after translation
    node.__gtRaw = text;
    queue.add(node);
    return;
  }

  node.__gtRaw = text;
  if (node.__gt_orig === undefined) node.__gt_orig = raw;
  seenAdd(text);
  queue.add(node);
  diag.queued++;
  dispatchIncremental();
  _dbg('detect', { text });
}

// ── 增量调度：扫描过程中队列达到阈值即立即发送翻译 ──
function dispatchIncremental() {
  if (translationMode === 'off' || !isAlive()) return;
  if (queue.size < INCREMENTAL_THRESHOLD) return;

  // 从队列取出最多 BATCH_SIZE 个节点，构建批次并异步发送
  var nodes = [];
  var iter = queue.values();
  var count = 0;
  var next;
  while (count < BATCH_SIZE && !(next = iter.next()).done) {
    nodes.push(next.value);
    queue.delete(next.value);
    count++;
  }
  if (nodes.length === 0) return;

  // 预处理：__gtRaw 已在 processTextNode 设置，直接取用
  var processed = [];
  _muteDepth++;
  try {
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (!node?.parentElement) continue;
      var raw = node.__gtRaw;
      if (!raw) continue;
      // cache + language 已在 processTextNode 检查过，直接入批
      processed.push(node);
    }
  } finally {
    _muteDepth--;
  }

  if (processed.length === 0) return;

  var batches = buildBatches(processed);
  // 异步发送，不阻塞扫描
  for (var b = 0; b < batches.length; b++) {
    translateBatch(batches[b]);
  }
}

function scanInitial() {
  if (translationMode === 'off') return;

  // 全面检测 React/Vue/Next.js 水合
  var hasHydration = !!(function () {
    // DOM 容器
    if (document.getElementById('__docusaurus') ||
      document.getElementById('__next') ||
      document.getElementById('___gatsby') ||
      document.getElementById('app') ||
      document.querySelector('[data-reactroot]') ||
      document.querySelector('[data-react-class]')) return true;
    // 全局变量
    if (window.__NEXT_DATA__ || window.__NUXT__ || window.__GATSBY__ ||
      window.__REACT_DEVTOOLS_GLOBAL_HOOK__) return true;
    // <script> 标签中的框架特征
    var scripts = document.querySelectorAll('script[src]');
    for (var i = 0; i < scripts.length; i++) {
      var s = scripts[i].src || scripts[i].textContent || '';
      if (/react|next|vue|angular|svelte|docusaurus|nuxt|gatsby/i.test(s)) return true;
    }
    return false;
  })();

  var delay = hasHydration ? HYDRATION_DELAY_MS : 0;

  // 用 requestIdleCallback 延迟扫描，让浏览器先完成首帧渲染
  // 动态内容由已启动的 MutationObserver 捕获
  const doScan = function () {
    if (translationMode === 'off') return;
    enqueueNode(document.body);
    const attrSelector = TRANSLATABLE_ATTRS.map(function (a) { return '[' + a + ']'; }).join(',');
    var els = querySelectorAllDeep(document.body, attrSelector);
    for (var i = 0; i < els.length; i++) {
      processElementAttrs(els[i]);
    }
    scheduleFlush();
  };

  if (delay > 0) {
    LOG('检测到 SPA 框架，延迟 ' + delay + 'ms 等待水合完成');
    setTimeout(function () {
      if (typeof requestIdleCallback === 'function') {
        requestIdleCallback(doScan, { timeout: 800 });
      } else {
        doScan();
      }
    }, delay);
  } else if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(doScan, { timeout: 200 });
  } else {
    setTimeout(doScan, 0);
  }
}

// querySelectorAllDeep — 已移至 content-globals.js

// ═══════════════════════════════════════════════════════════

// Shared mutation handler used for both main DOM and shadow-root observers
function onMutation(mutations) {
  if (translationMode === 'off') return;
  if (_muteDepth > 0) return;
  for (const m of mutations) {
    if (m.type === 'childList') {
      for (const n of m.addedNodes) enqueueNode(n);
      // Clean up observers for removed shadow roots
      for (const n of m.removedNodes) {
        if (n.nodeType === 1) {  // ELEMENT_NODE
          for (let i = _shadowObservers.length - 1; i >= 0; i--) {
            const entry = _shadowObservers[i];
            if (entry.root.host === n || n.contains(entry.root.host)) {
              entry.observer.disconnect();
              observedShadows.delete(entry.root);
              _shadowObservers.splice(i, 1);
            }
          }
        }
      }
    }
    if (m.type === 'characterData') {
      processTextNode(m.target);
    }
    if (m.type === 'attributes') {
      processElementAttrs(m.target, m.attributeName);
    }
  }
  scheduleFlush();
}

// observedShadows — 已移至 content-globals.js

function observeShadowRoot(sr) {
  if (!sr || observedShadows.has(sr)) return;
  observedShadows.add(sr);
  const obs = new MutationObserver(onMutation);
  obs.observe(sr, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['title', 'alt', 'placeholder', 'aria-label']
  });
  _shadowObservers.push({ root: sr, observer: obs });
}

function startObserver() {
  if (observer) return;
  observer = new MutationObserver(onMutation);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['title', 'alt', 'placeholder', 'aria-label']
  });
}

function stopObserver() {
  if (observer) {
    observer.disconnect();
    observer = null;
  }
  // Disconnect all shadow-root observers to prevent resource leak
  for (var i = 0; i < _shadowObservers.length; i++) {
    _shadowObservers[i].observer.disconnect();
  }
  _shadowObservers = [];
  observedShadows = new WeakSet();
}

// ─────────────────────────────────────────────
// flush scheduling
// ─────────────────────────────────────────────

let flushTimer = null;

function scheduleFlush() {
  if (translationMode === 'off') return;
  if (translating || flushTimer || !isAlive()) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    if (isAlive() && translationMode !== 'off') flushQueue();
  }, FLUSH_MS);
}

function clearPendingWork() {
  queue.clear();
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
}

// ─────────────────────────────────────────────
// batch building
// ─────────────────────────────────────────────

function buildBatches(nodes) {
  const batches = [];
  let current = [];
  let chars = 0;
  for (const node of nodes) {
    const raw = node.__gtRaw || normalize(node.textContent);

    // Cache hit → apply immediately, skip batch
    var cachedRaw = cacheGet(raw);
    if (cachedRaw !== undefined) {
      if (cachedRaw !== raw) {
        mute(() => applyTranslation(node, raw, cachedRaw));
      }
      continue;
    }

    const id = uid++;
    node.__gtId = id;

    // Solo batch for:
    //  (1) long text (avoids marker corruption)
    //  (2) pure CJK without kana/hangul — could be Trad.Chinese or pure-kanji Japanese;
    //      mixing these in marker batches with sl=auto causes Google to misdetect.
    //  Japanese with kana / Korean with hangul are unambiguous → can batch safely.
    const hasCjk = CJK_RE.test(raw);
    const hasKana = KANA_RE.test(raw);
    const hasHangul = HANGUL_RE.test(raw);
    const needsSolo = hasCjk && !hasKana && !hasHangul;
    if (raw.length > SOLO_THRESHOLD || needsSolo) {
      if (current.length) {
        batches.push(current);
        current = [];
        chars = 0;
      }
      batches.push([{ id, node, raw, payload: raw, solo: true }]);
      continue;
    }

    const payload = `${MARK_L}${id}${MARK_R}${raw}`;

    if (
      current.length >= BATCH_SIZE ||
      chars + payload.length > BATCH_CHARS
    ) {
      batches.push(current);
      current = [];
      chars = 0;
    }

    current.push({ id, node, raw, payload });
    chars += payload.length;
  }

  if (current.length) batches.push(current);
  return batches;
}

// ─────────────────────────────────────────────
// parse translated response
// ─────────────────────────────────────────────

function parseTranslated(text) {
  const result = new Map();

  // Google 可能把标记转为 ASCII 括号 [] 或 CJK 括号 【】，先归一化
  // 仅匹配行首的孤立 [N]（Google 转换产物），避免误伤 "see [1]" 等正常引用
  text = text.replace(/(^|\n)\[(\d+)\]/gm, '$1' + MARK_L + '$2' + MARK_R);
  text = text.replace(/【(\d+)】/g, MARK_L + '$1' + MARK_R);
  // Google 可能在标记内部插入空格，归一化 ⟪ 1 ⟫ → ⟪1⟫
  text = text.replace(/\u27EA\s*(\d+)\s*\u27EB/g, MARK_L + '$1' + MARK_R);

  // MARK_R may be dropped by Google Translate; make it optional
  const regex = new RegExp(
    `${MARK_L}(\\d+)${MARK_R}?([\\s\\S]*?)(?=${MARK_L}\\d+${MARK_R}?|$)`,
    'g'
  );

  let m;
  while ((m = regex.exec(text))) {
    const id = Number(m[1]);
    const content = m[2].trim();
    result.set(id, cleanTranslation(content));
  }

  if (result.size === 0) {
    // fallback: line-by-line order matching
    const lines = text
      .split(/\n/)
      .map(s => cleanTranslation(s))
      .filter(Boolean);

    if (lines.length > 0) {
      return { fallbackLines: lines };
    }
  }

  return result;
}

// 翻译回退函数 — 已移至 content-globals.js

// ═══════════════════════════════════════════════════════════
// translate & apply
// ═══════════════════════════════════════════════════════════

// 执行翻译结果到 DOM 的应用（供流式和非流式共用），返回 applied pairs
function _applyTranslationResult(batch, translation, isSolo) {
  var pairs = [];

  _muteDepth++;
  try {
    if (isSolo) {
      var item = batch[0];
      var translated = cleanTranslation(translation);
      if (translated) {
        cacheSet(item.raw, translated);
        applyTranslation(item.node, item.raw, translated);
        pairs.push({ id: item.id, raw: item.raw, translated: translated });
      }
    } else {
      var parsed = parseTranslated(translation);

      if (parsed.fallbackLines) {
        var lines = parsed.fallbackLines;
        var n = Math.min(batch.length, lines.length);
        for (var i = 0; i < n; i++) {
          var t = lines[i];
          if (!t) continue;
          cacheSet(batch[i].raw, t);
          applyTranslation(batch[i].node, batch[i].raw, t);
          pairs.push({ raw: batch[i].raw, translated: t });
        }
        if (n < batch.length) {
          for (var j = n; j < batch.length; j++) {
            var missedItem = batch[j];
            var idStr = String(missedItem.id);
            var idx = translation.indexOf(idStr);
            if (idx !== -1) {
              var before = idx > 0 ? translation[idx - 1] : '\n';
              var after = translation[idx + idStr.length] || '';
              if (before !== MARK_L && before !== '[' && before !== '【' && before !== '\n' &&
                  after !== MARK_R && after !== ']' && after !== '】') continue;
              var tail = translation.slice(idx + idStr.length);
              var breakPoints = [tail.indexOf(MARK_L), tail.indexOf('\n')].filter(function(p) { return p >= 0; });
              var end = breakPoints.length ? Math.min.apply(null, breakPoints) : -1;
              var snippet = (end >= 0 ? tail.slice(0, end) : tail).trim();
              if (snippet && snippet.length > 0) {
                var cleaned = cleanTranslation(snippet);
                if (cleaned) {
                  cacheSet(missedItem.raw, cleaned);
                  applyTranslation(missedItem.node, missedItem.raw, cleaned);
                  pairs.push({ id: missedItem.id, raw: missedItem.raw, translated: cleaned });
                }
              }
            }
          }
        }
      } else {
        var unmatched = [];
        for (var k = 0; k < batch.length; k++) {
          var batchItem = batch[k];
          var matchedTrans = parsed.get(batchItem.id);
          if (matchedTrans) {
            cacheSet(batchItem.raw, matchedTrans);
            applyTranslation(batchItem.node, batchItem.raw, matchedTrans);
            pairs.push({ id: batchItem.id, raw: batchItem.raw, translated: matchedTrans });
          } else {
            unmatched.push(batchItem);
          }
        }
        if (unmatched.length > 0) {
          for (var u = 0; u < unmatched.length; u++) {
            var uItem = unmatched[u];
            var uIdStr = String(uItem.id);
            var uIdx = translation.indexOf(uIdStr);
            if (uIdx !== -1) {
              var uBefore = uIdx > 0 ? translation[uIdx - 1] : '\n';
              var uAfter = translation[uIdx + uIdStr.length] || '';
              if (uBefore !== MARK_L && uBefore !== '[' && uBefore !== '【' && uBefore !== '\n' &&
                  uAfter !== MARK_R && uAfter !== ']' && uAfter !== '】') continue;
              var uTail = translation.slice(uIdx + uIdStr.length);
              var uBreakPoints = [uTail.indexOf(MARK_L), uTail.indexOf('\n')].filter(function(p) { return p >= 0; });
              var uEnd = uBreakPoints.length ? Math.min.apply(null, uBreakPoints) : -1;
              var uSnippet = (uEnd >= 0 ? uTail.slice(0, uEnd) : uTail).trim();
              if (uSnippet && uSnippet.length > 0) {
                var uCleaned = cleanTranslation(uSnippet);
                if (uCleaned) {
                  cacheSet(uItem.raw, uCleaned);
                  applyTranslation(uItem.node, uItem.raw, uCleaned);
                  pairs.push({ id: uItem.id, raw: uItem.raw, translated: uCleaned });
                }
              }
            }
          }
        }
      }
    }
  } finally {
    _muteDepth--;
  }

  return pairs;
}

async function translateBatch(batch) {
  if (!isAlive() || translationMode === 'off') return;

  const gen = _flushGen;
  const seq = ++batchSeq;

  const isSolo = batch.length === 1 && batch[0].solo;
  const text = isSolo
    ? batch[0].raw
    : batch.map(x => x.payload).join('\n');

  _dbg('batch_send', {
    seq,
    count: batch.length,
    items: batch.map(x => ({ id: x.id, raw: x.raw }))
  });

  const t0 = performance.now();

  let result;
  let sl;
  if (isSolo) {
    sl = detectSourceLang(text);
  } else if (batch.length === 1) {
    // 单条非solo批次：用显式语言检测，避免 MS auto-detect 将
    // 高 CJK 占比的日文（如：仅少量假名的混合文本）误判为中文
    sl = detectSourceLang(batch[0].raw);
  } else {
    sl = 'auto';
  }

  // Retry sendMessage up to 3 times (service worker may be waking up)
  for (let retry = 0; retry < 3; retry++) {
    try {
      result = await chrome.runtime.sendMessage({
        type: 'translate',
        text: text,
        sl: sl,
        domain: location.hostname,
        groupId: seq
      });
      break; // success — exit retry loop
    } catch (e) {
      if (retry < 2) {
        await new Promise(r => setTimeout(r, 50 * (retry + 1)));
      } else {
        // Background script crashed or disconnected after all retries
        result = { error: 'BG连接失败: ' + e.message };
        if (e.message === 'Extension context invalidated') {
          _handleExtensionGone();
        }
      }
    }
  }

  // Stale result — restorePage or translatePage happened while this batch was in-flight.
  // Check BEFORE applying any fallback, so we don't overwrite restored text.
  if (gen !== _flushGen || translationMode === 'off') return;

  // If background returned an error — no fallback, just log and fail
  if (result?.error) {
    ERR('翻译失败:', result.error, '| sl=', sl, '| text前100字:', text.slice(0, 100));
    diag.apiErrors.push(result.error);
    diag.failed += batch.length;
    return;
  }

  // 流式模式：后台会分批推送 apply_translation，这里只存批次数据
  if (result?.accepted) {
    _inflightBatches[seq] = { batch: batch, gen: gen, seq: seq, isSolo: isSolo, t0: t0, applied: 0, total: batch.length };
    return;
  }

  if (!result?.translation) {
    WARN('empty translation response');
    return;
  }

  const elapsed = performance.now() - t0;
  var pairs = _applyTranslationResult(batch, result.translation, isSolo);
  _dbg('batch_done', { seq: seq, count: pairs.length, elapsed: elapsed, pairs: pairs, engine: result.engine || '' });
  diag.translated += pairs.length;
}

function applyTranslation(node, raw, translated) {
  // Handle attribute wrapper objects
  if (node.__isAttr) {
    const el = node.__el;
    const attr = node.__attr;
    if (!el.isConnected) return;
    const cleanAttrVal = cleanTranslation(translated);
    // Store original attr value for restore (only first time)
    if (!el.__gt_orig_attrs) el.__gt_orig_attrs = {};
    if (!(attr in el.__gt_orig_attrs)) el.__gt_orig_attrs[attr] = raw;
    // Track in WeakMap for dedup
    if (!origAttrMap.has(el)) origAttrMap.set(el, new Map());
    origAttrMap.get(el).set(attr, raw);
    // Mark as translated to prevent observer feedback loop
    if (!translatedAttrs.has(el)) translatedAttrs.set(el, new Map());
    translatedAttrs.get(el).set(attr, { raw: raw, translated: cleanAttrVal });
    el.setAttribute(attr, cleanAttrVal);
    return;
  }

  // Normal text node — check if still in DOM
  if (node.parentElement && node.isConnected) {
    const translatedText = cleanTranslation(translated);
    if (node.__gt_orig !== undefined && node.textContent === translatedText) return;
    // Store original text for restore — only if not already captured by flushQueue
    // or processTextNode (otherwise a page-side modification between snapshot and
    // apply would be incorrectly saved as the "original").
    if (node.__gt_orig === undefined) {
      node.__gt_orig = node.textContent;
    }
    // Also track in WeakMap for dedup (processTextNode re-entry guard)
    origTextMap.set(node, { raw: raw, translated: translatedText });
    node.textContent = translatedText;
    return;
  }

  // Node is detached (framework re-rendered) — skip it.
  // The MutationObserver will pick up its replacement when it's re-added.
}

// ─────────────────────────────────────────────
// flush queue
// ─────────────────────────────────────────────

async function flushQueue() {
  if (translationMode === 'off') {
    clearPendingWork();
    if (_manualFlushResolvers.length > 0) {
      const rs = _manualFlushResolvers; _manualFlushResolvers = [];
      for (const r of rs) r(0);
    }
    return { skipped: true, reason: 'disabled', count: 0 };
  }
  if (translating) return { skipped: true, count: 0 };
  translating = true;

  let translatedCount = 0;

  var allNodes = [];

  try {
    // Atomically drain the queue into a snapshot before iterating.
    // This prevents the MutationObserver (which fires synchronously during
    // textContent reads inside normalize()) from adding new entries that
    // the for…of iterator might skip or visit depending on hash-table order.
    const queuedNodes = [...queue];
    queue.clear();

    _muteDepth++;
    try {
      for (const node of queuedNodes) {
        if (!node?.parentElement) continue;

        const raw = normalize(node.textContent);
        if (!raw) continue;

        // Snapshot the text — downstream code uses this, not a re-read from DOM
        node.__gtRaw = raw;
        // Also capture the restore target NOW, before the page can modify it.
        // applyTranslation itself won't overwrite this unless unregisterTextRestore
        // cleared it first (which means the node's content changed externally).
        if (node.__gt_orig === undefined) {
          node.__gt_orig = node.textContent;
        }

        var cachedNode = cacheGet(raw);
        if (cachedNode !== undefined) {
          diag.cached++;
          var beforeApply = node.__isAttr ? node.__el.getAttribute(node.__attr) : node.textContent;
          applyTranslation(node, raw, cachedNode);
          var afterApply = node.__isAttr ? node.__el.getAttribute(node.__attr) : node.textContent;
          if (beforeApply !== afterApply) translatedCount++;
          continue;
        }

        allNodes.push(node);
      }
    } finally {
      _muteDepth--;
    }

    const batches = buildBatches(allNodes);
    let index = 0;

    async function worker() {
      while (index < batches.length) {
        if (translationMode === 'off') return;
        const i = index++;
        try {
          await translateBatch(batches[i]);
        } catch (e) {
          ERR('translateBatch 未预期异常:', e?.message || e, '| batchSeq:', batches[i]?.[0]?.id || '?');
          diag.failed += batches[i] ? batches[i].length : 0;
        }
      }
    }

    const workerCount = Math.min(CONCURRENT, batches.length);
    const workers = [];
    for (let i = 0; i < workerCount; i++) {
      workers.push(worker());
    }

    await Promise.all(workers);

    if (translationMode === 'off') return { skipped: true, reason: 'disabled', count: 0 };

    // Second pass: only handle untranslated nodes (most are already done)
    _muteDepth++;
    try {
      for (const node of allNodes) {
        if (node.__isAttr) {
          if (node.__el.__gt_orig_attrs && node.__el.__gt_orig_attrs[node.__attr] !== undefined) {
            translatedCount++;
            continue;
          }
          const raw = node.__gtRaw;
          if (raw) {
            var cachedAttr = cacheGet(raw);
            if (cachedAttr !== undefined) {
              applyTranslation(node, raw, cachedAttr);
              translatedCount++;
              continue;
            }
          }
          const el = node.__el;
          const attr = node.__attr;
          if (el.__gt_orig_attrs && attr in el.__gt_orig_attrs) {
            el.setAttribute(attr, el.__gt_orig_attrs[attr]);
            delete el.__gt_orig_attrs[attr];
          }
        } else {
          if (origTextMap.has(node)) {
            translatedCount++;
            continue;
          }
          const raw = node.__gtRaw;
          if (raw) {
            var cachedText = cacheGet(raw);
            if (cachedText !== undefined) {
              applyTranslation(node, raw, cachedText);
              if (origTextMap.has(node)) { translatedCount++; continue; }
            }
          }
          if (node.__gt_orig !== undefined) { node.textContent = node.__gt_orig; }
          delete node.__gt_orig;
        }
      }
    } finally {
      _muteDepth--;
    }

  } finally {
    translating = false;

    // 清理 __gtRaw 快照，防止长期运行的 SPA 页面内存泄漏
    for (const node of allNodes) {
      delete node.__gtRaw;
    }

    // 诊断输出
    _diagLog();

    // 错误横幅
    if (diag.apiErrors.length > 0 && diag.translated === 0) {
      var uniqueErrors = [];
      var seen = {};
      for (var ei = 0; ei < diag.apiErrors.length; ei++) {
        var err = diag.apiErrors[ei];
        if (!seen[err]) { seen[err] = true; uniqueErrors.push(err); }
      }
      showErrorBanner('翻译接口全部失败: ' + uniqueErrors.slice(0, 2).join('; '));
    } else if (diag.translated > 0 && _errorBanner) {
      _errorBanner.remove();
      _errorBanner = null;
    }

    // 通知 UI 状态更新（自动/手动模式均需同步）
    if (translatedCount > 0) {
      notifyTranslatedState(true);
    }

    // Resolve all manual flush waiters so each message handler gets the actual count
    if (_manualFlushResolvers.length > 0) {
      const rs = _manualFlushResolvers; _manualFlushResolvers = [];
      for (const r of rs) r(translatedCount + _incrementalApplied);
    }

    // If more nodes accumulated while we were busy, flush again
    if (translationMode !== 'off' && queue.size > 0) scheduleFlush();
  }

  return { success: true, count: translatedCount };
}

// ─────────────────────────────────────────────
// restore
// ─────────────────────────────────────────────

function restorePage() {
  if (!document.body) return 0;
  translationMode = 'off';
  clearPendingWork();
  stopObserver();
  _flushGen++;
  _inflightBatches = {};
  _incrementalApplied = 0;

  if (_manualFlushResolvers.length > 0) {
    const rs = _manualFlushResolvers; _manualFlushResolvers = [];
    for (const r of rs) r(0);
  }

  var restoredCount = 0;

  // Single-pass tree walk: collect text nodes and elements together
  var textNodes = [];
  var elements = [];
  collectBoth(document.body, textNodes, elements);

  // Global mute — suppress observer for the entire restore
  _muteDepth++;
  try {
    for (var ti = 0; ti < textNodes.length; ti++) {
      var node = textNodes[ti];
      if (node.__gt_orig !== undefined) {
        node.textContent = node.__gt_orig;
        delete node.__gt_orig;
        restoredCount++;
      }
    }

    for (var ei = 0; ei < elements.length; ei++) {
      var el = elements[ei];
      if (el.__gt_orig_attrs) {
        for (var attr in el.__gt_orig_attrs) {
          if (el.__gt_orig_attrs.hasOwnProperty(attr)) {
            el.setAttribute(attr, el.__gt_orig_attrs[attr]);
            restoredCount++;
          }
        }
        delete el.__gt_orig_attrs;
        if (translatedAttrs.has(el)) translatedAttrs.delete(el);
      }
    }
  } finally {
    _muteDepth--;
  }

  origTextMap = new WeakMap();
  origAttrMap = new WeakMap();
  translatedAttrs = new WeakMap();
  cache.clear();
  seenText.clear();
  observedShadows = new WeakSet();

  return restoredCount;
}

function notifyTranslatedState(translated) {
  if (!isAlive()) return;
  chrome.runtime.sendMessage({
    type: 'update_state',
    translated
  }).catch(() => { });
}

function _handleExtensionGone() {
  if (translationMode === 'off') return;
  LOG('扩展上下文失效，停止翻译并恢复页面');
  translationMode = 'off';
  clearPendingWork();
  stopObserver();
  restorePage();
  notifyTranslatedState(false);
}

async function translatePage(mode) {
  if (translating) {
    if (mode === 'manual') return { skipped: true, reason: 'busy' };
    // auto-mode SPA re-entry: abort in-flight translations so they don't
    // overwrite the restored page with stale results, and release the
    // translating lock so the new scan can start immediately
    _flushGen++;
  _inflightBatches = {};
  _incrementalApplied = 0;
    translating = false;
    clearPendingWork();
  }

  LOG(`translatePage 启动, mode=${mode}`);
  _diagReset();
  _incrementalApplied = 0;
  translationMode = mode;
  startObserver();
  LOG('  Observer 已启动');

  // scanInitial 通过 requestIdleCallback 延迟执行，不阻塞页面渲染
  // 扫描完成后内部调用 scheduleFlush 触发翻译
  scanInitial();
  LOG('  初始扫描已调度（requestIdleCallback），翻译将在浏览器空闲时启动');

  // 手动模式：返回一个 Promise，flushQueue 完成时 resolve 实际翻译数
  // 每次调用都注册独立的 resolver，避免并发调用覆盖同一个 Promise
  if (mode === 'manual') {
    return new Promise(function (r) {
      _manualFlushResolvers.push(r);
    }).then(function (count) { return { success: true, count: count }; });
  }

  return { success: true, count: 0 };
}

function collectTextNodes(root, out) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) out.push(walker.currentNode);
  for (const sr of shadowRootsIn(root)) collectTextNodes(sr, out);
}

function collectElements(root, out) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  while (walker.nextNode()) out.push(walker.currentNode);
  for (const sr of shadowRootsIn(root)) collectElements(sr, out);
}

function collectBoth(root, textOut, elOut) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  while (walker.nextNode()) {
    const n = walker.currentNode;
    if (n.nodeType === Node.TEXT_NODE) {
      textOut.push(n);
    } else if (n.nodeType === Node.ELEMENT_NODE) {
      elOut.push(n);
    }
  }
  for (const sr of shadowRootsIn(root)) collectBoth(sr, textOut, elOut);
}

// ─────────────────────────────────────────────
// message handler
// ─────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _s, send) => {

  if (msg.action === 'translate_page') {
    (async function () {
      try {
        // 页面已是简体中文 → 无需翻译（用户可通过排除域名兜底覆盖）
        if (isPageSimplifiedChinese()) {
          LOG('手动翻译：页面为简体中文，跳过');
          send({ success: true, count: 0, reason: 'already_chinese' });
          return;
        }

        var result = await Promise.race([
          translatePage('manual'),
          new Promise(function (r) { setTimeout(function () { r({ success: false, reason: 'timeout' }); }, 30000); })
        ]);
        if (result?.skipped) {
          send({ success: false, reason: 'busy' });
          return;
        }
        if (result?.error) {
          send({ success: false, reason: result.error });
          return;
        }
        if (result?.success === false && result?.reason) {
          send({ success: false, reason: result.reason });
          return;
        }
        send({ success: true, count: result.count || 0 });
      } catch (e) {
        send({ success: false, reason: e?.message });
      }
    })();
    return true;
  }

  if (msg.action === 'restore_page') {
    var restoredCount = restorePage();
    notifyTranslatedState(false);
    send({ success: true, count: restoredCount });
    return;
  }

  if (msg.action === 'get_logs') {
    send({ logs: getLogBuffer() });
    return;
  }

  if (msg.action === 'download_logs') {
    downloadLogs();
    send({ success: true });
    return;
  }

  if (msg.action === 'save_logs') {
    var logBlob = new Blob([msg.text], { type: 'text/plain;charset=utf-8' });
    var logA = document.createElement('a');
    logA.href = URL.createObjectURL(logBlob);
    logA.download = msg.filename;
    document.body.appendChild(logA);
    logA.click();
    setTimeout(function() { document.body.removeChild(logA); URL.revokeObjectURL(logA.href); }, 300);
    send({ success: true });
    return;
  }

  // 流式翻译：后台分批推送各引擎的译文
  if (msg.action === 'apply_translation') {
    var grpId = msg.groupId;
    if (grpId === undefined || grpId === null) return;
    var inf = _inflightBatches[grpId];
    if (!inf) return;
    if (inf.gen !== _flushGen || translationMode === 'off') {
      delete _inflightBatches[grpId];
      return;
    }
    if (!msg.translation) return;

    var partialPairs = _applyTranslationResult(inf.batch, msg.translation, inf.isSolo);
    inf.applied += partialPairs.length;

    if (inf.applied >= inf.total) {
      var elapsed = performance.now() - inf.t0;
      _dbg('batch_done', { seq: inf.seq, count: inf.applied, elapsed: elapsed, engine: 'dual' });
      diag.translated += inf.applied;
      _incrementalApplied += inf.applied;
      delete _inflightBatches[grpId];
    }
    return;
  }

});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.excludedDomains) {
    _excludedDomains = changes.excludedDomains.newValue || [];
    const host = window.location.hostname || '';
    if (_excludedDomains.indexOf(host) !== -1 && translationMode !== 'off') {
      translationMode = 'off';
      clearPendingWork();
      stopObserver();
      restorePage();
      notifyTranslatedState(false);
    }
    return;
  }

  if (area !== 'sync' || !changes.autoTranslate) return;

  if (
    changes.autoTranslate.newValue === false &&
    translationMode === 'auto'
  ) {
    translationMode = 'off';
    clearPendingWork();
    stopObserver();
    restorePage();
    notifyTranslatedState(false);
  }
});

// ─────────────────────────────────────────────
// init
// ─────────────────────────────────────────────

// Keep service worker alive during translation
if (isAlive()) {
  try {
    var keepAlivePort = chrome.runtime.connect({ name: 'keepAlive' });
    keepAlivePort.onDisconnect.addListener(function () {
      chrome.runtime.lastError;
      if (!isAlive()) _handleExtensionGone();
    });
  } catch (_) { }
}

// ── SPA 导航检测 ──
// 问题: tabs.onUpdated 只响应 status==='loading'，SPA 路由切换不触发
// 导致: tab 状态/右键菜单错误，新 DOM 节点的还原功能失效
(function setupSPADetection() {
  var spaDebounce = null;
  var lastSpaUrl = location.href;

  function onSpaNavigate() {
    if (location.href === lastSpaUrl) return;
    lastSpaUrl = location.href;
    LOG('SPA 导航检测: ' + lastSpaUrl);

    var prevMode = translationMode;
    if (prevMode === 'off') return;

    // 重置翻译状态
    restorePage();
    notifyTranslatedState(false);

    // 自动模式：检查排除域名 + 中文后重新翻译
    if (prevMode === 'auto') {
      var newDomain = location.hostname || '';
      if (_excludedDomains.indexOf(newDomain) !== -1) {
        LOG('SPA：域名已排除，跳过:', newDomain);
        return;
      }
      if (typeof isPageSimplifiedChinese === 'function' && isPageSimplifiedChinese()) {
        LOG('SPA：页面为简体中文，跳过翻译');
        return;
      }
      translatePage('auto');
    }
    // 手动模式：保持关闭，用户需手动触发
  }

  function handleSpaUrlChange() {
    if (spaDebounce) clearTimeout(spaDebounce);
    spaDebounce = setTimeout(onSpaNavigate, 100);
  }

  // 拦截 history.pushState / replaceState
  var origPushState = history.pushState;
  history.pushState = function () {
    origPushState.apply(this, arguments);
    handleSpaUrlChange();
  };
  var origReplaceState = history.replaceState;
  history.replaceState = function () {
    origReplaceState.apply(this, arguments);
    handleSpaUrlChange();
  };

  // 监听 popstate（浏览器前进/后退按钮）
  window.addEventListener('popstate', handleSpaUrlChange);

  // 监听 hashchange（hash 路由 SPA 如 #/page1 → #/page2）
  window.addEventListener('hashchange', handleSpaUrlChange);
})();

(async function init() {

  LOG('content.js 初始化开始...');

  if (!document.body) {
    LOG('等待 document.body...');
    await new Promise(r => {
      window.addEventListener('load', r, { once: true });
    });
  }

  // 加载排除域名：从 chrome.storage.local 读取（安装时由 background 从 excluded-domains.json 种子写入）
  const domain = window.location.hostname || '';

  const settings = await new Promise(r =>
    chrome.storage.local.get(['excludedDomains'], r)
  );

  let excludedDomains = _excludedDomains;
  if (settings.excludedDomains && Array.isArray(settings.excludedDomains)) {
    excludedDomains = settings.excludedDomains;
    _excludedDomains = settings.excludedDomains;
  }

  // 额外读取 autoTranslate 设置
  const autoSettings = await new Promise(r =>
    chrome.storage.sync.get(['autoTranslate'], r)
  );
  settings.autoTranslate = autoSettings.autoTranslate;

  LOG('排除域名列表:', excludedDomains);

  if (excludedDomains.indexOf(domain) !== -1) {
    LOG('域名已排除，跳过:', domain);
    return;
  }

  // 页面已是简体中文 → 无需翻译（排除域名功能作为自定义兜底）
  if (isPageSimplifiedChinese()) {
    LOG('页面为简体中文，跳过翻译');
    return;
  }

  LOG('autoTranslate 设置:', settings.autoTranslate);

  if (settings.autoTranslate === false) {
    LOG('自动翻译已关闭，跳过');
    return;
  }

  translatePage('auto');
  LOG('初始化完成');

})()