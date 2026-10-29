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
  // 影响输出的开关（同一份 HTML + 同一 settings 必须得到同一份 JSON）
  "settings": {
    "fontPolicy": "any",          // any | redistributable
    "ttcSubfaces": true,          // false = 跳过 .ttc/.otc 集合
    "wrapTolerance": 0,           // px，加到 WrapTextAt 上
    "cjkBreaks": "policy",        // policy | none
    "lineHeightModel": "per-font" // per-font | legacy
  },
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
* `settings` 是**转换器实际生效的开关**（命令行或环境变量的最终值，已归一化）。它让“同一页两次转换为什么像素不同”
  可以直接 diff 出来；导入器不需要读它，但**审计脚本应当记录它**。缺省（老 JSON 无该段）等价于上例的值。

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
| `data-ue-class` | 任意元素 | 强制某个 UMG 类。可以写**裸类名**（`Overlay`、`CommonAnimatedSwitcher`），导入器按 `/Script/<每个已加载模块>.<类名>` 逐个试；也可以写完整路径或蓝图资产路径 |
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


### 逐字命名：`data-ue-name-verbatim` / `--name-verbatim`

自动命名会把 `data-ue-name` 做 PascalCase（`Button_Left` → `ButtonLeft`），因为那是给人看的。
但**控件名是契约**：蓝图图表绑定的是 `BndEvt__..._Button_Left_K2Node_ComponentBoundEvent_3`，
变量叫 `TextBlock_Switch`——名字一变，把旧图表复制过来就全断。

需要保住名字时加 `data-ue-name-verbatim`（`data-ue-name` 仍写名字）：

```html
<div class="btn" data-ue-name="Button_Left" data-ue-name-verbatim>左</div>
```

- 整页迁移用全局开关 `--name-verbatim`，不必逐元素写；个别元素想回退成 PascalCase：
  `data-ue-name-verbatim="false"`；
- 只替换 UE 装不下的字符（`[^A-Za-z0-9_]` → `_`），**下划线原样保留**，不折叠、不去尾；
  C++ 侧 `SanitizeWidgetName` 本来就保留下划线，所以只有转换器这一处需要改；
- 首字符是数字时补 `W` 前缀（UObject 名要求）；
- **重名会报 error 级警告**：UMG 名字必须唯一，第二个会变成 `Button_Left_1`——那同样会断绑定，
  所以必须让它显眼，而不是静默改名；
- 角色后缀（`_Box`/`_BG`/`_Text`…）不受影响：它们是新增的包装控件，本来就该有新名字。

验收页 `test/20-verbatim-names.html`：同一页里四个元素，两个 verbatim、一个默认、一个显式回退。

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



### 裸类名：`data-ue-class="Overlay"` / `data-ue-class="CommonAnimatedSwitcher"`

类名不必写完整脚本路径，写**裸类名**即可，导入器按这个顺序找：

1. `/Script/UMG.<类名>`、`/Script/Engine.<类名>`（UMG 自己的控件）；
2. **每个已加载的脚本模块**各试一次 `/Script/<模块>.<类名>`（`FModuleManager::FindModules` +
   `FindObject`，不触发加载）——所以 `CommonAnimatedSwitcher` 能找到
   `/Script/CommonUI.` 下的类，不需要硬编码插件名；
3. 再显式 `LoadObject /Script/CommonUI.<类名>`（CommonUI 的类有时尚未加载）；
4. 已经加载的同名类（蓝图生成类以 `_C` 结尾）；
5. 所有已加载控件类的**忽略大小写扫描**。

写蓝图资产路径也行（`data-ue-class="/Game/UI/WBP_Card"`，等价于 `data-ue-widget`）。

**切换器类名都按切换器处理**：类名以 `Switcher` 结尾（`WidgetSwitcher`、
`CommonAnimatedSwitcher`、`CommonActivatableWidgetSwitcher`）时，它的子元素按"页面"排槽位，
不会退化成普通 Box 子节点。

验收页 `test/21-bare-class.html`。

