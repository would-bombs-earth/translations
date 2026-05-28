// content-lang.js
// 语言检测 — 正则引擎，零依赖同步执行
// 依赖: content-globals.js (CJK_RE 通过 var 跨文件共享)

// ── 外文脚本正则规则 ──
var FOREIGN_RULES = [
    /[a-zA-ZÀ-ÖØ-öø-ÿĀ-žƀ-ɏ]/,
    /[\u3040-\u309F\u30A0-\u30FF\u31F0-\u31FF\uFF65-\uFF9F]/,
    /[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/,
    /[\u0400-\u04FF\u0500-\u052F]/,
    /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/,
    /[\u0E00-\u0E7F]/,
    /[\u0900-\u097F]/,
    /[\u0980-\u09FF]/,
    /[\u0B80-\u0BFF]/,
    /[\u0370-\u03FF]/,
    /[\u0590-\u05FF]/,
    /[\u10A0-\u10FF]/,
    /[\u1000-\u109F]/,
    /[\u1780-\u17FF]/,
    /[\u0E80-\u0EFF]/,
    /[\u0F00-\u0FFF]/,
    /[\u01A0\u01A1\u01AF\u01B0\u1EA0-\u1EF9]/,
];

var FOREIGN_RE = new RegExp(FOREIGN_RULES.map(function (r) { return r.source; }).join('|'));

// ── CJK 统一表意文字 ──
// 跨文件共享: content.js 的 buildBatches 也需要 CJK_RE
var CJK_RE = /\p{Unified_Ideograph}/u;

// ── 繁体字集（仅在繁体中文中出现，简体中不存在） ──
var TRADITIONAL_CHARS = new Set(
    '\u611B\u7919\u8956\u7F77\u5099\u7B46\u5E63\u9589\u908A\u7DE8\u6A19\u9336\u5F46\u8CD3\u4E26\u4F48\u88DC\u7E94\u8CA1\u63A1\u53C3\u5009\u84BC\u5C64\u7522\u9577\u5834\u5EE0\u8ECA\u5FB9\u9673\u7A31\u8AA0\u9F52\u885D\u87F2\u7C4C\u919C\u9F63\u8655\u89F8\u50B3\u5275\u7D14\u8A5E\u5F9E\u932F\u9054\u5E36\u55AE\u64D4\u81BD\u5F48\u7576\u9EE8\u6A94\u5C0E\u5CF6\u71C8\u9127\u6575\u905E\u9EDE\u96FB\u91E3\u8ABF\u9802\u8A02\u6771\u52D5\u9B25\u8B80\u7368\u935B\u968A\u5C0D\u5678\u9813\u596A\u984D\u5152\u723E\u767C\u7F70\u95A5\u98EF\u7BC4\u98DB\u5EE2\u8CBB\u596E\u98A8\u8C50\u9CF3\u5FA9\u8CA0\u5A66\u8A72\u84CB\u5E79\u8D95\u92FC\u5CA1\u500B\u7D66\u5BAE\u6E9D\u69CB\u8CFC\u5920\u7A40\u9867\u98B3\u95DC\u89C0\u9928\u8CAB\u5EE3\u898F\u6B78\u95A8\u6AC3\u904E\u9084\u6F22\u865F\u5F8C\u83EF\u756B\u5283\u8A71\u58DE\u6B61\u74B0\u63DB\u9EC3\u63EE\u6703\u5925\u7372\u8CA8\u64CA\u6A5F\u7A4D\u6975\u5E7E\u8A18\u8A08\u7D00\u969B\u6FDF\u7E7C\u50A2\u50F9\u76E3\u5805\u8271\u63C0\u64BF\u7C21\u898B\u528D\u9375\u8266\u6F38\u5C07\u8B1B\u734E\u91AC\u81A0\u8173\u8F03\u968E\u6F54\u7D50\u7BC0\u7DCA\u50C5\u76E1\u52C1\u9032\u7D93\u9A5A\u7CFE\u820A\u8209\u5287\u64DA\u61FC\u7D55\u89BA\u958B\u51F1\u8AB2\u61C7\u8932\u8A87\u584A\u7926\u8667\u774F\u56F0\u64F4\u95CA\u4F86\u7C43\u862D\u61F6\u721B\u52DE\u6A02\u6DDA\u985E\u96E2\u88E1\u79AE\u66C6\u9E97\u52F5\u806F\u81C9\u7DF4\u7CE7\u5169\u8F1B\u7642\u9130\u81E8\u9748\u9F61\u5289\u9F8D\u6A13\u7210\u9678\u9304\u7DA0\u502B\u8AD6\u56C9\u7F85\u99AC\u55CE\u8CB7\u8CE3\u6EFF\u9EBC\u6C92\u9580\u5011\u5922\u5F4C\u6EC5\u5EDF\u8B00\u755D\u96E3\u8166\u9B27\u9CE5\u5BE7\u8FB2\u6FC3\u6B50\u76E4\u8CE0\u5674\u8CA7\u860B\u6191\u64B2\u9F4A\u9A0E\u8C48\u555F\u6C23\u68C4\u925B\u9077\u9322\u69CD\u7246\u6436\u6A4B\u7FF9\u8F15\u6176\u7AAE\u5340\u9A45\u6B0A\u537B\u78BA\u8B93\u64FE\u71B1\u8A8D\u69AE\u8EDF\u6F64\u7051\u8CFD\u5098\u55AA\u6383\u6BBA\u66EC\u9583\u50B7\u8CDE\u71D2\u7D39\u6368\u8A2D\u651D\u5BE9\u52DD\u8056\u5E2B\u6FD5\u6642\u8B58\u5BE6\u8A66\u52E2\u6A39\u5E25\u96D9\u8AB0\u7D72\u9B06\u8A34\u8085\u96D6\u96A8\u6B72\u5B6B\u640D\u7E2E\u9396\u614B\u81FA\u8AC7\u5606\u6E6F\u71D9\u8A0E\u984C\u9AD4\u689D\u9435\u807D\u982D\u5716\u5718\u6A62\u842C\u7DB2\u70BA\u885B\u554F\u7A69\u70CF\u7121\u8AA4\u9727\u72A7\u8972\u7FD2\u6232\u7D30\u8766\u5687\u9BAE\u73FE\u7DDA\u9109\u97FF\u9805\u856D\u5BEB\u5354\u8B1D\u8208\u8A31\u7DD2\u7E8C\u61F8\u9078\u5B78\u8A62\u8A13\u58D3\u9D09\u4E9E\u7159\u9E7D\u56B4\u984F\u53AD\u967D\u990A\u6A23\u85E5\u723A\u8449\u9801\u696D\u91AB\u907A\u5104\u7FA9\u85DD\u61B6\u9670\u9280\u98F2\u96B1\u61C9\u64C1\u512A\u90F5\u7336\u904A\u9918\u9B5A\u8207\u8A9E\u9810\u54E1\u5712\u5713\u9060\u9858\u7D04\u95B1\u96F2\u904B\u96DC\u8F09\u81DF\u5247\u8CAC\u64C7\u6FA4\u8CCA\u8D08\u7D2E\u4F54\u6230\u5F35\u6F32\u5E33\u8CEC\u8D99\u9019\u91DD\u5075\u93AE\u9663\u722D\u912D\u8B49\u7E54\u8077\u7D19\u8A8C\u88FD\u8CEA\u7A2E\u773E\u8EF8\u76BA\u8C6C\u8AF8\u7BC9\u8F49\u5C08\u78DA\u58EF\u838A\u88DD\u72C0\u6E96\u8CC7\u7E3D\u7E31\u947D\u9EBC'
);

// ── 检测繁体中文 ──
function hasTraditionalChinese(text) {
    var traditional = 0, totalCjk = 0;
    for (const ch of text) {
        if (CJK_RE.test(ch)) {
            totalCjk++;
            if (TRADITIONAL_CHARS.has(ch)) traditional++;
        }
    }
    return totalCjk >= 2 && traditional >= 1;
}

// ── 判断文本是否已是中文（无需翻译） ──
function isAlreadyChinese(text) {
    var foreignRun = 0, maxForeignRun = 0;
    var hasKana = false, hasHangul = false;
    var anyForeign = false, anyCjk = false;

    for (const ch of text) {
        var c = ch.codePointAt(0);

        // Japanese kana
        if ((c >= 0x3040 && c <= 0x309F) || (c >= 0x30A0 && c <= 0x30FF) ||
            (c >= 0x31F0 && c <= 0x31FF) || (c >= 0xFF65 && c <= 0xFF9F)) {
            hasKana = true;
            foreignRun++;
            if (foreignRun > maxForeignRun) maxForeignRun = foreignRun;
            anyForeign = true;
            continue;
        }

        // Korean Hangul
        if ((c >= 0xAC00 && c <= 0xD7AF) || (c >= 0x1100 && c <= 0x11FF) ||
            (c >= 0x3130 && c <= 0x318F)) {
            hasHangul = true;
            foreignRun++;
            if (foreignRun > maxForeignRun) maxForeignRun = foreignRun;
            anyForeign = true;
            continue;
        }

        if (FOREIGN_RE.test(ch)) {
            foreignRun++;
            if (foreignRun > maxForeignRun) maxForeignRun = foreignRun;
            anyForeign = true;
            continue;
        }

        foreignRun = 0;
        if (CJK_RE.test(ch)) { anyCjk = true; }
    }

    if (hasKana || hasHangul) return false;
    if (!anyForeign && !anyCjk) return true;
    if (maxForeignRun >= 2) return false;

    // 含中文 + 仅数字/单位后缀 → 视为中文 (如 "491K 字幕", "148M 次观看")
    if (anyCjk && anyForeign && maxForeignRun <= 2) {
        // ME-2: 检查是否有真正的英文单词 (2+连续字母) 或缩写
        // 降低阈值从3到2，避免 "pH", "AI" 等短单词被误判为中文
        var hasRealWord = /[a-zA-Z]{2,}/.test(text);
        var hasAbbrev = /[a-zA-Z][.'][a-zA-Z]/.test(text);
        if (!hasRealWord && !hasAbbrev) return true;
    }

    if (anyCjk && !anyForeign) {
        if (hasTraditionalChinese(text)) return false;
        // 页面标注为日/韩语 → 纯 CJK 是汉字/汉谚，非中文，不跳过翻译
        if (_pageLangForeign) return false;
        // 页面明确标注为简体中文 → 纯 CJK 是中文，跳过翻译
        var htmlLang = (document.documentElement.getAttribute('lang') || '').toLowerCase();
        if (htmlLang === 'zh-cn' || htmlLang === 'zh-hans' || htmlLang === 'zh-sg') return true;
        // 无明确 lang 或裸 "zh" → 不跳过（可能是日文汉字）
        return false;
    }

    if (hasTraditionalChinese(text)) return false;
    // 短混合文本：有 CJK 且无长外文单词 → 视为中文
    if (anyCjk && text.length < 25) {
        var cjkCount2 = 0, meaningful2 = 0;
        for (const ch of text) {
            var cp = ch.codePointAt(0);
            if (cp <= 32) continue;
            meaningful2++;
            if (CJK_RE.test(ch)) cjkCount2++;
        }
        if (meaningful2 > 0 && cjkCount2 / meaningful2 >= 0.3) return true;
        return false;
    }
    // 有外文字符但连续长度不足 2 → 仍是外文（如 I'm, U.S., a.m., 24h, C++）
    return !anyForeign;
}

// ── 页面语言缓存（供 isAlreadyChinese 节点级判断使用） ──
var _pageLangForeign = false; // true = 页面 lang 为非中文 CJK 语言(如 ja)

// ── 页面级简体中文检测 ──
// 采样页面可见文本，判断是否已是简体中文（无需翻译）
function isPageSimplifiedChinese() {
    var body = document.body;
    if (!body) return false;

    // 快速路径：HTML lang 属性明确标注简体中文
    var htmlLang = (document.documentElement.getAttribute('lang') || '').toLowerCase();
    _pageLangForeign = false;
    if (htmlLang === 'zh-cn' || htmlLang === 'zh-hans' || htmlLang === 'zh-sg') {
        var quickText = (document.title || '') + ' ' + (document.body?.textContent || '').slice(0, 600);
        if (isAlreadyChinese(quickText)) return true;
    }
    // 明确标注非中文语言 → 不跳过（不含 bare "zh"，避免误拦繁体页面）
    if (htmlLang && htmlLang !== 'zh' && !htmlLang.startsWith('zh-')) {
        // 缓存：页面标注为非中文 CJK 语言（如 ja），节点级纯汉字不应视为中文
        _pageLangForeign = (htmlLang === 'ja' || htmlLang === 'ko');
        return false;
    }

    // 采样 body 中的可见文本（跳过脚本/样式/隐藏元素）
    var samples = [];
    var walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
        acceptNode: function (node) {
            var parent = node.parentElement;
            if (!parent) return NodeFilter.FILTER_REJECT;
            var tag = parent.tagName;
            // ME-3: 跳过导航和页眉页脚元素，避免采样偏差
            if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' ||
                tag === 'SVG' || tag === 'IFRAME' || tag === 'CODE' || tag === 'PRE' ||
                tag === 'NAV' || tag === 'HEADER' || tag === 'FOOTER') {
                return NodeFilter.FILTER_REJECT;
            }
            // 快速隐藏检测：offsetParent 为 null 且不是 fixed/absolute 定位 → 不可见
            if (parent.offsetParent === null && parent.offsetWidth === 0 && parent.offsetHeight === 0) {
                var pos = '';
                try { pos = getComputedStyle(parent).position; } catch (_) { }
                if (pos !== 'fixed' && pos !== 'absolute') return NodeFilter.FILTER_REJECT;
            }
            return NodeFilter.FILTER_ACCEPT;
        }
    });

    var totalChars = 0;
    while (walker.nextNode() && totalChars < 8000) {
        var t = walker.currentNode.textContent.trim();
        if (t.length > 0) {
            samples.push(t);
            totalChars += t.length;
        }
    }

    if (samples.length === 0) return false;

    var combined = samples.join(' ');
    return isAlreadyChinese(combined);
}

