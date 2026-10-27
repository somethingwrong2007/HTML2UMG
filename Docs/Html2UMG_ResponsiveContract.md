# Html2UMG 响应式作者约定（怎么写才能被连续响应式还原）

> 目标：一份 HTML 写一次，在 21:9 / 16:9 / 4:3 / 16:10 等宽高比下导入 UMG 后**自然重排**，
> 不需要为每个分辨率做一份变体。
> 配套验证页：`Plugins/Html2UMG/Resources/Converter/test/12-responsive.html`（纯流式，不含 media query）；
> 真实稿改写示范：`test/14-fluid-skyline.html`（把定宽的 skyline-settings 改成流式）。
> 机制背景（为什么 UMG 只能这样）见 `Docs/Html2UMG_Anchoring.md`。

## 0. 一页结论

| 你想要的 | 写法 | 转换器产出 | 跨分辨率 |
|---|---|---|---|
| 铺满视口 | `html,body{width:100%;height:100%}` | 根 Border 填满 | ✅ 连续 |
| 左侧固定栏 + 右侧自适应 | `.nav{flex:0 0 240px} .main{flex:1 1 auto;min-width:0}` | HBox + Fill 权重 | ✅ 连续 |
| 卡片按可用宽度换列 | `.cards{display:flex;flex-wrap:wrap;gap:16px}` + 卡片固定宽 | **WrapBox** | ✅ 连续 |
| 行内按比例分宽 | `.a{width:62%}`（**在 flex 行里**） | Fill 权重 0.62 | ✅ 连续 |
| 浮层左右贴边 | `position:absolute;left:32px;right:32px;bottom:24px` | CanvasPanel 槽 **Anchors Min(0,1)–Max(1,1)** | ✅ 连续 |
| 文本按容器宽度换行 | 文本容器**有确定宽度**（通栏 / 固定宽 / flex 拉伸） | TextBlock + AutoWrapText + WrapTextAt | ✅ 连续 |
| 让一块内容居中 | `justify-content:center` / `margin:0 auto` | **烘焙 px padding** | ⚠️ 只在设计尺寸精确（见 1.7） |
| 按长宽比改列数/显隐 | `@media (min-aspect-ratio:…)` | **不解析**（每次转换只看到当前视口） | ❌ 需要断点变体（见 2） |

一句话：**能用"容器宽度"推出来的都能连续；取决于"视口长宽比"的都不能。**

---

## 1. 能被连续响应式还原的写法（主体）

### 1.1 外壳：永远不要写死 body 的宽高

```css
/* ✅ 对：body 跟着视口走，根 Border 在任何分辨率下都填满 */
html, body { width: 100%; height: 100%; margin: 0; padding: 0; }

/* ❌ 错：这就是 1280 下被裁切的那份稿子的写法 */
html, body { width: 1920px; height: 1080px; }
```

写死 px 时，1280 视口里根仍然是 1280 宽、但内部按"1920 的剩余空间"算出来的 offset 会溢出
（实测见 `Docs/Html2UMG_Anchoring.md` §1.4：`340 + 1240 = 1580 > 1280`）。

### 1.2 伸缩：三种齿形，各有确定语义

| 写法 | 转换器读到 | 产出 | 备注 |
|---|---|---|---|
| `flex: 0 0 240px` | fixedWidth 240 | SizeBox(WidthOverride=240) | 跨分辨率恒 240 |
| `flex: 1 1 auto` + `min-width: 0` | flexGrow 1 | 槽 `Size={Fill,1}` | 吃掉剩余空间；`min-width:0` 防内容把行撑爆 |
| `min-width: 320px` / `max-width: 1240px` | minWidth/maxWidth | SizeBox `Min/MaxDesiredWidth` | 只钳制，不定位 |

