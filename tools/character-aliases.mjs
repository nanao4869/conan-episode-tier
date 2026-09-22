// Estimates which main characters appear in an anime-original episode from its YTV あらすじ (synopsis) text.
//
// The manga side has an official list per case (websunday.net), the anime side does not, so the anime
// entries get an estimate: a character counts when one of its aliases appears in the synopsis or title.
// Checked against the 324 manga cases that have an anime version (synopsis of the anime episodes vs the
// official list) and against every hit in the 471 anime originals by eye. Good for narrowing down, not a
// complete cast list.
//
// Keys must be the exact names used by websunday.net (see CHARACTERS in data/episodes.js).
//
// An alias is a regular expression (as a string). To cut false positives it can also be a pair
// [alias, context]: it only counts when the text ALSO matches `context`.
// Watch out for words that merely contain a name, e.g. スコッチ (whisky), 氷の白鳥 (a swan),
// 鈴木由美 (another 由美), 黒田清正, 大和田誠, 松田巧, メアリー・セレスト号, 豊臣秀吉.
const KANA = "[ァ-ヶー]";
const NOT_AFTER_KANA = `(?<!${KANA})`;
const NOT_BEFORE_KANA = `(?!${KANA})`;
const NOT_AFTER_KANJI = "(?<![一-龠々])";

// The Organization's members are named after drinks (ジン, ウォッカ, ベルモット, キール, キャンティ, コルン, スコッチ…),
// so count them only when the synopsis is clearly about the Organization.
const ORG = "黒ずくめ|黒の組織|組織";
const codename = (name) => [[name, ORG]]; // one alias that needs both the name and the context

export const ALIASES = {
  江戸川コナン: ["コナン"],
  毛利蘭: ["蘭"],
  毛利小五郎: ["小五郎"],
  目暮十三: ["目暮"],
  灰原哀: ["灰原"],
  高木渉: ["高木"],
  吉田歩美: ["歩美"],
  小嶋元太: ["元太"],
  円谷光彦: ["光彦"],
  阿笠博士: ["阿笠", `${NOT_AFTER_KANJI}博士`], // a bare 博士 is Agasa; "考古学博士" etc. are not
  鈴木園子: ["園子"],
  服部平次: ["平次", "服部"],
  佐藤美和子: ["美和子", "佐藤刑事"],
  遠山和葉: ["和葉"],
  千葉和伸: ["千葉刑事"],
  世良真純: ["世良"],
  安室透: ["安室"],
  赤井秀一: ["赤井"],
  ジョディ: ["ジョディ"],
  工藤有希子: ["工藤有希子", `${NOT_AFTER_KANJI}有希子`],
  白鳥任三郎: ["白鳥任三郎", "白鳥(?=警部|刑事|警視)"], // 氷の白鳥 is a swan
  沖矢昴: ["沖矢"],
  妃英理: [`妃\\s*英理`, `${NOT_AFTER_KANJI}英理`],
  小林澄子: ["小林先生", "小林澄子", `${NOT_AFTER_KANJI}澄子`],
  宮本由美: ["宮本由美", [`${NOT_AFTER_KANJI}由美`, "婦警|交通課"]], // 鈴木由美, 住人の由美 etc. are other people
  山村ミサオ: ["山村"],
  工藤優作: [`${NOT_AFTER_KANJI}優作`, "工藤優作"], // 松田優作 is an actor
  榎本梓: ["榎本", ["梓", "ポアロ|喫茶"]], // メイドの梓 is someone else; the waitress is at Poirot
  怪盗キッド: ["キッド"],
  横溝参悟: ["参悟", ["横溝警部", "静岡県警"]], // 横溝重悟 is the Kanagawa one
  横溝重悟: ["重悟", ["横溝警部", "神奈川県警"]],
  中森銀三: ["中森警部", "中森銀三"],
  アンドレ・キャメル: ["キャメル"],
  若狭留美: ["若狭留美", "若狭先生"],
  脇田兼則: ["脇田兼則", "脇田警部"],
  ジェイムズ・ブラック: ["ジェイムズ"],
  黒田兵衛: ["黒田兵衛", "黒田管理官", "黒田警視"], // 黒田清正 is someone else
  沖野ヨーコ: ["ヨーコ"],
  鈴木次郎吉: ["次郎吉"],
  羽田秀𠮷: ["羽田秀吉", "羽田秀𠮷"], // 豊臣秀吉
  大和敢助: ["大和敢助", "大和警部"], // 大和田誠, 大和屋
  三池苗子: ["三池"],
  京極真: ["京極"],
  上原由衣: ["上原由衣", "上原刑事"], // 上原美佐 is someone else
  本堂瑛祐: ["瑛祐"],
  諸伏高明: ["諸伏高明", "高明(?!な)"],
  大岡紅葉: ["大岡紅葉"], // 紅葉 alone is autumn leaves (紅葉御殿…)
  メアリー: ["メアリー(?!・セレスト)"], // メアリー・セレスト号
  松田陣平: ["松田陣平", "松田刑事"], // 松田巧
  伊織無我: ["伊織無我", "伊織"], // 無我夢中
  新出智明: ["新出智明", "新出先生", "新出医師"],
  萩原研二: ["萩原研二", "萩原刑事"],
  伊達航: ["伊達航"], // 伊達メガネ, other 伊達さん
  沖田総司: ["沖田総司"], // 沖田光夫
  風見裕也: ["風見裕也", "風見刑事"], // 風見鶏
  諸伏景光: ["景光"],
  萩原千速: ["千速"],
  水無怜奈: ["水無怜奈"],
  ジン: codename(`${NOT_AFTER_KANA}ジン${NOT_BEFORE_KANA}`), // not inside カタカナ words such as ジンジャー
  ウォッカ: codename("ウォッカ"),
  ベルモット: codename("ベルモット"),
  キャンティ: codename("キャンティ"),
  コルン: codename("コルン"),
  キール: codename("キール"),
};

