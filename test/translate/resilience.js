'use strict';
/*
 * 兜底：任何情况都不能让用户看到黑屏或整轨作废。
 *
 *   · fail-open　任何异常都原样放行英文字幕
 *   · 超时与部分降级　预算到点渲染已完成的部分、看门狗、法定人数、宽限期
 *   · 用量上限　cue 数上限、单字符 cue；体积闸的用例在 backfill.js
 *   · 错误处理与熔断　401 / 400 / 404 / 429 各自的处置，停用与解除
 */

const { check, assert, assertEqual, section } = require('../lib/harness');
const {
  runScript, SCRIPT, FIX, BASE, cfg, JSON_URL,
  json3, goodTranslator,
} = require('../lib/sandbox');

module.exports = async function () {
  section('fail-open：任何异常都必须原样放行');

  const failOpen = [
    ['空响应体', ''],
    ['非字幕的垃圾内容', 'this is definitely not a subtitle file at all'],
    ['截断的 JSON', '{"events":[{"tStartMs":0,"segs":[{"utf8":"hi"}]'],
    ['events 不是数组', '{"wireMagic":"pb3","events":{}}'],
  ];
  for (const [name, body] of failOpen) {
    await check(name + ' → 放行', async () => {
      const { result, calls } = await runScript({ url: JSON_URL, body, config: BASE, respond: goodTranslator });
      assert(!result || !result.body, '必须原样放行');
      assertEqual(calls.length, 0, '不应发起任何 LLM 请求');
    });
  }

  await check('LLM 返回条数不符 → 整批丢弃并放行', async () => {
    const { result } = await runScript({
      url: JSON_URL, body: FIX('YouTube.timedtext.json'), config: BASE,
      respond: () => ({ status: 200, body: JSON.stringify({ choices: [{ message: { content: '1|只有一行' }, finish_reason: 'stop' }] }) }),
    });
    assert(!result || !result.body, '条数不符时必须放行而不是输出半成品');
  });

  await check('finish_reason=length（被 max_tokens 截断）→ 丢弃', async () => {
    const body = json3([{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'hello world' }] }]);
    const { result } = await runScript({
      url: JSON_URL, body, config: BASE,
      respond: () => ({ status: 200, body: JSON.stringify({ choices: [{ message: { content: '1|译文' }, finish_reason: 'length' }] }) }),
    });
    assert(!result || !result.body, '截断的输出不可信，必须丢弃');
  });

  await check('网络层报错 / 500 → 放行', async () => {
    for (const r of [{ error: 'connection refused' }, { status: 500, body: 'boom' }]) {
      const { result } = await runScript({ url: JSON_URL, body: FIX('YouTube.timedtext.json'), config: BASE, respond: () => r });
      assert(!result || !result.body, '必须放行');
    }
  });

  await check('从不 abort、未启用不发请求、tlang 与中文轨直接放行', async () => {
    const cases = [
      [JSON_URL, 'garbage', BASE],
      [JSON_URL, FIX('YouTube.timedtext.json'), cfg({ enabled: false })],
      [JSON_URL + '&tlang=zh-Hans', FIX('YouTube.timedtext.json'), BASE],
      ['https://www.youtube.com/api/timedtext?v=x&lang=zh-Hans&fmt=json3', FIX('YouTube.timedtext.json'), BASE],
      ['https://www.youtube.com/youtubei/v1/player?key=x', FIX('YouTube.timedtext.json'), BASE],
    ];
    for (const [url, body, config] of cases) {
      const { result, calls } = await runScript({ url, body, config, respond: goodTranslator });
      assert(!result || result.abort !== true, '任何路径都不得 abort 连接');
      assert(!result || !result.body, url.slice(0, 60) + ' 应当放行');
      assertEqual(calls.length, 0, url.slice(0, 60) + ' 不应发起请求');
    }
  });

  await check('【回归】URL 里的半截百分号转义不会让脚本挂死', async () => {
    // decodeURIComponent 会抛 URIError；在 async IIFE 里抛出会变成被吞掉的 rejected
    // promise，导致 $done 永远走不到，只能干等看门狗。必须毫秒级放行。
    const t0 = Date.now();
    const { result } = await runScript({
      url: 'https://www.youtube.com/api/timedtext?v=a&fmt=json3&lang=%E0%A4',
      body: FIX('YouTube.timedtext.json'), config: cfg({ budgetMs: 8000 }), respond: goodTranslator,
    });
    const elapsed = Date.now() - t0;
    assert(elapsed < 3000, '必须立即返回而不是等看门狗，实际耗时 ' + elapsed + 'ms');
    assert(result === undefined || !result.body || result.body.length > 0, '不应挂死');
  });

  section('超时与部分降级');

  await check('【回归】预算到点时渲染已完成的部分，而不是全部作废', async () => {
    // 8 批，端点每次延迟 400ms，预算 1500ms —— 只来得及做完前几批。
    const events = [];
    for (let i = 0; i < 200; i++) events.push({ tStartMs: i * 2000, dDurationMs: 1500, segs: [{ utf8: 'line number ' + i + ' here' }] });
    const { result } = await runScript({
      url: JSON_URL, body: json3(events),
      config: cfg({ chunkSize: 25, concurrency: 2, budgetMs: 1500, requestTimeout: 1 }),
      respond: (o) => Object.assign(goodTranslator(o), { delay: 400 }),
    });
    assert(result && result.body, '应当返回部分翻译的结果而不是原样放行');
    const doc = JSON.parse(result.body);
    const translated = doc.events.filter((e) => e.segs[0].utf8.includes('[zh]')).length;
    assert(translated > 0, '应当有已翻译的 cue');
    assert(translated < 200, '不应全部翻完（本用例刻意让预算不够）');
    for (const e of doc.events) {
      assert(e.segs[0].utf8.split('\n').length <= 2, '未翻译的 cue 也必须是单行英文');
    }
  });

  await check('【回归】端点卡住不响应时，看门狗必须兜底放行', async () => {
    // 端点比预算还慢 —— await 永远不返回，只有看门狗能救。
    // 这条一旦失效，用户的字幕请求会被一直挂着，直到小火箭的脚本超时（行为未文档化）。
    const t0 = Date.now();
    const { result } = await runScript({
      url: JSON_URL, body: FIX('YouTube.timedtext.json'),
      config: cfg({ chunkSize: 100, concurrency: 1, budgetMs: 1500, requestTimeout: 1 }),
      respond: (o) => Object.assign(goodTranslator(o), { delay: 9000 }),
    });
    const elapsed = Date.now() - t0;
    assert(!result || !result.body, '一条都没翻完时应当原样放行');
    assert(elapsed < 5000, '必须由看门狗在预算内兜底，实际耗时 ' + elapsed + 'ms');
  });

  await check('【回归】速度档截止：新完成批次够法定人数（70%）就立刻渲染，不等掉队者', async () => {
    // 速度档把 DEADLINE 收紧到 fastBudgetMs，但全局看门狗定在 C.budgetMs（可能大得多）；
    // worker 的准入检查只是「到点不再发新请求」，在途请求还能拖满 requestTimeout。
    // 4 批里 3 批很快、1 批卡死——截止时 3/4 ≥ 70%，应当立刻带着 3 批渲染。
    const events = [];
    for (let i = 0; i < 80; i++) events.push({ tStartMs: i * 2000, dDurationMs: 1500, segs: [{ utf8: 'deadline line ' + i + ' text' }] });
    const t0 = Date.now();
    const { result } = await runScript({
      url: JSON_URL, body: json3(events),
      config: cfg({ chunkSize: 20, concurrency: 4, budgetMs: 20000, fastBudgetMs: 800, requestTimeout: 15 }),
      respond: (o, idx) => Object.assign(goodTranslator(o), { delay: idx === 4 ? 9000 : 200 }),
    });
    const elapsed = Date.now() - t0;
    assert(elapsed < 2200, '速度档必须在 800ms 截止附近返回，实际耗时 ' + elapsed + 'ms');
    assert(result && result.body, '截止时已有足额译文，应当渲染部分结果而不是放行');
    const doc = JSON.parse(result.body);
    const translated = doc.events.filter((e) => e.segs[0].utf8.includes('[zh]')).length;
    assertEqual(translated, 60, '应当恰好渲染出完成的那 3 批');
  });

  await check('【回归】截止时不足法定人数 → 宽限期兜住掉队少数，而不是空手等到看门狗', async () => {
    // 2 批里只有 1 批在截止后不久返回、另一批卡死——宽限期到点应带着那 1 批渲染。
    const events = [];
    for (let i = 0; i < 60; i++) events.push({ tStartMs: i * 2000, dDurationMs: 1500, segs: [{ utf8: 'grace line ' + i + ' text' }] });
    const t0 = Date.now();
    const { result } = await runScript({
      url: JSON_URL, body: json3(events),
      config: cfg({ chunkSize: 30, concurrency: 2, budgetMs: 20000, fastBudgetMs: 800, requestTimeout: 15 }),
      // 第一批 1200ms（过截止但在宽限期内），第二批卡死
      respond: (o, idx) => Object.assign(goodTranslator(o), { delay: idx === 1 ? 1200 : 9000 }),
    });
    const elapsed = Date.now() - t0;
    // 宽限期常数从源码读，不写死：常数一调，写死的时间断言就会误报，
    // 而机制本身并没有坏。
    const grace = +(SCRIPT.match(/var FAST_GRACE_MS = (\d+)/) || [])[1];
    assert(grace > 0, '应当能从源码读到 FAST_GRACE_MS');
    // 渲染时机 = 截止(800) + 宽限；掉队批次在 1200ms 落地，必须早于它才考得住机制
    assert(800 + grace > 1200, '宽限期太短，掉队批次赶不上，这个用例就失去意义了');
    const want = 800 + grace;
    assert(elapsed >= want - 300 && elapsed < want + 1800,
      '应当在截止(800)+宽限(' + grace + ')=' + want + 'ms 前后渲染，实际耗时 ' + elapsed + 'ms');
    const doc = JSON.parse(result.body);
    const translated = doc.events.filter((e) => e.segs[0].utf8.includes('[zh]')).length;
    assertEqual(translated, 30, '应当渲染出宽限期内落地的那一批');
  });

  await check('【回归】成簇返回的批次一个都不能掐：全部略慢于截止时，整轮必须完整落地', async () => {
    // 场景：单批耗时略长于截止（这里截止 800ms、每批 1200ms），10 个并发批次在截止线后
    // 几百毫秒内成簇返回。若「第一批完成就立刻渲染」，其余 9 批会被掐掉，
    // 每轮只能推进 1 批。正确行为：批次自然结算（都在 requestTimeout 内），
    // 整轮 10 批全部落地。
    const events = [];
    for (let i = 0; i < 200; i++) events.push({ tStartMs: i * 2000, dDurationMs: 1500, segs: [{ utf8: 'cluster line ' + i + ' text' }] });
    const t0 = Date.now();
    const { result } = await runScript({
      url: JSON_URL, body: json3(events),
      config: cfg({ chunkSize: 20, concurrency: 16, budgetMs: 8000, fastBudgetMs: 800, requestTimeout: 6 }),
      respond: (o) => Object.assign(goodTranslator(o), { delay: 1200 }),
    });
    const elapsed = Date.now() - t0;
    const doc = JSON.parse(result.body);
    const translated = doc.events.filter((e) => e.segs[0].utf8.includes('[zh]')).length;
    assertEqual(translated, 200, '成簇返回的 10 批必须全部渲染，一批都不能被提前 $done 掐掉');
    assert(elapsed < 2500, '批次结算后应立即返回，实际 ' + elapsed + 'ms');
  });

  await check('【回归】速度档截止时一条译文都没有 → 不放弃，等在途请求 / 看门狗', async () => {
    // 反面场景：端点单次往返比速度档预算慢。截止时若直接 passThrough，
    // $done 之后引擎拆上下文、在途回调不再执行、cachePut 永远不发生，
    // 而 headReady 只看缓存——慢端点会被永久锁死在「速度档→空手放行→缓存为空」。
    // 正确行为：截止时什么都不做，在途请求返回后照常渲染（或由看门狗兜底）。
    const events = [];
    for (let i = 0; i < 30; i++) events.push({ tStartMs: i * 2000, dDurationMs: 1500, segs: [{ utf8: 'slow endpoint line ' + i }] });
    const t0 = Date.now();
    const { result } = await runScript({
      url: JSON_URL, body: json3(events),
      // fastBudgetMs 必须大于准入检查的冷启动预留（600ms），否则一条请求都发不出去
      config: cfg({ chunkSize: 30, concurrency: 1, budgetMs: 6000, fastBudgetMs: 1000, requestTimeout: 5 }),
      respond: (o) => Object.assign(goodTranslator(o), { delay: 1500 }),
    });
    const elapsed = Date.now() - t0;
    assert(result && result.body, '在途请求返回后应当照常渲染，而不是截止时空手放行');
    const doc = JSON.parse(result.body);
    const translated = doc.events.filter((e) => e.segs[0].utf8.includes('[zh]')).length;
    assert(translated === 30, '唯一一批应当被完整渲染，实际 ' + translated);
    assert(elapsed >= 1400 && elapsed < 5000, '应当在在途请求返回（~1.5s）后立即返回，实际 ' + elapsed + 'ms');
  });

  await check('【回归】速度档截止不得拿缓存预填空转渲染——多轮之间缓存必须单调增长', async () => {
    // 活锁场景：缓存里已有一部分（translations 被预填非空）+ 本轮在途批次比
    // fastBudgetMs 慢。若截止定时器只看「translations 有没有东西」，每一轮都会
    // 到点拿旧缓存渲染并 $done、掐死在途请求，缓存永远长不大、永远停在速度档。
    // 正确行为：截止渲染只认「本轮新完成的批次」；没有就等第一批新完成立刻渲染。
    const store = new Map();
    const events = [];
    for (let i = 0; i < 40; i++) events.push({ tStartMs: i * 2000, dDurationMs: 1500, segs: [{ utf8: 'monotonic line ' + i + ' text' }] });
    // backfill: false —— 这条不变量是「没有后台补翻」时的规则。
    // 有补翻时宽限期到点会用缓存交回、在途批次交给 cron，缓存靠 cron 单调增长（见本用例末尾）。
    const CFG = cfg({ cache: true, chunkSize: 20, concurrency: 2, budgetMs: 6000, fastBudgetMs: 800, requestTimeout: 5, backfill: false });

    // 第 1 轮：第一批成功、第二批 500 失败 → 缓存里只有半截
    const r1 = await runScript({
      url: JSON_URL, body: json3(events), store, config: CFG,
      respond: (o, idx) => idx === 1 ? goodTranslator(o) : { status: 500, body: 'oops' },
    });
    assert(r1.result && r1.result.body, '第 1 轮应当渲染出成功的那一批');

    // 第 2 轮：剩下那批比速度档截止（800ms）慢。到点时不得拿第 1 轮的缓存空转渲染，
    // 必须等它完成（~1.5s）后带着全部译文返回。
    const t0 = Date.now();
    const r2 = await runScript({
      url: JSON_URL, body: json3(events), store, config: CFG,
      respond: (o) => Object.assign(goodTranslator(o), { delay: 1500 }),
    });
    const elapsed2 = Date.now() - t0;
    assert(elapsed2 >= 1400, '截止时没有新完成的批次就必须继续等，实际 ' + elapsed2 + 'ms 就返回了（拿缓存空转渲染）');
    const done2 = JSON.parse(r2.result.body).events.filter((e) => e.segs[0].utf8.includes('[zh]')).length;
    assertEqual(done2, 40, '第 2 轮应当是缓存 + 新批次的全量双语');
    assertEqual(JSON.parse(store.get('llmsubs.cache.idx')).length, 2, '缓存必须长到 2 批（单调增长）');

    // 第 3 轮：开头已就绪 → 质量档，几乎全走缓存，秒回
    const t1 = Date.now();
    const r3 = await runScript({
      url: JSON_URL, body: json3(events), store, config: CFG,
      respond: (o) => Object.assign(goodTranslator(o), { delay: 30 }),
    });
    const elapsed3 = Date.now() - t1;
    const done3 = JSON.parse(r3.result.body).events.filter((e) => e.segs[0].utf8.includes('[zh]')).length;
    assertEqual(done3, 40, '第 3 轮仍是全量双语');
    assert(elapsed3 < 1300, '第 3 轮应当基本走缓存秒回，实际 ' + elapsed3 + 'ms');

    // 有补翻时：同样的半截缓存 + 慢端点，第 2 轮宽限期到点就用缓存交回，
    // 在途那批进待翻队列；cron 补完之后第 3 轮全量命中——缓存仍然单调增长，只是靠 cron。
    const s2 = new Map();
    const CFG2 = cfg({ cache: true, chunkSize: 20, concurrency: 2, budgetMs: 6000, fastBudgetMs: 800, requestTimeout: 5 });
    await runScript({ url: JSON_URL, body: json3(events), store: s2, config: CFG2,
      respond: (o, idx) => idx === 1 ? goodTranslator(o) : { status: 500, body: 'oops' } });
    s2.set('llmsubs.cron.n', '1'); s2.set('llmsubs.cron.last', String(Date.now()));   // cron 在跑
    const t2 = Date.now();
    const b2 = await runScript({ url: JSON_URL, body: json3(events), store: s2, config: CFG2,
      respond: (o) => Object.assign(goodTranslator(o), { delay: 5000 }) });
    const el2 = Date.now() - t2;
    assert(el2 < 2500, '有补翻时宽限期到点就用缓存交回，实际 ' + el2 + 'ms');
    assertEqual(JSON.parse(b2.result.body).events.filter((e) => e.segs[0].utf8.includes('[zh]')).length, 20, '交回的是缓存那一半');
    assert([...s2.keys()].some((k) => k.startsWith('llmsubs.bf.') && s2.get(k)), '在途那批进了待翻队列');
    await runScript({ noRequest: true, noResponse: true, store: s2, config: CFG2, respond: goodTranslator });
    assertEqual(JSON.parse(s2.get('llmsubs.cache.idx')).length, 2, 'cron 补完，缓存长到 2 批');
    const b3 = await runScript({ url: JSON_URL, body: json3(events), store: s2, config: CFG2, respond: goodTranslator });
    assertEqual(b3.calls.length, 0, '第 3 轮全量命中');
    assertEqual(JSON.parse(b3.result.body).events.filter((e) => e.segs[0].utf8.includes('[zh]')).length, 40);
  });

  await check('【回归】requestTimeout 放不进预算时自动收紧，而不是静默什么都不做', async () => {
    // 这两个值互相矛盾（单请求 5s > 总预算 1.2s）。准入检查若据此判定「注定赶不上」
    // 而一条都不发，用户看到的就是「装好了但完全没反应」，日志里也没有线索。
    let sent = 0;
    const { logs } = await runScript({
      url: JSON_URL, body: FIX('asr.zh.json'),
      config: cfg({ chunkSize: 25, concurrency: 2, budgetMs: 1200, requestTimeout: 5 }),
      respond: (o) => { sent++; return Object.assign(goodTranslator(o), { delay: 200 }); },
    });
    assert(sent > 0, '应当收紧超时后照常工作，而不是一条都不发');
    assert(logs.some((l) => l.includes('收紧')), '必须在日志里说明超时被收紧了');
  });

  await check('临近截止时间不再发新批次', async () => {
    // 第一波能跑完，第二波算上请求耗时就越线了，应当直接停手而不是硬发出去白烧额度
    const events = [];
    for (let i = 0; i < 200; i++) events.push({ tStartMs: i * 2000, dDurationMs: 1500, segs: [{ utf8: 'line number ' + i }] });
    let sent = 0;
    await runScript({
      url: JSON_URL, body: json3(events),
      config: cfg({ chunkSize: 25, concurrency: 1, budgetMs: 3000, requestTimeout: 2 }),
      respond: (o) => { sent++; return Object.assign(goodTranslator(o), { delay: 1200 }); },
    });
    assert(sent >= 1, '第一批应当发出');
    assert(sent < 8, '不该把 8 批全发完，实际发了 ' + sent);
  });

  section('用量上限');

  await check('cue 数超过上限时只翻前 6000 条，而不是整个视频放弃', async () => {
    // 超一条就整个放行的话，那是悬崖不是上限：多一条 cue，整个视频就一句中文都没有。
    // 所以超过上限时截断而不是放弃，超出的部分保持英文（截断发生在排队之前，后台补翻也补不到）。
    // 上限取 6000，大约是三个半小时的内容，两三个小时的长视频也能整条覆盖。
    const events = [];
    for (let i = 0; i < 6200; i++) events.push({ tStartMs: i * 100, dDurationMs: 90, segs: [{ utf8: 'ab' }] });
    const { result, calls } = await runScript({
      url: JSON_URL, body: json3(events),
      config: cfg({ budgetMs: 25000, concurrency: 8 }), respond: goodTranslator,
    });
    assert(calls.length > 0, '不该整个放弃，应当发起翻译请求');
    assert(result && result.body, '应当改写响应');
    const doc = JSON.parse(result.body);
    assertEqual(doc.events.length, 6200, '渲染必须覆盖全部 cue，时间轴一条都不能少');
    const zh = doc.events.map((e) => e.segs.map((s) => s.utf8).join('').includes('[zh]'));
    assert(zh.slice(0, 6000).some(Boolean), '前 6000 条里应当有译文');
    assert(!zh.slice(6000).some(Boolean), '第 6000 条之后一律保持英文，绝不能排进翻译队列');
  });

  await check('【回归】一两千条 cue 的正常长视频不会被整个放弃', async () => {
    // 一两千条 cue 是正常长视频 ASR 轨的量级，不能当成畸形输入挡掉。
    const events = [];
    for (let i = 0; i < 1748; i++) events.push({ tStartMs: i * 2000, dDurationMs: 1500, segs: [{ utf8: 'long video line ' + i }] });
    const { result } = await runScript({ url: JSON_URL, body: json3(events), config: BASE, respond: goodTranslator });
    assert(result && result.body, '一两千条 cue 应当正常进入翻译流程');
  });

  await check('【回归】单字符 cue 被跳过，不构成放大入口', async () => {
    const events = [];
    for (let i = 0; i < 500; i++) events.push({ tStartMs: i * 100, dDurationMs: 90, segs: [{ utf8: 'a' }] });
    const { result, calls } = await runScript({ url: JSON_URL, body: json3(events), config: BASE, respond: goodTranslator });
    assertEqual(calls.length, 0, '长度 < 2 的 cue 应全部跳过');
    assert(!result || !result.body, '没有可翻译内容应当放行');
  });

  section('错误处理与熔断');

  await check('401 → 放行、通知、写入 hardStop（且不含 key）', async () => {
    const { result, notifications, store } = await runScript({
      url: JSON_URL, body: FIX('YouTube.timedtext.json'), config: BASE,
      respond: () => ({ status: 401, body: 'unauthorized' }),
    });
    assert(!result || !result.body, '必须放行');
    assert(notifications.length >= 1, '应当通知用户');
    const cb = JSON.parse(store.get('llmsubs.cb') || '{}');
    assertEqual(cb.hardStop, true, '应当写入 hardStop');
    for (const [k, v] of store) assert(!String(v).includes('sk-test'), '持久化存储里不得出现 key: ' + k);
    for (const n of notifications) assert(!JSON.stringify(n).includes('sk-test'), '通知里不得出现 key');
  });

  await check('【回归】400/404 停用并把端点原话写进日志', async () => {
    const { logs, store } = await runScript({
      url: JSON_URL, body: FIX('YouTube.timedtext.json'), config: BASE,
      respond: () => ({ status: 404, body: '{"error":{"message":"model not found: test-model"}}' }),
    });
    assert(logs.some((l) => l.includes('model not found')), '首次使用最常见的失败是配置错，必须把端点原话打出来');
    assertEqual(JSON.parse(store.get('llmsubs.cb') || '{}').hardStop, true, '重试没有意义，应直接停用');
  });

  await check('【回归】先成功过再收 400 → 只丢这批，绝不停用整个模块', async () => {
    // 同一份配置已经成功过、之后某一批收到 400（多半是这一批被内容安全过滤拒了），
    // 不该停用整个模块，否则用户只能靠改配置恢复。模型名写错的话第一次就会 400，
    // 不可能先成功——所以「此前成功过」是区分两种 400 的可靠判据。
    const events = [];
    for (let i = 0; i < 40; i++) events.push({ tStartMs: i * 2000, dDurationMs: 1500, segs: [{ utf8: 'line number ' + i }] });
    let n = 0;
    const { result, store } = await runScript({
      // fastConcurrency 给到 2，让两批在同一波里发出去。速度档默认只发一波，只有一个 worker
      // 顺序取的话，第二批会被拦掉 —— 这条用例要的是「先成功过、再收 400」，
      // 不该依赖波次来凑出第二批。
      url: JSON_URL, body: json3(events), config: cfg({ chunkSize: 20, concurrency: 1, fastConcurrency: 2 }),
      respond: (o) => (++n === 1 ? goodTranslator(o)
        : { status: 400, body: '{"code":"data_inspection_failed","message":"content rejected"}' }),
    });
    const cb = JSON.parse(store.get('llmsubs.cb') || '{}');
    assert(cb.hardStop !== true, '此前成功过，这个 400 就不该停用整个模块');
    assert(result && result.body, '先成功的那批译文仍应照常渲染');
    const done = JSON.parse(result.body).events.filter((e) => e.segs[0].utf8.includes('\n')).length;
    assert(done > 0, '第一批已经译好的内容不该被这个 400 连累');
  });

  await check('【回归】404 不走「成功过就丢这批」的旁路，模型下线必须停用', async () => {
    // 404 是「路径 / 模型不存在」，不可能是「这一批被拒」。模型下线后若也旁路掉，
    // 症状就是字幕一直是英文、没有任何提示。
    const events = [];
    for (let i = 0; i < 40; i++) events.push({ tStartMs: i * 2000, dDurationMs: 1500, segs: [{ utf8: 'line number ' + i }] });
    let n = 0;
    const { store } = await runScript({
      // 同上：两批一波发完，别靠第二波凑出「此前成功过」这个前提
      url: JSON_URL, body: json3(events), config: cfg({ chunkSize: 20, concurrency: 1, fastConcurrency: 2 }),
      respond: (o) => (++n === 1 ? goodTranslator(o)
        : { status: 404, body: '{"code":"model_not_found","message":"gone"}' }),
    });
    assertEqual(JSON.parse(store.get('llmsubs.cb') || '{}').hardStop, true,
      '即使此前成功过，404 也必须停用并提示用户');
  });

  await check('【回归】只改 temperature 这类同样进请求体的字段后收 400，不能被静默吞掉', async () => {
    // 配置指纹不能只含 baseUrl / apiKey / model：temperature / extraBody /
    // systemPrompt / userPrefix 同样进请求体、写错同样会 400（例如智谱的 temperature
    // 取开区间 (0,1)，收到 0 直接 400）。指纹漏掉它们，旧的 okFp 就仍然命中，
    // 配置错导致的 400 会被当成内容过滤丢掉——不停用、不通知。
    const store = new Map();
    await runScript({
      url: JSON_URL, body: FIX('YouTube.timedtext.json'),
      config: cfg({ temperature: 0.3 }), respond: goodTranslator, store,
    });
    assert(JSON.parse(store.get('llmsubs.cb') || '{}').okFp, '第一轮成功后应当记下 okFp');
    // 只改 temperature，baseUrl / key / model 一字未动
    const { store: s2, notifications } = await runScript({
      url: JSON_URL, body: FIX('YouTube.timedtext.json'),
      config: cfg({ temperature: 0 }), respond: () => ({ status: 400, body: '{"code":"InvalidParameter"}' }), store,
    });
    assertEqual(JSON.parse(s2.get('llmsubs.cb') || '{}').hardStop, true,
      'temperature 进了指纹，换值后 okFp 就不该再命中，必须停用');
    assert(notifications.length > 0, '必须弹通知，否则用户对着「没反应」查不出原因');
  });

  await check('从未成功过就收 400 → 仍然停用（这才是配置写错）', async () => {
    const { store } = await runScript({
      url: JSON_URL, body: FIX('YouTube.timedtext.json'), config: BASE,
      respond: () => ({ status: 400, body: '{"code":"model_not_found","message":"no such model"}' }),
    });
    const cb = JSON.parse(store.get('llmsubs.cb') || '{}');
    assertEqual(cb.hardStop, true, '一次都没成功过的 400 就是配置错，必须停下来告诉用户');
    assertEqual(cb.code, 'model_not_found', '应当记下端点给的错误代号，否则诊断里只有「请求被拒 400」五个字');
  });

  await check('停用记录只存错误代号，绝不存 message（它可能回显字幕正文）', async () => {
    const secret = 'Annie was born in Chicago and her number is 555';
    const { store } = await runScript({
      url: JSON_URL, body: FIX('YouTube.timedtext.json'), config: BASE,
      respond: () => ({ status: 400, body: JSON.stringify({ code: 'InvalidParameter', message: 'rejected input: ' + secret }) }),
    });
    const raw = store.get('llmsubs.cb') || '';
    assertEqual(JSON.parse(raw).code, 'InvalidParameter', '代号该记下来');
    assert(!raw.includes('Annie'), '错误体里的 message 可能回显字幕正文，绝不能落进要外发的诊断');
    assert(!raw.includes('555'), '同上');
  });

  await check('【回归】改了配置就自动解除停用，不用手动 resetState', async () => {
    const store = new Map();
    await runScript({
      url: JSON_URL, body: FIX('YouTube.timedtext.json'), config: BASE,
      respond: () => ({ status: 401, body: 'nope' }), store,
    });
    assertEqual(JSON.parse(store.get('llmsubs.cb')).hardStop, true, '先进入停用状态');
    // 换一个 key 再跑：应当自动恢复并正常翻译
    const { result, calls } = await runScript({
      url: JSON_URL, body: FIX('YouTube.timedtext.json'),
      config: cfg({ apiKey: 'sk-test-CORRECTEDKEY99' }), respond: goodTranslator, store,
    });
    assert(calls.length > 0, '换配置后应当自动恢复并发出请求');
    assert(result && result.body, '应当正常翻译');
  });

  await check('【回归】429 退避重试一次，且不计入熔断', async () => {
    const body = json3([{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'hello world' }] }]);
    let n = 0;
    const store = new Map();
    const { result, calls } = await runScript({
      url: JSON_URL, body, config: BASE, store,
      respond: (o) => { n++; return n === 1 ? { status: 429, body: 'slow down' } : goodTranslator(o); },
    });
    assertEqual(calls.length, 2, '429 应当退避重试一次');
    assert(result && result.body, '重试成功后应当正常输出');
    const cb = JSON.parse(store.get('llmsubs.cb') || '{}');
    assert(!cb.fails, '临时限流不应计入熔断，实际 fails=' + cb.fails);
  });
};
