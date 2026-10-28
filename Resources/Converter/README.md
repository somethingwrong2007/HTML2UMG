# Html2UMG — Node 转换器

`design.html` ──▶ **本目录（Node + 本机 Chromium/CDP）** ──▶ `design.json` ──▶ C++ 编辑器模块 ──▶ `WBP_Asset`

契约唯一真源：`Docs/Html2UMG_LayoutContract.md`（contract v1）。
本目录只输出契约里的字段，**不发明新语义**；新增均为可选字段，列在「契约扩展点」一节。

* 零依赖：不装 npm 包，不用 `node_modules`，不需要 `package.json`。
* 只要求 Node ≥ 22（用到内置 `fetch` 与全局 `WebSocket`；本机实测 v24.15.0）。
* 浏览器只用本机已装的 Chromium 内核浏览器（Edge / Chrome / Brave / Vivaldi），`--headless=new` 启动，临时 profile，跑完删除。

---

## 1. 用法

```bat
:: 单个页面
node Plugins/Html2UMG/Resources/Converter/cli/convert.js design.html -o design.json --viewport 1920x1080

:: 带保真度对拍截图 + 调试快照
node cli/convert.js test/03-dashboard.html -o out/03.json --shot out/03.png --dump-snapshot out/03.snap.json

:: CI：有 warning 即失败
node cli/convert.js test/01-flex.html -o out/01.json --strict
```

| 参数 | 说明 |
|---|---|
| `--viewport WxH` | 设计视口，默认 `1920x1080`。测量与 px 换算都基于它。 |
| `--probe WxH,WxH` | 额外视口，用于**推断 anchors**。默认自动加 0.75×/1.25× 两个视口；`--probe none` 关闭。 |
| `--browser <exe>` | 指定浏览器，优先于 `HTML2UMG_BROWSER` 环境变量。 |
| `--assets <dir>` | 资产目录名，相对 json 所在目录，默认 `assets`。 |
| `--shot <png>` | 同时输出浏览器截图（与 UMG 渲图对拍用）。 |
| `--blueprint <path>` | 覆盖 `data-ue-blueprint` / 默认 `/Game/UI/WBP_<Name>`。 |
| `--scale-box fit\|fill\|fitx\|fity` | 根节点外包 `ScaleBox`（固定设计尺寸的整体缩放）。 |
| `--strict` | 有任何 warning 就 `exit 2`。 |
| `-q, --quiet` | 只在 stdout 打一行摘要。 |
| `--dump-snapshot <f>` | 落盘原始 DOM snapshot（主视口 + probes）。 |
| `--keep-profile` | 保留临时浏览器 profile（排查用）。 |
| `--timeout <ms>` | 单步超时，默认 30000。 |
| `--bake` / `--no-bake` | 把原生控件的像素（下拉箭头、勾选框的勾、滑杆 thumb、进度条填充）切成贴图。**默认开**。 |
| `--bake-scale <n>` | 烘焙贴图的光栅化倍率，默认 2，上限 4。 |
| `--bake-max <px>` | 单张贴图最大边，默认 2048；超出自动降倍率并 warn。 |

退出码：`0` 成功 / `1` 失败 / `2` `--strict` 且产生了 warning。
**json 是唯一产物文件**，stdout 只有人类可读摘要。

浏览器探测顺序：`--browser` → `HTML2UMG_BROWSER` → Edge → Chrome → Brave → Vivaldi；都找不到时报错并列出查找过的路径（不会静默失败）。

---

## 2. 流水线

```
src/args.js      参数解析 / 视口解析 / 自动 probe
src/browser.js   启动 Edge（--remote-debugging-port=0），读 DevToolsActivePort，拿 page target；退出时 taskkill /T /F
src/cdp.js       零依赖 CDP 客户端（id→Promise 请求表 + 事件等待 + 页面动词）
src/snapshot.js  注入稳定性样式 → fonts.ready → 双 rAF → reflow → 一次 Runtime.evaluate 抓整棵 DOM
src/mapper.js    snapshot → 契约节点树（本目录的核心）
src/values.js    CSS 值 → 契约值类型（色彩 sRGB→linear、px、圆角、grid track…）
src/names.js     命名与全局去重（与 C++ SanitizeWidgetName 的约束一致）
src/assets.js    贴图/字体抽取，写 assets/ 并生成 assets 块
cli/convert.js   编排 + 输出 + 退出码
```

