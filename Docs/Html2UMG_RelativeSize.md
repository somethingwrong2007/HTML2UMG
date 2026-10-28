# Html2UMG 相对尺寸：把分段函数降维成一个盒子

> **状态：`H2URelativeBox` 已删除**，插件现在没有任何 Runtime 模块。§1–§7 记录的降维思路和实测量
> 仍然有效（其中 `relativeBoxPlan()` 还在用，它现在生成**原生三层嵌套**）；现行做法见 §8.2.1：
> `CanvasPanel(比例锚) → ScaleBox(ScaleToFit, DownOnly) → SizeBox(夹紧px)`。
> 外框宽度实测 1920=1240 / 1280=1177.6 / 2560=1240；像素差 1.89% / 10.31%
> （旧版逐字重排为 1.48% / 3.22%）。下文凡写 `H2URelativeBox` 处，请按"原生三层嵌套"读。

> 回应的问题：`width:min(1240px, 92vw)` / `clamp(320px, 50%, 900px)` / `width:92%; max-width:1240px`
> 这类"分段函数"为什么不能靠 SizeBox 落，怎么降维成 `{percent, minPx, maxPx}`，
> 降维后的 JSON 长什么样，以及哪一轴根本降不了。
> 相关文档：机制背景 `Docs/Html2UMG_Anchoring.md`；作者约定 `Docs/Html2UMG_ResponsiveContract.md`。
> 实现：`src/values.js` 的 `parseRelativeSize()`、`src/mapper.js` 的 `relativeBoxPlan()` /
> `relativeBoxProperties()` / `wrapCrossAxisPercent()`。验收页 `Resources/Converter/test/15-relative.html`。

## 0. 一页结论

| CSS（在**列**容器里，宽=交叉轴） | `--layout=responsive` 产出 | 跨分辨率 |
|---|---|---|
| `width:60%` | **spacer row**：`HBox[spacer Fill .2][child Fill .6][spacer Fill .2]` | ✅ 连续（无需运行期控件） |
| `width:92%; max-width:1240px` | **CanvasPanel(0.04..0.96) + ScaleBox(DownOnly) + SizeBox(1240)** | ✅ 连续（低于夹子时整体缩放） |
| `width:min(1240px, 92vw)` | 同上 `{WidthPercent:.92, MaxWidth:1240}` | ✅ 连续（vw 基准见 §7） |
| `width:max(600px, 40%)` | `{WidthPercent:.40, MinWidth:600}` | ✅ 连续 |
| `width:clamp(320px, 50%, 900px)` | `{WidthPercent:.50, MinWidth:320, MaxWidth:900}` | ✅ 连续 |
| `width:1240px` | `SizeBox{WidthOverride:1240}`（不变） | ✅ 定值 |
| `max-width:1240px`（无 %） | `SizeBox{MaxDesiredWidth:1240}`（不变） | 只夹 desired |
| **主轴**上的 `width:41%; max-width:380px` | `Fill 0.41` + `SizeBox` clamp + warn | ⚠️ 半连续，见 §4 |

`--layout=exact`（默认）这四类**照旧烘焙**：纯 % 钉实测 px、min/max 落 SizeBox，输出与改动前逐字节相同。

## 1. 为什么分段函数必须降维

UMG 的 `USizeBox` 只夹**期望尺寸**：

- `SBox.cpp:146-158`（`ComputeDesiredSize`）把 `MinDesired*`/`MaxDesired*` 应用在 `ChildDesiredSize` 上；
- `SBox.cpp:187+`（`OnArrangeChildren`）把**父容器分配的几何**原样交给子项，一个数都不夹。

所以 `max-width` 只有在"槽是 desired 驱动"（`SizeRule=Automatic`）时才有效。
一旦子项落在 `Fill` 槽里（它的宽度由分配决定），`MaxDesiredWidth` 在运行期**被静默忽略**。
旧代码的两条应对都不完整：

1. 在 `Fill` 槽上发现 clamp 生效就**丢掉 Fill**、退回 desired 驱动（`mapper.js` 的 clamp 启发式）——
   能保住 clamp，但丢掉了"随父宽变化"这件事；
2. 什么都不做——clamp 在运行期消失。