// Deliberately not estimated:
//  - 工藤新一: synopses mention him as Conan's true identity, not as an appearance.
//  - スコッチ: the word is far more often the whisky, and he never appears in anime originals.
export const NOT_ESTIMATED = ["工藤新一", "スコッチ"];

// Manual corrections for specific anime-original episodes, keyed by YTV episode number (the number after
// "A" in the app's badge - the FIRST episode of a merged multi-part entry). A user found several episodes in
// the classic 毛利小五郎"名探偵ぶり" format (he gets the credit, but コナン solves it through his bow-tie voice
// changer, unnamed in the synopsis) missing コナン from the estimate; each was checked by eye against the
// episode. Not a blanket rule (「探偵女子」spin-offs such as 女子会ミステリー really do have no コナン), so this
// stays a short, hand-checked list rather than a heuristic. Add to it the same way when another wrong episode
// is reported: {name: ["+add"] or ["-remove"]}.
export const FORCE_CAST = {
  67: ["+江戸川コナン"], 95: ["+江戸川コナン"], 196: ["+江戸川コナン"], 979: ["+江戸川コナン"],
  980: ["+江戸川コナン"], 1049: ["+江戸川コナン"], 1103: ["+江戸川コナン"], 1139: ["+江戸川コナン"], 1213: ["+江戸川コナン"],
};

// A group name in the text stands for several characters.
const GROUPS = { 少年探偵団: ["吉田歩美", "小嶋元太", "円谷光彦", "灰原哀"] };

// Every alias becomes a list of [regex, contextRegex | null].
const compiled = Object.entries(ALIASES).map(([name, aliases]) => [
  name,
  aliases.map((a) => (Array.isArray(a) ? [new RegExp(a[0]), new RegExp(a[1])] : [new RegExp(a), null])),
]);

/** Returns the set of character names (as in websunday.net) that the text suggests. */
export function detectCharacters(text) {
  const found = new Set();
  for (const [name, aliases] of compiled) {
    if (aliases.some(([re, ctx]) => re.test(text) && (!ctx || ctx.test(text)))) found.add(name);
  }
  for (const [group, members] of Object.entries(GROUPS)) if (text.includes(group)) members.forEach((m) => found.add(m));
  return found;
}
