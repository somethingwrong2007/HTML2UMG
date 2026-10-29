# HTML2UMG

> 中文版。English: [README.md](README.md)

把 HTML/CSS 设计稿转成原生 UMG 控件蓝图。运行时不需要浏览器，产物是普通的 Widget Blueprint，
可以在 UMG Designer 里继续改，也可以用 `BindWidget` 绑定到 C++ 或蓝图。

```
design.html  --[Node + 本机 Chromium]-->  design.json  --[UE 编辑器模块]-->  WBP_Asset
             转换期依赖                 可 diff 的中间产物            运行期零依赖
```

一次性完整重导会覆盖手工在 Designer 里做的**布局**改动。要改布局请改 HTML 或直接改 JSON，蓝图图表里的逻辑不受影响。

更详细的文档都在 `Docs/` 下：

- `Html2UMG_Approach.md` —— 为什么选这条路线，和其他方案比
- `Html2UMG_LayoutContract.md` —— JSON 契约的完整定义，手写或改 JSON 时看它
- `Html2UMG_ResponsiveContract.md` —— 想被连续响应式还原，HTML/CSS 该怎么写
- `Html2UMG_RelativeSize.md` —— 分段函数（`min(px, %)`、`clamp()`）怎么降维成运行期约束
- `Html2UMG_Anchoring.md` —— UMG 的位置语义机制矩阵（锚点 / Overlay / SizeBox / ScaleBox 各自能表达什么）
- `Html2UMG_FontMetrics.md` —— 字体度量、行高换算与中文排版

## 环境要求

- 引擎：Unreal Engine 5.8
- 编辑器平台：Windows
- 产物平台：任何 UMG 支持的平台
- 只有"HTML 转 JSON"这一步需要 Node.js 22+ 和本机任意 Chromium 内核浏览器（Edge / Chrome / Brave / Vivaldi）。
  导入一个已经存在的 `.json` 完全不需要 Node 和浏览器。

## 安装

1. 把插件放到工程的 `Plugins/Html2UMG/`，在 `.uproject` 的 Plugins 列表里启用。
2. 编译：

```bat
"<引擎路径>\Engine\Build\BatchFiles\Build.bat" <Project>Editor Win64 Development \
    -Project="<工程>.uproject" -WaitMutex
```

3. 编辑器里确认 Edit > Plugins > Editor 下的 "HTML to UMG" 已启用。

入口在 Tools > HTML to UMG，也可以用控制台命令 `Html2UMG.Open`。

## 三种用法

### 1. 面板

Tools > HTML to UMG，选 `.html`，可改目标蓝图路径和视口，然后 Convert + Import。
选文件的瞬间就会先转换一遍，所以按下 Import 之前就能看到警告和字体清单，不会先污染工程。

### 2. 命令行：只转 JSON

```bat
node Plugins\Html2UMG\Resources\Converter\cli\convert.js design.html -o design.json ^
     --viewport 1920x1080 --probe 1440x1080,2560x1080 --shot design.png
```

| 选项 | 说明 |
|---|---|
| `-o, --out` | 输出路径，默认同名 `.json` |
| `--viewport WxH` | 测量视口，默认 1920x1080 |
| `--probe W1xH1,...` | 额外视口，用来推断 anchors |
| `--shot <png>` | 参考截图，用于保真度对拍 |
| `--blueprint <path>` | 覆盖 `data-ue-blueprint` |
| `--assets <dir>` | 贴图/字体输出目录，默认 `assets` |
| `--scale-box <fit\|fill\|fitx\|fity>` | 根节点外包一层 ScaleBox，整屏菜单常用 `fit`，HUD 不要用 |
| `--bake` / `--no-bake` | 是否把原生控件部件切成贴图，默认开 |
| `--bake-scale <n>` | 切图光栅化倍率，默认 2，上限 4 |
| `--browser <exe>` | 指定浏览器 |
| `--strict` | 有 warning 就 exit 2，CI 用 |
| `--dump-snapshot <file>` | 导出原始 DOM 快照，调试用 |

退出码：0 成功，1 失败，2 `--strict` 下有 warning。

### 3. 无头导入

```bat
UnrealEditor-Cmd.exe <工程>.uproject -run=Html2UMG ^
    -html="D:\design.html" -blueprint="/Game/UI/WBP_Screen" ^
    -out-png="D:\umg.png" -unattended -nosplash
```

或者用 Python：

```python
import unreal
opts = unreal.Html2UMGImportOptions()
opts.set_editor_property("blueprint_path", "/Game/UI/WBP_Screen")
opts.set_editor_property("import_fonts", True)
r = unreal.Html2UMGBlueprintLibrary.import_from_json(r"D:\design.json", opts)
print(r.success, r.widgets_created, r.properties_set)
```

UE 会剥掉 `b` 前缀，所以 `bSuccess` 在 Python 里是 `success`。

## HTML 能写成什么样