// ── 混合文本的源语言推断 ──
function detectSourceLang(text) {
    var latin = 0, kana = 0, hangul = 0, cyrillic = 0, arabic = 0, thai = 0;
    var cjk = 0, tradCjk = 0, total = 0;

    for (const ch of text) {
        var c = ch.codePointAt(0);
        if (c <= 0x20) continue;
        total++;

        if ((c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A) ||
            (c >= 0xC0 && c <= 0x24F && c !== 0xD7 && c !== 0xF7 && c !== 0x17F)) latin++;
        else if ((c >= 0x3040 && c <= 0x30FF) || (c >= 0x31F0 && c <= 0x31FF) ||
            (c >= 0xFF65 && c <= 0xFF9F)) kana++;
        else if (c >= 0xAC00 && c <= 0xD7AF) hangul++;
        else if (c >= 0x0400 && c <= 0x052F) cyrillic++;
        else if (c >= 0x0600 && c <= 0x06FF) arabic++;
        else if (c >= 0x0E00 && c <= 0x0E7F) thai++;
        else if (CJK_RE.test(ch)) {
            cjk++;
            if (TRADITIONAL_CHARS.has(ch)) tradCjk++;
        }
    }

    // 假名和谚文是明确语种信号 — 必须优先于繁体检出
    // 否则 "東へ行く" 会因为「東」在繁体集中被误判为 zh-TW
    if (kana >= 1) return 'ja';
    if (hangul >= 1) return 'ko';

    // 无假名/谚文且检出繁体字 → 繁体中文字面转简体
    if (tradCjk >= 1 && cjk >= 2) return 'zh-TW';

    var foreign = latin + kana + hangul + cyrillic + arabic + thai;
    if (foreign < 2) return 'auto';
    if (cjk > 0 && foreign / cjk < 0.43) return 'auto';

    var max = Math.max(latin, kana, hangul, cyrillic, arabic, thai);
    if (max === cyrillic) return 'ru';
    if (max === arabic) return 'ar';
    if (max === thai) return 'th';
    return 'en';
}