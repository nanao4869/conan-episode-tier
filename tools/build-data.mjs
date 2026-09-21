// Rebuilds data/episodes.js and the bundled images (img/) from the source sites.
//
//   cd tools && npm install && node build-data.mjs [--refresh]
//
// Sources
//   - manga cases ........ https://websunday.net/conandb/episode-list/   (title, first File, thumbnail, main characters)
//   - anime episodes ..... https://www.ytv.co.jp/conan/data/case.json    (title, air date, thumbnail, page URL)
//   - anime originals,
//     seasons ............ Wikipedia 「名探偵コナンのアニメエピソード一覧」
//   - manga -> anime ..... Wikipedia 「名探偵コナンの漫画エピソード一覧」 (アニメ column)
//
// It is incremental: manga detail pages and images that already exist are not fetched again
// (use --refresh to re-fetch the manga detail pages). data/episodes.js is always rewritten.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as cheerio from "cheerio";
import sharp from "sharp";
import { ALIASES, NOT_ESTIMATED, detectCharacters } from "./character-aliases.mjs";
import { TAGS, tagsFor } from "./tag-rules.mjs";

const TOOLS = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TOOLS, "..");
const CACHE = path.join(TOOLS, "cache");
const IMG = path.join(ROOT, "img");
const REFRESH = process.argv.includes("--refresh");
const UA = { "User-Agent": "Mozilla/5.0" };
const WEB = "https://websunday.net";
const YTV = "https://www.ytv.co.jp";
const WIKI = "https://ja.wikipedia.org/w/api.php?action=parse&prop=text&format=json&formatversion=2&page=";

fs.mkdirSync(CACHE, { recursive: true });
for (const d of ["", "chars", "anime", "t", "t/anime"]) fs.mkdirSync(path.join(IMG, d), { recursive: true });

/* ------------------------------------------------------------------ helpers */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);
const warnings = [];
const warn = (msg) => {
  warnings.push(msg);
  console.warn("  ! " + msg);
};

async function retry(fn, label) {
  for (let i = 0; i < 3; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i === 2) throw new Error(`${label}: ${e.message}`);
      await sleep(800 * (i + 1));
    }
  }
}
const getText = (url) =>
  retry(async () => {
    const r = await fetch(url, { headers: UA });
    if (!r.ok) throw new Error(r.status);
    return r.text();
  }, url);
const getBuf = (url) =>
  retry(async () => {
    const r = await fetch(url, { headers: UA });
    if (!r.ok) throw new Error(r.status);
    return Buffer.from(await r.arrayBuffer());
  }, url);

// Small polite worker pool: 4 requests at a time with a short pause.
async function pool(items, fn, size = 4) {
  let i = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (i < items.length) {
        await fn(items[i++]);
        await sleep(100);
      }
    })
  );
}

// websunday.net sometimes lists a character under a nickname that is not a name; fold it into the real character
// so it doesn't show up as a separate person. 領域外の妹 is Mary Sera before she was named (same icon as メアリー).
const CHARACTER_RENAMES = { 領域外の妹: "メアリー" };
function foldCharacters(chars) {
  const seen = new Set();
  const out = [];
  for (const c of chars) {
    const name = CHARACTER_RENAMES[c.name] || c.name;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ ...c, name });
  }
  return out;
}

