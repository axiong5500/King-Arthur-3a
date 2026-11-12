/* 变换多端的天气：在运行时接管光照、天空、雨量与远景雾，不改动游戏本体代码 */
(function () {
  'use strict';

  var KEY = 'ka3a_wx_v1';
  var AKEY = 'ka3a_wx_auto_v1';

  /* 六种天候：zen 天顶、hor 地平线、away 背向地平线、sunI 主光强度、rain 雨量、wet 地面湿度、haze 远景雾 */
  var WEATHERS = [
    {
      id: 'drizzle', name: '细雨', desc: '常态港区雨，地面积水反光',
      zen: 0x44556a, hor: 0xf9c490, away: 0x8a7f7a, sunCol: 0xffddad,
      sunI: 11, rain: .6, wet: 1, haze: .42, exp: 1.1, wind: [-2.6, -9.4, 1.1]
    },
    {
      id: 'clear', name: '破晓晴', desc: '雨停云开，暖光直射集装箱',
      zen: 0x46709f, hor: 0xffc98a, away: 0xa8876a, sunCol: 0xffe6bd,
      sunI: 36, rain: 0, wet: .1, haze: .34, exp: 1.6, wind: [-.6, -9.4, .3]
    },
    {
      id: 'overcast', name: '阴天', desc: '云层压低，光线转冷变硬',
      zen: 0x44525f, hor: 0x9aa4ae, away: 0x6e767e, sunCol: 0xc8d2dc,
      sunI: 14, rain: .15, wet: .45, haze: .62, exp: 1.15, wind: [-1.4, -9.4, .6]
    },
    {
      id: 'storm', name: '暴雨', desc: '雨幕压低能见度，风推斜雨',
      zen: 0x3d4e63, hor: 0x9aa7b3, away: 0x66707a, sunCol: 0xb8c4d2,
      sunI: 14, rain: 1, wet: 1, haze: .95, exp: 1.2, wind: [-6, -9.4, 2.4]
    },
    {
      id: 'thunder', name: '雷暴', desc: '闪电劈落，天地瞬间发白',
      zen: 0x354555, hor: 0x6a7786, away: 0x4c5760, sunCol: 0xa8b9cb,
      sunI: 12, rain: 1, wet: 1, haze: 1.08, exp: 1.2, wind: [-8, -9.4, 3.2], bolt: true
    },
    {
      id: 'fog', name: '海雾', desc: '浓雾漫上码头，远景白到发灰',
      zen: 0x76818c, hor: 0xd2d8de, away: 0x9aa1a8, sunCol: 0xdde4ea,
      sunI: 16, rain: .1, wet: .9, haze: 1.55, exp: 1.45, wind: [-.8, -9.4, .2]
    }
  ];

  function byId(id) {
    for (var i = 0; i < WEATHERS.length; i++) { if (WEATHERS[i].id === id) return WEATHERS[i]; }
    return WEATHERS[0];
  }

  /* ---------- 运行时句柄 ---------- */
  var G = null, THREE = null, skyU = null, sun = null, tune = null, post = null;
  var rainMesh = null, splashMesh = null, rainVel = null;

  var S = null;                 // 当前实际值（每帧向 T 靠拢）
  var T = null;                 // 目标值
  var cur = WEATHERS[0].id;
  var auto = true;
  var nextAt = 0;               // 下次自动换天气的时刻（秒）
  var myFlash = 0;              // 叠加在 post.flash 上的瞬时闪光
  var hudFlashUntil = 0;

  function num(v) { return typeof v === 'number' && isFinite(v); }

  function loadSettings() {
    try {
      var id = localStorage.getItem(KEY);
      if (id && byId(id).id === id) cur = id;
      var a = localStorage.getItem(AKEY);
      if (a === '0') auto = false; else if (a === '1') auto = true;
    } catch (e) { }
    var m = /[?&]wx=([a-z]+)/.exec(location.search);
    if (m) {
      var w = byId(m[1]);
      if (w && w.id === m[1]) { cur = m[1]; auto = false; }
    }
  }

  function save() {
    try { localStorage.setItem(KEY, cur); localStorage.setItem(AKEY, auto ? '1' : '0'); } catch (e) { }
  }

  function readState() {
    var fallbackZen = new THREE.Color(0x425265);
    var fallbackHor = new THREE.Color(0xf9c490);
    var zen = skyU && skyU.uZen ? skyU.uZen.value.clone() : fallbackZen;
    var hor = skyU && skyU.uHor ? skyU.uHor.value.clone() : fallbackHor;
    var away = (skyU && skyU.uHorAway && skyU.uHorAway.value) ? skyU.uHorAway.value.clone() : hor.clone();
    return {
      zen: zen,
      hor: hor,
      away: away,
      sunCol: sun && sun.color ? sun.color.clone() : new THREE.Color(0xffddad),
      sunI: sun ? sun.intensity : 9,
      rain: (rainMesh && rainMesh.material && rainMesh.material.uniforms && rainMesh.material.uniforms.uRain) ? rainMesh.material.uniforms.uRain.value : .6,
      wet: (post && num(post.wet)) ? post.wet : 1,
      haze: (tune && num(tune.volFarHaze)) ? tune.volFarHaze : .42,
      wx: rainVel ? rainVel.x : -2.6,
      wy: rainVel ? rainVel.y : -9.4,
      wz: rainVel ? rainVel.z : 1.1,
      exp: (G && G.render && num(G.render.exposure)) ? G.render.exposure : 1,
      flash: 0
    };
  }

  function setTarget(w) {
    T.zen.setHex(w.zen);
    T.hor.setHex(w.hor);
    T.away.setHex(w.away);
    T.sunCol.setHex(w.sunCol);
    T.sunI = w.sunI;
    T.rain = w.rain;
    T.wet = w.wet;
    T.haze = w.haze;
    T.wx = w.wind[0];
    T.wy = w.wind[1];
    T.wz = w.wind[2];
    T.exp = w.exp;
  }

  function grab() {
    if (!window.__G) return false;
    var g = window.__G;
    if (!g.scene || !g.render || !g.THREE) return false;
    G = g;
    THREE = g.THREE;
    skyU = (g.render.sky && g.render.sky.material && g.render.sky.material.uniforms) ? g.render.sky.material.uniforms : null;
    sun = g.render.sun || null;
    tune = g.render.tune || null;
    post = g.render.post || null;
    rainMesh = g.scene.getObjectByName('rain') || null;
    splashMesh = g.scene.getObjectByName('rainSplash') || null;
    rainVel = (rainMesh && rainMesh.material && rainMesh.material.uniforms && rainMesh.material.uniforms.uVel) ? rainMesh.material.uniforms.uVel.value : null;
    if (!skyU || !sun || !THREE) return false;

    /* 雨量与可见性：内部 setRain 受相机区域限制，这里直接接管渲染期取值 */
    bindRain(rainMesh);
    bindRain(splashMesh);

    if (!S) {
      S = readState();
      T = readState();
      setTarget(byId(cur));
      snap();
      nextAt = performance.now() / 1000 + 18 + Math.random() * 10;
      syncUI();
    }
    return true;
  }

  /* 首帧直接对齐目标天气：进入游戏时就该是当前天候，而不是从上次的残值慢慢漂过去 */
  function snap() {
    S.zen.copy(T.zen);
    S.hor.copy(T.hor);
    S.away.copy(T.away);
    S.sunCol.copy(T.sunCol);
    S.sunI = T.sunI;
    S.rain = T.rain;
    S.wet = T.wet;
    S.haze = T.haze;
    S.wx = T.wx;
    S.wy = T.wy;
    S.wz = T.wz;
    S.exp = T.exp;
    S.flash = 0;
  }

  function bindRain(m) {
    if (!m || m.__kaWx) return;
    try {
      Object.defineProperty(m, 'visible', {
        configurable: true,
        enumerable: true,
        get: function () { return S.rain > .012; },
        set: function () { /* 内部每帧写入，忽略 */ }
      });
    } catch (e) { }
    m.onBeforeRender = function () {
      var u = m.material && m.material.uniforms;
      if (u && u.uRain) u.uRain.value = S.rain;
    };
    m.__kaWx = 1;
  }

  /* ---------- 主循环 ---------- */
  var last = 0;

  function loop(ts) {
    var now = ts / 1000;
    if (!last) last = now;
    var dt = now - last;
    last = now;
    if (dt > .08) dt = .08;
    if (dt < 0) dt = 0;

    if (!G && !grab()) { requestAnimationFrame(loop); return; }
    if (!S) { requestAnimationFrame(loop); return; }

    /* 自动轮转 */
    if (auto && now > nextAt) {
      var nx = cur;
      while (nx === cur) nx = WEATHERS[Math.floor(Math.random() * WEATHERS.length)].id;
      cur = nx;
      setTarget(byId(cur));
      nextAt = now + 55 + Math.random() * 45;
      save();
      syncUI();
      hudPulse();
    }

    /* 平滑过渡：约 1.2s 时间常数 */
    var k = 1 - Math.exp(-dt / 1.2);
    S.zen.lerp(T.zen, k);
    S.hor.lerp(T.hor, k);
    S.away.lerp(T.away, k);
    S.sunCol.lerp(T.sunCol, k);
    S.sunI += (T.sunI - S.sunI) * k;
    S.rain += (T.rain - S.rain) * k;
    S.wet += (T.wet - S.wet) * k;
    S.haze += (T.haze - S.haze) * k;
    S.wx += (T.wx - S.wx) * k;
    S.wy += (T.wy - S.wy) * k;
    S.wz += (T.wz - S.wz) * k;
    S.exp += (T.exp - S.exp) * k;

    /* 闪电：雷暴时随机劈落；其余天气只跟随游戏自身的雷声 */
    var w = byId(cur);
    if (S.flash > 0) S.flash = Math.max(0, S.flash - dt * 3.4);
    if (myFlash > 0) myFlash = Math.max(0, myFlash - dt * 2.1);
    if (w.bolt && S.flash <= .02) {
      if (!S.__nextBolt) S.__nextBolt = now + 4 + Math.random() * 5;
      if (now > S.__nextBolt) {
        bolt();
        S.__nextBolt = now + 5 + Math.random() * 7;
      }
    }

    /* 写入运行时（每帧覆盖，确保不被内部逻辑改回） */
    try {
      sun.intensity = S.sunI;
      sun.color.copy(S.sunCol);
      if (G.render && num(G.render.exposure)) G.render.exposure = S.exp;
      if (post) {
        post.wet = S.wet;
        if (myFlash > 0) post.flash = Math.max(post.flash || 0, myFlash);
      }
      if (tune && num(tune.volFarHaze)) tune.volFarHaze = S.haze;
      if (skyU) {
        skyU.uZen.value.copy(S.zen);
        skyU.uHor.value.copy(S.hor);
        if (skyU.uHorAway && skyU.uHorAway.value) skyU.uHorAway.value.copy(S.away);
        if (skyU.uSunCol) skyU.uSunCol.value.copy(S.sunCol);
        if (skyU.uFlash) skyU.uFlash.value = S.flash;
      }
      if (rainVel) rainVel.set(S.wx, S.wy, S.wz);
    } catch (e) { }

    if (hudFlashUntil && now > hudFlashUntil) {
      hudFlashUntil = 0;
      if (hud) hud.classList.remove('is-shift');
    }

    requestAnimationFrame(loop);
  }

  function bolt() {
    S.flash = 1;
    myFlash = .55;
    /* 视觉闪电后补一声雷；内部若已监听 thunder 事件会直接播放 */
    setTimeout(function () {
      try { if (G && G.events && G.events.emit) G.events.emit('thunder', { source: 'weather' }); } catch (e) { }
    }, 900);
  }

  /* ---------- 面板 ---------- */
  var panel = null, grid = null, curText = null, toggleBtn = null, hud = null;

  function skyGradient(w) {
    var z = '#' + ('000000' + w.zen.toString(16)).slice(-6);
    var h = '#' + ('000000' + w.hor.toString(16)).slice(-6);
    return 'linear-gradient(180deg,' + z + ' 0%,' + h + ' 100%)';
  }

  function buildPanel() {
    panel = document.createElement('div');
    panel.id = 'ka-wx-panel';
    var cards = WEATHERS.map(function (w, i) {
      return '<button class="kw-card" type="button" data-wx="' + w.id + '">' +
        '<span class="kw-swatch" style="background:' + skyGradient(w) + '">' +
        '<i></i><span class="kw-num">0' + (i + 1) + '</span></span>' +
        '<span class="kw-name">' + w.name + '<span class="kw-tag" hidden>生效中</span></span>' +
        '<span class="kw-desc">' + w.desc + '</span>' +
        '</button>';
    }).join('');

    panel.innerHTML =
      '<div class="kw-veil"></div>' +
      '<div class="kw-box" role="dialog" aria-modal="true" aria-label="天气系统">' +
      '<div class="kw-head">' +
      '<span class="kw-k">KA · 天候控制</span>' +
      '<h3 class="kw-title">变换多端的天气</h3>' +
      '<p class="kw-sub">光照、天空、雨量与远景雾同步过渡；自动循环每 1～1.5 分钟换一次天。游戏内按 K 可快速切换。</p>' +
      '</div>' +
      '<div class="kw-grid">' + cards + '</div>' +
      '<div class="kw-foot">' +
      '<span class="kw-cur">当前天候：<b>—</b></span>' +
      '<button class="kw-toggle" type="button">自动循环</button>' +
      '<button class="kw-close" type="button">完成</button>' +
      '</div>' +
      '</div>';

    document.body.appendChild(panel);
    grid = panel.querySelector('.kw-grid');
    curText = panel.querySelector('.kw-cur b');
    toggleBtn = panel.querySelector('.kw-toggle');

    panel.querySelector('.kw-veil').addEventListener('click', close);
    panel.querySelector('.kw-close').addEventListener('click', close);
    toggleBtn.addEventListener('click', function () { setAuto(!auto); });
    grid.addEventListener('click', function (ev) {
      var card = ev.target.closest ? ev.target.closest('.kw-card') : null;
      if (!card) return;
      choose(card.getAttribute('data-wx'), false);
    });
  }

  function choose(id, keepAuto) {
    var w = byId(id);
    cur = w.id;
    setTarget(w);
    if (!keepAuto) setAuto(false);
    nextAt = performance.now() / 1000 + 55 + Math.random() * 45;
    if (S) S.__nextBolt = performance.now() / 1000 + 3 + Math.random() * 4;
    save();
    syncUI();
    hudPulse();
  }

  function setAuto(v) {
    auto = !!v;
    nextAt = performance.now() / 1000 + (auto ? 12 + Math.random() * 8 : 1e9);
    save();
    syncUI();
  }

  function syncUI() {
    var w = byId(cur);
    if (grid) {
      var cards = grid.querySelectorAll('.kw-card');
      for (var i = 0; i < cards.length; i++) {
        var c = cards[i];
        var on = c.getAttribute('data-wx') === cur;
        c.className = 'kw-card' + (on ? ' is-on' : '');
        var tag = c.querySelector('.kw-tag');
        if (tag) tag.hidden = !on;
      }
    }
    if (curText) curText.textContent = w.name;
    if (toggleBtn) {
      toggleBtn.textContent = '自动循环 · ' + (auto ? '开' : '关');
      toggleBtn.className = 'kw-toggle' + (auto ? ' is-on' : '');
    }
    var bars = document.querySelectorAll('.ka-wx-bar .kw-bar-v');
    for (var j = 0; j < bars.length; j++) bars[j].textContent = w.name;
    if (hud) {
      var t = hud.querySelector('.kw-hud-t');
      if (t) t.textContent = w.name;
      var d = hud.querySelector('.kw-hud-dot');
      if (d) {
        var hx = '#' + ('000000' + w.hor.toString(16)).slice(-6);
        d.style.background = hx;
        d.style.boxShadow = '0 0 9px ' + hx;
      }
      var s = hud.querySelector('.kw-hud-s');
      if (s) s.textContent = auto ? 'AUTO' : 'HOLD';
    }
  }

  function hudPulse() {
    if (!hud) return;
    hud.classList.add('is-shift');
    hudFlashUntil = performance.now() / 1000 + 1.6;
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
    if (panel && panel.classList.contains('on')) {
      if (ev.key === 'Escape' || ev.key === 'Esc') {
        ev.preventDefault();
        ev.stopPropagation();
        close();
      }
      return;
    }
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    var k = ev.key || '';
    if (k === 'k' || k === 'K') {
      var i = 0;
      for (var j = 0; j < WEATHERS.length; j++) { if (WEATHERS[j].id === cur) { i = j; break; } }
      var nw = WEATHERS[(i + 1) % WEATHERS.length];
      ev.preventDefault();
      ev.stopPropagation();
      choose(nw.id, false);
    }
  }, true);

  /* ---------- 菜单入口 ---------- */
  function makeHud() {
    hud = document.createElement('div');
    hud.id = 'ka-wx-hud';
    hud.innerHTML = '<span class="kw-hud-dot"></span>' +
      '<span class="kw-hud-t">—</span>' +
      '<span class="kw-hud-s">AUTO</span>';
    document.body.appendChild(hud);
  }

  function makeBar() {
    var bar = document.createElement('div');
    bar.className = 'ka-wx-bar';
    bar.innerHTML = '<span class="kw-bar-k">天候 · 当前</span>' +
      '<b class="kw-bar-v">' + byId(cur).name + '</b>' +
      '<button class="btn small kw-bar-open" type="button" data-wx-entry="1">切换天气</button>';
    bar.querySelector('.kw-bar-open').addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      open();
    });
    return bar;
  }

  function mountEntry() {
    /* 标题页：紧跟在涂装状态条之后，避免破坏按钮阵列 */
    var title = document.querySelector('[data-s="title"] .m-actions');
    if (title && !document.querySelector('.ka-wx-bar')) {
      var skinBar = title.parentNode.querySelector('.ka-skin-bar');
      var anchor = skinBar || title;
      anchor.insertAdjacentElement('afterend', makeBar());
    }

    /* 暂停菜单：追加一枚按钮，与「枪械皮肤」并列 */
    var bars = document.querySelectorAll('[data-s="paused"] .m-actions');
    for (var i = 0; i < bars.length; i++) {
      var bar = bars[i];
      if (bar.querySelector('[data-wx-entry]')) continue;
      var btn = document.createElement('button');
      btn.className = 'btn';
      btn.type = 'button';
      btn.setAttribute('data-wx-entry', '1');
      btn.textContent = '天气';
      btn.addEventListener('click', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        open();
      });
      bar.appendChild(btn);
    }
    syncUI();
  }

  loadSettings();
  makeHud();

  var tries = 0;
  var mountTimer = setInterval(function () {
    mountEntry();
    if (++tries > 40) clearInterval(mountTimer);
  }, 500);

  var grabTries = 0;
  var grabTimer = setInterval(function () {
    if (grab() || ++grabTries > 150) clearInterval(grabTimer);
  }, 300);

  requestAnimationFrame(loop);

  if (/[?&]wxpanel=1/.test(location.search)) {
    setTimeout(open, 1200);
  }

  window.__kaWeather = {
    list: function () { return WEATHERS.map(function (w) { return w.id + ':' + w.name; }); },
    current: function () { return cur; },
    auto: function () { return auto; },
    choose: function (id) { choose(id, false); return cur; },
    setAuto: setAuto,
    open: open,
    close: close,
    state: function () {
      if (!S) return null;
      return {
        mode: cur,
        auto: auto,
        rain: +S.rain.toFixed(3),
        wet: +S.wet.toFixed(3),
        haze: +S.haze.toFixed(3),
        sunI: +S.sunI.toFixed(2),
        exp: +S.exp.toFixed(2),
        sunCol: S.sunCol.getHex(),
        zen: S.zen.getHex(),
        hor: S.hor.getHex(),
        flash: +S.flash.toFixed(2),
        rainVisible: rainMesh ? rainMesh.visible : null
      };
    }
  };
})();
