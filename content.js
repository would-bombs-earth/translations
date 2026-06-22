
// content.js

// manual flush promise (Fix 1+6: real count from translatePage)

var _flR = [], _flushGen = 0, _iF = {}, _iA = 0;

// node processing

function enqueueNode(node) {
  if (tMode === 'off') return;
  if (!node) return;
  if (queue.size > MAX_QUEUE) return;

  // ShadowRoot / DocumentFragment 鈥?walk children, then recurse into nested shadows
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

function processElementAttrs(el, onlyAttr) {
  if (tMode === 'off') return;
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

    // Cache hit 鈫?apply immediately (before language check 鈥?faster)
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
      // Content changed externally 鈥?remove old translation mapping
      done.delete(attr);
      if (el.__gt_orig_attrs && attr in el.__gt_orig_attrs) delete el.__gt_orig_attrs[attr];
    }

    // From here on, this is new/changed foreign text 鈥?allow re-processing

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
  if (tMode === 'off') return;
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

  // Cache hit 鈫?apply immediately without queuing (before language check 鈥?faster)
  var cachedTrans2 = cacheGet(text);
  if (cachedTrans2 !== undefined) {
    if (cachedTrans2 !== text) {
      diag.cached++;
      // Capture original text content now; applyTranslation won't overwrite it
      if (node.__gt_orig === undefined) node.__gt_orig = node.textContent;
      mute(() => applyTranslation(node, text, cachedTrans2));
    }
    return;
  }

  if (isAlreadyChinese(text)) { diag.alreadyChinese++; return; }

  // Fast cache hit: if already translated and this is a React-rebuilt node
  var fastCache = cacheGet(text);
  if (fastCache !== undefined && fastCache !== text && !origTextMap.has(node)) {
    if (node.__gt_orig === undefined) node.__gt_orig = raw;
    origTextMap.set(node, { raw: text, translated: fastCache });
    mute(() => applyTranslation(node, text, fastCache));
    return;
  }

  // Node was previously translated but content has changed externally
  // (e.g. "show more" expanded the textContent of the same node).
  // Re-process it; applyTranslation will update origTextMap with the new raw.
  if (origTextMap.has(node)) {
    if (normalize(origTextMap.get(node).translated) === text) return;
    unregisterTextRestore(node);
  }

  // Dedup: same text already queued 鈫?track node for later apply
  if (seenText.has(text)) {
    // still queue so buildBatches can apply from cache after translation
    node.__gtRaw = text;
    queue.add(node);
    return;
  }

  node.__gtRaw = text;
  node.__gt_orig = raw;
  seenAdd(text);
  queue.add(node);
  diag.queued++;
  dispatchIncremental();
  _dbg('detect', { text });
}

function dispatchIncremental() {
  if (tMode === 'off' || !isAlive()) return;
  if (queue.size < INCREMENTAL_THRESHOLD) return;

  var nodes = [], iter = queue.values(), count = 0, next;
  while (count < BATCH_SIZE && !(next = iter.next()).done) {
    nodes.push(next.value);
    queue.delete(next.value);
    count++;
  }
  if (nodes.length === 0) return;

  var processed = [];
  _muteDepth++;
  try { processed = nodes.filter(n => n?.parentElement && n.__gtRaw); } finally { _muteDepth--; }

  if (processed.length === 0) return;

  var batches = buildBatches(processed);
  batches.forEach(b => translateBatch(b));
}

function scanInitial(skipHydration) {
  if (tMode === 'off') return;

  var hasHydration = skipHydration ? false : (
    !!document.querySelector('#__docusaurus,#__next,#___gatsby,#app,[data-reactroot],[data-react-class]') ||
    !!(window.__NEXT_DATA__ || window.__NUXT__ || window.__GATSBY__ || window.__REACT_DEVTOOLS_GLOBAL_HOOK__) ||
    function() {
      for (var s of document.querySelectorAll('script[src]')) if (/react|next|vue|angular|svelte|docusaurus|nuxt|gatsby/i.test(s.src||s.textContent||'')) return true;
      return false;
    }()
  );

  var delay = hasHydration ? HYDRATION_DELAY_MS : 0;

  const doScan = function () {
    if (tMode === 'off') return;
    var titleEl = document.querySelector('title');
    if (titleEl && titleEl.firstChild && titleEl.firstChild.nodeType === Node.TEXT_NODE) processTextNode(titleEl.firstChild);
    enqueueNode(document.body);
    const attrSelector = TRANSLATABLE_ATTRS.map(a => '[' + a + ']').join(',');
    var els = querySelectorAllDeep(document.body, attrSelector);
    els.forEach(el => processElementAttrs(el));
    scheduleFlush();
  };

  if (tMode === 'manual') {
    doScan();
  } else if (delay > 0) {
    LOG_DOM('检测到 SPA 框架，延迟' + delay + 'ms 等待水合完成');
    setTimeout(() => {
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

// Shared mutation handler used for both main DOM and shadow-root observers
function onMutation(mutations) {
  if (tMode === 'off') return;
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
              _oS.delete(entry.root);
              _shadowObservers.splice(i, 1);
            }
          }
        }
      }
    }
    if (m.type === 'characterData') processTextNode(m.target);
    if (m.type === 'attributes') processElementAttrs(m.target, m.attributeName);
  }
  scheduleFlush();
}

