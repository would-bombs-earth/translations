
// content.js

// manual flush promise (Fix 1+6: real count from translatePage)

var _flR = [], _flushGen = 0, _iF = {}, _iA = 0, _skipInc = false;
var _selPopup = null, _selOutsideHandler = null;
var _selCache = new Map();
var _SEL_CACHE_MAX = 50;
var _selSeq = 0;

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

    if (attr === 'value' && el.tagName !== 'INPUT') continue;
    if (attr === 'value' && !isButtonInput(el)) continue;

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
  if (!node.parentElement.__gtSafe && isSkippable(node.parentElement)) return;
  if (isSvgMeta(node.parentElement)) return;

  diag.scanned++;
  const raw = node.textContent;
  if (!raw) return;

  const text = normalize(raw);
  const len = text.length;
  if (len < 2) { diag.tooShort++; return; }
  
  // Early exit for short punctuation/symbol strings
  if (len < 5 && /^[\p{P}\p{S}\s]+$/u.test(text)) { diag.tooShort++; return; }

  // Skip @mentions, URLs, pure numbers/symbols and Chinese UI patterns
  if (SKIP_COMBINED_RE.test(text)) { diag.skipRe++; return; }

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

  if (isAlreadyChinese(text, node)) { diag.alreadyChinese++; return; }

  if (text.includes("Director of National Intelligence") || text.includes("USG/DoD")) {
    console.log("[GT Debug] Found Tulsi bio:", text, "Length:", len);
    console.log("[GT Debug] isAlreadyChinese:", isAlreadyChinese(text, node));
    console.log("[GT Debug] SKIP_RE:", SKIP_RE.test(text), "SKIP_COMBINED_RE:", SKIP_COMBINED_RE.test(text));
    console.log("[GT Debug] node parent classes:", node.parentElement ? node.parentElement.className : "null");
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
  if (!_skipInc) dispatchIncremental();
  
  _dbg('detect', { text });
}

function dispatchIncremental() {
  if (tMode === 'off' || !isAlive() || translating) return;
  if (queue.size < INCREMENTAL_THRESHOLD) return;

  var snapshot = [], iter = queue.values(), count = 0, next;
  while (count < BATCH_SIZE && !(next = iter.next()).done) {
    snapshot.push(next.value);
    count++;
  }
  for (var di = 0; di < snapshot.length; di++) queue.delete(snapshot[di]);
  var nodes = snapshot;
  if (nodes.length === 0) return;

  var processed = [];
  _muteDepth++;
  try { processed = nodes.filter(n => n?.parentElement && n.__gtRaw); } finally { _muteDepth--; }

  if (processed.length === 0) return;

  var batches = buildBatches(processed);
  batches.forEach(b => translateBatch(b));
}

function scanInitial() {
  if (tMode === 'auto') {
    _pageLangZH = typeof isPageSimplifiedChinese === 'function' ? isPageSimplifiedChinese() : false;
  }
  if (tMode === 'off') return;

  const doScan = function () {
    if (tMode === 'off') return;
    _skipInc = true;
    var titleEl = document.querySelector('title');
    if (titleEl && titleEl.firstChild && titleEl.firstChild.nodeType === Node.TEXT_NODE) processTextNode(titleEl.firstChild);
    if (document.body) {
      enqueueNode(document.body);
      const attrSelector = TRANSLATABLE_ATTRS.map(a => '[' + a + ']').join(',');
      var els = querySelectorAllDeep(document.body, attrSelector);
      els.forEach(el => processElementAttrs(el));
    }
    scheduleFlush();
    _skipInc = false;
  };

  setTimeout(doScan, 0);
}

// Shared mutation handler used for both main DOM and shadow-root observers
function onMutation(mutations) {
  if (tMode === 'off') return;
  if (_muteDepth > 0) { _missedMutations = true; return; }
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
    attributeFilter: ['title', 'alt', 'placeholder', 'aria-label', 'aria-description', 'aria-roledescription', 'aria-valuetext', 'label', 'value']
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
  
  if (window.__gt_api_error_pause && Date.now() < window.__gt_api_error_pause) {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      if (isAlive() && tMode !== 'off') flushQueue();
    }, window.__gt_api_error_pause - Date.now());
    return;
  }

  if (tMode === 'manual') { flushQueue(); return; }
  flushTimer = setTimeout(() => {
    flushTimer = null;
    if (isAlive() && tMode !== 'off') flushQueue();
  }, FLUSH_MS);
}