分段函数的信息本来就够：`min(1240px, 92vw)` = "父宽的 92%，但不许超过 1240"。这是一个
**运行期才成立的等式**（`size = clamp(allot × percent, min, max)`），而 UMG 原生没有"给定空间 →
算自己尺寸"的控件（SizeBox 只能改 desired，Border/Overlay 只会摆子项）。所以它必须落到一个
**能读到自己被分配到多少**的控件上——这就是项目控件 `/Script/Html2UMGRuntime.H2URelativeBox`
（运行期实现见该控件的头注释，本仓库转换器只负责产出 JSON）。

反面：`clamp()` 不是"三个值"而是"一个百分比 + 两个夹子"。降维就是把三段折成这三个数，
运行期只做一次乘法加两次比较；如果留在 JSON 里当字符串，运行期没有 CSS 解析器可用。

## 2. 哪些表达式可降维

`values.js: parseRelativeSize(value)` 的判据：**表达式必须恰好等价于
`clamp(percent × 基准, minPx, maxPx)`**，且基准必须是"父容器在该轴上的尺寸"。

| 写法 | 结果 | 说明 |
|---|---|---|
| `min(1240px, 92%)` / `min(1240px, 92vw)` | `{percent:.92, maxPx:1240}` | min 取小 → px 是**上限** |
| `max(600px, 40%)` | `{percent:.40, minPx:600}` | max 取大 → px 是**下限** |
| `clamp(320px, 50%, 900px)` | `{percent:.50, minPx:320, maxPx:900}` | 三段齐全 |
| `clamp(320px, 50%, 900px)` 的边界不是 px（如 `clamp(10%,50%,90%)`） | ❌ null | 两个百分比夹子无法表达成 minPx/maxPx |
| `min(50%, 30%)` | `{percent:.30}` | 同基准的比例可以先折 |
| `60%` / `92vw` | `{percent}`，无夹子 | **不**用 H2URelativeBox（走 spacer row / Fill 权重） |
| `min(1000px, 1240px)`（全 px） | `{px:1000}` 常量 | 退化为定值，仍走设计尺寸分支 |
| `calc(100% - 240px)` / `var(--w)` / `50em` / `12rem` / `50%`+`60vw` 混用 | ❌ null | 见下 |

不可降维时**不许静默**：mapper 发一条
`relative-size: <表达式> at '<元素>' falls back to the design-size branch (…)`，
然后按旧行为（实测 px）落位。合并语义（`width:92%; max-width:1240px`）走的是
"声明式 `percent` + `max-width`"，产物与 `min(1240px, 92%)` **完全相同**。

三条硬边界：

1. **基准必须是父容器的该轴尺寸**。`%` 满足；`vw`/`vh` 是**视口**，只有当父容器正好横跨视口时才等价，
   转化器会发一条 `note:` 说明（§7）；
2. **不能混基准**：`min(40%, 60vw)` 里两个比例基准不同 → 返回 null（不是同一比例）；
3. **clamp 的夹子必须是 px**：`clamp(10%, 50%, 90%)` 的上下限本身随父宽变化，三个数的模型装不下。

## 3. JSON 字段语义

`class` 写 `"H2URelativeBox"`（导入器映射到 `/Script/Html2UMGRuntime.H2URelativeBox`），
它是该元素的**最外层**包装（元素自己的名字仍在里面的 Border/内容控件上，绑定不受影响）。

| 属性 | 类型 / 单位 | 语义 |
|---|---|---|
| `WidthPercent` / `HeightPercent` | 0..1 浮点 | 0 = **不启用百分比**（不是 0 像素）。真 0 宽仍用 SizeBox `WidthOverride=0` |
| `MinWidth` / `MaxWidth` / `MinHeight` / `MaxHeight` | px 浮点 | **≤0 = 不限制**（省略与 0 等价） |
| `ContentHAlign` / `ContentVAlign` | 0 / 0.5 / 1 | 内容在**分配空间内**的对齐：0 左/上、0.5 中、1 右/下。只在有百分比的那一轴输出（另一轴内容本来就拿满） |
| `ContentPadding` | [l,t,r,b] | 可选；本转换器不输出（内边距仍由元素自己的 Border 承担） |

运行期语义（与控件头注释一致）：

