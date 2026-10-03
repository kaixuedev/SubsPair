/*
 * ytsub.js 面板角色与 URL 分派的离线测试（面板和翻译是同一份 ytsub.js 里的两个角色）。
 *
 *   node test/panel.js
 *
 * 面板是 http-request 脚本，用 $done({response:{...}}) 短路返回页面/JSON，
 * 所以这里的沙箱要检查的是它交给 $done 的那个 response 对象；请求带了内容时照小火箭的行为，
 * 正文取 $done 参数的顶层 body，没给就是请求自己的内容（见 panel() 里的说明）。
 * 覆盖：配置 v4（推荐 / 其他模型两种模式）、v3 迁移、页面版本闸、测试连接、状态条、
 * 缺密钥守卫、余额暂停；页面部分用真实接口的响应驱动页面的视图函数，逐个场景断言控件集合。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const cp = require('child_process');

const ROOT = path.join(__dirname, '..');
// 单文件：面板和翻译是同一份代码里的两个角色，按 URL 分派
const PANEL = fs.readFileSync(path.join(ROOT, 'ytsub.js'), 'utf8');
const TRANSLATE = PANEL;
const VER = (PANEL.match(/var SCRIPT_VER = '([^']+)'/) || [])[1];
const PANEL_HTML = fs.readFileSync(path.join(ROOT, 'panel', 'panel.html'), 'utf8');

const MODULE_TEXT = fs.readFileSync(path.join(ROOT, 'SubsPair.sgmodule'), 'utf8');

// 这套测试要在两种构建上都能过：模块里 script-path 写成相对路径的本地构建（DEV_BUILD），和写成完整网址的发布构建。
// 两种构建只差探针与调试的出厂值、模块里的观察者行、script-path 的写法、模块描述这几处；涉及它们的用例按构建各自断言。
// 脚本与模块必须出自同一种构建：五个信号必须同指一边，对不上就在启动时报错，不让用例悄悄落进另一边的分支。
const DEV_BUILD = /^SubsPair\.\w+ = .*script-path=Script\/ytsub\.js/m.test(MODULE_TEXT);
(function checkBuildConsistency() {
  const signals = {
    '脚本 DEFAULTS.probe': /^\s*probe: true,$/m.test(PANEL),
    '脚本 DEFAULTS.debug': /^\s*debug: true,$/m.test(PANEL),
    '模块的观察者行': /^SubsPair\.Observe\w+ = /m.test(MODULE_TEXT),
    '模块 script-path 的写法': DEV_BUILD,
    '模块描述带「开发版」': /^#!desc=.*开发版/m.test(MODULE_TEXT),
  };
  const odd = Object.keys(signals).filter((k) => signals[k] !== DEV_BUILD);
  if (odd.length) throw new Error('脚本与模块对不上同一种构建（这几处临时改过的话，先改回仓库里的写法再跑测试），对不上的信号：' + odd.join('、'));
})();

// 断言、小节标题、汇总与翻译测试共用一份；withConfig（改写 DEFAULTS 里的值）也共用
const { check, assert, assertEqual, section, summary } = require('./lib/harness');
const { withConfig } = require('./lib/sandbox');

// v3.6.4 的脚本，固化成夹具（迁移用例拿它当「升级前」的对照）。文件不在就直接报错，不悄悄跳过：
// 跳过的话，全绿不等于对照真的测到了
const OLD_SCRIPT = fs.readFileSync(path.join(__dirname, 'fixtures', 'ytsub.v3.6.4.js'), 'utf8');

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0; }
  return ('0000000' + h.toString(16)).slice(-8);
}

/* ── 沙箱：跑面板脚本 ──
   所有接口请求默认补上页面版本 pv（GET 在 query，POST 在 body）与令牌 tok；opts.noPv / opts.noTok 用来验证闸本身。 */
function panel(opts) {
  const store = opts.store || new Map();
  const calls = [];
  const gets = [];
  let url = opts.url;
  const method = opts.method || 'GET';
  const isApi = /^https?:\/\/subs\.test\/api\//.test(url);
  if (isApi && method === 'GET' && !opts.noPv) url += (url.indexOf('?') < 0 ? '?' : '&') + 'pv=' + encodeURIComponent(VER);
  let body = opts.body;
  if (method === 'POST') {
    if (!store.has('llmsubs.tok')) store.set('llmsubs.tok', 't-test-token');
    try {
      const o = JSON.parse(body === undefined ? '{}' : body);
      if (o && typeof o === 'object' && !Array.isArray(o)) {
        if (!opts.noTok && !('tok' in o)) o.tok = store.get('llmsubs.tok');
        if (!opts.noPv && !('pv' in o)) o.pv = VER;
        body = JSON.stringify(o);
      }
    } catch (e) { /* 非 JSON 的请求体原样送，验证拒绝路径 */ }
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('面板没有调用 $done（超时 60s）')), 60000);
    const sandbox = {
      console: { log() {} },
      setTimeout, clearTimeout, Promise, JSON, Math, Date, Object, Array,
      String, Number, RegExp, Error, parseInt, parseFloat, isNaN,
      decodeURIComponent, encodeURIComponent,
      $request: { url, method, body },
      $argument: opts.argument,
      // 照小火箭的行为来：请求带了内容时，页面收到的回话正文取的是 $done 参数的顶层 body，
      // 没给就是请求自己发出去的那段内容。脚本只把回话放在 response.body 里的话，这里凡是看回话内容的 POST 用例都会变红
      $done: (arg) => {
        clearTimeout(timer);
        let res = arg && arg.response;
        if (res && body) res = Object.assign({}, res, { body: arg.body !== undefined ? arg.body : body });
        resolve({ res, raw: arg, store, calls, gets });
      },
      $persistentStore: {
        read: (k) => (store.has(k) ? store.get(k) : null),
        write: (v, k) => { store.set(k, String(v)); return true; },
      },
      $httpClient: {
        get: (o, cb) => {
          gets.push(o);
          const r = opts.respondGet ? opts.respondGet(o) : { status: 200, body: '' };
          setTimeout(() => cb(r.error || null, r.error ? null : { status: r.status }, r.body || ''), r.delay || 0);
        },
        post: (o, cb) => {
          calls.push(o);
          const r = opts.respond ? opts.respond(o, calls.length) : { status: 200, body: '{}' };
          if (r.error) return setTimeout(() => cb(r.error, null, null), r.delay || 0);
          setTimeout(() => cb(null, { status: r.status }, r.body), r.delay || 0);
        },
      },
      $notification: { post() {} },
    };
    // 按用例需要改掉沙箱里的某个内置对象，模拟脚本运行途中出错
    if (opts.patch) opts.patch(sandbox);
    try { vm.runInNewContext(withConfig(PANEL, opts.config), sandbox, { filename: 'ytsub.js' }); }
    catch (e) { clearTimeout(timer); reject(e); }
  });
}

const json = (r) => JSON.parse(r.res.body);
const U = 'http://subs.test';
const GET = (p, store, extra) => panel(Object.assign({ url: U + p, store }, extra || {})).then(json);
const POST = (p, body, store, extra) => panel(Object.assign({ url: U + p, method: 'POST', store, body: JSON.stringify(body || {}) }, extra || {})).then(json);

/* ── 沙箱：跑翻译脚本（验证配置往返）──
   opts.cron：模拟 cron 钩子（没有 $request 也没有 $response）；opts.script：换一份脚本（迁移对照）；
   opts.respond：自定义端点响应，默认按行回译文。 */
function translate(opts) {
  const store = opts.store;
  const calls = [];
  const notifications = [];
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('翻译脚本没有调用 $done')), 60000);
    const sandbox = {
      console: { log() {} },
      setTimeout, clearTimeout, Promise, JSON, Math, Date, Object, Array,
      String, Number, RegExp, Error, parseInt, parseFloat, isNaN,
      decodeURIComponent, encodeURIComponent,
      $request: opts.cron ? undefined : { url: opts.url },
      $argument: opts.argument,
      $response: opts.cron ? undefined : { status: 200, body: opts.body, headers: {} },
      $done: (a) => { clearTimeout(timer); setTimeout(() => resolve({ result: a, calls, store, notifications }), opts.settle || 0); },
      $persistentStore: {
        read: (k) => (store.has(k) ? store.get(k) : null),
        write: (v, k) => { store.set(k, String(v)); return true; },
      },
      $httpClient: {
        get: (o, cb) => { setTimeout(() => cb(null, { status: 200 }, ''), 0); },
        post: (o, cb) => {
          calls.push(o);
          if (opts.respond) {
            const r = opts.respond(o, calls.length);
            if (r.error) return setTimeout(() => cb(r.error, null, null), 0);
            return setTimeout(() => cb(null, { status: r.status }, r.body), r.delay || 0);
          }
          const msgs = JSON.parse(o.body).messages;
          const user = msgs[msgs.length - 1].content;
          const m = user.match(/<<<SUBS\n([\s\S]*)\nSUBS>>>/);
          const n = m ? m[1].split('\n').length : user.split('\n').length;
          const lines = [];
          for (let i = 1; i <= n; i++) lines.push(i + '|译' + i);
          setTimeout(() => cb(null, { status: 200 },
            JSON.stringify({ choices: [{ message: { content: lines.join('\n') }, finish_reason: 'stop' }] })), 0);
        },
      },
      $notification: { post: (t, s, b) => notifications.push({ t, s, b }) },
    };
    try { vm.runInNewContext(withConfig(opts.script || TRANSLATE, opts.config), sandbox, { filename: 'ytsub.js' }); }
    catch (e) { clearTimeout(timer); reject(e); }
  });
}

const j3 = (evs) => JSON.stringify({ wireMagic: 'pb3', pens: [{}], wpWinPositions: [{}], wsWinStyles: [{}], events: evs });
const SUB1 = 'https://www.youtube.com/api/timedtext?v=abc&lang=en&fmt=json3';
const oneLine = (s) => j3([{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: s || 'hello world here' }] }]);
const okReply = (content, extra) => ({ status: 200, body: JSON.stringify(Object.assign({ choices: [{ message: { content }, finish_reason: 'stop' }] }, extra || {})) });
// 按请求里的 SUBS 行数回译文（测试连接用 12 行样本）
const echoLines = (o) => {
  const msgs = JSON.parse(o.body).messages;
  const user = msgs[msgs.length - 1].content;
  const m = user.match(/<<<SUBS\n([\s\S]*)\nSUBS>>>/);
  const n = m ? m[1].split('\n').length : user.split('\n').length;
  const out = []; for (let i = 1; i <= n; i++) out.push(i + '|译文' + i);
  return okReply(out.join('\n'));
};
const withKey = (id, key, store) => { const s = store || new Map(); s.set('llmsubs.key.' + (id || 'deepseek'), key || 'sk-test-0000-1111-2222'); return s; };
const cfg4 = (d) => JSON.stringify({ v: 4, d });

/* ── 沙箱：把页面脚本跑起来，用真实接口的响应驱动视图函数 ──
   模拟接口块换成永不返回的桩（boot 不会覆盖用例手动装进 S 的数据），DOM 只桩到视图函数用得到的程度。 */
