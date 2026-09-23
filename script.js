(() => {
  "use strict";

  const EPISODES = window.EPISODES || [];
  const BY_NO = new Map(EPISODES.map((e) => [e.no, e]));
  const isAnime = (ep) => ep.k === "a";
  // A manga case that has an anime version (its アニメ list has a link).
  const hasTv = (ep) => !isAnime(ep) && !!ep.an && ep.an.some((a) => a.u);

  // Manga cases can show their own panel or the corresponding anime still (サムネイル switch, screen-only preference).
  const THUMB_KEY = "conanEpisodeTier.thumb";
  let thumbPref = "manga";
  try { thumbPref = localStorage.getItem(THUMB_KEY) === "anime" ? "anime" : "manga"; } catch (e) { /* ignore */ }
  // The first アニメ adaptation that has its own thumbnail (a few cases have two; the first covers almost all of them).
  const animeAdaptOf = (ep) => (!isAnime(ep) && ep.an ? ep.an.find((a) => a.img) : null) || null;
  const showsAnime = (ep) => isAnime(ep) || (thumbPref === "anime" && !!animeAdaptOf(ep));
  // What is shown for an episode: manga cases use the site's case number (or the adapted episode's "A" + number
  // while the サムネイル switch is on アニメ), anime originals always "A" + episode number.
  const labelOf = (ep) => {
    if (!isAnime(ep) && thumbPref === "anime") {
      const a = animeAdaptOf(ep);
      if (a) return a.label;
    }
    return ep.label || String(ep.no);
  };
  // Tiles use a small 180px square copy (img/t/...); the detail dialog loads the full-size image.
  const thumbOf = (ep) => {
    const a = !isAnime(ep) && thumbPref === "anime" ? animeAdaptOf(ep) : null;
    return (a ? a.img : ep.img).replace(/^img\//, "img/t/").replace(/\.\w+$/, ".jpg");
  };
  const CHARS = window.CHARACTERS || [];
  const CHAR_BY_ID = new Map(CHARS.map((c) => [c.id, c]));
  const STORAGE_KEY = "conanEpisodeTier.v1";
  const DEFAULT_TITLE = "好きな名探偵コナンのエピソード Tier表";
  const DEFAULT_TIERS = [
    { name: "S\n最高", color: "#ff7f7f" },
    { name: "A", color: "#ffbf7f" },
    { name: "B", color: "#ffdf7f" },
    { name: "C", color: "#bfff7f" },
    { name: "D\n好き", color: "#b8c4d6" },
  ];
  const PALETTE = [
    "#ff7f7f", "#ffbf7f", "#ffdf7f", "#ffff7f", "#bfff7f", "#7fff7f", "#7fffbf", "#7fffff",
    "#7fbfff", "#7f7fff", "#bf7fff", "#ff7fff", "#ff7fbf", "#f4f4f4", "#cfcfcf", "#858585",
  ];

  const $ = (id) => document.getElementById(id);
  const boardEl = $("board");
  const tiersEl = $("tiers");
  const titleEl = $("listTitle");
  const poolEl = $("pool");
  const poolGrid = $("poolGrid");
  const poolCount = $("poolCount");
  const qEl = $("q");
  const volEl = $("vol");
  const kindEl = $("kind");
  const yearEl = $("year");

  /* ------------------------------------------------------------------ state */

  let idSeq = 0;
  const newId = () => `t${Date.now().toString(36)}${(idSeq++).toString(36)}`;

  const NOTE_MAX = 300;

  function defaultState() {
    return {
      title: DEFAULT_TITLE,
      mode: "title",
      tiers: DEFAULT_TIERS.map((t) => ({ id: newId(), name: t.name, color: t.color, items: [] })),
      notes: {},
    };
  }

  // Loaded data comes from localStorage, so never trust its shape.
  function sanitize(raw) {
    if (!raw || typeof raw !== "object" || !Array.isArray(raw.tiers) || raw.tiers.length === 0) return null;
    const seen = new Set();
    const tiers = raw.tiers.slice(0, 30).map((t) => {
      t = t && typeof t === "object" ? t : {};
      const items = (Array.isArray(t.items) ? t.items : []).filter((n) => {
        if (!BY_NO.has(n) || seen.has(n)) return false;
        seen.add(n);
        return true;
      });
      return {
        id: newId(),
        name: typeof t.name === "string" ? t.name.slice(0, 40) : "",
        color: /^#[0-9a-f]{6}$/i.test(t.color) ? t.color : "#cfcfcf",
        items,
      };
    });
    const notes = {};
    if (raw.notes && typeof raw.notes === "object") {
      for (const [k, v] of Object.entries(raw.notes)) {
        const no = Number(k);
        if (BY_NO.has(no) && typeof v === "string" && v.trim()) notes[no] = v.slice(0, NOTE_MAX);
      }
    }
    return {
      title: typeof raw.title === "string" ? raw.title.slice(0, 100) : DEFAULT_TITLE,
      mode: ["image", "badge", "title"].includes(raw.mode) ? raw.mode : "title",
      tiers,
      notes,
    };
  }

  function loadState() {
    try {
      return sanitize(JSON.parse(localStorage.getItem(STORAGE_KEY)));
    } catch (e) {
      return null;
    }
  }

  let state = loadState() || defaultState();
  // View-only mode: a friend's board shown in place of ours (only when ours is empty). Nothing is saved while viewing.
  let viewMode = false;
  let ownState = null;
  let shareTimer = 0; // the link to our own board is rebuilt a moment after every change (see scheduleShareLink)
  let shareCache = { key: "", link: "" };

  // Per-episode memos: kept in state (and exported to the backup JSON) but never in the share link/URL - see encodeBoard().
  const hasNote = (no) => !!(state.notes && state.notes[no]);

  function save() {
    if (viewMode) return; // never write a friend's board over our own
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      /* private mode / storage disabled: the app still works, it just won't remember */
    }
  }

  /* ------------------------------------------------------------ undo / redo */

  // History covers the board: title, rows and where every episode sits. The display mode is a
  // view setting, so undoing never flips it.
  const HISTORY_LIMIT = 100;
  let undoStack = [];
  let redoStack = [];
  const snapshot = () => JSON.stringify({ title: state.title, tiers: state.tiers });

  function pushHistory(before) {
    undoStack.push(before);
    if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
    redoStack = [];
    updateHistoryButtons();
  }

  // Runs a change and records it for undo, unless it changed nothing (e.g. dropping a tile where it already was).
  function track(change) {
    const before = snapshot();
    change();
    if (snapshot() !== before) pushHistory(before);
    editBefore = snapshot();
    editPushed = false;
  }

  // Typing in the row dialog fires many events; the whole editing session becomes one undo step.
  let editBefore = null;
  let editPushed = false;
  function recordEdit() {
    if (editPushed || editBefore === null) return;
    pushHistory(editBefore);
    editPushed = true;
  }

  function applySnapshot(json) {
    const s = JSON.parse(json);
    state.title = s.title;
    state.tiers = s.tiers;
    titleEl.textContent = state.title;
    save();
    render();
  }

  function undo() {
    if (viewMode) return;
    if (!undoStack.length) return;
    redoStack.push(snapshot());
    applySnapshot(undoStack.pop());
    updateHistoryButtons();
    toast("元に戻しました");
  }

  function redo() {
    if (viewMode) return;
    if (!redoStack.length) return;
    undoStack.push(snapshot());
    applySnapshot(redoStack.pop());
    updateHistoryButtons();
    toast("やり直しました");
  }

  function updateHistoryButtons() {
    $("undoBtn").disabled = undoStack.length === 0;
    $("redoBtn").disabled = redoStack.length === 0;
  }

  const findTier = (id) => state.tiers.find((t) => t.id === id);
  const tierOf = (no) => state.tiers.find((t) => t.items.includes(no));

  function moveEpisode(no, tierId, index) {
    if (viewMode) return;
    track(() => {
      state.tiers.forEach((t) => {
        const i = t.items.indexOf(no);
        if (i >= 0) t.items.splice(i, 1);
      });
      if (tierId) {
        const t = findTier(tierId);
        if (t) {
          const at = index == null ? t.items.length : Math.max(0, Math.min(index, t.items.length));
          t.items.splice(at, 0, no);
        }
      }
    });
    save();
    render();
  }

  /* -------------------------------------------------------------- rendering */

  const itemCache = new Map();

  // One element per episode, reused between board and pool so already-loaded images don't flash.
  function itemEl(ep) {
    let d = itemCache.get(ep.no);
    if (d) return d;
    d = document.createElement("div");
    d.className = "item";
    d.dataset.no = ep.no;
    d.tabIndex = 0;
    d.setAttribute("role", "button");
    const img = new Image();
    img.alt = ep.title;
    img.draggable = false;
    img.decoding = "async";
    img.loading = "lazy";
    const badge = document.createElement("span");
    badge.className = "badge";
    const cap = document.createElement("span");
    cap.className = "cap";
    cap.textContent = ep.title;
    d.append(img, badge, cap);
    itemCache.set(ep.no, d);
    refreshItemEl(ep, d);
    return d;
  }

  // Refreshes the parts of a tile that depend on the サムネイル switch, which can change after the
  // tile was first built (itemEl() only builds each tile once).
  function refreshItemEl(ep, d = itemCache.get(ep.no)) {
    if (!d) return;
    d.classList.toggle("is-anime", showsAnime(ep));
    d.title = `${showsAnime(ep) ? "" : "No."}${labelOf(ep)} ${ep.title}`;
    d.firstChild.src = thumbOf(ep);
    d.querySelector(".badge").textContent = labelOf(ep);
  }
  function refreshAllItems() {
    for (const [no, d] of itemCache) refreshItemEl(BY_NO.get(no), d);
  }

  function textColorFor(hex) {
    const n = parseInt(hex.slice(1), 16);
    const lum = 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
    return lum > 140 ? "#111" : "#fff";
  }

  // Size by line length. With several lines the first stays big (e.g. the "S" of "S / 最高")
  // and the following lines are capped so the whole label still fits the row height.
  function labelSize(line, index, lineCount) {
    const n = line.length;
    let px = n <= 1 ? 36 : n <= 2 ? 30 : n <= 3 ? 24 : n <= 5 ? 18 : n <= 8 ? 14 : 11;
    if (index > 0) px = Math.min(px, 20);
    if (lineCount > 2) px = Math.min(px, 14);
    return `calc(${px}px * var(--fs))`;
  }

  const SVG = {
    gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
    up: '<path d="M18 15l-6-6-6 6"/>',
    down: '<path d="M6 9l6 6 6-6"/>',
  };

  function iconBtn(kind, label, action, tierId, disabled) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "icon-btn";
    b.dataset.action = action;
    b.dataset.tier = tierId;
    b.setAttribute("aria-label", label);
    b.title = label;
    b.disabled = !!disabled;
    b.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${SVG[kind]}</svg>`;
    return b;
  }

  function renderTiers() {
    const rows = state.tiers.map((t, i) => {
      const row = document.createElement("div");
      row.className = "tier";
      row.dataset.id = t.id;

      const label = document.createElement("div");
      label.className = "tier-label";
      label.style.background = t.color;
      label.style.color = textColorFor(t.color);
      label.dataset.action = "edit";
      label.dataset.tier = t.id;
      label.title = "クリックして編集";
      const text = document.createElement("span");
      text.className = "tier-label-text";
      const lines = t.name.split("\n");
      lines.forEach((ln, li) => {
        const div = document.createElement("div");
        div.textContent = ln || " ";
        div.style.fontSize = labelSize(ln, li, lines.length);
        text.append(div);
      });
      label.append(text);

      const items = document.createElement("div");
      items.className = "tier-items";
      t.items.forEach((no) => items.append(itemEl(BY_NO.get(no))));

      const tools = document.createElement("div");
      tools.className = "tier-tools no-export";
      tools.append(
        iconBtn("gear", "この行を編集", "edit", t.id),
        iconBtn("up", "上へ移動", "up", t.id, i === 0),
        iconBtn("down", "下へ移動", "down", t.id, i === state.tiers.length - 1)
      );

      row.append(label, items, tools);
      return row;
    });
    tiersEl.replaceChildren(...rows);
  }

  // Hiragana/katakana and full/half width shouldn't matter when searching.
  const norm = (s) =>
    s
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));

  const volumeOf = (ep) => {
    const m = /第(\d+)巻/.exec(ep.file);
    return m ? m[1] : "";
  };

  const HAYSTACK = new Map(EPISODES.map((e) => [e.no, norm(`${labelOf(e)} ${e.title} ${e.file}`)]));

  // On narrow screens the extra filters fold away so the episode list keeps its height.
  // The button shows how many hidden filters are on, so a folded panel never hides an active filter.
  const filterToggle = $("filterToggle");
  function updateFilterToggle(activeCount) {
    const open = poolEl.classList.contains("filters-open");
    filterToggle.textContent = `絞り込み${activeCount ? `（${activeCount}）` : ""} ${open ? "▴" : "▾"}`;
    filterToggle.classList.toggle("is-active", activeCount > 0);
    filterToggle.setAttribute("aria-expanded", String(open));
  }
  filterToggle.addEventListener("click", () => {
    poolEl.classList.toggle("filters-open");
    renderPool();
  });

  // モバイルでは一覧がずっと画面の4割強を占めるので、一時的に隠して表を広く見られるようにする。
  $("poolCollapseBtn").addEventListener("click", () => {
    const collapsed = poolEl.classList.toggle("is-collapsed");
    $("poolCollapseBtn").textContent = collapsed ? "表示" : "隠す";
  });

  const selectedChars = new Set();
  let charMode = "all";
  const matchChars = (ep, ids) =>
    charMode === "all" ? ids.every((id) => ep.c.includes(id))
    : charMode === "none" ? ids.every((id) => !ep.c.includes(id))
    : ids.some((id) => ep.c.includes(id));

  function renderCharChips() {
    $("charBtn").classList.toggle("is-active", selectedChars.size > 0);
    $("charBtn").textContent = selectedChars.size ? `キャラで絞り込み（${selectedChars.size}）` : "キャラで絞り込み";
    const chips = [...selectedChars].map((id) => {
      const c = CHAR_BY_ID.get(id);
      const b = document.createElement("button");
      b.type = "button";
      b.className = "char-chip";
      b.dataset.char = id;
      b.title = "クリックで解除";
      const img = new Image();
      img.src = c.icon;
      img.alt = "";
      const t = document.createElement("span");
      t.textContent = c.name;
      const x = document.createElement("span");
      x.className = "x";
      x.textContent = "×";
      b.append(img, t, x);
      return b;
    });
    $("charChips").replaceChildren(...chips);
  }

  // Manga cases and anime originals stay in their own blocks (manga first); this only reverses the order inside.
  let newestFirst = false;
  const sortBtn = $("sortBtn");
  sortBtn.addEventListener("click", () => {
    newestFirst = !newestFirst;
    sortBtn.textContent = newestFirst ? "並び：新しい順" : "並び：古い順";
    renderPool();
  });

  // メモで絞り込み: a filter like the others (reuses the same "found" outline for placed episodes) instead of
  // a badge on every tile, which the user found made tiles look cluttered. Cycles off -> has -> none -> off.
  let memoFilter = "off";
  const MEMO_FILTER_LABEL = { off: "メモで絞り込み", has: "メモがある話", none: "メモがない話" };
  const memoFilterBtn = $("memoFilterBtn");
  memoFilterBtn.addEventListener("click", () => {
    memoFilter = memoFilter === "off" ? "has" : memoFilter === "has" ? "none" : "off";
    memoFilterBtn.textContent = MEMO_FILTER_LABEL[memoFilter];
    memoFilterBtn.classList.toggle("is-active", memoFilter !== "off");
    renderPool();
  });

  // メモ一覧: every memo in one place (board order top to bottom, then 未分類), so the user can read them
  // the way they read their spreadsheet instead of opening each episode's detail one at a time.
  const memoListDlg = $("memoListDialog");
  let memoSort = "board";
  function renderMemoList() {
    const notes = state.notes || {};
    const filterVal = $("memoFilterSel").value; // "has" | "none" | "all"
    const passesFilter = (no) => (filterVal === "all" ? true : filterVal === "has" ? !!notes[no] : !notes[no]);
    const rows = []; // { no, tier: tier-object-or-null }
    const placed = new Set();
    state.tiers.forEach((t) => t.items.forEach((no) => {
      placed.add(no); // placed either way, so the pool loop below never lists it twice
      if (passesFilter(no)) rows.push({ no, tier: t });
    }));
    EPISODES.filter((e) => !placed.has(e.no) && passesFilter(e.no)).forEach((e) => rows.push({ no: e.no, tier: null }));
    // "表の並び順" is already board order (rows built above); the other two just re-sort by episode number
    // (manga cases 1-333, anime originals 1000+, so this keeps manga first then anime within each direction).
    if (memoSort === "epAsc") rows.sort((a, b) => a.no - b.no);
    else if (memoSort === "epDesc") rows.sort((a, b) => b.no - a.no);

    const withMemo = rows.filter((r) => notes[r.no]).length;
    $("memoListCount").textContent = !rows.length ? "該当する話がありません" : filterVal === "all" ? `${rows.length}件（メモあり ${withMemo}件）` : `${rows.length}件`;
    const list = $("memoList");
    list.replaceChildren();
    rows.forEach(({ no, tier }) => {
      const ep = BY_NO.get(no);
      const row = document.createElement("button");
      row.type = "button";
      row.className = "memo-row";
      const img = new Image();
      img.src = thumbOf(ep);
      img.alt = "";
      img.loading = "lazy";
      const body = document.createElement("div");
      body.className = "memo-row-body";
      const head = document.createElement("div");
      head.className = "memo-row-head";
      const title = document.createElement("span");
      title.className = "memo-row-title";
      title.textContent = `${labelOf(ep)} ${ep.title}`;
      const tag = document.createElement("span");
      tag.className = "memo-row-tier";
      if (tier) {
        tag.textContent = tier.name.replace(/\n/g, " ").trim() || "　";
        tag.style.background = tier.color;
        tag.style.color = textColorFor(tier.color);
      } else {
        tag.textContent = "未分類";
        tag.classList.add("is-pool");
      }
      head.append(title, tag);
      const text = document.createElement("p");
      text.className = "memo-row-text";
      if (notes[no]) text.textContent = notes[no];
      else { text.textContent = "（メモなし）"; text.classList.add("is-empty"); }
      body.append(head, text);
      row.append(img, body);
      row.addEventListener("click", () => openDetail(no)); // opens on top of this dialog; closing it comes back here
      list.append(row);
    });
  }
  $("memoListBtn").addEventListener("click", () => {
    renderMemoList();
    memoListDlg.showModal();
  });
  $("memoSort").addEventListener("change", () => {
    memoSort = $("memoSort").value;
    renderMemoList();
  });
  $("memoFilterSel").addEventListener("change", renderMemoList);

  // Placed tiles that match the current filters are outlined on the board, and this button walks through them.
  const foundBtn = $("foundBtn");
  let foundNos = [];
  let foundIdx = -1;
  foundBtn.addEventListener("click", () => {
    if (!foundNos.length) return;
    foundIdx = (foundIdx + 1) % foundNos.length;
    const el = itemCache.get(foundNos[foundIdx]);
    el.scrollIntoView({ block: "start", behavior: "smooth" });
    tiersEl.querySelectorAll(".item.pulse").forEach((n) => n.classList.remove("pulse"));
    void el.offsetWidth; // restart the animation
    el.classList.add("pulse");
  });

  function renderPool() {
    const placed = new Set();
    state.tiers.forEach((t) => t.items.forEach((n) => placed.add(n)));
    const q = norm(qEl.value.trim());
    const vol = volEl.value;
    const kind = kindEl.value;
    const year = yearEl.value;
    const chars = [...selectedChars];
    const filtering = q || vol || kind || year || chars.length || memoFilter !== "off";
    const passes = (ep) => {
      if (kind) {
        if (kind === "anime" ? !isAnime(ep) : isAnime(ep)) return false; // the other kinds are all manga
        if (kind === "manga-tv" && !hasTv(ep)) return false;
        if (kind === "manga-notv" && hasTv(ep)) return false;
      }
      if (year && String(ep.y) !== year) return false; // only anime carry a broadcast year
      if (vol && volumeOf(ep) !== vol) return false;
      if (q && !HAYSTACK.get(ep.no).includes(q)) return false;
      if (chars.length && !matchChars(ep, chars)) return false;
      if (memoFilter === "has" && !hasNote(ep.no)) return false;
      if (memoFilter === "none" && hasNote(ep.no)) return false;
      return true;
    };
    const frag = document.createDocumentFragment();
    let remaining = 0;
    let shown = 0;
    const foundSet = new Set();
    for (const ep of newestFirst ? [...EPISODES].reverse() : EPISODES) {
      if (placed.has(ep.no)) {
        if (filtering && passes(ep)) foundSet.add(ep.no);
        continue;
      }
      remaining++;
      if (!passes(ep)) continue;
      shown++;
      frag.append(itemEl(ep));
    }
    if (shown === 0) {
      const p = document.createElement("p");
      p.className = "pool-empty";
      p.textContent = remaining === 0 ? "すべてのエピソードをTierに入れました！" : "該当するエピソードがありません";
      frag.append(p);
    }
    poolGrid.replaceChildren(frag);
    for (const [no, el] of itemCache) el.classList.toggle("found", foundSet.has(no));
    foundNos = state.tiers.flatMap((t) => t.items).filter((no) => foundSet.has(no)); // board order, top to bottom
    foundIdx = -1;
    foundBtn.hidden = foundNos.length === 0;
    foundBtn.textContent = `表内 ${foundNos.length}件 ▸`;
    updateFilterToggle([kind, vol, year].filter(Boolean).length + (chars.length ? 1 : 0));
    poolCount.textContent = filtering ? `${shown}件表示 ／ 未分類 ${remaining}件` : `未分類 ${remaining} / ${EPISODES.length}`;
  }

  function render() {
    document.body.dataset.mode = state.mode;
    renderTiers();
    renderPool();
    if (statsDlg.open) renderStats(); // the stats show where each episode sits, so keep them current
    scheduleShareLink();
  }

  /* ---------------------------------------------------------- drag and drop */

  const HOLD_MS = 240; // touch: hold this long to start dragging, so a normal swipe still scrolls
  let drag = null;

  document.addEventListener("pointerdown", (e) => {
    if (drag || (e.pointerType === "mouse" && e.button !== 0)) return;
    const item = e.target.closest && e.target.closest(".item");
    if (!item) return;
    drag = {
      item,
      no: Number(item.dataset.no),
      id: e.pointerId,
      type: e.pointerType,
      sx: e.clientX, sy: e.clientY, x: e.clientX, y: e.clientY,
      started: false,
      ghost: null, ph: null, zoneEl: null, kind: null, timer: 0, raf: 0,
    };
    if (e.pointerType === "mouse") {
      e.preventDefault(); // no native text selection / image drag
    } else {
      drag.timer = setTimeout(startDrag, HOLD_MS);
    }
  });

  window.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag.x = e.clientX;
    drag.y = e.clientY;
    if (!drag.started) {
      const dist = Math.hypot(drag.x - drag.sx, drag.y - drag.sy);
      if (drag.type === "mouse") {
        if (dist > 5) startDrag();
      } else if (dist > 10) {
        // The finger moved before the long-press fired: the user is scrolling.
        clearTimeout(drag.timer);
        drag = null;
      }
      return;
    }
    e.preventDefault();
    frame();
  });

  window.addEventListener("pointerup", (e) => {
    if (drag && e.pointerId === drag.id) endDrag(true);
  });
  window.addEventListener("pointercancel", (e) => {
    if (drag && e.pointerId === drag.id) endDrag(false);
  });

  // Once a drag has started, stop the page from scrolling under the finger.
  document.addEventListener("touchmove", (e) => {
    if (drag && drag.started) e.preventDefault();
  }, { passive: false });
  document.addEventListener("contextmenu", (e) => {
    if (e.target.closest && e.target.closest(".item")) e.preventDefault();
  });

  function startDrag() {
    if (!drag || drag.started || viewMode) return; // viewing: a press/tap still opens the details, but nothing can be moved
    clearTimeout(drag.timer);
    drag.started = true;
    const r = drag.item.getBoundingClientRect();
    const ghost = drag.item.cloneNode(true);
    ghost.classList.add("ghost");
    ghost.style.width = `${r.width}px`;
    ghost.style.setProperty("--tile", `${r.width - 2}px`); // the tile size in the list can differ from the board's; keep the picture and badge proportional
    document.body.append(ghost);
    drag.ghost = ghost;
    drag.ph = document.createElement("div");
    drag.ph.className = "placeholder";
    drag.item.classList.add("drag-source");
    document.body.classList.add("is-dragging");
    if (drag.type !== "mouse" && navigator.vibrate) navigator.vibrate(10);
    frame();
    autoScrollLoop();
  }

  // Touch: hold the ghost above the finger so it stays visible.
  const fingerOffset = () => (drag.type === "mouse" ? 0 : -48);

  function frame() {
    const px = drag.x;
    const py = drag.y + fingerOffset();
    drag.ghost.style.transform = `translate(${px}px, ${py}px) translate(-50%, -50%) scale(1.1)`;
    updateTarget(px, py);
  }

  function setZone(zoneEl, kind) {
    if (drag.zoneEl === zoneEl) return;
    drag.zoneEl = zoneEl;
    drag.kind = kind;
    tiersEl.querySelectorAll(".tier.over").forEach((n) => n.classList.remove("over"));
    poolEl.classList.remove("over");
    if (kind === "tier") zoneEl.parentElement.classList.add("over");
    if (kind === "pool") poolEl.classList.add("over");
    if (kind !== "tier") drag.ph.remove();
  }

  function updateTarget(px, py) {
    const under = document.elementFromPoint(px, py);
    const tier = under && under.closest(".tier");
    const pool = under && under.closest("#pool");
    if (tier) {
      const zone = tier.querySelector(".tier-items");
      setZone(zone, "tier");
      let before = null;
      for (const k of zone.children) {
        if (!k.classList.contains("item") || k.classList.contains("drag-source")) continue;
        const r = k.getBoundingClientRect();
        if (py < r.top || (py <= r.bottom && px < r.left + r.width / 2)) {
          before = k;
          break;
        }
      }
      if (drag.ph.parentNode !== zone || drag.ph.nextSibling !== before) zone.insertBefore(drag.ph, before);
    } else if (pool) {
      setZone(poolEl, "pool");
    } else {
      setZone(null, null);
    }
  }

  function autoScrollLoop() {
    if (!drag || !drag.started) return;
    const EDGE = 72;
    const y = drag.y;
    let vy = 0;
    if (y < EDGE) vy = -Math.ceil((EDGE - y) / 3);
    else if (y > window.innerHeight - EDGE && drag.kind !== "pool") vy = Math.ceil((y - (window.innerHeight - EDGE)) / 3);
    if (vy) {
      window.scrollBy(0, vy);
      frame();
    }
    drag.raf = requestAnimationFrame(autoScrollLoop);
  }

  function endDrag(commit) {
    const d = drag;
    drag = null;
    clearTimeout(d.timer);
    cancelAnimationFrame(d.raf);

    if (!d.started) {
      if (commit) openDetail(d.no); // a plain tap
      return;
    }

    let move = null;
    if (commit && d.kind === "tier") {
      let idx = 0;
      for (const k of d.zoneEl.children) {
        if (k === d.ph) break;
        if (k.classList.contains("item") && !k.classList.contains("drag-source")) idx++;
      }
      move = { tierId: d.zoneEl.parentElement.dataset.id, idx };
    } else if (commit && d.kind === "pool") {
      move = { tierId: null };
    }

    d.ghost.remove();
    d.ph.remove();
    d.item.classList.remove("drag-source");
    document.body.classList.remove("is-dragging");
    tiersEl.querySelectorAll(".tier.over").forEach((n) => n.classList.remove("over"));
    poolEl.classList.remove("over");

    if (move) moveEpisode(d.no, move.tierId, move.idx);
  }

  document.addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && e.target.classList && e.target.classList.contains("item")) {
      e.preventDefault();
      openDetail(Number(e.target.dataset.no));
    }
  });

  /* ---------------------------------------------------------------- dialogs */

  const detailDlg = $("detailDialog");
  const tierDlg = $("tierDialog");
  $("aboutBtn").addEventListener("click", () => $("aboutDialog").showModal());

  // The detail dialog can be opened from the メモ一覧 list, stacked on top of it (native <dialog> supports
  // this); closing it comes back to the list, refreshed in case the memo text or the row it's in changed.
  detailDlg.addEventListener("close", () => {
    if (memoListDlg.open) renderMemoList();
  });

  // The dialog opens on pointerup; the click that follows the same tap must not count as a backdrop click.
  let dlgOpenedAt = 0;
  document.querySelectorAll("dialog").forEach((dlg) => {
    const show = dlg.showModal.bind(dlg);
    dlg.showModal = () => {
      dlgOpenedAt = Date.now();
      show();
    };
    dlg.addEventListener("click", (e) => {
      if (e.target.closest && e.target.closest("[data-close]")) return dlg.close();
      if (e.target === dlg && Date.now() - dlgOpenedAt > 350) dlg.close();
    });
  });

  // "シーズン31" (or a range if an episode set straddles two seasons); empty when unknown.
  const seasonText = (o) => (o.s ? (o.s2 ? `シーズン${o.s}〜${o.s2}` : `シーズン${o.s}`) : "");

  // Manga cases list the anime episode(s) that adapted them; anime originals are the anime themselves.
  function renderAnimeInfo(ep) {
    const box = $("dAnimeBox");
    const list = $("dAnime");
    box.hidden = isAnime(ep);
    list.replaceChildren();
    if (isAnime(ep)) return;
    if (!ep.an || ep.an.length === 0) {
      const li = document.createElement("li");
      li.className = "an-none";
      li.textContent = "対応するアニメはありません（未アニメ化、または情報がありません）";
      list.append(li);
      return;
    }
    ep.an.forEach((a) => {
      const li = document.createElement("li");
      if (a.img) {
        const pic = new Image();
        pic.className = "an-thumb";
        pic.src = a.img.replace(/^img\//, "img/t/").replace(/\.\w+$/, ".jpg");
        pic.alt = "";
        pic.loading = "lazy";
        li.append(pic);
      }
      if (a.s) {
        const season = document.createElement("span");
        season.className = "an-season";
        season.textContent = seasonText(a);
        li.append(season);
      }
      const no = document.createElement("span");
      no.className = "an-ep";
      no.textContent = a.e;
      li.append(no);
      if (a.t) {
        const title = document.createElement(a.u ? "a" : "span");
        title.className = "an-title";
        title.textContent = a.u ? `${a.t} ↗` : a.t;
        if (a.u) {
          title.href = a.u;
          title.target = "_blank";
          title.rel = "noopener noreferrer";
        }
        li.append(title);
      }
      if (a.d) {
        const date = document.createElement("span");
        date.className = "an-date";
        date.textContent = `${a.d}放送`;
        li.append(date);
      }
      list.append(li);
    });
  }

  let detailNo = null;
  function openDetail(no) {
    const ep = BY_NO.get(no);
    if (!ep) return;
    detailNo = no;
    $("dImg").src = ep.img;
    $("dImg").alt = ep.title;
    $("dNo").textContent = isAnime(ep) ? `アニメオリジナル ${labelOf(ep)}` : `事件 No.${ep.no}`;
    $("dTitle").textContent = ep.title;
    // "アニメオリジナル" is already in the heading line; the file line reads "シーズン 話数" like the manga's "巻 File".
    $("dFile").textContent = isAnime(ep) ? ep.file.replace(/^アニメオリジナルs*/, "") : ep.file;
    const season = isAnime(ep) ? seasonText(ep) : "";
    $("dSeason").textContent = season;
    $("dSeason").hidden = !season;
    $("dLink").href = isAnime(ep) ? ep.url : `https://websunday.net/episode/${ep.id}`;
    $("dLink").textContent = isAnime(ep) ? "読売テレビの公式サイトでこの話を見る ↗" : "公式サイトでこの事件を見る ↗";
    $("dCharsBox").hidden = ep.c.length === 0;
    $("dCharsLabel").textContent = ep.ce ? "登場キャラ（あらすじから推定）" : "メインキャラ";
    renderAnimeInfo(ep);
    $("dChars").replaceChildren(
      ...ep.c.map((id) => {
        const c = CHAR_BY_ID.get(id);
        const tag = document.createElement("span");
        tag.className = "char-tag";
        const img = new Image();
        img.src = c.icon;
        img.alt = "";
        tag.append(img, document.createTextNode(c.name));
        return tag;
      })
    );

    const cur = tierOf(no);
    const chips = $("dChips");
    chips.replaceChildren();
    state.tiers.forEach((t) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip" + (cur === t ? " is-current" : "");
      b.style.background = t.color;
      b.style.color = textColorFor(t.color);
      b.textContent = t.name.replace(/\n/g, " ").trim() || "　";
      b.addEventListener("click", () => {
        if (viewMode) return; // never move anything in a friend's board
        moveEpisode(no, t.id);
        detailDlg.close();
      });
      chips.append(b);
    });
    const pb = document.createElement("button");
    pb.type = "button";
    pb.className = "chip chip-pool" + (cur ? "" : " is-current");
    pb.textContent = "未分類";
    pb.addEventListener("click", () => {
      if (viewMode) return;
      moveEpisode(no, null);
      detailDlg.close();
    });
    chips.append(pb);
    $("dChips").hidden = viewMode;
    $("dChips").previousElementSibling.hidden = viewMode;
    $("dMemo").value = (state.notes && state.notes[no]) || "";
    $("dMemoBox").hidden = viewMode; // notes belong to our own state; there is nothing to save while viewing a friend's board
    detailDlg.showModal();
  }

  // Saved a moment after typing stops, like the share link (scheduleShareLink); doesn't create undo steps (unlike board edits).
  let memoTimer = 0;
  $("dMemo").addEventListener("input", () => {
    clearTimeout(memoTimer);
    const no = detailNo;
    const val = $("dMemo").value;
    memoTimer = setTimeout(() => {
      if (viewMode || !BY_NO.has(no)) return;
      state.notes = state.notes || {};
      if (val.trim()) state.notes[no] = val.slice(0, NOTE_MAX);
      else delete state.notes[no];
      save();
      renderPool(); // the メモがある話 filter/highlight needs to catch up if it's on
    }, 400);
  });

  /* ---------------------------------------------------- character filter */

  const charDlg = $("charDialog");
  const charGrid = $("charGrid");

  CHARS.forEach((c) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "char-btn";
    b.dataset.char = c.id;
    const img = new Image();
    img.src = c.icon;
    img.alt = "";
    img.loading = "lazy";
    const nm = document.createElement("span");
    nm.className = "nm";
    nm.textContent = c.name;
    const ct = document.createElement("span");
    ct.className = "ct";
    ct.textContent = c.count;
    b.append(img, nm, ct);
    charGrid.append(b);
  });

  function refreshCharUI() {
    charGrid.querySelectorAll(".char-btn").forEach((b) => b.classList.toggle("is-on", selectedChars.has(Number(b.dataset.char))));
    renderCharChips();
    renderPool();
    const n = [...poolGrid.querySelectorAll(".item")].length;
    $("charResult").textContent = selectedChars.size
      ? `未分類のうち ${n} 件が該当`
      : "キャラを選ぶと、未分類のエピソードが絞り込まれます";
  }

  function toggleChar(id) {
    if (selectedChars.has(id)) selectedChars.delete(id);
    else selectedChars.add(id);
    refreshCharUI();
  }

  $("charBtn").addEventListener("click", () => {
    refreshCharUI();
    charDlg.showModal();
  });
  charGrid.addEventListener("click", (e) => {
    const b = e.target.closest(".char-btn");
    if (b) toggleChar(Number(b.dataset.char));
  });
  $("charChips").addEventListener("click", (e) => {
    const b = e.target.closest(".char-chip");
    if (b) toggleChar(Number(b.dataset.char));
  });
  $("charClear").addEventListener("click", () => {
    selectedChars.clear();
    refreshCharUI();
  });
  document.querySelectorAll('input[name="charMode"]').forEach((r) =>
    r.addEventListener("change", () => {
      charMode = r.value;
      refreshCharUI();
    })
  );

  let editingId = null;
  const tName = $("tName");
  const tColor = $("tColor");
  const swatchBox = $("tSwatches");

  PALETTE.forEach((c) => {
    const s = document.createElement("button");
    s.type = "button";
    s.className = "swatch";
    s.style.background = c;
    s.dataset.color = c;
    s.setAttribute("aria-label", `色 ${c}`);
    swatchBox.append(s);
  });

  function syncSwatches(color) {
    swatchBox.querySelectorAll(".swatch").forEach((s) => s.classList.toggle("is-current", s.dataset.color === color));
    tColor.value = color;
  }

  function openTierDialog(id) {
    const t = findTier(id);
    if (!t) return;
    editingId = id;
    editBefore = snapshot();
    editPushed = false;
    tName.value = t.name;
    syncSwatches(t.color);
    $("tDelete").disabled = state.tiers.length <= 1;
    tierDlg.showModal();
  }

  tName.addEventListener("input", () => {
    const t = findTier(editingId);
    if (!t) return;
    recordEdit();
    t.name = tName.value;
    save();
    renderTiers();
  });
  const setColor = (c) => {
    const t = findTier(editingId);
    if (!t || t.color === c) return;
    recordEdit();
    t.color = c;
    syncSwatches(c);
    save();
    renderTiers();
  };
  swatchBox.addEventListener("click", (e) => {
    const s = e.target.closest(".swatch");
    if (s) setColor(s.dataset.color);
  });
  tColor.addEventListener("input", () => setColor(tColor.value));

  function addTier(index) {
    const used = new Set(state.tiers.map((t) => t.color));
    const color = PALETTE.find((c) => !used.has(c)) || PALETTE[state.tiers.length % PALETTE.length];
    track(() => state.tiers.splice(index, 0, { id: newId(), name: "New", color, items: [] }));
    save();
    render();
  }

  const editingIndex = () => state.tiers.findIndex((t) => t.id === editingId);
  $("tAddAbove").addEventListener("click", () => {
    addTier(editingIndex());
    tierDlg.close();
    toast("行を追加しました");
  });
  $("tAddBelow").addEventListener("click", () => {
    addTier(editingIndex() + 1);
    tierDlg.close();
    toast("行を追加しました");
  });
  $("tClear").addEventListener("click", () => {
    const t = findTier(editingId);
    if (!t) return;
    track(() => {
      t.items = [];
    });
    save();
    render();
    toast("この行を空にしました");
  });
  $("tDelete").addEventListener("click", () => {
    const t = findTier(editingId);
    if (!t || state.tiers.length <= 1) return;
    if (t.items.length && !confirm(`「${t.name.replace(/\n/g, " ")}」の行を削除しますか？\n中のエピソードは未分類に戻ります。`)) return;
    track(() => {
      state.tiers = state.tiers.filter((x) => x.id !== editingId);
    });
    save();
    render();
    tierDlg.close();
  });

  tiersEl.addEventListener("click", (e) => {
    const b = e.target.closest("[data-action]");
    if (!b) return;
    if (viewMode) return;
    const id = b.dataset.tier;
    const i = state.tiers.findIndex((t) => t.id === id);
    const act = b.dataset.action;
    if (act === "edit") return openTierDialog(id);
    const j = act === "up" ? i - 1 : i + 1;
    if (j < 0 || j >= state.tiers.length) return;
    track(() => {
      [state.tiers[i], state.tiers[j]] = [state.tiers[j], state.tiers[i]];
    });
    save();
    renderTiers();
  });

  /* ---------------------------------------------------------------- toolbar */

  $("addRowBtn").addEventListener("click", () => addTier(state.tiers.length));
  $("undoBtn").addEventListener("click", undo);
  $("redoBtn").addEventListener("click", redo);

  // Ctrl/Cmd+Z = undo, Ctrl/Cmd+Y or Ctrl/Cmd+Shift+Z = redo. Text fields keep their own undo.
  document.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || drag) return;
    if (e.target.closest && e.target.closest("input, textarea, select, [contenteditable]")) return;
    if (document.querySelector("dialog[open]")) return;
    const k = e.key.toLowerCase();
    if (k === "z" && !e.shiftKey) {
      e.preventDefault();
      undo();
    } else if (k === "y" || (k === "z" && e.shiftKey)) {
      e.preventDefault();
      redo();
    }
  });

  $("clearAllBtn").addEventListener("click", () => {
    if (!state.tiers.some((t) => t.items.length)) return;
    if (!confirm("すべてのエピソードを未分類に戻しますか？（行の名前と色は残ります）")) return;
    track(() => state.tiers.forEach((t) => (t.items = [])));
    save();
    render();
  });

  $("resetBtn").addEventListener("click", () => {
    if (!confirm("Tier表を初期状態に戻しますか？\n並べたエピソードも行の設定もすべて消えます。（エピソードのメモは残ります）")) return;
    const notes = state.notes;
    track(() => {
      state = defaultState();
      state.notes = notes; // memos are about the episode itself, not the board, so they survive a reset
    });
    titleEl.textContent = state.title;
    qEl.value = "";
    volEl.value = "";
    kindEl.value = "";
    yearEl.value = "";
    syncModeRadios();
    save();
    render();
  });

  document.querySelectorAll('input[name="mode"]').forEach((r) =>
    r.addEventListener("change", () => {
      state.mode = r.value;
      save();
      render();
    })
  );
  function syncModeRadios() {
    document.querySelectorAll('input[name="mode"]').forEach((r) => (r.checked = r.value === state.mode));
  }

  // サムネイル switch (マンガ／アニメ): a screen preference, not part of the board (not saved to the share link or the backup file).
  document.querySelectorAll('input[name="thumbSrc"]').forEach((r) => {
    r.checked = r.value === thumbPref;
    r.addEventListener("change", () => {
      thumbPref = r.value === "anime" ? "anime" : "manga";
      try { localStorage.setItem(THUMB_KEY, thumbPref); } catch (e) { /* not remembered, still works */ }
      refreshAllItems();
    });
  });

  titleEl.addEventListener("input", () => {
    if (!titleEl.textContent.trim()) titleEl.textContent = ""; // let :empty show the placeholder
    state.title = titleEl.textContent;
    save();
  });
  // Editing the title is one undo step, recorded when the field loses focus.
  let titleBefore = null;
  titleEl.addEventListener("focus", () => {
    titleBefore = snapshot();
  });
  titleEl.addEventListener("blur", () => {
    if (titleBefore !== null && JSON.parse(titleBefore).title !== state.title) pushHistory(titleBefore);
    titleBefore = null;
  });
  titleEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      titleEl.blur();
    }
  });
  titleEl.addEventListener("paste", (e) => {
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData).getData("text").replace(/\s+/g, " ");
    document.execCommand("insertText", false, text);
  });

  let filterTimer = 0;
  qEl.addEventListener("input", () => {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(renderPool, 120);
  });
  volEl.addEventListener("change", renderPool);
  kindEl.addEventListener("change", renderPool);
  yearEl.addEventListener("change", renderPool);

  const vols = [...new Set(EPISODES.map(volumeOf).filter(Boolean))].sort((a, b) => a - b);
  vols.forEach((v) => {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = `第${v}巻`;
    volEl.append(o);
  });

  const yearCounts = new Map();
  EPISODES.forEach((e) => e.y && yearCounts.set(e.y, (yearCounts.get(e.y) || 0) + 1));
  [...yearCounts.keys()].sort((a, b) => a - b).forEach((y) => {
    const o = document.createElement("option");
    o.value = y;
    o.textContent = `${y}年（${yearCounts.get(y)}）`;
    yearEl.append(o);
  });

  let toastTimer = 0;
  function toast(msg) {
    const t = $("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 1800);
  }

  /* ----------------------------------------------------------- image export */

  // Renders an off-screen copy at a fixed 1000px desktop layout so the saved image looks the
  // same no matter which device made it, and the on-screen board never has to reflow.
  async function exportImage(format = "png") {
    const stage = document.createElement("div");
    stage.className = "export-stage";
    const clone = boardEl.cloneNode(true);
    clone.removeAttribute("id");
    clone.classList.add("exporting");
    clone.querySelectorAll(".no-export").forEach((n) => n.remove());
    clone.querySelectorAll(".item").forEach((n) => n.classList.remove("drag-source", "found", "pulse"));
    clone.querySelectorAll("img").forEach((img) => img.setAttribute("loading", "eager"));
    clone.querySelector(".list-title").removeAttribute("contenteditable");
    stage.append(clone);
    document.body.append(stage);
    try {
      return await captureNode(clone, format);
    } finally {
      stage.remove();
    }
  }

  // Draws an off-screen node (already in the document) into an image data URL, PNG or JPEG.
  async function captureNode(node, format, background = "#121216") {
    await Promise.all([...node.querySelectorAll("img")].map((img) => (img.decode ? img.decode().catch(() => {}) : Promise.resolve())));
    // Integer size, so the scale onto the canvas stays clean (same lesson as the profile card app).
    const width = Math.round(node.getBoundingClientRect().width);
    const height = Math.ceil(node.getBoundingClientRect().height);
    // Keep total pixels under what mobile browsers can draw on one canvas.
    const pixelRatio = Math.max(1, Math.min(2, Math.sqrt(16000000 / (width * height))));
    const options = {
      pixelRatio,
      skipFonts: true,
      cacheBust: false,
      width,
      height,
      backgroundColor: background, // opaque, which JPEG needs anyway
    };
    return format === "jpeg" ? await htmlToImage.toJpeg(node, { ...options, quality: 0.92 }) : await htmlToImage.toPng(node, options);
  }

  function dateStamp() {
    const d = new Date();
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  }

  // Runs an image-making task while the button shows progress. On failure the user is told why and null is returned.
  const renderImage = (btn, idleText, format = "png") => withProgress(btn, idleText, () => exportImage(format));

  async function withProgress(btn, idleText, task) {
    btn.disabled = true;
    btn.textContent = "画像を生成中...";
    try {
      return await task();
    } catch (err) {
      console.error(err);
      alert(
        location.protocol === "file:"
          ? "画像の生成に失敗しました。\n\nindex.html をダブルクリックで直接開いていると、ブラウザの制限でサムネイル画像を読み込めず、画像を保存できません。\n\nフォルダ内の「Tier表を開く.bat」をダブルクリックして開き直してください。"
          : "画像の生成に失敗しました。もう一度お試しください。"
      );
      return null;
    } finally {
      btn.disabled = false;
      btn.textContent = idleText;
    }
  }

  const imageName = (format) => `conan_episode_tier_${dateStamp()}.${format === "jpeg" ? "jpg" : "png"}`;

  function downloadImage(dataUrl, format, name = imageName(format)) {
    const a = document.createElement("a");
    a.download = name;
    a.href = dataUrl;
    a.click();
  }

  function dataUrlToFile(dataUrl, name) {
    const bin = atob(dataUrl.split(",")[1]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], name, { type: "image/png" });
  }

  // Phones can attach the image straight to a post through the share sheet (Web Share API with files);
  // nothing is written to the device unless the user picks "save" there.
  // Desktop browsers just open X's post screen: their own share sheets are clumsier than X's.
  function canShareFiles() {
    try {
      return (
        matchMedia("(pointer: coarse)").matches &&
        !!navigator.share &&
        !!navigator.canShare &&
        navigator.canShare({ files: [new File([""], "a.png", { type: "image/png" })] })
      );
    } catch (e) {
      return false;
    }
  }

  // Save format (PNG is lossless and sharp; JPEG is much smaller). Remembered between visits.
  const FORMAT_KEY = "conanEpisodeTier.format";
  let saveFormat = "png";
  try {
    if (localStorage.getItem(FORMAT_KEY) === "jpeg") saveFormat = "jpeg";
  } catch (e) {
    /* storage unavailable: default to PNG */
  }
  const saveIdle = () => `画像として保存（${saveFormat === "jpeg" ? "JPEG" : "PNG"}）`;
  const POST_IDLE = "Xに投稿";
  const SHARE_TEXT = "名探偵コナンの好きなエピソードTier表を作りました！ リンクから私の表とくらべられます #コナンエピソードTier表 #名探偵コナン";
  const pageUrl = () => (/^https?:$/.test(location.protocol) ? location.origin + location.pathname : "");

  const saveBtn = $("saveBtn");
  const postXBtn = $("postXBtn");
  postXBtn.textContent = POST_IDLE;
  saveBtn.textContent = saveIdle();

  // One format setting for the board and the stats image: the toolbar switch and the stats dialog's select stay in sync.
  function applyFormat(format) {
    saveFormat = format === "jpeg" ? "jpeg" : "png";
    saveBtn.textContent = saveIdle();
    document.querySelectorAll('input[name="format"]').forEach((r) => (r.checked = r.value === saveFormat));
    $("statsFormat").value = saveFormat;
    try {
      localStorage.setItem(FORMAT_KEY, saveFormat);
    } catch (e) {
      /* not remembered, still works */
    }
  }
  document.querySelectorAll('input[name="format"]').forEach((r) => r.addEventListener("change", () => applyFormat(r.value)));
  $("statsFormat").addEventListener("change", () => applyFormat($("statsFormat").value));
  document.querySelectorAll('input[name="format"]').forEach((r) => (r.checked = r.value === saveFormat));
  $("statsFormat").value = saveFormat;

  saveBtn.addEventListener("click", async () => {
    const format = saveFormat; // what was selected when the button was pressed
    const dataUrl = await renderImage(saveBtn, saveIdle(), format);
    if (dataUrl) downloadImage(dataUrl, format);
  });

  // Two ways to post, so the long board link never comes as a surprise: introduce the site (plain URL), or post the board (link with its contents).
  const SITE_TEXT = "名探偵コナンの好きなエピソードでTier表が作れるツールです！ #コナンエピソードTier表 #名探偵コナン";
  const postDlg = $("postDialog");
  const openIntent = (text, url) => {
    let u = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`;
    if (url) u += `&url=${encodeURIComponent(url)}`;
    window.open(u, "_blank", "noopener"); // called straight from a click, so popup blockers allow it
  };

  postXBtn.addEventListener("click", () => {
    const empty = !placedEpisodes(true).length;
    $("postBoardBtn").disabled = empty;
    $("postBoardNote").hidden = !empty; // only explains why the choice is off
    postDlg.showModal();
  });

  $("postSiteBtn").addEventListener("click", () => {
    postDlg.close();
    openIntent(SITE_TEXT, pageUrl());
    toast("Xの投稿画面を開きました");
  });

  $("postBoardBtn").addEventListener("click", async () => {
    postDlg.close();
    if (canShareFiles()) {
      const dataUrl = await renderImage(postXBtn, POST_IDLE, "png");
      if (!dataUrl) return;
      const shareUrl = (await shareLinkNow()) || pageUrl();
      const file = dataUrlToFile(dataUrl, imageName("png"));
      if (navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ files: [file], text: SHARE_TEXT, ...(shareUrl ? { url: shareUrl } : {}) });
          return;
        } catch (e) {
          if (e.name === "AbortError") return; // the user closed the share sheet
          console.warn(e); // e.g. the tap's permission expired while the image was being made: open X's screen below
        }
      }
    }
    // The image is never saved or attached automatically. The link is prebuilt (shareLinkNow is instant when the cache
    // is fresh), so window.open still happens inside the click.
    openIntent(SHARE_TEXT, (await shareLinkNow()) || pageUrl());
    toast("Xの投稿画面を開きました。画像は「画像として保存」で保存して添付してください");
  });

  /* ------------------------------------------------------ export / import */

  // Backup file: episodes are stored by their numeric id (manga case No., anime 1000 + episode number),
  // so a file keeps working even if the site's thumbnails or titles change.
  const EXPORT_APP = "conan-episode-tier";
  const IMPORT_MAX_BYTES = 2 * 1024 * 1024;

  function exportData() {
    const data = {
      app: EXPORT_APP,
      version: 1,
      exportedAt: new Date().toISOString(),
      title: state.title,
      mode: state.mode,
      tiers: state.tiers.map((t) => ({ name: t.name, color: t.color, items: [...t.items] })),
      notes: { ...state.notes },
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    const a = document.createElement("a");
    a.download = `conan_episode_tier_${dateStamp()}.json`;
    a.href = url;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast("エクスポートしました");
  }

  const IMPORT_ERROR = "読み込めませんでした。このサイトでエクスポートしたJSONファイルを選んでください。";

  async function importFile(file) {
    if (!file) return;
    if (file.size > IMPORT_MAX_BYTES) return alert(IMPORT_ERROR);
    let raw;
    let next;
    try {
      raw = JSON.parse(await file.text());
      next = sanitize(raw);
    } catch (e) {
      next = null;
    }
    if (!next) return alert(IMPORT_ERROR);

    const count = (tiers) => tiers.reduce((n, t) => n + (t && Array.isArray(t.items) ? t.items.length : 0), 0);
    const placedNow = count(state.tiers);
    const placedNext = count(next.tiers);
    const skipped = count(raw.tiers) - placedNext;
    if (!confirm(`「${file.name}」を読み込みます。\n現在の表（${placedNow}件を配置済み）とメモは、読み込む表（${placedNext}件を配置）に置き換わります。よろしいですか？`)) return;

    track(() => {
      state = next;
    });
    titleEl.textContent = state.title;
    syncModeRadios();
    save();
    render();
    refreshAllItems();
    toast(skipped > 0 ? `読み込みました（認識できない${skipped}件は除外）` : "読み込みました");
  }

  const importInput = $("importFile");
  $("exportBtn").addEventListener("click", exportData);
  $("importBtn").addEventListener("click", () => importInput.click());
  importInput.addEventListener("change", async () => {
    const file = importInput.files[0];
    await importFile(file);
    importInput.value = ""; // so the same file can be chosen again
  });

  /* ------------------------------------------------------------ stats */

  // What the episodes placed on the board have in common, compared with all episodes.
  //   lift = share among placed episodes / share among all episodes  (1.0 = same as everything, 2.0 = twice as often)
  // Tabs: キャラ, グループ, コンビ, 年代, 舞台・事件, マンガ・アニメ, くらべる (friend's board).
  // The anime characters are an estimate (tools/character-aliases.mjs) and the tags are keyword guesses
  // (tools/tag-rules.mjs), so these are guides, not facts.
  //
  // Every tab has a STATS_DATA function that only calculates (rows, labels, options). The screen draws those rows
  // (renderStatsTab) and the saved image draws the top few of the same rows (exportStatsImage), so they never disagree.
  const statsDlg = $("statsDialog");
  const TAG_BY_ID = new Map((window.TAGS || []).map((t) => [t.id, t]));
  const STATS_TABS = ["char", "group", "combo", "era", "place", "kind", "compare"];
  const STATS_TOP = 15;
  const COMBO_TOP = 12;
  const MIN_PLACED_FOR_BIAS = 8; // with fewer episodes the "bias" is mostly noise
  const MIN_COUNT_FOR_BIAS = 3;
  const REGULAR_SHARE = 0.25; // characters in at least this share of all episodes are "regulars"
  let statsExpanded = false;
  let comboExpanded = false;
  let compareBoard = null; // a friend's board: { name, title, tiers }
  const statsOpen = new Set(); // breakdowns that are open, so a re-render keeps them open
  const cmpExpanded = new Set(); // compare lists shown in full ("both", "split", "mine", "their")

  const mk = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const charCounts = (eps) => {
    const m = new Map();
    for (const e of eps) for (const id of e.c) m.set(id, (m.get(id) || 0) + 1);
    return m;
  };
  const pct = (x) => `${Math.round(x * 100)}%`;
  const pctP = (x) => (x > 0 && x < 0.1 ? `${(x * 100).toFixed(1)}%` : pct(x)); // precise enough to redo the division
  // How much of it is on the board compared with its 出番: in words, because a bare "×4.8" reads like a score.
  // One-line definitions of the two numbers; the image prints only the ones it actually shows.
  const LEGEND_LIFT = "出番の○倍：全エピソードで出る割合に対して、表に何倍入れているか（高く評価している、とは別）";
  const LEGEND_ABOVE = "表の平均より○段上：その話（キャラ・グループ）を、表全体の平均より何段上に入れているか";
  // "the board average is 3.0, this is 2.2" -> 表の平均より0.8段上
  const aboveLabel = (d) => (Math.abs(d) < 0.15 ? "表の平均どおり" : `表の平均より${Math.abs(d).toFixed(1)}段${d > 0 ? "上" : "下"}`);
  const liftLabel = (lift) => (lift >= 1.25 || lift <= 0.8 ? `出番の${lift.toFixed(1)}倍` : "出番どおり");
  const lineOf = (name) => name.split("\n").join(" ").trim();
  const charName = (id) => CHAR_BY_ID.get(id).name;
  const charIcon = (id) => CHAR_BY_ID.get(id).icon;
  // For a manga case, the year of its first anime adaptation (null if it has none, or only a 番外 special).
  const animeYearCache = new Map();
  const animeYearOf = (ep) => {
    if (!animeYearCache.has(ep.no)) {
      const years = (ep.an || []).map((a) => /^(\d{4})年/.exec(a.d || "")).filter(Boolean).map((m) => Number(m[1]));
      animeYearCache.set(ep.no, years.length ? Math.min(...years) : null);
    }
    return animeYearCache.get(ep.no);
  };
  // basis "volume": manga by the release year of the first volume. basis "anime": manga by the year the anime
  // adapted it (cases never adapted keep their volume year). Anime originals always use their broadcast year.
  const yearOf = (ep, basis = "volume") => (isAnime(ep) ? ep.y : basis === "anime" ? animeYearOf(ep) || ep.vy : ep.vy);


  const STATS_HELP = {
    count: "表に入れたエピソードに、そのキャラが出ている回数です。",
    score: "そのキャラが出る話を、表全体の平均より何段上に入れているかの順です。出番の多さは関係なく、出番が少なくても上の段に入れていれば上位に来ます（3話以上に出ているキャラが対象。話数が少ないほど控えめに評価します）。",
    more: "出番（全エピソードでそのキャラが出る割合）に比べて、表に何倍入れているかが大きい順です（出番の2.0倍、など）。3話以上に出ているキャラが対象です。",
    less: "出番に比べて、表に入れている割合が小さい順です。全エピソードの5%以上に出るキャラが対象です。",
    rank: "そのキャラが出るエピソードを入れた行が、平均して上から何段目か（小さいほど上位）。3話以上に出ているキャラが対象です。",
  };

  // Groups by role in the story. A character can be in several groups; an episode counts for a group when
  // at least one member appears in it.
  const STATS_GROUPS = [
    ["少年探偵団", ["吉田歩美", "小嶋元太", "円谷光彦", "灰原哀"]],
    ["毛利家・帝丹高校まわり", ["毛利蘭", "毛利小五郎", "鈴木園子", "妃英理", "小林澄子"]],
    ["警察", ["目暮十三", "高木渉", "佐藤美和子", "千葉和伸", "白鳥任三郎", "宮本由美", "三池苗子", "上原由衣", "山村ミサオ", "横溝参悟", "横溝重悟", "大和敢助", "諸伏高明", "脇田兼則", "黒田兵衛", "萩原千速"]],
    ["公安・警察学校組", ["安室透", "風見裕也", "諸伏景光", "スコッチ", "松田陣平", "伊達航", "萩原研二"]],
    ["大阪（服部平次・和葉）", ["服部平次", "遠山和葉"]],
    ["黒ずくめの組織", ["ジン", "ウォッカ", "ベルモット", "キール", "水無怜奈", "キャンティ", "コルン"]],
    ["FBI・赤井一家", ["赤井秀一", "ジョディ", "アンドレ・キャメル", "ジェイムズ・ブラック", "世良真純", "メアリー", "羽田秀𠮷"]],
    ["怪盗キッドまわり", ["怪盗キッド", "中森銀三", "鈴木次郎吉"]],
    ["工藤家・阿笠博士", ["工藤新一", "工藤優作", "工藤有希子", "阿笠博士", "沖矢昴"]],
    ["ポアロ・芸能界", ["榎本梓", "沖野ヨーコ"]],
    ["そのほかの準レギュラー", ["京極真", "本堂瑛祐", "大岡紅葉", "若狭留美", "新出智明", "伊織無我", "沖田総司"]],
  ].map(([name, members]) => ({
    name,
    ids: new Set(members.map((n) => CHARS.find((c) => c.name === n)).filter(Boolean).map((c) => c.id)),
  }));

  const KIND_KEYS = [
    ["manga", "マンガの事件"],
    ["manga-tv", "　うち、アニメ化されている"],
    ["manga-notv", "　うち、アニメ化されていない"],
    ["anime", "アニメオリジナル"],
  ];

  const statsNote = (text) => mk("p", "stats-empty", text);
  const EMPTY_BOARD = "表にエピソードを入れると、集計できます。";
  const NEED_BIAS = `「出番の○倍」の表示は、表に${MIN_PLACED_FOR_BIAS}話以上入れると出ます。`;

  /* --- drawing blocks used by the screen --- */

  // The bar row shared by every tab: [icons] name + tags | count, bar underneath.
  function statRow(o) {
    const row = mk("div", "stat-row" + (o.icons && o.icons.length ? "" : " no-icon"));
    if (o.icons && o.icons.length) {
      const box = mk("div", "stat-icons");
      o.icons.forEach((src) => {
        const img = new Image();
        img.src = src;
        img.alt = "";
        box.append(img);
      });
      row.append(box);
    }
    const main = mk("div", "stat-main");
    const line = mk("div", "stat-line");
    line.append(mk("span", "stat-name", o.name));
    if (o.showLift) {
      const badge = mk("span", "lift " + (o.lift >= 1.25 ? "up" : o.lift <= 0.8 ? "down" : "flat"), liftLabel(o.lift));
      badge.title = "表に入れている割合が、出番（全エピソードでの割合）の何倍か。高い段に入れているかとは別の数字です";
      line.append(badge);
    }
    if (o.score !== undefined) line.append(mk("span", "stat-score", aboveLabel(o.score)));
    if (o.n >= MIN_COUNT_FOR_BIAS) line.append(mk("span", "stat-tag", `平均${o.avgTier.toFixed(1)}段目`));
    main.append(line);
    if (o.detail) main.append(mk("div", "stat-detail", o.detail));
    const num = mk("div", "stat-num", `${o.n}話（${pctP(o.share)}）`);
    if (!o.noBase) num.append(mk("span", "stat-base", `全話では ${pctP(o.baseShare)}`));
    const bar = mk("div", "stat-bar");
    const fill = mk("span");
    fill.style.width = `${(o.n / o.maxN) * 100}%`;
    bar.append(fill);
    row.append(main, num, bar);
    if (!o.own || !o.own.length) return row;

    // Clickable: shows which of the placed episodes are counted here, grouped by the row they sit in.
    const item = mk("div", "stat-item");
    const hint = mk("span", "stat-hint");
    line.append(hint);
    let drill = null; // built on the first open: most rows are never opened, and each holds a tile per episode
    const setOpen = (open) => {
      if (open && !drill) {
        drill = drillContent(o.own);
        item.append(drill);
      }
      if (drill) drill.hidden = !open;
      hint.textContent = open ? "内訳 ▴" : "内訳 ▾";
      row.setAttribute("aria-expanded", String(open));
      if (open) statsOpen.add(o.drillId);
      else statsOpen.delete(o.drillId);
    };
    row.classList.add("clickable");
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    const isOpen = () => !!drill && !drill.hidden;
    row.addEventListener("click", () => setOpen(!isOpen()));
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        setOpen(!isOpen());
      }
    });
    item.append(row);
    setOpen(statsOpen.has(o.drillId));
    return item;
  }

  // The episodes behind a stat, grouped by the board row they are in (top row first). Click one for its details.
  function drillContent(own) {
    const box = mk("div", "stat-drill");
    const byTier = new Map();
    for (const p of own) {
      if (!byTier.has(p.ti)) byTier.set(p.ti, []);
      byTier.get(p.ti).push(p.ep);
    }
    [...byTier.keys()]
      .sort((a, b) => a - b)
      .forEach((ti) => {
        const t = state.tiers[ti];
        const eps = byTier.get(ti);
        const sec = mk("div", "drill-tier");
        const head = mk("div", "drill-head");
        const chip = mk("span", "stat-tier-chip", lineOf(t.name) || "　");
        chip.style.background = t.color;
        chip.style.color = textColorFor(t.color);
        head.append(chip, mk("span", "stat-tier-size", `${eps.length}話`));
        const grid = mk("div", "drill-eps");
        eps.forEach((ep) => {
          const b = mk("button", "drill-ep");
          b.type = "button";
          b.title = `${labelOf(ep)} ${ep.title}`;
          const img = new Image();
          img.src = thumbOf(ep);
          img.alt = "";
          b.append(img, mk("div", "dl", labelOf(ep)), mk("div", "dt", ep.title));
          b.addEventListener("click", () => openDetail(ep.no));
          grid.append(b);
        });
        sec.append(head, grid);
        box.append(sec);
      });
    return box;
  }

  /* --- calculation --- */

  // Counts "keys" (a group, a tag, a decade, a pair…) over the placed episodes and over all episodes.
  // keysOf(ep) returns the keys an episode carries.
  function bucketStats(placed, universe, keysOf) {
    const all = new Map();
    const mine = new Map();
    const own = new Map(); // key -> [{ ep, ti }]
    for (const e of universe) for (const k of new Set(keysOf(e))) all.set(k, (all.get(k) || 0) + 1);
    for (const p of placed) {
      for (const k of new Set(keysOf(p.ep))) {
        mine.set(k, (mine.get(k) || 0) + 1);
        if (!own.has(k)) own.set(k, []);
        own.get(k).push(p);
      }
    }
    const rows = [...all.keys()].map((key) => {
      const n = mine.get(key) || 0;
      const list = own.get(key) || [];
      const share = n / placed.length;
      const baseShare = all.get(key) / universe.length;
      return { key, n, share, baseShare, placedN: placed.length, allN: all.get(key), allTotal: universe.length, lift: share / baseShare, avgTier: n ? list.reduce((a, p) => a + p.ti + 1, 0) / n : 0, own: list };
    });
    return { rows, mine };
  }

  function sortBuckets(rows, sort, enough, keepZero) {
    if (sort === "key") return rows.slice().sort((a, b) => a.key - b.key);
    if (sort === "lift") return enough ? rows.filter((r) => r.n >= MIN_COUNT_FOR_BIAS).sort((a, b) => b.lift - a.lift) : [];
    return rows.filter((r) => keepZero || r.n > 0).sort((a, b) => b.n - a.n || b.lift - a.lift);
  }

  // Draws rows into a list element. o: label(key), icons?(key), detail?(row), score?, showLift?(row), enough, tab
  function drawBuckets(listEl, rows, o) {
    const maxN = Math.max(1, ...rows.map((r) => r.n));
    rows.forEach((r) =>
      listEl.append(
        statRow({
          icons: o.icons ? o.icons(r.key) : null,
          name: o.label(r.key),
          detail: o.detail ? o.detail(r) : "",
          lift: r.lift,
          avgTier: r.avgTier,
          score: o.score ? r.above : undefined,
          n: r.n,
          share: r.share,
          baseShare: r.baseShare,
          maxN,
          noBase: o.noBase,
          showLift: o.showLift ? o.showLift(r) : o.enough && r.n >= MIN_COUNT_FOR_BIAS,
          own: r.own,
          drillId: `${o.tab}|${r.key}`,
        })
      )
    );
  }

  function placedEpisodes(includeAnime) {
    const placed = [];
    state.tiers.forEach((t, ti) =>
      t.items.forEach((no) => {
        const ep = BY_NO.get(no);
        if (includeAnime || !isAnime(ep)) placed.push({ ep, ti });
      })
    );
    return placed;
  }

  const currentTab = () => document.querySelector('input[name="statsTab"]:checked').value;

  // The episodes a tab works on. "kind" is about manga vs anime and "compare" uses whole boards, so the
  // anime switch doesn't apply to those two.
  function statsContext(tab) {
    const usesSwitch = tab !== "kind" && tab !== "compare";
    const includeAnime = usesSwitch ? $("statsAnime").checked : true;
    const placed = placedEpisodes(includeAnime);
    return {
      usesSwitch,
      placed,
      universe: EPISODES.filter((e) => includeAnime || !isAnime(e)),
      enough: placed.length >= MIN_PLACED_FOR_BIAS,
    };
  }

  // Each function returns { lists: [{ rows, tab, label, icons?, detail?, score?, showLift?, empty, title, more? }],
  // top?, help? }. rows are sorted and ready to show; `imageRows` (optional) overrides them for the image.
  // 評価 = how much higher than the board's own average row the episodes of this key sit (positive = higher).
  // Independent of how often the key appears. Shrunk toward 0 for small n, so 3 lucky episodes don't beat 15 good ones.
  function addRating(rows, placed) {
    const boardAvg = placed.reduce((a, p) => a + p.ti + 1, 0) / placed.length;
    const SHRINK = 2;
    rows.forEach((r) => {
      r.above = r.n ? boardAvg - r.avgTier : 0; // rows above the board average
      r.rating = (r.above * r.n) / (r.n + SHRINK);
    });
  }
  const byRating = (rows) => rows.filter((r) => r.n >= MIN_COUNT_FOR_BIAS).sort((a, b) => b.rating - a.rating || b.n - a.n);

  const STATS_DATA = {
    char({ placed, universe, enough }) {
      const sort = $("statsSort").value;
      const keysOf = (ep) => ep.c;
      const { rows, mine } = bucketStats(placed, universe, keysOf);
      addRating(rows, placed);
      let shown;
      if (sort === "count") shown = sortBuckets(rows, "count", enough, false);
      else if (sort === "more") shown = sortBuckets(rows, "lift", enough, false);
      else if (sort === "less") shown = enough ? rows.filter((r) => r.baseShare >= 0.05).sort((a, b) => a.lift - b.lift) : [];
      else if (sort === "score") shown = byRating(rows);
      else shown = rows.filter((r) => r.n >= MIN_COUNT_FOR_BIAS).sort((a, b) => a.avgTier - b.avgTier || b.n - a.n);
      return {
        sort,
        help: STATS_HELP[sort],
        lists: [
          {
            rows: shown,
            tab: "char",
            label: charName,
            icons: (k) => [charIcon(k)],
            score: sort === "score",
            showLift: (r) => enough && (r.n >= MIN_COUNT_FOR_BIAS || sort === "less"),
            empty: (sort === "more" || sort === "less") && !enough ? NEED_BIAS : "この条件に当てはまるキャラはまだいません。",
            more: { btn: "statsMore", expanded: () => statsExpanded, top: STATS_TOP, unit: "人" },
          },
        ],
      };
    },

    group({ placed, universe, enough }) {
      const keysOf = (ep) => STATS_GROUPS.flatMap((g, i) => (ep.c.some((id) => g.ids.has(id)) ? [i] : []));
      const { rows } = bucketStats(placed, universe, keysOf);
      const label = (i) => STATS_GROUPS[i].name;
      const sort = $("groupSort").value; // "count" | "score"
      addRating(rows, placed);
      return {
        sort,
        lists: [
          {
            rows: sort === "score" ? byRating(rows) : sortBuckets(rows, "count", enough, true),
            tab: "group",
            label,
            score: sort === "score",
            empty: "3話以上に出ているグループが、まだありません。",
            detail: (r) => {
              const c = charCounts(r.own.map((p) => p.ep));
              const top = [...STATS_GROUPS[r.key].ids].map((id) => [id, c.get(id) || 0]).filter((x) => x[1] > 0).sort((a, b) => b[1] - a[1]).slice(0, 3);
              return top.length ? "中心：" + top.map(([id, n]) => `${charName(id)} ${n}`).join("、") : "";
            },
            enough,
          },
        ],
      };
    },

    combo({ placed, universe, enough }) {
      const withRegulars = $("comboRegulars").checked;
      const sort = $("comboSort").value;
      const regular = new Set(withRegulars ? [] : [...charCounts(universe).entries()].filter(([, n]) => n / universe.length >= REGULAR_SHARE).map(([id]) => id));
      const keysOf = (ep) => {
        const ids = ep.c.filter((id) => !regular.has(id)).sort((a, b) => a - b);
        const keys = [];
        for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) keys.push(`${ids[i]}-${ids[j]}`);
        return keys;
      };
      const { rows } = bucketStats(placed, universe, keysOf);
      const pair = (key) => key.split("-").map(Number);
      return {
        sort,
        lists: [
          {
            rows: sortBuckets(rows, sort, enough, false),
            tab: "combo",
            label: (k) => pair(k).map(charName).join(" × "),
            icons: (k) => pair(k).map(charIcon),
            enough,
            empty: sort === "lift" && !enough ? NEED_BIAS : "一緒に出ているコンビがまだありません。",
            more: { btn: "comboMore", expanded: () => comboExpanded, top: COMBO_TOP, unit: "組" },
          },
        ],
      };
    },

    era({ placed, universe, enough }) {
      const unit = $("eraUnit").value; // "decade" | "year"
      const basis = $("eraBasis").value; // "volume" | "anime"
      const sort = $("eraSort").value; // "key" | "count" | "rank"
      const keysOf = (ep) => {
        const y = yearOf(ep, basis);
        return y ? [unit === "decade" ? Math.floor(y / 10) * 10 : y] : [];
      };
      const word = unit === "decade" ? "年代" : "年";
      const label = (b) => (unit === "decade" ? `${b}年代` : `${b}年`);
      const { rows, mine } = bucketStats(placed, universe, keysOf);
      const byCount = rows.filter((x) => x.n > 0).sort((a, b) => b.n - a.n || a.key - b.key);
      const byRank = rows.filter((x) => x.n > 0).sort((a, b) => a.avgTier - b.avgTier || b.n - a.n || a.key - b.key);
      const best = byCount[0];
      return {
        sort,
        note:
          "アニメオリジナルは放送年で数えています。マンガは、" +
          (basis === "anime" ? "最初にアニメ化された放送年（アニメ化されていない事件は単行本の発売年）" : "その事件を収録した最初の単行本の発売年") +
          "で数えています。",
        top: best ? `いちばん多い${word}：${label(best.key)}（${best.n}話・${pct(best.share)}）` : "",
        word,
        lists: [
          {
            rows: sort === "count" ? byCount : sort === "rank" ? byRank : sortBuckets(rows, "key"),
            imageRows: sort === "rank" ? byRank : byCount, // "by year" order is not a ranking, so the image ranks by frequency
            tab: `era-${unit}`,
            showLift: () => false, // "出番" of a year is just how many episodes came out that year: not a preference
            noBase: true,
            label,
            enough,
          },
        ],
      };
    },

    place({ placed, universe, enough }) {
      const tagsOf = (kind) => (ep) => (ep.t || []).filter((id) => TAG_BY_ID.get(id) && TAG_BY_ID.get(id).kind === kind);
      const label = (id) => TAG_BY_ID.get(id).name;
      const lists = [];
      for (const [kind, title] of [["place", "舞台"], ["type", "事件のタイプ"]]) {
        const { rows } = bucketStats(placed, universe, tagsOf(kind));
        lists.push({ rows: sortBuckets(rows, "count", enough, true), tab: kind, label, enough, title });
      }
      return { sort: "count", lists };
    },

    kind({ placed, universe }) {
      const keysOf = (ep) => (isAnime(ep) ? ["anime"] : ["manga", hasTv(ep) ? "manga-tv" : "manga-notv"]);
      const label = (k) => KIND_KEYS.find((x) => x[0] === k)[1];
      const { rows, mine } = bucketStats(placed, universe, keysOf);
      const order = new Map(KIND_KEYS.map((x, i) => [x[0], i]));
      const shown = rows.slice().sort((a, b) => order.get(a.key) - order.get(b.key));
      const by = new Map(rows.map((r) => [r.key, r]));
      const m = by.get("manga");
      const a = by.get("anime");
      let top = "";
      if (m && a && m.n >= MIN_COUNT_FOR_BIAS && a.n >= MIN_COUNT_FOR_BIAS) {
        const d = a.avgTier - m.avgTier; // positive: manga sits higher
        top =
          Math.abs(d) < 0.3
            ? "マンガとアニメオリジナルで、入れている高さはほぼ同じです。"
            : d > 0
              ? `マンガ派：マンガの事件のほうが、平均${d.toFixed(1)}段上に入れています。`
              : `アニメ派：アニメオリジナルのほうが、平均${(-d).toFixed(1)}段上に入れています。`;
      }
      return {
        sort: "key",
        top,
        lists: [
          {
            rows: shown,
            imageRows: shown.filter((r) => r.key === "manga" || r.key === "anime"), // the two "うち" rows repeat the first
            tab: "kind",
            label,
            enough: placed.length >= MIN_PLACED_FOR_BIAS,
          },
        ],
      };
    },
  };

  /* --- the screen --- */

  // The elements each tab fills in. Tabs that are not shown are emptied, so the dialog never holds more than one tab's rows.
  const STATS_LAYOUT = {
    char: { lists: ["statsList"], help: "statsHelp" },
    group: { lists: ["groupList"] },
    combo: { lists: ["comboList"] },
    era: { lists: ["eraList"], top: "eraTop", note: "eraNote" },
    place: { lists: ["placeList", "typeList"] },
    kind: { lists: ["kindList"], top: "kindTop" },
    compare: { lists: ["compareBody"] },
  };
  const layoutIds = (t) => {
    const l = STATS_LAYOUT[t];
    return [...l.lists, l.help, l.top, l.note].filter(Boolean);
  };
  const clearStats = (except) => {
    for (const t of Object.keys(STATS_LAYOUT)) if (t !== except) layoutIds(t).forEach((id) => $(id).replaceChildren());
  };
  statsDlg.addEventListener("close", () => clearStats(null));

  function renderStats() {
    const tab = currentTab();
    STATS_TABS.forEach((t) => ($(`statsPanel-${t}`).hidden = t !== tab));
    clearStats(tab);
    const ctx = statsContext(tab);
    $("statsAnimeLabel").hidden = !ctx.usesSwitch;
    // the meaning of the numbers on screen: the rating one only when that sort is chosen
    const legend = $("statsLegend");
    legend.hidden = tab === "compare" || tab === "era";
    legend.replaceChildren(document.createTextNode(LEGEND_LIFT));
    if ((tab === "char" && $("statsSort").value === "score") || (tab === "group" && $("groupSort").value === "score")) legend.append(document.createElement("br"), document.createTextNode(LEGEND_ABOVE));
    const { placed } = ctx;
    const nManga = placed.filter((p) => !isAnime(p.ep)).length;
    $("statsSummary").textContent = placed.length && !viewMode
      ? `表に入れた${placed.length}話（マンガ${nManga}・アニメ${placed.length - nManga}）を集計しています。` +
        (!ctx.enough && tab !== "compare" ? `「出番の○倍」の表示は、${MIN_PLACED_FOR_BIAS}話以上入れると出ます。` : "")
      : "";
    if (tab === "compare") renderStatsCompare();
    else renderStatsTab(tab, ctx);
  }

  function renderStatsTab(tab, ctx) {
    const layout = STATS_LAYOUT[tab];
    layoutIds(tab).forEach((id) => $(id).replaceChildren());
    ["statsMore", "comboMore"].forEach((id) => ($(id).hidden = true));
    if (!ctx.placed.length) return void $(layout.lists[0]).append(statsNote(EMPTY_BOARD));
    const data = STATS_DATA[tab](ctx);
    if (layout.help && data.help) $(layout.help).textContent = data.help;
    if (layout.note && data.note) $(layout.note).textContent = data.note;
    if (layout.top) $(layout.top).textContent = data.top || "";
    data.lists.forEach((list, i) => {
      const el = $(layout.lists[i]);
      let rows = list.rows;
      if (!rows.length) el.append(statsNote(list.empty || "この条件に当てはまるものは、まだありません。"));
      if (list.more) {
        const btn = $(list.more.btn);
        btn.hidden = rows.length <= list.more.top;
        if (!btn.hidden) {
          rows = list.more.expanded() ? rows : rows.slice(0, list.more.top);
          btn.textContent = list.more.expanded() ? "上位だけ表示" : `もっと見る（あと${list.rows.length - list.more.top}${list.more.unit}）`;
        }
      }
      drawBuckets(el, rows, list);
    });
  }

  /* --- くらべる --- */
  const boardPositions = (tiers) => {
    // 1 = top row … 0 = bottom row, so boards with different numbers of rows can be compared
    const m = new Map();
    tiers.forEach((t, ti) => t.items.forEach((no) => m.set(no, { pos: tiers.length > 1 ? 1 - ti / (tiers.length - 1) : 1, tier: t })));
    return m;
  };
  const boardCharScores = (tiers) => {
    const m = new Map();
    tiers.forEach((t, ti) =>
      t.items.forEach((no) => {
        const w = (tiers.length - ti) / tiers.length;
        for (const id of BY_NO.get(no).c) m.set(id, (m.get(id) || 0) + w);
      })
    );
    return m;
  };

  // Compares the board with the friend's. Shared by the screen and the image.
  const myTiers = () => (viewMode ? ownState : state).tiers; // while viewing, the board on screen is the friend's
  function computeCompare() {
    const mine = boardPositions(myTiers());
    const theirs = boardPositions(compareBoard.tiers);
    const shared = [...mine.keys()].filter((no) => theirs.has(no));
    // Episodes only one of us put on the board, highest row first. Not being on the other board does NOT mean "rated low".
    const only = (from, other) => [...from.entries()].filter(([no]) => !other.has(no)).map(([no, side]) => ({ no, side })).sort((x, y) => y.side.pos - x.side.pos);
    const out = { mineN: mine.size, theirN: theirs.size, shared: shared.length, agreement: null, charSim: null, both: [], split: [], common: [], mineOnly: only(mine, theirs), theirOnly: only(theirs, mine) };
    if (shared.length < MIN_COUNT_FOR_BIAS) return out;
    const diffs = shared.map((no) => ({ no, a: mine.get(no), b: theirs.get(no), d: Math.abs(mine.get(no).pos - theirs.get(no).pos) }));
    out.agreement = 1 - diffs.reduce((s, x) => s + x.d, 0) / diffs.length;
    out.both = diffs.filter((x) => x.a.pos >= 0.75 && x.b.pos >= 0.75).sort((x, y) => y.a.pos + y.b.pos - (x.a.pos + x.b.pos));
    out.split = diffs.filter((x) => x.d >= 0.3).sort((x, y) => y.d - x.d);
    // Regulars (コナン, 蘭, 小五郎…) are in nearly every board, so leave them out or every pair looks alike.
    const everyone = charCounts(EPISODES);
    const regular = new Set([...everyone.entries()].filter(([, n]) => n / EPISODES.length >= REGULAR_SHARE).map(([id]) => id));
    const sa = boardCharScores(myTiers());
    const sb = boardCharScores(compareBoard.tiers);
    regular.forEach((id) => {
      sa.delete(id);
      sb.delete(id);
    });
    const ids = new Set([...sa.keys(), ...sb.keys()]);
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (const id of ids) {
      const x = sa.get(id) || 0;
      const y = sb.get(id) || 0;
      dot += x * y;
      na += x * x;
      nb += y * y;
    }
    if (na && nb) out.charSim = dot / Math.sqrt(na * nb);
    const totA = [...sa.values()].reduce((s, v) => s + v, 0);
    const totB = [...sb.values()].reduce((s, v) => s + v, 0);
    out.common = [...ids]
      .map((id) => ({ id, s: Math.min((sa.get(id) || 0) / totA, (sb.get(id) || 0) / totB) }))
      .filter((x) => x.s > 0)
      .sort((x, y) => y.s - x.s);
    return out;
  }

  function compareEpisodeRow(no, a, b) {
    const ep = BY_NO.get(no);
    const row = mk("div", "cmp-ep");
    const img = new Image();
    img.src = thumbOf(ep);
    img.alt = "";
    img.loading = "lazy"; // a full list can be long
    const main = mk("div", "cmp-main");
    main.append(mk("div", "cmp-title", `${labelOf(ep)}　${ep.title}`));
    const chips = mk("div", "cmp-chips");
    for (const [who, side] of [["あなた", a], ["相手", b]]) {
      if (!side) continue;
      const chip = mk("span", "cmp-chip", `${who}：${lineOf(side.tier.name) || "　"}`);
      chip.style.background = side.tier.color;
      chip.style.color = textColorFor(side.tier.color);
      chips.append(chip);
    }
    row.append(img, main, chips);
    // click / Enter opens the episode's details (over the stats dialog, like the tiles in the breakdowns)
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    row.title = "クリックで詳細を表示";
    row.addEventListener("click", () => openDetail(no));
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openDetail(no);
      }
    });
    return row;
  }

  function renderStatsCompare() {
    const body = $("compareBody");
    body.replaceChildren();
    $("compareClear").hidden = !compareBoard;
    if (!compareBoard) return void body.append(statsNote("まだ相手の表を読み込んでいません。友達のリンクを開くか、貼り付けてください。"));
    const c = computeCompare();
    body.append(mk("p", "cmp-name", `相手の表：${compareBoard.title || "（タイトルなし）"}（${compareBoard.name}）`));
    const cards = mk("div", "cmp-cards");
    const card = (big, small) => {
      const el = mk("div", "cmp-card");
      el.append(mk("div", "cmp-big", big), mk("div", "cmp-small", small));
      cards.append(el);
    };
    card(`${c.shared}話`, `共通のエピソード（あなた${c.mineN}話・相手${c.theirN}話）`);
    if (c.agreement !== null) card(pct(c.agreement), "評価の近さ（共通の話を入れた高さの近さ）");
    if (c.charSim !== null) card(pct(c.charSim), "推しキャラの近さ（いつも出るキャラを除く）");
    body.append(cards);
    const section = (key, title, items, empty, row) => {
      body.append(mk("h4", "stats-h", title));
      const box = mk("div", "cmp-list");
      if (!items.length) box.append(statsNote(empty));
      const open = cmpExpanded.has(key);
      (open ? items : items.slice(0, 6)).forEach((x) => box.append(row(x)));
      if (items.length > 6) {
        const btn = mk("button", "btn btn-ghost btn-sm cmp-more", open ? "閉じる" : `ほか ${items.length - 6}話も表示`);
        btn.type = "button";
        btn.addEventListener("click", () => {
          if (open) cmpExpanded.delete(key);
          else cmpExpanded.add(key);
          renderStats();
        });
        box.append(btn);
      }
      body.append(box);
    };
    const both = (x) => compareEpisodeRow(x.no, x.a, x.b);
    if (c.agreement === null) {
      body.append(statsNote(`共通のエピソードが${MIN_COUNT_FOR_BIAS}話以上あると、評価の近さなどを表示します。`));
    } else {
      section("both", "二人とも上位に入れた話", c.both, "二人とも上位の行に入れた話は、まだありません。", both);
      section("split", "評価が分かれた話", c.split, "大きく評価が分かれた話は、ありません。", both);
    }
    // one-sided lists don't need any shared episodes
    section("mine", "あなただけが評価した話", c.mineOnly, "相手の表に入っていない話は、ありません。", (x) => compareEpisodeRow(x.no, x.side, null));
    section("their", "相手だけが評価した話", c.theirOnly, "あなたの表に入っていない話は、ありません。", (x) => compareEpisodeRow(x.no, null, x.side));
    body.append(mk("p", "dlg-note", "「だけが評価した話」は、もう一方の表に入っていない話です。低く評価している、という意味ではなく、まだ見ていないだけかもしれません。"));
    if (c.agreement !== null) {
      body.append(mk("h4", "stats-h", "二人とも推していそうなキャラ"));
      const chars = mk("div", "cmp-chars");
      c.common.slice(0, 6).forEach((x) => {
        const tag = mk("span", "char-tag");
        const img = new Image();
        img.src = charIcon(x.id);
        img.alt = "";
        tag.append(img, document.createTextNode(charName(x.id)));
        chars.append(tag);
      });
      body.append(chars);
    }
  }

  async function loadCompareFile(file) {
    if (!file) return;
    if (file.size > IMPORT_MAX_BYTES) return alert(IMPORT_ERROR);
    let board = null;
    try {
      const raw = JSON.parse(await file.text());
      board = sanitize(raw);
    } catch (e) {
      board = null;
    }
    if (!board) return alert(IMPORT_ERROR);
    compareBoard = { name: file.name, title: board.title, tiers: board.tiers };
    renderStats();
  }

  /* --- the saved image: a summary card, not a copy of the screen --- */

  // What the image is about, printed under its title.
  const STATS_IMAGE_SUB = { char: "キャラクター", group: "グループ", combo: "コンビ", era: "年代", place: "舞台・事件のタイプ", kind: "マンガ・アニメ", compare: "友達とくらべる" };
  const IMAGE_THUMBS = 6; // episodes shown under each ranking entry
  const chosen = (id) => $(id).options[$(id).selectedIndex].textContent;

  // The options in effect, printed small on the image so it can be read without the screen.
  function statsConditions(tab) {
    const parts = [];
    if (tab !== "kind" && tab !== "compare") parts.push($("statsAnime").checked ? "アニメオリジナルを含む" : "マンガのみ");
    if (tab === "char") parts.push(`並び順：${chosen("statsSort")}`);
    if (tab === "group") parts.push(`並び順：${chosen("groupSort")}`);
    if (tab === "combo") parts.push(`並び順：${chosen("comboSort")}`, $("comboRegulars").checked ? "いつも出るキャラも含む" : "いつも出るキャラは除く");
    if (tab === "era") parts.push(chosen("eraUnit"), $("eraSort").value === "rank" ? "平均段が良い順" : "頻度が高い順", chosen("eraBasis"));
    return parts.join(" ／ ");
  }

  // A thumbnail with the row it sits in: the point of the image is "where did I put these".
  function imageThumb(ep, chips) {
    const box = mk("div", "xt");
    const pic = mk("div", "xt-pic");
    const img = new Image();
    img.src = ep.img; // the full-size picture: these are shown large
    img.alt = "";
    pic.append(img);
    const bar = mk("div", "xt-chips");
    chips.forEach(([text, tier]) => {
      const chip = mk("span", "xt-chip", text);
      chip.style.background = tier.color;
      chip.style.color = textColorFor(tier.color);
      bar.append(chip);
    });
    pic.append(bar);
    box.append(pic, mk("div", "xt-label", labelOf(ep)), mk("div", "xt-title", ep.title));
    return box;
  }

  // One ranking entry: medal, name, key numbers, and the episodes behind it (top rows first).
  // `used` holds the episodes already pictured in earlier entries of this ranking (used only to choose, never to hide).
  function imageCard(rank, list, r, used) {
    const card = mk("div", "xc");
    const head = mk("div", "xc-head");
    head.append(mk("div", `xc-rank r${Math.min(rank, 4)}`, String(rank)));
    if (list.icons) {
      const icons = mk("div", "xc-icons");
      list.icons(r.key).forEach((src) => {
        const img = new Image();
        img.src = src;
        img.alt = "";
        icons.append(img);
      });
      head.append(icons);
    }
    const title = mk("div", "xc-title");
    title.append(mk("div", "xc-name", list.label(r.key)));
    const tags = mk("div", "xc-tags");
    if (list.score) tags.append(mk("span", "stat-score", aboveLabel(r.above)));
    if (r.n >= MIN_COUNT_FOR_BIAS) tags.append(mk("span", "stat-tag", `平均${r.avgTier.toFixed(1)}段目`));
    const showLift = list.showLift ? list.showLift(r) : list.enough && r.n >= MIN_COUNT_FOR_BIAS;
    if (showLift) tags.append(mk("span", "lift " + (r.lift >= 1.25 ? "up" : r.lift <= 0.8 ? "down" : "flat"), liftLabel(r.lift)));
    title.append(tags);
    if (showLift) title.append(mk("div", "xc-calc", `表 ${pctP(r.share)}（${r.n}/${r.placedN}話）÷ 全エピソード ${pctP(r.baseShare)}（${r.allN}/${r.allTotal}話）＝ ${r.lift.toFixed(1)}倍`));
    head.append(title, mk("div", "xc-num", `${r.n}話`));
    card.append(head);
    if (r.own.length) {
      // Everything that fits is shown, even when an earlier card already shows the same episode (コナン, 蘭 and 小五郎 share
      // most of theirs). Only when there are more than fit are the episodes not shown yet preferred, so the pictures
      // don't all repeat; the rest is said to be left out.
      const byRow = r.own.slice().sort((a, b) => a.ti - b.ti); // top rows first
      const chosen = new Set([...byRow.filter((p) => !used.has(p.ep.no)), ...byRow.filter((p) => used.has(p.ep.no))].slice(0, IMAGE_THUMBS));
      const picked = byRow.filter((p) => chosen.has(p)); // back to top-rows-first order
      picked.forEach((p) => used.add(p.ep.no));
      const eps = mk("div", "xc-eps");
      picked.forEach((p) => eps.append(imageThumb(p.ep, [[lineOf(state.tiers[p.ti].name) || "　", state.tiers[p.ti]]])));
      card.append(eps);
      if (byRow.length > picked.length) card.append(mk("div", "xc-more", `ほか ${byRow.length - picked.length}話は省略`));
    }
    return card;
  }

  function buildRankSheet(sheet, tab, n) {
    const ctx = statsContext(tab);
    const data = STATS_DATA[tab](ctx);
    // The one sentence worth keeping is a conclusion the ranking does not show: マンガ派 / アニメ派.
    if (tab === "kind" && data.top) sheet.append(mk("p", "xs-headline", data.top));
    data.lists.forEach((list) => {
      const rows = (list.imageRows || list.rows).filter((r) => r.n > 0 || data.sort === "less").slice(0, tab === "kind" ? 2 : n);
      const title =
        list.title ? `${list.title} Top${n}` : tab === "kind" ? "マンガとアニメオリジナル" : `${{ char: chosen("statsSort"), group: chosen("groupSort"), combo: chosen("comboSort"), era: $("eraSort").value === "rank" ? "平均段が良い順" : "頻度が高い順" }[tab]}　Top${n}`;
      sheet.append(mk("h3", "xs-section", title));
      if (!rows.length) sheet.append(mk("p", "xs-empty", list.empty || "当てはまるものは、まだありません。"));
      const used = new Set();
      rows.forEach((r, i) => sheet.append(imageCard(i + 1, list, r, used)));
    });
  }

  function buildCompareSheet(sheet, n) {
    const c = computeCompare();
    sheet.append(mk("p", "xs-friend", `相手の表：${compareBoard.title || "（タイトルなし）"}`));
    const cards = mk("div", "cmp-cards");
    const card = (big, small) => {
      const el = mk("div", "cmp-card");
      el.append(mk("div", "cmp-big", big), mk("div", "cmp-small", small));
      cards.append(el);
    };
    card(`${c.shared}話`, `共通のエピソード（あなた${c.mineN}話・相手${c.theirN}話）`);
    if (c.agreement !== null) card(pct(c.agreement), "評価の近さ");
    if (c.charSim !== null) card(pct(c.charSim), "推しキャラの近さ");
    sheet.append(cards);
    const eps = (title, items, empty, chipsOf) => {
      sheet.append(mk("h3", "xs-section", `${title} Top${n}`));
      if (!items.length) sheet.append(mk("p", "xs-empty", empty));
      const row = mk("div", "xc-eps");
      items.slice(0, n).forEach((x) => row.append(imageThumb(BY_NO.get(x.no), chipsOf(x))));
      sheet.append(row);
    };
    if (c.agreement === null) sheet.append(mk("p", "xs-empty", `共通のエピソードが${MIN_COUNT_FOR_BIAS}話以上あると、評価の近さなどを表示します。`));
    else {
      const bothChips = (x) => [[`あなた ${lineOf(x.a.tier.name)}`, x.a.tier], [`相手 ${lineOf(x.b.tier.name)}`, x.b.tier]];
      eps("二人とも上位に入れた話", c.both, "二人とも上位の行に入れた話は、まだありません。", bothChips);
      eps("評価が分かれた話", c.split, "大きく評価が分かれた話は、ありません。", bothChips);
    }
    eps("あなただけが評価した話", c.mineOnly, "相手の表に入っていない話は、ありません。", (x) => [[`あなた ${lineOf(x.side.tier.name)}`, x.side.tier]]);
    eps("相手だけが評価した話", c.theirOnly, "あなたの表に入っていない話は、ありません。", (x) => [[`相手 ${lineOf(x.side.tier.name)}`, x.side.tier]]);
    if (c.agreement === null) return;
    sheet.append(mk("h3", "xs-section", `二人とも推していそうなキャラ Top${n}`));
    const chars = mk("div", "cmp-chars");
    c.common.slice(0, n).forEach((x) => {
      const tag = mk("span", "char-tag");
      const img = new Image();
      img.src = charIcon(x.id);
      img.alt = "";
      tag.append(img, document.createTextNode(charName(x.id)));
      chars.append(tag);
    });
    sheet.append(chars);
  }

  async function exportStatsImage(format) {
    const tab = currentTab();
    const n = Number($("statsTopN").value) || 3;
    const stage = mk("div", "export-stage");
    const sheet = mk("div", "xs");
    sheet.append(mk("h2", "xs-title", `${((viewMode ? ownState : state).title || "").trim() || "Tier表"}の集計`), mk("p", "xs-sub", STATS_IMAGE_SUB[tab]));
    if (tab === "compare") buildCompareSheet(sheet, n);
    else buildRankSheet(sheet, tab, n);
    // how many episodes were counted and which options were on: useful, but not the point, so it goes last
    const summary = statsContext(tab).placed.length ? $("statsSummary").textContent.split("「出番の○倍」の表示は")[0].replace("を集計しています。", "") : "";
    const settings = statsConditions(tab).split(" ／ ").filter(Boolean);
    const notes = mk("div", "xs-notes");
    const compareNote = tab === "compare" ? "「だけが評価した話」＝もう一方の表に入っていない話（低く評価している、とは別）" : "";
    [[summary, ...settings].filter(Boolean).join("　／　"), sheet.querySelector(".lift") ? LEGEND_LIFT : "", sheet.querySelector(".stat-score") ? LEGEND_ABOVE : "", compareNote]
      .filter(Boolean)
      .forEach((line) => notes.append(mk("p", "", line)));
    if (notes.children.length) sheet.append(notes);
    sheet.append(mk("p", "xs-credit", "名探偵コナン 好きなエピソード Tier表メーカー ／ 出典：少年サンデー公式「全事件レポート編纂室」／読売テレビ「事件ファイル」 ©青山剛昌／小学館"));
    stage.append(sheet);
    document.body.append(stage);
    try {
      return await captureNode(sheet, format, "#202027");
    } finally {
      stage.remove();
    }
  }

  $("statsSaveBtn").addEventListener("click", async () => {
    const tab = currentTab();
    if (tab === "compare" && !compareBoard) return alert("先に、友達のファイルを選んでください。");
    if (!placedEpisodes(true).length) return alert("表にエピソードを入れてから、保存してください。");
    const format = saveFormat;
    const btn = $("statsSaveBtn");
    const idle = btn.textContent;
    const dataUrl = await withProgress(btn, idle, () => exportStatsImage(format));
    if (dataUrl) downloadImage(dataUrl, format, `conan_episode_tier_stats_${tab}_${dateStamp()}.${format === "jpeg" ? "jpg" : "png"}`);
  });

  /* --- share a board as a link (no server: the board is inside the link) --- */

  // { t: title, r: [[name, color, [episode numbers]], …] } -> JSON -> deflate -> base64url, prefixed with a version digit
  // ("1" = deflate, "0" = plain when the browser has no CompressionStream).
  const SHARE_PREFIX = "#c=";
  const SHARE_MAX_CHARS = 20000;
  const toB64u = (bytes) => {
    let bin = "";
    for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };
  const fromB64u = (str) => Uint8Array.from(atob(str.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  const pipeBytes = async (bytes, stream) => new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());

  async function encodeBoard() {
    const raw = new TextEncoder().encode(JSON.stringify({ t: state.title, r: state.tiers.map((t) => [t.name, t.color, t.items]) }));
    if (typeof CompressionStream === "undefined") return "0" + toB64u(raw);
    return "1" + toB64u(await pipeBytes(raw, new CompressionStream("deflate-raw")));
  }

  // Returns a sanitized board ({ title, tiers, mode }) or null. Anything from a link is untrusted, so it goes through sanitize().
  async function decodeBoard(payload) {
    try {
      if (!payload || payload.length > SHARE_MAX_CHARS) return null;
      let bytes = fromB64u(payload.slice(1));
      if (payload[0] === "1") bytes = await pipeBytes(bytes, new DecompressionStream("deflate-raw"));
      else if (payload[0] !== "0") return null;
      if (bytes.length > 400000) return null;
      const o = JSON.parse(new TextDecoder().decode(bytes));
      if (!o || !Array.isArray(o.r)) return null;
      return sanitize({ title: o.t, tiers: o.r.map((t) => ({ name: (t || [])[0], color: (t || [])[1], items: (t || [])[2] })) });
    } catch (e) {
      return null;
    }
  }

  const shareBase = () => location.href.split("#")[0];

  // The link for the current board, or "" while the board is empty. Cached by board content.
  async function shareLinkNow() {
    if (!placedEpisodes(true).length) return "";
    const key = snapshot();
    if (shareCache.key !== key) shareCache = { key, link: shareBase() + SHARE_PREFIX + (await encodeBoard()) };
    return shareCache.link;
  }
  function scheduleShareLink() {
    clearTimeout(shareTimer);
    shareTimer = setTimeout(() => shareLinkNow().catch(() => {}), 300);
  }
  async function myShareLink() {
    if (!placedEpisodes(true).length) {
      toast("表にエピソードを入れてから、リンクを作ってください");
      return null;
    }
    return shareBase() + SHARE_PREFIX + (await encodeBoard());
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;left:-9999px";
      document.body.append(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    }
  }

  $("linkCopyBtn").addEventListener("click", async () => {
    const url = await myShareLink();
    if (url) toast((await copyText(url)) ? "リンクをコピーしました。Xなどに貼って共有できます" : "コピーできませんでした。もう一度お試しください");
  });
  $("linkPostBtn").addEventListener("click", async () => {
    const url = await myShareLink();
    if (!url) return;
    const text = "私の名探偵コナンのエピソードTier表です。あなたの表とくらべてみてください！ #名探偵コナン";
    window.open(`https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`, "_blank", "noopener");
  });

  async function loadShared(payload, label) {
    const board = await decodeBoard(payload);
    if (!board) return false;
    compareBoard = { name: label, title: board.title, tiers: board.tiers };
    return true;
  }
  $("linkLoadBtn").addEventListener("click", async () => {
    const text = $("linkPaste").value.trim();
    const at = text.indexOf(SHARE_PREFIX);
    if (at < 0 || !(await loadShared(text.slice(at + SHARE_PREFIX.length), "友達のリンク"))) return alert("読み込めませんでした。このサイトで作ったリンクを貼り付けてください。");
    $("linkPaste").value = "";
    renderStats();
  });

  function enterView(board, name) {
    if (!viewMode) ownState = state;
    viewMode = true;
    state = { ...board, mode: ownState.mode, notes: ownState.notes }; // keep the viewer's own display setting and memos (memos are about the episode, not whose board is shown)
    document.body.classList.add("viewing");
    titleEl.contentEditable = "false";
    titleEl.textContent = state.title;
    const t = (board.title || "").trim();
    $("viewBannerText").textContent = t ? `「${t}」を表示中（閲覧モード）` : `${name}の表を表示中（閲覧モード）`;
    // the friend's board is also the "other side" of a comparison, which only makes sense if we have a board of our own
    compareBoard = { name: "リンクから", title: board.title, tiers: board.tiers };
    const hasOwn = ownState.tiers.some((t) => t.items.length);
    $("viewCompareBtn").hidden = !hasOwn;
    $("viewExitBtn").textContent = hasOwn ? "自分の表に戻る" : "自分の表を作る";
    $("viewBanner").hidden = false;
    render();
    window.scrollTo(0, 0);
  }

  function exitView() {
    if (!viewMode) return;
    state = ownState;
    ownState = null;
    viewMode = false;
    document.body.classList.remove("viewing");
    titleEl.contentEditable = "true";
    titleEl.textContent = state.title;
    $("viewBanner").hidden = true;
    syncModeRadios();
    render();
  }
  $("viewExitBtn").addEventListener("click", exitView);
  // Compare is opt-in: nothing opens by itself when a link is opened.
  $("viewCompareBtn").addEventListener("click", () => {
    document.querySelector('input[name="statsTab"][value="compare"]').checked = true;
    statsOpen.clear();
    cmpExpanded.clear();
    renderStats();
    statsDlg.showModal();
  });

  // Opened from a friend's link: always show theirs in view mode; comparing with our own board is a button in the banner.
  async function openIncomingShare() {
    if (!location.hash.startsWith(SHARE_PREFIX)) return;
    const payload = location.hash.slice(SHARE_PREFIX.length);
    history.replaceState(null, "", location.pathname + location.search); // the link is one-shot: a reload shouldn't re-open it
    const board = await decodeBoard(payload);
    if (!board) return toast("リンクを読み込めませんでした");
    enterView(board, "友達");
  }

  $("compareBtn").addEventListener("click", () => $("compareFile").click());
  $("compareFile").addEventListener("change", async () => {
    await loadCompareFile($("compareFile").files[0]);
    $("compareFile").value = "";
  });
  $("compareClear").addEventListener("click", () => {
    compareBoard = null;
    renderStats();
  });

  $("statsBtn").addEventListener("click", () => {
    statsOpen.clear();
    cmpExpanded.clear();
    statsExpanded = false;
    comboExpanded = false;
    renderStats();
    statsDlg.showModal();
  });
  ["statsSort", "groupSort", "statsAnime", "eraUnit", "eraSort", "eraBasis", "comboSort", "comboRegulars"].forEach((id) =>
    $(id).addEventListener("change", () => {
      statsExpanded = false;
      comboExpanded = false;
      renderStats();
    })
  );
  document.querySelectorAll('input[name="statsTab"]').forEach((r) => r.addEventListener("change", renderStats));
  $("statsMore").addEventListener("click", () => {
    statsExpanded = !statsExpanded;
    renderStats();
  });
  $("comboMore").addEventListener("click", () => {
    comboExpanded = !comboExpanded;
    renderStats();
  });

  /* ------------------------------------------------------------------- boot */

  // on narrow screens, the rarely used buttons (reset / export / import) live at the bottom of the page
  const dataTools = $("dataTools");
  const dataToolsHome = dataTools.parentNode;
  const narrowMq = matchMedia("(max-width: 899px)");
  const placeDataTools = () => ($("dataToolsSlot") && narrowMq.matches ? $("dataToolsSlot") : dataToolsHome).appendChild(dataTools);
  placeDataTools();
  narrowMq.addEventListener("change", placeDataTools);

  titleEl.textContent = state.title;
  syncModeRadios();
  render();
  renderCharChips();
  openIncomingShare();
  window.addEventListener("hashchange", openIncomingShare); // a link opened while the app is already open
})();
