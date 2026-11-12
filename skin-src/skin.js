/* PAC-9 涂装库：枪械皮肤（运行时替换武器材质配色，不改动游戏本体代码） */
(function () {
  'use strict';

  var KEY = 'ka3a_skin_v1';
  var FALLBACK = 'stock';

  var SKINS = [
    {
      id: 'stock', name: '出厂黑', desc: '阳极氧化 · 配发标准',
      tones: ['#17181a', '#1d1d1f', '#5b503f']
    },
    {
      id: 'desert', name: '沙漠灰', desc: '沙棕聚合物 · 干热港区', tones: ['#6e5f45', '#8c7a5c', '#b39a6e'],
      mats: {
        pac9_anodised: { c: 0x6e5f45, r: .52, m: .35 },
        pac9_phosphate: { c: 0x7a6a4e, r: .5, m: .4 },
        pac9_polymer: { c: 0x8c7a5c, r: .68, m: .05 },
        pac9_matte: { c: 0xa8946f, r: .9, m: 0 },
        pac9_polymer_tan: { c: 0xb39a6e, r: .68, m: 0 }
      }
    },
    {
      id: 'urban', name: '都市灰', desc: '冷灰蓝 · 城区夜战', tones: ['#3a4048', '#454c55', '#6b727c'],
      mats: {
        pac9_anodised: { c: 0x3a4048, r: .45, m: .6 },
        pac9_phosphate: { c: 0x2e343a, r: .5, m: .65 },
        pac9_polymer: { c: 0x454c55, r: .55, m: .12 },
        pac9_matte: { c: 0x6b727c, r: .85, m: .05 },
        pac9_polymer_tan: { c: 0x4a5058, r: .55, m: .1 }
      }
    },
    {
      id: 'royal', name: '亚瑟金', desc: '高抛光黄铜 · 王座礼装', tones: ['#b08a2e', '#2a2418', '#d9b457'],
      mats: {
        pac9_anodised: { c: 0xb08a2e, r: .26, m: .95 },
        pac9_phosphate: { c: 0x8e6b22, r: .3, m: .92 },
        pac9_polymer: { c: 0x2a2418, r: .5, m: .15 },
        pac9_matte: { c: 0xd9b457, r: .72, m: .35 },
        pac9_polymer_tan: { c: 0xc99f3e, r: .4, m: .55 }
      }
    },
    {
      id: 'arctic', name: '极地白', desc: '低温涂层 · 冰区渗透', tones: ['#c9d0d6', '#e2e6ea', '#9fb4c4'],
      mats: {
        pac9_anodised: { c: 0xc9d0d6, r: .5, m: .35 },
        pac9_phosphate: { c: 0xaeb7bf, r: .55, m: .4 },
        pac9_polymer: { c: 0xe2e6ea, r: .6, m: .05 },
        pac9_matte: { c: 0xffffff, r: .9, m: 0 },
        pac9_polymer_tan: { c: 0x9fb4c4, r: .6, m: .1 }
      }
    },
    {
      id: 'crimson', name: '猩红', desc: '暗红烤漆 · 高风险行动', tones: ['#7e1b1b', '#2a0e0e', '#a32b2b'],
      mats: {
        pac9_anodised: { c: 0x7e1b1b, r: .36, m: .5 },
        pac9_phosphate: { c: 0x4a1212, r: .4, m: .55 },
        pac9_polymer: { c: 0x2a0e0e, r: .55, m: .1 },
        pac9_matte: { c: 0xa32b2b, r: .8, m: .1 },
        pac9_polymer_tan: { c: 0x5e1616, r: .55, m: .15 }
      }
    }
  ];

  function byId(id) {
    for (var i = 0; i < SKINS.length; i++) { if (SKINS[i].id === id) return SKINS[i]; }
    return SKINS[0];
  }

  function load() {
    try { var v = localStorage.getItem(KEY); if (v && byId(v).id === v) return v; } catch (e) { }
    return FALLBACK;
  }
  function save(id) { try { localStorage.setItem(KEY, id); } catch (e) { } }

  var cur = load();

  /* ---------- 材质 ---------- */
  function findMats() {
    var out = [];
    var G = window.__G;
    if (!G) return out;
    var roots = [G.scene, G.camera, G.viewCamera];
    for (var i = 0; i < roots.length; i++) {
      var root = roots[i];
      if (!root || !root.traverse) continue;
      root.traverse(function (o) {
        var mat = o.material;
        if (!mat) return;
        var list = (mat.length !== undefined) ? mat : [mat];
        for (var j = 0; j < list.length; j++) {
          var m = list[j];
          if (m && m.name && m.name.indexOf('pac9_') === 0 && out.indexOf(m) < 0) out.push(m);
        }
      });
    }
    return out;
  }

  function apply(id) {
    var skin = byId(id);
    var mats = findMats();
    for (var i = 0; i < mats.length; i++) {
      var m = mats[i];
      if (!m.color) continue;
      if (!m.userData.kaOrig) {
        m.userData.kaOrig = {
          c: m.color.getHex(),
          r: m.roughness,
          mt: m.metalness,
          e: m.emissive ? m.emissive.getHex() : 0
        };
      }
      var o = m.userData.kaOrig;
      var d = skin.mats && skin.mats[m.name] ? skin.mats[m.name] : null;
      if (!d) {
        m.color.setHex(o.c);
        m.roughness = o.r;
        m.metalness = o.mt;
        if (m.emissive) m.emissive.setHex(o.e);
      } else {
        if (d.c != null) m.color.setHex(d.c);
        if (d.r != null) m.roughness = d.r;
        if (d.m != null) m.metalness = d.m;
        if (m.emissive) m.emissive.setHex(d.e != null ? d.e : 0);
      }
      m.userData.kaSkin = id;
      m.needsUpdate = true;
    }
    cur = skin.id;
    save(cur);
    syncUI();
    return mats.length;
  }

  /* 武器材质可能在开局/重开后重建，定期校准，确保皮肤不丢 */
  setInterval(function () {
    var mats = findMats();
    if (!mats.length) return;
    for (var i = 0; i < mats.length; i++) {
      if (mats[i].userData.kaSkin !== cur) { apply(cur); return; }
    }
  }, 1500);

  /* ---------- 面板 ---------- */
  var panel = null;
  var grid = null;
  var curText = null;

  function swatchGradient(tones) {
    return 'linear-gradient(90deg,' + tones[0] + ' 0 34%,' + tones[1] + ' 34% 63%,' + tones[2] + ' 63% 100%)';
  }

  function buildPanel() {
    panel = document.createElement('div');
    panel.id = 'ka-skin-panel';
    var cards = SKINS.map(function (s) {
      return '<button class="ks-card" type="button" data-skin="' + s.id + '">' +
        '<span class="ks-swatch" style="background:' + swatchGradient(s.tones) + '"></span>' +
        '<span class="ks-name">' + s.name + '<span class="ks-tag" hidden>已装备</span></span>' +
        '<span class="ks-desc">' + s.desc + '</span>' +
        '</button>';
    }).join('');

    panel.innerHTML =
      '<div class="ks-veil"></div>' +
      '<div class="ks-box" role="dialog" aria-modal="true" aria-label="枪械皮肤">' +
      '<div class="ks-head">' +
      '<span class="ks-k">PAC-9 · 涂装库</span>' +
      '<h3 class="ks-title">枪械皮肤</h3>' +
      '<p class="ks-sub">切换即刻生效，选择会保存在本机；重新开始任务后依然保留。</p>' +
      '</div>' +
      '<div class="ks-grid">' + cards + '</div>' +
      '<div class="ks-foot"><span class="ks-cur">当前涂装：<b>—</b></span>' +
      '<button class="ks-close" type="button">完成</button></div>' +
      '</div>';

    document.body.appendChild(panel);
    grid = panel.querySelector('.ks-grid');
    curText = panel.querySelector('.ks-cur b');

    panel.querySelector('.ks-veil').addEventListener('click', close);
    panel.querySelector('.ks-close').addEventListener('click', close);
    grid.addEventListener('click', function (ev) {
      var card = ev.target.closest ? ev.target.closest('.ks-card') : null;
      if (!card) return;
      apply(card.getAttribute('data-skin'));
    });
  }

  function syncUI() {
    var name = byId(cur).name;
    if (grid) {
      var cards = grid.querySelectorAll('.ks-card');
      for (var i = 0; i < cards.length; i++) {
        var c = cards[i];
        var on = c.getAttribute('data-skin') === cur;
        c.className = 'ks-card' + (on ? ' is-on' : '');
        var tag = c.querySelector('.ks-tag');
        if (tag) tag.hidden = !on;
      }
    }
    if (curText) curText.textContent = name;
    var shown = document.querySelectorAll('.ka-skin-v');
    for (var j = 0; j < shown.length; j++) shown[j].textContent = name;
  }

  function open() {
    if (!panel) buildPanel();
    syncUI();
    panel.classList.add('on');
  }
  function close() {
    if (panel) panel.classList.remove('on');
  }

  document.addEventListener('keydown', function (ev) {
    if (!panel || !panel.classList.contains('on')) return;
    if (ev.key === 'Escape' || ev.key === 'Esc') {
      ev.preventDefault();
      ev.stopPropagation();
      close();
    }
  }, true);

  /* ---------- 菜单入口 ---------- */
  function makeBar() {
    var bar = document.createElement('div');
    bar.className = 'ka-skin-bar';
    bar.innerHTML = '<span class="ka-skin-k">PAC-9 涂装库 · 当前</span>' +
      '<b class="ka-skin-v">' + byId(cur).name + '</b>' +
      '<button class="btn small ka-skin-open" type="button" data-skin-entry="1">更换皮肤</button>';
    bar.querySelector('.ka-skin-open').addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      open();
    });
    return bar;
  }

  function mountEntry() {
    var titleBar = document.querySelector('[data-s="title"] .m-actions');
    if (titleBar && !titleBar.parentNode.querySelector('.ka-skin-bar')) {
      titleBar.insertAdjacentElement('afterend', makeBar());
    }

    var bars = document.querySelectorAll('[data-s="paused"] .m-actions');
    for (var i = 0; i < bars.length; i++) {
      var bar = bars[i];
      if (bar.querySelector('[data-skin-entry]')) continue;
      var btn = document.createElement('button');
      btn.className = 'btn';
      btn.type = 'button';
      btn.setAttribute('data-skin-entry', '1');
      btn.textContent = '枪械皮肤';
      btn.addEventListener('click', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        open();
      });
      bar.appendChild(btn);
    }
    syncUI();
  }

  var tries = 0;
  var mountTimer = setInterval(function () {
    mountEntry();
    tries++;
    if (tries > 40) clearInterval(mountTimer);
  }, 500);

  window.__kaSkin = {
    list: function () { return SKINS.map(function (s) { return s.id + ':' + s.name; }); },
    current: function () { return cur; },
    apply: apply,
    open: open,
    close: close,
    materialState: function () {
      var mats = findMats();
      var o = {};
      for (var i = 0; i < mats.length; i++) {
        o[mats[i].name] = { c: mats[i].color.getHex().toString(16), r: mats[i].roughness, m: mats[i].metalness };
      }
      return o;
    }
  };

  /* 首帧后套用已保存的涂装 */
  var firstTries = 0;
  var firstTimer = setInterval(function () {
    if (findMats().length) { apply(cur); clearInterval(firstTimer); return; }
    if (++firstTries > 120) clearInterval(firstTimer);
  }, 500);

  if (/[?&]skins=1/.test(location.search)) {
    setTimeout(open, 1200);
  }
})();
