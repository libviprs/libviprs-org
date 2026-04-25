/* libviprs CLI doc page — interactive layer.
 *
 * Self-contained: no module bundler, no external deps. Loaded with `defer`
 * from cli.html, so by the time we run the DOM is parsed but DOMContentLoaded
 * may or may not have fired (defer guarantees DCL has not yet fired when this
 * script's top-level executes, but our work is gated on it anyway).
 *
 * Layout, in source order:
 *   1. Theme toggle  (#themeToggle, [data-theme] on <html>, persisted)
 *   2. Delegated copy buttons  (.code-wrap .copy-btn — works for injected snippets)
 *   3. Snippet store           (fetch js/snippets.generated.json, expose on window)
 *   4. Per-flag controls       (rewrite each <dt> under "pyramid" h2)
 *   5. Per-flag snippet render (renderFlagSnippet)
 *   6. Generator panel         (slot-walking renderer)
 *   7. Generator panel UI      (cli + rust + summary, copy/reset buttons)
 *   8. Base-setup mirror       (sync top-of-page when zero flags checked)
 *   9. Base-setup toggle       (.cmd-base-setup-toggle expand)
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // 0. Rust syntax highlighter — single-pass, no deps, HTML-safe.
  //    Token classes (.r-keyword, .r-type, .r-string, .r-number, .r-macro,
  //    .r-attr, .r-comment, .r-lifetime) are styled in cli.css and follow the
  //    same palette as the existing shell-prompt highlighting.
  // ---------------------------------------------------------------------------

  var RUST_TOKEN_RE = new RegExp([
    '(\\/\\/[^\\n]*)',                          // 1: line comment
    '(\\/\\*[\\s\\S]*?\\*\\/)',                  // 2: block comment
    '(b?"(?:[^"\\\\]|\\\\.)*")',                 // 3: string (incl. byte strings)
    "(b?'(?:[^'\\\\]|\\\\.)')",                  // 4: char literal
    '(#!?\\[[^\\]]*\\])',                        // 5: outer/inner attribute
    "('[a-zA-Z_][a-zA-Z0-9_]*)\\b",              // 6: lifetime / label
    '(\\b[a-z_][a-zA-Z0-9_]*!)',                 // 7: macro invocation
    '(\\b[A-Z][A-Za-z0-9_]*\\b)',                // 8: type / variant / trait
    '(\\b[0-9][0-9_]*(?:\\.[0-9_]+)?(?:[eE][+\\-]?[0-9_]+)?(?:[uif](?:8|16|32|64|128|size))?\\b)', // 9: number
    '(\\b(?:as|async|await|break|const|continue|crate|dyn|else|enum|extern|false|fn|for|if|impl|in|let|loop|match|mod|move|mut|pub|ref|return|self|Self|static|struct|super|trait|true|type|unsafe|use|where|while|box)\\b)' // 10: keyword
  ].join('|'), 'g');

  var RUST_TOKEN_CLASS = [
    null, 'r-comment', 'r-comment', 'r-string', 'r-string',
    'r-attr', 'r-lifetime', 'r-macro', 'r-type', 'r-number', 'r-keyword'
  ];

  function escapeHtml(s) {
    return s.replace(/[&<>"]/g, function (c) {
      return c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;';
    });
  }

  function highlightRust(code) {
    if (code == null) return '';
    var out = '';
    var last = 0;
    var m;
    RUST_TOKEN_RE.lastIndex = 0;
    while ((m = RUST_TOKEN_RE.exec(code)) !== null) {
      if (m.index > last) out += escapeHtml(code.slice(last, m.index));
      var cls = null;
      for (var i = 1; i < m.length; i++) {
        if (m[i] !== undefined) { cls = RUST_TOKEN_CLASS[i]; break; }
      }
      out += '<span class="' + cls + '">' + escapeHtml(m[0]) + '</span>';
      last = m.index + m[0].length;
    }
    if (last < code.length) out += escapeHtml(code.slice(last));
    return out;
  }

  function paintCodeEl(codeEl, source) {
    if (!codeEl) return;
    codeEl.innerHTML = highlightRust(source);
  }

  function paintStaticRustBlocks() {
    document.querySelectorAll('code.language-rust').forEach(function (el) {
      // Skip blocks the interactive layer manages — we paint those at update
      // time. Static authoring (info / plan / test-image) doesn't carry
      // those marker classes, so this only catches authored-by-hand examples.
      if (el.id === 'pyramid-base-code') return;
      if (el.closest('.gen-rust') || el.closest('.flag-rust')) return;
      paintCodeEl(el, el.textContent);
    });
  }

  // ---------------------------------------------------------------------------
  // 1. Theme toggle
  // ---------------------------------------------------------------------------

  function initThemeToggle() {
    var btn = document.getElementById('themeToggle');
    if (!btn) return;

    function applyTheme(theme) {
      document.documentElement.setAttribute('data-theme', theme);
      // Sun for light → "switch to light"; moon for dark → "switch to dark".
      btn.textContent = theme === 'dark' ? '☀ Light' : '☾ Dark';
    }
    function setTheme(theme) {
      applyTheme(theme);
      try { localStorage.setItem('theme', theme); } catch (_) { /* private mode */ }
    }

    var saved = null;
    try { saved = localStorage.getItem('theme'); } catch (_) { /* ignore */ }
    if (saved === 'light' || saved === 'dark') {
      applyTheme(saved);
    } else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      applyTheme('dark');
    } else {
      applyTheme('light');
    }

    btn.addEventListener('click', function () {
      var current = document.documentElement.getAttribute('data-theme');
      setTheme(current === 'dark' ? 'light' : 'dark');
    });

    // Track OS preference only when the user hasn't pinned a choice.
    if (window.matchMedia) {
      var mq = window.matchMedia('(prefers-color-scheme: dark)');
      var listener = function (e) {
        var pinned = null;
        try { pinned = localStorage.getItem('theme'); } catch (_) { /* ignore */ }
        if (!pinned) applyTheme(e.matches ? 'dark' : 'light');
      };
      if (mq.addEventListener) mq.addEventListener('change', listener);
      else if (mq.addListener) mq.addListener(listener);
    }
  }

  // ---------------------------------------------------------------------------
  // 2. Delegated copy buttons
  // ---------------------------------------------------------------------------
  // One listener on document → catches buttons that were added later (per-flag
  // snippet panels, dynamically-rebuilt generator panel, etc).

  function initDelegatedCopyButtons() {
    document.addEventListener('click', function (e) {
      var btn = e.target && e.target.closest && e.target.closest('.code-wrap .copy-btn');
      if (!btn) return;
      var wrap = btn.closest('.code-wrap');
      if (!wrap) return;
      var codeEl = wrap.querySelector('pre code');
      if (!codeEl) return;
      var text = codeEl.textContent;
      if (!navigator.clipboard) return;
      navigator.clipboard.writeText(text).then(function () {
        var prev = btn.innerHTML;
        btn.textContent = '✓ Copied';
        setTimeout(function () { btn.innerHTML = prev; }, 1500);
      }).catch(function () { /* user denied / insecure context — silent */ });
    });
  }

  // ---------------------------------------------------------------------------
  // 3. Snippet store
  // ---------------------------------------------------------------------------

  function loadSnippets() {
    return fetch('js/snippets.generated.json', { cache: 'no-cache' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (data) {
        window.VIPRS_SNIPPETS = data;
        return data;
      });
  }

  // ---------------------------------------------------------------------------
  // 4. Per-flag controls
  // ---------------------------------------------------------------------------

  // Map of enum string values → Rust variant. Used both inline (for {layout},
  // {format} etc. in slot lines) and during per-flag previews.
  var ENUM_VARIANT = {
    'deep-zoom': 'DeepZoom',
    'xyz': 'Xyz',
    'google': 'Google',
    'png': 'Png',
    'jpeg': 'Jpeg',          // overridden when quality is known (see variantFor)
    'raw': 'Raw',
    'blake3': 'Blake3',
    'sha256': 'Sha256',
    'fail-fast': 'FailFast',
    'retry-then-fail': 'RetryThenFail',
    'retry-then-skip': 'RetryThenSkip'
  };

  // Build a Rust variant string for an enum value. Quality is special-cased
  // because `Jpeg { quality: <q> }` carries a payload.
  function variantFor(enumValue, ctx) {
    if (enumValue === 'jpeg') {
      var q = (ctx && ctx.quality != null && ctx.quality !== '') ? ctx.quality : 90;
      return 'Jpeg { quality: ' + q + ' }';
    }
    return ENUM_VARIANT[enumValue] || enumValue;
  }

  function pyramidSection() {
    // Find the <h2> whose textContent is exactly "pyramid".
    var heads = document.querySelectorAll('h2');
    for (var i = 0; i < heads.length; i++) {
      if ((heads[i].textContent || '').trim() === 'pyramid') return heads[i];
    }
    return null;
  }

  // Walk forward from the pyramid <h2> and return every <dt> that lives
  // before the next <h2> (regardless of nesting in <dl>). DOM order = reading
  // order, so iterating siblings within the parent isn't enough — we need
  // a tree walker bounded by the next h2 in document order.
  function pyramidDts() {
    var head = pyramidSection();
    if (!head) return [];
    var out = [];
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, null);
    walker.currentNode = head;
    var node;
    while ((node = walker.nextNode())) {
      if (node.tagName === 'H2') break;
      if (node.tagName === 'DT') out.push(node);
    }
    return out;
  }

  function flagNameFromDt(dt) {
    var code = dt.querySelector('code');
    if (!code) return null;
    var m = (code.textContent || '').match(/^--([a-z][a-z0-9-]*)/);
    return m ? m[1] : null;
  }

  function buildTestHref(test) {
    if (!test || !test.file) return null;
    var line = test.line ? ('#L' + test.line) : '';
    if (test.repo === 'libviprs-tests') {
      return 'https://github.com/libviprs/libviprs-tests/blob/main/tests/' + test.file + line;
    }
    return 'https://github.com/libviprs/libviprs/blob/main/' + test.file + line;
  }

  function buildTestRefHref(test) {
    // Same as buildTestHref but used in the per-flag inline rust panel.
    return buildTestHref(test);
  }

  // Decorate a single <dt>, attach matching <dd> rust panel. Returns true if
  // the flag was a known/registered one (so the caller can track).
  function decorateFlagDt(dt, flagName, flagDef) {
    // Snapshot the original <code> so we can keep it as the visible flag-name.
    var origCode = dt.querySelector('code');
    if (!origCode) return false;

    dt.classList.add('flag-row');
    // Stable hash-link anchor: lets external docs / READMEs deep-link to a flag
    // via https://libviprs.org/cli/#flag-<name>.
    if (!dt.id) dt.id = 'flag-' + flagName;

    // Clear and rebuild contents.
    while (dt.firstChild) dt.removeChild(dt.firstChild);

    // Checkbox.
    var check = document.createElement('input');
    check.type = 'checkbox';
    check.className = 'flag-check';
    check.dataset.flag = flagName;
    check.addEventListener('change', function () { updateGenerator(); });
    check.addEventListener('click', function (e) { e.stopPropagation(); });
    dt.appendChild(check);

    // Flag name (clickable to toggle expanded).
    var nameSpan = document.createElement('span');
    nameSpan.className = 'flag-name';
    nameSpan.appendChild(origCode);
    nameSpan.addEventListener('click', function () {
      dt.classList.toggle('expanded');
    });
    dt.appendChild(nameSpan);

    // Optional value input for non-bool flags.
    var valueEl = null;
    if (flagDef.type && flagDef.type !== 'bool') {
      if (flagDef.type === 'enum') {
        valueEl = document.createElement('select');
        var options = flagDef.options || [];
        for (var i = 0; i < options.length; i++) {
          var opt = document.createElement('option');
          opt.value = options[i];
          opt.textContent = options[i];
          valueEl.appendChild(opt);
        }
      } else if (flagDef.type === 'int') {
        valueEl = document.createElement('input');
        valueEl.type = 'number';
      } else {
        valueEl = document.createElement('input');
        valueEl.type = 'text';
      }
      valueEl.className = 'flag-value';
      if (flagDef.default != null) valueEl.value = String(flagDef.default);

      valueEl.addEventListener('click', function (e) { e.stopPropagation(); });
      valueEl.addEventListener('input', function () {
        if (valueEl.value !== '' && !check.checked) check.checked = true;
        updateSnippet(dt);
        updateGenerator();
      });
      // <select> fires `change`, not `input`, in some browsers — cover both.
      valueEl.addEventListener('change', function () {
        if (valueEl.value !== '' && !check.checked) check.checked = true;
        updateSnippet(dt);
        updateGenerator();
      });
      dt.appendChild(valueEl);
    }

    // Test link (small "test" anchor).
    var testHref = buildTestHref(flagDef.test);
    if (testHref) {
      var a = document.createElement('a');
      a.className = 'test-link';
      a.target = '_blank';
      a.rel = 'noopener';
      a.href = testHref;
      a.textContent = 'test';
      a.addEventListener('click', function (e) { e.stopPropagation(); });
      dt.appendChild(a);
    }

    // Toggle indicator (chevron is drawn via CSS ::before).
    var toggle = document.createElement('span');
    toggle.className = 'toggle-indicator';
    toggle.textContent = 'Rust code';
    toggle.addEventListener('click', function () {
      dt.classList.toggle('expanded');
    });
    dt.appendChild(toggle);

    // Build the per-flag rust panel inside the matching <dd>.
    var dd = nextDd(dt);
    if (dd) {
      var panel = document.createElement('div');
      panel.className = 'flag-rust';
      // The CSS for `dt.flag-row.expanded + dd .flag-rust` flips display, so
      // the `hidden` attribute is fine to leave on (CSS specificity wins on
      // expand). It still hides the panel when collapsed.
      panel.setAttribute('hidden', '');

      var codeWrap = document.createElement('pre');
      var codeEl = document.createElement('code');
      codeEl.className = 'language-rust';
      codeWrap.appendChild(codeEl);
      panel.appendChild(codeWrap);

      var refHref = buildTestRefHref(flagDef.test);
      if (refHref) {
        var p = document.createElement('p');
        p.className = 'test-ref';
        p.appendChild(document.createTextNode('Live example: '));
        var refA = document.createElement('a');
        refA.target = '_blank';
        refA.rel = 'noopener';
        refA.href = refHref;
        refA.appendChild(document.createTextNode('tests/' + (flagDef.test.file || '') + ' · '));
        var fnCode = document.createElement('code');
        fnCode.textContent = flagDef.test.fn || '';
        refA.appendChild(fnCode);
        if (flagDef.test.line) refA.appendChild(document.createTextNode(' @ L' + flagDef.test.line));
        p.appendChild(refA);
        panel.appendChild(p);
      }

      dd.appendChild(panel);
      dt._flagPanelCode = codeEl;
    }

    // Cache references for fast access in update callbacks.
    dt._flagName = flagName;
    dt._flagDef = flagDef;
    dt._flagCheck = check;
    dt._flagValue = valueEl;

    // Initial render of the per-flag preview.
    updateSnippet(dt);
    return true;
  }

  function nextDd(dt) {
    var n = dt.nextElementSibling;
    while (n && n.tagName !== 'DD') n = n.nextElementSibling;
    return n;
  }

  // ---------------------------------------------------------------------------
  // 5. Per-flag snippet rendering
  // ---------------------------------------------------------------------------

  // Substitute {placeholder} tokens. `params` is a string→string map.
  // Unknown tokens are left untouched (safer than dropping them silently —
  // makes missing snippet metadata visible).
  function substitute(text, params) {
    return text.replace(/\{([a-zA-Z_][a-zA-Z0-9_-]*)\}/g, function (whole, key) {
      if (Object.prototype.hasOwnProperty.call(params, key)) return String(params[key]);
      return whole;
    });
  }

  // Compute the substitution context for a flag: { paramName: rendered-value }.
  // For enum flags, the rendered value is a Rust variant (e.g. Layout::Xyz).
  function paramsForFlag(flag, value, otherDefaults) {
    var params = {};
    var v;
    if (flag.options) {
      v = variantFor(value, otherDefaults || {});
    } else {
      v = (value == null || value === '') ? (flag.default != null ? flag.default : '') : value;
    }
    params.v = v;
    if (flag.param) params[flag.param] = v;
    // Pull any sibling defaults the snippet might want (e.g. {dpi}, {page}).
    if (otherDefaults) {
      for (var k in otherDefaults) {
        if (Object.prototype.hasOwnProperty.call(otherDefaults, k) && !(k in params)) {
          params[k] = otherDefaults[k];
        }
      }
    }
    return params;
  }

  // Render a self-contained preview for a single flag (the per-flag rust panel
  // shown when the user expands a flag row).
  function renderFlagSnippet(flag, value) {
    var snippets = window.VIPRS_SNIPPETS;
    if (!snippets) return '';
    var params = paramsForFlag(flag, value, gatherOtherDefaults(flag));

    if (flag.kind === 'param') {
      var slot = snippets.slots && snippets.slots[flag.slot];
      if (!slot || !slot.lines) return '';
      return slot.lines.map(function (line) { return substitute(line, params); }).join('\n');
    }
    if (flag.kind === 'append' || flag.kind === 'appendChain') {
      var frag = flag.fragment || '';
      return substitute(frag, params);
    }
    if (flag.kind === 'override') {
      var frag2 = flag.fragment || '';
      return substitute(frag2, params);
    }
    if (flag.kind === 'imports-only') {
      var imports = (flag.imports_when_active || []).slice().sort();
      return '// adds imports: ' + imports.join(', ');
    }
    return '';
  }

  // Pull defaults from sibling flags. Used so override fragments referencing
  // `{dpi}`, `{page}`, etc. render with the user's other choices baked in.
  function gatherOtherDefaults(skip) {
    var out = {};
    var snippets = window.VIPRS_SNIPPETS;
    if (!snippets || !snippets.flags) return out;
    var byParam = {};
    var dts = pyramidDts();
    var liveByName = {};
    dts.forEach(function (dt) {
      if (dt._flagName) liveByName[dt._flagName] = dt;
    });
    Object.keys(snippets.flags).forEach(function (name) {
      var f = snippets.flags[name];
      if (skip && f === skip) return;
      var live = liveByName[name];
      var v;
      if (live && live._flagValue && live._flagValue.value !== '') {
        v = live._flagValue.value;
      } else {
        v = f.default != null ? f.default : '';
      }
      if (f.param) byParam[f.param] = f.options ? variantFor(v, byParam) : v;
    });
    return byParam;
  }

  function updateSnippet(dt) {
    if (!dt._flagPanelCode || !dt._flagDef) return;
    var value = dt._flagValue ? dt._flagValue.value : '';
    paintCodeEl(dt._flagPanelCode, renderFlagSnippet(dt._flagDef, value));
  }

  // ---------------------------------------------------------------------------
  // 6. Generator panel renderer
  // ---------------------------------------------------------------------------

  // Returns { rust, cli, count } for the current flag selection.
  function renderFullProgram() {
    var snippets = window.VIPRS_SNIPPETS;
    if (!snippets) return { rust: '', cli: '', count: 0 };

    // Snapshot the live state for every active flag (checkbox checked).
    var dts = pyramidDts();
    var active = []; // [{ name, def, value, dt }]
    dts.forEach(function (dt) {
      if (dt._flagCheck && dt._flagCheck.checked && dt._flagDef) {
        var v = dt._flagValue ? dt._flagValue.value : '';
        if (v === '' && dt._flagDef.default != null) v = String(dt._flagDef.default);
        active.push({ name: dt._flagName, def: dt._flagDef, value: v, dt: dt });
      }
    });

    // Group flags by slot. `param` flags substitute placeholders; `append`
    // and `appendChain` flags append to a slot; `override` replaces a slot
    // body entirely; `imports-only` contributes nothing structural.
    var bySlot = {}; // slot → { params: [], appends: [], chains: [], overrides: [] }
    function bucket(slot) {
      if (!bySlot[slot]) bySlot[slot] = { params: [], appends: [], chains: [], overrides: [] };
      return bySlot[slot];
    }
    active.forEach(function (a) {
      if (!a.def.kind) return;
      if (a.def.kind === 'imports-only') return;
      var slot = a.def.slot;
      if (!slot) return;
      var b = bucket(slot);
      if (a.def.kind === 'param') b.params.push(a);
      else if (a.def.kind === 'append') b.appends.push(a);
      else if (a.def.kind === 'appendChain') b.chains.push(a);
      else if (a.def.kind === 'override') b.overrides.push(a);
    });

    // Build a {param-name: rendered-value} map across all active flags so
    // slot lines can refer to other flags' values (e.g. {quality} inside
    // the format slot when the format is jpeg).
    var liveParams = {};
    active.forEach(function (a) {
      if (a.def.param) {
        liveParams[a.def.param] = a.def.options ? variantFor(a.value, liveParams) : a.value;
      }
    });
    // Fold defaults for any inactive flag with a `param` so slot lines that
    // reference (say) {tile_size} render even when the user didn't check
    // --tile-size.
    Object.keys(snippets.flags || {}).forEach(function (name) {
      var f = snippets.flags[name];
      if (!f.param) return;
      if (Object.prototype.hasOwnProperty.call(liveParams, f.param)) return;
      liveParams[f.param] = f.options ? variantFor(f.default, liveParams) : (f.default != null ? f.default : '');
    });

    // Render each slot in declared order.
    var slotOrder = snippets.slot_order || [];
    var renderedSlots = [];
    slotOrder.forEach(function (slotName) {
      var slot = snippets.slots && snippets.slots[slotName];
      if (!slot) return;
      var assigned = bySlot[slotName];

      // Override wins outright. If multiple, last one wins (deterministic
      // by source order; in practice we expect at most one override per slot).
      if (assigned && assigned.overrides.length) {
        var override = assigned.overrides[assigned.overrides.length - 1];
        // Sink override is special-cased — see resolveSinkOverride.
        if (override.def.special === 'sink-override' || override.name === 'sink') {
          var sinkResult = resolveSinkOverride(override, snippets);
          if (sinkResult) {
            renderedSlots.push(sinkResult.body);
            sinkResult.imports.forEach(function (imp) { extraImports[imp] = true; });
            return;
          }
        }
        renderedSlots.push(substitute(override.def.fragment || '', mergeParams(liveParams, paramsForFlag(override.def, override.value))));
        return;
      }

      // Base body (slot.lines), with placeholder substitution.
      var body = (slot.lines || []).map(function (line) { return substitute(line, liveParams); }).join('\n');

      // appendChain: each chain piece slots onto the trailing `;` of the
      // body. Practically: `EngineConfig::default();` becomes
      //   EngineConfig::default()
      //       .with_x(...)
      //       ;
      // We trim the last `;` (and any preceding whitespace), append the
      // chain pieces (each as `    .with_X(...)`), then re-emit `;`.
      if (assigned && assigned.chains.length) {
        body = applyAppendChain(body, assigned.chains, liveParams);
      }

      // append: simple line-level concatenation after the slot body.
      if (assigned && assigned.appends.length) {
        var extras = assigned.appends.map(function (a) {
          return substitute(a.def.fragment || '', mergeParams(liveParams, paramsForFlag(a.def, a.value)));
        });
        body = body + (body ? '\n' : '') + extras.join('\n');
      }

      renderedSlots.push(body);
    });

    var extraImports = {}; // populated above for sink override side-effects

    // Imports: union of imports_base + each active flag's imports_when_active.
    var importsSet = {};
    (snippets.imports_base || []).forEach(function (s) { importsSet[s] = true; });
    active.forEach(function (a) {
      (a.def.imports_when_active || []).forEach(function (s) { importsSet[s] = true; });
    });
    Object.keys(extraImports).forEach(function (s) { importsSet[s] = true; });
    var imports = Object.keys(importsSet).sort();

    // Wrap inner body in main(). Indent every non-empty line by 4 spaces.
    var inner = renderedSlots.filter(function (s) { return s && s.length; }).join('\n\n');
    var indented = inner.split('\n').map(function (line) {
      return line.length ? '    ' + line : line;
    }).join('\n');

    var rust =
      'use libviprs::{' + imports.join(', ') + '};\n' +
      'use std::path::PathBuf;\n' +
      '\n' +
      'fn main() -> Result<(), Box<dyn std::error::Error>> {\n' +
      '    let input = PathBuf::from("/path/to/your/input.pdf");\n' +
      '    let output = PathBuf::from("./tiles");\n' +
      (indented ? '\n' + indented + '\n' : '') +
      '\n' +
      '    Ok(())\n' +
      '}\n';

    // CLI command.
    var parts = ['viprs pyramid input.pdf tiles/'];
    active.forEach(function (a) {
      if (!a.def.cli) return;
      parts.push(substitute(a.def.cli, { v: a.value, value: a.value }));
    });
    var cli = parts.join(' ');

    return { rust: rust, cli: cli, count: active.length };
  }

  function mergeParams(a, b) {
    var out = {};
    for (var k in a) if (Object.prototype.hasOwnProperty.call(a, k)) out[k] = a[k];
    for (var k2 in b) if (Object.prototype.hasOwnProperty.call(b, k2)) out[k2] = b[k2];
    return out;
  }

  // Splice append-chain pieces onto the tail of an existing slot body. The
  // slot body is expected to end on a `;` (engine-config / engine-builder
  // are designed for this). We strip the trailing `;`, append each chain
  // fragment as a new indented line, then re-emit `;`.
  function applyAppendChain(body, chains, params) {
    if (!body) {
      // Defensive: if the slot body was empty, just join chains directly.
      return chains.map(function (c) {
        return substitute(c.def.fragment || '', mergeParams(params, paramsForFlag(c.def, c.value)));
      }).join('\n');
    }

    // Find the last `;` (possibly preceded by `?`) and split there.
    var idx = body.lastIndexOf(';');
    if (idx === -1) {
      // No trailing `;` — append chains as plain lines.
      var extra = chains.map(function (c) {
        return substitute(c.def.fragment || '', mergeParams(params, paramsForFlag(c.def, c.value)));
      });
      return body + '\n' + extra.join('\n');
    }

    var head = body.slice(0, idx).replace(/\s+$/, '');
    var tail = body.slice(idx + 1); // anything after `;` (probably nothing)
    var pieces = chains.map(function (c) {
      var rendered = substitute(c.def.fragment || '', mergeParams(params, paramsForFlag(c.def, c.value)));
      // Each fragment is expected to be a single `.with_x(...)` call. Indent
      // by four spaces relative to the start of the chained expression.
      return '    ' + rendered.replace(/^\s+/, '');
    });
    return head + '\n' + pieces.join('\n') + '\n    ;' + tail;
  }

  // Sink override: --sink s3://… or packfile://… replaces the entire `sink`
  // slot body with hard-coded snippets that match the documented usage.
  function resolveSinkOverride(active, snippets) {
    var v = active.value || '';
    if (v.indexOf('s3://') === 0) {
      var rest = v.slice('s3://'.length); // bucket/prefix
      var slash = rest.indexOf('/');
      var bucket = slash === -1 ? rest : rest.slice(0, slash);
      var prefix = slash === -1 ? '' : rest.slice(slash + 1);
      var body =
        'let object_store = ObjectStoreConfig::s3("' + bucket + '")\n' +
        '    .with_prefix("' + prefix + '")\n' +
        '    .build()?;\n' +
        'let sink = ObjectStoreSink::new(object_store);';
      return { body: body, imports: ['ObjectStoreConfig', 'ObjectStoreSink'] };
    }
    if (v.indexOf('packfile://') === 0) {
      var path = v.slice('packfile://'.length);
      var fmt = 'Tar';
      if (/\.tar\.gz$|\.tgz$/i.test(path)) fmt = 'TarGz';
      else if (/\.zip$/i.test(path)) fmt = 'Zip';
      else if (/\.tar$/i.test(path)) fmt = 'Tar';
      // Tile format: pull from the live `format` flag if available, else Png.
      var liveFormat = 'TileFormat::Png';
      var dts = pyramidDts();
      for (var i = 0; i < dts.length; i++) {
        var dt = dts[i];
        if (dt._flagName === 'format' && dt._flagValue) {
          var fv = dt._flagValue.value;
          // Be quality-aware so a checked --quality flows through.
          var ctx = {};
          var qDt = findDt('quality');
          if (qDt && qDt._flagValue) ctx.quality = qDt._flagValue.value;
          liveFormat = 'TileFormat::' + variantFor(fv, ctx);
          break;
        }
      }
      var body2 =
        'let sink = PackfileSink::new(\n' +
        '    PathBuf::from("' + path + '"),\n' +
        '    PackfileFormat::' + fmt + ',\n' +
        '    plan.clone(),\n' +
        '    ' + liveFormat + ',\n' +
        ')?;';
      return { body: body2, imports: ['PackfileSink', 'PackfileFormat'] };
    }
    return null;
  }

  function findDt(flagName) {
    var dts = pyramidDts();
    for (var i = 0; i < dts.length; i++) {
      if (dts[i]._flagName === flagName) return dts[i];
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // 7. Generator panel UI
  // ---------------------------------------------------------------------------

  function generatorEl()  { return document.getElementById('cli-generator'); }
  function genCliCode()   { var g = generatorEl(); return g && g.querySelector('.gen-cli pre code'); }
  function genRustCode()  { var g = generatorEl(); return g && g.querySelector('.gen-rust pre code'); }
  function summaryEl()    { var g = generatorEl(); return g && g.querySelector('.summary'); }
  function baseCodeEl()   { return document.getElementById('pyramid-base-code'); }

  function updateGenerator() {
    var prog = renderFullProgram();
    var rustOut = genRustCode();
    var cliOut = genCliCode();
    var summary = summaryEl();
    if (rustOut) paintCodeEl(rustOut, prog.rust);
    if (cliOut) cliOut.textContent = prog.cli;
    if (summary) {
      summary.textContent = prog.count === 0
        ? 'No flags selected. Check boxes above to assemble a CLI command and a complete Rust program.'
        : (prog.count + ' flag' + (prog.count === 1 ? '' : 's') + ' selected. Edit input/output paths in the program below.');
    }

    // Refresh every per-flag preview so cross-flag references (e.g. quality
    // affecting the format snippet) stay in sync.
    pyramidDts().forEach(function (dt) {
      if (dt._flagPanelCode) updateSnippet(dt);
    });

    // Mirror to the top-of-page base setup when nothing is selected.
    if (prog.count === 0) {
      var base = baseCodeEl();
      if (base) paintCodeEl(base, prog.rust);
    }
  }

  function initGeneratorActions() {
    var g = generatorEl();
    if (!g) return;

    // Per-target copy buttons.
    g.querySelectorAll('.gen-copy-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var target = btn.dataset.target;
        var code = g.querySelector('.' + target + ' pre code');
        if (!code || !navigator.clipboard) return;
        navigator.clipboard.writeText(code.textContent).then(function () {
          var prev = btn.innerHTML;
          btn.textContent = '✓ Copied';
          setTimeout(function () { btn.innerHTML = prev; }, 1500);
        }).catch(function () { /* silent */ });
      });
    });

    // Reset all flags.
    var reset = g.querySelector('.reset-btn');
    if (reset) {
      reset.addEventListener('click', function () {
        pyramidDts().forEach(function (dt) {
          if (dt._flagCheck) dt._flagCheck.checked = false;
          if (dt._flagValue && dt._flagDef && dt._flagDef.default != null) {
            dt._flagValue.value = String(dt._flagDef.default);
          } else if (dt._flagValue) {
            dt._flagValue.value = '';
          }
          dt.classList.remove('expanded');
        });
        updateGenerator();
      });
    }
  }

  // ---------------------------------------------------------------------------
  // 9. Base-setup toggle
  // ---------------------------------------------------------------------------

  function initBaseSetupToggles() {
    document.querySelectorAll('.cmd-base-setup-toggle').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var parent = btn.closest('.cmd-base-setup');
        if (!parent) return;
        var nowOpen = parent.classList.toggle('expanded');
        btn.setAttribute('aria-expanded', nowOpen ? 'true' : 'false');
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Entry point
  // ---------------------------------------------------------------------------

  function setUpFlagRows() {
    var snippets = window.VIPRS_SNIPPETS;
    if (!snippets || !snippets.flags) return;
    var dts = pyramidDts();
    dts.forEach(function (dt) {
      var name = flagNameFromDt(dt);
      if (!name) return;
      var def = snippets.flags[name];
      // If the JSON doesn't know about this flag, leave the <dt> as-is.
      if (!def) return;
      decorateFlagDt(dt, name, def);
    });
  }

  function ready(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn, { once: true });
    } else {
      fn();
    }
  }

  ready(function () {
    initThemeToggle();
    initDelegatedCopyButtons();
    initBaseSetupToggles();
    paintStaticRustBlocks();

    loadSnippets().then(function () {
      setUpFlagRows();
      initGeneratorActions();
      updateGenerator();
    }).catch(function (err) {
      // Static page still works without snippets — log and bail out of the
      // interactive layer so the rest of the page (theme, copy, base toggle)
      // keeps functioning.
      // eslint-disable-next-line no-console
      console.error('[viprs cli] failed to load snippets.generated.json:', err);
    });
  });
})();
