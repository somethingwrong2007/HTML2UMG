# Html2UMG — HTML/CSS 直接导入成原生 UMG

把 HTML/CSS 设计稿转成**原生 UMG Widget Blueprint**。不内嵌浏览器、运行时零依赖，产物可以在 UMG Designer 里继续编辑、可以被 `BindWidget` 绑定、可以打到任何 UMG 支持的平台。

```
design.html ──[Node + 本机 Chromium/CDP]──> design.json ──[UE 5.8 Editor 模块]──> WBP_Asset
              （转换期依赖）                  （可 diff 的契约）      （运行期什么都不需要）
```

为什么这样选型、和 CEF 方案/自研 CSS 引擎的对比，见 [`Docs/Html2UMG_Approach.md`](Docs/Html2UMG_Approach.md)。
JSON 契约的完整定义见 [`Docs/Html2UMG_LayoutContract.md`](Docs/Html2UMG_LayoutContract.md)。

---

## 环境要求

| | |
|---|---|
| 引擎 | Unreal Engine 5.8 |
| 编辑器平台 | Windows |
| 产物平台 | 任何 UMG 支持的平台 |
| 运行时依赖 | **无** |
| 仅"HTML → JSON"这一步需要 | Node.js 22+，以及本机任意 Chromium 内核浏览器（Edge / Chrome / Brave / Vivaldi） |

导入一个 `.json` **完全不需要** Node 和浏览器。它们只在你要把 HTML 变成 JSON 时参与。

---

## 安装

克隆到工程的 `Plugins/` 目录下（目录名保持 `Html2UMG`）：

```bat
cd YourProject\Plugins
git clone https://github.com/somethingwrong2007/HTML2UMG Html2UMG
```

然后在工程的 `.uproject` 里启用插件，或在编辑器 **Edit › Plugins › Editor** 里勾选 **HTML to UMG**
（首次会提示重建，接受即可）。也可以直接用 UBT 编译：

```bat
"<UE目录>\Engine\Build\BatchFiles\Build.bat" YourProjectEditor Win64 Development ^
    -Project="<工程目录>\YourProject.uproject" -WaitMutex
```

**环境变量**（可选，`Resources/Tools/` 下的脚本用）：

| 变量 | 用途 |
|---|---|
| `HTML2UMG_ENGINE` | UE 引擎根目录，默认 `E:\Epic Games\UE_5.8` |
| `HTML2UMG_UPROJECT` | 宿主工程的 `.uproject`；不给就在插件上两级目录里自动找 |
| `HTML2UMG_NODE` | 指定 `node.exe`（面板/命令行找不到 Node 时） |
| `HTML2UMG_BROWSER` | 指定 Chromium 可执行文件 |

面板入口：**Tools › HTML to UMG…**（同时也在 **Window** 菜单下）。控制台 `Html2UMG.Open`。

> 下文示例沿用开发时的宿主工程 `FPVSkyline` 与引擎路径 `E:\Epic Games\UE_5.8`，换成你自己的即可。

---

## 三种用法

### 1. 面板（最常用）

`Tools › HTML to UMG…` → 选 `.html` →（可选）改目标 Blueprint 路径与视口 → **Convert + Import**。

选文件时就会先转换，**在你按下 Import 之前**警告和字体清单已经摆在你面前，不会先污染工程。

### 2. 命令行：只转 JSON（不需要 UE）

```bat
node Plugins\Html2UMG\Resources\Converter\cli\convert.js design.html -o design.json ^
     --viewport 1920x1080 --probe 1440x1080,2560x1080 --shot design.png
```

| 选项 | 含义 |
|---|---|
| `-o, --out` | 输出路径，默认同名 `.json` |
| `--viewport WxH` | 测量视口，默认 1920x1080 |
| `--probe W1xH1,…` | 额外视口，用于推断 anchors（响应式） |
| `--shot <png>` | 参考截图，用于保真度对拍 |
| `--blueprint <path>` | 覆盖 `data-ue-blueprint` |
| `--assets <dir>` | 资产输出目录，默认 `assets` |
| `--scale-box <fit\|fill\|fitx\|fity>` | 根节点外包 `ScaleBox`（整屏菜单常用 `fit`，HUD 不要用） |
| `--browser <exe>` | 指定浏览器 |
| `--strict` | 有任何 warning 就 exit 2（CI 用） |
| `-q, --quiet` | 只输出错误 |

