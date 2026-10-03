'use strict';
/*
 * 发请求之前的准备：读哪份配置、要不要先查缓存、切成几批、请求体长什么样。
 *
 *   · 请求体与并发　字段白名单、跨批上下文只在质量档带、并发受配置约束
 *   · 缓存　命中不再请求、键与内容不含视频 ID；缓存索引落盘与 LRU 淘汰在 waves.js 的「首波与缓存」一节
 *   · 配置　只认新格式的存储；末条「$argument 仍被探针记录」与 probes.js 的用例同族
 *   · 按字符切批　单批耗时看字符数不看条数
 */

const { check, assert, assertEqual, section } = require('../lib/harness');
const {
  runScript, FIX, BASE, cfg, JSON_URL, M_JSON_URL,
  json3, readSubs, goodTranslator,
} = require('../lib/sandbox');

module.exports = async function () {
  section('请求体与并发');

  await check('只使用字段白名单，temperature 为 0', async () => {
    const { calls } = await runScript({ url: JSON_URL, body: FIX('YouTube.timedtext.json'), config: BASE, respond: goodTranslator });
    const allowed = new Set(['model', 'temperature', 'max_tokens', 'stream', 'messages',
      'thinking',              // extraBody 白名单里的（DeepSeek 关思考）
      'translation_options']); // noSystem 模式下脚本自己加的目标语言
    for (const c of calls) {
      const p = JSON.parse(c.body);
      for (const k of Object.keys(p)) assert(allowed.has(k), '出现了白名单外的字段: ' + k);
      assertEqual(p.temperature, 0, 'temperature 必须为 0');
      assertEqual(p.stream, false, '不应使用流式');
      assert(p.max_tokens > 0 && p.max_tokens <= 4096, 'max_tokens 必须有上限');
      assert(!('tools' in p) && !('functions' in p), '不得声明工具');
      assert(!p.messages[0].content.includes('sk-test'), 'system 里不得出现 key');
    }
  });

  await check('质量档才带跨批上下文，速度档为了抢首屏不带', async () => {
    const events = [];
    for (let i = 0; i < 200; i++) events.push({ tStartMs: i * 2000, dDurationMs: 1500, segs: [{ utf8: 'sentence number ' + i }] });
    const body = json3(events);
    const store = new Map();
    // 首波只放 3 批、端点 600ms 才回：速度档一波就到准入线，给第二轮留下要翻的批
    // （升级通道默认关，第二轮若 todo 为 0 就一个请求都不发，用例会空跑）
    const cfg1 = cfg({ chunkSize: 25, fastConcurrency: 3, concurrency: 8, cache: true, fastBudgetMs: 1000 });

    // 第一轮：全新，走速度档——只翻开头，且不带上下文
    const fast = [];
    await runScript({
      url: JSON_URL, body, store, config: cfg1,
      respond: (o) => { fast.push((JSON.parse(o.body).messages[1].content.match(/<<<CONTEXT/g) || []).length); return Object.assign(goodTranslator(o), { delay: 600 }); },
    });
    assert(fast.length > 0, '速度档应当有请求');
    assert(fast.every((n) => n === 0), '速度档不该带上下文，那是为了抢首屏');

    // 第二轮：刚刚请求过、且是会等的客户端（m 域），走质量档——这时才带上下文
    const slow = [];
    await runScript({
      url: M_JSON_URL, body, store, config: cfg1,
      respond: (o) => { slow.push((JSON.parse(o.body).messages[1].content.match(/<<<CONTEXT/g) || []).length); return goodTranslator(o); },
    });
    assert(slow.length > 0, '质量档应当继续翻后面的');
    assert(slow.some((n) => n === 1), '质量档的批次应当带上下文块');
  });

  await check('并发数受配置约束', async () => {
    let inFlight = 0, peak = 0;
    await runScript({
      url: JSON_URL, body: FIX('asr.zh.json'),
      config: cfg({ chunkSize: 10, concurrency: 3, budgetMs: 15000 }),
      respond: (o) => { inFlight++; peak = Math.max(peak, inFlight); inFlight--; return goodTranslator(o); },
    });
    assert(peak <= 3, '并发不得超过配置值，实际峰值 ' + peak);
  });

  section('缓存');

  await check('缓存命中后不再请求 LLM', async () => {
    const body = json3([{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'cache me please' }] }]);
    const store = new Map();
    const conf = cfg({ cache: true });
    // 三阶段：速度档翻 → 质量档补齐并升级 → 之后纯缓存
    const first = await runScript({ url: JSON_URL, body, config: conf, respond: goodTranslator, store });
    assertEqual(first.calls.length, 1, '第一次（速度档）应当请求 LLM');
    await runScript({ url: M_JSON_URL, body, config: conf, respond: goodTranslator, store });   // 质量档（m 域才会进；升级通道默认关，这轮不发请求）
    const third = await runScript({ url: JSON_URL, body, config: conf, respond: goodTranslator, store });
    assertEqual(third.calls.length, 0, '升级完之后应当彻底走缓存，一个请求都不发');
    assert(third.result && third.result.body, '缓存命中也要正常输出');
  });

  await check('【回归】含被丢弃条目的批次，缓存仍然可命中', async () => {
    // 空串是「这条当时就被丢弃」的哨兵，不是损坏记录。把它当成损坏的话，
    // 一批里只要有一条译文被丢，整批就永远命中不了缓存，每次重播都重新付费。
    const body = json3([
      { tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'short text' }] },
      { tStartMs: 2000, dDurationMs: 1000, segs: [{ utf8: 'also short text' }] },
    ]);
    const store = new Map();
    const bad = () => ({ status: 200, body: JSON.stringify({ choices: [{ message: { content: '1|' + '啦'.repeat(5000) + '\n2|正常译文' }, finish_reason: 'stop' }] }) });
    const conf2 = cfg({ cache: true });
    const first = await runScript({ url: JSON_URL, body, config: conf2, respond: bad, store });
    assertEqual(first.calls.length, 1, '第一次应当请求');
    await runScript({ url: M_JSON_URL, body, config: conf2, respond: bad, store });   // 质量档（m 域才会进；升级通道默认关，这轮不发请求）
    const second = await runScript({ url: JSON_URL, body, config: conf2, respond: bad, store });
    assertEqual(second.calls.length, 0, '升级完之后应当命中缓存，不该重新付费');
    const doc = JSON.parse(second.result.body);
    assertEqual(doc.events[0].segs[0].utf8, 'short text', '被丢弃的那条仍保持英文');
    assert(doc.events[1].segs[0].utf8.includes('正常译文'), '有效译文应当从缓存恢复');
  });

  await check('缓存 key 与内容都不含视频 ID / URL / key', async () => {
    const body = json3([{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'privacy check line' }] }]);
    const { store } = await runScript({ url: JSON_URL, body, config: cfg({ cache: true }), respond: goodTranslator });
    const keys = [...store.keys()];
    assert(keys.some((k) => k.startsWith('llmsubs.c.')), '应当写入缓存条目');
    for (const k of keys) assert(!k.includes('abc123'), '缓存 key 不得含视频 ID');
    for (const [k, v] of store) {
      assert(!String(v).includes('sk-test'), '缓存里不得出现 key');
      assert(!String(v).includes('youtube.com'), '缓存里不得出现 URL');
      assert(!String(v).includes('abc123'), '缓存里不得出现视频 ID');
    }
  });

  section('配置：只认新格式的存储，旧格式与模块参数都覆盖不了');

  await check('【回归】旧格式 llmsubs.config（整份对象）改不动脚本', async () => {
    // 配置只认带版本号的存储：llmsubs.cfg4 = {v:4, d:{只有改过的键}}（v3 的 llmsubs.cfg 只读迁移），白名单制。
    // 旧格式 llmsubs.config 是一整份对象、非空覆盖一切：里面残留的值会悄悄盖掉出厂值
    // （把功能关掉、把端点换掉），所以整份忽略。
    const store = new Map();
    store.set('llmsubs.config', JSON.stringify({ enabled: false, baseUrl: 'https://hijack.example.com/v1', model: 'hijacked' }));
    const body = json3([{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'hello world here' }] }]);
    const { calls } = await runScript({ url: JSON_URL, body, config: BASE, store, respond: goodTranslator });
    assert(calls.length > 0, '存储里的 enabled:false 不该关掉功能');
    assertEqual(calls[0].url, 'https://api.example.com/v1/chat/completions', '端点必须来自 DEFAULTS');
    assertEqual(JSON.parse(calls[0].body).model, 'test-model', '模型必须来自 DEFAULTS');
  });

  await check('【回归】模块参数（$argument）也改不动脚本', async () => {
    const body = json3([{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'hello world here' }] }]);
    const { calls } = await runScript({
      url: JSON_URL, body, config: BASE, respond: goodTranslator,
      argument: 'enabled=false&baseUrl=https%3A%2F%2Fhijack.example.com%2Fv1&model=hijacked',
    });
    assert(calls.length > 0, '模块参数里的 enabled=false 不该关掉功能');
    assertEqual(calls[0].url, 'https://api.example.com/v1/chat/completions', '端点必须来自 DEFAULTS');
  });

  await check('$argument 仍被探针记录（记下它在运行环境里能不能读到）', async () => {
    const { store } = await runScript({
      url: JSON_URL, body: FIX('YouTube.timedtext.json'), config: cfg({ probe: true }),
      respond: goodTranslator, argument: 'anything=1',
    });
    const env = JSON.parse(store.get('llmsubs.env'));
    assertEqual(env.argument, 'string', '应当记下 typeof $argument');
    assertEqual(env.argumentSeen, true, '应当记下能不能真的解析出内容');
  });

  section('按字符切批：单批耗时看字符数，不看条数');

  // 长 cue 的轨：每条约 130 字符时，按 20 条切一批就有约 2700 字符，单批耗时会超过 App 愿意等的时间。
  const longCue = 'this is a fairly long caption line that a real talk video produces all the time ok';
  const shortCue = 'short line here';

  await check('【回归】长 cue 轨按字符切小批，单批字符数不超过 chunkChars', async () => {
    const events = [];
    for (let i = 0; i < 60; i++) events.push({ tStartMs: i * 2000, dDurationMs: 1500, segs: [{ utf8: longCue + ' ' + i }] });
    const seen = [];
    await runScript({
      url: JSON_URL, body: json3(events),
      config: cfg({ chunkSize: 20, chunkChars: 600, budgetMs: 20000 }),
      respond: (o) => { seen.push(readSubs(o).join('\n').length); return goodTranslator(o); },
    });
    assert(seen.length > 3, '600 字符上限下，60 条长 cue 应被切成很多批，实际 ' + seen.length + ' 批');
    for (const n of seen) assert(n <= 700, '单批字符数应受 chunkChars 约束，实际 ' + n);
  });

  await check('短 cue 轨仍按条数切，不会被字符上限切碎', async () => {
    const events = [];
    for (let i = 0; i < 40; i++) events.push({ tStartMs: i * 2000, dDurationMs: 1500, segs: [{ utf8: shortCue }] });
    const seen = [];
    await runScript({
      url: JSON_URL, body: json3(events),
      config: cfg({ chunkSize: 20, chunkChars: 1100, budgetMs: 20000 }),
      respond: (o) => { seen.push(readSubs(o).length); return goodTranslator(o); },
    });
    assertEqual(seen.length, 2, '40 条短 cue 应当正好 2 批（每批 20 条）');
    for (const n of seen) assertEqual(n, 20, '每批应当装满 chunkSize');
  });

  await check('单条就超过 chunkChars 时自成一批，绝不丢条也不死循环', async () => {
    const huge = 'x'.repeat(900) + ' end';
    const events = [
      { tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: huge }] },
      { tStartMs: 1000, dDurationMs: 1000, segs: [{ utf8: shortCue }] },
    ];
    const { result } = await runScript({
      url: JSON_URL, body: json3(events),
      config: cfg({ chunkSize: 20, chunkChars: 300, budgetMs: 20000 }), respond: goodTranslator,
    });
    const doc = JSON.parse(result.body);
    assertEqual(doc.events.length, 2, '两条 cue 都要在');
    for (const e of doc.events) assert(e.segs[0].utf8.includes('[zh]'), '两条都应被翻译');
  });

  await check('批次边界稳定：同样的输入两次切出同样的批（缓存的前提）', async () => {
    // 边界只依赖正文本身，不依赖运行时状态。不稳的话缓存键全部落空，
    // 每次重播都要重新付费翻译一遍。
    const store = new Map();
    const events = [];
    for (let i = 0; i < 50; i++) {
      events.push({ tStartMs: i * 2000, dDurationMs: 1500, segs: [{ utf8: (i % 3 ? longCue : shortCue) + ' ' + i }] });
    }
    // upgrade 显式打开：这条用例靠第二轮的重翻请求来比对批边界（升级通道默认关）
    const CFG = cfg({ cache: true, chunkSize: 20, chunkChars: 500, budgetMs: 20000, upgrade: true });
    const shapes = (r) => r.calls.map((o) => readSubs(o).join('|')).sort();
    const first = await runScript({ url: M_JSON_URL, body: json3(events), store, config: CFG, respond: goodTranslator });
    // 第二轮刚刚请求过且是 m 域 → 质量档，会把速度档的粗译升级重翻一遍（设计如此），
    // 所以它照样会发请求；要验的是发出去的批内容一模一样。
    const second = await runScript({ url: M_JSON_URL, body: json3(events), store, config: CFG, respond: goodTranslator });
    assert(first.calls.length > 1, '第一轮应当切出多批');
    assertEqual(JSON.stringify(shapes(second)), JSON.stringify(shapes(first)), '两轮的批次边界必须完全一致');
  });
};
