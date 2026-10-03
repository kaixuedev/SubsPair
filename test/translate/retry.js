'use strict';
/*
 * 模型交回的东西不对时怎么办：漏行就拆批重试，整批回显就当没翻。
 *
 *   · 模型漏行：拆批重试　前半是拆批与错位译文的保守判据；后半是档位路由：
 *     首次请求走速度档、m 域的重复请求才进质量档、App 的重复请求仍走速度档。档位路由另有
 *     两条在 waves.js（整条轨已缓存的重复请求秒回、放行的请求不把下一次推进质量档）、
 *     一条在 backfill.js（请求计数按轨不按视频）
 *   · 整批回显检测　模型把英文原文当译文交回来：不渲染、不入缓存、拆批重试；
 *     专名、代码、缩写合法保留英文的批不能误伤
 *
 * 单跑本文件会比看上去慢约 30 秒：「速度档一批都没落地时…」那条用例的假端点 30 秒后才回，
 * 用例本身早就断言完了，但那个定时器让进程多挂 30 秒才退出。不是卡住。
 */

const { check, assert, assertEqual, section } = require('../lib/harness');
const {
  runScript, SCRIPT, cfg, JSON_URL, M_JSON_URL, json3,
  readSubs, goodTranslator, dropNth,
} = require('../lib/sandbox');

