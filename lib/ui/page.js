/**
 * 面板页面（M6）。刻意做成**一个自包含字符串**：
 * 没有构建步骤、没有外部 CDN、没有静态文件路由——`lib/` 里只有 JS，装进 profile 也不会缺资源。
 *
 * 页面只读：拉 `/api/overview`、`/api/graph`、`/api/audit`，用 canvas 画图，用 DOM 拼表格。
 */
export function renderDashboard()         {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GraphFS · 一致性图面板</title>
<style>
  :root {
    --bg: #0f1115; --panel: #171a21; --line: #262b36; --text: #d7dce5; --dim: #8b94a7;
    --accent: #7aa2f7; --ok: #6cc48b; --warn: #e0af68; --bad: #f07178; --info: #7dcfff;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text);
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", sans-serif; }
  header { display: flex; align-items: center; gap: 16px; padding: 14px 20px; border-bottom: 1px solid var(--line);
    background: var(--panel); position: sticky; top: 0; z-index: 5; }
  .brand { font-weight: 700; letter-spacing: .3px; }
  .brand span { color: var(--dim); font-weight: 400; margin-left: 6px; }
  .root { flex: 1; color: var(--dim); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .actions { display: flex; align-items: center; gap: 12px; font-size: 12px; color: var(--dim); }
  button { background: #232936; color: var(--text); border: 1px solid var(--line); border-radius: 6px;
    padding: 5px 12px; cursor: pointer; font-size: 13px; }
  button:hover { border-color: var(--accent); color: #fff; }
  main { padding: 16px 20px 40px; max-width: 1400px; margin: 0 auto; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 10px; margin-bottom: 14px; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; }
  .card .k { color: var(--dim); font-size: 11px; letter-spacing: .4px; text-transform: uppercase; }
  .card .v { font-size: 22px; font-weight: 700; margin-top: 2px; }
  .card.bad .v { color: var(--bad); } .card.warn .v { color: var(--warn); } .card.ok .v { color: var(--ok); }
  .banner { border-radius: 8px; padding: 10px 14px; margin-bottom: 14px; border: 1px solid var(--line);
    background: var(--panel); color: var(--dim); }
  .banner.bad { border-color: #5b2b32; color: #ffb3b8; background: #2a1a1d; }
  .banner.ok { border-color: #24402e; color: #a8e0bb; background: #16211a; }
  .tabs { display: flex; gap: 6px; margin-bottom: 12px; border-bottom: 1px solid var(--line); }
  .tabs button { border: none; background: transparent; border-bottom: 2px solid transparent; border-radius: 0;
    padding: 8px 12px; color: var(--dim); }
  .tabs button.active { color: var(--text); border-bottom-color: var(--accent); }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .8px; color: var(--dim); margin: 20px 0 8px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { color: var(--dim); font-weight: 500; font-size: 11px; text-transform: uppercase; letter-spacing: .5px; }
  code, .mono { font-family: "SF Mono", ui-monospace, Menlo, monospace; font-size: 12px; }
  .muted { color: var(--dim); }
  .pill { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 11px; border: 1px solid var(--line); color: var(--dim); }
  .pill.bad { color: var(--bad); border-color: #5b2b32; } .pill.warn { color: var(--warn); border-color: #4a3a20; }
  .cols { display: grid; grid-template-columns: 1fr 300px; gap: 14px; }
  #pane-graph { display: grid; grid-template-columns: 1fr 320px; gap: 14px; min-height: 560px; }
  .canvas-wrap { position: relative; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
  canvas { display: block; width: 100%; height: 560px; }
  #inspect { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 12px; overflow: auto; max-height: 560px; }
  #inspect h3 { margin: 0 0 6px; font-size: 13px; }
  #inspect .path { color: var(--accent); word-break: break-all; }
  #inspect ul { list-style: none; padding: 0; margin: 8px 0 0; }
  #inspect li { padding: 5px 0; border-bottom: 1px solid var(--line); font-size: 12px; }
  #tooltip { position: absolute; pointer-events: none; background: #0b0d11; border: 1px solid var(--line);
    border-radius: 6px; padding: 6px 9px; font-size: 12px; display: none; max-width: 380px; z-index: 9; }
  .legend { position: absolute; left: 12px; bottom: 10px; font-size: 11px; color: var(--dim);
    display: flex; gap: 12px; flex-wrap: wrap; }
  .legend i { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 4px; }
  .journal { font-family: "SF Mono", ui-monospace, Menlo, monospace; font-size: 12px; }
  .journal .row { display: grid; grid-template-columns: 150px 80px 1fr; gap: 10px; padding: 6px 8px; border-bottom: 1px solid var(--line); }
  .journal .row:hover { background: #1b1f27; }
  .journal .kind { color: var(--info); }
  .empty { color: var(--dim); padding: 8px 0; }
  footer { color: var(--dim); font-size: 11px; margin-top: 24px; }
</style>
</head>
<body>
<header>
  <div class="brand">GraphFS<span>一致性图</span></div>
  <div class="root" id="root">loading…</div>
  <div class="actions">
    <label><input type="checkbox" id="auto"> 自动刷新</label>
    <button id="refresh">刷新</button>
  </div>
</header>
<main>
  <div id="banner" class="banner" hidden></div>
  <section class="cards" id="cards"></section>

  <nav class="tabs">
    <button data-tab="overview" class="active">概览</button>
    <button data-tab="graph">图</button>
    <button data-tab="journal">审计</button>
  </nav>

  <div id="pane-overview">
    <div id="overview"></div>
  </div>

  <div id="pane-graph" hidden>
    <div class="canvas-wrap">
      <canvas id="canvas"></canvas>
      <div id="tooltip"></div>
      <div class="legend" id="legend"></div>
    </div>
    <aside id="inspect"><h3>节点</h3><div class="muted">点击图中的点查看它的关系</div></aside>
  </div>

  <div id="pane-journal" hidden>
    <div class="journal" id="journal"></div>
  </div>

  <footer>
    GraphFS · 只读面板 · 数据来自 <span class="mono" id="graphPath">—</span>
  </footer>
</main>
<script>
(function () {
  'use strict';
  var state = { overview: null, graph: null, positions: null, selected: null, hover: null, dirty: false };
  var colors = { mirror: '#7aa2f7', translates: '#6cc48b', generates: '#e0af68', documents: '#7dcfff', constrains: '#f07178', related: '#8b94a7' };
  var $ = function (id) { return document.getElementById(id); };
  var doc = document;

  function el(tag, cls, text) {
    var node = doc.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function banner(message, kind) {
    var box = $('banner');
    if (!message) { box.hidden = true; return; }
    box.hidden = false;
    box.className = 'banner ' + (kind || '');
    box.textContent = message;
  }
  function getJson(url) {
    return fetch(url, { cache: 'no-store' }).then(function (res) {
      if (!res.ok) throw new Error(url + ' → HTTP ' + res.status);
      return res.json();
    });
  }

  function cards() {
    var box = $('cards'); clear(box);
    var ov = state.overview;
    if (!ov || !ov.hasGraph) {
      box.appendChild(card('状态', '无图', 'warn'));
      return;
    }
    box.appendChild(card('节点', ov.counts.nodes));
    box.appendChild(card('边', ov.counts.edges));
    box.appendChild(card('漂移', ov.drift.length, ov.drift.length ? 'bad' : 'ok'));
    box.appendChild(card('冲突', ov.conflicts.length, ov.conflicts.length ? 'bad' : 'ok'));
    box.appendChild(card('缺失', ov.dangling.length, ov.dangling.length ? 'bad' : 'ok'));
    box.appendChild(card('孤儿', ov.orphans.length, ov.orphans.length ? 'warn' : 'ok'));
    box.appendChild(card('孤立节点', ov.unlinked.length, ov.unlinked.length ? 'warn' : 'ok'));
    box.appendChild(card('审计', ov.journal.length));
  }
  function card(k, v, cls) {
    var node = el('div', 'card' + (cls ? ' ' + cls : ''));
    node.appendChild(el('div', 'k', k));
    node.appendChild(el('div', 'v', v));
    return node;
  }

  function section(title) {
    var wrap = el('div');
    wrap.appendChild(el('h2', null, title));
    return wrap;
  }
  function table(headers) {
    var t = el('table');
    var thead = el('thead');
    var tr = el('tr');
    headers.forEach(function (h) { tr.appendChild(el('th', null, h)); });
    thead.appendChild(tr);
    t.appendChild(thead);
    var body = el('tbody');
    t.appendChild(body);
    t.body = body;
    return t;
  }
  function row(cells) {
    var tr = el('tr');
    cells.forEach(function (cell) {
      var td = el('td');
      if (cell && typeof cell === 'object' && cell.nodeType) td.appendChild(cell);
      else if (cell && typeof cell === 'object' && cell.code !== undefined) td.appendChild(el('code', 'mono', cell.code));
      else td.textContent = cell === undefined || cell === null ? '' : String(cell);
      tr.appendChild(td);
    });
    return tr;
  }

  function overview() {
    var box = $('overview'); clear(box);
    var ov = state.overview;
    if (!ov) { box.appendChild(el('div', 'empty', '加载中…')); return; }
    if (!ov.hasGraph) {
      box.appendChild(el('div', 'empty', '这个工作区还没有 .graphfs/graph.yaml。先在终端运行：graphfs init --root ' + ov.root));
      return;
    }
    if (ov.ok) {
      var ok = el('div', 'banner ok', '全部一致（clean ' + ov.clean + ' 条边）——' + ov.generatedAt);
      box.appendChild(ok);
    }

    if (ov.drift.length) {
      var s = section('漂移 ' + ov.drift.length);
      var t = table(['边', '变化侧', '关系', '从 → 到']);
      ov.drift.forEach(function (d) {
        var arrow = el('span');
        arrow.appendChild(el('code', 'mono', d.from));
        arrow.appendChild(doc.createTextNode(' → '));
        arrow.appendChild(el('code', 'mono', d.to));
        t.body.appendChild(row([{ code: d.edgeId }, d.side + (d.bothMoved ? '（两端）' : ''), d.relation, arrow]));
      });
      s.appendChild(t);
      box.appendChild(s);
    }

    if (ov.conflicts.length) {
      var sc = section('冲突 ' + ov.conflicts.length);
      var tc = table(['边', '关系', '从 → 到']);
      ov.conflicts.forEach(function (c) {
        tc.body.appendChild(row([{ code: c.edgeId }, c.relation, c.from + ' → ' + c.to]));
      });
      sc.appendChild(tc);
      box.appendChild(sc);
    }

    if (ov.dangling.length) {
      var sd = section('缺失 ' + ov.dangling.length);
      var td = table(['引用', '路径']);
      ov.dangling.forEach(function (d) { td.body.appendChild(row([{ code: d.ref }, d.path || ''])); });
      sd.appendChild(td);
      box.appendChild(sd);
    }

    if (ov.orphans.length) {
      var so = section('未声明关系的文件 ' + ov.orphans.length);
      var ul = el('div');
      ov.orphans.slice(0, 60).forEach(function (path) { ul.appendChild(el('div', 'mono muted', path)); });
      if (ov.orphans.length > 60) ul.appendChild(el('div', 'muted', '…还有 ' + (ov.orphans.length - 60) + ' 个'));
      ul.appendChild(el('div', 'muted', '处理：graphfs attach <file> --to <node> --relation <r>  或  --unmanaged'));
      so.appendChild(ul);
      box.appendChild(so);
    }

    if (ov.unlinked.length) {
      var su = section('孤立节点 ' + ov.unlinked.length);
      var ulu = el('div');
      ov.unlinked.slice(0, 40).forEach(function (path) { ulu.appendChild(el('div', 'mono muted', path)); });
      su.appendChild(ulu);
      box.appendChild(su);
    }

    if (ov.unhashable.length) {
      var sh = section('不可哈希 ' + ov.unhashable.length);
      var th = table(['路径', '原因']);
      ov.unhashable.forEach(function (u) { th.body.appendChild(row([{ code: u.path }, u.reason])); });
      sh.appendChild(th);
      box.appendChild(sh);
    }

    if (ov.issues.length) {
      var si = section('issues ' + ov.issues.length);
      var ti = table(['代码', '消息']);
      ov.issues.forEach(function (issue) { ti.body.appendChild(row([{ code: issue.code }, issue.message])); });
      si.appendChild(ti);
      box.appendChild(si);
    }
  }

  function journal() {
    var box = $('journal'); clear(box);
    var entries = state.overview && state.overview.journal ? state.overview.journal : [];
    if (!entries.length) { box.appendChild(el('div', 'empty', '审计日志为空')); return; }
    entries.slice().reverse().forEach(function (entry) {
      var rowEl = el('div', 'row');
      rowEl.appendChild(el('div', 'muted', String(entry.at || '').replace('T', ' ').replace(/\\..*$/, '')));
      rowEl.appendChild(el('div', 'kind', entry.kind || '?'));
      var right = el('div');
      var target = entry.edgeId || entry.node || '';
      if (target) right.appendChild(el('span', 'mono', target + '  '));
      if (entry.actor) right.appendChild(el('span', 'pill', entry.actor));
      if (entry.detail) {
        var text = JSON.stringify(entry.detail);
        right.appendChild(el('div', 'muted', text.length > 300 ? text.slice(0, 300) + '…' : text));
      }
      rowEl.appendChild(right);
      box.appendChild(rowEl);
    });
  }

  function buildGraph() {
    var g = state.graph;
    if (!g || !g.hasGraph) { state.positions = null; return; }
    var nodes = g.nodes.slice().sort(function (a, b) { return a.path < b.path ? -1 : a.path > b.path ? 1 : 0; });
    var index = new Map();
    var n = nodes.length || 1;
    var golden = Math.PI * (3 - Math.sqrt(5));
    var positions = new Array(nodes.length);
    for (var i = 0; i < nodes.length; i++) {
      var r = Math.sqrt((i + 0.5) / n);
      var a = i * golden;
      positions[i] = { x: 0.5 + Math.cos(a) * r * 0.47, y: 0.5 + Math.sin(a) * r * 0.47 };
      index.set(nodes[i].id, i);
    }
    var inc = new Map();
    var edges = [];
    g.edges.forEach(function (e) {
      var fi = index.get(e.from), ti = index.get(e.to);
      if (fi === undefined || ti === undefined) return;
      edges.push({ e: e, fi: fi, ti: ti });
      if (!inc.has(e.from)) inc.set(e.from, []);
      if (!inc.has(e.to)) inc.set(e.to, []);
      inc.get(e.from).push(edges.length - 1);
      inc.get(e.to).push(edges.length - 1);
    });
    state.graph.nodesById = index;
    state.graph.sorted = nodes;
    state.positions = { list: positions, edges: edges, incident: inc };
  }

  function fit() {
    var canvas = $('canvas');
    var rect = canvas.getBoundingClientRect();
    var dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(320, Math.floor(rect.width * dpr));
    canvas.height = Math.max(320, Math.floor(rect.height * dpr));
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx: ctx, w: rect.width, h: rect.height };
  }

  function draw() {
    var canvas = $('canvas');
    var ctx = canvas.getContext('2d');
    var view = fit();
    ctx.clearRect(0, 0, view.w, view.h);
    var g = state.graph;
    if (!g || !g.hasGraph) {
      ctx.fillStyle = '#8b94a7';
      ctx.font = '14px sans-serif';
      ctx.fillText('没有图', 20, 30);
      return;
    }
    var pos = state.positions;
    var w = view.w, h = view.h;
    var toX = function (p) { return p.x * w; };
    var toY = function (p) { return p.y * h; };

    ctx.lineWidth = 0.7;
    pos.edges.forEach(function (item) {
      var a = pos.list[item.fi], b = pos.list[item.ti];
      if (!a || !b) return;
      ctx.strokeStyle = colors[item.e.relation] || '#8b94a7';
      ctx.globalAlpha = state.selected && (item.e.from === state.selected || item.e.to === state.selected) ? 0.85 : 0.12;
      ctx.beginPath();
      ctx.moveTo(toX(a), toY(a));
      ctx.lineTo(toX(b), toY(b));
      ctx.stroke();
    });
    ctx.globalAlpha = 1;

    var selectedIndex = state.selected === null ? -1 : g.nodesById.get(state.selected);
    pos.list.forEach(function (p, i) {
      var isSel = i === selectedIndex;
      ctx.beginPath();
      ctx.arc(toX(p), toY(p), isSel ? 4 : 1.8, 0, Math.PI * 2);
      ctx.fillStyle = isSel ? '#ffffff' : '#7aa2f7';
      ctx.globalAlpha = isSel ? 1 : 0.65;
      ctx.fill();
    });
    ctx.globalAlpha = 1;

    $('legend').innerHTML = '';
    Object.keys(colors).forEach(function (name) {
      var item = el('span');
      var dot = el('i');
      dot.style.background = colors[name];
      item.appendChild(dot);
      item.appendChild(doc.createTextNode(name));
      $('legend').appendChild(item);
    });
  }

  function nodeAt(event) {
    var canvas = $('canvas');
    var rect = canvas.getBoundingClientRect();
    var x = (event.clientX - rect.left) / rect.width;
    var y = (event.clientY - rect.top) / rect.height;
    var best = -1, bestD = 0.012;
    state.positions.list.forEach(function (p, i) {
      var dx = p.x - x, dy = p.y - y;
      var d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = i; }
    });
    return best;
  }

  function bindCanvas() {
    var canvas = $('canvas');
    canvas.addEventListener('mousemove', function (event) {
      if (!state.positions) return;
      var i = nodeAt(event);
      var tip = $('tooltip');
      if (i < 0) { tip.style.display = 'none'; return; }
      var node = state.graph.sorted[i];
      var rect = canvas.getBoundingClientRect();
      var degree = (state.positions.incident.get(node.id) || []).length;
      tip.textContent = node.path + '  ·  节点 ' + node.id + '  ·  ' + degree + ' 条关系';
      tip.style.display = 'block';
      tip.style.left = Math.min(rect.width - 200, event.clientX - rect.left + 12) + 'px';
      tip.style.top = Math.max(4, event.clientY - rect.top - 34) + 'px';
    });
    canvas.addEventListener('mouseleave', function () { $('tooltip').style.display = 'none'; });
    canvas.addEventListener('click', function (event) {
      if (!state.positions) return;
      var i = nodeAt(event);
      state.selected = i < 0 ? null : state.graph.sorted[i].id;
      draw();
      inspect();
    });
  }

  function inspect() {
    var box = $('inspect'); clear(box);
    box.appendChild(el('h3', null, '节点'));
    if (!state.selected || !state.graph) {
      box.appendChild(el('div', 'muted', '点击图中的点查看它的关系'));
      return;
    }
    var node = state.graph.sorted[state.graph.nodesById.get(state.selected)];
    box.appendChild(el('div', 'path', node.path || node.id));
    box.appendChild(el('div', 'muted', 'id: ' + node.id + ' · unit: ' + JSON.stringify(node.unit)));
    var indices = state.positions.incident.get(node.id) || [];
    box.appendChild(el('div', 'muted', '关系 ' + indices.length));
    var list = el('ul');
    indices.slice(0, 80).forEach(function (idx) {
      var edge = state.positions.edges[idx].e;
      var other = edge.from === node.id ? edge.to : edge.from;
      var li = el('li');
      li.appendChild(el('span', 'pill', edge.relation));
      li.appendChild(doc.createTextNode(' ' + (edge.from === node.id ? '→ ' : '← ') + other));
      list.appendChild(li);
    });
    box.appendChild(list);
  }

  function tabs() {
    var buttons = doc.querySelectorAll('.tabs button');
    buttons.forEach(function (btn) {
      btn.addEventListener('click', function () {
        buttons.forEach(function (b) { b.classList.toggle('active', b === btn); });
        ['overview', 'graph', 'journal'].forEach(function (name) {
          $('pane-' + name).hidden = name !== btn.dataset.tab;
        });
        if (btn.dataset.tab === 'graph') { draw(); }
      });
    });
  }

  function load() {
    return Promise.all([getJson('/api/overview'), getJson('/api/graph')])
      .then(function (results) {
        state.overview = results[0];
        state.graph = results[1];
        $('root').textContent = state.overview.root;
        $('graphPath').textContent = state.overview.graphPath || '';
        banner('');
        if (!state.overview.hasGraph) {
          banner('工作区还没有图：运行 graphfs init --root ' + state.overview.root, 'bad');
        } else if (!state.overview.ok) {
          banner('存在不一致：漂移 ' + state.overview.drift.length + ' · 冲突 ' + state.overview.conflicts.length + ' · 缺失 ' + state.overview.dangling.length, 'bad');
        }
        buildGraph();
        cards();
        overview();
        journal();
        inspect();
        if (!$('pane-graph').hidden) draw();
      })
      .catch(function (error) {
        banner('加载失败：' + error.message, 'bad');
      });
  }

  function boot() {
    tabs();
    bindCanvas();
    $('refresh').addEventListener('click', load);
    var timer = null;
    $('auto').addEventListener('change', function (event) {
      if (timer) { clearInterval(timer); timer = null; }
      if (event.target.checked) timer = setInterval(load, 20000);
    });
    window.addEventListener('resize', function () { if (!$('pane-graph').hidden) draw(); });
    load();
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
</script>
</body>
</html>`
}


//# sourceURL=/Users/zfyang/Documents/文件/AI Agent/GraphFS/src/ui/page.ts