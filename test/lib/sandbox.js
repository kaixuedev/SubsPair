'use strict';
/*
 * 翻译角色的离线执行环境。
 *
 * 做法：在一个 vm 沙箱里注入 Shadowrocket 的全局对象（$request / $response / $done /
 * $httpClient / $persistentStore / $notification），把 ytsub.js 原样跑一遍，
 * 检查它交给 $done 的东西。$httpClient 是假的，不会有任何真实网络请求。
 *
 * 三块内容，按下面三道横幅分开：
 *   · 沙箱执行器　withConfig 改写脚本里的默认值，runScript 跑脚本并收集请求、存储、通知、日志
 *   · 假的 LLM 端点　readSubs 解析脚本发来的批，goodTranslator 正常翻，dropNth 故意漏一行
 *   · 字幕样本与常量　FIX 读夹具，json3 构造样本，BASE / cfg 是基础配置，外加三条常用 URL
 *
 * 取舍：只有两个以上用例文件都用到的东西才放这里；单个文件专用的辅助留在那个文件里
 * （比如 formats.js 里的 xmlLines / vtt，waves.js 里的 fnv1a）。
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { assert } = require('./harness');

// 本文件在 test/lib/ 下：上一级是 test/，再上一级是仓库根。
// 路径算错时下一行读 ytsub.js 就会抛 ENOENT 并印出完整路径，不需要再加检查。
const TEST_DIR = path.join(__dirname, '..');
const ROOT = path.join(TEST_DIR, '..');
const SCRIPT = fs.readFileSync(path.join(ROOT, 'ytsub.js'), 'utf8');
const FIX = (name) => fs.readFileSync(path.join(TEST_DIR, 'fixtures', name), 'utf8');

/* ───────────────── 沙箱执行器 ───────────────── */

function withConfig(src, overrides) {
  let out = src;
  for (const [k, v] of Object.entries(overrides || {})) {
    const re = new RegExp('(\\n\\s*' + k + ':\\s*)([^,\\n]*)(,)');
    assert(re.test(out), 'CONFIG 里找不到字段 ' + k);
    out = out.replace(re, '$1' + JSON.stringify(v) + '$3');
  }
  return out;
}

function runScript(opts) {
  const calls = [];
  const gets = [];        // $httpClient.get 的调用（relay 探针走它）
  const notifications = [];
  const logs = [];
  const store = opts.store || new Map();

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('脚本没有调用 $done（超时 30s）')), 30000);

    const sandbox = {
      console: { log: (m) => logs.push(String(m)) },
      setTimeout, clearTimeout, Promise, JSON, Math, Date, Object, Array,
      String, Number, RegExp, Error, parseInt, parseFloat, isNaN,
      decodeURIComponent, encodeURIComponent,

      // noRequest 模拟 cron 钩子（后台补翻角色：既没有 $request 也没有 $response）；
      // emptyRequest 模拟「引擎给 cron 塞了一个空 $request 对象」这种没文档的形态
      $request: opts.noRequest ? undefined : opts.emptyRequest ? {}
        : opts.requestNoUrl ? { method: 'GET', headers: {} }   // 真 http 钩子但 URL 取不到（不能当 cron）
        : { url: opts.url },
      $argument: opts.argument,
      // noResponse 模拟 http-request 钩子（观察者角色就是这么被调用的）
      $response: opts.noResponse ? undefined
        : { status: opts.status || 200, body: opts.body, headers: opts.headers || { 'Content-Type': 'application/json' } },

      $done: (arg) => {
        clearTimeout(timer);
        resolve({ result: arg, calls, gets, notifications, logs, store, at: Date.now() });
      },

      $httpClient: {
        get: (options, cb) => {
          gets.push(options);
          const r = opts.respondGet ? opts.respondGet(options) : { status: 200, body: '' };
          setTimeout(() => cb(r.error || null, r.error ? null : { status: r.status }, r.body || ''), r.delay || 0);
        },
        post: (options, cb) => {
          calls.push(options);
          let res;
          try {
            res = opts.respond ? opts.respond(options, calls.length) : { status: 200, body: '' };
          } catch (e) {
            return setTimeout(() => cb(String(e.message), null, null), 0);
          }
          if (res && res.error) return setTimeout(() => cb(res.error, null, null), res.delay || 0);
          setTimeout(() => cb(null, { status: res.status }, res.body), res.delay || 0);
        },
      },

      $persistentStore: {
        read: (k) => (store.has(k) ? store.get(k) : null),
        write: (v, k) => { store.set(k, String(v)); return true; },
      },

      $notification: { post: (t, s, b) => notifications.push({ t, s, b }) },
    };

    const code = withConfig(opts.script || SCRIPT, opts.config || {});
    try {
      vm.runInNewContext(code, sandbox, { filename: 'ytsub.js' });
    } catch (e) {
      clearTimeout(timer);
      reject(e);
    }
  });
}