function observeShadowRoot(sr) {
  if (!sr || _oS.has(sr)) return;
  _oS.add(sr);
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
  observer.observe(document.documentElement, {
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
  _shadowObservers.forEach(e => e.observer.disconnect());
  _shadowObservers = [];
  _oS = new WeakSet();
}

let flushTimer = null;

function scheduleFlush() {
  if (tMode === 'off') return;
  if (translating || flushTimer || !isAlive()) return;
  if (tMode === 'manual') { flushQueue(); return; }
  flushTimer = setTimeout(() => {
    flushTimer = null;
    if (isAlive() && tMode !== 'off') flushQueue();
  }, FLUSH_MS);
}

function clearPendingWork() {
  queue.clear();
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
}

function buildBatches(nodes) {
  const batches = [];
  let current = [], chars = 0;
  for (const node of nodes) {
    const raw = node.__gtRaw || normalize(node.textContent);

    // Cache hit 鈫?apply immediately, skip batch
    var cachedRaw = cacheGet(raw);
    if (cachedRaw !== undefined) {
      if (cachedRaw !== raw) mute(() => applyTranslation(node, raw, cachedRaw));
      continue;
    }

    const id = uid++;
    node.__gtId = id;

    // Solo batch for:
    //  (1) long text (avoids marker corruption)
    //  (2) pure CJK without kana/hangul 鈥?could be Trad.Chinese or pure-kanji Japanese;
    //      mixing these in marker batches with sl=auto causes Google to misdetect.
    //  Japanese with kana / Korean with hangul are unambiguous 鈫?can batch safely.
    const hasCjk = CJK_RE.test(raw), hasKana = KANA_RE.test(raw), hasHangul = HANGUL_RE.test(raw);
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

function parseTranslated(text) {
  const result = new Map();

  // Google 可能把标记转为 ASCII 括号 [] 或 CJK 括号 【】，先归一化
  // 仅匹配行首的孤立 [N]（Google 转换产物），避免误伤 "see [1]" 等正常引用
  text = text.replace(/(^|\n)\[(\d+)\]/gm, '$1' + MARK_L + '$2' + MARK_R);
  text = text.replace(/【(\d+)】/g, MARK_L + '$1' + MARK_R);
  // Google 可能在标记内部插入空格，归一化 ⟪1 ⟫ → ⟪⟫
  text = text.replace(/\u27EA\s*(\d+)\s*\u27EB/g, MARK_L + '$1' + MARK_R);

  // MARK_R may be dropped by Google Translate; make it optional
  const regex = new RegExp(
    `${MARK_L}(\\d+)${MARK_R}?([\\s\\S]*?)(?=${MARK_L}\\d+${MARK_R}?|$)`,
    'g'
  );

  let m;
  while ((m = regex.exec(text))) {
    const id = Number(m[1]), content = m[2].trim();
    result.set(id, cleanTranslation(content));
  }

  if (result.size === 0) {
    // ME-1: fallback 鈥?line-by-line order matching, filter empty/whitespace-only lines
    const lines = text
      .split(/\n/)
      .map(s => cleanTranslation(s))
      .filter(s => s && s.length > 0);

    if (lines.length > 0) {
      return { fallbackLines: lines };
    }
  }

  return result;
}

function _tryExtract(translation, item, pairs) {
  var idStr = String(item.id), idx = translation.indexOf(idStr), cleaned;
  if (idx === -1) return;
  var before = idx > 0 ? translation[idx - 1] : '\n', after = translation[idx + idStr.length] || '';
  if (before !== MARK_L && before !== '[' && before !== '【' && before !== '\n' &&
  after !== MARK_R && after !== ']' && after !== '】') return;
  var tail = translation.slice(idx + idStr.length), breakPoints = [tail.indexOf(MARK_L), tail.indexOf('\n')].filter(p => p >= 0);
  var end = breakPoints.length ? Math.min.apply(null, breakPoints) : -1, snippet = (end >= 0 ? tail.slice(0, end) : tail).trim();
  if (!snippet || !snippet.length || !(cleaned = cleanTranslation(snippet))) return;
  cacheSet(item.raw, cleaned);
  applyTranslation(item.node, item.raw, cleaned);
  pairs.push({ id: item.id, raw: item.raw, translated: cleaned });
}

function _applyTr(batch, translation, isSolo) {
  var pairs = [];

  _muteDepth++;
  try {
    if (isSolo) {
      var item = batch[0], translated = cleanTranslation(translation);
      if (translated) {
        cacheSet(item.raw, translated);
        applyTranslation(item.node, item.raw, translated);
        pairs.push({ id: item.id, raw: item.raw, translated: translated });
      }
    } else {
      var parsed = parseTranslated(translation);

      if (parsed.fallbackLines) {
        var lines = parsed.fallbackLines, n = Math.min(batch.length, lines.length);
        for (var i = 0; i < n; i++) {
          var t = lines[i];
          if (!t) continue;
          cacheSet(batch[i].raw, t);
          applyTranslation(batch[i].node, batch[i].raw, t);
          pairs.push({ raw: batch[i].raw, translated: t });
        }
        if (n < batch.length) batch.slice(n).forEach(b => _tryExtract(translation, b, pairs));
      } else {
        var unmatched = [];
        for (var k = 0; k < batch.length; k++) {
          var batchItem = batch[k], matchedTrans = parsed.get(batchItem.id);
          if (matchedTrans) {
            cacheSet(batchItem.raw, matchedTrans);
            applyTranslation(batchItem.node, batchItem.raw, matchedTrans);
            pairs.push({ id: batchItem.id, raw: batchItem.raw, translated: matchedTrans });
          } else {
            unmatched.push(batchItem);
          }
        }
        if (unmatched.length > 0) unmatched.forEach(u => _tryExtract(translation, u, pairs));
      }
    }
  } finally {
    _muteDepth--;
  }

  return pairs;
}

async function translateBatch(batch) {
  if (!isAlive() || tMode === 'off') return;

  const gen = _flushGen, seq = ++batchSeq, isSolo = batch.length === 1 && batch[0].solo, text = isSolo
    ? batch[0].raw
    : batch.map(x => x.payload).join('\n');

  _dbg('batch_send', {
    seq,
    count: batch.length,
    items: batch.map(x => ({ id: x.id, raw: x.raw }))
  });

  const t0 = performance.now();

  let result, sl;
  if (isSolo) {
    sl = detectSourceLang(text);
  } else if (batch.length === 1) {
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
      break; // success 鈥?exit retry loop
    } catch (e) {
      if (retry < 2) {
        await new Promise(r => setTimeout(r, 50 * (retry + 1)));
      } else {
        // Background script crashed or disconnected after all retries
        result = { error: 'BG连接失败: ' + e.message };
        if (e.message === 'Extension context invalidated') _handleExtensionGone();
      }
    }
  }

  // Stale result — restorePage or translatePage happened while this batch was in-flight.
  // Check BEFORE applying any fallback, so we don't overwrite restored text.
  if (gen !== _flushGen || tMode === 'off') return;

  // If background returned an error 鈥?no fallback, just log and fail
  if (result?.error) {
    ERR('翻译失败:', result.error, '| sl=', sl, '| text前100字', text.slice(0, 100));
    diag.apiErrors.push(result.error);
    diag.failed += batch.length;
    return;
  }

  if (result?.accepted) {
    _iF[seq] = { batch: batch, gen: gen, seq: seq, isSolo: isSolo, t0: t0, applied: 0, total: batch.length };
    return;
  }

  if (!result?.translation) {
    WARN('empty translation response');
    return;
  }

  const elapsed = performance.now() - t0;
  var pairs = _applyTr(batch, result.translation, isSolo);
  _dbg('batch_done', { seq: seq, count: pairs.length, elapsed: elapsed, pairs: pairs, engine: result.engine || '' });
  diag.translated += pairs.length;
}

function applyTranslation(node, raw, translated) {
  // Handle attribute wrapper objects
  if (node.__isAttr) {
    const el = node.__el, attr = node.__attr;
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

  // Normal text node 鈥?check if still in DOM
  if (node.parentElement && node.isConnected) {
    const translatedText = cleanTranslation(translated);
    if (!translatedText) return;
    if (normalize(translatedText) === normalize(raw)) return;
    if (node.__gt_orig === undefined) {
      node.__gt_orig = node.textContent;
    }
    origTextMap.set(node, { raw: raw, translated: translatedText });
    // Simple direct write 鈥?no DOM structure changes, no React breakage
    node.textContent = translatedText;
    return;
  }

  // Node is detached 鈥?skip.
}


async function flushQueue() {
  if (tMode === 'off') {
    clearPendingWork();
    if (_flR.length > 0) {
      const rs = _flR; _flR = [];
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
    // the for鈥f iterator might skip or visit depending on hash-table order.
    const queuedNodes = [...queue];
    queue.clear();

    _muteDepth++;
    try {
      for (const node of queuedNodes) {
        if (!node?.parentElement) continue;

        const raw = normalize(node.textContent);
        if (!raw) continue;

        // Snapshot the text 鈥?downstream code uses this, not a re-read from DOM
        node.__gtRaw = raw;
        // Also capture the restore target NOW, before the page can modify it.
        // applyTranslation itself won't overwrite this unless unregisterTextRestore
        // cleared it first (which means the node's content changed externally).
        if (node.__gt_orig === undefined) node.__gt_orig = node.textContent;

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
        if (tMode === 'off') return;
        const i = index++;
        try {
          await translateBatch(batches[i]);
        } catch (e) {
          ERR('translateBatch 未预期异常', e?.message || e, '| batchSeq:', batches[i]?.[0]?.id || '?');
          diag.failed += batches[i] ? batches[i].length : 0;
        }
      }
    }

    const workerCount = Math.min(CONCURRENT, batches.length), workers = [];
    for (let i = 0; i < workerCount; i++) workers.push(worker());

    await Promise.all(workers);

    if (tMode === 'off') return { skipped: true, reason: 'disabled', count: 0 };

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
            _muteDepth++;
            el.setAttribute(attr, el.__gt_orig_attrs[attr]);
            delete el.__gt_orig_attrs[attr];
            _muteDepth--;
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

    allNodes.forEach(n => delete n.__gtRaw);

    _diagLog();

    if (diag.apiErrors.length > 0 && diag.translated === 0) {
      showErrorBanner('翻译接口全部失败: ' + [...new Set(diag.apiErrors)].slice(0, 2).join('; '));
    } else if (diag.translated > 0 && _errorBanner) { _errorBanner.remove(); _errorBanner = null; }

    if (translatedCount > 0) notifyTranslatedState(true);

    // Resolve all manual flush waiters so each message handler gets the actual count
    if (_flR.length > 0) {
      const rs = _flR; _flR = [];
      var reportedCount = translatedCount + _iA;
      if (reportedCount === 0) reportedCount = _iA;
      for (const r of rs) r(reportedCount);
    }

    // If more nodes accumulated while we were busy, flush again
    if (tMode !== 'off' && queue.size > 0) scheduleFlush();
  }

  return { success: true, count: translatedCount + _iA };
}

function restorePage() {
  if (!document.body) return 0;
  tMode = 'off';
  clearPendingWork();
  stopObserver();
  _flushGen++;
  _iF = {};
  _iA = 0;

  if (_flR.length > 0) {
    const rs = _flR; _flR = [];
    for (const r of rs) r(0);
  }

  var restoredCount = 0;

  // Single-pass tree walk: collect text nodes and elements together
  var textNodes = [], elements = []; _coll(document.body, textNodes, elements);

  // Global mute 鈥?suppress observer for the entire restore
  _muteDepth++;
  try {
    // Remove translation spans and restore hidden originals
    var transSpans = document.querySelectorAll('[data-jiyi-translation]');
    transSpans.forEach(s => { try { s.remove(); } catch (_) { } });
    var hiddenCopies = document.querySelectorAll('[data-jiyi-hidden]');
    hiddenCopies.forEach(hc => {
      if (hc.__gtOrigNode) {
        try { hc.parentElement.insertBefore(hc.__gtOrigNode, hc); hc.remove(); restoredCount++; } catch (_) { }
      }
    });

    textNodes.forEach(node => {
      if (node.__gt_orig !== undefined) { node.textContent = node.__gt_orig; delete node.__gt_orig; restoredCount++; }
    });

    var titleEl = document.querySelector('title');
    if (titleEl && titleEl.firstChild && titleEl.firstChild.__gt_orig !== undefined) {
      titleEl.firstChild.textContent = titleEl.firstChild.__gt_orig;
      delete titleEl.firstChild.__gt_orig;
      restoredCount++;
    }

    elements.forEach(el => {
      if (el.__gt_orig_attrs) {
        Object.keys(el.__gt_orig_attrs).forEach(attr => { el.setAttribute(attr, el.__gt_orig_attrs[attr]); restoredCount++; });
        delete el.__gt_orig_attrs;
        if (translatedAttrs.has(el)) translatedAttrs.delete(el);
      }
    });
  } finally {
    _muteDepth--;
  }

  origTextMap = new WeakMap();
  origAttrMap = new WeakMap();
  translatedAttrs = new WeakMap();
  cache.clear();
  seenText.clear();
  _oS = new WeakSet();

  return restoredCount;
}

function notifyTranslatedState(translated) {
  if (!isAlive()) return;
  chrome.runtime.sendMessage({
    type: 'update_state',
    translated
  }).catch(() => { });
}

function _stopAndRestore() {
  tMode = 'off';
  clearPendingWork();
  stopObserver();
  restorePage();
  notifyTranslatedState(false);
}

function _handleExtensionGone() {
  if (tMode === 'off') return;
    LOG_API('扩展上下文失效，停止翻译并恢复页面');
  _stopAndRestore();
}

async function translatePage(mode, skipHydration) {
  if (translating) {
    if (mode === 'manual') return { skipped: true, reason: 'busy' };
    // auto-mode SPA re-entry: abort in-flight translations so they don't
    // overwrite the restored page with stale results, and release the
    // translating lock so the new scan can start immediately
    _flushGen++;
    _iF = {};
    _iA = 0;
    translating = false;
    clearPendingWork();
  }

  LOG(`translatePage 启动, mode=${mode}`);
  _diagReset();
  _iA = 0;
  tMode = mode;
  startObserver();
  LOG('  Observer 已启动');

  scanInitial(skipHydration);
  LOG('  初始扫描已调度（requestIdleCallback），翻译将在浏览器空闲时启动');

  if (mode === 'manual') return new Promise(r => { _flR.push(r); }).then(count => ({ success: true, count }));

  return { success: true, count: 0 };
}

function _coll(root, textOut, elOut) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  while (walker.nextNode()) {
    const n = walker.currentNode;
    if (n.nodeType === Node.TEXT_NODE) {
      textOut.push(n);
    } else if (n.nodeType === Node.ELEMENT_NODE) {
      elOut.push(n);
    }
  }
  for (const sr of shadowRootsIn(root)) _coll(sr, textOut, elOut);
}

chrome.runtime.onMessage.addListener((msg, _s, send) => {

  if (msg.action === 'translate_page') {
    (async () => {
      try {
        if (isPageSimplifiedChinese()) { LOG_STATE('手动翻译：页面为简体中文，跳过'); send({ success: true, count: 0, reason: 'already_chinese' }); return; }
        var result = await Promise.race([translatePage('manual'), new Promise(r => setTimeout(() => r({ success: false, reason: 'timeout' }), 30000))]);
        if (result?.skipped) { send({ success: false, reason: 'busy' }); return; }
        if (result?.error) { send({ success: false, reason: result.error }); return; }
        if (result?.success === false && result?.reason) { send({ success: false, reason: result.reason }); return; }
        send({ success: true, count: result.count || 0 });
      } catch (e) { send({ success: false, reason: e?.message }); }
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
    var logBlob = new Blob([msg.text], { type: 'text/plain;charset=utf-8' }), logA = document.createElement('a');
    logA.href = URL.createObjectURL(logBlob);
    logA.download = msg.filename;
    document.body.appendChild(logA);
    logA.click();
    setTimeout(() => { document.body.removeChild(logA); URL.revokeObjectURL(logA.href); }, 300);
    send({ success: true });
    return;
  }

  if (msg.action === 'apply_translation') {
    var grpId = msg.groupId;
    if (grpId === undefined || grpId === null) return;
    var inf = _iF[grpId];
    if (!inf) return;
    if (inf.gen !== _flushGen || tMode === 'off') {
      delete _iF[grpId];
      return;
    }
    if (!msg.translation) return;

    var partialPairs = _applyTr(inf.batch, msg.translation, inf.isSolo);
    inf.applied += partialPairs.length;

    if (inf.applied >= inf.total) {
      var elapsed = performance.now() - inf.t0;
      _dbg('batch_done', { seq: inf.seq, count: inf.applied, elapsed: elapsed, engine: 'dual' });
      diag.translated += inf.applied;
      _iA += inf.applied;
      delete _iF[grpId];
    }
    return;
  }

});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.excludedDomains) {
    _excludedDomains = changes.excludedDomains.newValue || [];
    const host = window.location.hostname || '';
    if (_isDomainExcluded(host) && tMode !== 'off') {
      _stopAndRestore();
    }
    return;
  }

  if (area !== 'sync' || !changes.autoTranslate) return;

  if (changes.autoTranslate.newValue === false && tMode === 'auto') {
    _stopAndRestore();
  } else if (changes.autoTranslate.newValue === true && tMode === 'off') {
    var host = window.location.hostname || '';
    if (_isDomainExcluded(host)) return;
    if (typeof isPageSimplifiedChinese === 'function' && isPageSimplifiedChinese()) return;
    translatePage('auto').catch(e => ERR('autoTranslate re-enable fails:', e?.message));
  }
});

// SPA 导航检测
if (isAlive()) {
  try {
    var keepAlivePort = chrome.runtime.connect({ name: 'keepAlive' });
    keepAlivePort.onDisconnect.addListener(() => { chrome.runtime.lastError; if (!isAlive()) _handleExtensionGone(); });
  } catch (_) { }
}

var spaDebounce = null, lastSpaUrl = location.href;

function onSpaNavigate() {
    if (location.href === lastSpaUrl) return;
    lastSpaUrl = location.href;
        LOG_DOM('SPA 导航检测 ' + lastSpaUrl);

    var prevMode = tMode;
    if (prevMode === 'off') return;

    _flushGen++;
    _iF = {};
    _iA = 0;
    clearPendingWork();
    stopObserver();
    origTextMap = new WeakMap();
    origAttrMap = new WeakMap();
    translatedAttrs = new WeakMap();
    seenText.clear();
    _oS = new WeakSet();
    notifyTranslatedState(false);

    if (prevMode === 'auto') {
      var newDomain = location.hostname || '';
      if (_isDomainExcluded(newDomain)) {
            LOG_STATE('SPA：域名已排除，跳过', newDomain);
        return;
      }
      if (typeof isPageSimplifiedChinese === 'function' && isPageSimplifiedChinese()) {
            LOG_STATE('SPA：页面为简体中文，跳过翻译');
        return;
      }
      translatePage('auto', true).catch(e => ERR('SPA translatePage fails:', e?.message));
    }
  }

  function handleSpaUrlChange() {
    if (spaDebounce) clearTimeout(spaDebounce);
    spaDebounce = setTimeout(onSpaNavigate, 100);
  }

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

  window.addEventListener('popstate', handleSpaUrlChange);
  window.addEventListener('hashchange', handleSpaUrlChange);

(async function init() {

  LOG('content.js 初始化开始..');

  if (!document.body) {
    LOG('等待 document.body...');
    await new Promise(r => {
      window.addEventListener('load', r, { once: true });
    });
  }

  const domain = window.location.hostname || '';

  const settings = await new Promise(r =>
    chrome.storage.local.get(['excludedDomains'], r)
  );

  let excludedDomains = _excludedDomains;
  if (settings.excludedDomains && Array.isArray(settings.excludedDomains)) {
    excludedDomains = settings.excludedDomains;
    _excludedDomains = settings.excludedDomains;
  }

  const autoSettings = await new Promise(r =>
    chrome.storage.sync.get(['autoTranslate'], r)
  );
  settings.autoTranslate = autoSettings.autoTranslate;

  LOG('排除域名列表:', excludedDomains);

  if (_isDomainExcluded(domain)) {
    LOG_STATE('域名已排除，跳过:', domain);
    return;
  }

  if (isPageSimplifiedChinese()) {
    LOG_STATE('页面为简体中文，跳过翻译');
    return;
  }

  LOG('autoTranslate 设置:', settings.autoTranslate);

  if (settings.autoTranslate === false) {
    LOG_STATE('自动翻译已关闭，跳过');
    return;
  }

  translatePage('auto').catch(e => ERR('init translatePage fails:', e?.message));
  LOG('初始化完成');

})()
