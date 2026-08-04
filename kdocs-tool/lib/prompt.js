// ── 指令模板生成 ──
const { FILE_ID } = require("./config");

function buildPrompt(parsed, steamAppId, manualCoverUrl) {
  const urls = [];
  if (parsed.baiduUrl) urls.push(`百度网盘：${parsed.baiduUrl}`);
  if (parsed.xunleiUrl) urls.push(`迅雷网盘：${parsed.xunleiUrl}`);
  if (parsed.quarkUrl) urls.push(`夸克网盘：${parsed.quarkUrl}`);
  const tagStr = parsed.tags.join(",") + (steamAppId ? ",Steam" : "");

  // 游戏大小：文本自动识别 > 占位提示
  const gameSize = (parsed.size || "").trim();
  const sizeLine = gameSize || "【从夸克分享页抓取，如 30.7G】";

  // 封面图：已由上位逻辑（executor）自动下载到本地目录，bl 只需读取并上传，不要自行联网搜索封面直链
  const coverLine = `封面图已由工具自动下载到本地目录 E:\\游戏网站建设\\（文件名形如 ${parsed.raw}_cover.jpg/.png/.webp），请直接读取该目录下的封面图片文件并 upload_attachment 上传，不要自行联网搜索封面直链。`;

  const steamLine = steamAppId
    ? `Steam AppID：${steamAppId}`
    : "Steam AppID：非 Steam 游戏，跳过 Steam 搜索";

  return `将以下游戏写入金山文档多维表。严格按步骤执行，不要跳过。

多维表：file_id=${FILE_ID}，sheet_id=1

=== 游戏信息 ===
游戏名称：${parsed.raw}
游戏大小：${sizeLine}
游戏介绍：【必须先 web_search 联网搜真实公开资料（Wikipedia/Metacritic/官方新闻稿/权威测评，多源交叉验证）再写，80-110字；必含 开发商/发行年份/类型标签/核心玩法，搜到则加 Metacritic评分/全球销量/权威奖项；禁止以"该游戏"开头（用《》起头）、禁止写"支持中文"、禁止推测评分（搜不到的数字一律不写）、禁止罗列平台、禁止堆砌"精美画面""极致体验""沉浸式"等空泛形容词；严禁凭记忆编造】
游戏信息标签：${tagStr}
下载链接：分别填${urls.length ? " " + urls.join("；") : "【无链接请跳过】"}
${steamLine}
封面图：${coverLine}

=== 执行步骤 ===
1. 查重：kdocs-cli call dbsheet.list_records --args '{"file_id":"${FILE_ID}","sheet_id":1}' 确认无同名记录
2. 下载封面图到 E:\\游戏网站建设\\
3. 上传封面：kdocs-cli call upload_attachment --args '{"sheet_id":1,"filename":"封面文件名.jpg","content_type":"image/jpeg","content_base64":"<图片Base64>"}' 获取 object_id
4. 创建记录：kdocs-cli call dbsheet.create_records --args '{"file_id":"${FILE_ID}","sheet_id":1,"prefer_id":false,"add_select_item":true,"records":[{"fields":{"游戏名称":"${parsed.raw}","游戏介绍":"...","游戏大小":"${gameSize || "..."}","游戏信息标签":["${parsed.tags.join('","')}"${steamAppId ? ',"Steam"' : ""}],"下载链接":[${[
    parsed.baiduUrl ? `{"address":"${parsed.baiduUrl}","displayText":"百度网盘"}` : "",
    parsed.xunleiUrl ? `{"address":"${parsed.xunleiUrl}","displayText":"迅雷网盘"}` : "",
    parsed.quarkUrl ? `{"address":"${parsed.quarkUrl}","displayText":"夸克网盘"}` : ""
  ].filter(Boolean).join(",")}]}}]} 获取 record_id
5. 更新封面：kdocs-cli call dbsheet.update_records --args '{"file_id":"${FILE_ID}","sheet_id":1,"records":[{"id":"record_id","fields":{"作品展示":[{"fileName":"封面文件名.jpg","size":字节数,"source":"upload_ks3","type":"image/jpeg","uploadId":"object_id"}]}}]}'
6. 验证：kdocs-cli call dbsheet.get_record --args '{"file_id":"${FILE_ID}","sheet_id":1,"record_id":"record_id"}' 回读确认

所有 kdocs-cli 命令统一用 call <function> --args '<JSON>' 形式（与自动执行逻辑保持一致），kdocs-cli 版本 v2.5.22。`;
}

module.exports = { buildPrompt };