退出码：`0` 成功 / `1` 失败 / `2` `--strict` 下有 warning。

### 3. 无头导入（CI）

```bat
UnrealEditor-Cmd.exe FPVSkyline.uproject -run=Html2UMG ^
    -html="D:\design.html" -blueprint="/Game/UI/WBP_Screen" ^
    -out-png="D:\umg.png" -unattended -nosplash
```

Python：

```python
import unreal
opts = unreal.Html2UMGImportOptions()
opts.set_editor_property("blueprint_path", "/Game/UI/WBP_Screen")
opts.set_editor_property("import_fonts", True)
r = unreal.Html2UMGBlueprintLibrary.import_from_json(r"D:\design.json", opts)
print(r.success, r.widgets_created, r.properties_set)
for m in r.messages:
    print(m)
```

> 注意 UE 会剥掉 `b` 前缀：`bSuccess` 在 Python 里是 `success`。

---

## 交互控件与锚点（已实测）

**表单/交互控件**：`<button>` → `UButton`、`<input>` → `EditableTextBox`、`<select>` → `ComboBoxString`（含选项）、
`<input type=checkbox>` → `CheckBox`（含勾选态）、`<input type=range>` → `Slider`（min/max）、
`<progress>` → `ProgressBar`（百分比）、`<textarea>` → `ScrollBox` + `EditableTextBox`。

### 控件配色（WidgetStyle）落到资产

不只是"结构对"，样式结构体也会写进去：

| 控件 | 写入的样式 | CSS 来源 |
|---|---|---|
| `ComboBoxString` | `WidgetStyle.ComboButtonStyle.{Normal,Hovered,Pressed,Disabled}` | `select` 的 box 样式 |
| | `ItemStyle.{InactiveBrush,InactiveHoveredBrush,ActiveBrush,ActiveHoveredBrush,EvenRowBackgroundBrush,OddRowBackgroundBrush,TextColor,SelectedTextColor}` | `option` / `option:hover` / `option:checked` / `option:nth-child(odd\|even)` |
| | `ForegroundColor`、`SelectedOption` | 选中项文字色 / 当前值 |
| `CheckBox` | `WidgetStyle.{UncheckedImage,UncheckedHoveredImage,CheckedImage,CheckedHoveredImage,...}` | `accent-color` + 容器背景/边框/圆角 + `:hover` |
| `ProgressBar` | `WidgetStyle.{BackgroundImage,FillImage}`、`FillColorAndOpacity` | 轨道 `background` / 填充 `accent-color` 或 `::-webkit-progress-value` |
| `Slider` | `WidgetStyle.{NormalBarImage,NormalThumbImage,BarThickness}`、`SliderBarColor`、`SliderHandleColor` | `accent-color` / 轨道高度 |
| `EditableTextBox` | `WidgetStyle.{BackgroundImage,BackgroundImageFocused,ForegroundColor,Padding}` | 容器 box / `:focus` / 文字色 |

**div 自绘的下拉框**（真实设计里最常见，因为原生 `<select>` 只给有限样式）用 `data-ue-control="combobox"`
强制映射成真 `UComboBoxString`，详见契约文档 §9。

### 验证：样式审计

光说"颜色进去了"不算。用 `Html2UMG.DumpWidgets` 把资产里的真实值导出来，和 layout.json 逐项比：

```bat
UnrealEditor.exe FPVSkyline.uproject ^
  -ExecCmds="Html2UMG.DumpWidgets /Game/UI/WBP_Controls --json=C:/w/dump.json, QUIT_EDITOR" ^
  -unattended -nosplash -windowed

python Plugins\Html2UMG\Resources\Tools\style_audit.py C:/w/layout.json C:/w/dump.json
```

输出形如：

```
layout    : 77 nodes, 516 style keys
asset     : 77 widgets
checked keys : 516
matched      : 516
RESULT: CLEAN
```