function pageSandbox() {
  const script = PANEL_HTML.slice(PANEL_HTML.indexOf('<script>') + 8, PANEL_HTML.lastIndexOf('</script>'));
  const MS = '/* @@MOCK-API-START@@ */', ME = '/* @@MOCK-API-END@@ */';
  const never = 'function(){return new Promise(function(){});}';
  const code = script.slice(0, script.indexOf(MS)) +
    'var api = { getConfig:' + never + ', saveConfig:' + never + ', setKey:' + never + ', test:' + never + ', resume:' + never + ', clearCache:' + never + ', resetConfig:' + never + ', diag:' + never + ' };\n' +
    script.slice(script.indexOf(ME) + ME.length);
  const els = {};
  const el = (id) => els[id] || (els[id] = { id, innerHTML: '', textContent: '', hidden: false, style: {}, open: false,
    addEventListener() {}, querySelectorAll: () => [], querySelector: () => null, setAttribute() {}, removeAttribute() {}, focus() {}, firstChild: null });
  const noop = () => {};
  const sb = {
    document: { getElementById: el, documentElement: { lang: '', setAttribute: noop, removeAttribute: noop }, addEventListener: noop,
      querySelector: () => null, querySelectorAll: () => [], hidden: false, title: '', activeElement: null, body: { contains: () => false, appendChild: noop, removeChild: noop } },
    window: { addEventListener: noop, scrollTo: noop, pageYOffset: 0 },
    navigator: { language: 'zh-CN', languages: ['zh-CN'] },
    location: { hash: '', reload: noop }, history: {},
    localStorage: { getItem: () => null, setItem: noop },
    setTimeout, clearTimeout, setInterval: () => 0, console: { log: noop, error: noop },
    JSON, Math, Date, Object, Array, String, Number, RegExp, Error, Promise, parseInt, parseFloat, isNaN, encodeURIComponent, decodeURIComponent,
  };
  vm.createContext(sb);
  vm.runInContext(code, sb, { filename: 'panel.html' });
  // g = GET /api/config 的响应，d = GET /api/diag 的响应（与 boot() 同样的装载）
  sb.load = (g, d) => {
    const S = sb.S;
    S.cfg = g.cfg; S.saved = g.saved; S.keys = g.keys || {}; S.rec = g.rec; S.fallback = g.fallback || {}; S.directory = g.directory || [];
    S.limits = g.limits; S.fc = g.fc; S.status = g.status; S.ver = g.ver || ''; S.diag = (d && d.ok) ? d : null;
    sb.LANG = sb.resolveLang(S.cfg);
  };
  sb.show = (route) => {
    sb.S.route = route;
    sb.render();
    const html = ['rail', 'top', 'status', 'view', 'foot'].map((k) => el(k).innerHTML).join('\n');
    const acts = new Set((html.match(/data-act="[^"]+"/g) || []).map((s) => s.slice(10, -1)));
    const vs = new Set((html.match(/data-v="[^"]+"/g) || []).map((s) => s.slice(8, -1)));
    return { html, acts, vs, status: el('status').innerHTML };
  };
  return sb;
}
async function viewOf(store, route, config, prep) {
  const g = await GET('/api/config', store, { config });
  const d = await GET('/api/diag', store, { config });
  assertEqual(g.ok, true, 'GET /api/config 应当成功');
  const sb = pageSandbox();
  sb.load(g, d);
  if (prep) prep(sb);
  const v = sb.show(route);
  assert(v.status.indexOf('页面显示出错') < 0, route + ' 视图渲染抛错了');
  return v;
}

async function main() {
  section('页面与路由');

  await check('GET / 返回内联 HTML 页面；不加载外部资源，外链只允许 DeepSeek 开放平台', async () => {
    const { res } = await panel({ url: U + '/' });
    assertEqual(res.status, 200, '应当 200');
    assert(/text\/html/.test(res.headers['Content-Type']), 'Content-Type 应当是 HTML');
    assert(res.body.indexOf('<!doctype html>') === 0, '应当是完整 HTML 文档');
    assert(res.body.includes('<title>SubsPair · YouTube AI 双语字幕</title>'), '应当有标题，且带产品名');
    // 页面必须自包含，不能依赖 CDN——否则没联网或网络不稳时首次打开就白屏
    assert(!/src\s*=\s*['"]https?:/i.test(res.body), '不得引用外部脚本或图片');
    assert(!/<link[^>]+href\s*=\s*['"]https?:/i.test(res.body), '不得引用外部样式');
    assert(!/@import|url\(\s*['"]?https?:/i.test(res.body), 'CSS 里不得加载外部资源');
    const urls = res.body.match(/https?:\/\/[A-Za-z0-9.\-]+[^\s'"<>)]*/g) || [];
    const bad = urls.filter((u) => !/^https:\/\/platform\.deepseek\.com\//.test(u) && !/^https:\/\/subs\.test\/$/.test(u) &&
      u !== 'http://www.w3.org/2000/svg' && !/^https:\/\/api\.example\.com\/v1/.test(u) && !/^http:\/\/192\.168\.1\.10/.test(u));
    assertEqual(bad.length, 0, '页面里出现了白名单外的地址：' + bad.join(' '));
  });

  await check('OPTIONS 200，但不放行跨源（无 CORS 头）', async () => {
    const { res } = await panel({ url: U + '/api/config', method: 'OPTIONS' });
    assertEqual(res.status, 200, '应当 200');
    assert(!res.headers['Access-Control-Allow-Origin'], '不得有 Access-Control-Allow-Origin');
    const page = await panel({ url: U + '/' });
    assert(!page.res.headers['Access-Control-Allow-Origin'], '页面也不得带 CORS 头');
  });

  await check('未知路径回落到页面；打开页面记下首次打开时刻', async () => {
    const store = new Map();
    const { res } = await panel({ url: U + '/whatever/deep/path', store });
    assert(res.body.indexOf('<!doctype html>') === 0, '任何 GET 都应当给页面');
    assert(+store.get('llmsubs.panel.first') > 0, '帮助页靠它区分「后台任务还没来得及跑」与「根本没跑」');
  });

  await check('页面地址只认 GET：带内容的请求打到页面地址时回一句拒绝，不会把请求者发来的内容当网页交回去', async () => {
    const html = '<script>alert(1)</script>';
    for (const [mth, pth] of [['POST', '/'], ['POST', '/anything'], ['POST', '/relay'], ['PUT', '/']]) {
      const p = await panel({ url: U + pth, method: mth, store: new Map(), body: html });
      assert(p.res && p.res.body !== html, mth + ' ' + pth + '：交回的正文不能是请求者发来的那段内容');
      assertEqual(JSON.parse(p.res.body).code, 'bad_request');
      assert(/application\/json/.test(p.res.headers['Content-Type']), mth + ' ' + pth + '：不以网页的类型交回');
    }
    const g = await panel({ url: U + '/', store: new Map() });
    assert(/<!doctype html>/i.test(g.res.body), 'GET 照常打开设置页');
  });

  section('配置 v4：出厂值 ⊕ 面板改动');

  const defNum = (k) => Number((PANEL.match(new RegExp('\\n\\s*' + k + ':\\s*(\\d+),')) || [])[1]);

  await check('GET /api/config：面板形状的配置、密钥尾号、推荐模型、兜底参数、服务商目录；永不回传密钥', async () => {
    const c = await GET('/api/config', new Map());
    assertEqual(c.ok, true);
    assertEqual(c.ver, VER);
    assertEqual(c.cfg.mode, 'rec', '默认推荐模式');
    assertEqual(c.cfg.enabled, true);
    assertEqual(c.cfg.uiLang, 'auto'); assertEqual(c.cfg.theme, 'auto'); assertEqual(c.cfg.fcCap, 'auto');
    assertEqual(c.cfg.custom.provider, 'zhipu', '切到其他模型时默认智谱');
    assert(!('apiKey' in c.cfg) && !('provider' in c.cfg) && !('services' in c.cfg), 'v3 的键不再出现');
    assertEqual(JSON.stringify(c.keys), '{}', '全新设备没有任何密钥');
    assertEqual(c.directory[0].id, 'deepseek', '目录第一项是 DeepSeek 官方');
    assert(c.directory.every((p) => typeof p.url === 'string' && Array.isArray(p.models) && typeof p.key === 'boolean' && !('apiKey' in p)), '目录只放稳定事实');
    const zp = c.directory.find((p) => p.id === 'zhipu');
    assertEqual(zp.models[0], 'glm-5.2', '智谱的第一个常用模型是 glm-5.2');
    // 目录只列这几家、局域网 Ollama 与「其他兼容接口」（自己填地址，任何兼容接口都能接）；页面演示用的那份目录与脚本的一字不差
    assertEqual(c.directory.map((p) => p.id).join(' '), 'deepseek dashscope zhipu kimi siliconflow volc ollama custom', '服务商目录');
    const mock = (PANEL_HTML.match(/var MOCK_DIRECTORY = (\[[\s\S]*?\n\]);/) || [])[1];
    assert(mock, '前提：页面里有演示用的目录');
    assertEqual(JSON.stringify(new Function('return ' + mock)()), JSON.stringify(c.directory), '页面演示用的目录要和脚本的一字不差');
    // 页面字典里服务商的显示名与目录一一对应，模型名提示只给目录里的服务商；演示场景只用目录里的服务商
    const tStart = PANEL_HTML.indexOf('var T = {'), tEnd = PANEL_HTML.indexOf('\n};', tStart) + 3;
    const T = new Function(PANEL_HTML.slice(tStart, tEnd) + '; return T;')();
    const ids = c.directory.map((p) => p.id);
    for (const lang of ['zh', 'en']) {
      assertEqual(Object.keys(T[lang]).filter((k) => k.startsWith('dir.')).map((k) => k.slice(4)).sort().join(' '), ids.slice().sort().join(' '), lang + ' 字典里服务商的显示名要和目录一一对应');
      const ph = Object.keys(T[lang]).filter((k) => k.startsWith('m.modelPh.')).map((k) => k.slice(10));
      assert(ph.every((id) => ids.includes(id)), lang + ' 字典里模型名提示的服务商要都在目录里：' + ph.join(' '));
    }
    const mockApi = PANEL_HTML.slice(PANEL_HTML.indexOf('@@MOCK-API-START@@'), PANEL_HTML.indexOf('@@MOCK-API-END@@'));
    const used = [...mockApi.matchAll(/provider:'([\w-]+)'|m\.keys\.([\w-]+)\s*=/g)].map((m) => m[1] || m[2]);
    assert(used.length >= 2 && used.every((id) => ids.includes(id)), '演示场景用到的服务商要都在目录里：' + [...new Set(used)].join(' '));
    assertEqual(c.rec.model, (PANEL.match(/\n\s*model: '([^']+)',/) || [])[1], '推荐模型就是 DEFAULTS.model');
    assertEqual(JSON.stringify(c.fallback), JSON.stringify({ temperature: '', think: 'none', chunkChars: 800, fc: 32, maxTokensFloor: 1024, secondWave: false, bfThink: false, extraBody: '' }));
    assertEqual(JSON.stringify(c.limits), JSON.stringify({ fc: [1, 96], cc: [600, 1600] }));
    assertEqual(c.saved.v, 4); assertEqual(JSON.stringify(c.saved.d), '{}', '全新设备没有任何改动');
    assertEqual(c.status.code, 'setup_key', '没有密钥 = 尚未完成设置');
    assertEqual(c.fc.capN, defNum('fastConcurrency')); assertEqual(c.fc.eff, defNum('fastConcurrency'));
  });

  await check('存着的服务商已经不在目录里：读出来落回默认服务商、不报错；再保存时报成被改动', async () => {
    const store = new Map();
    store.set('llmsubs.cfg4', JSON.stringify({ v: 4, d: { mode: 'custom', custom: { provider: 'retired-provider', ep: { 'retired-provider': { model: 'm-1' }, zhipu: { model: 'glm-4.7-flash' } } } } }));
    const c = await GET('/api/config', store);
    assertEqual(c.ok, true);
    assertEqual(c.cfg.custom.provider, 'zhipu', '落回默认服务商');
    assert(!('retired-provider' in c.cfg.custom.ep), '不在目录里的服务商的地址与模型不再带着');
    assertEqual(c.cfg.custom.ep.zhipu.model, 'glm-4.7-flash', '目录里还在的服务商存过的模型照样保留');
    const r = await POST('/api/config', { mode: 'custom', custom: { provider: 'retired-provider' } }, store);
    assertEqual(r.ok, true);
    assert(r.adjusted.some((a) => a.key === 'custom.provider' && a.code === 'invalid'), '保存时把服务商报成被改动：' + JSON.stringify(r.adjusted));
  });

  await check('POST /api/config：只收白名单、逐键夹取、只存与出厂值不同的键，被改动的键列进 adjusted', async () => {
    const store = new Map();
    const r = await POST('/api/config', {
      enabled: false, model: 'hijacked', budgetMs: 1, position: 'above', fcCap: 999, theme: 'neon',
      custom: { provider: 'dashscope', ep: { dashscope: { model: 'bad model!!', url: 'http://evil.example.com/v1' }, evil: { model: 'x' } },
        temperature: '9', chunkChars: 100, think: 'bogus', secondWave: true, extraBody: '{not json' },
    }, store);
    assertEqual(r.ok, true, '保存应当成功');
    const saved = JSON.parse(store.get('llmsubs.cfg4'));
    assertEqual(saved.v, 4);
    assertEqual(saved.d.enabled, false); assertEqual(saved.d.position, 'above');
    assert(!('model' in saved.d) && !('budgetMs' in saved.d) && !('theme' in saved.d), '白名单外的键与回落到出厂值的键都不存');
    assertEqual(saved.d.fcCap, 96, '同时请求数上限夹到 96');
    const cu = saved.d.custom;
    assertEqual(cu.provider, 'dashscope');
    assertEqual(cu.ep.dashscope.model, 'badmodel', '模型名只留合法字符');
    assert(!cu.ep.dashscope.url, '公网 http 地址不收');
    assert(!cu.ep.evil, '目录外的服务商整个丢弃');
    assertEqual(cu.temperature, '2', '温度夹到 2');
    assertEqual(cu.chunkChars, 600, '每次请求字符数夹到 600');
    assert(!('think' in cu), '未知的思考方式回落 none（与兜底相同就不存）');
    assertEqual(cu.secondWave, true);
    assert(!('extraBody' in cu), '不是 JSON 对象的附加参数不收');
    const adj = r.adjusted.map((a) => a.key).sort().join(',');
    for (const k of ['fcCap', 'theme', 'custom.ep.dashscope.model', 'custom.ep.dashscope.url', 'custom.temperature', 'custom.chunkChars', 'custom.think', 'custom.extraBody']) {
      assert(adj.split(',').indexOf(k) >= 0, 'adjusted 应当列出 ' + k + '：' + adj);
    }
    assertEqual(r.cfg.enabled, false, '返回合并后的配置');
    assert(r.status && r.fc && r.keys && r.directory, '保存的响应与 GET 同形状，页面据此落定');
    assert(!store.get('llmsubs.cfg'), '不写 v3 的键');
  });

  await check('改回出厂值就删掉该键；全部改回时仍写 {v:4, d:{}}（否则残留的 v3 配置会被重新迁移）', async () => {
    const store = new Map();
    store.set('llmsubs.cfg', JSON.stringify({ v: 3, d: { position: 'above' } }));
    await POST('/api/config', { enabled: false }, store);
    let saved = JSON.parse(store.get('llmsubs.cfg4'));
    assertEqual(saved.d.position, 'above', '迁移后的 v3 值带进 cfg4');
    await POST('/api/config', { enabled: true, position: 'below', uiLang: 'auto' }, store);
    saved = JSON.parse(store.get('llmsubs.cfg4'));
    assertEqual(JSON.stringify(saved), JSON.stringify({ v: 4, d: {} }), '一个改动都没有时写空的 v4');
    const g = await GET('/api/config', store);
    assertEqual(g.cfg.position, 'below', 'v3 的旧值不能复活');
    assertEqual(JSON.parse(store.get('llmsubs.cfg')).d.position, 'above', 'v3 的 cfg 只读保留，便于回滚');
  });

  await check('页面版本闸与令牌闸：缺 pv / 旧 pv 一律 stale_page；POST 无令牌或错令牌一律 bad_token；被拒的写入不落盘', async () => {
    const store = new Map();
    const page = await panel({ url: U + '/', store });
    const tok = store.get('llmsubs.tok');
    assert(tok && tok.length >= 16, 'GET / 应当生成按设备的令牌');
    assert(page.res.body.includes('name="ytsub-token" content="' + tok + '"'), '令牌要注入页面');
    assert(page.res.body.includes("var PV = '" + VER + "'"), '页面版本要注入页面脚本');
    const g = await panel({ url: U + '/api/config', store });
    assert(!g.res.body.includes(tok), 'GET /api/config 不得带令牌');
    for (const p of ['/api/config', '/api/diag']) {
      const r = await GET(p, store, { noPv: true });
      assertEqual(r.code, 'stale_page', p + ' 缺 pv 应当 stale_page');
      assert(/刷新/.test(r.msg) && /Reload/.test(r.msg), 'stale_page 带一句旧页面能直接显示的话');
      const r2 = await panel({ url: U + p + '?pv=3.6.4', store, noPv: true }).then(json);
      assertEqual(r2.code, 'stale_page', p + ' 旧版本 pv 应当 stale_page');
    }
    const routes = [['/api/config', { enabled: false }], ['/api/key', { provider: 'kimi', key: 'sk-evil-1' }], ['/api/config/reset', {}],
      ['/api/cache/clear', {}], ['/api/resume', {}], ['/api/diag/clear', {}], ['/api/test', {}]];
    for (const [p, body] of routes) {
      const a = await POST(p, body, store, { noTok: true });
      assertEqual(a.code, 'bad_token', p + ' 无令牌必须拒绝');
      const b = await POST(p, Object.assign({ tok: 'wrong' }, body), store, { noTok: true });
      assertEqual(b.code, 'bad_token', p + ' 错令牌必须拒绝');
      const c = await POST(p, body, store, { noPv: true });
      assertEqual(c.code, 'stale_page', p + ' 缺 pv 必须拒绝');
    }
    assert(!store.get('llmsubs.cfg4') && !store.get('llmsubs.key.kimi'), '被拒的写入不得落盘');
    const ok = await POST('/api/config', { enabled: false }, store);
    assertEqual(ok.ok, true, '带对令牌与版本就能写');
  });

  await check('旧页面兼容：stale 的 GET /api/diag 补齐旧页面重绘会读的空字段；/api/config 不补（补了假配置会显示成设置被清空）', async () => {
    const store = new Map();
    for (const extra of [{ noPv: true }, { noPv: true, url: U + '/api/diag?pv=3.6.4' }]) {
      const d = await panel(Object.assign({ url: U + '/api/diag', store }, extra)).then(json);
      assertEqual(d.code, 'stale_page');
      for (const k of ['records', 'obs', 'reqlog', 'pings', 'cron', 'backfill', 'killed']) assert(Array.isArray(d[k]), 'stale diag 的 ' + k + ' 应当是空数组');
      assert(d.circuit && typeof d.circuit === 'object' && d.cronStats === null && d.cacheEntries === 0, JSON.stringify(d));
    }
    const g = await GET('/api/config', store, { noPv: true });
    assert(!('cfg' in g) && !('records' in g), 'stale 的 /api/config 只回 code 与 msg：' + JSON.stringify(Object.keys(g)));
  });

  await check('不变量：空存储时脚本跑的配置 = DEFAULTS（请求体、端点、密钥都来自 DEFAULTS）', async () => {
    const conf = { baseUrl: 'https://probe.test/v1', model: 'probe-model', apiKey: 'sk-probe-1', temperature: 0.7, fastConcurrency: 8 };
    const { calls } = await translate({ url: SUB1, body: oneLine(), store: new Map(), config: conf });
    assert(calls.length > 0);
    assert(calls[0].url.startsWith('https://probe.test/v1'), '端点来自 DEFAULTS');
    assertEqual(calls[0].headers.Authorization, 'Bearer sk-probe-1', '密钥来自 DEFAULTS');
    const body = JSON.parse(calls[0].body);
    assertEqual(body.model, 'probe-model'); assertEqual(body.temperature, 0.7);
    assertEqual(JSON.stringify(body.thinking), JSON.stringify({ type: 'disabled' }), 'extraBody 来自 DEFAULTS');
    assertEqual(body.max_tokens, 768, '推荐模式 max_tokens 下限 768（DEFAULTS.maxTokensFloor）');
  });

  await check('元测试：源码里不得出现原始控制字符与双向控制符（只能写成转义）', async () => {
    const bad = new Set([0x7f, 0x2028, 0x2029, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2060, 0xfeff]);
    for (let c = 0; c < 32; c++) if (c !== 9 && c !== 10 && c !== 13) bad.add(c);
    for (const [name, text] of [['ytsub.js', PANEL], ['panel/panel.html', PANEL_HTML], ['panel/api.real.js', fs.readFileSync(path.join(ROOT, 'panel', 'api.real.js'), 'utf8')]]) {
      let line = 1; const hits = [];
      for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); if (c === 10) line++; else if (bad.has(c)) hits.push(line + ':U+' + c.toString(16)); }
      assertEqual(hits.length, 0, name + ' 里有原始控制字符：' + hits.slice(0, 5).join(' '));
    }
  });

  await check('元测试：DEFAULTS 之前不得出现同名键行（withConfig 按第一处匹配改写，会被劫持）', async () => {
    const at = PANEL.indexOf('var DEFAULTS = {');
    assert(at > 0);
    const head = PANEL.slice(0, at);
    const m = head.match(/\n\s*(model|baseUrl|apiKey|temperature|extraBody|fastConcurrency|chunkChars|maxTokensFloor|cache|enabled|backfillThinking|secondWave|probe|debug):/);   // probe / debug 同样按「第一处同名键行」定位，一并查
    assert(!m, 'DEFAULTS 之前出现了 ' + (m && m[1]));
    assert(/\n\s*maxTokensFloor: 768,/.test(PANEL), 'DEFAULTS 要有单行的 maxTokensFloor: 768');
  });

  await check('targetLang 走原型链的假值（constructor / toString / __proto__）一律回落', async () => {
    for (const bad of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      const store = new Map();
      const r = await POST('/api/config', { targetLang: bad }, store);
      assertEqual(r.cfg.targetLang, 'zh-Hans', bad + ' 不是合法语言码');
      assertEqual(JSON.stringify(JSON.parse(store.get('llmsubs.cfg4')).d), '{}', '回落到出厂值就不存');
    }
    const store = withKey();
    store.set('llmsubs.cfg4', cfg4({ targetLang: 'constructor' }));
    const { calls } = await translate({ url: SUB1, body: oneLine(), store });
    const sys = JSON.parse(calls[0].body).messages[0].content;
    assert(!/native code|function Object/.test(sys), '提示词不得被原型链上的函数污染');
  });

  await check('推荐模式锁定模型参数：存储里残留任何 custom 值都不参与合并', async () => {
    const store = withKey();
    store.set('llmsubs.cfg4', cfg4({ mode: 'rec', fcCap: 32, custom: { provider: 'kimi', ep: { kimi: { model: 'x', url: 'https://evil.example.com/v1' } }, temperature: '0.9', think: 'effort', chunkChars: 600, extraBody: '{"top_p":0.1}' } }));
    const conf = { baseUrl: 'https://rec.test/v1', model: 'rec-model' };
    const { calls } = await translate({ url: SUB1, body: oneLine(), store, config: conf });
    assert(calls.length > 0);
    assert(calls[0].url.startsWith('https://rec.test/v1'), '地址锁定为 DEFAULTS');
    const body = JSON.parse(calls[0].body);
    assertEqual(body.model, 'rec-model'); assertEqual(body.temperature, 0);
    assertEqual(JSON.stringify(body.thinking), JSON.stringify({ type: 'disabled' }));
    assert(!('reasoning_effort' in body) && !('top_p' in body), 'custom 的参数不得渗进推荐模式');
    const g = await GET('/api/config', store, { config: conf });
    assertEqual(g.fc.capN, 32, '推荐模式只开放同时请求数上限');
  });

  await check('其他模型：切过去默认智谱 glm-5.2；参数 = 兜底预设（不发温度、不发思考字段、max_tokens 下限 1024）', async () => {
    const store = new Map();
    await POST('/api/config', { mode: 'custom' }, store);
    let g = await GET('/api/config', store);
    assertEqual(g.status.code, 'setup_key', '智谱没有密钥 = 尚未完成设置');
    let t = await translate({ url: SUB1, body: oneLine(), store });
    assertEqual(t.calls.length, 0, '缺密钥零出站');
    await POST('/api/key', { provider: 'zhipu', key: 'zp-key-000000000000' }, store);
    g = await GET('/api/config', store);
    assertEqual(g.status.code, 'ok');
    assertEqual(g.fc.capN, 32, '其他模型的默认上限 32');
    t = await translate({ url: SUB1, body: oneLine(), store });
    assert(t.calls.length > 0);
    assert(t.calls[0].url.startsWith('https://open.bigmodel.cn/api/paas/v4/chat/completions'), '打智谱：' + t.calls[0].url);
    assertEqual(t.calls[0].headers.Authorization, 'Bearer zp-key-000000000000', '用智谱自己的密钥');
    const body = JSON.parse(t.calls[0].body);
    assertEqual(body.model, 'glm-5.2');
    assert(!('temperature' in body), '兜底预设不发温度');
    for (const k of ['thinking', 'enable_thinking', 'reasoning', 'reasoning_effort']) assert(!(k in body), '兜底预设不发思考字段：' + k);
    assertEqual(body.max_tokens, 1024, '其他模型 max_tokens 下限 1024');
  });

  await check('其他模型：关思考方式是枚举，五种各发各的字段；附加参数在前、思考字段在后', async () => {
    const want = { none: {}, thinking: { thinking: { type: 'disabled' } }, effort: { reasoning_effort: 'none' }, enable: { enable_thinking: false }, reasoning: { reasoning: { enabled: false } } };
    for (const mode of Object.keys(want)) {
      const store = withKey('kimi');
      await POST('/api/config', { mode: 'custom', custom: { provider: 'kimi', think: mode, temperature: '0.3', extraBody: '{"top_p":0.8}' } }, store);
      const { calls } = await translate({ url: SUB1, body: oneLine(), store });
      const body = JSON.parse(calls[0].body);
      assertEqual(body.temperature, 0.3); assertEqual(body.top_p, 0.8);
      for (const k of ['thinking', 'enable_thinking', 'reasoning', 'reasoning_effort']) {
        assertEqual(JSON.stringify(body[k]), JSON.stringify(want[mode][k]), mode + ' 的 ' + k);
      }
    }
  });

  await check('其他模型：服务商没有预设又没填模型名 → 零出站、状态「填写模型名称」、测试连接 no_model', async () => {
    const store = withKey('volc');
    await POST('/api/config', { mode: 'custom', custom: { provider: 'volc' } }, store);
    const { result, calls } = await translate({ url: SUB1, body: oneLine(), store });
    assertEqual(calls.length, 0, '空模型不该发请求');
    assertEqual(result, undefined, '原样放行');
    assertEqual((await GET('/api/config', store)).status.code, 'setup_model');
    const t = await POST('/api/test', {}, store);
    assertEqual(t.ok, false); assertEqual(t.code, 'no_model');
  });

  await check('其他模型：其他兼容接口没填地址 → 状态「服务地址无效」、测试连接 bad_url；地址按服务商分别保存；三样都填好就发到自己填的地址', async () => {
    const store = new Map();
    await POST('/api/config', { mode: 'custom', custom: { provider: 'custom' } }, store);
    assertEqual((await GET('/api/config', store)).status.code, 'setup_url');
    assertEqual((await POST('/api/test', {}, store)).code, 'bad_url');
    await POST('/api/config', { mode: 'custom', custom: { provider: 'custom', ep: { custom: { url: 'https://my.example.com/v1', model: 'm1' }, kimi: { model: 'kimi-other' } } } }, store);
    const g = await GET('/api/config', store);
    assertEqual(g.cfg.custom.ep.custom.url, 'https://my.example.com/v1');
    assertEqual(g.cfg.custom.ep.kimi.model, 'kimi-other', '别的服务商的模型名各存各的');
    assertEqual(g.status.code, 'setup_key');
    // 地址、模型、密钥都自己填好：字幕发到自己填的地址，带自己填的密钥与模型
    await POST('/api/key', { provider: 'custom', key: 'sk-test-0000-1111-2222' }, store);
    assertEqual((await GET('/api/config', store)).status.code, 'ok', '三样都填了就正常');
    const { calls } = await translate({ url: SUB1, body: oneLine(), store });
    assert(calls.length > 0, '应当发请求');
    assertEqual(calls[0].url, 'https://my.example.com/v1/chat/completions', '发到自己填的地址');
    assertEqual(calls[0].headers.Authorization, 'Bearer sk-test-0000-1111-2222', '带自己填的密钥');
    assertEqual(JSON.parse(calls[0].body).model, 'm1', '用自己填的模型');
  });

  await check('其他模型：局域网 http 地址不要求密钥，也绝不发送密钥', async () => {
    const store = withKey('ollama', 'sk-should-not-leak-000');
    await POST('/api/config', { mode: 'custom', custom: { provider: 'ollama', ep: { ollama: { url: 'http://192.168.1.10:11434/v1' } } } }, store);
    assertEqual((await GET('/api/config', store)).status.code, 'ok', '局域网地址不要求密钥');
    const { calls } = await translate({ url: SUB1, body: oneLine(), store });
    assert(calls.length > 0, '应当发请求');
    assert(!calls[0].headers.Authorization, '明文 http 不发密钥');
    assertEqual(JSON.parse(calls[0].body).model, 'qwen3:8b', '目录的第一个常用模型');
  });

  await check('DeepSeek 密钥：填入 → 清除 → 重填，翻译请求跟着变；尾号只在 ≥16 字符时回传', async () => {
    const store = new Map();
    let r = await POST('/api/key', { provider: 'deepseek', key: 'sk-seed-0000000001' }, store);
    assertEqual(r.ok, true); assertEqual(r.keys.deepseek.tail, '0001', '≥16 字符回传末 4 位');
    assertEqual(r.status.code, 'ok', '密钥写入后状态立刻刷新');
    assert(!JSON.stringify(r).includes('sk-seed-00000'), '响应里不得出现密钥前段');
    r = await POST('/api/key', { provider: 'deepseek', clear: true }, store);
    assertEqual(r.ok, true); assert(!r.keys.deepseek, '清除后不再显示「已保存」');
    assertEqual(r.status.code, 'setup_key');
    let t = await translate({ url: SUB1, body: oneLine(), store });
    assertEqual(t.calls.length, 0, '清除后零出站');
    r = await POST('/api/key', { provider: 'deepseek', key: 'sk-short' }, store);
    assertEqual(r.keys.deepseek.tail, null, '短密钥不回传尾号');
    t = await translate({ url: SUB1, body: oneLine('a different line here'), store });
    assert(t.calls.length > 0, '应当重新请求');
    assertEqual(t.calls[0].headers.Authorization, 'Bearer sk-short');
    const d = await GET('/api/diag', store);
    assert(!JSON.stringify(d).includes('sk-short') && !JSON.stringify(d).includes('tail'), '诊断里不含密钥也不含尾号');
  });

  await check('密钥只发给存它时的那个主机：改了地址，旧密钥留着但不发、也不显示尾号；改回去自动恢复', async () => {
    const store = new Map(), KEY = 'sk-first-account-000', OTHER = 'https://collector.example.com/v1';
    let r = await POST('/api/key', { provider: 'deepseek', key: KEY }, store);
    assertEqual(r.keys.deepseek.tail, '-000', '前提：推荐模式下存好了 DeepSeek 的密钥');
    // 把 DeepSeek 这一家的地址换成别的主机：密钥是给官方主机存的，不能跟着地址走
    r = await POST('/api/config', { mode: 'custom', custom: { provider: 'deepseek', ep: { deepseek: { url: OTHER } } } }, store);
    assert(!r.keys.deepseek, '地址换了主机，这把密钥按没填显示（不回传尾号）');
    assertEqual(r.status.code, 'setup_key', '状态回到「请填写密钥」');
    const t = await panel({ url: U + '/api/test', method: 'POST', store, body: '{}', respond: echoLines });
    assertEqual(JSON.parse(t.res.body).code, 'no_key', '测试连接不拿旧密钥去试新主机');
    assertEqual(t.calls.length, 0, '测试连接一个请求都不发');
    assertEqual((await translate({ url: SUB1, body: oneLine(), store })).calls.length, 0, '翻译也不发：没有密钥就不出站');
    assertEqual(store.get('llmsubs.key.deepseek'), KEY, '密钥本身留在存储里，没有被删');
    // 同一个主机的另一种写法（大小写不同）算同一个主机；端口不同就是另一个主机
    r = await POST('/api/config', { custom: { provider: 'deepseek', ep: { deepseek: { url: 'https://API.DeepSeek.com/v1' } } } }, store);
    assertEqual(r.keys.deepseek.tail, '-000', '主机名大小写不同仍是同一个主机');
    r = await POST('/api/config', { custom: { provider: 'deepseek', ep: { deepseek: { url: 'https://api.deepseek.com:8443/v1' } } } }, store);
    assert(!r.keys.deepseek, '端口不同算另一个主机');
    // 改回去自动恢复，不用重填
    r = await POST('/api/config', { mode: 'rec' }, store);
    assertEqual(r.keys.deepseek.tail, '-000', '回到官方地址，密钥恢复显示');
    assertEqual(r.status.code, 'ok');
    const back = await translate({ url: SUB1, body: oneLine(), store });
    assert(back.calls.length > 0, '回到官方地址后应当发请求');
    assertEqual(back.calls[0].url, 'https://api.deepseek.com/v1/chat/completions');
    assertEqual(back.calls[0].headers.Authorization, 'Bearer ' + KEY, '回到官方地址后照常带密钥');
  });

  await check('密钥与主机：在新地址下重填就改绑到新主机；自己填地址的那一项同样跟着主机；没记过主机的旧密钥只认目录地址', async () => {
    // 在别的主机下「保存并测试」新密钥：新密钥只发给这个主机，并改绑到它
    let store = new Map();
    await POST('/api/key', { provider: 'deepseek', key: 'sk-first-account-000' }, store);
    await POST('/api/config', { mode: 'custom', custom: { provider: 'deepseek', ep: { deepseek: { url: 'https://relay.example.com/v1' } } } }, store);
    const t = await panel({ url: U + '/api/test', method: 'POST', store, body: JSON.stringify({ key: 'sk-second-account-00', slot: 'deepseek' }), respond: echoLines });
    assertEqual(JSON.parse(t.res.body).saved, true);
    assertEqual(t.calls.length, 1); assertEqual(t.calls[0].headers.Authorization, 'Bearer sk-second-account-00', '发给新主机的是新填的密钥，不是旧的');
    let tr = await translate({ url: SUB1, body: oneLine(), store });
    assert(tr.calls.length > 0, '新密钥绑在新主机上，应当发请求');
    assertEqual(tr.calls[0].url, 'https://relay.example.com/v1/chat/completions');
    assertEqual(tr.calls[0].headers.Authorization, 'Bearer sk-second-account-00', '新密钥绑在新主机上，翻译照常');
    let r = await POST('/api/config', { mode: 'rec' }, store);
    assert(!r.keys.deepseek, '回到官方地址：槽位里现在是给别的主机存的密钥，不发给官方主机');
    assertEqual((await translate({ url: SUB1, body: oneLine('another line here'), store })).calls.length, 0);

    // 自己填地址的那一项：密钥跟着存它时的主机
    store = new Map();
    await POST('/api/config', { mode: 'custom', custom: { provider: 'custom', ep: { custom: { url: 'https://a.example.com/v1', model: 'm1' } } } }, store);
    r = await POST('/api/key', { provider: 'custom', key: 'sk-test-0000-1111-2222' }, store);
    assertEqual(r.status.code, 'ok');
    r = await POST('/api/config', { custom: { provider: 'custom', ep: { custom: { url: 'https://b.example.com/v1', model: 'm1' } } } }, store);
    assert(!r.keys.custom, '地址换了主机，密钥不跟过去'); assertEqual(r.status.code, 'setup_key');
    assertEqual((await translate({ url: SUB1, body: oneLine(), store })).calls.length, 0, '不带旧密钥去连新主机');
    r = await POST('/api/config', { custom: { provider: 'custom', ep: { custom: { url: 'https://a.example.com/v2', model: 'm1' } } } }, store);
    assertEqual(r.status.code, 'ok', '同一个主机换路径不受影响');
    tr = await translate({ url: SUB1, body: oneLine(), store });
    assert(tr.calls.length > 0, '同一个主机换路径，应当照常发请求');
    assertEqual(tr.calls[0].headers.Authorization, 'Bearer sk-test-0000-1111-2222');

    // 清除密钥时连同主机记录一起清：之后在别的地址下重填，不会被旧记录挡住
    await POST('/api/key', { provider: 'custom', clear: true }, store);
    assert(!store.get('llmsubs.key.custom.host'), '清除密钥要把主机记录一起清掉');

    // 存储里只有密钥、没有主机记录：目录里有地址的服务商按目录地址算，改了地址就不发
    store = withKey('kimi', 'sk-kimi-000000000000');
    r = await POST('/api/config', { mode: 'custom', custom: { provider: 'kimi' } }, store);
    assertEqual(r.keys.kimi.tail, '0000', '目录地址下照常可用');
    r = await POST('/api/config', { custom: { provider: 'kimi', ep: { kimi: { url: 'https://elsewhere.example.com/v1' } } } }, store);
    assert(!r.keys.kimi, '没记过主机的旧密钥不发给目录之外的主机');
    // 自己填地址的那一项没有目录地址：没记过主机就不可用，重填一次
    store = withKey('custom', 'sk-test-0000-1111-2222');
    r = await POST('/api/config', { mode: 'custom', custom: { provider: 'custom', ep: { custom: { url: 'https://a.example.com/v1', model: 'm1' } } } }, store);
    assert(!r.keys.custom); assertEqual(r.status.code, 'setup_key');
  });

  await check('密钥与主机：密钥没换成就不许动主机记录；长得像的主机不算同一个', async () => {
    const K1 = 'sk-first-account-000', OTHER = 'https://collector.example.com/v1';
    // 先在官方地址下存好密钥，再把这一家的地址换到别的主机
    const moved = async () => {
      const st = new Map();
      await POST('/api/key', { provider: 'deepseek', key: K1 }, st);
      await POST('/api/config', { mode: 'custom', custom: { provider: 'deepseek', ep: { deepseek: { url: OTHER } } } }, st);
      return st;
    };
    const mustNotSend = async (st, why) => {
      assert(!(await GET('/api/config', st)).keys.deepseek, why + '：这把密钥仍应按没填显示');
      assertEqual((await translate({ url: SUB1, body: oneLine(), store: st })).calls.length, 0, why + '：不该带着旧密钥出站');
      assertEqual(st.get('llmsubs.key.deepseek'), K1, why + '：旧密钥原样留着');
    };
    // 交一把会被端点判无效的密钥：新密钥不保存，旧密钥也不能因此改绑到新主机
    let s = await moved();
    let t = await panel({ url: U + '/api/test', method: 'POST', store: s, body: JSON.stringify({ key: 'sk-bad-000000000000', slot: 'deepseek' }),
      respond: () => ({ status: 401, body: '{"error":{"message":"invalid api key"}}' }) });
    assertEqual(JSON.parse(t.res.body).code, 'key_invalid'); assertEqual(JSON.parse(t.res.body).saved, false);
    assertEqual(t.calls.length, 1); assertEqual(t.calls[0].headers.Authorization, 'Bearer sk-bad-000000000000', '测试时发出去的只有刚填的那把');
    await mustNotSend(s, '候选密钥被判无效');
    // 交一把格式不对的密钥
    s = await moved();
    assertEqual((await POST('/api/key', { provider: 'deepseek', key: 'has space' }, s)).code, 'key_format');
    await mustNotSend(s, '密钥格式不对');
    // 存储只拒收密钥这一条写入（两条存密钥的路都试）
    const rejectKeyWrite = (sb) => { const w = sb.$persistentStore.write; sb.$persistentStore.write = (v, k) => (k === 'llmsubs.key.deepseek' ? false : w(v, k)); };
    for (const [route, body] of [['/api/key', { provider: 'deepseek', key: 'sk-second-account-00' }], ['/api/test', { key: 'sk-second-account-00', slot: 'deepseek' }]]) {
      s = await moved();
      const r = JSON.parse((await panel({ url: U + route, method: 'POST', store: s, body: JSON.stringify(body), respond: echoLines, patch: rejectKeyWrite })).res.body);
      assertEqual(r.code, 'write_failed', route + '：密钥没写进去要照实报');
      await mustNotSend(s, route + ' 密钥写入失败');
    }
    // 长得像的主机：前面多一截、少一截、后面多一截，都不是同一个主机
    s = new Map();
    await POST('/api/key', { provider: 'deepseek', key: K1 }, s);
    const lookalikes = ['https://evil-api.deepseek.com/v1', 'https://deepseek.com/v1', 'https://api.deepseek.com.example.com/v1',
      'https://api.deepsee' + String.fromCharCode(0x212a) + '.com/v1'];   // 最后一个：K 换成开尔文符号，转小写后会变成普通的 k
    for (const u of lookalikes) {
      const r = await POST('/api/config', { mode: 'custom', custom: { provider: 'deepseek', ep: { deepseek: { url: u } } } }, s);
      assert(!r.keys.deepseek, '不是同一个主机，密钥不该显示：' + encodeURI(u));
      assertEqual((await translate({ url: SUB1, body: oneLine(), store: s })).calls.length, 0, '不是同一个主机，不该出站：' + encodeURI(u));
    }
    // 主机名里有非 ASCII 字符的地址下「保存并测试」新密钥：不测也不存，原来那把与它的主机记录都不动
    assertEqual((await POST('/api/test', {}, s)).code, 'no_key', '不带新密钥时，这个地址下按没填密钥报');
    const odd = await panel({ url: U + '/api/test', method: 'POST', store: s, body: JSON.stringify({ key: 'sk-second-account-00', slot: 'deepseek' }), respond: echoLines });
    assertEqual(JSON.parse(odd.res.body).code, 'bad_url'); assertEqual(JSON.parse(odd.res.body).saved, false);
    assertEqual(odd.calls.length, 0, '算不出主机的地址下不发测试请求');
    assertEqual(s.get('llmsubs.key.deepseek'), K1, '原来那把密钥没有被换掉');
    assertEqual(s.get('llmsubs.key.deepseek.host'), 'api.deepseek.com', '原来那把的主机记录没有被动');
    const afterOdd = await POST('/api/config', { mode: 'rec' }, s);
    assertEqual(afterOdd.keys.deepseek.tail, '-000', '回到官方地址，原来那把照常可用');
    const backOdd = await translate({ url: SUB1, body: oneLine(), store: s });
    assert(backOdd.calls.length > 0, '回到官方地址后应当发请求'); assertEqual(backOdd.calls[0].headers.Authorization, 'Bearer ' + K1, '发给官方主机的是原来那把，不是在别的地址下填的那把');
    s = new Map();
    await POST('/api/config', { mode: 'custom', custom: { provider: 'custom', ep: { custom: { url: 'https://a.example.com/v1', model: 'm1' } } } }, s);
    await POST('/api/key', { provider: 'custom', key: 'sk-test-0000-1111-2222' }, s);
    for (const u of ['https://xa.example.com/v1', 'https://example.com/v1']) {
      const r = await POST('/api/config', { custom: { provider: 'custom', ep: { custom: { url: u, model: 'm1' } } } }, s);
      assert(!r.keys.custom, '不是同一个主机，密钥不该显示：' + u);
      assertEqual((await translate({ url: SUB1, body: oneLine(), store: s })).calls.length, 0, '不是同一个主机，不该出站：' + u);
    }
    // 自己填地址的那一项也一样：主机名里有非 ASCII 字符的地址下带新密钥测试，不测也不存，原来那把与它的主机记录都不动
    await POST('/api/config', { custom: { provider: 'custom', ep: { custom: { url: 'https://' + String.fromCharCode(0xe4) + '.example.com/v1', model: 'm1' } } } }, s);
    const odd2 = await panel({ url: U + '/api/test', method: 'POST', store: s, body: JSON.stringify({ key: 'sk-second-account-00', slot: 'custom' }), respond: echoLines });
    assertEqual(JSON.parse(odd2.res.body).code, 'bad_url'); assertEqual(odd2.calls.length, 0);
    assertEqual(s.get('llmsubs.key.custom'), 'sk-test-0000-1111-2222', '原来那把没有被换掉');
    assertEqual(s.get('llmsubs.key.custom.host'), 'a.example.com', '原来那把的主机记录没有被动');
  });

  await check('密钥与主机：每条存密钥的路，记的都是这把密钥所属那一家当前的地址', async () => {
    // 自己填地址的那一项经「保存并测试」存（页面走的就是这条路）：存完就能用，换主机就不发
    let s = new Map();
    await POST('/api/config', { mode: 'custom', custom: { provider: 'custom', ep: { custom: { url: 'https://a.example.com/v1', model: 'm1' } } } }, s);
    let t = JSON.parse((await panel({ url: U + '/api/test', method: 'POST', store: s, body: JSON.stringify({ key: 'sk-test-0000-1111-2222', slot: 'custom' }), respond: echoLines })).res.body);
    assertEqual(t.code, 'ok'); assertEqual(t.saved, true);
    assert(t.keys.custom, '保存并测试之后密钥应当显示'); assertEqual(t.status.code, 'ok');
    let tr = await translate({ url: SUB1, body: oneLine(), store: s });
    assert(tr.calls.length > 0, '应当发请求'); assertEqual(tr.calls[0].headers.Authorization, 'Bearer sk-test-0000-1111-2222');
    let r = await POST('/api/config', { custom: { provider: 'custom', ep: { custom: { url: 'https://b.example.com/v1', model: 'm1' } } } }, s);
    assert(!r.keys.custom, '换了主机就不显示');

    // 候选密钥撞限流也照存（只有明确无效才不存），同样要绑到刚测的那个主机
    s = new Map();
    await POST('/api/key', { provider: 'deepseek', key: 'sk-first-account-000' }, s);
    await POST('/api/config', { mode: 'custom', custom: { provider: 'deepseek', ep: { deepseek: { url: 'https://relay.example.com/v1' } } } }, s);
    t = JSON.parse((await panel({ url: U + '/api/test', method: 'POST', store: s, body: JSON.stringify({ key: 'sk-second-account-00', slot: 'deepseek' }),
      respond: () => ({ status: 429, body: '{"error":{"message":"rate limit"}}' }) })).res.body);
    assertEqual(t.saved, true, '限流与密钥本身无关，照存');
    assert(t.keys.deepseek, '存下的密钥在刚测的地址下应当显示');
    tr = await translate({ url: SUB1, body: oneLine(), store: s });
    assert(tr.calls.length > 0, '应当发请求'); assertEqual(tr.calls[0].url, 'https://relay.example.com/v1/chat/completions');
    assertEqual(tr.calls[0].headers.Authorization, 'Bearer sk-second-account-00');
    await POST('/api/config', { mode: 'rec' }, s);
    assertEqual((await translate({ url: SUB1, body: oneLine('another line here'), store: s })).calls.length, 0, '给别的主机存的密钥不发给官方主机');

    // 目录里的服务商改了地址之后直接存密钥：绑的是改后的主机
    s = new Map();
    await POST('/api/config', { mode: 'custom', custom: { provider: 'deepseek', ep: { deepseek: { url: 'https://relay.example.com/v1' } } } }, s);
    r = await POST('/api/key', { provider: 'deepseek', key: 'sk-second-account-00' }, s);
    assert(r.keys.deepseek, '在改后的地址下应当显示');
    tr = await translate({ url: SUB1, body: oneLine(), store: s });
    assert(tr.calls.length > 0, '应当发请求'); assertEqual(tr.calls[0].url, 'https://relay.example.com/v1/chat/completions');
    r = await POST('/api/config', { mode: 'rec' }, s);
    assert(!r.keys.deepseek, '回到官方地址：这把是给别的主机存的');
    assertEqual((await translate({ url: SUB1, body: oneLine('another line here'), store: s })).calls.length, 0);

    // 没被选中的服务商同样按它自己的地址判断
    s = withKey('kimi', 'sk-kimi-000000000000');
    r = await POST('/api/config', { mode: 'custom', custom: { provider: 'zhipu', ep: { kimi: { url: 'https://elsewhere.example.com/v1' } } } }, s);
    assert(!r.keys.kimi, '没选中的这一家地址换了主机，它的密钥也不该显示');

    // 推荐模式不影响别家：别家已存的密钥照常显示；这时给别家存密钥，记的是那一家自己的主机
    s = withKey('kimi', 'sk-kimi-000000000000');
    assertEqual((await GET('/api/config', s)).keys.kimi.tail, '0000', '推荐模式下别家的密钥照常显示');
    s = new Map();
    await POST('/api/key', { provider: 'kimi', key: 'sk-kimi-000000000000' }, s);
    assertEqual(s.get('llmsubs.key.kimi.host'), 'api.moonshot.cn', '推荐模式下给 Kimi 存的密钥记 Kimi 的主机');
    assertEqual((await POST('/api/config', { mode: 'custom', custom: { provider: 'kimi' } }, s)).status.code, 'ok');
    // 选中的是另一家时给这一家存密钥：记的是这一家的主机，不是选中那一家的
    s = new Map();
    await POST('/api/config', { mode: 'custom', custom: { provider: 'zhipu' } }, s);
    r = await POST('/api/key', { provider: 'kimi', key: 'sk-kimi-000000000000' }, s);
    assert(r.keys.kimi); assertEqual(s.get('llmsubs.key.kimi.host'), 'api.moonshot.cn');
    assertEqual((await POST('/api/config', { custom: { provider: 'kimi' } }, s)).status.code, 'ok');

    // 自己填地址的那一项还没填地址：存储里就算有密钥也不显示；这时直接存密钥会被拒（存下也用不上）
    s = withKey('custom', 'sk-test-0000-1111-2222');
    assert(!(await GET('/api/config', s)).keys.custom, '没有地址、没有主机记录的密钥不显示');
    assert(!(await POST('/api/config', { mode: 'custom', custom: { provider: 'custom' } }, s)).keys.custom);
    s = new Map();
    await POST('/api/config', { mode: 'custom', custom: { provider: 'custom' } }, s);
    assertEqual((await POST('/api/key', { provider: 'custom', key: 'sk-test-0000-1111-2222' }, s)).code, 'bad_url', '地址还没填就存密钥：拒绝');
    assert(!s.get('llmsubs.key.custom'), '被拒的密钥不落盘');
  });

  await check('出厂不预置任何密钥；DEFAULTS.apiKey 必须留空', async () => {
    const c = await GET('/api/config', new Map());
    assert(!c.keys.deepseek && !c.keys.kimi);
    assert(!/apiKey:\s*'[^']+'/.test(PANEL), 'DEFAULTS.apiKey 必须留空，别把真密钥提交进来');
  });

  await check('发送侧守卫：DEFAULTS.temperature 是空串时也不发该字段', async () => {
    const { calls } = await translate({ url: SUB1, body: oneLine(), store: withKey(), config: { temperature: '' } });
    assert(calls.length > 0);
    assert(!('temperature' in JSON.parse(calls[0].body)), '空串与 null 同义：整个字段不发');
  });

  await check('POST /api/key：格式校验、未知服务商、空串不是清除、永不回传', async () => {
    const store = new Map();
    let r = await POST('/api/key', { provider: 'nope', key: 'sk-x' }, store);
    assertEqual(r.code, 'bad_provider');
    r = await POST('/api/key', { provider: 'kimi', key: 'sk with space' }, store);
    assertEqual(r.code, 'key_format', '带空格的密钥拒绝（防 header 注入）');
    assert(!store.get('llmsubs.key.kimi'));
    r = await POST('/api/key', { provider: 'kimi', key: 'sk-ok-1' }, store);
    assertEqual(r.ok, true);
    const g = await panel({ url: U + '/api/config', store });
    assert(!g.res.body.includes('sk-ok-1'), 'GET 不得回传密钥');
    r = await POST('/api/key', { provider: 'kimi', key: '' }, store);
    assertEqual(r.ok, false, '空串不是清除');
    assertEqual(store.get('llmsubs.key.kimi'), 'sk-ok-1', '空串不改动已存的密钥');
    r = await POST('/api/key', { provider: 'kimi', clear: true }, store);
    assertEqual(r.ok, true); assert(!r.keys.kimi); assert(!store.get('llmsubs.key.kimi'), '显式清除才删');
  });

  await check('恢复默认设置：清 cfg4、cfg、降档、熔断、余额暂停；不动密钥与已保存的译文', async () => {
    const store = withKey('kimi', 'sk-keep-1');
    await POST('/api/config', { enabled: false, mode: 'custom', custom: { provider: 'kimi' } }, store);
    store.set('llmsubs.cfg', JSON.stringify({ v: 3, d: { position: 'above' } }));
    store.set('llmsubs.cache.idx', '[{"k":"x"}]');
    store.set('llmsubs.fcb', '{"eff":8}'); store.set('llmsubs.cb', '{"until":1}'); store.set('llmsubs.pause', '{"until":1}');
    const r = await POST('/api/config/reset', {}, store);
    assertEqual(r.ok, true);
    assertEqual(r.cfg.enabled, true); assertEqual(r.cfg.mode, 'rec'); assertEqual(r.cfg.position, 'below', 'v3 的旧值也要清掉');
    for (const k of ['cfg4', 'cfg', 'fcb', 'cb', 'pause']) assert(!store.get('llmsubs.' + k), k + ' 应当被清');
    assertEqual(store.get('llmsubs.key.kimi'), 'sk-keep-1', '密钥不受影响');
    assertEqual(store.get('llmsubs.cache.idx'), '[{"k":"x"}]', '已保存的译文不受影响');
  });

  await check('坏存储：cfg4 不是 v4 → 回落 v3 迁移；v3 也坏 → 出厂值；白名单键是坏值 → 单键回落', async () => {
    const store = new Map();
    store.set('llmsubs.cfg4', JSON.stringify({ v: 9, d: { enabled: false } }));
    store.set('llmsubs.cfg', JSON.stringify({ v: 2, d: { enabled: false } }));
    let c = await GET('/api/config', store);
    assertEqual(c.cfg.enabled, true, '未知版本整份忽略');
    store.set('llmsubs.cfg4', cfg4({ enabled: false, targetLang: 'xx-YY', position: 42, mode: 'weird', fcCap: 'lots', custom: 'nope' }));
    c = await GET('/api/config', store);
    assertEqual(c.cfg.enabled, false, '好的键照常生效');
    assertEqual(c.cfg.targetLang, 'zh-Hans'); assertEqual(c.cfg.position, 'below'); assertEqual(c.cfg.mode, 'rec');
    assertEqual(c.cfg.fcCap, 'auto'); assertEqual(c.cfg.custom.provider, 'zhipu');
    store.set('llmsubs.cfg4', 'not json');
    c = await GET('/api/config', store);
    assertEqual(c.ok, true, '存储坏掉面板也要能打开');
  });

  section('v3 → v4 迁移（对照 v3.6.4 的真实请求体与配置指纹）');

  // 同一份存储分别喂给 v3.6.4 与当前脚本，比较请求体与成功后写下的 okFp
  async function compareUpgrade(d3, keys, opts) {
    opts = opts || {};
    const mk = () => { const s = new Map(); s.set('llmsubs.cfg', JSON.stringify({ v: 3, d: d3 })); for (const id in keys) s.set('llmsubs.key.' + id, keys[id]); return s; };
    const sNew = mk();
    const g = await GET('/api/config', sNew);
    const tNew = await translate({ url: SUB1, body: oneLine('compare this exact line'), store: sNew });
    const res = { g, tNew, sNew };
    const sOld = mk();
    const tOld = await translate({ url: SUB1, body: oneLine('compare this exact line'), store: sOld, script: OLD_SCRIPT });
    res.tOld = tOld;
    if (opts.body !== false) {
      assert(tOld.calls.length > 0 && tNew.calls.length > 0, '两边都应当发请求');
      assertEqual(tNew.calls[0].url, tOld.calls[0].url, '端点不变');
      assertEqual(JSON.stringify(tNew.calls[0].headers), JSON.stringify(tOld.calls[0].headers), '请求头不变');
      const a = JSON.parse(tOld.calls[0].body), b = JSON.parse(tNew.calls[0].body);
      // 其他模型的 max_tokens 下限是 1024，v3.6.4 是 768：这一项有意不同，单独断言后从比较里拿掉
      if (opts.customFloor) { assertEqual(b.max_tokens, Math.max(1024, a.max_tokens)); delete a.max_tokens; delete b.max_tokens; }
      assertEqual(JSON.stringify(b), JSON.stringify(a), '请求体逐字节不变');
      const fpOld = JSON.parse(sOld.get('llmsubs.cb') || '{}').okFp, fpNew = JSON.parse(sNew.get('llmsubs.cb') || '{}').okFp;
      assert(fpOld && fpNew, '两边都应当写下 okFp');
      assertEqual(fpNew, fpOld, 'CONFIG_FP 不变（okFp 继续有效）');
    }
    return res;
  }

  await check('迁移 1：空存储 / 未知版本 → 出厂值，GET 不写任何存储', async () => {
    const s = new Map();
    s.set('llmsubs.cfg', JSON.stringify({ v: 7, d: { enabled: false } }));
    const g = await GET('/api/config', s);
    assertEqual(g.cfg.enabled, true); assertEqual(JSON.stringify(g.saved.d), '{}');
    assert(!s.get('llmsubs.cfg4'), '迁移只在内存里做');
  });

  await check('迁移 2：只点选过 Kimi（{provider:"kimi"}）→ 其他模型 · Kimi，请求体与指纹不变', async () => {
    const { g } = await compareUpgrade({ provider: 'kimi' }, { kimi: 'sk-kimi-0000000000' }, { customFloor: true });
    assertEqual(g.cfg.mode, 'custom');
    const cu = g.cfg.custom;
    assertEqual(cu.provider, 'kimi'); assertEqual(cu.ep.kimi.model, 'kimi-k2.6', '模型名不能为空');
    assertEqual(cu.temperature, '0.3'); assertEqual(cu.chunkChars, 1100); assert(!('fcCap' in cu), '并发 32 与兜底相同就不存');
    assertEqual(g.cfg.uiLang, 'zh', 'v3 缺席的界面语言迁移成中文，不变成跟随系统');
  });

  await check('迁移 3：DeepSeek 官方改过并发 48 → 推荐模式 + 上限 48，请求体与指纹不变', async () => {
    const { g } = await compareUpgrade({ services: { deepseek: { fastConcurrency: 48 } } }, { deepseek: 'sk-ds-000000000000' });
    assertEqual(g.cfg.mode, 'rec'); assertEqual(g.cfg.fcCap, 48); assertEqual(g.fc.capN, 48);
  });

  await check('迁移 4：DeepSeek 官方开过第二波、温度留空 → 推荐模式；差异存进 custom，点「使用其他模型」可找回', async () => {
    const { g } = await compareUpgrade({ services: { deepseek: { secondWave: true, temperature: '' } } }, { deepseek: 'sk-ds-000000000000' }, { body: false });
    assertEqual(g.cfg.mode, 'rec');
    const cu = g.cfg.custom;
    assertEqual(cu.provider, 'deepseek'); assertEqual(cu.secondWave, true); assertEqual(cu.think, 'thinking');
    assert(!('temperature' in cu), '留空与兜底相同');
    assertEqual(cu.ep.deepseek.model, 'deepseek-flash');
    assertEqual(cu.bfThink, true, 'v3 的 cron 思考在 DeepSeek 上迁移时保留');
    // 已知例外：推荐模式锁定模型参数，v3 里调过的温度不再生效
    const { tNew } = await compareUpgrade({ services: { deepseek: { temperature: '0.7' } } }, { deepseek: 'sk-ds-000000000000' }, { body: false });
    assertEqual(JSON.parse(tNew.calls[0].body).temperature, 0, '推荐模式发推荐温度');
  });

  await check('迁移 5：deepseek-v4-pro → 推荐模式（已路由到 V4.1 Flash；模型名变化是已知例外）', async () => {
    const { g, tNew } = await compareUpgrade({ services: { deepseek: { model: 'deepseek-v4-pro' } } }, { deepseek: 'sk-ds-000000000000' }, { body: false });
    assertEqual(g.cfg.mode, 'rec');
    assertEqual(JSON.parse(tNew.calls[0].body).model, 'deepseek-flash');
  });

  await check('迁移 6：DeepSeek 自定义地址 → 其他模型 · DeepSeek（地址与模型保留）；升级前存的密钥只认官方主机，在自定义地址下重填一次后请求体与指纹不变', async () => {
    const d3 = { services: { deepseek: { baseUrl: 'https://llm.example.com/v1' } } };
    // 升级前存下的密钥没有记过它是给哪个主机存的，升级后按官方地址的主机算：配置原样迁过来，但密钥不带到自定义地址去
    const up = await compareUpgrade(d3, { deepseek: 'sk-ds-000000000000' }, { body: false });
    assertEqual(up.g.cfg.mode, 'custom');
    assertEqual(up.g.cfg.custom.provider, 'deepseek');
    assertEqual(up.g.cfg.custom.ep.deepseek.url, 'https://llm.example.com/v1');
    assertEqual(up.g.cfg.custom.fcCap, 96, 'v3 的并发 96 ≠ 兜底 32，要存');
    assertEqual(up.g.cfg.custom.bfThink, true, 'DeepSeek 系保留 cron 思考');
    assert(up.tOld.calls.length > 0, '前提：升级前的脚本在这套配置下是发请求的');
    assert(!up.g.keys.deepseek, '升级前存的密钥在自定义地址下按没填显示');
    assertEqual(up.g.status.code, 'setup_key', '状态提示去填密钥');
    assertEqual(up.tNew.calls.length, 0, '旧密钥不带到自定义地址去');
    // 在这个地址下重填过密钥（密钥记到了这个主机上）之后，请求体与指纹和升级前一致
    const { g } = await compareUpgrade(d3, { deepseek: 'sk-ds-000000000000', 'deepseek.host': 'llm.example.com' }, { customFloor: true });
    assert(g.keys.deepseek, '重填之后密钥照常显示');
    assertEqual(g.status.code, 'ok');
  });

  await check('迁移 7：百炼 + deepseek-flash（DeepSeek 官方的模型名，百炼的模型表里没有）→ 其他模型 · 百炼 deepseek-v4-flash', async () => {
    const { g } = await compareUpgrade({ provider: 'dashscope', services: { dashscope: { model: 'deepseek-flash' } } }, { dashscope: 'sk-dash-0000000000' }, { body: false });
    assertEqual(g.cfg.mode, 'custom'); assertEqual(g.cfg.custom.ep.dashscope.model, 'deepseek-v4-flash');
  });

  await check('迁移 8：智谱预设没改过 → 其他模型 · 智谱 glm-5.2，请求体与指纹不变', async () => {
    const { g } = await compareUpgrade({ provider: 'zhipu' }, { zhipu: 'zp-key-000000000000' }, { customFloor: true });
    assertEqual(g.cfg.custom.ep.zhipu.model, 'glm-5.2'); assertEqual(g.cfg.custom.think, 'thinking'); assertEqual(g.cfg.custom.temperature, '0.1');
  });

  await check('迁移 9–12：其他兼容接口空地址 / 关闭 + 术语表 / cache:false / 未知服务商', async () => {
    let r = await compareUpgrade({ provider: 'custom' }, {}, { body: false });
    assertEqual(r.g.status.code, 'setup_url'); assertEqual(r.tNew.calls.length, 0);
    r = await compareUpgrade({ enabled: false, glossary: [{ s: 'toy model', t: '简化模型' }] }, { deepseek: 'sk-ds-000000000000' }, { body: false });
    assertEqual(r.g.cfg.enabled, false); assertEqual(r.g.cfg.glossary[0].t, '简化模型'); assertEqual(r.g.status.code, 'off');
    r = await compareUpgrade({ cache: false }, { deepseek: 'sk-ds-000000000000' }, { body: false });
    assert(!('cache' in r.g.cfg) && !('cache' in r.g.saved.d), 'cache 不再是面板设置');
    r = await compareUpgrade({ provider: 'nope', targetLang: 'xx-YY', position: 42, uiLang: 'en' }, { deepseek: 'sk-ds-000000000000' });
    assertEqual(r.g.cfg.mode, 'rec', '未知服务商按 v3 规则回落 DeepSeek'); assertEqual(r.g.cfg.uiLang, 'en');
  });

  await check('v3 配置里选的服务商只要还在目录里，就原样迁成「其他模型」里的这一家（v3 预设表里每一行都用得上）', async () => {
    const c0 = await GET('/api/config', new Map());
    const others = c0.directory.map((p) => p.id).filter((id) => id !== 'deepseek');
    assert(others.length >= 5, '前提：目录里除 DeepSeek 还有别家');
    for (const id of others) {
      const store = new Map();
      store.set('llmsubs.cfg', JSON.stringify({ v: 3, d: { provider: id } }));
      const c = await GET('/api/config', store);
      assertEqual(c.cfg.mode + ' ' + c.cfg.custom.provider, 'custom ' + id, 'v3 里选的是 ' + id + '，迁移后应当还是它');
    }
  });

  await check('迁移幂等：迁移后 POST 一个无关的键，cfg4 里 mode/custom 完整、v3 cfg 原样、密钥不动', async () => {
    const store = withKey('zhipu', 'zp-key-000000000000');
    const v3 = JSON.stringify({ v: 3, d: { provider: 'zhipu', services: { kimi: { model: 'kimi-x' } } } });
    store.set('llmsubs.cfg', v3);
    const before = await GET('/api/config', store);
    await POST('/api/config', { position: 'above' }, store);
    const after = await GET('/api/config', store);
    const saved = JSON.parse(store.get('llmsubs.cfg4'));
    assertEqual(saved.d.mode, 'custom'); assertEqual(saved.d.custom.provider, 'zhipu'); assertEqual(saved.d.custom.ep.kimi.model, 'kimi-x', '其他服务商保存过的模型名一并迁移');
    const a = Object.assign({}, before.cfg), b = Object.assign({}, after.cfg); delete a.position; delete b.position;
    assertEqual(JSON.stringify(b), JSON.stringify(a), '写入 cfg4 前后配置一致（幂等）');
    assertEqual(store.get('llmsubs.cfg'), v3, 'v3 cfg 原样保留');
    assertEqual(store.get('llmsubs.key.zhipu'), 'zp-key-000000000000');
  });

  section('测试连接（与真实翻译同形状）');

  const TCFG = { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-test-key-abcdef', model: 'm' };

  await check('请求同形状：system + user 两条消息、12 行样本、stream:false、密钥只在头里；成功写下与翻译角色相同的 okFp', async () => {
    const store = new Map();
    const { res, calls } = await panel({ url: U + '/api/test', method: 'POST', store, config: TCFG, respond: echoLines });
    assertEqual(calls.length, 1, '应当发一次请求');
    assertEqual(calls[0].url, 'https://api.example.com/v1/chat/completions');
    assert(!calls[0].url.includes('sk-test') && !String(calls[0].body).includes('sk-test'), '密钥绝不进 URL 或请求体');
    assertEqual(calls[0].headers.Authorization, 'Bearer sk-test-key-abcdef');
    assertEqual(calls[0]['auto-redirect'], false, '不得跟随重定向');
    const body = JSON.parse(calls[0].body);
    assertEqual(body.messages.length, 2); assertEqual(body.messages[0].role, 'system'); assertEqual(body.stream, false);
    assert(/<<<SUBS\n(\d+\|[^\n]*\n){11}\d+\|[^\n]*\nSUBS>>>/.test(body.messages[1].content), 'user 里是 12 行编号样本');
    assert(body.messages[0].content.includes('自动语音识别'), '上下文固定为 ASR 轨');
    assertEqual(JSON.stringify(body.thinking), JSON.stringify({ type: 'disabled' }), '思考字段与翻译同源');
    assertEqual(body.max_tokens, 768);
    const r = JSON.parse(res.body);
    assertEqual(r.ok, true); assertEqual(r.code, 'ok'); assertEqual(r.lines.sent, 12); assertEqual(r.lines.got, 12);
    assertEqual(r.rating, 'fast'); assertEqual(r.http, 200);
    assert(r.status && r.keys, '附带最新状态与密钥尾号');
    // 翻译角色对同一份配置算出的指纹
    const t = await translate({ url: SUB1, body: oneLine(), store: new Map(), config: TCFG });
    assertEqual(JSON.parse(store.get('llmsubs.cb')).okFp, JSON.parse(t.store.get('llmsubs.cb')).okFp, 'okFp 与翻译角色同一个 configFp');
  });

  await check('请求体与翻译角色逐字段一致（除用户消息的内容）', async () => {
    const conf = Object.assign({}, TCFG, { extraBody: { thinking: { type: 'disabled' }, presence_penalty: 0.4, messages: [{ role: 'user', content: 'pwn' }], tools: [1], stream: true } });
    const p = await panel({ url: U + '/api/test', method: 'POST', store: new Map(), config: conf, respond: echoLines });
    const t = await translate({ url: SUB1, body: oneLine(), store: new Map(), config: conf });
    const a = JSON.parse(p.calls[0].body), b = JSON.parse(t.calls[0].body);
    assertEqual(a.messages[0].content.replace(/人工制作的[^\n]*/, 'X').replace(/自动语音识别[^\n]*/, 'X').length > 0, true);
    assertEqual(Object.keys(a).sort().join(','), Object.keys(b).sort().join(','), '字段集合一致');
    assertEqual(a.presence_penalty, 0.4, '白名单内的附加参数透传');
    assert(!('tools' in a) && a.stream === false && a.messages.length === 2, '白名单外的键挡掉');
  });

  await check('带内容的请求（POST）回话时，同一份内容也放在顶层 body：小火箭交给页面的正文取的是这一份，不给的话页面收到的是它自己发出去的那段话', async () => {
    const p = await panel({ url: U + '/api/test', method: 'POST', store: new Map(), config: TCFG, respond: echoLines });
    assert(p.raw && p.raw.response && typeof p.raw.body === 'string', '$done 的参数里要有顶层 body');
    assertEqual(p.raw.body, p.raw.response.body, '顶层 body 与 response.body 是同一份内容');
    assertEqual(JSON.parse(p.res.body).code, 'ok', '页面收到的是测试结果，不是它自己发出去的请求内容');
    const save = await panel({ url: U + '/api/config', method: 'POST', store: new Map(), body: JSON.stringify({ position: 'above' }) });
    assertEqual(JSON.parse(save.res.body).ok, true, '保存设置的回话同理');
  });

  await check('测试连接整体 10 秒封顶：兜底计时按剩下的时间算；换写法重试时只拿第一次剩下的，剩不到半秒就不再发', async () => {
    // 把脚本看到的时钟和计时器换成可控的：计时器记下毫秒数后很快触发，时钟可以拨快
    const mk = () => {
      const st = { timers: [], skew: 0 };
      st.patch = (sb) => {
        class D extends Date {}
        D.now = () => Date.now() + st.skew;
        sb.Date = D;
        sb.setTimeout = (fn, ms) => { st.timers.push(ms); return setTimeout(fn, Math.min(ms, 30)); };
      };
      return st;
    };
    const noSys = { status: 400, body: '{"error":{"message":"system role is not supported"}}' };
    // 服务一直不回话：兜底计时不超过 10 秒，到点按超时收尾
    let st = mk();
    let p = await panel({ url: U + '/api/test', method: 'POST', store: new Map(), config: TCFG, patch: st.patch,
      respond: () => ({ status: 200, body: '{}', delay: 300 }) });
    assertEqual(p.calls[0].timeout, 10, '第一次请求最多等 10 秒');
    assert(st.timers.length === 1 && st.timers[0] > 9500 && st.timers[0] <= 10000, '兜底计时不超过 10 秒：' + st.timers);
    assertEqual(JSON.parse(p.res.body).code, 'timeout');
    // 第一次用掉 4 秒才被拒，换写法重试只拿剩下的 6 秒
    st = mk();
    p = await panel({ url: U + '/api/test', method: 'POST', store: new Map(), config: TCFG, patch: st.patch,
      respond: (o, n) => { if (n === 1) { st.skew = 4000; return noSys; } return echoLines(o); } });
    assertEqual(p.calls.length, 2, '端点不认 system 角色时换写法再试一次');
    assertEqual(p.calls[1].timeout, 6, '重试只拿第一次剩下的时间');
    assert(st.timers[1] > 5500 && st.timers[1] <= 6000, '重试的兜底计时也按剩下的时间算：' + st.timers);
    assertEqual(JSON.parse(p.res.body).code, 'ok');
    // 第一次用掉 9.7 秒：剩不到半秒，不再发第二次，直接按超时收尾
    st = mk();
    p = await panel({ url: U + '/api/test', method: 'POST', store: new Map(), config: TCFG, patch: st.patch,
      respond: (o, n) => { if (n === 1) { st.skew = 9700; return noSys; } return echoLines(o); } });
    assertEqual(p.calls.length, 1, '时间不够就不再发');
    assertEqual(JSON.parse(p.res.body).code, 'timeout');
  });

  await check('测试时脚本自己出错（发请求之前，或拿到回复之后）：回「服务暂时不可用」并带上错误原文，密钥先打码再截断，日志里也不露，不把请求原样放行', async () => {
    const secret = 'sk-should-not-leak-000';
    // 候选密钥与已存密钥都用不是 sk- 开头的假串：这类密钥只能靠按原文打码挡住
    const cand = 'candKEY.notSkShape/98765+abc', saved = 'savedKEY.notSkShape-43210', candEnc = encodeURIComponent(cand);
    // 发请求之前出错：让脚本第一次取时间就出错。错误原文里把像密钥的串垫在 200 字截断线上，先截断再打码就会漏出半截
    const head = 'boom ' + cand + ' ' + candEnc + ' ' + saved + ' ';
    const message = head + 'x'.repeat(193 - 'script: '.length - head.length) + secret + ' ' + 'y'.repeat(150);
    const logs = [];
    let thrown = false;
    const early = await panel({ url: U + '/api/test', method: 'POST', store: new Map(), config: Object.assign({}, TCFG, { apiKey: saved }),
      body: JSON.stringify({ key: cand }), respond: echoLines,
      patch: (sb) => {
        sb.console = { log: (m) => logs.push(String(m)) };
        class D extends Date {}
        D.now = () => { if (thrown) return Date.now(); thrown = true; throw new Error(message); };
        sb.Date = D;
      } });
    assert(early.res && typeof early.res.body === 'string', '必须回 JSON，不能不带参数地放行');
    let r = JSON.parse(early.res.body);
    assertEqual(early.calls.length, 0, '这个场景里错误发生在请求发出之前');
    assertEqual(r.ok, false); assertEqual(r.code, 'server', '用页面现成的「服务暂时不可用」结果卡');
    assert(/^script: boom /.test(r.detail), '错误原文放进「服务返回」那一行：' + r.detail.slice(0, 40));
    assertEqual(r.detail.length, 200, '截到 200 字');
    const leaked = (t) => [cand, candEnc, saved, secret.slice(0, 7)].filter((k) => t.includes(k));
    assertEqual(leaked(early.res.body).join(' '), '', '回话里密钥原文、编码后的密钥、像密钥的串都不能露，半截也不行');
    assert(logs.some((l) => l.includes('测试连接出错')), '日志里留一行，方便排查');
    assertEqual(leaked(logs.join('\n')).join(' '), '', '日志里同样不能露');
    // 拿到回复之后出错：状态码一读就出错
    const late = await panel({ url: U + '/api/test', method: 'POST', store: new Map(), config: TCFG,
      respond: () => ({ status: { valueOf() { throw new Error('boom after reply'); }, toString() { throw new Error('boom after reply'); } }, body: '{}' }) });
    assert(late.res && typeof late.res.body === 'string', '拿到回复之后出错也必须回 JSON');
    r = JSON.parse(late.res.body);
    assertEqual(late.calls.length, 1);
    assertEqual(r.code, 'server'); assert(/^script: boom after reply/.test(r.detail), r.detail);
    // 抛出的不是标准错误对象时，原文也要带出来
    const str = await panel({ url: U + '/api/test', method: 'POST', store: new Map(), config: TCFG, respond: echoLines,
      patch: (sb) => { class D extends Date {} D.now = () => { throw 'host said no'; }; sb.Date = D; } });
    assertEqual(JSON.parse(str.res.body).detail, 'script: host said no');
  });

  const codeOf = async (respond, extra) => {
    const store = (extra && extra.store) || new Map();
    const p = await panel(Object.assign({ url: U + '/api/test', method: 'POST', store, config: TCFG, respond }, extra || {}));
    return Object.assign(json(p), { _calls: p.calls, _store: store });
  };

  await check('失败分类：401（及明说鉴权的 403）→ key_invalid；402 与余额类错误 → balance；429 → rate_limited；404 → model_not_found；400 → bad_request；5xx → server', async () => {
    assertEqual((await codeOf(() => ({ status: 401, body: '{}' }))).code, 'key_invalid');
    assertEqual((await codeOf(() => ({ status: 403, body: '{"error":{"message":"Unauthorized"}}' }))).code, 'key_invalid', '403 且正文说是鉴权问题');
    assertEqual((await codeOf(() => ({ status: 402, body: '{"error":{"message":"Insufficient Balance"}}' }))).code, 'balance');
    assertEqual((await codeOf(() => ({ status: 429, body: '{"error":{"type":"insufficient_quota"}}' }))).code, 'balance', 'OpenAI 的额度用完是 429 + insufficient_quota');
    assertEqual((await codeOf(() => ({ status: 429, body: '{}' }))).code, 'rate_limited');
    const nf = await codeOf(() => ({ status: 404, body: '{"error":{"message":"model not found: m"}}' }));
    assertEqual(nf.code, 'model_not_found'); assertEqual(nf.http, 404); assert(nf.detail.includes('model not found'), '回显端点原话（脱敏、≤200 字）');
    assertEqual((await codeOf(() => ({ status: 400, body: '{"error":"bad temperature"}' }))).code, 'bad_request');
    assertEqual((await codeOf(() => ({ status: 503, body: 'busy' }))).code, 'server');
    assertEqual((await codeOf(() => okReply('', { error: { message: 'upstream failed' }, choices: undefined }))).code, 'server', '200 里夹 error');
    assertEqual((await codeOf(() => ({ error: 'The request timed out.' }))).code, 'timeout');
    assertEqual((await codeOf(() => ({ error: 'The Internet connection appears to be offline.' }))).code, 'network');
  });

  await check('模型名写错：服务商回 400 而不是 404 时，按正文判成「模型不存在」；同样提到 model 的其他 400 不误判', async () => {
    // DeepSeek 官方接口对不存在的模型名回 400，正文是这个形状
    const real = '{"error":{"message":"The supported API model names are deepseek-flash, deepseek-v4-pro, but you passed deepseek-flash-typo.","type":"invalid_request_error","param":null,"code":"invalid_request_error"}}';
    assertEqual((await codeOf(() => ({ status: 400, body: real }))).code, 'model_not_found');
    for (const body of ['{"error":{"message":"The model `foo` does not exist"}}', '{"error":{"code":"model_not_found"}}', '{"error":{"message":"模型不存在，请检查模型名称"}}', '{"message":"Unknown model: foo"}']) {
      assertEqual((await codeOf(() => ({ status: 400, body }))).code, 'model_not_found', body);
    }
    for (const body of ['{"error":{"message":"This model\'s maximum context length is 65536 tokens"}}', '{"error":{"message":"Invalid parameter: temperature must be between 0 and 2"}}',
      '{"error":{"message":"thinking is not supported by this model"}}', '{}']) {
      assertEqual((await codeOf(() => ({ status: 400, body }))).code, 'bad_request', '不该误判成模型不存在：' + body);
    }
    assertEqual((await codeOf(() => ({ status: 404, body: '{}' }))).code, 'model_not_found', '404 不看正文，直接判成模型不存在');
  });

  await check('思考没关：截断且无正文 / 只在 reasoning_content / 只在 reasoning / 计费里有思考 token → thinking_on', async () => {
    const lines12 = Array.from({ length: 12 }, (_, i) => (i + 1) + '|译文').join('\n');
    const mk = (msg, finish, usage) => () => ({ status: 200, body: JSON.stringify({ choices: [{ message: msg, finish_reason: finish }], usage }) });
    assertEqual((await codeOf(mk({ content: '' }, 'length'))).code, 'thinking_on');
    assertEqual((await codeOf(mk({ content: null, reasoning_content: lines12 }, 'stop'))).code, 'thinking_on');
    assertEqual((await codeOf(mk({ content: null, reasoning: lines12 }, 'stop'))).code, 'thinking_on', '只回 reasoning 字段的端点也判思考未关');
    const r = await codeOf(mk({ content: lines12 }, 'stop', { completion_tokens_details: { reasoning_tokens: 312 } }));
    assertEqual(r.code, 'thinking_on'); assertEqual(r.reasoningTokens, 312);
    assertEqual((await codeOf(mk({ content: '1|半截' }, 'length'))).code, 'truncated', '有正文的截断是 truncated');
    const f = await codeOf(mk({ content: '1|一\n2|二\n9|九' }, 'stop'));
    assertEqual(f.code, 'format', '行数不符'); assertEqual(f.lines.got, 3, '收到 3 行编号（尾号缺失整批判不合格）');
    const f2 = await codeOf(mk({ content: '完全没按格式' }, 'stop'));
    assertEqual(f2.code, 'format');
  });

  await check('候选密钥：key_invalid 不保存、原密钥保留；其他结果先保存；成功解除熔断与余额暂停', async () => {
    const store = withKey('deepseek', 'sk-old-000000000000');
    const conf = { baseUrl: 'https://api.example.com/v1', model: 'm' };
    let r = await codeOf(() => ({ status: 401, body: '{}' }), { store, config: conf, body: JSON.stringify({ key: 'sk-bad-000000000000' }) });
    assertEqual(r.code, 'key_invalid'); assertEqual(r.saved, false);
    assertEqual(r._calls[0].headers.Authorization, 'Bearer sk-bad-000000000000', '测的是候选密钥');
    assertEqual(store.get('llmsubs.key.deepseek'), 'sk-old-000000000000', '原密钥保留');
    r = await codeOf(() => ({ error: 'offline' }), { store, config: conf, body: JSON.stringify({ key: 'sk-net-000000000000' }) });
    assertEqual(r.code, 'network'); assertEqual(r.saved, true, '网络问题与密钥无关，先存下来');
    store.set('llmsubs.cb', JSON.stringify({ fails: 3, until: Date.now() + 60000, hardStop: true, fp: 'x', reason: 'auth', warn: { code: 'low_balance', at: Date.now() } }));
    store.set('llmsubs.pause', JSON.stringify({ until: Date.now() + 60000, code: 'balance' }));
    r = await codeOf(echoLines, { store, config: conf, body: JSON.stringify({ key: 'sk-good-00000000000' }) });
    assertEqual(r.code, 'ok'); assertEqual(r.saved, true); assertEqual(r.keys.deepseek.tail, '0000');
    assertEqual(store.get('llmsubs.key.deepseek'), 'sk-good-00000000000');
    const cb = JSON.parse(store.get('llmsubs.cb'));
    assert(!cb.fails && !cb.until && !cb.hardStop && cb.okFp && cb.warn, '清熔断与停用、写 okFp、保留余额偏低提示：' + JSON.stringify(cb));
    assert(!store.get('llmsubs.pause'), '余额暂停解除');
    assertEqual(r.status.code, 'ok');
    const bad = await codeOf(echoLines, { store, config: conf, body: JSON.stringify({ key: 'has space' }) });
    assertEqual(bad.code, 'key_format'); assertEqual(bad._calls.length, 0, '格式不对不发请求');
  });

  await check('测试连接的边角情况：早退带 saved:false；403 不一定是密钥问题；中文超时；先脱敏再截断；槽位不符不写密钥；适配失败不写 nosys', async () => {
    const s1 = new Map();
    await POST('/api/config', { mode: 'custom', custom: { provider: 'custom' } }, s1);
    let r = await POST('/api/test', { key: 'sk-cand-000000000000' }, s1);
    assertEqual(r.code, 'bad_url'); assertEqual(r.saved, false, '没发请求就返回时明确没存');
    r = await codeOf(() => ({ status: 403, body: '{"error":{"message":"Model access denied for this account"}}' }), { body: JSON.stringify({ key: 'sk-cand-111111111111' }) });
    assertEqual(r.code, 'bad_request', '模型没开通的 403 不是密钥无效'); assertEqual(r.saved, true, '候选密钥照常保存');
    r = await codeOf(() => ({ status: 403, body: '{"error":{"message":"Invalid API key provided"}}' }), { body: JSON.stringify({ key: 'sk-cand-222222222222' }) });
    assertEqual(r.code, 'key_invalid'); assertEqual(r.saved, false);
    assertEqual((await codeOf(() => ({ error: '请求超时。' }))).code, 'timeout');
    assertEqual((await codeOf(() => ({ error: 'Error Domain=NSURLErrorDomain Code=-1001' }))).code, 'timeout');
    const secret = 'ab+c/d=ef01234567890xyz';
    const enc = encodeURIComponent(secret);
    r = await codeOf(() => ({ status: 400, body: 'x'.repeat(190) + 'bad key ' + secret + ' and ' + enc }), { config: { baseUrl: 'https://api.example.com/v1', apiKey: secret, model: 'm' } });
    assert(!r.detail.includes(secret.slice(0, 10)) && !r.detail.includes(enc.slice(0, 10)), '截断处不能漏出半截密钥、URL 编码的回显也要遮：' + r.detail.slice(-40));
    const s2 = new Map();
    await POST('/api/config', { mode: 'custom', custom: { provider: 'kimi' } }, s2);
    const p = await panel({ url: U + '/api/test', method: 'POST', store: s2, body: JSON.stringify({ key: 'sk-cand-333333333333', slot: 'zhipu' }), respond: echoLines });
    assertEqual(json(p).code, 'bad_provider'); assertEqual(p.calls.length, 0); assert(!s2.get('llmsubs.key.kimi') && !s2.get('llmsubs.key.zhipu'), '槽位对不上不写任何密钥');
    const s3 = new Map();
    await codeOf(() => ({ status: 400, body: '{"error":{"message":"system role is not supported; also invalid temperature"}}' }), { store: s3 });
    assert(![...s3.keys()].some((k) => /^llmsubs\.nosys\./.test(k) && s3.get(k)), '改发纯数据仍被拒时不写 nosys（写了就清不掉）');
  });

  await check('测试通过但候选密钥没写进存储：报 write_failed 而不是 ok；不写 okFp、不清熔断与余额暂停', async () => {
    const store = new Map();
    store.set('llmsubs.cb', JSON.stringify({ fails: 2, until: Date.now() + 60000 }));
    store.set('llmsubs.pause', JSON.stringify({ until: Date.now() + 60000, code: 'balance' }));
    const realSet = store.set.bind(store);
    store.set = (k, v) => (k === 'llmsubs.key.deepseek' ? store : realSet(k, v));   // 密钥槽位写不进去
    const p = await panel({ url: U + '/api/test', method: 'POST', store, body: JSON.stringify({ key: 'sk-cand-444444444444', slot: 'deepseek' }), respond: echoLines });
    const r = json(p);
    assertEqual(p.calls.length, 1, '请求照常发出');
    assertEqual(r.code, 'write_failed'); assertEqual(r.ok, false); assertEqual(r.saved, false);
    assert(!store.get('llmsubs.key.deepseek'), '密钥确实没存下');
    const cb = JSON.parse(store.get('llmsubs.cb'));
    assert(!cb.okFp && cb.fails === 2 && cb.until, '密钥没落地就不能清熔断、不能写 okFp：' + JSON.stringify(cb));
    assert(store.get('llmsubs.pause'), '余额暂停也不清');
  });

  await check('detail 脱敏：Bearer 后面只遮令牌本身，紧凑 JSON 的后半段不能被吞掉', async () => {
    const key = 'sk-leak-me-123456';
    const r = await codeOf(() => ({ status: 400, body: '{"error":"bad request","echoHeader":"Bearer ' + key + '","tail":"after"}' }), { config: { baseUrl: 'https://api.example.com/v1', apiKey: key, model: 'm' } });
    assertEqual(r.code, 'bad_request');
    assert(!r.detail.includes(key), '密钥必须遮掉：' + r.detail);
    assert(r.detail.includes('"tail":"after"'), 'Bearer 之后的正文要保留：' + r.detail);
  });

  await check('公网明文 http → bad_url 零出站；局域网 http 不发密钥；缺密钥 → no_key 零出站', async () => {
    let p = await panel({ url: U + '/api/test', method: 'POST', store: new Map(), config: { baseUrl: 'http://api.example.com/v1', apiKey: 'k', model: 'm' } });
    assertEqual(json(p).code, 'bad_url'); assertEqual(p.calls.length, 0);
    p = await panel({ url: U + '/api/test', method: 'POST', store: new Map(), config: { baseUrl: 'http://192.168.1.10:11434/v1', apiKey: 'sk-should-not-leak', model: 'm' }, respond: echoLines });
    assertEqual(p.calls.length, 1, '局域网地址应当放行');
    assert(!JSON.stringify(p.calls[0]).includes('sk-should-not-leak'), 'key 不得以任何形式出现');
    p = await panel({ url: U + '/api/test', method: 'POST', store: new Map(), config: { baseUrl: 'https://api.example.com/v1', model: 'm' } });
    assertEqual(json(p).code, 'no_key'); assertEqual(p.calls.length, 0);
  });

  await check('端点不认 system 角色：自动改发纯数据并记住，结果注明已适配', async () => {
    const store = new Map();
    const r = await codeOf((o, n) => (n === 1 ? { status: 400, body: '{"error":{"message":"Role must be in [user, assistant]"}}' } : echoLines(o)), { store });
    assertEqual(r._calls.length, 2); assertEqual(r.code, 'ok'); assertEqual(r.noSystem, true);
    assertEqual(JSON.parse(r._calls[1].body).messages.length, 1);
    assert([...store.keys()].some((k) => /^llmsubs\.nosys\./.test(k)), '结论写下来给翻译角色复用');
  });

  await check('报错里的密钥被脱敏', async () => {
    const store = new Map();
    const conf = { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-leak-me-123456', model: 'm' };
    const { res } = await panel({ url: U + '/api/test', method: 'POST', store, config: conf, respond: () => ({ status: 500, body: 'failed with Authorization: Bearer sk-leak-me-123456' }) });
    assert(!res.body.includes('sk-leak-me-123456'), '报错信息必须脱敏');
  });

  section('状态条、恢复翻译、清除译文');

  await check('状态优先级：off > setup > paused_auth / rejected > paused_balance > paused_errors > ok；余额偏低 24 小时内附加', async () => {
    const conf = { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-test-key-abcdef', model: 'm' };
    const store = new Map();
    let s = (await GET('/api/config', store, { config: conf })).status;
    assertEqual(s.code, 'ok'); assertEqual(s.lastAt, null); assertEqual(s.warn, null);
    // 401 → 停用（指纹匹配才算）
    await translate({ url: SUB1, body: oneLine(), store, config: conf, respond: () => ({ status: 401, body: '{}' }) });
    assertEqual(JSON.parse(store.get('llmsubs.cb')).reason, 'auth', 'cb.reason 是分类码');
    s = (await GET('/api/config', store, { config: conf })).status;
    assertEqual(s.code, 'paused_auth');
    // 遗留的中文 reason 也认
    const cb = JSON.parse(store.get('llmsubs.cb')); cb.reason = '鉴权失败 401'; store.set('llmsubs.cb', JSON.stringify(cb));
    assertEqual((await GET('/api/config', store, { config: conf })).status.code, 'paused_auth');
    cb.reason = 'rejected'; store.set('llmsubs.cb', JSON.stringify(cb));
    assertEqual((await GET('/api/config', store, { config: conf })).status.code, 'paused_rejected');
    // 换了配置（指纹变了）就不再显示停用
    assertEqual((await GET('/api/config', store, { config: Object.assign({}, conf, { apiKey: 'sk-other-key-abcdef' }) })).status.code, 'ok');
    // 关闭优先于一切
    await POST('/api/config', { enabled: false }, store, { config: conf });
    assertEqual((await GET('/api/config', store, { config: conf })).status.code, 'off');
    await POST('/api/config', { enabled: true }, store, { config: conf });
    store.set('llmsubs.cb', JSON.stringify({ until: Date.now() + 150000, warn: { code: 'low_balance', at: Date.now() - 3600000 } }));
    s = (await GET('/api/config', store, { config: conf })).status;
    assertEqual(s.code, 'paused_errors'); assertEqual(s.p.min, 3); assertEqual(s.warn, 'low_balance');
    store.set('llmsubs.pause', JSON.stringify({ until: Date.now() + 25 * 60000, code: 'balance' }));
    s = (await GET('/api/config', store, { config: conf })).status;
    assertEqual(s.code, 'paused_balance', '余额暂停优先于熔断'); assertEqual(s.p.min, 25);
    store.set('llmsubs.cb', JSON.stringify({ warn: { code: 'low_balance', at: Date.now() - 25 * 3600000 } }));
    store.set('llmsubs.pause', '');
    s = (await GET('/api/config', store, { config: conf })).status;
    assertEqual(s.code, 'ok'); assertEqual(s.warn, null, '余额偏低提示 24 小时后消失');
  });

  await check('「最近一次翻译」last：探针关闭也写、不含任何内容；早退与 cron 不写', async () => {
    const store = withKey();
    await translate({ url: SUB1, body: oneLine(), store, config: { probe: false } });
    const last = JSON.parse(store.get('llmsubs.last'));
    assertEqual(Object.keys(last).sort().join(','), 'at,ok', '只有时间与成败');
    assertEqual(last.ok, true);
    assertEqual((await GET('/api/config', store)).status.lastAt, last.at);
    const s2 = withKey();
    await POST('/api/config', { enabled: false }, s2);
    await translate({ url: SUB1, body: oneLine(), store: s2 });
    assert(!s2.get('llmsubs.last'), '早退放行不写');
    const s3 = withKey();
    await translate({ cron: true, store: s3 });
    assert(!s3.get('llmsubs.last'), 'cron 不写');
  });

  await check('恢复翻译：清熔断、停用与余额暂停，保留 okFp 与余额偏低提示', async () => {
    const store = withKey();
    store.set('llmsubs.cb', JSON.stringify({ fails: 2, until: Date.now() + 60000, hardStop: true, fp: 'x', reason: 'errors', okFp: 'keepme', warn: { code: 'low_balance', at: Date.now() } }));
    store.set('llmsubs.pause', JSON.stringify({ until: Date.now() + 60000, code: 'balance' }));
    const r = await POST('/api/resume', {}, store);
    assertEqual(r.ok, true); assertEqual(r.status.code, 'ok');
    const cb = JSON.parse(store.get('llmsubs.cb'));
    assertEqual(JSON.stringify(Object.keys(cb).sort()), JSON.stringify(['okFp', 'warn']));
    assert(!store.get('llmsubs.pause'));
  });

  await check('清除已保存的译文：只清缓存条目、索引与待翻译队列；熔断、降档、配置都不动', async () => {
    const store = new Map();
    store.set('llmsubs.cache.idx', JSON.stringify([{ k: 'aaa' }])); store.set('llmsubs.c.aaa', 'cached');
    store.set('llmsubs.bfq', JSON.stringify([{ h: 'hh', n: 1 }])); store.set('llmsubs.bf.hh', '{}');
    store.set('llmsubs.cb', '{"okFp":"x"}'); store.set('llmsubs.fcb', '{"eff":8}'); store.set('llmsubs.cfg4', cfg4({ position: 'above' }));
    const r = await POST('/api/cache/clear', {}, store);
    assertEqual(r.ok, true);
    for (const k of ['cache.idx', 'c.aaa', 'bfq', 'bf.hh']) assert(!store.get('llmsubs.' + k), k + ' 应当被清');
    for (const k of ['cb', 'fcb', 'cfg4']) assert(store.get('llmsubs.' + k), k + ' 不该被动');
  });

  section('缺密钥守卫与余额暂停（运行时）');

  await check('全新设备、空存储：零出站，发一条「尚未完成设置」通知（写明面板地址，每小时最多一条）', async () => {
    const store = new Map();
    const r = await translate({ url: SUB1, body: j3([{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'hello world here' }] }]), store, config: { probe: true } });
    assertEqual(r.calls.length, 0, '没有密钥一条请求都不发');
    assertEqual(r.result, undefined, '原样放行');
    assertEqual(r.notifications.length, 1);
    assertEqual(r.notifications[0].t, 'SubsPair 尚未完成设置');
    assert(r.notifications[0].b.includes('https://subs.test/') && r.notifications[0].b.includes('DeepSeek'), r.notifications[0].b);
    assertEqual(store.get('llmsubs.stat.started'), '1', '运行计数照常');
    const again = await translate({ url: SUB1, body: oneLine(), store });
    assertEqual(again.notifications.length, 0, '一小时内不重复通知');
    // 界面语言是英文时通知也是英文；自定义模式不提 DeepSeek
    const s2 = new Map();
    await POST('/api/config', { uiLang: 'en', mode: 'custom' }, s2);
    const en = await translate({ url: SUB1, body: oneLine(), store: s2 });
    assert(/setup required/i.test(en.notifications[0].t) && !/DeepSeek/.test(en.notifications[0].b), JSON.stringify(en.notifications));
  });

  await check('cron 在缺密钥时零出站，运行计数照常；密钥在、地址却换了主机时同样零出站', async () => {
    const model = (PANEL.match(/\n\s*model:\s*'([^']+)'/) || [])[1];
    // 往待翻队列里放一条轨。记录的版本与模型名要对得上当前脚本，否则它会被当成旧记录丢掉，那样无论有没有密钥都是零出站
    const queued = (store) => {
      store.set('llmsubs.bfq', JSON.stringify([{ h: 'aabbccdd', at: Date.now(), n: 1 }]));
      store.set('llmsubs.bf.aabbccdd', JSON.stringify({ v: VER, h: 'aabbccdd', at: Date.now(), kind: 'asr', dom: '', mdl: model, n: 1, fail: 0, items: [{ t: ['hello there my friend'], c: [] }] }));
      return store;
    };
    let r = await translate({ cron: true, store: queued(withKey()) });
    assert(r.calls.length > 0 && r.calls[0].headers.Authorization, '前提：有密钥时 cron 确实会翻队列里这条轨（否则下面的零出站什么都证明不了）');
    r = await translate({ cron: true, store: queued(new Map()) });
    assertEqual(r.calls.length, 0, '缺密钥时 cron 零出站');
    assertEqual(r.store.get('llmsubs.cron.n'), '1', '运行计数照常');
    const moved = withKey();
    await POST('/api/config', { mode: 'custom', custom: { provider: 'deepseek', ep: { deepseek: { url: 'https://collector.example.com/v1' } } } }, moved);
    r = await translate({ cron: true, store: queued(moved) });
    assertEqual(r.calls.length, 0, '密钥是给官方主机存的，地址换了主机后 cron 也不带着它出站');
  });

  await check('余额不足（402）：写 pause、不计熔断、停止派发；暂停期间零出站；状态与通知说清楚', async () => {
    const store = withKey();
    const evs = []; for (let i = 0; i < 60; i++) evs.push({ tStartMs: i * 2000, dDurationMs: 1500, segs: [{ utf8: 'balance line ' + i }] });
    const r = await translate({ url: SUB1, body: j3(evs), store, config: { chunkSize: 10, fastConcurrency: 1 }, respond: () => ({ status: 402, body: '{"error":{"message":"Insufficient Balance"}}' }) });
    assertEqual(r.calls.length, 1, '撞上余额不足就停手，不再派发');
    const pz = JSON.parse(store.get('llmsubs.pause'));
    assertEqual(pz.code, 'balance'); assert(pz.until - Date.now() > 29 * 60000, '暂停 30 分钟');
    const cb = JSON.parse(store.get('llmsubs.cb') || '{}');
    assert(!cb.fails && !cb.until && !cb.hardStop, '余额不足不是端点故障：' + JSON.stringify(cb));
    assert(r.notifications.some((n) => n.t === 'SubsPair 已暂停' && /余额不足/.test(n.b)), JSON.stringify(r.notifications));
    assertEqual((await GET('/api/config', store)).status.code, 'paused_balance');
    const again = await translate({ url: SUB1, body: oneLine('another'), store });
    assertEqual(again.calls.length, 0, '暂停期间零出站');
    // 到期后的第一次运行只派一路探路；探路成功删掉记录，下一次恢复正常并发
    const pz2 = JSON.parse(store.get('llmsubs.pause')); pz2.until = Date.now() - 1; store.set('llmsubs.pause', JSON.stringify(pz2));
    await translate({ url: SUB1, body: j3(evs.map((e) => Object.assign({}, e, { segs: [{ utf8: 'probe ' + e.segs[0].utf8 }] }))), store, config: { probe: true, chunkSize: 10, fastConcurrency: 8 } });
    const dl = JSON.parse(store.get('llmsubs.diag')).slice(-1)[0];
    assertEqual(dl.chunks.wave, 1, '到期后先探一路，不是一整波');
    assert(!store.get('llmsubs.pause'), '探路成功，暂停记录删除');
  });

  await check('暂停到期的探路轮撞 429 不写降档记录（波宽 1 是人为压的，不是端点承受力）；无暂停时同样的 429 照常降档', async () => {
    const evs = []; for (let i = 0; i < 60; i++) evs.push({ tStartMs: i * 2000, dDurationMs: 1500, segs: [{ utf8: 'probe line ' + i }] });
    const r429 = () => ({ status: 429, body: '{"error":{"message":"slow down"}}' });
    const s1 = withKey();
    await translate({ url: SUB1, body: oneLine('first'), store: s1, config: { fastConcurrency: 8 }, respond: () => ({ status: 402, body: '{}' }) });
    const pz = JSON.parse(s1.get('llmsubs.pause')); pz.until = Date.now() - 1; s1.set('llmsubs.pause', JSON.stringify(pz));
    await translate({ url: SUB1, body: j3(evs), store: s1, config: { probe: true, chunkSize: 10, fastConcurrency: 8 }, respond: r429 });
    assertEqual(JSON.parse(s1.get('llmsubs.diag')).slice(-1)[0].chunks.wave, 1, '到期后先探一路');
    assert(!s1.get('llmsubs.fcb'), '探路轮的 429 不能把有效并发钉死在 1：' + s1.get('llmsubs.fcb'));
    assert(s1.get('llmsubs.pause'), '探路没成功，暂停记录保留');
    const s2 = withKey();
    await translate({ url: SUB1, body: j3(evs), store: s2, config: { chunkSize: 10, fastConcurrency: 8 }, respond: r429 });
    const fcb = JSON.parse(s2.get('llmsubs.fcb') || 'null');
    assert(fcb && fcb.eff > 1 && fcb.eff < 8, '对照组：正常波宽撞 429 照常降一档：' + JSON.stringify(fcb));
  });

  await check('余额判定收窄：400 正文里回显的余额字样不触发暂停；暂停跟着账户走，换密钥即不再拦截', async () => {
    const s1 = withKey();
    await translate({ url: SUB1, body: oneLine('insufficient funds in the account'), store: s1, respond: () => ({ status: 400, body: '{"error":{"message":"Input data may contain inappropriate content: insufficient funds in the account"}}' }) });
    assert(!s1.get('llmsubs.pause'), '400 回显的正文不能判成余额不足');
    const s2 = withKey('deepseek', 'sk-first-account-000');
    await translate({ url: SUB1, body: oneLine(), store: s2, respond: () => ({ status: 402, body: '{}' }) });
    assertEqual((await GET('/api/config', s2)).status.code, 'paused_balance');
    await POST('/api/key', { provider: 'deepseek', key: 'sk-second-account-00' }, s2);
    assertEqual((await GET('/api/config', s2)).status.code, 'ok', '换了密钥（账户），旧账户的暂停不拦新账户');
    const t = await translate({ url: SUB1, body: oneLine('new account line'), store: s2 });
    assert(t.calls.length > 0, '换密钥后照常翻译');
  });

  await check('解除暂停只解除本账户：换密钥后测试成功 / 点恢复都不抹掉旧账户的暂停记录；换回去仍在暂停；本账户点恢复才清', async () => {
    const store = withKey('deepseek', 'sk-first-account-000');
    await translate({ url: SUB1, body: oneLine(), store, respond: () => ({ status: 402, body: '{}' }) });
    const pz = store.get('llmsubs.pause'); assert(pz, '先制造 A 账户的暂停');
    await POST('/api/key', { provider: 'deepseek', key: 'sk-second-account-00' }, store);
    let p = await panel({ url: U + '/api/test', method: 'POST', store, body: '{}', respond: echoLines });
    assertEqual(json(p).code, 'ok'); assertEqual(store.get('llmsubs.pause'), pz, 'B 账户测试成功不动 A 的暂停');
    let r = await POST('/api/resume', {}, store);
    assertEqual(r.ok, true); assertEqual(store.get('llmsubs.pause'), pz, 'B 账户点恢复也不动 A 的暂停');
    await POST('/api/key', { provider: 'deepseek', key: 'sk-first-account-000' }, store);
    assertEqual((await GET('/api/config', store)).status.code, 'paused_balance', '换回 A：暂停仍在');
    r = await POST('/api/resume', {}, store);
    assertEqual(r.ok, true); assert(!store.get('llmsubs.pause'), 'A 自己点恢复才清');
  });

  await check('限流里带余额信号（429 + remaining balance）：照常降档，并写一次「余额偏低」提示', async () => {
    const store = withKey();
    const r = await translate({ url: SUB1, body: oneLine(), store, respond: () => ({ status: 429, body: '{"error":{"message":"Rate limited by remaining balance"}}' }) });
    assert(r.calls.length >= 1);
    const cb = JSON.parse(store.get('llmsubs.cb') || '{}');
    assertEqual(cb.warn && cb.warn.code, 'low_balance');
    const st = (await GET('/api/config', store)).status;
    assertEqual(st.warn, 'low_balance'); assertEqual(st.code, 'ok');
  });

  section('诊断数据');

  await check('GET /api/diag 带出观察者记录、记录、环境、被掐断计数、余额暂停、最近一次翻译与首次打开时刻', async () => {
    const store = new Map();
    store.set('llmsubs.obs', JSON.stringify([{ host: '*.googlevideo.com', path: '/videoplayback', val: { mime: 'text/vtt' }, n: 4 }]));
    store.set('llmsubs.diag', JSON.stringify([{ outcome: 'replaced' }]));
    store.set('llmsubs.env', JSON.stringify({ rocket: 'object' }));
    store.set('llmsubs.stat.started', '7'); store.set('llmsubs.stat.finished', '5');
    store.set('llmsubs.pause', '{"until":5,"code":"balance"}'); store.set('llmsubs.last', '{"at":9,"ok":true}'); store.set('llmsubs.panel.first', '123');
    store.set('llmsubs.cache.idx', JSON.stringify([{ k: 'a' }, { k: 'b' }, { k: 'c' }]));
    const d = await GET('/api/diag', store);
    assertEqual(d.ok, true);
    assertEqual(d.obs[0].val.mime, 'text/vtt'); assertEqual(d.records.length, 1); assertEqual(d.env.rocket, 'object');
    assertEqual(d.started - d.finished, 2, '差值就是被引擎掐断的次数');
    assertEqual(d.pause.code, 'balance'); assertEqual(d.last.at, 9); assertEqual(d.panelFirstAt, 123); assertEqual(d.cacheEntries, 3);
  });

  await check('诊断不带字幕正文：XML 骨架只留标签——截断点落在句子中间、正文包在 CDATA 里、正文出现在第一个标签之前，都不带出一个字', async () => {
    const head = '<?xml version="1.0" encoding="utf-8" ?><timedtext format="3"><body>';
    const tail = '<p t="9000" d="1500">tail line here</p></body></timedtext>';
    const cases = {
      '第 400 个字符落在文本节点中间': head + '<p t="0" d="1500">' + 'ZEBRAWORD '.repeat(80) + '</p>' + tail,
      '第 2000 个字符落在文本节点中间': head + '<p t="0" d="1500">' + 'ZEBRAWORD '.repeat(260) + '</p>' + tail,
      '正文包在 CDATA 里': head + '<p t="0" d="1500"><![CDATA[ZEBRAWORD inside cdata]]></p>' + tail,
    };
    assert(cases['第 2000 个字符落在文本节点中间'].length > 2000 && !cases['第 2000 个字符落在文本节点中间'].slice(1990, 2010).includes('<'), '前置条件：第 2000 个字符确实在句子中间');
    for (const [name, body] of Object.entries(cases)) {
      const store = withKey();
      await translate({ url: 'https://www.youtube.com/api/timedtext?v=abc&lang=en&format=srv3', body, store, config: { probe: true } });
      const rec = JSON.parse(store.get('llmsubs.diag')).slice(-1)[0];
      assert(rec.sub && typeof rec.sub.skeleton === 'string' && rec.sub.skeleton.length > 0, name + '：应当记下骨架：' + JSON.stringify(rec.sub));
      assert(!/ZEBRA|tail line|cdata/i.test(rec.sub.skeleton), name + '：骨架里不得有字幕正文：' + rec.sub.skeleton.slice(0, 160));
      assert(rec.sub.skeleton.includes('<p t="0" d="1500">') && rec.sub.skeleton.includes('·'), name + '：结构仍然看得见：' + rec.sub.skeleton.slice(0, 160));
      assert(rec.sub.skeleton.length <= 400, name + '：长度封顶');
    }
  });

  await check('复制诊断：漏行场景里记下的模型原话与送翻原文不出现在复制内容里；自定义接口的主机名不带，官方的保留', async () => {
    const store = withKey();
    const evs = []; for (let i = 0; i < 6; i++) evs.push({ tStartMs: i * 2000, dDurationMs: 1500, segs: [{ utf8: 'walrus sentence number ' + i }] });
    // 少回最后一行：硬失败 mmTail，诊断里会记 mmRaw / mmSrc
    await translate({ url: SUB1, body: j3(evs), store, config: { probe: true, chunkSize: 6, fastConcurrency: 1 },
      respond: (o) => { const n = JSON.parse(o.body).messages.slice(-1)[0].content.match(/<<<SUBS\n([\s\S]*)\nSUBS>>>/)[1].split('\n').length;
        const out = []; for (let i = 1; i < n; i++) out.push(i + '|海象译文' + i); return okReply(out.join('\n')); } });
    const d = await GET('/api/diag', store);
    const raw = JSON.stringify(d);
    assert(/walrus sentence/.test(raw) && /海象译文/.test(raw), '前置条件：服务端的诊断里确实记了这两段（探针开着时供排查用）');
    const sb = pageSandbox();
    const copied = JSON.stringify(sb.diagForCopy(d));
    assert(!/walrus/.test(copied) && !/海象/.test(copied), '复制出去的内容不得带字幕原文与模型原话');
    assert(/"mmSeen"/.test(copied) && /"countMismatch"/.test(copied), '排查用的计数照常保留');
    assert(/walrus sentence/.test(JSON.stringify(d)), 'diagForCopy 不得改动传入的对象（页面上的技术详情仍显示完整内容）');
    const fake = { ok: true, records: [{ llm: { host: 'llm.example.net', model: 'm' } }, { llm: { host: 'api.deepseek.com', model: 'deepseek-flash' } }, null] };
    const c2 = sb.diagForCopy(fake);
    assertEqual(c2.records[0].llm.host, '(hidden)'); assertEqual(c2.records[1].llm.host, 'api.deepseek.com'); assertEqual(fake.records[0].llm.host, 'llm.example.net');
    const envd = sb.diagForCopy({ ok: true, records: [], env: { rocketKeys: 'a,b', rocketDump: '{"secretish":1}', envDump: '{"x":2}', doneType: 'function' } });
    assert(!('rocketDump' in envd.env) && !('envDump' in envd.env) && envd.env.rocketKeys === 'a,b' && envd.env.doneType === 'function', '运行时对象的原样转储不往外带，键名与类型照常保留：' + JSON.stringify(envd.env));
    // 两条复制路径都要走过滤
    const texts = []; sb.copyText = (t) => texts.push(t); sb.toast = () => {};
    sb.S.diag = d; sb.api = { diag: () => Promise.resolve(d) };
    sb.doCopyDiag();
    sb.S.diag = null; sb.doCopyDiag();
    await new Promise((r) => setTimeout(r, 20));
    assertEqual(texts.length, 2, '手上有诊断时同步复制；没有时取回再复制');
    assert(texts.every((t) => !/walrus|海象/.test(t)), '两条路径都不得带出正文');
  });


  await check('复制诊断：由视频编号推出来的编号换成本次复制里的代号，算不回是哪个视频；同一个视频还是同一个代号', async () => {
    const store = withKey();
    const evs = []; for (let i = 0; i < 60; i++) evs.push({ tStartMs: i * 2000, dDurationMs: 1500, segs: [{ utf8: 'harbor line ' + i }] });
    const echo = (o) => { const n = JSON.parse(o.body).messages.slice(-1)[0].content.match(/<<<SUBS\n([\s\S]*)\nSUBS>>>/)[1].split('\n').length;
      const out = []; for (let i = 1; i <= n; i++) out.push(i + '|港口' + i); return okReply(out.join('\n')); };
    // 首波只发一批，剩下的进待翻队列：诊断里就同时有待翻队列、运行记录、请求日志三处编号
    await translate({ url: SUB1, body: j3(evs), store, config: { probe: true, chunkSize: 5, fastConcurrency: 1 }, respond: echo });
    const vHash = fnv1a('abc'), tHash = fnv1a(['abc', 'en', '', '', 'json3'].join('|'));
    // 一次前台翻译碰不到的几处，按脚本写入的形状放进存储：cron 环、播放统计、被掐死与在途的运行、三类配置指纹
    store.set('llmsubs.cron', JSON.stringify([{ at: new Date().toISOString(), h: tHash, vh: vHash, todo: 3 }]));
    store.set('llmsubs.pings', JSON.stringify([{ at: new Date().toISOString(), host: 'm', kind: 'playback', h: vHash, cmt: 12.5 }]));
    store.set('llmsubs.killed', JSON.stringify([{ id: 'r1', stage: 'parsed', h: 'm', vh: vHash, at: Date.now() - 90000 }]));
    store.set('llmsubs.inflight', JSON.stringify([{ id: 'r2', stage: 'translating', h: 'www', vh: vHash, at: Date.now() }]));
    store.set('llmsubs.cb', JSON.stringify({ okFp: '5eed0001', fp: '5eed0001' }));
    store.set('llmsubs.pause', JSON.stringify({ until: Date.now() + 60000, code: 'balance', ns: '5eed0002' }));
    store.set('llmsubs.fcb', JSON.stringify({ eff: 32, clean: 0, t: Date.now(), cap: 96, ns: '5eed0003' }));
    const d = await GET('/api/diag', store);
    // 前提：服务端诊断里真有这些编号，而且拿视频编号一算就能对上——这正是复制时要挡住的
    assert(d.backfill.length > 0 && d.backfill[0].h === tHash, '前提：待翻队列里的轨编号就是视频编号算出来的：' + JSON.stringify(d.backfill));
    assert(d.records.some((r) => r.q && r.q.vHash === vHash), '前提：运行记录里有视频编号算出来的哈希');
    assert(d.reqlog.some((e) => e.h === vHash && e.tk === tHash.slice(0, 4)), '前提：请求日志里有视频哈希与轨哈希前缀');
    const sb = pageSandbox();
    const c = sb.diagForCopy(d), copied = JSON.stringify(c);
    assert(!copied.includes(vHash) && !copied.includes(tHash) && !copied.includes('"' + tHash.slice(0, 4) + '"'), '复制出去的内容里不得出现能用视频编号算出来的编号');
    assertEqual(c.backfill[0].h, 't1', '待翻队列的轨编号换成代号');
    assert(c.records.filter((r) => r.q && r.q.vHash).every((r) => r.q.vHash === 'v1'), '同一个视频的运行记录都是同一个代号');
    assert(c.reqlog.filter((e) => e.h).every((e) => e.h === 'v1' && e.tk === 't1'), '请求日志里的视频与轨前缀对上同一个代号：' + JSON.stringify(c.reqlog));
    assertEqual(c.cron[0].h + '/' + c.cron[0].vh, 't1/v1', 'cron 环的轨与视频对上同一组代号');
    assertEqual(c.pings[0].h, 'v1', '播放统计里的视频编号与字幕请求是同一个视频');
    assertEqual(c.killed[0].vh + '/' + c.inflight[0].vh, 'v1/v1', '被掐死与在途的运行也换成代号');
    assertEqual(c.killed[0].h, 'm', '这两处的 h 是主机标签，不是哈希，原样保留');
    for (const fp of ['5eed0001', '5eed0002', '5eed0003']) assert(!copied.includes(fp), '配置指纹不原样带出：' + fp);
    assert(/^c\d+$/.test(c.circuit.okFp) && c.circuit.okFp === c.circuit.fp, '熔断记录的两个指纹换成代号，相等关系保留');
    assert(/^k\d+$/.test(c.pause.ns) && /^e\d+$/.test(c.fcb.ns), '余额暂停与降档记录的指纹换成代号');
    assertEqual(d.backfill[0].h, tHash, 'diagForCopy 不得改动传入的对象（页面上的技术详情仍显示完整内容）');
    // 不同的视频拿到不同的代号；只留了前缀的轨编号对上完整编号的代号
    const f = sb.diagForCopy({ ok: true, backfill: [{ h: 'aaaa1111', n: 3 }, { h: 'bbbb2222', n: 1 }, { h: 'aaaa1111', n: 2 }], reqlog: [{ h: 'x1', tk: 'bbbb' }, { h: 'x2', tk: 'cccc' }] });
    assertEqual(f.backfill.map((e) => e.h).join(','), 't1,t2,t1');
    assertEqual(f.reqlog.map((e) => e.h + '/' + e.tk).join(','), 'v1/t2,v2/t3');
    // 两条完整轨前缀相同时，只有前缀的那一行不能被说成其中任何一条
    const g = sb.diagForCopy({ ok: true, backfill: [{ h: 'ab12aaaa' }, { h: 'ab12bbbb' }], reqlog: [{ h: 'x', tk: 'ab12' }] });
    assert(!['t1', 't2'].includes(g.reqlog[0].tk), '前缀对上不止一条完整轨时单独编号：' + g.reqlog[0].tk);
    // 问题模板与面板提示说法一致
    const tpl = fs.readFileSync(path.join(ROOT, '.github', 'ISSUE_TEMPLATE', 'bug_report.md'), 'utf8');
    assert(tpl.includes('代号') && tpl.includes('使用时间') && !tpl.includes('视频 ID'), '问题模板要照实写：视频只用代号、带有使用时间');
  });
  await check('POST /api/diag/clear 清空诊断数据与观察者记录，不动运行状态', async () => {
    const store = new Map();
    store.set('llmsubs.diag', '[{}]'); store.set('llmsubs.obs', '[{}]'); store.set('llmsubs.stat.started', '3');
    store.set('llmsubs.reqlog', '[1]'); store.set('llmsubs.pings', '[2]'); store.set('llmsubs.seen', '[3]'); store.set('llmsubs.killed', '[4]'); store.set('llmsubs.inflight', '[5]');
    store.set('llmsubs.fcb', '{"eff":32}');
    const r = await POST('/api/diag/clear', {}, store);
    assertEqual(r.ok, true);
    for (const k of ['diag', 'obs', 'stat.started', 'reqlog', 'pings', 'seen', 'killed', 'inflight']) assert(!store.get('llmsubs.' + k), k + ' 应当被清');
    assert(store.get('llmsubs.fcb'), 'fcb 是运行状态不是诊断');
  });

  await check(DEV_BUILD ? '开发版：探针默认开着，运行一次就有诊断数据可看；诊断里不含密钥'
                        : '公开版：探针默认关着，照常翻译，但不写诊断记录与运行计数', async () => {
    const store = withKey('deepseek', 'sk-diag-000000000000');
    const r = await translate({ url: 'https://www.youtube.com/api/timedtext?v=abc&lang=en&format=srv3', body: oneLine(), store });
    if (!DEV_BUILD) {
      assert(r.calls.length >= 1 && r.result && typeof r.result.body === 'string', '公开版探针关着也要照常翻译（这条不能是空跑）');
      // 版本章 diagver 不算诊断数据：探针关着也要盖，否则 cron 会把前台刚排的队列当旧版本清掉
      for (const k of store.keys()) assert(k === 'llmsubs.diagver' || (!k.startsWith('llmsubs.diag') && !k.startsWith('llmsubs.stat')), '公开版探针关着，不该写 ' + k);
      return;
    }
    assertEqual(store.get('llmsubs.stat.started'), '1');
    const d = await GET('/api/diag', store);
    assertEqual(d.records.length, 1); assertEqual(d.started, 1);
    assert(!JSON.stringify(d).includes('sk-'), '诊断数据里不得出现密钥');
  });

  section('配置不可被外部覆盖、跨文件不变量');

  await check('【回归】模块参数里的 false 杀不掉可用配置', async () => {
    const { calls } = await translate({ url: SUB1, body: oneLine(), store: withKey(), argument: 'enabled=false&baseUrl=&apiKey=&model=&targetLang=&probe=false' });
    assert(calls.length > 0, '模块参数不该能关掉功能');
  });

  await check('【回归】模块文件里没有会盖掉配置的传参声明', async () => {
    const mod = fs.readFileSync(path.join(ROOT, 'SubsPair.sgmodule'), 'utf8');
    const code = mod.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    assert(!/#!arguments=/.test(code), '模块不声明 #!arguments');
    assert(!/\bargument=/.test(code), '[Script] 行不传 argument');
  });

  await check('模块与脚本的跨文件不变量：max-size ↔ BODY_MAX、pattern ↔ MITM ↔ TIMEDTEXT_RE、版本号', async () => {
    const mod = fs.readFileSync(path.join(ROOT, 'SubsPair.sgmodule'), 'utf8');
    const maxSize = mod.match(/\bmax-size=(\d+)/);
    const bodyMax = PANEL.match(/\bvar BODY_MAX = (\d+)/);
    assert(maxSize && bodyMax, '两处都应能提取到');
    assertEqual(bodyMax[1], maxSize[1], '脚本 BODY_MAX 必须与模块 max-size 同值');
    const obsLines = mod.split('\n').filter((l) => /^#?\s*SubsPair\.Observe/.test(l));
    if (DEV_BUILD) assert(obsLines.length >= 1, '开发版应当保留 m.youtube 观察者');
    else assertEqual(obsLines.length, 0, '公开版不带观察者');
    for (const l of obsLines) {
      assert(/requires-body=false/.test(l), '观察者绝不能读 body：' + l.slice(0, 40));
      assert(!/max-size/.test(l), '观察者不该声明 max-size');
    }
    assert(!/SubsPair\.Observe(Hls)?\s*=[^\n]*googlevideo/.test(mod), '模块里不该有 googlevideo 的观察者：字幕正文不从这个域名出');
    assert(!/^\s*AND,\(\(PROTOCOL,UDP\)[^\n]*googlevideo/m.test(mod), '模块里不该有针对 googlevideo 的 QUIC 拒绝规则：只需要拒绝 youtube.com 的');
    const scriptLines = mod.split('\n').filter((l) => /^#?\s*SubsPair\.\w+ = /.test(l));
    assert(scriptLines.length >= 2, '应当能提取到 [Script] 行');
    for (const l of scriptLines) {
      const pat = (l.match(/pattern=([^,]*)/) || [])[1] || '';
      assert(pat.indexOf(' ') < 0, 'pattern 里不得有裸空格：' + l.slice(0, 60));
    }
    const modVer = mod.match(/^#!version=(.+)$/m);
    assertEqual(VER, modVer[1].trim(), '脚本 SCRIPT_VER 必须与模块 #!version 同值');
    const modCode = mod.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    const pat = modCode.match(/SubsPair\.Translate\s*=.*?pattern=([^,]+),/);
    const normalized = pat[1].replace(/\\(.)/g, '$1');
    const hostAlt = normalized.match(/\(([a-z|]+)\)\.youtube\.com|:\/\/([a-z]+)\.youtube\.com/);
    const hosts = (hostAlt[1] || hostAlt[2]).split('|');
    const mitm = (modCode.match(/^hostname\s*=\s*(.+)$/m) || [])[1] || '';
    for (const h of hosts) assert(mitm.includes(h + '.youtube.com'), 'pattern 声称处理 ' + h + '.youtube.com，但 [MITM] 没有解密它');
    const reCopies = PANEL.split('\n').filter((l) => l.includes('TIMEDTEXT_RE = /'));
    assert(reCopies.length >= 1);
    for (const c of reCopies) for (const h of hosts) assert(c.includes(h), 'TIMEDTEXT_RE 副本缺少主机 ' + h);
    // 面板那一行的 timeout：要放得下测试连接的最长时间（整体上限再留余量）
    const panelLine = mod.split('\n').find((l) => /^SubsPair\.Panel = /.test(l));
    const panelTimeout = parseInt((panelLine.match(/timeout=(\d+)/) || [])[1], 10);
    const testMax = parseInt((PANEL.match(/var TEST_TIMEOUT_S = (\d+)/) || [])[1], 10);
    assert(testMax > 0 && testMax <= 10, '测试连接整体最多等 10 秒：' + testMax);
    assert(panelTimeout >= testMax + 5, '面板脚本 timeout 要放得下测试连接的最长时间（' + testMax + ' 秒加兜底与余量）：' + panelLine);
    // 页面等测试结果的时间：比脚本的上限长（否则脚本还没判完页面先放弃），比模块的 timeout 短
    const pageWait = parseInt((PANEL.match(/jfetch\('\/api\/test', o \|\| \{\}, (\d+)\)/) || [])[1], 10);
    assert(pageWait > (testMax + 1) * 1000 && pageWait < panelTimeout * 1000, '页面等测试结果的毫秒数要在脚本上限与模块 timeout 之间：' + pageWait);
  });

  await check(DEV_BUILD ? '跨文件不变量：观察者 pattern 与脚本里的 OBSERVE_RE 必须一致'
                        : '公开版：模块里没有观察者行；脚本里的 OBSERVE_RE 仍只放行那几类地址', async () => {
    const mod = fs.readFileSync(path.join(ROOT, 'SubsPair.sgmodule'), 'utf8');
    const live = mod.split('\n').filter((l) => /^SubsPair\.Observe\w+ = /.test(l));
    if (DEV_BUILD) {
      const stats = live.find((l) => /ObserveStats/.test(l));
      assert(stats && /www\\\.youtube\\\.com\\\/api\\\/stats\\\//.test(stats), 'ObserveStats 的 pattern 要指向 www 的 api/stats/');
      const obsM = live.find((l) => /ObserveM\b/.test(l));
      assert(obsM && /api\\\/stats\\\//.test(obsM), 'm 域观察者的 pattern 也要含 api/stats/');
    } else {
      assertEqual(live.length, 0, '公开版模块不该有观察者行');
    }
    const reSrc = (PANEL.match(/var OBSERVE_RE = (\/.*\/i);/) || [])[1];
    const OBSERVE_RE = new Function('return ' + reSrc)();
    for (const u of ['https://www.youtube.com/api/stats/watchtime?docid=x&cmt=1', 'https://m.youtube.com/api/stats/playback?docid=x', 'https://m.youtube.com/youtubei/v1/player?prettyPrint=false']) assert(OBSERVE_RE.test(u), '应当放行 ' + u);
    for (const u of ['https://www.youtube.com/watch?v=x', 'https://www.youtube.com/api/timedtext?v=x', 'https://www.youtube.com/youtubei/v1/player']) assert(!OBSERVE_RE.test(u), '不该放行 ' + u);
  });

  await check('跨文件不变量：模块有 SubsPair.Backfill 的 cron 行，每分钟一次，timeout 大于脚本的 BF_BUDGET_MS', async () => {
    const mod = fs.readFileSync(path.join(ROOT, 'SubsPair.sgmodule'), 'utf8');
    const line = mod.split('\n').find((l) => /^SubsPair\.Backfill = /.test(l));
    assert(line && /type=cron/.test(line) && /cronexp=\* \* \* \* \*/.test(line), '每分钟一次的 cron：' + line);
    // 所有 [Script] 行必须指向同一份脚本
    const paths = mod.split('\n').filter((l) => /^SubsPair\.\w+ = /.test(l)).map((l) => (l.match(/script-path=(\S+)/) || [])[1]);
    assert(paths.length >= 3 && paths.every((p) => p === paths[0]), '所有 [Script] 行的 script-path 要一致：' + paths.join(' | '));
    assert(DEV_BUILD ? paths[0] === 'Script/ytsub.js' : /^https:\/\/\S+\/ytsub\.js$/.test(paths[0]), 'script-path 的写法要和版本对得上：' + paths[0]);
    const timeout = parseInt((line.match(/\btimeout=(\d+)/) || [])[1], 10);
    const budget = parseInt((PANEL.match(/var BF_BUDGET_MS = (\d+)/) || [])[1], 10);
    assert(timeout * 1000 > budget, '模块 timeout 必须大于 BF_BUDGET_MS');
  });

  await check('跨文件不变量：面板网址只有一个来源——脚本 PANEL_RE 里的主机名，模块与文案处处一致', async () => {
    // 面板主机名散在脚本、模块、页面与说明里几十处；任何一处对不上，面板就打不开或解密不到，所以从 PANEL_RE 这一个来源逐处核对
    const reSrc = (PANEL.match(/var PANEL_RE = \/(.+?)\/i;/) || [])[1] || '';
    const escaped = (reSrc.match(/\\\/\\\/([^(]+)\(/) || [])[1];   // ^https?:\/\/ 与 ( 之间的主机名（带转义）
    assert(escaped, '前提：能从 PANEL_RE 取出主机名：' + reSrc);
    const H = escaped.replace(/\\\./g, '.');
    assert(/^[a-z0-9-]+\.test$/.test(H), '面板主机名必须是 .test 后缀：' + H);
    const panelLine = MODULE_TEXT.split('\n').find((l) => /^SubsPair\.Panel = /.test(l));
    assert(panelLine && panelLine.includes('pattern=^https?:\\/\\/' + escaped + '('), '模块 Panel 行的 pattern 要用同一个主机名：' + panelLine);
    // 每个键只许一行，而且要以 %APPEND% 开头：不加会整个盖掉用户配置里原有的设置，弄坏别的模块
    const hostsOf = (key) => {
      const rows = [...MODULE_TEXT.matchAll(new RegExp('^' + key + '\\s*=\\s*(.+)$', 'gm'))].map((m) => m[1]);
      assertEqual(rows.length, 1, '模块里 ' + key + ' 只许写一行');
      assert(/^%APPEND%\s/.test(rows[0]), '模块的 ' + key + ' 要以 %APPEND% 开头：' + rows[0]);
      return rows[0].replace('%APPEND%', '').split(',').map((s) => s.trim()).filter(Boolean);
    };
    // 解密的域名恰好是翻译脚本处理的 YouTube 主机加上设置页，不多不少：多解密一个域名就多一处能看到用户流量的地方
    const ytHosts = ((MODULE_TEXT.split('\n').find((l) => /^SubsPair\.Translate = /.test(l)) || '').match(/\(([a-z|]+)\)\\\.youtube\\\.com/) || [])[1];
    assert(ytHosts, '前提：能从翻译脚本的 pattern 取出 YouTube 主机');
    const sameSet = (a, b) => a.slice().sort().join(' ') === b.slice().sort().join(' ');
    const want = { hostname: ytHosts.split('|').map((h) => h + '.youtube.com').concat(H), 'force-http-engine-hosts': [H] };
    for (const key of Object.keys(want)) {
      const hosts = hostsOf(key);
      assert(sameSet(hosts, want[key]), key + ' 恰好是 ' + want[key].join(' ') + '，不多不少：' + hosts.join(' '));
    }
    // 安全说明里写的解密范围与规则条数，和模块实际对得上
    const sec = fs.readFileSync(path.join(ROOT, 'SECURITY.md'), 'utf8');
    for (const h of want.hostname) assert(sec.includes(h), 'SECURITY.md 要写明会解密 ' + h);
    assert(!/子域名/.test(sec), '模块只解密设置页这一个主机，SECURITY.md 里不该出现「及其子域名」');
    const rules = MODULE_TEXT.split(/^\[Rule\]$/m).slice(1).map((part) => part.split(/^\[/m)[0]).join('\n').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    assert(sec.includes('模块里只有两条规则'), 'SECURITY.md 要写明规则的条数（现在的写法是「模块里只有两条规则」）');
    assertEqual(rules.length, 2, 'SECURITY.md 说模块里只有两条规则，模块里实际的规则条数（所有 [Rule] 区段加起来）要一致');
    // 设置页的网址必须有一条 DIRECT 规则：没有它，这个不存在的网址会落到用户自己配置的兜底规则上，小火箭一边运行脚本
    // 一边去连它，连不上就把还在等的脚本停掉——等零点几秒到一秒多就断，而「测试连接」要等模型回话，就会失败
    assert(rules.indexOf('DOMAIN,' + H + ',DIRECT') >= 0, '模块里要有一条写给设置页网址的规则：DOMAIN,' + H + ',DIRECT');
    assert(rules.indexOf('AND,((PROTOCOL,UDP),(DST-PORT,443),(DOMAIN-SUFFIX,youtube.com)),REJECT-NO-DROP') >= 0, '模块里要有拒绝 YouTube 的 QUIC 的那条规则：少了它 App 不走普通 HTTPS，字幕请求到不了脚本');
    assert(sec.includes(H + '（DIRECT）'), 'SECURITY.md 要说明写给设置页网址的这条规则');
    assert(MODULE_TEXT.includes('\n#!openUrl=https://' + H + '/\n'), '#!openUrl 要指向面板');
    assert(((MODULE_TEXT.match(/^#!desc=(.*)$/m) || [])[1] || '').includes('https://' + H + '/'), '模块描述里的面板网址');
    // README 的写法各式各样（大小写、有没有结尾斜杠、http），先都抓进来，统一大小写与结尾斜杠后再比，http 照样算错
    const readmeUrls = (fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8').match(/\bhttps?:\/\/[a-z0-9.-]+\.test\b\/?/gi) || [])
      .map((u) => u.toLowerCase().replace(/\/?$/, '/'));
    assert(readmeUrls.length >= 1, 'README 要写明面板网址');
    const urls = (PANEL.match(/https:\/\/[a-z0-9.-]+\.test\//g) || []).concat(PANEL_HTML.match(/https:\/\/[a-z0-9.-]+\.test\//g) || []).concat(readmeUrls);
    assert(urls.length >= 7, '前提：脚本（通知、relay）、页面（页脚）与 README 里都有面板网址：' + urls.length);
    for (const u of urls) assertEqual(u, 'https://' + H + '/', '脚本、页面或 README 里的面板网址与 PANEL_RE 不一致');
  });

  // 模块描述必须包含的说法：隐私告知、功能边界、条款提示、无关联声明
  const DESC_NEEDS = ['字幕全文', '模型服务商', '条款', '无关联', 'DeepSeek', '法律法规', '不提供任何网络接入服务', '不含服务器配置', '不收集数据', '不收费'];
  await check(DEV_BUILD ? '开发版：探针与调试的出厂值都开，模块描述带「开发版」标记'
                        : '公开版：探针与调试的出厂值都关；模块描述是对外写法——隐私告知、条款提示、面板地址，不带「开发版」', async () => {
    const desc = (MODULE_TEXT.match(/^#!desc=(.*)$/m) || [])[1] || '';
    // 无关联声明在模块描述与面板「关于」区各有一句：两句只差自称（本模块 / 本工具），其余必须相同，免得改一处忘了另一处
    const legal = (fs.readFileSync(path.join(ROOT, 'panel', 'panel.html'), 'utf8').match(/'help\.legal':'([^']*)'/) || [])[1] || '';
    assert(legal.startsWith('本工具'), '面板声明要以「本工具」自称：' + legal);
    if (DEV_BUILD) {
      assert(/^\s*probe: true,$/m.test(PANEL) && /^\s*debug: true,$/m.test(PANEL), '开发版出厂值');
      assert(desc.includes('【开发版】'), '开发版描述要有标记，免得误发');
      // 发布配置里另有一份模块描述：文件在的话，按同样的要求核对
      const cfgPath = path.join(ROOT, 'tools', 'release.config.js');
      if (fs.existsSync(cfgPath)) {
        const pub = require(cfgPath).desc;
        assert(pub.includes('本模块' + legal.slice(3)), '面板的声明与公开版模块描述对不上：' + legal);
        for (const need of DESC_NEEDS) assert(pub.join('').includes(need), '公开版描述要有：' + need);
      }
      return;
    }
    assert(/^\s*probe: false,$/m.test(PANEL) && /^\s*debug: false,$/m.test(PANEL), '公开版出厂值');
    for (const need of DESC_NEEDS) assert(desc.includes(need), '公开版描述要有：' + need);
    assert(desc.includes('本模块' + legal.slice(3)), '面板的声明与模块描述对不上：' + legal);
    assert(!desc.includes('开发版'), '公开版描述不该带「开发版」');
  });

  await check('README：安装地址与仓库名、无关联声明和模块与面板对得上；引用的图、文件与页内跳转都在；没有 GitHub 会删掉或露出源码的写法；隐私照实写', async () => {
    // HTML 注释在 GitHub 上看不见：藏进注释里的声明与隐私说明不算数，所以先剥掉再核对
    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
    // 无关联声明：面板自称「本工具」、模块描述自称「本模块」、README 自称「本项目」，其余一字不差
    const legal = (PANEL_HTML.match(/'help\.legal':'([^']*)'/) || [])[1] || '';
    assert(legal.startsWith('本工具'), '前提：面板声明以「本工具」自称：' + legal);
    assert(readme.includes('本项目' + legal.slice(3)), 'README 的无关联声明要和面板那句只差自称：' + legal);
    // 功能边界照实写
    assert(readme.includes('不提供任何网络接入服务') && readme.includes('不含服务器配置'), 'README 的声明要写明功能边界');
    // 安装地址：模块在发布分支上的地址，和脚本同一个目录。先从模块的 script-path 取，
    // 取不到再看发布配置
    let scriptUrl = (MODULE_TEXT.match(/script-path=(https:\/\/[^,\s]+)/) || [])[1];
    const cfgPath = path.join(ROOT, 'tools', 'release.config.js');
    if (!scriptUrl && fs.existsSync(cfgPath)) scriptUrl = require(cfgPath).scriptPath;
    assert(scriptUrl || DEV_BUILD, '公开版的模块要指向公开仓库里的脚本');
    if (scriptUrl) {
      const repo = scriptUrl.match(/^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/[^/]+\/[^/]+$/);   // 主人、仓库名、发布分支、脚本
      assert(repo, '前提：脚本地址在公开仓库的发布分支上：' + scriptUrl);
      const base = scriptUrl.replace(/[^/]+$/, ''), site = 'https://github.com/' + repo[1] + '/' + repo[2];
      assert(readme.includes('\n' + base + 'SubsPair.sgmodule\n'), 'README 要单独一行给出模块地址，方便整行复制：' + base + 'SubsPair.sgmodule');
      // 指向 GitHub 的地址：原始文件只许发布分支（别的分支没等自动测试跑绿），网页只许本仓库；http、www 的写法也先抓进来再判
      for (const u of readme.match(/https?:\/\/(?:www\.)?(?:raw\.githubusercontent\.com|github\.com)\/[^\s"'()<>]*/gi) || []) {
        assert(u.startsWith(base) || u === site || (u.startsWith(site) && /^[/#?]/.test(u.slice(site.length))), 'README 里的 GitHub 地址要指向本仓库，原始文件只许发布分支：' + u);
      }
      const pages = readme.match(/https?:\/\/[a-z0-9-]+\.github\.io[^\s"'()<>]*/gi) || [];
      assert(pages.length >= 1, 'README 要有一键安装页的地址');
      for (const u of pages) assertEqual(u, 'https://' + repo[1] + '.github.io/' + repo[2] + '/', '一键安装页的地址要和公开仓库对得上');
    }
    // 引用：HTML 属性（单双引号、srcset 的每一项）、行内链接（可带标题）、引用式定义
    const refs = [];
    for (const m of readme.matchAll(/\b(src|href|srcset)\s*=\s*(["'])(.*?)\2/gi)) {
      if (/^srcset$/i.test(m[1])) for (const part of m[3].split(',')) refs.push(part.trim().split(/\s+/)[0]);
      else refs.push(m[3]);
    }
    for (const m of readme.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+(["']).*?\2)?\s*\)/g)) refs.push(m[1]);
    for (const m of readme.matchAll(/^ {0,3}\[[^\]]+\]:\s*<?([^\s>]+)>?/gm)) refs.push(m[1]);
    assert(refs.length >= 10, '前提：README 里有图和链接：' + refs.length);
    const exportCfgPath = path.join(ROOT, 'tools', 'export.config.js');
    const EXPORT_CFG = fs.existsSync(exportCfgPath) ? require(exportCfgPath) : null;
    // 页内跳转的目标按 GitHub 的规则从标题生成：转小写，去掉字母、数字、空格、横线、下划线以外的字符，空格换成横线
    const anchors = new Set();
    for (const m of readme.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)) anchors.add(m[1].toLowerCase().replace(/[^\p{L}\p{M}\p{Nd}\p{Pc} -]/gu, '').replace(/ /g, '-'));
    for (const r of refs) {
      if (/^(?:https?:|mailto:)/i.test(r)) continue;
      if (r.startsWith('#')) {
        let a = null; try { a = decodeURIComponent(r.slice(1)); } catch (e) {}
        assert(a !== null && anchors.has(a), 'README 的页内跳转找不到对应的标题：' + r);
        continue;
      }
      assert(!/^[a-z][a-z0-9+.-]*:/i.test(r) && !r.startsWith('//'), 'README 里的 ' + r + '：GitHub 只留 http、https 与 mailto 链接，这种会被删掉');
      let rel = null; try { rel = decodeURI(r.split(/[#?]/)[0]); } catch (e) {}
      assert(rel, 'README 里的地址解不开：' + r);
      const inside = path.relative(ROOT, path.resolve(ROOT, rel));
      assert(inside && !inside.startsWith('..') && !path.isAbsolute(inside), 'README 引用了仓库以外的东西：' + r);
      if (EXPORT_CFG) assert(EXPORT_CFG.publish.includes(inside.split(path.sep).join('/')), 'README 引用的文件不在要发布的文件清单里：' + r);
      // 逐段核对精确的文件名：GitHub 上文件名分大小写，所以按目录列表逐段精确比对
      let dir = ROOT;
      for (const seg of inside.split(path.sep)) {
        assert(fs.statSync(dir).isDirectory() && fs.readdirSync(dir).includes(seg), 'README 引用的文件不存在（注意大小写）：' + r);
        dir = path.join(dir, seg);
      }
    }
    // 图只许用仓库里的文件：外链的图在发布之后可以被别人换掉，README 首页就跟着变了
    // 标签按引号切（属性值里的 > 不算结束），属性值带不带引号都认；图片语法认行内写法与三种引用写法（![文字][标签]、![标签][]、![标签]）
    const imgs = [];
    for (const t of readme.match(/<(?:img|source)\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi) || []) {
      for (const a of t.matchAll(/\b(src|srcset)\s*=\s*(?:(["'])(.*?)\2|([^\s"'>]+))/gi)) {
        const v = a[3] !== undefined ? a[3] : a[4];
        imgs.push(...(/^srcset$/i.test(a[1]) ? v.split(',').map((p) => p.trim().split(/\s+/)[0]) : [v]));
      }
    }
    const alt = String.raw`(?:[^\[\]]|\[[^\]]*\])*`;   // 替代文字里允许一层方括号
    for (const m of readme.matchAll(new RegExp(String.raw`!\[` + alt + String.raw`\]\(\s*<?([^)\s>]+)`, 'g'))) imgs.push(m[1]);
    const defs = {};
    for (const m of readme.matchAll(/^ {0,3}\[([^\]]+)\]:\s*<?([^\s>]+)>?/gm)) defs[m[1].trim().toLowerCase()] = m[2];
    for (const m of readme.matchAll(new RegExp(String.raw`!\[(` + alt + String.raw`)\](?:\[([^\]]*)\])?(?![(\[])`, 'g'))) {
      const label = (m[2] || m[1]).trim().toLowerCase();
      if (defs[label]) imgs.push(defs[label]);
    }
    assert(imgs.length >= 5, '前提：README 里有图：' + imgs.length);
    for (const u of imgs) assert(!/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(u), 'README 的图只许用仓库里的文件，不许外链：' + u);
    // 裸写的网址后面紧跟中文或全角标点，GitHub 会把后面的字一路算进链接：网址要写成 <…> 或 [..](..)
    const prose = readme.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '').replace(/<https?:\/\/[^>\s]+>/g, '')
      .replace(/\[[^\]\n]*\]\([^)\n]*\)/g, ' ').replace(/\b(?:src|href|srcset)\s*=\s*(["']).*?\1/gi, '');
    const bare = prose.match(/(?:https?:\/\/|www\.)[^\s<>]*[^\s -~]/);
    assert(!bare, '裸写的网址后面紧跟着中文，GitHub 会把后面的字算进链接：' + (bare && bare[0]));
    // 这些标签 GitHub 不认：有的把源码原样露在页面上，有的整段删掉
    const tag = readme.match(/<(?:style|iframe|script|object|embed|form|input|button|video|audio|svg|math|link|meta|textarea|select|noscript|template|base)\b/i);
    assert(!tag, 'README 里不要写 ' + (tag && tag[0]) + '：GitHub 会露出源码或整段删掉');
    // 隐私照实写，放在醒目的提示框里：字幕全文会发给服务商、对方能看到、足以看出在看什么；手机上确实存着译文与待翻的原文，
    // 所以不能写成「不记录你看过什么」这一类说法
    const priv = readme.split(/^## /m).find((sec) => sec.startsWith('隐私')) || '';
    const alert = (priv.match(/^> \[!(?:WARNING|IMPORTANT|CAUTION)\]\n(?:>.*\n?)+/m) || [''])[0];
    assert(alert, 'README「隐私」一节要放在醒目的提示框里（WARNING、IMPORTANT 或 CAUTION）');
    for (const need of ['所有数据只存在你自己的手机上', '我们没有服务器', '字幕全文都会发给', '模型服务商', '对方能看到并可能留存', '字幕全文足以看出你在看什么视频']) {
      assert(alert.includes(need), 'README「隐私」提示框里要照实写：' + need);
    }
    const over = readme.match(/不(?:会)?(?:记录|保存|收集|留存|知道|追踪|上传|发送|分享|泄露)[^。\n]{0,8}(?:看过|看了|观看|浏览|看过的视频|看了什么)/);
    assert(!over, '隐私不能写成「不记录你看过什么」这一类说法：' + (over && over[0]));
  });

  await check('一键安装页：只跳到本项目发布分支上的模块，要用户自己点；不自动跳转、不读参数、不加载外部资源；先讲安装前的两件事；和 README、发布配置对得上', async () => {
    // 这几条规矩各防一件事：只许跳到本项目的模块、不读地址栏参数——免得别人拿这个页面的网址去装他自己的模块；
    // 要用户自己点、不自动跳转——打开网页不该不经同意就拉起别的 App；不加载外部资源——页面内容不依赖任何第三方，
    // 也不把访问者的信息带给第三方
    const raw = fs.readFileSync(path.join(ROOT, 'install', 'index.html'), 'utf8');
    const text = raw.replace(/<!--(?!>)[\s\S]*?-->/g, '');
    // 模块地址与 README 那条用例同一个来源：先取模块里的 script-path，取不到再看发布配置
    let scriptUrl = (MODULE_TEXT.match(/script-path=(https:\/\/[^,\s]+)/) || [])[1];
    const cfgPath = path.join(ROOT, 'tools', 'release.config.js');
    if (!scriptUrl && fs.existsSync(cfgPath)) scriptUrl = require(cfgPath).scriptPath;
    const repo = String(scriptUrl || '').match(/^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/[^/]+\/[^/]+$/);
    assert(repo, '前提：拿得到发布分支上的脚本地址：' + scriptUrl);
    const moduleUrl = scriptUrl.replace(/[^/]+$/, '') + 'SubsPair.sgmodule', site = 'https://github.com/' + repo[1] + '/' + repo[2];
    // 只有一个跳进小火箭的按钮，地址写死成本项目的模块
    const schemes = [...text.matchAll(/\bhref\s*=\s*["']?\s*([a-z][a-z0-9+.-]*):/gi)].map((m) => m[1].toLowerCase()).filter((s) => s !== 'https');
    assertEqual(schemes.join(' '), 'shadowrocket', '页面上只许有一个跳进小火箭的链接，别的链接都是 https');
    const install = (text.match(/href="shadowrocket:\/\/install\?module=([^"]+)"/) || [])[1];
    assert(install, '要有安装按钮：shadowrocket://install?module=…');
    assertEqual(decodeURIComponent(install), moduleUrl, '安装按钮只跳到本项目发布分支上的模块');
    // 别的链接只许指向本仓库或设置页；不许有「//」开头的写法、不许用 .. 绕到别处、不许用字符引用藏写法
    assert(!/\bhref\s*=\s*["']?[^"'\s>]*&#/i.test(text), '链接里不许用字符引用');
    for (const m of text.matchAll(/\bhref\s*=\s*["']?\s*((?:https?:)?\/\/[^"'\s>]*)/gi)) {
      const u = m[1];
      assert((u === site || u.startsWith(site + '#') || u.startsWith(site + '/') || u === 'https://subs.test/') && !/\/\.\.?(?:[/#?]|$)/.test(u), '页面上的链接只许指向本仓库或设置页：' + u);
    }
    // 要用户自己点：页面唯一的脚本就是「复制地址」这一小段，一字不差（改它就得同时改这里）；没有行内事件、表单、自动刷新；
    // 浏览器那一层再用内容安全策略挡住一切外部资源
    const scripts = [...text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
    assertEqual(scripts.length, 1, '页面只许有一段脚本');
    assertEqual(scripts[0][1].trim(), '', '脚本不许从外面加载');
    const squash = (s) => s.replace(/\s+/g, ' ').trim();
    assertEqual(squash(scripts[0][2]), squash(`
      // 复制地址：剪贴板不可用时退回到选中文字，让用户自己长按复制
      document.getElementById('copy').addEventListener('click', function () {
        var btn = this, addr = document.getElementById('addr');
        function selectIt() {
          var r = document.createRange(); r.selectNodeContents(addr);
          var s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
          btn.textContent = '已选中，长按复制';
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(addr.textContent).then(function () { btn.textContent = '已复制'; }, selectIt);
        } else selectIt();
      });`), '页面的脚本只许是复制地址这一小段');
    const markup = text.replace(scripts[0][0], '');
    assert(!/\son[a-z]+\s*=|<form\b|<(?:object|embed|iframe|base)\b|http-equiv\s*=\s*["']?refresh/i.test(markup), '不许有行内事件、表单、嵌入页面、改基准地址或自动刷新');
    assert(markup.includes(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'">`),
      '页面要用内容安全策略挡住一切外部资源');
    assert(!/@import|url\s*\(\s*["']?\s*(?:https?:)?\/\/|<(?:img|link|source|video|audio)\b[^>]*\b(?:src|href|srcset)\s*=\s*["']?\s*(?:https?:)?\/\//i.test(markup), '页面不加载任何外部资源');
    // 「复制地址」真的复制按钮里的那个地址：把页面脚本跑一遍，点一下
    assert(markup.includes('id="addr">' + moduleUrl + '<'), '按钮没反应时显示的地址要和按钮里的一样');
    let copied = null, onClick = null;
    const btn = { textContent: '', addEventListener: (ev, fn) => { if (ev === 'click') onClick = fn; } };
    const addr = { textContent: (markup.match(/id="addr">([^<]*)</) || [])[1] };
    vm.runInNewContext(scripts[0][2], { document: { getElementById: (id) => (id === 'copy' ? btn : id === 'addr' ? addr : null) },
      navigator: { clipboard: { writeText: (t) => { copied = t; return Promise.resolve(); } } }, window: {} });
    assert(onClick, '复制按钮要接上点击');
    onClick.call(btn);
    await new Promise((r) => setTimeout(r, 0));
    assertEqual(copied, moduleUrl, '「复制地址」复制的是按钮里的模块地址');
    assertEqual(btn.textContent, '已复制');
    // 这个页面可以不经 README 直接打开，所以先讲安装前的两件事并链回 README 的第一步；链到的标题 README 里都要有
    for (const need of ['全局路由', '配置', 'HTTPS 解密', '证书信任设置', '完全信任', '装好了却没反应']) assert(markup.includes(need), '页面要先讲安装前的两件事：' + need);
    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
    const anchors = new Set();
    for (const m of readme.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)) anchors.add(m[1].toLowerCase().replace(/[^\p{L}\p{M}\p{Nd}\p{Pc} -]/gu, '').replace(/ /g, '-'));
    const hops = [...markup.matchAll(/href\s*=\s*["']https:[^"'#]*#([^"']*)["']/g)].map((m) => decodeURIComponent(m[1]));
    assert(hops.some((a) => a.startsWith('第一步')), '页面要链回 README 的第一步');
    for (const a of hops) assert(anchors.has(a), '页面链到 README 的「#' + a + '」，README 里没有这个标题');
    // 和 README、设置页同一套说法：标语、功能边界、无关联声明（只差自称）
    const afterH1 = readme.slice(readme.search(/<\/h1>|^# .+$/m));
    const tagline = ((afterH1.match(/<p\b[^>]*>([\s\S]*?)<\/p>/) || [])[1] || '').replace(/<[^>]+>/g, '').trim();
    assert(tagline && markup.includes('<p class="tag">' + tagline + '</p>'), '页面上的标语要和 README 大标题下那句一字不差');
    const scope = ((readme.match(/^- (SubsPair 只在你的手机上运行[^\n]*)$/m) || [])[1] || '').trim();
    assert(['不提供任何网络接入服务', '不含服务器配置', '不收集数据', '不收费'].every((w) => scope.includes(w)), 'README 的声明里要有那句功能边界');
    assert(markup.includes('<p>' + scope + '</p>'), '页面上的功能边界句要和 README 声明里那句一字不差');
    const legal = (PANEL_HTML.match(/'help\.legal':'([^']*)'/) || [])[1] || '';
    assert(legal.startsWith('本工具') && markup.includes('本项目' + legal.slice(3)), '一键安装页的无关联声明要和设置页那句只差自称');
    // README 的安装按钮打开的就是这个页面；Pages 只发布 install/ 这一个目录、只从 main 发布、不跑别的命令
    assert(readme.includes('href="https://' + repo[1] + '.github.io/' + repo[2] + '/"'), 'README 的安装按钮要指向这个页面');
    const wf = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'pages.yml'), 'utf8');
    assert(/^\s+path: install\s*$/m.test(wf) && /^\s+branches: \[main\]\s*$/m.test(wf), 'Pages 只发布 install/ 这一个目录，只从 main 发布');
    assert(!/^\s*-?\s*run:/m.test(wf), 'Pages 的发布流程不许跑别的命令（免得把别的文件带进网站）');
    const triggers = ((wf.match(/^on:\n((?:[ \t]+.*\n)+)/m) || [])[1] || '').split('\n').filter((l) => /^  [a-z_]+:/.test(l)).map((l) => l.trim().replace(/:.*$/, ''));
    assertEqual(triggers.join(' '), 'push workflow_dispatch', 'Pages 只在推送或手动运行时发布');
    // 不换行的片段要短：一段太长的话，窄屏手机上它撑宽整页，右边被截掉、要左右拖着看（375 宽的屏幕约容得下 18 个字）
    const nw = [...text.matchAll(/<span class="nw">([^<]*)<\/span>/g)].map((m) => m[1]);
    assert(nw.length >= 3, '前提：页面里有不换行的片段：' + nw.length);
    for (const s of nw) assert(s.length <= 10, '不换行的片段太长，窄屏上会撑宽整页：' + s);
  });

  await check('品牌名一致：模块文件与名称、脚本标签、页面标题与主屏幕名称、品牌名、通知标题、日志前缀、README 标题、标志图都叫 SubsPair，没有别的名字', async () => {
    // 正面写法：该署名的地方全都是 SubsPair
    assertEqual(fs.readdirSync(ROOT).filter((f) => /\.sgmodule$/i.test(f)).join(', '), 'SubsPair.sgmodule', '目录里只有一个模块文件，文件名就是产品名');
    const mod = fs.readFileSync(path.join(ROOT, 'SubsPair.sgmodule'), 'utf8');
    assertEqual((mod.match(/^#!name=.*$/gm) || []).join(' | '), '#!name=SubsPair · YouTube AI 双语字幕', '模块名称只有一行，第一次出现要带说明');
    assert(/^#!author=kaixuedev$/m.test(mod), '模块的作者一栏要是 kaixuedev');
    // 脚本标签：生效的行和注释掉的备用写法都算；注释与脚本里提到的标签名也一样
    const labels = mod.split('\n').filter((l) => /^#?\s*[A-Za-z]+\.[A-Za-z]+ = type=/.test(l)).map((l) => l.replace(/^#?\s*/, '').split(' = ')[0]);
    assert(labels.length >= 3 && labels.every((l) => /^SubsPair\./.test(l)), '脚本标签一律 SubsPair.*：' + labels.join(', '));
    const mentioned = (mod + '\n' + PANEL).match(/\b[A-Za-z]+\.(?:Panel|Translate|Backfill|Observe[A-Za-z]*)\b/g) || [];
    assert(mentioned.length >= labels.length && mentioned.every((l) => /^SubsPair\./.test(l)), '提到的脚本标签一律 SubsPair.*：' + [...new Set(mentioned)].join(', '));
    const { res } = await panel({ url: U + '/', store: new Map() });
    assert(res.body.includes('<title>SubsPair · YouTube AI 双语字幕</title>'), '页面标题');
    assert(res.body.includes('name="apple-mobile-web-app-title" content="SubsPair"'), '添加到主屏幕时显示的名字');
    assertEqual((res.body.match(/'app\.name':'[^']*'/g) || []).join(' | '), "'app.name':'SubsPair' | 'app.name':'SubsPair'", '面板左上角、关于与页脚的品牌名：中英两份字典都是 SubsPair');
    assertEqual((res.body.match(/'app\.full':'[^']*'/g) || []).join(' | '), "'app.full':'SubsPair · YouTube AI 双语字幕' | 'app.full':'SubsPair · AI bilingual subtitles for YouTube'",
      '中英 app.full（按界面语言设的页面标题、总开关的读屏名）带品牌名和说明');
    // 面板区段以外的脚本：按回填工具写进去的那对标记切（文件头注释里也提到标记名，只找名字会切错地方）
    const ps = PANEL.indexOf('/* @@PANEL-START@@'), pe = PANEL.indexOf('/* @@PANEL-END@@ */');
    assert(ps > 0 && pe > ps, '前提：脚本里有面板区段的起止标记');
    const outside = PANEL.slice(0, ps) + PANEL.slice(pe);
    const prefixes = outside.match(/console\.log\('\[[^\]]*\]/g) || [];
    assert(prefixes.length >= 3 && prefixes.every((p) => p === "console.log('[SubsPair]"), '日志前缀一律 [SubsPair]：' + [...new Set(prefixes)].join(', '));
    for (const t of ["setupTitle: 'SubsPair 尚未完成设置'", "pausedTitle: 'SubsPair 已暂停'", "errorsTitle: 'SubsPair 暂时暂停'",
      "setupTitle: 'SubsPair: setup required'", "pausedTitle: 'SubsPair paused'", "errorsTitle: 'SubsPair temporarily paused'"]) {
      assert(outside.includes(t), '通知标题：' + t);
    }
    assert(outside.includes("rej400Title: 'SubsPair：部分字幕未能翻译'") && outside.includes("rej400Title: 'SubsPair: some subtitles were not translated'"), '四条通知标题都要署名，不能三条署名一条不署');
    const titles = outside.match(/\b\w+Title: '[^']*'/g) || [];
    assert(titles.length >= 8 && titles.every((t) => /^\w+Title: 'SubsPair[ :：]/.test(t)), '通知文案表里每一条标题都以产品名开头：' + titles.filter((t) => !/'SubsPair/.test(t)).join(' | '));
    assert(!/['"]YouTube 双语字幕['"]/.test(outside), '写死在调用点的通知标题不许只写「YouTube 双语字幕」，要带产品名');
    const literal = outside.match(/(?:notifyOnce\('\w+', |\$notification\.post\()'[^']*'/g) || [];
    assert(literal.length >= 3 && literal.every((c) => /'SubsPair'$/.test(c)), '写死在调用点的通知标题一律是产品名：' + literal.join(' | '));
    assert(!/双语字幕已暂停|Bilingual Subtitles paused/.test(outside), '通知标题不许用不带产品名的写法');
    // 用户在 GitHub 上看到的：README 的大标题、标志图的名字（读屏与悬停提示）、包名
    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
    const h1 = (readme.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>|^# (.+)$/m) || []).slice(1).find(Boolean) || '';
    assert(/\bSubsPair\b/.test(h1), 'README 的大标题要是产品名：' + h1);
    // README 大标题下的那句标语，和模块描述的第一句是同一句话：GitHub 首屏与小火箭里的模块说明说法一致，改一处要两处一起改
    const afterH1 = readme.slice(readme.search(/<\/h1>|^# .+$/m));
    const tagline = ((afterH1.match(/<p\b[^>]*>([\s\S]*?)<\/p>/) || [])[1] || '').replace(/<[^>]+>/g, '').trim();
    assert(tagline, 'README 大标题下面要有一句标语');
    const cfgPath = path.join(ROOT, 'tools', 'release.config.js');
    const pubDesc = !DEV_BUILD ? ((MODULE_TEXT.match(/^#!desc=(.*)$/m) || [])[1] || '') : fs.existsSync(cfgPath) ? require(cfgPath).desc[0] : null;
    if (pubDesc !== null) assert(pubDesc.startsWith(tagline + '。'), '公开版模块描述的第一句要和 README 大标题下的标语一字不差：' + tagline + ' / ' + pubDesc.slice(0, 60));
    // 名字的写法：说明、模块、设置页、脚本与图里，凡是写成 subs/pair 这个词的，只许是 SubsPair（包名那一行是小写的 subspair）
    const spelled = [];
    for (const rel of ['README.md', 'SECURITY.md', 'CONTRIBUTING.md', '.github/ISSUE_TEMPLATE/bug_report.md', 'package.json', 'SubsPair.sgmodule', 'panel/panel.html', 'ytsub.js', 'tools/inline-panel.js', 'install/index.html']
      .concat(fs.readdirSync(path.join(ROOT, '.github', 'assets')).filter((n) => /\.svg$/i.test(n)).map((n) => '.github/assets/' + n))) {
      const text = fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/^\s*"name": "subspair",$/m, '');
      for (const m of text.match(/\bsubs?[\s._-]*pair\b/gi) || []) if (m !== 'SubsPair') spelled.push(rel + '：' + m);
    }
    assert(!spelled.length, '产品名写成了别的样子（大小写、少 s、中间加了空格或符号）：' + spelled.join('，'));
    for (const f of ['logo.svg', 'logo-dark.svg']) {
      assert(fs.readFileSync(path.join(ROOT, '.github', 'assets', f), 'utf8').includes('<title>SubsPair</title>'), f + ' 的名字要是产品名');
    }
    assertEqual(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).name, 'subspair', 'package.json 的包名');
  });

  section('单文件分派：两个角色不能串台');

  await check('无关 URL 原样放行，不做任何事', async () => {
    const store = new Map();
    const { res } = await panel({ url: 'https://example.com/whatever', store });
    assert(!res, '不该返回任何响应');
    assertEqual(store.size, 0, '不该碰持久化存储');
  });

  await check('m.youtube.com（移动网页版）的 timedtext 也走翻译角色', async () => {
    const { result, calls } = await translate({
      url: 'https://m.youtube.com/api/timedtext?v=abc&lang=en&fmt=json3', body: oneLine(), store: new Map(),
      config: { enabled: true, probe: false, baseUrl: 'https://a.example.com/v1', apiKey: 'k', model: 'm' },
    });
    assert(result && result.body, 'm 域的字幕应当被改写');
    assertEqual(calls.length, 1);
    assert(JSON.parse(result.body).events[0].segs[0].utf8.includes('\n'), '应当是双语两行');
  });

  await check('面板 URL 不会触发翻译逻辑；字幕 URL 不会返回 HTML 页面', async () => {
    const store = new Map();
    const CFG = { enabled: true, probe: true, baseUrl: 'https://a.example.com/v1', apiKey: 'k', model: 'm' };
    const { res, calls } = await panel({ url: U + '/', store, config: CFG });
    assert(res && res.body.indexOf('<!doctype html>') === 0, '应当走面板角色');
    assertEqual(calls.length, 0, '面板不该发翻译请求');
    assert(!store.get('llmsubs.diag'), '面板不该写翻译侧的诊断记录');
    const { result } = await translate({ url: SUB1, body: oneLine(), store: new Map(), config: CFG });
    assert(result && result.body && result.body.indexOf('<!doctype') < 0 && !result.response, '应当走翻译角色');
    JSON.parse(result.body);
  });

  await check('面板域名的子路径也归面板管', async () => {
    for (const u of [U, U + '/', U + '/api/config', 'https://subs.test/deep/path?x=1']) {
      const { res } = await panel({ url: u, store: new Map() });
      assert(res, u + ' 应当被面板接管');
    }
  });

  await check('探针：/relay 记进 relays 环并对外发一次请求；/api/diag 带出探针键，清空诊断一起清', async () => {
    const store = new Map();
    const sentAt = Date.now() - 100;
    const r = await panel({ url: U + '/relay?id=abcd1234&t=' + sentAt, store, config: { probe: true }, respondGet: () => ({ status: 200 }) });
    assertEqual(json(r).ok, true);
    const relays = JSON.parse(store.get('llmsubs.relays'));
    assertEqual(relays.length, 1); assertEqual(relays[0].id, 'abcd1234');
    assert(relays[0].lag >= 100 && relays[0].lag < 5000); assertEqual(relays[0].out, 200);
    assertEqual(r.gets.length, 1); assert(!/subs\.test/.test(r.gets[0].url), '对外那次不能再打自己');
    const s2 = new Map();
    const r2 = await panel({ url: U + '/relay?id=deadbeef&t=1', store: s2, config: { probe: true }, respondGet: () => ({ error: 'boom' }) });
    assertEqual(json(r2).ok, true); assertEqual(JSON.parse(s2.get('llmsubs.relays'))[0].outErr, 'boom');
    const s2c = new Map();
    const r2c = await panel({ url: U + '/relay?id=' + 'x'.repeat(500) + '&t=1', store: s2c, config: { probe: true }, respondGet: () => ({ status: 200 }) });
    assertEqual(json(r2c).ok, true);
    assert(!s2c.get('llmsubs.relays') && r2c.gets.length === 0, '不是运行 id 格式的请求不记录、不外发（任何网页都能打到这里）');
    const s2e = new Map();
    s2e.set('llmsubs.diagver', '0.0.0'); s2e.set('llmsubs.relays', JSON.stringify([{ at: 'stale', id: 'oldver' }]));
    await panel({ url: U + '/relay?id=0badf00d&t=1', store: s2e, config: { probe: true }, respondGet: () => ({ status: 200 }) });
    assertEqual(JSON.parse(s2e.get('llmsubs.relays')).length, 1, '换版本后旧 relays 清掉');
    const s0 = new Map();
    const r0 = await panel({ url: U + '/relay?id=abcd1234&t=1', store: s0, config: { probe: false }, respondGet: () => ({ status: 200 }) });
    assertEqual(json(r0).ok, true);
    assert(r0.gets.length === 0 && !s0.get('llmsubs.relays'), '探针关着（公开版出厂值）时 /relay 不外发、不落盘：任何网页都能打到这里');
    const s3 = new Map();
    s3.set('llmsubs.postdone', '{"id":"r1"}'); s3.set('llmsubs.relays', '[{"id":"r1"}]'); s3.set('llmsubs.relaycb', '{"id":"r1"}'); s3.set('llmsubs.fcb', '{"eff":32}');
    const d = await GET('/api/diag', s3);
    assertEqual(d.postdone.id, 'r1'); assertEqual(d.relays[0].id, 'r1'); assertEqual(d.relaycb.id, 'r1'); assertEqual(d.fcb.eff, 32);
    await POST('/api/diag/clear', {}, s3);
    assert(!s3.get('llmsubs.postdone') && !s3.get('llmsubs.relays') && !s3.get('llmsubs.relaycb'), '探针键随清空一起清');
    await POST('/api/config/reset', {}, s3);
    assert(!s3.get('llmsubs.fcb'), '恢复默认设置时降档记录一起归位');
  });

  await check('探针：/relay 对外请求超时兜底只收尾一次，晚到的回调不再追加记录', async () => {
    const store = new Map();
    const t0 = Date.now();
    const r = await panel({ url: U + '/relay?id=aaaaaaaa&t=1', store, config: { probe: true }, respondGet: () => ({ status: 200, delay: 6600 }) });
    const elapsed = Date.now() - t0;
    assertEqual(json(r).ok, true);
    assert(elapsed >= 5500 && elapsed < 6500, '6 秒兜底收尾，实际 ' + elapsed + 'ms');
    await new Promise((res) => setTimeout(res, 1200));
    assertEqual(JSON.parse(store.get('llmsubs.relays')).length, 1, '晚到的回调不能再追加一条');
  });

  await check('/api/diag 带出 cron 环、存活计数、待翻队列索引与 pdn；清空诊断不动队列；清除译文连队列一起清', async () => {
    const store = new Map();
    store.set('llmsubs.cron', JSON.stringify([{ at: 'x', skip: 'idle' }]));
    store.set('llmsubs.cron.n', '7'); store.set('llmsubs.cron.first', '1000'); store.set('llmsubs.cron.last', '361000');
    store.set('llmsubs.pdn', '123');
    store.set('llmsubs.bfq', JSON.stringify([{ h: 'aabbccdd', at: 1, n: 2 }]));
    store.set('llmsubs.bf.aabbccdd', JSON.stringify({ h: 'aabbccdd', items: [{ t: ['secret subtitle text'] }] }));
    const d = await GET('/api/diag', store);
    assertEqual(d.cron.length, 1); assertEqual(d.pdn, '123');
    assertEqual(d.cronStats.n, 7); assertEqual(d.cronStats.expected, 7);
    assert(typeof d.cronStats.ago === 'number' && d.cronStats.ago > 0);
    assertEqual(d.backfill[0].n, 2);
    assert(!JSON.stringify(d).includes('secret subtitle text'), '诊断只带队列索引，不带待翻正文');
    await POST('/api/diag/clear', {}, store);
    assert(!store.get('llmsubs.cron') && !store.get('llmsubs.pdn') && !store.get('llmsubs.cron.n'), '清空诊断清掉 cron 环、计数与 pdn');
    assert(store.get('llmsubs.bf.aabbccdd') && store.get('llmsubs.bfq'), '待翻队列不是诊断');
    await POST('/api/cache/clear', {}, store);
    assert(!store.get('llmsubs.bf.aabbccdd') && !store.get('llmsubs.bfq'), '清除译文时队列一起清');
  });

  section('页面：内联、接线、视图与文案');

  await check('面板内联脚本语法合法，接的是真实接口（带 pv 与 tok）不是模拟；与 panel/panel.html 同步', async () => {
    const { res } = await panel({ url: U + '/', store: new Map() });
    const m = res.body.match(/<script>([\s\S]*?)<\/script>/);
    assert(m, '页面应当有内联脚本');
    new Function(m[1]);
    for (const p of ["'/api/config'", "'/api/key'", "'/api/test'", "'/api/resume'", "'/api/cache/clear'", "'/api/config/reset'", "'/api/diag'"]) assert(m[1].includes(p), '页面要打真实接口 ' + p);
    assert(/b\.tok = TOK; b\.pv = PV;/.test(m[1]) && /'pv=' \+ encodeURIComponent\(PV\)/.test(m[1]), 'POST 带 tok 与 pv，GET 带 pv');
    assert(!m[1].includes('@@MOCK-API') && !/\bmockScenario\b|\bDEMO\b|演示|demo-fab|sk-demo/.test(res.body), '模拟接口与演示控制台不得进页面');
    assert(!res.body.includes('@@VER@@') && !res.body.includes('@@TOK@@'), '占位符要被替换');
    const r = cp.spawnSync(process.execPath, [path.join(ROOT, 'tools', 'inline-panel.js'), '--check'], { encoding: 'utf8' });
    assertEqual(r.status, 0, '内联的面板必须与 panel/panel.html 一致: ' + (r.stderr || r.stdout));
  });

  await check('api.real.js 契约：GET 带 pv、POST 带 tok 与 pv；业务失败 resolve；非 JSON / fetch 失败 / 超时 reject {network:true}；stale_page 触发 markStale', async () => {
    const src = fs.readFileSync(path.join(ROOT, 'panel', 'api.real.js'), 'utf8').replace('@@VER@@', VER);
    const fetches = []; let reply = () => Promise.resolve({ status: 200, text: () => Promise.resolve('{"ok":false,"code":"bad_url"}') });
    const stale = [];
    const sb = { document: { querySelector: () => ({ getAttribute: () => 'tok-abc' }) }, fetch: (url, opt) => { fetches.push({ url, opt }); return reply(url, opt); },
      markStale: () => stale.push(1), setTimeout, clearTimeout, Promise, JSON, encodeURIComponent, Object };
    vm.createContext(sb); vm.runInContext(src, sb, { filename: 'api.real.js' });
    let r = await sb.api.getConfig();
    assertEqual(fetches[0].url, '/api/config?pv=' + encodeURIComponent(VER)); assertEqual(fetches[0].opt.method, 'GET');
    assertEqual(r.code, 'bad_url', '业务失败要 resolve，不是 reject');
    await sb.api.saveConfig({ enabled: false });
    const body = JSON.parse(fetches[1].opt.body);
    assertEqual(fetches[1].opt.method, 'POST'); assertEqual(body.tok, 'tok-abc'); assertEqual(body.pv, VER); assertEqual(body.enabled, false);
    reply = () => Promise.resolve({ status: 502, text: () => Promise.resolve('<html>bad gateway') });
    let e = await sb.api.diag().then(() => null, (x) => x);
    assert(e && e.network === true && e.http === 502, '非 JSON 响应 → {network:true}：' + JSON.stringify(e));
    reply = () => Promise.reject(new Error('offline'));
    e = await sb.api.resume().then(() => null, (x) => x);
    assert(e && e.network === true, 'fetch 失败 → {network:true}');
    reply = () => new Promise(() => {});
    e = await sb.jfetch('/api/config', null, 20).then(() => null, (x) => x);
    assert(e && e.network === true && e.timeout === true, '超时 → {network:true, timeout:true}');
    reply = () => Promise.resolve({ status: 200, text: () => Promise.resolve('{"ok":false,"code":"stale_page"}') });
    r = await sb.api.getConfig();
    assertEqual(r.code, 'stale_page'); assertEqual(stale.length, 1, 'stale_page 要通知页面');
  });

  await check('页面每个调用接口的地方都有失败分支：Promise 链不许裸 then', async () => {
    const script = PANEL_HTML.slice(PANEL_HTML.indexOf('/* @@MOCK-API-END@@ */'));
    const lines = script.split('\n');
    const bad = [];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (!/api\.(saveConfig|setKey|test|resume|clearCache|resetConfig|diag|getConfig)\(/.test(l)) continue;
      const chunk = lines.slice(i, i + 16).join('\n');
      if (!/function \((e|err)?\) \{|\.then\(null, |, function \(\) \{/.test(chunk) && !/Promise\.all/.test(l)) bad.push(i + ': ' + l.trim().slice(0, 80));
    }
    assertEqual(bad.length, 0, '缺失败分支：\n' + bad.join('\n'));
  });

  await check('字典：中英键集合相等、占位符一致；英文不含汉字（字幕示例除外）；面板用语不含内部术语', async () => {
    const tStart = PANEL_HTML.indexOf('var T = {'), tEnd = PANEL_HTML.indexOf('\n};', tStart) + 3;
    const T = new Function(PANEL_HTML.slice(tStart, tEnd) + '; return T;')();
    const zk = Object.keys(T.zh).sort(), ek = Object.keys(T.en).sort();
    const onlyZh = zk.filter((k) => !(k in T.en)), onlyEn = ek.filter((k) => !(k in T.zh));
    assertEqual(onlyZh.concat(onlyEn).length, 0, '键不对齐：' + onlyZh.concat(onlyEn).join(','));
    const ph = (s) => (String(s).match(/\{\w+\}/g) || []).sort().join(',');
    for (const k of zk) assertEqual(ph(T.en[k]), ph(T.zh[k]), k + ' 的占位符不一致');
    const han = ek.filter((k) => !/^cap\.|^lang\.hant$|^lang\.hans$/.test(k) && /[一-鿿]/.test(T.en[k]));
    assertEqual(han.length, 0, '英文里有汉字：' + han.join(','));
    const TERMS = /速度档|质量档|补翻|补全|首波|第二波|落地|交回|熔断|退档|cron|端点|探针|批/;
    const hit = zk.filter((k) => TERMS.test(T.zh[k]));
    assertEqual(hit.length, 0, '面板字典出现内部术语：' + hit.map((k) => k + '=' + T.zh[k]).join(' | '));
    for (const code of ['ok', 'key_invalid', 'balance', 'rate_limited', 'model_not_found', 'bad_request', 'thinking_on', 'truncated', 'format', 'network', 'timeout', 'server', 'no_key', 'no_model', 'bad_url']) {
      assert(T.zh['t.' + code + '.title'] !== undefined, '测试结果缺标题：' + code);
      if (code !== 'ok') assert(T.zh['t.' + code + '.rec'] !== undefined && T.zh['t.' + code + '.custom'] !== undefined, '测试结果缺下一步：' + code);
    }
    for (const code of ['write_failed', 'key_format', 'bad_token', 'bad_provider', 'network', 'generic']) assert(T.zh['err.' + code], '接口错误码缺文案：' + code);
  });

  await check('视图 · 首页：推荐无密钥 / 有密钥 / 其他模型三种场景的控件集合；推荐模式不出现模型参数', async () => {
    let v = await viewOf(new Map(), 'home');
    for (const a of ['enabled', 'keyInput', 'saveTest', 'targetLang', 'position', 'uiLang', 'theme', 'stAct', 'nav']) assert(v.acts.has(a), '推荐 · 无密钥缺 ' + a);
    assert(!v.html.includes('均无关联'), '无关联声明放在帮助页的关于区，不上首页（首页保持极简）');
    for (const a of ['keyReplace', 'keyRemove', 'test', 'useRec', 'cTemp', 'cThink']) assert(!v.acts.has(a), '推荐 · 无密钥不该有 ' + a);
    assert(v.vs.has('enterKey'), '状态条动作：填写 API Key');
    assert(v.html.includes('https://platform.deepseek.com/api_keys'), '获取密钥的外链');
    v = await viewOf(withKey('deepseek', 'sk-view-0000000000009'), 'home');
    for (const a of ['keyReplace', 'keyRemove', 'test']) assert(v.acts.has(a), '推荐 · 有密钥缺 ' + a);
    assert(!v.acts.has('keyInput') && !v.acts.has('stAct'), '有密钥且正常时没有输入框、状态条没有动作');
    assert(v.html.includes('0009'), '显示末 4 位');
    const cs = withKey('kimi');
    await POST('/api/config', { mode: 'custom', custom: { provider: 'kimi' } }, cs);
    v = await viewOf(cs, 'home');
    assert(v.acts.has('useRec') && v.acts.has('nav') && !v.acts.has('keyInput'), '其他模型的首页：管理 + 使用推荐模型');
    assert(v.html.includes('kimi-k2.6'), '首页写明正在用的模型');
  });

  await check('视图 · 高级设置：用量与限额；同时请求数上限的当前值与自动降档提示来自服务端', async () => {
    const store = withKey();
    store.set('llmsubs.cache.idx', JSON.stringify([{ k: 'a' }, { k: 'b' }]));
    await POST('/api/config', { fcCap: 48, glossary: [{ s: 'toy model', t: '简化模型' }] }, store);
    const ns = fnv1a('api.deepseek.com|deepseek-flash');
    store.set('llmsubs.fcb', JSON.stringify({ eff: 12, clean: 0, t: Date.now(), cap: 48, ns }));
    const v = await viewOf(store, 'advanced');
    for (const a of ['backfill', 'clearCache', 'fcCap', 'glAdd', 'glDel', 'glEdit']) assert(v.acts.has(a), '高级设置缺 ' + a);
    for (const a of ['cTemp', 'cThink', 'cStep', 'cExtra']) assert(!v.acts.has(a), '推荐模式高级设置不该有模型参数 ' + a);
    assert(/<option value="48" selected>/.test(v.html), '迁移来的 48 临时追加为选项并选中');
    assert(v.html.includes('12'), '自动降档后的当前值要显示出来');
    assert(v.html.includes('2 条') || v.html.includes('2'), '清除译文的说明带条数');
  });

  await check('视图 · 翻译模型：推荐模式只有「使用其他模型」；其他模型模式列出服务商、地址、模型、密钥与参数', async () => {
    let v = await viewOf(withKey(), 'model');
    assert(v.acts.has('useCustom') && !v.acts.has('cProvider'), '推荐模式');
    const store = new Map();
    await POST('/api/config', { mode: 'custom' }, store);
    v = await viewOf(store, 'model');
    for (const a of ['useRec', 'cProvider', 'cUrl', 'cModelSel', 'keyInput', 'saveTest', 'cTemp', 'cThink', 'cStep', 'cWave2', 'cBfThink', 'cExtra']) assert(v.acts.has(a), '其他模型缺 ' + a);
    assert(/<option value="zhipu" selected>/.test(v.html) && /<option value="glm-5\.2" selected>/.test(v.html), '默认智谱 + glm-5.2');
    assert(/id="paramsReset"[^>]*hidden/.test(v.html) && /id="urlReset"[^>]*hidden/.test(v.html) && /id="paramsEdited"[^>]*hidden/.test(v.html), '没改过参数与地址时恢复按钮与「已修改」隐藏');
    await POST('/api/config', { mode: 'custom', custom: { provider: 'volc', ep: { volc: { url: 'https://ark.example.com/api/v3' } }, temperature: '0.2' } }, store);
    v = await viewOf(store, 'model');
    assert(v.acts.has('cModel') && !v.acts.has('cModelSel'), '没有预设的服务商直接手填模型名');
    assert(!/id="paramsReset"[^>]*hidden/.test(v.html) && !/id="urlReset"[^>]*hidden/.test(v.html), '改过参数与地址时显示恢复按钮');
  });

  await check('视图 · 帮助与诊断：暂停时有恢复翻译；后台翻译任务三种状态；技术详情可展开', async () => {
    const store = withKey();
    store.set('llmsubs.pause', JSON.stringify({ until: Date.now() + 20 * 60000, code: 'balance' }));
    let v = await viewOf(store, 'help');
    for (const a of ['resume', 'copyDiag', 'resetAll']) assert(v.acts.has(a), '帮助页缺 ' + a);
    assert(!v.acts.has('stAct'), '紧凑状态条的修复入口就在本页时不再重复放按钮');
    assert(v.html.includes('https://platform.deepseek.com/top_up'), '余额暂停在推荐模式附充值链接');
    assert(v.html.includes('已暂停：账户余额不足'), v.status.slice(0, 200));
    const s2 = withKey();
    await panel({ url: U + '/', store: s2 });
    v = await viewOf(s2, 'help');
    assert(v.html.includes('尚未运行'), '刚打开面板、cron 还没跑');
    const s3 = withKey();
    s3.set('llmsubs.panel.first', String(Date.now() - 3600000));
    v = await viewOf(s3, 'help');
    assert(v.html.includes('请在小火箭中重新安装模块'), '开面板一小时了 cron 一次没跑');
    const s4 = withKey();
    s4.set('llmsubs.cron.n', '30'); s4.set('llmsubs.cron.first', String(Date.now() - 1800000)); s4.set('llmsubs.cron.last', String(Date.now() - 20000));
    v = await viewOf(s4, 'help');
    assert(v.html.includes('正常'), 'cron 在跑');
    assert(!v.acts.has('resume'), '不暂停时没有恢复翻译');
    assert(v.html.includes('Shadowrocket、DeepSeek 均无关联') && v.html.includes('条款'), '关于区要有无关联声明与服务条款提示（首页只推荐 DeepSeek，也要写明和它无关联）');
    assert(v.html.includes('代号') && v.html.includes('使用时间') && !v.html.includes('视频 ID'), '复制诊断的提示要照实写');
    const s5 = withKey();
    await POST('/api/config', { uiLang: 'en' }, s5);
    v = await viewOf(s5, 'help');
    assert(v.html.includes('not affiliated with YouTube, Shadowrocket or DeepSeek') && v.html.includes('terms'), '英文界面的关于区也要有声明');
    assert(/codes/.test(v.html) && /usage times/.test(v.html) && !/video IDs/i.test(v.html), '英文的复制诊断提示也要照实写');
  });

  await check('视图 · 状态条覆盖每一种状态码，二级页收成紧凑样式；余额偏低单独一张提示卡', async () => {
    const cases = [
      ['off', (s) => POST('/api/config', { enabled: false }, s), '已关闭'],
      ['paused_errors', (s) => s.set('llmsubs.cb', JSON.stringify({ until: Date.now() + 120000 })), '暂时暂停'],
      ['paused_balance', (s) => s.set('llmsubs.pause', JSON.stringify({ until: Date.now() + 120000, code: 'balance' })), '账户余额不足'],
    ];
    for (const [code, prep, text] of cases) {
      const store = withKey();
      await prep(store);
      const v = await viewOf(store, 'home');
      assert(v.status.includes(text), code + ' 的状态条：' + v.status.slice(0, 160));
      const c = await viewOf(store, 'advanced');
      assert(/yt-st compact/.test(c.status), code + ' 在二级页是紧凑样式');
    }
    const store = withKey();
    store.set('llmsubs.cb', JSON.stringify({ warn: { code: 'low_balance', at: Date.now() } }));
    const v = await viewOf(store, 'home');
    assertEqual((v.status.match(/class="yt-st/g) || []).length, 2, '正常卡 + 余额偏低提示卡');
  });

  await check('页面 · 保存并测试：服务端没存下密钥时输入框内容保留；非测试错误码不进结果区', async () => {
    const store = new Map();
    await POST('/api/config', { mode: 'custom', custom: { provider: 'custom' } }, store);
    const g = await GET('/api/config', store);
    const sb = pageSandbox();
    sb.load(g, null); sb.show('model');
    const toasts = []; sb.toast = (m) => toasts.push(m);
    sb.document.getElementById('keyInput').value = 'sk-keep-me-0000000000';
    sb.api = { test: () => Promise.resolve({ ok: false, code: 'bad_url', saved: false, keys: {}, status: g.status }) };
    sb.runTest(true);
    await new Promise((r) => setTimeout(r, 30));
    assertEqual(sb.S.testing, false);
    assertEqual(sb.S.keyDraft, 'sk-keep-me-0000000000', '没存下就保留草稿');
    assert(sb.document.getElementById('keyBox').innerHTML.includes('value="sk-keep-me-0000000000"'), '输入框里仍是用户填的密钥');
    sb.S.cooling = false;
    sb.api = { test: () => Promise.resolve({ ok: false, code: 'bad_token' }) };
    sb.runTest(false);
    await new Promise((r) => setTimeout(r, 30));
    assertEqual(sb.S.test, null, '接口错误不当成测试结果显示');
    assert(toasts.some((m) => /刷新/.test(m)), '按错误码提示：' + JSON.stringify(toasts));
  });

  await check('页面 · 保存串行：第二次保存等第一次落地才发出，先发的响应不覆盖后发的值', async () => {
    const g = await GET('/api/config', withKey());
    const sb = pageSandbox();
    sb.load(g, null); sb.show('home'); sb.toast = () => {};
    const sent = []; let releaseFirst;
    const withPos = (pos) => Object.assign({}, g, { cfg: Object.assign({}, g.cfg, { position: pos }) });
    sb.api = {
      saveConfig: (patch) => { sent.push(patch.position); return sent.length === 1 ? new Promise((r) => { releaseFirst = () => r(withPos('above')); }) : Promise.resolve(withPos('below')); },
      getConfig: () => Promise.resolve(g),
    };
    const p1 = sb.change({ position: 'above' });
    const p2 = sb.change({ position: 'below' });
    await new Promise((r) => setTimeout(r, 30));
    assertEqual(sent.length, 1, '第一次还没落地，第二次不能发');
    assertEqual(sb.S.cfg.position, 'below', '乐观更新立刻显示最后一次点击');
    releaseFirst();
    await p1; await p2;
    assertEqual(sent.join(','), 'above,below', '按点击顺序发出');
    assertEqual(sb.S.cfg.position, 'below', '最终停在最后一次点击的值');
    assertEqual(sb.S.pending, 0);
  });

  await check('页面 · landed 判据：只看 patch 自己的键——写丢了但服务端另有差异 → 没落地；写成功但被规范化 → 落地', async () => {
    const sb = pageSandbox();
    assertEqual(sb.landed({ a: 9, b: 1 }, { a: 1, b: 1 }, { b: 2 }), false, '写丢了：不能因为 a 变了就报成功');
    assertEqual(sb.landed({ t: '0.2' }, { t: '' }, { t: '0.20' }), true, '服务端规范化过的值也算落地');
    assertEqual(sb.landed({ b: 2 }, { b: 1 }, { b: 2 }), true, '原样写进去');
    assertEqual(sb.landed({ b: 1 }, { b: 1 }, { b: 2 }), false, '值没动就是没写进去');
    assertEqual(sb.landed(null, {}, { b: 2 }), false);
  });

  await check('页面 · keepView 保存失败回滚时整页重画：控件不能停在用户点的那个值', async () => {
    const store = withKey();
    await POST('/api/config', { mode: 'custom', custom: { provider: 'zhipu' } }, store);
    const g = await GET('/api/config', store);
    const sb = pageSandbox(); sb.load(g, null); sb.show('model'); sb.toast = () => {};
    const renders = []; const origRender = sb.render; sb.render = (regions) => { renders.push(regions || 'FULL'); return origRender(regions); };
    const server = JSON.parse(JSON.stringify(g));   // 服务端的快照：与页面里被乐观更新改过的 S.cfg 不是同一个对象
    sb.api = { saveConfig: () => Promise.reject({ network: true }), getConfig: () => Promise.resolve(server) };
    const ok = await sb.change({ custom: Object.assign({}, g.cfg.custom, { temperature: '0.9' }) }, { keepView: true, quiet: true });
    assertEqual(ok, false);
    assertEqual(renders[renders.length - 1], 'FULL', '回滚后最后一次重绘必须是整页：' + JSON.stringify(renders));
    assertEqual(sb.S.cfg.custom.temperature, server.cfg.custom.temperature, '配置回滚');
  });

  await check('页面 · 轮询作废：在途的旧快照不能打回刚做完的操作；在途时的补偿刷新排队再跑一次', async () => {
    const store = withKey();
    store.set('llmsubs.pause', JSON.stringify({ until: Date.now() + 60000, code: 'balance' }));
    const paused = await GET('/api/config', store);
    assertEqual(paused.status.code, 'paused_balance');
    const okStatus = Object.assign({}, paused.status, { code: 'ok' });
    const fresh = Object.assign({}, paused, { status: okStatus });
    const sb = pageSandbox(); sb.load(paused, null); sb.show('home'); sb.toast = () => {};
    let gets = 0;
    sb.api = {
      // 第一次是恢复之前发出的旧快照（仍显示暂停）、之后才是服务端的新状态
      getConfig: () => { gets++; const snap = gets === 1 ? paused : fresh; return new Promise((r) => setTimeout(() => r(snap), 30)); },
      diag: () => Promise.resolve(null),
      resume: () => Promise.resolve({ ok: true, status: okStatus }),
    };
    sb.refreshLive();
    sb.doResume();
    await new Promise((r) => setTimeout(r, 10));
    assertEqual(sb.S.status.code, 'ok', '恢复的响应先落定');
    await new Promise((r) => setTimeout(r, 80));
    assertEqual(sb.S.status.code, 'ok', '晚到的旧快照必须作废，不能把「暂停」又画回来');
    assert(gets >= 2, '补偿刷新在在途那次结束后自动再跑一次：' + gets);
  });

  await check('页面 · 同时请求数下拉框的选项值也要转义：接口交回的值不能原样拼进 HTML', async () => {
    // 服务端现在只会交回 auto 或 1–96 的整数，这条路平时走不到；页面带着令牌、能改密钥，不能指望接口永远守规矩
    const g = await GET('/api/config', withKey());
    g.cfg.fcCap = '7"><i id="x">';
    const sb = pageSandbox(); sb.load(g, null);
    const v = sb.show('advanced');
    assert(v.html.includes('data-act="fcCap"'), '前提：高级设置页画出了同时请求数下拉框');
    assert(!v.html.includes('"><i id="x">'), '选项值原样进了 HTML：引号与尖括号没有转义');
    assert(v.html.includes('value="7&quot;&gt;&lt;i id=&quot;x&quot;&gt;"'), '选项值应当转义后放进 value 属性');
  });

  await check('页面 · 测试连接先等保存队列落地；非测试结果码不冷却按钮', async () => {
    const g = await GET('/api/config', withKey());
    const sb = pageSandbox(); sb.load(g, null); sb.show('home'); sb.toast = () => {};
    let release; sb.S.saveQ = new Promise((r) => { release = r; });
    let tested = 0; sb.api = { test: () => { tested++; return Promise.resolve({ ok: false, code: 'bad_token' }); } };
    sb.runTest(false);
    await new Promise((r) => setTimeout(r, 20));
    assertEqual(tested, 0, '保存还没落地不能发测试');
    release();
    await new Promise((r) => setTimeout(r, 20));
    assertEqual(tested, 1);
    assertEqual(sb.S.cooling, false, '没打到端点就不冷却'); assertEqual(sb.S.testing, false);
    sb.api = { test: () => Promise.resolve({ ok: true, code: 'ok', ms: 900, rating: 'fast', lines: { sent: 12, got: 12 } }) };
    sb.runTest(false);
    await new Promise((r) => setTimeout(r, 20));
    assertEqual(sb.S.cooling, true, '真的测过才冷却'); assertEqual(sb.S.test && sb.S.test.code, 'ok');
  });

  await check('页面 · 密钥草稿按槽位：给 A 服务商填到一半的密钥不出现在 B 服务商的输入框里', async () => {
    const store = new Map();
    await POST('/api/config', { mode: 'custom', custom: { provider: 'zhipu' } }, store);
    const g = await GET('/api/config', store);
    const sb = pageSandbox(); sb.load(g, null); sb.S.route = 'home'; sb.S.keyEdit = true;
    sb.S.keyDraft = 'sk-half-typed-for-deepseek'; sb.S.keyDraftSlot = 'deepseek';
    assert(!sb.viewKeyBox().includes('sk-half-typed'), '别家的草稿不回填');
    sb.S.keyDraftSlot = 'zhipu';
    assert(sb.viewKeyBox().includes('value="sk-half-typed-for-deepseek"'), '本槽位的草稿回填');
  });

  await check('页面 · 序号闸：先发的保存响应回来时，页面仍停在用户最后点的值；adjusted 触发整页重绘与提示', async () => {
    const g = await GET('/api/config', withKey());
    const sb = pageSandbox(); sb.load(g, null); sb.show('home');
    const toasts = []; sb.toast = (m) => toasts.push(m);
    const withPos = (pos) => Object.assign({}, g, { cfg: Object.assign({}, g.cfg, { position: pos }) });
    let releaseFirst, releaseSecond;
    sb.api = {
      saveConfig: (patch) => new Promise((r) => { if (patch.position === 'above') releaseFirst = () => r(withPos('above')); else releaseSecond = () => r(withPos('below')); }),
      getConfig: () => Promise.resolve(g),
    };
    const p1 = sb.change({ position: 'above' }); const p2 = sb.change({ position: 'below' });
    await new Promise((r) => setTimeout(r, 10));
    releaseFirst(); await p1;
    assertEqual(sb.S.cfg.position, 'below', '第一次的响应被序号闸跳过，不能把页面改回 above');
    await new Promise((r) => setTimeout(r, 10));
    releaseSecond(); await p2;
    assertEqual(sb.S.cfg.position, 'below');
    const renders = []; const origRender = sb.render; sb.render = (regions) => { renders.push(regions || 'FULL'); return origRender(regions); };
    sb.api = { saveConfig: () => Promise.resolve(Object.assign({}, g, { adjusted: ['fcCap'] })), getConfig: () => Promise.resolve(g) };
    await sb.change({ fcCap: 999 }, { keepView: true });
    assertEqual(renders[renders.length - 1], 'FULL', '被夹取过就整页重绘');
    assert(toasts.some((m) => m === sb.t('sv.adjusted')), '并提示：' + JSON.stringify(toasts));
  });

  await check('页面 · syncView：keepView 保存落地后同步「已修改」标签与恢复按钮的显示', async () => {
    const store = new Map();
    await POST('/api/config', { mode: 'custom', custom: { provider: 'zhipu' } }, store);
    const g = await GET('/api/config', store);
    const sb = pageSandbox(); sb.load(g, null); sb.show('model');
    const el = (id) => sb.document.getElementById(id);
    sb.S.cfg.custom.temperature = '0.9'; sb.syncView();
    assertEqual(el('paramsEdited').hidden, false, '改过参数：显示「已修改」'); assertEqual(el('paramsReset').hidden, false);
    delete sb.S.cfg.custom.temperature; sb.syncView();
    assertEqual(el('paramsEdited').hidden, true, '改回兜底值：隐藏'); assertEqual(el('paramsReset').hidden, true);
  });

  await check('响应头：禁止被嵌套（X-Frame-Options: DENY）与 nosniff——面板自带令牌，被 iframe 进去就能点击劫持', async () => {
    for (const p of ['/', '/api/config', '/api/diag']) {
      const { res } = await panel({ url: U + p, store: new Map() });
      assertEqual(res.headers['X-Frame-Options'], 'DENY', p); assertEqual(res.headers['X-Content-Type-Options'], 'nosniff', p);
    }
  });

  await check('页面：不开放给用户的配置项与操作不出现控件；DEFAULTS 仍是出厂值的唯一来源', async () => {
    const { res } = await panel({ url: U + '/', store: new Map() });
    for (const k of ['budgetMs', 'fastBudgetMs', 'requestTimeout', 'nlProbe', 'xmlNewline', 'qualityModel', 'chunkSize', 'systemPrompt', 'userPrefix', 'cache', 'copyReqlog', 'clearDiag', 'factory']) {
      assert(!new RegExp('data-(act|k)="' + k + '"').test(res.body), k + ' 不开放给用户，面板不该有它的控件');
    }
    assert(/\n\s*fastConcurrency:\s*\d+,/.test(PANEL) && /\n\s*backfillConcurrency:\s*\d+,/.test(PANEL), 'DEFAULTS 仍是出厂值的唯一来源');
  });

  section('面板交互：乐观更新与误报防护');

  /* 页面里不依赖 DOM 的那部分（change / settle / landed）单独抽出来跑：桩掉 render / toast / api，
     就能验「开关立刻跟手」和「写成功了就别报错」。 */
  function pageFn(name) {
    const i = PANEL_HTML.indexOf('function ' + name + '(');
    assert(i >= 0, 'panel.html 里应有 ' + name + '()');
    return PANEL_HTML.slice(i, PANEL_HTML.indexOf('\n}', i) + 2);
  }
  function uiRun(opts) {
    const toasts = [], renders = [];
    const sb = {
      JSON, Object, Promise, String, setTimeout, console: { log() {} },
      clone: (o) => JSON.parse(JSON.stringify(o)),
      has: (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k),
      S: { cfg: { enabled: true, position: 'below', custom: { provider: 'zhipu', ep: {} } }, saved: null },
      LANG: 'zh', T: { zh: { 'err.network': 'x', 'err.write_failed': 'y' } },
      t: (k, v) => k + (v && v.reason ? ':' + v.reason : ''), toast: (m) => toasts.push(m), ask: () => Promise.resolve(true),
      resolveLang: () => 'zh', applyTheme: () => {}, markStale: () => { sb.S.stale = true; },
      api: { saveConfig: opts.save, getConfig: () => Promise.resolve({ ok: true, cfg: opts.serverCfg, saved: { v: 4, d: {} } }) },
    };
    sb.render = () => renders.push(JSON.parse(JSON.stringify(sb.S.cfg)));
    vm.createContext(sb);
    new vm.Script([pageFn('settle'), pageFn('landed'), pageFn('change'), pageFn('errText')].join('\n')).runInContext(sb);
    return sb.change(opts.patch, {}).then(() => ({ toasts, renders, cfg: sb.S.cfg, S: sb.S }));
  }
  const OFF = { enabled: false, position: 'below', custom: { provider: 'zhipu', ep: {} } };
  const ON = { enabled: true, position: 'below', custom: { provider: 'zhipu', ep: {} } };

  await check('开关立刻跟手：不等一次往返，第一次重绘就是用户点的那个值', async () => {
    const r = await uiRun({ save: () => new Promise((res) => setTimeout(() => res({ ok: true, cfg: OFF, saved: {} }), 50)), serverCfg: OFF, patch: { enabled: false } });
    assertEqual(r.renders[0].enabled, false, '乐观更新，不等服务端');
    assertEqual(r.cfg.enabled, false);
  });

  await check('【回归】写成功但响应丢了：不报错、开关也不许弹回去', async () => {
    const r = await uiRun({ save: () => Promise.reject({ network: true }), serverCfg: OFF, patch: { enabled: false } });
    assertEqual(r.cfg.enabled, false, '写进去了就该保持关掉');
    assert(!r.toasts.some((m) => m.indexOf('sv.failed') >= 0), '不该弹失败提示：' + JSON.stringify(r.toasts));
  });

  await check('真没写进去才回滚，并按错误码报出原因', async () => {
    let r = await uiRun({ save: () => Promise.reject({ network: true }), serverCfg: ON, patch: { enabled: false } });
    assertEqual(r.cfg.enabled, true, '没写进去就该回到原值');
    assert(r.toasts.some((m) => m === 'sv.failed:err.network'), JSON.stringify(r.toasts));
    r = await uiRun({ save: () => Promise.resolve({ ok: false, code: 'write_failed' }), serverCfg: ON, patch: { enabled: false } });
    assert(r.toasts.some((m) => m === 'sv.failed:err.write_failed'), JSON.stringify(r.toasts));
    r = await uiRun({ save: () => Promise.resolve({ ok: false, code: 'stale_page' }), serverCfg: ON, patch: { enabled: false } });
    assertEqual(r.S.stale, true, 'stale_page 转成「请刷新」状态'); assertEqual(r.cfg.enabled, true);
  });

  await check('每个 JSON 路由都带 ok：少一个就会被页面的失败兜底当成写失败', async () => {
    for (const [m, p, b] of [['GET', '/api/config'], ['GET', '/api/diag'], ['POST', '/api/diag/clear'], ['POST', '/api/config/reset'], ['POST', '/api/resume'], ['POST', '/api/cache/clear'], ['POST', '/api/key', { provider: 'kimi', key: 'sk-1' }], ['POST', '/api/config', { position: 'above' }]]) {
      const j = m === 'GET' ? await GET(p, new Map()) : await POST(p, b || {}, new Map());
      assert(Object.prototype.hasOwnProperty.call(j, 'ok'), m + ' ' + p + ' 的响应里必须有 ok');
      assertEqual(j.ok, true, m + ' ' + p);
    }
  });

  await check('面板响应一律 no-store：页面里嵌着按设备令牌，被缓存住就会拿旧令牌去写', async () => {
    for (const p of ['/', '/api/config']) {
      const { res } = await panel({ url: U + p, store: new Map() });
      assertEqual(String(res.headers['Cache-Control'] || ''), 'no-store', p + ' 的响应应当禁用缓存');
    }
  });

  summary();
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
