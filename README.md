# King-Arthur-3a · 亚瑟王中王

「亚瑟王中王」——一款基于浏览器的国产 3A FPS 演示作品（WebGL 实时渲染），单文件 HTML，双击即可运行。

## 在线试玩

https://axiong5500.github.io/King-Arthur-3a/

## 仓库

https://github.com/axiong5500/King-Arthur-3a

## 手机玩

横屏适配版：[King-Arthur-3a-App](https://github.com/axiong5500/King-Arthur-3a-App) · 在线试玩 https://axiong5500.github.io/King-Arthur-3a-App/

## 玩法

- 港区主控已封锁泊位，切断堆场、仓库、码头三处中继
- 空中有机械飞鸥，地面有机械猎犬，三处中继全部断开后前往撤离艇
- 键鼠：瞄准 / 射击：左键 / 交互（切断中继）：按住 E / 暂停：Esc
- 触屏：左半屏摇杆移动，右半屏拖动转向，右下开火键（按住后在键上滑动可边打边转向）

## 运行

直接打开 `index.html`，或起一个静态服务器：

```bash
python -m http.server 8080
```

## 枪械皮肤

首页与暂停菜单都能进入「PAC-9 涂装库」，共六套：出厂黑、沙漠灰、都市灰、亚瑟金、极地白、猩红。点选即时生效，选择记在本机（localStorage），重新开始任务后仍然保留。

涂装只改武器的 5 个材质（阳极氧化件、磷化件、聚合物件、哑光面、弹匣），不动模型与刻字，所以任何配色下机加工细节都在；「出厂黑」是恢复原值的基准，切换回来不会有色差累积。

## 目录结构

- `index.html` —— 成品（单文件，已注入皮肤功能）
- `skin-src/` —— 皮肤功能源码，可重复构建
  - `skin.css`：涂装面板样式
  - `skin.js`：涂装数据、材质替换、菜单入口、持久化
  - `build.ps1`：注入脚本

## 构建

`index.html` 由未打补丁的原版注入皮肤功能生成（每次重建都从原版重新注入，不叠加）：

```powershell
pwsh ./skin-src/build.ps1 -BaseHtml ../_src/base_web.html -OutHtml ./index.html
```

## 说明

首次加载需要生成贴图与材质，请稍等数秒。游戏内的「亚瑟港区」「亚瑟突击小队」「亚瑟九式突击步枪」等属于世界观设定名词，与作品名无关。
