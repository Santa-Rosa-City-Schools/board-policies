(() => {
  "use strict";

  const state = {
    slug: null,
    index: null,
    policyCache: new Map(),
    activeId: null,
    fulltext: null,
    fulltextPromise: null,
    expandedGroups: new Set(),
  };

  const el = {
    eyebrow: document.getElementById("institution-eyebrow"),
    name: document.getElementById("institution-name"),
    search: document.getElementById("search"),
    fulltextToggle: document.getElementById("search-fulltext"),
    list: document.getElementById("policy-list"),
    detail: document.getElementById("detail"),
    layout: document.getElementById("layout"),
    toggleSidebar: document.getElementById("toggle-sidebar"),
    toggleTheme: document.getElementById("toggle-theme"),
  };

  function escapeHtml(s) {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  // ---- theme switch ---------------------------------------------------------

  const THEME_KEY = "policyArchive.theme";

  function systemPrefersDark() {
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  }

  function applyTheme(theme) {
    if (theme === "light" || theme === "dark") {
      document.documentElement.setAttribute("data-theme", theme);
    } else {
      document.documentElement.removeAttribute("data-theme");
    }
    const effectiveDark = theme === "dark" || (theme !== "light" && systemPrefersDark());
    el.toggleTheme.textContent = effectiveDark ? "Light" : "Dark";
  }

  function initTheme() {
    let stored = null;
    try { stored = localStorage.getItem(THEME_KEY); } catch (err) { /* ignore */ }
    applyTheme(stored);
  }

  el.toggleTheme.addEventListener("click", () => {
    const current = document.documentElement.getAttribute("data-theme");
    const effectiveDark = current === "dark" || (!current && systemPrefersDark());
    const next = effectiveDark ? "light" : "dark";
    try { localStorage.setItem(THEME_KEY, next); } catch (err) { /* ignore */ }
    applyTheme(next);
  });

  // ---- sidebar visibility -----------------------------------------------------

  const SIDEBAR_KEY = "policyArchive.sidebarCollapsed";

  function setSidebarCollapsed(collapsed) {
    el.layout.classList.toggle("sidebar-collapsed", collapsed);
    el.toggleSidebar.textContent = collapsed ? "Show list" : "Hide list";
  }

  function initSidebar() {
    let collapsed = false;
    try { collapsed = localStorage.getItem(SIDEBAR_KEY) === "1"; } catch (err) { /* ignore */ }
    setSidebarCollapsed(collapsed);
  }

  el.toggleSidebar.addEventListener("click", () => {
    const collapsed = !el.layout.classList.contains("sidebar-collapsed");
    setSidebarCollapsed(collapsed);
    try { localStorage.setItem(SIDEBAR_KEY, collapsed ? "1" : "0"); } catch (err) { /* ignore */ }
  });

  // ---- clipboard ---------------------------------------------------------

  async function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch (err) { /* fall through to legacy path */ }
    }
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      return true;
    } catch (err) {
      return false;
    }
  }

  // ---- deep links ---------------------------------------------------------
  // Hash shape: #<slug>/<policyId>/<viewingIndex>[/<compareIndex>]

  function parseHash() {
    const raw = location.hash.replace(/^#/, "");
    if (!raw) return null;
    const parts = raw.split("/").map((p) => decodeURIComponent(p));
    if (parts.length < 2 || !parts[0] || !parts[1]) return null;
    const result = { slug: parts[0], policyId: parts[1] };
    if (parts[2] !== undefined && parts[2] !== "") result.viewingIndex = Number(parts[2]);
    if (parts[3] !== undefined && parts[3] !== "") result.compareIndex = Number(parts[3]);
    return result;
  }

  function syncHash(policyId, viewingIndex, compareIndex) {
    let hash = `#${encodeURIComponent(state.slug)}/${encodeURIComponent(policyId)}/${viewingIndex}`;
    if (compareIndex !== null && compareIndex !== undefined) hash += `/${compareIndex}`;
    history.replaceState(null, "", hash);
  }

  // ---- Myers diff over an arbitrary token array ---------------------------
  // Returns an ordered list of {type: 'equal'|'add'|'del', token} — one entry
  // per input token (not coalesced), so callers can re-group runs as needed.

  function myersDiff(a, b) {
    const n = a.length, m = b.length;
    const max = n + m;
    if (max === 0) return [];
    const v = new Map([[1, 0]]);
    const trace = [];

    for (let d = 0; d <= max; d++) {
      trace.push(new Map(v));
      for (let k = -d; k <= d; k += 2) {
        let x;
        if (k === -d || (k !== d && v.get(k - 1) < v.get(k + 1))) {
          x = v.get(k + 1);
        } else {
          x = v.get(k - 1) + 1;
        }
        let y = x - k;
        while (x < n && y < m && a[x] === b[y]) { x++; y++; }
        v.set(k, x);
        if (x >= n && y >= m) {
          return backtrack(trace, a, b, d);
        }
      }
    }
    return a.map((token) => ({ type: "equal", token }));
  }

  function backtrack(trace, a, b, d) {
    let x = a.length, y = b.length;
    const ops = [];
    for (let depth = d; depth > 0; depth--) {
      const v = trace[depth];
      const k = x - y;
      let prevK;
      if (k === -depth || (k !== depth && v.get(k - 1) < v.get(k + 1))) {
        prevK = k + 1;
      } else {
        prevK = k - 1;
      }
      const prevX = v.get(prevK);
      const prevY = prevX - prevK;

      while (x > prevX && y > prevY) {
        ops.push({ type: "equal", token: a[x - 1] });
        x--; y--;
      }
      if (x > prevX) {
        ops.push({ type: "del", token: a[x - 1] });
        x--;
      } else if (y > prevY) {
        ops.push({ type: "add", token: b[y - 1] });
        y--;
      }
    }
    while (x > 0 && y > 0) {
      ops.push({ type: "equal", token: a[x - 1] });
      x--; y--;
    }
    ops.reverse();
    return ops;
  }

  function coalesce(ops) {
    const out = [];
    for (const op of ops) {
      const last = out[out.length - 1];
      if (last && last.type === op.type) {
        last.value += op.token;
      } else {
        out.push({ type: op.type, value: op.token });
      }
    }
    return out;
  }

  // ---- lightweight markdown rendering --------------------------------------
  // Policy text uses a small, consistent subset of markdown: **bold** section
  // labels, occasional *italic* labels, (possibly nested) numbered/bulleted
  // lists as nakedly-indented blocks, and occasional GFM pipe tables (which
  // sometimes use literal "<br>" inside a cell for a manual line break). No
  // headers or links appear in scraped policy bodies, so we don't handle those.

  function inlineMarkdown(escapedText) {
    return escapedText
      .replace(/\*\*([^*]+?)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, "$1<em>$2</em>");
  }

  const LIST_ITEM_RE = /^(\s*)([-*]|\d+\.)\s+(.*)$/;

  function isListParagraph(text) {
    const lines = text.split("\n").filter((l) => l.trim() !== "");
    return lines.length > 0 && lines.every((l) => LIST_ITEM_RE.test(l));
  }

  function parseListTree(text) {
    const lines = text.split("\n").filter((l) => l.trim() !== "");
    const root = [];
    const stack = [{ indent: -1, children: root }];
    for (const raw of lines) {
      const m = raw.match(LIST_ITEM_RE);
      if (!m) continue;
      const indent = m[1].length;
      const ordered = /^\d+\./.test(m[2]);
      while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
      const node = { ordered, text: m[3], children: [] };
      stack[stack.length - 1].children.push(node);
      stack.push({ indent, children: node.children });
    }
    return root;
  }

  function renderListTree(nodes) {
    if (!nodes.length) return "";
    const tag = nodes[0].ordered ? "ol" : "ul";
    let html = `<${tag}>`;
    for (const node of nodes) {
      html += `<li>${inlineMarkdown(escapeHtml(node.text))}${renderListTree(node.children)}</li>`;
    }
    html += `</${tag}>`;
    return html;
  }

  const TABLE_ROW_RE = /^\s*\|(.+)\|\s*$/;
  const TABLE_SEPARATOR_CELL_RE = /^:?-{3,}:?$/;

  function splitTableRow(line) {
    return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
  }

  function isTableParagraph(text) {
    const lines = text.split("\n").filter((l) => l.trim() !== "");
    if (lines.length < 2 || !lines.every((l) => TABLE_ROW_RE.test(l))) return false;
    const sepCells = splitTableRow(lines[1]);
    return sepCells.length > 0 && sepCells.every((c) => TABLE_SEPARATOR_CELL_RE.test(c));
  }

  // Scraped tables sometimes use a literal "<br>" inside a cell as a manual
  // line break — split on it first so each fragment still gets escaped and
  // markdown-interpreted independently, then rejoin with a real <br>.
  function renderTableCell(text) {
    return text
      .split(/<br\s*\/?>/i)
      .map((part) => inlineMarkdown(escapeHtml(part.trim())))
      .join("<br>");
  }

  function renderTable(text) {
    const lines = text.split("\n").filter((l) => l.trim() !== "");
    const headerCells = splitTableRow(lines[0]);
    let html = "<table><thead><tr>";
    for (const cell of headerCells) html += `<th>${renderTableCell(cell)}</th>`;
    html += "</tr></thead><tbody>";
    for (const line of lines.slice(2)) {
      html += "<tr>";
      for (const cell of splitTableRow(line)) html += `<td>${renderTableCell(cell)}</td>`;
      html += "</tr>";
    }
    html += "</tbody></table>";
    return `<div class="table-wrap">${html}</div>`;
  }

  function renderMarkdownParagraph(text) {
    if (isTableParagraph(text)) return renderTable(text);
    if (isListParagraph(text)) return renderListTree(parseListTree(text));
    const withBreaks = inlineMarkdown(escapeHtml(text)).replace(/\n/g, "<br>");
    return `<p>${withBreaks}</p>`;
  }

  function renderMarkdown(body) {
    return splitParagraphs(body).map(renderMarkdownParagraph).join("");
  }

  // ---- word-level diff -----------------------------------------------------

  function tokenizeWords(text) {
    return text.match(/\s+|[^\s]+/g) || [];
  }

  function wordDiffHtml(oldText, newText) {
    const ops = coalesce(myersDiff(tokenizeWords(oldText), tokenizeWords(newText)));
    let html = "";
    for (const op of ops) {
      const safe = escapeHtml(op.value);
      if (op.type === "equal") html += safe;
      else if (op.type === "add") html += `<ins>${safe}</ins>`;
      else if (op.type === "del") html += `<del>${safe}</del>`;
    }
    // Not markdown-aware (bold/italic markers could straddle an ins/del
    // boundary and corrupt the tags above) — just preserve line breaks.
    return html.replace(/\n/g, "<br>");
  }

  // ---- paragraph-level diff, with inline word diff for close rewrites ------
  // Paragraphs are diffed as opaque units first so an edited paragraph reads
  // as one coherent change instead of a scramble of matched words scattered
  // across unrelated paragraphs. Within a run of replaced paragraphs, a
  // deleted/inserted pair is shown as an inline word diff only when the two
  // paragraphs still share a reasonable fraction of their words; otherwise
  // they're shown as whole removed/added blocks.

  function splitParagraphs(text) {
    return text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  }

  function wordSet(text) {
    return new Set(text.toLowerCase().match(/[a-z0-9']+/g) || []);
  }

  function similarity(a, b) {
    const sa = wordSet(a), sb = wordSet(b);
    if (sa.size === 0 && sb.size === 0) return 1;
    let intersection = 0;
    for (const w of sa) if (sb.has(w)) intersection++;
    return (2 * intersection) / (sa.size + sb.size || 1);
  }

  const SIMILARITY_THRESHOLD = 0.35;

  function renderParagraphBlock(text, type) {
    const cls = type === "del" ? "diff-para-del" : "diff-para-add";
    return `<div class="${cls}">${renderMarkdownParagraph(text)}</div>`;
  }

  function renderParagraphRun(dels, adds) {
    let html = "";
    const pairCount = Math.min(dels.length, adds.length);
    for (let i = 0; i < pairCount; i++) {
      if (similarity(dels[i], adds[i]) >= SIMILARITY_THRESHOLD) {
        html += `<p>${wordDiffHtml(dels[i], adds[i])}</p>`;
      } else {
        html += renderParagraphBlock(dels[i], "del");
        html += renderParagraphBlock(adds[i], "add");
      }
    }
    for (let i = pairCount; i < dels.length; i++) html += renderParagraphBlock(dels[i], "del");
    for (let i = pairCount; i < adds.length; i++) html += renderParagraphBlock(adds[i], "add");
    return html;
  }

  function renderDiff(oldText, newText) {
    const ops = myersDiff(splitParagraphs(oldText), splitParagraphs(newText));
    let html = "";
    let i = 0;
    while (i < ops.length) {
      if (ops[i].type === "equal") {
        html += renderMarkdownParagraph(ops[i].token);
        i++;
        continue;
      }
      const dels = [];
      const adds = [];
      while (i < ops.length && ops[i].type === "del") { dels.push(ops[i].token); i++; }
      while (i < ops.length && ops[i].type === "add") { adds.push(ops[i].token); i++; }
      html += renderParagraphRun(dels, adds);
    }
    return html;
  }

  // ---- data loading --------------------------------------------------------

  async function fetchJson(path) {
    const res = await fetch(path);
    if (!res.ok) throw new Error(`Failed to load ${path}`);
    return res.json();
  }

  async function loadInstitution(slug) {
    state.slug = slug;
    state.index = await fetchJson(`data/${slug}/index.json`);
    state.fulltext = null;
    state.fulltextPromise = null;
    state.expandedGroups = new Set();
    el.fulltextToggle.checked = false;
    el.eyebrow.textContent = "BOARD POLICY ARCHIVE";
    el.name.textContent = state.index.institution_name;
    renderList("");
  }

  function ensureFulltextLoaded() {
    if (state.fulltext) return Promise.resolve(state.fulltext);
    if (state.fulltextPromise) return state.fulltextPromise;
    state.fulltextPromise = fetchJson(`data/${state.slug}/fulltext.json`)
      .then((rows) => {
        const map = new Map(rows.map((r) => [r.id, r.text]));
        state.fulltext = map;
        return map;
      })
      .catch((err) => {
        console.error(err);
        state.fulltext = new Map();
        return state.fulltext;
      });
    return state.fulltextPromise;
  }

  async function loadPolicy(id) {
    if (state.policyCache.has(id)) return state.policyCache.get(id);
    const detail = await fetchJson(`data/${state.slug}/policies/${id}.json`);
    state.policyCache.set(id, detail);
    return detail;
  }

  // ---- rendering ------------------------------------------------------------

  function renderList(filterText) {
    const q = filterText.trim().toLowerCase();
    const isSearching = q.length > 0;
    const fulltextMode = el.fulltextToggle.checked;
    if (fulltextMode && !state.fulltext) {
      el.list.innerHTML = `<div class="no-results">Loading full text search index&hellip;</div>`;
      return;
    }

    const byGroup = new Map();
    for (const g of state.index.groups) byGroup.set(g.key, { label: g.label, items: [] });

    for (const p of state.index.policies) {
      let haystack = `${p.code} ${p.title} ${p.type}`.toLowerCase();
      if (fulltextMode) haystack += " " + (state.fulltext.get(p.id) || "").toLowerCase();
      if (q && !haystack.includes(q)) continue;
      if (!byGroup.has(p.group)) byGroup.set(p.group, { label: p.group, items: [] });
      byGroup.get(p.group).items.push(p);
    }

    const groupKeys = [...byGroup.keys()].sort();
    let html = "";
    let total = 0;
    for (const key of groupKeys) {
      const group = byGroup.get(key);
      if (group.items.length === 0) continue;
      total += group.items.length;
      const expanded = isSearching || state.expandedGroups.has(key);
      html += `<div class="group-block">`;
      html += `<button type="button" class="group-label" data-group="${escapeHtml(key)}" aria-expanded="${expanded}">`;
      html += `<span class="caret">▸</span>${escapeHtml(group.label)} <span class="group-count">(${group.items.length})</span>`;
      html += `</button>`;
      html += `<div class="group-items"${expanded ? "" : " hidden"}>`;
      for (const p of group.items) {
        const activeClass = p.id === state.activeId ? " active" : "";
        html += `<button class="policy-row${activeClass}" data-id="${p.id}">`;
        html += `<span class="code">${escapeHtml(p.code)}</span>${escapeHtml(p.title)}`;
        if (p.type) html += `<span class="badge">${escapeHtml(p.type)}</span>`;
        html += `</button>`;
      }
      html += `</div></div>`;
    }
    if (total === 0) html = `<div class="no-results">No policies match your search.</div>`;
    el.list.innerHTML = html;

    el.list.querySelectorAll(".group-label").forEach((btn) => {
      btn.addEventListener("click", () => {
        const key = btn.dataset.group;
        if (state.expandedGroups.has(key)) state.expandedGroups.delete(key);
        else state.expandedGroups.add(key);
        renderList(el.search.value);
      });
    });

    el.list.querySelectorAll(".policy-row").forEach((btn) => {
      btn.addEventListener("click", () => selectPolicy(btn.dataset.id));
    });
  }

  async function selectPolicy(id, initial) {
    state.activeId = id;
    const p = state.index.policies.find((x) => x.id === id);
    if (p) state.expandedGroups.add(p.group);
    renderList(el.search.value);
    const policy = await loadPolicy(id);
    renderDetail(policy, initial);
  }

  function revisionLabel(rev, isLatest) {
    const hasCustomMessage = rev.message && !/^Publish /.test(rev.message);
    const base = hasCustomMessage ? `${rev.date} — ${rev.message}` : rev.date;
    return isLatest ? `${base} (most recent)` : base;
  }

  // Renders <option> tags newest-first, keeping value = the revision's real
  // (oldest-first) index into the revisions array.
  function optionsForRevisions(revisions, excludeIndex) {
    const items = [];
    for (let i = revisions.length - 1; i >= 0; i--) {
      if (i === excludeIndex) continue;
      items.push(
        `<option value="${i}">${escapeHtml(revisionLabel(revisions[i], i === revisions.length - 1))}</option>`
      );
    }
    return items.join("");
  }

  function clampIndex(value, fallback, length) {
    const n = Number(value);
    if (Number.isInteger(n) && n >= 0 && n < length) return n;
    return fallback;
  }

  // ---- BP/AR quick switch ---------------------------------------------------
  // Board policies (BP) and their administrative regulations (AR) share the
  // same code, so the counterpart is just "the other type with this code."

  const PAIRED_TYPE = { BP: "AR", AR: "BP" };

  function findPairedPolicy(policy) {
    const targetType = PAIRED_TYPE[(policy.type || "").toUpperCase()];
    if (!targetType) return null;
    return (
      state.index.policies.find(
        (p) => p.code === policy.code && (p.type || "").toUpperCase() === targetType
      ) || null
    );
  }

  function renderDetail(policy, initial) {
    const revisions = policy.revisions;
    const hasMultiple = revisions.length > 1;
    const paired = findPairedPolicy(policy);

    let viewingIndex = clampIndex(
      initial && initial.viewingIndex,
      revisions.length - 1,
      revisions.length
    );
    let compareIndex = null;
    let comparing = false;
    if (hasMultiple && initial && initial.compareIndex !== undefined) {
      const ci = clampIndex(initial.compareIndex, null, revisions.length);
      if (ci !== null && ci !== viewingIndex) {
        compareIndex = ci;
        comparing = true;
      }
    }

    function renderHeaderInner() {
      const meta = revisions[viewingIndex];
      return (
        `<div class="policy-header-row">` +
        `<div class="eyebrow">${escapeHtml(policy.group)} · ${escapeHtml(policy.type || "POLICY")}</div>` +
        (paired
          ? `<button type="button" id="switch-pair" class="btn-chip">View ${escapeHtml(paired.type)}</button>`
          : "") +
        `</div>` +
        `<h2 class="policy-title">${escapeHtml(policy.code)} — ${escapeHtml(policy.title)}</h2>` +
        `<div class="meta-row">` +
        `<span><strong>Date last revised:</strong> ${escapeHtml(meta.date_last_revised || "—")}</span>` +
        `<span><strong>Date last reviewed:</strong> ${escapeHtml(meta.date_last_reviewed || "—")}</span>` +
        `<span><strong>Revisions on file:</strong> ${revisions.length}</span>` +
        (policy.source_url
          ? `<span><a href="${escapeHtml(policy.source_url)}" target="_blank" rel="noopener">Source ↗</a></span>`
          : "") +
        `</div>`
      );
    }

    el.detail.innerHTML =
      `<div class="policy-header" id="policy-header-slot">${renderHeaderInner()}</div>` +
      `<div class="version-bar">` +
      `<div class="version-control"><label for="view-version">Viewing version</label>` +
      `<select id="view-version">${optionsForRevisions(revisions)}</select></div>` +
      `<button type="button" id="copy-link" class="btn-outline">Copy link</button>` +
      (hasMultiple
        ? `<button type="button" id="toggle-compare" class="btn-outline">Show markings</button>`
        : "") +
      `</div>` +
      (hasMultiple
        ? `<div id="compare-bar" class="compare-bar" hidden>` +
          `<label for="compare-version">Compare to</label>` +
          `<select id="compare-version"></select>` +
          `<button type="button" id="exit-compare" class="btn-text">Hide markings</button>` +
          `</div>`
        : "") +
      `<div id="content-area" class="policy-body"></div>`;

    function attachSwitchPairButton() {
      if (!paired) return;
      const btn = document.getElementById("switch-pair");
      if (btn) btn.addEventListener("click", () => selectPolicy(paired.id));
    }

    const headerSlot = document.getElementById("policy-header-slot");
    const viewSelect = document.getElementById("view-version");
    const copyBtn = document.getElementById("copy-link");
    const toggleBtn = hasMultiple ? document.getElementById("toggle-compare") : null;
    const compareBar = hasMultiple ? document.getElementById("compare-bar") : null;
    const compareSelect = hasMultiple ? document.getElementById("compare-version") : null;
    const exitBtn = hasMultiple ? document.getElementById("exit-compare") : null;
    const content = document.getElementById("content-area");

    viewSelect.value = String(viewingIndex);
    attachSwitchPairButton();

    function updateHash() {
      syncHash(policy.id, viewingIndex, comparing ? compareIndex : null);
    }

    function refreshCompareOptions() {
      const options = optionsForRevisions(revisions, viewingIndex);
      compareSelect.innerHTML = `<option value="">— select —</option>${options}`;
      compareSelect.value = compareIndex === null ? "" : String(compareIndex);
    }

    function renderContent() {
      if (comparing && compareIndex !== null) {
        const from = revisions[compareIndex];
        const to = revisions[viewingIndex];
        content.className = "diff-body";
        content.innerHTML =
          `<div class="diff-legend"><span class="add">Added</span><span class="del">Removed</span></div>` +
          renderDiff(from.body, to.body);
      } else if (comparing) {
        content.className = "policy-body";
        content.innerHTML = `<p class="single-revision-note">Choose a version above to see markings against it.</p>`;
      } else {
        content.className = "policy-body";
        content.innerHTML = renderMarkdown(revisions[viewingIndex].body);
      }
    }

    viewSelect.addEventListener("change", () => {
      viewingIndex = Number(viewSelect.value);
      headerSlot.innerHTML = renderHeaderInner();
      attachSwitchPairButton();
      if (compareIndex === viewingIndex) compareIndex = null;
      if (comparing) refreshCompareOptions();
      updateHash();
      renderContent();
    });

    copyBtn.addEventListener("click", async () => {
      const ok = await copyToClipboard(location.href);
      const original = copyBtn.textContent;
      copyBtn.textContent = ok ? "Copied!" : "Copy failed";
      setTimeout(() => { copyBtn.textContent = original; }, 1500);
    });

    if (hasMultiple) {
      if (comparing) {
        compareBar.hidden = false;
        toggleBtn.hidden = true;
        refreshCompareOptions();
      }

      toggleBtn.addEventListener("click", () => {
        comparing = true;
        compareBar.hidden = false;
        toggleBtn.hidden = true;
        refreshCompareOptions();
        updateHash();
        renderContent();
      });

      exitBtn.addEventListener("click", () => {
        comparing = false;
        compareIndex = null;
        compareBar.hidden = true;
        toggleBtn.hidden = false;
        updateHash();
        renderContent();
      });

      compareSelect.addEventListener("change", () => {
        compareIndex = compareSelect.value === "" ? null : Number(compareSelect.value);
        updateHash();
        renderContent();
      });
    }

    updateHash();
    renderContent();
  }

  // ---- boot -----------------------------------------------------------------

  let searchTimer = null;
  el.search.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => renderList(el.search.value), 80);
  });

  el.fulltextToggle.addEventListener("change", () => {
    if (el.fulltextToggle.checked) {
      ensureFulltextLoaded().then(() => renderList(el.search.value));
    }
    renderList(el.search.value);
  });

  initTheme();
  initSidebar();

  (async () => {
    try {
      const institutions = await fetchJson("data/institutions.json");
      if (!institutions.length) {
        el.name.textContent = "No institutions found";
        return;
      }
      const linked = parseHash();
      const slug =
        linked && institutions.some((i) => i.slug === linked.slug)
          ? linked.slug
          : institutions[0].slug;
      await loadInstitution(slug);

      if (linked && state.index.policies.some((p) => p.id === linked.policyId)) {
        await selectPolicy(linked.policyId, {
          viewingIndex: linked.viewingIndex,
          compareIndex: linked.compareIndex,
        });
      }
    } catch (err) {
      el.name.textContent = "Failed to load policy data";
      console.error(err);
    }
  })();
})();