1. 有百分比：`子尺寸 = clamp(父分配 × percent, min ≤0 ? -∞ : min, max ≤0 ? +∞ : max)`；
2. 无百分比只有夹子：`clamp(desired, min, max)`（这种情况转换器不出这个控件，SizeBox 本来就能做）；
3. **父空间 < Min 时按 Min 显示并允许溢出**，控件自己不裁切——和浏览器 `min-width` 溢出语义一致。

因为控件"自己算了尺寸"，它在父容器里的槽必须拿到**整块可分配空间**，所以转换器给：

- 交叉轴：`HorizontalAlignment/VerticalAlignment = Fill`（Box 槽交叉轴本来就有富余）；
- 主轴（仅非 Box 父容器，§4）：`Size = {Fill, 1}`。

实例（`test/15-relative.html`，1280×720 与 1920×1080 两次转换的产物逐字相同——这正是"运行期才算"的意思）：

```json
{ "name": "RelMin_Rel", "class": "H2URelativeBox",
  "properties": { "WidthPercent": 0.92, "MaxWidth": 1240, "ContentHAlign": 0.5 },
  "slot": { "Padding": [0, 24, 0, 0], "Size": { "SizeRule": "Automatic" },
            "HorizontalAlignment": "Fill", "VerticalAlignment": "Top" } }
```

`14-fluid-skyline.html` 的真实面板（`width:92%; max-width:1240px`，列容器的交叉轴）：

```json
{ "name": "SettingsPanel_Rel", "class": "H2URelativeBox",
  "properties": { "WidthPercent": 0.92, "MaxWidth": 1240, "ContentHAlign": 0.5 } }
```

## 4. 主轴上的百分比降不了（明确的限制）

`H2URelativeBox` 的百分比是"**分配给我的空间**的百分比"。Box 面板的主轴分配不是父宽：

- 交叉轴：槽 = 面板尺寸，富余都在 → `percent × 面板宽` 成立；
- 主轴：槽 = `weight / Σweight ×(剩余空间)`。若把一个 `41%` 的子项先按权重分到 41% 的剩余空间，
  控件再乘 41%，结果是 `41% of 41%` —— 比不降维还错。

所以转换器只在这些位置输出 H2URelativeBox：**Box 面板的交叉轴、GridPanel 的格子、单子项槽
（Border/SizeBox/Overlay/根）**。主轴上的"百分比 + 夹子"保持
`Fill 权重 + SizeBox clamp` 并 warn：

    note: '<元素>' has a clamped percentage on its container's main axis; it is left to the
    SizeBox clamp because a Fill share is not a fraction of the parent

这与 `Docs/Html2UMG_ResponsiveContract.md` §1.2/§6.4 记录的"半连续"是同一件事：
`14-fluid-skyline.html` 的 `.row-v{width:41%; max-width:380px}` 属于这一档。

## 5. 与 spacer row 的分工（纯百分比不用新控件）

没有夹子的纯百分比**不**走 H2URelativeBox：交叉轴用 spacer row，主轴用 Fill 权重，两者都已连续，
且不引入运行期控件。 `test/15-relative.html` 的 `width:60%`：

```json
{ "name": "PctBox_Size_PctWrap", "class": "HorizontalBox",
  "slot": { "Padding": [0,0,0,0], "Size": {"SizeRule":"Automatic"},
            "HorizontalAlignment": "Fill", "VerticalAlignment": "Top" },
  "children": [
    { "name": "PctBox_Size_PctWrap_L", "class": "SizeBox",
      "slot": { "Size": { "Value": 0.2, "SizeRule": "Fill" } } },
    { "name": "PctBox_Size", "class": "SizeBox",
      "slot": { "Size": { "Value": 0.6, "SizeRule": "Fill" } } },
    { "name": "PctBox_Size_PctWrap_R", "class": "SizeBox",
      "slot": { "Size": { "Value": 0.2, "SizeRule": "Fill" } } } ] }
```

两个要点（都踩过）：

1. spacer 是**无画刷、无子项的空 SizeBox**，权重只存在于槽上；`assignSlots()` 会重算槽，
   所以权重同时存在节点的 `meta.fillWeight` 上，否则 spacer 会退回 `Automatic`（0 宽），
   子项就吃满 100%；
2. row 自己必须处在**交叉轴 Fill** 的槽里（上面的 `HorizontalAlignment: Fill`），否则 row 只有
   desired 宽，三个 Fill 权重分的是一个缩小的空间，"父宽的 60%"就不成立；