转换器读的是 computed style，不看 class 名，所以 Tailwind、shadcn、随便什么来源的 HTML 都能直接喂进去，
不需要按某种模板规范来写。

### 控件映射

| HTML | UMG |
|---|---|
| `<div>` / 布局容器 | `VerticalBox` / `HorizontalBox` / `WrapBox` / `CanvasPanel` / `GridPanel` |
| 文本 | `TextBlock` |
| `<img>` / `background-image` | `Border` 或 `Image` + 导入的贴图 |
| `<button>` | `UButton`（含 hover / pressed / disabled 三态） |
| `<input type=text>` | `EditableTextBox` |
| `<input type=number>` | **`SpinBox`**：`min`/`max`/`step`/`value` 直接映射到 `MinValue`/`MaxValue`/`Delta`/`Value`，小数位按值推断（整数不显示 `45.0`）。箭头是 `FSpinBoxStyle.ArrowsImage`，由引擎默认样式提供——浏览器的 spinner 是 UA 绘制的、只在 hover 出现，没有东西需要烘焙 |
| `<textarea>` | 多行 `EditableTextBox` |
| `<select>` | `ComboBoxString`（含选项） |
| `<input type=checkbox>` | `CheckBox`（含勾选态） |
| `<input type=range>` | `Slider`（min/max/value） |
| `<progress>` | `ProgressBar` |
| 绝对定位元素 | 放在 `CanvasPanel` 上，带 anchors 和 offsets |

原生 `<select>` 能接受的样式很有限，所以真实设计里的下拉框基本是 div 自绘的。这种用
`data-ue-control="combobox"` 就能强制映射成真正的 `UComboBoxString`。

**"步进器"和 SpinBox 是两件事**，别混：`<input type=number>` 是浏览器自带 spinner 的输入框 → `SpinBox`
（箭头由引擎样式画）；而设计稿里那种「`−` 数值 `＋`」的步进器是**两个按钮 + 一个文本**，转换出来就是
`Button` + `TextBlock`，符号是**文字**（`−` U+2212 / `＋` U+FF0B），跟着字体走，不需要额外图标资产。
`test/18-inputs.html` 把三种情况放在一页里做对照。
### 复用已经导入的组件

三种手段，从省事到精确：

| 手段 | 写法 | 产物 |
|---|---|---|
| **注册表**（推荐） | `--components test/components.json`，页面里写着 `.slotcard` | 自动变成 `WBP_SlotCard` 实例 |
| 显式实例 | `data-ue-widget="/Game/.../WBP_SlotCard"` | 同上，单点覆盖注册表 |
| 片段内联 | `data-ue-partial="fragments/x.html"` | 独立子树（生成期复用） |

组件页用 `data-ue-named-slot="Body"` 声明插槽，消费页用 `data-ue-slot="Body"` 往里塞内容。
注册表匹配、插槽填装、命名冲突处理的细节见 `Docs/Html2UMG_LayoutContract.md` 第 10 节。

验收页：`test/19a-slot-card.html`（组件，两个插槽）+ `test/19b-component-registry.html`（消费页，两个实例各填不同内容）。


### 样式

不只是结构对，控件的样式结构体也会写进资产，比如 `ComboBoxString` 的
`WidgetStyle.ComboButtonStyle`、`ItemStyle` 各态画刷，`CheckBox` 的 `UncheckedImage` /
`CheckedImage`，`Slider` 的 `NormalBarImage` / `NormalThumbImage` / `BarThickness`，
`ProgressBar` 的 `FillImage` 等等。

按钮的四个状态是从页面里的 `:hover` / `:active` / `:disabled` 规则读出来的，
所以 HTML 里怎么写，导入后悬停按下就怎么变。点击行为不导入，写在蓝图里。

### data-* 属性

| 属性 | 作用 |
|---|---|
| `data-ue-name` | 生成的控件名，`BindWidget` 靠它匹配 |
| `data-ue-class` | 强制该元素使用某个 UMG 类 |
| `data-ue-variable="false"` | 不生成蓝图变量 |
| `data-ue-blueprint` | 写在根元素上，覆盖目标资产路径 |
| `data-ue-font-map` | 写在根元素上，字体族到字体资产路径的映射 |

## 锚点与响应式

绝对定位元素的 anchors 由多视口 probe 推断，而不是把像素位置换算成比例。判定依据是 CSS 的边缘约束：
`left:312px; right:40px` 是横向拉伸，`left:25%` 才是比例锚点。把 px 约束换算成比例在
设计分辨率下数值刚好对，换设备就漂。

`SConstraintCanvas` 的公式（UE 5.8 `SConstraintCanvas.cpp`）值得记住，锚点算错基本都是没按它来：

```
点锚点：size = (Offsets.Right, Offsets.Bottom)
        pos  = anchorPx + Offsets.Left - size * Alignment
拉伸：  pos  = anchorPx.Min + Offsets.Left
        size = anchorPx.Max - pos - Offsets.Right     // 这里的 Right 是正的右边距
```