注意：**`flex-basis: 62%` 与 `width:62%` 在 flex 行里等价**，都会变成「主轴百分比的 Fill 权重」。
不要用 `calc(100% - 240px)` 去表达"剩余宽度"——`calc()` 在尺寸声明里不被解析（见 3），
而 `flex:1` 就是它的连续等价物。

### 1.3 换行重排：flex-wrap → WrapBox（连续重排的主力）

```css
.cards { display: flex; flex-wrap: wrap; gap: 16px; align-content: flex-start; }
.card  { flex: 0 0 460px; width: 460px; }   /* 卡片固定宽，列数由容器宽度决定 */
```

转换器把 `flex-wrap:wrap` 映射成 **WrapBox**，`gap` 映射成 `InnerSlotPadding`。
实测（`12-responsive.html`，8 张 460px 卡片）：

| 视口 | 内容区宽 | 每行列数 | 行数 |
|---|---|---|---|
| 2560×1080 (21:9) | 2272 | **4** | 2 |
| 1920×1080 (16:9) | 1632 | **3** | 3（3+3+2） |
| 1440×1080 (4:3) | 1152 | **2** | 4 |

这就是"不用断点也能改列数"的全部秘密：**列数是容器宽度的函数，不是长宽比的函数**。
反过来，如果列数必须由"长宽比"决定（比如 21:9 一定要 3 列而不是 4 列），那就只能断点变体（见 2）。

百分比宽度的卡片（`width: 25%`）在 WrapBox 里**不推荐**：WrapBox 的主轴尺寸来自子项自身，
百分比会让每张卡片都试图占满父宽的 25%，换算到 UMG 时退化成实测 px（并产生 warn）。
要百分比，请用「行内分宽」（1.4）而不是「卡片宽度」。

### 1.4 百分比：主轴连续，交叉轴不连续

```css
/* ✅ 主轴百分比：flex 行里按比例分宽 -> Fill 权重，跨分辨率连续 */
.ratio { display: flex; gap: 8px; }
.ratio .pct  { width: 62%; }     /* -> Size={Fill, 0.62} */
.ratio .rest { flex: 1 1 auto; } /* -> Size={Fill, 1}     */

/* ⚠️ 交叉轴百分比：竖排里的 width:62% 会被钉成实测 px（并 warn） */
.col > .meter { width: 62%; }
```

原因：UMG 的 Box 槽只有**主轴**有"权重"概念（Fill），交叉轴没有。
转换器对交叉轴百分比的处理是「按设计尺寸钉 px + warn `approximated: … box slots have no cross-axis weight`」，
所以在别的分辨率下不会跟着缩放。**交叉轴要连续，请改成嵌套的 flex 行**。

### 1.5 绝对定位：双侧 inset → 拉伸锚（这条已经能连续）

```css
.content { position: relative; }
.overlay { position: absolute; left: 32px; right: 32px; bottom: 24px; height: 56px; }
```

实测产出（`12-responsive.html` 的 `OverlayBar_Size`，1920×1080）：

```json
"slot": {
  "LayoutData": {
    "Anchors": { "Minimum": [0, 1], "Maximum": [1, 1] },       // X 拉伸、Y 贴底
    "Offsets": { "Left": 32, "Top": -80, "Right": 32, "Bottom": 56 }
  }
}
```

- 左右都给 → X 轴 `Min≠Max` → **拉伸锚**，宽度随父容器连续变化（实测 2272/1632/1152 → 浮层 2256/1616/1136）；
- 只给一边 → 该边点锚（`left:24px` → 锚 0 + offset 24）；
- 都不给 → 若测量中心≈0.5 或 `translate(-50%,-50%)` 则点锚 0.5。

规矩：**要"贴两边"就给两个 inset，不要给 width**；要"固定宽度贴右"就给 `right` + `width`。

### 1.6 文本：容器必须有确定宽度，行数随宽度变化才是对的

