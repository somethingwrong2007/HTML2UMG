# HTML -> Slate：可行性与实现

> 回答的问题：能不能把 HTML/CSS 转成 **Slate**（而不是 UMG）？
> 结论：能，而且**不需要烘焙任何贴图**——颜色、圆角、描边在 Slate 里就是 `FSlateBrush` 的字段，可以直接用代码写出来。

## 1. 为什么这件事在结构上成立

UMG 是 Slate 外面的一层 UObject 包装：`UWidget::TakeWidget()` 交出的就是 `TSharedRef<SWidget>`，
控件本体由 `UWidget::RebuildWidget()` 构造。所以 UMG 里有的控件，Slate 里都有对应类；
我们 layout.json 里的**画布槽就是 `SConstraintCanvas::FSlot` 的字段**（逐项核对过）：

| layout.json | Slate |
|---|---|
| `slot.LayoutData.Anchors.{Minimum,Maximum}` | `SConstraintCanvas::Slot().Anchors(FAnchors(minX,minY,maxX,maxY))` |
| `slot.LayoutData.Offsets.{Left,Top,Right,Bottom}` | `.Offset(FMargin(L,T,R,B))` |
| `slot.LayoutData.Alignment` | `.Alignment(FVector2D(ax,ay))` |
| `slot.bAutoSize` | `.AutoSize(bool)` |
| `brush.tint / cornerRadii / outlineWidth / outlineColor` | `FSlateBrush::TintColor / OutlineSettings.CornerRadii / Width / Color` |
| `properties.Font.{Size,TypefaceFontName,LetterSpacing}` | `FSlateFontInfo(..., Size, Typeface).LetterSpacing` |
| `properties.ColorAndOpacity`（**线性**空间） | `FSlateColor(FLinearColor(...))`，同一空间，不用转 |
| `properties.Justification / AutoWrapText / LineHeightPercentage` | `STextBlock` 的同名参数 |
| `properties.WidgetStyle.{Normal,Hovered,Pressed,Disabled}` | `FButtonStyle` 的同名 brush |

## 2. 和 UMG 路线的关键差别：不烘焙

UMG 那边 `bake.js` 要截贴图，是因为 `USlateBrushAsset` 只能装一张图：按钮三态、复选框轨道和圆钮、
渐变、阴影，全都得先画成 PNG 再塞进 brush。Slate 里不必：

- **纯色/圆角/描边** → `H2USlate::BoxBrush(Tint, CornerRadii, OutlineWidth, OutlineColor)`；
- **按钮 hover/pressed/disabled** → `FButtonStyle` 的四个 brush，同样由代码给出（layout.json 里已有这些颜色）；
- **文字颜色/字号/行高/字距** → `STextBlock` 的参数；
- **真实设计图**（`<img>`、`background-image`）才用贴图，按 layout 的 `assets.textures[].source`（UObject 路径）加载。

所以 Slate 产物是**纯代码**：没有烘焙贴图、没有额外资产、没有运行时依赖。

## 3. 现在已实现的东西

```bat
node Plugins/Html2UMG/Resources/Converter/cli/html2slate.js layout.json \
     -o <输出目录> --class FH2UPage --asset-root /Game/Html2UMG
```

产出三个文件：

| 文件 | 内容 |
|---|---|
| `<Class>.h` | `SCompoundWidget` 子类，`BrushStore`/`StyleStore` 持有 brush 与 style |
| `<Class>.cpp` | `Construct()`：先建 brush/style，再建整棵树 |
| `H2USlate.h` | 支持头：`BoxBrush` / `TextureBrush` / `Font`（复合字体可用，与 UMG 同一套字体资产） |

覆盖的类：CanvasPanel / Overlay / VerticalBox / HorizontalBox / Border / SizeBox / ScaleBox /
ScrollBox / TextBlock / Image / Button / Spacer / 各种 Switcher。无法映射的类会**告警并降级**为 `SBox`
（不静默丢内容）。

