'use strict';
/*
 * 波次与并发：速度档首波能铺多远、失败批下次怎么拆、撞 429 怎么退档。
 *
 *   · 「首波与缓存：一波能铺多远、失败批下次拆半、缓存淘汰不挤掉开头」　fastConcurrency、第二波开关、
 *     失败批拆半并行；其中三条是缓存持久化（索引攒批落盘、LRU、整轨命中秒回），缓存的主场在 request.js
 *   · 「首波并发自动退档；$done 之后的两个探针」　前三条是退档与回升，
 *     后两条是 $done 之后的探针（postdone / relay），探针的主场在 probes.js
 */

const { check, assert, assertEqual, section } = require('../lib/harness');
const {
  runScript, SCRIPT, FIX, cfg, JSON_URL, M_JSON_URL,
  json3, readSubs, goodTranslator,
} = require('../lib/sandbox');

module.exports = async function () {
  section('首波与缓存：一波能铺多远、失败批下次拆半、缓存淘汰不挤掉开头');

  // 真并发计数：post 时 +1，响应交付时才 -1（当场同步 -1 的话量不到并发）。
  function concurrencyMeter(delay) {
    let inFlight = 0, peak = 0;
    return {
      peak: () => peak,
      respond: (o) => {
        inFlight++; peak = Math.max(peak, inFlight);
        setTimeout(() => { inFlight--; }, delay);
        return Object.assign(goodTranslator(o), { delay });
      },
    };
  }

  await check('速度档首波并发由 fastConcurrency 决定，质量档仍用 concurrency', async () => {
    /* 速度档只能跑一波（准入判据 now + expectedCallMs() > DEADLINE 挡住第二波），
       所以首波并发 = 一次交回能覆盖的批数，它必须能独立于质量档的并发往上调。 */
    const events = [];
    for (let i = 0; i < 100; i++) events.push({ tStartMs: i * 2000, dDurationMs: 1500, segs: [{ utf8: 'wave line ' + i }] });
    const body = json3(events);

    const m1 = concurrencyMeter(300);
    const r1 = await runScript({ url: JSON_URL, body, config: cfg({ chunkSize: 10, fastConcurrency: 6, concurrency: 2, fastBudgetMs: 3000, probe: true }), respond: m1.respond });
    assertEqual(m1.peak(), 6, '速度档首波并发应当是 fastConcurrency');
    assert(r1.result && r1.result.body && r1.result.body.includes('[zh]'), '速度档照常交回双语');
    const d1 = JSON.parse(r1.store.get('llmsubs.diag')).slice(-1)[0];
    assertEqual(d1.chunks.wave, 6, '诊断记下这次的首波并发');
    assertEqual(d1.llm.fastConcurrency, 6, '诊断的 llm 块要报 fastConcurrency');
    // 速度档默认只发一波：预算再宽也不派第 7 批
    assertEqual(d1.chunks.started, 6, '默认只发一波 = fastConcurrency 批');
    assertEqual(d1.chunks.fresh, 6, '发出去的都落地了');

    // 质量档（m 域重复请求）的主波也用 fastConcurrency：第一轮端点慢、只翻了 4 批，
    // 第二轮还剩 6 批要翻，这 6 批应当一波并行（peak 6），而不是按 concurrency(2) 分三波。
    // （第一轮必须留下没翻完的批：若第一轮就全翻完，第二轮 todo=0、主波根本不跑，一个请求都不发，量不到主波的并发。）
    const store = new Map();
    const confQ = cfg({ chunkSize: 10, fastConcurrency: 4, concurrency: 2, cache: true, probe: true, fastBudgetMs: 1000 });
    const r0 = await runScript({ url: M_JSON_URL, body, config: confQ, store, respond: (o) => Object.assign(goodTranslator(o), { delay: 600 }) });
    assertEqual(r0.calls.length, 4, '前提：第一轮只发得出一波 4 批');
    const confQ2 = cfg({ chunkSize: 10, fastConcurrency: 6, concurrency: 2, cache: true, probe: true, fastBudgetMs: 1000 });
    const m2 = concurrencyMeter(200);
    const r2 = await runScript({ url: M_JSON_URL, body, config: confQ2, store, respond: m2.respond });
    const d2 = JSON.parse(r2.store.get('llmsubs.diag')).slice(-1)[0];
    assertEqual(d2.chunks.mode, 'q', '前提：第二次是质量档');
    assertEqual(d2.chunks.todo, 6, '前提：还有 6 批没翻');
    assertEqual(r2.calls.length, 6, '质量档把剩下的翻完，且默认不跑升级通道');
    assertEqual(m2.peak(), 6, '质量档主波的并发也是 fastConcurrency');

    // 升级通道（显式打开）仍受 concurrency 约束：第三轮 todo 0，只有升级在跑
    const confU = cfg({ chunkSize: 10, fastConcurrency: 6, concurrency: 2, cache: true, probe: true, upgrade: true });
    const m4 = concurrencyMeter(200);
    const r4 = await runScript({ url: M_JSON_URL, body, config: confU, store, respond: m4.respond });
    assert(r4.calls.length >= 4, '打开 upgrade 后质量档要重翻速度档批次');
    assertEqual(m4.peak(), 2, '升级通道的并发受 concurrency 约束');

    // fastConcurrency 缺失/非法：退回 concurrency，绝不能算成 NaN 让 worker 一个都起不来
    const m3 = concurrencyMeter(200);
    const r3 = await runScript({ url: JSON_URL, body, config: cfg({ chunkSize: 10, fastConcurrency: 0, concurrency: 3 }), respond: m3.respond });
    assertEqual(m3.peak(), 3, 'fastConcurrency 非法时退回 concurrency');
    assert(r3.result && r3.result.body && r3.result.body.includes('[zh]'), '退回之后照常翻译');
  });

  await check('第二波开关：速度档默认只发一波，开了才用空出来的 worker 补发', async () => {
    /* 第二波不是设计出来的功能，是 expectedCallMs 那个 (DEADLINE−T0)*0.45 帽子的副产品。
       它要等首波有批回来、空出 worker 才派得出；对一般的云端接口，这时剩下的预算往往不够
       再跑一次往返，派出去的批大多在 $done 时还在途 —— 而 $done 之后脚本上下文就没了，
       那些响应无人接收 = token 白烧、译文丢掉，那几批还得躺回队列等 cron 重翻。
       所以默认关；本地模型那种极速端点才值得开。                                   */
    const events = [];
    for (let i = 0; i < 100; i++) events.push({ tStartMs: i * 2000, dDurationMs: 1500, segs: [{ utf8: 'wave line ' + i }] });
    const body = json3(events);
    const slow = (o) => Object.assign(goodTranslator(o), { delay: 300 });
    const base = { chunkSize: 10, fastConcurrency: 6, concurrency: 2, fastBudgetMs: 3000, probe: true };

    const off = await runScript({ url: JSON_URL, body, config: cfg(base), respond: slow });
    const dOff = JSON.parse(off.store.get('llmsubs.diag')).slice(-1)[0];
    assertEqual(dOff.chunks.wave, 6, '前提：这一波宽 6');
    assertEqual(dOff.chunks.started, 6, '默认关：发满一波就收手，哪怕预算还够（3s / 每批 300ms）');

    const on = await runScript({ url: JSON_URL, body, config: cfg(Object.assign({}, base, { secondWave: true })), respond: slow });
    const dOn = JSON.parse(on.store.get('llmsubs.diag')).slice(-1)[0];
    assertEqual(dOn.chunks.wave, 6, '开关不动首波宽度');
    assert(dOn.chunks.started > 6, '开了之后空出来的 worker 继续取批，实际 ' + dOn.chunks.started);
    assert(on.result && on.result.body && on.result.body.includes('[zh]'), '照常交回双语');

    // 闸只拦速度档（MODE.tag==='f'）：质量档多波推进是设计，cron 要把队列铺完。
    // 这两条由本节别处的质量档断言和 backfill.js 的 cron 用例覆盖，这里不重复构造。
  });

  await check('【回归】升级通道默认关：整条轨已缓存的 m 域重复请求必须秒回', async () => {
    /* 整条轨都已缓存（todo 0）时没有任何新内容要翻。升级通道若默认开着，这次重复请求仍会把
       速度档翻过的批全部重翻一遍，等它们都回来才交回，而这期间播放器手上并没有轨（上一次
       请求刚被浏览器放弃）。换来的只是每批开头几行多了上文可参照，不值这段等待，所以默认关。 */
    const events = [];
    for (let i = 0; i < 60; i++) events.push({ tStartMs: i * 2000, dDurationMs: 1500, segs: [{ utf8: 'upgrade off line ' + i }] });
    const body = json3(events);
    const store = new Map();
    const conf = cfg({ chunkSize: 10, cache: true, probe: true });
    await runScript({ url: M_JSON_URL, body, config: conf, store, respond: goodTranslator });
    const t0 = Date.now();
    const r2 = await runScript({ url: M_JSON_URL, body, config: conf, store, respond: (o) => Object.assign(goodTranslator(o), { delay: 3000 }) });
    const e2 = Date.now() - t0;
    const d2 = JSON.parse(r2.store.get('llmsubs.diag')).slice(-1)[0];
    assertEqual(d2.chunks.mode, 'q', '前提：m 域重复请求是质量档');
    assertEqual(d2.chunks.todo, 0, '前提：整条轨已缓存');
    assertEqual(r2.calls.length, 0, '默认不重翻，一次调用都不发');
    assert(e2 < 800, '必须秒回，实际 ' + e2 + 'ms');
    assertEqual(JSON.parse(r2.result.body).events.filter((e) => e.segs[0].utf8.includes('[zh]')).length, 60, '交回全量双语');
    // 对照：显式打开才重翻
    const r3 = await runScript({ url: M_JSON_URL, body, config: cfg({ chunkSize: 10, cache: true, probe: true, upgrade: true }), store, respond: goodTranslator });
    assertEqual(r3.calls.length, 6, '打开 upgrade 才会把 6 批速度档译文重翻一遍');
  });

  await check('【回归】速度档翻不成的批（模型合并行）下次拆半并行，不再每次白占一个槽', async () => {
    /* 模型合并行（少输出一行，mmTail）的批，速度档没预算当场拆批重试。不处理的话，同一批
       每次打开都失败、永远不进缓存、每次都占一个并发槽。所以失败时写「下次拆半」标记，
       下次切批时拆成两半在同一波里并行发。                                              */
    const events = [];
    for (let i = 0; i < 28; i++) events.push({ tStartMs: i * 2000, dDurationMs: 1500, segs: [{ utf8: 'merge prone line ' + i }] });
    const body = json3(events);
    // 15 行以上的批：模型把最后两行合并，少输出一行（mmTail）；小批则正常。
    const dropTail = (o) => {
      const lines = readSubs(o);
      if (lines.length < 15) return goodTranslator(o);
      const out = lines.slice(0, -1).map((line) => { const m = line.match(/^(\d+)\|([\s\S]*)$/); return m[1] + '|[zh]' + m[2].slice(0, 20); });
      return { status: 200, body: JSON.stringify({ choices: [{ message: { content: out.join('\n') }, finish_reason: 'stop' }] }), delay: 1000 };
    };
    const store = new Map();
    const conf = cfg({ chunkSize: 20, cache: true, probe: true, fastBudgetMs: 1500 });

    // 第一轮：20 行的批失败（1000ms 才回，预算不够拆批重试），8 行的批成功
    const r1 = await runScript({ url: JSON_URL, body, config: conf, store, respond: dropTail });
    const zh1 = JSON.parse(r1.result.body).events.filter((e) => e.segs[0].utf8.includes('[zh]')).length;
    assertEqual(zh1, 8, '第一轮只有小批成功，大批一条都不能错位地贴上去');
    let marks = 0;
    for (const [k, v] of store) if (k.startsWith('llmsubs.c.') && JSON.parse(v).split === 1) marks++;
    assertEqual(marks, 1, '失败的那批应当留下「下次拆半」标记');

    // 第二轮：那批被拆成 10+10 两半，同一波并行发出，全部译成
    const meter = { inFlight: 0, peak: 0 };
    const r2 = await runScript({
      url: JSON_URL, body, config: conf, store,
      respond: (o) => { meter.inFlight++; meter.peak = Math.max(meter.peak, meter.inFlight); setTimeout(() => meter.inFlight--, 100); return Object.assign(dropTail(o), { delay: 100 }); },
    });
    assertEqual(r2.calls.length, 2, '第二轮只该发两半，缓存里的小批不发');
    assertEqual(meter.peak, 2, '两半必须在同一波里并行，不多花一次往返');
    const zh2 = JSON.parse(r2.result.body).events.filter((e) => e.segs[0].utf8.includes('[zh]')).length;
    assertEqual(zh2, 28, '第二轮应当全量双语');
    const last = JSON.parse(r2.store.get('llmsubs.diag')).slice(-1)[0];
    assertEqual(last.splitParts, 1, '诊断记下多出来的工作单元数');
    // 标记必须和两半一起参与 LRU 刷新：第一轮索引顺序是 [小批 B, 标记]，第二轮 B 命中、
    // 标记被用到，两者都该挪到队尾且标记排在 B 之后（只刷新两半不刷新标记的话，标记
    // 会是这部视频里最先被淘汰的一条，一没，整批又按原批派发、重译、再次合并行）。
    const idx2 = JSON.parse(store.get('llmsubs.cache.idx')).map((e) => e.k);
    let markKey = null, smallKey = null;
    for (const [k, v] of store) {
      if (!k.startsWith('llmsubs.c.') || !v) continue;
      const rec = JSON.parse(v);
      if (rec.split === 1) markKey = k.slice('llmsubs.c.'.length);
      else if (Array.isArray(rec.v) && rec.v.length === 8) smallKey = k.slice('llmsubs.c.'.length);
    }
    assert(markKey && smallKey, '应当能找到标记与小批的键');
    assert(idx2.indexOf(markKey) > idx2.indexOf(smallKey), '用到的标记必须像命中一样被刷新到队尾');
    // 第三轮：两半都在缓存里 → 一次调用都不发
    const r3 = await runScript({ url: JSON_URL, body, config: conf, store, respond: dropTail });
    assertEqual(r3.calls.length, 0, '两半都命中缓存时整批视为已缓存');
  });

  await check('【回归】放行的请求（空 body / tlang 轨）不得把下一次真请求推进质量档', async () => {
    /* 缺 POT 时 YouTube 回 200 + 空 body，播放器随即重试；tlang 轨脚本原样放行。
       这些请求播放器并没有拿到一条脚本给的英文轨，计数若在放行之前，本次会话的第一次
       真请求就会被判成 reqNo 2 的后台刷新——m 域上就是 18 秒质量档、18 秒空白。      */
    const events = [];
    for (let i = 0; i < 30; i++) events.push({ tStartMs: i * 2000, dDurationMs: 1500, segs: [{ utf8: 'pot retry line ' + i }] });
    const body = json3(events);
    const conf = cfg({ chunkSize: 10, probe: true, cache: true });
    // 空 body → 重试
    const s1 = new Map();
    await runScript({ url: M_JSON_URL, body: '', config: conf, store: s1, respond: goodTranslator });
    const r1 = await runScript({ url: M_JSON_URL, body, config: conf, store: s1, respond: goodTranslator });
    const d1 = JSON.parse(r1.store.get('llmsubs.diag')).slice(-1)[0];
    assertEqual(d1.reqNo, 1, '空 body 那次不算「播放器拿到了轨」');
    assertEqual(d1.chunks.mode, 'f', '重试是本次会话的第一次真请求，必须走速度档');
    // tlang 轨 → 英文轨
    const s2 = new Map();
    await runScript({ url: M_JSON_URL + '&tlang=zh-Hans', body, config: conf, store: s2, respond: goodTranslator });
    const r2 = await runScript({ url: M_JSON_URL, body, config: conf, store: s2, respond: goodTranslator });
    const d2 = JSON.parse(r2.store.get('llmsubs.diag')).slice(-1)[0];
    assertEqual(d2.reqNo, 1, 'tlang 轨放行不计数');
    assertEqual(d2.chunks.mode, 'f', '之后的英文轨请求仍是速度档');
    // 对照：两次真请求才算重复
    const r3 = await runScript({ url: M_JSON_URL, body, config: conf, store: s2, respond: goodTranslator });
    assertEqual(JSON.parse(r3.store.get('llmsubs.diag')).slice(-1)[0].chunks.mode, 'q', '真的重复请求（m 域）才进质量档');
  });

  await check('【回归】缓存索引攒批落盘：一波里不是每批都重写一次，收尾必落', async () => {
    /* cache.idx 是整份 JSON 读-改-写，条目多时有几十上百 KB。每 cachePut 一次就重写一次的话，
       一波几十批成簇落地就要整份重写几十次，全落在硬上限定时器抢线程的那个窗口里。 */
    const every = +(SCRIPT.match(/var IDX_FLUSH_EVERY = (\d+)/) || [])[1];
    assert(every >= 2, '应当能从源码读到 IDX_FLUSH_EVERY');
    const events = [];
    for (let i = 0; i < 30; i++) events.push({ tStartMs: i * 2000, dDurationMs: 1500, segs: [{ utf8: 'idx batch line ' + i }] });
    const store = new Map();
    let idxWrites = 0;
    const counting = new Map();
    // 用 Proxy 数 cache.idx 的写入次数（store 是 Map，runScript 直接用它）
    const spy = new Proxy(store, {
      get(target, prop) {
        if (prop === 'set') return (k, v) => { if (k === 'llmsubs.cache.idx') idxWrites++; return target.set(k, v); };
        const val = target[prop];
        return typeof val === 'function' ? val.bind(target) : val;
      },
    });
    const r = await runScript({ url: JSON_URL, body: json3(events), config: cfg({ chunkSize: 1, cache: true }), store: spy, respond: goodTranslator });
    assertEqual(r.calls.length, 30, '30 批各一次调用');
    assert(idxWrites <= Math.ceil(30 / every) + 1, '索引写入应当攒批，实际写了 ' + idxWrites + ' 次');
    assertEqual(JSON.parse(store.get('llmsubs.cache.idx')).length, 30, '收尾时全部 30 条都在索引里');
    // 第二轮全命中：只写一次索引（LRU 刷新）
    idxWrites = 0;
    const r2 = await runScript({ url: JSON_URL, body: json3(events), config: cfg({ chunkSize: 1, cache: true }), store: spy, respond: goodTranslator });
    assertEqual(r2.calls.length, 0);
    assertEqual(idxWrites, 1, '全命中的一轮只写一次索引');
  });

  await check('【回归】缓存淘汰是 LRU：刚命中的视频不能被新写入挤掉', async () => {
    /* 按写入顺序 FIFO、命中不刷新的话：缓存写满后，老视频的开头最先被挤掉，
       下次打开那部视频，速度档那一波又全花在开头，尾部永远推不动。所以淘汰用 LRU。  */
    const cap = +(SCRIPT.match(/var CACHE_MAX_ENTRIES = (\d+)/) || [])[1];
    assert(cap > 10, '应当能从源码读到 CACHE_MAX_ENTRIES');
    const store = new Map();
    const conf = cfg({ cache: true, chunkSize: 1 });
    const A = json3([0, 1, 2].map((i) => ({ tStartMs: i * 2000, dDurationMs: 1500, segs: [{ utf8: 'lru alpha ' + i }] })));
    const a1 = await runScript({ url: JSON_URL, body: A, config: conf, store, respond: goodTranslator });
    assertEqual(a1.calls.length, 3, 'A 切成 3 批');
    let idx = JSON.parse(store.get('llmsubs.cache.idx'));
    const aKeys = idx.map((e) => e.k);
    assertEqual(aKeys.length, 3);
    // A 在队头（最老），后面塞假条目直到只差 1 个就满
    const dummies = [];
    for (let i = 0; i < cap - 4; i++) {
      const k = 'dummy' + i;
      dummies.push({ k, t: Date.now() });
      store.set('llmsubs.c.' + k, '{"t":1,"v":["x"],"m":"f"}');
    }
    store.set('llmsubs.cache.idx', JSON.stringify(idx.concat(dummies)));

    const a2 = await runScript({ url: JSON_URL, body: A, config: conf, store, respond: goodTranslator });
    assertEqual(a2.calls.length, 0, '再看 A 全命中');
    idx = JSON.parse(store.get('llmsubs.cache.idx'));
    assertEqual(idx.length, cap - 1, '命中不该改变条目数');
    assertEqual(idx.slice(-3).map((e) => e.k).sort().join(), aKeys.slice().sort().join(), '命中的条目必须挪到队尾');

    // 新视频 B 写 5 条 → 超限 4 条 → 淘汰的必须是队头的假条目，A 一条都不能少
    const B = json3([0, 1, 2, 3, 4].map((i) => ({ tStartMs: i * 2000, dDurationMs: 1500, segs: [{ utf8: 'lru beta ' + i }] })));
    await runScript({ url: JSON_URL.replace('abc123', 'bbb456'), body: B, config: conf, store, respond: goodTranslator });
    idx = JSON.parse(store.get('llmsubs.cache.idx'));
    assertEqual(idx.length, cap, '超限后收敛到上限');
    assert(aKeys.every((k) => store.get('llmsubs.c.' + k)), 'A 的条目不得被淘汰');
    assert(!store.get('llmsubs.c.dummy0'), '被淘汰的是最老的假条目（删除写的是空值）');
    const a3 = await runScript({ url: JSON_URL, body: A, config: conf, store, respond: goodTranslator });
    assertEqual(a3.calls.length, 0, '刚看过的视频不能因为别的视频写入被挤掉');
  });

  section('首波并发自动退档；$done 之后的两个探针');

  // 降档记录的命名空间（与脚本的 fcbNs 同算法）：接口主机 + 模型
  function fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0; }
    return ('0000000' + h.toString(16)).slice(-8);
  }
  const NS = fnv1a('api.example.com|test-model');

  const BF_URL_FCB = 'https://www.youtube.com/api/timedtext?v=fcb123&lang=en&fmt=json3&caps=asr&kind=asr';
  const bfEventsFcb = (n) => { const ev = []; for (let i = 0; i < n; i++) ev.push({ tStartMs: i * 2000, dDurationMs: 1500, segs: [{ utf8: 'backfill line ' + i }] }); return ev; };
  const failAfterFirstFcb = (o) => {
    const lines = readSubs(o);
    if (lines[0].startsWith('1|backfill line 0')) return goodTranslator(o);
    const out = lines.map((line) => line.replace(/^(\d+)\|(.*)$/, '$1|[zh]$2')); out.pop();
    return { status: 200, body: JSON.stringify({ choices: [{ message: { content: out.join('\n') }, finish_reason: 'stop' }] }) };
  };

  await check('首波并发撞 429 自动降档（按比例、落地即写），连续 3 轮宽波干净后回升一步（×1.5），命名空间与上限不符即作废', async () => {
    const mk = (n, tag) => { const ev = []; for (let i = 0; i < n; i++) ev.push({ tStartMs: i * 2000, dDurationMs: 1500, segs: [{ utf8: tag + ' line ' + i }] }); return json3(ev); };
    const body20 = mk(200, 'backoff');    // 20 批
    const body40 = mk(400, 'wide');       // 40 批
    const conf = cfg({ chunkSize: 10, fastConcurrency: 48, concurrency: 16, probe: true, cache: false, fastBudgetMs: 3000 });
    const store = new Map();
    const diagLast = (s) => JSON.parse(s.get('llmsubs.diag')).slice(-1)[0];
    // 整轮 429 → 降档，并带上当时的 cap 与命名空间
    await runScript({ url: JSON_URL, body: body20, config: conf, store, respond: () => ({ status: 429, body: '{"error":{"code":"Throttling"}}' }) });
    assert(store.get('llmsubs.fcb'), '撞 429 后要写降档状态');
    let fcb = JSON.parse(store.get('llmsubs.fcb'));
    assertEqual(fcb.eff, 32, '48 降到 floor(48/1.5)=32'); assertEqual(fcb.clean, 0); assertEqual(fcb.cap, 48, '记下当时的上限');
    assertEqual(fcb.ns, NS, '记下接口主机 + 模型的命名空间');
    // 之后的运行用 32；宽波（40 批 ≥ 0.8×32）干净才记 clean
    await runScript({ url: JSON_URL, body: body40, config: conf, store, respond: goodTranslator });
    assertEqual(diagLast(store).chunks.wave, 32, '降档后的波宽');
    assertEqual(diagLast(store).fcb.eff, 32, '诊断里看得到降档状态');
    fcb = JSON.parse(store.get('llmsubs.fcb')); assertEqual(fcb.clean, 1);
    await runScript({ url: JSON_URL, body: body40, config: conf, store, respond: goodTranslator });
    fcb = JSON.parse(store.get('llmsubs.fcb')); assertEqual(fcb.eff, 32); assertEqual(fcb.clean, 2, '两轮干净还不回升');
    // 窄波（8 批）不算干净轮：证明不了 32 路能跑
    await runScript({ url: JSON_URL, body: mk(80, 'narrow'), config: conf, store, respond: goodTranslator });
    fcb = JSON.parse(store.get('llmsubs.fcb')); assertEqual(fcb.clean, 2, '8 批的小视频不能记 clean');
    await runScript({ url: JSON_URL, body: body40, config: conf, store, respond: goodTranslator });
    fcb = JSON.parse(store.get('llmsubs.fcb')); assertEqual(fcb.eff, 48, '第三轮宽波干净回升一步（32×1.5=48）'); assertEqual(fcb.clean, 0);
    // 回升一步是 ×1.5 不是一步到顶：cap 96、eff 16，三轮干净后应是 24
    const s96 = new Map();
    const conf96 = cfg({ chunkSize: 10, fastConcurrency: 96, concurrency: 16, probe: true, cache: false, fastBudgetMs: 3000 });
    s96.set('llmsubs.fcb', JSON.stringify({ eff: 16, clean: 0, t: Date.now(), cap: 96, ns: NS }));
    for (let i = 0; i < 3; i++) await runScript({ url: JSON_URL, body: body40, config: conf96, store: s96, respond: goodTranslator });
    assertEqual(JSON.parse(s96.get('llmsubs.fcb')).eff, 24, '回升一次 ×1.5');
    // 命名空间不符（换了模型或接口）→ 作废
    store.set('llmsubs.fcb', JSON.stringify({ eff: 16, clean: 0, t: Date.now(), cap: 48, ns: fnv1a('api.example.com|other-model') }));
    await runScript({ url: JSON_URL, body: body40, config: conf, store, respond: goodTranslator });
    assertEqual(diagLast(store).chunks.wave, 48, '别的模型的降档记录不生效');
    // 上限变了 → 旧记录作废
    store.set('llmsubs.fcb', JSON.stringify({ eff: 16, clean: 0, t: Date.now(), cap: 32, ns: NS }));
    await runScript({ url: JSON_URL, body: body40, config: conf, store, respond: goodTranslator });
    assertEqual(diagLast(store).chunks.wave, 48, 'cap 对不上的记录不生效');
    // 阈值按比例：48 批里 3 次 429 是噪声、不降；6 次才降
    const bodyBig = mk(480, 'big');   // 48 批
    const s2 = new Map();
    let n = 0;
    await runScript({ url: JSON_URL, body: bodyBig, config: conf, store: s2, respond: (o) => (++n <= 3 ? { status: 429, body: '{}' } : goodTranslator(o)) });
    assert(!s2.get('llmsubs.fcb'), '48 批里 3 次 429 不该降档');
    const s2b = new Map(); n = 0;
    await runScript({ url: JSON_URL, body: bodyBig, config: conf, store: s2b, respond: (o) => (++n <= 6 ? { status: 429, body: '{}' } : goodTranslator(o)) });
    assertEqual(JSON.parse(s2b.get('llmsubs.fcb')).eff, 32, '48 批里 6 次（≥10%）才降');
    // 上限只有 16 也照常降档：退档不看上限高低，上限本来就低的配置同样会撞限流
    const s3 = new Map();
    await runScript({ url: JSON_URL, body: body20, config: cfg({ chunkSize: 10, fastConcurrency: 16, concurrency: 16, probe: true, cache: false, fastBudgetMs: 3000 }), store: s3, respond: () => ({ status: 429, body: '{}' }) });
    assertEqual(JSON.parse(s3.get('llmsubs.fcb')).eff, 10, 'cap 16 降到 floor(16/1.5)=10');
    // 升级通道撞的 429 不降主波：m 域第二次请求 todo 0、只有升级通道在跑
    const s4 = new Map();
    const confU = cfg({ chunkSize: 10, fastConcurrency: 48, concurrency: 4, cache: true, probe: true, upgrade: true });
    await runScript({ url: M_JSON_URL, body: body20, config: confU, store: s4, respond: goodTranslator });
    await runScript({ url: M_JSON_URL, body: body20, config: confU, store: s4, respond: () => ({ status: 429, body: '{}' }) });
    assertEqual(diagLast(s4).chunks.todo, 0, '前提：第二次没有新地盘，只有升级通道');
    assert(!s4.get('llmsubs.fcb'), '升级通道的 429 不该降主波');
  });

  await check('降档的边界：下限是 1（cap 4 → 2 → 1）；满一天起每天回升一步（读取时算、不写回），满 7 天作废；cron 并发 = 有效上限 / 3', async () => {
    const mk = (n, tag) => { const ev = []; for (let i = 0; i < n; i++) ev.push({ tStartMs: i * 2000, dDurationMs: 1500, segs: [{ utf8: tag + ' line ' + i }] }); return json3(ev); };
    const conf4 = cfg({ chunkSize: 10, fastConcurrency: 4, concurrency: 4, probe: true, cache: false, fastBudgetMs: 3000 });
    const store = new Map();
    const all429 = () => ({ status: 429, body: '{}' });
    await runScript({ url: JSON_URL, body: mk(40, 'four'), config: conf4, store, respond: all429 });
    assertEqual(JSON.parse(store.get('llmsubs.fcb')).eff, 2, '4 → floor(4/1.5)=2');
    await runScript({ url: JSON_URL, body: mk(40, 'four'), config: conf4, store, respond: all429 });
    assertEqual(JSON.parse(store.get('llmsubs.fcb')).eff, 1, '2 → max(1, floor(2/1.5))=1');
    const diagLast = (s) => JSON.parse(s.get('llmsubs.diag')).slice(-1)[0];
    await runScript({ url: JSON_URL, body: mk(40, 'four'), config: conf4, store, respond: all429 });
    assertEqual(JSON.parse(store.get('llmsubs.fcb')).eff, 1, '下限 1，不会降到 0');
    assertEqual(diagLast(store).chunks.wave, 1);
    // 读取时按天数回升：49 小时前的 eff 8（cap 48）→ 两步 8→12→18
    const conf48 = cfg({ chunkSize: 10, fastConcurrency: 48, concurrency: 16, probe: true, cache: false, fastBudgetMs: 3000 });
    const s2 = new Map();
    const aged = { eff: 8, clean: 0, t: Date.now() - 49 * 3600 * 1000, cap: 48, ns: NS };
    s2.set('llmsubs.fcb', JSON.stringify(aged));
    await runScript({ url: JSON_URL, body: mk(40, 'aged'), config: conf48, store: s2, respond: goodTranslator });
    assertEqual(diagLast(s2).chunks.wave, 18, '满两天回升两步');
    assertEqual(JSON.parse(s2.get('llmsubs.fcb')).t, aged.t, '窄波不过门时不写回，原记录留着');
    // 满 7 天作废
    const s3 = new Map();
    s3.set('llmsubs.fcb', JSON.stringify({ eff: 2, clean: 0, t: Date.now() - 7 * 24 * 3600 * 1000 - 1000, cap: 48, ns: NS }));
    await runScript({ url: JSON_URL, body: mk(40, 'week'), config: conf48, store: s3, respond: goodTranslator });
    assertEqual(diagLast(s3).chunks.wave, 48, '7 天前的降档记录作废');
    // cron 只读：并发 = round(有效上限 / 3)，不写降档记录
    const s4 = new Map();
    await runScript({ url: BF_URL_FCB, body: json3(bfEventsFcb(200)), config: cfg({ cache: true, fastConcurrency: 48 }), store: s4, respond: failAfterFirstFcb });
    s4.set('llmsubs.fcb', JSON.stringify({ eff: 9, clean: 0, t: Date.now(), cap: 48, ns: NS }));
    let peak = 0, live = 0;
    const r = await runScript({ noRequest: true, noResponse: true, config: cfg({ cache: true, fastConcurrency: 48, backfillThinking: false }), store: s4,
      respond: (o) => { live++; peak = Math.max(peak, live); setTimeout(() => live--, 30); return Object.assign(goodTranslator(o), { delay: 30 }); } });
    assert(r.calls.length > 0, '前提：cron 翻了队列里的批');
    assertEqual(peak, 3, 'cron 并发 = round(9/3) = 3');
    assertEqual(JSON.parse(s4.get('llmsubs.fcb')).eff, 9, 'cron 不写降档记录');
  });

  await check('【回归】交回时在途的 429 不能算成干净轮；晚到的 429 若上下文还活着也要退档', async () => {
    // 整轮全 429 但都在 $done 之后才回时，收尾那张快照看到的是零 429；据此记成干净轮，eff 就会被错误地升上去。
    const ev = []; for (let i = 0; i < 200; i++) ev.push({ tStartMs: i * 2000, dDurationMs: 1500, segs: [{ utf8: 'late line ' + i }] });
    const body = json3(ev);
    const conf = cfg({ chunkSize: 10, fastConcurrency: 96, concurrency: 16, probe: true, cache: false, fastBudgetMs: 1000 });
    const store = new Map();
    const seeded = { eff: 32, clean: 2, t: Date.now(), cap: 96, ns: NS };
    store.set('llmsubs.fcb', JSON.stringify(seeded));
    const hard = +(SCRIPT.match(/var FAST_HARD_MS = (\d+)/) || [])[1];
    const t0 = Date.now();
    await runScript({ url: JSON_URL, body, config: conf, store, respond: () => ({ status: 429, body: '{}', delay: hard + 400 }) });
    assert(Date.now() - t0 < hard + 300, '硬上限空手放行');
    let fcb = JSON.parse(store.get('llmsubs.fcb'));
    assertEqual(fcb.eff, 32, '$done 那一刻在途未归，不能升档');
    assertEqual(fcb.clean, 2, '也不能记 clean');
    await new Promise((r) => setTimeout(r, 900));   // 让晚到的 429 进沙箱
    fcb = JSON.parse(store.get('llmsubs.fcb'));
    assertEqual(fcb.eff, 21, '晚到的 429 落地即退：floor(32/1.5)=21');
  });

  await check('探针：$done 之后 1.5 秒还活着就会写 postdone；probe 关闭时不写', async () => {
    const store = new Map();
    const r = await runScript({ url: JSON_URL, body: FIX('YouTube.timedtext.json'), config: cfg({ probe: true }), store, respond: goodTranslator });
    assert(!store.get('llmsubs.postdone'), '$done 那一刻还不该有');
    await new Promise((res) => setTimeout(res, 1800));
    assert(store.get('llmsubs.postdone'), '沙箱里上下文不会死，1.5 秒后应当写出来（在小火箭里没写出来 = 引擎销毁了上下文）');
    const pd = JSON.parse(store.get('llmsubs.postdone'));
    assert(/^[0-9a-f]{8}$/.test(pd.id) && pd.sinceDone >= 1400 && pd.sinceDone < 3000, JSON.stringify(pd));
    const s2 = new Map();
    await runScript({ url: JSON_URL, body: FIX('YouTube.timedtext.json'), config: cfg({ probe: false }), store: s2, respond: goodTranslator });
    await new Promise((res) => setTimeout(res, 1800));
    assert(!s2.get('llmsubs.postdone'), '探针关闭时不写');
  });

  await check('探针：$done 前一刻用 $httpClient 打自己的 subs.test/relay，回调写 relaycb；probe 关闭时不发', async () => {
    const store = new Map();
    const r = await runScript({ url: JSON_URL, body: FIX('YouTube.timedtext.json'), config: cfg({ probe: true }), store, respond: goodTranslator, respondGet: () => ({ status: 204 }) });
    assertEqual(r.gets.length, 1, '正好发一次');
    assert(/^https:\/\/subs\.test\/relay\?id=[0-9a-f]{8}&t=\d+$/.test(r.gets[0].url), 'URL 只带运行 id 与时间戳：' + r.gets[0].url);
    assertEqual(r.gets[0].timeout, 5, '短超时，不能拖住引擎');
    for (let i = 0; i < 200 && !store.get('llmsubs.relaycb'); i++) await new Promise((res) => setTimeout(res, 10));
    assert(store.get('llmsubs.relaycb'), '回调应当写 relaycb');
    const cb = JSON.parse(store.get('llmsubs.relaycb'));
    assertEqual(cb.status, 204, '回调把状态记下来');
    assertEqual(cb.err, null);
    // 跑过翻译的放行路径也发（一批都没译成 → 放行）
    const s2 = new Map();
    const r2 = await runScript({ url: JSON_URL, body: FIX('YouTube.timedtext.json'), config: cfg({ probe: true }), store: s2, respond: () => ({ status: 200, body: 'not json at all' }) });
    assert(!r2.result || !r2.result.body, '前提：一批都没成，放行');
    assertEqual(r2.gets.length, 1, '跑过翻译的放行路径同样发探针');
    // 毫秒级早退（tlang）不发：一次播放里这种请求好几次，会把探针环刷掉
    const s2b = new Map();
    const r2b = await runScript({ url: JSON_URL + '&tlang=zh-Hans', body: FIX('YouTube.timedtext.json'), config: cfg({ probe: true }), store: s2b, respond: goodTranslator });
    assertEqual(r2b.gets.length, 0, '早退放行不发探针');
    const s3 = new Map();
    const r3 = await runScript({ url: JSON_URL, body: FIX('YouTube.timedtext.json'), config: cfg({ probe: false }), store: s3, respond: goodTranslator });
    assertEqual(r3.gets.length, 0, '探针关闭时不发');
  });
};
