(() => {
  "use strict";

  // start/end (seconds) mark each song's slice of the linked video; end = next song's start (last song has none).
  // Songs added after the video was made (no "start") aren't in it at all - they just don't get a play button.
  // Movie theme songs (window.MOVIE_THEMES) go after all the TV OP/ED, in movie release order; they never have
  // a "start" either (they're not in the TV compilation video), so they only ever play their own official PV.
  const ALL_SONGS = [...(window.OPENINGS || []), ...(window.MOVIE_THEMES || [])];
  const SONGS = ALL_SONGS.map((s, i, arr) => ({
    ...s,
    end: arr[i + 1] && arr[i + 1].start != null ? arr[i + 1].start : Infinity,
  }));
  const BY_NO = new Map(SONGS.map((s) => [s.no, s]));
  // SONGS is already in the intended browsing order (TV曲→劇場版主題歌), used for 放送順に並び替え.
  const IDX_BY_NO = new Map(SONGS.map((s, i) => [s.no, i]));
  const VIDEO_ID = window.OP_VIDEO_ID;

  const STORAGE_KEY = "conanOpeningTier.v1";
  // 「好きな曲だけTierに入れる」使い方だと、未分類のままの曲が「まだ見てない」のか「見た上でTierに入れなかった」のか
  // 分からなくなるので、Tierとは別に「確認済み」を曲ごとに覚えておく（プールに残ったままのカードを見分けるためだけの印）。
  const SEEN_KEY = "conanOpeningTier.seen";
  let seenSet = new Set();
  try {
    seenSet = new Set(JSON.parse(localStorage.getItem(SEEN_KEY)) || []);
  } catch (e) { /* default to empty */ }
  function saveSeen() {
    try { localStorage.setItem(SEEN_KEY, JSON.stringify([...seenSet])); } catch (e) { /* not remembered, still works */ }
  }
  function setSeen(no, on) {
    if (on) seenSet.add(no);
    else seenSet.delete(no);
    saveSeen();
    const el = itemCache.get(no);
    if (el) el.classList.toggle("op-seen", on);
  }
  const DEFAULT_TITLE = "好きな名探偵コナンの主題歌 Tier表";
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
  // Every song gets a plain colored card (there is no official per-song art to show) - one color per artist,
  // so the same artist's songs are visually grouped, not a fresh color for every one of the 133 songs.
  // A separate, more muted palette from the row colors above (those need to stay bright/candy-toned to match
  // the other two Tier makers; these just need to look good as ~130 small cards next to each other).
  // 倉木麻衣はコナンにとって特別なアーティスト（主題歌を最も多く手がけている）なので、
  // 一番鮮やかな #d65a5a を専用色として周期パレットから外し、他のアーティストとは絶対に被らないようにする。
  const CARD_PALETTE = [
    "#d68a4a", "#c9a63c", "#8fae3f", "#3f9e6b", "#3aa39c", "#3f88b8", "#4f6fc0",
    "#6f5fc0", "#9c52ac", "#b8508a", "#5a6472",
  ];
  const KURAKI_MAI = "倉木麻衣";
  const KURAKI_MAI_COLOR = "#d65a5a";
  const artistColor = (() => {
    const map = new Map();
    let i = 0;
    return (artist) => {
      if (!map.has(artist)) {
        map.set(artist, artist === KURAKI_MAI ? KURAKI_MAI_COLOR : CARD_PALETTE[i++ % CARD_PALETTE.length]);
      }
      return map.get(artist);
    };
  })();

  const $ = (id) => document.getElementById(id);
  const boardEl = $("board");
  const tiersEl = $("tiers");
  const titleEl = $("listTitle");
  const poolEl = $("pool");
  const poolGrid = $("poolGrid");
  const poolCount = $("poolCount");

  /* ------------------------------------------------------------------ state */

  let idSeq = 0;
  const newId = () => `t${Date.now().toString(36)}${(idSeq++).toString(36)}`;

  function defaultState() {
    return {
      title: DEFAULT_TITLE,
      tiers: DEFAULT_TIERS.map((t) => ({ id: newId(), name: t.name, color: t.color, items: [] })),
    };
  }

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
    return { title: typeof raw.title === "string" ? raw.title.slice(0, 100) : DEFAULT_TITLE, tiers };
  }

  function loadState() {
    try {
      return sanitize(JSON.parse(localStorage.getItem(STORAGE_KEY)));
    } catch (e) {
      return null;
    }
  }

  let state = loadState() || defaultState();
  let viewMode = false;
  let ownState = null;

  function save() {
    if (viewMode) return; // never write a friend's board over our own
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      /* private mode / storage disabled: the app still works, it just won't remember */
    }
  }

  /* ------------------------------------------------------------ undo / redo */

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

  function track(change) {
    const before = snapshot();
    change();
    if (snapshot() !== before) pushHistory(before);
    editBefore = snapshot();
    editPushed = false;
  }

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
    if (!undoStack.length) return;
    redoStack.push(snapshot());
    applySnapshot(undoStack.pop());
    updateHistoryButtons();
    toast("元に戻しました");
  }
  function redo() {
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

  function moveSong(no, tierId, index) {
    if (viewMode) return; // never move anything in a friend's board
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

  $("sortByOrderBtn").addEventListener("click", () => {
    if (!confirm("各行の中の並び順を、放送・掲載順に並び替えます。\n自分でつけた行内の細かい並び順は失われます。よろしいですか？")) return;
    track(() => {
      state.tiers.forEach((t) => t.items.sort((a, b) => IDX_BY_NO.get(a) - IDX_BY_NO.get(b)));
    });
    save();
    render();
    toast("放送順に並び替えました");
  });

  /* --- share a board as a link (no server: the board is inside the link) --- */

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

  // Returns a sanitized board ({ title, tiers }) or null. Anything from a link is untrusted, so it goes through sanitize().
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

  async function myShareLink() {
    if (!state.tiers.some((t) => t.items.length)) {
      toast("表に曲を入れてから、リンクを作ってください");
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
  // Friend's link: replaces the view with their board (read-only). Nothing is saved over our own board -
  // save() is guarded by viewMode, so leaving view mode always restores exactly what we had.
  function enterView(board) {
    if (!viewMode) ownState = state;
    viewMode = true;
    state = board;
    document.body.classList.add("viewing");
    titleEl.contentEditable = "false";
    titleEl.textContent = state.title;
    const t = (board.title || "").trim();
    $("viewBannerText").textContent = t ? `「${t}」を表示中（閲覧モード）` : "友達の表を表示中（閲覧モード）";
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
    render();
  }
  $("viewExitBtn").addEventListener("click", exitView);

  async function openIncomingShare() {
    if (!location.hash.startsWith(SHARE_PREFIX)) return;
    const payload = location.hash.slice(SHARE_PREFIX.length);
    history.replaceState(null, "", location.pathname + location.search); // the link is one-shot: a reload shouldn't re-open it
    const board = await decodeBoard(payload);
    if (!board) return toast("リンクを読み込めませんでした");
    enterView(board);
  }

  /* -------------------------------------------------------------- rendering */

  const itemCache = new Map();

  function itemEl(s) {
    let d = itemCache.get(s.no);
    if (d) return d;
    d = document.createElement("div");
    d.className = "item";
    if (seenSet.has(s.no)) d.classList.add("op-seen");
    d.dataset.no = s.no;
    d.tabIndex = 0;
    d.setAttribute("role", "button");
    d.title = `${s.artist}「${s.title}」`;

    const art = document.createElement("div");
    art.className = "op-art";
    art.style.backgroundColor = artistColor(s.artist); // backgroundColor only, so the CSS gradient/accent-bar (background-image) still shows on top
    art.style.color = textColorFor(artistColor(s.artist));
    const artist = document.createElement("span");
    artist.className = "op-artist";
    artist.textContent = s.artist;
    const title = document.createElement("span");
    title.className = "op-title";
    title.textContent = s.title;
    art.append(artist, title);
    if (s.movieNo) {
      // TVのOP/EDが映画の主題歌としても使われた曲は、映画オリジナルの曲と分かるように表示を変える。
      const badge = document.createElement("span");
      badge.className = "op-movie-badge";
      badge.textContent = s.epRange ? "TV+映画" : "映画";
      art.append(badge);
    }
    const age = ageThen(s.no);
    if (age != null && age >= 0) {
      const ageBadge = document.createElement("span");
      ageBadge.className = "op-age-badge no-export";
      ageBadge.textContent = `${age}歳`;
      art.append(ageBadge);
    }

    d.append(art);
    if (s.start != null || s.video) {
      const play = document.createElement("button");
      play.type = "button";
      play.className = "op-play no-export";
      play.setAttribute("aria-label", "この曲を再生");
      play.textContent = "▶";
      // Keep this button out of the drag/tap-to-open system: it has its own job.
      play.addEventListener("pointerdown", (e) => e.stopPropagation());
      play.addEventListener("click", (e) => {
        e.stopPropagation();
        playSong(s.no);
      });
      d.append(play);
    }
    const seen = document.createElement("button");
    seen.type = "button";
    seen.className = "op-seen-btn no-export";
    seen.setAttribute("aria-label", "確認済みにする（見た上でTierに入れなかった曲の印）");
    seen.textContent = "✓";
    // Keep this button out of the drag/tap-to-open system, same as the play button above.
    seen.addEventListener("pointerdown", (e) => e.stopPropagation());
    seen.addEventListener("click", (e) => {
      e.stopPropagation();
      setSeen(s.no, !seenSet.has(s.no));
      renderPool();
    });
    d.append(seen);
    itemCache.set(s.no, d);
    return d;
  }

  function textColorFor(hex) {
    const n = parseInt(hex.slice(1), 16);
    const lum = 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
    return lum > 140 ? "#111" : "#fff";
  }

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
        div.textContent = ln || " ";
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

  let newestFirst = false;
  const sortBtn = $("sortBtn");
  sortBtn.addEventListener("click", () => {
    newestFirst = !newestFirst;
    sortBtn.textContent = newestFirst ? "並び：逆順" : "並び：放送順";
    renderPool();
  });

  // モバイルでは一覧がずっと画面の4割強を占めるので、タイトルバーを上下にドラッグして高さを変えられるように
  // する（ボタンは、最小の高さ⇄既定の高さ（CSSの42dvh）を切り替えるショートカット）。
  const POOL_MIN_H = 78; // just the title row (+ grab handle) - the filters below are hidden at this height (.is-min)
  const poolHeadEl = $("poolHead");
  let poolDrag = null;
  poolHeadEl.addEventListener("pointerdown", (e) => {
    if (!matchMedia("(max-width: 899px)").matches) return;
    if (e.target.closest("button, select, input, a, label")) return; // let the existing controls keep working
    poolDrag = { id: e.pointerId, startY: e.clientY, startH: poolEl.getBoundingClientRect().height };
    poolEl.classList.add("is-resizing");
    e.preventDefault();
  });
  window.addEventListener("pointermove", (e) => {
    if (!poolDrag || e.pointerId !== poolDrag.id) return;
    const delta = poolDrag.startY - e.clientY; // dragging up = growing
    const max = window.innerHeight - 64;
    poolEl.style.height = `${Math.max(POOL_MIN_H, Math.min(max, poolDrag.startH + delta))}px`;
    syncPoolMin();
  });
  // the height being animated to (inline style), not the mid-transition one
  const poolH = () => (poolEl.style.height ? parseFloat(poolEl.style.height) : poolEl.getBoundingClientRect().height);
  const syncPoolMin = () => poolEl.classList.toggle("is-min", poolH() <= POOL_MIN_H + 6);
  function updatePoolCollapseLabel() {
    syncPoolMin();
    const h = poolH();
    $("poolCollapseBtn").textContent = h <= POOL_MIN_H + 20 ? "表示" : "隠す";
  }
  function endPoolDrag(e) {
    if (!poolDrag || e.pointerId !== poolDrag.id) return;
    poolDrag = null;
    poolEl.classList.remove("is-resizing");
    updatePoolCollapseLabel();
  }
  window.addEventListener("pointerup", endPoolDrag);
  window.addEventListener("pointercancel", endPoolDrag);
  document.addEventListener("touchmove", (e) => { if (poolDrag) e.preventDefault(); }, { passive: false });
  $("poolCollapseBtn").addEventListener("click", () => {
    const collapse = poolH() > POOL_MIN_H + 20;
    poolEl.style.height = collapse ? `${POOL_MIN_H}px` : ""; // "" = back to the CSS default
    poolEl.classList.toggle("is-min", collapse);
    $("poolCollapseBtn").textContent = collapse ? "表示" : "隠す";
  });

  // Hiragana/katakana and full/half width shouldn't matter when searching.
  const norm = (s) =>
    s
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
  const HAYSTACK = new Map(SONGS.map((s) => [s.no, norm(`${s.title} ${s.artist}`)]));

  // 年代（放送開始年から算出、10年区切り）。放送期間が分かっていない曲は「年代不明」。
  const eraOf = (s) => {
    const m = s.period && /(\d{4})年/.exec(s.period);
    return m ? `${Math.floor(+m[1] / 10) * 10}年代` : "年代不明";
  };
  const ERA = new Map(SONGS.map((s) => [s.no, eraOf(s)]));

  // 「放送・公開年」（曲の year）と「自分の生まれ年」から、その曲が出た時の自分の年齢を逆算する。
  // 年齢は年をまたぐと変わってしまうので、覚えておくのは（入力時点から計算した）生まれ年そのもの。
  const YEAR = new Map(
    SONGS.map((s) => {
      const m = s.period && /(\d{4})年/.exec(s.period);
      return [s.no, m ? +m[1] : null];
    })
  );
  const AGE_KEY = "conanOpeningTier.birthYear";
  let birthYear = null;
  try {
    const saved = parseInt(localStorage.getItem(AGE_KEY), 10);
    if (saved > 1900 && saved < 2030) birthYear = saved;
  } catch (e) { /* default to unset */ }
  const ageThen = (no) => {
    const y = YEAR.get(no);
    return birthYear != null && y != null ? y - birthYear : null;
  };
  function updateAgeBadges() {
    for (const [no, el] of itemCache) {
      const art = el.querySelector(".op-art");
      let badge = art.querySelector(".op-age-badge");
      const age = ageThen(no);
      if (age != null && age >= 0) {
        if (!badge) {
          badge = document.createElement("span");
          badge.className = "op-age-badge no-export";
          art.append(badge);
        }
        badge.textContent = `${age}歳`;
      } else if (badge) {
        badge.remove();
      }
    }
  }
  const ageInputEl = $("ageInput");
  const ageNoteEl = $("ageNote");
  function syncAgeNote() {
    ageNoteEl.textContent = birthYear != null ? `生まれ年：${birthYear}年ごろ` : "当時の年齢が分かります";
  }
  if (birthYear != null) ageInputEl.value = new Date().getFullYear() - birthYear;
  syncAgeNote();
  ageInputEl.addEventListener("input", () => {
    const v = parseInt(ageInputEl.value, 10);
    if (ageInputEl.value.trim() === "") {
      birthYear = null;
    } else if (v >= 0 && v <= 110) {
      birthYear = new Date().getFullYear() - v;
    } else {
      return;
    }
    try {
      if (birthYear != null) localStorage.setItem(AGE_KEY, birthYear);
      else localStorage.removeItem(AGE_KEY);
    } catch (e) { /* not remembered, still works */ }
    syncAgeNote();
    updateAgeBadges();
  });

  const qEl = $("q");
  let filterTimer = 0;
  qEl.addEventListener("input", () => {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(renderPool, 120);
  });

  // アーティストで絞り込み: most songs first (so 倉木麻衣 etc. sort near the top), ties broken alphabetically.
  const artistFilterEl = $("artistFilter");
  (() => {
    const count = new Map();
    for (const s of SONGS) count.set(s.artist, (count.get(s.artist) || 0) + 1);
    const artists = [...count.keys()].sort((a, b) => count.get(b) - count.get(a) || a.localeCompare(b, "ja"));
    for (const a of artists) {
      const opt = document.createElement("option");
      opt.value = a;
      opt.textContent = `${a}（${count.get(a)}）`;
      artistFilterEl.append(opt);
    }
  })();
  artistFilterEl.addEventListener("change", renderPool);

  // 年代で絞り込み: 古い順（1990年代→…）、「年代不明」は最後。
  const eraFilterEl = $("eraFilter");
  (() => {
    const count = new Map();
    for (const s of SONGS) count.set(ERA.get(s.no), (count.get(ERA.get(s.no)) || 0) + 1);
    const eras = [...count.keys()].sort((a, b) => (a === "年代不明") - (b === "年代不明") || a.localeCompare(b, "ja"));
    for (const e of eras) {
      const opt = document.createElement("option");
      opt.value = e;
      opt.textContent = `${e}（${count.get(e)}）`;
      eraFilterEl.append(opt);
    }
  })();
  eraFilterEl.addEventListener("change", renderPool);

  // TV・映画で絞り込み: TVはepRangeがある曲、映画はmovieNoがある曲（両方兼ねる曲はどちらでもヒットする）。
  const kindFilterEl = $("kindFilter");
  (() => {
    const tvCount = SONGS.filter((s) => s.epRange).length;
    const movieCount = SONGS.filter((s) => s.movieNo).length;
    kindFilterEl.querySelector('option[value="tv"]').textContent = `TVのみ（${tvCount}）`;
    kindFilterEl.querySelector('option[value="movie"]').textContent = `映画のみ（${movieCount}）`;
  })();
  kindFilterEl.addEventListener("change", renderPool);

  // 確認済みで絞り込み: 「見た上でTierに入れなかった曲」を、一覧から隠す／それだけ表示する。
  const SEEN_FILTER_LABEL = { off: "確認済みで絞り込み", unseen: "絞り込み：未確認のみ", seen: "絞り込み：確認済みのみ" };
  let seenFilter = "off";
  const seenFilterBtn = $("seenFilterBtn");
  seenFilterBtn.addEventListener("click", () => {
    seenFilter = seenFilter === "off" ? "unseen" : seenFilter === "unseen" ? "seen" : "off";
    seenFilterBtn.textContent = SEEN_FILTER_LABEL[seenFilter];
    seenFilterBtn.classList.toggle("is-active", seenFilter !== "off");
    renderPool();
  });

  function renderPool() {
    const scrollTop = poolGrid.scrollTop; // replaceChildren() below would otherwise reset the list's scroll to the top
    const placed = new Set();
    state.tiers.forEach((t) => t.items.forEach((n) => placed.add(n)));
    const artist = artistFilterEl.value;
    const era = eraFilterEl.value;
    const kind = kindFilterEl.value;
    const q = norm(qEl.value.trim());
    const filtering = artist || era || kind || seenFilter !== "off" || q;
    const passes = (s) =>
      (!artist || s.artist === artist) &&
      (!era || ERA.get(s.no) === era) &&
      (!kind || (kind === "tv" ? !!s.epRange : !!s.movieNo)) &&
      (seenFilter === "off" || (seenFilter === "seen") === seenSet.has(s.no)) &&
      (!q || HAYSTACK.get(s.no).includes(q));
    const frag = document.createDocumentFragment();
    let shown = 0;
    let remaining = 0;
    let seenRemaining = 0;
    const foundSet = new Set();
    for (const s of newestFirst ? [...SONGS].reverse() : SONGS) {
      if (placed.has(s.no)) {
        if (filtering && passes(s)) foundSet.add(s.no);
        continue;
      }
      remaining++;
      if (seenSet.has(s.no)) seenRemaining++;
      if (filtering && !passes(s)) continue;
      shown++;
      frag.append(itemEl(s));
    }
    if (shown === 0) {
      const p = document.createElement("p");
      p.className = "pool-empty";
      p.textContent = remaining === 0 ? "すべての曲をTierに入れました！" : "該当する曲がありません";
      frag.append(p);
    }
    poolGrid.replaceChildren(frag);
    poolGrid.scrollTop = scrollTop;
    for (const [no, el] of itemCache) el.classList.toggle("found", foundSet.has(no));
    const seenNote = seenRemaining ? `　確認済み ${seenRemaining}件` : "";
    poolCount.textContent = (filtering ? `${shown}件表示 ／ 未分類 ${remaining}件` : `未分類 ${remaining} / ${SONGS.length}`) + seenNote;
    markPlaying(); // playing-highlight is on the actual tile elements, which just got reattached
  }

  function render() {
    renderTiers();
    renderPool();
  }

  /* ---------------------------------------------------------- drag and drop */

  const HOLD_MS = 240;
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
      e.preventDefault();
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

  document.addEventListener("touchmove", (e) => {
    if (drag && drag.started) e.preventDefault();
  }, { passive: false });
  document.addEventListener("contextmenu", (e) => {
    if (e.target.closest && e.target.closest(".item")) e.preventDefault();
  });

  function startDrag() {
    if (!drag || drag.started) return;
    clearTimeout(drag.timer);
    drag.started = true;
    const r = drag.item.getBoundingClientRect();
    const ghost = drag.item.cloneNode(true);
    ghost.classList.add("ghost");
    ghost.style.width = `${r.width}px`;
    ghost.style.setProperty("--tile", `${r.width - 2}px`);
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
      if (commit) openDetail(d.no);
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

    if (move) moveSong(d.no, move.tierId, move.idx);
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

  let dlgOpenedAt = 0;
  document.querySelectorAll("dialog").forEach((dlg) => {
    const show = dlg.showModal.bind(dlg);
    dlg.showModal = () => {
      dlgOpenedAt = Date.now();
      show();
    };
    // スマホでは、カードをタップした指の「クリック」が、開いた直後のダイアログ（Tier表のボタンやリンク）に当たってしまうので、開いてすぐのクリックは無視する
    dlg.addEventListener("click", (e) => {
      if (Date.now() - dlgOpenedAt < 350) {
        e.preventDefault();
        e.stopPropagation();
      }
    }, true);
    dlg.addEventListener("click", (e) => {
      if (e.target.closest && e.target.closest("[data-close]")) return dlg.close();
      if (e.target === dlg && Date.now() - dlgOpenedAt > 350) dlg.close();
    });
  });

  function openDetail(no) {
    const s = BY_NO.get(no);
    if (!s) return;
    $("dNo").textContent = `No.${s.no}`;
    $("dTitle").textContent = s.title;
    $("dFile").textContent = s.artist;
    $("dPeriod").textContent = s.movieNo && !s.epRange
      ? `劇場版『${s.movieTitle}』主題歌（${s.period}公開）`
      : s.period
      ? `放送：${s.epRange}（${s.period}）`
      : "";
    $("dPeriod").hidden = !s.period;
    $("dMovieNote").textContent = s.movieNo && s.epRange ? `劇場版『${s.movieTitle}』（${s.moviePeriod}公開）の主題歌としても使われました` : "";
    $("dMovieNote").hidden = !(s.movieNo && s.epRange);
    const ageAtSong = ageThen(no);
    $("dAgeNote").textContent = ageAtSong != null && ageAtSong >= 0 ? `この曲が出たのは、あなたが${ageAtSong}歳の頃です` : "";
    $("dAgeNote").hidden = ageAtSong == null || ageAtSong < 0;
    const hasVideo = s.start != null || !!s.video;
    $("dPlayBtn").hidden = !hasVideo;
    $("dNoVideoNote").hidden = hasVideo;
    $("dPlayBtn").onclick = () => {
      playSong(no);
      detailDlg.close(); // ダイアログを開いたままだと、下にある一時停止・早送り・音量などの操作ができない
    };
    const seenBtn = $("dSeenBtn");
    const syncSeenBtn = () => {
      seenBtn.textContent = seenSet.has(no) ? "確認済みを解除" : "確認済みにする";
      seenBtn.classList.toggle("is-current", seenSet.has(no));
    };
    syncSeenBtn();
    seenBtn.onclick = () => {
      setSeen(no, !seenSet.has(no));
      syncSeenBtn();
      renderPool();
    };

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
        moveSong(no, t.id);
        detailDlg.close();
      });
      chips.append(b);
    });
    const pb = document.createElement("button");
    pb.type = "button";
    pb.className = "chip chip-pool" + (cur ? "" : " is-current");
    pb.textContent = "未分類";
    pb.addEventListener("click", () => {
      moveSong(no, null);
      detailDlg.close();
    });
    chips.append(pb);
    detailDlg.showModal();
  }

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
    swatchBox.querySelectorAll(".swatch").forEach((sw) => sw.classList.toggle("is-current", sw.dataset.color === color));
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
    track(() => { t.items = []; });
    save();
    render();
    toast("この行を空にしました");
  });
  $("tDelete").addEventListener("click", () => {
    const t = findTier(editingId);
    if (!t || state.tiers.length <= 1) return;
    if (t.items.length && !confirm(`「${t.name.replace(/\n/g, " ")}」の行を削除しますか？\n中の曲は未分類に戻ります。`)) return;
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
    if (!confirm("すべての曲を未分類に戻しますか？（行の名前と色は残ります）")) return;
    track(() => state.tiers.forEach((t) => (t.items = [])));
    save();
    render();
  });

  $("resetBtn").addEventListener("click", () => {
    if (!confirm("Tier表を初期状態に戻しますか？\n並べた曲も行の設定もすべて消えます。")) return;
    track(() => {
      state = defaultState();
    });
    titleEl.textContent = state.title;
    save();
    render();
  });

  titleEl.addEventListener("input", () => {
    if (!titleEl.textContent.trim()) titleEl.textContent = "";
    state.title = titleEl.textContent;
    save();
  });
  titleEl.addEventListener("focus", () => {
    editBefore = snapshot();
    editPushed = false;
  });
  titleEl.addEventListener("blur", recordEdit);
  titleEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      titleEl.blur();
    }
  });

  // 900px: narrow layout moves the rarely used buttons (reset / export / import) into #dataToolsSlot above 他のツール.
  const dataTools = $("dataTools");
  const dataToolsHome = dataTools.parentNode;
  const narrowMq = matchMedia("(max-width: 899px)");
  const placeDataTools = () => ($("dataToolsSlot") && narrowMq.matches ? $("dataToolsSlot") : dataToolsHome).appendChild(dataTools);
  placeDataTools();
  narrowMq.addEventListener("change", placeDataTools);

  let toastTimer = 0;
  function toast(msg) {
    const t = $("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 1800);
  }

  /* ----------------------------------------------------------- image export */

  async function exportImage(format = "png") {
    const stage = document.createElement("div");
    stage.className = "export-stage";
    const clone = boardEl.cloneNode(true);
    clone.removeAttribute("id");
    clone.classList.add("exporting");
    clone.querySelectorAll(".no-export").forEach((n) => n.remove());
    clone.querySelectorAll(".item").forEach((n) => n.classList.remove("drag-source", "op-playing"));
    clone.querySelector(".list-title").removeAttribute("contenteditable");
    stage.append(clone);
    document.body.append(stage);
    try {
      return await captureNode(clone, format);
    } finally {
      stage.remove();
    }
  }

  async function captureNode(node, format, background = "#121216") {
    const width = Math.round(node.getBoundingClientRect().width);
    const height = Math.ceil(node.getBoundingClientRect().height);
    const pixelRatio = Math.max(1, Math.min(2, Math.sqrt(16000000 / (width * height))));
    const options = { pixelRatio, skipFonts: true, cacheBust: false, width, height, backgroundColor: background };
    return format === "jpeg" ? await htmlToImage.toJpeg(node, { ...options, quality: 0.92 }) : await htmlToImage.toPng(node, options);
  }

  function dateStamp() {
    const d = new Date();
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  }

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
          ? "画像の生成に失敗しました。\n\nHTMLファイルを直接開いていると、ブラウザの制限で画像を保存できません。ローカルサーバー経由で開き直してください。"
          : "画像の生成に失敗しました。もう一度お試しください。"
      );
      return null;
    } finally {
      btn.disabled = false;
      btn.textContent = idleText;
    }
  }

  const imageName = (format) => `conan_opening_tier_${dateStamp()}.${format === "jpeg" ? "jpg" : "png"}`;
  function downloadImage(dataUrl, format, name = imageName(format)) {
    const a = document.createElement("a");
    a.download = name;
    a.href = dataUrl;
    a.click();
  }

  const FORMAT_KEY = "conanOpeningTier.format";
  let saveFormat = "png";
  try {
    if (localStorage.getItem(FORMAT_KEY) === "jpeg") saveFormat = "jpeg";
  } catch (e) { /* default to PNG */ }
  const saveIdle = () => `画像として保存（${saveFormat === "jpeg" ? "JPEG" : "PNG"}）`;
  const saveBtn = $("saveBtn");
  saveBtn.textContent = saveIdle();

  function applyFormat(format) {
    saveFormat = format === "jpeg" ? "jpeg" : "png";
    saveBtn.textContent = saveIdle();
    document.querySelectorAll('input[name="format"]').forEach((r) => (r.checked = r.value === saveFormat));
    try { localStorage.setItem(FORMAT_KEY, saveFormat); } catch (e) { /* not remembered, still works */ }
  }
  document.querySelectorAll('input[name="format"]').forEach((r) => r.addEventListener("change", () => applyFormat(r.value)));
  document.querySelectorAll('input[name="format"]').forEach((r) => (r.checked = r.value === saveFormat));

  saveBtn.addEventListener("click", async () => {
    const format = saveFormat;
    const dataUrl = await renderImage(saveBtn, saveIdle(), format);
    if (dataUrl) downloadImage(dataUrl, format);
  });

  // Two ways to post, so the long board link never comes as a surprise: introduce the site (plain URL), or post the board (link with its contents).
  const SITE_TEXT = "名探偵コナンの歴代主題歌でTier表が作れるツールです！動画を見ながら操作できます #コナン主題歌Tier表 #名探偵コナン";
  const postDlg = $("postDialog");
  const openIntent = (text, url) => {
    let u = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`;
    if (url) u += `&url=${encodeURIComponent(url)}`;
    window.open(u, "_blank", "noopener"); // called straight from a click, so popup blockers allow it
  };

  $("postXBtn").addEventListener("click", () => {
    const empty = !state.tiers.some((t) => t.items.length);
    $("postBoardBtn").disabled = empty;
    $("postBoardNote").hidden = !empty; // only explains why the choice is off
    postDlg.showModal();
  });
  $("postSiteBtn").addEventListener("click", () => {
    postDlg.close();
    openIntent(SITE_TEXT, location.origin + location.pathname);
    toast("Xの投稿画面を開きました。画像を投稿に添付する場合は、先に「画像として保存」しておいてください");
  });
  $("postBoardBtn").addEventListener("click", async () => {
    postDlg.close();
    const url = await myShareLink();
    if (!url) return;
    const text = "私の名探偵コナンの主題歌Tier表です。リンクから見てみてください！ #名探偵コナン";
    openIntent(text, url);
    toast("Xの投稿画面を開きました");
  });

  /* ------------------------------------------------------ export / import */

  const EXPORT_APP = "conan-opening-tier";
  const IMPORT_MAX_BYTES = 2 * 1024 * 1024;

  function exportData() {
    const data = {
      app: EXPORT_APP,
      version: 1,
      exportedAt: new Date().toISOString(),
      title: state.title,
      tiers: state.tiers.map((t) => ({ name: t.name, color: t.color, items: [...t.items] })),
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    const a = document.createElement("a");
    a.download = `conan_opening_tier_${dateStamp()}.json`;
    a.href = url;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast("エクスポートしました");
  }

  const IMPORT_ERROR = "読み込めませんでした。このサイトでエクスポートしたJSONファイルを選んでください。";

  async function importFile(file) {
    if (!file) return;
    if (file.size > IMPORT_MAX_BYTES) return alert(IMPORT_ERROR);
    let raw, next;
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
    if (!confirm(`「${file.name}」を読み込みます。\n現在の表（${placedNow}件を配置済み）は、読み込む表（${placedNext}件を配置）に置き換わります。よろしいですか？`)) return;

    track(() => { state = next; });
    titleEl.textContent = state.title;
    save();
    render();
    toast(skipped > 0 ? `読み込みました（認識できない${skipped}件は除外）` : "読み込みました");
  }

  const importInput = $("importFile");
  $("exportBtn").addEventListener("click", exportData);
  $("importBtn").addEventListener("click", () => importInput.click());
  importInput.addEventListener("change", async () => {
    const file = importInput.files[0];
    await importFile(file);
    importInput.value = "";
  });

  /* --------------------------------------------------------- YouTube player */

  // Play/pause, seek, and volume are all left to YouTube's own player UI (playerVars has no `controls: 0`),
  // rather than rebuilding them here - it already does this well, and it's what people expect from a YouTube embed.
  //
  // Two modes share the one embedded player:
  // - "reel": the 133-song compilation video (VIDEO_ID), seeking to each song's timestamp.
  // - "single": a song added after the reel was made has its own official PV instead (song.video), loaded
  //   in full. Playing a reel song again swaps the reel video back in.
  let ytPlayer = null;
  let ytReady = false;
  let ytMode = "reel";
  let playingNo = null;

  // 動画自体が小さくて、YouTube本体の早送り・音量操作がしづらいので、そこだけ補う軽量なボタン/スライダー。
  // 再生・一時停止やシークバーはYouTube本体に任せたまま（動画を隠す/表示の切り替え時にも同じ音量を保つ）。
  const VOLUME_KEY = "conanOpeningTier.volume";
  let volumePref = 100;
  try {
    const saved = parseInt(localStorage.getItem(VOLUME_KEY), 10);
    if (saved >= 0 && saved <= 100) volumePref = saved;
  } catch (e) { /* default to 100 */ }
  $("ytVolume").value = volumePref;

  window.onYouTubeIframeAPIReady = () => {
    ytPlayer = new YT.Player("ytPlayer", {
      videoId: VIDEO_ID,
      playerVars: { rel: 0 },
      events: {
        onReady: () => {
          ytReady = true;
          ytPlayer.setVolume(volumePref);
        },
        onStateChange: (e) => setPlayPauseIcon(e.data === 1),
      },
    });
  };
  const ytScript = document.createElement("script");
  ytScript.src = "https://www.youtube.com/iframe_api";
  document.head.append(ytScript);

  function playSong(no) {
    const s = BY_NO.get(no);
    if (!s || !ytReady) return;
    if (s.start != null) {
      if (ytMode !== "reel") {
        // loadVideoById() is asynchronous (it has to buffer the new video first), so a seekTo() called
        // right after it races the load and gets ignored - passing the start time as loadVideoById's own
        // 2nd argument avoids that race entirely.
        ytMode = "reel";
        ytPlayer.loadVideoById(VIDEO_ID, s.start);
      } else {
        ytPlayer.seekTo(s.start, true);
      }
      ytPlayer.playVideo();
    } else if (s.video) {
      ytMode = "single";
      playingNo = no;
      ytPlayer.loadVideoById(s.video);
      markPlaying();
    }
  }

  // 動画を隠す: collapses the player's height instead of display:none, so the iframe stays "visible" to the
  // browser and audio keeps playing while the video itself takes no screen space (mainly for phones, where
  // the video was taking up too much of the screen).
  const YT_HIDE_KEY = "conanOpeningTier.hideVideo";
  const ytWrap = $("ytWrap");
  const ytHideBtn = $("ytHideBtn");
  function setVideoHidden(hidden) {
    ytWrap.classList.toggle("is-hidden", hidden);
    ytHideBtn.textContent = hidden ? "動画を表示" : "動画を隠す";
    try { localStorage.setItem(YT_HIDE_KEY, hidden ? "1" : "0"); } catch (e) { /* not remembered, still works */ }
  }
  ytHideBtn.addEventListener("click", () => setVideoHidden(!ytWrap.classList.contains("is-hidden")));
  let hideVideoPref = false;
  try { hideVideoPref = localStorage.getItem(YT_HIDE_KEY) === "1"; } catch (e) { /* default to shown */ }
  setVideoHidden(hideVideoPref);

  const ytPlayPauseBtn = $("ytPlayPause");
  function setPlayPauseIcon(playing) {
    ytPlayPauseBtn.querySelector(".yt-icon-pause").hidden = !playing;
    ytPlayPauseBtn.querySelector(".yt-icon-play").hidden = playing;
    ytPlayPauseBtn.title = ytPlayPauseBtn.ariaLabel = playing ? "一時停止" : "再生";
  }
  ytPlayPauseBtn.addEventListener("click", () => {
    if (!ytReady) return;
    if (ytPlayer.getPlayerState() === 1) ytPlayer.pauseVideo();
    else ytPlayer.playVideo();
  });

  $("ytBack10").addEventListener("click", () => {
    if (!ytReady) return;
    ytPlayer.seekTo(Math.max(0, ytPlayer.getCurrentTime() - 10), true);
  });
  $("ytFwd10").addEventListener("click", () => {
    if (!ytReady) return;
    ytPlayer.seekTo(ytPlayer.getCurrentTime() + 10, true);
  });
  $("ytVolume").addEventListener("input", (e) => {
    volumePref = +e.target.value;
    if (ytReady) ytPlayer.setVolume(volumePref);
    try { localStorage.setItem(VOLUME_KEY, volumePref); } catch (err) { /* not remembered, still works */ }
  });

  function markPlaying() {
    for (const [no, el] of itemCache) el.classList.toggle("op-playing", no === playingNo);
    const s = playingNo != null ? BY_NO.get(playingNo) : null;
    $("ytCaption").textContent = s ? `再生中：${s.artist}「${s.title}」` : "再生中の曲はありません";
  }

  // Polls instead of relying on player events, since YT doesn't fire anything while a video just keeps playing.
  // Only tracks time-based matching in "reel" mode - a "single" song's own video has an unrelated timeline,
  // so it just stays marked as playing (set directly in playSong) until another song is played.
  setInterval(() => {
    if (ytMode !== "reel" || !ytReady || typeof ytPlayer.getPlayerState !== "function" || ytPlayer.getPlayerState() !== 1) return;
    const t = ytPlayer.getCurrentTime();
    const hit = SONGS.find((s) => t >= s.start && t < s.end);
    const no = hit ? hit.no : null;
    if (no !== playingNo) {
      playingNo = no;
      markPlaying();
    }
  }, 1000);

  /* ------------------------------------------------------------------ boot */

  titleEl.textContent = state.title;
  render();
  openIncomingShare();
  window.addEventListener("hashchange", openIncomingShare); // a link opened while the app is already open
})();
