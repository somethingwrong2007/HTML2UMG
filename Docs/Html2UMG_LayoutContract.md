# Html2UMG — 布局契约 (contract v1)

HTML 是**创作格式**，`layout.json` 是**契约**，UMG Widget Blueprint 是**产物**。

```
design.html ──[Node + 本机 Chromium/CDP]──> design.json ──[UE Editor 模块]──> WBP_Design
```

契约存在的意义：转换器（JS）与导入器（C++）可以独立开发、独立测试；JSON 可 diff、可 review、可手写。

---

## 1. 顶层对象

```jsonc
{
  "contractVersion": 1,
  "generator": "html2umg-converter/0.1.0",
  "source": "C:/design/design.html",
  "blueprint": "/Game/UI/WBP_Design",   // 目标资产路径，可被面板/API 覆盖
  "parentClass": "/Script/MyGame.MyBaseWidget",  // 可选，BindWidget 匹配此类的属性
  "viewport": { "width": 1920, "height": 1080 },
  "assets": {
    "textures": [ { "key": "tex_0", "file": "assets/tex_0.png" } ],
    "fonts":    [ { "key": "font_0", "family": "Inter", "weight": 400, "italic": false, "file": "assets/Inter-400.ttf" } ]
  },
  "warnings": [ "unsupported: box-shadow on '.card' baked as texture" ],
  "root": { /* Node */ }
}
```

* `file` 为**相对于 json 所在目录**的路径（也接受绝对路径）。
* `assets` 中的 `key` 被节点的 `@key` 形式引用。

---

## 2. 节点 (Node)

```jsonc
{
  "name": "TitleText",            // 唯一、合法标识符；这是 BindWidget 的匹配依据
  "class": "TextBlock",           // UMG 短类名，或 "/Script/UMG.TextBlock" 全路径
  "variable": true,               // 是否生成蓝图变量（默认 true）
  "source": "div#title",          // 调试用，标记来源于哪个 DOM 节点
  "properties": { ... },          // 对象自身的反射属性（键名大小写不敏感）
  "brush": { ... },               // 仅 Border / Image / Button 等带 brush 的控件
  "slot": { ... },                // 作用于 **Slot 对象**（其类由父容器决定）
  "children": [ /* Node... */ ]
}
```

设计要点：**一个 DOM 元素可以展开成多个节点**（SizeBox → Border → 内容），
转换器通过插入合成包装节点（如 `MyPanel_BG`、`MyPanel_Content`）表达，
C++ 侧只是普通递归构建，没有任何特例分支。

---

## 3. 值类型系统

`properties` / `slot` 的每个值按**目标属性类型**解释：

| JSON 形态 | 目标类型示例 | 说明 |
|---|---|---|
| `true` / `false` | `bool` | |
| `12` / `1.5` | `int32` / `float` / `double` | |
| `"Fill"` | 枚举 | 按枚举名匹配 |
| `"Hello"` | `FString` / `FName` / `FText` | |
| `[x, y]` | `FVector2D` / `FIntPoint` | |
| `[l, t, r, b]` | `FMargin` | |
| `[r, g, b, a]` | `FLinearColor` / `FSlateColor` | **线性**色彩空间 |
| `{ "Left":0, ... }` | 任意 USTRUCT | 递归写入同名字段 |
| `"@tex_0"` | `TObjectPtr<UObject>` / `FSlateBrush` 贴图 | 引用 `assets` |
| `"/Game/UI/T_Foo"` | 资产路径 | 直接 LoadObject |

嵌套示例（TextBlock）：

```jsonc
"properties": {
  "Text": "SYSTEM READY",
  "Font": { "FontObject": "@font_0", "Size": 18, "TypefaceFontName": "Regular", "LetterSpacing": 0 },
  "ColorAndOpacity": [0.05, 0.05, 0.06, 1.0],
  "Justification": "Left",
  "AutoWrapText": true,
  "ShadowOffset": [1, 1],
  "ShadowColorAndOpacity": [0, 0, 0, 0.5]
}
```

---

## 4. brush 块