**为什么只用一次 `Runtime.evaluate`**：每个元素一次往返在 1000 节点页面上是分钟级；整棵树在一个 IIFE 里遍历完，只付一次 IPC。

**为什么要 probe**：单视口无法区分 `left:24px` 与 `right:24px`。

### 锚点由 CSS 边缘约束决定（不是位置比例）

按 `SConstraintCanvas` 的语义，一条轴只可能是三种形态之一：

| CSS | 锚点 | Offsets |
|---|---|---|
| `left` + `right` 都声明且宽度 auto | **拉伸** `Min=0, Max=1`（`%` 时按比例） | `Left=left`、`Right=right`（正的右边距） |
| 只有 `left`（px） | 点锚点 `Min=Max=0` | `Left=left`，`Right=宽度` |
| 只有 `right`（px） | 点锚点 `Min=Max=1` | `Left=-(right+宽度)`，`Right=宽度` |
| 只有 `left:25%` / `bottom:60px` | 比例锚点 `Min=Max=0.25` / `Min=Max=1` | 由实测位置反推 |
| `width:50%`（百分比尺寸） | **按比例拉伸** `Min=0.25, Max=0.75` | 0（否则换分辨率不跟随） |
| `max-width` 与 `width:100%` 同时存在 | 以 `max-width` 当固定尺寸 | 点锚点 + 宽度 |
| 无 inset 但居中（`translate(-50%)` / 实测居中） | `Min=Max=0.5` | `Left=-宽度/2` |
| 以上都没有（流式子节点） | 回退到多视口比例推断 | |

**把 px 约束换算成比例是错的**：设计分辨率下数值恰好对，换分辨率就漂。

> 包含块：绝对定位元素的坐标系是"最近的 positioned 祖先"，没有则是**视口**（ICB）。
> 页头把 `html,body` 固定成 1920×1080 时，`right:60px` 在 1280 下仍按视口解析——
> 校验这类节点时父盒也必须用视口，不能用 body 的固定矩形。

`line-height` 有两种含义不能混：单行且 `line-height ≥ 元素高度×0.9` 是"垂直居中"（转成槽的
`VerticalAlignment: Center`，父级已是 flex `align-items:center` 时不重复加）；否则是行距
（转成 `TextBlock.LineHeightPercentage`）。

---

## 3. DOM → UMG 映射（已实现部分）

| CSS / 标签 | UMG | 说明 |
|---|---|---|
| `display:flex` + `row` / `column` | `HorizontalBox` / `VerticalBox` | `flex-wrap:wrap` → `WrapBox` |
| `display:grid` | `UniformGridPanel` / `GridPanel` | 计算后各轨道等宽 → Uniform；否则 Grid + `ColumnFill` |
| 块级容器有块级子节点 | `VerticalBox` | 纯文本/行内子树合并成一个 `TextBlock` |
| `position:absolute/fixed` | 父级 `CanvasPanel` + `CanvasPanelSlot` | anchors/offsets 由 probe 推断 |
| 同时有流式子节点 + 绝对定位子节点 | `CanvasPanel` ▸ [`<Name>_Flow` 流式容器, 绝对定位子节点…] | 两者共存，流式布局不丢 |
| `overflow:auto/scroll` | `ScrollBox` | 外层 Border 仍在外面，滚动区在内部 |
| 纯文本 / 行内 run | `TextBlock` | `<br>` → `\n`；`text-transform` 直接作用到文本 |
| `<img>` / `background-image:url()` | `Image` / Border brush | 贴图抽到 `assets/`，`@tex_N` 引用 |
| 有背景/边框/圆角/内边距的容器 | `Border` | 视觉盒子；纯 padding 用 `drawAs:NoDrawType` |
| CSS 声明的 px 尺寸 | `SizeBox` 包一层 | 只有**声明**的尺寸才固定 |
| `<button>` | `Button`（内含 `TextBlock` 标签） | |
| `<input type=text/password/…>` | `EditableTextBox` | 字体写在 `WidgetStyle.TextStyle` |
| `<select>` | `ComboBoxString` | `DefaultOptions` 带静态项 |
| `<progress>` | `ProgressBar` | `Percent` |
| `<input type=checkbox/radio>` | `CheckBox` | radio 只能近似 |
| `<input type=range>` | `Slider` | `MinValue/MaxValue` |
| `<textarea>` | `EditableTextBox` | |
| 内联 `<svg>` / `.svg` 图 | `Image` + 4× 光栅化 PNG | CDP `Page.captureScreenshot` clip，16M 像素上限 |