function clearPendingWork() {
  queue.clear();
  _pendingWrites.length = 0;
  _rafScheduled = false;
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
    sl = detectSourceLang(text);
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
    
    // Add nodes back to queue so they get retried
    batch.forEach(item => {
      if (item.node && item.node.isConnected) queue.add(item.node);
    });
    // Add a pause to prevent tight loops on persistent errors
    window.__gt_api_error_pause = Date.now() + 3000;
    
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

var _pendingWrites = [];
var _rafScheduled = false;

function _flushWrites() {
  _rafScheduled = false;
  if (_pendingWrites.length === 0) return;
  _muteDepth++;
  const t0 = performance.now();
  var i = 0;
  try {
    for (; i < _pendingWrites.length; i++) {
      var w = _pendingWrites[i];
      if (w.isAttr) {
        w.node.__el.setAttribute(w.node.__attr, w.text);
      } else {
        w.node.textContent = w.text;
      }
      if ((i & 31) === 31 && performance.now() - t0 > 10) {
        i++;
        break;
      }
    }
  } finally {
    _muteDepth--;
    if (i < _pendingWrites.length) {
      _pendingWrites = _pendingWrites.slice(i);
      _rafScheduled = true;
      requestAnimationFrame(_flushWrites);
    } else {
      _pendingWrites.length = 0;
    }
  }
}

function _scheduleWrite(node, text, raw, isAttr) {
  if (tMode === 'manual') {
    _muteDepth++;
    try {
      if (isAttr) {
        node.__el.setAttribute(node.__attr, text);
      } else {
        node.textContent = text;
      }
    } finally {
      _muteDepth--;
    }
  } else {
    _pendingWrites.push({ node: node, text: text, isAttr: isAttr });
    if (!_rafScheduled) {
      _rafScheduled = true;
      requestAnimationFrame(_flushWrites);
    }
  }
}

function applyTranslation(node, raw, translated) {
  // Handle attribute wrapper objects
  if (node.__isAttr) {
    const el = node.__el, attr = node.__attr;
    if (!el.isConnected) return;
    const cleanAttrVal = cleanTranslation(translated);
    if (!cleanAttrVal || cleanAttrVal === raw) return;
    // Store original attr value for restore (only first time)
    if (!el.__gt_orig_attrs) el.__gt_orig_attrs = {};
    if (!(attr in el.__gt_orig_attrs)) el.__gt_orig_attrs[attr] = raw;
    // Track in WeakMap for dedup
    if (!origAttrMap.has(el)) origAttrMap.set(el, new Map());
    origAttrMap.get(el).set(attr, raw);
    // Mark as translated to prevent observer feedback loop
    if (!translatedAttrs.has(el)) translatedAttrs.set(el, new Map());
    translatedAttrs.get(el).set(attr, { raw: raw, translated: cleanAttrVal });
    
    // Notify MAIN world interceptor
    el.dispatchEvent(new CustomEvent('gt-orig-attr', { detail: { attr: attr, value: raw } }));

    _scheduleWrite(node, cleanAttrVal, raw, true);
    return;
  }

  // Normal text node 鈥?check if still in DOM
  if (node.parentElement && node.isConnected) {
    const translatedText = cleanTranslation(translated);
    if (!translatedText) return;
    
    // raw is already normalized by caller (processTextNode or flushQueue)
    if (translatedText === raw) return;
    
    if (node.__gt_orig === undefined) {
      node.__gt_orig = node.textContent;
    }
    origTextMap.set(node, { raw: raw, translated: translatedText });
    
    // Notify MAIN world interceptor
    node.dispatchEvent(new CustomEvent('gt-orig-text', { detail: node.__gt_orig }));

    _scheduleWrite(node, translatedText, raw, false);
    return;
  }
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

        const raw = node.__gtRaw || normalize(node.textContent);
        if (!raw) continue;

        node.__gtRaw = raw;
        // Also capture the restore target NOW, before the page can modify it.
        // applyTranslation itself won't overwrite this unless unregisterTextRestore
        // cleared it first (which means the node's content changed externally).
        if (node.__gt_orig === undefined) node.__gt_orig = node.textContent;

        var cachedNode = cacheGet(raw);
        if (cachedNode !== undefined) {
          diag.cached++;
          applyTranslation(node, raw, cachedNode);
          if (cachedNode !== raw) translatedCount++;
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
      while (true) {
        if (tMode === 'off') return;
        const i = index++;
        if (i >= batches.length) break;
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
            try {
              el.setAttribute(attr, el.__gt_orig_attrs[attr]);
              delete el.__gt_orig_attrs[attr];
            } finally {
              _muteDepth--;
            }
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
  if (typeof clearCleanCache === 'function') clearCleanCache();
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
  // restorePage() internally sets tMode='off', clears work, and stops observer,
  // so we only need to call restorePage() directly to avoid redundant double-execution.
  restorePage();
  notifyTranslatedState(false);
}

function _handleExtensionGone() {
  if (tMode === 'off') return;
  LOG_API('扩展上下文失效，停止翻译并恢复页面');
  _stopAndRestore();
}

async function translatePage(mode) {
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

  scanInitial();
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
        // if (isPageSimplifiedChinese()) { LOG_STATE('手动翻译：页面为简体中文，跳过'); send({ success: true, count: 0, reason: 'already_chinese' }); return; }
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

  if (msg.action === 'export_translations') {
    var pairs = [];
    _muteDepth++;
    try {
      var textNodes = [], elements = [];
      _coll(document.body, textNodes, elements);
      textNodes.forEach(function (node) {
        if (origTextMap.has(node)) {
          var entry = origTextMap.get(node);
          pairs.push({ raw: entry.raw, translated: entry.translated });
        }
      });
      elements.forEach(function (el) {
        if (el.__gt_orig_attrs) {
          Object.keys(el.__gt_orig_attrs).forEach(function (attr) {
            var origVal = el.__gt_orig_attrs[attr];
            var curVal = el.getAttribute(attr);
            if (origVal && curVal && origVal !== curVal) {
              pairs.push({ raw: origVal, translated: curVal });
            }
          });
        }
      });
    } finally {
      _muteDepth--;
    }
    send({ success: true, pairs: pairs });
    return true;
  }

});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.excludedDomains) {
    const oldList = changes.excludedDomains.oldValue || [];
    const newList = changes.excludedDomains.newValue || [];
    _excludedDomains = newList;
    const host = window.location.hostname || '';
    const h = host.replace(/^www\./, '');
    const wasExcluded = oldList.some(function (d) { return d === host || d.replace(/^www\./, '') === h; });
    const isExcluded = _isDomainExcluded(host);
    if (isExcluded) {
      closeSelPopup();
      if (tMode !== 'off') _stopAndRestore();
    } else if (wasExcluded && !isExcluded && tMode === 'off') {
      chrome.storage.sync.get(['autoTranslate'], function (r) {
        if (r.autoTranslate !== false) {
          // if (typeof isPageSimplifiedChinese === 'function' && isPageSimplifiedChinese()) return;
          translatePage('auto').catch(function (e) { ERR('exclusion removal re-enable fails:', e?.message); });
        }
      });
    }
    return;
  }

  if (area !== 'sync' || !changes.autoTranslate) return;

  if (changes.autoTranslate.newValue === false && tMode === 'auto') {
    _stopAndRestore();
  } else if (changes.autoTranslate.newValue === true && tMode === 'off') {
    var host = window.location.hostname || '';
    if (_isDomainExcluded(host)) return;
    // if (typeof isPageSimplifiedChinese === 'function' && isPageSimplifiedChinese()) return;
    translatePage('auto').catch(e => ERR('autoTranslate re-enable fails:', e?.message));
  }
});