3. row 不写 `source`：它代表父容器的内容宽，不是元素自己的矩形，写了会让几何审计拿两个不同的框比较。

## 6. 复现与验收（只跑 convert）

```bat
cd Plugins\Html2UMG\Resources\Converter
node cli/convert.js test/15-relative.html -o C:\out\rel-1280\layout.json --assets C:\out\rel-1280\assets --viewport 1280x720  --layout=responsive
node cli/convert.js test/15-relative.html -o C:\out\rel-1920\layout.json --assets C:\out\rel-1920\assets --viewport 1920x1080 --layout=responsive
```

| 盒子 | JSON（两次相同） | 浏览器实测宽 | 运行期将得到 |
|---|---|---|---|
| `PctBox` `width:60%` | spacer row `Fill 0.2/0.6/0.2` | 768 / 1152 | 0.6 × 宽 |
| `RelMin` | `WidthPercent .92, MaxWidth 1240` | 1177.59 / 1240 | 1177.6 / 1240 |
| `RelMax` | `WidthPercent .4, MinWidth 600` | 600 / 768 | 600 / 768 |
| `RelClamp` | `WidthPercent .5, Min 320, Max 900` | 640 / 900 | 640 / 900 |

判据：每个盒子的 `browser w` 与"控件会算出的值"一致（1280 下 `min` 不被夹、1920 下被 1240 夹住），
而 JSON 两次**完全一样**——夹在哪一档由运行期决定，不是转换期。

## 7. 已知限制

| 限制 | 后果 | 状态 |
|---|---|---|
| `vw`/`vh` 的基准是**视口**，控件乘的是**父分配** | 父容器不横跨视口时偏小/偏大 | 转换器发 `note:`；要精确请用 `%` |
| 百分比是**内容盒**，控件按 **border box** 夹 | 元素自身有 padding/border 时差一个 padding | 未处理（本仓库的百分比元素基本都是无内边距容器） |
| 主轴上的"百分比 + 夹子" | 仍走 SizeBox clamp，半连续 | §4，warn |
| `calc()` / `var()` / `em` / 混基准 | 不降维 | warn + 设计尺寸分支 |
| WrapBox 里的百分比 | 不降维（WrapBox 主轴尺寸来自子项自身） | warn + 设计尺寸分支 |
| `test/validate.js` 的类表 | — | 已补：`H2URelativeBox`、`H2URelativeBoxSlot`、单子项上限；32 份 layout 校验全过 |

另：exact 模式下与相对尺寸无关但相关的一处修正是**页面画布**上的交叉轴居中——当父容器是
"带着设计尺寸而不跟窗口走"的画布（`<body>`，或覆盖整幅设计视口且在 probe 里尺寸不变的块）时，
不发 `VAlign=Center`，改为实测 `Padding.Top`（`mapper.js: boxSlot` 的画布分支 +
`designCanvasParent()`）。它让定宽稿在窄视口里按设计高度被裁切，而不是重新居中：
skyline 定宽稿 1280×720 从 25.76% 降到 2.4% 量级，而 1920/2560/1440 回到改动前的数字。

**只限画布**，不是所有固定 px 的父容器：`height:38px` 的行在任何分辨率都保持 38px，它内部的
`Center` 本来就跟着控件自身尺寸走、是对的；在那里烘焙实测偏移会改动 17 个槽位并让设计尺寸
掉 0.12%（Slate 的字高与浏览器行盒有微小差，居中能吸收它，冻结的数字不能）。判不准时保持
`Center`，并在日志里 info 一次。见 `Docs/Html2UMG_Anchoring.md` §1.4 的同一机制（主轴）。

---

## 8. 相邻的两个坑（WrapBox 间距、段落换行）

这两条不在"相对尺寸"里，但都属于"responsive 下宽度/尺寸由运行期决定"的同一族，记在这里免得再踩。

### 8.1 WrapBox 的 gap 只能有一个来源

`display:flex; flex-wrap:wrap; gap:16px` → WrapBox。gap 有两个可写的位置：

| 位置 | 谁消费 | 说明 |
|---|---|---|
| 面板 `UWrapBox.InnerSlotPadding` | WrapBox 自己在两个子项之间加 | **唯一来源** |
| 子项 `UWrapBoxSlot.Padding` | 每个槽自己的内边距 | **不要再放 gap**，否则叠加 |