```css
/* ✅ 通栏：宽度由父容器决定（父容器是 flex 拉伸或块级流） */
.note { font-size: 14px; line-height: 22px; }

/* ✅ 卡片内：宽度由卡片决定 */
.card .zh { font-size: 14px; line-height: 22px; }
```

转换器会给这样的 TextBlock 同时写 `AutoWrapText=true` 和明确的 `WrapTextAt`，运行期按宽度换行。
实测（`12-responsive.html` 的 「Note」通栏段）：21:9 与 16:9 各 2 行，4:3 **3 行** —— 这就是"运行期换行"的证据；
如果三个视口行数完全一样，说明宽度根本不是流式的。

**不要**：把文本塞进 `white-space:nowrap` 或 `overflow:hidden` 的容器里来"防换行"——
那样导出的是不可换行的 TextBlock，窄屏时会被裁掉；也不要用 shrink-to-fit 的容器（宽度由内容反推，换行点会漂）。

### 1.7 居中：今天是"半连续"，连续解要等 Overlay 接入

```css
.centered { display: flex; justify-content: center; }
.badge { width: 320px; }
```

Slate 的 Box 槽在子项是 Automatic 尺寸时**没有剩余空间可供对齐**（`Docs/Html2UMG_Anchoring.md` §1.2.3），
所以转换器现在的做法是：把浏览器量到的前导空间烘焙成槽 padding，并强制 `HAlign=Left`：

```json
// 1920×1080 下 CenteredBadge_Size 的槽
{ "Padding": [656, 0, 0, 0], "Size": { "SizeRule": "Automatic" }, "HorizontalAlignment": "Left" }
// 656 = (1632 − 320) / 2
```

三个视口实测的烘焙值：21:9 `976`、16:9 `656`、4:3 `416` —— **每次转换都正确，但 WBP 里只有一个值**。
所以在别的分辨率下，这个居中块会偏。

- 现在能做的：接受它（只出一档分辨率时够用），或改用 1.2 的「弹性 + 子项按比例」代替居中；
- 连续解：把这种容器映射成 Overlay（`HAlign=Center` 在 Overlay 里是真居中），
  即 `Docs/Html2UMG_Anchoring.md` 的 I2（默认关，需要灰度）。

### 1.8 单位与函数的现实边界

| 写法 | 现实 |
|---|---|
| `px` / `%` | ✅ 都支持（% 的连续性与轴有关，见 1.4） |
| `flex` / `flex-grow` | ✅ |
| `min-width/max-width/min-height/max-height` | ✅ → SizeBox Min/MaxDesired |
| `vw` / `vh` | ❌ 换算函数返回 0（拿不到画布尺寸）；用 % + flex 代替 |
| `aspect-ratio` | ❌ 转换器不读这个属性；要比例请用 padding-top 百分比或显式高度 |
| `calc()` 用于尺寸 | ❌ 不被解析（退化成实测 px）；用 flex:1 / 嵌套容器代替 |
| `grid-template-columns` 的 `fr` | ⚠️ 只在 decl 里能读到 fr；computed 给的是 px，会按"每列一个最宽单元格"处理 |

---

## 2. 会迫使【断点变体】的写法（一小节）

只有一类：**结构与长宽比相关**。包括

- 用 `@media (min-aspect-ratio: …)` / `max-aspect-ratio` 改 `grid-template-columns`（列数）；
- 用 media query 显隐整块内容（`display:none` 侧栏、21:9 专属信息条）；
- 用 media query 改变 DOM 结构（把并排改成上下、把两个小卡片合并成一个大卡片）。

转换器**每个视口只转换一次**，它看到的是"该视口下"的 DOM：media query 匹配的分支会生效、
不匹配的被浏览器直接 `display:none`（snapshot 会跳过整棵子树并计入 `skippedHidden`），
所以「一个断点 = 一次转换 = 一份 layout.json」。