单视口分不清"左对齐"和"居中"，用 `--probe` 多给几个视口会明显更准。

## 页面切换：WidgetSwitcher，优先用 CommonUI 版本

标签页/多页界面在 HTML 里通常是"同一个位置放几张页面，只有一张可见"。给容器加
`data-ue-switcher`，它的**子元素就是页面**：

```html
<div class="viewer" data-ue-switcher data-ue-name="Viewer">
  <div class="on" data-ue-name="ViewerA">视图 A</div>
  <div data-ue-name="ViewerB">视图 B</div>
  <div data-ue-name="ViewerC">视图 C</div>
</div>
```

- 隐藏的页面（`display:none`）**也会被测量**：截快照时把它们临时按内边距盒摊开、量完立刻还原，
  所以它们在 UMG 里是完整的、有真实布局的页面，而不是空壳；
- `ActiveWidgetIndex` 取浏览器当时**可见**的那一页的下标；
- 输出的类名是语义化的 `PageSwitcher`，**由导入器决定用哪个引擎类**——JSON 因此不绑定具体项目：

| 项目情况 | 解析成 |
|---|---|
| 启用了 CommonUI 插件（`CommonUIConfig` / `CommonUI`） | `/Script/CommonUI.CommonAnimatedSwitcher`（自带页面切换过渡） |
| 没启用 | `/Script/UMG.WidgetSwitcher`（回退） |

导入日志会打一行说明用了哪个（`PageSwitcher: CommonUI is not enabled, using the stock WidgetSwitcher...`）。
两个类都是 `UWidgetSwitcher` 家族，槽位语义一致（`bExplicitWrapSize` 那类差异不存在），所以
布局不用为"有没有 CommonUI"分叉。

## 动画：不转换，但会明确告诉你丢了什么

CSS 的 `transition` / `@keyframes` 不在转换范围内。原因不是懒：UMG 的运动是
`UWidgetAnimation`（一个 Sequencer 资产）+ 蓝图图表驱动的，而 CSS 里真正有意思的部分是
hover/focus/press 这类**事件驱动的状态过渡**——静态转换器没有地方放那张图。真要生成，只能覆盖
"入场/循环关键帧"这一小撮，还得给每个控件建 track 与绑定，收益远小于复杂度。

所以做法是**如实报告**：转换时会打一条

```
approximated: CSS motion is not converted - 2 rule(s) with transition (.tab, .btn); @keyframes spin. ...
```

读的是**作者写的规则**而不是计算后的样式——快照前有一张 `* { transition: none !important }` 的
稳定化样式表（否则截图不确定），计算值里永远看不到它们。

页面切换的过渡是个免费的例外：CommonUI 的 `CommonAnimatedSwitcher` 自带切页动画。

## 自动命名

优先级：`data-ue-name` > `#id` > `class` > `tag`，转成 PascalCase、全局唯一、保证合法。

一个元素可能会被拆成几个控件（`SizeBox` 定尺寸、`Border` 画背景、容器放内容），**主节点拿干净的名字**
（`SettingsPanel`），其余按角色加**短后缀**：`_Box`（尺寸盒）、`_Inner`（内容容器）、`_BG`（背景）、
`_Blur`、`_Row`、`_Wrap`。后缀只有一个词，而且**从元素自己的名字派生**，不会层层叠加：

```
好：SettingsPanel / SettingsPanel_Box / SettingsPanel_Inner
坏：SettingsPanel_Size_PctWrap_Content_Text   （旧版本会这样）
```

需要绑定的控件建议直接写 `data-ue-name`：那是 `BindWidget` 的匹配键，改名等于改契约。

**要把设计重导入到已有图表的蓝图里**（事件和变量已经绑好），加 `data-ue-name-verbatim`
或整页传 `--name-verbatim`，名字就逐字保留（含下划线）：

```html
<div data-ue-name="Button_Left" data-ue-name-verbatim>…</div>
```

这样 `BndEvt__..._Button_Left_K2Node_ComponentBoundEvent_3` 和变量 `TextBlock_Switch` 才连得上；
不加则仍是 PascalCase（`ButtonLeft`）。verbatim 重名会打 **error 级警告**（第二个被改成
`Button_Left_1`，那同样会断绑定，所以必须显眼）。验收页 `test/20-verbatim-names.html`。

## 响应式：一份 WBP 适配多种尺寸

UMG 没有 flexbox，所以"和浏览器一致"要分两种情况说，转换器也分成两种模式：

| 模式 | 适用稿子 | 行为 |
|---|---|---|
| `--layout=exact`（默认） | 定宽稿（`html,body` 写死宽高、全 px） | 按设计尺寸烘焙。换分辨率时**与浏览器一致**，因为浏览器自己也不重排（1280 视口下它同样只是裁切） |
| `--layout=responsive` | 流式稿（`%`、`flex`、`min/max-width`、双侧 `inset`） | 输出**运行期可解**的约束，换分辨率时真的重排 |

