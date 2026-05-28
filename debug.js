// debug.js — Translation Debug Logger
// 在控制台输出翻译批次摘要及译文
// 通过 window.__gt_debug 注册回调，由 content.js 的钩子触发

(function () {

  const TAG = '[翻译调试]';
  const S_HEAD = 'color:#fff;background:#5c6bc0;padding:2px 6px;border-radius:3px;font-weight:bold';
  const S_NONE = '';

  let detectCount = 0;

  window.__gt_debug = {

    // ── 检索到文本节点（静默计数，不逐条打印） ──
    detect() { detectCount++; },

    // ── 发送翻译批次 ──
    batch_send(data) {
      console.log(
        `%c${TAG}%c 批次 #${data.seq} — ${data.count} 条原文 (已检索 ${detectCount} 项)`,
        S_HEAD, S_NONE
      );
      // 打印每条原文，方便排查映射问题
      if (data.items) {
        console.groupCollapsed(`  └─ 原文明细 (${data.items.length} 条)`);
        data.items.forEach(function (item, i) {
          console.log(`    [${i}] id=${item.id} ` + item.raw);
        });
        console.groupEnd();
      }
    },

    // ── 翻译完成 ──
    batch_done(data) {
      const ms = data.elapsed.toFixed(0);
      const engName = data.engine || '?';
      const S_ENG = engName === 'microsoft'
        ? 'color:#fff;background:#6366f1;padding:1px 5px;border-radius:3px'
        : engName === 'worker-proxy'
          ? 'color:#0b0d14;background:#2dd4bf;padding:1px 5px;border-radius:3px'
          : engName === 'dual'
            ? 'color:#fff;background:#8b5cf6;padding:1px 5px;border-radius:3px'
          : engName === '(cache)'
            ? 'color:#8b8d9e;background:rgba(255,255,255,0.08);padding:1px 5px;border-radius:3px'
            : 'color:#fff;background:#666;padding:1px 5px;border-radius:3px';
      console.log(
        `%c${TAG}%c 批次 #${data.seq} ✅ ${data.count} 条译文 (${ms}ms) %c${engName}%c`,
        S_HEAD, S_NONE, S_ENG, S_NONE
      );
    }
  };

  console.log(
    `%c${TAG}%c 调试模式已启用`,
    S_HEAD, S_NONE
  );

  // ── 连通性自检 ──
  (async function connectivityCheck() {
    const S_OK = 'color:#fff;background:#34d399;padding:1px 5px;border-radius:3px';
    const S_FAIL = 'color:#fff;background:#ef5350;padding:1px 5px;border-radius:3px';
    try {
      const { workerUrl } = await chrome.storage.local.get('workerUrl');
      if (!workerUrl) {
        console.log(`%c${TAG}%c 连通性: Worker 未配置`, S_HEAD, S_NONE);
        return;
      }
      let raw = workerUrl.replace(/\/+$/, '');
      if (!/^https?:\/\//i.test(raw)) raw = 'https://' + raw;
      const healthUrl = raw + '/health';

      const t0 = performance.now();
      let ok = false;
      let err = '';
      try {
        const res = await fetch(healthUrl);
        ok = res.ok;
        if (!ok) err = 'HTTP ' + res.status;
      } catch (e) {
        err = e.message;
      }
      const ms = Math.round(performance.now() - t0);

      console.log(
        `%c${TAG}%c 连通性: ${healthUrl} → %c${ok ? 'OK ' + ms + 'ms' : 'FAIL ' + err}%c`,
        S_HEAD, S_NONE,
        ok ? S_OK : S_FAIL, S_NONE
      );
    } catch (_) {
      // storage 不可用时静默
    }
  })();

})();
