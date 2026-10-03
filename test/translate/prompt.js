'use strict';
/*
 * 提示词：中英两套内置提示词、自定义覆盖、轨道类型、领域术语表、标点兜底、重试提示。
 *
 *   · 提示词体系　语言选择、自定义覆盖、system 角色始终保留
 *   · 提示词细则　轨道类型 / 术语表 / 标点兜底 / 重试提示，以及术语表与领域参与缓存键；
 *     末条 qualityModel（质量档换模型）也放在这里，档位路由的其余用例在 retry.js 与 waves.js
 *
 * 「三档统一用短提示词」这条用例在 formats.js，和渲染用例放在一起；找短提示词的断言去那里。
 */

const { check, assert, assertEqual, section } = require('../lib/harness');
const {
  runScript, SCRIPT, FIX, BASE, cfg, JSON_URL,
  M_JSON_URL, XML_URL, json3, readSubs, goodTranslator,
} = require('../lib/sandbox');

module.exports = async function () {
  section('提示词体系');

  await check('目标语言是中文时用中文提示词', async () => {
    const body = json3([{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'hello world here' }] }]);
    const { calls } = await runScript({
      url: JSON_URL, body, config: cfg({ targetLang: '简体中文' }), respond: goodTranslator,
    });
    const sys = JSON.parse(calls[0].body).messages[0].content;
    assert(/字幕译者/.test(sys) && /逐行对应/.test(sys), '中文目标语应当走中文版提示词');
    assert(sys.includes('简体中文'), '{{to}} 变量应当被替换');
    assert(!sys.includes('{{'), '不应残留未替换的变量');
  });

  await check('目标语言非中文时用英文提示词', async () => {
    const body = json3([{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'hola mundo aqui' }] }]);
    const { calls } = await runScript({
      url: JSON_URL, body, config: cfg({ targetLang: 'Japanese' }), respond: goodTranslator,
    });
    const sys = JSON.parse(calls[0].body).messages[0].content;
    assert(/professional subtitle translator/i.test(sys), '非中文目标语应当走英文版提示词');
    assert(sys.includes('Japanese'), '{{to}} 变量应当被替换');
  });

  await check('自定义提示词覆盖内置，且支持变量', async () => {
    const body = json3([{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'hello world here' }] }]);
    const { calls } = await runScript({
      url: JSON_URL, body,
      config: cfg({ systemPrompt: 'CUSTOM translate into {{to}} only', userPrefix: 'PREFIX {{count}}' }),
      respond: goodTranslator,
    });
    const msgs = JSON.parse(calls[0].body).messages;
    assertEqual(msgs[0].content, 'CUSTOM translate into 简体中文 only', '自定义 system 应当生效并替换变量');
    assert(/^PREFIX 1\n\n/.test(msgs[1].content), '自定义前缀应当出现在 user 消息开头');
    assert(msgs[1].content.includes('<<<SUBS'), '前缀不能破坏定界块');
  });

  await check('system 角色始终保留', async () => {
    const body = json3([{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'hello world here' }] }]);
    const { calls } = await runScript({ url: JSON_URL, body, config: BASE, respond: goodTranslator });
    assertEqual(JSON.parse(calls[0].body).messages[0].role, 'system', '所有 OpenAI 兼容后端都接受 system');
  });

  section('提示词细则：轨道类型 / 术语表 / 标点兜底 / 重试提示');

  const sysOf = (calls, i) => JSON.parse(calls[i || 0].body).messages[0].content;
  // 术语表在 user 消息里（system 要整轨恒定才吃得到端点的前缀缓存）
  const userOf = (calls, i) => JSON.parse(calls[i || 0].body).messages[1].content;
  const promptOf = (calls, i) => sysOf(calls, i) + '\n' + userOf(calls, i);
  const okReply = (content) => ({ status: 200, body: JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }) });

  await check('PROMPT_VER 是 5（提示词一改就要升，旧提示词的缓存才不会再命中）', async () => {
    assert(/var PROMPT_VER = '5'/.test(SCRIPT), 'PROMPT_VER 应为 5');
  });

  await check('人工字幕轨：提示词说明本轨是人工制作、刻意重复要保留', async () => {
    const body = json3([{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'hello world here' }] }]);
    const { calls } = await runScript({ url: JSON_URL, body, config: BASE, respond: goodTranslator });
    const sys = sysOf(calls);
    assert(/人工制作/.test(sys), '应当说明是人工字幕');
    assert(!/自动语音识别/.test(sys), '不应说成 ASR 轨');
    assert(!sys.includes('{{'), '不应残留未替换的变量');
  });

  await check('ASR 轨（URL 带 kind=asr）：提示词说明本轨是自动识别、有口吃与误识别', async () => {
    const body = json3([{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'hello world here' }] }]);
    const { calls } = await runScript({ url: JSON_URL + '&kind=asr', body, config: BASE, respond: goodTranslator });
    assert(/自动语音识别/.test(sysOf(calls)), '应当说明是 ASR 轨');
  });

  await check('ASR 轨（没有 kind 参数但带滚动窗口）：按结构识别为自动识别', async () => {
    const body = json3([
      { id: 1, wsWinStyleId: 1, wpWinPosId: 1, tStartMs: 0, dDurationMs: 5000 },
      { segs: [{ utf8: 'hello world here' }], wWinId: 1, tStartMs: 0, dDurationMs: 1000 },
      { aAppend: 1, segs: [{ utf8: '\n' }], wWinId: 1, tStartMs: 900, dDurationMs: 100 },
      { segs: [{ utf8: 'second line here' }], wWinId: 1, tStartMs: 1000, dDurationMs: 1000 },
    ]);
    const { calls } = await runScript({ url: JSON_URL, body, config: BASE, respond: goodTranslator });
    assert(/自动语音识别/.test(sysOf(calls)), '滚动窗口 = ASR 轨');
  });

  await check('AI 关键词密集的字幕自动附上内置术语表；普通字幕不附', async () => {
    const words = ['we trained the neural network with machine learning', 'the training data and embeddings',
                   'fine-tuning the large language model', 'interpretability and superposition',
                   'reinforcement learning from human feedback', 'deep learning at OpenAI and Anthropic'];
    const ai = [];
    for (let i = 0; i < 12; i++) ai.push({ tStartMs: i * 1000, dDurationMs: 900, segs: [{ utf8: words[i % words.length] }] });
    const a = await runScript({ url: JSON_URL, body: json3(ai), config: BASE, respond: goodTranslator });
    const glA = userOf(a.calls);            // 术语表在 user 消息里，不在 system
    assert(/## 术语表/.test(glA), 'AI 内容应当附术语表');
    assert(glA.includes('"embedding": "嵌入"'), '术语表应含本批出现的内置条目（embeddings 里含 embedding）');
    assert(!glA.includes('"toy model"'), '本批没出现的术语不注入（控制输入 token）');
    assert(!promptOf(a.calls).includes('{{'), '不应残留未替换的变量');
    const plain = [];
    for (let i = 0; i < 12; i++) plain.push({ tStartMs: i * 1000, dDurationMs: 900, segs: [{ utf8: 'we went to the market and bought apples ' + i }] });
    const b = await runScript({ url: JSON_URL, body: json3(plain), config: BASE, respond: goodTranslator });
    assert(!/## 术语表/.test(promptOf(b.calls)), '普通内容不应附术语表');
    assert(!promptOf(b.calls).includes('{{'), '不应残留未替换的变量');
  });

  await check('用户术语表任何题材都生效，且覆盖内置条目', async () => {
    const body = json3([{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'a toy model of the northwind market' }] }]);
    const { calls } = await runScript({
      url: JSON_URL, body,
      config: cfg({ glossary: { 'toy model': '简化模型', 'Northwind': 'Northwind', 'unused term': '不出现' } }),
      respond: goodTranslator,
    });
    const gl = userOf(calls);
    assert(gl.includes('"toy model": "简化模型"'), '用户条目应当出现并覆盖内置');
    assert(gl.includes('"Northwind": "Northwind"'), '原文=译文的「保留英文」条目也应出现（匹配不分大小写）');
    assert(!gl.includes('unused term'), '本批没出现的用户条目也不注入');
  });

  await check('领域识别不被泛用词误触发：训狗 / 加密货币 / 汽修字幕不注入 AI 术语表', async () => {
    const snippets = [
      ['positive reinforcement works best', 'get your dog\'s attention first', 'adjust the parameters of the exercise', 'the training algorithm is simple', 'attention and reinforcement every day', 'a benchmark for good behaviour', 'keep the reinforcement schedule', 'attention is the key parameter'],
      ['this token launched last week', 'the consensus algorithm is proof of stake', 'a benchmark for the tokens', 'token holders vote on parameters', 'the algorithm rewards inference nodes', 'tokens and the benchmark index', 'gradient of the token price', 'tokens tokens tokens'],
      ['check the wheel alignment first', 'the transformer in the ignition coil', 'adjust the alignment parameters', 'a transformer converts the voltage', 'alignment of the front wheels', 'the parameters on the dashboard', 'transformer and alignment done', 'attention to the alignment marks'],
    ];
    for (const lines of snippets) {
      const events = lines.map((l, i) => ({ tStartMs: i * 1000, dDurationMs: 900, segs: [{ utf8: l }] }));
      const { calls } = await runScript({ url: JSON_URL, body: json3(events), config: BASE, respond: goodTranslator });
      const sys = sysOf(calls);
      assert(!/## 术语表/.test(sys), '普通题材不应注入术语表：' + lines[0]);
      assert(!sys.includes('智能体'), '更不该出现 AI 语境的强制译法：' + lines[0]);
    }
  });

  await check('术语表配坏了不污染提示词：数组不算表，引号被剥掉', async () => {
    const body = json3([{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'the x y thing and aaa' }] }]);
    const arr = await runScript({ url: JSON_URL, body, config: cfg({ glossary: ['aaa', 'bbb'] }), respond: goodTranslator });
    assert(!/## 术语表/.test(promptOf(arr.calls)), '数组不是术语表，不应生成 "0": "aaa"');
    const quoted = await runScript({ url: JSON_URL, body, config: cfg({ glossary: { 'x "y': 'a"b' } }), respond: goodTranslator });
    const gl = userOf(quoted.calls);
    assert(gl.includes('"x y": "a b"'), '引号应被剥成空格，实际: ' + (gl.match(/## 术语表[\s\S]*/) || [''])[0].slice(0, 120));
  });

  await check('术语表在 user 消息里、system 整轨逐字恒定（前缀缓存的前提）', async () => {
    // 为什么要守这条：术语表按批变（只带本批出现的词）。它要是放在 system 模板中段，
    // 端点的前缀缓存到这里就断了，后面的模板内容每批都要重新算；所以 system 必须整轨
    // 逐字恒定，术语表放在 user 消息里。挪回去不会有任何可见症状，只能靠测试发现。
    const words = ['we trained the neural network with machine learning', 'the training data and embeddings',
                   'fine-tuning the large language model', 'interpretability and superposition',
                   'reinforcement learning from human feedback', 'deep learning at OpenAI and Anthropic'];
    const ev = [];
    for (let i = 0; i < 24; i++) ev.push({ tStartMs: i * 1000, dDurationMs: 900, segs: [{ utf8: words[i % words.length] }] });
    const { calls } = await runScript({ url: JSON_URL, body: json3(ev), config: cfg({ chunkSize: 6 }), respond: goodTranslator });
    assert(calls.length >= 2, '要至少两批才能比较 system 是否恒定，实际 ' + calls.length);
    assert(/## 术语表/.test(userOf(calls)), '术语表应当出现在 user 消息里');
    assert(!/## 术语表/.test(sysOf(calls)), '术语表不该出现在 system prompt 里（会每批作废它后面的前缀）');
    for (let i = 1; i < calls.length; i++) {
      assertEqual(sysOf(calls, i), sysOf(calls, 0), '第 ' + i + ' 批的 system 与第 0 批不一致——前缀缓存会落空');
    }
  });

  await check('改术语表后旧缓存不再命中（术语表参与缓存键）', async () => {
    const body = json3([{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'hello world here' }] }]);
    const store = new Map();
    const first = await runScript({ url: JSON_URL, body, config: cfg({ cache: true }), respond: goodTranslator, store });
    assertEqual(first.calls.length, 1, '第一次要真翻');
    const again = await runScript({ url: JSON_URL, body, config: cfg({ cache: true }), respond: goodTranslator, store });
    assertEqual(again.calls.length, 0, '同配置第二次应当命中缓存');
    const changed = await runScript({ url: JSON_URL, body, config: cfg({ cache: true, glossary: { hello: '你好' } }), respond: goodTranslator, store });
    assertEqual(changed.calls.length, 1, '术语表变了必须重翻');
  });

  await check('标点兜底：行末句号/逗号去掉，中文之间的半角标点转全角，省略号归一', async () => {
    const body = json3([
      { tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'line one here' }] },
      { tStartMs: 2000, dDurationMs: 1000, segs: [{ utf8: 'line two here' }] },
      { tStartMs: 4000, dDurationMs: 1000, segs: [{ utf8: 'line three here' }] },
      { tStartMs: 6000, dDurationMs: 1000, segs: [{ utf8: 'line four here' }] },
      { tStartMs: 8000, dDurationMs: 1000, segs: [{ utf8: 'line five here' }] },
      { tStartMs: 10000, dDurationMs: 1000, segs: [{ utf8: 'line six here' }] },
    ]);
    const { result } = await runScript({
      url: JSON_URL, body, config: BASE,
      respond: () => okReply('1|这就是原因。\n2|我们搭了一个棚子,邻居都来看,\n3|真的吗?\n4|等等... 2001 年的 v1.0\n5|我们用 GPT-4.5,它更快\n6|会议是 3:30,别迟到 价格 1,234.5 美元'),
    });
    const doc = JSON.parse(result.body);
    const zh = doc.events.map((e) => e.segs[0].utf8.split('\n')[1]);
    assertEqual(zh[0], '这就是原因', '行末句号应去掉');
    assertEqual(zh[1], '我们搭了一个棚子 邻居都来看', '行内逗号改成空格（AVTpro L10.2），行末逗号去掉');
    assertEqual(zh[2], '真的吗？', '行末问号保留并转全角');
    assertEqual(zh[3], '等等… 2001 年的 v1.0', '省略号归一，数字与版本号里的半角点不动');
    assertEqual(zh[4], '我们用 GPT-4.5 它更快', '拉丁/数字后面的半角逗号也按行内句读处理成空格');
    assertEqual(zh[5], '会议是 3:30 别迟到 价格 1,234.5 美元', '时间里的冒号、千分位与小数点不动');
  });

  await check('非中文目标语不做中文标点处理', async () => {
    const body = json3([{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'hola mundo aqui' }] }]);
    const { result } = await runScript({
      url: JSON_URL, body, config: cfg({ targetLang: 'Japanese' }),
      respond: () => okReply('1|こんにちは。'),
    });
    const doc = JSON.parse(result.body);
    assertEqual(doc.events[0].segs[0].utf8.split('\n')[1], 'こんにちは。', '日文目标语保持原样');
  });

  await check('拆批重试的两半带「上一次为什么被丢」的提示，首次请求不带', async () => {
    const events = [];
    for (let i = 0; i < 12; i++) events.push({ tStartMs: i * 2000, dDurationMs: 1500, segs: [{ utf8: 'line number ' + i }] });
    const users = [];
    const { calls } = await runScript({
      url: JSON_URL, body: json3(events), config: cfg({ chunkSize: 12, concurrency: 1 }),
      respond: (o) => {
        users.push(JSON.parse(o.body).messages[1].content);
        const lines = readSubs(o);
        if (lines.length > 6) {
          const out = lines.slice(0, -1).map((l) => l.match(/^(\d+)\|/)[1] + '|译');
          return okReply(out.join('\n'));
        }
        return goodTranslator(o);
      },
    });
    assert(calls.length >= 3, '应当拆批重试');
    assert(!/上一次翻译的行数/.test(users[0]), '首次请求不带重试提示');
    assert(/^上一次翻译的行数/.test(users[1]) && /^上一次翻译的行数/.test(users[2]), '两半都应以重试提示开头');
    for (const u of users.slice(1)) assertEqual((u.match(/<<<SUBS/g) || []).length, 1, '重试提示不能破坏定界块');
  });

  await check('拒绝 system 角色的端点：重试提示也绝不混进纯数据消息', async () => {
    const events = [];
    for (let i = 0; i < 12; i++) events.push({ tStartMs: i * 2000, dDurationMs: 1500, segs: [{ utf8: 'line number ' + i }] });
    const dataOnly = [];
    await runScript({
      url: JSON_URL, body: json3(events), config: cfg({ chunkSize: 12, concurrency: 1 }),
      respond: (o) => {
        const p = JSON.parse(o.body);
        if (p.messages.some((m) => m.role === 'system')) {
          return { status: 400, body: JSON.stringify({ error: { message: 'Role must be in [user, assistant].' } }) };
        }
        dataOnly.push(p.messages[0].content);
        const lines = readSubs(o);
        if (lines.length > 6) {
          const out = lines.slice(0, -1).map((l) => l.match(/^(\d+)\|/)[1] + '|译');
          return okReply(out.join('\n'));
        }
        return goodTranslator(o);
      },
    });
    assert(dataOnly.length >= 3, '应当有纯数据的拆批重试请求');
    for (const u of dataOnly) {
      for (const leak of ['上一次翻译', '分开翻译', '<<<SUBS', '<<<CONTEXT', '字幕译者', '术语表']) {
        assert(u.indexOf(leak) < 0, '指令泄漏进了纯数据消息：' + leak);
      }
    }
  });

  await check('srv3 轨道类型：仓库 fixture 判得对，正文里的 a=1 不算结构信号', async () => {
    const a = await runScript({ url: XML_URL, body: FIX('asr.jp.xml'), config: BASE, respond: goodTranslator });
    assert(/自动语音识别/.test(sysOf(a.calls)), 'asr.jp.xml（逐词 <s> + a="1"）应判为 ASR');
    const m = await runScript({ url: XML_URL, body: FIX('long.en.xml'), config: BASE, respond: goodTranslator });
    assert(/人工制作/.test(sysOf(m.calls)), 'long.en.xml 应判为人工轨');
    const tricky = '<?xml version="1.0"?><timedtext format="3"><body>'
      + '<p t="0" d="2000">let a=1 and b=2 then solve</p><p t="2000" d="2000">for x in the equation</p></body></timedtext>';
    const k = await runScript({ url: XML_URL, body: tricky, config: BASE, respond: goodTranslator });
    assert(/人工制作/.test(sysOf(k.calls)), '正文里的 a=1 不是续接属性，仍应判为人工轨');
  });

  await check('标点兜底：拉丁缩写的点不动，中文之间的句点才转，连续省略号合并', async () => {
    const body = json3([0, 1, 2, 3, 4].map((i) => ({ tStartMs: i * 2000, dDurationMs: 1000, segs: [{ utf8: 'line ' + i + ' here' }] })));
    const { result } = await runScript({
      url: JSON_URL, body, config: BASE,
      respond: () => okReply('1|他在 U.S. 市场做得很好\n2|那家公司叫 Apple Inc.\n3|他说.走吧\n4|哈哈…………\n5|Mr. 史密斯说没问题,'),
    });
    const zh = JSON.parse(result.body).events.map((e) => e.segs[0].utf8.split('\n')[1]);
    assertEqual(zh[0], '他在 U.S. 市场做得很好', '缩写点后接中文不能变成句号');
    assertEqual(zh[1], '那家公司叫 Apple Inc.', '行末的缩写点不能被剥掉');
    assertEqual(zh[2], '他说 走吧', '中文之间的半角句点先转全角、再按行内句读改成空格');
    assertEqual(zh[3], '哈哈…', '连续省略号合并成一个');
    assertEqual(zh[4], 'Mr. 史密斯说没问题', '缩写点保留，行末逗号去掉');
  });

  await check('译文只剩标点时退回「…」，而不是静默丢行', async () => {
    const body = json3([{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'um uh' }] }]);
    const { result } = await runScript({ url: JSON_URL, body, config: BASE, respond: () => okReply('1|。') });
    assertEqual(JSON.parse(result.body).events[0].segs[0].utf8, 'um uh\n…', '纯标点译文应显示为「…」');
  });

  await check('领域识别的三道门槛都有用例钉住：不同词不够、密度不够都不注入', async () => {
    // 只有 3 个不同强信号词（命中 12 次）→ 不注入
    const three = ['machine learning is fun', 'deep learning too', 'fine-tuning helps'];
    const ev3 = [];
    for (let i = 0; i < 12; i++) ev3.push({ tStartMs: i * 1000, dDurationMs: 900, segs: [{ utf8: three[i % 3] }] });
    const r3 = await runScript({ url: JSON_URL, body: json3(ev3), config: BASE, respond: goodTranslator });
    assert(!/## 术语表/.test(sysOf(r3.calls)), '不同强信号词不够 4 个不应注入');
    // 700 条普通内容里撒 6 次命中（4 个不同词）→ 密度 8.6‰ < 10‰，不注入
    const ev700 = [];
    const ai = ['a neural network', 'machine learning', 'fine-tuning it', 'superposition here', 'interpretability work', 'rlhf training'];
    for (let i = 0; i < 700; i++) ev700.push({ tStartMs: i * 1000, dDurationMs: 900, segs: [{ utf8: i % 100 === 0 && i < 600 ? ai[i / 100] : 'we walked to the market and bought apples ' + i }] });
    const r700 = await runScript({ url: JSON_URL, body: json3(ev700), config: cfg({ concurrency: 8, fastConcurrency: 8, budgetMs: 25000 }), respond: goodTranslator });
    assert(!/## 术语表/.test(sysOf(r700.calls)), '密度不够不应注入');
  });

  await check('用户术语表真的覆盖内置条目（AI 题材下 embedding 用用户译法）', async () => {
    const words = ['we trained the neural network with machine learning', 'the training data and embeddings',
                   'fine-tuning the large language model', 'interpretability and superposition',
                   'reinforcement learning from human feedback', 'deep learning at OpenAI and Anthropic'];
    const ev = [];
    for (let i = 0; i < 12; i++) ev.push({ tStartMs: i * 1000, dDurationMs: 900, segs: [{ utf8: words[i % words.length] }] });
    const { calls } = await runScript({ url: JSON_URL, body: json3(ev), config: cfg({ glossary: { embedding: '向量嵌入' } }), respond: goodTranslator });
    const gl = userOf(calls);
    assert(gl.includes('"embedding": "向量嵌入"'), '用户译法应当出现');
    assert(!gl.includes('"embedding": "嵌入"'), '内置译法应当被覆盖掉');
  });

  await check('同一段字幕在 AI 轨与普通轨下不共用缓存（DOMAIN 参与缓存键）', async () => {
    const store = new Map();
    const words = ['we trained the neural network with machine learning', 'the training data and embeddings',
                   'fine-tuning the large language model', 'interpretability and superposition',
                   'reinforcement learning from human feedback', 'deep learning at OpenAI and Anthropic'];
    const evA = [];
    for (let i = 0; i < 12; i++) evA.push({ tStartMs: i * 1000, dDurationMs: 900, segs: [{ utf8: words[i % words.length] }] });
    evA.push({ tStartMs: 12000, dDurationMs: 900, segs: [{ utf8: 'hello world here' }] });
    const conf = cfg({ cache: true, chunkSize: 1 });
    const a = await runScript({ url: JSON_URL, body: json3(evA), config: conf, respond: goodTranslator, store });
    assertEqual(a.calls.length, 13, 'AI 轨逐条一批，13 次');
    const evB = [{ tStartMs: 0, dDurationMs: 900, segs: [{ utf8: 'hello world here' }] }];
    const b = await runScript({ url: JSON_URL, body: json3(evB), config: conf, respond: goodTranslator, store });
    assertEqual(b.calls.length, 1, '普通轨下同一句不应命中 AI 轨的缓存');
    const b2 = await runScript({ url: JSON_URL, body: json3(evB), config: conf, respond: goodTranslator, store });
    assertEqual(b2.calls.length, 0, '同一轨第二次应当命中');
  });

  await check('「下次拆半」预拆出来的两半也带重试提示（它们上次正是因为行数对不上被丢的）', async () => {
    const events = [];
    for (let i = 0; i < 28; i++) events.push({ tStartMs: i * 2000, dDurationMs: 1500, segs: [{ utf8: 'merge prone line ' + i }] });
    const body = json3(events);
    const dropTail = (o) => {
      const lines = readSubs(o);
      if (lines.length < 15) return goodTranslator(o);
      const out = lines.slice(0, -1).map((line) => { const m = line.match(/^(\d+)\|([\s\S]*)$/); return m[1] + '|[zh]' + m[2].slice(0, 20); });
      return { status: 200, body: JSON.stringify({ choices: [{ message: { content: out.join('\n') }, finish_reason: 'stop' }] }), delay: 1000 };
    };
    const store = new Map();
    const conf = cfg({ chunkSize: 20, cache: true, probe: true, fastBudgetMs: 1500 });
    await runScript({ url: JSON_URL, body, config: conf, store, respond: dropTail });
    const users = [];
    const r2 = await runScript({
      url: JSON_URL, body, config: conf, store,
      respond: (o) => { users.push(JSON.parse(o.body).messages[1].content); return Object.assign(dropTail(o), { delay: 50 }); },
    });
    assertEqual(r2.calls.length, 2, '第二轮只发两半');
    for (const u of users) assert(/^上一次翻译的行数/.test(u), '预拆的两半都应以重试提示开头，实际: ' + u.slice(0, 40));
  });

  await check('专业标点：？！不叠用、冒号改空格、中英数字之间留空格、数字与英文单位不空格', async () => {
    const body = json3([0, 1, 2, 3].map((i) => ({ tStartMs: i * 2000, dDurationMs: 1000, segs: [{ utf8: 'line ' + i + ' here' }] })));
    const { result } = await runScript({
      url: JSON_URL, body, config: BASE,
      respond: () => okReply('1|真的吗？！\n2|他说：我们用GPT-4训练了3天\n3|剂量是20mg 血压120mmHg\n4|会议 19:35 开始 有15人参加'),
    });
    const zh = JSON.parse(result.body).events.map((e) => e.segs[0].utf8.split('\n')[1]);
    assertEqual(zh[0], '真的吗？', '？！叠用只留第一个');
    assertEqual(zh[1], '他说 我们用 GPT-4 训练了 3 天', '冒号改空格，中英与数字之间留空格');
    assertEqual(zh[2], '剂量是 20mg 血压 120mmHg', '数字与英文单位之间不空格');
    assertEqual(zh[3], '会议 19:35 开始 有 15 人参加', '表时间的半角冒号不动');
  });

  await check('歌词轨（♪ 包裹的 cue 占比高）附上歌词附加段；普通轨不附', async () => {
    const lyr = [0, 1, 2, 3, 4].map((i) => ({ tStartMs: i * 2000, dDurationMs: 1800, segs: [{ utf8: '♪ la la la ' + i + ' ♪' }] }));
    const a = await runScript({ url: JSON_URL, body: json3(lyr), config: BASE, respond: goodTranslator });
    assert(/## 歌词/.test(sysOf(a.calls)), '歌词轨应附歌词段');
    const plain = [0, 1, 2, 3, 4].map((i) => ({ tStartMs: i * 2000, dDurationMs: 1800, segs: [{ utf8: 'we walked to the market ' + i }] }));
    const b = await runScript({ url: JSON_URL, body: json3(plain), config: BASE, respond: goodTranslator });
    assert(!/## 歌词/.test(sysOf(b.calls)), '普通轨不附歌词段');
  });

  await check('医学内容：判出题材但默认不注入附加段，也不与 AI 术语表混淆', async () => {
    const words = ['the patients had sepsis and cardiac symptoms', 'we adjusted the dose of the antibiotics', 'the receptor and the immune response',
                   'clinical diagnosis of the syndrome', 'mortality and prognosis in the randomized trial', 'inflammation and the infection'];
    const ev = [];
    for (let i = 0; i < 14; i++) ev.push({ tStartMs: i * 1000, dDurationMs: 900, segs: [{ utf8: words[i % words.length] }] });
    const { calls } = await runScript({ url: JSON_URL, body: json3(ev), config: BASE, respond: goodTranslator });
    const sys = sysOf(calls);
    assert(!/## 医学与科学内容/.test(sys), '医学附加段默认不注入');
    assert(!/## 术语表/.test(sys), '医学 profile 没有内置术语表');
    assert(!sys.includes('{{'), '不应残留未替换的变量');
    const store = new Map();
    const again = await runScript({ url: JSON_URL, body: json3(ev), config: cfg({ probe: true }), respond: goodTranslator, store });
    const d = JSON.parse(again.store.get('llmsubs.diag')).slice(-1)[0];
    assertEqual(d.domain, 'medical', '题材仍要判出来（进缓存键与诊断）');
  });

  await check('qualityModel：质量档（m 域重复请求）换模型，速度档不换，两档缓存各存各的', async () => {
    const body = json3([0, 1, 2].map((i) => ({ tStartMs: i * 2000, dDurationMs: 1500, segs: [{ utf8: 'quality line ' + i }] })));
    const store = new Map();
    const conf = cfg({ cache: true, qualityModel: 'test-quality-model' });
    const models = [];
    const resp = (o) => { models.push(JSON.parse(o.body).model); return goodTranslator(o); };
    const first = await runScript({ url: M_JSON_URL, body, config: conf, store, respond: resp });   // 首次 = 速度档
    assertEqual(models[0], 'test-model', '首次请求是速度档，用 model');
    const second = await runScript({ url: M_JSON_URL, body, config: conf, store, respond: resp });  // 2 分钟内重复 = 质量档
    assert(second.calls.length >= 1, '质量档换了模型，不该命中速度档的缓存');
    assertEqual(models[models.length - 1], 'test-quality-model', '质量档应当用 qualityModel');
    const d = JSON.parse(store.get('llmsubs.diag')).slice(-1)[0];
    assertEqual(d.modelUsed, 'test-quality-model', '诊断记下实际用的模型');
    const third = await runScript({ url: M_JSON_URL, body, config: conf, store, respond: resp });   // 再来一次质量档 → 命中自己的缓存
    assertEqual(third.calls.length, 0, '质量档第二次应命中质量档自己的缓存');
    const www = await runScript({ url: JSON_URL, body, config: conf, store, respond: resp });       // App 域永远速度档
    assert(www.calls.length === 0 || models[models.length - 1] === 'test-model', 'App 域不用 qualityModel');
  });
};