**已验证**：`test/05-controls.html` 生成 64 个控件表达式、0 告警，放进插件的 Editor 模块
**一次编译通过**（UBT `Result: Succeeded`，日志里有 `[1/5] Compile FH2UControls.cpp`）。

**尚待验证**：像素。Slate 侧渲染不需要新机制——插件里的
`FWidgetRenderer::DrawWidget(RenderTarget, SlateWidget, ...)` 本来就吃任意 `SWidget`，
所以下一步是加一个渲染入口，用现有的 `visual_audit.py` 和浏览器截图对拍。

## 4. 已知缺口（都会在生成时告警）

1. **NamedSlot 没有 Slate 对应物**。`SNamedSlot` 不存在（已核对 Slate/SlateCore 全树）——
   命名插槽是 UMG 的组合概念。组件页要么生成成**独立的 `SCompoundWidget` 类**（用 `SLATE_NAMED_SLOT`
   或类型化 setter），要么在纯数据路线里退化。这是唯一一个需要结构性设计的缺口。
2. **渐变/阴影**。Slate 没有渐变 brush，需要在自定义 `OnPaint` 里用 `FSlateDrawElement::MakeGradient`
   画（可行，但属于下一步）。UMG 路线在这里烘焙。
3. **动画**。`UWidgetAnimation` 是 UMG 专有的 Sequencer 资产；Slate 只有 `FCurveSequence`（代码驱动），
   没有时间轴编辑器。
4. **可编辑性**。Slate 没有设计器，也没有可序列化的树资产（`SWidget` 不是 `UObject`）。改一行就要重编译。
5. **本地化**。HTML 文本直接塞进 `FText::FromString` 不会被收集；要 `LOCTEXT` 或字符串表。
6. **蓝图访问**。纯 Slate 没有 `BindWidget`、没有蓝图事件——C++ 或你自己的回调表。

## 5. 方案对比（为什么选代码生成）

| 路线 | 做法 | 优点 | 代价 |
|---|---|---|---|
| **A 代码生成**（已实现） | JSON -> `<Class>.cpp` | 纯代码、零运行时依赖、编译期检查、与 UMG 共用前端 | 改设计要重编译；无设计器 |
| B 运行时解释器 | JSON -> `SWidget` 树 | 热改、免编译 | 需要运行时模块（与「0 依赖」冲突）；`SWidget` 无反射，每种控件都要手写工厂 |
| C 走 UMG + `TakeWidget()` | 现有 WBP | 零成本 | 仍要 UMG/资产/世界；不是纯 Slate |
| D 混合 | 页面代码生成 + 组件页类化 | A 的性能 + 组件可组合 | 工作量最大 |

## 6. 外部先例（调研结论）

**没有公开的 HTML/CSS -> UE Slate 转换器。** 搜到的 `html2slate` 全是 Slate.js（富文本编辑器），
与 Unreal 无关。相关但不同：

- **RSHTMLUI**（商业）：一个 UMG 控件，内部把 HTML/CSS **解释**成 Slate 渲染，不产出代码；
- **MomijiUI**（MIT）：自己的 JSON schema -> 运行时 Slate 树 + 浏览器 canvas 预览；
- **TAPython**：编辑器工具，JSON -> Slate，逐节点派发；
- **所有 HTML/JSON -> 资产 的产品（UMGForge / Loom / soft-ue-cli / ReactorUMG 等）都落 UMG**，
  因为 `UWidgetTree` 是 `UObject`（可序列化），而 `SWidget` 不是。

Epic 官方立场：游戏内 UI **首选 UMG**，Slate 主要面向编辑器/工具层。也就是说这条 Slate 路线
的合理定位是：**工具 UI、无 UMG 依赖的程序化 UI、或者需要一个纯代码交付的界面**。

## 7. 像素验证（已打通，尚未对齐）

渲染链路已证明可行：`FHtml2UMGFidelity::RenderSlateTreeToFile(TSharedRef<SWidget>, ...)` 把任意 Slate 树
画成 PNG（`FWidgetRenderer::DrawWidget` 本来就吃 `SWidget`），配一个临时命令 `Html2UMG.RenderSlatePreview`
就能对拍。`test/05-controls` 实测 **1920x1080 出图成功**。