```jsonc
"brush": {
  "drawAs": "RoundedBox",          // NoDrawType | Box | Border | Image | RoundedBox
  "tint": [0.1, 0.12, 0.16, 1.0],  // 线性
  "cornerRadii": [8, 8, 8, 8],     // TL, TR, BR, BL（像素）
  "outlineWidth": 1.0,
  "outlineColor": [1, 1, 1, 0.15],
  "texture": "@tex_0",             // 可选
  "margin": [0, 0, 0, 0],          // 九宫格 margin
  "imageSize": [64, 64],           // 可选
  "tiling": "NoTile"               // 可选
}
```

对应 UMG：`FSlateBrush`（`RoundedBox` + `FSlateBrushOutlineSettings`）。

**可选：`states` 交互态覆盖**（仅对 `Button` 生效）。转换器从页面的 `:hover` / `:active` / `:disabled`
规则里取，未列出的键沿用 normal brush：

```jsonc
"brush": {
  "drawAs": "RoundedBox",
  "tint": [0.0137, 0.159, 0.8308, 1],
  "states": {
    "hovered":  { "tint": [0.0242, 0.2016, 0.9131, 1], "outlineColor": [0.0976, 0.3813, 1, 1] },
    "pressed":  { "tint": [0.0091, 0.0976, 0.552, 1],  "outlineColor": [0.0242, 0.147, 0.6584, 1] },
    "disabled": { "tint": [0.0137, 0.159, 0.8308, 0.45] }
  }
}
```

导入器据此写入 `FButtonStyle` 的 `Hovered` / `Pressed` / `Disabled`；四态里任何一个缺失就沿用 normal。

---

## 5. slot 块

`slot` 的键就是 Slot 类上的反射属性名。常用：

```jsonc
// CanvasPanelSlot
"slot": {
  "LayoutData": {
    "Anchors":   { "Minimum": [0.0, 0.0], "Maximum": [1.0, 0.0] },
    "Offsets":   { "Left": 24, "Top": 16, "Right": 24, "Bottom": 0 },
    "Alignment": [0.0, 0.0]
  },
  "bAutoSize": true,   // 注意 UE 的 bool 反射属性带 b 前缀：CanvasPanelSlot 上就是 bAutoSize
  "ZOrder": 3
}

// VerticalBoxSlot / HorizontalBoxSlot
"slot": { "Padding": [0, 8, 0, 8], "Size": { "Value": 1.0, "SizeRule": "Fill" },
          "HorizontalAlignment": "Fill", "VerticalAlignment": "Center" }

// OverlaySlot
"slot": { "Padding": [0, 0, 0, 0], "HorizontalAlignment": "Right", "VerticalAlignment": "Bottom" }

// GridSlot
"slot": { "Row": 1, "Column": 2, "RowSpan": 1, "ColumnSpan": 2, "Layer": 0, "Padding": [4,4,4,4] }

// UniformGridSlot
"slot": { "Row": 0, "Column": 1, "HorizontalAlignment": "Fill", "VerticalAlignment": "Fill" }
```

---

## 6. DOM → UMG 映射规则（转换器职责）

| CSS | UMG |
|---|---|
| `display:flex; flex-direction:row/column` | `HorizontalBox` / `VerticalBox` |
| `flex-wrap:wrap` | `WrapBox` |
| `display:grid` 等宽 | `UniformGridPanel` |
| `display:grid` 不等宽/含 span | `GridPanel` + `GridSlot` |
| `display:block` 且含块级子元素 | `VerticalBox`（流式内联文本合并为一个 `TextBlock`） |
| `position:absolute/fixed` | 父 `CanvasPanel` + `CanvasPanelSlot`（anchors 由多视口 probe 推断） |
| `overflow:auto/scroll` | `ScrollBox` |
| 纯文本元素 | `TextBlock` |
| `background-image:url()` / `<img>` | `Image`（贴图抽到 `assets`） |
| 有 `background-color` / `border` / `border-radius` 的容器 | `Border`（+ 外层 `SizeBox` 承载声明尺寸） |
| `<button>` | `Button`（hover/pressed 作为真实 brush 状态可选） |
| `<input>text` | `EditableTextBox` |
| `<select>` | `ComboBoxString` |
| `<progress>` | `ProgressBar` |
| `<input type=checkbox>` | `CheckBox` |
| `<input type=range>` | `Slider` |

