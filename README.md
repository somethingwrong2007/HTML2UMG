# HTML2UMG

把 HTML/CSS 设计稿转成原生 UMG 控件蓝图。运行时不需要浏览器，产物是普通的 Widget Blueprint，
可以在 UMG Designer 里继续改，也可以用 `BindWidget` 绑定到 C++ 或蓝图。

```
design.html  --[Node + 本机 Chromium]-->  design.json  --[UE 编辑器模块]-->  WBP_Asset
             转换期依赖                 可 diff 的中间产物            运行期零依赖
```

一次性完整重导会覆盖手工在 Designer 里做的**布局**改动。要改布局请改 HTML 或直接改 JSON，蓝图图表里的逻辑不受影响。

两份更详细的文档：`Docs/Html2UMG_Approach.md`（为什么选这条路线，和其他方案比）和
`Docs/Html2UMG_LayoutContract.md`（JSON 契约的完整定义，手写或改 JSON 时看它）。

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
| `07-anchors.html` | 点/横拉/竖拉/四边拉/百分比/居中 | 0.57% |
| `08-effects.html` | 渐变、backdrop-filter、阴影 | 0.38% |
| `01-flex.html` | flex 行/列、gap、grow、wrap | 1.59% |
| `06-native.html` | 原生控件切图 | 1.99% |
| `04-form.html` | 完整表单 | 2.01% |
| `05-controls.html` | 自绘下拉、勾选、滑杆、进度、输入框 | 2.63% |
| `03-dashboard.html` | 综合 HUD，层级较深 | 3.59% |

测量时要**单页单次渲染**：一次编辑器会话里连续导入渲染多个页面，烘焙贴图的结果会互相影响，
同一个页面能测出不一样的数字。

剩下的误差主要来自文字（字形光栅化的差异）和少数几处细节，比如文本行盒在 CSS 和 Slate 里的定义不同、
`SBackgroundBlur` 在离屏渲染里不出效果。

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
  Source/Html2UMG/
    Public|Private/
      Importer/     JSON 到 WidgetBlueprint：建树、反射写属性、贴图与字体导入
      Editor/       面板、控制台命令、蓝图/Python API、离屏渲染
      Html2UMGTypes 契约的 C++ 表示和解析
  Resources/
    Converter/      Node 转换器（零依赖，通过 CDP 驱动本机浏览器）
    Tools/          pngdiff / style_audit / anchor_check / visual_audit / run_acceptance
```