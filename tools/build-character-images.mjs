// キャラクターTier表用のデータと画像を作る。
//   node tools/build-character-images.mjs
// 名前・登場話数: data/episodes.js の CHARACTERS（少年サンデー「全事件レポート編纂室」のメインキャラ）
// 画像: 読売テレビ「名探偵コナン」公式のキャラクター紹介（https://www.ytv.co.jp/conan/character/）の一覧画像を
//       200x200 の webp にして img/chars2/ に置く。公式に画像がないキャラ（沖野ヨーコ・新出智明）は、少年サンデーのカラーイラスト。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "img", "chars2");
fs.mkdirSync(OUT, { recursive: true });

const win = {};
new Function("window", fs.readFileSync(path.join(ROOT, "data", "episodes.js"), "utf8"))(win);
const ours = win.CHARACTERS;

const YTV = "https://www.ytv.co.jp";
const json = await (await fetch(`${YTV}/conan/data/characters.json`)).json();
const norm = (s) => (s || "").replace(/<br>.*/, "").replace(/[\s　・･]/g, "");
const byName = new Map(json.map((x) => [norm(x.data.name), x.data]));
// 当サイト側の表記 → 公式側の表記
// 公式サイトにいて、少年サンデーのメインキャラ表（＝ours）にいない人（別名の人は除く）。登場話数は不明なので0。
const EXTRA = ["服部平蔵", "服部静華", "遠山銀司郎", "大滝悟郎", "綾小路文麿", "松本清長", "トメさん", "宮野明美", "宮野エレーナ", "宮野厚司", "赤井務武", "ラム"];
const ALIAS = { メアリー: "赤井メアリー", ジョディ: "ジョディ・スターリング" };

// 公式（YTV）に画像がないキャラは、少年サンデー「コナン100巻記念」ページのカラーイラスト（380x380・白背景）を使う。
// 白背景は、端から続く白い部分だけを透明にする（絵の中の白は残す）。
const WEBSUNDAY_MAIN = "https://websunday.net/wp-content/themes/cms202008/assets/img/websunday2019/conan100/img";
const MAIN_ART = { 沖野ヨーコ: ["chara_main_017.jpg", Infinity, 444], 新出智明: ["chara_main_024.jpg", 230, 450] }; // [ファイル, 左右の辺からシードにする高さの上限, 少年サンデーのキャラページの tid（紹介文用）]

const clean = (t) => (t || "").replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
// 少年サンデーのキャラページから、メイン画像の直後にある紹介文を取る
async function websundayProfile(tid, file, name) {
  const html = await (await fetch(`https://websunday.net/conan100/character/?tid=${tid}`)).text();
  const i = html.indexOf(file);
  const rest = html.slice(html.indexOf(">", i) + 1, html.indexOf(">", i) + 3000);
  const text = clean(rest);
  const k = text.indexOf(`${name} の`);
  return (k > 0 ? text.slice(0, k) : text).trim();
}

// 白背景を透明にする。線画（色のついた部分）を壁にして、外側から続く白い部分だけを消す（服の白や、線で囲まれた白は残す）。
// 線の切れ目から中へ漏れないよう、壁は少し太らせておく。シードは上辺と、左右の辺（sideMaxY より上）から。
async function whiteToTransparent(buf, sideMaxY = Infinity) {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  const ink = new Uint8Array(w * h);
  for (let k = 0; k < w * h; k++) {
    const i = k * 4;
    ink[k] = data[i] < 225 || data[i + 1] < 225 || data[i + 2] < 225 ? 1 : 0;
  }
  const R = 3;
  const wall = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!ink[y * w + x]) continue;
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && xx < w && yy >= 0 && yy < h) wall[yy * w + xx] = 1;
    }
  }
  const seen = new Uint8Array(w * h);
  const stack = [];
  const push = (x, y) => { const k = y * w + x; if (!seen[k] && !wall[k]) { seen[k] = 1; stack.push(k); } };
  for (let x = 0; x < w; x++) push(x, 0);
  for (let y = 0; y < Math.min(h, sideMaxY); y++) { push(0, y); push(w - 1, y); }
  while (stack.length) {
    const k = stack.pop(), x = k % w, y = (k / w) | 0;
    if (x > 0) push(x - 1, y); if (x < w - 1) push(x + 1, y); if (y > 0) push(x, y - 1); if (y < h - 1) push(x, y + 1);
  }
  // 太らせた壁の分（背景に接する線の縁）も、背景の白に近ければ透明にして白いふちを残さない
  for (let k = 0; k < w * h; k++) if (seen[k]) data[k * 4 + 3] = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const k = y * w + x, i = k * 4;
    if (seen[k] || ink[k] || data[i + 3] === 0) continue;
    let near = false;
    for (let dy = -R; dy <= R && !near; dy++) for (let dx = -R; dx <= R; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && xx < w && yy >= 0 && yy < h && seen[yy * w + xx]) { near = true; break; }
    }
    if (near) data[i + 3] = 0;
  }
  return sharp(data, { raw: { width: w, height: h, channels: 4 } });
}