**响应式原则**：只有 CSS **声明**的尺寸变成固定值（`SizeBox`）；由父容器撑开得到的尺寸必须保持 `Fill`，
否则布局失去响应性。绝对定位元素的位置转成 **anchors + offsets**，不是死偏移。

**命名**：`data-ue-name` 优先 → `id` → `class` → `tag`，去重加后缀，`SnapshotName` 清洗为合法标识符。

**属性覆盖**：`data-ue-class` 强制类、`data-ue-variable="false"` 不生成变量、
`data-ue-blueprint` 根元素上覆盖目标资产、`data-ue-font-map` 字体映射。

---

## 7. 导入语义

* 目标资产已存在时**原地重建**控件树：资产身份、父类、图表(graph) 保留，`BindWidget` 绑定继续有效。
* 手工在 Designer 里对**布局**的改动会被覆盖；写在 HTML 里。
* 导入结束编译蓝图；失败时资产仍保存，但消息里给出错误。

---

## 8. 命令

```bat
:: 仅转换，不需要 UE
node Plugins/Html2UMG/Resources/Converter/cli/convert.js design.html -o design.json --viewport 1920x1080

:: 导入（编辑器内）
Html2UMG.Import "D:/design/design.json"

:: 全链路，无编辑器窗口
UnrealEditor-Cmd.exe <Project>.uproject -run=Html2UMG -html="D:/design/design.html" -blueprint="/Game/UI/WBP_Design" -unattended -nullrhi
```

---

## 9. HTML 约定（作者可控的开关）

转换器读 computed style，**不需要任何模板规范**；下面这些属性只在你需要"纠偏"时用。

| 属性 | 加在 | 作用 |
|---|---|---|
| `data-ue-name` | 任意元素 | 生成的控件名，`BindWidget` 按它匹配 |
| `data-ue-class` | 任意元素 | 强制某个 UMG 类 |
| `data-ue-variable="false"` | 任意元素 | 不生成蓝图变量 |
| `data-ue-blueprint` | 根元素 | 覆盖目标资产路径 |
| `data-ue-font-map` | 根元素 | 字体族 → 字体资产路径的 JSON 映射 |
| `data-ue-control` | 任意元素 | **把自绘控件变成真 UMG 控件**：`combobox` / `checkbox` / `slider` / `progress` / `textbox` / `button` |
| `data-ue-options` | `data-ue-control="combobox"` | 选项，`\|` 分隔：`"A\|B\|C"` |
| `data-ue-selected` | 同上 | 选中项索引，0 基 |
| `data-ue-bind` | 任意元素 | 逗号分隔的绑定提示，写进控件的 `Tag` 供蓝图读取 |

### 为什么要 `data-ue-control`

设计稿里的"下拉框"经常不是原生 `<select>`，而是 **div + ul + li 自绘**（为了完全控制配色）。
浏览器的 `<select>` 只允许有限样式，所以真实设计里复杂配色的下拉几乎都是自绘的。
自绘结构在 UMG 里最好映射成**真 `UComboBoxString`**（自带弹出层、键盘导航、滚动），
而不是一堆 Border + TextBlock 拼出来的假下拉：

```html
<!-- 自绘下拉：默认会被当成普通容器 -->
<div class="combo" data-ue-control="combobox"
     data-ue-name="ModeCombo"
     data-ue-options="Stabilize|Altitude hold|Return to launch|Manual"
     data-ue-selected="1">
  <div class="value">Altitude hold</div>
</div>
```

转换器会读这个 div 的 box 样式生成 `WidgetStyle.ComboButtonStyle`，
读 `.combo-list .item` 的配色生成 `ItemStyle`（普通行 / hover 行 / 选中行 / 奇偶行），
子节点只用来取文字，不再逐个建控件。

### 边框约定

Slate 的 `FSlateBrush` 只有**一圈** outline，做不了四边不同。转换器的处理：

| CSS | 结果 |
|---|---|
| 四边同宽同色 | 直接用 `outlineWidth` / `outlineColor` |
| 仅单边（如 `border-bottom`） | 取该边宽度+颜色做成 outline，另把缺失边补进 `Padding` 防内容贴边，并 warn |
| 四边不同 | 取最大宽度与该边颜色，warn |
| `dashed` / `dotted` | 退化为实线，warn |
| `border-radius` | 进 `cornerRadii`（`RoundedBox` + `FixedRadius`，按控件尺寸钳制） |