当前差异与原因（看图确认，不是猜）：

| 现象 | 原因 |
|---|---|
| 文字曾被截掉左侧几个字 | 未映射的原生控件塌成 0 尺寸空盒，把行内宽度挤没了；补上控件映射后**已修复** |
| 下拉框显示「未提供内容」 | `SComboBox` 的 `InitiallySelectedItem` 仍为空，待定位（疑似 Construct 时 `OptionsSource` 的时序） |
| 复选框行 / 按钮尺寸偏小 | layout.json **不携带控件 rect**：设计尺寸只体现在画布槽与 SizeBox 上，盒内自动排布的控件高度退回 Slate 默认样式尺寸 |
| 右卡片「98%」「12」两个值不显示 | 待查（同属盒内自动排布 + 文本尺寸问题） |
| 行间垂直间距偏差累积 | 同上：每行高度差几像素会累积 |

**这条差异的根因是信息缺失，不是生成器写错**：要让 Slate 精确对齐，layout.json 需要额外携带**每个控件的测量尺寸**
（或转换器在盒内控件外面套一个带 `MinDesiredHeight` 的 SizeBox）。这是下一步的真正工作。

## 8. 一次实测的教训

第一次编译失败不是生成器的问题，而是插件 `Build.cs` 少了 **InputCore**：`SEditableTextBox` / `SSpinBox` /
`SComboBox` 会实例化并引用 `EKeys`，链接期报 10 个未解析符号。加上依赖即通过——做 Slate 输出必须连带处理模块依赖。

## 9. 颜色/圆角两个实测 bug（已修）

**A. 容器背景 brush 根本没有被发出来。** 转换器把画刷放在节点顶层的 `node.brush`，我只读了
`properties.Background`（那是 WBP 导出器的方言）。于是每个 Border 都是无背景的透明框，底下是黑色清屏。
实测：页面背景 `(7,11,17)` → 渲染成 `(0,0,0)`。修好后**逐字节一致**。

**B. 圆角全部变成椭圆。** `FSlateBrushOutlineSettings` 的默认 `RoundingType` 是 `HalfHeightRadius`——
**忽略你给的 CornerRadii，永远按高度的一半圆角**。一个 700x782、半径 14 的面板因此画成椭圆。
显式设 `ESlateBrushRoundingType::FixedRadius` 后恢复成 14px 圆角。

另外确认了一件事（用色阶带量出来的，不是推理）：`H2USlate::BoxBrush` 的线性 tint 经渲染管线后
**正好等于 sRGB(线性)**——线性 0.0021 → 字节 7、0.01 → 25、0.5 → 188，与浏览器一致。所以颜色不需要
任何补偿，错只可能在“值没送到”或“画刷模式不对”这两处，事实也正是如此。

修复前后的对拍（`test/05-controls`，1920x1080，对照浏览器截图）：

| | 修复前 | 修复后 |
|---|---|---|
| 差异像素 | 13.38% | **7.79%** |
| 结构边缘匹配 | 21.6% | **33.3%** |
| 页面背景 | (0,0,0) | **(7,11,17) = 浏览器** |
| 右卡片背景 | (0,0,0) | **(11,19,28) = 浏览器** |
| 面板圆角 | 椭圆 | 14px |

剩下的差异是**布局**不是颜色：下拉框占位、复选框行尺寸、盒内控件高度、按钮宽度。根因仍是
§7 那条——layout.json 不携带控件 rect。

## 10. 尺寸信息补进 layout.json（第一步已做）

`mapper.makeNode()` 现在给每个节点输出 `rect: [x, y, w, h]`（CSS px，来自快照测量）。UMG 不需要它
（槽里已经带尺寸），但 Slate 需要：盒内自动排布的控件没有内在尺寸，就会退回 Slate 默认样式尺寸。

生成器据此把每个节点钉到测量矩形上（`SBox::WidthOverride/HeightOverride`）。**钉哪个轴要看父面板**：