module.exports = async function () {
  section('模型漏行：拆批重试');

  await check('【回归】条数不匹配 → 对半拆开重试而不是整批丢弃', async () => {
    // 批越大模型越容易漏行；同样的内容拆成小批通常就能按格式交回，所以拆小就能救回来
    const events = [];
    for (let i = 0; i < 12; i++) events.push({ tStartMs: i * 2000, dDurationMs: 1500, segs: [{ utf8: 'line number ' + i }] });
    const { result, calls } = await runScript({
      url: JSON_URL, body: json3(events), config: cfg({ chunkSize: 12, concurrency: 1 }),
      respond: (o) => {
        const lines = readSubs(o);
        if (lines.length > 6) {
          // 大批次故意漏一行，模拟真实模型行为
          const out = lines.slice(0, -1).map((l) => l.match(/^(\d+)\|/)[1] + '|译');
          return { status: 200, body: JSON.stringify({ choices: [{ message: { content: out.join('\n') }, finish_reason: 'stop' }] }) };
        }
        return goodTranslator(o);
      },
    });
    assert(calls.length >= 3, '应当拆批重试，实际只发了 ' + calls.length + ' 次');
    assert(result && result.body, '拆批后应当能产出结果');
    const doc = JSON.parse(result.body);
    const done = doc.events.filter((e) => e.segs[0].utf8.includes('\n')).length;
    assertEqual(done, 12, '拆小之后 12 条都该翻出来，实际 ' + done);
  });

  await check('拆批也救不回来时，该半保持英文而不是污染整轨', async () => {
    const events = [];
    for (let i = 0; i < 8; i++) events.push({ tStartMs: i * 2000, dDurationMs: 1500, segs: [{ utf8: 'line number ' + i }] });
    const { result } = await runScript({
      url: JSON_URL, body: json3(events), config: cfg({ chunkSize: 8, concurrency: 1 }),
      // 永远少回一行，拆到底也不匹配
      respond: (o) => {
        const lines = readSubs(o);
        const out = lines.slice(0, -1).map((l) => l.match(/^(\d+)\|/)[1] + '|译');
        return { status: 200, body: JSON.stringify({ choices: [{ message: { content: out.join('\n') }, finish_reason: 'stop' }] }) };
      },
    });
    if (result && result.body) {
      const doc = JSON.parse(result.body);
      for (const e of doc.events) {
        assert(e.segs[0].utf8.split('\n').length <= 2, '不能出现超过两行的 cue');
      }
    }
  });

  const bilingual = (body) => JSON.parse(body).events.filter((e) => e.segs[0].utf8.includes('\n')).length;

  // 下面两条是一对：批次大小完全相同，只差「漏掉的是中间那行还是最后那行」，
  // 结果却必须不同。漏中间 → 序号没前移，其余几条对得上，保留；漏末尾 → 疑似
  // 合并漏，后续序号可能整体前移，接受就会把译文错位贴到别的字幕上，宁可全英文。
  await check('逐条漏且拆不动时，保留已译部分而不是整批退回英文', async () => {
    const events = [];
    for (let i = 0; i < 3; i++) events.push({ tStartMs: i * 2000, dDurationMs: 1500, segs: [{ utf8: 'line number ' + i }] });
    // chunkSize 3 → n < 4，拆批重试的闸门关着，只能靠 partial 兜底
    const { result } = await runScript({
      url: JSON_URL, body: json3(events), config: cfg({ chunkSize: 3, concurrency: 1 }),
      respond: dropNth('middle'),
    });
    assert(result && result.body, '应当产出结果而不是放行');
    assertEqual(bilingual(result.body), 2, '漏掉的那条保持英文，另外两条该照常翻出来');
    const doc = JSON.parse(result.body);
    assert(!doc.events[1].segs[0].utf8.includes('\n'), '保持英文的应当正是被漏掉的第 2 条');
  });

  await check('【回归】漏掉末尾一条时绝不接受错位译文，宁可整批英文', async () => {
    const events = [];
    for (let i = 0; i < 3; i++) events.push({ tStartMs: i * 2000, dDurationMs: 1500, segs: [{ utf8: 'line number ' + i }] });
    const { result } = await runScript({
      url: JSON_URL, body: json3(events), config: cfg({ chunkSize: 3, concurrency: 1 }),
      respond: dropNth('tail'),
    });
    if (result && result.body) {
      assertEqual(bilingual(result.body), 0, '尾号缺失说明序号可能整体前移，一条都不能要');
    }
  });

  await check('【回归】模型合并行且自身编号也漏一号时，绝不能渲染出错位译文', async () => {
    /* 「尾号缺失但号码里有空档」不能当成「模型沿用了送去的编号、剩下的行可以用」：
       模型完全可以既合并行（重新编号、整体前移）、又在自己的编号里漏掉一号，
       空档照样出现而内容已经错位。这条输入正是这种情形，接受的话会渲染出 5 条错位译文。
       错位的中文比整条英文更糟：看的人分不出哪句对不上。 */
    const WORDS = ['alpha one', 'bravo two', 'charlie three', 'delta four',
                   'echo five', 'foxtrot six', 'golf seven', 'hotel eight'];
    const events = WORDS.map((w, i) => ({ tStartMs: i * 2000, dDurationMs: 1500, segs: [{ utf8: w }] }));
    const { result } = await runScript({
      url: JSON_URL, body: json3(events), config: cfg({ chunkSize: 8, concurrency: 1 }),
      respond: (o) => {
        const lines = readSubs(o);
        // 子批（拆批重试）一律不跟格式，保证救不回来，考的才是主批的判据
        if (lines.length < 4) {
          return { status: 200, body: JSON.stringify({ choices: [{ message: { content: '没跟格式' }, finish_reason: 'stop' }] }) };
        }
        // 把原文 1+2 合并成输出 1，此后整体前移；且输出的 3 号忘了写 "3|" 前缀
        const out = ['1|译文-合并(1+2)'];
        for (let src = 3; src <= lines.length; src++) {
          const num = src - 1;
          out.push(num === 3 ? '译文-原文' + src : num + '|译文-原文' + src);
        }
        return { status: 200, body: JSON.stringify({ choices: [{ message: { content: out.join('\n') }, finish_reason: 'stop' }] }) };
      },
    });
    // 放行（不改写）是可以接受的；一旦改写，每条译文都必须贴在它自己的原文上
    if (result && result.body) {
      JSON.parse(result.body).events.forEach((e, i) => {
        const parts = e.segs.map((s) => s.utf8).join('').split('\n');
        if (parts.length < 2) return;                 // 保持英文，没问题
        const m = parts[1].match(/原文(\d+)/);
        if (m) assertEqual(+m[1], i + 1, '第 ' + (i + 1) + ' 条贴上了原文 ' + m[1] + ' 的译文——错位了');
      });
    }
  });

  await check('硬失败按原因分开计数（否则无从判断保守判据挡下了多少译文）', async () => {
    const events = [];
    for (let i = 0; i < 3; i++) events.push({ tStartMs: i * 2000, dDurationMs: 1500, segs: [{ utf8: 'line number ' + i }] });
    const { store } = await runScript({
      url: JSON_URL, body: json3(events),
      config: cfg({ chunkSize: 3, concurrency: 1, probe: true }), respond: dropNth('tail'),
    });
    const r = JSON.parse(store.get('llmsubs.diag'))[0];
    assertEqual(r.ev.countMismatch, 1, '总数仍该计');
    assertEqual(r.ev.mmTail, 1, '尾号缺失应当单独计入 mmTail');
    assert(!r.ev.mmDup && !r.ev.mmEmpty, '不该误计成重号或全空');
    assertEqual(r.mmSeen, '2/3', 'mmSeen 要记下「解出几条 / 送了几条」——它衡量被白白丢掉的量');
  });

  await check('逐条漏时拆批重试仍然优先：预算够就把漏的那条也补回来', async () => {
    const events = [];
    for (let i = 0; i < 12; i++) events.push({ tStartMs: i * 2000, dDurationMs: 1500, segs: [{ utf8: 'line number ' + i }] });
    const { result, calls } = await runScript({
      url: JSON_URL, body: json3(events), config: cfg({ chunkSize: 12, concurrency: 1 }),
      // 大批次漏中间一条，拆小之后正常回
      respond: (o) => (readSubs(o).length > 6 ? dropNth('middle')(o) : goodTranslator(o)),
    });
    assert(calls.length >= 3, '有预算时应当拆批重试，实际只发了 ' + calls.length + ' 次');
    assertEqual(bilingual(result.body), 12, '拆批补齐后 12 条都该有译文');
  });

  await check('部分结果不落缓存：下一次重复请求还有机会译全', async () => {
    const events = [];
    for (let i = 0; i < 3; i++) events.push({ tStartMs: i * 2000, dDurationMs: 1500, segs: [{ utf8: 'line number ' + i }] });
    const body = json3(events);
    const store = new Map();
    const conf = cfg({ chunkSize: 3, concurrency: 1, cache: true });
    const first = await runScript({ url: JSON_URL, body, config: conf, store, respond: dropNth('middle') });
    assertEqual(bilingual(first.result.body), 2, '第一轮应当是部分译文');
    // 同一个 store 再跑一次，这次端点正常
    const second = await runScript({ url: JSON_URL, body, config: conf, store, respond: goodTranslator });
    assert(second.calls.length > 0, '部分结果若落了缓存，第二轮就会直接命中、一次请求都不发');
    assertEqual(bilingual(second.result.body), 3, '第二轮该把三条都翻出来');
  });

  await check('【回归】拆批后只成了一半：合并结果不落缓存，下一次把缺的那半补上', async () => {
    /* 整批漏尾号 → 拆成两半重试；一半译成，另一半撞上临时限流。
       把「一半有译文、一半全空」的合并结果写进缓存的话，这一批之后都会直接命中，
       空的那半要等缓存过期才有机会重翻，也进不了待翻队列。前半失败与后半失败各跑一遍。 */
    const N = 12;
    const RATE_LIMITED = { status: 429, body: '{"error":{"message":"rate limit"}}' };
    for (const failing of ['后半', '前半']) {
      const events = [];
      for (let i = 0; i < N; i++) events.push({ tStartMs: i * 2000, dDurationMs: 1500, segs: [{ utf8: 'half line number ' + (i + 1) }] });
      const body = json3(events);
      const store = new Map();
      const conf = cfg({ chunkSize: N, concurrency: 1, cache: true });
      const first = await runScript({
        url: JSON_URL, body, config: conf, store,
        respond: (o) => {
          const lines = readSubs(o);
          if (lines.length === N) return dropNth('tail')(o);            // 整批：漏尾号，走拆批
          const isFront = /number 1$/.test(lines[0]);
          return isFront === (failing === '前半') ? RATE_LIMITED : goodTranslator(o);
        },
      });
      assertEqual(bilingual(first.result.body), N / 2, failing + '失败，前提：第一轮只有另一半有译文');
      // 出问题的中间态：缓存里不该有「整批 N 行、其中一半是空」的记录
      for (const [k, v] of store) {
        if (!/^llmsubs\.c\./.test(k)) continue;
        const rec = JSON.parse(v);
        assert(!(rec.v && rec.v.length === N), failing + '失败：只成了一半的整批不该落缓存（整批 ' + N + ' 行的记录里有一半是空的）');
      }
      assertEqual([...store.keys()].filter((k) => k.startsWith('llmsubs.bf.') && store.get(k)).length, 1,
        failing + '失败：只成了一半的整批还得排进待翻队列，否则后台不会去补缺的那半');
      // 同一个 store 再跑一次，这次端点正常
      const second = await runScript({ url: JSON_URL, body, config: conf, store, respond: goodTranslator });
      assert(second.calls.length > 0, failing + '失败：缺的那半该重发；一次请求都没发，说明带空的整批被当成缓存命中了');
      assertEqual(bilingual(second.result.body), N, failing + '失败：第二轮该把 ' + N + ' 条都翻出来');
      assert(second.calls.every((c) => readSubs(c).length < N), failing + '失败：另一半已在缓存里，第二轮只该补发缺的那半，不该整批重发');
    }
  });

  await check('【回归】拆批后有一半自己又只成了一半：整批同样不落缓存，下一次只补缺的那几行', async () => {
    const N = 12;
    const events = [];
    for (let i = 0; i < N; i++) events.push({ tStartMs: i * 2000, dDurationMs: 1500, segs: [{ utf8: 'nested line number ' + (i + 1) }] });
    const body = json3(events);
    const store = new Map();
    const conf = cfg({ chunkSize: N, concurrency: 1, cache: true });
    const first = await runScript({
      url: JSON_URL, body, config: conf, store,
      respond: (o) => {
        const lines = readSubs(o);
        if (lines.length === N) return dropNth('tail')(o);                                   // 整批：漏尾号，走拆批
        if (lines.length === 6 && /number 1$/.test(lines[0])) return dropNth('tail')(o);     // 前半：还是漏尾号，再拆一层
        if (lines.length === 3 && /number 4$/.test(lines[0])) return { status: 429, body: '{"error":{"message":"rate limit"}}' };   // 前半的后一小半：临时限流
        return goodTranslator(o);
      },
    });
    assertEqual(bilingual(first.result.body), 9, '前提：第一轮缺的正是那三行');
    for (const [k, v] of store) {
      if (!/^llmsubs\.c\./.test(k)) continue;
      const rec = JSON.parse(v);
      assert(!(rec.v && rec.v.indexOf('') >= 0), '带空行的合并结果不该落缓存（有一条记录里带着空行）');
    }
    const second = await runScript({ url: JSON_URL, body, config: conf, store, respond: goodTranslator });
    assert(second.calls.length > 0, '缺的那三行该重发；一次请求都没发，说明带空的整批被当成缓存命中了');
    assertEqual(bilingual(second.result.body), N, '第二轮该把 ' + N + ' 条都翻出来');
    assert(second.calls.every((c) => readSubs(c).length === 3), '译好的部分已在缓存里：第二轮只该补发缺的那三行');
  });

  await check('【回归】缓存热但本次会话首次请求 → 仍走速度档，绝不扣 18 秒', async () => {
    /* 从历史进度重开一个看过的视频：缓存是热的，但播放器手上一条轨都没有。
       「开头在不在缓存里」不能用来判断是不是第一次请求——缓存跨会话持久。
       误判成重复请求就会进 18 秒质量档 = 18 秒黑屏。 */
    const events = [];
    for (let i = 0; i < 60; i++) events.push({ tStartMs: i * 2000, dDurationMs: 1500, segs: [{ utf8: 'warm cache line ' + i }] });
    const body = json3(events);
    const store = new Map();
    const conf = cfg({ chunkSize: 10, concurrency: 4, probe: true, cache: true });
    await runScript({ url: JSON_URL, body, config: conf, store, respond: goodTranslator });
    // 模拟「新会话」：缓存留着，但请求计数清空
    store.delete('llmsubs.seen');
    const { store: s2 } = await runScript({ url: JSON_URL, body, config: conf, store, respond: goodTranslator });
    const recs = JSON.parse(s2.get('llmsubs.diag'));
    const last = recs[recs.length - 1];
    assertEqual(last.reqNo, 1, '清掉计数后应当被视为本次会话的第一次请求');
    assertEqual(last.chunks.mode, 'f', '首次请求必须走速度档——扣响应的每毫秒都是黑屏');
  });

  await check('重复请求（播放器已有轨）才进质量档', async () => {
    const events = [];
    for (let i = 0; i < 60; i++) events.push({ tStartMs: i * 2000, dDurationMs: 1500, segs: [{ utf8: 'repeat line ' + i }] });
    const body = json3(events);
    const store = new Map();
    const conf = cfg({ chunkSize: 10, concurrency: 4, probe: true, cache: true });
    await runScript({ url: M_JSON_URL, body, config: conf, store, respond: goodTranslator });
    const { store: s2 } = await runScript({ url: M_JSON_URL, body, config: conf, store, respond: goodTranslator });
    const recs = JSON.parse(s2.get('llmsubs.diag'));
    const last = recs[recs.length - 1];
    assertEqual(last.reqNo, 2, '同一条轨的第二次请求');
    assertEqual(last.clientWaits, true, 'm 域的播放器会等');
    assertEqual(last.chunks.mode, 'q', '浏览器已有轨且会等，扣多久都不阻塞画面，应当放开预算');
  });

  await check('【回归】App（www）的重复请求是用户点 CC，必须仍走速度档并有 4.2s 天花板', async () => {
    /* App 的重复请求来自 CC 开关：每点一次 CC，App 就重新请求一次字幕轨，这时播放器手上
       没有轨、是前台请求。App 大约等 4.5 秒就放弃，并报「字幕加载错误」——中英文都没有。
       质量档没有速度档那三个到点交回的定时器（预算、宽限期、硬上限），最长会扣 18 秒。
       所以 www 上「刚刚才请求过」不能当成后台刷新，必须仍走速度档。 */
    const hard = +(SCRIPT.match(/var FAST_HARD_MS = (\d+)/) || [])[1];
    assert(hard > 0 && hard < 4500, '应当能从源码读到 FAST_HARD_MS 且低于 App 忍耐阈值');
    const events = [];
    for (let i = 0; i < 60; i++) events.push({ tStartMs: i * 2000, dDurationMs: 1500, segs: [{ utf8: 'cc toggle line ' + i }] });
    const body = json3(events);

    // ① todo 为 0（整条轨已缓存）：必须立刻交回，不能为了升级通道扣住响应。
    //   fastBudgetMs 必须用默认值：写 1000 的话升级通道的准入（now + 2×expectedCallMs < DEADLINE）
    //   会因预算太小而天然为假，「不跑升级」的断言就怎么改都是绿的，等于没检验。
    const store = new Map();
    const conf = cfg({ chunkSize: 10, probe: true, cache: true });
    await runScript({ url: JSON_URL, body, config: conf, store, respond: goodTranslator });
    const t0 = Date.now();
    const r2 = await runScript({ url: JSON_URL, body, config: conf, store, respond: (o) => Object.assign(goodTranslator(o), { delay: 6000 }) });
    const e2 = Date.now() - t0;
    const recs = JSON.parse(r2.store.get('llmsubs.diag'));
    const last = recs[recs.length - 1];
    assertEqual(last.recentRepeat, true, '确实是 2 分钟内的重复请求');
    assertEqual(last.clientWaits, false, 'www 的播放器不会等');
    assertEqual(last.chunks.mode, 'f', 'App 的重复请求必须走速度档');
    assertEqual(r2.calls.length, 0, '整条轨已缓存时不得为了升级去打端点');
    assert(e2 < 800, '整条轨已缓存时必须立刻交回，实际 ' + e2 + 'ms');
    assertEqual(JSON.parse(r2.result.body).events.filter((e) => e.segs[0].utf8.includes('[zh]')).length, 60, '交回的是全量双语');

    // ② 还有没翻的、端点却很慢：必须在 FAST_HARD_MS 内带着缓存部分交回，不能等 18 秒。
    const store2 = new Map();
    // backfill: false —— 这段测的是「没有补翻时的硬上限兜底」；有补翻时宽限期就用缓存交回，硬上限根本不参与
    const conf2 = cfg({ chunkSize: 10, concurrency: 2, probe: true, cache: true, fastBudgetMs: 1000, backfill: false });
    // 端点 600ms 才回：首波 2 批落地后已过了准入线（now + expectedCallMs > 1000ms），只翻了 2 批
    await runScript({ url: JSON_URL, body, config: conf2, store: store2, respond: (o) => Object.assign(goodTranslator(o), { delay: 600 }) });
    const t1 = Date.now();
    const r3 = await runScript({ url: JSON_URL, body, config: conf2, store: store2, respond: (o) => Object.assign(goodTranslator(o), { delay: 6000 }) });
    const e3 = Date.now() - t1;
    const last3 = JSON.parse(r3.store.get('llmsubs.diag')).slice(-1)[0];
    assertEqual(last3.chunks.mode, 'f', '第二次仍是速度档');
    // 裕量取 1.5s：它要防的回归（误进质量档）落在 6s（worker 自然结算）到 18s（看门狗），
    // 这么宽不损失检出；只留 500ms 的话仅够事件循环过冲，高负载下会假红。
    assert(e3 < hard + 1500, '必须在 FAST_HARD_MS 内交回，实际 ' + e3 + 'ms');
    assert(r3.result && r3.result.body, '到点要带着已缓存的部分渲染，而不是空手放行');
    const zh3 = JSON.parse(r3.result.body).events.filter((e) => e.segs[0].utf8.includes('[zh]')).length;
    assertEqual(zh3, 20, '缓存里的 2 批（20 条）必须出现在交回的轨里');
  });

  await check('【回归】隔了很久的「重复请求」是新会话，必须回落速度档', async () => {
    /* 从历史进度接着看时，不能出现「英文正常、中文一条都没有」。
       只凭 REQ_NO > 1 判不出「播放器手上已有轨」：记 REQ_NO 的 seen 表跨会话持久，
       看一半退出、几小时后从历史进度点回来，REQ_NO 已经是 2，就会被判成后台刷新、
       进 18 秒质量档——可播放器手上什么都没有，等于扣十几秒，App 放弃后拿到未改写的
       原始响应，中文全丢。
       和「开头在不在缓存里」是同一类错：拿跨会话持久的状态推断播放器此刻的状态。
       判据必须带时间维度。 */
    const recent = +(SCRIPT.match(/var RECENT_REQ_MS = (\d+)/) || [])[1];
    assert(recent > 0, '应当能从源码读到 RECENT_REQ_MS');
    const events = [];
    for (let i = 0; i < 60; i++) events.push({ tStartMs: i * 2000, dDurationMs: 1500, segs: [{ utf8: 'resume line ' + i }] });
    const body = json3(events);
    const store = new Map();
    const conf = cfg({ chunkSize: 10, concurrency: 4, probe: true, cache: true });
    await runScript({ url: JSON_URL, body, config: conf, store, respond: goodTranslator });
    // 把「上次请求时刻」推到很久以前，模拟隔了几小时再从历史进度点进来
    const seen = JSON.parse(store.get('llmsubs.seen'));
    seen.forEach((s) => { s.t = Date.now() - recent - 60000; });
    store.set('llmsubs.seen', JSON.stringify(seen));
    const { store: s2 } = await runScript({ url: JSON_URL, body, config: conf, store, respond: goodTranslator });
    const recs = JSON.parse(s2.get('llmsubs.diag'));
    const last = recs[recs.length - 1];
    assert(last.reqNo > 1, '计数仍然累加（它记的是「第几次」，不是「多久前」）');
    assertEqual(last.recentRepeat, false, '隔了这么久就不能算「刚刚才请求过」');
    assertEqual(last.chunks.mode, 'f', '新会话的第一次请求必须走速度档，绝不能扣 18 秒');
  });

  await check('【回归】速度档翻「还没翻过的」而不是「位置在开头的」', async () => {
    /* 速度档不能按位置截断（只排开头那几批、序号超过开头那一段就不排队）：
       App 的请求一律走速度档，进不了质量档；按位置截断的话，长视频每次都只翻开头，
       中间和末尾永远排不上队。所以要排的是「还没翻过的」批。 */
    const events = [];
    for (let i = 0; i < 300; i++) events.push({ tStartMs: i * 2000, dDurationMs: 1500, segs: [{ utf8: 'deadlock line ' + i }] });
    const body = json3(events);
    const store = new Map();
    const conf = cfg({ chunkSize: 20, concurrency: 8, probe: true, cache: true, fastBudgetMs: 20000 });
    // 第一轮把开头翻掉
    await runScript({ url: JSON_URL, body, config: conf, store, respond: goodTranslator });
    // 新会话（缓存热、reqNo 归 1 → 速度档），必须继续往后推进而不是原地打转
    store.delete('llmsubs.seen');
    const { result } = await runScript({ url: JSON_URL, body, config: conf, store, respond: goodTranslator });
    const doc = JSON.parse(result.body);
    const beyondHead = doc.events.slice(220).filter((e) => e.segs.map((s) => s.utf8).join('').includes('[zh]')).length;
    assert(beyondHead > 0, '开头之外（第 220 条起）必须也能翻到，否则中段与末尾永远排不上队');
  });

  await check('【回归】速度档一批都没落地时，也必须在 App 放弃前交回（绝不黑屏等看门狗）', async () => {
    /* 速度档的窗口可能比单批往返还短，截止那一刻一批都没落地。宽限期到点时手上没有
       新译文可渲染，如果就此不管、等全局看门狗（18 秒）来兜底，响应会被扣住 18 秒；
       App 大约等 4.5 秒就放弃 → 整条字幕轨加载失败 → 完全没有字幕。
       英文字幕是真内容，空白不是：宁可放行给英文，也绝不能黑屏等到 App 放弃。 */
    const hard = +(SCRIPT.match(/var FAST_HARD_MS = (\d+)/) || [])[1];
    assert(hard > 0, '应当能从源码读到 FAST_HARD_MS');
    assert(hard < 4500, 'FAST_HARD_MS 必须低于 App 约 4.5s 的忍耐阈值，否则等于没兜住');
    const events = [];
    for (let i = 0; i < 20; i++) events.push({ tStartMs: i * 2000, dDurationMs: 1500, segs: [{ utf8: 'never lands ' + i }] });
    const t0 = Date.now();
    const { result } = await runScript({
      url: JSON_URL, body: json3(events),
      config: cfg({ chunkSize: 20, concurrency: 1, budgetMs: 18000, requestTimeout: 30 }),
      // 永远不在窗口内返回
      respond: (o) => Object.assign(goodTranslator(o), { delay: 30000 }),
    });
    const elapsed = Date.now() - t0;
    assert(elapsed < hard + 1200,
      '必须在 FAST_HARD_MS(' + hard + ') 前后交回，实际等了 ' + elapsed + 'ms（黑屏这么久 App 早放弃了）');
    // 交回的可以是放行（原始英文）或部分渲染，但绝不能是「什么都没有」
    if (result && result.body) {
      assert(result.body.length > 0, '交回的响应体不能是空的');
    }
  });

  await check('【回归】单次运行的 LLM 请求数有硬上限', async () => {
    const events = [];
    // 380 条 ÷ 每批 2 条 = 190 批，远低于批次数上限（MAX_CHUNKS），
    // 这样考的才是请求数预算本身，而不是批次数上限
    for (let i = 0; i < 380; i++) events.push({ tStartMs: i * 2000, dDurationMs: 1500, segs: [{ utf8: 'line number ' + i }] });
    let n = 0;
    await runScript({
      url: JSON_URL, body: json3(events),
      config: cfg({ chunkSize: 2, concurrency: 8, budgetMs: 15000 }),
      respond: (o) => { n++; return goodTranslator(o); },
    });
    assert(n <= 300, '不管怎么分批都不该超过 300 次，实际 ' + n);
    assert(n > 0, '应当有请求');
  });

  section('整批回显检测（模型把英文原文当译文交回来）');

  // 自拟的英文口语：每行至少两个词、含虚词，属于「本该被翻译的句子」
  const PROSE = ['I think we should go now', 'what do you want from me', 'she was not in the room', 'this is the best day of my life',
    'do you know where they are', 'we have to talk about it', 'he did not say that to her', 'there is no way out of here'];
  const evOf = (lines) => lines.map((t, i) => ({ tStartMs: i * 2000, dDurationMs: 1500, segs: [{ utf8: t }] }));
  const chatReply = (msg) => ({ status: 200, body: JSON.stringify({ choices: [{ message: msg, finish_reason: 'stop' }] }) });
  // 「N|原文」原样交回。field：回显出现在正文还是思考字段
  const echoReply = (o, field) => { const msg = { content: null }; msg[field || 'content'] = readSubs(o).join('\n'); return chatReply(msg); };
  // 正常译文（含汉字）；keep(text) 为真的行原样保留英文
  const zhReply = (o, keep) => chatReply({ content: readSubs(o).map((l) => { const m = l.match(/^(\d+)\|([\s\S]*)$/); return m[1] + '|' + (keep && keep(m[2]) ? m[2] : '这是第' + m[1] + '行的译文'); }).join('\n') });
  const valueRecs = (store) => [...store].filter(([k, v]) => k.startsWith('llmsubs.c.') && v && Array.isArray(JSON.parse(v).v)).map(([k, v]) => [k, JSON.parse(v)]);
  const evCount = (store, name) => JSON.parse(store.get('llmsubs.diag') || '[]').reduce((n, d) => n + ((d.ev && d.ev[name]) || 0), 0);
  // 汉字判定（CJK 统一表意文字基本区 U+4E00–U+9FFF）：范围两端用码点数值经 fromCharCode 拼出，范围一眼看得清
  const HAS_HAN = new RegExp('[' + String.fromCharCode(0x4e00) + '-' + String.fromCharCode(0x9fff) + ']');
  const translated = (result) => JSON.parse(result.body).events.filter((e) => e.segs[0].utf8.includes('\n')).length;
  // 一条都没译成时脚本原样放行（$done 不带参数，result 是 undefined）：两种形态都算「没有渲染译文」
  const noneTranslated = (result) => !result || !result.body || translated(result) === 0;
  // 上英下英：第二行不含汉字
  const echoRendered = (result) => (!result || !result.body) ? 0 : JSON.parse(result.body).events.filter((e) => { const p = e.segs[0].utf8.split('\n'); return p.length > 1 && !HAS_HAN.test(p[1]); }).length;

  await check('正文为空、思考字段里逐行复述原文：不当译文用、不入缓存，拆批重试后译全', async () => {
    const store = new Map();
    const { result, calls } = await runScript({ url: JSON_URL, body: json3(evOf(PROSE)), store, config: cfg({ cache: true, chunkSize: 8, concurrency: 1 }),
      respond: (o, n) => (n === 1 ? echoReply(o, 'reasoning_content') : zhReply(o)) });
    assert(calls.length >= 3, '第一次被拒后应当拆批重试，实际 ' + calls.length + ' 次');
    assertEqual(translated(result), 8, '重试后 8 行都该有译文');
    assertEqual(evCount(store, 'echoBatch'), 1, '记一次 echoBatch');
    for (const [, rec] of valueRecs(store)) assert(rec.v.every((v) => HAS_HAN.test(v)), '缓存里不得有英文回显：' + JSON.stringify(rec.v));
  });

  await check('正文整批回显：不渲染成上英下英、不入缓存；拆不动的小批保持英文，下次还会重试', async () => {
    const store = new Map();
    const three = PROSE.slice(0, 3);   // 3 行：够得上「≥ 3 行」的门槛，又小到拆不了（n < 4）
    const r1 = await runScript({ url: JSON_URL, body: json3(evOf(three)), store, config: cfg({ cache: true, concurrency: 1 }), respond: (o) => echoReply(o) });
    assert(noneTranslated(r1.result), '回显不能被当成译文渲染');
    assertEqual(valueRecs(store).length, 0, '回显不落缓存');
    assertEqual(evCount(store, 'echoBatch'), 1);
    const r2 = await runScript({ url: JSON_URL, body: json3(evOf(three)), store, config: cfg({ cache: true, concurrency: 1 }), respond: (o) => zhReply(o) });
    assertEqual(r2.calls.length, 1, '没进缓存，所以下一次照常重试');
    assertEqual(translated(r2.result), 3);
  });

  await check('正文整批回显的大批：当场拆批重试，合并后的译文入缓存', async () => {
    const store = new Map();
    const { result, calls } = await runScript({ url: JSON_URL, body: json3(evOf(PROSE)), store, config: cfg({ cache: true, chunkSize: 8, concurrency: 1 }),
      respond: (o, n) => (n === 1 ? echoReply(o) : zhReply(o)) });
    assertEqual(calls.length, 3, '1 次回显 + 两半各 1 次');
    assertEqual(translated(result), 8);
    assert(valueRecs(store).some(([, rec]) => rec.v.length === 8 && rec.v.every((v) => HAS_HAN.test(v))), '合并后的整批译文入缓存');
  });

  await check('单条专名等于原文：放行并入缓存（术语表约定「译文与原文相同 = 保留英文」）', async () => {
    const store = new Map();
    const lines = PROSE.slice(0, 5).concat(['Tim Cook']);
    const { result, calls } = await runScript({ url: JSON_URL, body: json3(evOf(lines)), store, config: cfg({ cache: true, concurrency: 1 }),
      respond: (o) => zhReply(o, (t) => t === 'Tim Cook' || t === PROSE[0]) });   // 再带一条句子也原样保留：两条回显够不到门槛
    assertEqual(calls.length, 1, '不该触发重试');
    assertEqual(evCount(store, 'echoBatch'), 0);
    const recs = valueRecs(store);
    assertEqual(recs.length, 1, '正常入缓存'); assertEqual(recs[0][1].v[5], 'Tim Cook');
    assertEqual(translated(result), 6);
  });

  await check('全是专名、代码、缩写的批：整批等于原文也不误伤', async () => {
    const store = new Map();
    const lines = ['Tim Cook', 'OpenAI GPT-4', 'console.log(x)', 'San Francisco', 'NASA JPL', 'npm install react'];
    const { calls } = await runScript({ url: JSON_URL, body: json3(evOf(lines)), store, config: cfg({ cache: true, concurrency: 1 }), respond: (o) => echoReply(o) });
    assertEqual(calls.length, 1, '不该被判成回显去重试');
    assertEqual(evCount(store, 'echoBatch'), 0);
    assertEqual(valueRecs(store).length, 1, '照常入缓存');
  });

  await check('已被污染的缓存记录：读回算未命中，重译后覆盖', async () => {
    const store = new Map();
    const conf = cfg({ cache: true, concurrency: 1 });
    await runScript({ url: JSON_URL, body: json3(evOf(PROSE.slice(0, 6))), store, config: conf, respond: (o) => zhReply(o) });
    const [key, rec] = valueRecs(store)[0];
    rec.v = PROSE.slice(0, 6);   // 模拟还没有回显检测的版本写进来的整批英文
    store.set(key, JSON.stringify(rec));
    const again = await runScript({ url: JSON_URL, body: json3(evOf(PROSE.slice(0, 6))), store, config: conf, respond: (o) => zhReply(o) });
    assertEqual(again.calls.length, 1, '污染记录不能命中，必须重译');
    assertEqual(evCount(store, 'echoCache'), 1, '同一条记录一次运行会被读两三遍，只计一次');
    assert(JSON.parse(store.get(key)).v.every((v) => HAS_HAN.test(v)), '重译结果覆盖旧记录');
    const third = await runScript({ url: JSON_URL, body: json3(evOf(PROSE.slice(0, 6))), store, config: conf, respond: (o) => zhReply(o) });
    assertEqual(third.calls.length, 0, '覆盖之后正常命中');
  });

  await check('思考兜底的小批：一两行够不到回显门槛，但不含汉字的思考文本同样不用；含汉字的真译文照常采用', async () => {
    const one = json3(evOf([PROSE[1]]));
    const s1 = new Map();
    const r1 = await runScript({ url: JSON_URL, body: one, store: s1, config: cfg({ cache: true }), respond: (o) => echoReply(o, 'reasoning') });
    assertEqual(valueRecs(s1).length, 0, '思考字段里的英文复述不入缓存');
    assert(noneTranslated(r1.result), '思考字段里的英文复述不渲染');
    const s2 = new Map();
    const r2 = await runScript({ url: JSON_URL, body: one, store: s2, config: cfg({ cache: true }), respond: () => chatReply({ content: null, reasoning_content: '1|你想从我这里得到什么' }) });
    assertEqual(translated(r2.result), 1, '思考没关掉的端点上，译文确实只在思考字段里：照常采用');
    assertEqual(valueRecs(s2).length, 1);
  });

  await check('稳定回显的模型：拆到 2 行的叶子批也判得出——任何批大小都不把英文写进缓存、不渲染成上英下英', async () => {
    for (const n of [2, 4, 5, 8]) {
      const store = new Map();
      const conf = cfg({ cache: true, chunkSize: n, concurrency: 1 });
      const body = json3(evOf(PROSE.slice(0, n)));
      const r1 = await runScript({ url: JSON_URL, body, store, config: conf, respond: (o) => echoReply(o) });
      assertEqual(echoRendered(r1.result), 0, 'n=' + n + ' 首次不得上英下英');
      assertEqual(valueRecs(store).length, 0, 'n=' + n + ' 不得有任何译文记录入缓存：' + JSON.stringify(valueRecs(store).map(([, r]) => r.v)));
      const r2 = await runScript({ url: JSON_URL, body, store, config: conf, respond: (o) => zhReply(o) });
      assertEqual(translated(r2.result), n, 'n=' + n + ' 模型恢复正常后照常译全');
    }
  });

  await check('口语短句的整批回显（Shut up / Yeah right 这类不含 the/you/is 的行）同样判得出', async () => {
    const store = new Map();
    const lines = ['Yeah right', 'Shut up', 'Get out of here', 'No kidding', 'Come on', 'Nice try'];
    const r = await runScript({ url: JSON_URL, body: json3(evOf(lines)), store, config: cfg({ cache: true, concurrency: 1 }), respond: (o) => echoReply(o) });
    assert(evCount(store, 'echoBatch') >= 1, '应当判成回显');
    assertEqual(valueRecs(store).length, 0); assertEqual(echoRendered(r.result), 0);
  });

  await check('思考没关的端点上，全是专名或代码的批合法保留英文：思考通道同样不误伤', async () => {
    const store = new Map();
    const lines = ['Tim Cook', 'OpenAI GPT-4', 'console.log(x)', 'San Francisco', 'NASA JPL', 'npm install react'];
    const { calls } = await runScript({ url: JSON_URL, body: json3(evOf(lines)), store, config: cfg({ cache: true, concurrency: 1 }), respond: (o) => echoReply(o, 'reasoning_content') });
    assertEqual(calls.length, 1, '不该被否决去重试');
    assertEqual(evCount(store, 'echoBatch'), 0); assertEqual(valueRecs(store).length, 1, '照常入缓存');
  });

  // ── 回显判定的边界情形 ──
  // 回显 + 同批漏条：漏的必须是中间那条（漏尾条会被 parseNumbered 判成 mmTail 硬失败，够不到回显判定）
  const echoMissingMid = (o) => chatReply({ content: readSubs(o).filter((l, i) => i !== 2).join('\n') });
  // 译文含汉字、但把原文也抄在后面：含汉字 = 它翻了，不该按回显丢批
  const zhPlusEcho = (o) => chatReply({ content: readSubs(o).map((l) => { const m = l.match(/^(\d+)\|([\s\S]*)$/); return m[1] + '|译文在这里 ' + m[2]; }).join('\n') });

  await check('只有两条保留英文：够不到「≥ 3 行」的门槛，不算整批回显', async () => {
    const store = new Map();
    const { calls } = await runScript({ url: JSON_URL, body: json3(evOf(PROSE.slice(0, 4))), store, config: cfg({ cache: true, concurrency: 1 }),
      respond: (o) => zhReply(o, (t) => t === PROSE[0] || t === PROSE[1]) });
    assertEqual(calls.length, 1, '两条回显不该触发重试');
    assertEqual(evCount(store, 'echoBatch'), 0);
    assertEqual(valueRecs(store).length, 1, '照常入缓存');
  });

  await check('8 行里 3 条保留英文、5 条真译文：不到这类句子的一半，不算整批回显', async () => {
    const store = new Map();
    const keep = PROSE.slice(0, 3);
    const { calls } = await runScript({ url: JSON_URL, body: json3(evOf(PROSE)), store, config: cfg({ cache: true, chunkSize: 8, concurrency: 1 }),
      respond: (o) => zhReply(o, (t) => keep.indexOf(t) >= 0) });
    assertEqual(calls.length, 1, '少数行保留英文不该触发重试');
    assertEqual(evCount(store, 'echoBatch'), 0);
    assertEqual(valueRecs(store).length, 1, '照常入缓存');
  });

  await check('译文含汉字、后面又抄了一遍原文：含汉字就当它翻了，不按回显丢批', async () => {
    const store = new Map();
    const { result, calls } = await runScript({ url: JSON_URL, body: json3(evOf(PROSE.slice(0, 6))), store, config: cfg({ cache: true, concurrency: 1 }),
      respond: (o) => zhPlusEcho(o) });
    assertEqual(calls.length, 1, '含汉字的行不该被拿去和原文比');
    assertEqual(evCount(store, 'echoBatch'), 0);
    assertEqual(translated(result), 6);
    assertEqual(valueRecs(store).length, 1, '照常入缓存');
  });

  await check('整批回显又恰好漏一条：先判回显，不能把回显当 partial 交出去渲染', async () => {
    const store = new Map();
    const { calls } = await runScript({ url: JSON_URL, body: json3(evOf(PROSE.slice(0, 5))), store, config: cfg({ cache: true, chunkSize: 5, concurrency: 1 }),
      respond: (o, n) => (n === 1 ? echoMissingMid(o) : zhReply(o)) });
    assertEqual(evCount(store, 'echoBatch'), 1, '回显判定必须排在「逐条漏」之前');
    assertEqual(evCount(store, 'partialLines'), 0, '回显批绝不能走 partial 通道');
    assert(calls.length >= 2, '仍然拆批重试');
  });

  await check('非中文目标语：整批等于原文也不判回显（字符集分不出「没翻」）', async () => {
    const store = new Map();
    const { calls } = await runScript({ url: JSON_URL, body: json3(evOf(PROSE.slice(0, 6))), store,
      config: cfg({ cache: true, concurrency: 1, targetLang: 'Japanese' }), respond: (o) => echoReply(o) });
    assertEqual(calls.length, 1, '非中文目标语不该触发回显重试');
    assertEqual(evCount(store, 'echoBatch'), 0);
    assertEqual(valueRecs(store).length, 1, '照常入缓存');
  });
};