const decode = (s) => s.replace(/&amp;/g, "&").replace(/&#0?39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
const jpDate = (d) => {
  const [y, m, dd] = d.split("-").map(Number);
  return `${y}年${m}月${dd}日`;
};

/* --------------------------------------------------------- 1. manga (websunday) */

async function loadManga() {
  log("1/6 manga cases (websunday.net)");
  const list = await getText(`${WEB}/conandb/episode-list/`);
  const re = /<td class="list-no">\s*(\d+)\s*<\/td>\s*<td>\s*<a href="\/episode\/(\d+)">\s*([\s\S]*?)\s*<\/a>/g;
  const cases = [];
  for (let m; (m = re.exec(list)); ) cases.push({ no: +m[1], id: m[2], title: decode(m[3]) });
  if (cases.length === 0) throw new Error("could not parse the websunday episode list");

  const cacheFile = path.join(CACHE, "manga-pages.json");
  const pages = !REFRESH && fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, "utf8")) : {};
  // pages cached by an older version of this script lack the venue / synopsis fields used for the 舞台・事件のタイプ tags
  const todo = cases.filter((c) => !pages[c.id] || pages[c.id].summary === undefined);
  log(`   ${cases.length} cases, ${todo.length} detail pages to fetch`);
  await pool(todo, async (c) => {
    const h = await getText(`${WEB}/episode/${c.id}`);
    const thumb = h.match(/class="pin1">\s*<img src="([^"]+)"/);
    const file = h.match(/<div class="file">[\s\S]*?<ul>\s*<li>\s*([\s\S]*?)\s*<\/li>/);
    const box = h.match(/<div class="mchara">([\s\S]*?)<\/ul>/);
    const chars = box ? [...box[1].matchAll(/<li>\s*<img src="([^"]+)"[^>]*alt="[^"]*"[\s\S]*?<p>\s*([\s\S]*?)\s*<\/p>/g)].map((x) => ({ icon: x[1], name: decode(x[2]) })) : [];
    const place = h.match(/<div class="venue">[\s\S]*?<p>\s*([\s\S]*?)\s*<\/p>/);
    const summary = h.match(/<p class="naiyo__box1">\s*([\s\S]*?)\s*<\/p>/);
    if (!thumb || !file) throw new Error(`unexpected page layout: case ${c.no} (${c.id})`);
    // the venue and synopsis are only used to derive tags (tag-rules.mjs); the text itself is not shipped
    pages[c.id] = { thumb: thumb[1], file: decode(file[1]), chars, place: place ? decode(place[1].replace(/<[^>]+>/g, "")) : "", summary: summary ? decode(summary[1].replace(/<[^>]+>/g, "")) : "" };
  });
  fs.writeFileSync(cacheFile, JSON.stringify(pages));
  return cases.map((c) => ({ ...c, ...pages[c.id], chars: foldCharacters(pages[c.id].chars) })).sort((a, b) => a.no - b.no);
}

/* ------------------------------------------------------------ 2. anime (YTV) */

async function loadYtv() {
  log("2/6 anime episodes (ytv.co.jp)");
  const json = JSON.parse(await getText(`${YTV}/conan/data/case.json`));
  const today = new Date().toISOString().slice(0, 10);
  const eps = new Map();
  let future = 0;
  for (const x of json) {
    const d = x.data;
    if (!/^\d+$/.test(d.episode || "")) continue; // re-runs (R..), specials (SP..) are not numbered episodes
    const date = ((d.onair_date && d.onair_time ? d.onair_date : d.oa_date) || "").slice(0, 10);
    if (!date) continue;
    if (date > today) {
      future++;
      continue;
    }
    eps.set(+d.episode, { ep: +d.episode, title: d.title.trim(), date, suffix: d.suffix || ".html", thumb: d.thumbnail, story: d.conan_story || "" });
  }
  log(`   ${eps.size} aired episodes (${future} not aired yet are skipped)`);
  return eps;
}

/* ----------------------------------------------------------- 3. Wikipedia */

function grid($, table) {
  const g = [];
  $(table).find("tr").toArray().forEach((tr, r) => {
    g[r] = g[r] || [];
    let c = 0;
    $(tr).children("th,td").each((_, cell) => {
      while (g[r][c] !== undefined) c++;
      const rs = +($(cell).attr("rowspan") || 1);
      const cs = +($(cell).attr("colspan") || 1);
      const clone = $(cell).clone();
      clone.find("sup,.reference,style").remove();
      clone.find("br").replaceWith("\n");
      const lines = clone.text().split("\n").map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);
      for (let i = 0; i < rs; i++) for (let j = 0; j < cs; j++) (g[r + i] = g[r + i] || [])[c + j] = lines;
      c += cs;
    });
  });
  return g;
}

