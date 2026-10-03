'use strict';
/*
 * 翻译角色的离线测试总入口。同一角色的后台补翻（cron 钩子）与探针里的观察者角色也在这里。
 *
 *   node test/run.js                  全部跑一遍（要几分钟：不少用例断言的是实际耗时）
 *   node test/run.js formats retry    只跑指定的文件（translate/ 下的文件名，不带 .js）
 *
 * 用例按主题放在 translate/ 下，每个文件导出一个 async 函数，里面按小节顺序登记用例；
 * 共用的断言与汇总在 lib/harness.js，沙箱、假端点与字幕样本在 lib/sandbox.js。
 * 不发真实的网络请求。
 *
 * 标了「回归」的用例各对应一个修过的缺陷，改代码时别让它们变红。
 */

const fs = require('fs');
const path = require('path');
const { fail, stats, summary } = require('./lib/harness');

// 执行顺序，也是目录：新文件必须登记在这里，否则启动时报错，防止新用例被静默漏跑。
const SUITES = [
  ['formats',    '字幕格式：json3、srv3、srv1、WebVTT 的解析、双语合并与写回'],
  ['resilience', '兜底：fail-open、超时与部分降级、用量上限、错误处理与熔断'],
  ['security',   '安全：密钥与出站面、字幕是不可信输入'],
  ['request',    '发请求之前：配置来源、缓存、切批、请求体'],
  ['prompt',     '提示词：内置与自定义、轨道类型、术语表、标点兜底、重试提示'],
  ['providers',  '服务商兼容与端点脾气的自动适配'],
  ['retry',      '模型交回的不对：漏行拆批重试、整批回显检测；附档位路由'],
  ['waves',      '波次与并发：首波能铺多远、失败批拆半、撞 429 退档'],
  ['probes',     '探针与观察者：只记形状与计数，隐私红线'],
  ['backfill',   '后台补翻：待翻队列、cron 角色、体积闸、宽限期'],
  ['defaults',   '出厂值冒烟：不开探针，按脚本自己的出厂值跑用户看得见的几条路径'],
];

const DIR = path.join(__dirname, 'translate');
// extra/ 下的文件也当用例文件跑，排在最后；这个目录可以不存在，里面的文件不用登记进 SUITES
const EXTRA_DIR = path.join(__dirname, 'extra');
const EXTRA = fs.existsSync(EXTRA_DIR) ? fs.readdirSync(EXTRA_DIR).filter((f) => f.endsWith('.js')).sort().map((f) => [f.slice(0, -3), '附加检查']) : [];
const ALL = SUITES.concat(EXTRA);
const dirOf = (name) => (SUITES.some(([n]) => n === name) ? DIR : EXTRA_DIR);

// 目录里的文件与登记表一一对应：多了是漏登记，少了是登记表过期
function checkRegistry() {
  const onDisk = fs.readdirSync(DIR).filter((f) => f.endsWith('.js')).map((f) => f.slice(0, -3));
  const listed = SUITES.map(([name]) => name);
  const unlisted = onDisk.filter((n) => !listed.includes(n));
  const missing = listed.filter((n) => !onDisk.includes(n));
  if (unlisted.length) throw new Error('translate/ 下有文件没登记在 SUITES 里：' + unlisted.join(', '));
  if (missing.length) throw new Error('SUITES 登记了不存在的文件：' + missing.join(', '));
  const clash = EXTRA.map(([name]) => name).filter((n) => listed.includes(n));
  if (clash.length) throw new Error('extra/ 下的文件和 translate/ 下的重名：' + clash.join(', '));
}

// 用例文件从 lib/ 解构出来的名字必须真的存在：拼错的名字只会悄悄变成 undefined，
// 用例变红时的报错（比如「返回条数不符」）离真正的原因很远。启动时对全部文件跑一遍，不等跑到它才报。
// 认单引号 / 双引号、带不带 .js、别名解构（{ assert: ok }）；一个文件一处 lib/ 的 require 都没认出来
// 也报错——那说明写法变了、这道闸对它没生效。
const IMPORT_RE = /const \{([^}]+)\}\s*=\s*require\((['"])\.\.\/lib\/([\w-]+?)(?:\.js)?\2\)/g;
function checkImports(name) {
  const src = fs.readFileSync(path.join(dirOf(name), name + '.js'), 'utf8');
  let seen = 0;
  for (const [, names, , mod] of src.matchAll(IMPORT_RE)) {
    seen++;
    const exported = require('./lib/' + mod);   // 模块不存在会在这里直接抛
    for (const n of names.split(',').map((s) => s.split(':')[0].trim()).filter(Boolean)) {
      if (!(n in exported)) throw new Error(name + '.js 从 lib/' + mod + '.js 解构了不存在的 ' + n);
    }
  }
  if (!seen) throw new Error(name + '.js 里没认出任何 lib/ 的 require，这道闸对它没生效');
}

function pickSuites(argv) {
  if (!argv.length) return ALL;
  const known = ALL.map(([name]) => name);
  const unknown = argv.filter((n) => !known.includes(n));
  if (unknown.length) throw new Error('没有这个文件：' + unknown.join(', ') + '\n可选：' + known.join(' '));
  return ALL.filter(([name]) => argv.includes(name));
}

// 必须串行：二十多条用例断言的是实际耗时，并行跑会互相挤，集体变红
async function main() {
  checkRegistry();
  for (const [name] of ALL) checkImports(name);   // 全部文件，不只是这次要跑的
  const picked = pickSuites(process.argv.slice(2));
  for (const [name] of picked) {
    const before = stats();
    try {
      await require(path.join(dirOf(name), name))();
    } catch (e) {
      fail(name + '.js 整个文件中断', e);   // 用例之外抛出的错（require 就炸、夹具读不到…）：只毁这一个文件，其余照跑
    }
    const after = stats();
    if (after.passed === before.passed && after.failed === before.failed) fail(name + '.js 一项用例都没跑到', new Error('导出的函数没有登记任何用例'));
  }
  if (picked.length < ALL.length) console.log('\n（只跑了 ' + picked.length + ' / ' + ALL.length + ' 个文件）');
  summary();
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
