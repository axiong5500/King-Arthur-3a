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
    lastShot: 0,
    fireAt: 0
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

  // ---------------- 替身：程序化特种兵（关节层级 + 姿态）----------------
  var AV_MAT = null;
  function avMat() {
    if (AV_MAT) return AV_MAT;
    AV_MAT = {
      pants: new THREE.MeshStandardMaterial({ color: 0x4b5346, roughness: 0.92, metalness: 0.05, emissive: 0x232a20, emissiveIntensity: 0.2 }),
      shirt: new THREE.MeshStandardMaterial({ color: 0x3c443c, roughness: 0.9, metalness: 0.06, emissive: 0x1b211b, emissiveIntensity: 0.18 }),
      vest: new THREE.MeshStandardMaterial({ color: 0x1e241f, roughness: 0.66, metalness: 0.32, emissive: 0x13170f, emissiveIntensity: 0.15 }),
      gear: new THREE.MeshStandardMaterial({ color: 0x2a302d, roughness: 0.6, metalness: 0.34, emissive: 0x161a17, emissiveIntensity: 0.14 }),
      helmet: new THREE.MeshStandardMaterial({ color: 0x3a4145, roughness: 0.5, metalness: 0.42, emissive: 0x1b2226, emissiveIntensity: 0.16 }),
      visor: new THREE.MeshStandardMaterial({ color: 0x161d20, roughness: 0.16, metalness: 0.9, emissive: 0x2f4046, emissiveIntensity: 0.12 }),
      skin: new THREE.MeshStandardMaterial({ color: 0xa1876f, roughness: 0.82, metalness: 0.02, emissive: 0x4a3b2c, emissiveIntensity: 0.2 }),
      metal: new THREE.MeshStandardMaterial({ color: 0x3d4346, roughness: 0.42, metalness: 0.75, emissive: 0x1a1f21, emissiveIntensity: 0.14 }),
      metal: new THREE.MeshStandardMaterial({ color: 0x2b2f31, roughness: 0.42, metalness: 0.75 }),
      lamp: new THREE.MeshStandardMaterial({ color: 0x79cf80, emissive: 0x79cf80, emissiveIntensity: 3.4, roughness: 1 })
    };
    return AV_MAT;
  }

  // 肢体：关节在原点、整体沿 -Y 延伸 len
  function avLimb(len, r, mat) {
    var g = new THREE.Group();
    var m = new THREE.Mesh(new THREE.CapsuleGeometry(r, Math.max(0.02, len - 2 * r), 3, 8), mat);
    m.position.y = -len * 0.5;
    m.castShadow = true;
    g.add(m);
    return g;
  }

  function avBox(w, h, d, mat, x, y, z) {
    var m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x || 0, y || 0, z || 0);
    m.castShadow = true;
    return m;
  }

  // 步枪：机匣 / 护木 / 枪管 / 弹匣 / 握把 / 枪托 / 瞄具，朝 -Z
  function avRifle(M) {
    var g = new THREE.Group();
    g.add(avBox(0.055, 0.082, 0.30, M.metal, 0, 0, 0));
    g.add(avBox(0.05, 0.066, 0.26, M.gear, 0, -0.004, -0.25));
    var barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.28, 8), M.metal);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 0.006, -0.46);
    g.add(barrel);
    g.add(avBox(0.052, 0.048, 0.07, M.metal, 0, 0.006, -0.55));
    var mag = avBox(0.036, 0.16, 0.072, M.gear, 0, -0.105, -0.09);
    mag.rotation.x = 0.14;
    g.add(mag);
    g.add(avBox(0.038, 0.095, 0.052, M.gear, 0, -0.085, 0.085));
    g.add(avBox(0.046, 0.07, 0.19, M.gear, 0, 0.002, 0.22));
    g.add(avBox(0.026, 0.03, 0.10, M.metal, 0, 0.058, -0.13));
    return g;
  }

  function makeAvatar() {
    var M = avMat();
    var root = new THREE.Group();
    root.name = 'mp-soldier';
    var rig = { phase: 0 };

    // 髋：全身重心（以脚底贴地为基准）
    var hips = new THREE.Group();
    hips.position.y = 0.86;
    root.add(hips);
    rig.hips = hips;
    hips.add(avBox(0.355, 0.205, 0.24, M.pants, 0, -0.03, 0));
    hips.add(avBox(0.385, 0.08, 0.27, M.vest, 0, 0.075, 0));           // 战术腰带
    hips.add(avBox(0.118, 0.12, 0.08, M.vest, 0.157, 0.0, -0.10));     // 腰包
    hips.add(avBox(0.108, 0.105, 0.075, M.vest, -0.163, 0.01, -0.09));

    // 腿
    function buildLeg(sx) {
      var thigh = avLimb(0.38, 0.107, M.pants);
      thigh.position.set(sx * 0.108, -0.075, 0);
      var shin = avLimb(0.36, 0.089, M.pants);
      shin.position.y = -0.38;
      shin.add(avBox(0.168, 0.138, 0.178, M.gear, 0, 0.01, -0.016));    // 护膝
      var foot = avBox(0.138, 0.09, 0.30, M.gear, 0, -0.36, -0.06);     // 战靴
      shin.add(foot);
      thigh.add(shin);
      hips.add(thigh);
      return { thigh: thigh, shin: shin, foot: foot };
    }
    rig.legL = buildLeg(-1);
    rig.legR = buildLeg(1);

    // 躯干
    var chest = new THREE.Group();
    chest.position.y = 0.09;
    hips.add(chest);
    rig.chest = chest;
    chest.add(avBox(0.382, 0.42, 0.228, M.shirt, 0, 0.20, 0));         // 胸廓
    chest.add(avBox(0.412, 0.375, 0.268, M.vest, 0, 0.16, 0));         // 战术背心
    chest.add(avBox(0.09, 0.105, 0.055, M.vest, -0.096, 0.17, -0.145));// 弹匣袋
    chest.add(avBox(0.09, 0.105, 0.055, M.vest, 0, 0.17, -0.145));
    chest.add(avBox(0.09, 0.105, 0.055, M.vest, 0.096, 0.17, -0.145));
    chest.add(avBox(0.078, 0.054, 0.04, M.lamp, -0.145, 0.355, -0.125));// 肩章灯
    chest.add(avBox(0.225, 0.275, 0.125, M.vest, 0, 0.20, 0.168));     // 背包

    // 头
    var head = new THREE.Group();
    head.position.y = 0.445;
    chest.add(head);
    rig.head = head;
    head.add(avBox(0.11, 0.085, 0.11, M.skin, 0, -0.025, 0));           // 颈
    var skull = new THREE.Mesh(new THREE.SphereGeometry(0.118, 12, 10), M.skin);
    skull.position.set(0, 0.058, 0.005);
    skull.castShadow = true;
    head.add(skull);
    var helm = new THREE.Mesh(new THREE.SphereGeometry(0.142, 12, 9, 0, Math.PI * 2, 0, Math.PI * 0.62), M.helmet);
    helm.position.set(0, 0.080, 0.004);
    helm.castShadow = true;
    head.add(helm);
    head.add(avBox(0.225, 0.052, 0.082, M.visor, 0, 0.065, -0.10));     // 护目镜
    head.add(avBox(0.15, 0.085, 0.05, M.vest, 0, -0.02, -0.082));       // 面罩
    head.add(avBox(0.036, 0.032, 0.032, M.lamp, 0.118, 0.05, -0.014));  // 耳麦灯

    // 臂
    function buildArm(sx) {
      var sh = new THREE.Group();
      sh.position.set(sx * 0.215, 0.35, 0);
      chest.add(sh);
      var upper = avLimb(0.30, 0.088, M.shirt);
      upper.position.y = -0.015;
      sh.add(upper);
      sh.add(avBox(0.118, 0.098, 0.125, M.vest, 0, -0.075, 0));          // 护肩
      var fore = avLimb(0.31, 0.075, M.shirt);
      fore.position.y = -0.295;
      fore.add(avBox(0.112, 0.08, 0.11, M.gear, 0, -0.015, 0));          // 护肘
      fore.add(avBox(0.095, 0.105, 0.11, M.gear, 0, -0.30, -0.012));     // 手套
      upper.add(fore);
      return { shoulder: sh, upper: upper, fore: fore };
    }
    rig.armL = buildArm(-1);
    rig.armR = buildArm(1);

    // 枪：挂在右前臂，随肘部角度走
    var rifle = avRifle(M);
    rifle.position.set(0.012, -0.30, -0.085);
    rig.armR.fore.add(rifle);
    rig.rifle = rifle;

    // 自补光：逆光下也能看清装备层次与轮廓
    var fill = new THREE.PointLight(0xd2e2ff, 0.85, 3.6, 2);
    fill.position.set(0, 1.28, -0.55);
    root.add(fill);

    root.userData.rig = rig;
    root.visible = false;
    root.rotation.order = 'YXZ';
    G.scene.add(root);
    return root;
  }

  function damp(a, b, k, dt) { return a + (b - a) * (1 - Math.exp(-k * dt)); }

  function poseAvatar(rig, st, dt) {
    if (!rig || !dt || dt <= 0) return;
    var moving = st.speed > 0.45;
    rig.phase += st.speed * dt * (st.sprint ? 2.1 : 1.7);
    var s = Math.sin(rig.phase);
    var amp = moving ? (0.40 + (st.sprint ? 0.36 : 0)) : 0.045;

    // 重心与前倾
    var hipY = st.crouch ? 0.44 : 0.86;
    var bob = moving ? Math.sin(rig.phase * 2) * 0.014 : Math.sin(performance.now() * 0.0012) * 0.006;
    rig.hips.position.y = damp(rig.hips.position.y, hipY + bob, 9, dt);
    var lean = (st.sprint ? 0.30 : 0) + (st.crouch ? 0.28 : 0) + (moving ? 0.04 : 0);
    rig.chest.rotation.x = damp(rig.chest.rotation.x, lean, 7, dt);

    // 腿
    var cT = st.crouch ? 1.50 : 0;
    rig.legL.thigh.rotation.x = damp(rig.legL.thigh.rotation.x, s * amp + cT, 11, dt);
    rig.legR.thigh.rotation.x = damp(rig.legR.thigh.rotation.x, -s * amp + cT, 11, dt);
    var cK = st.crouch ? 1.52 : 0;
    rig.legL.shin.rotation.x = damp(rig.legL.shin.rotation.x, -Math.max(0, s) * amp * 1.15 - cK, 11, dt);
    rig.legR.shin.rotation.x = damp(rig.legR.shin.rotation.x, -Math.max(0, -s) * amp * 1.15 - cK, 11, dt);

    // 手臂：持枪。冲刺时枪口下压抱于胸前，开火时抬平
    var aimBias = st.fire ? 0.14 : (st.sprint ? -0.20 : 0);
    var rSh = 0.88 + aimBias - (st.crouch ? 0.10 : 0);
    rig.armR.shoulder.rotation.x = damp(rig.armR.shoulder.rotation.x, rSh, 9, dt);
    rig.armR.shoulder.rotation.z = damp(rig.armR.shoulder.rotation.z, -0.12, 9, dt);
    rig.armR.fore.rotation.x = damp(rig.armR.fore.rotation.x, -0.92 + (st.sprint ? 0.46 : 0), 9, dt);

    rig.armL.shoulder.rotation.x = damp(rig.armL.shoulder.rotation.x, 0.80 - (st.sprint ? 0.18 : 0), 9, dt);
    rig.armL.shoulder.rotation.z = damp(rig.armL.shoulder.rotation.z, 0.34, 9, dt);
    rig.armL.fore.rotation.x = damp(rig.armL.fore.rotation.x, -1.05, 9, dt);

    // 开火后坐
    if (rig.rifle) rig.rifle.position.z = damp(rig.rifle.position.z, st.fire ? -0.045 : -0.075, 14, dt);
  }

  function placeAvatar(g, x, y, z, yaw, pitch, st, dt) {
    if (!g) return;
    g.visible = true;
    g.position.set(x, y, z);
    g.rotation.y = yaw || 0;
    g.rotation.x = 0;
    if (g.userData.rig) poseAvatar(g.userData.rig, st, dt);
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
    function onReady() {
      if (S.connected) return;
      S.connected = true;
      setStatus(
        S.role === 'host' ? '队友已加入，开始同步' : '已连接到房主',
        'ok'
      );
      setLaunch(S.role, S.role === 'host' ? '房主 · 已连接' : '队友 · 已连接');
      updateHud();
      // 首包：告诉对方自己是谁
      send({ t: 'hello', role: S.role, name: S.role === 'host' ? '房主' : '队友' });
    }
    // PeerJS 的 open 只派发一次；如果绑定时连接已经就绪，必须立刻进入就绪态，
    // 否则 S.connected 永远为 false，位置包与替身都会被跳过。
    if (conn.open) {
      try { onReady(); } catch (e) { }
    } else {
      conn.on('open', onReady);
    }
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
        c: p.crouching ? 1 : 0, s: p.sprinting ? 1 : 0,
        f: (performance.now() - (S.fireAt || 0)) < 320 ? 1 : 0
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
    r.c = !!m.p.c; r.s = !!m.p.s; r.f = !!m.p.f;
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
      r.c = !!m.p.c; r.s = !!m.p.s; r.f = !!m.p.f;
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
        c.on('open', function () {
          // 回归：对已 open 的连接调用 bindConn，必须立刻进入已连接态
          try { bindConn(c); } catch (e) { fail('bind:' + (e && e.message)); return; }
          c.send({ t: 'ping', seq: 7 });
        });
        c.on('data', function (m) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          var ok = m && m.t === 'pong' && m.echo === 7 && S.connected === true;
          document.title = 'SELFTEST:' + (ok ? 'OK' : 'BADPAYLOAD') + ':' + JSON.stringify(m) + ':connected=' + S.connected;
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
      try {
        G.events.on('weapon:fire', function () {
          S.fireAt = performance.now();
          try { onLocalFire.apply(null, arguments); } catch (e) { }
        });
      } catch (e) { /* 事件名不存在则跳过 */ }
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

    // 渲染帧：替身跟随 + 姿态驱动
    var lastP = null, lastT = 0;
    (function frame() {
      try {
        var now = performance.now();
        if (S.connected && S.remote && avatars.remote) {
          var dt = lastT ? Math.min(0.06, (now - lastT) / 1000) : 0.016;
          lastT = now;
          if (!(dt > 0)) dt = 0.016;
          var r = S.remote;
          var spd = 0;
          if (lastP) {
            var dx = r.x - lastP.x, dy = r.y - lastP.y, dz = r.z - lastP.z;
            spd = Math.sqrt(dx * dx + dy * dy + dz * dz) / dt;
            if (spd > 25) spd = 0;   // 传送/抖动保护
          }
          lastP = { x: r.x, y: r.y, z: r.z };
          placeAvatar(avatars.remote, r.x, r.y, r.z, r.yaw, r.pitch,
            { speed: spd, crouch: !!r.c, sprint: !!r.s, fire: !!r.f }, dt);
        } else {
          lastP = null;
          lastT = 0;
          if (avatars.remote) avatars.remote.visible = false;
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
        c: p.crouching ? 1 : 0, s: p.sprinting ? 1 : 0,
        f: (performance.now() - (S.fireAt || 0)) < 320 ? 1 : 0
      }
    });
  }

})();