async function loadWikiAnime() {
  log("3/6 Wikipedia: anime episode list");
  const html = JSON.parse(await getText(WIKI + encodeURIComponent("名探偵コナンのアニメエピソード一覧"))).parse.text;
  const $ = cheerio.load(html);
  const rows = new Map(); // ep -> { src, season }
  let season = null;
  $("h2,h3,h4,table.wikitable").each((_, el) => {
    if (el.tagName === "table") {
      if (!season) return;
      const g = grid($, el);
      const head = (g[0] || []).map((x) => x.join(""));
      const iEp = head.findIndex((x) => /^話数/.test(x));
      const iSrc = head.findIndex((x) => /原作/.test(x));
      if (iEp < 0) return;
      for (let r = 1; r < g.length; r++) {
        const ep = ((g[r] || [])[iEp] || [])[0];
        if (/^\d+$/.test(ep || "") && !rows.has(+ep)) rows.set(+ep, { src: iSrc >= 0 ? g[r][iSrc].join(" ") : "", season });
      }
      return;
    }
    const t = $(el).text().replace(/\[編集\]/g, "").trim();
    const m = t.match(/^シーズン(\d+)（\d{4}年）/);
    if (m) season = +m[1];
    else if (el.tagName === "h2" || (el.tagName === "h3" && !/^シーズン/.test(t))) season = null;
  });
  if (rows.size < 1000) throw new Error(`Wikipedia anime list looks wrong (${rows.size} rows) - the page layout may have changed`);
  return rows;
}

// Release year of every manga volume (Wikipedia 「名探偵コナン」 > 単行本). A manga case gets the year of the
// first volume it appears in: it is the only date the manga side has, and it is used for the 年代 stats.
async function loadVolumeYears() {
  log("   Wikipedia: manga volume release dates");
  const html = JSON.parse(await getText(WIKI + encodeURIComponent("名探偵コナン"))).parse.text;
  const $ = cheerio.load(html);
  const years = new Map(); // volume number -> year
  $("table").each((_, table) => {
    const g = grid($, table);
    const head = (g[0] || []).map((x) => x.join(""));
    const iVol = head.findIndex((x) => /巻数/.test(x));
    const iDate = head.findIndex((x) => /発売日/.test(x));
    if (iVol < 0 || iDate < 0) return;
    for (let r = 1; r < g.length; r++) {
      const vol = ((g[r] || [])[iVol] || [])[0];
      const m = /(\d{4})年\d{1,2}月\d{1,2}日/.exec(((g[r] || [])[iDate] || []).join(" "));
      if (/^\d+$/.test(vol || "") && m && !years.has(+vol)) years.set(+vol, +m[1]);
    }
  });
  if (years.size < 100) throw new Error(`Wikipedia volume list looks wrong (${years.size} volumes) - the page layout may have changed`);
  return years;
}

async function loadWikiManga() {
  log("4/6 Wikipedia: manga episode list");
  const html = JSON.parse(await getText(WIKI + encodeURIComponent("名探偵コナンの漫画エピソード一覧"))).parse.text;
  const $ = cheerio.load(html);
  const rows = new Map(); // case no -> tokens of the アニメ column
  $("table.wikitable").each((_, table) => {
    const g = grid($, table);
    const head = (g[0] || []).map((x) => x.join(""));
    const iN = head.indexOf("話");
    const iA = head.findIndex((x) => /アニメ/.test(x));
    if (iN < 0 || iA < 0) return;
    for (let r = 1; r < g.length; r++) {
      const no = ((g[r] || [])[iN] || [])[0];
      if (/^\d+$/.test(no || "")) rows.set(+no, g[r][iA] || []);
    }
  });
  if (rows.size < 300) throw new Error(`Wikipedia manga list looks wrong (${rows.size} rows) - the page layout may have changed`);
  return rows;
}

/* ------------------------------------------- 4. grouping multi-part episodes */

const split = (t) => {
  const m = t.match(/^(.*?)\s*[（(]([^（()）]*)[)）]\s*$/);
  return m ? { base: m[1].trim(), part: m[2] } : { base: t, part: "" };
};
const key = (s) => s.normalize("NFKC").replace(/\s+/g, "");
const lev = (a, b) => {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
};