// ── 划词翻译（排除域名 / 自动翻译关闭时生效）──

var _selPopupDragHandler = null;
var _selPopupMoveHandler = null;
var _selPopupUpHandler = null;

function closeSelPopup() {
  if (_selPopup) {
    _selPopup.remove();
    _selPopup = null;
  }
  if (_selOutsideHandler) {
    document.removeEventListener('mousedown', _selOutsideHandler);
    _selOutsideHandler = null;
  }
  if (_selPopupMoveHandler) {
    document.removeEventListener('mousemove', _selPopupMoveHandler);
    _selPopupMoveHandler = null;
  }
  if (_selPopupUpHandler) {
    document.removeEventListener('mouseup', _selPopupUpHandler);
    _selPopupUpHandler = null;
  }
}

var _POS_LABEL = { noun: '名词', verb: '动词', adjective: '形容词', adverb: '副词', preposition: '介词', conjunction: '连词', pronoun: '代词', interjection: '感叹词', article: '冠词' };
var _POS_COLORS = {
  noun: { bg: 'rgba(59,130,246,0.15)', text: '#93c5fd' },
  verb: { bg: 'rgba(16,185,129,0.15)', text: '#6ee7b7' },
  adjective: { bg: 'rgba(245,158,11,0.15)', text: '#fcd34d' },
  adverb: { bg: 'rgba(139,92,246,0.15)', text: '#c4b5fd' },
  preposition: { bg: 'rgba(236,72,153,0.15)', text: '#f9a8d4' },
  conjunction: { bg: 'rgba(6,182,212,0.15)', text: '#67e8f9' },
  pronoun: { bg: 'rgba(20,184,166,0.15)', text: '#5eead4' },
  interjection: { bg: 'rgba(239,68,68,0.15)', text: '#fca5a5' },
  article: { bg: 'rgba(156,163,175,0.15)', text: '#d1d5db' },
};