// 所属グループ（1人1グループ）。公式サイトの所属表記を参考に、表示用にまとめ直したもの。並びは表示順。
const GROUPS = [
  ["少年探偵団", ["江戸川コナン", "灰原哀", "吉田歩美", "小嶋元太", "円谷光彦", "阿笠博士"]],
  ["毛利家・工藤家・友人", ["毛利小五郎", "毛利蘭", "妃英理", "鈴木園子", "工藤新一", "工藤有希子", "工藤優作", "榎本梓", "鈴木次郎吉", "京極真", "沖野ヨーコ"]],
  ["帝丹学校", ["小林澄子", "若狭留美", "新出智明", "本堂瑛祐"]],
  ["関西", ["服部平次", "遠山和葉", "服部静華", "大岡紅葉", "伊織無我", "沖田総司"]],
  ["警視庁", ["目暮十三", "高木渉", "千葉和伸", "佐藤美和子", "白鳥任三郎", "宮本由美", "三池苗子", "中森銀三", "黒田兵衛", "松本清長", "トメさん"]],
  ["各県警", ["山村ミサオ", "横溝参悟", "横溝重悟", "大和敢助", "上原由衣", "諸伏高明", "萩原千速", "服部平蔵", "遠山銀司郎", "大滝悟郎", "綾小路文麿"]],
  ["公安・警察学校組", ["安室透", "風見裕也", "松田陣平", "萩原研二", "伊達航", "諸伏景光"]],
  ["FBI・CIA", ["赤井秀一", "ジョディ", "沖矢昴", "アンドレ・キャメル", "ジェイムズ・ブラック", "水無怜奈"]],
  ["赤井家", ["世良真純", "メアリー", "羽田秀𠮷", "赤井務武"]],
  ["宮野家", ["宮野明美", "宮野エレーナ", "宮野厚司"]],
  ["黒ずくめの組織", ["ジン", "ウォッカ", "ベルモット", "キャンティ", "コルン", "キール", "スコッチ", "ラム", "脇田兼則"]],
  ["その他", ["怪盗キッド"]],
];
const BASE = ours.length;
EXTRA.forEach((name, k) => ours.push({ id: BASE + k, name, icon: undefined, count: 0 }));
const groupOf = new Map(GROUPS.flatMap(([, names], gi) => names.map((n) => [n, gi])));
for (const c of ours) if (!groupOf.has(c.name)) throw new Error(`グループ未設定: ${c.name}`);
const out = [];
for (const c of ours) {
  const hit = byName.get(norm(ALIAS[c.name] || c.name));
  let img = null;
  if (hit) {
    const code = hit.code;
    const dest = path.join(OUT, `${code}.webp`);
    if (!fs.existsSync(dest)) {
      const res = await fetch(`${YTV}${hit.thumbnail}`);
      if (!res.ok) throw new Error(`${c.name}: ${res.status}`);
      await sharp(Buffer.from(await res.arrayBuffer())).resize(200, 200, { fit: "cover" }).webp({ quality: 88 }).toFile(dest);
    }
    img = `img/chars2/${code}.webp`;
  }
  if (!img && MAIN_ART[c.name]) {
    const dest = path.join(OUT, `${MAIN_ART[c.name][0].replace(/\.jpg$/, "")}.webp`);
    if (!fs.existsSync(dest)) {
      const res = await fetch(`${WEBSUNDAY_MAIN}/${MAIN_ART[c.name][0]}`);
      if (!res.ok) throw new Error(`${c.name}: ${res.status}`);
      await (await whiteToTransparent(Buffer.from(await res.arrayBuffer()), MAIN_ART[c.name][1])).resize(200, 200, { fit: "cover" }).webp({ quality: 88 }).toFile(dest);
    }
    img = `img/chars2/${path.basename(dest)}`;
  }
  let profile = "", link = "", from = "";
  if (hit) {
    profile = clean(hit.profile);
    link = `${YTV}/conan/character/${hit.code}/`;
    from = "読売テレビ「名探偵コナン」公式サイト";
  } else if (MAIN_ART[c.name]) {
    const [file, , tid] = MAIN_ART[c.name];
    profile = await websundayProfile(tid, file, c.name);
    link = `https://websunday.net/conan100/character/?tid=${tid}`;
    from = "少年サンデー「名探偵コナン」公式ページ";
  }
  out.push({ id: c.id + 1, name: c.name, g: groupOf.get(c.name), icon: c.icon, ...(img ? { img } : {}), count: c.count, ...(profile ? { profile, link, from } : {}) });
}

const body = out.map((o) => "  " + JSON.stringify(o)).join(",\n");
fs.writeFileSync(
  path.join(ROOT, "data", "characters.js"),
  `// キャラクターTier表用。名前・登場話数は少年サンデー「全事件レポート編纂室」のメインキャラ表記、img は読売テレビ「名探偵コナン」公式のキャラクター紹介の画像（無い場合は icon の32px画像）。\n// count = 登場話数（マンガ事件＋アニメオリジナル）。\nwindow.CHAR_GROUPS = ${JSON.stringify(GROUPS.map(([n]) => n))};\nwindow.CHAR_TIER = [\n${body}\n];\n`
);
console.log(`${out.length} characters, ${out.filter((o) => o.img).length} with official image; without:`, out.filter((o) => !o.img).map((o) => o.name).join("、"));
