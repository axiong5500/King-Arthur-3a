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
  var cache = {};            // 已构建的程序化模型
  var stockName = null;      // 本体原配枪名（首次读取后缓存）

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
  /* 方案：root 组本身始终保持可见（本体开火判定、弹簧动画、手部逻辑都挂在 root 上，
     隐藏整组会锁死开火）；只把 root 内本体自带的网格逐个隐藏，新模型作为 root 子级挂入，
     自动继承 root 的位姿与动画。 */
  function weapon() { return G && G.weapon; }
  function root() { var w = weapon(); return w && w.root; }

  var bodyMeshes = [];   // 本体自带网格（首次拿到 root 时缓存原始 visible）
  var modelGroup = null; // 当前挂入 root 的新模型组
  var lastRoot = null;

  function collectBodyMeshes(r) {
    bodyMeshes = [];
    r.traverse(function (o) {
      if (o.isMesh) {
        o.userData.kaArsenalOrigVisible = o.visible;
        bodyMeshes.push(o);
      }
    });
  }

  function restoreBody() {
    for (var i = 0; i < bodyMeshes.length; i++) bodyMeshes[i].visible = bodyMeshes[i].userData.kaArsenalOrigVisible;
  }
  function hideBody() {
    for (var i = 0; i < bodyMeshes.length; i++) bodyMeshes[i].visible = false;
  }

  function getModel(gun) {
    if (gun.builtin) return null;
    if (!cache[gun.id]) cache[gun.id] = gun.build();
    return cache[gun.id];
  }

  function detachModel() {
    if (modelGroup && modelGroup.parent) modelGroup.parent.remove(modelGroup);
    modelGroup = null;
  }

  function apply(id, silent) {
    var gun = byId(id);
    cur = gun.id;
    save(cur);

    var w = weapon(), r = root();
    if (!w || !r) { syncUI(); return; }

    if (!stockName) stockName = w.name || '亚瑟九式突击步枪';
    if (r !== lastRoot) { lastRoot = r; collectBodyMeshes(r); }

    /* 注意：不主动改 r.visible。root 的可见性由本体状态机控制
       （进任务 setVisible(true)，回标题/启动 setVisible(false)）；
       若在这里强制 true，标题视角会把武器模型露出来形成遮挡黑块。 */
    if (gun.builtin) {
      /* 原配：恢复本体网格，摘除新模型 */
      restoreBody();
      detachModel();
      w.name = stockName;
    } else {
      hideBody();
      detachModel();
      modelGroup = getModel(gun);
      if (modelGroup) r.add(modelGroup);
      w.name = gun.name;
    }
    if (!silent) syncUI();
  }

  /* 开局/重开后 weapon 可能重建：重新收集本体网格并校准外形与枪名 */
  function reattach() {
    var w = weapon(), r = root();
    if (!w || !r) return;
    if (r !== lastRoot) { lastRoot = r; collectBodyMeshes(r); }
    var gun = byId(cur);
    if (gun.builtin) {
      restoreBody();
      detachModel();
      if (w.name !== stockName && stockName) w.name = stockName;
    } else {
      hideBody();
      detachModel();
      modelGroup = getModel(gun);
      if (modelGroup) r.add(modelGroup);
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

  /* 卡片侧面剪影（示意外形，枪口朝右）；纯 SVG，不依赖 WebGL */
  function R(x, y, w, h) { return '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '"/>'; }
  function P(p) { return '<polygon points="' + p + '"/>'; }
  var GUN_SILHOUETTE = {
    pac9: R(6,20,22,14) + R(28,18,44,14) + R(72,20,48,10) + R(120,23,48,4) +
      P('44,32 56,32 54,46 46,46') + P('30,32 38,32 36,44 29,44') + R(50,12,16,6) + R(164,16,3,7),
    smg: R(18,22,12,8) + R(30,18,58,14) + R(88,21,32,8) +
      P('50,32 60,32 59,44 51,44') + P('36,32 44,32 42,42 35,42') + R(55,13,14,5),
    sniper: R(6,20,24,14) + R(30,19,48,12) + R(78,21,42,8) + R(120,23,58,3) +
      R(48,10,44,8) + R(62,18,6,3) + P('52,31 62,31 61,40 53,40') + P('34,31 42,31 40,43 33,43') + R(178,21,8,7),
    pistol: R(40,18,60,10) + R(42,28,50,4) + P('46,32 60,32 57,48 44,48') +
      P('62,32 76,32 74,38 63,38') + R(92,13,6,5),
    shotgun: R(8,20,24,14) + R(32,18,38,14) + R(70,22,38,10) + R(108,21,52,6) +
      R(70,30,78,4) + P('38,32 46,32 44,43 37,43') + R(156,15,3,6)
  };
  function gunSvg(id) {
    var body = GUN_SILHOUETTE[id] || GUN_SILHOUETTE.pac9;
    return '<svg class="ka-gun-svg" viewBox="0 0 200 60" preserveAspectRatio="xMidYMid meet" aria-hidden="true">' + body + '</svg>';
  }

  function buildPanel() {
    panel = document.createElement('div');
    panel.id = 'ka-arsenal-panel';
    var cards = GUNS.map(function (s) {
      return '<button class="ka-card" type="button" data-gun="' + s.id + '">' +
        '<span class="ka-swatch" style="background:' + swatch(s) + '">' + gunSvg(s.id) + '</span>' +
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
  /* 标题态只在 .m-actions 按钮行内追加一个入口按钮，不新增整行状态条，
     避免把标题菜单撑高、把“开始行动”按钮顶进位置卡片浮层的遮挡区。 */
  function makeEntryBtn(label) {
    var btn = document.createElement('button');
    btn.className = 'btn';
    btn.type = 'button';
    btn.setAttribute('data-arsenal-entry', '1');
    btn.textContent = label;
    btn.addEventListener('click', function (ev) {
      ev.preventDefault(); ev.stopPropagation(); open();
    });
    return btn;
  }

  function mountEntry() {
    var titleBar = document.querySelector('[data-s="title"] .m-actions');
    if (titleBar && !titleBar.querySelector('[data-arsenal-entry]')) {
      titleBar.appendChild(makeEntryBtn('更换兵器'));
    }
    var bars = document.querySelectorAll('[data-s="paused"] .m-actions');
    for (var i = 0; i < bars.length; i++) {
      var bar = bars[i];
      if (bar.querySelector('[data-arsenal-entry]')) continue;
      bar.appendChild(makeEntryBtn('兵器库'));
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
  }, 500);

  window.__kaArsenal = {
    list: function () { return GUNS.map(function (s) { return s.id + ':' + s.name; }); },
    current: function () { return cur; },
    apply: apply,
    open: open,
    close: close,
    root: function () { return root() || null; },
    model: function () { return modelGroup || null; }
  };

  if (/[?&]arsenal=1/.test(location.search)) {
    setTimeout(open, 1200);
  }
})();