不一致会逐条打印 `节点.属性 / layout 期望值 / asset 实际值`，所以"某个下拉行颜色没进去"这种问题无处可藏。
`05-controls.html` 的实测：**516 个样式键全部匹配**（字体资产引用按"已解析"计）。

**按钮的四个状态**：转换器会去页面里读 `:hover` / `:active` / `:disabled` 规则，写成 `FButtonStyle`
的 Hovered / Pressed / Disabled。所以 HTML 里写：

```css
.btn           { background:#1b2632; border:1px solid #2a3a4a; border-radius:6px; }
.btn:hover     { background:#243444; border-color:#3d5670; }
.btn:active    { background:#121a24; border-color:#1d2a38; }
.btn:disabled  { opacity:0.45; }
```

导入后按钮悬停/按下在 UMG 里就是真的变色。导入日志会给出确认：
`button brush applied with 3 interaction state(s) from the design`。
点击行为不导入（写在蓝图里，`OnClicked`）。

**锚点**：绝对定位元素的 anchors 由**多视口 probe** 推断，不是死偏移。实测产物：

| 元素 | anchors | 含义 |
|---|---|---|
| `AltBadge` | min=max=(0.0125, 0.0222) | 左上角点锚点，固定尺寸 206×66 |
| `StatusPill` | min=max=(0.9875, 0.0222) | 右上角点锚点（Right=222 保持右边距） |
| `BottomBar` | min=max=(0.5, 0.9704) | 底部居中点锚点 |
| `FrameTop` | min=(0,0) max=(1,0) | **横向拉伸**，高度固定 3px |
| `Floating` | min=max=(1, 0.0508) | 贴右边缘 |

用 `--probe 1440x1080,2560x1080` 给出你关心的其他视口，anchors 会更准（单视口分不清"左对齐"和"居中"）。

### 拉框（拉伸锚点）是重点

锚点不只有"一个点"，`Min != Max` 就是**一个可以拉开的框**——横拉、竖拉、四边拉。判定看 CSS 的**边缘约束**而不是位置比例：

| CSS | anchors | Offsets（点锚点：Right/Bottom 是尺寸；拉伸：Right/Bottom 是正边距） |
|---|---|---|
| `left:312px; right:40px` | `Min(0,?) Max(1,?)` | 横向拉伸 `{Left:312, Right:40}` |
| `top:64px; bottom:0` | `Min(?,0) Max(?,1)` | 纵向拉伸 `{Top:64, Bottom:0}` |
| `left/top/right/bottom` 都有 | `Min(0,0) Max(1,1)` | **四边拉伸** `{Left:312,Top:96,Right:40,Bottom:96}` |
| `left:25%; width:50%` | `Min(0.25,?) Max(0.75,?)` | 百分比才用比例锚点 |
| `right:24px; bottom:60px` | `Min=Max=(1,1)` | 点锚点贴右下 `{Left:-120,Top:-88,Right:96,Bottom:28}` |
| `left:50%` + `translate(-50%,-50%)` | `Min=Max=(0.5,0.5)` | 居中 `{Left:-w/2, Top:-h/2}` |

**关键**：包边约束是 px 时锚点必须落在 0/1 边上（而不是把像素换算成比例）。
比例锚点在设计分辨率下数值正好对，换设备就漂——这是最容易做错、也最难靠肉眼发现的一类 bug。

`SConstraintCanvas` 的权威公式（UE 5.8 `Slate/Private/Widgets/Layout/SConstraintCanvas.cpp`）：

```
点锚点：size = (Offsets.Right, Offsets.Bottom)
        pos  = anchorPx + Offsets.Left - size * Alignment
拉伸：  pos  = anchorPx.Min + Offsets.Left
        size = anchorPx.Max - pos - Offsets.Right      // Right 是正的右边距
```

### 怎么验证（换设备而不是靠眼看）

`Resources/Tools/anchor_check.py` 拿 layout 里的 anchors/offsets 按上面的公式算出各分辨率矩形，
和浏览器在同样分辨率下的真实矩形逐项比：

```bat
node cli/convert.js design.html -o out/layout.json --probe 1280x720,2560x1440 --dump-snapshot out/snap.json
python Resources\Tools\anchor_check.py out/layout.json out/snap.json --tolerance 3
```