/* ───────────────── 假的 LLM 端点 ───────────────── */

function readSubs(options) {
  const payload = JSON.parse(options.body);
  const user = payload.messages.find((m) => m.role === 'user').content;
  const block = user.match(/<<<SUBS\n([\s\S]*)\nSUBS>>>/);
  // 两种形态：带定界块的（能收 system 的端点），和纯数据的（拒绝 system 的翻译模型）
  if (block) return block[1].split('\n');
  const lines = user.split('\n').filter((l) => /^\s*\d+\|/.test(l));
  if (!lines.length) throw new Error('user 消息里既没有 SUBS 定界块也没有编号行');
  return lines;
}

function goodTranslator(options) {
  const out = readSubs(options).map((line) => {
    const m = line.match(/^(\d+)\|([\s\S]*)$/);
    if (!m) throw new Error('行格式不对: ' + line);
    return m[1] + '|[zh]' + m[2].slice(0, 20);
  });
  return { status: 200, body: JSON.stringify({ choices: [{ message: { content: out.join('\n') }, finish_reason: 'stop' }] }) };
}

// 漏掉一行的假端点：'tail' 漏最后一行，'middle' 漏中间那行。脚本对这两种漏法的处理必须不同：
// 漏中间 → 序号没前移，其余几条对得上，保留；漏末尾 → 疑似合并漏，后续序号可能整体前移，宁可全英文
const dropNth = (which) => (o) => {
  const lines = readSubs(o);
  const keep = which === 'tail' ? lines.slice(0, -1)
    : lines.filter((_, i) => i !== Math.floor(lines.length / 2));
  const out = keep.map((l) => {
    const m = l.match(/^(\d+)\|([\s\S]*)$/);
    return m[1] + '|[zh]' + m[2].slice(0, 20);
  });
  return { status: 200, body: JSON.stringify({ choices: [{ message: { content: out.join('\n') }, finish_reason: 'stop' }] }) };
};

/* ───────────────── 字幕样本与常量 ───────────────── */

// 测试的基础配置。探针在这里显式打开，不跟着脚本的出厂值走：大半用例靠诊断计数与 cron 运行环
// 观察脚本的行为，探针关着就什么都看不到，会大片变红。
// 要测探针关着的行为，显式传 probe: false；出厂值本身由 panel.js 断言。
const BASE = {
  enabled: true,
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'sk-test-abcdefghijklmnop',
  model: 'test-model',
  cache: false,
  budgetMs: 20000,
  probe: true,
};

// 速度档首波的并发另由 fastConcurrency 控制。只给了 concurrency 的用例让 fastConcurrency 跟着它走，
// 一个值同时约束两档。
const cfg = (o) => Object.assign({}, BASE,
  (o && o.concurrency !== undefined && o.fastConcurrency === undefined) ? { fastConcurrency: o.concurrency } : {},
  o);

const JSON_URL = 'https://www.youtube.com/api/timedtext?v=abc123&lang=en&fmt=json3&caps=asr';
// 移动网页版（m 域）。只有它的重复请求能进质量档——App（www）的重复请求
// 来自用户点 CC 开关、是前台请求，必须仍走速度档。要验质量档行为的用例用这条。
const M_JSON_URL = 'https://m.youtube.com/api/timedtext?v=abc123&lang=en&fmt=json3&caps=asr';
const XML_URL = 'https://www.youtube.com/api/timedtext?v=abc123&lang=en&format=srv3&caps=asr';
// 只有一个文件用的 URL 留在那个文件里：srv1 的 BARE_URL 与 WebVTT 的 VTT_URL 都在 formats.js

// 构造一份 json3
function json3(events) {
  return JSON.stringify({ wireMagic: 'pb3', pens: [{}], wpWinPositions: [{}], wsWinStyles: [{}], events });
}

module.exports = {
  ROOT, SCRIPT, FIX,
  withConfig, runScript,
  readSubs, goodTranslator, dropNth,
  BASE, cfg, JSON_URL, M_JSON_URL, XML_URL,
  json3,
};