### 尺寸语义（响应式的关键）

* **只有 CSS 声明的尺寸才固定**（`width/height/min/max-*` 的 px 值 → `SizeBox` + `bOverride_*`）。
  由父容器撑开的尺寸一律保持 `Automatic`/`Fill`。
* `box-sizing: content-box` 的声明尺寸会**加上自身 padding/border**，因为 UMG `SizeBox` 永远按 border-box 算。
* 槽位主轴的尺寸优先级：`flex-grow > 0` → `Fill/值`；否则主轴百分比 → `Fill/百分比`；否则 `Automatic`。
* ⚠️ **绝不能**输出 `{"SizeRule":"Fill","Value":0}`：Slate 在总拉伸系数为 0 时跳过分配，控件会塌成 0
  （`SlateCore/Public/Layout/LayoutUtils.h` 的 `ArrangeChildrenInStack`）。
* 主轴百分比 → `Fill/百分比`；**交叉轴百分比**（如竖排容器里的 `width:62%`）在 UMG 里没有对应能力，
  会按设计视口实测 px 固定并给出 `approximated:` warning——不会塌成 0，但也不再随宽度变化。
* `gap` 只落在**相邻**槽位上，且只落主轴：竖排 → 后一项 `Padding.Top`，横排 → 后一项 `Padding.Left`。
* `justify-content: space-*` 用实测间隙写进各槽 `Padding`（CSS 的 space 分布在 UMG 无等价物）。
* `align-items` / `align-self` / `justify-content` → 槽位 `HorizontalAlignment` / `VerticalAlignment`。

### 颜色 / brush

* 所有颜色输出**线性** RGBA（sRGB→linear，alpha 保持线性），与 `FLinearColor` 一致。
* `border-radius` → `brush.cornerRadii [TL,TR,BR,BL]`；有圆角用 `RoundedBox`，否则 `Box`。
* `border-*-width` → `brush.outlineWidth`（四边不等时取最大并 warning）+ `outlineColor`。
* `background-image` → `drawAs:"Image"` + `@tex_N`（`background-size:cover/contain` 近似为拉伸并 warning）。

### 命名

优先级 `data-ue-name` > `id` > `class` > `tag`；清洗为 `[A-Za-z0-9_]`，数字开头补 `W`，全局去重 `_1/_2`。

一个元素可能展开成 `SizeBox → Border → ScrollBox → 内容`。名字归属：

* 叶子控件（`TextBlock`/`Image`/`Button`/表单控件）→ **叶子**（`BindWidget` 要绑的就是它）；
* 容器 → **`Border`**（面板的视觉本体），没有 Border 时给 `ScrollBox`，再没有才给内容容器；
* 其余合成节点一律带**一个短角色后缀**且 `variable:false`：`<Name>_Box`（SizeBox）、`<Name>_Inner`（内容容器）、
  `<Name>_BG` / `<Name>_Pad`（背景/内边距 Border）、`<Name>_Blur`、`<Name>_Scroll`、`<Name>_Row`（百分比行）、
  `<Name>_Wrap`（文本换行盒）、`<Name>_Flow`（流组）。后缀只从**元素自己的基名**派生，不链式叠加
  （`Item_1Text`，不会出现 `Item_1_Inner_Text`）。

所以 `data-ue-name="StatusPanel"` 出现在 `div.hud` 上时，WBP 里有一个名为 `StatusPanel` 的 `Border`，
它的外层是 `StatusPanel_Box`、内层是 `StatusPanel_Inner`。

### 控制属性