判断该用哪种不用猜：转换结束会打印一行 `design: fluid (118/144 boxes rescale with the viewport)`，
同时写进 JSON 的 `settings.design`。`rigid` 的稿子别开 responsive，`fluid` 的稿子别用 exact
（实测：定宽稿开 responsive 会从 1.4% 恶化到 16%；流体稿用 exact 在 1280 下会从 2.7% 恶化到 34%）。

### 换成什么

| CSS | UMG |
|---|---|
| 固定 px | SizeBox + 边锚 |
| `width/height: %` | Box 槽 Fill 权重，或 `[spacer][child][spacer]` 三格（列容器的交叉轴百分比） |
| `flex: 1` | Fill 权重 |
| `min/max-width` | SizeBox 的 Min/MaxDesired*（**只夹期望尺寸**，放在 Fill 槽里运行期不生效） |
| 双侧 `inset` | Canvas 槽拉伸锚（`Anchors.Minimum != Maximum`） |
| 单子项 `justify-content: center/end` | Overlay 槽（真居中，替代烘焙偏移） |
| `flex-wrap: wrap` | WrapBox（`InnerSlotPadding` 是唯一间距来源，槽位 padding 归零） |
| 折行文本 | `AutoWrapText`（原生，第二帧按真实宽度重排） |
| `min(1240px, 92vw)` / `clamp()` | `CanvasPanel`（比例锚）+ `ScaleBox(ScaleToFit, DownOnly)` + `SizeBox`（夹紧后的 px）三层嵌套，纯原生 |

`position: absolute` 的基准是**内边距盒**（CSS 规范），所以承载画布的容器会把
`Border.Padding` 让给流式子项，让 CanvasPanel 正好落在内边距盒上——之前画布落在内容盒里，
浮层会整体偏一个 padding（实测 12-responsive 的浮层偏了 24/96 px）。

### 运行时控件：只剩一个，而且只有混合单位尺寸才用得上

这里早期有三个 Runtime 控件，后来核对引擎源码 + 多帧实测，**删掉了两个**——原生 UMG 本来就能做，
只是晚一帧：

- `STextBlock::OnPaint` 自己写着："we may have been arranged in a different box than what we were
  cached with, which might update wrapping" —— 它在绘制时按真实 allotted 宽度重排文本，desired size
  变了就 `Invalidate(Layout)`；
- `SWrapBox::Tick` 在 `bUseAllottedSize`（= `bExplicitWrapSize` 为 false）时把 allotted 宽度写进
  `PreferredSize`，而这个属性声明为 `EInvalidateWidgetReason::Layout`，下一趟 prepass 就重算行数。

实测（同一段 79 个汉字，SizeBox 固定 432 宽）：

| 组 | 第 1 帧 | 第 2 帧 |
|---|---|---|
| `AutoWrapText`，不给 `WrapTextAt` | 17px（1 行，被裁） | **51px（3 行）** |
| `WrapTextAt=432` | 51px | 51px |

所以离线验收**必须跑两帧**（`Html2UMG.RenderFrames`，默认 2）。单帧截图会系统性地低估自动折行文本和
换行盒——"文本不换行、WrapBox 高度不跟着变"的结论就是这样误判出来的。

**现在插件里没有任何 Runtime 模块**（`Source/Html2UMGRuntime` 已整体删除，uplugin 里也没有 Runtime
条目）：转换出来的蓝图只用原生 UMG 控件，移除插件后照常工作。三个曾经的运行期控件全部消失了——

| 曾经的控件 | 为什么不需要 |
|---|---|
| `H2UTextWrapBox` | `STextBlock::OnPaint` 自己按 allotted 宽度重排并 `Invalidate(Layout)`，第二帧收敛 |
| `H2UWrapBox` | `SWrapBox::Tick` 把 allotted 宽写进 `PreferredSize`（`Layout` 失效），prepass 重算行数 |
| `H2URelativeBox` | 改用 **CanvasPanel(比例锚) → ScaleBox(DownOnly) → SizeBox(px) → 内容** 三层嵌套，外框宽度在设计尺寸、1280、2560 上都对 |


### 混合单位尺寸这一件事

`width: 92%; max-width: 1240px` 这种"百分比 + px 夹子"**单个** UMG 控件表达不了：百分比靠 Canvas
比例锚点（丢上限），px 夹子靠 `SizeBox.MaxDesiredWidth`（只夹"期望尺寸"，Fill 槽里被忽略）。实测：
92% 槽里塞一个 `MaxDesiredWidth=1240` 的 SizeBox，1920 下仍然是 **1766px**，夹子完全没生效。

**三层嵌套可以**（转换器自动生成，纯原生）：

```
CanvasPanel        锚点 0.04..0.96  ← 百分比
  ScaleBox         ScaleToFit + DownOnly ← 只缩不放
    SizeBox        WidthOverride=1240, HeightOverride=设计高 ← px 上限
      内容
```