function showSelPopup(rawText, transText, dictData) {
  if (_selPopup) {
    var oldBod = _selPopup.querySelector('.__gt_bod');
    if (oldBod) {
      oldBod.textContent = transText;
      oldBod.style.color = transText === '翻译中...' ? 'rgba(255,255,255,0.4)' :
        transText.indexOf('翻译失败') === 0 ? '#f87171' : '#00ff41';
      oldBod.style.textShadow = (transText === '翻译中...' || transText.indexOf('翻译失败') === 0) ? 'none' : '0 0 8px rgba(0,255,65,0.4)';
    }
    var oldSrc = _selPopup.querySelector('.__gt_src');
    if (oldSrc) oldSrc.textContent = rawText;
    var oldPos = _selPopup.querySelector('.__gt_pos');
    if (oldPos) {
      if (dictData && Array.isArray(dictData) && dictData.length > 0) {
        oldPos.style.display = '';
        oldPos.innerHTML = '';
        for (var pi = 0; pi < dictData.length; pi++) {
          var entry = dictData[pi];
          if (!entry || !entry.pos || !entry.meanings) continue;
          var pr = document.createElement('div');
          pr.style.cssText = 'display:flex;align-items:baseline;gap:8px;margin-top:6px;';
          var colors = _POS_COLORS[entry.pos] || { bg: 'rgba(255,255,255,0.08)', text: 'rgba(255,255,255,0.6)' };
          var pt = document.createElement('span');
          pt.style.cssText =
            'display:inline-block;background:' + colors.bg + ';' +
            'color:' + colors.text + ';' +
            'border-radius:5px;padding:1px 8px;' +
            'font-size:11px;font-weight:500;white-space:nowrap;';
          pt.textContent = _POS_LABEL[entry.pos] || entry.pos;
          pr.appendChild(pt);
          var pm = document.createElement('span');
          pm.style.cssText = 'color:rgba(255,255,255,0.65);font-size:13px;line-height:1.4;';
          pm.textContent = entry.meanings.join('、');
          pr.appendChild(pm);
          oldPos.appendChild(pr);
        }
      } else {
        oldPos.style.display = 'none';
      }
    }
    return;
  }

  var sel = window.getSelection();
  if (!sel || !sel.rangeCount) return;
  var rect = sel.getRangeAt(0).getBoundingClientRect();

  var popup = document.createElement('div');
  _selPopup = popup;

  var isError = transText.indexOf('翻译失败') === 0;
  var isLoading = transText === '翻译中...';

  popup.style.cssText =
    'position:fixed;z-index:2147483646;' +
    'background:rgba(22,22,30,0.96);' +
    'backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);' +
    'border:1px solid rgba(255,255,255,0.06);' +
    'border-radius:16px;padding:16px;' +
    'min-width:180px;max-width:420px;' +
    'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Noto Sans SC",sans-serif;' +
    'font-size:13px;line-height:1.5;' +
    'color:#e0e0ea;' +
    'box-shadow:0 12px 48px rgba(0,0,0,0.5);' +
    'overflow:hidden;pointer-events:auto;opacity:0;' +
    'transform:scale(0.94);' +
    'transition:opacity 0.15s ease-out,transform 0.15s ease-out;';

  // Close button — top-right floating
  var cls = document.createElement('span');
  cls.textContent = '✕';
  cls.style.cssText =
    'position:absolute;top:11px;right:14px;cursor:pointer;' +
    'opacity:0.25;font-size:14px;line-height:1;color:rgba(255,255,255,0.5);' +
    'transition:opacity 0.15s;user-select:none;z-index:1;';
  cls.onmouseenter = function () { cls.style.opacity = '0.7'; };
  cls.onmouseleave = function () { cls.style.opacity = '0.25'; };
  cls.onclick = closeSelPopup;
  popup.appendChild(cls);

  // Source text (original) — top, small, italic
  var src = document.createElement('div');
  src.className = '__gt_src';
  src.style.cssText =
    'font-size:11px;line-height:1.4;color:rgba(255,255,255,0.3);' +
    'font-style:italic;margin-bottom:8px;padding-right:20px;word-break:break-word;';
  src.textContent = rawText;
  popup.appendChild(src);

  // Translation body — hero
  var bod = document.createElement('div');
  bod.className = '__gt_bod';
  bod.style.cssText =
    'font-size:15px;font-weight:500;line-height:1.5;' +
    'word-break:break-word;white-space:pre-wrap;' +
    'color:' + (isError ? '#f87171' : isLoading ? 'rgba(255,255,255,0.4)' : '#00ff41') + ';' +
    ((!isError && !isLoading) ? 'text-shadow:0 0 8px rgba(0,255,65,0.4);' : '');
  bod.textContent = transText;
  popup.appendChild(bod);

  // POS entries — colored pills
  var posWrap = document.createElement('div');
  posWrap.className = '__gt_pos';
  posWrap.style.cssText = 'margin-top:10px;';
  if (dictData && Array.isArray(dictData) && dictData.length > 0) {
    for (var pi = 0; pi < dictData.length; pi++) {
      var entry = dictData[pi];
      if (!entry || !entry.pos || !entry.meanings) continue;
      var pr = document.createElement('div');
      pr.style.cssText = 'display:flex;align-items:baseline;gap:8px;margin-top:6px;';
      var colors = _POS_COLORS[entry.pos] || { bg: 'rgba(255,255,255,0.08)', text: 'rgba(255,255,255,0.6)' };
      var pt = document.createElement('span');
      pt.style.cssText =
        'display:inline-block;background:' + colors.bg + ';' +
        'color:' + colors.text + ';' +
        'border-radius:5px;padding:1px 8px;' +
        'font-size:11px;font-weight:500;white-space:nowrap;';
      pt.textContent = _POS_LABEL[entry.pos] || entry.pos;
      pr.appendChild(pt);
      var pm = document.createElement('span');
      pm.style.cssText = 'color:rgba(255,255,255,0.65);font-size:13px;line-height:1.4;';
      pm.textContent = entry.meanings.join('、');
      pr.appendChild(pm);
      posWrap.appendChild(pr);
    }
  } else {
    posWrap.style.display = 'none';
  }
  popup.appendChild(posWrap);

  // Position — viewport-relative
  var top = rect.bottom + 6;
  var left = rect.left;

  document.body.appendChild(popup);
  requestAnimationFrame(function () {
    popup.style.opacity = '1';
    popup.style.transform = 'scale(1)';
  });

  var pw = popup.offsetWidth, ph = popup.offsetHeight;
  var vw = window.innerWidth, vh = window.innerHeight;

  if (left + pw > vw - 10) left = Math.max(10, vw - pw - 10);
  if (left < 10) left = 10;
  if (top + ph > vh - 10 && rect.top > ph + 16) top = rect.top - ph - 6;
  if (top < 10) top = 10;

  popup.style.left = left + 'px';
  popup.style.top = top + 'px';

  // 增加鼠标拖动支持
  var dragHandle = document.createElement('div');
  dragHandle.style.cssText =
    'position:absolute;top:0;left:0;right:0;height:16px;cursor:move;' +
    'background:transparent;z-index:2;';
  var dragLine = document.createElement('div');
  dragLine.style.cssText =
    'width:32px;height:4px;border-radius:2px;background:rgba(255,255,255,0.15);' +
    'margin:6px auto 0;transition:background 0.2s;';
  dragHandle.onmouseenter = function() { dragLine.style.background = 'rgba(255,255,255,0.3)'; };
  dragHandle.onmouseleave = function() { dragLine.style.background = 'rgba(255,255,255,0.15)'; };
  dragHandle.appendChild(dragLine);
  popup.appendChild(dragHandle);

  var isDragging = false;
  var dragOffsetX = 0, dragOffsetY = 0;

  _selPopupDragHandler = function (e) {
    isDragging = true;
    dragOffsetX = e.clientX - popup.getBoundingClientRect().left;
    dragOffsetY = e.clientY - popup.getBoundingClientRect().top;
    popup.style.transition = 'none';
    e.preventDefault();
  };
  dragHandle.addEventListener('mousedown', _selPopupDragHandler);

  _selPopupMoveHandler = function (e) {
    if (!isDragging) return;
    popup.style.left = (e.clientX - dragOffsetX) + 'px';
    popup.style.top = (e.clientY - dragOffsetY) + 'px';
  };

  _selPopupUpHandler = function (e) {
    if (isDragging) {
      isDragging = false;
      popup.style.transition = 'opacity 0.15s ease-out, transform 0.15s ease-out';
    }
  };

  document.addEventListener('mousemove', _selPopupMoveHandler);
  document.addEventListener('mouseup', _selPopupUpHandler);

  _selOutsideHandler = function (e) {
    if (!popup.contains(e.target)) closeSelPopup();
  };
  // Use mousedown for outside click, but ensure it doesn't trigger immediately during current mousedown
  setTimeout(function () { document.addEventListener('mousedown', _selOutsideHandler); }, 0);
}