推论：
1. 这类页面要「N 个断点各跑一次 convert」，由运行期按自身长宽比选变体（WidgetSwitcher）——
   这是另一条流水线（导入器/运行期选择器的活），**不是作者在这一份 HTML 里能解决的**；
2. **不要指望 `--probe` 帮你重排**：`--probe`（默认 0.75× / 1.25×）只用于**锚点比例推断**；
   如果某次 probe 下 DOM 元素数量变了，转换器会 warn
   `probe WxH: DOM changed between viewports (N vs M elements); ignored for anchor inference`
   并**丢弃该 probe**——它不会生成任何"第二个布局"；
3. 结构断点页建议显式 `--probe none`，避免无意义的告警。

---

## 3. 明确做不到的（不要在约定里假装可以）

| 做不到 | 原因 | 替代 |
|---|---|---|
| 像素级连续的 flex 重排（等比伸缩 + 换行 + 基线对齐同时正确） | UMG 没有 flexbox，Box 槽只有主轴 Fill 权重 | 断点变体，或接受 ±2px 级偏差 |
| 断点之间的动画插值 / 连续过渡 | 变体是离散资产，没有插值通道 | 只用断点切换，不做过渡 |
| 复杂 `calc()`、`clamp()`、CSS 变量参与布局 | 尺寸声明只认 px/%/flex | 用 flex + min/max 组合表达 |
| `grid` 自动放置（auto-flow + 跨行跨列 + 内容决定轨道） | 我们的 GridPanel 需要显式行列/span | 显式 `grid-column/grid-row`，或用 flex-wrap |
| 交叉轴百分比随分辨率缩放 | 槽没有交叉轴权重 | 嵌套 flex 行（1.4） |
| 文本「按内容收缩」后靠 nowrap 兜底 | 导出后是不可换行的 TextBlock，窄屏裁切 | 给容器确定宽度 |

---

## 4. 验证页 `12-responsive.html` 的三视口期望几何

> 数值来自 `node cli/convert.js test/12-responsive.html --viewport WxH --dump-snapshot snap.json`
> 的浏览器实测（Chromium 布局结果），**不是手算**；verify 可直接用同一份 snap.json 或渲染后的
> geometry dump 对照。

### 4.1 关键元素 rect（x, y, w, h；px）

| 元素（data-ue-name） | 2560×1080 (21:9) | 1920×1080 (16:9) | 1440×1080 (4:3) |
|---|---|---|---|
| `Nav`（左侧固定栏） | 0, 0, **240**, 1080 | 0, 0, **240**, 1080 | 0, 0, **240**, 1080 |
| `Content`（弹性内容区） | 240, 0, **2320**, 1080 | 240, 0, **1680**, 1080 | 240, 0, **1200**, 1080 |
| `Toolbar` | 264, 18, 2272, 32 | 264, 18, 1632, 32 | 264, 18, 1152, 32 |
| `BtnSettings`（被弹簧推到右端） | 2478, 18, 58, 32 | 1838, 18, 58, 32 | 1358, 18, 58, 32 |
| `Cards`（WrapBox） | 264, 106, 2272, **300** | 264, 106, 1632, **458** | 264, 106, 1152, **616** |
| `CenteredBadge`（居中块，烘焙） | **1240**, 62, 320, 32 | **920**, 62, 320, 32 | **680**, 62, 320, 32 |
| `OverlayBar`（双侧 inset 浮层） | 272, 1000, **2256**, 56 | 272, 1000, **1616**, 56 | 272, 1000, **1136**, 56 |
| `Note`（通栏长中文段） | 264, 418, 2272, **44（2 行）** | 264, 576, 1632, **44（2 行）** | 264, 734, 1152, **66（3 行）** |
| `Card0..Card7`（460×142） | 每行 **4** 张 | 每行 **3** 张（末行 2 张） | 每行 **2** 张 |

