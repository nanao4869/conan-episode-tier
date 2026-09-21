// Automatic tags for the 舞台 / 事件のタイプ stats: keywords found in an episode's title, venue and synopsis.
//
// Neither source has structured data for this (websunday.net has a free-text 場所 and the synopsis, YTV only
// the synopsis), so this is keyword matching. It is a rough guide: a case can carry several tags, and some are
// missed or over-matched. Only the tag ids are stored in data/episodes.js, not the texts.
//
// Add or tune a rule here, run `node build-data.mjs`, and check the counts it prints.
// Keep keywords specific: a bare 山 or 島 would also match names such as 山村 or 小島.

export const PLACE_TAGS = [
  ["温泉・旅館", /温泉|旅館|湯煙|湯けむり|露天風呂|民宿|湯布院/],
  ["山・別荘・スキー場", /山荘|別荘|登山|山道|山小屋|山奥|山中|雪山|スキー|ゲレンデ|高原|峠|ロッジ|キャンプ場|山(?=へ|で|に|を|が|は|、)/],
  ["海・島・港", /孤島|無人島|離島|島(?=に|へ|で|の|を|は|が)|海岸|海辺|海水浴|ビーチ|砂浜|入り江|漁村|岬|港/],
  ["船・クルーズ", /客船|クルーズ|ヨット|フェリー|遊覧船|船上|船内|船(?=に|で|の|は|が|を)/],
  ["列車・駅", /列車|電車|新幹線|特急|鉄道|地下鉄|寝台|トロッコ|駅(?![前])|ミステリートレイン/],
  ["飛行機・空港", /飛行機|空港|機内|ヘリコプター|旅客機|フライト|ジャンボ/],
  ["学校", /学校|高校|小学校|中学|大学|教室|学園|帝丹|修学旅行|文化祭|体育館|クラブ活動/],
  ["洋館・屋敷・城", /洋館|屋敷|古城|城(?!下)|御殿|豪邸|大邸宅|旧家|館の主/],
  ["遊園地・イベント", /遊園地|テーマパーク|トロピカルランド|動物園|水族館|祭り|縁日|花火|フェス|コンサート|ライブ|博覧会|マラソン|パーティー|大会/],
  ["レストラン・カフェ", /ホテル|レストラン|カフェ|喫茶|ポアロ|ラーメン|寿司|食堂|居酒屋|料理|バー(?=[へでにをが、])/],
  ["美術館・博物館", /美術館|博物館|図書館|展覧会|展示会|ギャラリー|宝石展|オークション/],
  ["病院・研究所", /病院|医院|診療所|研究所|研究室|クリニック/],
  ["テレビ局・劇場", /テレビ局|撮影|スタジオ|劇場|舞台|映画|ドラマ|番組|生放送|楽屋/],
  ["関西（大阪・京都など）", /大阪|京都|浪花|関西|奈良|神戸|滋賀|和歌山/],
  ["海外", /海外|ニューヨーク|ハワイ|ロンドン|パリ|ロサンゼルス|香港|アメリカ|イギリス|ヨーロッパ|外国/],
  ["街・ビル・会社", /会社|オフィス|社長|ビル(?![ー])|マンション|アパート|デパート|百貨店|銀行|商店街/],
];

export const TYPE_TAGS = [
  ["殺人", /殺人|殺害|殺され|殺す|遺体|死体|毒殺|刺殺|射殺|撲殺|絞殺/],
  ["誘拐・監禁", /誘拐|監禁|拉致|さらわ|人質/],
  ["爆破・爆弾", /爆破|爆弾|爆発|爆殺|時限/],
  ["暗号・謎解き", /暗号|謎解き|謎かけ|なぞなぞ|クイズ|パズル|宝探し|宝の地図|ダイイング|ダイイングメッセージ/],
  ["盗難・強盗・怪盗", /盗難|盗まれ|盗み|強盗|窃盗|泥棒|怪盗|宝石|強奪/],
  ["脅迫・恐喝", /脅迫|恐喝|脅され|ゆすり/],
  ["失踪・行方不明", /失踪|行方不明|いなくなっ|姿を消/],
  ["密室", /密室/],
  ["連続事件", /連続|次々|相次ぐ|第二の|第三の/],
  ["推理対決", /対決|勝負|VS|vs|ＶＳ|決戦|推理ショー/],
  ["怪談・オカルト", /怪談|幽霊|オカルト|呪|祟|妖怪|心霊|降霊|UFO|宇宙人|都市伝説|伝説/],
];

/** [name, kind] for every tag, in id order (kind: "place" | "type"). */
export const TAGS = [...PLACE_TAGS.map(([n]) => [n, "place"]), ...TYPE_TAGS.map(([n]) => [n, "type"])];

const RULES = [...PLACE_TAGS, ...TYPE_TAGS];

/** Ids of the tags whose keywords appear in the text. */
export function tagsFor(text) {
  const ids = [];
  RULES.forEach(([, re], i) => {
    if (re.test(text)) ids.push(i);
  });
  return ids;
}