// Consecutive episodes with the same title and different "(前編)/(後編)/(事件編)…" suffixes become one group.
// A one-character difference is tolerated (YTV has typos such as 非劇/悲劇); the later part's spelling wins.
function groupEpisodes(list, canJoin = () => true) {
  const groups = [];
  for (const e of list) {
    const s = split(e.title);
    const cur = { ...e, base: s.base, part: s.part };
    const g = groups[groups.length - 1];
    const last = g && g.eps[g.eps.length - 1];
    const same = g && (key(g.base) === key(cur.base) || lev(key(g.base), key(cur.base)) <= 1);
    if (g && same && cur.part && last.part && last.part !== cur.part && cur.ep === last.ep + 1 && canJoin(last, cur)) {
      g.eps.push(cur);
      g.base = cur.base;
    } else groups.push({ base: cur.base, eps: [cur] });
  }
  return groups;
}

function describe(g, seasonOf) {
  const f = g.eps[0];
  const l = g.eps[g.eps.length - 1];
  const n = g.eps.length;
  const range = n === 1 ? `第${f.ep}話` : n === 2 ? `第${f.ep}・${l.ep}話（全2話）` : `第${f.ep}〜${l.ep}話（全${n}話）`;
  const s = seasonOf(f.ep);
  const s2 = seasonOf(l.ep);
  return {
    range,
    title: g.base.replace(/　/g, " ").replace(/\s+/g, " ").trim(),
    date: f.date,
    url: `${YTV}/conan/archive/k${f.date.replace(/-/g, "")}${f.suffix}`,
    ...(s ? { s } : {}),
    ...(s2 && s2 !== s ? { s2 } : {}),
  };
}

/* ---------------------------------------------------------------- 5. images */

// Some YTV thumbnails are a small picture centred in a big black frame. Crop the frame and upscale 2x.
async function cropBlackFrame(buf) {
  const { data, info } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: W, height: H, channels: C } = info;
  const dark = (x, y) => {
    const i = (y * W + x) * C;
    return data[i] <= 24 && data[i + 1] <= 24 && data[i + 2] <= 24;
  };
  const rowBlack = (y) => { for (let x = 0; x < W; x++) if (!dark(x, y)) return false; return true; };
  const colBlack = (x) => { for (let y = 0; y < H; y++) if (!dark(x, y)) return false; return true; };
  let t = 0; while (t < H && rowBlack(t)) t++;
  let b = H - 1; while (b > t && rowBlack(b)) b--;
  let l = 0; while (l < W && colBlack(l)) l++;
  let r = W - 1; while (r > l && colBlack(r)) r--;
  const w = r - l + 1;
  const h = b - t + 1;
  if ((w * h) / (W * H) >= 0.3) return buf; // normal image (in-show letterbox bars are kept on purpose)
  return sharp(buf).extract({ left: l + 1, top: t + 1, width: w - 2, height: h - 2 }).resize({ width: (w - 2) * 2, height: (h - 2) * 2, kernel: "lanczos3" }).jpeg({ quality: 90 }).toBuffer();
}