| 父面板 | 自动定尺寸的轴 | 需要钉 |
|---|---|---|
| VerticalBox | 高度（或 Fill） | `HeightOverride`；宽度在 HAlign=Fill 时由父级给 |
| HorizontalBox | 宽度（或 Fill） | `WidthOverride`；高度由最高兄弟决定 |
| Overlay / 单子级 | 两个轴都由自身 desired size | 两个都钉 |
| CanvasPanel | 槽已经带尺寸 | 不钉 |

注意一个坑：HorizontalBox 里的 `VerticalAlignment: Fill` 意思是“对齐到行高”，**不是**“父级会给高度”，
所以不能用对齐值来判断是否需要钉。

实测（`test/05-controls` @1920x1080）：差异 8.13% → 8.34%，结构边缘 38.5% → 38.9%。按钮、下拉框、
输入框的尺寸明显改善；但**行的垂直位置仍在漂**，复选框行与右卡片两个数值仍不对。

下一步需要的不是继续调参，而是**instrumentation**：给临时渲染命令加一个几何 dump（遍历 `SWidget` 的
`GetDesiredSize()`/`GetCachedGeometry()`，和 JSON 的 `rect` 逐节点对比），才能看出是哪一层的
高度差被累积。盲调已经证明无效（钉了全部节点反而略差）。

## 11. 测试体系（多轮迭代用）

### 11.1 新增 fixture

| 文件 | 覆盖什么 |
|---|---|
| test/23-slate-canvas.html | 锚点三种形态（点锚 / 水平拉伸 / 右下远边锚）+ 圆角 + 描边 + 胶囊与圆形 |
| test/24-slate-controls.html | 六种原生控件（复选框/滑块/进度条/输入框/数字框/下拉框），各自有明确 px 尺寸 |
| test/25-slate-switcher.html | 切换器两页（隐藏页也必须被测量），页内有文本与进度条 |

### 11.2 快速层（不需要引擎）

    node test/slate/run_slate_tests.js
    node test/slate/run_slate_tests.js --filter 24

每个 fixture 断言：转换成功、每个节点都带 rect、期望的控件类都出现、没有 no-Slate-mapping、
以及生成器确定性（两次产出逐字节相同）。

### 11.3 引擎层（一次构建，渲染 + 几何对比）

    bash test/slate/engine_tests.sh

流程：转换 -> html2slate-pack 打包（含一个名字到 SNew(类) 的注册表，因为 SWidget 不是 UObject、
运行时无法按名字查类）-> 拷进插件 -> 一次构建 -> 按名字渲染每个 fixture 并 dump 几何 -> 与
layout 的 rect 逐控件比较（最近匹配，避免把 Slate 内部文本配到设计文本上）。

### 11.4 当前实测

| fixture | 参与比较控件 | 最大位置误差 | 最大尺寸误差 |
|---|---|---|---|
| 23-slate-canvas | 2（文本） | 4.0 px | 5.9 px |
| 24-slate-controls | 12（6 控件 + 6 文本） | 11.0 px | 18.0 px |
| 25-slate-switcher | 3 | 2.0 px | 362 px（文本未拉伸到页宽） |

### 11.5 这两轮测试直接抓到的 bug

1. data-ue-switcher 被子元素绝对定位吃掉。切换器检测原先只在流式容器分支里做，而页面常常是
   绝对定位的，于是走 canvas 分支、属性被静默忽略，设计稿的切换器变成一个页面堆叠。已修：在
   flow/absolute 分流之前检查该属性。24 个 fixture 全量校验通过，25 现在正确产出 PageSwitcher。
2. instrumentation 的坑：SWidgetSwitcher::GetChildren() 只返回当前活动页（引擎实现如此），
   所以几何 dump 永远看不到隐藏页。对比脚本因此只比活动页，否则会把每个隐藏页报成缺失——
   这不是生成器的 bug，记下来免得下次误判。

## 12. 排版对不上的两个根因（已修，实测 0px）

### 12.1 `SVerticalBox::Slot()` 默认是 **Fill**，不是 Auto