外框宽度实测：**1920 → 1240、1280 → 1177.6、2560 → 1240**，三个视口全中。

代价要说清楚：低于夹子宽度时，内容是被**整体等比缩小**（1280 下 0.9497 倍），而浏览器是**按 1177.6
重新排版**（字号不变）。所以像素差在 1920 是 1.89%，1280 是 10.31%（同一稿的"逐字重排"版本是
1.48% / 3.22%）。这个差异只对文字密集、会因宽度改变换行的内容明显；被夹的如果是一张图或固定网格，
两者像素一样。

也可以**改设计**避开它：只用百分比（宽屏偏宽）或固定宽度居中（窄屏溢出）——很多游戏的内容列本来就是
固定宽度，混合单位尺寸是多余的。

### 实测（同一份 WBP，只换渲染分辨率；两帧口径）

| 稿子 | 模式 | 1920×1080 | 1280×720 |
|---|---|---|---|
| 流体稿（14-fluid-skyline） | responsive，含 `min()`，**零 runtime 依赖（现行）** | **1.89%** | **10.31%** |
| 流体稿 | 旧版 `H2URelativeBox`（已删除，作参照） | 1.48% | 3.22% |
| 流体稿 | 旧版"固定+居中"降级（作参照） | 1.48% | 10.08% |
| 定宽稿 | exact | 1.45% | 2.42% |
| 长文档型页（12-responsive） | responsive，纯原生 | 6.35% | 11.33%（见下） |

流体稿那一行值得单看：面板 `width: 92%; max-width: 1240px`，在 1920 下渲染成
`x=340 / w=1240`、在 1280 下自动变成 `x=51.2 / w=1177.6`，与浏览器逐值一致——
**一次烘焙，两种分辨率都对**。

12-responsive 的 1280 那个数不是布局问题：该页内容在 1280 下高约 1000px，超出 720 视口，浏览器
只截可见部分，而 WBP 不会自己滚动。几何本身是逐值对的（`Cards` 992×616、`Zh` 430×66、
`OverlayBar` 272/640/976/56）。要看这个页的真实保真度，得用 1920（6.35%）。

### 写法约定