关键判据（三句话）：
1. `Nav` 恒 240、`Content` 恒等于「视口宽 − 240」→ 弹性壳正确；
2. `Cards` 每行列数 **4 / 3 / 2** 且总高 **300 / 458 / 616** → WrapBox 真的重排了；
3. `Note` 行数 **2 / 2 / 3** → 文本真的按容器宽度重排（而不是烘焙成固定行数）。

### 4.2 转换器产出（用于核对"机制是否真的落到 UMG 上"）

| 元素 | 产出类 | 槽 / 属性 |
|---|---|---|
| `Cards` | **WrapBox** | `InnerSlotPadding=[16,16]`（gap 16） |
| `OverlayBar_Size` | SizeBox(HeightOverride=56) | **CanvasPanelSlot**：`Anchors Min(0,1) Max(1,1)`、`Offsets L32 T-80 R32 B56`（X 拉伸 / Y 贴底） |
| `CenteredBadge_Size` | SizeBox(320×32) | Box 槽：`Padding[976/656/416, 0, 0, 0]` + `HAlign=Left`（烘焙居中，见 1.7） |
| `Content`（含绝对定位子项） | Border + **CanvasPanel** + VerticalBox(Flow) | 流子项进 Flow 组，绝对定位子项进 Canvas 层 |
| `Note` | TextBlock | `AutoWrapText=true` + `WrapTextAt`（宽度来自容器） |

---

## 5. 作者自查清单（提交设计稿前逐条过）

1. `html, body` 宽高是 `100%`，不是 px？
2. 没有 `vw` / `vh` / `aspect-ratio` / 尺寸类 `calc()`？
3. 固定栏都用 `flex: 0 0 Npx`，自适应区都用 `flex: 1 1 auto` + `min-width: 0`？
4. 卡片区是 `flex-wrap:wrap` + 固定卡片宽（而不是 grid 或 %宽卡片）？
5. 需要按比例分宽的地方，是本行内的 `width:%` / `flex-basis:%`（主轴），而不是竖排交叉轴？
6. 贴边的浮层用了**两个** inset（left+right 或 top+bottom）？
7. 每段文本的祖先链上，至少有一层给出了确定宽度？
8. 没有靠 `white-space:nowrap` 或 `overflow:hidden` 掩盖换行问题？
9. 列数/显隐**不依赖长宽比**？（一旦依赖，就要接受断点变体流水线）
10. 跑一遍三视口 convert，确认「列数」与「文本行数」确实变了？

---

## 6. 真实稿改写示范：定宽 skyline-settings → 流式（`test/14-fluid-skyline.html`）

> 源稿：`skyline-settings.html`（`html,body{width:1920px;height:1080px}`、全 px、无 media query）。
> 流式版：`Plugins/Html2UMG/Resources/Converter/test/14-fluid-skyline.html`（同一份 DOM / 同一套 class 与
> `data-ue-*`，**只改 CSS**）。目标：1920×1080 下视觉不变，但布局不再绑死 1920。

### 6.1 改了哪些属性、为什么（这张表就是改自己稿子时的说明书）

