/* 真实接口（由 tools/inline-panel.js 替换掉 panel.html 里 MOCK-API 标记之间的模拟实现）。
   路由都在 ytsub.js 的面板角色里；这里只做「打接口 → 原样交回结构化结果」，文案由页面按 code 查字典。
   约定：
     · 服务端的业务结果（含 {ok:false, code}）一律 resolve；
     · 请求没送达、超时、响应不是 JSON 时 reject {network:true}，页面据此显示「无法连接到面板服务」；
     · 每个请求都带页面版本 pv（GET 在 query 里，POST 在 body 里），POST 另带按设备令牌 tok。
       脚本更新后旧页面会收到 stale_page，由页面提示刷新。                                    */
var PV = '@@VER@@';
var TOK = (function () { var m = document.querySelector('meta[name="ytsub-token"]'); return (m && m.getAttribute('content')) || ''; })();
function jfetch(path, body, timeoutMs) {
  var opt = { method: body ? 'POST' : 'GET', headers: {}, cache: 'no-store', credentials: 'same-origin' }, url = path;
  if (body) {
    var b = {}, k;
    for (k in body) if (Object.prototype.hasOwnProperty.call(body, k)) b[k] = body[k];
    b.tok = TOK; b.pv = PV;
    opt.headers['Content-Type'] = 'application/json';
    opt.body = JSON.stringify(b);
  } else {
    url += (url.indexOf('?') < 0 ? '?' : '&') + 'pv=' + encodeURIComponent(PV);
  }
  return new Promise(function (resolve, reject) {
    var done = false;
    // 小火箭没开或脚本卡住时 fetch 可能一直挂着：按钮不能永远停在「正在测试」
    var timer = setTimeout(function () { if (!done) { done = true; reject({ network: true, timeout: true }); } }, timeoutMs || 15000);
    fetch(url, opt).then(function (r) {
      return r.text().then(function (txt) {
        var j = null;
        try { j = JSON.parse(txt); } catch (e) {}
        if (done) return;
        done = true; clearTimeout(timer);
        if (!j || typeof j !== 'object') { reject({ network: true, http: r.status }); return; }
        if (j.code === 'stale_page' && typeof markStale === 'function') markStale();
        resolve(j);
      });
    }).then(null, function () {
      if (done) return;
      done = true; clearTimeout(timer);
      reject({ network: true });
    });
  });
}
var api = {
  getConfig: function () { return jfetch('/api/config'); },
  saveConfig: function (patch) { return jfetch('/api/config', patch); },
  setKey: function (o) { return jfetch('/api/key', o); },
  // 脚本那边测试连接整体最多 10 秒（含端点不认 system 角色时的一次重试），这里多留几秒
  test: function (o) { return jfetch('/api/test', o || {}, 15000); },
  resume: function () { return jfetch('/api/resume', {}); },
  clearCache: function () { return jfetch('/api/cache/clear', {}); },
  resetConfig: function () { return jfetch('/api/config/reset', {}); },
  diag: function () { return jfetch('/api/diag'); }
};