### 10.2 带插槽的复用：`data-ue-named-slot` + `data-ue-slot`

**组件页**里用 `data-ue-named-slot` 声明插槽（产物是 `UNamedSlot`，**widget 名 = 插槽名**）：

```html
<div id="card">
  <div data-ue-named-slot="Header" style="position:absolute;left:0;top:0;width:480px;height:44px"></div>
  <div data-ue-named-slot="Body"   style="position:absolute;left:0;top:56px;width:480px;height:184px"></div>
</div>
```

几条实现细节（都是踩过的坑）：

| 情况 | 行为 |
|---|---|
| 插槽名和别的元素重名（例如 `#body` 也叫 `Body`） | **插槽优先**，其余元素改名 `Body_1`。UMG 的 widget 名是 WidgetTree 子对象名，同名会让 `NewObject` 直接失败并崩编辑器 |
| 插槽里留了多个子元素 | `UNamedSlot` 只收一个，多个自动包一层 `VerticalBox` 并告警 |
| 插槽设计期为空 | 允许（预览为空），运行期照样能填 |
| 组件里插槽底下还有占位文字 | 占位**不会**被清掉，会被盖住——组件页里别放 |

**消费页**再往里塞内容：


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

### 10.6 组件注册表：`--components registry.json`

不想每处手写 `data-ue-widget` 时，用注册表把 CSS 选择器映射到已导入的 WBP：

```json
{
  "components": [
    { "name": "slot-card", "match": ".slotcard, [data-kind=card]",
      "blueprint": "/Game/UI/Html2UMG/Demo/WBP_SlotCard" }
  ]
}
```

```bash
node cli/convert.js page.html -o layout.json --viewport 1000x320 --components registry.json
```

- `match` 支持**复合选择器**：`tag`、`.class`、`#id`、`[attr]`、`[attr=value]`，逗号分隔多个；**不支持**后代/子代组合器；
- 优先顺序：`data-ue-widget`（显式） > `data-ue-component="name"`（按注册表 name 点名） > `match` 选择器；
- 某处不想复用：加 `data-ue-inline`；
- `blueprint` 写**文件夹路径也行**：导入器会补成 `WBP_X/WBP_X.WBP_X_C`（一页一文件夹落盘）；
- 每次认领都会在 warnings 里留一行 `mapped: ... matches component registry selector ...`。

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

---

## 11. 字体回退（`assets.fonts[].fallbacks`）与复合字体

### 11.1 为什么需要这个字段

CSS 的 `font-family: "Segoe UI", sans-serif` 在浏览器里渲染中文是**正常的**：Blink 会把西文字体没有的字形
逐字替换成系统 CJK 字体。UMG 没有这层替换 —— `FSlateFontInfo` 指向**一个**字体文件，缺字就是豆腐块
（`.notdef`）。所以“浏览器看起来没问题”与“UE 里丢字”之间的差，必须由转换器显式记录下来：

```jsonc
"fonts": [
  {
    "key": "font_4",
    "family": "Segoe UI",          // 设计稿请求的家族（第一个）
    "weight": 400,                  // 请求的字重（不是文件的固有字重）
    "italic": false,
    "file": "assets/font_4.ttf",
    "license": "proprietary",       // redistributable | proprietary | unknown（见 11.7）
    "fallbacks": [                  // 可选：为空时整个字段不出现
      {
        "key": "font_5",            // 指向 fonts[] 里另一条普通条目（同 key）
        "family": "Microsoft YaHei",
        "weight": 400,
        "italic": false,
        "file": "assets/font_5.ttc",
        "license": "proprietary",
        "source": "css-stack",      // css-stack | platform | system，仅供调试
        "subface": 0                // 可选：仅 .ttc 且子面索引 > 0 时出现
      }
    ]
  },
  { "key": "font_5", "family": "Microsoft YaHei", "weight": 400, "italic": false, "file": "assets/font_5.ttc" }
]
```

### 11.2 字段语义

