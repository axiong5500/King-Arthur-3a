/* 亚瑟王中王 · 双人联机层
 * 架构：房主（host）权威模拟敌人，加入者（guest）只做表现与射线反馈。
 * 依赖：内联的 PeerJS（由 build.ps1 注入，标记 #ka-mp-lib）。
 */
(function () {
  'use strict';

  var G = null, THREE = null;
  var Q = new URLSearchParams(location.search);

  var CFG = {
    hz: 20,
    prefix: 'ka3a-',
    dmg: 34,
    maxDist: 300,
    interp: 12
  };

  // ---------------- 状态 -------------------
  var S = {
    role: 'solo',
    peer: null,
    conn: null,
    code: '',
    connected: false,
    playerId: '',
    map: {},            // host enemyId -> { inst, tx,ty,tz, tyaw, alive, hp }
    remote: null,       // { x,y,z,yaw,pitch,hp,alive }
    internalSpawn: false,
    guestHooked: false,
    sending: false,
    lastShot: 0
  };

  var avatars = { remote: null };

  // ---------------- 工具 -------------------
  function mkCode() {
    var A = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
    var s = '';
    for (var i = 0; i < 4; i++) s += A[Math.floor(Math.random() * A.length)];
    return s;
  }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }

  function ui(el) { return document.getElementById(el); }
  function setStatus(txt, tone) {
    var n = ui('ka-mp-status');
    if (!n) return;
    n.textContent = txt || '';
    n.setAttribute('data-tone', tone || '');
  }
  function setLaunch(state, label) {
    var n = ui('ka-mp-launch');
    if (!n) return;
    n.setAttribute('data-state', state || '');
    n.querySelector('.label').textContent = label || '双人联机';
  }

  // ---------------- 替身 -------------------
  function makeAvatar() {
    var g = new THREE.Group();
    g.name = 'mp-avatar';
    var skin = new THREE.MeshStandardMaterial({ color: 0x2f3740, roughness: 0.78, metalness: 0.18 });
    var cloth = new THREE.MeshStandardMaterial({ color: 0x1d2329, roughness: 0.92, metalness: 0.05 });
    var visor = new THREE.MeshStandardMaterial({ color: 0x0d1418, roughness: 0.3, metalness: 0.6 });
    var lamp = new THREE.MeshStandardMaterial({ color: 0x6fbf73, emissive: 0x6fbf73, emissiveIntensity: 2.2, roughness: 1 });

    var torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.23, 0.62, 4, 10), cloth);
    torso.position.y = 1.02;
    torso.castShadow = true;
    g.add(torso);

    var head = new THREE.Mesh(new THREE.SphereGeometry(0.155, 14, 12), skin);
    head.position.y = 1.55;
    head.castShadow = true;
    g.add(head);

    var vis = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.075, 0.1), visor);
    vis.position.set(0, 1.57, -0.12);
    g.add(vis);

    var tip = new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 8), lamp);
    tip.position.set(0, 1.74, 0);
    g.add(tip);

    [-1, 1].forEach(function (sx) {
      var leg = new THREE.Mesh(new THREE.CapsuleGeometry(0.105, 0.55, 4, 8), cloth);
      leg.position.set(sx * 0.125, 0.36, 0);
      leg.castShadow = true;
      g.add(leg);

      var arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.075, 0.36, 4, 8), skin);
      arm.position.set(sx * 0.27, 1.2, sx * 0.03);
      arm.rotation.z = sx * 0.16;
      g.add(arm);
    });

    // 简化武器：右手前方一段枪身
    var gun = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.085, 0.52), visor);
    gun.position.set(0.2, 1.16, -0.26);
    gun.rotation.x = 0.06;
    g.add(gun);

    g.visible = false;
    g.rotation.order = 'YXZ';
    G.scene.add(g);
    return g;
  }

  function placeAvatar(g, x, y, z, yaw, pitch) {
    if (!g) return;
    g.visible = true;
    g.position.set(x, y, z);
    g.rotation.y = yaw || 0;
    g.rotation.x = 0;
  }

  // ---------------- 网络 -------------------
  function peerOpts() {
    return { debug: 0 };
  }

  function ensurePeer() {
    if (S.peer) return S.peer;
    if (typeof Peer === 'undefined') {
      setStatus('信令库未加载（PeerJS 缺失）', 'err');
      return null;
    }
    S.peer = new Peer(CFG.prefix + Crand(), peerOpts());
    S.peer.on('error', function (e) {
      var msg = e && e.type ? e.type : 'unknown';
      if (msg === 'peer-unavailable') setStatus('房间不存在或对方已离线', 'err');
      else if (msg === 'unavailable-id') setStatus('房间号被占用，重试', 'warn');
      else setStatus('连接错误：' + msg, 'err');
    });
    return S.peer;
  }
  function Crand() {
    return Math.random().toString(36).slice(2, 8);
  }

  function bindConn(conn) {
    S.conn = conn;
    conn.on('open', function () {
      S.connected = true;
      setStatus(
        S.role === 'host' ? '队友已加入，开始同步' : '已连接到房主',
        'ok'
      );
      setLaunch(S.role, S.role === 'host' ? '房主 · 已连接' : '队友 · 已连接');
      updateHud();
      // 首包：告诉对方自己是谁
      send({ t: 'hello', role: S.role, name: S.role === 'host' ? '房主' : '队友' });
    });
    conn.on('data', onData);
    conn.on('close', function () {
      S.connected = false;
      S.conn = null;
      setStatus('对方已断开', 'warn');
      setLaunch('', '双人联机');
      updateHud();
    });
    conn.on('error', function () { setStatus('数据通道错误', 'err'); });
  }

  function send(msg) {
    if (S.conn && S.connected) {
      try { S.conn.send(msg); } catch (e) { /* 通道抖动忽略 */ }
    }
  }

  function onData(m) {
    if (!m || !m.t) return;
    if (m.t === 'hello') {
      setStatus((m.role === 'host' ? '房主' : '队友') + '已就绪', 'ok');
      return;
    }
    if (m.t === 'st') {
      if (S.role === 'host') onRemoteSelf(m); else onState(m);
      return;
    }
    if (m.t === 'shot' && S.role === 'host') { onRemoteShot(m); return; }
    if (m.t === 'hit') { onHitMsg(m); return; }
  }

  // ---------------- 主机 -------------------
  function hostTick() {
    if (!S.connected) return;
    var p = G.player;
    var list = G.enemies.list || [];
    var arr = [];
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      if (!e.active) continue;
      arr.push({
        i: e.id,
        k: e.type === 'hound' ? 1 : 0,
        x: +e.pos.x.toFixed(2),
        y: +e.pos.y.toFixed(2),
        z: +e.pos.z.toFixed(2),
        w: +e.yaw.toFixed(2),
        a: e.alive ? 1 : 0,
        h: Math.round(e.hp)
      });
    }
    send({
      t: 'st',
      p: {
        x: +p.pos.x.toFixed(2), y: +p.pos.y.toFixed(2), z: +p.pos.z.toFixed(2),
        w: +p.yaw.toFixed(3), q: +p.pitch.toFixed(3),
        h: Math.round(p.health), a: p.alive ? 1 : 0,
        c: p.crouching ? 1 : 0, s: p.sprinting ? 1 : 0
      },
      e: arr
    });
  }

  function onRemoteSelf(m) {
    if (!m.p) return;
    if (!S.remote) S.remote = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, hp: 100, alive: true };
    var r = S.remote;
    r.x = m.p.x; r.y = m.p.y; r.z = m.p.z;
    r.yaw = m.p.w; r.pitch = m.p.q;
    r.hp = m.p.h; r.alive = !!m.p.a;
  }

  function onRemoteShot(m) {
    if (!m.o || !m.d) return;
    var o = new THREE.Vector3(m.o[0], m.o[1], m.o[2]);
    var d = new THREE.Vector3(m.d[0], m.d[1], m.d[2]).normalize();
    var hit = null;
    try { hit = G.enemies.raycast(o, d, CFG.maxDist); } catch (e) { hit = null; }
    if (hit && hit.enemy) {
      var en = hit.enemy;
      en.hp -= CFG.dmg;
      send({ t: 'hit', i: en.id, h: Math.round(en.hp), a: en.alive ? 1 : 0, x: hit.point.x, y: hit.point.y, z: hit.point.z });
    }
  }

  // ---------------- 加入者 -------------------
  function guestHooks() {
    if (S.guestHooked) return;
    S.guestHooked = true;

    var origSpawn = G.enemies.spawn;
    G.enemies.spawn = function (type, pos, opts) {
      if (S.role === 'guest' && !S.internalSpawn) return null;
      return origSpawn.call(G.enemies, type, pos, opts);
    };

    var origUpdate = G.enemies.update;
    G.enemies.update = function (dt) {
      origUpdate.call(G.enemies, dt);
      if (S.role === 'guest') driveGuest(dt);
    };
  }

  function spawnGhost(idKey, isHound, x, y, z, yaw) {
    var pos = new THREE.Vector3(x, y, z);
    S.internalSpawn = true;
    var inst = null;
    try { inst = G.enemies.spawn(isHound ? 'hound' : 'gull', pos, { passive: true, state: 'patrol' }); } catch (e) { inst = null; }
    S.internalSpawn = false;
    if (!inst) return null;
    // 冻结本地 AI：只保留表现，位置由网络驱动
    inst._update = function () {};
    inst.passive = true;
    S.map[idKey] = {
      inst: inst, tx: x, ty: y, tz: z, tyaw: yaw,
      alive: true, hp: inst.hp
    };
    return S.map[idKey];
  }

  function onState(m) {    if (S.role !== 'guest') return;
    if (m.p) {
      if (!S.remote) S.remote = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, hp: 100, alive: true };
      var r = S.remote;
      r.x = m.p.x; r.y = m.p.y; r.z = m.p.z;
      r.yaw = m.p.w; r.pitch = m.p.q;
      r.hp = m.p.h; r.alive = !!m.p.a;
    }
    if (m.e) {
      var seen = {};
      for (var i = 0; i < m.e.length; i++) {
        var d = m.e[i];
        var key = String(d.i);
        seen[key] = 1;
        var ent = S.map[key];
        if (!ent) ent = spawnGhost(key, d.k === 1, d.x, d.y, d.z, d.w);
        if (!ent) continue;
        ent.tx = d.x; ent.ty = d.y; ent.tz = d.z; ent.tyaw = d.w;
        ent.alive = !!d.a;
        ent.hp = d.h;
        if (!d.a && ent.inst) {
          ent.inst.alive = false;
        }
      }
      // 主机已回收的敌人
      for (var k in S.map) {
        if (!seen[k]) {
          var z = S.map[k];
          if (z && z.inst) {
            z.inst.alive = false;
            if (z.inst.rig && z.inst.rig.group) z.inst.rig.group.visible = false;
          }
          delete S.map[k];
        }
      }
    }
    updateHud();
  }

  function driveGuest(dt) {
    var f = clamp(dt * CFG.interp, 0, 1);
    for (var k in S.map) {
      var e = S.map[k];
      if (!e || !e.inst) continue;
      var inst = e.inst;
      if (!e.alive) {
        if (inst.rig && inst.rig.group) inst.rig.group.visible = false;
        continue;
      }
      // 位置平滑 + 同步到内部状态（保证本地 raycast 与画面一致）
      inst.pos.x = lerp(inst.pos.x, e.tx, f);
      inst.pos.y = lerp(inst.pos.y, e.ty, f);
      inst.pos.z = lerp(inst.pos.z, e.tz, f);
      inst.yaw = e.tyaw;
      if (inst.rig && inst.rig.group) {
        var gr = inst.rig.group;
        gr.visible = true;
        gr.position.copy(inst.pos);
        gr.rotation.y = inst.yaw;
        // 旋翼自转 + 轻微悬浮，保底表现
        var bones = inst.rig.bones || {};
        for (var bn in bones) {
          var b = bones[bn];
          if (b && b.rotation && /rotor/i.test(bn)) b.rotation.y += dt * 26;
        }
        var t = performance.now() * 0.001;
        gr.position.y += Math.sin(t * 2.1 + (inst.id || 0)) * 0.05;
      }
    }
  }

  function onHitMsg(m) {
    var ent = S.map[String(m.i)];
    if (ent) {
      ent.hp = m.h;
      if (!m.a) {
        ent.alive = false;
        if (ent.inst) {
          ent.inst.alive = false;
          if (ent.inst.rig && ent.inst.rig.group) ent.inst.rig.group.visible = false;
        }
      }
    }
    if (m.a) flashHit(m);
  }

  function flashHit(m) {
    if (G.hud && G.hud.hitmarker) {
      try { G.hud.hitmarker(); } catch (e) { /* 忽略 */ }
    }
  }

  // ---------------- 开火转发 -------------------
  function onLocalFire(ev) {
    if (S.role !== 'guest' || !S.connected) return;
    var now = performance.now();
    if (now - S.lastShot < 40) return;
    S.lastShot = now;

    var cam = G.camera;
    var dir = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    var org = new THREE.Vector3();
    if (G.weapon.muzzleWorld) {
      try { var mw = G.weapon.muzzleWorld(); if (mw && mw.isVector3) org.copy(mw); } catch (e) { org.copy(cam.position); }
    } else {
      org.copy(cam.position);
    }
    if (!org.lengthSq()) org.copy(cam.position);

    send({
      t: 'shot',
      o: [+org.x.toFixed(2), +org.y.toFixed(2), +org.z.toFixed(2)],
      d: [+dir.x.toFixed(3), +dir.y.toFixed(3), +dir.z.toFixed(3)]
    });
  }

  // ---------------- 房间 -------------------
  function hostRoom(code) {
    if (S.connected) return;
    S.role = 'host';
    S.code = (code || mkCode()).toUpperCase();
    if (typeof Peer === 'undefined') {
      setStatus('信令库未加载（PeerJS 缺失）', 'err');
      return;
    }
    // 已存在其他 peer（例如先点了加入）就重建，host 必须用房间号当 id
    if (S.peer) { try { S.peer.destroy(); } catch (e) { } S.peer = null; }

    S.peer = new Peer(CFG.prefix + S.code, peerOpts());
    S.peer.on('open', function () {
      setStatus('房间已创建，等待队友加入', 'ok');
      showRoom(S.code);
      guestHooks(); // 主机也装钩子，只是 guest 分支不激活
      setLaunch('host', '房主 · 等待');
    });
    S.peer.on('connection', function (c) {
      if (S.conn) { try { c.close(); } catch (e) { } return; }
      bindConn(c);
    });
    S.peer.on('error', function (e) {
      var ty = (e && e.type) || 'unknown';
      if (ty === 'unavailable-id') setStatus('房间号冲突，换一个再试', 'err');
      else if (ty === 'network') setStatus('信令服务器连接失败', 'err');
      else setStatus('信令错误：' + ty, 'err');
    });
    setLaunch('host', '房主 · 创建中');
  }

  function joinRoom(code) {
    if (S.connected) return;
    S.role = 'guest';
    S.code = (code || '').toUpperCase().trim();
    if (!S.code) { setStatus('请输入房号', 'warn'); return; }
    var peer = ensurePeer();
    if (!peer) return;
    guestHooks();

    peer.on('open', function () {
      var c = peer.connect(CFG.prefix + S.code, { reliable: true });
      if (!c) { setStatus('无法创建连接', 'err'); return; }
      c.on('open', function () { bindConn(c); });
      c.on('error', function () { setStatus('连接失败，检查房号', 'err'); });
      setTimeout(function () { if (!S.connected) setStatus('连接超时，房号可能不正确', 'err'); }, 8000);
    });
    setLaunch('guest', '队友 · 连接中');
  }

  function showRoom(code) {
    var box = ui('ka-mp-room');
    var codeEl = ui('ka-mp-room-code');
    if (box) box.setAttribute('data-on', '1');
    if (codeEl) codeEl.textContent = code;
  }

  // ---------------- HUD -------------------
  function updateHud() {
    var n = ui('ka-mp-hud');
    if (!n) return;
    if (!S.connected) { n.setAttribute('data-on', '0'); return; }
    n.setAttribute('data-on', '1');
    var mate = n.querySelector('.mate');
    var hp = n.querySelector('.hpbar i');
    if (mate) mate.textContent = S.role === 'host' ? '队友' : '房主';
    var hpp = S.role === 'guest' && S.remote ? clamp(S.remote.hp, 0, 100) : 100;
    if (hp) hp.style.width = hpp + '%';
  }

  // ---------------- UI -------------------
  function buildUI() {
    var launch = document.createElement('div');
    launch.id = 'ka-mp-launch';
    launch.innerHTML = '<span class="dot"></span><span class="label">双人联机</span>';
    launch.addEventListener('click', function () { togglePanel(true); });
    document.body.appendChild(launch);

    var panel = document.createElement('div');
    panel.id = 'ka-mp-panel';
    panel.innerHTML =
      '<div id="ka-mp-card">' +
      '  <h2>双人联机</h2>' +
      '  <p class="sub">房主创建房间并把房号发给队友；队友输入房号加入。敌人由房主模拟。</p>' +
      '  <div id="ka-mp-room"><div class="code" id="ka-mp-room-code">----</div><div class="hint">把上面这串房号发给队友</div></div>' +
      '  <div class="field"><input id="ka-mp-input" maxlength="4" placeholder="输入房号" autocomplete="off" spellcheck="false"><button class="primary" id="ka-mp-join">加入</button></div>' +
      '  <div class="field"><button id="ka-mp-host" style="flex:1 1 auto">创建房间</button></div>' +
      '  <div id="ka-mp-status"></div>' +
      '  <div id="ka-mp-actions"><button class="ghost" id="ka-mp-close">关闭</button></div>' +
      '</div>';
    document.body.appendChild(panel);

    var hud = document.createElement('div');
    hud.id = 'ka-mp-hud';
    hud.innerHTML = '<span class="mate">队友</span><span class="hpbar"><i></i></span>';
    document.body.appendChild(hud);

    ui('ka-mp-host').addEventListener('click', function () {
      if (S.role === 'host' && S.code) { showRoom(S.code); setStatus('房间已存在，等待队友', 'ok'); return; }
      hostRoom(mkCode());
    });
    ui('ka-mp-join').addEventListener('click', function () {
      joinRoom(ui('ka-mp-input').value);
    });
    ui('ka-mp-input').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') joinRoom(ui('ka-mp-input').value);
    });
    ui('ka-mp-close').addEventListener('click', function () { togglePanel(false); });
    panel.addEventListener('click', function (e) { if (e.target === panel) togglePanel(false); });

    window.addEventListener('keydown', function (e) {
      if (e.key === 'm' || e.key === 'M') {
        if (e.target && /input|textarea/i.test(e.target.tagName)) return;
        togglePanel(panel.getAttribute('data-open') !== '1');
      }
    });
  }

  function togglePanel(open) {
    var p = ui('ka-mp-panel');
    if (!p) return;
    p.setAttribute('data-open', open ? '1' : '0');
    if (open && S.code && !S.connected) showRoom(S.code);
  }

  // ---------------- 自检：不依赖两台机器，验证信令与数据通道 -------------------
  function selftest() {
    var tag = Math.random().toString(36).slice(2, 7);
    var nameA = CFG.prefix + 'sf' + tag + 'a';
    var nameB = CFG.prefix + 'sf' + tag + 'b';
    var done = false;
    function fail(why) {
      if (done) return; done = true;
      document.title = 'SELFTEST:ERR:' + why;
    }
    var timer = setTimeout(function () { fail('timeout'); }, 12000);

    var A = new Peer(nameA, peerOpts());
    A.on('error', function (e) { fail('A:' + (e && e.type)); });
    A.on('open', function () {
      var B = new Peer(nameB, peerOpts());
      B.on('error', function (e) { fail('B:' + (e && e.type)); });
      A.on('connection', function (c) {
        c.on('data', function (m) {
          if (m && m.t === 'ping') c.send({ t: 'pong', echo: m.seq });
        });
      });
      B.on('open', function () {
        var c = B.connect(nameA, { reliable: true });
        c.on('error', function (e) { fail('conn:' + (e && e.type)); });
        c.on('open', function () { c.send({ t: 'ping', seq: 7 }); });
        c.on('data', function (m) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          var ok = m && m.t === 'pong' && m.echo === 7;
          document.title = 'SELFTEST:' + (ok ? 'OK' : 'BADPAYLOAD') + ':' + JSON.stringify(m);
          try { A.destroy(); B.destroy(); } catch (e) { }
        });
      });
    });
  }

  // ---------------- 主循环 -------------------
  function boot() {
    if (Q.get('selftest') === '1') { selftest(); return; }
    avatars.remote = makeAvatar();
    buildUI();

    if (G.events && G.events.on) {
      try { G.events.on('weapon:fire', onLocalFire); } catch (e) { /* 事件名不存在则跳过 */ }
      // 敌人死亡立刻广播，让队友侧同步消失（不必等下一个状态包）
      try {
        G.events.on('enemy:killed', function (payload) {
          if (S.role !== 'host' || !S.connected) return;
          var id = payload && payload.enemy && payload.enemy.id;
          if (id != null) send({ t: 'hit', i: id, h: 0, a: 0 });
        });
      } catch (e) { }
    }

    // 统一 tick：20Hz 发包
    setInterval(function () {
      if (!S.connected) return;
      if (S.role === 'host') hostTick();
      else if (S.role === 'guest') guestSendSelf();
    }, 1000 / CFG.hz);

    // 渲染帧：替身跟随
    (function frame() {
      try {
        if (S.connected) {
          if (S.role === 'host' && S.remote) {
            placeAvatar(avatars.remote, S.remote.x, S.remote.y, S.remote.z, S.remote.yaw, S.remote.pitch);
          } else if (S.role === 'guest' && S.remote) {
            placeAvatar(avatars.remote, S.remote.x, S.remote.y, S.remote.z, S.remote.yaw, S.remote.pitch);
          }
        } else if (avatars.remote) {
          avatars.remote.visible = false;
        }
      } catch (e) { /* 渲染异常不阻塞主循环 */ }
      requestAnimationFrame(frame);
    })();

    // 自动流程（便于测试）
    if (Q.get('room')) {
      joinRoom(Q.get('room'));
      togglePanel(true);
    } else if (Q.get('mproom')) {
      hostRoom(Q.get('mproom').toUpperCase());
      togglePanel(true);
    }

    window.__kaMp = S;
    window.__kaMpAvatar = avatars;
  }

  // 游戏是异步初始化的，__G 晚于本脚本挂上 window，所以等它出现
  (function waitForGame() {
    var tries = 0;
    var iv = setInterval(function () {
      var cand = window.__G;
      if (cand && cand.THREE && cand.enemies && cand.player && cand.scene) {
        clearInterval(iv);
        G = cand;
        THREE = cand.THREE;
        try { boot(); } catch (e) { console.error('[mp] 初始化失败', e); }
        return;
      }
      if (++tries > 400) { clearInterval(iv); console.warn('[mp] 等待 __G 超时，联机层未启用'); }
    }, 50);
  })();

  function guestSendSelf() {
    var p = G.player;
    send({
      t: 'st',
      p: {
        x: +p.pos.x.toFixed(2), y: +p.pos.y.toFixed(2), z: +p.pos.z.toFixed(2),
        w: +p.yaw.toFixed(3), q: +p.pitch.toFixed(3),
        h: Math.round(p.health), a: p.alive ? 1 : 0,
        c: p.crouching ? 1 : 0, s: p.sprinting ? 1 : 0
      }
    });
  }

  boot();
})();