| # | 选择器 / 属性 | 原值 | 流式版 | 转换器产出（实测） | 触发的 UMG 机制 |
|---|---|---|---|---|---|
| 1 | `html,body` `width/height` | `1920px / 1080px` | **`100% / 100%`** | 根 Border 填满视口 | 去掉"1920 绝对坐标系"；否则窄屏必溢出 |
| 2 | `body` `display / 方向` | `flex; row; justify-content:center` | **`flex; column; align-items:center`** | 面板槽 **`HorizontalAlignment: Center`** | 水平居中走**交叉轴**（有富余，连续）；原来的「行 + justify:center」只能烘焙前导 padding |
| 3 | `#panel` `width` | `1240px` | **`92%; max-width:1240px; min-width:0`** | `WidthOverride=1240` + `MaxDesiredWidth=1240`，并 warn `width:92% … pinned to 1240px` | 交叉轴百分比没有权重 → 钉实测 px（**这一条是半连续**，见 6.4） |
| 4 | `#nav` `width` | `232px` | **`flex:0 0 232px; min/max-width:232px`** | SizeBox(232) | 固定列，跨分辨率恒 232 |
| 5 | `#vrule` | `width:1px` | **`flex:0 0 1px`** | SizeBox(1) | 同上，防止被压成 0 |
| 6 | `#content` | `flex:1 1 auto` | **`flex:1 1 auto; min-width:0`** | 槽 **`Size={Fill,1}`** + `MinDesiredWidth=0` | 吃掉剩余宽度（连续） |
| 7 | `.row-k` | `flex:1 1 auto` | **`+ min-width:0`** | `Size={Fill,1}` + `MinDesiredWidth=0` | 同上；`min-width:0` 防止内容把行撑爆 |
| 8 | `.row-v` | `width:380px` | **`width:41%; max-width:380px`** | 槽 `Size={Fill,0.41}` + `MaxDesiredWidth=380` | **主轴百分比 + 上限钳制 = CSS 的 `min(380px,41%)`**，连续 |
| 9 | `#footer-hint` | `flex:1 1 auto` | **`+ min-width:0`** | `Fill 1` | 同上 |
| 10 | 按钮 / 开关 / 下拉 | 固定宽高 | 不变 | SizeBox 定值 | 设计意图就是固定，不要动 |

两处**故意没改**：`.row` 的 `height:76px`、按钮的 `150×44` —— 这些是设计意图里的定值，
改成流式只会让细节抖动；流式要改的是"容器与分配"，不是"控件尺寸"。

### 6.2 视觉在 1920×1080 下没有变化（逐元素实测 diff）

| 元素 | 原稿 rect | 流式 rect | Δ |
|---|---|---|---|
| SettingsPanel | 340, 204, 1240, 672 | 340, 204, 1240, 672 | **0,0,0,0** |
| Header | 341, 205, 1238, 107 | 341, 205, 1238, 107 | 0,0,0,0 |
| Title | 377, 235, 1166, 34 | 377, 235, 1166, 34 | 0,0,0,0 |
| Body | 341, 313, 1238, 467 | 341, 313, 1238, 467 | 0,0,0,0 |
| Nav | 341, 313, 232, 467 | 341, 313, 232, 467 | 0,0,0,0 |
| NavRule | 573, 313, 1, 467 | 573, 313, 1, 467 | 0,0,0,0 |
| Content | 574, 313, 1005, 467 | 574, 313, 1005, 467 | 0,0,0,0 |
| RowResolution | 606, 319, 937, 76 | 606, 319, 937, 76 | 0,0,0,0 |
| RowRenderDistance | 606, 396, 937, 76 | 606, 396, 937, 76 | 0,0,0,0 |
| Footer | 341, 781, 1238, 94 | 341, 781, 1238, 94 | 0,0,0,0 |
| FooterHint | 377, 819.5, 720, 11 | 377, 819.5, 720, 11 | 0,0,0,0 |
| BtnReset | 1109, 803, 130, 44 | 1109, 803, 130, 44 | 0,0,0,0 |
| BtnApply | 1393, 803, 150, 44 | 1393, 803, 150, 44 | 0,0,0,0 |

结论：**13 个关键元素全部 0 像素差**（比"±2px 可接受"更好）。也就是说，把定宽稿改成流式
不会改变设计尺寸下的样子——它只改变"别的尺寸下会发生什么"。

### 6.3 四视口实测（同一份 HTML，四次 convert）

| 视口 | 面板 rect (x,y,w,h) | Nav 宽 | Content 宽 | `.row-v` 宽 | FooterHint 宽 | 是否裁切 |
|---|---|---|---|---|---|---|
| 2560×1080 (21:9) | 660, 204, **1240**, 672 | 232 | 1005 | 380 | 720 | 否（居中） |
| 1920×1080 (16:9) | 340, 204, **1240**, 672 | 232 | 1005 | 380 | 720 | 否 |
| 1440×1080 (4:3) | 100, 204, **1240**, 672 | 232 | 1005 | 380 | 720 | 否 |
| **1280×720** | **51.2, 24, 1177.59**, 672 | 232 | **942.59** | **358.58** | **657.59** | **否** |