function setupSelectionTranslate() {
  document.addEventListener('mouseup', function (e) {
    if (_selPopup && _selPopup.contains(e.target)) return;
    if (tMode !== 'off') return;
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    var text = sel.toString().trim();
    if (!text || text.length < 2 || text.length > 5000) return;

    // Check local caches first
    var selCacheHit = _selCache.get(text);
    if (selCacheHit) { showSelPopup(text, selCacheHit.translation, selCacheHit.dict || null); return; }
    var contentCacheHit = cacheGet(text);
    if (contentCacheHit) { showSelPopup(text, contentCacheHit, null); return; }

    var isWord = /^[a-zA-Z-]+$/.test(text) && text.length < 40;
    showSelPopup(text, '翻译中...');
    var seq = ++_selSeq;
    var msg = isWord
      ? { type: 'translate_word', text: text }
      : { type: 'sel_translate', text: text };
    try {
      chrome.runtime.sendMessage(msg).then(function (r) {
        if (_selSeq !== seq) return;
        if (!isAlive()) { closeSelPopup(); return; }
        if (r && r.translation) {
          showSelPopup(text, r.translation, r.dict || null);
          if (_selCache.size >= _SEL_CACHE_MAX) _selCache.delete(_selCache.keys().next().value);
          _selCache.set(text, { translation: r.translation, dict: r.dict || null });
        } else {
          showSelPopup(text, '翻译失败' + (r && r.error ? ': ' + r.error : ''));
        }
      }).catch(function (err) {
        if (_selSeq !== seq) return;
        if (!isAlive() || String(err).indexOf('Extension context invalidated') !== -1) { closeSelPopup(); return; }
        showSelPopup(text, '翻译失败: ' + (err && err.message ? err.message : String(err)));
      });
    } catch (err) {
      if (_selSeq !== seq) return;
      if (!isAlive() || String(err).indexOf('Extension context invalidated') !== -1) { closeSelPopup(); return; }
      showSelPopup(text, '翻译失败: ' + (err && err.message ? err.message : String(err)));
    }
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeSelPopup();
  });
}

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
    // if (typeof isPageSimplifiedChinese === 'function' && isPageSimplifiedChinese()) {
    //   LOG_STATE('SPA：页面为简体中文，跳过翻译');
    //   return;
    // }
    translatePage('auto').catch(e => ERR('SPA translatePage fails:', e?.message));
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

