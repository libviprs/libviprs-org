/* libviprs CLI doc page — interactive layer.
 *
 * Self-contained: no module bundler, no external deps. Loaded with `defer`
 * from cli.html, so by the time we run the DOM is parsed but DOMContentLoaded
 * may or may not have fired (defer guarantees DCL has not yet fired when this
 * script's top-level executes, but our work is gated on it anyway).
 *
 * Layout, in source order:
 *   1. Theme toggle  — moved to ../topbar.js (shared across all pages)
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
  // Flag → color map. Built lazily from the snippets JSON (the source of truth
  // for the flag list). Stable: hue is derived from the flag's index in the
  // sorted flag list, so the same flag always gets the same color across
  // reloads. Exposed on `prog.flagColors` for consumers like CodeGutter.
  // ---------------------------------------------------------------------------

  var FLAG_COLORS = null; // populated by ensureFlagColors() once snippets load

  function ensureFlagColors() {
    if (FLAG_COLORS) return FLAG_COLORS;
    var snippets = window.VIPRS_SNIPPETS;
    if (!snippets || !snippets.flags) return {};
    var FLAGS = snippets.flags;
    var colors = {};
    var keys = Object.keys(FLAGS);
    keys.forEach(function (k, i) {
      var hue = Math.round((i * 360 / keys.length) % 360);
      colors[k] = 'hsl(' + hue + ', 65%, 55%)';
    });
    FLAG_COLORS = colors;
    return FLAG_COLORS;
  }

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
  // 1. Theme toggle — moved to the shared topbar.js (loaded by index.html).
  //    Left intentionally blank here so the section numbering keeps reading
  //    in source order with the original layout.
  // ---------------------------------------------------------------------------

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

  // Return the flag names that this raw template line is attributed to, by
  // looking at every `{name}` placeholder in the line and resolving each
  // back to the flag whose `param_name` matches. Used to color the
  // provenance gutter on slot-base lines (where the rendered text after
  // substitution carries no flag-identifying token).
  function flagsForRawLine(rawLine, snippets) {
    if (!rawLine || !snippets || !snippets.flags) return [];
    var flags = [];
    var seen = {};
    var re = /\{([a-zA-Z_][a-zA-Z0-9_-]*)\}/g;
    var m;
    while ((m = re.exec(rawLine)) !== null) {
      var paramName = m[1];
      // Find the flag whose param_name (or legacy `param`) matches.
      var match = null;
      Object.keys(snippets.flags).some(function (flagName) {
        var f = snippets.flags[flagName];
        var pk = f && (f.param_name || f.param);
        if (pk === paramName) { match = flagName; return true; }
        return false;
      });
      if (match && !seen[match]) {
        seen[match] = 1;
        flags.push(match);
      }
    }
    return flags;
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
    var pk = flag.param_name || flag.param;
    if (pk) params[pk] = v;
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

  // Flag attribution for a base-body slot line. Returns the array of flag
  // names that "drove" this line into the output. Empty array means the line
  // belongs to the slot's static scaffolding and isn't attributable to a
  // particular flag — the caller (CodeGutter) renders no bar for those.
  //
  // Patterns are matched against the *substituted* line text so that any
  // {placeholder} expansion that surfaces an `args.<flag>` reference still
  // attributes correctly.
  function attributeBaseLine(slotName, lineText) {
    var f, seen, out;
    switch (slotName) {
      case 'tracing-init':
        return ['trace-level'];
      case 'memory-limit':
        return ['memory-limit'];
      case 'geo':
        return ['geo-origin', 'geo-scale'];
      case 'planner':
        if (/args\.tile_size/.test(lineText)) return ['tile-size'];
        if (/args\.overlap/.test(lineText)) return ['overlap'];
        if (/^\s*layout,\s*$/.test(lineText)) return ['layout'];
        if (/with_centre/.test(lineText)) return ['centre'];
        return [];
      case 'load-source':
        f = [];
        if (/args\.render|render_page_pdfium|Rendering PDF page|\(pdfium\)/.test(lineText)) f.push('render');
        if (/args\.dpi|\bDPI\b|f64 \/ 72\.0/.test(lineText)) f.push('dpi');
        if (/args\.page|page_number|PDF page \{\}/.test(lineText)) f.push('page');
        if (/args\.match_page_size|page_dims|matching page|libviprs::resize::downscale_to|page_info|pdf_info\(&path\)|width_pts|height_pts|Resizing/.test(lineText)) {
          f.push('match-page-size');
        }
        seen = {}; out = [];
        f.forEach(function (x) { if (!seen[x]) { seen[x] = 1; out.push(x); } });
        return out;
      case 'sink-fs':
        if (/manifest_emit_checksums|with_checksums.*checksum_algo/.test(lineText)) {
          return ['manifest-emit-checksums', 'checksum-algo'];
        }
        if (/with_format|tile_format/.test(lineText)) return ['format'];
        if (/with_manifest|manifest_builder/.test(lineText)) return ['manifest-emit-checksums'];
        if (/build_dedupe_strategy|with_dedupe\(ds\)/.test(lineText)) return ['dedupe-blanks'];
        if (/args\.resume|with_resume/.test(lineText)) return ['resume'];
        return [];
      case 'engine-config':
        if (/with_concurrency/.test(lineText)) return ['concurrency'];
        if (/with_buffer_size/.test(lineText)) return ['buffer-size'];
        if (/with_blank_tile_strategy|blank_strategy/.test(lineText)) return ['skip-blank'];
        if (/with_failure_policy|failure_policy/.test(lineText)) return ['failure-policy'];
        if (/dedupe_strategy|with_dedupe_strategy/.test(lineText)) return ['dedupe-blanks'];
        return [];
      case 'engine-builder':
        if (/with_engine\(engine_kind\)/.test(lineText)) return ['parallel'];
        if (/with_concurrency/.test(lineText)) return ['concurrency'];
        if (/with_buffer_size/.test(lineText)) return ['buffer-size'];
        if (/with_blank_strategy|blank_tile_strategy/.test(lineText)) return ['skip-blank'];
        if (/with_failure_policy/.test(lineText)) return ['failure-policy'];
        if (/with_dedupe|dedupe_strategy/.test(lineText)) return ['dedupe-blanks'];
        if (/memory_budget|with_memory_budget|BudgetPolicy/.test(lineText)) return ['memory-budget'];
        return [];
      case 'finish':
      case 'sink-s3':
      case 'sink-packfile':
      default:
        return [];
    }
  }

  // Returns {
  //   rust, cli, count,
  //   rustLines: [{ text, flags }, …],
  //   activeFlags: [name, …],     // order: FLAGS key order, then any extras
  //   flagColors: { name: 'hsl(...)' },
  // } for the current flag selection.
  //
  // `prog.rust` is byte-identical to what the previous string-only generator
  // produced; `rustLines` is the per-line decomposition with flag attribution
  // so consumers (e.g. CodeGutter) can paint a colored bar per line.
  function renderFullProgram() {
    var snippets = window.VIPRS_SNIPPETS;
    if (!snippets) {
      return {
        rust: '', cli: '', count: 0,
        rustLines: [], activeFlags: [], flagColors: ensureFlagColors()
      };
    }

    // Per-line collector. `pushLine` is the single entry point for emitting
    // an output line — it normalises the `flags` argument and records both
    // the text and its attribution.
    var rustLines = [];
    function pushLine(text, flags, removed) {
      var f;
      if (flags == null) f = [];
      else if (Array.isArray(flags)) f = flags;
      else f = [flags];
      rustLines.push({ text: text, flags: f, removed: !!removed });
    }
    function pushAttributed(items) {
      // items: [{ text, flags, removed? }] — already-attributed lines from
      // a slot rendering pass. `removed` propagates so override-displaced
      // lines render as strikethrough ghosts and stay out of prog.rust.
      items.forEach(function (it) { pushLine(it.text, it.flags, it.removed); });
    }

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
    // Param key: prefer `param_name` (the canonical field in
    // snippets.generated.json) and fall back to `param` for legacy data.
    function paramKey(def) { return def && (def.param_name || def.param); }

    var liveParams = {};
    active.forEach(function (a) {
      var k = paramKey(a.def);
      if (k) {
        liveParams[k] = a.def.options ? variantFor(a.value, liveParams) : a.value;
      }
    });
    // Fold defaults for any inactive flag with a param so slot lines that
    // reference (say) {tile-size} render even when the user didn't check
    // --tile-size.
    Object.keys(snippets.flags || {}).forEach(function (name) {
      var f = snippets.flags[name];
      var k = paramKey(f);
      if (!k) return;
      if (Object.prototype.hasOwnProperty.call(liveParams, k)) return;
      liveParams[k] = f.options ? variantFor(f.default, liveParams) : (f.default != null ? f.default : '');
    });

    var extraImports = {}; // populated below for sink override side-effects

    // Render each slot in declared order. Each slot produces an array of
    // attributed `{text, flags}` lines.
    var slotOrder = snippets.slot_order || [];
    var renderedSlots = []; // [[ {text, flags}, … ], …]
    var activeNames = {};
    active.forEach(function (a) { activeNames[a.name] = true; });

    slotOrder.forEach(function (slotName) {
      var slot = snippets.slots && snippets.slots[slotName];
      if (!slot) return;

      // Gated slots only render when at least one of their gating flags
      // is checked. Without this, slots like `memory-limit`, `geo`, and
      // `tracing-init` would always emit their default-substituted code
      // even when no related flag was selected — confusing for users
      // who expect "no flags = minimum viable program".
      if (slot.gated_by && slot.gated_by.length) {
        var on = slot.gated_by.some(function (g) { return activeNames[g]; });
        if (!on) return;
      }

      var assigned = bySlot[slotName];

      // Override wins outright. If multiple, last one wins (deterministic
      // by source order; in practice we expect at most one override per slot).
      // We also emit the *original* slot body as ghost lines (`removed: true`)
      // so the user can see what the flag displaced. Ghost lines are rendered
      // struck-through and excluded from prog.rust (and therefore from the
      // copy-to-clipboard text).
      if (assigned && assigned.overrides.length) {
        var override = assigned.overrides[assigned.overrides.length - 1];
        var ghostLines = (slot.lines || []).map(function (rawLine) {
          return { text: substitute(rawLine, liveParams), flags: [override.name], removed: true };
        });
        // Sink override is special-cased — see resolveSinkOverride.
        if (override.def.special === 'sink-override' || override.name === 'sink') {
          var sinkResult = resolveSinkOverride(override, snippets);
          if (sinkResult) {
            var sinkLines = sinkResult.body.split('\n').map(function (ln) {
              return { text: ln, flags: ['sink'], removed: false };
            });
            renderedSlots.push(ghostLines.concat(sinkLines));
            sinkResult.imports.forEach(function (imp) { extraImports[imp] = true; });
            return;
          }
        }
        var overrideText = substitute(override.def.fragment || '', mergeParams(liveParams, paramsForFlag(override.def, override.value)));
        var overrideLines = overrideText.split('\n').map(function (ln) {
          return { text: ln, flags: [override.name], removed: false };
        });
        renderedSlots.push(ghostLines.concat(overrideLines));
        return;
      }

      // Base body (slot.lines), with placeholder substitution and per-line
      // attribution. We attribute by scanning the *raw* line for `{name}`
      // placeholders before substitution — looking up which flag uses each
      // param name. This is template-correct: a line like `    {tile-size},`
      // belongs to whichever flag has `param_name: "tile-size"`. After
      // substitution the placeholder becomes a literal value, so a regex
      // run over the substituted text wouldn't be able to attribute it.
      var bodyLines = (slot.lines || []).map(function (rawLine) {
        var flags = flagsForRawLine(rawLine, snippets);
        // Fall back to the legacy regex-based attribution if no placeholder
        // matched — keeps old hand-authored slot bodies (e.g. literal CLI
        // source) working in case the JSON drifts.
        if (!flags.length) flags = attributeBaseLine(slotName, rawLine);
        var text = substitute(rawLine, liveParams);
        return { text: text, flags: flags };
      });

      // appendChain: each chain piece slots onto the trailing `;` of the
      // body. Practically: `EngineConfig::default();` becomes
      //   EngineConfig::default()
      //       .with_x(...)
      //       ;
      // We trim the last `;` (and any preceding whitespace), append the
      // chain pieces (each as `    .with_X(...)`), then re-emit `;`.
      if (assigned && assigned.chains.length) {
        bodyLines = applyAppendChainAttributed(bodyLines, assigned.chains, liveParams);
      }

      // append: simple line-level concatenation after the slot body.
      if (assigned && assigned.appends.length) {
        assigned.appends.forEach(function (a) {
          var rendered = substitute(a.def.fragment || '', mergeParams(liveParams, paramsForFlag(a.def, a.value)));
          rendered.split('\n').forEach(function (ln) {
            bodyLines.push({ text: ln, flags: [a.name] });
          });
        });
      }

      renderedSlots.push(bodyLines);
    });

    // Imports: union of imports_base + each active flag's imports_when_active.
    var importsSet = {};
    (snippets.imports_base || []).forEach(function (s) { importsSet[s] = true; });
    active.forEach(function (a) {
      (a.def.imports_when_active || []).forEach(function (s) { importsSet[s] = true; });
    });
    Object.keys(extraImports).forEach(function (s) { importsSet[s] = true; });
    var imports = Object.keys(importsSet).sort();

    // Filter empty slots (so the join-with-blank-line spacing matches the
    // previous string-based output exactly). Then interleave a blank line
    // between non-empty slots — same as the old `join('\n\n')`.
    var nonEmpty = renderedSlots.filter(function (s) {
      return s && s.length && s.some(function (it) { return it.text && it.text.length; });
    });

    // Build the indented inner body with attribution carried through.
    var innerLines = []; // [{ text, flags }] — already 4-space-indented where appropriate
    nonEmpty.forEach(function (slotItems, idx) {
      if (idx > 0) innerLines.push({ text: '', flags: [] }); // blank separator
      slotItems.forEach(function (it) {
        var t = it.text.length ? '    ' + it.text : it.text;
        innerLines.push({ text: t, flags: it.flags });
      });
    });

    // Emit the full program through pushLine so rustLines mirrors prog.rust.
    pushLine('use libviprs::{' + imports.join(', ') + '};', []);
    pushLine('use std::path::PathBuf;', []);
    pushLine('', []);
    pushLine('fn main() -> Result<(), Box<dyn std::error::Error>> {', []);
    pushLine('    let input = PathBuf::from("/path/to/your/input.pdf");', []);
    pushLine('    let output = PathBuf::from("./tiles");', []);
    // Mirror the original template's spacing exactly:
    //   …let output = …;\n          (always)
    //   \nINNER\n                    (only if INNER non-empty)
    //   \n                            (always — blank line before Ok)
    //   Ok(())\n                     (always)
    //   }\n                           (always — final newline)
    if (innerLines.length) {
      pushLine('', []);
      pushAttributed(innerLines);
    }
    pushLine('', []);
    pushLine('    Ok(())', []);
    pushLine('}', []);
    // Trailing newline: rustLines.map(text).join('\n') produces no trailing
    // '\n' on its own. Append one empty entry so the joined string ends in
    // '\n', matching the original template's `'}\n'`.
    pushLine('', []);

    // prog.rust is the canonical clipboard / copy-to-paste string — it
    // EXCLUDES ghost lines (`removed: true`) so the user pastes only the
    // program that actually runs. The full rustLines array (including
    // ghosts) is what the row renderer iterates over for visual output.
    var rust = rustLines
      .filter(function (l) { return !l.removed; })
      .map(function (l) { return l.text; }).join('\n');

    // CLI command.
    var parts = ['viprs pyramid input.pdf tiles/'];
    active.forEach(function (a) {
      if (!a.def.cli) return;
      parts.push(substitute(a.def.cli, { v: a.value, value: a.value }));
    });
    var cli = parts.join(' ');

    // activeFlags ordered by FLAGS key order (i.e. snippets.flags key order),
    // so colors line up with the gutter's natural sort.
    var flagsKeyOrder = Object.keys(snippets.flags || {});
    var activeNames = {};
    active.forEach(function (a) { activeNames[a.name] = true; });
    var activeFlags = flagsKeyOrder.filter(function (n) { return activeNames[n]; });
    // (Defensive) include any active name not present in FLAGS at the tail.
    active.forEach(function (a) {
      if (activeFlags.indexOf(a.name) === -1) activeFlags.push(a.name);
    });

    return {
      rust: rust,
      cli: cli,
      count: active.length,
      rustLines: rustLines,
      activeFlags: activeFlags,
      flagColors: ensureFlagColors()
    };
  }

  function mergeParams(a, b) {
    var out = {};
    for (var k in a) if (Object.prototype.hasOwnProperty.call(a, k)) out[k] = a[k];
    for (var k2 in b) if (Object.prototype.hasOwnProperty.call(b, k2)) out[k2] = b[k2];
    return out;
  }

  // Attributed twin of applyAppendChain. Operates on [{text, flags}] line
  // arrays so chain pieces carry their owning flag's name into the gutter.
  // Mirrors the string version's transformation byte-for-byte: locate the
  // last `;` in the joined body, split there, re-emit each chain fragment
  // as `    .with_X(...)`, then a closing `    ;` line.
  function applyAppendChainAttributed(bodyLines, chains, params) {
    if (!bodyLines || !bodyLines.length) {
      var only = [];
      chains.forEach(function (c) {
        var rendered = substitute(c.def.fragment || '', mergeParams(params, paramsForFlag(c.def, c.value)));
        rendered.split('\n').forEach(function (ln) {
          only.push({ text: ln, flags: [c.name] });
        });
      });
      return only;
    }

    // Find the last bodyLine containing `;`. We need to split at the same
    // textual boundary as the string-mode applyAppendChain to preserve
    // byte-for-byte equivalence.
    var lastSemiIdx = -1;
    var semiCol = -1;
    for (var i = bodyLines.length - 1; i >= 0; i--) {
      var col = bodyLines[i].text.lastIndexOf(';');
      if (col !== -1) { lastSemiIdx = i; semiCol = col; break; }
    }
    if (lastSemiIdx === -1) {
      // No `;` anywhere — append chains as plain lines.
      var out = bodyLines.slice();
      chains.forEach(function (c) {
        var rendered = substitute(c.def.fragment || '', mergeParams(params, paramsForFlag(c.def, c.value)));
        rendered.split('\n').forEach(function (ln) {
          out.push({ text: ln, flags: [c.name] });
        });
      });
      return out;
    }

    // Build the head: lines before lastSemiIdx, plus the prefix of the
    // last-semi line up to (but not including) the `;`. Match the string
    // mode's `replace(/\s+$/, '')` on the joined head — when the line has
    // no non-ws content before `;`, drop it; otherwise trim trailing ws.
    var headLines = bodyLines.slice(0, lastSemiIdx).map(function (it) {
      return { text: it.text, flags: it.flags.slice() };
    });
    var lastLineText = bodyLines[lastSemiIdx].text;
    var lastLineFlags = bodyLines[lastSemiIdx].flags;
    var beforeSemi = lastLineText.slice(0, semiCol);
    var afterSemi = lastLineText.slice(semiCol + 1);

    // Mimic head = (prevText + '\n' + beforeSemi).replace(/\s+$/, '').
    // If beforeSemi is whitespace-only, the trim eats it AND any preceding
    // newline — i.e. drop the line entirely from head, then trim trailing ws
    // off the new last line.
    if (/^\s*$/.test(beforeSemi)) {
      // drop lastSemiIdx line; trim trailing ws on the new last head line.
      while (headLines.length && /^\s*$/.test(headLines[headLines.length - 1].text)) {
        headLines.pop();
      }
      if (headLines.length) {
        var tl = headLines[headLines.length - 1];
        tl.text = tl.text.replace(/\s+$/, '');
      }
    } else {
      headLines.push({ text: beforeSemi.replace(/\s+$/, ''), flags: lastLineFlags.slice() });
    }

    // Chain pieces.
    var pieces = [];
    chains.forEach(function (c) {
      var rendered = substitute(c.def.fragment || '', mergeParams(params, paramsForFlag(c.def, c.value)));
      // Each fragment is expected to be a single `.with_x(...)` call. Indent
      // by four spaces relative to the start of the chained expression. The
      // string-mode version applies `'    ' + rendered.replace(/^\s+/, '')`.
      var stripped = rendered.replace(/^\s+/, '');
      pieces.push({ text: '    ' + stripped, flags: [c.name] });
    });

    // Closing `    ;` line — base scaffolding, not attributable to a flag.
    var closer = { text: '    ;' + afterSemi, flags: [] };

    // Tail: any body lines that came AFTER the last-semi line. The string-
    // mode applyAppendChain preserves these because it operates on the
    // joined body and only splits at the final `;` character — content
    // after that `;` (including subsequent newlines and lines) flows into
    // the result unchanged.
    var tailLines = bodyLines.slice(lastSemiIdx + 1).map(function (it) {
      return { text: it.text, flags: it.flags.slice() };
    });

    return headLines.concat(pieces, [closer], tailLines);
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
  function genRustCode()  { return document.getElementById('genRustRows'); }

  // Render the full rust program as one DOM row per line, so the gutter can
  // align flag-attribution markers to individual lines. The base-setup mirror
  // (#pyramid-base-code) keeps using paintCodeEl — it's a single <pre><code>.
  function renderRustRows(rowsEl, rustLines) {
    if (!rowsEl) return;
    rowsEl.innerHTML = '';
    (rustLines || []).forEach(function (line, i) {
      var row = document.createElement('div');
      row.className = 'code-row';
      // Override-displaced lines are kept visible as struck-through
      // "ghosts" so the user can see what the flag replaced. They are
      // excluded from prog.rust so the clipboard text reflects the
      // actual program.
      if (line.removed) row.classList.add('is-removed');
      row.setAttribute('role', 'listitem');
      row.dataset.line = String(i + 1);

      var num = document.createElement('span');
      num.className = 'line-num';
      num.setAttribute('aria-hidden', 'true');
      num.textContent = String(i + 1);

      var code = document.createElement('code');
      code.className = 'line-content language-rust';
      // highlightRust returns HTML with <span class="r-…"> tokens.
      code.innerHTML = highlightRust(line.text || '');

      row.appendChild(num);
      row.appendChild(code);
      rowsEl.appendChild(row);
    });
  }
  function summaryEl()    { var g = generatorEl(); return g && g.querySelector('.summary'); }
  function baseCodeEl()   { return document.getElementById('pyramid-base-code'); }

  // Cached copy of the most recent prog.rust string. The floating copy button
  // reads this instead of re-running renderFullProgram() on every click — the
  // string is regenerated on every flag toggle anyway via updateGenerator().
  var lastRustText = '';

  function updateGenerator() {
    var prog = renderFullProgram();
    var rowsEl = genRustCode();
    var cliOut = genCliCode();
    var summary = summaryEl();
    lastRustText = prog.rust;
    if (rowsEl) renderRustRows(rowsEl, prog.rustLines);
    // Hand the per-line attribution to CodeGutter (loaded as a separate
    // script). Wrapped so a gutter bug never breaks the generator panel.
    try {
      if (window.CodeGutter && window.CodeGutter.update) {
        window.CodeGutter.update(prog);
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[viprs cli] CodeGutter.update threw:', e);
    }
    if (cliOut) cliOut.textContent = prog.cli;
    if (summary) {
      summary.textContent = prog.count === 0
        ? 'No flags selected. Check boxes above to assemble a CLI command and a complete Rust program.'
        : (prog.count + ' flag' + (prog.count === 1 ? '' : 's') + ' selected. Edit input/output paths in the program below.');
    }

    // Floating copy button: only show once at least one flag is checked.
    // The button is `position: fixed` (lives in the viewport corner), so
    // showing it when there's nothing meaningful to copy would just be
    // visual noise.
    var floatingCopy = document.getElementById('genRustCopyFloating');
    if (floatingCopy) {
      floatingCopy.classList.toggle('is-active', prog.count > 0);
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

    // Floating copy button on the gen-rust row stack. Reads from the cached
    // lastRustText (kept fresh by updateGenerator) and swaps the <i> icon
    // class for ~1.5 s on success.
    var rustCopyFloating = document.getElementById('genRustCopyFloating');
    if (rustCopyFloating) {
      rustCopyFloating.addEventListener('click', function () {
        if (!navigator.clipboard) return;
        navigator.clipboard.writeText(lastRustText || '').then(function () {
          var icon = rustCopyFloating.querySelector('i');
          if (!icon) return;
          var prevClass = icon.className;
          icon.className = 'fa-solid fa-check';
          setTimeout(function () { icon.className = prevClass; }, 1500);
        }).catch(function () { /* silent */ });
      });
    }

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

  // ---------------------------------------------------------------------------
  // 10. How-to info bubble (top of page, auto-collapse after 10s)
  // ---------------------------------------------------------------------------

  function initInfoBubble() {
    var bubble = document.getElementById('how-to-bubble');
    if (!bubble) return;
    var icon = bubble.querySelector('.info-bubble-icon');
    var timerEl = bubble.querySelector('.info-bubble-timer');
    var COUNTDOWN_S = 10;
    var tickHandle = null;

    function setState(state) {
      bubble.dataset.state = state;
      if (icon) icon.setAttribute('aria-expanded', state === 'open' ? 'true' : 'false');
      if (state !== 'open' && tickHandle !== null) {
        clearInterval(tickHandle);
        tickHandle = null;
      }
    }

    function startCountdown() {
      var remaining = COUNTDOWN_S;
      if (timerEl) timerEl.textContent = remaining;
      if (tickHandle !== null) clearInterval(tickHandle);
      tickHandle = setInterval(function () {
        remaining -= 1;
        if (timerEl) timerEl.textContent = remaining > 0 ? remaining : 0;
        if (remaining <= 0) {
          clearInterval(tickHandle);
          tickHandle = null;
          setState('closed');
        }
      }, 1000);
    }

    if (icon) {
      icon.addEventListener('click', function () {
        if (bubble.dataset.state === 'open') {
          setState('closed');
        } else {
          setState('open');
          startCountdown();
        }
      });
    }

    // Pause the countdown while the user hovers, so reading the bubble
    // doesn't get yanked out from under them.
    bubble.addEventListener('mouseenter', function () {
      if (tickHandle !== null) {
        clearInterval(tickHandle);
        tickHandle = null;
      }
    });
    bubble.addEventListener('mouseleave', function () {
      if (bubble.dataset.state === 'open' && tickHandle === null) startCountdown();
    });

    startCountdown();
  }

  ready(function () {
    initDelegatedCopyButtons();
    initBaseSetupToggles();
    paintStaticRustBlocks();
    initInfoBubble();

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