对照原稿在 1280×720 下的行为：面板仍从 `x=340` 开始、宽 1240 → 右边缘 1580 > 1280，**被裁 300px**。
流式版在 1280 下：`92% × 1280 = 1177.59` 生效、居中到 `x=51.2`、右边缘 1228.79 < 1280 —— **不裁切**。

本稿没有卡片区，所以"重排"体现为**宽度收缩链**（面板 → 内容区 → 数值列 → 提示文字），
而不是列数变化；列数变化的证据看 `12-responsive.html`（4 / 3 / 2 列，见 §4.1）。

### 6.4 这次改写"连续到什么程度"（诚实结论）

| 维度 | 是否连续 | 依据 |
|---|---|---|
| 面板水平居中 | ✅ 连续 | 槽 `HorizontalAlignment=Center`（交叉轴），2560/1920/1440/1280 实测 x = 660/340/100/51.2 |
| 剩余宽度分配（Content、row-k） | ✅ 连续 | `Size={Fill,1}` ×3 层，1280 下内容区仍 = 面板宽 − 232 − 1 − 68 |
| 数值列 `min(380px,41%)` | ✅ 连续 | 槽 `Fill 0.41` + `MaxDesiredWidth=380`：≥1440 时 380，1280 时 358.58 |
| 面板宽度 92% 上限 1240 | ⚠️ 半连续 | 交叉轴百分比被钉成实测 px（warn 可见）：1280 那次转换得到 1177.59，1920 那次得到 1240 |
| 面板纵向居中 | ⚠️ 烘焙 | 主轴无富余 → `Padding[0,204]`（1920）/ `[0,24]`（1280），每档转换各自正确 |
| 换行位置 | ✅ 连续（按宽度） | 文本容器宽度由上述弹性链决定；行数随宽度变化，不依赖长宽比 |

**要同时拿到"连续居中 + 连续宽度"，需要把这种容器映射成 Overlay**（Overlay 的 HAlign=Center 是真居中，
且子项可以用 Fill 宽度）——这就是 `Docs/Html2UMG_Anchoring.md` 的 I2，当前默认关闭。

### 6.5 复现命令

```bat
cd Plugins\Html2UMG\Resources\Converter
node cli/convert.js test/14-fluid-skyline.html -o C:\out\fluid-1280\layout.json --viewport 1280x720  --assets assets --dump-snapshot C:\out\fluid-1280\snap.json
node cli/convert.js test/14-fluid-skyline.html -o C:\out\fluid-1920\layout.json --viewport 1920x1080 --assets assets --dump-snapshot C:\out\fluid-1920\snap.json
node cli/convert.js test/14-fluid-skyline.html -o C:\out\fluid-1440\layout.json --viewport 1440x1080 --assets assets --dump-snapshot C:\out\fluid-1440\snap.json
node cli/convert.js test/14-fluid-skyline.html -o C:\out\fluid-2560\layout.json --viewport 2560x1080 --assets assets --dump-snapshot C:\out\fluid-2560\snap.json
```

判据（打开 snap.json 的 `primary.elements`，按 `ue.name` 取 rect）：

1. `SettingsPanel`.x 在四档分别 ≈ 660 / 340 / 100 / 51.2，且 `x+w ≤ 视口宽`；
2. `Nav`.w 恒 232；
3. `Content`.w = 面板宽 − 232 − 1 − 68（内边距），1280 档 ≈ 942.59；
4. 任一 `div.row-v` 的 w：≥1440 档 380，1280 档 ≈ 358.58。
