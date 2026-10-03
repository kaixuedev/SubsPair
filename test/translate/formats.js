'use strict';
/*
 * 字幕格式：每种格式怎么解析、双语怎么合并、写回后结构必须原样。
 *
 *   · json3　人工字幕轨、ASR 滚动轨（aAppend / wWinId / 时长 clamp）
 *   · srv3 / XML　iOS 原生 App 用的格式：<p> 两行上限、自闭合 <p/>、词级 <s>、转义
 *   · srv1　不带 fmt 参数时 YouTube 返回的旧格式
 *   · 渲染补充　非滚动轨的 clamp、歌词轨窗口居中，和上面 json3 / srv3 的 clamp 是同一套机制；
 *     首条「三档统一用短提示词」是一条完整的提示词用例，与 prompt.js 同族；末条是诊断里的耗时统计
 *   · 换行写法　srv3 里换行的三种写法与 A/B 探针
 *   · WebVTT　iOS 原生 HLS 播放器与 fmt=vtt 用的格式
 *
 * 只有本文件用的辅助（xmlLines、BARE_URL、VTT_URL、vtt）就放在本文件里。
 */

const { check, assert, assertEqual, section } = require('../lib/harness');
const {
  runScript, SCRIPT, FIX, BASE, cfg, JSON_URL,
  M_JSON_URL, XML_URL, json3, readSubs, goodTranslator,
} = require('../lib/sandbox');

