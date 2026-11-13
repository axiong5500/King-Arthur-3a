# 协作约定（Claude 每次改动前必读）

## 提交流程
- **直接提交到 `main` 分支**，不要另开功能分支、不要等 PR。
- 每次提交 = 一个可独立回退的功能节点：一个提交只做一件事，出问题时可以直接 `git revert <提交>` 回退，不牵连其他功能。
- 不要 force push，不要改写 main 的历史。
- 本仓库克隆通常是浅克隆；合并/回退前如遇 “unrelated histories”，先 `git fetch --deepen` 补深度，不要硬合。

## 每次提交必须同步 README
- 在 `README.md` 的「更新记录」里**新增一条**（最新的放最上面），写明：日期、提交号（提交后补）、**新增/改变了什么游戏功能**（玩家能感受到的变化，不只是代码改动）、涉及文件、回退方式。
- 同时更新 README 里对应功能小节的说明（如双人联机、枪械皮肤）。
- 提交信息格式：`feat|fix|perf(范围): 一句话说明新增了什么功能`，正文列出具体变化。
- 纯重构或文档改动也要在「更新记录」里写一条，标注「无玩法变化」。

## 构建产物
- `mp-src/net.js` 是联机层源码，改完必须重新注入生成 `mp/index.html`（等价于 `mp-src/build.ps1`），两者内容必须一致。
- `index.html` 是单机成品，除非任务明确要求，不要改动。

# 架构速查（后续优化前先读这里，不用重新勘察）

## 项目本质
浏览器 WebGL 3A FPS 演示《亚瑟王中王》。单文件 HTML，THREE r180 全量内联，**零外链、零图片/模型/音频文件，全部资产由代码生成**。`index.html` 约 1.4MB 且已压缩，**不要直接读或改它**；所有新功能都做成「补丁层」注入。

## 分层与构建
| 目录 | 作用 | 产物 |
| --- | --- | --- |
| `index.html` | 单机成品（原版 + 皮肤层） | 线上主版本 |
| `skin-src/` | 枪械涂装：运行时替换 PAC-9 的 5 个材质配色，localStorage 记选择 | 注入 index.html |
| `weather-src/` | 六种天候（光照/天空/雨/湿度/雾渐变），**当前未启用** | 仅总构建注入 |
| `mp-src/` | 双人联机层：`net.js` + `net.css` + 内联 `peerjs.min.js` | 生成 `mp/index.html` |
注入方式：构建脚本把 css 塞进 `</head>` 前、js 塞进最后的 `</body>` 前；基底已含标记（`ka-mp-js` 等）就报错拒绝，所以永远从干净基底重新注入，不叠加。没有 pwsh 时，用 python 做等价替换（正则匹配 `<script id="ka-mp-js">…</script>` 换成新 net.js），再校验内联内容与 `mp-src/net.js` 逐字一致。

## 运行时抓手 `window.__G`
补丁层不改本体，全靠它。键：`THREE, params, events, rng, time, quality, showcase, render, renderer, scene, camera, viewCamera, mats, physics, props, input, level, backdrop, ground, fx, audio, player, combat, weapon, enemies, hud, game`。
- 它晚于补丁脚本挂上 window，所以补丁用 50ms 轮询等 `__G.THREE/enemies/player/scene` 都就绪再 `boot()`（最多 400 次）。
- 玩家：`player.pos/yaw/pitch/health/alive/crouching/sprinting`，**pitch 正值 = 抬头**，眼高 1.68，走速 3.8、冲刺 6.4。
- 敌人：`enemies.list/spawn/update/raycast`，类型 `gull`（机械飞鸥）与 `hound`（机械猎犬）。
- 事件：`events.on('weapon:fire' | 'enemy:killed' | …)`。渲染：`render.sun / exposure / sky.material.uniforms / tune / post`。
- 陷阱：`ground.setRain()` 外部调用不生效，要在渲染钩子里覆盖 `uRain`；闪电不要写 `post.flash`，改抬 `sun.intensity`；场景无 `fog`，远景靠 `volFarHaze`。

