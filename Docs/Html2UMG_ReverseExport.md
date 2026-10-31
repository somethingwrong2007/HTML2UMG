# Html2UMG 反向导出：WBP -> JSON -> HTML

> 回应的问题：能不能把已经做好的 UMG 控件蓝图**转回 HTML**。
> 相关：正向流程见 `README.md`；契约见 `Html2UMG_LayoutContract.md`。

## 1. 路线

整条管线本来就是「HTML -> JSON -> WBP」，所以反向只需要回到中间那一层：

```
WBP  --[Html2UMG.ExportLayout]-->  layout.json  --[cli/wbp2html.js]-->  HTML
                                    ^ 与正向同形：嵌套树 / slot 对象 / 扁平属性
```

```bat
:: 1) 导出（编辑器控制台命令，产物是 JSON + 贴图 png + 字体 ttf）
UnrealEditor-Cmd.exe <工程>.uproject \
  -ExecCmds="Html2UMG.ExportLayout /Game/UI/WBP_X --json=C:/out/x.json --assets=C:/out/x_assets --viewport=1920x1080, QUIT_EDITOR" \
  -unattended -windowed -stdout

:: 2) 生成 HTML（Node，不需要引擎）
node Plugins/Html2UMG/Resources/Converter/cli/wbp2html.js C:/out/x.json -o C:/out/x.html
```

## 2. 三个必须精确还原的换算

| 量 | JSON 里是什么 | 反向换算 | 依据 |
|---|---|---|---|
| 颜色 | **线性**空间 `[r,g,b,a]`（FSlateColor） | `linearToSrgb()` 再输出 hex/rgba | 正向 `values.js: srgbToLinear` |
| 字号 | Slate **pt** | `cssPx = Size * 4/3` | 正向 `mapper.js: PX_PER_POINT = 96/72` |
| 行高 | `LineHeightPercentage = cssBox / slateBox`（一个乘数，不是百分数） | `cssBox = 值 * slateBox(字体, 字号)` | 需要字体度量，**所以导出器会把 ttf 一并复制出来** |

行高那一条只有在拿到字体文件时才成立；拿不到时输出 `line-height: normal` 并给警告。

## 3. 结构：折叠与标记

正向导入时每个元素会被拆成 `SizeBox -> Border -> [ScrollBox] -> 内容`，反向生成器把这一串**折回一个 `<div>`**
（尺寸进 `width/height`，背景进 `background`，内边距进 `padding`），控件名用**去掉角色后缀的那个**，
例如 `SizeBox Row_Box` + `CanvasPanel Row` 合成 `<div data-ue-name="Row">`。

CSS 表达不了的控件不硬凑，而是保留标记让回导能重建同一个控件：

| 标记 | 用于 |
|---|---|
| `data-ue-name`（+ `data-ue-name-verbatim`） | 控件名；名字里含下划线等会被 PascalCase 吃掉时自动加 verbatim |
| `data-ue-class` | CSS 画不出来的控件类（Slider / CheckBox / ComboBox / ScaleBox / BackgroundBlur …） |
| `data-ue-widget` / `data-ue-slot` | 复用的 WBP 实例与它的命名插槽 |
| `data-ue-named-slot` | 组件页里的插槽 |
| `data-ue-switcher` / `data-ue-display` | 切换器，以及某个隐藏页「显示时」的真实 display |
| `data-ue-hidden` | 不是隐藏页（隐藏页用 `display: none`，转换器就是这样识别的） |

## 4. 往返验证

```bat
node Plugins/Html2UMG/Resources/Tools/layout_diff.js a.json b.json --tolerance 1 --verbose
```

它同时认两种形状（导出的扁平 `Background.*` / 导入器的 `brush` 对象），比较控件类名、slot 几何、
尺寸、字体、颜色、圆角、描边、内边距，并已经把三类**等价差异**当噪声排除：

- 默认值 vs 省略（`Clipping: Inherit`、`HorizontalAlignment: Fill`、全零 `Padding`）；
- 折叠：被折掉的 `_Box`/`_BG` 包装原样消失（这正是简化规则会做的事）；
- box 槽的**主轴**对齐（几何由槽内边距承载，只有交叉轴是独立的）。

实测（8 个组件页，导出 -> HTML -> 重新转换 -> 对比）：

| 页面 | 结果 |
|---|---|
| WBP_RowSlider | 19 -> 19，**完全一致** |
| WBP_RowSwitch | 13 -> 13，**完全一致** |
| WBP_RowEnum | 29 -> 29，**完全一致**（含隐藏切换页） |
| WBP_Progress | **完全一致** |
| WBP_Slider | **完全一致** |
| WBP_ImageCard | 5 处：9-slice brush 的 Margin 与 padding 互换、贴图乘 tint 丢失（见 §5） |
| WBP_Stepper | 5 处：同上两类 |
| WBP_BareClass | 1 处：一个**空 Overlay** 没有子节点，CSS 里没有任何信号可以承载它 |

## 5. 已知限制（都会在生成时给警告）

1. **贴图乘 tint**：Slate 把画刷颜色与贴图相乘，CSS 只能把图片画在底色**上面**。非白色 tint 时给警告，
   恢复时会丢这一层乘法。
2. **9-slice 画刷**：`drawAs=Box` + `Margin` 是九宫格拉伸，CSS 用 `background-size: 100% 100%` 只能整图拉伸，
   采样方式不同，槽内边距会差几像素。
3. **没有孩子、也没有样式的空容器**（空 `Overlay`/`CanvasPanel`）：它不画任何东西、也不决定任何尺寸，
   CSS 里没有可以承载它的东西，回导时不会重建。
4. **文字阴影**：UMG 把它画在字形内部，CSS 的 `text-shadow` 语义不同，不输出。
5. **蓝图图表、`UWidgetAnimation`、事件绑定**从来不在这条链路上——但控件名逐字保留，
   所以「WBP -> HTML -> WBP」之后，原来的变量名与事件绑定还能对上（见 `data-ue-name-verbatim`）。

## 6. 这个功能可以拿来做的事

- **把已有 WBP 拿回设计管线**：生成可编辑的 HTML 起点，之后改 HTML 再正向导入；
- **任意 WBP 的结构审查 / 备份**：`ExportLayout` 出来的 JSON 可 diff、可跨工程比较；
- **导入器的最强回归测试**：往返一次，前端（转换器）和后端（导入器）任何一侧走样都会被抓出来。