| 属性 | 作用 |
|---|---|
| `data-ue-name` | 覆盖命名 |
| `data-ue-class` | 强制 UMG 类（该元素的子节点不再自动套槽位） |
| `data-ue-variable="false"` | 不生成蓝图变量 |
| `data-ue-blueprint` | 放在根元素上，覆盖目标资产路径 |
| `data-ue-font-map` | `Inter=/Game/UI/F_Inter;Segoe UI=…` 或 JSON `{"Inter":"/Game/UI/F_Inter"}`，向下继承 |
| `data-ue-ignore="true"` | 整个子树跳过 |
| `data-ue-control` | 把 div 自绘控件**提升为真 UMG 控件**：`combobox` / `checkbox` / `slider` / `progress` / `textbox` / `button`（别名 `select`/`dropdown`/`range`/`bar`/`input`/`btn`）。子元素不再建控件 |
| `data-ue-options` | 自绘下拉的选项，`选项1\|选项2\|…` |
| `data-ue-selected` | 选中项索引（0 起） |
| `data-ue-item-class` | 行样式选择器片段（如 `.combo-list .item`）。缺省时按"祖先类名以本控件类名开头"推断并 warn |
| `data-ue-row-height` | 行高（px）。ComboBoxString 无该属性，折算成对称的 `MenuRowPadding` |
| `data-ue-menu-max-height` | 仅记录：UMG 无对应属性，warn 提示在样式资产里设 |

### 复杂控件的样式翻译

设计稿里控件的外观来自 CSS 状态，而快照只能看到静态画面，所以状态样式是**从样式表规则重放**出来的：
把匹配到的声明写到一张离屏探针元素上再读回 computed 值（`background` 简写、`var(--x)`、继承都能正确解析）。
**只有作者真的写了该状态的规则才会记录**，否则回退到 `accent-color` / 引擎默认，不会凭空造一个"看起来一样"的状态。

| 控件 | 输出 |
|---|---|
| `<select>` / 自绘 combobox | `DefaultOptions`、`SelectedOption`、`ForegroundColor`、`WidgetStyle.ComboButtonStyle.ButtonStyle`{Normal, Hovered(=` :hover`), Pressed(=` :focus`), Disabled}、`WidgetStyle.ContentPadding`、`WidgetStyle.MenuRowPadding`、`MenuBorderBrush`（下拉面板）、`ItemStyle` |
| `ItemStyle` (FTableRowStyle) | **9 个键恒定齐全**：`InactiveBrush`（行底色，不含斑马纹）、`InactiveHoveredBrush`、`ActiveBrush`(`:checked`/`.selected`)、`ActiveHoveredBrush`、`SelectorFocusedBrush`（键盘焦点行，缺规则时回退 hover 色）、`EvenRowBackgroundBrush`/`OddRowBackgroundBrush`（无奇偶规则时回退行底色）、`TextColor`、`SelectedTextColor`。行底色回退链：行自身 → 列表容器 → 控件自身（容器只贡献颜色，不带边框/圆角） |
| `<input type=checkbox/radio>` | `CheckedState` + `WidgetStyle`{`UncheckedImage`,`UncheckedHoveredImage`,`CheckedImage`(=`accent-color` 或 `::before`),`CheckedHoveredImage`,`ForegroundColor`,`CheckedForeground`} |
| `<progress>` | `Percent` + `WidgetStyle`{`BackgroundImage`(轨道),`FillImage`} + `FillColorAndOpacity`(=`accent-color`；`FillImage` 置白避免二次着色) |
| `<input type=range>` | `MinValue`/`MaxValue`/`Value` + `SliderHandleColor`(=`accent-color`)+`SliderBarColor` + `WidgetStyle`{`NormalBarImage`,`HoveredBarImage`,`NormalThumbImage`,`BarThickness`} |
| `<input type=text>` / `<textarea>` | `WidgetStyle`{`BackgroundImageNormal`/`Hovered`/`Focused`/`ReadOnly`,`Padding`,`ForegroundColor`,`FocusedForegroundColor`,`TextStyle`{`Font`,`ColorAndOpacity`}} |
| `<button>` | **只**输出 `properties.WidgetStyle`{`Normal`,`Hovered`,`Pressed`,`Disabled`,`NormalPadding`,`PressedPadding`}，**不输出 `brush`** |

