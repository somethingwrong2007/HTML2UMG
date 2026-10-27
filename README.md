# HTML2UMG

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
- `Html2UMG_CJK_Acceptance.md` —— 中文字体回退与排版的验收记录

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
| `<textarea>` | 多行 `EditableTextBox` |
| `<select>` | `ComboBoxString`（含选项） |
| `<input type=checkbox>` | `CheckBox`（含勾选态） |
| `<input type=range>` | `Slider`（min/max/value） |
| `<progress>` | `ProgressBar` |
| 绝对定位元素 | 放在 `CanvasPanel` 上，带 anchors 和 offsets |

原生 `<select>` 能接受的样式很有限，所以真实设计里的下拉框基本是 div 自绘的。这种用
`data-ue-control="combobox"` 就能强制映射成真正的 `UComboBoxString`。

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
| 折行文本 | `H2UTextWrapBox` |
| `min(1240px, 92vw)` / `clamp()` | `H2URelativeBox`（百分比 + px 上下限，运行期算） |

`position: absolute` 的基准是**内边距盒**（CSS 规范），所以承载画布的容器会把
`Border.Padding` 让给流式子项，让 CanvasPanel 正好落在内边距盒上——之前画布落在内容盒里，
浮层会整体偏一个 padding（实测 12-responsive 的浮层偏了 24/96 px）。

### 三个运行时控件

插件现在有两个模块：编辑器模块 `Html2UMG`，以及一个只含三个控件的 **Runtime 模块 `Html2UMGRuntime`**
（`Type=Runtime`，只在 UI 真正需要时才被用到，不依赖编辑器模块）。

| 控件 | 解决什么 |
|---|---|
| `H2URelativeBox` | 百分比宽度 + px 上下限 + 对齐。因为 `USizeBox` 的 min/max 只夹"期望尺寸"，Fill 槽里运行期完全不生效 |
| `H2UTextWrapBox` | 让文本**随容器宽度重新折行**。Slate 的 `TextBlock` 在 VerticalBox 的 Automatic 槽里拿不到有界宽度，desired 会按一行算，arrange 再折行就被裁掉 |
| `H2UWrapBox` | 让 WrapBox 的**自身高度**按真实宽度算。`SWrapBox` 的换行宽度是 `WrapSize`（设计期常量），换分辨率后行数变了高度不会跟着变 |

三者都在 `OnArrangeChildren` 里用真实 allotted 宽度重算，并在高度变化时
`Invalidate(Previsit)` 请求重排；转换器会把设计期的容器宽度写进 `DesignWrapWidth` 作为首帧依据。

### 实测（同一份 WBP，只换渲染分辨率）

| 稿子 | 1920×1080 | 1440×1080 (4:3) | 1280×720 |
|---|---|---|---|
| 流体稿（流式改写版，responsive） | 1.21% | 1.62% | **2.72%** |
| 定宽稿（exact） | 1.45% | 1.76% | 2.42% |
| 对照：定宽稿用 responsive | 1.37% | 16.7% | 16.6% |

流体稿那一行值得单看：面板 `width: 92%; max-width: 1240px`，在 1920 下渲染成
`x=340 / w=1240`、在 1280 下自动变成 `x=51.2 / w=1177.6`，与浏览器逐值一致——
**一次烘焙，两种分辨率都对**。

### 写法约定

想吃到 responsive 的收益，HTML 那边有些写法上的讲究（`%"/`flex`/`min-max`、文本容器要有确定宽度、
用双侧 `inset` 表达拉伸、别把 `body` 写死 px），完整清单见
`Docs/Html2UMG_ResponsiveContract.md`。仓库里的 `test/14-fluid-skyline.html` 是一份真实定宽稿的
流式改写：**只改 CSS、DOM 一个没动**，1920×1080 下逐元素差异为 0，1280 下面板自动收窄且不再裁切。

### 这一块的已知限制

- **首帧高度滞后**：`WrapBox` 与折行文本在"实际宽度 ≠ 设计宽度"时，第一帧按设计宽报高度，
  第二帧收敛。这是 Slate 的结构决定的（子先算 desired、父在 arrange 时才给宽度，
  `STextBlock::AutoWrapText` 的注释里也写了至少晚一帧）。运行时无感，但**截首帧图验收会看到偏矮**。
- **设计期常量**：`WrapSize`/`DesignWrapWidth` 来自设计视口。要覆盖多个断点，需要按断点各烘一份
  （`--aspects`，尚未实现），或者接受第二帧收敛。
- **半连续场景**：flex **行主轴**上的"百分比 + 夹子"（Fill 份额不等于父宽，再乘百分比会变成 41% of 41%）、
  `vw/vh` 基准是视口而控件乘的是父分配、内容盒与 border 盒的 padding 差——这三类只做近似并向日志给出警告。

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

测量时每个页面要用自己的 `--assets` 目录。贴图按位置命名（`tex_0`、`tex_1`…），
两个页面转进同一目录会互相覆盖，前一个页面的 JSON 就指到了后一个页面的像素。
这会凭空制造出「改坏了」的假象；转换器现在遇到这种情况会直接警告。

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

## 目录结构

```
Plugins/Html2UMG/
  Html2UMG.uplugin
  Source/Html2UMG/          编辑器模块：导入、面板、控制台命令、离屏渲染
    Public|Private/
      Importer/     JSON 到 WidgetBlueprint：建树、反射写属性、贴图与字体导入
      Editor/       面板、控制台命令、蓝图/Python API、离屏渲染
      Html2UMGTypes 契约的 C++ 表示和解析
  Source/Html2UMGRuntime/   Runtime 模块：三个运行期控件（相对尺寸 / 文本折行 / 换行盒）
  Resources/
    Converter/      Node 转换器（零依赖，通过 CDP 驱动本机浏览器）
      src/          mapper（分类、槽位、画刷、网格）、bake（切图与效果）、assets（贴图/字体）、
                    fontmetrics（字体度量）、values（CSS 值解析）
      test/         01–16 测试页与 validate.js 契约校验
    Tools/          pngdiff / style_audit / anchor_check / visual_audit / run_acceptance /
                    font_metrics / residual_correct
```