`RESULT: CLEAN` 表示每个 probe、每条边误差都 ≤3px。

再加一道像素级证明：**同一个 WBP 渲染到不同分辨率**，和浏览器同尺寸截图对拍。

| `07-anchors.html`（点/横拉/竖拉/四边拉/百分比/居中/右下全都有） | 差异像素 | 平均误差 |
|---|---|---|
| 1920×1080（设计分辨率） | **3.06%** | 0.35% |
| 1280×720（换设备） | **4.89%** | 0.62% |

修复前这两个数字是 `65.01%` / `57.28%`——同一个 WBP 在 720p 下重排后仍能对上，才说明锚点是真的在工作，
而不是"设计分辨率下碰巧对"。

---

## 在 HTML 里控制转换结果

| 属性 | 作用 |
|---|---|
| `data-ue-name` | 生成的控件名，**`BindWidget` 靠它匹配** |
| `data-ue-class` | 强制该元素用某个 UMG 类 |
| `data-ue-variable="false"` | 不生成蓝图变量 |
| `data-ue-blueprint` | 根元素上，覆盖目标资产路径 |
| `data-ue-font-map` | 根元素上，字体族 → 字体资产路径的 JSON 映射 |

不需要遵守任何"模板规范"：转换器读的是 **computed style**，不看 class 名，所以 Tailwind / shadcn / AI 生成的原样 HTML 都能吃。

---

## 检查结果（保真度）

导入后可以把 WBP 渲染成 PNG，和浏览器截图做像素对拍——不用 PIE、不用开视口：

```bat
python Plugins\Html2UMG\Resources\Tools\pngdiff.py design.png umg.png --out out\ --max-diff 0.05
```

它会打印差异像素比与平均绝对误差，并输出 `out_diff.png`（放大 4 倍的差异热图）和 `out_side.png`（左右对照）。

一键全链路：

```bat
python Plugins\Html2UMG\Resources\Tools\run_acceptance.py ^
    --html Plugins\Html2UMG\Resources\Converter\test\03-dashboard.html ^
    --blueprint /Game/UI/Html2UMGTest/WBP_Dashboard
```

### 实测结果（UE 5.8 / Win64，1920×1080，`Resources/Converter/test/`）

| 测试页 | 控件 | 属性 | error | 差异像素 | 平均误差 | 备注 |
|---|---|---|---|---|---|---|
| `01-flex.html` | 56 | 451 | 0 | 18.09% | 0.99% | flex / wrap 布局 |
| `02-absolute.html` | 29 | 243 | 0 | **4.40%** | **0.60%** | 纯绝对定位，anchors 推断最准 |
| `03-dashboard.html` | 108 | 812 | 0 | 9.86% | 2.36% | 综合 HUD，14 层深 |
| `04-form.html` | 58 | 478 | 0 | 41.35% | **2.40%** | 控件配色已落地，余差是原生 chrome |
| `05-controls.html` | 77 | 664 | 0 | 17.38% | 1.58% | 压力页：自绘下拉/勾选/滑杆/进度/输入框 |
| `06-native.html` | 54 | 475 | 0 | **14.82%** | 1.03% | 原生控件切图（bake）后 |
| `07-anchors.html` | 27 | 239 | 0 | **3.06%** | **0.35%** | 点/横拉/竖拉/四边拉/百分比/居中；**1280×720 下 4.89% / 0.62%** |

`05-controls.html` 的**样式审计**：516 个样式键 **全部匹配**（`style_audit.py` → `RESULT: CLEAN`）。
`06-native.html` 的审计：396 个样式键全部匹配（含 28 张烘焙贴图的 `ResourceObject`）。

### 原生控件切图（`--bake`）

`<select>` 的箭头、`<input type=checkbox>` 的勾、`<input type=range>` 的 thumb、`<progress>` 的填充，
在浏览器里是**操作系统主题**画的，UMG 里只能靠 Slate 默认样式近似——这是 `04-form` 那 41.5% 差异的来源。
`--bake` 的解法是：**把这些部件从浏览器里切下来当贴图**。