这是「一堆对不上」的真正来源。用受控探针测出来：300px 高的面板里放三个 `SBox.HeightOverride(40)`
的子项，结果每个 **92px**（(300-24)/3）——槽默认按比例均分剩余空间。于是每行都比设计高约 4px，
且**逐行累积**：24 号 fixture 实测行距 60px，设计是 56px。

修法：每个槽都显式写尺寸规则 —— `.AutoHeight()` / `.AutoWidth()`，或在 `SizeRule=Fill` 时写
`.FillHeight(w)` / `.FillWidth(w)`。修完六行位置误差 `0 0 0 0 0 0`。

### 12.2 `SBorder` 不写 `.Padding()` 会内缩 2px

整页统一 +2px。用同一份 JSON 的 **UMG 渲染**做对照才敢下结论：

    browser (20,20,619,379)
    umg     (20,20,619,379)   d=(+0,+0)
    slate   (22,22,621,381)   d=(+2,+2)

修法：每个 Border 都显式输出 `.Padding`（设计没有就写 0）。

### 12.3 盒内子项按**测量间距**排布

只钉尺寸不够：容器是流式叠加，任一行高度不同就会把下面全部推走。现在按 rect 算出相邻子项的
主轴线间距离，作为槽的 leading padding，并且**第一个子项不吃 gap**（父容器自己的 padding 已经把它
放到设计位置了，再加就是双重计数——实测第一版首行低了 17px）。框内子项一律只用测量间距，
CSS 的 margin 被替换而不是叠加（否则同一段 12px 会算两次，每行多 24px）。

### 12.4 结果

| fixture | 差异像素（本轮前 → 后） | 几何位置误差 | 几何尺寸误差 |
|---|---|---|---|
| 23-slate-canvas | 4.12% → 4.12% | 0.0 px | 0.0 px |
| 24-slate-controls | 19.88% → **14.82%** | 0.0 px（仅 SSpinBox 9px） | 0.0 px（仅 SSpinBox 18px） |
| 25-slate-switcher | 8.91% → 8.91% | 0.0 px | 0.0 px |

对比图（浏览器 / Slate / 差异 x4）：`E:\Epic Games\HTML2Unreal\slate\compare\{23,24,25}.png`，
渲染图与几何 dump 在 `...\slate\render\`，layout 在 `...\slate\layout\`，生成代码在 `...\slate\pack\`。

### 12.5 仍剩下的（都是控件**外观**，不是排版）

| 现象 | 说明 |
|---|---|
| 复选框没有勾 | `FCheckBoxStyle` 的勾选图需要图形，UMG 路线是烘贴图；纯代码路线要自绘或接受默认样式 |
| 进度条没有轨道底色 | 设计的轨道色来自 UA 默认样式，layout.json 里没有这个颜色 |
| 下拉框显示引擎的「未提供内容」 | `InitiallySelectedItem` 已传入但未生效，待查 |
| SSpinBox 位置/尺寸差 9/18px | 数字框自带按钮与内边距，外层 SBox 的尺寸被内部 desired 覆盖 |

## 13. 滑块：圆手柄 + 两段轨道（代码构造）

`FSliderStyle` 只有**一条** bar 和一条 thumb，没有「已填充段」的概念，所以浏览器里
「填充到手柄位置 + 其后是空轨」的两段式轨道，光靠样式表达不了。

现在的做法（全部用代码，无贴图）：

```
SOverlay
  + 底轨     SBorder  BorderImage = BoxBrush(bar×0.35, 半径=条厚/2)   // 胶囊
  + 填充段   SBox.WidthOverride(宽 × 比例) [ SBorder BoxBrush(bar, 同半径) ]
  + 滑块     SSlider  Style = FSliderStyle{ bar 透明, thumb = 圆形固定尺寸 }