想吃到 responsive 的收益，HTML 那边有些写法上的讲究（`%"/`flex`/`min-max`、文本容器要有确定宽度、
用双侧 `inset` 表达拉伸、别把 `body` 写死 px），完整清单见
`Docs/Html2UMG_ResponsiveContract.md`。仓库里的 `test/14-fluid-skyline.html` 是一份真实定宽稿的
流式改写：**只改 CSS、DOM 一个没动**，1920×1080 下逐元素差异为 0，1280 下面板自动收窄且不再裁切。

### 这一块的已知限制

- **两帧收敛**：折行文本与 WrapBox 的行数/高度在第二帧才正确（引擎自身行为，见上）。运行时无感，
  但**单帧截图验收会看到偏矮**——用 `Html2UMG.RenderFrames`（默认 2）。
- **混合单位尺寸**：`min()/max()/clamp()` 里"百分比 + px"这一组合原生表达不了（见上）。
- **半连续场景**：flex **行主轴**上的"百分比 + 夹子"（Fill 份额不等于父宽，再乘百分比会变成 41% of 41%）、
  `vw/vh` 基准是视口而控件乘的是父分配、内容盒与 border 盒的 padding 差——这几类只做近似并向日志给出警告。
- **长页不滚动**：内容高于视口时，浏览器只截可见区域，WBP 会继续往下画（需要自己包 `ScrollBox`，
  或用 `--pin-flow` 钉高度）。

## 原生控件切图

`<select>` 的箭头、勾选框的勾、滑杆的 thumb、进度条的填充，在浏览器里是操作系统主题画的。
Slate 的默认样式长得很不一样，所以这些部件默认会从浏览器里切下来当贴图（`--bake`）：

浏览器里把目标部件隔离（隐藏其他部分、强制伪状态）后截图，按 `border-radius` 做圆角遮罩，
写入 brush 的 `ResourceObject`，同时把控件自身的样式前景色设成白色——贴图里已经带了颜色，
再乘一次就会发黑。

切图用的是元素自身的设计尺寸，所以按钮、勾选框、下拉框在 UMG 里和在浏览器里看着一样，
而不是"Slate 默认外观 + 一个颜色"。

## 效果：渐变、模糊、阴影

Slate 的画刷只能是一个颜色或一张图，没有渐变、没有背景模糊，所以这几类效果按"结果能否光栅化"处理：

- **渐变**（`linear/radial/conic-gradient`）烘成贴图，连带圆角和边框一起，直接作为一个 Image 画刷。
- **`backdrop-filter: blur(N)`** 映射到 UMG 原生的 `BackgroundBlur` 控件，`BlurStrength = N`。
  它是运行期效果，离屏渲染看不到，这点在截图对拍时要注意。
- **`box-shadow`** 外阴影烘成贴图：截图范围按 `blur + spread` 外扩，盒子跟着放大，
  槽位用负内边距把多出来的占位抵消掉，所以元素在流里的位置不变。合成贴图里包含元素背后的背景像素，
  背后是静态背景时完全正确，压在动态内容上会有痕迹。内阴影（`inset`）不支持。

不支持的还有 `clip-path`、`mask-image`、`filter`、`mix-blend-mode`，转换时会逐个给出警告。

### 圆角与描边

这一块 Slate 的表达力比 CSS 窄，所以按"能不能用一次 outline 说清楚"分三档处理：

**1. 均匀的边框（四边同宽同色、实线）** —— 直接用 brush 的 outline。
这里有个容易踩的坑：`FSlateBrush` 的 `OutlineSettings` **只有 rounded-box 着色器会消费**，
普通的 `DrawAs=Box`（9-slice）只画填充。所以"有边框但没有圆角"的元素原本一根线都画不出来
（实测 6px 边框渲染成完全没有边框，该色块 14.5% 的像素不对）。现在只要有边框就强制走 `RoundedBox`，
半径可以全为 0 —— 半径 0 的圆角矩形就是矩形，outline 才会被画出来。

**2. 四边不等宽 / 四色 / 非实线（dashed、dotted、double）** —— outline 表达不了。
非实线一律烘成贴图；四边不等的情况在"最大边不超过 400px"时也烘，超过则退回"取最宽边 + 内边距补偿"。
加大面积限制是必要的：一条 1920x52 的工具栏虽然面积不大，但截图会横跨整页，把别的页面从 0.57% 拖到 22%。

**3. 四角不同半径** —— `FSlateBrushOutlineSettings.CornerRadii` 本身是 FVector4，按 TL/TR/BR/BL 四个值，
所以 `border-radius: 30px 0 30px 0` 这种可以直接表达，不需要烘焙。

剩下的差异是**亚像素抗锯齿**：外沿 1px 的描边在 Slate 里是约 88% 混合，浏览器是实心，
所以 1px 边框类的色块会稳定剩 2~3%，肉眼看是一根稍暗的线。

`Resources/Converter/test/09-borders.html` 是这一块的专用用例（19 个色块：纯圆角、胶囊、
半径+细边框、半径+粗边框、单边、双色、四色、四角不同、虚线、双线、透明底、嵌套圆角）。
当前整页差异 **0.40%**，最差单个色块 2.8%（就是上面那根 1px 线）。

## 验证工具

转换过程可以量化，不必靠眼睛判断"像不像"。

```bat
:: 像素对拍：打印差异像素比和平均误差，并输出放大 4 倍的差异图和左右对照图
python Resources\Tools\pngdiff.py design.png umg.png --out out\ --max-diff 0.05

:: 样式审计：把资产里真实的属性值导出来，和 layout.json 逐项比
python Resources\Tools\style_audit.py out\layout.json dump.json

:: 锚点审计：按上面的公式算出各分辨率矩形，和浏览器实测矩形比
python Resources\Tools\anchor_check.py out\layout.json snap.json --tolerance 3

:: 逐元素定位误差：输出差异密度图和按 tag/id/class 排序的误差表，还能查强调色是否被画出来
python Resources\Tools\visual_audit.py browser.png umg.png --snapshot snap.json
```

`run_acceptance.py` 把"转换 → 导入 → 渲染 → 对拍"串成一条命令：

```bat
python Resources\Tools\run_acceptance.py --html design.html --blueprint /Game/UI/WBP_Screen
```

**验收渲染跑几帧很重要。** 离屏渲染默认跑两趟布局（`Html2UMG.RenderFrames`，默认 2）：
折行文本和 WrapBox 的行数/高度是引擎在**第二帧**才收敛的（见"运行时控件"一节），只跑一帧会
系统性地把自动折行的文本量成一行。想复现单帧行为：`Html2UMG.RenderFrames 1`；想验证收敛：
`Html2UMG.RenderFrames 3`，几何应与 2 帧逐值相同。

导出资产真实值的命令：

```bat
UnrealEditor.exe <工程>.uproject ^
  -ExecCmds="Html2UMG.DumpWidgets /Game/UI/WBP_Screen --json=C:/w/dump.json, QUIT_EDITOR" ^
  -unattended -nosplash -windowed