| 控件 | 隔离手法 | 写入字段 |
|---|---|---|
| `<select>` | 隐藏文字（`color: transparent`）后截整个框（含箭头） | `WidgetStyle.ComboButtonStyle.ButtonStyle.{Normal,Hovered,Pressed,Disabled}` |
| `<input type=checkbox\|radio>` | 分别截未勾选 / 勾选态 | `WidgetStyle.{Unchecked,Checked,UncheckedHovered,CheckedHovered,UncheckedPressed,CheckedPressed}Image` |
| `<input type=range>` | 隐藏 thumb 截纯轨道；对比 value=min/max 两张图定位 thumb 后裁切 | `WidgetStyle.{NormalBarImage,NormalThumbImage,HoveredThumbImage,DisabledBarImage,DisabledThumbImage}` |
| `<progress>` | 分别隐藏填充 / 轨道各截一张 | `WidgetStyle.{BackgroundImage,FillImage}` |

多状态用 CDP `CSS.forcePseudoState` 强制 `:hover` / `:active` / `:focus` / `:disabled` 后截。
所有切图走 `assets.textures`，brush 用 `{drawAs:"Image", texture:"@tex_N", imageSize:[w,h]}` 引用——
`imageSize` 是控件的设计像素尺寸，不加会被拉伸。

**可交互性没有丢**：切图只替换"画什么"，`select` 仍然是真 `ComboBoxString`（弹出列表、键盘导航可用），
`checkbox` 仍能点，`range` 仍能拖。部件隔离失败会回退矢量近似并 `warn`，不会静默。

开关：`--bake`（默认对原生控件开启）、`--no-bake`、`--bake-scale <n>`（默认 2）、`--bake-max <px>`（默认 2048）。
下拉框的 `ItemStyle` 九个键恒定齐全：`InactiveBrush` / `InactiveHoveredBrush` / `ActiveBrush` / `ActiveHoveredBrush` /
`SelectorFocusedBrush`（键盘焦点行）/ `EvenRowBackgroundBrush` / `OddRowBackgroundBrush` / `TextColor` / `SelectedTextColor`。
`04-form.html` 从加样式前的 `46.08% / 6.19%` 降到 `41.54% / **2.97%**`——平均误差腰斩，说明颜色/边框真的对了；
剩下的差异像素集中在原生控件 chrome（`<select>` 的箭头、`<input type=checkbox>` 的勾、滑杆的 thumb），
这些在浏览器里是 OS 主题皮肤，UMG 里是 Slate 默认样式，属于已知外观差、不是布局或配色错。
（要彻底消除这部分差异走 `--bake`：把浏览器里那些部件切下来当贴图，见下节。）

---

## 复用已经导入好的控件

同一块 UI 在多个页面出现时，**不要让它每次重新展开**——用实例复用，产物是一个 `UUserWidget` 实例，
改一处生效全局，且引用它的页面在目标 WBP 重导后不需要重导。

```html
<!-- 1) 实例复用：直接变成 WBP_Card 的实例，写在里面的子节点会被忽略 -->
<div data-ue-widget="/Game/UI/WBP_Card" data-ue-name="CardA"></div>

<!-- 2) 带插槽：子元素塞进被复用 WBP 里名为 Header / Body 的 NamedSlot -->
<div data-ue-widget="/Game/UI/WBP_Panel" data-ue-name="Sidebar">
  <div data-ue-slot="Header">...</div>
  <div data-ue-slot="Body">...</div>
</div>

<!-- 3) 作者期片段复用：把另一个 html 文件内联进来（产物是独立副本） -->
<div data-ue-partial="fragments/stat-card.html"></div>

<!-- 4) 强制展开：这一处要一份独立副本 -->
<div data-ue-component="stat-card" data-ue-inline>...</div>
```

| 场景 | 用 |
|---|---|
| 同一块 UI 多页面出现、行为一致 | `data-ue-widget`（实例） |
| 结构固定、内容每个页面不同 | `data-ue-widget` + `data-ue-slot` |
| 只想复用排版代码、产物各自能改 | `data-ue-partial` |
| 有一处要偏离共享组件 | `data-ue-inline` |