// ═══════════════════════════════════════════════════════════
// Prefetch queue for "Headless" Translation
// ═══════════════════════════════════════════════════════════
const prefetchQueue = new Set();
let prefetchTimer = null;

window.addEventListener('gt-prefetch-text', (e) => {
  if (tMode === 'off' || !e.detail || !Array.isArray(e.detail)) return;
  e.detail.forEach(s => prefetchQueue.add(s));
  if (!prefetchTimer) {
    prefetchTimer = setTimeout(() => {
      prefetchTimer = null;
      flushPrefetch();
    }, 50);
  }
});

function flushPrefetch() {
  const texts = Array.from(prefetchQueue)
    .map(s => normalize(s))
    .filter(s => {
      if (!s || s.length < 2) return false;
      if (s.length < 5 && /^[\p{P}\p{S}\s]+$/u.test(s)) return false;
      if (SKIP_COMBINED_RE.test(s)) return false;
      if (isAlreadyChinese(s)) return false;
      if (isAsciiNonText(s)) return false;
      if (_isUiBrandName(s)) return false;
      return cacheGet(s) === undefined;
    });
  prefetchQueue.clear();
  if (texts.length === 0) return;

  const batches = [];
  let current = [], chars = 0;
  for (let raw of texts) {
    const id = uid++;
    const payload = `${MARK_L}${id}${MARK_R}${raw}`;
    if (current.length >= BATCH_SIZE || chars + payload.length > BATCH_CHARS) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push({ id, raw, payload });
    chars += payload.length;
  }
  if (current.length) batches.push(current);

  batches.forEach(b => {
    if (!isAlive()) return;
    try {
      chrome.runtime.sendMessage({
        type: 'translate',
        domain: location.hostname,
        text: b.map(x => x.payload).join('\n')
      }, response => {
        if (chrome.runtime.lastError) return;
        if (response && response.translation) {
          const resMap = parseTranslated(response.translation);
          b.forEach(item => {
            if (resMap.has(item.id)) {
              cacheSet(item.raw, resMap.get(item.id));
            }
          });
        }
      });
    } catch (_) {}
  });
}

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
  setupSelectionTranslate();

  if (_isDomainExcluded(domain)) {
    LOG_STATE('域名已排除，跳过:', domain);
    return;
  }

  // if (isPageSimplifiedChinese()) {
  //   LOG_STATE('页面为简体中文，跳过翻译');
  //   return;
  // }

  LOG('autoTranslate 设置:', settings.autoTranslate);

  if (settings.autoTranslate === false) {
    LOG_STATE('自动翻译已关闭，跳过');
    return;
  }

  // Patch cacheSet to bridge translations to MAIN world for pre-render injection
  var _origCacheSet = cacheSet;
  cacheSet = function (key, value) {
    _origCacheSet(key, value);
    try {
      if (typeof key === 'string' && typeof value === 'string' && value !== key) {
        window.dispatchEvent(new CustomEvent('gt-cache-translation', { detail: { raw: key, translated: value } }));
      }
    } catch (e) {}
  };

  _onMuteReleased = function () {
    if (document.body) enqueueNode(document.body);
    scheduleFlush();
  };

  translatePage('auto').catch(e => ERR('init translatePage fails:', e?.message));
  LOG('初始化完成');

})()