```

## 保真度

`Resources/Converter/test/` 下是几个覆盖不同场景的页面。差异像素是 1920x1080 下 UMG 渲染
和浏览器截图的比例，数字越低越好：

| 测试页 | 覆盖内容 | 差异像素 |
|---|---|---|
| `02-absolute.html` | 纯绝对定位，anchors 推断 | 0.38% |
| `08-effects.html` | 渐变、backdrop-filter、阴影 | 0.38% |
| `09-borders.html` | 圆角、描边、虚线、多色边框 | 0.40% |
| `07-anchors.html` | 点/横拉/竖拉/四边拉/百分比/居中 | 0.43% |
| `04-form.html` | 完整表单 | 1.47% |
| `01-flex.html` | flex 行/列、gap、grow、wrap | 1.68% |
| `06-native.html` | 原生控件切图 | 1.99% |
| `05-controls.html` | 自绘下拉、勾选、滑杆、进度、输入框 | 2.55% |
| `03-dashboard.html` | 综合 HUD，层级较深 | 3.39% |

贴图文件名是**内容寻址**的（`tex_div_card_af5758db.png`：可读词干 + 内容哈希前 8 位），
所以多个页面共用一个 `--assets` 目录不会再互相覆盖，同一张图也只落一份。早期版本按位置命名
（`tex_0`、`tex_1`…），两个页面转进同一目录会静默覆盖、前一个页面的 JSON 指到后一个页面的像素——
那会凭空制造出「改坏了」的假象。

导入到工程里时，**一个页面一个文件夹**：

```
/Game/MenuSystem/Skyline/Components/
  WBP_RowSlider/
    WBP_RowSlider.uasset          蓝图本身
    assets/                       这一页的贴图
      tex_input_track_fb250cd6.uasset
      tex_input_thumb_b5f74fdc.uasset
