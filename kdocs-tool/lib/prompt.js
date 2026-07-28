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

  // 封面图：统一由 bl 联网搜索封面直链并下载；Steam 也可用 cloudflare CDN；非 Steam 也必须让 bl 去搜官方封面
  const coverLine = steamAppId
    ? `封面由 bl 联网获取直链下载；Steam 也可直接用 cdn.cloudflare.steamstatic.com/steam/apps/${steamAppId}/library_600x900_2x.jpg（cloudflare 源最稳，fastly 直链实测404勿用）`
    : `封面必须由 bl 联网搜索官方封面/宣传图直链下载（搜索 "${parsed.raw} 封面"、"${parsed.raw} 官网" 等），不允许跳过；若实在找不到，才在工具「封面链接」输入框粘贴图片 URL：${manualCoverUrl || "（未提供）"}`;

  const steamLine = steamAppId
    ? `Steam AppID：${steamAppId}`
    : "Steam AppID：非 Steam 游戏，跳过 Steam 搜索";

  return `将以下游戏写入金山文档多维表。严格按步骤执行，不要跳过。

多维表：file_id=${FILE_ID}，sheet_id=1

=== 游戏信息 ===
游戏名称：${parsed.raw}
游戏大小：${sizeLine}
游戏介绍：【用 web_search 搜真实描述，50-80字，不要自己编】
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