| 字段 | 类型 | 说明 |
|---|---|---|
| `key` | string | `font_N`，节点里用 `@font_N` 引用**主**字体；fallback 项同样有自己的 key |
| `family` | string | 主条目 = 设计稿请求的第一个家族；fallback 项 = 实际提供文件的那个家族 |
| `weight` | number | **请求**的字重（100–900）。fallback 文件常常只有一个面（如 Noto Sans SC 只有 Regular），此时该字段描述的是“它要顶替的槽位”，不是文件的固有字重 |
| `italic` | bool | 同上，描述槽位；中文字体一般没有真正的斜体文件 |
| `file` | string | 相对 json 目录的路径（也接受绝对路径）。多个条目**可以共用同一个 file**（同一物理文件只拷一份） |
| `subface` | int，可选 | `.ttc`/`.otc` 集合内的面索引，语义等于 UE 的 `FFontData::SubFaceIndex`（FT face index）。**集合文件总是输出（0 也输出）**，单面 `.ttf/.otf` 从不输出：这样“显式面 0”与“没给”可区分（导入器侧缺省 -1 = 未给）。不同面的 hhea/OS-2 不同（msyh.ttc：面 0 = Microsoft YaHei，Slate 行盒/字号 1.3125；面 1 = Microsoft YaHei UI，1.2500），行高必须按**选中的面**算 |
| `license` | string | `redistributable`（OFL/UFL/Apache，可随包分发）/ `proprietary`（微软雅黑、宋体、等线、黑体、Segoe UI 等）/ `unknown`（页面自带 `@font-face` 文件，授权无法自动判定）。见 11.7 |
| `fallbacks[]` | array，可选 | 回退链，顺序即优先级（浏览器回退顺序：platformFonts 命中 → CSS 栈 → 系统表）；**为空时不出现该字段** |
| `coverage` | array，可选 | 该回退字体**负责的码点区间**，**闭区间** `[[first,last],...]`（两端都含），整数码点。同一主字体的多个 fallback 之间**互不重叠**。见 11.6 |
| `fallbacks[].source` | string，可选 | `css-stack`（CSS 家族里排在后面的那个）/`platform`（浏览器实际用到的系统字体，来自 `CSS.getPlatformFontsForNode`）/`system`（系统已知中文字体兜底）。调试与审计用，导入器可忽略 |

**每个 fallback 同时是 `fonts[]` 里的一条普通条目**（key 相同），所以导入器只需：主字体建 `UFont` →
对每个 fallback 按 key 找到条目 → `ImportFontFace` → 加进 `FCompositeFont::SubTypefaces`。
子字体的 `FTypefaceEntry` 名字由 `{weight, italic}` 推出（`weight >= 600` → Bold；italic → Italic / BoldItalic），
必须与文本实际请求的 `TypefaceFontName` 一致，否则 Slate 不会去子字体里找字形。

### 11.3 区间（CharacterRanges）

转换器判定“需要回退”的码点区间（CJK 判定与 `font-check.js` 用的是同一张表）：

| 块 | 区间 |
|---|---|
| 中日韩标点 | U+3000–U+303F |
| 假名 | U+3040–U+30FF |
| 扩展 A | U+3400–U+4DBF |
| 统一表意文字 | U+4E00–U+9FFF |
| 兼容表意文字 | U+F900–U+FAFF |
| 全角形式 | U+FF00–U+FFEF |

子字体的 `CharacterRanges` 建议覆盖上表的**并集**（再加 `U+2E80–U+2FDF` 部首与 `U+20000–U+2FA1F` 扩展 B，
如果字体文件确实有——有没有由 cmap 决定，不要假设）。区间是**闭区间**，与 `FCharacterRange` 的
`(First, Last)` 语义一致，两端点都包含。

### 11.4 判定顺序（谁被选中）

1. **cmap 覆盖率第一**：解析字体文件自带的 `cmap`（format 4 / 12；`.ttc` 按**实际选中的子面**读，不同面的 cmap
   不同），文本的码点必须真的在这个文件里，家族名像中文字体不算证据。