const exists = (p) => fs.existsSync(p) && fs.statSync(p).size > 0;
const thumbPath = (img) => path.join(ROOT, img.replace(/^img\//, "img/t/").replace(/\.\w+$/, ".jpg"));

async function fetchImages(manga, anime, chars) {
  log("5/6 images");
  let n = { manga: 0, anime: 0, chars: 0, tiles: 0 };
  await pool(manga, async (m) => {
    const dest = path.join(ROOT, m.img);
    if (!exists(dest)) { fs.writeFileSync(dest, await getBuf(m.thumb.startsWith("http") ? m.thumb : WEB + m.thumb)); n.manga++; }
  });
  await pool(chars, async (c) => {
    const dest = path.join(ROOT, c.icon);
    if (!exists(dest)) { fs.writeFileSync(dest, await getBuf(WEB + c.src)); n.chars++; }
  });
  await pool(anime, async (a) => {
    const dest = path.join(ROOT, a.img);
    if (!exists(dest)) { fs.writeFileSync(dest, await cropBlackFrame(await getBuf(YTV + a.thumbSrc))); n.anime++; }
  });
  // 180px square copies for the tiles (the app loads the full-size image only in the detail dialog)
  for (const e of [...manga, ...anime]) {
    const dest = thumbPath(e.img);
    if (exists(dest)) continue;
    await sharp(path.join(ROOT, e.img), { pages: 1 }).flatten({ background: "#222222" }).resize(180, 180, { fit: "cover", position: "centre" }).jpeg({ quality: 80, mozjpeg: true }).toFile(dest);
    n.tiles++;
  }
  log(`   downloaded: manga ${n.manga}, anime ${n.anime}, character icons ${n.chars}; new tiles ${n.tiles}`);
}

/* --------------------------------------------------------------------- main */

const [mangaRaw, ytv, wikiAnime, wikiManga] = [await loadManga(), await loadYtv(), await loadWikiAnime(), await loadWikiManga()];
const volumeYear = await loadVolumeYears();
log("5/6 building data");

// season: Wikipedia's section; the season number is also (air year - 1995) for every episode checked so far
const seasonOf = (ep) => wikiAnime.get(ep)?.season || (ytv.get(ep) ? +ytv.get(ep).date.slice(0, 4) - 1995 : 0);
// "original" = the 原作 cell says アニメオリジナル and has no File/巻 reference (those are re-tellings of manga cases)
const isOriginal = (ep) => {
  const src = wikiAnime.get(ep)?.src || "";
  return /アニメオリジナル/.test(src) && !/File|第\d+巻/.test(src);
};

const unknown = [...ytv.keys()].filter((ep) => !wikiAnime.has(ep)).sort((a, b) => a - b);
if (unknown.length) warn(`aired on YTV but not in the Wikipedia list yet (left out): ${unknown.join(", ")}`);

const airedList = [...ytv.values()].filter((e) => wikiAnime.has(e.ep)).sort((a, b) => a.ep - b.ep);
const animeGroups = groupEpisodes(airedList, (a, b) => isOriginal(a.ep) === isOriginal(b.ep)).filter((g) => g.eps.every((e) => isOriginal(e.ep)));

// characters, most frequent first
const count = new Map();
const iconSrc = new Map();
for (const m of mangaRaw) for (const c of m.chars) { count.set(c.name, (count.get(c.name) || 0) + 1); iconSrc.set(c.name, c.icon); }
// anime originals have no official cast list: estimate it from the synopsis (see character-aliases.mjs)
const animeNames = animeGroups.map((g) => [...detectCharacters(g.eps.map((e) => `${e.title} ${e.story}`).join(" "))].filter((n) => iconSrc.has(n)));
for (const list of animeNames) for (const n of list) count.set(n, count.get(n) + 1);
for (const n of Object.keys(ALIASES)) if (!iconSrc.has(n)) warn(`character-aliases.mjs has "${n}", which is not a character on websunday.net (renamed?)`);
for (const n of iconSrc.keys()) if (!(n in ALIASES) && !NOT_ESTIMATED.includes(n)) warn(`no alias for the new character "${n}": add it to tools/character-aliases.mjs so anime episodes can match it`);
const names = [...count.keys()].sort((a, b) => count.get(b) - count.get(a));
const charId = new Map(names.map((n, i) => [n, i]));
const CHARACTERS = names.map((n, i) => ({ id: i, name: n, icon: "img/chars/" + iconSrc.get(n).split("/").pop(), count: count.get(n), src: iconSrc.get(n) }));

const manga = mangaRaw.map((m) => {
  const tokens = wikiManga.get(m.no) || [];
  const nums = [];
  for (const tok of tokens) {
    let x;
    if ((x = tok.match(/^(\d+) - (\d+)$/))) for (let e = +x[1]; e <= +x[2]; e++) nums.push(e);
    else if (/^\d+$/.test(tok)) nums.push(+tok);
  }
  let an;
  const eps = [...new Set(nums)].sort((a, b) => a - b).filter((e) => ytv.has(e));
  if (eps.length) {
    an = groupEpisodes(eps.map((e) => ytv.get(e))).map((g) => {
      const d = describe(g, seasonOf);
      return { e: d.range, t: d.title, d: jpDate(d.date), u: d.url, ...(d.s ? { s: d.s } : {}), ...(d.s2 ? { s2: d.s2 } : {}) };
    });
  } else if (tokens.includes("番外")) an = [{ e: "番外編（通常の話数外の放送）" }];
  else an = [];
  const ext = m.thumb.split(".").pop().toLowerCase();
  const firstVol = /第(\d+)巻/.exec(m.file);
  const vy = firstVol ? volumeYear.get(+firstVol[1]) : undefined;
  if (!vy) warn(`manga case ${m.no}: no release year for its volume (${m.file}); it will be left out of the 年代 stats`);
  return { no: m.no, id: m.id, title: m.title, file: m.file, img: `img/${String(m.no).padStart(3, "0")}.${ext}`, c: m.chars.map((c) => charId.get(c.name)), an, ...(vy ? { vy } : {}), t: tagsFor(`${m.title} ${m.place} ${m.summary}`), thumb: m.thumb };
});
for (let n = 1; n <= manga.length; n++) if (!wikiManga.has(n)) warn(`manga case ${n} is not in the Wikipedia manga list (no anime info)`);

const anime = animeGroups.map((g, i) => {
  const d = describe(g, seasonOf);
  const first = g.eps[0];
  return {
    no: 1000 + first.ep, k: "a", label: "A" + first.ep, id: String(first.ep), title: d.title,
    file: `アニメオリジナル ${d.range}／${jpDate(d.date)}放送`,
    img: `img/anime/${String(first.ep).padStart(4, "0")}.jpg`, url: d.url, c: animeNames[i].map((n) => charId.get(n)).sort((a, b) => a - b), ce: 1,
    y: +d.date.slice(0, 4), ...(d.s ? { s: d.s } : {}), ...(d.s2 ? { s2: d.s2 } : {}),
    t: tagsFor(g.eps.map((e) => `${e.title} ${e.story}`).join(" ")),
    thumbSrc: first.thumb,
  };
});

await fetchImages(manga, anime, CHARACTERS);

log("6/6 writing data/episodes.js");
const strip = ({ thumb, thumbSrc, ...rest }) => rest;
log("   tag counts (manga / anime originals):");
TAGS.forEach(([name, kind], id) => log(`     ${kind === "place" ? "舞台" : "タイプ"}  ${name.padEnd(12, "　")} ${String(manga.filter((e) => e.t.includes(id)).length).padStart(3)} / ${String(anime.filter((e) => e.t.includes(id)).length).padStart(3)}`));
const header =
  "// Generated by tools/build-data.mjs - do not edit by hand.\n" +
  "// Sources:\n" +
  "//  - manga cases: https://websunday.net/conandb/episode-list/ (333+ cases; main characters from each episode page)\n" +
  "//  - anime originals: https://www.ytv.co.jp/conan/archive/ (multi-part episodes merged into one entry); anime-original flag, seasons and the manga<->anime mapping from Wikipedia\n";
fs.writeFileSync(
  path.join(ROOT, "data", "episodes.js"),
  header +
    "window.TAGS = " + JSON.stringify(TAGS.map(([name, kind], id) => ({ id, name, kind }))) + ";\n" +
    "window.CHARACTERS = " + JSON.stringify(CHARACTERS.map(({ src, ...c }) => c)) + ";\n" +
    "window.EPISODES = " + JSON.stringify([...manga.map(strip), ...anime.map(strip)]) + ";\n"
);
log(`done: ${manga.length} manga cases, ${anime.length} anime-original entries (${animeGroups.reduce((a, g) => a + g.eps.length, 0)} episodes), ${CHARACTERS.length} characters`);
if (warnings.length) log(`\n${warnings.length} warning(s) above - check them before publishing.`);