实测（12-responsive，8 张 460px 卡片，gap 16）：两处都写的时候 pitch = 460+32 = 492，
浏览器是 460+16 = 476，四张卡累计偏 48px。现在槽位 padding 只留 margin，gap 全部走
`InnerSlotPadding`。

### 8.2 `WrapSize` 必须显式声明（否则可能只放得下一列）

`UWrapBox` 构造默认 `WrapSize=500, bExplicitWrapSize=false`（`WrapBox.cpp:19-20`），而
`RebuildWidget` 用 `UseAllottedSize(!bExplicitWrapSize)` + `PreferredSize(WrapSize)`
（`WrapBox.cpp:65-72`）决定"按父宽折行"还是"按 500px 折行"。一张 460px 卡片在 500px 里
只放得下**一张**：12-responsive 因此渲染成 8 行 / 896px（= 8×98 + 7×16），而浏览器是 3 行 / 458px。

转换器现在**两种模式**都显式发（`WrapSize` = 设计视口下该容器的**内容宽**）：

```json
{ "class": "WrapBox",
  "properties": { "InnerSlotPadding": [16,16], "bExplicitWrapSize": false, "WrapSize": 1632 } }
```

先纠正一个容易踩反的细节：**`WrapSize` 不能发 0**。`SWrapBox` 的 `ComputeDesiredSize` 和子项排布
**都**读 `PreferredSize`（`SWrapBox.cpp:227` `WidthOfCurrentLine = WrapBox.PreferredSize`），
`UWrapBox` 把 `WrapSize` 映射成 `PreferredSize`（`WrapBox.cpp:65-72`）；`bUseAllottedSize`
（= `!bExplicitWrapSize`）只让 Tick 把**上一次 allotted 宽**写回 `PreferredSize`，所以它修的是
**arrange**、**修不到 desired**。三档实测：

| `WrapSize` | desired 行数 | 12-responsive 卡片区高 |
|---|---|---|
| `0` | 每子项一行 | 1226 |
| 引擎默认 `500` | 460 卡每行一张 | 896（8 行） |
| **设计内容宽 `1632`** | 3 张一行 | **458** ✅ |

`bExplicitWrapSize` 保持 `false`，让 Tick 继续跟踪运行期宽度供 arrange 用。
**两种模式都发**：这是引擎默认值的陷阱（换一份稿子就翻车），不是响应式专用；exact 模式的
`01-flex` 只是恰好一行放得下才没暴露（它的 `Tags` 现在 `WrapSize=1206` → 1 行 / 24px）。

### 8.2.1 不需要运行期 WrapBox：引擎自己会在第二帧收敛

这里曾经有一个 `H2UWrapBox`（`UWrapBox` 子类，用上一次 arrange 宽重算 desired 高度），**已删除**。

`WrapSize` 确实是设计期常量，但 `SWrapBox::Tick` 在 `bUseAllottedSize`（= `bExplicitWrapSize`
为 false）时会把 allotted 宽度写进 `PreferredSize`，而这个属性声明为
`EInvalidateWidgetReason::Layout` —— 属性一变布局失效，下一趟 prepass 就按新宽度重算行数与
desired 高度。所以普通 `WrapBox` + `WrapSize=设计内容宽` 就够了：

| 场景 | 实测 |
|---|---|
| 合成稿 1920（4 行） | 第 1 帧 592，第 2 帧 592 |
| 合成稿 1280（6 行） | 第 1 帧 592（设计宽），**第 2 帧 896** |
| 12-responsive @1280 的 `Cards` | 第 1 帧 458，**第 2 帧 616**（与浏览器一致） |

> **结论（不是缺陷）**：高度与行数在**第二帧**收敛。Slate 是「子先算 desired、父 arrange 才给宽度」
> 的单帧结构；`STextBlock::AutoWrapText` 的官方注释同样承认「晚一帧」。**单帧离屏截图会看到设计宽下
> 的高度**——验收要么跑两帧（`Html2UMG.RenderFrames`，默认 2），要么按这个口径记录。

### 8.2.2 绝对定位的基准盒：CanvasPanel 必须站在 padding 盒上

