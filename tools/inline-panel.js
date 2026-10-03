#!/usr/bin/env node
/*
 * 把 panel/panel.html 回填进 ytsub.js 的 pageLines()。
 *
 *   node tools/inline-panel.js          回填
 *   node tools/inline-panel.js --check  只比对，不一致则退出码 1（测试用）
 *
 * 做三件事：① 把页面里 MOCK-API 标记之间的模拟接口换成 panel/api.real.js；
 * ② 补上 doctype / head / body 骨架；③ 逐行 JSON.stringify 成字符串数组，
 * 写进 ytsub.js 的 @@PANEL-START@@ / @@PANEL-END@@ 之间。
 * 这是开发期工具，不是运行时构建：仓库里的 ytsub.js 仍是单文件。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HTML = path.join(ROOT, 'panel', 'panel.html');
const REAL = path.join(ROOT, 'panel', 'api.real.js');
const JS = path.join(ROOT, 'ytsub.js');

function build() {
  const html = fs.readFileSync(HTML, 'utf8');
  const real = fs.readFileSync(REAL, 'utf8').trim();
  const MS = '/* @@MOCK-API-START@@ */', ME = '/* @@MOCK-API-END@@ */';
  const a = html.indexOf(MS), b = html.indexOf(ME);
  if (a < 0 || b < 0 || b < a) throw new Error('panel.html 缺少 MOCK-API 标记');
  let page = html.slice(0, a) + real + '\n' + html.slice(b + ME.length);
  const split = page.indexOf('<div class="ytx"');
  if (split < 0) throw new Error('panel.html 里找不到 <div class="ytx"');
  page = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="ytsub-token" content="@@TOK@@"><meta name="apple-mobile-web-app-title" content="SubsPair">\n' +
    page.slice(0, split).trim() + '\n</head><body>\n' + page.slice(split).trim() + '\n</body></html>';
  // 只放行 data: 形式的 <link href>（添加到主屏幕的图标）；任何外部脚本与样式一律拒绝
  if (/<script[^>]+src=|<link[^>]+href=(?!["']data:)/i.test(page)) throw new Error('页面不得引用外部脚本或样式');
  // JSON.stringify 不转义 U+2028/U+2029，而它们是 JS 的行终止符：混进一个就会在字符串字面量中间断行
  const esc = (str) => str.replace(new RegExp(String.fromCharCode(0x2028), 'g'), '\\u2028').replace(new RegExp(String.fromCharCode(0x2029), 'g'), '\\u2029');
  return page.split('\n').map((l) => esc(JSON.stringify(l)) + ',').join('\n');
}

function splice(js, block) {
  const PS = '/* @@PANEL-START@@', PE = '/* @@PANEL-END@@ */';
  const i = js.indexOf(PS), j = js.indexOf(PE);
  if (i < 0 || j < 0 || j < i) throw new Error('ytsub.js 缺少 PANEL 标记');
  const lineEnd = js.indexOf('\n', i);
  return js.slice(0, lineEnd + 1) + block + '\n' + js.slice(j);
}

const js = fs.readFileSync(JS, 'utf8');
const out = splice(js, build());
if (process.argv.includes('--check')) {
  if (out !== js) { console.error('ytsub.js 里的面板与 panel/panel.html 不一致：请运行 node tools/inline-panel.js'); process.exit(1); }
  console.log('面板已是最新');
} else {
  fs.writeFileSync(JS, out);
  console.log('已回填 ' + out.split('\n').length + ' 行的 ytsub.js（面板 ' + build().split('\n').length + ' 行）');
}