module.exports = async function () {
  // 只有本文件用的辅助（跨文件共用的在 lib/sandbox.js）
  const BARE_URL = 'https://www.youtube.com/api/timedtext?v=abc123&lang=en&caps=asr';

  // 一条 <p> 里有几行文本。默认分隔符是裸换行（YouTube 官方写法），
  // 探针的变体模式下还可能是数值引用或 <br/>，所以都算。
  function xmlLines(pBlock) {
    const inner = pBlock.replace(/^<p[^>]*>/, '').replace(/<\/p>$/, '');
    return inner.split(/&#x0*A;|&#10;|<br\s*\/?>|\r?\n/i).length;
  }

  section('json3 · 人工字幕轨');

  await check('合并成 “英文\\n中文” 的单个 seg', async () => {
    const { result } = await runScript({ url: JSON_URL, body: FIX('YouTube.timedtext.json'), config: BASE, respond: goodTranslator });
    assert(result && result.body, '应当返回改写后的 body');
    const doc = JSON.parse(result.body);
    const sample = doc.events.find((e) => e.segs && e.segs[0].utf8.includes('[zh]'));
    assert(sample, '至少要有一条被翻译的 cue');
    assertEqual(sample.segs.length, 1, 'segs 必须被压成单元素');
    const parts = sample.segs[0].utf8.split('\n');
    assertEqual(parts.length, 2, '必须恰好两行');
    assert(parts[1].startsWith('[zh]'), '第二行应当是译文');
  });

  await check('顶层元数据与时间轴原样保留', async () => {
    const src = FIX('YouTube.timedtext.json');
    const { result } = await runScript({ url: JSON_URL, body: src, config: BASE, respond: goodTranslator });
    const before = JSON.parse(src), after = JSON.parse(result.body);
    assertEqual(after.wireMagic, before.wireMagic, 'wireMagic 必须原样');
    assertEqual(JSON.stringify(after.pens), JSON.stringify(before.pens), 'pens 必须原样');
    assertEqual(after.events.length, before.events.length, '人工轨不应增删 event');
    for (let i = 0; i < before.events.length; i++) {
      assertEqual(after.events[i].tStartMs, before.events[i].tStartMs, '第 ' + i + ' 条 tStartMs 变了');
    }
  });

  await check('【回归】原文自带换行的 cue 合并后仍是两行，不是三行', async () => {
    const body = json3([{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'first line here\nsecond line here' }] }]);
    const { result } = await runScript({
      url: JSON_URL, body, config: BASE,
      respond: () => ({ status: 200, body: JSON.stringify({ choices: [{ message: { content: '1|译文' }, finish_reason: 'stop' }] }) }),
    });
    const utf8 = JSON.parse(result.body).events[0].segs[0].utf8;
    assertEqual(utf8.split('\n').length, 2, '原文必须先拍平，实际: ' + JSON.stringify(utf8));
  });

  await check('【回归】1 行高窗口（rcRows=1）放宽到 2 行，否则第二行中文被裁掉', async () => {
    // 网页端 json3 的非滚动轨可能通过 wpWinPosId 引用 rcRows=1 的窗口：
    // 双语两行塞进 1 行窗口，播放器会把第二行（中文）裁掉——表现是「英文正常、中文不见」。
    const body = JSON.stringify({
      wireMagic: 'pb3', pens: [{}], wsWinStyles: [{}, {}],
      wpWinPositions: [{}, { apPoint: 6, rcRows: 1 }, { rcRows: 2 }],
      events: [
        { tStartMs: 0, dDurationMs: 1000, wpWinPosId: 1, wsWinStyleId: 1, segs: [{ utf8: 'hello world here' }] },
        { tStartMs: 1000, dDurationMs: 1000, segs: [{ utf8: 'second cue line' }] },
      ],
    });
    const { result } = await runScript({ url: JSON_URL, body, config: BASE, respond: goodTranslator });
    const doc = JSON.parse(result.body);
    assertEqual(doc.wpWinPositions[1].rcRows, 2, 'rcRows=1 的窗口应放宽到 2');
    assertEqual(doc.wpWinPositions[2].rcRows, 2, '本来就是 2 的不动');
    assert(!('rcRows' in doc.wpWinPositions[0]), '没有 rcRows 的窗口不动');
    assertEqual(doc.events[0].wpWinPosId, 1, '窗口引用保留（只放宽行数，不动位置）');
    assert(doc.events[0].segs[0].utf8.includes('\n'), 'cue 本身应是双语两行');
  });

  section('json3 · ASR 滚动轨');

  await check('跳过 aAppend 事件并在合并后移除', async () => {
    const src = FIX('asr.zh.json');
    assert(JSON.parse(src).events.filter((e) => e.aAppend === 1).length > 100, '样本应含大量 aAppend');
    const { result, calls } = await runScript({ url: JSON_URL, body: src, config: BASE, respond: goodTranslator });
    assertEqual(JSON.parse(result.body).events.filter((e) => e.aAppend === 1).length, 0, 'aAppend 事件应被移除');
    for (const c of calls) {
      for (const l of readSubs(c)) assert(l.replace(/^\d+\|/, '').trim() !== '', '不应把空白送去翻译');
    }
  });

  await check('删除 wWinId 让 cue 脱离滚动窗口', async () => {
    const { result } = await runScript({ url: JSON_URL, body: FIX('asr.zh.json'), config: BASE, respond: goodTranslator });
    assert(!JSON.parse(result.body).events.some((e) => e.wWinId !== undefined), '所有 wWinId 都应被删除');
  });

  await check('时长被 clamp，消除同屏叠字', async () => {
    const { result } = await runScript({ url: JSON_URL, body: FIX('asr.zh.json'), config: BASE, respond: goodTranslator });
    const ev = JSON.parse(result.body).events.filter((e) => Array.isArray(e.segs));
    let overlaps = 0;
    for (let i = 0; i < ev.length - 1; i++) {
      if (typeof ev[i].dDurationMs === 'number' && ev[i].tStartMs + ev[i].dDurationMs > ev[i + 1].tStartMs) overlaps++;
    }
    assertEqual(overlaps, 0, '不应再有重叠的 cue');
  });

  await check('词级 seg 拼接不插入多余空格', async () => {
    // 要守的是：一个词被切在两个 seg 里（后一个 seg 不以空格开头）时，拼回去不带空格。用现造的谚文字做样本
    const H = (i) => String.fromCharCode(0xac00 + i * 28);
    const w1 = H(0) + H(1), w2 = H(2) + H(3), w3 = H(4) + H(5);
    const events = [0, 1, 2].map((k) => ({ tStartMs: k * 2000, dDurationMs: 1800, segs: [{ utf8: w1 }, { utf8: w2 }, { utf8: ' ' + w3 + k }] }));
    const split = await runScript({ url: JSON_URL, body: json3(events), config: BASE, respond: goodTranslator });
    const user = JSON.parse(split.calls[0].body).messages[1].content;
    assert(!/ {2,}/.test(user), '拼接后不应出现连续空格');
    const lines = split.calls.flatMap((c) => readSubs(c)).map((l) => l.replace(/^\d+\|/, ''));
    assertEqual(lines[0], w1 + w2 + ' ' + w3 + '0', '切在两个 seg 里的词要拼回原样，不能多出空格');
  });

  await check('【回归】不带 aAppend 的 ASR 轨（内嵌 \\n、带 wWinId）也脱离滚动窗口', async () => {
    // 这种格式没有 aAppend，判据若只看 aAppend 会把它当成「非滚动轨」：wWinId 不删、原文不拍平，
    // 结果是 3 行 cue 塞进 rcRows=2 的滚动窗口，屏幕上叠成六行。
    const body = JSON.stringify({
      wireMagic: 'pb3', pens: [{}],
      wpWinPositions: [{}, { apPoint: 6, rcRows: 2, ccCols: 40 }],
      wsWinStyles: [{}, { sdScrollDir: 3 }],
      events: [
        { tStartMs: 0, id: 1, wpWinPosId: 1, wsWinStyleId: 1 },
        { tStartMs: 40, dDurationMs: 7040, wWinId: 1, segs: [{ utf8: 'did you ever wonder why\nthe kettle always starts to whistle' }] },
        { tStartMs: 3000, dDurationMs: 9000, wWinId: 1, segs: [{ utf8: 'right when you sit down' }] },
      ],
    });
    const { result } = await runScript({
      url: JSON_URL, body, config: BASE,
      respond: (o) => {
        const n = readSubs(o).length;
        const lines = [];
        for (let i = 1; i <= n; i++) lines.push(i + '|译文' + i);
        return { status: 200, body: JSON.stringify({ choices: [{ message: { content: lines.join('\n') }, finish_reason: 'stop' }] }) };
      },
    });
    const doc = JSON.parse(result.body);
    assert(!doc.events.some((e) => e.wWinId !== undefined), 'wWinId 必须被删除（判据不能只看 aAppend）');
    const cues = doc.events.filter((e) => Array.isArray(e.segs));
    for (const c of cues) {
      assertEqual(c.segs[0].utf8.split('\n').length, 2, '每条必须恰好两行，实际: ' + JSON.stringify(c.segs[0].utf8));
    }
    assert(cues[0].dDurationMs <= 3000 - 40, '时长应被 clamp 到下一条起点');
  });

  section('srv3 / XML（iOS 原生 App 用的格式）');

  await check('人工 XML 轨合并出双语 <p>', async () => {
    const { result } = await runScript({ url: XML_URL, body: FIX('YouTube.timedtext.xml'), config: BASE, respond: goodTranslator });
    assert(result && result.body, '应当返回改写后的 body');
    // YouTube 自己在 <p> 里放的就是裸换行，所以默认必须是裸换行而不是数值引用；
    // 数值引用（&#x000A;）只要再过一道转义就成了 &amp;#x000A;，播放器只解一次，屏幕上是字面量。
    assert(/<p[^>]*>[^<]*\n[^<]*<\/p>/.test(result.body), '双语之间默认应当是裸换行');
    assert(!result.body.includes('&#x000A;'), '默认不该再出现数值引用');
    assert(!result.body.includes('&amp;#'), '绝不能出现二次转义');
    assert(result.body.startsWith('<?xml'), 'XML 声明必须保留');
  });

  await check('【回归】srv3 每条 <p> 最多两行——原文必须先拍平', async () => {
    // <s> 标签之间的缩进换行若不清理就写回，一条 cue 在屏幕上会炸成很多行
    // （asr.jp.xml 里的 cue 多数带这种换行）。
    for (const fx of ['asr.jp.xml', 'YouTube.timedtext.xml']) {
      const { result } = await runScript({ url: XML_URL, body: FIX(fx), config: BASE, respond: goodTranslator });
      const blocks = result.body.match(/<p\b[^>]*>[\s\S]*?<\/p>/g) || [];
      assert(blocks.length > 0, fx + ' 应当有 <p> 块');
      for (const b of blocks) {
        assert(xmlLines(b) <= 2, fx + ' 里有 <p> 超过两行: ' + b.slice(0, 160));
        // 裸换行本身是正确写法，但一条 cue 里只能有一个（上原文下译文）
        // 被跳过的 cue（音效标签之类）没有译文，是单行；有译文的必须恰好两行
        assert((b.match(/\n/g) || []).length <= 1, fx + ' 里有 <p> 换行数超过 1: ' + JSON.stringify(b.slice(0, 160)));
      }
    }
  });

  await check('【回归】CJK 词级 <s> 拼接不插入空格', async () => {
    // 不写死夹具里的某个词（换夹具就失效），查的是「任意两个中日文字之间不许有空白」。
    // 先确认夹具里真有「词级 <s> 之间隔着空白」的结构，否则这条检查测不到东西（换夹具时会悄悄变空）
    const CJK_GAP = /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}]\s+[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}]/u;
    const body = FIX('asr.jp.xml');
    const naive = [...body.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/g)].filter((m) => CJK_GAP.test(m[1].replace(/<[^>]+>/g, '')));
    assert(naive.length > 0, '夹具里没有「词级 <s> 之间隔着空白」的日文 cue，这条回归检查测不到东西了');
    const { calls } = await runScript({ url: XML_URL, body, config: BASE, respond: goodTranslator });
    const lines = calls.flatMap((c) => readSubs(c)).map((l) => l.replace(/^\d+\|/, ''));   // 所有批，不只第一批
    const bad = lines.filter((l) => CJK_GAP.test(l));
    assert(bad.length === 0, '日文词之间不应被插入空格（必须先合 >\\s+< 再剥标签），有 ' + bad.length + ' 行，例如: ' + bad[0]);
  });

  await check('【回归】自闭合 <p/> 不会吞掉相邻 cue，不产出非法 XML', async () => {
    const body = '<?xml version="1.0" encoding="utf-8" ?>\n<timedtext format="3"><body>'
      + '<p t="0" d="1000" w="1"/>'
      + '<p t="1000" d="2000" w="1">hello world here</p>'
      + '<p t="3000" d="2000" w="1">second cue text</p>'
      + '</body></timedtext>';
    const { result } = await runScript({
      url: XML_URL, body, config: BASE,
      respond: (o) => {
        const n = readSubs(o).length;
        assertEqual(n, 2, '应当只有两条可翻译 cue');
        return { status: 200, body: JSON.stringify({ choices: [{ message: { content: '1|译一\n2|译二' }, finish_reason: 'stop' }] }) };
      },
    });
    assert(!/\/>[^<]*<\/p>/.test(result.body), '不得出现自闭合标签后跟游离 </p> 的非法结构');
    assert(result.body.includes('hello world here'), '第二条 cue 的正文不能丢');
    assertEqual((result.body.match(/<\/p>/g) || []).length, 2, '闭合标签数量应当匹配');
  });

  await check('【回归】自闭合 <p/> 也要脱离滚动窗口：删 w=、参与 clamp、a="1" 时整段删', async () => {
    // 滚动轨里的自闭合 <p/> 同样带着 w=。解析时若直接跳过它，
    // 它既不删 w= 也不参与时长 clamp，会留在滚动窗口里和改写后的双语 cue 打架。
    const body = '<?xml version="1.0" encoding="utf-8" ?>\n<timedtext format="3"><body>'
      + '<p t="0" d="9000" w="1"/>'
      + '<p t="1000" d="2000" w="1" a="1"/>'
      + '<p t="1000" d="2000" w="1">hello world here</p>'
      + '<p t="3000" d="2000" w="1">second cue text</p>'
      + '</body></timedtext>';
    const { result } = await runScript({
      url: XML_URL, body, config: BASE,
      respond: goodTranslator,
    });
    assert(!/<p\b[^>]*\sw=/.test(result.body), '自闭合 <p/> 的 w= 也应被删除');
    assert(!/<p\b[^>]*\sa=["']?1/.test(result.body), '自闭合的 a="1" 续接事件也应被整段删除');
    const sc = result.body.match(/<p ([^>]*)\/>/);
    assert(sc, '自闭合标签本身应保留');
    const d = sc[1].match(/\bd=["']?(\d+)/);
    assert(d && +d[1] <= 1000, '自闭合 cue 的 d= 应被 clamp 到下一条开始（≤1000），实际: ' + sc[1]);
  });

  await check('【回归】自闭合 <p/> 不能当 clamp 锚点：正文时长要 clamp 到下一条正文', async () => {
    // 自闭合标记屏幕上什么都不显示。若拿它的 t= 当锚点，前一条正文的 d= 会被
    // 砍短、字幕提前消失（本例里会砍成 d=1000，而不是 d=4000）。
    const body = '<?xml version="1.0" encoding="utf-8" ?>\n<timedtext format="3"><body>'
      + '<p t="0" d="5000" w="1">alpha beta gamma</p>'
      + '<p t="1000" d="500" w="1"/>'
      + '<p t="4000" d="2000" w="1">delta epsilon zeta</p>'
      + '</body></timedtext>';
    const { result } = await runScript({ url: XML_URL, body, config: BASE, respond: goodTranslator });
    const first = result.body.match(/<p ([^>]*)>[^<]*alpha/);
    assert(first, '第一条正文 cue 应保留');
    const d = first[1].match(/\bd=["']?(\d+)/);
    assertEqual(+d[1], 4000, '正文的 d= 应 clamp 到下一条正文（t=4000），而不是中间的空标记（t=1000）');
  });

  await check('【回归】缺 t= 的自闭合 <p/> 不得掐断 clamp 链条', async () => {
    // 自闭合标记常常没有 t=。若 clamp 只看紧邻的下一条 keep，取不到 t 就放弃，
    // 前一条正文的越界时长（滚动模式的惯用写法）就漏 clamp，出现同屏叠字。
    const body = '<?xml version="1.0" encoding="utf-8" ?>\n<timedtext format="3"><body>'
      + '<p t="0" d="9000" w="1">one two three</p>'
      + '<p w="1"/>'
      + '<p t="3000" d="9000" w="1">four five six</p>'
      + '<p t="6000" d="2000" w="1">seven eight nine</p>'
      + '</body></timedtext>';
    const { result } = await runScript({ url: XML_URL, body, config: BASE, respond: goodTranslator });
    const first = result.body.match(/<p ([^>]*)>[^<]*one/);
    const d1 = first[1].match(/\bd=["']?(\d+)/);
    assertEqual(+d1[1], 3000, '第一条的 d= 必须越过无 t= 的空标记，clamp 到 t=3000');
    const second = result.body.match(/<p ([^>]*)>[^<]*four/);
    const d2 = second[1].match(/\bd=["']?(\d+)/);
    assertEqual(+d2[1], 3000, '第二条也要照常 clamp（链条不许断）');
  });

  await check('【回归】srv3 滚动轨脱离窗口：删 w=、删 a="1"、clamp d=', async () => {
    const { result } = await runScript({ url: XML_URL, body: FIX('asr.jp.xml'), config: BASE, respond: goodTranslator });
    assert(!/<p\b[^>]*\sw=/.test(result.body), '内容 <p> 的 w= 应被删除（脱离滚动窗口）');
    assert(!/<p\b[^>]*\sa=["']?1/.test(result.body), 'a="1" 续接事件应被整段删除');
    const ps = [...result.body.matchAll(/<p\b([^>]*)>/g)].map((m) => m[1]);
    const times = ps.map((a) => {
      const t = a.match(/\bt=["']?(\d+)/), d = a.match(/\bd=["']?(\d+)/);
      return { t: t ? +t[1] : null, d: d ? +d[1] : null };
    }).filter((x) => x.t !== null);
    let overlaps = 0;
    for (let i = 0; i < times.length - 1; i++) {
      if (times[i].d !== null && times[i].t + times[i].d > times[i + 1].t) overlaps++;
    }
    assertEqual(overlaps, 0, 'srv3 侧也不应再有重叠 cue');
  });

  await check('XML 特殊字符被正确转义', async () => {
    const body = '<?xml version="1.0" encoding="utf-8" ?>\n<timedtext format="3"><body>'
      + '<p t="0" d="1000">Tom &amp; Jerry &lt;3 &quot;quoted&quot;</p></body></timedtext>';
    const { result } = await runScript({
      url: XML_URL, body, config: BASE,
      respond: (o) => {
        const user = JSON.parse(o.body).messages[1].content;
        assert(user.includes('Tom & Jerry <3 "quoted"'), '实体应当先解码再送翻译');
        return { status: 200, body: JSON.stringify({ choices: [{ message: { content: '1|汤姆 & 杰瑞 <3' } , finish_reason: 'stop'}] }) };
      },
    });
    assert(result.body.includes('&lt;3'), '译文里的 < 应写成 &lt;');
    assert(result.body.includes('&amp;'), '译文里的 & 应写成 &amp;');
  });

  await check('【回归】srv3 的 1 行高窗口放宽到 2 行，否则中文那行被裁掉', async () => {
    // 一条轨可以同时定义 rc="2" 与 rc="1" 两个窗口，而正文 cue 引用的可能正是
    // rc="1" 那个 —— 双语第二行会被播放器裁掉。
    // json3 与 XML 两条路径都要放宽，保持对称。
    const body = '<?xml version="1.0" encoding="utf-8" ?>\n<timedtext format="3"><head>'
      + '<ws id="1" ju="2"/>'
      + '<wp id="2" ap="7" ah="50" av="100" rc="2" cc="32"/>'
      + '<wp id="1" ap="7" ah="50" av="93" rc="1" cc="32"/>'
      + '<wp id="3" ap="7" rc="10" cc="32"/>'
      + '</head><body>'
      + '<p t="0" d="2000" wp="1" ws="1">hello world here</p>'
      + '<p t="2000" d="2000" wp="2" ws="1">second cue text</p>'
      + '</body></timedtext>';
    const { result } = await runScript({ url: XML_URL, body, config: BASE, respond: goodTranslator });
    const wps = [...result.body.matchAll(/<wp id="(\d+)"[^>]*rc="(\d+)"/g)].map((m) => [m[1], m[2]]);
    assertEqual(JSON.stringify(wps), JSON.stringify([['2', '2'], ['1', '2'], ['3', '10']]),
      'rc="1" 应放宽为 2；rc="2" 不动；rc="10" 绝不能被误伤');
    assert(result.body.includes('hello world here\n[zh]'), 'cue 本身仍是双语两行');
    assert(result.body.includes('av="93"'), '窗口的其余属性（位置等）一律不动');
  });

  section('srv1（不带 fmt 参数时 YouTube 返回的旧格式）');

  await check('【回归】<transcript><text> 格式也能翻译', async () => {
    const body = '<?xml version="1.0" encoding="utf-8" ?><transcript>'
      + '<text start="1.5" dur="2.0">hello there friend</text>'
      + '<text start="4.0" dur="2.5">how are you today</text></transcript>';
    const { result, calls } = await runScript({
      url: BARE_URL, body, config: BASE,
      respond: (o) => {
        assertEqual(readSubs(o).length, 2, '应当解析出两条');
        return { status: 200, body: JSON.stringify({ choices: [{ message: { content: '1|你好朋友\n2|今天还好吗' }, finish_reason: 'stop' }] }) };
      },
    });
    assertEqual(calls.length, 1, '应当发一次请求');
    assert(result.body.includes('你好朋友'), 'srv1 也应当被翻译');
    assert(result.body.includes('<transcript>'), '根节点必须保留');
    for (const b of result.body.match(/<text\b[^>]*>[\s\S]*?<\/text>/g) || []) {
      assertEqual(xmlLines(b.replace(/^<text/, '<p').replace(/<\/text>$/, '</p>')), 2, '每条必须恰好两行');
    }
  });

  section('渲染补充：非滚动轨 clamp、窗口居中；附短提示词与整轮耗时统计');

  await check('三档统一用短提示词；用户自填的三档都用', async () => {
    /* 三档（速度 / 质量 / 补翻）都用短版提示词，理由不一样。
       速度档要抢首屏：专业版长得多，会把单批耗时的尾巴拖长。
       质量档与补翻档时间宽裕，用短版是为了逐行对齐：提示词里的约束越多，越容易出跨行错位与漏译；
       后台补翻开思考也是配着短版用的。
       三档一致还有一个好处：共用缓存时，同一批不会因为先被哪一档翻到而文风不同。
       专业版模板本身留在源码里（下面有一条守它还在），只是默认不用。                        */
    const events = [];
    for (let i = 0; i < 60; i++) events.push({ tStartMs: i * 2000, dDurationMs: 1500, segs: [{ utf8: 'tier line ' + i }] });
    const body = json3(events);
    const sys = (o) => JSON.parse(o.body).messages[0].content;
    const store = new Map();
    const conf = cfg({ chunkSize: 10, fastConcurrency: 3, concurrency: 3, cache: true, probe: true, fastBudgetMs: 1000 });
    const seenFast = [];
    await runScript({ url: M_JSON_URL, body, config: conf, store, respond: (o) => { seenFast.push(sys(o)); return Object.assign(goodTranslator(o), { delay: 600 }); } });
    assert(seenFast.length > 0, '速度档应当有请求');
    assert(seenFast.every((s) => s.includes('行内可用逗号')), '速度档应当用短版');
    assert(seenFast.every((s) => !s.includes('专业字幕规范')), '速度档不该带专业版条款');
    // 第二轮能进质量档且还有活干，依赖的是「首波 3 批 600ms 才回 → now + expectedCallMs(450) > 1000 拒发第二波」
    // 这道算术；日后改 fastBudgetMs 或 expectedCallMs 的预留公式，这里 seenQ 变空是真信号不是抖动。
    const seenQ = [];
    await runScript({ url: M_JSON_URL, body, config: conf, store, respond: (o) => { seenQ.push(sys(o)); return goodTranslator(o); } });
    assert(seenQ.length > 0, '质量档应当翻剩下的批');
    assert(seenQ.every((s) => s.includes('行内可用逗号')), '质量档也用短版');
    assert(seenQ.every((s) => !s.includes('专业字幕规范')), '质量档不该带专业版条款');

    // 用户自填的 systemPrompt：各档都用它（速度档与质量档都要验，只验一档会漏）
    const confU = cfg({ chunkSize: 10, fastConcurrency: 3, concurrency: 3, cache: true, fastBudgetMs: 1000, systemPrompt: 'CUSTOM-PROMPT {{to}}' });
    const storeU = new Map();
    const seenU = [];
    await runScript({ url: M_JSON_URL, body, config: confU, store: storeU, respond: (o) => { seenU.push(sys(o)); return Object.assign(goodTranslator(o), { delay: 600 }); } });
    const seenUQ = [];
    await runScript({ url: M_JSON_URL, body, config: confU, store: storeU, respond: (o) => { seenUQ.push(sys(o)); return goodTranslator(o); } });
    assert(seenU.length > 0 && seenU.every((s) => s.startsWith('CUSTOM-PROMPT 简体中文')), '速度档用自填的');
    assert(seenUQ.length > 0 && seenUQ.every((s) => s.startsWith('CUSTOM-PROMPT 简体中文')), '质量档也用自填的');

    // 非中文目标语：两档都用英文短版（英文专业版有 "## Punctuation" 段，短版没有）
    const confJ = cfg({ chunkSize: 10, fastConcurrency: 3, concurrency: 3, cache: true, fastBudgetMs: 1000, targetLang: 'Japanese' });
    const storeJ = new Map();
    const seenJF = [];
    await runScript({ url: M_JSON_URL, body, config: confJ, store: storeJ, respond: (o) => { seenJF.push(sys(o)); return Object.assign(goodTranslator(o), { delay: 600 }); } });
    const seenJQ = [];
    await runScript({ url: M_JSON_URL, body, config: confJ, store: storeJ, respond: (o) => { seenJQ.push(sys(o)); return goodTranslator(o); } });
    assert(seenJF.length > 0 && seenJF.every((s) => s.includes('Line-to-line correspondence') && !s.includes('## Punctuation')), '非中文速度档用英文短版');
    assert(seenJQ.length > 0 && seenJQ.every((s) => s.includes('## Punctuation') === false), '非中文质量档也用英文短版');

    // 专业版模板默认用不到，留着是为了以后能换回去：守住它不被当成死代码清掉
    assert(/var BUILTIN_SYSTEM_ZH = \[/.test(SCRIPT) && /var BUILTIN_SYSTEM_EN = \[/.test(SCRIPT),
           '专业版模板应当仍然保留在源码里');
  });

  await check('【回归】非滚动轨（人工/歌词）重叠的 cue 也 clamp 时长，双语两行不再叠在一起', async () => {
    // 歌词轨常见下一行在上一行结束前就开始：不 clamp 的话，上一条的中文会压在下一条的英文上。
    const xml = '<?xml version="1.0" encoding="utf-8" ?><timedtext format="3"><head><wp id="1" ap="6" ah="3" av="100" rc="2" cc="34"/></head><body>'
      + '<p t="1000" d="3000" wp="1">first line of lyric</p><p t="2000" d="2000" wp="1">second line of lyric</p><p t="6000" d="1000" wp="1">third line</p></body></timedtext>';
    const { result } = await runScript({ url: XML_URL, body: xml, config: BASE, respond: goodTranslator });
    const out = result.body;
    assert(/<p t="1000" d="1000"/.test(out), '第一条与第二条重叠 2 秒，时长应砍到下一条开始：' + out.slice(0, 400));
    assert(/<p t="2000" d="2000"/.test(out), '第二条与第三条不重叠，时长不动');
    assert(/<p t="6000" d="1000"/.test(out), '最后一条不动');
    const j = json3([
      { tStartMs: 1000, dDurationMs: 3000, segs: [{ utf8: 'first line of lyric' }] },
      { tStartMs: 2000, dDurationMs: 2000, segs: [{ utf8: 'second line of lyric' }] },
    ]);
    const r2 = await runScript({ url: JSON_URL, body: j, config: BASE, respond: goodTranslator });
    const doc = JSON.parse(r2.result.body);
    assertEqual(doc.events[0].dDurationMs, 1000, 'json3 同样 clamp');
    assertEqual(doc.events[1].dDurationMs, 2000, 'json3 不重叠的不动');

    // 起播只差 200ms（分左右的双人对白 / 和声）：字幕制作者故意同屏，不砍（砍了会变成 200ms 一闪）
    const minMs = +(SCRIPT.match(/var CLAMP_MIN_MS = (\d+)/) || [])[1];
    assert(minMs >= 200, '应当能从源码读到 CLAMP_MIN_MS');
    const xml2 = '<?xml version="1.0" encoding="utf-8" ?><timedtext format="3"><head><wp id="1" ap="6" ah="3" av="100" rc="2" cc="34"/><wp id="2" ap="8" ah="97" av="100" rc="2" cc="34"/></head><body>'
      + '<p t="1000" d="4000" wp="1">speaker one talking</p><p t="1200" d="3800" wp="2">speaker two talking</p><p t="6000" d="2000" wp="1">later line</p></body></timedtext>';
    const r3 = await runScript({ url: XML_URL, body: xml2, config: BASE, respond: goodTranslator });
    assert(/<p t="1000" d="4000"/.test(r3.result.body), '起播只差 200ms 的两条不砍：' + r3.result.body.slice(0, 400));
    assert(/<p t="1200" d="3800"/.test(r3.result.body), '第二条与下一条隔 4.8 秒，不重叠不动');
    const j2 = json3([
      { tStartMs: 1000, dDurationMs: 4000, segs: [{ utf8: 'speaker one talking' }] },
      { tStartMs: 1200, dDurationMs: 3800, segs: [{ utf8: 'speaker two talking' }] },
      { tStartMs: 6000, segs: [{ utf8: 'no duration here' }] },
      { tStartMs: 7000, dDurationMs: 1000, segs: [{ utf8: 'last line' }] },
    ]);
    const r4 = await runScript({ url: JSON_URL, body: j2, config: BASE, respond: goodTranslator });
    const doc2 = JSON.parse(r4.result.body);
    assertEqual(doc2.events[0].dDurationMs, 4000, 'json3 起播只差 200ms 的不砍');
    assertEqual(doc2.events[2].dDurationMs, undefined, 'json3 非滚动轨时长缺失时不补（与 srv3 一致）');
  });

  await check('【回归】歌词轨的窗口全都锚在左下角时改成水平居中，不再时左时右；分左右的双人轨不碰', async () => {
    const wrap = (wps) => '<?xml version="1.0" encoding="utf-8" ?><timedtext format="3"><head>' + wps + '</head><body>'
      + '<p t="0" d="1000" wp="1">hello there friend</p><p t="2000" d="1000" wp="2">second line here</p></body></timedtext>';
    const wpsOf = (r) => r.result.body.match(/<wp\b[^>]*>/g);
    // 全部相同锚点、只差宽度 → 底部居中，垂直不动
    let r = await runScript({ url: XML_URL, body: wrap('<wp id="1" ap="6" ah="3" av="100" rc="2" cc="34"/><wp id="2" ap="6" ah="3" av="100" rc="2" cc="40"/>'), config: BASE, respond: goodTranslator });
    let wps = wpsOf(r);
    assert(wps.length === 2 && wps.every((t) => /\bap="7"/.test(t) && /\bah="50"/.test(t) && /\bav="100"/.test(t)), '应改成底部居中：' + wps.join(' '));
    assert(wps[0].includes('cc="34"') && wps[1].includes('cc="40"'), '宽度与其余属性不动');
    // 顶部左锚 → 顶部居中（只改水平，垂直留在顶部）
    r = await runScript({ url: XML_URL, body: wrap('<wp id="1" ap="0" ah="3" av="0" rc="2" cc="34"/><wp id="2" ap="0" ah="3" av="0" rc="2" cc="40"/>'), config: BASE, respond: goodTranslator });
    wps = wpsOf(r);
    assert(wps.every((t) => /\bap="1"/.test(t) && /\bah="50"/.test(t) && /\bav="0"/.test(t)), '顶部的只改水平：' + wps.join(' '));
    // 锚点各不相同（双人分左右）→ 一个都不动
    r = await runScript({ url: XML_URL, body: wrap('<wp id="1" ap="6" ah="3" av="100" rc="2" cc="34"/><wp id="2" ap="8" ah="97" av="100" rc="2" cc="34"/>'), config: BASE, respond: goodTranslator });
    wps = wpsOf(r);
    assert(/ap="6" ah="3"/.test(wps[0]) && /ap="8" ah="97"/.test(wps[1]), '分左右的轨不动：' + wps.join(' '));
    // 已经居中（ASR 轨的样子）→ 输出逐字节不变（这条只是护栏：居中改写对已居中的窗口本就是幂等的）
    const asrHead = '<wp id="0"/><wp id="1" ap="7" ah="50" av="100" rc="2" cc="40"/>';
    r = await runScript({ url: XML_URL, body: wrap(asrHead), config: BASE, respond: goodTranslator });
    assert(r.result.body.includes(asrHead), '已居中的原样保留');
    // 只有一个带锚点的窗口 → 不动（单窗口避开画面图形的字幕不能被搬到中线）
    const single = '<wp id="1" ap="6" ah="10" av="90" rc="2" cc="30"/><wp id="2" ap="6" ah="10" av="90" rc="2" cc="30"/>';
    r = await runScript({ url: XML_URL, body: wrap('<wp id="1" ap="6" ah="10" av="90" rc="2" cc="30"/>').replace('wp="2"', 'wp="1"'), config: BASE, respond: goodTranslator });
    assert(/ap="6" ah="10" av="90"/.test(r.result.body), '单窗口的轨不动：' + r.result.body.slice(0, 300));
    // 两个窗口锚点相同但宽度也相同 → 「只差宽度」的证据不存在，不动
    r = await runScript({ url: XML_URL, body: wrap(single), config: BASE, respond: goodTranslator });
    assert(r.result.body.includes(single), '宽度全相同的轨不动');
    // 没有 ap 只有 ah 的窗口 → 不动（只改 ah 会把窗口左边缘推到中线，比原来更偏）
    const ahOnly = '<wp id="1" ah="10" av="90" rc="2" cc="30"/><wp id="2" ah="10" av="90" rc="2" cc="40"/>';
    r = await runScript({ url: XML_URL, body: wrap(ahOnly), config: BASE, respond: goodTranslator });
    assert(r.result.body.includes(ahOnly), '无锚点的窗口不动：' + r.result.body.slice(0, 300));
    // json3 同一规则
    const jd = { wireMagic: 'pb3', pens: [{}], wsWinStyles: [{}],
      wpWinPositions: [{}, { apPoint: 6, ahHorPos: 3, avVerPos: 100, rcRows: 2, ccCols: 34 }, { apPoint: 6, ahHorPos: 3, avVerPos: 100, rcRows: 2, ccCols: 40 }],
      events: [{ tStartMs: 0, dDurationMs: 1000, wpWinPosId: 1, segs: [{ utf8: 'hello there friend' }] }, { tStartMs: 2000, dDurationMs: 1000, wpWinPosId: 2, segs: [{ utf8: 'second line here' }] }] };
    r = await runScript({ url: JSON_URL, body: JSON.stringify(jd), config: BASE, respond: goodTranslator });
    const wp = JSON.parse(r.result.body).wpWinPositions;
    assertEqual(wp[1].apPoint, 7); assertEqual(wp[1].ahHorPos, 50); assertEqual(wp[1].avVerPos, 100); assertEqual(wp[2].ccCols, 40);
    assertEqual(JSON.stringify(wp[0]), '{}', '无定位的默认窗口不动');
    const jd2 = JSON.parse(JSON.stringify(jd)); jd2.wpWinPositions[2] = { apPoint: 8, ahHorPos: 97, avVerPos: 100, rcRows: 2, ccCols: 34 };
    r = await runScript({ url: JSON_URL, body: JSON.stringify(jd2), config: BASE, respond: goodTranslator });
    assertEqual(JSON.parse(r.result.body).wpWinPositions[1].ahHorPos, 3, 'json3 分左右的轨不动');
    const jd3 = JSON.parse(JSON.stringify(jd)); jd3.wpWinPositions = [{}, { ahHorPos: 0, avVerPos: 100, rcRows: 2, ccCols: 34 }, { ahHorPos: 0, avVerPos: 100, rcRows: 2, ccCols: 40 }];
    r = await runScript({ url: JSON_URL, body: JSON.stringify(jd3), config: BASE, respond: goodTranslator });
    assertEqual(JSON.parse(r.result.body).wpWinPositions[1].ahHorPos, 0, 'json3 没有 apPoint 只有 ahHorPos 的窗口不动');
    const jd4 = JSON.parse(JSON.stringify(jd)); jd4.wpWinPositions = [{}, { apPoint: 6, ahHorPos: 3, avVerPos: 100, rcRows: 2, ccCols: 34 }];
    jd4.events = [jd4.events[0]];
    r = await runScript({ url: JSON_URL, body: JSON.stringify(jd4), config: BASE, respond: goodTranslator });
    assertEqual(JSON.parse(r.result.body).wpWinPositions[1].ahHorPos, 3, 'json3 单窗口的轨不动');
  });

  await check('诊断里的 callMin/Max/P90 统计整轮全部调用，不只是最近 8 次', async () => {
    // 若只看准入用的最近 8 个样本，那正好是最晚落地的几批，callMin 会被抬高、分布报歪。
    const events = [];
    for (let i = 0; i < 120; i++) events.push({ tStartMs: i * 2000, dDurationMs: 1500, segs: [{ utf8: 'stats line ' + i }] });
    let n = 0;
    const r = await runScript({
      url: JSON_URL, body: json3(events), config: cfg({ chunkSize: 10, fastConcurrency: 12, probe: true, fastBudgetMs: 3000 }),
      respond: (o) => { n++; return Object.assign(goodTranslator(o), { delay: 60 * n }); },
    });
    const d = JSON.parse(r.store.get('llmsubs.diag')).slice(-1)[0].chunks;
    assertEqual(d.started, 12, '前提：12 批一波');
    assert(d.callMin <= 120, '最短的那次（60ms）必须在统计里，实际 ' + d.callMin);
    assert(d.callMax >= 660, '最长的那次（720ms）必须在统计里，实际 ' + d.callMax);
    assert(d.callP90 >= 600 && d.callP90 <= d.callMax, 'p90 应当落在高位，实际 ' + d.callP90);
  });

  section('换行写法与 A/B 探针');

  await check('srv3 默认用裸换行，且绝不二次转义', async () => {
    const { result } = await runScript({ url: XML_URL, body: FIX('asr.jp.xml'), config: BASE, respond: goodTranslator });
    assert(!result.body.includes('&amp;#'), '出现 &amp;# 就说明数值引用被二次转义了');
    assert(!result.body.includes('&#x000A;'), '默认不该用数值引用');
    assert(/<p[^>]*>[^<]*\n[^<]*<\/p>/.test(result.body), '应当是裸换行');
  });

  await check('nlProbe=rotate 轮转全部换行写法并打标签', async () => {
    const events = [];
    for (let i = 0; i < 8; i++) events.push({ tStartMs: i * 2000, dDurationMs: 1500, segs: [{ utf8: 'line number ' + i }] });
    const xml = '<?xml version="1.0" ?><timedtext format="3"><body>'
      + events.map((e, i) => '<p t="' + (i * 2000) + '" d="1500">line number ' + i + '</p>').join('')
      + '</body></timedtext>';
    const { result } = await runScript({
      url: XML_URL, body: xml, config: cfg({ nlProbe: 'rotate', probe: true }), respond: goodTranslator,
    });
    assert(result && result.body, '应当有输出');
    for (const tag of ['1RAW', '2HEX', '3DEC', '4BR', '5ZWSP', '6CRLF', '7LIT']) {
      assert(result.body.includes('[' + tag + ']'), '缺少变体标签 ' + tag);
    }
    assert(result.body.includes('&#x000A;'), '2HEX 变体应当出现数值引用');
    assert(/<br\s*\/?>/.test(result.body), '4BR 变体应当出现 <br/>');
    assert(!result.body.includes('&amp;#'), '变体本身不得被二次转义');
  });

  await check('nlProbe 指定单个变体用于回归验证', async () => {
    const xml = '<?xml version="1.0" ?><timedtext format="3"><body><p t="0" d="1500">line number one</p></body></timedtext>';
    const { result } = await runScript({
      url: XML_URL, body: xml, config: cfg({ nlProbe: '3DEC', probe: true }), respond: goodTranslator,
    });
    assert(result.body.includes('&#10;'), '应当只用 3DEC 写法');
    assert(result.body.includes('[3DEC]'), '应当带标签');
    assert(!result.body.includes('[1RAW]'), '不应轮转');
  });

  section('WebVTT（iOS 原生 HLS 播放器与 fmt=vtt 用的格式）');

  const VTT_URL = 'https://www.youtube.com/api/timedtext?v=abc123&lang=en&fmt=vtt&caps=asr';
  const vtt = (body) => 'WEBVTT\nKind: captions\nLanguage: en\n\n' + body;

  await check('VTT 双语两行，时间轴与 cue 设置原样保留', async () => {
    const body = vtt(
      '00:00:01.000 --> 00:00:03.000 align:start position:0%\nhello world here\n\n'
      + '00:00:03.500 --> 00:00:06.000\nsecond cue line\n');
    const { result } = await runScript({ url: VTT_URL, body, config: BASE, respond: goodTranslator });
    assert(result && result.body, 'VTT 应当被改写');
    const out = result.body;
    assert(out.indexOf('WEBVTT') === 0, '头部必须原样保留');
    assert(out.includes('Kind: captions') && out.includes('Language: en'), '头部元数据不能丢');
    assert(out.includes('00:00:01.000 --> 00:00:03.000 align:start position:0%'), '时间轴与 cue 设置必须原样保留');
    assert(out.includes('hello world here\n[zh]hello world here'), '应当是「英文\\n中文」两行: ' + out);
    assert(out.includes('second cue line\n[zh]second cue line'), '第二条也要双语');
  });

  await check('VTT 逐词高亮标签被剥掉，不会连标签一起送翻译', async () => {
    const body = vtt('00:00:01.000 --> 00:00:03.000\n<c.colorE5E5E5>hello</c> <00:00:02.000><c>world here</c>\n');
    const { result, calls } = await runScript({ url: VTT_URL, body, config: BASE, respond: goodTranslator });
    const sent = readSubs(calls[0])[0];
    assert(!sent.includes('<'), '送翻译的文本不该带标签: ' + sent);
    assert(sent.includes('hello world here'), '文本应当被正确拼出: ' + sent);
    assert(!result.body.includes('<c'), '写回也不该再有标签');
  });

  await check('VTT 写回时 > 也转义：正文里的「-->」不能变成一条新的时间轴', async () => {
    // 播放器把含「-->」的行当成时间轴行。原文里合法写成 --&gt; 的箭头解码后是 -->，模型也可能交回一行时间轴样子的字；
    // 这两种原样写回，都会在轨里多造出一条 cue 或把这条字幕截断。一行里有两个箭头时两个都要转
    const body = vtt('00:00:01.000 --> 00:00:03.000\nfirst a --&gt; b then b --&gt; c and 5 &gt; 3\n');
    const { result } = await runScript({
      url: VTT_URL, body, config: BASE,
      respond: () => ({ status: 200, body: JSON.stringify({ choices: [{ message: { content: '1|x --> 00:00:00.000 --> 09:00:00.000 line:0' }, finish_reason: 'stop' }] }) }),
    });
    assert(result && result.body, '前提：这条轨被翻译并写回了');
    const lines = result.body.split('\n');
    const arrows = lines.filter((l) => l.indexOf('-->') >= 0);
    assertEqual(arrows.length, 1, '只有原来那一条时间轴行带「-->」：' + JSON.stringify(arrows));
    assert(result.body.includes('a --&gt; b then b --&gt; c'), '原文里的两个箭头都写回成 --&gt;');
    assert(result.body.includes('x --&gt; 00:00:00.000 --&gt; 09:00:00.000'), '译文里时间轴样子的字也只是文字');
    assert(result.body.includes('5 &gt; 3'), '单独的 > 同样转义');
    assertEqual(lines.filter((l) => l.indexOf('>') >= 0 && l.indexOf('-->') < 0).length, 0, '正文行里不留裸的 >');
  });

  await check('VTT 转义只用规范认的实体：绝不能出现 &quot;', async () => {
    const body = vtt('00:00:01.000 --> 00:00:03.000\nTom &amp; Jerry said "hi" 3 &lt; 5\n');
    const { result, calls } = await runScript({
      url: VTT_URL, body, config: BASE,
      respond: (o) => {
        const user = JSON.parse(o.body).messages[1].content;
        assert(user.includes('Tom & Jerry said "hi" 3 < 5'), '实体应当先解码再送翻译');
        return { status: 200, body: JSON.stringify({ choices: [{ message: { content: '1|汤姆 & 杰瑞说 "嗨" 3 < 5' }, finish_reason: 'stop' }] }) };
      },
    });
    assert(result.body.includes('&amp;'), '& 应当转义');
    assert(result.body.includes('&lt;'), '< 应当转义');
    assert(!result.body.includes('&quot;'), 'VTT 不认 &quot; —— 用户会看到字面量');
    assert(result.body.includes('"'), '引号应当原样保留');
  });

  await check('VTT 的 cue 标识行不会被当成正文', async () => {
    const body = vtt('cue-1\n00:00:01.000 --> 00:00:03.000\nhello world here\n');
    const { result, calls } = await runScript({ url: VTT_URL, body, config: BASE, respond: goodTranslator });
    assertEqual(readSubs(calls[0]).length, 1, '只有一条可翻译 cue');
    assert(result.body.includes('cue-1\n00:00:01.000'), '标识行必须原样保留');
  });

  await check('【回归】VTT 的探针骨架不得带出字幕正文（各种「看起来像结构行」的正文）', async () => {
    // XML 那套「把 > < 之间的文本换成 ·」对 VTT 不适用（它没有标签）。
    // 「看起来像结构行就放行」的启发式白名单也不行：说话人标签（NARRATOR:）、
    // 含 --> 的正文、纯数字行、URL 开头的行都会被整句放行进诊断报告。
    // 所以遮蔽必须由解析器按块结构定位，不能靠猜。
    const body = vtt(
      '00:00:01.000 --> 00:00:03.000\nNARRATOR: SECRETALPHA my confession\n\n'
      + '00:00:03.500 --> 00:00:06.000\n42\n\n'
      + '00:00:06.500 --> 00:00:09.000\nSECRETBETA --> hunter2 is it\n\n'
      + '00:00:09.500 --> 00:00:12.000\nhttps://example.com/SECRETGAMMA-link\n\n'
      + '00:00:12.500 --> 00:00:15.000\nSUPERSECRETLINE here we go\n');
    const { store } = await runScript({ url: VTT_URL, body, config: cfg({ probe: true }), respond: goodTranslator });
    const dump = store.get('llmsubs.diag');
    for (const secret of ['SECRETALPHA', 'SECRETBETA', 'SECRETGAMMA', 'SUPERSECRETLINE', 'hunter2', 'NARRATOR']) {
      assert(!dump.includes(secret), '绝不能出现字幕正文片段 ' + secret);
    }
    const r = JSON.parse(dump)[0];
    assertEqual(r.sub.format, 'vtt', '应当记录检测到的格式是 vtt');
    assert(r.sub.skeleton.includes('-->'), '骨架应保留时间轴结构');
    assert(r.sub.skeleton.includes('WEBVTT'), '骨架应保留头部');
    assert(r.sub.skeleton.includes('·'), '正文行应被换成 ·');
  });

  await check('【回归】CRLF 换行的 VTT 不会塌成一条 cue', async () => {
    // CRLF 的空行是 \r\n\r\n，匹配不上 \n[ \t]*\n。若用一条大正则抓「到空行为止」，
    // 整份字幕会塌成一条 cue，后面所有时间轴被当正文吞掉，
    // 还不触发 fail-open（items>=1、输出够长），500 条 cue 会变成一个巨型 prompt。
    const body = 'WEBVTT\r\n\r\n00:00:01.000 --> 00:00:03.000\r\nHello world here\r\n\r\n'
      + '00:00:03.500 --> 00:00:05.000\r\nSecond cue line\r\n\r\n'
      + '00:00:06.000 --> 00:00:08.000\r\nThird cue line\r\n';
    const { result, calls } = await runScript({ url: VTT_URL, body, config: BASE, respond: goodTranslator });
    const sent = readSubs(calls[0]);
    assertEqual(sent.length, 3, 'CRLF 下也必须是 3 条 cue，实际 ' + JSON.stringify(sent));
    for (const line of sent) assert(!line.includes('-->'), '时间轴绝不能被当成正文送翻译: ' + line);
    assertEqual((result.body.match(/-->/g) || []).length, 3, '三条时间轴都必须原样保留');
  });

  await check('【回归】空载荷 cue 不会吞掉下一条 cue 的时间轴', async () => {
    // 时间轴行后直接是空行时，用懒惰量词匹配正文会一路吃到下一条 cue，
    // 把下一条的时间轴当正文替换掉——那条 cue 就被永久删除了。
    const body = vtt('00:00:01.000 --> 00:00:03.000\n\n00:00:03.500 --> 00:00:05.000\nBravo here now\n');
    const { result, calls } = await runScript({ url: VTT_URL, body, config: BASE, respond: goodTranslator });
    const sent = readSubs(calls[0]);
    assertEqual(sent.length, 1, '只有一条有正文的 cue');
    assert(!sent[0].includes('-->'), '时间轴不该被当成正文: ' + sent[0]);
    assertEqual((result.body.match(/-->/g) || []).length, 2, '两条时间轴都必须还在');
    assert(result.body.includes('Bravo here now\n[zh]'), '有正文的那条应被双语替换');
  });

  await check('【回归】多物理行的 cue 写回后恰好两行（拍平后与送翻译的是同一份）', async () => {
    // VTT 里一条 cue 的正文跨多行是常态。若写回用未拍平的原文、送翻译用拍平文本，
    // 屏幕上这条 cue 会炸成三行——与 srv3 路径是同一类问题。
    const body = vtt('00:00:01.000 --> 00:00:03.000\nfirst physical line\nsecond physical line\n');
    const { result, calls } = await runScript({ url: VTT_URL, body, config: BASE, respond: goodTranslator });
    assertEqual(readSubs(calls[0]).length, 1, '两行物理文本属于同一条 cue');
    const block = result.body.split('00:00:01.000 --> 00:00:03.000\n')[1].replace(/\n+$/, '');
    assertEqual(block.split('\n').length, 2, 'cue 正文必须恰好两行（英文一行、中文一行），实际: ' + JSON.stringify(block));
    assert(block.startsWith('first physical line second physical line'), '英文行应当是拍平后的单行: ' + block);
  });

  await check('VTT 专有实体 &nbsp; / &lrm; 不会被二次转义成字面量', async () => {
    const body = vtt('00:00:01.000 --> 00:00:03.000\nhello&nbsp;world here now\n');
    const { result } = await runScript({ url: VTT_URL, body, config: BASE, respond: goodTranslator });
    assert(!result.body.includes('&amp;nbsp;'), '绝不能出现二次转义的 &amp;nbsp;（屏幕上会显示字面量）');
  });

  await check('VTT 空/无 cue 时 fail-open 放行', async () => {
    const { result, calls } = await runScript({
      url: VTT_URL, body: 'WEBVTT\nKind: captions\n\n', config: BASE, respond: goodTranslator });
    assert(!result || !result.body, '没有可翻译内容应当原样放行');
    assertEqual(calls.length, 0, '不该发请求');
  });
};