/Game/Html2UMG/Fonts/             字体公共目录（同一字面被所有页面复用）
```

也就是说蓝图路径 `/Game/X/WBP_Foo` 会自动变成 `/Game/X/WBP_Foo/WBP_Foo`（可重复导入，
不会叠第二层）。删一页 = 删一个文件夹，页面不再用的旧贴图会在下次导入时自动清掉
（只在这个页面自己的 `assets/` 里动，判据是"本次布局没用到 + 零引用"）。

日志会写明落点：

```
[info] assets: 2 texture(s) -> /Game/MenuSystem/Skyline/Components/WBP_RowSlider/assets (fonts -> /Game/Html2UMG/Fonts)
```

清理工具（都在编辑器控制台）：

| 命令 | 作用 |
|---|---|
| `Html2UMG.PruneAssets /Game/Html2UMG` | 删掉该目录下**零引用**的资产（资产注册表判定，不会误删在用的） |
| `Html2UMG.DeleteAsset /Game/UI/WBP_Old` | 明确删除指定资产（清理重复导入留下的旧副本） |

剩下的误差主要来自文字（字形光栅化的差异）和少数几处细节，比如文本行盒在 CSS 和 Slate 里的定义不同、
`SBackgroundBlur` 在离屏渲染里不出效果。

## 对照真实设计发现的问题

除了 `Resources/Converter/test/` 的用例，还拿一份真实设计（1920x7081 的长文档，1358 个控件）做过对照，
它暴露的问题比用例更真实。

**grid 的两处错误**（这一份设计从 11.58% 降到 7.97% 主要靠它们）：

1. UMG 的 `GridPanel` 没有 gap。原来的做法是给每个单元格两侧各加半个 gap，
   看着对称，实际把**首列右推了 22px、并吃掉 44px 宽度**——一个 `148px` 的轨道被渲染成 83px，
   第二列因此提前 43px 开始。gap 只存在于轨道**之间**，所以现在加在每个单元格的尾边（最后一行/列不加）。
2. `GridPanel` 的列宽由最宽的单元格决定，所以 px 轨道会被内容压窄。现在按 `grid-template-columns`
   的 px 轨道把单元格宽度钉死（fr / auto 轨道仍然跟随内容）。钉完之后两列位置和浏览器完全一致：
   `390 / 148`、`582 / 948`。

**`overflow:hidden` 映射成 UMG 的 Clipping**（原来只是"不裁剪"加一条警告）。表格套在圆角面板里会溢出，
就是靠它解决的。

**自动尺寸元素的阴影**：原来要求元素有显式宽高才能为阴影预留空间，否则裁掉。现在用浏览器实测尺寸作为
兜底，于是"没有写死宽高的卡片"也能有完整阴影。

**`::before/::after` 仍然丢弃**（5 处），这类装饰需要一个独立控件，还没有做。

### 这类设计的剩余偏差分布

| 区域 | 差异 |
|---|---|
| 顶部头部区（0–1000px） | 8.8% / 14.5% |
| 正文表格区 | 3–8% |
| 页尾（6500px 之后） | 17.8% / 48.9% |

页尾偏差最大的原因是**累计高度**：UMG 内容比浏览器高约 660px（`Wrap` 7748 vs 7081），
越往下漂移越多，最后一屏直接错位。这些高度差来自表格单元格和小字号的文本行盒，逐行累计。

真实设计里仍然存在、按出现次数排序的缺口：

| 次数 | 缺口 |
|---|---|
| 22 | 宽元素上的单边边框（被折叠成四边，取最宽的一边） |
| 5 | `::before/::after` 装饰 |
| 4 | 横向百分比宽度（UMG 的 box slot 没有交叉轴权重） |
| 3 | `inset` 阴影 |
| 3 | 行内混排的小字号（`<b>` 之类）被合并成一个 TextBlock |

### 单边边框：宽元素现在也烘焙

「按下最宽的一边 + 内边距补偿」这条近似在**宽元素**上没有别的选择，但早期版本不敢烘焙宽元素，
因为一次实验里带文字的工具栏（1920x52）烘焙后文字整体错位 1px，测得更差。

后来发现当时错在**同时清零了内边距补偿**：烘焙出的贴图已经包含边框，内容应该退回 CSS 的
`padding + border` 位置，但补偿一清零，补偿本身也没了。保留补偿之后，同一个页面从 1.68% 降到 1.49%，
因此现在只要元素不透明、最长边不超过 `--bake-max`，宽元素也一并烘焙。

仍然不烘焙的是**背景透明**的元素（例如只有一条 `border-top` 的表行）：截图会把身后的内容一起拍进去，
这是之前把一页从 0.57% 拖到 22% 的原因。这类元素继续走「最宽一边 + 补偿」的近似。

### `--pin-flow`：把流式子项按实测高度钉死

长文档的问题是**累计高度**：每个块的高度由内容撑开，逐块差一点，到页尾就偏了几百像素
（这份设计 7081px 高，UMG 渲染出来高约 660px，最后一屏直接错位）。

`--pin-flow` 会把纵向流式容器里的每个子项按浏览器实测高度写进 `HeightOverride`。
效果是**两个方向**的，所以默认关闭：

| 页面 | 默认 | 加 `--pin-flow` |
|---|---|---|
| 真实设计（1920x7081 长文档） | 7.97% | **4.81%** |
| 01-flex | 1.49% | 0.89% |
| 06-native | 1.99% | 1.84% |
| 07-anchors | 0.43% | 0.31% |
| 04-form | 1.47% | 3.57% |
| 02-absolute | 0.38% | 1.57% |
| 03-dashboard | 3.05% | 8.10% |

也就是说：**文档型页面**（长滚动、少 flex 填充）明显受益；**应用型页面**（表单、仪表盘、依赖 flex 分配）
会受损，因为钉死高度会和填充分配打架。所以它是一个按页面类型选择的开关，不是默认行为。

## 已知限制

- 一个 `Border` 只有一圈描边，所以四边宽度不同的边框（比如只有底部 2px）只能取最宽的一边，
  其余用内边距补。转换时会给出警告。
- Slate 没有逐边边框，也���有 `border-image`。
- 文本的 `line-height` 通过 `LineHeightPercentage` 近似，两个引擎的行盒定义不同，需要按比例折算。
- 表格、原生滚动条标题栏等由操作系统绘制的部分不在映射范围内。
- `position: sticky` 按 static 处理。

## 排查

| 现象 | 原因 |
|---|---|
| `Node.js was not found` | 装 Node 22+，或设 `HTML2UMG_NODE` 指向 node.exe |
| `no Chromium found` | 用 `--browser` 指定 Edge/Chrome 路径 |
| `'X' is not a property of Y` | 手写 JSON 里写了该类没有的属性 |
| `'X' appears twice` | 控件名必须唯一，那是 `BindWidget` 的匹配键 |
| 某个 `BindWidget` 为空 | 给对应元素加 `data-ue-name`，名字接近时消息里会提示疑似拼写 |
| 导入失败但资产已存 | 资产是半成品，改完重新导入即可 |
| 重导后贴图没变 | 贴图按内容寻址，源文件变了名字就会变；如果没变说明没重新烘焙 |
| 切页只在第一页 | 容器没加 `data-ue-switcher`；或项目没启用 CommonUI 却期望切页动画（日志会说明回退到 `WidgetSwitcher`） |
| 隐藏页在 UMG 里是空的 | 该页不是 `data-ue-switcher` 的子元素，转换器没有理由去测量它 |
| 转出来的名字还是太长 | 那是旧版本产物；`data-ue-name` 会原样成为控件名，其余自动名只带一个角色后缀 |

## 目录结构

```
Plugins/Html2UMG/
  Html2UMG.uplugin
  Source/Html2UMG/          编辑器模块：导入、面板、控制台命令、离屏渲染
    Public|Private/
      Importer/     JSON 到 WidgetBlueprint：建树、反射写属性、贴图与字体导入
      Editor/       面板、控制台命令、蓝图/Python API、离屏渲染
      Html2UMGTypes 契约的 C++ 表示和解析
    Resources/
    Converter/      Node 转换器（零依赖，通过 CDP 驱动本机浏览器）
      src/          mapper（分类、槽位、画刷、网格）、bake（切图与效果）、assets（贴图/字体）、
                    fontmetrics（字体度量）、values（CSS 值解析）
      test/         01–19 测试页与 validate.js 契约校验
    Tools/          pngdiff / style_audit / anchor_check / visual_audit / run_acceptance /
                    font_metrics / residual_correct
```