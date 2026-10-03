# 夹具

字幕样本里的文字都是替换过的或自编的，只保留测试要用的结构（时间轴、窗口、分段、标签）。新写的测试例句一律自己编，不要从真实视频里摘。

所以**断言不要依赖夹具里的具体文字**。需要「一段夹具里真有的正文」，运行时从夹具里取（`probes.js` 的隐私用例是例子）；需要夹具具备某种结构时，先断言这种结构确实存在，免得换了夹具以后用例悄悄变空（`formats.js` 的「CJK 词级 `<s>` 拼接不插入空格」是例子）。

| 文件 | 格式 | 结构 | 谁在用 |
|---|---|---|---|
| `YouTube.timedtext.json` | json3 | 人工字幕轨，中文，近千条 cue | 主夹具，`translate/` 下大多数文件都在用 |
| `asr.zh.json` | json3 | 中文 ASR 滚动轨：`aAppend`、`wWinId`、词级 `segs`、`[音乐]` 标记 | `formats.js`、`request.js`、`resilience.js` |
| `asr.jp.xml` | srv3 | 日文 ASR：`<s>` 词级、`a="1"` 滚动、`<w>` 窗口 | `formats.js`、`probes.js`、`prompt.js`、`backfill.js` |
| `long.en.xml` | srv3 | 英文人工轨：一段自编对白循环拼成的二十来分钟、六百多条 cue | `prompt.js`（判轨道类型） |
| `YouTube.timedtext.xml` | srv3 | 英文人工轨，短，带 `&#39;` 实体与 cue 内换行 | `formats.js` |
| `ytsub.v3.6.4.js` | 脚本 | v3.6.4 的 `ytsub.js`，不是字幕 | 两套测试的迁移对照：`panel.js` 的 v3 → v4 迁移、`backfill.js` 的请求体逐字节对照 |

`ytsub.v3.6.4.js` 是升级前的脚本，迁移用例拿它和当前脚本喂同一份存储、比较请求体与配置指纹。它去掉了注释，只保留测试用得到的翻译与后台补翻部分。文件不在时两套测试都直接报错，不会悄悄跳过。
