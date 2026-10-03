'use strict';
/*
 * 后台补翻（cron 角色）：前台没翻完的批进待翻队列，cron 每分钟醒来清队列、写缓存。
 *
 *   · 「后台补翻（cron 角色）」　队列、cron 角色、思考开关、让路、就地重试、熔断、版本闸、存活计数、批次数上限
 *   · 「体积闸」　三条体积闸放这里是因为撞闸的轨连待翻队列都进不去；
 *     同一节里还有四条：seen 计数按轨（档位路由）、速度档 429 不空睡、postdone 弹通知（探针）、诊断时间字段
 *   · 「宽限期」　有补翻时宽限期到点用缓存交回
 */

const fs = require('fs');
const path = require('path');

const { check, assert, assertEqual, section } = require('../lib/harness');
const {
  runScript, SCRIPT, ROOT, FIX, cfg, JSON_URL,
  M_JSON_URL, XML_URL, json3, readSubs, goodTranslator,
} = require('../lib/sandbox');

module.exports = async function () {
  section('后台补翻（cron 角色）：队列、思考开关、让路、就地重试、熔断、版本闸、存活计数');

  // 三批 × 20 条、短句：第一批成功，其余批「尾号缺失」（合并漏：整批丢、拆半重试照样漏，且不计熔断）
  // → 收尾时它们没进缓存。不用「端点回垃圾」：那是硬失败，连续 4 次会触发熔断，把后面的用例一起带偏。
  const BF_URL = 'https://www.youtube.com/api/timedtext?v=abc123&lang=en&fmt=json3&caps=asr&kind=asr';
  function bfEvents(n) {
    const events = [];
    for (let i = 0; i < n; i++) events.push({ tStartMs: i * 2000, dDurationMs: 1500, segs: [{ utf8: 'backfill line ' + i }] });
    return events;
  }
  const tailMissing = (o) => {
    const out = readSubs(o).map((line) => line.replace(/^(\d+)\|(.*)$/, '$1|[zh]$2'));
    out.pop();
    return { status: 200, body: JSON.stringify({ choices: [{ message: { content: out.join('\n') }, finish_reason: 'stop' }] }) };
  };
  const failAfterFirst = (o) => {
    const lines = readSubs(o);
    if (lines[0].startsWith('1|backfill line 0')) return goodTranslator(o);
    return tailMissing(o);
  };
  // 删除是写空串（$persistentStore 不一定接受 null），所以「存在」要看值非空
  const bfKeys = (store) => [...store.keys()].filter((k) => k.startsWith('llmsubs.bf.') && store.get(k));
  const bfKeyOf = (store) => bfKeys(store)[0];

  await check('前台收尾把没进缓存的批次写进待翻队列（只存原文与上文，不存 URL / 视频 id）', async () => {
    const store = new Map();
    const { result } = await runScript({
      url: BF_URL, body: json3(bfEvents(60)), config: cfg({ cache: true, probe: true, fastConcurrency: 4 }), store, respond: failAfterFirst,
    });
    assert(result && result.body, '前提：第一批译成，响应被改写');
    const key = bfKeyOf(store);
    assert(key, '应当写出 bf.<轨哈希> 记录');
    const rec = JSON.parse(store.get(key));
    assertEqual(rec.items.length, 2, '没进缓存的两批都要排进队列');
    assertEqual(rec.items[0].t.length, 20, '每项就是前台切出来的那一批原文');
    assert(Array.isArray(rec.items[0].c) && rec.items[0].c.length === 6, '带上文 6 行，cron 用它当跨批上下文');
    assertEqual(rec.n, 3, '记下整轨批数');
    assertEqual(rec.mdl, 'test-model', '记下缓存键用的模型名');
    const q = JSON.parse(store.get('llmsubs.bfq'));
    assertEqual(q.length, 1);
    assertEqual(q[0].n, 2);
    assert(/^[0-9a-f]{8}$/.test(q[0].h) && key === 'llmsubs.bf.' + q[0].h, '索引指向记录');
    for (const [k, v] of store) {
      assert(!k.includes('abc123') && !String(v).includes('abc123'), '待翻记录不得含视频 id：' + k);
      assert(!String(v).includes('youtube.com'), '待翻记录不得含 URL：' + k);
      assert(!String(v).includes('sk-test'), '待翻记录不得含 key：' + k);
    }
    const diag = JSON.parse(store.get('llmsubs.diag'));
    assertEqual(diag[0].backfill.queued, 2, '诊断记录里能看到排了几批');
  });

  await check('cron 角色（无 $request / $response）清空队列：译好写缓存、删记录、记 cron 环，不碰诊断与计数', async () => {
    const store = new Map();
    await runScript({ url: BF_URL, body: json3(bfEvents(60)), config: cfg({ cache: true, probe: true, fastConcurrency: 4 }), store, respond: failAfterFirst });
    const key = bfKeyOf(store);
    const before = { diag: store.get('llmsubs.diag'), started: store.get('llmsubs.stat.started'), reqlog: store.get('llmsubs.reqlog') };
    const cacheBefore = [...store.keys()].filter((k) => k.startsWith('llmsubs.c.')).length;
    const r = await runScript({ noRequest: true, noResponse: true, config: cfg({ cache: true, probe: true }), store, respond: goodTranslator });
    assertEqual(r.result, undefined, 'cron 角色用裸 $done() 收尾，不带响应');
    assertEqual(r.calls.length, 2, '只翻队列里的两批');
    assert(!store.get(key), '全部译成后删掉记录');
    assert(!store.get('llmsubs.bfq'), '索引也清空');
    const cacheAfter = [...store.keys()].filter((k) => k.startsWith('llmsubs.c.')).length;
    assertEqual(cacheAfter - cacheBefore, 2, '两批译文进了缓存');
    const ring = JSON.parse(store.get('llmsubs.cron'));
    assertEqual(ring.length, 1, 'cron 环一条');
    const e = ring[0];
    assertEqual(e.todo, 2); assertEqual(e.started, 2); assertEqual(e.fresh, 2); assertEqual(e.left, 0);
    assertEqual(e.done, 1); assertEqual(e.why, '完成');
    assert(/^[0-9a-f]{8}$/.test(e.h), '环里只有轨哈希');
    assert(!store.get('llmsubs.inflight'), '不留面包屑');
    assertEqual(store.get('llmsubs.diag'), before.diag, '不进诊断记录');
    assertEqual(store.get('llmsubs.stat.started'), before.started, '不计 started');
    assertEqual(store.get('llmsubs.reqlog'), before.reqlog, '不进请求日志');
    assertEqual(r.gets.length, 0, '有活干时不发网络探针');
    // 缓存键必须和前台一致：同一条轨再请求一次，三批全命中、零调用
    const again = await runScript({ url: BF_URL, body: json3(bfEvents(60)), config: cfg({ cache: true, probe: true, fastConcurrency: 4 }), store, respond: goodTranslator });
    assertEqual(again.calls.length, 0, 'cron 铺的缓存前台必须能命中（批次边界与键一致）');
    const diag = JSON.parse(store.get('llmsubs.diag'));
    assertEqual(diag[diag.length - 1].chunks.cached, 3, '三批全部命中');
    assert(!bfKeyOf(store), '铺满的轨不再排队');
  });

  await check('cron 开思考：只有 cron 角色发 reasoning_effort，且必须连 max_tokens 一起给', async () => {
    /* 开思考能减少跨行错位，但单批耗时会超出前台两档的时间预算，所以只在 cron 里开。

       这条测试守的是最容易漏、后果最严重的那个配对：思考 token 算在 completion 里，
       正常的 max_tokens 公式在 1100 字符的批上只给 768，会被思考整个吃光——
       finish_reason=length、可用输出 0 行，而且 HTTP 200 不报错。
       所以「开了思考却没给预算」= 静默零字幕。两者必须一起改，这里一起断言。 */
    const store = new Map();
    await runScript({ url: BF_URL, body: json3(bfEvents(60)), config: cfg({ cache: true, fastConcurrency: 4 }), store, respond: failAfterFirst });
    const r = await runScript({ noRequest: true, noResponse: true, config: cfg({ cache: true }), store, respond: goodTranslator });
    assert(r.calls.length > 0, 'cron 应当翻队列里的批');
    for (const c of r.calls) {
      const b = JSON.parse(c.body);
      assertEqual(b.reasoning_effort, 'low', 'cron 应当发 reasoning_effort:low');
      assert(!('thinking' in b), '关思考那一键必须被删掉，否则会把刚设的强度覆盖回去');
      assertEqual(b.max_tokens, 8192, '开思考必须同时把输出预算抬到 8192，否则思考把预算吃光、零可用输出');
    }
  });

  await check('cron 开思考可以关；前台任何档位都不发思考参数', async () => {
    const store = new Map();
    await runScript({ url: BF_URL, body: json3(bfEvents(60)), config: cfg({ cache: true, fastConcurrency: 4 }), store, respond: failAfterFirst });
    const off = await runScript({ noRequest: true, noResponse: true, config: cfg({ cache: true, backfillThinking: false }), store, respond: goodTranslator });
    assert(off.calls.length > 0);
    for (const c of off.calls) {
      const b = JSON.parse(c.body);
      assert(!('reasoning_effort' in b), '关掉之后不该再发 reasoning_effort');
      assert(b.max_tokens <= 4096, '关掉之后输出预算回到正常公式');
    }
    // 前台：无论速度档还是质量档，都不该出现思考参数
    const fg = await runScript({ url: JSON_URL, body: json3(bfEvents(20)), config: cfg({ cache: false }), store: new Map(), respond: goodTranslator });
    assert(fg.calls.length > 0);
    for (const c of fg.calls) assert(!('reasoning_effort' in JSON.parse(c.body)), '前台绝不发思考参数');
  });

  await check('推荐模式：前台与 cron 的请求体与 v3.6.4 逐字节一致（对照夹具 ytsub.v3.6.4.js）', async () => {
    const OLD = FIX('ytsub.v3.6.4.js');   // 夹具不在就报错，不跳过：跳过的话全绿不等于测到了
    const flow = async (script) => {
      const store = new Map();
      const fg = await runScript({ script, url: BF_URL, body: json3(bfEvents(60)), config: cfg({ cache: true }), store, respond: failAfterFirst });
      const cr = await runScript({ script, noRequest: true, noResponse: true, config: cfg({ cache: true }), store, respond: goodTranslator });
      return { fg: fg.calls.map((c) => c.body).sort(), cr: cr.calls.map((c) => c.body).sort(), hdr: JSON.stringify(fg.calls[0].headers) };
    };
    const a = await flow(OLD), b = await flow(SCRIPT);
    assert(a.fg.length > 0 && a.cr.length > 0, '前提：两边都发了前台与 cron 请求');
    assertEqual(b.fg.length, a.fg.length); assertEqual(b.cr.length, a.cr.length);
    for (let i = 0; i < a.fg.length; i++) assertEqual(b.fg[i], a.fg[i], '前台请求体第 ' + i + ' 条');
    for (let i = 0; i < a.cr.length; i++) assertEqual(b.cr[i], a.cr[i], 'cron 请求体第 ' + i + ' 条');
    assertEqual(b.hdr, a.hdr, '请求头一致');
  });

  await check('其他模型：cron 默认不开思考（max_tokens 下限 1024）；打开「后台翻译使用思考模式」才发 reasoning_effort 并删掉所有关思考字段', async () => {
    const setup = async (custom) => {
      const store = new Map();
      store.set('llmsubs.key.kimi', 'sk-kimi-000000000000');
      store.set('llmsubs.cfg4', JSON.stringify({ v: 4, d: { mode: 'custom', custom: Object.assign({ provider: 'kimi' }, custom) } }));
      await runScript({ url: BF_URL, body: json3(bfEvents(60)), config: cfg({ cache: true }), store, respond: failAfterFirst });
      return runScript({ noRequest: true, noResponse: true, config: cfg({ cache: true }), store, respond: goodTranslator });
    };
    let r = await setup({ think: 'reasoning' });
    assert(r.calls.length > 0, '前提：cron 翻了队列里的批');
    for (const c of r.calls) {
      const b = JSON.parse(c.body);
      assert(!('reasoning_effort' in b), '其他模型的 cron 默认不开思考');
      assertEqual(JSON.stringify(b.reasoning), JSON.stringify({ enabled: false }), '关思考字段照发');
      assert(b.max_tokens >= 1024 && b.max_tokens <= 4096, 'max_tokens 下限 1024：' + b.max_tokens);
      assertEqual(b.model, 'kimi-k2.6');
    }
    r = await setup({ think: 'reasoning', bfThink: true, extraBody: '{"enable_thinking":false,"thinking":{"type":"disabled"}}' });
    assert(r.calls.length > 0);
    for (const c of r.calls) {
      const b = JSON.parse(c.body);
      assertEqual(b.reasoning_effort, 'low');
      for (const k of ['thinking', 'enable_thinking', 'reasoning']) assert(!(k in b), '开思考时必须删掉 ' + k + '，否则会把强度覆盖回去');
      assertEqual(b.max_tokens, 8192);
    }
  });

  await check('cron 撞上余额不足（402）：写 pause、停止派发、不计硬失败；这条轨的 rec.fail 保持原值', async () => {
    const store = new Map();
    await runScript({ url: BF_URL, body: json3(bfEvents(200)), config: cfg({ cache: true, fastConcurrency: 4 }), store, respond: failAfterFirst });
    const key = bfKeyOf(store);
    const rec0 = JSON.parse(store.get(key));
    rec0.fail = 2; store.set(key, JSON.stringify(rec0));
    const r = await runScript({ noRequest: true, noResponse: true, config: cfg({ cache: true, fastConcurrency: 3 }), store, respond: () => ({ status: 402, body: '{"error":{"message":"Insufficient Balance"}}' }) });
    assertEqual(r.calls.length, 1, '撞上余额不足就停手');
    const pz = JSON.parse(store.get('llmsubs.pause'));
    assertEqual(pz.code, 'balance');
    const e = JSON.parse(store.get('llmsubs.cron')).pop();
    assertEqual(e.bal, 1, '运行记录标出余额不足');
    assert(!e.hardFails, '余额不足不计硬失败：' + JSON.stringify(e));
    assertEqual(JSON.parse(store.get(key)).fail, 2, 'rec.fail 保持原值，充值后接着补');
    assertEqual(r.notifications.length, 0, '后台任务不弹通知');
    const cb = JSON.parse(store.get('llmsubs.cb') || '{}');
    assert(!cb.fails && !cb.until, 'cron 不写熔断器');
    // 暂停期间 cron 醒来直接收工
    const r2 = await runScript({ noRequest: true, noResponse: true, config: cfg({ cache: true }), store, respond: goodTranslator });
    assertEqual(r2.calls.length, 0, '暂停期间零出站');
    assertEqual(JSON.parse(store.get('llmsubs.cron')).pop().bal, 1);
  });

  /* ── 就地重试：失败的批本轮再试一次 ── */

  await check('cron 就地重试：失败的批本轮再试一次，救回来的不拖到下一分钟', async () => {
    /* cron 里的失败多数是超时（postJSON 的 reject，进 worker 循环的 catch），属于端点侧的瞬时抖动，
       不是确定性问题，重试一次通常就成。cron 一轮有 30 秒预算（BF_BUDGET_MS − REQ_TIMEOUT），
       通常用不完，放得下这次重试；不重试的话这批要干等下一分钟那轮 cron。 */
    const store = new Map();
    await runScript({ url: BF_URL, body: json3(bfEvents(60)), config: cfg({ cache: true, fastConcurrency: 4 }), store, respond: failAfterFirst });
    let n = 0;
    const flaky = (o) => { n++; return n === 1 ? { error: 'timeout' } : goodTranslator(o); };
    const r = await runScript({ noRequest: true, noResponse: true, config: cfg({ cache: true, probe: true }), store, respond: flaky });
    assertEqual(r.calls.length, 3, '队列两批 + 一次重试');
    assert(!bfKeyOf(store), '重试救回来了，队列该清空');
    const e = JSON.parse(store.get('llmsubs.cron')).slice(-1)[0];
    assertEqual(e.retried, 1, '记下重试了几次');
    assertEqual(e.retryOk, 1, '记下救回几次 —— hardFails 答不了「重试有没有用」');
    assertEqual(e.left, 0, '没有批留到下一轮');
  });

  await check('cron 就地重试：重试仍失败就写回队列，交给下一分钟那一轮（跨轮兜底不能断）', async () => {
    const store = new Map();
    await runScript({ url: BF_URL, body: json3(bfEvents(60)), config: cfg({ cache: true, fastConcurrency: 4 }), store, respond: failAfterFirst });
    const r = await runScript({ noRequest: true, noResponse: true, config: cfg({ cache: true, probe: true }), store, respond: () => ({ error: 'timeout' }) });
    assertEqual(r.calls.length, 4, '两批各首发一次 + 各重试一次');
    const e = JSON.parse(store.get('llmsubs.cron')).slice(-1)[0];
    assertEqual(e.retried, 2); assertEqual(e.retryOk, 0, '一次都没救回');
    assertEqual(e.left, 2, '两批都写回');
    assert(bfKeyOf(store), '队列还在 —— 下一分钟那轮 cron 必须能重新取到它');
  });

  await check('cron 就地重试不污染「有没有进展」的判定：救回一批就算进展，连续失败计数归零', async () => {
    /* rec.fail 是连续零进展的轮数，不是单批失败次数；满 3 就放弃整条轨的剩余批。
       重试让 left 变小 = 有进展 = fail 归零，这条语义不能被重试计数带偏。 */
    const store = new Map();
    await runScript({ url: BF_URL, body: json3(bfEvents(60)), config: cfg({ cache: true, fastConcurrency: 4 }), store, respond: failAfterFirst });
    let aFails = 0;
    const mixed = (o) => {
      const first = readSubs(o)[0] || '';
      if (/line 40/.test(first)) return { error: 'timeout' };            // 这批怎么试都不成
      if (/line 20/.test(first)) { aFails++; return aFails === 1 ? { error: 'timeout' } : goodTranslator(o); }
      return goodTranslator(o);
    };
    const r = await runScript({ noRequest: true, noResponse: true, config: cfg({ cache: true, probe: true }), store, respond: mixed });
    const e = JSON.parse(store.get('llmsubs.cron')).slice(-1)[0];
    assertEqual(e.retried, 2, '两批都失败过、都重试了');
    assertEqual(e.retryOk, 1, '救回一批');
    assertEqual(e.left, 1, '另一批写回');
    const rec = JSON.parse(store.get(bfKeyOf(store)));
    assertEqual(rec.fail || 0, 0, '这一轮有进展，连续失败计数必须归零');
  });

  await check('cron 就地重试受「前台开打就让路」约束：重试前再查一次，命中就不发并置 yield', async () => {
    /* 就地重试是循环体内的第二个派发点，同样要过顶部那道 cronShouldYield：用户此刻打开视频
       （BF_YIELD_MS 12 秒内）cron 应当让路，否则重试会再发一次最长 REQ_TIMEOUT(10s) 的请求，
       跟前台的首屏抢并发。
       构造：失败耗时 600ms 跨过 cronShouldYield 的 500ms 缓存，失败期间写入新鲜的 fg 占位。 */
    const store = new Map();
    await runScript({ url: BF_URL, body: json3(bfEvents(60)), config: cfg({ cache: true, fastConcurrency: 4 }), store, respond: failAfterFirst });
    const before = JSON.parse(store.get(bfKeyOf(store))).items.length;
    const r = await runScript({
      noRequest: true, noResponse: true, config: cfg({ cache: true, probe: true }), store,
      respond: () => {
        store.set('llmsubs.fg', JSON.stringify({ id: 'fg-test', at: Date.now() }));   // 前台正好开打
        return { error: 'timeout', delay: 600 };
      },
    });
    assertEqual(r.calls.length, before, '每批只发一次：让路命中，一次重试都不许有');
    const e = JSON.parse(store.get('llmsubs.cron')).slice(-1)[0];
    assertEqual(e.retried, undefined, '让路时不该计重试');
    assertEqual(e.yield, 1, '让路必须置 cronYielded —— cronFinish 用它判「这一轮不算零进展」，漏置会让 rec.fail 白涨、三轮后误伤整条轨');
  });

  await check('cron 的失败类型要落进 cron 环：这一轮没有 diagFlush，写 DIAG.ev 等于丢掉', async () => {
    /* cron 这一轮没有 diagFlush 路径：passThrough 在 CRON_JOB 分支就 return，replaceBody 只有 render 调，
       而 render 对 cron 直接返回 false。所以 callTimeout / callThrow 写进 DIAG.ev 等于丢掉，
       只剩 hardFails=N、看不出原因；必须挂进 entry，走 cron 环落盘。 */
    const store = new Map();
    await runScript({ url: BF_URL, body: json3(bfEvents(60)), config: cfg({ cache: true, fastConcurrency: 4 }), store, respond: failAfterFirst });
    const r = await runScript({ noRequest: true, noResponse: true, config: cfg({ cache: true, probe: true }), store, respond: () => ({ error: 'timeout' }) });
    const e = JSON.parse(store.get('llmsubs.cron')).slice(-1)[0];
    assertEqual(e.ct, r.calls.length, '每次 timeout 都要记一笔（含就地重试那次）');
    assertEqual(e.cx, undefined, '不是超时的异常才记 cx，这一轮没有');
    assertEqual(e.retried, 2, '两批各重试一次');
    // 非超时异常走另一个计数
    const s2 = new Map();
    await runScript({ url: BF_URL, body: json3(bfEvents(60)), config: cfg({ cache: true, fastConcurrency: 4 }), store: s2, respond: failAfterFirst });
    await runScript({ noRequest: true, noResponse: true, config: cfg({ cache: true, probe: true }), store: s2, respond: () => ({ error: 'socket hang up' }) });
    const e2 = JSON.parse(s2.get('llmsubs.cron')).slice(-1)[0];
    assert(e2.cx > 0, '非超时异常记 cx：它意味着脚本自己撞到边界，重试没用');
    assertEqual(e2.ct, undefined, '别把它算成超时');
  });

  await check('worker 循环 catch 到的异常要写进诊断：timeout 与其他异常分开计数', async () => {
    /* worker 循环 catch 到的异常必须 diagBump，不能只写 log：log 不落盘，
       不记的话事后只看得到失败了几次（hardFails=N），查不出原因。
       分两个计数是因为处置方式相反：timeout 多半是端点侧的瞬时抖动，重试就能救；其他异常多半是
       脚本自己的边界问题，重试再多次也没用。cron 角色不落诊断记录，所以这条用前台路径验。 */
    const ev = async (err) => {
      const r = await runScript({
        url: JSON_URL, body: json3(bfEvents(40)),
        config: cfg({ chunkSize: 20, fastConcurrency: 2, probe: true }), respond: () => ({ error: err }),
      });
      return JSON.parse(r.store.get('llmsubs.diag')).slice(-1)[0].ev || {};
    };
    const t1 = await ev('timeout');
    assertEqual(t1.callTimeout, 2, '两批都超时，各记一次');
    assert(!t1.callThrow, '超时不该算进另一类');
    const t2 = await ev('socket hang up');
    assertEqual(t2.callThrow, 2, '非超时的异常单独计数');
    assert(!t2.callTimeout, '别把它算成超时');
  });

  await check('就地重试只在 cron：速度档失败绝不重试（2.8s 预算里重试 = 挤掉一个新批）', async () => {
    const store = new Map();
    const r = await runScript({ url: BF_URL, body: json3(bfEvents(60)), config: cfg({ cache: false, fastConcurrency: 4, probe: true }), store, respond: () => ({ error: 'timeout' }) });
    assertEqual(r.calls.length, 3, '三批各发一次就完 —— 前台一次重试都不许有');
  });

  await check('cron 就地重试受熔断闸约束：端点真坏了（硬失败满 6）就停手，不再重试', async () => {
    /* 与 worker 循环顶部同一判据。没有这道闸，端点整个挂掉时重试会把失败次数翻倍、
       把这一分钟的预算全烧在注定失败的请求上。 */
    const store = new Map();
    await runScript({ url: BF_URL, body: json3(bfEvents(300)), config: cfg({ cache: true, fastConcurrency: 4 }), store, respond: failAfterFirst });
    const queued = JSON.parse(store.get(bfKeyOf(store))).items.length;
    assert(queued >= 8, '这条用例需要队列里有足够多的批，实际 ' + queued);
    const r = await runScript({ noRequest: true, noResponse: true, config: cfg({ cache: true, probe: true }), store, respond: () => ({ error: 'timeout' }) });
    const e = JSON.parse(store.get('llmsubs.cron')).slice(-1)[0];
    assert(e.hardFails >= 6, '应当累计到停手阈值，实际 ' + e.hardFails);
    assert(r.calls.length < queued * 2, '停手之后不该把队列里每一批都试两遍：' + r.calls.length + ' / ' + (queued * 2));
    assert(e.left > 0, '没做完的批留在队列里');
  });

  await check('换模型后 cron 不碰旧队列：记录里的 mdl 与当前 model 对不上就丢', async () => {
    /* 缓存键含模型名。换模型之后队列里还躺着记着旧模型名的记录；
       如果 cron 照记录里的模型名去翻，译文会写进一个前台永远查不到的键——
       白烧 token、白占存储，且完全没有可见症状。所以对不上就丢。 */
    const store = new Map();
    await runScript({ url: BF_URL, body: json3(bfEvents(60)), config: cfg({ cache: true, fastConcurrency: 4 }), store, respond: failAfterFirst });
    const key = bfKeyOf(store);
    assert(store.get(key), '前台应当写了待翻队列');
    // 换个模型名再让 cron 醒来
    const r = await runScript({ noRequest: true, noResponse: true, config: cfg({ cache: true, model: 'some-other-model' }), store, respond: goodTranslator });
    assertEqual(r.calls.length, 0, '模型名对不上就不该翻');
    assert(!store.get(key), '对不上的记录要丢掉，别每分钟撞它');
  });

  /* ── 让路、熔断、队列的上限与收尾 ── */

  await check('cron 让路：前台刚开打（fg 时间戳新鲜）就 skip=inflight，不打端点、记录不动', async () => {
    const store = new Map();
    await runScript({ url: BF_URL, body: json3(bfEvents(60)), config: cfg({ cache: true, fastConcurrency: 4 }), store, respond: failAfterFirst });
    const key = bfKeyOf(store);
    store.set('llmsubs.fg', String(Date.now()));
    const r = await runScript({ noRequest: true, noResponse: true, config: cfg({ cache: true }), store, respond: goodTranslator });
    assertEqual(r.calls.length, 0, '不打端点');
    const ring = JSON.parse(store.get('llmsubs.cron'));
    assertEqual(ring[ring.length - 1].skip, 'inflight');
    assert(store.get(key), '记录原样保留');
    // 前台的时间戳过期后就正常干活
    store.set('llmsubs.fg', String(Date.now() - 60000));
    const r2 = await runScript({ noRequest: true, noResponse: true, config: cfg({ cache: true }), store, respond: goodTranslator });
    assertEqual(r2.calls.length, 2);
    assert(!store.get(key));
  });

  await check('cron 遇到熔断 / 停用不打端点；队列为空时 skip=idle 并 10 分钟探一次网络', async () => {
    const store = new Map();
    await runScript({ url: BF_URL, body: json3(bfEvents(60)), config: cfg({ cache: true, fastConcurrency: 4 }), store, respond: failAfterFirst });
    store.set('llmsubs.cb', JSON.stringify({ until: Date.now() + 120000 }));
    const r = await runScript({ noRequest: true, noResponse: true, config: cfg({ cache: true }), store, respond: goodTranslator });
    assertEqual(r.calls.length, 0);
    let ring = JSON.parse(store.get('llmsubs.cron'));
    assert(/熔断/.test(ring[ring.length - 1].skip), '记下原因：' + ring[ring.length - 1].skip);
    // 队列为空：idle + 网络探针（打一个真实主机，不带任何参数）
    const s2 = new Map();
    const r2 = await runScript({ noRequest: true, noResponse: true, config: cfg({ cache: true }), store: s2, respond: goodTranslator, respondGet: () => ({ status: 200 }) });
    assertEqual(r2.calls.length, 0);
    assertEqual(r2.gets.length, 1, '空队列时探一次网络');
    assertEqual(r2.gets[0].url, 'https://api.example.com/', '打的是配置的端点主机');
    ring = JSON.parse(s2.get('llmsubs.cron'));
    assertEqual(ring[0].skip, 'idle');
    assertEqual(ring[0].net.status, 200, '探针结果记进环');
    assert(typeof ring[0].ms === 'number');
    const r3 = await runScript({ noRequest: true, noResponse: true, config: cfg({ cache: true }), store: s2, respond: goodTranslator, respondGet: () => ({ status: 200 }) });
    assertEqual(r3.gets.length, 0, '10 分钟内不再探');
    ring = JSON.parse(s2.get('llmsubs.cron'));
    assertEqual(ring.length, 2);
    assert(typeof ring[1].gap === 'number' && ring[1].gap >= 0, '记下距上次运行的间隔（证明每分钟真的在跑）');
  });

  await check('backfill 关掉：前台不写队列，cron 醒来即退（skip=off）', async () => {
    const store = new Map();
    await runScript({ url: BF_URL, body: json3(bfEvents(60)), config: cfg({ cache: true, fastConcurrency: 4, backfill: false }), store, respond: failAfterFirst });
    assert(!bfKeyOf(store) && !store.get('llmsubs.bfq'), '不写队列');
    store.set('llmsubs.bfq', JSON.stringify([{ h: 'deadbeef', n: 1 }]));
    const r = await runScript({ noRequest: true, noResponse: true, config: cfg({ cache: true, backfill: false }), store, respond: goodTranslator });
    assertEqual(r.calls.length, 0);
    assertEqual(JSON.parse(store.get('llmsubs.cron'))[0].skip, 'off');
    // 缓存关着也不排队：队列的意义就是填缓存
    const s2 = new Map();
    await runScript({ url: BF_URL, body: json3(bfEvents(60)), config: cfg({ cache: false, fastConcurrency: 4 }), store: s2, respond: failAfterFirst });
    assert(!bfKeyOf(s2), 'cache=false 时不写队列');
  });

  await check('cron 连续 3 轮零进展就丢掉记录（别为一批永远翻不出来的东西每分钟打端点）', async () => {
    const store = new Map();
    await runScript({ url: BF_URL, body: json3(bfEvents(60)), config: cfg({ cache: true, fastConcurrency: 4 }), store, respond: failAfterFirst });
    const key = bfKeyOf(store);
    // 尾号缺失（合并漏）：整批丢弃、拆批后两半照样漏——永远翻不出来
    for (let round = 1; round <= 3; round++) {
      await runScript({ noRequest: true, noResponse: true, config: cfg({ cache: true }), store, respond: tailMissing });
      const ring = JSON.parse(store.get('llmsubs.cron'));
      const e = ring[ring.length - 1];
      assertEqual(e.left, 2, '第 ' + round + ' 轮：两批都没成');
      if (round < 3) {
        assert(store.get(key), '第 ' + round + ' 轮后记录还在');
        assertEqual(JSON.parse(store.get(key)).fail, round, 'fail 计数');
      } else {
        assert(!store.get(key), '第 3 轮后丢掉');
        assertEqual(e.drop, 'stuck');
        assert(!store.get('llmsubs.bfq'));
      }
    }
  });

  await check('cron 成一批、剩一批：收尾把剩余批次写回队列（fail 归零、索引同步）', async () => {
    // 端点对第二批报错，第一批成功；主流程完成后剩一批写回，而不是整条记录丢掉
    const store = new Map();
    await runScript({ url: BF_URL, body: json3(bfEvents(60)), config: cfg({ cache: true, fastConcurrency: 4 }), store, respond: failAfterFirst });
    const key = bfKeyOf(store);
    let n = 0;
    const r = await runScript({
      noRequest: true, noResponse: true, config: cfg({ cache: true, requestTimeout: 1 }), store,
      respond: (o) => { n++; return n === 1 ? goodTranslator(o) : { error: 'timeout', delay: 1500 }; },
    });
    const rec = JSON.parse(store.get(key));
    assertEqual(rec.items.length, 1, '成了一批、剩一批写回');
    assertEqual(rec.fail, 0, '有进展就不算失败');
    const q = JSON.parse(store.get('llmsubs.bfq'));
    assertEqual(q[0].n, 1, '索引里的批数同步');
    const e = JSON.parse(store.get('llmsubs.cron')).pop();
    assertEqual(e.left, 1);
  });

  await check('cron 只留最新 3 条轨：第 4 条轨进队列时最老的连记录一起丢', async () => {
    const store = new Map();
    for (let v = 0; v < 4; v++) {
      const url = 'https://www.youtube.com/api/timedtext?v=vid' + v + '&lang=en&fmt=json3&caps=asr';
      await runScript({ url, body: json3(bfEvents(60)), config: cfg({ cache: true, fastConcurrency: 4 }), store, respond: failAfterFirst });
    }
    const q = JSON.parse(store.get('llmsubs.bfq'));
    assertEqual(q.length, 3, '最多 3 条轨');
    const recs = bfKeys(store);
    assertEqual(recs.length, 3, '被挤出的那条轨的记录也删了');
    for (const it of q) assert(store.get('llmsubs.bf.' + it.h), '索引里的每一条都有记录');
  });

  await check('cron 角色不受速度档定时器影响：多批也在一次运行里翻完', async () => {
    // 前台切了 10 批、只成 1 批 → 队列 9 批；cron 并发 2 也要一次跑完（速度档「一波」的限制不适用）
    const store = new Map();
    await runScript({ url: BF_URL, body: json3(bfEvents(200)), config: cfg({ cache: true, fastConcurrency: 4 }), store, respond: failAfterFirst });
    const key = bfKeyOf(store);
    assertEqual(JSON.parse(store.get(key)).items.length, 9);
    const r = await runScript({ noRequest: true, noResponse: true, config: cfg({ cache: true, backfillConcurrency: 2 }), store, respond: goodTranslator });
    assertEqual(r.calls.length, 9, '九批全部翻完');
    assert(!store.get(key));
    const e = JSON.parse(store.get('llmsubs.cron')).pop();
    assertEqual(e.fresh, 9);
  });

  await check('让路占位 fg 带运行 id：并发的另一次前台运行收尾时不会替它清掉；自己收尾才清', async () => {
    const store = new Map();
    // 先让第一批进缓存，这样运行 B（全命中、todo 0）能在几十毫秒内收尾
    await runScript({ url: BF_URL, body: json3(bfEvents(20)), config: cfg({ cache: true }), store, respond: goodTranslator });
    // 运行 A：60 条、后两批端点慢 1.2s → 它要跑一阵子，期间 fg 应当一直是 A 的
    const slow = (o) => (readSubs(o)[0].startsWith('1|backfill line 0') ? goodTranslator(o) : { ...goodTranslator(o), delay: 1200 });
    const pA = runScript({ url: BF_URL, body: json3(bfEvents(60)), config: cfg({ cache: true, fastConcurrency: 4, fastBudgetMs: 2000 }), store, respond: slow });
    await new Promise((res) => setTimeout(res, 150));
    const fgDuringA = JSON.parse(store.get('llmsubs.fg') || 'null');
    assert(fgDuringA && fgDuringA.id && typeof fgDuringA.at === 'number', 'A 开打后写了带 id 的占位');
    // 运行 B：同一视频前 20 条，全命中，立刻收尾
    await runScript({ url: BF_URL, body: json3(bfEvents(20)), config: cfg({ cache: true }), store, respond: goodTranslator });
    const fgAfterB = JSON.parse(store.get('llmsubs.fg') || 'null');
    assert(fgAfterB && fgAfterB.id === fgDuringA.id, 'B 收尾不能清掉 A 的占位（B 自己没写过）');
    await pA;
    assert(!store.get('llmsubs.fg'), 'A 自己收尾时清掉');
  });

  await check('cron 收尾前重读记录：前台期间重写过就合并（去掉本轮做完的），被前台删了就不复活', async () => {
    const store = new Map();
    await runScript({ url: BF_URL, body: json3(bfEvents(60)), config: cfg({ cache: true, fastConcurrency: 4 }), store, respond: failAfterFirst });
    const key = bfKeyOf(store);
    const rec = JSON.parse(store.get(key));
    // cron 跑到一半（端点慢 300ms），前台把记录重写成「第 2 批 + 一条全新的批」
    const slow = (o) => ({ ...goodTranslator(o), delay: 300 });
    const p = runScript({ noRequest: true, noResponse: true, config: cfg({ cache: true }), store, respond: slow });
    await new Promise((res) => setTimeout(res, 60));
    const fresh = { t: ['a brand new line that was never queued before'] };
    store.set(key, JSON.stringify(Object.assign({}, rec, { at: rec.at + 1, items: [rec.items[0], fresh] })));
    await p;
    const after = JSON.parse(store.get(key));
    assertEqual(after.items.length, 1, '本轮做完的第 2 批被去掉，前台新排的那批留下');
    assertEqual(after.items[0].t[0], fresh.t[0]);
    const e = JSON.parse(store.get('llmsubs.cron')).pop();
    assertEqual(e.merged, 1);
    assertEqual(JSON.parse(store.get('llmsubs.bfq'))[0].n, 1, '索引里的批数同步');
    // 被前台删掉：不复活
    const s2 = new Map();
    await runScript({ url: BF_URL, body: json3(bfEvents(60)), config: cfg({ cache: true, fastConcurrency: 4 }), store: s2, respond: failAfterFirst });
    const key2 = bfKeyOf(s2);
    const p2 = runScript({ noRequest: true, noResponse: true, config: cfg({ cache: true }), store: s2, respond: (o) => ({ ...tailMissing(o), delay: 300 }) });
    await new Promise((res) => setTimeout(res, 60));
    s2.set(key2, '');
    s2.set('llmsubs.bfq', '');
    await p2;
    assert(!s2.get(key2), '前台删掉的记录不复活');
    assertEqual(JSON.parse(s2.get('llmsubs.cron')).pop().gone, 1);
  });

  /* ── 待翻记录的体积闸、缓存键与坏条目 ── */

  await check('待翻记录有体积闸：超过 256KB 丢尾并记 backfillClipped', async () => {
    const events = [];
    const big = 'y'.repeat(1100);
    for (let i = 0; i < 120; i++) events.push({ tStartMs: i * 5000, dDurationMs: 4000, segs: [{ utf8: big + i }] });
    const { store } = await runScript({
      url: JSON_URL, body: json3(events), config: cfg({ cache: true, probe: true, fastBudgetMs: 900, fastConcurrency: 4 }), respond: tailMissing,
    });
    const key = bfKeyOf(store);
    assert(key, '有记录');
    assert(store.get(key).length < 300 * 1024, '记录不超过体积闸太多：' + store.get(key).length);
    const rec = JSON.parse(store.get(key));
    assert(rec.items.length < 120, '丢了尾巴：' + rec.items.length);
    assertEqual(JSON.parse(store.get('llmsubs.diag'))[0].ev.backfillClipped, 1);
  });

  const failUnless = (first) => (o) => (readSubs(o)[0].startsWith('1|' + first) ? goodTranslator(o) : tailMissing(o));

  await check('cron 缓存键与前台一致的核心不变量：命中领域（dom）与轨类型（kind）的语料也要全命中', async () => {
    // 其他 backfill 用例的语料都判不出领域，rec.dom 那条判据只有这条用例测得到。
    // 用能触发 DOMAIN='ai' 的语料跑「前台排队 → cron 铺满 → 前台重请求零调用」。
    const ai = ['neural networks learn features', 'fine-tuning a large language model', 'RLHF aligns the chatbot',
      'scaling laws predict the loss', 'gradient descent and backpropagation', 'training data and model weights',
      'embeddings capture meaning', 'hallucination is a known failure', 'foundation models are pretrained', 'openai and anthropic ship models'];
    const events = [];
    for (let i = 0; i < 60; i++) events.push({ tStartMs: i * 2000, dDurationMs: 1500, segs: [{ utf8: ai[i % ai.length] + ' ' + i }] });
    const store = new Map();
    await runScript({ url: BF_URL, body: json3(events), config: cfg({ cache: true, probe: true, fastConcurrency: 4 }), store, respond: failUnless(ai[0] + ' 0') });
    const d0 = JSON.parse(store.get('llmsubs.diag'))[0];
    assertEqual(d0.domain, 'ai', '前提：这份语料判成 AI 领域');
    const key = bfKeyOf(store);
    const rec = JSON.parse(store.get(key));
    assertEqual(rec.dom, 'ai', '记录里带前台判定的领域');
    assertEqual(rec.kind, 'asr', '记录里带轨类型');
    const r = await runScript({ noRequest: true, noResponse: true, config: cfg({ cache: true, probe: true }), store, respond: goodTranslator });
    assertEqual(r.calls.length, 2);
    const again = await runScript({ url: BF_URL, body: json3(events), config: cfg({ cache: true, probe: true, fastConcurrency: 4 }), store, respond: goodTranslator });
    assertEqual(again.calls.length, 0, 'cron 按 rec.dom 算的键前台必须能命中');
    const d = JSON.parse(store.get('llmsubs.diag'));
    assertEqual(d[d.length - 1].chunks.cached, 3);
  });

  await check('cron 的失败不碰前台共享的熔断器、不弹通知；硬失败够多就停手', async () => {
    const store = new Map();
    await runScript({ url: BF_URL, body: json3(bfEvents(200)), config: cfg({ cache: true, fastConcurrency: 4 }), store, respond: failAfterFirst });
    const key = bfKeyOf(store);
    assertEqual(JSON.parse(store.get(key)).items.length, 9);
    // cron 并发 = round(有效上限 / 3)：上限 3 → 1 路
    const r = await runScript({ noRequest: true, noResponse: true, config: cfg({ cache: true, fastConcurrency: 3 }), store, respond: () => ({ error: 'network down' }) });
    const cb = JSON.parse(store.get('llmsubs.cb') || '{}');
    assert(!cb.until && !cb.fails && !cb.hardStop, '后台失败不能写熔断器：' + JSON.stringify(cb));
    assertEqual(r.notifications.length, 0, '后台任务不弹通知');
    const e = JSON.parse(store.get('llmsubs.cron')).pop();
    assert(e.hardFails >= 6, '本次运行的硬失败计在环里：' + JSON.stringify(e));
    assert(r.calls.length <= 9, '够多就停手，别把 9 批都烧完：' + r.calls.length);
    assert(store.get(key), '记录留着，下一分钟再试');
    // 紧接着前台请求另一个视频，必须照常翻译
    const fg = await runScript({ url: JSON_URL, body: FIX('YouTube.timedtext.json'), config: cfg({ cache: true }), store, respond: goodTranslator });
    assert(fg.result && fg.result.body && fg.calls.length > 0, '前台不受后台失败影响');
  });

  await check('cron 跑到一半这条轨被挤出索引 / 被清空缓存：收尾不写回（不留孤儿）', async () => {
    const store = new Map();
    await runScript({ url: BF_URL, body: json3(bfEvents(60)), config: cfg({ cache: true, fastConcurrency: 4 }), store, respond: failAfterFirst });
    const key = bfKeyOf(store);
    const p = runScript({ noRequest: true, noResponse: true, config: cfg({ cache: true }), store, respond: (o) => ({ ...tailMissing(o), delay: 300 }) });
    await new Promise((res) => setTimeout(res, 60));
    store.set('llmsubs.bfq', '');   // 面板「清空缓存」/ 被第 4 条轨挤掉
    await p;
    assert(!store.get(key), '索引里没有它就不能再写回');
    assertEqual(JSON.parse(store.get('llmsubs.cron')).pop().drop, 'evicted');
  });

  await check('bfq 里缺 h 的坏条目只丢它自己，后面正常的轨照常处理', async () => {
    const store = new Map();
    await runScript({ url: BF_URL, body: json3(bfEvents(60)), config: cfg({ cache: true, fastConcurrency: 4 }), store, respond: failAfterFirst });
    const key = bfKeyOf(store);
    const q = JSON.parse(store.get('llmsubs.bfq'));
    store.set('llmsubs.bfq', JSON.stringify([{ at: 1, n: 5 }, null, q[0]]));
    const r = await runScript({ noRequest: true, noResponse: true, config: cfg({ cache: true }), store, respond: goodTranslator });
    assertEqual(r.calls.length, 2, '正常的轨被处理');
    assert(!store.get(key) && !store.get('llmsubs.bfq'), '处理完删记录、索引清空');
  });

  /* ── 存活计数、版本闸与前台的续期 ── */

  await check('cron 存活计数：每次运行先盖章（cron.n / cron.first / cron.last），补翻关着也盖；空 $request 对象也认成 cron', async () => {
    const store = new Map();
    await runScript({ noRequest: true, noResponse: true, config: cfg({ cache: true, backfill: false }), store, respond: goodTranslator });
    assertEqual(store.get('llmsubs.cron.n'), '1', '补翻关着也要计数（回答的是「小火箭有没有叫它」）');
    const first = store.get('llmsubs.cron.first');
    assert(/^\d{13}$/.test(first), '记下首次运行时刻');
    assertEqual(JSON.parse(store.get('llmsubs.cron'))[0].skip, 'off');
    await runScript({ emptyRequest: true, noResponse: true, config: cfg({ cache: true }), store, respond: goodTranslator });
    assertEqual(store.get('llmsubs.cron.n'), '2', '$request 是空对象时同样按 cron 分派');
    assertEqual(store.get('llmsubs.cron.first'), first, 'first 不变');
    const ring = JSON.parse(store.get('llmsubs.cron'));
    assertEqual(ring.length, 2);
    assertEqual(ring[1].skip, 'idle');
    assert(typeof ring[1].gap === 'number' && ring[1].gap >= 0, '第二次起带 gap');
    // 真 http 钩子但 URL 取不到：有 method / headers 就不能当 cron（误入会把那个钩子扣住 40 秒）
    const s3 = new Map();
    const r3 = await runScript({ requestNoUrl: true, noResponse: true, config: cfg({ cache: true }), store: s3, respond: goodTranslator });
    assertEqual(r3.result, undefined, '原样放行');
    assert(!s3.get('llmsubs.cron.n') && !s3.get('llmsubs.cron'), '不按 cron 处理');
  });

  await check('cron 入口过版本闸：旧版本的诊断环、待翻记录与存活计数清掉，再盖新章', async () => {
    const store = new Map();
    store.set('llmsubs.diagver', '0.0.0');
    store.set('llmsubs.diag', JSON.stringify([{ v: '0.0.0' }]));
    store.set('llmsubs.cron.n', '99'); store.set('llmsubs.cron.first', '1');
    store.set('llmsubs.bfq', JSON.stringify([{ h: 'deadbeef', n: 1 }]));
    store.set('llmsubs.bf.deadbeef', JSON.stringify({ v: '0.0.0', h: 'deadbeef', items: [{ t: ['x'] }] }));
    const r = await runScript({ noRequest: true, noResponse: true, config: cfg({ cache: true }), store, respond: goodTranslator });
    const ver = (SCRIPT.match(/var SCRIPT_VER = '([^']+)'/) || [])[1];
    assertEqual(store.get('llmsubs.diagver'), ver, '版本闸更新');
    assert(!store.get('llmsubs.diag'), '旧诊断记录清掉');
    assert(!store.get('llmsubs.bf.deadbeef') && !store.get('llmsubs.bfq'), '旧版本待翻记录清掉');
    assertEqual(store.get('llmsubs.cron.n'), '1', '计数从 1 重新开始（先清旧的 99 再盖章）');
    assert(store.get('llmsubs.cron.first') !== '1', 'first 重新记');
    assertEqual(r.calls.length, 0);
  });

  await check('【回归】探针关着时版本闸也在前台过：装好后第一分钟排的队列，cron 第一次醒来不能当旧版本清掉', async () => {
    // 探针通常是关着的，版本闸不能依赖它：如果只在探针开着的前台过闸，探针关着时前台不写 diagver，
    // cron 第一次醒来就会把队列当旧版本清掉——装好或升级后第一条视频的补翻整个丢掉。
    const store = new Map();   // 全新设备：没有 diagver
    await runScript({ url: BF_URL, body: json3(bfEvents(60)), config: cfg({ cache: true, probe: false }), store, respond: failAfterFirst });
    assert(store.get('llmsubs.bfq'), '前提：前台把没翻完的批排进了队列');
    const ver = (SCRIPT.match(/var SCRIPT_VER = '([^']+)'/) || [])[1];
    assertEqual(store.get('llmsubs.diagver'), ver, '探针关着前台也要盖版本章，否则 cron 会把队列当旧版本清掉');
    const cr = await runScript({ noRequest: true, noResponse: true, config: cfg({ cache: true, probe: false }), store, respond: goodTranslator });
    assert(cr.calls.length > 0, 'cron 第一次醒来就该翻队列里的批，而不是把它清掉');
    assert(!store.get('llmsubs.bfq'), '翻完队列该清空');
    // 升级路径：手机上还留着旧版本的章与旧记录。前台入口先过闸清掉旧的、再排新的，cron 翻的必须是新排的队列
    const up = new Map();
    up.set('llmsubs.diagver', '0.0.0');
    up.set('llmsubs.bfq', JSON.stringify([{ h: 'deadbeef', n: 1 }]));
    up.set('llmsubs.bf.deadbeef', JSON.stringify({ v: '0.0.0', h: 'deadbeef', items: [{ t: ['old'] }] }));
    await runScript({ url: BF_URL, body: json3(bfEvents(60)), config: cfg({ cache: true, probe: false }), store: up, respond: failAfterFirst });
    assert(!up.get('llmsubs.bf.deadbeef') && up.get('llmsubs.bfq'), '旧版本的记录清掉、新的排上');
    const cr2 = await runScript({ noRequest: true, noResponse: true, config: cfg({ cache: true, probe: false }), store: up, respond: goodTranslator });
    assert(cr2.calls.length > 0, '升级后 cron 第一次醒来也该翻新排的队列');
  });

  await check('探针关闭时 cron 不探网络、不写运行环；存活章（cron.n/last/first）照盖', async () => {
    const store = new Map();
    const r = await runScript({ noRequest: true, noResponse: true, config: cfg({ cache: true, probe: false }), store, respondGet: () => ({ status: 200 }) });
    assertEqual(r.gets.length, 0);
    assert(!store.get('llmsubs.cron') && !store.get('llmsubs.cron.net'), '不写运行环、不探网络');
    assertEqual(store.get('llmsubs.cron.n'), '1', '存活章不受探针开关影响：探针关着也要靠它判 cron 活着、面板也要靠它分辨「没跑」与「探针关了」');
    assert(store.get('llmsubs.cron.last') && store.get('llmsubs.cron.first'));
    // 探针开着时网络探针打的是用户配置的端点主机，不是硬编码的第三方
    const s2 = new Map();
    const r2 = await runScript({ noRequest: true, noResponse: true, config: cfg({ cache: true, probe: true, baseUrl: 'https://my-llm.example.org/v1' }), store: s2, respondGet: () => ({ status: 404 }) });
    assertEqual(r2.gets.length, 1);
    assertEqual(r2.gets[0].url, 'https://my-llm.example.org/');
  });

  await check('cron 中途让路：进展为零也不算失败（fail 不累加、记录留着）', async () => {
    const store = new Map();
    await runScript({ url: BF_URL, body: json3(bfEvents(60)), config: cfg({ cache: true, fastConcurrency: 4 }), store, respond: failAfterFirst });
    const key = bfKeyOf(store);
    const p = runScript({ noRequest: true, noResponse: true, config: cfg({ cache: true, backfillConcurrency: 1 }), store, respond: (o) => ({ ...tailMissing(o), delay: 150 }) });
    await new Promise((res) => setTimeout(res, 50));
    store.set('llmsubs.fg', JSON.stringify({ id: 'someone-else', at: Date.now() }));   // 前台开打了
    await p;
    const e = JSON.parse(store.get('llmsubs.cron')).pop();
    assertEqual(e.yield, 1, '记下让路');
    const rec = JSON.parse(store.get(key));
    assertEqual(rec.items.length, 2, '两批都没成、都留着');
    assertEqual(rec.fail, 0, '让路不算零进展');
  });

  await check('前台每派一批续期一次 fg，长跑的质量档不会被 cron 判成「早走了」', async () => {
    const store = new Map();
    // 这条要的就是「同一个 worker 连着派第二、三批」，所以必须显式开第二波（默认关）
    const p = runScript({ url: BF_URL, body: json3(bfEvents(60)), config: cfg({ cache: true, fastConcurrency: 1, fastBudgetMs: 2500, secondWave: true }), store, respond: (o) => ({ ...goodTranslator(o), delay: 400 }) });
    await new Promise((res) => setTimeout(res, 120));
    const first = JSON.parse(store.get('llmsubs.fg')).at;
    await new Promise((res) => setTimeout(res, 800));
    const later = JSON.parse(store.get('llmsubs.fg')).at;
    assert(later > first, '派第二、三批时续期了：' + first + ' → ' + later);
    await p;
    assert(!store.get('llmsubs.fg'), '收尾清掉');
  });

  await check('待翻记录里的模型名一律记速度档模型：质量档排的队铺完之后速度档也能命中', async () => {
    const store = new Map();
    const conf = cfg({ cache: true, probe: true, fastConcurrency: 4, qualityModel: 'quality-model' });
    const U = M_JSON_URL + '&kind=asr';
    await runScript({ url: U, body: json3(bfEvents(60)), config: conf, store, respond: failAfterFirst });
    await runScript({ url: U, body: json3(bfEvents(60)), config: conf, store, respond: failAfterFirst });   // 重复请求 → 质量档
    const d = JSON.parse(store.get('llmsubs.diag'));
    assertEqual(d[1].chunks.mode, 'q', '前提：第二次进质量档');
    assertEqual(d[1].modelUsed, 'quality-model');
    const rec = JSON.parse(store.get(bfKeyOf(store)));
    assertEqual(rec.mdl, 'test-model', '记的是速度档模型');
    await runScript({ noRequest: true, noResponse: true, config: conf, store, respond: goodTranslator });
    const fast = await runScript({ url: BF_URL, body: json3(bfEvents(60)), config: conf, store, respond: goodTranslator });
    assertEqual(fast.calls.length, 0, '速度档全命中');
  });

  await check('待翻记录写失败（存储拒收）时不在索引里留悬空条目，并记 backfillWriteFailed', async () => {
    const store = new Map();
    const realSet = store.set.bind(store);
    store.set = (k, v) => ((k.startsWith('llmsubs.bf.') && String(v).length > 50) ? store : realSet(k, v));
    await runScript({ url: BF_URL, body: json3(bfEvents(60)), config: cfg({ cache: true, probe: true, fastConcurrency: 4 }), store, respond: failAfterFirst });
    assert(!store.get('llmsubs.bfq'), '索引里不能有悬空条目');
    assertEqual(JSON.parse(store.get('llmsubs.diag'))[0].ev.backfillWriteFailed, 1);
  });

  await check('批次数超过 MAX_CHUNKS 只派发前 600 批，不整条轨放行', async () => {
    // 每条 cue 1100+ 字符 → 各自成批；605 批
    const events = [];
    const big = 'x'.repeat(1101);
    for (let i = 0; i < 605; i++) events.push({ tStartMs: i * 5000, dDurationMs: 4000, segs: [{ utf8: big + i }] });
    const { result, store } = await runScript({
      url: JSON_URL, body: json3(events), config: cfg({ probe: true, fastBudgetMs: 900, fastConcurrency: 8 }), respond: goodTranslator,
    });
    assert(result && result.body, '应当改写响应而不是放行');
    const diag = JSON.parse(store.get('llmsubs.diag'))[0];
    assertEqual(diag.ev.chunksTruncated, 1, '记下截断');
    assertEqual(diag.chunks.total, 605);
    const doc = JSON.parse(result.body);
    assert(!doc.events[604].segs[0].utf8.includes('[zh]'), '第 601 批之后保持英文');
    assert(doc.events[0].segs[0].utf8.includes('[zh]'), '前面照常翻');
  });

  section('体积闸：4MB 以内照常翻译并入队，超出才放行并通知');
  /* 为什么这道闸要三条用例，语料又为什么要仿真实的 ASR 轨：
     体积闸的放行发生在 TRACK_HASH 算出来之前，被放行的轨连待翻队列都进不去，
     cron 永远补不到它——普通长视频是「这次一半、下次补齐」，撞闸的轨是永远 0%。
     所以闸要足够高，撞闸时还要有提示。

     语料必须模仿真实 ASR 轨的比例：json3 里正文只占体积的百分之几，其余是逐词时间与结构开销；
     否则 1MB 的正文会先撞 MAX_CHUNKS=600（600 批 × 1100 字符 ≈ 660KB），
     测到的就不是体积闸了。 */
  function asrLikeJson3(events, segsPer) {
    // 逐词 seg + tOffsetMs + acAsrConf：JSON 结构开销大、正文少，和真实的 ASR 轨同构
    const evs = [];
    for (let i = 0; i < events; i++) {
      const segs = [];
      for (let j = 0; j < segsPer; j++) {
        segs.push({ utf8: (j ? ' ' : '') + 'word' + j, tOffsetMs: j * 120, acAsrConf: 224 });
      }
      evs.push({ tStartMs: i * 3000, dDurationMs: 2800, wWinId: 1, segs: segs });
    }
    return json3(evs);
  }

  await check('体积闸：超过 1MB、不到 4MB 的轨（长视频的 ASR 轨就在这个量级）照常翻译并入队，不放行', async () => {
    const body = asrLikeJson3(5000, 5);
    assert(body.length > 1048576, '语料必须真的超过 1MB，实际 ' + body.length);
    assert(body.length < 4194304, '又必须在体积闸（4MB）之内，实际 ' + body.length);
    const { result, store } = await runScript({
      url: JSON_URL, body, config: cfg({ cache: true, probe: true, fastBudgetMs: 900, fastConcurrency: 8 }), respond: goodTranslator,
    });
    assert(result && result.body, '这个体积的轨不该整条放行（result.body 不能为空）');
    const doc = JSON.parse(result.body);
    assert(doc.events[0].segs[0].utf8.includes('[zh]'), '开头必须有中文：用户第一次打开就得看见脚本在工作');
    const diag = JSON.parse(store.get('llmsubs.diag'))[0];
    assert(!diag.ev || !diag.ev.bodyTooBig, '没超体积闸就不该记 bodyTooBig');
    assertEqual(diag.inLen, body.length, 'inLen 无条件记体积，对账用');
    // 关键：这条轨必须进得了待翻队列，cron 才补得到
    assert(store.get('llmsubs.bfq'), '剩余批次必须进待翻队列');
    assert(JSON.parse(store.get('llmsubs.bfq')).length > 0, '队列里要有这条轨');
  });

  await check('体积闸：真超出才放行，且记 bodyTooBig + 弹一次通知（不能是无声的一片英文）', async () => {
    // 闸在格式嗅探之前，所以正文是什么不重要；用 json3 开头保持真实
    const body = '{"wireMagic":"pb3","events":[],"pad":"' + 'x'.repeat(4194400) + '"}';
    assert(body.length > 4194304, '必须真的超过体积闸');
    const store = new Map();
    const r = await runScript({ url: JSON_URL, body, config: cfg({ probe: true }), store, respond: goodTranslator });
    assert(!r.result || !r.result.body, '超出闸只能放行');
    const diag = JSON.parse(store.get('llmsubs.diag'))[0];
    assertEqual(diag.ev.bodyTooBig, 1, '记下来，面板才看得到');
    assertEqual(diag.inLen, body.length, '超限路径也要有体积，这是最需要它的场景');
    assertEqual(r.notifications.length, 1, '必须弹通知：屏幕上一片英文时，「太长了」和「模块坏了」长得一模一样');
    assert(/体积/.test(r.notifications[0].b), '通知要说清是体积问题：' + r.notifications[0].b);
    // 一小时内不重复打扰
    const r2 = await runScript({ url: JSON_URL, body, config: cfg({ probe: true }), store, respond: goodTranslator });
    assertEqual(r2.notifications.length, 0, '同一类别一小时只弹一次');
  });

  await check('体积闸：模块 max-size 与脚本 BODY_MAX 必须是同一个值（两处不同时，实际生效的是较小的那个）', async () => {
    const mod = fs.readFileSync(path.join(ROOT, 'SubsPair.sgmodule'), 'utf8');
    const script = fs.readFileSync(path.join(ROOT, 'ytsub.js'), 'utf8');
    const maxSize = mod.match(/\bmax-size=(\d+)/);
    const bodyMax = script.match(/\bvar BODY_MAX = (\d+)/);
    assert(maxSize && bodyMax, '两处都要找得到');
    assertEqual(bodyMax[1], maxSize[1], 'BODY_MAX 必须等于 max-size');
    assert(parseInt(bodyMax[1], 10) >= 4194304, '体积闸不得低于 4MB，否则 3 小时左右的 ASR 轨进不来');
  });

  await check('seen 计数按轨不按视频：切到另一条轨是它的第 1 次请求（m 域不进质量档）', async () => {
    const store = new Map();
    await runScript({ url: M_JSON_URL, body: FIX('YouTube.timedtext.json'), config: cfg({ probe: true }), store, respond: goodTranslator });
    const r2 = await runScript({ url: M_JSON_URL + '&kind=asr', body: FIX('YouTube.timedtext.json'), config: cfg({ probe: true }), store, respond: goodTranslator });
    const diag = JSON.parse(store.get('llmsubs.diag'));
    assertEqual(diag[1].reqNo, 1, '另一条轨是第一次请求');
    assertEqual(diag[1].chunks.mode, 'f', '播放器手上没有这条轨，必须走速度档');
    // 同一条轨再来一次才是重复请求
    await runScript({ url: M_JSON_URL + '&kind=asr', body: FIX('YouTube.timedtext.json'), config: cfg({ probe: true }), store, respond: goodTranslator });
    const diag3 = JSON.parse(store.get('llmsubs.diag'));
    assertEqual(diag3[2].reqNo, 2);
    assertEqual(diag3[2].chunks.mode, 'q');
  });

  await check('速度档撞 429 不空睡 1.2 秒：来不及重试就立刻放弃这一批', async () => {
    const t = Date.now();
    const body = json3([{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'only one line here' }] }]);
    const { calls, at } = await runScript({
      url: JSON_URL, body, config: cfg({ fastBudgetMs: 1500 }),
      respond: () => ({ status: 429, body: '{"error":"rate"}' }),
    });
    assertEqual(calls.length, 1, '不重试');
    assert(at - t < 1100, '不该睡满 1.2s 再放弃，实际 ' + (at - t) + 'ms');
  });

  await check('探针：$done 之后 1.5 秒仍存活就弹一条通知，且每个版本只弹一次', async () => {
    const store = new Map();
    const r = await runScript({ url: JSON_URL, body: FIX('YouTube.timedtext.json'), config: cfg({ probe: true }), store, respond: goodTranslator });
    assertEqual(r.notifications.length, 0, '$done 那一刻还没有');
    assert(/^p:\d+$/.test(store.get('llmsubs.pdn')), '$done 前同步记「已计划」：' + store.get('llmsubs.pdn'));
    await new Promise((res) => setTimeout(res, 1800));
    assertEqual(r.notifications.length, 1, '沙箱里上下文不会被回收，1.5s 后应当弹（手机上没弹 = $done 之后上下文被回收了）');
    assert(/1\.5 秒/.test(r.notifications[0].b));
    assert(/^f:\d+$/.test(store.get('llmsubs.pdn')), '定时器触发后改成「已触发」：' + store.get('llmsubs.pdn'));
    const r2 = await runScript({ url: JSON_URL, body: FIX('YouTube.timedtext.json'), config: cfg({ probe: true }), store, respond: goodTranslator });
    await new Promise((res) => setTimeout(res, 1800));
    assertEqual(r2.notifications.length, 0, '第二次不再弹');
  });

  await check('诊断里的时间对账字段：sub.durMs / chunks.coverMs', async () => {
    const body = json3([
      { tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'first line here' }] },
      { tStartMs: 5000, dDurationMs: 1000, segs: [{ utf8: 'second line here' }] },
      { tStartMs: 10000, dDurationMs: 1000, segs: [{ utf8: 'third line here' }] },
    ]);
    const { store } = await runScript({ url: JSON_URL, body, config: cfg({ probe: true }), respond: goodTranslator });
    const d = JSON.parse(store.get('llmsubs.diag'))[0];
    assertEqual(d.sub.durMs, 10000, '整轨末尾的时间');
    assertEqual(d.chunks.coverMs, 10000, '最后一条有中文的 cue 的时间');
    const { store: s2 } = await runScript({ url: XML_URL, body: FIX('asr.jp.xml'), config: cfg({ probe: true }), respond: goodTranslator });
    const d2 = JSON.parse(s2.get('llmsubs.diag'))[0];
    assert(typeof d2.sub.durMs === 'number' && d2.sub.durMs > 0, 'srv3 也能从 t= 取到时间');
  });

  section('宽限期：有补翻时到点用缓存交回');

  await check('有补翻且开头已缓存：宽限期到点不再陪在途批次等，用缓存交回，在途那批进待翻队列', async () => {
    // 缓存已覆盖大部分、只剩一批在翻时，陪它等下去会逼近 App 的放弃时限（约 4.5 秒）：宽限期到点就该用缓存交回
    const store = new Map();
    await runScript({ url: BF_URL, body: json3(bfEvents(40)), config: cfg({ cache: true }), store, respond: goodTranslator });   // 前两批进缓存
    store.set('llmsubs.cron.n', '3'); store.set('llmsubs.cron.last', String(Date.now()));   // cron 最近在跑（存活章）
    const t = Date.now();
    const r = await runScript({
      url: BF_URL, body: json3(bfEvents(60)), config: cfg({ cache: true, probe: true, fastBudgetMs: 1000 }), store,
      respond: (o) => ({ ...goodTranslator(o), delay: 5000 }),   // 第三批要 5 秒
    });
    const ms = Date.now() - t;
    assert(ms < 2500, '宽限期到点就该交回，实际 ' + ms + 'ms');
    const doc = JSON.parse(r.result.body);
    assert(doc.events[0].segs[0].utf8.includes('[zh]'), '缓存的两批有中文');
    assert(!doc.events[59].segs[0].utf8.includes('[zh]'), '在途那批保持英文');
    const d = JSON.parse(store.get('llmsubs.diag')).pop();
    assert(/用缓存交回/.test(d.chunks.via), '记下是哪条路径：' + d.chunks.via);
    assertEqual(d.backfill.queued, 1, '在途那批进待翻队列，cron 一分钟内补上');
    // 两种「没有补翻」的情况都不拿缓存交回，等在途批次 / 硬上限：
    //   ① backfill 关着；② backfill 开着但 cron 五分钟内没跑过（小火箭没调度它 / 存活章过期）
    const s2 = new Map(), s3 = new Map();
    await runScript({ url: BF_URL, body: json3(bfEvents(40)), config: cfg({ cache: true, backfill: false }), store: s2, respond: goodTranslator });
    await runScript({ url: BF_URL, body: json3(bfEvents(40)), config: cfg({ cache: true }), store: s3, respond: goodTranslator });
    s3.set('llmsubs.cron.n', '50'); s3.set('llmsubs.cron.last', String(Date.now() - 6 * 60000));   // 六分钟前，过期
    let settled2 = false, settled3 = false;
    const slow = (o) => ({ ...goodTranslator(o), delay: 5000 });
    const p2 = runScript({ url: BF_URL, body: json3(bfEvents(60)), config: cfg({ cache: true, backfill: false, fastBudgetMs: 1000 }), store: s2, respond: slow })
      .then((x) => { settled2 = true; return x; });
    const p3 = runScript({ url: BF_URL, body: json3(bfEvents(60)), config: cfg({ cache: true, fastBudgetMs: 1000 }), store: s3, respond: slow })
      .then((x) => { settled3 = true; return x; });
    await new Promise((res) => setTimeout(res, 2500));
    assert(!settled2, 'backfill 关着：宽限期不拿缓存交回（等在途批次落地进缓存，否则缓存永远长不大）');
    assert(!settled3, 'cron 没在跑：同样不拿缓存交回（在途批次进了队列也没人补）');
    await p2; await p3;
  });
};