2. 候选优先级：**浏览器 `platformFonts` 实际命中的家族** → CSS 栈里其他家族（含 `@font-face`）→ 系统表
   （中文：Microsoft YaHei → Noto Sans SC → SimHei → DengXian；衬线优先 SimSun / Noto Serif SC）。
   浏览器实际用的那个家族排第一，是因为它同时决定了字形轮廓与竖直度量：实测同一页把中文回退改成
   Noto Sans SC 后像素差异 15.86%、`Δtop` 最大 +50px（整页位移）；改用浏览器真正用的 Microsoft YaHei
   后差异 12.80%、`Δtop` 仅 1px。CSS 里写了 `"Noto Sans SC"` 但 Windows Chromium 实际用雅黑渲染中文时，
   转换器会打一条 info：`CSS asks for "X" but the browser rendered this text with "Y"`。
5. 家族级抽样门槛（快速否决，逐码点校验仍是最终依据）：常用 39 个字命中率 ≥95% 且 CJK 抽样 ≥90%
   才允许当回退，否则跳过并 warn（附命中/总数）。这条专治“名字像中文字体但覆盖不全”的字体
   （例如 NotoSansJP 对简体常用字只覆盖 33/39 ≈ 84.6%，等距逐码点校验会放过个别句子）。
3. 先找**完整覆盖**的候选；都覆盖不全时才接受覆盖最多者，并发一条带数字的 warning
   （`covers only n/m code point(s)`）。
4. 日文面（Noto Sans JP / Source Han * JP / Yu Gothic / Hiragino / Meiryo / MS PGothic…）**禁止**用作中文回退：
   实测简体覆盖只有 ~61%（NotoSansJP 12747/20992），除非文本里真的有假名（U+3040–U+30FF）或 CSS 显式指定。
   被拒绝时同样发 warning 说明原因。

### 11.5 兼容规则

* **老 JSON 没有 `fallbacks`**：等价于“没有回退”，导入器按原逻辑走（单 `UFont`）。
* **老 JSON 没有 `subface`**：等价于 `0`（`.ttc` 的第一个面）。
* **纯西文页面**：`fallbacks` 为空 → 字段不写，`assets.fonts` 与引入本特性前逐字节相同（9 个测试页已回归验证）。
* `fallbacks` 里指向的条目**一定**也在 `fonts[]` 中；导入器不要只遍历 `fallbacks` 而跳过普通条目，
  否则会重复导入同一个文件或漏掉主字体。
* `characterRanges` 之类的“怎么用区间”属于导入器决定，转换器只保证“这段文本确实需要这些码点”，
  所以导入器使用比上表更宽的区间是安全的（多余区间不会命中没有字形的码点）。


### 11.6 `coverage`：谁负责哪些码点

```jsonc
"fallbacks": [
  { "key": "font_5", "family": "Microsoft YaHei", "coverage": [[12288,12543],[13312,19455],[19968,40959],[65280,65519]] },
  { "key": "font_9", "family": "Noto Sans SC",    "coverage": [[63744,64255]] }
]
```

**为什么必须有这个字段**：Slate 处理复合字体时，区间重叠的规则是“小者优先、同大小先声明者胜”；
一旦命中的子字体没有该字形，它会**直接跳到 FallbackTypeface**（引擎默认回退），不会再试下一个子字体。
所以如果两个子字体都声明 `0x4E00-0x9FFF`，第二个永远不会生效；而子字体的顺序来自 `TMap` 迭代（哈希序），
也不是转换器的优先级顺序。转换器在 JSON 里把区间切成**互斥**的块，导入器照抄即可，不必猜。

**语义**

| 项 | 规则 |
|---|---|
| 类型 | `[[first, last], ...]`，**闭区间**（两端都含），整数 Unicode 码点。`4E00–9FFF` 写成 `[19968, 40959]` |
| 归属 | 每个区间只属于一个 fallback；所有 fallback 的区间合起来是“回退字体共同负责的码点集合” |
| 顺序 | `fallbacks[]` 的顺序 = 优先级（浏览器回退顺序），与 `coverage` 不重叠这一事实无关 |
| 缺省 | 老 JSON 没有该字段 → 导入器退回旧行为（按固定 CJK 区间表给每个 fallback 都声明一份） |
| 空数组 | 不输出；**拿不到任何区间的 fallback 会被转换器直接丢弃**（连文件都不拷），避免产生“声明了却永远不生效”的子字体 |