已实测：`data-ue-class` / `data-ue-widget` 指向 `/Game/UI/WBP_Mini` 时，产物里出现一个 `WBP_Mini_C` 控件
（`DumpWidgets` 输出 `WBP_Mini_C  ReusedMini`）。插入命名插槽的控件没有自己的 `slot` 布局
（布局由被复用 WBP 内部的容器决定），因此 `slot` 属性会被忽略并告警；槽名写错会报错并列出真实可用的槽名。

完整约定见契约文档 §10。


`03-dashboard` 的差异构成：像素完全一致 **31.6%**，±5–8 舍入级 56.5%，**结构性差异（通道差 >64）3.47%**（主要是文字字形栅格化差异）。纯色背景区域逐字节一致（如 `(11,16,23)`、`(7,10,15)`）。

第二次导入同一份 JSON：`0 created / 108 reused`，资产目录无 `_1` 重复项。

**已知短板**：`04-form` 的大差异来自原生表单控件——浏览器里 `<select>` / `<input type=range>` / `<progress>` 带 OS 主题外观，UMG 侧是 Slate 控件样式。要压下去得给这些控件补 brush 状态，属于后续优化，不是布局错误。

---

## 能力矩阵：什么环境能做什么

| 能力 | 面板 / `-ExecCmds`（完整编辑器） | `-run=Html2UMG`（无头 CI） |
|---|---|---|
| 布局 / 控件树 / 反射属性 | ✔ | ✔ |
| 贴图资产导入 | ✔ | ✔ |
| **字体文件导入** | ✔ | ✘（需要 Slate 字体图集） |
| **渲染 PNG 对拍** | ✔ | ✘（需要 Slate/RHI） |
| 编译 + 保存资产 | ✔ | ✔ |

命令行走的是"无 Slate"进程（`LaunchEngineLoop` 在 `IsRunningCommandlet()` 分支不创建 `FSlateApplication`），
所以字体与渲染这两件依赖 Slate 的事必须在完整编辑器里做。无头 CI 请只用它做"布局 + 贴图 + 属性"。

> `-ExecCmds` 的多个命令用**逗号**分隔，不是分号。用 `;` 会把 `;QUIT_EDITOR` 塞进最后一个参数里。

```bat
UnrealEditor.exe FPVSkyline.uproject ^
  -ExecCmds="Html2UMG.ImportAndRender C:/work/layout.json /Game/UI/WBP_X C:/work/umg.png 1920x1080, QUIT_EDITOR" ^
  -unattended -nosplash -windowed -ResX=1280 -ResY=720
```

（路径里不要有空格——控制台命令按空格切分参数。）

---

## 重新导入

再次导入会**原地重建控件树**：资产身份、父类、蓝图图表都保留，控件名保持稳定，所以 `BindWidget` 绑定不会断。

**手工在 Designer 里对布局做的改动会被覆盖**——要改布局请改 HTML（或直接改 JSON）。蓝图图表里的逻辑不受影响。

---

## 排查

| 现象 | 原因 |
|---|---|
| `Node.js was not found` | 装 Node 22+，或设 `HTML2UMG_NODE` 指向 node.exe |
| `no Chromium found` | 用 `--browser` 指定 Edge/Chrome 路径 |
| `'X' is not a property of Y` | 手写 JSON 里写了该类没有的属性；消息里会给出类名 |
| `'X' appears twice` | 控件名必须唯一（那是 `BindWidget` 的匹配键） |
| 某个 `BindWidget` 为空 | 给对应元素加 `data-ue-name="那个名字"`；名字接近时消息会提示疑似拼写 |
| 导入失败但资产已存 | 看上面的错误；资产是半成品，改完重新导入即可 |

---

## 目录结构

```
Plugins/Html2UMG/
  Html2UMG.uplugin
  Source/Html2UMG/
    Public|Private/
      Importer/      JSON → WidgetBlueprint（反射写入、建树、贴图/字体导入）
      Editor/        面板、命令、蓝图/Python API、保真度渲染
      Html2UMGTypes 契约的 C++ 表示 + 解析器
  Resources/
    Converter/       Node 转换器（零依赖，CDP 驱动本机浏览器）
    Tools/           pngdiff.py / run_acceptance.py
```