> **按钮不再有 `brush` 块**：单态 `brush` 会在写入四态 `WidgetStyle` 之后被应用，把 hover/pressed 压平。
> 设计里没写的状态用 Normal 的 brush 填充，避免露出引擎默认皮肤。

### 单边/多边边框

Slate 的 brush 只有**一圈** outline，四边不同的 CSS 边框必须折叠：

* 四边一致 → 直接 `outlineWidth` + `outlineColor`。
* 只有一边有边框（输入框常见的 `border-bottom`）→ 取该边宽度/颜色并 warn，同时给另外三边补同等 padding，内容不贴住新画出的轮廓。
* 四边宽度不同 → 取最大宽度 + 该边颜色，warn。
* `dashed/dotted/double/…` → 退化为实线并 warn。

全部进 `warnings`，不会静默丢弃。

### 行内流里的控件

文字合并遇到**替换元素 / 有绘制的 inline-block**（`input`/`select`/`progress`/`img`/`svg`/`button`/`data-ue-control`）会打断，
把控件提升为独立节点；容器因此失去"纯文本"资格，就按流向变成 `HorizontalBox`：
`<label><input type=checkbox> Caption</label>` → `HorizontalBox[CheckBox, TextBlock]`，而不是吞掉控件的单个 `TextBlock`。

> 已知取舍：`:hover` / `:checked` 按**设计意图**取值，忽略斑马纹 `:nth-child` 的遮蔽。
> 浏览器里 `option:nth-child(odd)` 与 `option:hover` 同优先级时后者会被源码顺序盖掉，
> 但"选中行没有 hover 反馈"显然不是设计意图，所以斑马纹单独进 even/odd brush。

> CSSOM 会把 `:nth-child(odd)` 规范化成 `:nth-child(2n+1)`，因此奇偶判断按 An+B 表达式解析。

---

## 4. 资产

* `<img src>`、`background-image:url()`：`data:` URI 直接解码落盘；`file:`/相对路径拷贝；`http(s)` 只做一次 8s 超时抓取，失败降级为 warning。
* 贴图命名 `tex_N.<ext>`（格式按内容嗅探，不信任扩展名），字体 `font_N.ttf`。
* 字体：优先用页面里的 `@font-face` 文件；否则查 Windows 系统字体表（Segoe UI / Arial / Consolas / Times New Roman / …）并**拷贝真实 TTF** 进 `assets/`。拿不到文件时仍登记 `{key,family,weight,italic,file:""}` 并 warning，同时**不**输出 `Font.FontObject`（避免 importer 去加载空路径）。
* `.ttc` 字体集合不拷贝（UE 不能直接导入），会 warning。

> 字体是从系统目录复制进项目的，**分发前请自行确认授权**。

---

## 5. 不支持项

全部降级为 `warnings`，绝不中断转换：`box-shadow`、渐变、`filter`、`backdrop-filter`、`transform`、
`mix-blend-mode`、`clip-path`、`mask-image`、`position:sticky`、`overflow:hidden` 裁剪、`::before/::after` 内容、
`text-decoration:underline`、`object-fit:cover/contain`、非均匀 border 宽度、交叉轴百分比、`direction:rtl`、
行内多样式合并、`<video>/<canvas>/<iframe>` 等。

同一 warning 文本只记一次；文本里带选择器（`div.card`）方便定位。

---

## 5.5 原生控件烘焙（`--bake`）

Slate 默认皮肤和浏览器画的原生控件差得远（下拉箭头、勾、thumb、填充）。烘焙把**真实像素**切下来：

```
隔离（注入 CSS / 强制伪类） → CDP clipped 截图 → 解码 → alpha 遮罩 → 编码 → assets/textures
```

