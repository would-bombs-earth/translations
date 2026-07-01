// dom-hijack.js
// 运行在 MAIN world 的拦截脚本，拦截 React/Vue/Next.js 的水合读取，防止 Mismatch 报错
(function() {
  if (window.__gt_hijacked) return;
  window.__gt_hijacked = true;

  const origTextMap = new WeakMap();
  const origAttrMap = new WeakMap();

  // ── Translation Cache for Pre-render Injection ──
  var translationCache = new Map();
  var TC_MAX = 5000;
  var TC_CLEAN = 1250;

  window.addEventListener('gt-cache-translation', function (e) {
    var detail = e.detail;
    if (detail && typeof detail.raw === 'string' && typeof detail.translated === 'string' && detail.translated !== detail.raw) {
      translationCache.set(detail.raw, detail.translated);
      if (translationCache.size > TC_MAX) {
        var iter = translationCache.keys();
        for (var i = 0; i < TC_CLEAN; i++) translationCache.delete(iter.next().value);
      }
    }
  }, true);

  window.addEventListener('gt-orig-text', (e) => {
    e.stopPropagation();
    const node = e.target;
    if (node && typeof e.detail === 'string') {
      origTextMap.set(node, e.detail);
    }
  }, true);

  window.addEventListener('gt-orig-attr', (e) => {
    e.stopPropagation();
    const node = e.target;
    if (node && e.detail && e.detail.attr) {
      let attrs = origAttrMap.get(node);
      if (!attrs) {
        attrs = new Map();
        origAttrMap.set(node, attrs);
      }
      attrs.set(e.detail.attr, e.detail.value);
    }
  }, true);

  // Helper to hijack getters/setters for text properties
  function hijackProperty(prototype, propertyName) {
    const origDescriptor = Object.getOwnPropertyDescriptor(prototype, propertyName);
    if (!origDescriptor) return;

    Object.defineProperty(prototype, propertyName, {
      get() {
        if (origTextMap.has(this)) {
          return origTextMap.get(this);
        }
        return origDescriptor.get ? origDescriptor.get.call(this) : origDescriptor.value;
      },
      set(val) {
        var nVal = typeof val === 'string' ? val.replace(/\s+/g, ' ').trim() : val;
        if (typeof nVal === 'string' && translationCache.has(nVal)) {
          origTextMap.set(this, val);
          val = translationCache.get(nVal);
        } else {
          origTextMap.delete(this);
        }
        if (origDescriptor.set) {
          origDescriptor.set.call(this, val);
        } else {
          origDescriptor.value = val;
        }
      },
      enumerable: origDescriptor.enumerable,
      configurable: origDescriptor.configurable
    });
  }

  // Intercept texts
  hijackProperty(CharacterData.prototype, 'data');
  hijackProperty(Node.prototype, 'nodeValue');
  hijackProperty(Node.prototype, 'textContent');

  // Intercept Element attributes (getAttribute / setAttribute)
  const origGetAttribute = Element.prototype.getAttribute;
  Element.prototype.getAttribute = function(name) {
    const attrs = origAttrMap.get(this);
    const lowerName = typeof name === 'string' ? name.toLowerCase() : name;
    if (attrs && attrs.has(lowerName)) {
      return attrs.get(lowerName);
    }
    return origGetAttribute.call(this, name);
  };

  const origSetAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function(name, value) {
    const attrs = origAttrMap.get(this);
    if (attrs) {
      const lowerName = typeof name === 'string' ? name.toLowerCase() : name;
      attrs.delete(lowerName);
    }
    return origSetAttribute.call(this, name, value);
  };

  // Intercept properties reflecting attributes
  function hijackAttrProperty(prototype, propertyName) {
    const origDescriptor = Object.getOwnPropertyDescriptor(prototype, propertyName);
    if (!origDescriptor) return;

    Object.defineProperty(prototype, propertyName, {
      get() {
        const attrs = origAttrMap.get(this);
        if (attrs && attrs.has(propertyName)) {
          return attrs.get(propertyName);
        }
        return origDescriptor.get ? origDescriptor.get.call(this) : origDescriptor.value;
      },
      set(val) {
        const attrs = origAttrMap.get(this);
        if (attrs) {
          attrs.delete(propertyName);
        }
        if (origDescriptor.set) {
          origDescriptor.set.call(this, val);
        } else {
          origDescriptor.value = val;
        }
      },
      enumerable: origDescriptor.enumerable,
      configurable: origDescriptor.configurable
    });
  }

  hijackAttrProperty(HTMLInputElement.prototype, 'placeholder');
  hijackAttrProperty(HTMLTextAreaElement.prototype, 'placeholder');
  hijackAttrProperty(HTMLElement.prototype, 'title');

  // ═══════════════════════════════════════════════════════════
  // Fetch / XHR Interception for Pre-translation
  // ═══════════════════════════════════════════════════════════
  function extractAndPrefetch(obj) {
    const strings = new Set();
    function traverse(node) {
      if (typeof node === 'string') {
        const s = node.trim();
        if (s.length > 1) {
          // Reject obvious non-text (URLs, hashes, base64)
          if (s.startsWith('http://') || s.startsWith('https://') || s.startsWith('/')) return;
          if (/^[0-9a-fA-F\-]{20,}$/.test(s)) return;
          if (/^[A-Za-z0-9+/=]{40,}$/.test(s)) return;
          if (/^[^a-zA-Z0-9\u4e00-\u9fa5]+$/.test(s)) return;
          // Reject SVG paths (start with M/m followed by digits, high digit density)
          if (/^[Mm]\s*-?\d+/.test(s) && (s.match(/[0-9]/g) || []).length > s.length * 0.3) return;
          // Reject CSS/code blocks
          if (s.includes('{') || s.includes('}') || s.includes(';')) return;
          strings.add(s);
        }
      } else if (Array.isArray(node)) {
        node.forEach(traverse);
      } else if (node && typeof node === 'object') {
        Object.values(node).forEach(traverse);
      }
    }
    try { traverse(obj); } catch (e) {}
    if (strings.size > 0) {
      window.dispatchEvent(new CustomEvent('gt-prefetch-text', { detail: Array.from(strings) }));
    }
  }

  const origFetch = window.fetch;
  window.fetch = async function(...args) {
    const response = await origFetch.apply(this, args);
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('json')) {
      const clone = response.clone();
      clone.text().then(text => {
        try {
          const json = JSON.parse(text);
          extractAndPrefetch(json);
        } catch (e) {}
      }).catch(() => {});
    }
    return response;
  };

  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function(...args) {
    this.addEventListener('load', function() {
      const type = this.responseType;
      if (type === '' || type === 'text' || type === 'json') {
        try {
          const json = type === 'json' ? this.response : JSON.parse(this.responseText);
          extractAndPrefetch(json);
        } catch (e) {}
      }
    });
    return origSend.apply(this, args);
  };

})();
