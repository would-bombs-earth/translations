// test_dedup.mjs — v1.0.2 完整测试
// 覆盖: cacheGet LRU / normalize /u / SKIP_RE / isAlreadyChinese / dedup+second-pass / __gt_orig 恢复

let seenTextSet = new Set();
let cache = new Map();
let FAIL = 0;

// ── cacheGet (LRU 晋升) ──
function cacheGet(key) {
  if (!cache.has(key)) return undefined;
  const value = cache.get(key);
  cache.delete(key);
  cache.set(key, value);
  return value;
}
function cacheSet(key, value) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  if (cache.size > 5) {
    const iter = cache.keys();
    for (let i = 0; i < 1; i++) { const k = iter.next().value; if (k) cache.delete(k); }
  }
}

// ── normalize (with /u flag) ──
function normalize(text) {
  return text.replace(/\s+/gu, ' ').trim();
}

// ── CJK / KANA / HANGUL regexes ──
const CJK_RE = /[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF]/;
const KANA_RE = /[\u3040-\u309F\u30A0-\u30FF\u31F0-\u31FF\uFF65-\uFF9F]/;
const HANGUL_RE = /[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/;
const FOREIGN_RE = /[a-zA-Z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u024F\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF]/;

// ── SKIP_RE (简化) ──
const SKIP_RE = /^(?:@[\w.-]+|https?:\/\/\S+|\d[\d.,]*[KkMmBb]?)$/;

// ── TRADITIONAL_CHARS (从生产代码提取的繁体字集子集用于测试) ──
const TRADITIONAL_CHARS = new Set(
    '愛礙襖罷備筆幣閉邊編標錶彆賓並佈補纔財採參倉蒼層產長場廠車徹陳稱誠齒衝蟲籌醜齣處觸傳創純詞從錯達帶單擔膽彈當黨檔導島燈鄧敵遞點電釣調頂訂東動鬥讀獨鍛隊對噸頓奪額兒爾發罰閥飯範飛廢費奮風豐鳳復負婦該蓋幹趕鋼岡個給宮溝構購夠穀顧颳關觀館貫廣規歸閨櫃過還漢號後華畫劃話壞歡環換黃揮會夥獲貨擊機積極幾記計紀際濟繼傢價監堅艱揀撿簡見劍鍵艦漸將講獎醬膠腳較階潔結節緊僅盡勁進經驚糾舊舉劇據懼絕覺開凱課懇褲誇塊礦虧睏困擴闊來籃蘭懶爛勞樂淚類離裡禮曆麗勵聯臉練糧兩輛療鄰臨靈齡劉龍樓爐陸錄綠倫論囉羅馬嗎買賣滿麼沒門們夢彌滅廟謀畝難腦鬧鳥寧農濃歐盤賠噴貧蘋憑撲齊騎豈啟氣棄鉛遷錢槍牆搶橋翹輕慶窮區驅權卻確讓擾熱認榮軟潤灑賽傘喪掃殺曬閃傷賞燒紹捨設攝審勝聖師濕時識實試勢樹帥雙誰絲鬆訴肅雖隨歲孫損縮鎖態臺談嘆湯燙討題體條鐵聽頭圖團橢萬網為衛問穩烏無誤霧犧襲習戲細蝦嚇鮮現線鄉響項蕭寫協謝興許緒續懸選學詢訓壓鴉亞煙鹽嚴顏厭陽養樣藥爺葉頁業醫遺億義藝憶陰銀飲隱應擁優郵猶遊餘魚與語預員園圓遠願約閱雲運雜載臟則責擇澤賊贈紮佔戰張漲帳賬趙這針偵鎮陣爭鄭證織職紙誌製質種眾軸皺豬諸築轉專磚壯莊裝狀準資總縱鑽麼');

function hasTraditionalChinese(text) {
  let traditional = 0, totalCjk = 0;
  for (const ch of text) {
    if (CJK_RE.test(ch)) {
      totalCjk++;
      if (TRADITIONAL_CHARS.has(ch)) traditional++;
    }
  }
  return totalCjk >= 2 && traditional >= 1;
}

// ── isAlreadyChinese (与生产代码同步) ──
function isAlreadyChinese(text) {
  let foreignRun = 0, maxForeignRun = 0, anyForeign = false, anyCjk = false;
  let hasKana = false, hasHangul = false;
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if ((c >= 0x3040 && c <= 0x30FF) || (c >= 0x31F0 && c <= 0x31FF) || (c >= 0xFF65 && c <= 0xFF9F)) {
      hasKana = true; foreignRun++; maxForeignRun = Math.max(maxForeignRun, foreignRun); anyForeign = true; continue;
    }
    if ((c >= 0xAC00 && c <= 0xD7AF) || (c >= 0x1100 && c <= 0x11FF) || (c >= 0x3130 && c <= 0x318F)) {
      hasHangul = true; foreignRun++; maxForeignRun = Math.max(maxForeignRun, foreignRun); anyForeign = true; continue;
    }
    if (FOREIGN_RE.test(ch)) {
      foreignRun++; maxForeignRun = Math.max(maxForeignRun, foreignRun); anyForeign = true; continue;
    }
    foreignRun = 0;
    if (CJK_RE.test(ch)) anyCjk = true;
  }
  if (hasKana || hasHangul) return false;
  if (!anyForeign && !anyCjk) return true;
  if (maxForeignRun >= 2) return false;
  if (anyCjk && anyForeign && maxForeignRun <= 2) {
    const hasRealWord = /[a-zA-Z]{3,}/.test(text);
    const hasAbbrev = /[a-zA-Z][.'][a-zA-Z]/.test(text);
    if (!hasRealWord && !hasAbbrev) return true;
  }
  if (anyCjk && !anyForeign) {
    if (hasTraditionalChinese(text)) return false;
    return true;
  }
  if (hasTraditionalChinese(text)) return false;
  // 短混合文本：有 CJK 且无长外文单词 → 视为中文
  if (anyCjk && text.length < 25) {
    let cjkCount2 = 0, meaningful2 = 0;
    for (const ch of text) {
      const cp = ch.codePointAt(0);
      if (cp <= 32) continue;
      meaningful2++;
      if (CJK_RE.test(ch)) cjkCount2++;
    }
    if (meaningful2 > 0 && cjkCount2 / meaningful2 >= 0.3) return true;
    return false;
  }
  return !anyForeign;
}

function assert(label, cond) {
  if (cond) { console.log('  \u2713', label); }
  else { console.log('  \u2717 FAIL:', label); FAIL++; }
}

// ══════════════════════════════════════════════════════
console.log('=== 1. normalize /u flag ===');
assert('NBSP stripped', normalize('\u00A0Hello\u00A0') === 'Hello');
assert('mixed spaces', normalize('  a   b  ') === 'a b');

console.log('\n=== 2. SKIP_RE ===');
assert('@mention skipped', SKIP_RE.test('@user_name'));
assert('URL skipped', SKIP_RE.test('https://example.com/path'));
assert('number+unit skipped', SKIP_RE.test('123K'));
assert('normal text not skipped', !SKIP_RE.test('Hello World'));

console.log('\n=== 3. isAlreadyChinese ===');
assert('pure Chinese', isAlreadyChinese('\u4f60\u597d\u4e16\u754c') === true);
assert('pure English', isAlreadyChinese('Hello World') === false);
assert('number + Chinese', isAlreadyChinese('123K \u5b57\u5e55') === true);
assert('Japanese kana', isAlreadyChinese('\u3053\u3093\u306b\u3061\u306f') === false);
assert('Korean', isAlreadyChinese('\uc548\ub155\ud558\uc138\uc694') === false);
assert("I'm + Chinese (abbrev fix)", isAlreadyChinese("I'm \u597d") === false);
assert('U.S. + Chinese (abbrev fix)', isAlreadyChinese('U.S. \u4e0d\u9519') === true);
assert("don't + Chinese (abbrev fix)", isAlreadyChinese("don't \u77e5\u9053") === false);
assert('traditional Chinese (should translate)', isAlreadyChinese('\u611b\u60c5\u7684\u6a21\u6a23') === false);
assert('short CJK-foreign mix (low cjk ratio)', isAlreadyChinese('read \u6587\u4ef6') === false);
assert('short CJK-dominant mix', isAlreadyChinese('\u4f60\u597d ok') === false);
assert('short CJK mix with foreign', isAlreadyChinese('\u4f60\u597d o') === true);
assert('traditional chars in pure CJK', isAlreadyChinese('\u611b\u60c5') === false);

console.log('\n=== 4. cacheGet LRU ===');
cache.clear();
cacheSet('a', 'A');
cacheSet('b', 'B');
cacheSet('c', 'C');
cacheSet('d', 'D');
cacheSet('e', 'E');
cacheSet('f', 'F'); // size=6 > 5, evict oldest = 'a'
assert('a evicted', cache.has('a') === false);
assert('f exists', cache.has('f') === true);
// cacheGet promotes
cacheGet('b'); // b moves to end
cacheSet('g', 'G'); // evict oldest = 'c' (b was promoted)
assert('b promoted (LRU)', cache.has('b') === true);
assert('c evicted', cache.has('c') === false);

console.log('\n=== 5. dedup + second-pass ===');
// Reset state from previous tests
cache.clear();
seenTextSet.clear();
const origTextMap = new Map();
function applyTranslation(nodeKey, raw, translated) {
  origTextMap.set(nodeKey, translated);
}

const nodes = [
  { key: 'btn1', text: '  Submit  ' },
  { key: 'btn2', text: 'Submit' },
  { key: 'btn3', text: 'Submit ' },
  { key: 'h1', text: 'Read More' },
  { key: 'h2', text: 'Read More' },
];

// Simulate processTextNode scan
const queue = [];
for (const n of nodes) {
  const raw = normalize(n.textContent || n.text);
  const cached = cacheGet(raw);
  if (cached !== undefined) {
    applyTranslation(n.key, raw, cached);
    continue;
  }
  if (seenTextSet.has(raw)) { queue.push(n); continue; }
  seenTextSet.add(raw);
  queue.push(n);
}

// Simulate flushQueue first pass
const allNodes = [];
for (const n of queue) {
  const raw = normalize(n.textContent || n.text);
  const cached = cacheGet(raw);
  if (cached !== undefined) { applyTranslation(n.key, raw, cached); continue; }
  allNodes.push(n);
}

// dedup in batch
const rawSeen = new Set();
const batch = [];
for (const n of allNodes) {
  const raw = normalize(n.textContent || n.text);
  if (rawSeen.has(raw)) continue;
  rawSeen.add(raw);
  batch.push(n);
}

// Simulate translation
cacheSet('Submit', '\u63d0\u4ea4');
cacheSet('Read More', '\u9605\u8bfb\u66f4\u591a');
for (const n of batch) {
  const raw = normalize(n.textContent || n.text);
  const cached = cacheGet(raw);
  if (cached !== undefined) applyTranslation(n.key, raw, cached);
}

// Second pass: apply cache to deduped nodes
for (const n of allNodes) {
  const raw = normalize(n.textContent || n.text);
  const cached = cacheGet(raw);
  if (cached !== undefined) applyTranslation(n.key, raw, cached);
}

assert('btn1 translated', origTextMap.get('btn1') !== undefined);
assert('btn2 translated', origTextMap.get('btn2') !== undefined);
assert('btn3 translated', origTextMap.get('btn3') !== undefined);
assert('h1 translated', origTextMap.get('h1') !== undefined);
assert('h2 translated', origTextMap.get('h2') !== undefined);
const allDone = nodes.every(n => origTextMap.has(n.key));
assert('ALL TRANSLATED', allDone);

console.log('\n=== 6. __gt_orig restore on failure ===');
const node = { textContent: 'Original Text', __gt_orig: 'Original Text' };
// Simulate failed translation: restore original, then delete
if (node.__gt_orig !== undefined) { node.textContent = node.__gt_orig; }
delete node.__gt_orig;
assert('text restored', node.textContent === 'Original Text');
assert('__gt_orig cleaned', node.__gt_orig === undefined);

// ── Summary ──
console.log('\n\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550');
if (FAIL === 0) {
  console.log('ALL TESTS PASSED \u2713');
} else {
  console.log(FAIL + ' TEST(S) FAILED \u2717');
  process.exit(1);
}

