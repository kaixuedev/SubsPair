'use strict';
/*
 * 服务商兼容：各家端点的脾气与脚本的自动适配。
 *
 *   · 服务商兼容性　temperature 为 null 不发、extraBody 白名单、200 里夹 error、choices 为空、
 *     content 为 null 回落 reasoning_content、insufficient_system_resource 退避、剥思考块与代码围栏、拒答
 *   · 端点脾气：自动适配　拒绝 system 角色就改发纯数据，记住脾气，先单发一条探路
 */

const { check, assert, assertEqual, section } = require('../lib/harness');
const {
  runScript, FIX, BASE, cfg, JSON_URL, json3,
  goodTranslator,
} = require('../lib/sandbox');

module.exports = async function () {
  section('服务商兼容性');

  await check('temperature 填 null 时整个字段不发（智谱是开区间，收到 0 会 400）', async () => {
    const body = json3([{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'hello world here' }] }]);
    const { calls } = await runScript({
      url: JSON_URL, body, config: cfg({ temperature: null }), respond: goodTranslator,
    });
    assert(!('temperature' in JSON.parse(calls[0].body)), 'temperature 为 null 时不应出现在请求体里');
  });

  await check('temperature 有值时按值发送', async () => {
    const body = json3([{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'hello world here' }] }]);
    const { calls } = await runScript({
      url: JSON_URL, body, config: cfg({ temperature: 0.1 }), respond: goodTranslator,
    });
    assertEqual(JSON.parse(calls[0].body).temperature, 0.1, 'temperature 应当按配置发送');
  });

  await check('extraBody 只放行白名单键（DeepSeek 关思考那种）', async () => {
    const body = json3([{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'hello world here' }] }]);
    const { calls } = await runScript({
      url: JSON_URL, body, respond: goodTranslator,
      config: cfg({ extraBody: { thinking: { type: 'disabled' }, top_p: 0.9, tools: [1], messages: 'x', stream: true } }),
    });
    const p = JSON.parse(calls[0].body);
    assertEqual(JSON.stringify(p.thinking), '{"type":"disabled"}', '白名单内的 thinking 应当透传');
    assertEqual(p.top_p, 0.9, '白名单内的 top_p 应当透传');
    assert(!('tools' in p), 'tools 必须被挡掉');
    assertEqual(p.stream, false, 'stream 不得被覆盖');
    assert(Array.isArray(p.messages), 'messages 不得被覆盖');
  });

  await check('HTTP 200 里夹 error 对象 → 丢弃并放行', async () => {
    const { result } = await runScript({
      url: JSON_URL, body: FIX('YouTube.timedtext.json'), config: BASE,
      respond: () => ({ status: 200, body: JSON.stringify({ error: { code: 402, message: 'no credits' } }) }),
    });
    assert(!result || !result.body, 'OpenRouter 式的 200+error 必须被识别');
  });

  await check('choices 为空数组 → 丢弃并放行', async () => {
    const { result } = await runScript({
      url: JSON_URL, body: FIX('YouTube.timedtext.json'), config: BASE,
      respond: () => ({ status: 200, body: JSON.stringify({ choices: [] }) }),
    });
    assert(!result || !result.body, 'choices 为空必须被识别');
  });

  await check('content 为 null 时回落到 reasoning_content', async () => {
    const body = json3([{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'hello world here' }] }]);
    const { result } = await runScript({
      url: JSON_URL, body, config: BASE,
      respond: () => ({
        status: 200,
        body: JSON.stringify({ choices: [{ message: { content: null, reasoning_content: '1|思考里的译文' }, finish_reason: 'stop' }] }),
      }),
    });
    assert(result && result.body, 'DeepSeek 思考模式下内容在 reasoning_content 里，应当能取到');
    assert(result.body.includes('思考里的译文'), '译文应当被采用');
  });

  await check('insufficient_system_resource 退避重试（DeepSeek 独有）', async () => {
    const body = json3([{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'hello world here' }] }]);
    let n = 0;
    const { calls, result } = await runScript({
      url: JSON_URL, body, config: BASE,
      respond: (o) => {
        n++;
        return n === 1
          ? { status: 200, body: JSON.stringify({ choices: [{ message: { content: '' }, finish_reason: 'insufficient_system_resource' }] }) }
          : goodTranslator(o);
      },
    });
    assertEqual(calls.length, 2, '算力不足属于临时状态，应当重试');
    assert(result && result.body, '重试成功后应当正常输出');
  });

  await check('剥掉模型爱加的壳：思考块与代码围栏', async () => {
    const body = json3([{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'hello world here' }] }]);
    const { result } = await runScript({
      url: JSON_URL, body, config: BASE,
      respond: () => ({
        status: 200,
        body: JSON.stringify({ choices: [{ message: { content: '<think>让我想想</think>```\n1|干净的译文\n```' }, finish_reason: 'stop' }] }),
      }),
    });
    assert(result && result.body, '壳被剥掉后应当能正常解析');
    const utf8 = JSON.parse(result.body).events[0].segs[0].utf8;
    assert(utf8.includes('干净的译文'), '译文应当被取到');
    assert(!utf8.includes('think') && !utf8.includes('```'), '壳不能混进字幕');
  });

  await check('模型拒答 → 整批丢弃并放行', async () => {
    for (const refusal of ['1|很抱歉，我无法翻译这段内容', "1|I'm sorry, but I cannot assist with that"]) {
      const { result } = await runScript({
        url: JSON_URL, body: FIX('YouTube.timedtext.json'), config: BASE,
        respond: () => ({ status: 200, body: JSON.stringify({ choices: [{ message: { content: refusal }, finish_reason: 'stop' }] }) }),
      });
      assert(!result || !result.body, '拒答必须被识别: ' + refusal);
    }
  });

  section('端点脾气：自动适配');

  const SYS_REJECT = { status: 400, body: JSON.stringify({ error: { message: 'Role must be in [user, assistant].' } }) };

  await check('【回归】端点拒绝 system 角色 → 改发纯数据，绝不把指令混进去', async () => {
    // 有的端点（例如阿里百炼的 qwen-mt-plus）第一条消息是 system 就直接 400。
    //
    // 这类端点多半是专用翻译模型——它不遵循指令，只翻译你给它的一切。
    // 把指令并进 user 消息的话，提示词本身会被当成字幕正文翻译出来、显示在字幕第二行。
    // 所以这里必须只发数据。
    const body = json3([{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'hello world here' }] }]);
    const { result, calls } = await runScript({
      url: JSON_URL, body, config: BASE,
      respond: (o) => (JSON.parse(o.body).messages.some((m) => m.role === 'system') ? SYS_REJECT : goodTranslator(o)),
    });
    assertEqual(calls.length, 2, '应当自动重试一次');
    assert(JSON.parse(calls[0].body).messages.some((m) => m.role === 'system'), '第一次带 system');

    const p2 = JSON.parse(calls[1].body);
    const second = p2.messages;
    assertEqual(second.length, 1, '第二次只有一条消息');
    assertEqual(second[0].role, 'user', '只能是 user');
    // 核心断言：一个字的指令都不能出现在待翻译的内容里
    for (const leak of ['字幕译者', 'subtitle translator', '<<<SUBS', 'SUBS>>>', '<<<CONTEXT', '翻译规则', 'Rules']) {
      assert(second[0].content.indexOf(leak) < 0, '指令泄漏进了待翻译内容：' + leak);
    }
    assert(/^1\|hello world here$/m.test(second[0].content), '应当只有编号数据行，实际: ' + JSON.stringify(second[0].content));
    assert(p2.translation_options, '目标语言应当靠 translation_options 传，而不是靠文字指令');
    assert(result && result.body, '重试成功后应当正常输出');
  });

  await check('【回归】记住端点脾气，下次不再白费一次请求', async () => {
    const body = json3([{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'hello world here' }] }]);
    const store = new Map();
    const responder = (o) => (JSON.parse(o.body).messages.some((m) => m.role === 'system') ? SYS_REJECT : goodTranslator(o));
    const first = await runScript({ url: JSON_URL, body, config: BASE, respond: responder, store });
    assertEqual(first.calls.length, 2, '第一次要探一下');
    const second = await runScript({ url: JSON_URL, body, config: BASE, respond: responder, store });
    assertEqual(second.calls.length, 1, '第二次应当直接用对的形状');
    assert(!JSON.parse(second.calls[0].body).messages.some((m) => m.role === 'system'), '不该再带 system');
  });

  await check('【回归】不知道端点脾气时先单发一条探路，不让并发一起撞上限流', async () => {
    const events = [];
    for (let i = 0; i < 40; i++) events.push({ tStartMs: i * 2000, dDurationMs: 1500, segs: [{ utf8: 'line number ' + i }] });
    let concurrentAt400 = 0, inFlight = 0;
    await runScript({
      url: JSON_URL, body: json3(events),
      config: cfg({ chunkSize: 10, concurrency: 4 }),
      respond: (o) => {
        const hasSys = JSON.parse(o.body).messages.some((m) => m.role === 'system');
        if (hasSys) { inFlight++; concurrentAt400 = Math.max(concurrentAt400, inFlight); inFlight--; return SYS_REJECT; }
        return goodTranslator(o);
      },
    });
    assertEqual(concurrentAt400, 1, '带 system 的请求最多只该发出去一条，实际 ' + concurrentAt400);
  });
};