**所有近似都会进 `warnings`，不会静默丢弃**——这是"可度量"的一部分。

---

## 10. 复用已经导入好的控件

一个页面里，同一块 UI（卡片、状态条、按钮组）往往在多个页面重复出现。
**不要让它每次重新展开成一堆 Border + TextBlock**——那会让多个页面各有一份互不相干的副本，
改一次要改 N 处。改用下面三种复用方式。

### 10.1 实例复用（推荐）：`data-ue-widget`

```html
<!-- 这个元素直接变成 WBP_Card 的一个实例；写在里面的子节点会被忽略 -->
<div data-ue-widget="/Game/UI/WBP_Card" data-ue-name="CardA"></div>
```

产物是**一个** `WBP_Card_C` 控件（`UUserWidget` 子类），不带子节点。
`BindWidget`/`data-ue-name` 得到的变量就是这个实例，蓝图里可以 `GetWidgetFromName` 或强转后调用它的函数。

关键性质：
- 复用的 WBP 被再次导入时，**引用它的页面不需要重新导入**（引用的是类，不是内容）。
- 页面之间不复制结构，改一处生效全局。
- 实例的尺寸/位置仍然由 HTML 里那个元素的 box 决定（走正常 slot 逻辑）。

`data-ue-class="/Game/UI/WBP_Card"` 与 `data-ue-widget` 等价，后者语义更清晰（表达"这是复用"，而不是"这是类名覆盖"）。
导入器把 `WBP_Foo` 自动解析成 `/Game/UI/WBP_Foo.WBP_Foo_C`。

### 10.2 带插槽的复用：`data-ue-slot`

被复用的 WBP 里如果放了 `NamedSlot`（UMG 的命名插槽），外层可以往里塞内容：

```html
<div data-ue-widget="/Game/UI/WBP_Panel" data-ue-name="Sidebar">
  <div data-ue-slot="Header">  <!-- 进 NamedSlot "Header" -->
    <span>TELEMETRY</span>
  </div>
  <div data-ue-slot="Body">    <!-- 进 NamedSlot "Body" -->
    <div class="metric">42.5 m</div>
  </div>
</div>
```

契约里子节点输出 `"namedSlot": "Header"`。导入器解析顺序：
1. 父控件本身是 `UNamedSlot` → 直接 `SetContent`；
2. 父控件实现 `INamedSlotInterface`（`UUserWidget` 就是）→ 按槽名 `SetContentForSlot`；
3. 都不是 → **报错并列出真实可用的槽名**，然后降级为普通子节点。

注意：进了命名插槽的控件**没有自己的 `slot` 布局**（布局由被复用 WBP 内部的插槽容器决定），
所以 `slot` 里的属性会被忽略并告警。

### 10.3 作者期片段复用：`data-ue-partial`

复用**标记结构**而不是已导入资产——转换时把另一个 HTML 文件的内容内联进来：

```html
<div data-ue-partial="fragments/stat-card.html"></div>
```

产物是**独立的控件子树**（和直接粘贴进去一样），适合：
- 同一区块要在不同页面用**不同内容**（片段里有占位符，外层覆盖）；
- 还没决定要抽成 WBP 的时候。

区别一句话：`data-ue-partial` 是**生成期**复用（编辑 HTML 结构），`data-ue-widget` 是**运行期**复用（共享一个 UMG 资产）。

### 10.4 强制展开：`data-ue-inline`

如果某个组件规则把元素匹配成了共享控件，但这一处你就是要一份独立副本（比如只改这一处的配色）：

```html
<div data-ue-component="stat-card" data-ue-inline> ... </div>
```

### 10.5 怎么选

| 场景 | 用 |
|---|---|
| 同一块 UI 在多个页面出现，行为一致 | `data-ue-widget`（实例） |
| 结构固定但内部内容每个页面不同 | `data-ue-widget` + `data-ue-slot` |
| 只想复用排版代码，产物要能各自独立改 | `data-ue-partial` |
| 有一处要偏离共享组件 | `data-ue-inline` |