```

- **圆手柄**：thumb 用 `SizedBoxBrush(tint, 半径=7.5, ImageSize=15x15)`。之前被拉伸成椭圆/圆角方
  是因为没有设 `ImageSize`——画刷默认铺满整个槽，15x15 的图被拉成 292x20，再按 4px 圆角就变成胶囊。
- **条厚/手柄尺寸取自 layout**：`WidgetStyle.BarThickness` 与 `WidgetStyle.NormalThumbImage.imageSize`
  （本例 20 / 15x15），不是猜的。
- **样式里的 bar 设为透明**，否则它会盖住下面画好的两段轨道。
- 填充色由 layout 的 bar 色派生（设计的确切强调色在烘焙皮肤里，这条路线不产出烘焙）。

## 14. 当前构建阻塞（与插件无关）

全量 `FPVSkylineEditor` 构建被项目自身代码挡住：

    Source/FPVSkyline/Private/AircraftParts/UI/SAircraftAssemblyEditor.cpp(1861..1863): C2664
    Source/FPVSkyline/Public/Contract/GameplayChannels.h(94): C3861 MakeIndexedName 未定义

插件侧改动已用 `-SingleFile` 单独编译验证：**Result: Succeeded**。
项目代码恢复绿之后，用下面两条即可出图与对比：

    bash test/slate/engine_tests.sh              # 构建 + 渲染 + 几何对比
    python test/slate/make_comparison.py ...     # 三格对比图

## 15. 控件皮肤：从烘焙像素里**量**颜色，而不是猜

滑块/进度条这类控件的颜色，layout.json 里只有白色占位（`SliderBarColor=[1,1,1,1]`），真正的蓝色在
烘焙出的皮肤贴图里。既然这条路线不交付贴图，就把颜色**量出来写进 JSON**：

- `bake.js` 新增 `measureBarPalette()`：取轨道图**中间一行**扫描线。原生 range 的中间行同时包含
  两段颜色（手柄左侧是强调色、右侧是空轨），于是「饱和度最高的」= 填充色、「最亮的」= 轨道色。
  实测得到 `fill=(0,117,255)`、`track=(239,239,239)`，与浏览器逐像素一致。
- 单个「主色」在这里没用：轨道图 584×40，绝大部分是被条遮住的页面背景，第一次尝试因此把背景
  当成了控件颜色（测出 `(24,24,40)`）。
- 颜色写进 `WidgetStyle.NormalBarImage.palette` 与 `bakedColor`，Slate 生成器直接取用。

### 15.1 滑块

- 手柄之前是被**拉伸**成胶囊的：画刷不设 `ImageSize` 会铺满整个槽，15×15 被拉成 292×20。现在用
  `SizedBoxBrush(色, 半径=7.5, ImageSize=15×15)`，是正圆；尺寸取自 `NormalThumbImage.imageSize`。
- `FSliderStyle` **没有**「已填充段」概念，所以两段轨道用 `SOverlay` 组合出来：底轨 + 按比例宽的
  填充段 + 上层 `SSlider`（样式里的 bar 设为**透明**，否则它会盖住下面画好的轨道）。
- 轨道**可见厚度**要单独算：`BarThickness=20` 是整个槽高，可见轨道只有约 6px。用
  `thumbH × 0.4` 推算并夹取。

### 15.2 进度条

- `SProgressBar.BackgroundImage` 传了也不生效：它仍用样式里的**默认深色背景**把轨道盖住。
  修法是给它一个**透明**背景，把颜色由下面的 `SBorder` 轨道提供。
- 填充色不能只靠 `FillColorAndOpacity`：它会与引擎默认 FillImage 相乘（实测变成 `0,55,231`）。
  改为给 `.FillImage` 一个承载测量色的画刷，`FillColorAndOpacity` 保持白。

### 15.3 本轮实测

| fixture | 差异像素 |
|---|---|
| 23-slate-canvas | 4.12% |
| 24-slate-controls | 14.51% → **13.78%** |
| 25-slate-switcher | 8.91% |

关键采样点（24 号页，进度条 y=171）：

| x | 浏览器 | Slate |
|---|---|---|
| 195 | (0,117,255) | (8,119,248) |
| 260 | (239,239,239) | **(239,239,239)** |

剩下未解决：复选框的勾（需要矢量绘制）、下拉框仍是引擎占位、`SSpinBox` 内边距导致 9px 偏差。
