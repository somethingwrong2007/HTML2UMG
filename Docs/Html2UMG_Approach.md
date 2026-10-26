# HTML → UMG：技术路线调研与选型

> 目标：在 UE 5.8 里"把 HTML 设计稿变成可用的 UI"，有三种本质不同的做法。它们的差别不在实现细节，而在**最终产物是什么**。

---

## 路线 ①：运行时内嵌浏览器

把 Chromium/WebKit 塞进游戏进程，UI 还是网页。

| 代表 | 形态 |
|---|---|
| [Coherent Gameface](https://forums.unrealengine.com/t/umg-vs-web-browser-widget-html-css-and-js-to-make-a-ui/2668224) | 商业，UE 官方生态里最常见的 HTML UI 方案，JS 双向绑定 Blueprint |
| BLUI / WebUI / UE 自带 `WebBrowser` | CEF 封装，开源或随插件分发 |
| Ultralight | 精简 WebKit，主打低开销 |

**优点**：CSS/JS 全支持，前端代码原样跑，热更新容易，设计工具链成熟。
**缺点**：
- 产物不是 UMG——Designer 里看不到、改不了，`BindWidget` 用不上；
- 打包体积（CEF 几十 MB）与常驻内存（一个渲染进程）；
- 主机平台（PS/Xbox/Switch）要么不支持要么额外许可成本；
- 渲染与 UMG 分层叠加，Slate 的裁剪/DPI/无障碍/输入焦点要重新对齐；
- 版本天花板：CEF 版本被插件锁死。

## 路线 ②：在 Unreal 内自建 HTML/CSS 引擎并自绘

自己解析 HTML、算 CSS 层叠、做布局，再用 Slate 画出来。

| 代表 | 说明 |
|---|---|
| [WebUIX](https://www.fab.com/listings/ef660a6e-7069-4c7f-88dc-e3dbc1620fbd) | Fab 产品，明确卖点是"不内嵌浏览器"，自带 DOM/样式/布局/显示列表管线 |
| [litehtml](https://github.com/litehtml/litehtml) | C++ 轻量 HTML/CSS 引擎，只支持 CSS2 + 部分 CSS3，**没有 flex/grid** |
| [UE4_Gumbo](https://github.com/AlexeyTaranov/UE4_Gumbo) | Google Gumbo 解析器的 UE4 移植，只做解析，布局仍需自己写 |
| yoga / taffy / css-layout | 布局内核，可以借来算 flex/grid |

**优点**：运行时零外部进程、可控体积、产物可以是 Slate 原生绘制。
**缺点**：这是"重造浏览器"——CSS 层叠、继承、flex/grid、字体度量、文本断行、渐变/阴影/滤镜，每一项都是深坑。litehtml 连 flexbox 都不支持；要覆盖现代设计稿（Tailwind、shadcn 这类）几乎要写一个 MiniBlink。**投入产出比最差**。

## 路线 ③：离线静态转换（本项目采用）

用机器上**已经装好的真浏览器**算一次布局，把结果固化成中间契约，再由编辑器生成**原生 UMG**。

```
design.html ──[Node + 本机 Chromium/CDP]──> layout.json ──[UE Editor 模块]──> WBP_Asset
```

**关键点**：转换时不需要自己实现 CSS——用 Chrome/Edge 的 `getComputedStyle` + `getBoundingClientRect` 拿真实排版结果。现代 CSS（`color-mix()`、`:has()`、container query、`position: sticky`）天然支持，因为用的是"你的浏览器"。

**优点**：
- 产物是**纯 UMG**：Designer 可编辑、`BindWidget` 可用、任何 UMG 支持的平台都能跑、运行时零依赖、零额外内存；
- 不需要 CEF，也不需要自研 CSS 引擎——**编辑器期**依赖 Node+浏览器，**运行时**什么都不需要；
- 中间 JSON 可 diff、可 review、可手写、可进 CI（`-run=Html2UMG`）；
- 无 Chromium 版本天花板。

**代价（必须诚实说明）**：
- 只做**静态**：CSS 动画/过渡/JS 行为不会变成 Widget Animation，交互要在蓝图里写；
- 一次快照无法区分"左对齐"和"居中"（1920 宽下位置一样）——所以要用多视口 probe 推断 anchors；
- `box-shadow`、渐变、`backdrop-filter` 这类 Slate 画不出的效果，要么烘焙成贴图，要么用材质近似。

**这条路线已有商业实现**——你给的参考站 [UMGForge](https://soulpersona.studio/pages/umgforge_docs) 就是这个架构（Node 驱动本机 Chromium，输出 JSON，编辑器生成 WBP）。它验证了可行性，也暴露了这条路线的难点清单（响应式、字体度量、烘焙策略）。本项目按同一架构实现，但在契约、反射写入和可验证性上做了自己的设计。

---

## 三条路线对比

| 维度 | ① 内嵌浏览器 | ② 自研 CSS 引擎 | ③ 静态转换（本项目） |
|---|---|---|---|
| 最终产物 | 网页 | Slate 自绘 | **原生 UMG Widget Blueprint** |
| 可在 Designer 编辑 | ✗ | 部分 | **✓** |
| `BindWidget` | ✗ | ✗ | **✓** |
| 运行时依赖 | CEF 数十 MB | 自研引擎 | **无** |
| 主机平台 | 受限/需授权 | ✓ | **✓** |
| JS 行为 | ✓ | ✗ | ✗（写蓝图） |
| CSS 动画 | ✓ | 部分 | ✗（显式不支持） |
| CSS 兼容性 | 取决于 CEF 版本 | 取决自研程度 | **取决于本机浏览器** |
| 响应式 | ✓ | 取决于实现 | ✓（anchors + Fill，需 probe） |
| 开发成本 | 中（集成） | **极高** | 中（转换器 + 导入器） |
| CI 可用 | 难 | 难 | **✓ 全程无头** |

---

## 本项目的关键设计决定

1. **读 computed style，不读 class 名**。所以 Tailwind / shadcn / AI 生成的任意 HTML 都能直接吃，没有"模板规范"要遵守。
2. **只有 CSS 声明过的尺寸才固定**；被父容器撑开的尺寸保持 `Fill`。这条决定了产物是否还响应式——是整条路线里最容易做错的一点。
3. **一个 DOM 元素可以展开成多个控件**（`SizeBox → Border → 内容`），转换器插入合成包装节点，C++ 侧只做无特例的递归。
4. **中间契约是产品的一部分**：`layout.json` 可手写。不想要 HTML 的团队可以直接写 JSON。
5. **原地重建**：重复导入时控件的名字保持稳定，蓝图图表与 `BindWidget` 继续有效——只覆盖布局。
6. **可度量**：插件自带把 WBP 渲染成 PNG 的能力，可以和浏览器截图做像素对拍（`Resources/Tools/pngdiff.py`），不靠"看起来差不多"。

## 明确不做的事

| 不做 | 原因 / 替代 |
|---|---|
| CSS 动画 → Widget Animation | 语义映射不唯一（timing function、关键帧、composite）；UMG 里手做 |
| JS 逻辑导入 | 静态产物，交互写在蓝图 |
| `box-shadow` 精确复刻 | Slate brush 无投影；烘焙为贴图或材质 |
| 角度渐变 | Slate 只有轴向；吸附到最近轴并告警 |
| CommonUI | 先做纯 UMG，CommonUI 是另一套控件与输入路由 |
| 运行时热更新 HTML | 那是路线 ①，本项目产物是编译期资产 |

---

## 参考

- [UMGForge 文档](https://soulpersona.studio/pages/umgforge_docs) — 同架构的商业参考实现，含"能转换/不能转换"清单
- [litehtml](https://github.com/litehtml/litehtml) — 路线 ② 的典型基座，作者自己说明不支持 flex/grid
- [UE4_Gumbo](https://github.com/AlexeyTaranov/UE4_Gumbo) — Gumbo HTML 解析器的 UE 移植
- [WebUIX (Fab)](https://www.fab.com/listings/ef660a6e-7069-4c7f-88dc-e3dbc1620fbd) — 路线 ② 的商业产品
- [UMG vs Web Browser Widget 讨论](https://forums.unrealengine.com/t/umg-vs-web-browser-widget-html-css-and-js-to-make-a-ui/2668224) — 路线 ① 的社区实践与 Coherent Gameface