| 控件 | 隔离手法 | 写到哪里 |
|---|---|---|
| `<select>` | `color:transparent !important`（否则选中文案烘进图、UMG 再画一次就重影）→ 截整个框（含箭头）；`CSS.forcePseudoState` 强制 hover/active，`disabled` 用属性 | `WidgetStyle.ComboButtonStyle.ButtonStyle.{Normal,Hovered,Pressed,Disabled}`，文字靠 `ForegroundColor` 单独画 |
| `<input type=checkbox/radio>` | 直接截控件；`el.checked=true/false` × `:hover` 交叉组合出四态 | `WidgetStyle.{UncheckedImage,UncheckedHoveredImage,CheckedImage,CheckedHoveredImage}`（+ pressed 回退到对应态） |
| `<input type=range>` | 轨道：`::-webkit-slider-thumb{opacity:0}` 截整框；thumb：value=min/max 两次截图与"无 thumb 轨道"做像素差，包围盒即 thumb | `WidgetStyle.{Normal,Hovered,Disabled}BarImage` / `…ThumbImage`，`BarThickness`=轨道高 |
| `<progress>` | 轨道：`::-webkit-progress-value{opacity:0}`；填充：`::-webkit-progress-bar{opacity:0}` 且 value=max，再与轨道做差只留填充像素 | `WidgetStyle.BackgroundImage` / `FillImage`（`FillColorAndOpacity` 置白避免二次着色） |

要点：

* **控件类型不变**：`ComboBoxString` 仍是 `ComboBoxString`（能弹、能键盘导航），`CheckBox` 能点，`Slider` 能拖。贴图只替换"画什么"。
* 每张烘焙 brush 都带 `imageSize`（设计 px）；thumb 的 `imageSize` 是 thumb 自己的尺寸，不是整条轨道。
* 圆角控件按 `border-radius` 生成 alpha 遮罩；进度填充与轨道做差取 alpha；圆形 thumb 用圆形遮罩。
* **任何隔离/解码/裁剪失败都降级到矢量近似并 warn**，不静默：
  `bake: could not isolate the slider thumb on 'input#gain'; kept vector approximation`。
* 确定性：同一页面两次运行 JSON 与**所有 PNG 逐字节一致**。
* 管线是通用的（`src/bake.js`）：元素在快照阶段被打上 `data-h2u-idx`，烘焙时用 `DOM.querySelector` 换 nodeId 再 `CSS.forcePseudoState`；
  以后要烘焙普通 div 的 `box-shadow`/渐变可直接复用。

---

## 5.6 复用已导入的控件（契约 §10）

| 属性 | 语义 |
|---|---|
| `data-ue-widget="/Game/UI/WBP_Card"` | 该元素变成**一个** `WBP_Card` 实例节点（`class` 就是资产路径），**不展开子节点**；声明尺寸仍走 `SizeBox` |
| `data-ue-slot="Header"` | 子节点输出 `"namedSlot": "Header"`，**不带自己的 `slot`**（布局由被复用 WBP 决定） |
| `data-ue-inline` | 忽略复用，正常展开（某处要偏离共享组件时用） |
| `data-ue-partial="fragments/x.html"` | 转换期把该文件片段内联（相对 html 路径，`file://` fetch 生效）。失败 → warn + 空 div |
| `data-ue-component="card"` | 没有组件注册表，warn 后正常展开；要资产复用请用 `data-ue-widget` |

`data-ue-class` 写资产路径与 `data-ue-widget` 等价。
内联片段继承占位元素上的 `data-ue-*`（`data-ue-name` 依旧命名片段根节点）；
片段内的相对资源路径按**主页面**解析，跨目录片段请用绝对路径。

---

## 6. 契约扩展点（新增均为可选，不改既有语义）