## 联机层 `mp-src/net.js`（约 1400 行）
**架构：房主权威。** 房主本机照常模拟敌人 AI，每 20Hz 发包；加入者冻结敌人 `_update`，只渲染 + 插值；加入者开火只发射线起点/方向，由房主 `enemies.raycast` 裁决再回 `hit`。走 PeerJS(WebRTC) 点对点，信令只在 `peerOpts()` 配置。
- 消息：`hello` / `st`（`p`=对方玩家 `x,y,z,w=yaw,q=pitch,h=hp,a=alive,c=crouch,s=sprint,f=fire`；房主另带 `e`=敌人数组）/ `shot` / `hit` / `ping`。
- 状态对象 `S`：`role(solo|host|guest)`、`remote`（队友最新状态）、`map`（房主敌人 id → 本地幽灵实例）。
- 关键函数：`hostTick`、`guestSendSelf`、`onRemoteSelf`、`onRemoteShot`、`onState`、`driveGuest`、`spawnGhost`、`onHitMsg`、`onLocalFire`、`hostRoom/joinRoom`、`selftest`（`?selftest=1`，标题变 `SELFTEST:OK`）、`boot`（主循环：20Hz 发包 + rAF 驱动替身）。
- 调试句柄：`window.__kaMp`（状态 S）、`window.__kaMpAvatar`（替身）。URL 参数 `?mproom=XXXX` 自动建房，`?room=XXXX` 自动加入。

### 队友人物 v2（net.js「替身」一节）
- 约定：root 原点在脚底，朝 -Z；层级 `root → body → hips → {legL/R: thigh→shin→foot, spine→chest→{neck→head, armL/R, weapon→rifle→手套}}`。身高 ≈1.79m（`AVD` 常量表 + `root.scale 0.975`）。
- 几何积木：`avEll`（椭球）、`avRB`（倒角挤出盒，带缓存）、`avLathe`（旋转体）、`avCyl/avCap/avBand`；贴图全由 canvas 生成（迷彩、织带、枪口焰），材质在 `avMat()`。
- 动画管线（每帧）：`stepAvatar`（把 20Hz 位置包平滑、差分出速度/转身率/腾空，**不需要额外网络字段**）→ `poseAvatar`（混合量 crouch/sprint/air/land/flinch/death、步频 `cad`、支撑相 `duty`、骨盆高度由落脚跨度几何反推、脊柱扭转、头部、武器姿态、开火后坐与枪口焰）→ `avSolve/avApplyChain`（双骨 IK，腿落点来自步态，**手腕固定到枪上的握点**）。
- 已知残留：冲刺时脚底仍有约 1 m/s 的轻微滑动（走路 ≈0.35）；人物细节只看过部分渲染图。

## 验证方法（无真机时）
- 无头 Chrome（`/usr/bin/google-chrome`，puppeteer-core，`--use-angle=swiftshader`）+ npm 的 `three@0.180.0`：写一个测试页 `eval` 注入 net.js 末尾暴露内部函数，多个替身并排渲染多姿态截图，再做数值检查（NaN、落地脚滑动速度、IK 到达率 `reach<1`、跳跃/倒地/复活/传送/跨 ±π 转身）。
- 真实页面集成检查：打开 `mp/index.html`，设 `__kaMp.connected=true` 并写入 `__kaMp.remote` 模拟队友，确认 `__kaMpAvatar.remote.visible` 且无页面报错。这些脚本放在会话临时目录，不入库。

## 已知薄弱点 / 优化候选
1. 联机 V1：敌人只把房主当目标（应改为「最近的玩家」）；任务进度（三处中继、波次、结算）两端各跑各的，需同步 `objective:progress`；队友命中依赖回包，有约一帧延迟。
2. 敌人 AI 只有 patrol/alert 两态、无寻路；关卡是单图 + 三波固定敌人。
3. 天气层源码完整但未启用：暴雨/雷暴低画质糊屏（雨量 >0.6），缺真机长时间验证。
4. 补丁层依赖 `__G` 内部字段名，原版改名会连锁失效。
5. 联机依赖 PeerJS 公共信令 `0.peerjs.com`，不可达时需自建信令。

## 工作环境注意
- 克隆是浅克隆：推送新分支后若钩子误报“无远程分支”，先 `git fetch --depth=1 origin +refs/heads/X:refs/remotes/origin/X` 补跟踪引用；合并前遇 “unrelated histories” 用 `--depth=2` 补深度。
- Claude 的 GitHub 应用对本仓库有写权限（推送已验证可用）。
