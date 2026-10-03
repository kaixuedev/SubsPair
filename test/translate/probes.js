'use strict';
/*
 * 探针与观察者：只记形状、计数与哈希，不记视频 ID 原值与密钥。字幕正文只有一处例外：
 * 模型漏行时，把模型原话与送翻原文各截一小段留在设备上的诊断里；复制诊断时会删掉，不往外带。
 *
 *   · 请求日志环与播放位置环　每次字幕请求一行、每次播放统计上报一行
 *   · 观察者角色　脚本的第三个角色（前两个是翻译与面板）：googlevideo 分片与 http-request 钩子上的
 *     timedtext 只记形状、原样放行；受同一个探针开关管，所以放在这里
 *   · 探针　采集内容、面包屑、版本隔离、环形缓冲，以及隐私红线
 *
 * 另有几条探针用例搭车在别处：$done 之后的两个探针在 waves.js，postdone 弹通知在 backfill.js，
 * $argument 被探针记录在 request.js。
 */

const path = require('path');

const { check, assert, assertEqual, section } = require('../lib/harness');
const {
  runScript, SCRIPT, FIX, cfg, JSON_URL, XML_URL,
  json3, goodTranslator, dropNth,
} = require('../lib/sandbox');

module.exports = async function () {
  section('探针：请求日志环与播放位置环');

  await check('reqlog：每次 timedtext 请求一行（replaced / pass 都记），字段齐、不含视频 id 原值', async () => {
    const max = +(SCRIPT.match(/var REQLOG_MAX = (\d+)/) || [])[1];
    assert(max >= 20, '应当能从源码读到 REQLOG_MAX');
    const store = new Map();
    const conf = cfg({ probe: true, cache: true, chunkSize: 10 });
    await runScript({ url: JSON_URL, body: FIX('YouTube.timedtext.json'), config: conf, store, respond: goodTranslator });
    assert(store.get('llmsubs.reqlog'), '翻译角色跑完应当写了 reqlog');
    let log = JSON.parse(store.get('llmsubs.reqlog'));
    assertEqual(log.length, 1, '一次请求一行');
    const e = log[0];
    assert(/^\d{4}-\d\d-\d\dT/.test(e.at), '带 ISO 时间');
    assert(/^[0-9a-f]{8}$/.test(e.h), '视频只记短哈希：' + e.h);
    assertEqual(e.host, 'www'); assertEqual(e.n, 1); assertEqual(e.o, 'replaced'); assertEqual(e.m, 'f');
    assert(/^[0-9a-f]{4}$/.test(e.tk), '带轨哈希前 4 位：' + e.tk);
    assert(typeof e.ms === 'number' && typeof e.c === 'number' && typeof e.t === 'number' && typeof e.x === 'number', '带耗时与批次计数');
    assert('k' in e && e.k === null, '没有 kind 参数时 k 为 null（人工轨）');
    // 放行的请求（tlang 轨）也记一行；它在计数之前早退，所以没有 n（不是 1，是「不知道」）
    await runScript({ url: JSON_URL + '&tlang=zh-Hans', body: FIX('YouTube.timedtext.json'), config: conf, store, respond: goodTranslator });
    log = JSON.parse(store.get('llmsubs.reqlog'));
    assertEqual(log.length, 2, '放行也记');
    assert(log[1].o.startsWith('pass:'), '结果写清是放行：' + log[1].o);
    assert(!('n' in log[1]), '早退放行的行不该有 n 字段');
    // 带 kind=asr 的轨记 k='asr'。n 按轨计（视频 + lang + kind + name）：ASR 轨是另一条轨，
    // 它的第一次请求 n=1（播放器手上没有它，不能当成后台刷新）；同一条轨再来一次才是 2。
    await runScript({ url: JSON_URL + '&kind=asr', body: FIX('YouTube.timedtext.json'), config: conf, store, respond: goodTranslator });
    log = JSON.parse(store.get('llmsubs.reqlog'));
    assertEqual(log[2].k, 'asr', '自动字幕轨记 k=asr');
    assertEqual(log[2].n, 1, '另一条轨的第一次请求 n=1');
    assert(log[2].h === log[0].h && log[2].tk !== log[0].tk, '同一视频（h 同）的另一条轨（tk 不同）');
    await runScript({ url: JSON_URL + '&kind=asr', body: FIX('YouTube.timedtext.json'), config: conf, store, respond: goodTranslator });
    log = JSON.parse(store.get('llmsubs.reqlog'));
    assertEqual(log[3].n, 2, '同一条轨的真请求才累加 n');
    assert(!store.get('llmsubs.reqlog').includes('abc123'), '日志里不得出现视频 id 原值');
  });

  await check('reqlog：被引擎掐死的运行也记一行（来自面包屑，带视频哈希与阶段）', async () => {
    const ver = (SCRIPT.match(/var SCRIPT_VER = '([^']+)'/) || [])[1];
    const stale = +(SCRIPT.match(/var CRUMB_STALE_MS = (\d+)/) || [])[1];
    const store = new Map();
    store.set('llmsubs.diagver', ver);
    const deadAt = Date.now() - stale - 5000;
    store.set('llmsubs.inflight', JSON.stringify([{ id: 'deadrun', v: ver, stage: 'translating', at: deadAt, todo: 7, mode: 'q', h: 'www', vh: 'deadbeef' }]));
    await runScript({ url: JSON_URL, body: FIX('YouTube.timedtext.json'), config: cfg({ probe: true }), store, respond: goodTranslator });
    const log = JSON.parse(store.get('llmsubs.reqlog'));
    const killed = log.filter((x) => x.o === 'killed');
    assertEqual(killed.length, 1, '掐死的那次要在日志里');
    assertEqual(killed[0].h, 'deadbeef'); assertEqual(killed[0].host, 'www'); assertEqual(killed[0].stage, 'translating'); assertEqual(killed[0].t, 7);
    assertEqual(killed[0].at, new Date(deadAt).toISOString(), '时间用面包屑写下的那一刻');
    // 写入侧：本次运行留下的 parsed / translating 面包屑都要带 vh 与 h，下次若被掐死才对得上视频。
    // 面包屑在正常收尾时会被抹掉，所以用 Proxy 抓运行中对 inflight 的每一次写入。
    const seenCrumbs = [];
    const base = new Map();
    const spy = new Proxy(base, {
      get(target, prop) {
        if (prop === 'set') return (k, v) => { if (k === 'llmsubs.inflight' && v) seenCrumbs.push(v); return target.set(k, v); };
        const val = target[prop];
        return typeof val === 'function' ? val.bind(target) : val;
      },
    });
    await runScript({ url: JSON_URL, body: FIX('YouTube.timedtext.json'), config: cfg({ probe: true, cache: false }), store: spy, respond: (o) => Object.assign(goodTranslator(o), { delay: 50 }) });
    const stages = {};
    for (const raw of seenCrumbs) for (const c of JSON.parse(raw)) stages[c.stage] = c;
    assert(stages.parsed && /^[0-9a-f]{8}$/.test(stages.parsed.vh) && stages.parsed.h === 'www', 'parsed 面包屑要带 vh 与 h：' + JSON.stringify(stages.parsed));
    assert(stages.translating && stages.translating.vh === stages.parsed.vh && stages.translating.h === 'www', 'translating 面包屑要带同一个 vh：' + JSON.stringify(stages.translating));
  });

  await check('reqlog：环上限，最老的先出；版本一换连同 pings 一起清零', async () => {
    const max = +(SCRIPT.match(/var REQLOG_MAX = (\d+)/) || [])[1];
    const ver = (SCRIPT.match(/var SCRIPT_VER = '([^']+)'/) || [])[1];
    const store = new Map();
    store.set('llmsubs.diagver', ver);
    const old = []; for (let i = 0; i < max; i++) old.push({ at: 'old' + i, o: 'replaced' });
    store.set('llmsubs.reqlog', JSON.stringify(old));
    await runScript({ url: JSON_URL, body: FIX('YouTube.timedtext.json'), config: cfg({ probe: true }), store, respond: goodTranslator });
    let log = JSON.parse(store.get('llmsubs.reqlog'));
    assertEqual(log.length, max, '不超过上限');
    assertEqual(log[0].at, 'old1', '最老的一条被挤掉');
    assertEqual(log[max - 1].o, 'replaced');
    assert(log[max - 1].at !== 'old' + (max - 1), '最新一条是本次的');
    // 版本闸
    const s2 = new Map();
    s2.set('llmsubs.diagver', '0.0.0');
    s2.set('llmsubs.reqlog', JSON.stringify([{ at: 'stale' }]));
    s2.set('llmsubs.pings', JSON.stringify([{ at: 'stale' }]));
    await runScript({ url: JSON_URL, body: FIX('YouTube.timedtext.json'), config: cfg({ probe: true }), store: s2, respond: goodTranslator });
    log = JSON.parse(s2.get('llmsubs.reqlog'));
    assertEqual(log.length, 1, '旧版本的请求日志清掉，只剩本次');
    assert(!(s2.get('llmsubs.pings') || '').includes('stale'), '旧版本的 pings 也清掉');
  });

  await check('pings：播放统计上报只记时间、视频短哈希、cmt，不记 cpn，不进形状表，m/www 两域都认', async () => {
    const store = new Map();
    const url = 'https://www.youtube.com/api/stats/watchtime?ns=yt&el=detailpage&cpn=SECRETCPN123&docid=abc123&ver=2&cmt=123.4&st=100,110&et=123.4,130&len=3600.5&state=playing';
    const r = await runScript({ url, noResponse: true, store, config: cfg({ probe: true }), respond: goodTranslator });
    assert(!r.result || !r.result.body, '观察者原样放行');
    assertEqual(r.calls.length, 0, '不发任何翻译请求');
    assert(store.get('llmsubs.pings'), 'www 上的 api/stats 上报应当进 pings 环（OBSERVE_RE 要放行它）');
    const pings = JSON.parse(store.get('llmsubs.pings'));
    assertEqual(pings.length, 1);
    const p = pings[0];
    assertEqual(p.host, 'www'); assertEqual(p.kind, 'watchtime'); assertEqual(p.cmt, 123.4);
    assertEqual(p.st, '100,110'); assertEqual(p.et, '123.4,130'); assertEqual(p.len, '3600.5');
    assert(/^[0-9a-f]{8}$/.test(p.h), 'docid 只记短哈希：' + p.h);
    const raw = store.get('llmsubs.pings');
    assert(!raw.includes('abc123') && !raw.includes('SECRETCPN'), '不得出现视频 id 原值或 cpn');
    assert(!store.get('llmsubs.obs'), '统计上报不进形状表（cmt 每次不同会把形状预算吃光）');
    assert(!store.get('llmsubs.diag'), '不写翻译侧诊断');
    // st / et 是逗号列表，实际请求里很容易超过 40 字符，不能被砍成半截数
    const longSt = Array.from({ length: 12 }, (_, i) => (i * 30.045).toFixed(3)).join(',');
    await runScript({ url: 'https://www.youtube.com/api/stats/watchtime?docid=abc123&cmt=5&st=' + longSt + '&et=' + longSt, noResponse: true, store, config: cfg({ probe: true }), respond: goodTranslator });
    assertEqual(JSON.parse(store.get('llmsubs.pings'))[1].st, longSt, 'st 列表要完整保留（' + longSt.length + ' 字符）');
    // m 域同样认；cmt 缺失记 null
    await runScript({ url: 'https://m.youtube.com/api/stats/playback?ns=yt&docid=abc123&ver=2', noResponse: true, store, config: cfg({ probe: true }), respond: goodTranslator });
    const p2 = JSON.parse(store.get('llmsubs.pings'))[2];
    assertEqual(p2.host, 'm'); assertEqual(p2.kind, 'playback'); assertEqual(p2.cmt, null);
    // qoe / atr 这类不记（qoe 的位置在 POST body，读不到；记了只是占环），也不进形状表
    await runScript({ url: 'https://www.youtube.com/api/stats/qoe?docid=abc123&cmt=0:12.3', noResponse: true, store, config: cfg({ probe: true }), respond: goodTranslator });
    await runScript({ url: 'https://www.youtube.com/api/stats/atr?docid=abc123', noResponse: true, store, config: cfg({ probe: true }), respond: goodTranslator });
    assertEqual(JSON.parse(store.get('llmsubs.pings')).length, 3, 'qoe / atr 不进 pings');
    assert(!store.get('llmsubs.obs'), 'qoe / atr 也不进形状表');
    // 环上限：最老的先出
    const pmax = +(SCRIPT.match(/var PINGS_MAX = (\d+)/) || [])[1];
    assert(pmax >= 60, '应当能从源码读到 PINGS_MAX');
    const s4 = new Map();
    const ver = (SCRIPT.match(/var SCRIPT_VER = '([^']+)'/) || [])[1];
    s4.set('llmsubs.diagver', ver);
    const old = []; for (let i = 0; i < pmax; i++) old.push({ at: 'old' + i, cmt: i });
    s4.set('llmsubs.pings', JSON.stringify(old));
    await runScript({ url, noResponse: true, store: s4, config: cfg({ probe: true }), respond: goodTranslator });
    const capped = JSON.parse(s4.get('llmsubs.pings'));
    assertEqual(capped.length, pmax, 'pings 不超过上限');
    assertEqual(capped[0].at, 'old1', '最老的一条被挤掉');
    assertEqual(capped[pmax - 1].cmt, 123.4, '最新一条是本次的');
    // 探针关闭时什么都不写
    const s3 = new Map();
    await runScript({ url, noResponse: true, store: s3, config: cfg({ probe: false }), respond: goodTranslator });
    assert(!s3.get('llmsubs.pings'), '探针关闭时不记');
  });

  section('观察者角色：只记形状，不改不读 body');

  // 带一堆敏感参数的 googlevideo 字幕分片 URL（值全是编的）
  const GV_VTT = 'https://rr3---sn-xxxxxxx.googlevideo.com/videoplayback'
    + '?expire=1234567890&ei=SECRET_EI&ip=203.0.113.7&id=o-VIDEOIDXYZ&itag=386'
    + '&mime=text%2Fvtt&sq=2&signature=DEADBEEFSIG&pot=POTTOKEN123&key=yt8';

  await check('googlevideo 字幕分片：记录形状、原样放行、不碰翻译流程', async () => {
    const { result, calls, store } = await runScript({
      url: GV_VTT, body: 'WEBVTT\n\n00:00.000 --> 00:02.000\nhello',
      headers: { 'Content-Type': 'text/vtt; charset=utf-8' },
      config: cfg({ probe: true }), respond: goodTranslator,
    });
    assert(!result || !result.body, '观察者绝不改写任何东西');
    assertEqual(calls.length, 0, '观察者绝不发 LLM 请求');
    assert(!store.get('llmsubs.diag'), '观察者不写翻译侧的诊断记录');
    const obs = JSON.parse(store.get('llmsubs.obs'));
    assertEqual(obs.length, 1, '应当记下一种形状');
    assertEqual(obs[0].host, '*.googlevideo.com', '主机名应归一化（机房/会话标签是噪声也暴露位置）');
    assertEqual(obs[0].path, '/videoplayback', '应记录路径');
    assertEqual(obs[0].val.mime, 'text/vtt', 'mime 是判定字幕分片的关键证据，必须记');
    assertEqual(obs[0].val.itag, '386', 'itag 在白名单内');
    assert(obs[0].ctype.indexOf('text/vtt') >= 0, '应记录 Content-Type');
    assert(obs[0].params.indexOf('signature') >= 0, '参数名要记全，才能还原 URL 形状');
  });

  await check('【回归】路径参数风格的 URL：观察者只保留固定路径前缀，不记 path 里的值', async () => {
    // googlevideo 的 /api/manifest/ 把 ip / 视频 id / signature / pot / 机房主机名
    // 全编码在路径里，query 的脱敏白名单完全够不着。原样存下来等于把这些
    // 写进要外发的诊断；而且 path 每次都不同，30 条形状的预算几下就被吃光。
    const manifest = 'https://rr3---sn-xxxxxxx.googlevideo.com/api/manifest/hls_variant'
      + '/expire/1234567890/ei/SECRETEI123/ip/203.0.113.77/id/SECRETVIDEOID99'
      + '/playback_host/rr3---sn-xxxxxxx.googlevideo.com/gcr/xx'
      + '/sig/SECRETSIGNATURE456/pot/SECRETPOTTOKEN/file/index.m3u8';
    const store = new Map();
    for (let i = 0; i < 5; i++) {
      // 每次 expire/sig 都不同，和实际请求一样
      await runScript({
        url: manifest.replace('1234567890', String(1234567890 + i)).replace('SECRETSIGNATURE456', 'SIG' + i),
        body: '#EXTM3U', config: cfg({ probe: true }), store, respond: goodTranslator,
      });
    }
    const dump = store.get('llmsubs.obs');
    for (const secret of ['SECRETEI123', '203.0.113.77', 'SECRETVIDEOID99', 'SECRETSIGNATURE456', 'SECRETPOTTOKEN', 'sn-xxxxxxx']) {
      assert(dump.indexOf(secret) < 0, '绝不能出现 ' + secret + '：' + dump.slice(0, 200));
    }
    const obs = JSON.parse(dump);
    assertEqual(obs.length, 1, '同一类清单请求必须归成一种形状（否则形状预算被吃光），实际 ' + obs.length);
    assert(obs[0].path.indexOf('/api/manifest/hls_variant') === 0, '应保留固定路径前缀: ' + obs[0].path);
    assertEqual(obs[0].n, 5, '5 次请求应当记在同一条的计数上');
  });

  await check('观察者的隐私红线：签名 / IP / 视频 ID / token 的值一概不记', async () => {
    const { store } = await runScript({
      url: GV_VTT, body: 'WEBVTT', config: cfg({ probe: true }), respond: goodTranslator,
    });
    const dump = store.get('llmsubs.obs');
    for (const secret of ['DEADBEEFSIG', '203.0.113.7', 'POTTOKEN123', 'o-VIDEOIDXYZ', 'SECRET_EI', 'sn-xxxxxxx']) {
      assert(dump.indexOf(secret) < 0, '绝不能出现 ' + secret);
    }
  });

  await check('同一形状去重计数，不会把每个分片都堆成一条记录', async () => {
    const store = new Map();
    for (let i = 0; i < 3; i++) {
      await runScript({ url: GV_VTT, body: 'WEBVTT', store, config: cfg({ probe: true }), respond: goodTranslator });
    }
    const obs = JSON.parse(store.get('llmsubs.obs'));
    assertEqual(obs.length, 1, '同一形状只占一条');
    assertEqual(obs[0].n, 3, '重复次数记在 n 上');
  });

  await check('形状数量有硬上限，观察者不会无限增长', async () => {
    const store = new Map();
    for (let i = 0; i < 34; i++) {
      await runScript({
        url: 'https://rr1---sn-x.googlevideo.com/videoplayback?mime=text%2Fvtt&itag=' + (300 + i),
        body: 'WEBVTT', store, config: cfg({ probe: true }), respond: goodTranslator,
      });
    }
    const obs = JSON.parse(store.get('llmsubs.obs'));
    assert(obs.length <= 30, '形状数应封顶在 30，实际 ' + obs.length);
  });

  await check('【回归】http-request 钩子上的 timedtext 走观察者，不会空跑整套翻译', async () => {
    // 观察者是 http-request 钩子：mweb 万一真的请求 timedtext，请求钩子会先命中
    // 同一个 URL。没有 HAS_RESPONSE 判据的话，翻译角色会拿一个空 $response
    // 跑完整套流程 → 污染诊断、白占一次运行计数。
    const store = new Map();
    const { result, calls } = await runScript({
      url: 'https://m.youtube.com/api/timedtext?v=abc123&lang=en&format=srv3',
      noResponse: true, store, config: cfg({ probe: true }), respond: goodTranslator,
    });
    assert(!result || !result.body, '没有响应体可改，必须原样放行');
    assertEqual(calls.length, 0, '不该发起任何翻译请求');
    assert(!store.get('llmsubs.diag'), '不该写翻译侧的诊断记录（那是一次假运行）');
    const obs = JSON.parse(store.get('llmsubs.obs'));
    assertEqual(obs[0].host, 'm.youtube.com', '应当被观察者记下来');
    assertEqual(obs[0].path, '/api/timedtext', '记录路径');
  });

  await check('探针关闭时观察者什么都不写', async () => {
    const { store } = await runScript({
      url: GV_VTT, body: 'WEBVTT', config: cfg({ probe: false }), respond: goodTranslator,
    });
    assertEqual(store.size, 0, '关掉探针就不该碰存储');
  });

  section('探针：采集内容与隐私红线');

  await check('探针关闭时不写任何诊断数据', async () => {
    const { store } = await runScript({
      url: JSON_URL, body: FIX('YouTube.timedtext.json'), config: cfg({ probe: false }), respond: goodTranslator,
    });
    // 版本章 diagver 不算诊断数据：探针关着也要盖，否则 cron 会把前台刚排的队列当旧版本清掉（backfill.js 有回归用例）
    for (const k of store.keys()) assert(k === 'llmsubs.diagver' || (!k.startsWith('llmsubs.diag') && !k.startsWith('llmsubs.stat')), '探针关闭时不该写 ' + k);
  });

  await check('探针打开时记录格式与 ASR 形态指纹', async () => {
    const { store } = await runScript({
      url: XML_URL, body: FIX('asr.jp.xml'), config: cfg({ probe: true }), respond: goodTranslator,
    });
    const diag = JSON.parse(store.get('llmsubs.diag'));
    assert(Array.isArray(diag) && diag.length === 1, '应当写入一条诊断记录');
    const r = diag[0];
    assertEqual(r.outcome, 'replaced', '应当记录结果');
    assertEqual(r.sub.format, 'srv3', '应当记录检测到的格式');
    assertEqual(r.q.format, 'srv3', '应当记录 URL 上的 format 参数（这是判断客户端的依据）');
    assertEqual(r.q.host, 'www', '应当记录请求主机的子域标签（区分 www 与 m）');
    const ver = (SCRIPT.match(/var SCRIPT_VER = '([^']+)'/) || [])[1];
    assertEqual(r.v, ver, '每条记录应带脚本版本号');
    assert(r.sub.sTags > 0, '应当记录 <s> 标签数（逐词滚动的特征）');
    assert(r.sub.drops > 0, '应当记录 a="1" 续接事件数');
    assert(r.sub.rc, '应当记录滚动窗口行数 rc');
    assert(r.audit && typeof r.audit.dblEsc === 'number', '应当记录发出前的换行自检');
    assert(r.llm && r.llm.host === 'api.example.com', '应当记录端点 host');
    // noSystem 必须在 diagSet('llm') 之前赋值：var 只提升声明不提升赋值，晚了读到的就是 undefined，
    // JSON.stringify 直接丢键——诊断里就没有这个字段。
    assertEqual(typeof r.llm.noSystem, 'boolean', 'llm.noSystem 必须是布尔（undefined 会让 JSON.stringify 丢掉整个字段）');
    assert(r.chunks && r.chunks.total > 0, '应当记录批次统计');
    assert(typeof r.chunks.via === 'string' && r.chunks.via, '应记录哪条路径触发的渲染（调 fastBudgetMs 的依据）');
    assert(typeof r.chunks.maxChars === 'number' && r.chunks.maxChars > 0, '应记录最大批字符数（耗时的第一现场）');
    assert(typeof r.chunks.callMax === 'number' && r.chunks.callMax >= r.chunks.callMin,
      '应记录单批往返的最小值与最大值（只看平均值看不出快批与慢批的差距）');
  });

  await check('探针记录里不含字幕正文 / 视频 ID 原值 / API key', async () => {
    const { store } = await runScript({
      url: JSON_URL, body: FIX('YouTube.timedtext.json'), config: cfg({ probe: true }), respond: goodTranslator,
    });
    // 扫全部会进诊断报告的键（reqlog / pings / 探针键都在内），译文缓存除外（那是派生内容，不外发）
    await new Promise((res) => setTimeout(res, 60));   // 让 relay 回调落盘
    let dump = '';
    for (const [k, v] of store) if (k.startsWith('llmsubs.') && !k.startsWith('llmsubs.c.') && k !== 'llmsubs.cache.idx') dump += '|' + v;
    assert(dump.includes('"reqlog"') || store.has('llmsubs.reqlog'), '前提自检：请求日志在扫描范围内');
    assert(!dump.includes('sk-test'), '绝不能出现 API key');
    assert(!dump.includes('abc123'), '绝不能出现视频 ID 原值');
    // 注意：断言的句子必须真的存在于 fixture 正文里，否则这条红线永远为真、等于没被检验。
    // 夹具的内容会换，写死的词一旦不在里面也没人发现，所以不写死，从夹具里现取一条 cue：
    // 要单行、不含引号与反斜杠（dump 是 JSON 串拼起来的，含换行或引号的正文会被转义，原样搜不到），
    // 再从里面截一段连续的字（至少 4 个）一起断言，只漏出半句也抓得到。
    const cue = JSON.parse(FIX('YouTube.timedtext.json')).events
      .map((e) => ((e.segs && e.segs[0] && e.segs[0].utf8) || '').trim())
      .find((t) => t.length >= 6 && !/["\\\x00-\x1f]/.test(t));
    assert(cue, '前提自检：fixture 里得有一条够长的单行 cue');
    const fragment = (cue.match(/[\p{L}\p{N}]{4,}/gu) || []).sort((a, b) => b.length - a.length)[0];
    assert(fragment, '前提自检：cue 里得有一段够长的连续文字');
    assert(!dump.includes(cue), '绝不能出现字幕正文：' + cue);
    assert(!dump.includes(fragment), '绝不能出现字幕正文的片段：' + fragment);
    assert(!dump.includes('signature'), '不该出现签名参数值');
    const r = JSON.parse(store.get('llmsubs.diag'))[0];
    assertEqual(r.llm.keyPresent, true, '只记「有没有 key」这个布尔');
    assert(!('keyLen' in r.llm), '连长度都不该记（长度会泄漏 key 格式）');
    assert(r.q.vHash && r.q.vHash.length === 8, '视频 ID 只存短哈希');
    // 骨架应当把文本剥成 ·
    assert(r.sub.skeleton.indexOf('·') >= 0, '结构骨架应当剥掉文本');
  });

  await check('探针记录环境快照与「被引擎杀掉」的计数差', async () => {
    const { store } = await runScript({
      url: JSON_URL, body: FIX('YouTube.timedtext.json'), config: cfg({ probe: true }), respond: goodTranslator,
    });
    const env = JSON.parse(store.get('llmsubs.env'));
    assert('rocket' in env && 'fetch' in env && 'clearTimeout' in env, '应当记录引擎能力矩阵');
    assertEqual(store.get('llmsubs.stat.started'), '1', '入口计数');
    assertEqual(store.get('llmsubs.stat.finished'), '1', '收尾计数（两者之差就是被引擎掐掉的次数）');
  });

  await check('正常收尾会清掉在途面包屑（否则下一轮会误报为被掐断）', async () => {
    const { store } = await runScript({
      url: JSON_URL, body: FIX('YouTube.timedtext.json'),
      config: cfg({ probe: true }), respond: goodTranslator,
    });
    assert(!store.get('llmsubs.inflight'), '走到 $done 就必须把面包屑清掉');
    const dead = JSON.parse(store.get('llmsubs.killed') || '[]');
    assertEqual(dead.length, 0, '正常收尾不该被记成掐断');
  });

  await check('久未更新的面包屑才算被掐断，并记下死在哪一步', async () => {
    // started/finished 的差值只能说「有几次没收尾」，说不出死在哪一步。
    const ver = (SCRIPT.match(/var SCRIPT_VER = '([^']+)'/) || [])[1];
    const stale = +(SCRIPT.match(/var CRUMB_STALE_MS = (\d+)/) || [])[1];
    assert(stale > 0, '应当能从源码读到 CRUMB_STALE_MS');
    const store = new Map();
    store.set('llmsubs.diagver', ver);   // 别让 verGate 把用例埋的证据清掉
    store.set('llmsubs.inflight', JSON.stringify([
      { id: 'deadrun', v: ver, stage: 'translating', at: Date.now() - stale - 5000, todo: 7 },
    ]));
    const { store: s2 } = await runScript({
      url: JSON_URL, body: FIX('YouTube.timedtext.json'),
      config: cfg({ probe: true }), respond: goodTranslator, store,
    });
    const dead = JSON.parse(s2.get('llmsubs.killed') || '[]');
    assertEqual(dead.length, 1, '超过阈值的残留应当被记成一次掐断');
    assertEqual(dead[0].stage, 'translating', '要记下死在哪个阶段');
    assertEqual(dead[0].todo, 7, '阶段带的上下文也要留下来');
    assert(dead[0].deadFor >= stale, '要记下它挂了多久');
  });

  await check('【回归】并发运行的面包屑绝不能被误判成掐断', async () => {
    /* 面包屑不能所有运行共用一格、按「上一次的还在 = 上一次死了」来判：脚本是并发跑的，
       几次运行的启动时刻可以只差几十毫秒，各跑几秒。那样 A 写下面包屑、B 紧跟着启动
       就会宣告 A 已死，而 A 随后正常收尾——记下来的掐断全是误报。
       所以每次运行各占一条，只有久未更新的才算掐断，收尾时也只抹自己那条。 */
    const ver = (SCRIPT.match(/var SCRIPT_VER = '([^']+)'/) || [])[1];
    const store = new Map();
    store.set('llmsubs.diagver', ver);
    // 另一个运行 50ms 前刚写下的面包屑——它还活着
    store.set('llmsubs.inflight', JSON.stringify([
      { id: 'concurrent-run', v: ver, stage: 'translating', at: Date.now() - 50, todo: 15 },
    ]));
    const { store: s2 } = await runScript({
      url: JSON_URL, body: FIX('YouTube.timedtext.json'),
      config: cfg({ probe: true }), respond: goodTranslator, store,
    });
    const dead = JSON.parse(s2.get('llmsubs.killed') || '[]');
    assertEqual(dead.length, 0, '并发运行的新鲜面包屑不是尸体，不能记成掐断');
    // 而且自己收尾时只能抹掉自己那条，不能顺手清掉别人的
    const ring = JSON.parse(s2.get('llmsubs.inflight') || '[]');
    assertEqual(ring.length, 1, '并发运行的面包屑必须留着');
    assertEqual(ring[0].id, 'concurrent-run', '留下的应当正是那个并发运行的');
  });

  await check('重复请求的节奏被记录下来（非对称预算整个押在它上面）', async () => {
    const store = new Map();
    const opts = {
      url: JSON_URL, body: FIX('YouTube.timedtext.json'),
      config: cfg({ probe: true }), respond: goodTranslator, store,
    };
    await runScript(opts);
    let recs = JSON.parse(store.get('llmsubs.diag'));
    assertEqual(recs[0].reqNo, 1, '第一次请求应当记成 reqNo=1');
    assert(recs[0].sinceLast === undefined, '第一次没有「距上次」');

    await runScript(opts);
    recs = JSON.parse(store.get('llmsubs.diag'));
    const last = recs[recs.length - 1];
    assertEqual(last.reqNo, 2, '同一条轨的第二次请求应当记成 reqNo=2');
    assert(typeof last.sinceLast === 'number' && last.sinceLast >= 0,
      '必须记下距上次请求多久——首次压到 2.8s、重复放宽到 18s 的前提就是这个节奏');
  });

  await check('漏行时把模型原话记进诊断（不然只能靠猜是合并漏还是截断）', async () => {
    const events = [];
    for (let i = 0; i < 3; i++) events.push({ tStartMs: i * 2000, dDurationMs: 1500, segs: [{ utf8: 'line number ' + i }] });
    const { store } = await runScript({
      url: JSON_URL, body: json3(events),
      config: cfg({ chunkSize: 3, concurrency: 1, probe: true }), respond: dropNth('tail'),
    });
    const r = JSON.parse(store.get('llmsubs.diag'))[0];
    assert(typeof r.mmRaw === 'string' && r.mmRaw.length > 0, '应当记下模型原话片段');
    assert(r.mmRaw.indexOf('1|') >= 0, '原话里该看得见模型实际输出的编号');
  });

  await check('诊断按版本隔离：版本一换，旧记录与计数器全部清零', async () => {
    // 诊断日志一直积累的话，不同版本的记录混在一起会误导排查（预算参数不同的
    // 版本之间耗时不可比），started-finished 差值也只有同版本内才可比。
    // 所以只保留当前版本的日志。
    const store = new Map();
    store.set('llmsubs.diagver', '0.0.0');
    store.set('llmsubs.diag', JSON.stringify([{ outcome: 'replaced', v: '0.0.0' }]));
    store.set('llmsubs.env', JSON.stringify({ stale: true }));
    store.set('llmsubs.stat.started', '50');
    store.set('llmsubs.stat.finished', '40');
    await runScript({
      url: JSON_URL, body: FIX('YouTube.timedtext.json'), store, config: cfg({ probe: true }), respond: goodTranslator,
    });
    const ver = (SCRIPT.match(/var SCRIPT_VER = '([^']+)'/) || [])[1];
    assertEqual(store.get('llmsubs.diagver'), ver, '版本标记应更新为当前版本');
    const diag = JSON.parse(store.get('llmsubs.diag'));
    assertEqual(diag.length, 1, '旧版本的记录应被清掉，只剩本次的');
    assertEqual(diag[0].v, ver, '剩下的记录属于当前版本');
    assertEqual(store.get('llmsubs.stat.started'), '1', '计数器应归零重计');
    assertEqual(store.get('llmsubs.stat.finished'), '1', '计数器应归零重计');
    assert(!(store.get('llmsubs.env') || '').includes('stale'), '旧环境快照应被重新采集');
  });

  await check('诊断缓冲是环形的，不会无限增长', async () => {
    const store = new Map();
    const body = json3([{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'ring buffer test' }] }]);
    for (let i = 0; i < 25; i++) {
      await runScript({ url: JSON_URL, body, store, config: cfg({ probe: true }), respond: goodTranslator });
    }
    const diag = JSON.parse(store.get('llmsubs.diag'));
    assertEqual(diag.length, 20, '应当只保留最近 20 条');
  });

  await check('fail-open 路径也会落诊断记录', async () => {
    const { store } = await runScript({
      url: JSON_URL, body: '', config: cfg({ probe: true }), respond: goodTranslator,
    });
    const diag = JSON.parse(store.get('llmsubs.diag'));
    assertEqual(diag.length, 1, '放行也要留记录，否则「装了没反应」查不出原因');
    assert(/^pass:/.test(diag[0].outcome), '应当记录放行原因: ' + diag[0].outcome);
  });
};