| 位置 | 内容 | 理由 |
|---|---|---|
| `slot.bAutoSize` | `CanvasPanelSlot` 输出 `bAutoSize`（契约示例写的 `AutoSize`） | `UCanvasPanelSlot` 的 UPROPERTY 真名带 b 前缀，按反射名写入才能命中；importer 也可用 b 前缀回退双保险 |
| `SizeBox.properties.bOverride_*` | 与 `WidthOverride/HeightOverride/Min|MaxDesired*` 成对输出 | `USizeBox` 的数值全部被 `bOverride_*` 位域 gate，只写数值不生效 |
| `GridPanel.properties.ColumnFill` | `[1,1,2]`（`TArray<float>`） | star 列在 `GridPanel` 里靠它保持比例；需要 importer 支持「数字数组 → float 数组」 |
| `WrapBox.properties.InnerSlotPadding` | `[x,y]`（`FVector2D`） | 折叠 `gap` |
| `UniformGridPanel.properties.SlotPadding` | `[l,t,r,b]` | 折叠 `gap`（该槽位类没有 Padding） |
| `ScrollBox.properties.Orientation` | `Orient_Vertical` / `Orient_Horizontal` | |
| `EditableTextBox.properties.WidgetStyle.TextStyle` | 嵌套 struct | 输入框字体/颜色只能写在 style 里 |
| `node.variable:false` | 合成节点 | 不污染变量列表 |
| `TextBlock.properties.TextOverflowPolicy` | `Ellipsis` | `text-overflow:ellipsis` |
| `TextBlock.properties.LineHeightPercentage` | 150 | UE 5.1+ 属性，值 = line-height/font-size×100 |
| `node.class` = `/Game/UI/WBP_Card` | 实例复用节点（契约 §10） | 不是 UMG 类名而是资产路径；validator 按 `WBP-instance` 计数 |
| `node.namedSlot` | `"Header"` | 命名插槽内容节点；此类节点不带 `slot` |
| `assets.textures[]`（烘焙） | `tex_N.png` 由 `--bake` 生成 | 与普通贴图同一套 `{key,file}` 结构，brush 里 `imageSize` 给设计尺寸 |

---

## 7. 自测

**先转换（需要浏览器），再校验。** `validate.js` 只校验已存在的 json，它自己不产出 json——
直接 `node test/validate.js test/03-dashboard.json` 会报"文件不存在"，因为该文件还没生成。

```bat
cd Plugins/Html2UMG/Resources/Converter

:: 1) 转换四个基线页面（输出放 test/out，建议 gitignore：里面有几十 KB json + 拷贝出来的 TTF）
node cli/convert.js test/01-flex.html      -o test/out/01-flex.json      --shot test/out/01-flex.png
node cli/convert.js test/02-absolute.html  -o test/out/02-absolute.json  --shot test/out/02-absolute.png
node cli/convert.js test/03-dashboard.html -o test/out/03-dashboard.json --shot test/out/03-dashboard.png
node cli/convert.js test/04-form.html      -o test/out/04-form.json      --shot test/out/04-form.png

:: 2) 校验（传目录 = 校验目录里所有 *.json；也可以传单个文件，支持多个）
node test/validate.js test/out
node test/validate.js test/out/03-dashboard.json
```

`validate.js` 会检查：`contractVersion`、必备字段、`name` 唯一且合法、`class` 属于已知 UMG 类、
所有数值有限、**slot 的键必须是「父容器对应的 Slot 类」真有的属性**、枚举合法、颜色在 [0,1]、
`assets` 键唯一且文件存在、`@tex_/font_` 引用可解析、`Fill` 槽位权重必须 > 0、单子控件容器不超 1 个子节点。

正常输出（四个页面全 PASS，0 warning）：

```
ok   test/out/01-flex.json  56 widgets
ok   test/out/02-absolute.json  29 widgets
ok   test/out/03-dashboard.json  108 widgets
ok   test/out/04-form.json  58 widgets

4 file(s): 4 passed, 0 failed, 0 warning(s)
```

可复现性：同一输入两次运行产物**逐字节相同**（不写时间戳，所有排序稳定；`source` 只取输入路径）。

---

## 8. 已知缺口

1. **交叉轴百分比**只能固定 px（见上文）；`width:62%` 的进度条填充在 1920 宽下正确，换分辨率不跟随。
2. 行内多样式（同段落里不同颜色/字重）合并成一个 `TextBlock`，只会 warning，不会变成 `RichTextBlock`。
3. 渐变 / 阴影 / 裁剪 / 3D 变换不烘焙成贴图（只 warning），需要保真时请在 HTML 里改用位图。
4. `justify-content: space-*` 用实测间隙固定，不随父容器尺寸变化。
5. 字体不做子集化，也不做 weight→typeface 的测绘；`TypefaceFontName` 按 400/600 阈值给 Regular/Bold(+Italic)。
6. 没有 `<table>` 专门映射（按 block 流处理）。
7. SVG 光栅化用元素截图，因此 SVG 里的动画/字体依赖浏览器当时状态。
