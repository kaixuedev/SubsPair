'use strict';
/*
 * 测试框架：登记用例、断言、打小节标题、最后汇总。
 *
 * 它不认识被测的脚本，也不得依赖 sandbox.js（sandbox.js 依赖这里的 assert，反向引用会成环，
 * 拿到的是还没填完的导出对象）。翻译角色的沙箱与假端点都在 sandbox.js 里。
 *
 * 计数是模块级的：同一进程里所有文件登记的用例共用一份，跑完调一次 summary() 一起算。
 */

let passed = 0;
const failures = [];

function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log('  \x1b[32m✓\x1b[0m ' + name); })
    .catch((e) => fail(name, e));
}

// 记一条失败。check() 用它，入口也用它记「用例之外抛出的错」（比如整个文件在 require 时就炸了）
function fail(name, e) {
  failures.push({ name, message: e && e.message });
  console.log('  \x1b[31m✗\x1b[0m ' + name + '\n      ' + (e && e.message));
}

// 当前计数，给入口核对「这个文件到底跑了几项」。不直接导出 passed：CommonJS 导出的是值的快照，会永远停在 0
function stats() {
  return { passed, failed: failures.length };
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error((msg || '') + '\n      期望: ' + JSON.stringify(expected) + '\n      实际: ' + JSON.stringify(actual));
  }
}

// 小节标题：加粗打印，和用例的 ✓ / ✗ 行区分开
function section(title) {
  console.log('\n\x1b[1m' + title + '\x1b[0m');
}

// 汇总：打印通过与失败的清单；有失败就把退出码置 1
function summary() {
  console.log('\n' + '─'.repeat(58));
  if (failures.length === 0) {
    console.log('\x1b[32m全部 ' + passed + ' 项通过\x1b[0m\n');
  } else {
    console.log('\x1b[31m' + failures.length + ' 项失败\x1b[0m（' + passed + ' 项通过）\n');
    for (const f of failures) console.log('  ✗ ' + f.name + '\n    ' + f.message + '\n');
    process.exitCode = 1;
  }
}

module.exports = { check, assert, assertEqual, section, fail, stats, summary };