**分配算法**（转换器侧，`assets.js#_assignFallbackCoverage`）

1. 以标准 CJK 块为粒度：标点 `3000-303F`、假名 `3040-30FF`、扩展 A `3400-4DBF`、
   统一表意 `4E00-9FFF`、兼容表意 `F900-FAFF`、全角 `FF00-FFEF`。
2. 先按“这段文本真正缺的码点”决定：某块归**能画出最多缺失码点**的那个 fallback（并列则按优先级）。
3. 没有缺失码点的块，归第一个对该块 cmap 覆盖率 ≥60% 的 fallback（为“以后改文案”留余量）。
4. 一块只归一个字体；相邻且同属一个字体的块合并成一条区间，跨空洞不合并。
5. 块内只部分覆盖（≥60% 但 <100%）时整块归它，并打 info 说明“缺口由 FallbackTypeface 兜底”。

### 11.7 字体授权与分发

转换器会把字体文件拷进 `assets/`，导入器把每个文件做成 `UFontFace`（bulk data 内嵌），
也就是说**字体会随游戏包一起分发**。微软雅黑 / 宋体 / 等线 / 黑体 / Segoe UI 这类系统字体不允许无条件随包分发；
Noto Sans SC、Noto Serif SC、Source Han Sans（思源）是 OFL，可以自由分发。

因此 `assets.fonts[]` 每条（含 fallback 项）都带 `license`：

| 值 | 含义 | 本项目里已知的例子 |
|---|---|---|
| `redistributable` | OFL / UFL / Apache 等，可随包分发 | `NotoSansSC-VF.ttf`、`NotoSerifSC-VF.ttf`、`SourceHanSans*.otf` |
| `proprietary` | 商业/系统字体，随包分发有授权风险 | `msyh*.ttc`、`simsun*.ttc`、`Deng*.ttf`、`simhei.ttf`、`segoeui*.ttf`、`arial*.ttf` … |
| `unknown` | 页面自带的 `@font-face` / `data:` 字体，转换器无法判定授权 | 设计稿里内嵌的 webfont |

**默认行为不变**：仍然嵌入（`--font-policy=any`），但转换结束时会打印一段醒目的
`font-license` 提示，列出被嵌入的非可再分发字体（家族 + 文件 + 主字体/回退）与替换建议。
这段提示**不写进 `layout.json` 的 `warnings`**：里面往往包含 Segoe UI 这种每页都在用的字体，
如果计入 warnings，任何 `--strict` 的 CI 都会从“通过”变成“失败”，那不是这个提示该做的事。
机器可读的信息在 `license` 字段里，下游可以自己决定怎么处理。

**严格模式**：`--font-policy=redistributable` 会拒绝嵌入 `proprietary`/`unknown` 字体，
改用可再分发的候选（中文顺序变成 Noto Sans SC → SimHei → DengXian，且不再考虑 .ttc 集合），
每条跳过都会 warn 说明“因授权策略跳过 X，改用 Y”。此时若 Latin 字体没有 OFL 替代，
主字体会退化成引擎默认字体（同样有 warn）——这是该模式的语义，不是 bug。

```bash
# 默认：忠实还原浏览器，同时提示授权风险
node cli/convert.js design.html -o out/layout.json --assets out/assets

# 发布前自检：只允许可再分发字体
node cli/convert.js design.html -o out/layout.json --font-policy=redistributable
```

### 11.8 审计工具

```bash
node Plugins/Html2UMG/Resources/Converter/test/font-check.js C:/out/demo/layout.json
```

按条目打印主字体覆盖率、主+回退覆盖率、每条文本的样本，并汇总：需要 CJK 的文本数、拿到回退的条数、
落盘文件数、仍然未覆盖的码点数（>0 时退出码为 2）。