`buildElement` 用一层 Border 承载元素的 padding+border，所以 `CanvasPanel` 默认落在**内容盒**；
而 CSS `position:absolute` 的 `left/right/top/bottom` 是相对**padding 盒**（border 盒减 border）量的。
两者差一个 padding，于是每个绝对定位子项整体偏移：

| | 浏览器 | 修复前 | 修复后 |
|---|---|---|---|
| `12-responsive .overlay` | `x=272 y=1000 w=1616 h=56` | `x=296 y=904 w=1568` | **`x=272 y=1000 w=1616 h=56`** |

修法（**不改 `Anchors/Offsets` 的语义**，它们继续等于 CSS 的值）：

1. `buildElement`：这个元素**承载画布**时（containing block 且有绝对子项），Border 的 `Padding`
   只保留 **border 宽**，不消费 CSS padding → Border 的内容区就是 **padding 盒**，CanvasPanel 落在这里；
2. 画布里的 **flow 组**用 `Offsets = canvasPad`（= 原来的 Border.Padding − border，即 CSS padding）
   把自己挪回内容盒，所以**流式子项的几何完全不变**；
3. 绝对子项的锚点/偏移沿用 CSS 原值，父尺寸按 padding 盒算（采样 `pos` 减 border、`parentSize` 减两侧 border）。

> 不要试图用**负槽 padding** 把画布「撑」出去：Slate 会把负 `FMargin` 夹掉，画布仍停在内容盒，
> 只有 flow 被推走（实测 `Cards` 264,106 → 288,124）。

该节点的槽保持 CSS 原值：

```json
{ "LayoutData": { "Anchors": { "Minimum": [0,1], "Maximum": [1,1] },
                  "Offsets": { "Left": 32, "Top": -80, "Right": 32, "Bottom": 56 },
                  "Alignment": [0,0] }, "bAutoSize": false }
```

换算：canvas = padding 盒 `[240, 0, 1680, 1080]` → 拉伸轴 `x = 240+32 = 272`、`w = 1680-32-32 = 1616`；
点锚轴 `y = 1080-80 = 1000`、`h = Offsets.Bottom = 56`。

边界：`position:static` 的元素不是 containing block（老路径不动）；父容器**没有 CSS padding** 时
`canvasPad = 0`、`Border.Padding` 仍是 border 宽，槽只按 border 修正 ±1px 级偏差 ——
`02-absolute` / `07-anchors` 逐字节相同，`03-dashboard` 有 3 个槽按 border 修正（`#horizon` 的
`left:8%` 从 0.84 变 0，即之前多算了 1px border）。
### 8.3 段落折行也不需要运行期控件

TextBlock 在 VerticalBox 的 Automatic 槽里 desired 阶段**拿不到宽度约束**，所以第一帧按 1 行算高
（实测 `.zh` 1 行、卡片 98px）。这曾经是 `H2UTextWrapBox` 存在的理由——**已删除**，因为
`STextBlock::OnPaint` 自己写了：

> "Due to the nature of wrapping and layout, we may have been arranged in a different box than what
> we were cached with. Which might update wrapping…"

它在绘制时按**真实 allotted 宽度**重排，desired size 变了就 `Invalidate(EInvalidateWidgetReason::Layout)`，
第二帧父级重新问一次就成了：

| 组（同一段 79 汉字，SizeBox 固定 432 宽） | 第 1 帧 | 第 2 帧 |
|---|---|---|
| `AutoWrapText`，不给 `WrapTextAt` | 17px（1 行，被裁） | **51px（3 行）** |
| `WrapTextAt=432`（exact 模式的做法） | 51px | 51px |

所以 responsive 模式下**什么都不用发**：不写 `WrapTextAt`（避免冻结设计宽度），只保留
`AutoWrapText=true`，第二帧就按真实宽度折行。这也让"临界段落"（设计宽度下 1 行、1280 下会折行）
自动被覆盖——之前那个"行数 ≥ 2 才包"的判据连同缺口一起消失了。

> 代价只有一个：**首帧**（_第一帧_）文本可能仍按 1 行布局。游戏里一帧不可见；但如果要在
> "widget 还没 tick 过"时截图验收，要么跑两帧（`Html2UMG.RenderFrames`），要么走 exact 模式
> （烘焙 `WrapTextAt`，首帧即正确，代价是换分辨率不重排）。

