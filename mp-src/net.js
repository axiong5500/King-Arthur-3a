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

  // ---------------- 替身：程序化特种兵 v2 ----------------
  // 真实人体比例（身高约 1.78m）· 关节层级 · 双骨 IK 步态（脚落地不滑步）· 持枪 IK（双手贴枪）
  // 坐标约定：root 原点在脚底，朝向 -Z，yaw 由 root.rotation.y 给出；pitch 正值 = 抬头（与游戏一致）。
  var AVD = {
    hipH: 0.965,                       // 站立时骨盆中心离地高度（髋关节 = hipH - hipJ）
    hipJ: 0.04,
    thigh: 0.43, shin: 0.42, ankle: 0.085,
    hipHalf: 0.095,
    spine1: 0.07,                      // 髋 → 腰
    spine2: 0.15,                      // 腰 → 胸腔基点
    shX: 0.205, shY: 0.285,            // 肩关节（胸腔局部）
    upper: 0.305, fore: 0.28,
    butt: 0.30                         // 步枪枪托末端的 z（枪局部）
  };

  var AV_MAT = null, AV_GEO = {}, AVS = null;

  function avScratch() {
    if (AVS) return AVS;
    var V = THREE.Vector3;
    AVS = {
      v1: new V(), v2: new V(), v3: new V(), v4: new V(), E: new V(), W: new V(), T: new V(),
      down: new V(0, -1, 0),
      q1: new THREE.Quaternion(), q2: new THREE.Quaternion(), q3: new THREE.Quaternion(),
      e1: new THREE.Euler(0, 0, 0, 'YXZ'),
      poleArmL: new V(-0.30, -1, 0.15), poleArmR: new V(0.50, -1, 0.35),
      poleLegL: new V(-0.12, 0, -1), poleLegR: new V(0.12, 0, -1),
      reach: 0
    };
    return AVS;
  }

  function avRand(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function avCanvasTex(size, draw, rx, ry) {
    var c = document.createElement('canvas');
    c.width = c.height = size;
    draw(c.getContext('2d'), size);
    var t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(rx || 1, ry || rx || 1);
    if (THREE.SRGBColorSpace) t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  }

  // 多地形迷彩：无缝（边缘 9 宫格复制）
  function avCamo(seed, cols, rep) {
    return avCanvasTex(256, function (g, n) {
      var R = avRand(seed), i, k, ox, oy;
      g.fillStyle = cols[0];
      g.fillRect(0, 0, n, n);
      for (k = 1; k < cols.length; k++) {
        g.fillStyle = cols[k];
        for (i = 0; i < 40; i++) {
          var x = R() * n, y = R() * n, rx = 9 + R() * 26, ry = 5 + R() * 15, a = R() * Math.PI;
          for (ox = -1; ox <= 1; ox++) for (oy = -1; oy <= 1; oy++) {
            g.beginPath();
            g.ellipse(x + ox * n, y + oy * n, rx, ry, a, 0, Math.PI * 2);
            g.fill();
          }
        }
      }
      for (i = 0; i < 2400; i++) {            // 布料颗粒
        g.fillStyle = 'rgba(0,0,0,' + (R() * 0.10).toFixed(3) + ')';
        g.fillRect(R() * n, R() * n, 1.5, 1.5);
      }
    }, rep, rep);
  }

  // 背心 MOLLE 织带：横向缝线
  function avWebbing() {
    return avCanvasTex(128, function (g, n) {
      g.fillStyle = '#3b4235';
      g.fillRect(0, 0, n, n);
      var y, x;
      for (y = 4; y < n; y += 12) {
        g.fillStyle = 'rgba(0,0,0,0.5)';
        g.fillRect(0, y, n, 3);
        g.fillStyle = 'rgba(160,170,140,0.16)';
        g.fillRect(0, y + 4, n, 1);
      }
      for (x = 0; x < n; x += 16) {
        g.fillStyle = 'rgba(0,0,0,0.22)';
        g.fillRect(x, 0, 1, n);
      }
    }, 3.7, 3.7);
  }

  function avFlashTex() {
    return avCanvasTex(64, function (g, n) {
      var r = g.createRadialGradient(n / 2, n / 2, 1, n / 2, n / 2, n / 2);
      r.addColorStop(0, 'rgba(255,250,225,1)');
      r.addColorStop(0.25, 'rgba(255,205,110,0.85)');
      r.addColorStop(1, 'rgba(255,120,30,0)');
      g.fillStyle = r;
      g.fillRect(0, 0, n, n);
    }, 1, 1);
  }

  function avMat() {
    if (AV_MAT) return AV_MAT;
    var camoA = avCamo(11, ['#6e6a4c', '#566342', '#8a7a55', '#383f31'], 3.2);
    var camoB = avCamo(23, ['#737052', '#5a6847', '#8c7d59', '#3c4435'], 2.6);
    var camoH = avCamo(37, ['#656246', '#4f5b3e', '#7d6f4e', '#343b2d'], 2.2);
    var web = avWebbing();
    function std(o) { return new THREE.MeshStandardMaterial(o); }
    // 带贴图的布料：加一点自发光让逆光面也能看出图案
    function fab(map, rough, em) {
      return std({ color: 0xffffff, map: map, roughness: rough, metalness: 0.03, emissive: 0xffffff, emissiveMap: map, emissiveIntensity: em });
    }
    AV_MAT = {
      pants: fab(camoB, 0.95, 0.10),
      shirt: fab(camoA, 0.93, 0.10),
      helmet: fab(camoH, 0.88, 0.09),
      vest: fab(web, 0.8, 0.12),
      gear: std({ color: 0x3a3f33, roughness: 0.82, metalness: 0.06, emissive: 0x1a1d16, emissiveIntensity: 0.18 }),
      glove: std({ color: 0x24272a, roughness: 0.88, metalness: 0.04, emissive: 0x101214, emissiveIntensity: 0.2 }),
      boot: std({ color: 0x3a3228, roughness: 0.78, metalness: 0.04, emissive: 0x1a150f, emissiveIntensity: 0.2 }),
      rubber: std({ color: 0x151617, roughness: 0.95, metalness: 0.0, emissive: 0x08090a, emissiveIntensity: 0.2 }),
      visor: std({ color: 0x0f1518, roughness: 0.12, metalness: 0.95, emissive: 0x23353b, emissiveIntensity: 0.2 }),
      skin: std({ color: 0xb28c6b, roughness: 0.78, metalness: 0.0, emissive: 0x4a3524, emissiveIntensity: 0.2 }),
      cloth: std({ color: 0x23272a, roughness: 0.92, metalness: 0.02, emissive: 0x101214, emissiveIntensity: 0.15 }),
      metal: std({ color: 0x2f3437, roughness: 0.4, metalness: 0.8, emissive: 0x15191b, emissiveIntensity: 0.12 }),
      polymer: std({ color: 0x25292a, roughness: 0.62, metalness: 0.15, emissive: 0x111415, emissiveIntensity: 0.15 }),
      lamp: std({ color: 0x79cf80, emissive: 0x79cf80, emissiveIntensity: 3.4, roughness: 1 }),
      flash: new THREE.MeshBasicMaterial({ map: avFlashTex(), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false })
    };
    return AV_MAT;
  }

  // ---- 几何积木 ----
  function avSphereGeo() {
    return AV_GEO.sph || (AV_GEO.sph = new THREE.SphereGeometry(1, 18, 12));
  }

  // 椭球
  function avEll(rx, ry, rz, mat, x, y, z) {
    var m = new THREE.Mesh(avSphereGeo(), mat);
    m.scale.set(rx, ry, rz);
    m.position.set(x || 0, y || 0, z || 0);
    m.castShadow = true;
    return m;
  }

  // 圆角盒：用带倒角的挤出体
  function avRBoxGeo(w, h, d, r) {
    var key = 'rb' + [w, h, d, r].join('_');
    if (AV_GEO[key]) return AV_GEO[key];
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
    return (AV_GEO[key] = geo);
  }

  function avRB(w, h, d, r, mat, x, y, z) {
    var m = new THREE.Mesh(avRBoxGeo(w, h, d, r), mat);
    m.position.set(x || 0, y || 0, z || 0);
    m.castShadow = true;
    return m;
  }

  // 旋转体（躯干、四肢）：prof 为 [半径, y]，可椭圆化（sx, sz）
  function avLathe(prof, sx, sz, mat, seg) {
    var pts = prof.slice().sort(function (a, b) { return a[1] - b[1]; }).map(function (p) { return new THREE.Vector2(p[0], p[1]); });
    var m = new THREE.Mesh(new THREE.LatheGeometry(pts, seg || 18), mat);
    m.scale.set(sx || 1, 1, sz || 1);
    m.castShadow = true;
    return m;
  }

  // 圆柱（沿 z 或 y 放置）
  function avCyl(r0, r1, len, mat, axis, x, y, z) {
    var m = new THREE.Mesh(new THREE.CylinderGeometry(r1, r0, len, 12), mat);
    if (axis === 'z') m.rotation.x = Math.PI / 2;
    else if (axis === 'x') m.rotation.z = Math.PI / 2;
    m.position.set(x || 0, y || 0, z || 0);
    m.castShadow = true;
    return m;
  }

  // 胶囊（手指）：axis 指向胶囊长轴
  function avCap(r, len, mat, axis, x, y, z) {
    var m = new THREE.Mesh(new THREE.CapsuleGeometry(r, len, 3, 6), mat);
    if (axis === 'z') m.rotation.x = Math.PI / 2;
    else if (axis === 'x') m.rotation.z = Math.PI / 2;
    m.position.set(x || 0, y || 0, z || 0);
    m.castShadow = true;
    return m;
  }

  // 环带（腰带、围腰）：开口圆筒，双面
  function avBand(r, y0, y1, sx, sz, mat) {
    var m = avLathe([[r, y0], [r, y1]], sx, sz, mat, 22);
    m.material = mat.userData.__ds || (mat.userData.__ds = (function () { var c = mat.clone(); c.side = THREE.DoubleSide; return c; })());
    return m;
  }

  // ---- 步枪：枪托末端在 z = +0.30，枪口朝 -Z ----
  function avRifle(M) {
    var g = new THREE.Group();
    g.add(avRB(0.050, 0.064, 0.24, 0.008, M.metal, 0, 0, 0.02));            // 上机匣
    g.add(avRB(0.044, 0.052, 0.17, 0.008, M.polymer, 0, -0.054, 0.04));     // 下机匣
    var mag = avRB(0.032, 0.14, 0.056, 0.006, M.gear, 0, -0.14, -0.005);    // 弹匣
    mag.rotation.x = 0.10;
    g.add(mag);
    var grip = avRB(0.032, 0.10, 0.046, 0.010, M.polymer, 0, -0.112, 0.09); // 握把
    grip.rotation.x = -0.38;
    g.add(grip);
    g.add(avCyl(0.016, 0.016, 0.14, M.metal, 'z', 0, -0.004, 0.20));        // 缓冲管
    g.add(avRB(0.038, 0.070, 0.12, 0.012, M.polymer, 0, -0.012, 0.225));    // 枪托
    g.add(avRB(0.040, 0.094, 0.022, 0.006, M.rubber, 0, -0.012, 0.289));    // 托底板
    g.add(avRB(0.022, 0.009, 0.34, 0.003, M.metal, 0, 0.036, -0.06));       // 顶部导轨
    g.add(avRB(0.034, 0.042, 0.06, 0.008, M.polymer, 0, 0.064, -0.045));    // 红点镜
    var lens = avRB(0.026, 0.026, 0.004, 0.002, M.visor, 0, 0.066, -0.077);
    g.add(lens);
    g.add(avCyl(0.031, 0.031, 0.28, M.polymer, 'z', 0, 0, -0.24));          // 圆护木
    g.add(avCyl(0.0095, 0.0095, 0.14, M.metal, 'z', 0, 0.002, -0.45));      // 枪管
    g.add(avCyl(0.0145, 0.0145, 0.055, M.metal, 'z', 0, 0.002, -0.525));    // 消焰器
    g.add(avRB(0.008, 0.026, 0.01, 0.002, M.metal, 0, 0.026, -0.40));       // 准星座
    g.add(avRB(0.008, 0.012, 0.008, 0.002, M.metal, 0, 0.044, -0.015));     // 照门
    return g;
  }

  // 手套：双手直接做在枪的坐标系里（保证握姿永远贴合），返回腕点（枪局部）
  function avHands(rifle, M) {
    var gl = M.glove, R = new THREE.Group(), L = new THREE.Group();
    // 右手：握把 + 食指伸直放扳机护圈外
    R.add(avRB(0.050, 0.086, 0.078, 0.014, gl, 0.0, -0.090, 0.092));
    R.add(avCap(0.0095, 0.045, gl, 'x', 0.0, -0.082, 0.052));
    R.add(avCap(0.0095, 0.045, gl, 'x', 0.0, -0.103, 0.056));
    R.add(avCap(0.0090, 0.040, gl, 'x', 0.0, -0.123, 0.062));
    R.add(avCap(0.0090, 0.045, gl, 'z', 0.028, -0.050, 0.030));            // 食指
    R.add(avCap(0.0105, 0.045, gl, 'z', -0.027, -0.048, 0.085));           // 拇指
    // 左手：从下托住护木，四指绕右侧，拇指在左侧向前
    L.add(avRB(0.074, 0.046, 0.090, 0.014, gl, -0.004, -0.066, -0.205));
    L.add(avCap(0.0095, 0.040, gl, 'y', 0.039, -0.040, -0.172));
    L.add(avCap(0.0095, 0.042, gl, 'y', 0.040, -0.040, -0.192));
    L.add(avCap(0.0090, 0.040, gl, 'y', 0.039, -0.040, -0.212));
    L.add(avCap(0.0085, 0.036, gl, 'y', 0.037, -0.040, -0.231));
    L.add(avCap(0.0105, 0.045, gl, 'z', -0.032, -0.035, -0.182));
    rifle.add(R);
    rifle.add(L);
    return {
      wristR: new THREE.Vector3(0.004, -0.080, 0.150),
      wristL: new THREE.Vector3(-0.012, -0.070, -0.150)
    };
  }

  function makeAvatar() {
    var M = avMat();
    avScratch();
    var D = AVD;
    var root = new THREE.Group();
    root.name = 'mp-soldier';
    var body = new THREE.Group();
    root.add(body);
    var rig = { body: body };

    // ---------- 髋 / 骨盆 ----------
    var hips = new THREE.Group();
    hips.position.y = D.hipH;
    body.add(hips);
    rig.hips = hips;
    hips.add(avLathe([[0.0, -0.135], [0.10, -0.13], [0.15, -0.08], [0.165, -0.01], [0.158, 0.06], [0.142, 0.11], [0.0, 0.115]], 1.0, 0.74, M.pants, 20));
    hips.add(avEll(0.052, 0.07, 0.05, M.pants, -0.075, -0.045, 0.098));       // 臀
    hips.add(avEll(0.052, 0.07, 0.05, M.pants, 0.075, -0.045, 0.098));
    hips.add(avBand(0.161, 0.040, 0.092, 1.0, 0.76, M.gear));                 // 战术腰带
    hips.add(avRB(0.058, 0.04, 0.012, 0.004, M.metal, 0, 0.066, -0.127));     // 腰带扣
    hips.add(avRB(0.075, 0.10, 0.05, 0.012, M.gear, -0.145, 0.0, -0.075));    // 腰包（左）
    hips.add(avRB(0.062, 0.085, 0.05, 0.012, M.gear, 0.150, 0.0, -0.07));     // 腰包（右）

    // ---------- 腿 ----------
    function buildLeg(sx) {
      var thigh = new THREE.Group();
      thigh.position.set(sx * D.hipHalf, -D.hipJ, 0);
      thigh.add(avLathe([[0.062, 0.02], [0.088, -0.01], [0.098, -0.07], [0.092, -0.20], [0.074, -0.33], [0.062, -0.40], [0.058, -0.425]], 1.0, 0.94, M.pants, 16));
      thigh.add(avRB(0.07, 0.09, 0.034, 0.012, M.pants, sx * 0.075, -0.20, 0.0));   // 大腿侧袋
      if (sx > 0) thigh.add(avRB(0.040, 0.17, 0.085, 0.012, M.gear, 0.098, -0.17, -0.005)); // 右腿手枪套
      var shin = new THREE.Group();
      shin.position.y = -D.thigh;
      shin.add(avEll(0.062, 0.062, 0.062, M.pants, 0, 0, 0));                        // 膝
      shin.add(avLathe([[0.056, 0.02], [0.062, -0.02], [0.067, -0.12], [0.056, -0.26], [0.047, -0.36], [0.048, -0.41]], 1.0, 0.95, M.pants, 16));
      shin.add(avRB(0.100, 0.115, 0.040, 0.016, M.gear, 0, -0.015, -0.060));        // 护膝
      shin.add(avLathe([[0.052, -0.45], [0.062, -0.43], [0.067, -0.36], [0.066, -0.30]], 1.0, 1.0, M.boot, 16)); // 靴筒
      var foot = new THREE.Group();
      foot.position.y = -D.shin;
      foot.add(avRB(0.092, 0.066, 0.200, 0.026, M.boot, 0, -0.040, -0.062));         // 靴面
      foot.add(avEll(0.047, 0.036, 0.062, M.boot, 0, -0.048, -0.172));               // 鞋头
      foot.add(avEll(0.046, 0.046, 0.050, M.boot, 0, -0.040, 0.036));                // 后跟
      foot.add(avRB(0.100, 0.026, 0.286, 0.012, M.rubber, 0, -0.072, -0.066));       // 大底
      foot.add(avRB(0.088, 0.024, 0.062, 0.008, M.rubber, 0, -0.058, 0.040));        // 鞋跟
      shin.add(foot);
      thigh.add(shin);
      hips.add(thigh);
      return { thigh: thigh, shin: shin, foot: foot, sx: sx };
    }
    rig.legL = buildLeg(-1);
    rig.legR = buildLeg(1);

    // ---------- 脊柱 / 躯干 ----------
    var spine = new THREE.Group();
    spine.position.y = D.spine1;
    hips.add(spine);
    rig.spine = spine;
    spine.add(avLathe([[0.0, 0.0], [0.138, 0.0], [0.128, 0.06], [0.130, 0.12], [0.150, 0.172], [0.0, 0.175]], 1.08, 0.72, M.shirt, 20));

    var chest = new THREE.Group();
    chest.position.y = D.spine2;
    spine.add(chest);
    rig.chest = chest;
    chest.add(avLathe([[0.0, -0.01], [0.15, -0.01], [0.168, 0.05], [0.180, 0.14], [0.184, 0.22], [0.168, 0.29], [0.105, 0.327], [0.062, 0.340], [0.0, 0.345]], 1.10, 0.68, M.shirt, 22));
    chest.add(avBand(0.176, 0.0, 0.075, 1.10, 0.72, M.vest));                  // 围腰
    chest.add(avRB(0.265, 0.310, 0.052, 0.026, M.vest, 0, 0.165, -0.142));     // 前插板
    chest.add(avRB(0.255, 0.300, 0.050, 0.026, M.vest, 0, 0.165, 0.142));      // 后插板
    var pm;
    for (var pi = -1; pi <= 1; pi++) {
      pm = avRB(0.066, 0.100, 0.040, 0.012, M.gear, pi * 0.085, 0.075, -0.180);   // 弹匣袋
      chest.add(pm);
      chest.add(avRB(0.058, 0.014, 0.012, 0.005, M.polymer, pi * 0.085, 0.128, -0.190)); // 袋盖扣
    }
    chest.add(avRB(0.150, 0.066, 0.022, 0.008, M.gear, 0, 0.245, -0.176));        // 管理面板
    chest.add(avRB(0.052, 0.120, 0.056, 0.012, M.gear, -0.178, 0.130, -0.095));   // 电台袋
    chest.add(avRB(0.050, 0.100, 0.050, 0.012, M.gear, 0.178, 0.125, -0.095));    // 急救包
    for (var sd = -1; sd <= 1; sd += 2) {
      var strap = avRB(0.060, 0.014, 0.30, 0.006, M.vest, sd * 0.096, 0.328, 0.0);   // 肩带
      strap.rotation.z = sd * -0.20;
      chest.add(strap);
    }
    chest.add(avRB(0.040, 0.012, 0.030, 0.004, M.lamp, -0.130, 0.346, -0.06));       // 识别灯
    chest.add(avRB(0.250, 0.300, 0.130, 0.034, M.gear, 0, 0.170, 0.225));           // 背包
    chest.add(avRB(0.070, 0.120, 0.050, 0.014, M.gear, 0.0, 0.165, 0.302));         // 背包外挂
    var ant = avCyl(0.004, 0.0028, 0.42, M.polymer, 'y', 0.10, 0.50, 0.25);           // 天线
    ant.rotation.z = -0.07;
    chest.add(ant);

    // ---------- 颈 / 头 ----------
    chest.add(avEll(0.092, 0.036, 0.060, M.shirt, -0.080, 0.322, 0.004));            // 斜方肌
    chest.add(avEll(0.092, 0.036, 0.060, M.shirt, 0.080, 0.322, 0.004));
    var neck = new THREE.Group();
    neck.position.y = 0.335;
    chest.add(neck);
    rig.neck = neck;
    neck.add(avCyl(0.056, 0.050, 0.12, M.skin, 'y', 0, 0.045, 0.004));
    neck.add(avCyl(0.070, 0.062, 0.07, M.cloth, 'y', 0, 0.04, -0.002));              // 围脖

    var head = new THREE.Group();
    head.position.y = 0.105;
    neck.add(head);
    rig.head = head;
    head.add(avEll(0.077, 0.098, 0.094, M.skin, 0, 0.088, 0.002));                  // 颅
    head.add(avEll(0.062, 0.058, 0.070, M.skin, 0, 0.022, -0.030));                 // 下颌
    head.add(avEll(0.030, 0.022, 0.030, M.skin, 0, -0.002, -0.068));                // 下巴
    head.add(avEll(0.013, 0.022, 0.018, M.skin, 0, 0.066, -0.093));                 // 鼻
    head.add(avEll(0.010, 0.021, 0.014, M.skin, -0.080, 0.080, 0.006));             // 耳
    head.add(avEll(0.010, 0.021, 0.014, M.skin, 0.080, 0.080, 0.006));
    head.add(avEll(0.074, 0.050, 0.066, M.cloth, 0, 0.012, -0.034));               // 下半脸面罩
    var helm = new THREE.Mesh(new THREE.SphereGeometry(1, 22, 14, 0, Math.PI * 2, 0, Math.PI * 0.60), M.helmet);
    helm.scale.set(0.093, 0.108, 0.113);
    helm.position.set(0, 0.113, 0.004);
    helm.rotation.x = -0.05;
    helm.castShadow = true;
    head.add(helm);
    head.add(avRB(0.150, 0.014, 0.026, 0.005, M.polymer, 0, 0.158, -0.100));        // 头盔前沿
    head.add(avRB(0.044, 0.044, 0.030, 0.008, M.metal, 0, 0.146, -0.108));          // 夜视支架
    head.add(avRB(0.012, 0.030, 0.160, 0.004, M.polymer, -0.083, 0.098, -0.010));   // 侧导轨
    head.add(avRB(0.012, 0.030, 0.160, 0.004, M.polymer, 0.083, 0.098, -0.010));
    head.add(avRB(0.172, 0.052, 0.040, 0.016, M.visor, 0, 0.088, -0.086));          // 护目镜镜片
    head.add(avRB(0.178, 0.014, 0.100, 0.006, M.cloth, 0, 0.088, -0.03));           // 护目镜带（侧）
    var earL = avCyl(0.033, 0.033, 0.028, M.polymer, 'x', -0.091, 0.062, 0.010);    // 耳罩
    var earR = avCyl(0.033, 0.033, 0.028, M.polymer, 'x', 0.091, 0.062, 0.010);
    head.add(earL);
    head.add(earR);
    var boom = avCap(0.003, 0.07, M.polymer, 'z', -0.080, 0.040, -0.060);          // 麦克风杆
    head.add(boom);
    head.add(avRB(0.030, 0.014, 0.016, 0.004, M.lamp, 0.096, 0.108, -0.01));       // 耳麦灯

    // ---------- 手臂 ----------
    function buildArm(sx) {
      var sh = new THREE.Group();
      sh.position.set(sx * D.shX, D.shY, 0);
      chest.add(sh);
      var upper = new THREE.Group();
      sh.add(upper);
      sh.add(avEll(0.066, 0.072, 0.064, M.shirt, 0, -0.012, 0));                       // 三角肌
      sh.add(avRB(0.094, 0.084, 0.108, 0.026, M.vest, sx * 0.012, -0.020, 0));         // 护肩
      upper.add(avLathe([[0.047, -0.305], [0.050, -0.26], [0.057, -0.15], [0.059, -0.05], [0.054, 0.0]], 1.0, 0.94, M.shirt, 16));
      var fore = new THREE.Group();
      fore.position.y = -D.upper;
      fore.add(avEll(0.049, 0.049, 0.049, M.shirt, 0, 0, 0));                          // 肘
      fore.add(avRB(0.082, 0.070, 0.026, 0.010, M.gear, 0, -0.018, 0.048));            // 护肘（背侧）
      fore.add(avLathe([[0.034, -0.285], [0.036, -0.25], [0.043, -0.15], [0.048, -0.05], [0.049, 0.0]], 1.0, 0.92, M.shirt, 16));
      fore.add(avCyl(0.040, 0.037, 0.060, M.glove, 'y', 0, -0.262, 0));                // 手套腕口
      upper.add(fore);
      return { shoulder: sh, upper: upper, fore: fore, sx: sx };
    }
    rig.armL = buildArm(-1);
    rig.armR = buildArm(1);

    // ---------- 武器：以枪托抵肩点为枢轴 ----------
    var weapon = new THREE.Group();
    weapon.rotation.order = 'YXZ';
    weapon.position.set(0.125, 0.250, -0.085);
    chest.add(weapon);
    var rifle = avRifle(M);
    rifle.position.set(0, -0.02, -D.butt);
    weapon.add(rifle);
    var wr = avHands(rifle, M);
    rig.weapon = weapon;
    rig.rifle = rifle;
    rig.wristR = wr.wristR;
    rig.wristL = wr.wristL;

    // 枪口焰
    var flash = new THREE.Group();
    flash.position.set(0, 0.002, -0.56);
    var fq1 = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.2), M.flash);
    var fq2 = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.2), M.flash);
    fq2.rotation.z = Math.PI / 2;
    var fq3 = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.2), M.flash);
    fq3.rotation.y = Math.PI / 2;
    fq3.position.z = -0.08;
    flash.add(fq1);
    flash.add(fq2);
    flash.add(fq3);
    flash.visible = false;
    rifle.add(flash);
    var flashLight = new THREE.PointLight(0xffc070, 0, 7, 2);
    flashLight.position.set(0, 0.0, -0.62);
    rifle.add(flashLight);
    rig.flash = flash;
    rig.flashLight = flashLight;

    // 自补光：逆光下也能看清装备层次与轮廓
    var fill = new THREE.PointLight(0xd2e2ff, 0.85, 3.6, 2);
    fill.position.set(0, 1.28, -0.55);
    root.add(fill);

    // 动画状态
    rig.s = {
      t: 0, phi: 0, w: 0, duty: 0.6, dx: 0, dz: -1,
      crouch: 0, sprint: 0, air: 0, wasAir: false, land: 0,
      deathT: 0, recoil: 0, flashT: 0, fireCd: 0, hpPrev: -1, flinch: 0,
      hipX: 0, lookYaw: 0, twistSmooth: 0, vyPrev: 0
    };

    root.scale.setScalar(0.975);                                  // 整体身高约 1.79m
    root.userData.rig = rig;
    root.userData.anim = { init: false, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, vx: 0, vz: 0, vy: 0, yawRate: 0, air: false };
    root.visible = false;
    root.rotation.order = 'YXZ';
    G.scene.add(root);
    return root;
  }

  function damp(a, b, k, dt) { return a + (b - a) * (1 - Math.exp(-k * dt)); }
  function avEase(x) { x = x < 0 ? 0 : x > 1 ? 1 : x; return x * x * (3 - 2 * x); }
  function avWrap(a) { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; }

  // 步态相位 → 脚掌俯仰（+ = 脚尖上翘）：落地脚跟先着地 → 放平 → 脚跟离地蹬伸 → 摆动期脚尖下垂再回抬
  function avFootPitch(t, d) {
    var u;
    if (t < d) {
      u = t / d;
      if (u < 0.12) return lerp(0.24, 0, avEase(u / 0.12));
      if (u < 0.55) return 0;
      return lerp(0, -0.52, avEase((u - 0.55) / 0.45));
    }
    u = (t - d) / (1 - d);
    return lerp(-0.52, 0.24, avEase(u * 1.15));
  }

  // 双骨 IK：关节在原点，T 为目标（父坐标系），pole 为弯曲方向提示。结果：S.E（肘/膝）、S.W（实际到达点）
  function avSolve(a, b, T, pole) {
    var S = AVS, d = T.length(), lo = Math.abs(a - b) + 1e-3, hi = a + b - 1e-3;
    var dm = d < lo ? lo : (d > hi ? hi : d);
    var u = S.v4;
    if (d < 1e-6) u.set(0, 0, -1); else u.copy(T).multiplyScalar(1 / d);
    var x = (a * a - b * b + dm * dm) / (2 * dm);
    var h = Math.sqrt(Math.max(0, a * a - x * x));
    var p = S.v3.copy(pole).addScaledVector(u, -pole.dot(u));
    if (p.lengthSq() < 1e-8) { p.set(1, 0, 0); p.addScaledVector(u, -u.x); }
    p.normalize();
    S.E.copy(u).multiplyScalar(x).addScaledVector(p, h);
    S.W.copy(u).multiplyScalar(dm);
    S.reach = dm / (a + b);
  }

  function avApplyChain(upper, fore) {
    var S = AVS;
    S.v1.copy(S.E).normalize();
    upper.quaternion.setFromUnitVectors(S.down, S.v1);
    S.v2.copy(S.W).sub(S.E);
    S.q1.copy(upper.quaternion).invert();
    S.v2.applyQuaternion(S.q1).normalize();
    fore.quaternion.setFromUnitVectors(S.down, S.v2);
  }

  // 一条腿：踝点目标（身体坐标系）→ IK → 脚掌姿态
  function avLeg(rig, leg, tx, ty, tz, pitch, yawFoot, hips) {
    var S = AVS, T = S.T;
    T.set(tx, ty, tz).sub(hips.position).applyQuaternion(S.q1.copy(hips.quaternion).invert());
    T.sub(leg.thigh.position);
    avSolve(AVD.thigh, AVD.shin, T, leg.sx > 0 ? S.poleLegR : S.poleLegL);
    leg.reach = S.reach;
    avApplyChain(leg.thigh, leg.shin);
    // 脚掌：先在身体系定姿，再换算到小腿局部
    S.e1.set(pitch, yawFoot, 0, 'YXZ');
    S.q2.setFromEuler(S.e1);
    S.q3.copy(hips.quaternion).invert().multiply(S.q2);
    S.q1.copy(leg.thigh.quaternion).multiply(leg.shin.quaternion).invert().multiply(S.q3);
    leg.foot.quaternion.copy(S.q1);
  }

  // 一只手臂：腕点目标取枪上的固定点
  function avArm(rig, arm, wristLocal) {
    var S = AVS, T = S.T;
    T.copy(wristLocal).add(rig.rifle.position).applyQuaternion(rig.weapon.quaternion).add(rig.weapon.position);
    T.sub(arm.shoulder.position);
    avSolve(AVD.upper, AVD.fore, T, arm.sx > 0 ? S.poleArmR : S.poleArmL);
    arm.reach = S.reach;
    avApplyChain(arm.upper, arm.fore);
  }

  function poseAvatar(rig, st, dt) {
    if (!rig || !dt || dt <= 0) return;
    var S = avScratch(), P = rig.s, D = AVD;
    P.t += dt;
    var alive = st.alive !== false;
    var sp = st.speed || 0;
    var spin = Math.abs(st.yawRate || 0);
    var aim = clamp(st.pitch || 0, -1.25, 1.25);

    // ---- 状态混合量 ----
    P.crouch = damp(P.crouch, st.crouch ? 1 : 0, 9, dt);
    P.sprint = damp(P.sprint, (st.sprint && sp > 2.2 && !st.crouch && alive) ? 1 : 0, 8, dt);
    P.air = damp(P.air, st.air ? 1 : 0, 16, dt);
    if (P.wasAir && !st.air) P.land = Math.max(P.land, clamp(Math.abs(P.vyPrev) / 7, 0.25, 1) * 0.12);
    P.wasAir = !!st.air;
    P.vyPrev = st.vy || 0;
    P.land = damp(P.land, 0, 7, dt);

    // 受击：血量下降 → 一次短促抽动
    if (P.hpPrev < 0) P.hpPrev = st.hp;
    if (st.hp < P.hpPrev - 0.5) P.flinch = 1;
    P.hpPrev = st.hp;
    P.flinch = damp(P.flinch, 0, 9, dt);

    // 死亡进度
    if (!alive) P.deathT = Math.min(1, P.deathT + dt / 1.15);
    else P.deathT = Math.max(0, P.deathT - dt / 0.4);
    var dead1 = avEase(P.deathT / 0.45);               // 膝盖先软
    var dead2 = avEase((P.deathT - 0.25) / 0.75);      // 再整体后倒

    // ---- 步态参数：由速度推导 ----
    var veff = alive ? Math.max(sp, Math.min(1.3, spin * 0.28)) : 0;      // 原地转身时脚也要迈步
    // 步频（步/秒）随速度上升；一个完整周期（左右各一步）的长度 = 2v/步频
    var vq = Math.max(veff, 0.5);
    var cad = 1.45 + 0.40 * vq - 0.02 * vq * vq;
    var Lc = (2 * vq / cad) * (1 - 0.30 * P.crouch);
    // 触地时间随速度缩短；一个单脚支撑期内脚相对髋走过的距离 = v * 触地时间
    var tc = 0.70 / Math.pow(vq, 0.855);
    var duty = clamp(tc * cad / 2, 0.26, 0.66);                           // 跑起来 <0.5 就有腾空期
    var runSign = clamp((duty - 0.5) / 0.08, -1, 1);                      // 走路 +1（髋在中支撑最高），跑步 -1（髋在中支撑最低）
    P.w = damp(P.w, (veff > 0.22 && !st.air) ? 1 : 0, 10, dt);
    if (P.w > 0.02) P.phi += dt * veff / Lc;
    if (P.phi > 1000) P.phi -= 1000;
    var phi = P.phi;
    var H = (0.040 + 0.022 * Math.min(veff, 6)) * (1 - 0.3 * P.crouch);   // 摆动脚抬高

    // 运动方向（相对身体）
    var tdx = 0, tdz = -1;
    if (sp > 0.35) { tdx = (st.lat || 0) / sp; tdz = -(st.fwd || 0) / sp; }
    P.dx = damp(P.dx, tdx, 8, dt);
    P.dz = damp(P.dz, tdz, 8, dt);
    var dl = Math.sqrt(P.dx * P.dx + P.dz * P.dz) || 1;
    var ddx = P.dx / dl, ddz = P.dz / dl;

    // ---- 骨盆 ----
    var vmin = Math.min(veff, 5);
    var wMove = P.w;
    var bobA = (0.008 + 0.0075 * vmin) * wMove;
    var bob = runSign * bobA * Math.cos(4 * Math.PI * (phi - duty * 0.5));
    // 髋的平均高度由「落脚跨度」反推：跨度越大，触地瞬间腿越斜，髋就必须越低（几何约束，不是随便降的）
    var legReach = (D.thigh + D.shin) * 0.985;
    var Sdes = duty * Lc;
    var hipsNeed = D.ankle + D.hipJ + Math.sqrt(Math.max(0.01, legReach * legReach - 0.25 * Sdes * Sdes)) - runSign * bobA * Math.cos(2 * Math.PI * duty);
    var standY = D.hipH - 0.012;
    var baseY = lerp(standY, Math.min(standY, hipsNeed), wMove) - P.crouch * 0.29 - P.land - P.flinch * 0.025;
    // 死亡：膝盖塌下
    baseY -= dead1 * 0.30;
    // 落脚点的前后跨度受腿长限制：触地瞬间髋的高度决定脚最远能伸多远。
    // 超出就缩短支撑期（飞行期变长），保证脚速仍等于地面速度、不滑步。
    var hipJointTD = baseY + runSign * bobA * Math.cos(2 * Math.PI * duty) - D.hipJ;
    var vertTD = Math.max(0.2, hipJointTD - D.ankle);
    var Smax = 2 * Math.sqrt(Math.max(0.0004, legReach * legReach - vertTD * vertTD)) * 0.94;
    var Sstep = Math.min(duty * Lc, Smax);
    duty = Sstep / Lc;
    P.duty = duty;
    bob = runSign * bobA * Math.cos(4 * Math.PI * (phi - duty * 0.5));
    // 起跳/腾空：略抬
    var hipY = baseY + bob + P.air * 0.02;

    P.hipX = damp(P.hipX, 0.016 * Math.sin(2 * Math.PI * phi) * wMove * (1 - 0.5 * P.sprint), 12, dt);
    var twistT = -(0.05 + 0.012 * vmin) * Math.sin(2 * Math.PI * phi) * wMove;
    P.twistSmooth = damp(P.twistSmooth, twistT, 14, dt);
    var twist = P.twistSmooth;
    var roll = 0.035 * Math.sin(2 * Math.PI * phi) * wMove;
    var leanF = 0.014 * vmin + 0.13 * P.sprint + 0.34 * P.crouch;       // 前倾（弧度，正 = 前倾）
    var breath = Math.sin(P.t * 1.9) * 0.010 * (1 - 0.6 * wMove);
    var hipZ = 0.075 * P.crouch;

    var hips = rig.hips, spine = rig.spine, chest = rig.chest;
    hips.position.set(P.hipX, hipY, hipZ);
    hips.rotation.set(-0.25 * leanF - 0.02 * P.sprint, twist, roll, 'YXZ');

    // 受击抽动 / 命中后仰
    var fl = P.flinch;
    // 瞄准持枪的躯干扭转：肩线转向持枪侧，使左手能够到护木
    var aimStance = -0.38 * (1 - 0.65 * P.sprint) - 0.06 * P.crouch;
    var spY = 0.4 * aimStance - 0.3 * twist;
    var chY = 0.6 * aimStance - 0.3 * twist;
    spine.rotation.set(-0.40 * leanF + 0.12 * aim + 0.4 * breath + 0.06 * fl, spY, -0.6 * roll * 0.5, 'YXZ');
    chest.rotation.set(-0.35 * leanF + 0.16 * aim + breath + 0.10 * fl + dead2 * 0.1, chY + 0.05 * fl, -0.6 * roll * 0.5, 'YXZ');

    // ---- 头：看向瞄准方向，行进中稳定视线 ----
    var yawSum = twist + spY + chY;
    var scan = Math.sin(P.t * 0.45) * 0.07 * (1 - wMove) * (alive ? 1 : 0);
    var head = rig.head;
    head.rotation.set(0.55 * aim + 0.55 * (leanF * 0.7) - 0.3 * breath + 0.18 * fl, -0.85 * yawSum + scan, 0.02 * Math.sin(P.t * 0.7) - 0.5 * (spine.rotation.z + chest.rotation.z), 'YXZ');
    rig.neck.rotation.set(0.15 * aim, 0, 0);

    // ---- 武器 ----
    // 开火：按射速重复触发后坐与枪口焰
    if (st.fire && alive) {
      P.fireCd -= dt;
      if (P.fireCd <= 0) {
        P.recoil = 1;
        P.flashT = 0.05;
        P.fireCd = 0.085 + Math.random() * 0.02;
        rig.flash.rotation.z = Math.random() * 6.28;
        var fs = 0.8 + Math.random() * 0.7;
        rig.flash.scale.set(fs, fs, fs);
      }
    } else P.fireCd = 0;
    P.recoil = damp(P.recoil, 0, 20, dt);
    P.flashT = Math.max(0, P.flashT - dt);
    rig.flash.visible = P.flashT > 0;
    rig.flashLight.intensity = P.flashT > 0 ? 7 : 0;

    var weapon = rig.weapon, rifle = rig.rifle;
    var swayX = Math.sin(P.t * 1.1) * 0.003 + Math.sin(P.t * 0.37) * 0.002;
    var swayY = Math.sin(P.t * 1.7) * 0.003 * (1 - wMove);
    var gaitBounce = -bob * 0.5;                                           // 枪不完全随骨盆颠簸
    weapon.position.set(
      0.125 - 0.025 * P.sprint + swayX,
      0.250 - 0.075 * P.sprint - 0.012 * P.crouch + swayY + gaitBounce - dead2 * 0.12,
      -0.085 + 0.045 * P.sprint + P.recoil * 0.032
    );
    // 枪口指向：世界俯仰 = 瞄准俯仰（扣除上身已有的俯仰），冲刺时压低
    var upPitch = hips.rotation.x + spine.rotation.x + chest.rotation.x;
    var wPitch = aim - upPitch - 0.36 * P.sprint + P.recoil * 0.055 + P.air * 0.05 - dead2 * 1.0;
    var wYaw = -(twist + spY + chY) + 0.10 * P.sprint + 0.12 * dead2;
    var wRoll = 0.03 + 0.10 * P.sprint + 0.015 * Math.sin(P.t * 1.3) + dead2 * 0.5;
    weapon.rotation.set(wPitch, wYaw, wRoll, 'YXZ');
    rifle.position.z = -D.butt + P.recoil * 0.014;

    // ---- 手臂：双手 IK 到枪上的握点 ----
    avArm(rig, rig.armR, rig.wristR);
    avArm(rig, rig.armL, rig.wristL);

    // ---- 腿：脚落地点由步态 / 站姿混合，IK 解算 ----
    var stanceG = lerp(0.105, 0.075, P.sprint) + 0.04 * P.crouch;
    var yawOut = 0.10 + 0.05 * P.crouch;
    var legs = [rig.legL, rig.legR];
    for (var i = 0; i < 2; i++) {
      var leg = legs[i], sx = leg.sx;
      // 站姿：支撑侧脚在前、持枪侧脚在后；蹲时脚略前移让膝盖有位置
      var ix = sx * (0.105 + 0.04 * P.crouch);
      var iz = (sx < 0 ? -0.095 : 0.060) - 0.04 * P.crouch;
      var iy = D.ankle;
      var ip = 0;
      // 步态
      var t = phi + (sx > 0 ? 0.5 : 0);
      t -= Math.floor(t);
      var gp, lift = 0;
      if (t < duty) {
        gp = Sstep * 0.5 - Sstep * (t / duty);           // 支撑相：脚相对身体向后滑，世界系里不动
      } else {
        var u = (t - duty) / (1 - duty);
        gp = -Sstep * 0.5 + Sstep * avEase(u);           // 摆动相：脚向前迈
        lift = H * Math.sin(Math.PI * u);
      }
      var gPitch = avFootPitch(t, duty);
      var gx = sx * stanceG + ddx * gp;
      var gz = ddz * gp;
      var gy = D.ankle + lift + 0.17 * Math.sin(Math.max(0, -gPitch)) * 0.6;
      var w = P.w;
      var fx = lerp(ix, gx, w), fy = lerp(iy, gy, w), fz = lerp(iz, gz, w);
      var fp = lerp(ip, gPitch, w);
      // 腾空：双腿略收，前后错开
      if (P.air > 0.01) {
        fy += P.air * 0.22;
        fz += P.air * (sx < 0 ? -0.14 : 0.10);
        fp = lerp(fp, -0.30, P.air);
      }
      avLeg(rig, leg, fx, fy, fz, fp, -sx * yawOut, hips);
    }

    // ---- 倒地：整体绕脚后倒 ----
    rig.body.rotation.x = 1.50 * dead2;
    rig.body.position.y = 0.14 * dead2;
    rig.body.position.z = 0;
  }

  // 每个渲染帧：把网络位置（20Hz 阶梯）平滑成连续运动，再估计速度、状态，驱动姿态
  function stepAvatar(g, r, dt) {
    var A = g.userData.anim;
    var snap = !A.init || Math.abs(r.x - A.x) + Math.abs(r.z - A.z) + Math.abs(r.y - A.y) > 4;
    var ky = 1 - Math.exp(-14 * dt);
    var px = A.x, py = A.y, pz = A.z, pyaw = A.yaw;
    if (snap) {
      A.x = r.x; A.y = r.y; A.z = r.z; A.yaw = r.yaw || 0; A.pitch = r.pitch || 0;
      A.vx = A.vz = A.vy = A.yawRate = 0;
      A.init = true;
      px = A.x; py = A.y; pz = A.z; pyaw = A.yaw;
    } else {
      A.x += (r.x - A.x) * ky;
      A.y += (r.y - A.y) * ky;
      A.z += (r.z - A.z) * ky;
      A.yaw += avWrap((r.yaw || 0) - A.yaw) * (1 - Math.exp(-20 * dt));
      A.pitch += ((r.pitch || 0) - A.pitch) * (1 - Math.exp(-16 * dt));
    }
    // 速度：对平滑后的位置做差分，再低通
    var kv = 1 - Math.exp(-9 * dt);
    A.vx += ((A.x - px) / dt - A.vx) * kv;
    A.vz += ((A.z - pz) / dt - A.vz) * kv;
    A.vy += ((A.y - py) / dt - A.vy) * kv;
    A.yawRate += (avWrap(A.yaw - pyaw) / dt - A.yawRate) * (1 - Math.exp(-10 * dt));
    var spd = Math.sqrt(A.vx * A.vx + A.vz * A.vz);
    if (spd > 14) spd = 0;

    // 腾空判定：竖直速度显著时进入，回落到小值时退出（迟滞）
    if (!A.air && (A.vy > 2.4 || A.vy < -3.8)) A.air = true;
    else if (A.air && Math.abs(A.vy) < 1.2) A.air = false;

    // 世界速度 → 身体系（前向 = -Z）
    var c = Math.cos(A.yaw), s = Math.sin(A.yaw);
    var lx = A.vx * c - A.vz * s;
    var lz = A.vx * s + A.vz * c;

    g.visible = true;
    g.position.set(A.x, A.y, A.z);
    g.rotation.y = A.yaw;
    g.rotation.x = 0;
    var rig = g.userData.rig;
    if (rig) poseAvatar(rig, {
      speed: spd, fwd: -lz, lat: lx, vy: A.vy, air: A.air, yawRate: A.yawRate,
      crouch: !!r.c, sprint: !!r.s, fire: !!r.f,
      pitch: A.pitch, alive: r.alive !== false, hp: r.hp
    }, dt);
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
      if (S.role === 'host') sendObjSnapshot();
      return;
    }
    if (m.t === 'st') {
      if (S.role === 'host') onRemoteSelf(m); else onState(m);
      return;
    }
    if (m.t === 'shot' && S.role === 'host') { onRemoteShot(m); return; }
    if (m.t === 'hit') { onHitMsg(m); return; }
    if (m.t === 'dmg' && S.role === 'guest') { onDamageMsg(m); return; }
    if (m.t === 'obj' || m.t === 'objs' || m.t === 'end') { onObjMsg(m); return; }
  }

  // ---------------- 主机 -------------------
  var snapTick = 0;
  function hostTick() {
    if (!S.connected) return;
    if (++snapTick >= CFG.hz * 2) { snapTick = 0; sendObjSnapshot(); }
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
    try { var hr = G.enemies.TUNE && G.enemies.TUNE.hearRadius; if (hr) G.enemies.alert(o, hr); } catch (e) { }
    if (hit && hit.enemy) {
      var en = hit.enemy;
      en.hp -= CFG.dmg;
      send({ t: 'hit', i: en.id, h: Math.round(en.hp), a: en.alive ? 1 : 0, x: hit.point.x, y: hit.point.y, z: hit.point.z });
    }
  }


  // ---------------- 敌人多目标（房主）----------------
  // 游戏本体的敌人 AI 每次都读 G.player。做法：给队友造一个「代理玩家」，
  // 在每个敌人 _update 的这一刻把 G.player 临时换成离它最近的活人，结束后换回，
  // 这样巡逻、索敌、开火、近战、追击全部自动对最近的玩家生效，不用改本体。
  var RP = null;
  function makeRemoteProxy() {
    RP = {
      isRemoteProxy: true,
      pos: new THREE.Vector3(), eye: new THREE.Vector3(), vel: new THREE.Vector3(),
      speed: 0, alive: false, crouching: false, sprinting: false, health: 100,
      // 敌人命中队友：伤害由房主判定，发给队友本机去扣血（自带受击反馈、死亡流程）
      damage: function (amount, from) {
        if (!RP.alive || !S.connected || !(amount > 0)) return;
        var f = from && from.isVector3 ? [+from.x.toFixed(2), +from.y.toFixed(2), +from.z.toFixed(2)] : null;
        send({ t: 'dmg', a: +(+amount).toFixed(1), f: f });
      }
    };
    return RP;
  }

  function syncRemoteProxy() {
    var r = S.remote;
    if (!r) { RP.alive = false; return; }
    var A = avatars.remote && avatars.remote.userData.anim;
    var ok = A && A.init;
    RP.pos.set(ok ? A.x : r.x, ok ? A.y : r.y, ok ? A.z : r.z);
    RP.crouching = !!r.c;
    RP.sprinting = !!r.s;
    RP.eye.set(RP.pos.x, RP.pos.y + (r.c ? 1.15 : 1.68), RP.pos.z);
    RP.vel.set(ok ? A.vx : 0, 0, ok ? A.vz : 0);
    RP.speed = Math.sqrt(RP.vel.x * RP.vel.x + RP.vel.z * RP.vel.z);
    RP.health = r.hp;
    RP.alive = r.alive !== false;
  }

  // 离敌人最近的活人；加 25% 滞回，避免两人距离接近时目标来回跳
  function pickTarget(e, real) {
    var rAlive = real && real.alive !== false;
    if (!RP.alive) return real;
    if (!rAlive) return RP;
    var dr = Math.hypot(e.pos.x - real.pos.x, e.pos.z - real.pos.z);
    var dp = Math.hypot(e.pos.x - RP.pos.x, e.pos.z - RP.pos.z);
    var pick;
    if (e.__mpT === 'p') pick = dp < dr * 1.25 ? 'p' : 'r';
    else pick = dr < dp * 1.25 ? 'r' : 'p';
    e.__mpT = pick;
    return pick === 'p' ? RP : real;
  }

  function wrapEnemy(e) {
    if (!e || typeof e._update !== 'function' || e._update.__mp) return;
    var orig = e._update;
    var w = function (dt) {
      if (S.role !== 'host' || !S.connected || !RP || !RP.alive) return orig.call(e, dt);
      var real = G.player;
      if (pickTarget(e, real) !== RP) return orig.call(e, dt);
      G.player = RP;
      try { return orig.call(e, dt); } finally { G.player = real; }
    };
    w.__mp = true;
    e._update = w;
  }

  // 线段-线段最短距离平方（Ericson）
  var SG = { d1: null, d2: null, r: null };
  function segDist2(p1, q1, p2, q2) {
    if (!SG.d1) { SG.d1 = new THREE.Vector3(); SG.d2 = new THREE.Vector3(); SG.r = new THREE.Vector3(); }
    var d1 = SG.d1.copy(q1).sub(p1), d2 = SG.d2.copy(q2).sub(p2), r = SG.r.copy(p1).sub(p2);
    var a = d1.dot(d1), e = d2.dot(d2), f = d2.dot(r), s, t;
    if (a <= 1e-9 && e <= 1e-9) return r.dot(r);
    if (a <= 1e-9) { s = 0; t = clamp(f / e, 0, 1); }
    else {
      var c = d1.dot(r);
      if (e <= 1e-9) { t = 0; s = clamp(-c / a, 0, 1); }
      else {
        var b = d1.dot(d2), den = a * e - b * b;
        s = den > 1e-9 ? clamp((b * f - c * e) / den, 0, 1) : 0;
        t = (b * s + f) / e;
        if (t < 0) { t = 0; s = clamp(-c / a, 0, 1); }
        else if (t > 1) { t = 1; s = clamp((b - c) / a, 0, 1); }
      }
    }
    var x = r.x + d1.x * s - d2.x * t, y = r.y + d1.y * s - d2.y * t, z = r.z + d1.z * s - d2.z * t;
    return x * x + y * y + z * z;
  }

  // 机械飞鸥的弹丸由全局弹丸系统结算，只会检测房主；这里补一遍对队友的检测
  var boltPrev = [], bvA = null, bvB = null, bvP = null, bvQ = null;
  function hostBolts(dt) {
    var bolts = G.enemies.debug && G.enemies.debug.bolts;
    var T = G.enemies.TUNE && G.enemies.TUNE.gull;
    if (!bolts || !T || !RP || !RP.alive) { boltPrev.length = 0; return; }
    if (!bvA) { bvA = new THREE.Vector3(); bvB = new THREE.Vector3(); bvP = new THREE.Vector3(); bvQ = new THREE.Vector3(); }
    var step = T.boltSpeed * Math.min(dt, 0.05);
    for (var i = 0; i < bolts.length; i++) {
      var b = bolts[i];
      if (!b || !b.on) { boltPrev[i] = null; continue; }
      var prev = boltPrev[i];
      if (!prev) prev = boltPrev[i] = new THREE.Vector3();
      var seg0 = bvP;
      if (prev.__valid) seg0.copy(prev); else seg0.copy(b.pos).addScaledVector(b.dir, -step);
      bvQ.copy(b.pos);
      bvA.set(RP.pos.x, RP.pos.y + 0.35, RP.pos.z);
      bvB.set(RP.pos.x, RP.pos.y + (RP.crouching ? 1 : 1.5), RP.pos.z);
      if (segDist2(seg0, bvQ, bvA, bvB) < 0.36 * 0.36) {
        b.on = false;
        prev.__valid = false;
        RP.damage(T.boltDamage, b.from);
        continue;
      }
      prev.copy(b.pos);
      prev.__valid = true;
    }
  }

  // 自爆飞鸥的爆炸同理：本体只伤房主，补算队友
  function hostExplosion(n, rad, dmg) {
    if (!RP || !RP.alive || !n) return;
    rad = rad == null ? 5 : rad;
    dmg = dmg == null ? 80 : dmg;
    var c = new THREE.Vector3(RP.pos.x, RP.pos.y + 1, RP.pos.z);
    var l = c.distanceTo(n);
    if (l >= rad) return;
    var los = true;
    try { los = G.physics.lineOfSight(n, c); } catch (e) { los = true; }
    if (los) RP.damage(dmg * 0.5 * (1 - l / rad), n);
  }

  var hostHooked = false;
  function hostHooks() {
    if (hostHooked) return;
    hostHooked = true;
    makeRemoteProxy();
    var origUpdate = G.enemies.update;
    G.enemies.update = function (dt) {
      if (S.role === 'host' && S.connected) {
        try {
          syncRemoteProxy();
          var list = G.enemies.list || [];
          for (var i = 0; i < list.length; i++) wrapEnemy(list[i]);
        } catch (e) { console.error('[mp] 目标选择准备失败', e); }
        origUpdate.call(G.enemies, dt);
        try { hostBolts(dt); } catch (e) { console.error('[mp] 弹丸检测失败', e); }
      } else {
        origUpdate.call(G.enemies, dt);
      }
    };
    if (G.combat && typeof G.combat.explode === 'function') {
      var origExplode = G.combat.explode;
      G.combat.explode = function (n, rad, dmg) {
        var out = origExplode.apply(G.combat, arguments);
        if (S.role === 'host' && S.connected) { try { hostExplosion(n, rad, dmg); } catch (e) { } }
        return out;
      };
    }
  }


  // ---------------- 任务进度同步（中继 / 撤离结算）----------------
  // 游戏本体的任务状态在 G.game.run（relays 每项 {id,cut,t,...}，cut/allCut/queue…），
  // 切断中继的内部函数没有导出，但 G.game.debugCut() 会切断「第一个还没切的中继」。
  // 所以收到队友切断某个中继时，临时把它排到 relays 最前面，再调 debugCut，由游戏自己走完整流程
  // （标记变灰、广播、电台、波次、HUD、音效）。切断是单调的：只增不减，重复收到自动忽略。
  // 波次由房主权威生成：任一方切断中继，房主这边都会按本体逻辑刷新下一波，并经现有状态包同步给队友。
  var objApplying = false;   // 正在应用对方的事件：不回发，避免互相回声
  var endApplying = false;

  function missionRun() { return G.game && G.game.run; }
  function toast(txt) { try { if (G.hud && G.hud.message) G.hud.message(txt, 3.2); } catch (e) { } }

  function applyRemoteCut(id, quiet) {
    var run = missionRun();
    if (!run || !run.relays) return false;
    var rel = null, i;
    for (i = 0; i < run.relays.length; i++) if (run.relays[i].id === id) { rel = run.relays[i]; break; }
    if (!rel || rel.cut) return false;
    var orig = run.relays;
    var ordered = [rel];
    for (i = 0; i < orig.length; i++) if (orig[i] !== rel) ordered.push(orig[i]);
    objApplying = true;
    try { run.relays = ordered; G.game.debugCut(); }
    catch (e) { console.error('[mp] 应用队友切断中继失败', e); }
    finally { run.relays = orig; objApplying = false; }
    if (!quiet) toast('队友切断了中继 ' + (rel.short || ''));
    return true;
  }

  function cutIds() {
    var run = missionRun(), out = [];
    if (run && run.relays) for (var i = 0; i < run.relays.length; i++) if (run.relays[i].cut) out.push(run.relays[i].id);
    return out;
  }

  function sendObjSnapshot() {
    if (!S.connected) return;
    send({ t: 'objs', c: cutIds() });
  }

  function onObjMsg(m) {
    if (m.t === 'obj') { if (m.k === 'cut') applyRemoteCut(m.id); return; }
    if (m.t === 'objs') {          // 快照：补上漏掉的（包括中途加入）
      var ids = m.c || [], n = 0;
      for (var i = 0; i < ids.length; i++) if (applyRemoteCut(ids[i], true)) n++;
      if (n) toast('已同步队友的任务进度');
      return;
    }
    if (m.t === 'end') applyRemoteEnd();
  }

  // 队友撤离成功 → 本机也撤离。撤离判定在游戏内部（玩家进入撤离点且 allCut），
  // 所以先补齐中继，再把玩家挪到撤离点，让游戏本体自己走结算流程（评级、结算画面、音乐）。
  function applyRemoteEnd() {
    var g = G.game;
    if (!g || g.state !== 'playing') return;
    var run = missionRun(), ex = G.level && G.level.extraction;
    if (!run || !ex || !ex.pos) return;
    for (var i = 0; i < run.relays.length; i++) applyRemoteCut(run.relays[i].id, true);
    toast('队友已撤离，任务完成');
    endApplying = true;
    try { G.player.pos.set(ex.pos.x, ex.pos.y, ex.pos.z); } catch (e) { endApplying = false; }
  }

  function missionHooks() {
    if (!G.events || !G.events.on) return;
    G.events.on('objective:done', function (p) {
      if (objApplying || !S.connected || !p) return;
      send({ t: 'obj', k: 'cut', id: p.id });
    });
    G.events.on('extraction:reached', function () {
      if (endApplying) { endApplying = false; return; }
      if (S.connected) send({ t: 'end' });
    });
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

  // 房主判定敌人打中了队友：在队友本机走游戏自己的受击流程（扣血、屏幕反馈、死亡）
  function onDamageMsg(m) {
    var p = G.player;
    if (!p || !(m.a > 0) || typeof p.damage !== 'function') return;
    var from = m.f && m.f.length === 3 ? new THREE.Vector3(m.f[0], m.f[1], m.f[2]) : undefined;
    try { p.damage(m.a, from); } catch (e) { console.error('[mp] 受击处理失败', e); }
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
    hostHooks();
    missionHooks();
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
    var lastT = 0;
    (function frame() {
      try {
        var now = performance.now();
        if (S.connected && S.remote && avatars.remote) {
          var dt = lastT ? Math.min(0.06, (now - lastT) / 1000) : 0.016;
          lastT = now;
          if (!(dt > 0)) dt = 0.016;
          stepAvatar(avatars.remote, S.remote, dt);
        } else {
          lastT = 0;
          if (avatars.remote) avatars.remote.userData.anim.init = false;
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
    window.__kaMpApi = { onData: onData };   // 测试入口：直接喂一条网络消息
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
