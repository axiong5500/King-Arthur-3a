/* 兵器库：单机版外观换模（程序化建模切换手持武器外形，不改动弹道/伤害/射速/弹匣） */
(function () {
  'use strict';

  var KEY = 'ka3a_arsenal_v1';
  var FALLBACK = 'pac9';

  /* 五把兵器：原配 PAC-9 沿用本体模型；其余四把为程序化外形 */
  var GUNS = [
    { id: 'pac9',    name: '亚瑟九式突击步枪', desc: '原配 · 全自动制式步枪', builtin: true },
    { id: 'smg',     name: '蜂鸟冲锋枪',       desc: '短管全自动 · 紧凑近距',   build: buildSmg },
    { id: 'sniper',  name: '苍鹰狙击步枪',     desc: '长枪管 · 高倍瞄具',       build: buildSniper },
    { id: 'pistol',  name: '守卫手枪',         desc: '短管副武器 · 随身防卫',   build: buildPistol },
    { id: 'shotgun', name: '破阵霰弹枪',       desc: '泵动粗管 · 近距压制',     build: buildShotgun }
  ];

  function byId(id) {
    for (var i = 0; i < GUNS.length; i++) { if (GUNS[i].id === id) return GUNS[i]; }
    return GUNS[0];
  }
  function load() {
    try { var v = localStorage.getItem(KEY); if (v && byId(v).id === v) return v; } catch (e) { }
    return FALLBACK;
  }
  function save(id) { try { localStorage.setItem(KEY, id); } catch (e) { } }

  var cur = load();
  var G = null, THREE = null;
  var proxy = null;          // 挂在 camera 下，跟随本体 root 的动画位姿
  var cache = {};            // 已构建的程序化模型
  var stockName = null;      // 本体原配枪名（首次读取后缓存）
  var lastRoot = null;       // 上一次拿到的本体 root（开局/重开后会重建）

  /* ---------- 程序化建模积木（坐标约定：枪口朝 -Z，与本体 PAC-9 一致） ---------- */
  var geoCache = {};

  function rBoxGeo(w, h, d, r) {
    var key = 'rb' + [w, h, d, r].join('_');
    if (geoCache[key]) return geoCache[key];
    var b = Math.max(0.0008, Math.min(r, w * 0.45, h * 0.45, d * 0.45));
    var iw = w - 2 * b, ih = h - 2 * b, id = Math.max(0.0008, d - 2 * b);
    var rr = Math.max(0.0005, Math.min(b, iw * 0.5, ih * 0.5));
    var x0 = -iw / 2, x1 = iw / 2, y0 = -ih / 2, y1 = ih / 2;
    var s = new THREE.Shape();
    s.moveTo(x0 + rr, y0);
    s.lineTo(x1 - rr, y0); s.quadraticCurveTo(x1, y0, x1, y0 + rr);
    s.lineTo(x1, y1 - rr); s.quadraticCurveTo(x1, y1, x1 - rr, y1);
    s.lineTo(x0 + rr, y1); s.quadraticCurveTo(x0, y1, x0, y1 - rr);
    s.lineTo(x0, y0 + rr); s.quadraticCurveTo(x0, y0, x0 + rr, y0);
    var geo = new THREE.ExtrudeGeometry(s, { depth: id, bevelEnabled: true, bevelThickness: b, bevelSize: b, bevelOffset: 0, bevelSegments: 2, curveSegments: 4 });
    geo.translate(0, 0, -(id / 2));
    return (geoCache[key] = geo);
  }

  function RB(w, h, d, r, mat, x, y, z) {
    var m = new THREE.Mesh(rBoxGeo(w, h, d, r), mat);
    m.position.set(x || 0, y || 0, z || 0);
    m.castShadow = false; m.receiveShadow = false; m.frustumCulled = false;
    return m;
  }
  function Cyl(r0, r1, len, mat, axis, x, y, z) {
    var m = new THREE.Mesh(new THREE.CylinderGeometry(r1, r0, len, 12), mat);
    if (axis === 'z') m.rotation.x = Math.PI / 2;
    else if (axis === 'x') m.rotation.z = Math.PI / 2;
    m.position.set(x || 0, y || 0, z || 0);
    m.castShadow = false; m.frustumCulled = false;
    return m;
  }
  function Ell(rx, ry, rz, mat, x, y, z) {
    var m = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 10), mat);
    m.scale.set(rx, ry, rz);
    m.position.set(x || 0, y || 0, z || 0);
    m.castShadow = false; m.frustumCulled = false;
    return m;
  }

  function mats() {
    return {
      metal:   new THREE.MeshStandardMaterial({ color: 0x2f3437, roughness: .4,  metalness: .8,  emissive: 0x15191b, emissiveIntensity: .12 }),
      dark:    new THREE.MeshStandardMaterial({ color: 0x17181a, roughness: .55, metalness: .3,  emissive: 0x0c0d0e, emissiveIntensity: .15 }),
      polymer: new THREE.MeshStandardMaterial({ color: 0x25292a, roughness: .62, metalness: .15, emissive: 0x111415, emissiveIntensity: .15 }),
      wood:    new THREE.MeshStandardMaterial({ color: 0x4a3826, roughness: .7,  metalness: .05, emissive: 0x1a120a, emissiveIntensity: .12 }),
      glove:   new THREE.MeshStandardMaterial({ color: 0x24272a, roughness: .88, metalness: .04, emissive: 0x101214, emissiveIntensity: .2 }),
      visor:   new THREE.MeshStandardMaterial({ color: 0x0f1518, roughness: .12, metalness: .95, emissive: 0x23353b, emissiveIntensity: .2 })
    };
  }

  /* 简化双手：贴在握把与护木位置，避免换模后枪身悬空 */
  function addHands(g, M, gripZ, foreZ) {
    var R = new THREE.Group(), L = new THREE.Group();
    R.add(RB(0.050, 0.086, 0.078, 0.014, M.glove, 0, -0.090, gripZ));
    L.add(RB(0.074, 0.046, 0.090, 0.014, M.glove, -0.004, -0.066, foreZ));
    g.add(R); g.add(L);
  }

  /* ---- 冲锋枪：紧凑、短管、伸缩托 ---- */
  function buildSmg() {
    var M = mats(), g = new THREE.Group();
    g.add(RB(0.046, 0.060, 0.22, 0.008, M.metal,   0, 0, 0.02));            // 上机匣
    g.add(RB(0.040, 0.050, 0.16, 0.008, M.polymer, 0, -0.052, 0.04));       // 下机匣
    var mag = RB(0.030, 0.13, 0.052, 0.006, M.dark, 0, -0.125, -0.02);
    mag.rotation.x = 0.12; g.add(mag);                                     // 弹匣
    var grip = RB(0.030, 0.09, 0.044, 0.010, M.polymer, 0, -0.10, 0.09);
    grip.rotation.x = -0.38; g.add(grip);                                  // 握把
    g.add(Cyl(0.014, 0.014, 0.12, M.metal, 'z', 0, -0.004, 0.17));         // 伸缩托杆
    g.add(RB(0.034, 0.06, 0.07, 0.010, M.polymer, 0, -0.012, 0.215));      // 托垫
    g.add(RB(0.022, 0.009, 0.2, 0.003, M.metal, 0, 0.034, -0.04));         // 顶部导轨
    g.add(RB(0.030, 0.034, 0.05, 0.006, M.polymer, 0, 0.058, -0.03));      // 瞄具
    g.add(Cyl(0.026, 0.026, 0.16, M.polymer, 'z', 0, 0, -0.19));           // 短护木
    g.add(Cyl(0.009, 0.009, 0.12, M.metal, 'z', 0, 0.002, -0.32));         // 枪管
    g.add(Cyl(0.013, 0.013, 0.045, M.metal, 'z', 0, 0.002, -0.40));        // 枪口
    g.add(RB(0.008, 0.022, 0.01, 0.002, M.metal, 0, 0.024, -0.26));        // 准星
    addHands(g, M, 0.09, -0.19);
    return g;
  }

  /* ---- 狙击步枪：长枪管、高倍镜、固定式枪托 ---- */
  function buildSniper() {
    var M = mats(), g = new THREE.Group();
    g.add(RB(0.050, 0.066, 0.26, 0.008, M.metal,   0, 0, 0.02));            // 机匣
    g.add(RB(0.044, 0.050, 0.18, 0.008, M.polymer, 0, -0.052, 0.04));      // 下机匣
    var mag = RB(0.032, 0.11, 0.056, 0.006, M.dark, 0, -0.115, -0.01);
    mag.rotation.x = 0.08; g.add(mag);                                      // 弹匣
    var grip = RB(0.032, 0.10, 0.046, 0.010, M.polymer, 0, -0.11, 0.10);
    grip.rotation.x = -0.4; g.add(grip);                                   // 握把
    g.add(RB(0.038, 0.072, 0.17, 0.012, M.wood, 0, -0.012, 0.24));         // 枪托
    g.add(RB(0.040, 0.096, 0.022, 0.006, M.dark, 0, -0.012, 0.325));       // 托底板
    g.add(Cyl(0.011, 0.011, 0.5, M.metal, 'z', 0, 0.002, -0.45));          // 长枪管
    g.add(Cyl(0.016, 0.016, 0.07, M.metal, 'z', 0, 0.002, -0.72));         // 枪口制退器
    g.add(RB(0.024, 0.010, 0.2, 0.003, M.metal, 0, 0.040, -0.05));         // 镜座导轨
    g.add(Cyl(0.020, 0.020, 0.16, M.dark, 'z', 0, 0.075, -0.04));          // 高倍镜身
    g.add(Cyl(0.023, 0.023, 0.03, M.visor, 'z', 0, 0.075, -0.13));         // 物镜
    g.add(Cyl(0.017, 0.017, 0.03, M.visor, 'z', 0, 0.075, 0.05));          // 目镜
    g.add(RB(0.008, 0.026, 0.01, 0.002, M.metal, 0, 0.026, -0.30));        // 准星座
    addHands(g, M, 0.10, -0.28);
    return g;
  }

  /* ---- 手枪：滑套 + 握把，无枪托 ---- */
  function buildPistol() {
    var M = mats(), g = new THREE.Group();
    g.add(RB(0.040, 0.046, 0.18, 0.006, M.metal,   0, 0.012, -0.02));       // 滑套
    g.add(RB(0.036, 0.040, 0.14, 0.006, M.dark,    0, -0.020, -0.01));      // 枪身
    var grip = RB(0.032, 0.11, 0.050, 0.010, M.polymer, 0, -0.078, 0.055);
    grip.rotation.x = -0.28; g.add(grip);                                   // 握把
    g.add(Cyl(0.008, 0.008, 0.05, M.metal, 'z', 0, 0.006, -0.115));         // 枪口内管
    g.add(RB(0.030, 0.010, 0.02, 0.003, M.dark, 0, -0.030, -0.04));         // 扳机护圈
    g.add(RB(0.006, 0.020, 0.008, 0.002, M.metal, 0, 0.038, -0.08));        // 后照门
    addHands(g, M, 0.055, -0.05);
    return g;
  }

  /* ---- 霰弹枪：粗枪管、管式弹仓、泵动护木、枪托 ---- */
  function buildShotgun() {
    var M = mats(), g = new THREE.Group();
    g.add(RB(0.050, 0.070, 0.20, 0.008, M.metal,   0, 0, 0.02));            // 机匣
    g.add(RB(0.044, 0.050, 0.15, 0.008, M.polymer, 0, -0.052, 0.05));      // 下机匣
    var grip = RB(0.034, 0.10, 0.048, 0.010, M.polymer, 0, -0.105, 0.095);
    grip.rotation.x = -0.34; g.add(grip);                                  // 握把
    g.add(RB(0.042, 0.075, 0.16, 0.012, M.wood, 0, -0.012, 0.235));        // 枪托
    g.add(RB(0.042, 0.090, 0.022, 0.006, M.dark, 0, -0.012, 0.315));       // 托底板
    g.add(Cyl(0.016, 0.016, 0.34, M.metal, 'z', 0, 0.006, -0.30));          // 枪管
    g.add(Cyl(0.012, 0.012, 0.30, M.dark,  'z', 0, -0.022, -0.28));         // 管式弹仓
    g.add(RB(0.046, 0.052, 0.11, 0.010, M.wood, 0, -0.012, -0.20));        // 泵动护木
    g.add(Cyl(0.018, 0.018, 0.05, M.metal, 'z', 0, 0.006, -0.49));         // 枪口
    g.add(RB(0.008, 0.026, 0.01, 0.002, M.metal, 0, 0.026, -0.12));        // 准星
    addHands(g, M, 0.095, -0.20);
    return g;
  }

  /* ---------- 运行时装配 ---------- */
  function weapon() { return G && G.weapon; }
  function root() { var w = weapon(); return w && w.root; }

  function ensureProxy() {
    if (proxy) return proxy;
    var cam = G.camera;
    if (!cam) return null;
    proxy = new THREE.Group();
    proxy.name = 'ka-arsenal-proxy';
    proxy.visible = false;
    cam.add(proxy);
    return proxy;
  }

  function getModel(gun) {
    if (gun.builtin) return null;
    if (!cache[gun.id]) cache[gun.id] = gun.build();
    return cache[gun.id];
  }

  function apply(id, silent) {
    var gun = byId(id);
    cur = gun.id;
    save(cur);

    var w = weapon(), r = root();
    if (!w || !r) { syncUI(); return; }

    if (!stockName) stockName = w.name || '亚瑟九式突击步枪';

    if (gun.builtin) {
      /* 原配：恢复本体模型，隐藏代理组 */
      r.visible = true;
      if (proxy) proxy.visible = false;
      w.name = stockName;
    } else {
      var px = ensureProxy();
      if (!px) { syncUI(); return; }
      /* 清空代理组内旧模型，挂入新外形 */
      while (px.children.length) px.remove(px.children[0]);
      px.add(getModel(gun));
      px.visible = true;
      r.visible = false;
      w.name = gun.name;
    }
    if (!silent) syncUI();
  }

  /* 每帧跟随：代理组复制本体 root 的局部位姿（后坐/晃动/手臂摆动由本体弹簧驱动 root） */
  function follow() {
    var r = root(), px = proxy;
    if (!r || !px) return;
    if (cur === 'pac9') return;
    px.position.copy(r.position);
    px.quaternion.copy(r.quaternion);
    px.scale.copy(r.scale);
  }

  /* 开局/重开后 weapon 可能重建：重新挂接并校准外形与枪名 */
  function reattach() {
    var w = weapon(), r = root();
    if (!w || !r) return;
    if (r !== lastRoot) {
      lastRoot = r;
      proxy = null;
      ensureProxy();
    }
    var gun = byId(cur);
    if (gun.builtin) {
      r.visible = true;
      if (proxy) proxy.visible = false;
      if (w.name !== stockName && stockName) w.name = stockName;
    } else {
      var px = ensureProxy();
      if (px) {
        while (px.children.length) px.remove(px.children[0]);
        px.add(getModel(gun));
        px.visible = true;
      }
      r.visible = false;
      if (w.name !== gun.name) w.name = gun.name;
    }
  }

  /* ---------- 面板 ---------- */
  var panel = null, grid = null, curText = null;

  function swatch(gun) {
    var map = {
      pac9:    'linear-gradient(120deg,#17181a,#2a2d31 60%,#5b503f)',
      smg:     'linear-gradient(120deg,#20262b,#333a40 60%,#4a555e)',
      sniper:  'linear-gradient(120deg,#242019,#3a3226 60%,#6b5a3e)',
      pistol:  'linear-gradient(120deg,#1b1d20,#2c3033 60%,#565b60)',
      shotgun: 'linear-gradient(120deg,#26221b,#3d3224 60%,#7a6240)'
    };
    return map[gun.id] || map.pac9;
  }

  function buildPanel() {
    panel = document.createElement('div');
    panel.id = 'ka-arsenal-panel';
    var cards = GUNS.map(function (s) {
      return '<button class="ka-card" type="button" data-gun="' + s.id + '">' +
        '<span class="ka-swatch" style="background:' + swatch(s) + '"></span>' +
        '<span class="ka-name">' + s.name + '<span class="ka-tag" hidden>已装备</span></span>' +
        '<span class="ka-desc">' + s.desc + '</span>' +
        '</button>';
    }).join('');

    panel.innerHTML =
      '<div class="ka-veil"></div>' +
      '<div class="ka-box" role="dialog" aria-modal="true" aria-label="兵器库">' +
      '<div class="ka-head">' +
      '<span class="ka-k">单机 · 兵器库</span>' +
      '<h3 class="ka-title">更换兵器</h3>' +
      '<p class="ka-sub">仅更换手持外观；弹道、伤害、射速与弹匣仍沿用原配 PAC-9。选择保存在本机。</p>' +
      '</div>' +
      '<div class="ka-grid">' + cards + '</div>' +
      '<div class="ka-foot"><span class="ka-cur">当前兵器：<b>—</b></span>' +
      '<button class="ka-close" type="button">完成</button></div>' +
      '</div>';

    document.body.appendChild(panel);
    grid = panel.querySelector('.ka-grid');
    curText = panel.querySelector('.ka-cur b');

    panel.querySelector('.ka-veil').addEventListener('click', close);
    panel.querySelector('.ka-close').addEventListener('click', close);
    grid.addEventListener('click', function (ev) {
      var card = ev.target.closest ? ev.target.closest('.ka-card') : null;
      if (!card) return;
      apply(card.getAttribute('data-gun'));
    });
  }

  function syncUI() {
    var name = byId(cur).name;
    if (grid) {
      var cards = grid.querySelectorAll('.ka-card');
      for (var i = 0; i < cards.length; i++) {
        var c = cards[i];
        var on = c.getAttribute('data-gun') === cur;
        c.className = 'ka-card' + (on ? ' is-on' : '');
        var tag = c.querySelector('.ka-tag');
        if (tag) tag.hidden = !on;
      }
    }
    if (curText) curText.textContent = name;
    var shown = document.querySelectorAll('.ka-arsenal-v');
    for (var j = 0; j < shown.length; j++) shown[j].textContent = name;
  }

  function open() { if (!panel) buildPanel(); syncUI(); panel.classList.add('on'); }
  function close() { if (panel) panel.classList.remove('on'); }

  document.addEventListener('keydown', function (ev) {
    if (!panel || !panel.classList.contains('on')) return;
    if (ev.key === 'Escape' || ev.key === 'Esc') {
      ev.preventDefault(); ev.stopPropagation(); close();
    }
  }, true);

  /* ---------- 菜单入口（标题栏 + 暂停菜单，与皮肤层并列、互不覆盖） ---------- */
  function makeBar() {
    var bar = document.createElement('div');
    bar.className = 'ka-arsenal-bar';
    bar.innerHTML = '<span class="ka-arsenal-k">兵器库 · 当前</span>' +
      '<b class="ka-arsenal-v">' + byId(cur).name + '</b>' +
      '<button class="btn small ka-arsenal-open" type="button" data-arsenal-entry="1">更换兵器</button>';
    bar.querySelector('.ka-arsenal-open').addEventListener('click', function (ev) {
      ev.preventDefault(); ev.stopPropagation(); open();
    });
    return bar;
  }

  function mountEntry() {
    var titleBar = document.querySelector('[data-s="title"] .m-actions');
    if (titleBar && !titleBar.parentNode.querySelector('.ka-arsenal-bar')) {
      titleBar.insertAdjacentElement('afterend', makeBar());
    }
    var bars = document.querySelectorAll('[data-s="paused"] .m-actions');
    for (var i = 0; i < bars.length; i++) {
      var bar = bars[i];
      if (bar.querySelector('[data-arsenal-entry]')) continue;
      var btn = document.createElement('button');
      btn.className = 'btn';
      btn.type = 'button';
      btn.setAttribute('data-arsenal-entry', '1');
      btn.textContent = '兵器库';
      btn.addEventListener('click', function (ev) {
        ev.preventDefault(); ev.stopPropagation(); open();
      });
      bar.appendChild(btn);
    }
    syncUI();
  }

  var mountTries = 0;
  var mountTimer = setInterval(function () {
    mountEntry();
    if (++mountTries > 40) clearInterval(mountTimer);
  }, 500);

  /* ---------- 启动等待与校准 ---------- */
  var bootTries = 0;
  var bootTimer = setInterval(function () {
    G = window.__G;
    if (G && G.THREE && G.weapon && G.weapon.root) {
      THREE = G.THREE;
      apply(cur, true);
      reattach();
      clearInterval(bootTimer);
      return;
    }
    if (++bootTries > 120) clearInterval(bootTimer);
  }, 250);

  /* 周期校准：应对武器开局/重开后重建、枪名被本体重置 */
  setInterval(function () {
    G = window.__G;
    if (!G) return;
    if (G.THREE && !THREE) THREE = G.THREE;
    reattach();
    follow();
  }, 500);

  /* 每帧跟随代理组位姿 */
  (function frame() {
    follow();
    requestAnimationFrame(frame);
  })();

  window.__kaArsenal = {
    list: function () { return GUNS.map(function (s) { return s.id + ':' + s.name; }); },
    current: function () { return cur; },
    apply: apply,
    open: open,
    close: close,
    root: function () { return root() || null; },
    proxy: function () { return proxy; }
  };

  if (/[?&]arsenal=1/.test(location.search)) {
    setTimeout(open, 1200);
  }
})();
