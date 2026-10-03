'use strict';
/*
 * 出厂值冒烟：不经 lib/sandbox.js 的 BASE（它把探针写死成开），只给密钥与端点，其余按脚本自己的出厂值跑。
 *
 * 目的是测到「用户装好后真正走的默认路径」：出厂时探针与调试日志是关着的，而别的用例几乎都把探针
 * 打开了（大半靠诊断计数观察行为），探针关着的路径就只剩零星几条显式 probe: false 的用例。
 * 这里的断言只看用户看得见的量：请求数、译文、待翻队列、通知，不看诊断数据。只在探针关着时才会
 * 出现的问题（例如版本闸没在前台过，backfill.js 有对应用例）就是这类用例要挡的。
 */

const { check, assert, assertEqual, section } = require('../lib/harness');
const { runScript, JSON_URL, json3, readSubs, goodTranslator } = require('../lib/sandbox');

// 只给密钥与端点，别的都是出厂值（cache 是补翻的前提，两条用例单独打开）
const FACTORY = { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-test-abcdefghijklmnop', model: 'test-model' };
const BF_URL = JSON_URL + '&kind=asr';
const events = (n, tag) => { const a = []; for (let i = 0; i < n; i++) a.push({ tStartMs: i * 2000, dDurationMs: 1500, segs: [{ utf8: tag + ' line ' + i }] }); return a; };
// 少回最后一行：硬失败，这一批留给后台补翻
const tailMissing = (o) => {
  const out = readSubs(o).slice(0, -1).map((l) => l.replace(/^(\d+)\|.*/, '$1|[zh]x'));
  return { status: 200, body: JSON.stringify({ choices: [{ message: { content: out.join('\n') }, finish_reason: 'stop' }] }) };
};

module.exports = async function () {
  section('出厂值冒烟：按脚本自己的探针与调试出厂值跑');

  await check('首屏：装好填上密钥就能翻，每条都是上英下中', async () => {
    const { result, calls } = await runScript({ url: JSON_URL, body: json3(events(6, 'first')), config: FACTORY, respond: goodTranslator });
    assert(calls.length >= 1, '应当发出翻译请求');
    const doc = JSON.parse(result.body);
    assert(doc.events.every((e) => e.segs[0].utf8.includes('\n[zh]')), '每条都应是双语两行');
  });

  await check('没翻完的批进待翻队列，cron 第一次醒来就补翻，不依赖探针', async () => {
    const store = new Map();
    const cfg = Object.assign({ cache: true }, FACTORY);
    await runScript({ url: BF_URL, body: json3(events(60, 'queue')), config: cfg, store, respond: (o, n) => (n === 1 ? goodTranslator(o) : tailMissing(o)) });
    assert(store.get('llmsubs.bfq'), '前台应把没翻完的批排进队列');
    const cr = await runScript({ noRequest: true, noResponse: true, config: cfg, store, respond: goodTranslator });
    assert(cr.calls.length >= 1, 'cron 应当翻队列里的批');
    assert(!store.get('llmsubs.bfq'), '翻完队列清空');
  });

  await check('二次打开命中缓存：一条请求都不发，译文照常', async () => {
    const store = new Map();
    const cfg = Object.assign({ cache: true }, FACTORY);
    await runScript({ url: JSON_URL, body: json3(events(6, 'again')), config: cfg, store, respond: goodTranslator });
    const { result, calls } = await runScript({ url: JSON_URL, body: json3(events(6, 'again')), config: cfg, store, respond: goodTranslator });
    assertEqual(calls.length, 0, '缓存命中后不该再请求');
    assert(JSON.parse(result.body).events.every((e) => e.segs[0].utf8.includes('\n[zh]')), '译文来自缓存');
  });

  await check('没填密钥：零出站，发一条带面板地址的通知', async () => {
    const { calls, notifications } = await runScript({ url: JSON_URL, body: json3(events(3, 'nokey')), config: { baseUrl: FACTORY.baseUrl, model: FACTORY.model }, respond: goodTranslator });
    assertEqual(calls.length, 0, '没有密钥一条请求都不发');
    assertEqual(notifications.length, 1, '提醒去设置');
    assert(/https:\/\/[a-z0-9.-]+\.test\//.test(notifications[0].b), '通知里要有面板地址：' + notifications[0].b);
  });
};
