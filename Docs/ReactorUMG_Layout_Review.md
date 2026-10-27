# ReactorUMG 布局 / 导入 / 样式应用 评审（对照 Html2UMG）

> 目的：把 ReactorUMG 的"布局 → 控件 → 样式 → 资产"做法挖出来，对照我们
> Plugins/Html2UMG 的 mapper/bake/importer，给出可落地的改进清单。
> 结论先行：**它的布局思路（把 flex 交给 Slate 槽位规则）不适合我们照搬，但它的"布局完成后读回实测几何再修正"这条闭环，正是我们长文档累计高度缺口缺的那一环；其余（样式、字体、资产、效果）它全面落后于我们。**

---

## 0. 证据边界（先读这段，否则 A/B 节的行号会找不到）

- 参考仓库：`ReactorUMG`，commit `83f866c`（2026-02-04），插件版本 `1.0.0`，
  `PlatformAllowList` 仅 `Win64`（`ReactorUMG.uplugin:17-37`），MIT。
- **这个仓库里没有布局引擎。** `Source/ReactorUMG` + `Source/ReactorUMGEditor` 合计只有 **4,238 行**
  （`find … -name '*.cpp' -o -name '*.h' | xargs wc -l`），内容只有：Puerts 环境引导、`UReactorUIWidget` 壳、
  蓝图编译器、`.d.ts` 生成器。真正的 React→UMG 转换器是 npm 包 `reactorumg@1.0.5`
  （`Scripts/Project/package.json:18`；仓库里 `Scripts/Project/src/` 只有 `types/`，库里代码靠 `node_modules`）。
- 好消息：该 npm 包**随包发布 .ts 源码**（不是 min 产物）。我用 jsdelivr 只读拉了 36 个 `.ts` 到临时目录
  （`%TEMP%/rumg`）分析，**未修改参考项目，未往我们工程拷任何资产/代码**。
- 因此本文证据有两种标注：
  - `Source/…:行` = 克隆仓库内的 C++；
  - `reactorumg@1.0.5/<path>.ts:行` = 发布包源码（行号 = 该 `.ts` 文件的实际行号）。
- 文中所有"它没做 X"，都是对该包全部 `.ts` + 仓库全部 C++ 做 grep 0 命中的结果，不是推测。

---

## A. ReactorUMG 的布局 / 导入架构（一页纸）

### A.1 定性：它是"React 运行时渲染器"，不是"设计稿→资产"的转换器

- WBP 只是壳：`UReactorUIWidget::SetNewWidgetTree()` 在每次 `Initialize()` 时把一个
  `RF_Transient` 的 `UWidgetTree` 换上去，然后跑 TS 脚本去"现场建树"
  （`Source/ReactorUMG/Private/ReactorUIWidget.cpp:35-63`）。
- 建树 = 起一个 Puerts JS 环境 + 把 `WidgetTree` 指针传进 JS
  （`ReactorUIWidget.cpp:73-123`，参数见 `:77-87`）。
- 所以：**没有 layout.json，没有离线测量，没有导入步骤**；"导入"就是"运行脚本"。产物的保真度取决于
  Slate 当场算出来的结果。这也是它 README 自己限定"现阶段建议只用于编辑器工具 UI"的原因
  （`README.md:16`）。

### A.2 链路（一次 React 渲染到 UMG）

```
React 树
 └─ react-reconciler host config          reactorumg@1.0.5/renderer.ts:231-312
     createInstance(typeName, props)      → UMGWidget                 renderer.ts:240-242
     createTextInstance(text)             → UMGWidget("text", …)      renderer.ts:243-245
     appendInitialChild / appendChild     → converter.appendChild()   renderer.ts:237-239
 ├─ createElementConverter(typeName)      converter.ts:148-196
 │   style/div/grid/canvas/overlay…  → ContainerConverter             converter.ts:142,178-183
 │   button/input/text/img/progress…  → JSXConverter                  converter.ts:185-190
 │   其它（UMG 控件名）                → UMGConverter                 converter.ts:192-195
 ├─ ContainerConverter：三级包装（这是它最值得看的一段）
 │   ① proxy = Flex/Grid/Canvas/Overlay/UniformGrid 容器
 │   ② setupBackground → UBorder（背景色/背景图）
 │   ③ setupBoxSize    → USizeBox（声明的 width/height + min/max + aspectRatio）
 │   ④ setupBoxScale   → UScaleBox（objectFit）
 │                              container_converter.ts:279-306（顺序）/ 74-131 / 133-193 / 195-229
 └─ 建完就完事：没有任何"布局完成后回灌/修正"的常规通道
```

### A.3 五个研究问题的直接答案

| 问题 | 答案（有证据） |
|---|---|
| 自己算像素再绝对定位，还是映射到 UMG 槽位规则？ | **映射槽位规则**。flex → `HorizontalBox`/`VerticalBox`/`WrapBox`（`flex.ts:271-297`），children 的 flex 语义写成槽属性（`flex.ts:335-352`）。**没有 Yoga**：该包依赖只有 `react` + `react-reconciler`（`reactorumg@1.0.5/package.json` dependencies），grep `yoga|flexbox|css-layout` 全包 0 命中；横向尺寸的求解完全交给 Slate。 |
| flex-grow / shrink / basis | **只有 grow**：`flex-grow`（或 `flex` 里第一个数字）→ `SlateChildSize(grow, Fill)`（`flex.ts:114-149`，`:212-213`）。`flexShrink`/`flexBasis` 全包 **0 命中**：CSS 默认的"压缩以适配"完全不实现。 |
| align-items / justify-content | 逐子项写成槽 Alignment（`alignment_parser.ts:65-149` + `flex.ts:151-183`）。`space-between` 被折成"每子项 Fill 权重 = flex-grow"（`flex.ts:157-162`）；`center`/`flex-end` 只是把每个子项在**自己的份额内**对齐，对自动尺寸的子项等于**没生效**（HBox 里 Auto 槽只分到 desired 宽度，再对齐无富余）。 |
| gap | 不是容器属性，是**槽 padding**：非首子项在主轴上 +mainAxisGap（`flex.ts:222-248`）；WrapBox 用 `SetInnerSlotPadding`（`flex.ts:250-269`）。Grid 用"每格两侧各半 gap，且只加在内边"（`grid.ts:443-450`）。 |
| 百分比尺寸 | **基本不处理**。`SizeBox` 分支把 `width/height` 直接换算，换算函数在没有 referenceSize 时**返回 0**，而 0 又被 `if (widthPx !== 0)` 跳过 → 百分比宽高被**静默丢弃**（`container_converter.ts:149-159` + `css_length_parser.ts:79-85`）。`vw/vh` 直接当 0（`css_length_parser.ts:96-99`，注释自陈"目前无法在非运行时下获取到画布大小"）。只有 CanvasPanel 会拿容器尺寸做参考（`canvas.ts:210-217`，且仅当容器自身有 px 宽高）。 |
| text measure 走哪条路 | **纯 Slate**：`AutoWrapText`（`text.ts:274-275`）、`SlateFontInfo`，无 JS 侧估宽。它甚至**没有 px→pt 换算**（字号原样塞，见 D2）。唯一读回实测的地方是 Overlay 的绝对定位：`GetWidgetScreenPixelSize` → 失败回退 `GetDesiredSize`，并且用 `setTimeout` 每 2s 重试、最多 10 次（`overlay.ts:103-136`）。 |
| 有没有两段式（先测量后修正） | **有一个"非正式"的两段式**：Overlay 里没有绝对定位容器，于是等 Slate 布局完成后读回父/子像素尺寸，再把 `left/top` 落成 `OverlaySlot` 的 `Padding`（`overlay.ts:146-168`）。这是全项目唯一的"实测回灌"，而且是轮询式的、只服务 Overlay。除此之外没有。 |


### A.4 关键文件索引

| 关注点 | 文件 | 说明 |
|---|---|---|
| 元素→转换器分派 | `reactorumg@1.0.5/converter.ts:142-196` | 标签名白名单决定容器/JSX/UMG 三条路 |
| 容器分派（flex/grid/overlay/canvas） | `container/container_converter.ts:54-72` | div 默认 `display:flex`，`position:relative` → Overlay，其余 → flex |
| flex 槽位规则 | `container/flex.ts:202-220, 222-248, 319-352` | grow→Fill、gap→Padding、wrap→InnerSlotPadding |
| 对齐映射 | `parsers/alignment_parser.ts:4-30, 65-149` | CSS 关键字 → EHorizontalAlignment/EVerticalAlignment |
| 绝对定位/锚点 | `container/canvas.ts:17-48, 94-208` | 预设 20 种 `positionAnchor` → FAnchors + Offsets |
| 相对容器内的绝对定位 | `container/overlay.ts:56-86, 93-168` | left/top→slot Padding，含 `translate()` 累加 |
| grid | `container/grid.ts:57-130, 175-201, 443-450` | 轨道定义 → `SetColumnFill/SetRowFill` |
| 样式级联（不用 computed style） | `parsers/cssstyle_parser.ts:198-223` | type < attr < class < 父后代 < id < inline |
| `<style>` 标签支持 | `jsx/style.ts:56-59` + `parsers/inline_style_registry.ts:62-80` | 把 CSS 文本注册进全局表 |
| 背景/圆角 | `parsers/css_background_parser.ts:331-416`、`parsers/brush_parser.ts:96-138` | 只有纯色/贴图/FSlateBrush outline |
| 字体 | `parsers/css_font_parser.ts:187-267`、`Source/ReactorUMG/Private/UMGManager.cpp:185-204` | 家族名找 UFont，回退 Roboto |
| 贴图 | `Source/ReactorUMG/Private/UMGManager.cpp:221-246, 314-377` | 运行时 `ImportFileAsTexture2D` / HTTP |
| 属性写入 | `umg/native_widget_converter.ts:50-69` + `UMGManager.cpp:36-44` | `puerts.merge(widget, props)` → `SynchronizeProperties()` |
| 实测几何读回 | `UMGManager.cpp:206-219, 440-472` | `GetWidgetGeometrySize` / `GetWidgetScreenPixelSize` / `GetCanvasSizeDIP` |
| 编辑器入口 | `Source/ReactorUMGEditor/Private/ReactorUMGEditor.cpp:63-109, 123-157, 196-234` | 只有 TS 模板复制 + d.ts 生成 + 编译器注册；**没有任何 importer/asset action 做布局导入** |
| TS 声明生成 | `Source/ReactorUMGEditor/Private/WidgetDeclarationGenerator.cpp:57-82, 161-200` | 反向：UMG 类 → TS 类型（不是布局导出） |

### A.5 它的"中间格式"：没有文件，只有 TS 类型（字段 → 语义 → UMG 属性）

它没有 layout.json 这类可 diff 的契约；能称得上"中间格式"的只有 `index.d.ts` 里的
`Style` / `CommonProps` / `PanelProps`（`reactorumg@1.0.5/index.d.ts:41-120`）。抄成表：

| 字段（TS） | 语义 | 落到哪个 UMG 属性 | 备注 |
|---|---|---|---|
| `width`/`height`/`min*`/`max*` | 声明尺寸 | `USizeBox::WidthOverride/HeightOverride/Min/MaxDesired*`（`container_converter.ts:133-193`） | `auto` 才不加 SizeBox；**百分比被丢** |
| `aspectRatio` | 宽高比 | `SizeBox::Min/MaxAspectRatio` | `16/9` 与 `0.5` 都支持（`css_length_parser.ts:184-205`） |
| `flex`/`flexGrow` | 主轴权重 | `SlateChildSize{Fill, grow}`（`flex.ts:212-213`） | shrink/basis 无 |
| `gap`/`rowGap`/`columnGap` | 间距 | 槽 `Padding`（box）/`WrapBox::InnerSlotPadding`/Grid 半 gap | `gap: row col` 顺序被正确交换（`css_margin_parser.ts:133-137`） |
| `margin` / `padding` | 外边距/内边距 | **两者写同一个 slot 的 Padding，padding 后写覆盖 margin**（`container_converter.ts:263-277`） | 同时给两个 → margin 丢失 |
| `justifyContent`/`alignItems`/`alignSelf`/`justifySelf` | 对齐 | 槽 `Horizontal/VerticalAlignment` | center/end 对自动尺寸子项无效（A.3） |
| `position`/`left`/`top`/`right`/`bottom` | 定位 | `OverlaySlot.Padding`（父为 Overlay）/ `CanvasPanelSlot.Position+Size`（显式 Canvas） | 只有 `position:relative` 的父才会变 Overlay（`container_converter.ts:62-67`） |
| `positionAnchor`/`offsetAnchor` | 锚点（**非 CSS**，自有扩展） | `CanvasPanelSlot::SetAnchors` | 20 种预设串（`canvas.ts:17-48`） |
| `zIndex`/`zOrder` | 层序 | `CanvasPanelSlot::ZOrder`（`canvas.ts:197-205`） | 仅 Canvas 分支 |
| `overflow`/`overflowX/Y` | 溢出 | **无消费者**：`index.d.ts:103-105` 声明，全包无读取 | 用自有值 `visibility:"clip"` 代替（`container_converter.ts:231-237`） |
| `objectFit` | 图片填充 | `ScaleBox::Stretch`（`container_converter.ts:195-229`） | `contain/cover/fill/none/scale-down` |
| `opacity`/`transform`/`translate`/`rotate` | 渲染变换 | `RenderOpacity`/`RenderTransform`/`Translate`（`converter.ts:18-47`） | 走 `puerts.merge` + `SynchronizeProperties` |
| `visibility` + `hitTest` | 可见/命中 | `ESlateVisibility`（`common_props_parser.ts:379-412`） | **hitTest 分支缺 break，永远落 Visible**（`:400-409`） |
| `gridTemplateColumns/Rows`、`gridRow/Column` | 网格轨道/占位 | `GridPanel::SetColumnFill/SetRowFill` + `GridSlot::Row/Column/Span` | px 轨道被换成比例权重（见 D3） |
| `background[Color/Image/Size/Repeat/Position]` | 背景 | `UBorder` 的 brush（`container_converter.ts:74-131`） | 无渐变、无阴影 |
| `fontSize/lineHeight/letterSpacing/fontWeight…` | 字体 | `SlateFontInfo`（`css_font_parser.ts:187-267`） | 字号不换算 pt、行高不换算倍数（见 D2） |
| `display` | 容器类型 | `grid` → GridPanel；其余 → flex（`container_converter.ts:54-72`） | 不支持 inline-*/table |


---

## B. 逐项对照表

> 我们现状的证据统一指向 `Plugins/Html2UMG/Resources/Converter/src/mapper.js`（下称 mapper）以及
> `Docs/Html2UMG_LayoutContract.md`；当前像素差异取自 `项目内的踩坑记录:68-83`。

| # | 能力 | ReactorUMG 做法 | 我们 Html2UMG 现状 | 差距 | 建议 |
|---|---|---|---|---|---|
| B1 | 布局求解主体 | 不自算像素，flex 全交给 Slate 槽位（`flex.ts:202-220`） | Chromium 实测 + CanvasPanel 绝对坐标为主，flex 容器用 Box 槽（mapper:466-569） | **路线不同**：它响应式但保真低；我们保真高但尺寸是"设计尺寸快照" | 不换路线；只借它的槽位语义经验（gap/对齐/百分比），不借它的求解方式 |
| B2 | flex-grow | `SlateChildSize(grow, Fill)` | 同（mapper:499-509），并额外处理 Fill 与主轴对齐的联动（mapper:527-544） | 我们更细：我们知道 Fill 槽若不把主轴也设 Fill 会被按 desired 排列（CONTEXT:43） | 保持 |
| B3 | flex-shrink / basis | **不支持**（全包 0 命中） | 不支持，但被实测兜底（子项宽度来自 snapshot） | 双方都缺 | 不抄；若要补，见 C5（自定义 panel） |
| B4 | gap | 槽 padding（首子项不加）/ WrapBox InnerSlotPadding / Grid 半 gap | 槽 padding 只加尾边（mapper:486-490）；Grid 加在尾边、末列不加（CONTEXT:65） | 我们更准（首列不被推偏） | 保持；Grid 半 gap 是明确的反面教材（D4） |
| B5 | justify-content: space-* | 折成每个子项 Fill 权重（`flex.ts:157-162`）——会把子项拉宽 | 用**实测** inter-child gap 写进每个槽 padding（mapper:473-482, 2655-2665），并注释说明是"设计尺寸下的近似" | 我们更准 | 保持，并把同一套实测思路推广到 center/end（C2） |
| B6 | justify-content: center/flex-end | 每子项在自身份额内对齐 → 自动尺寸子项**实际无效**（A.3） | 同样是主对齐（mapper:2855-2870 → boxSlot:515-544），对自动尺寸子项也不产生"整组偏移" | 双方都不真 | **C2**：用实测首子项偏移量写进首槽 padding |
| B7 | 百分比尺寸 | SizeBox 里静默丢弃（`container_converter.ts:149-159`）；`vw/vh` 恒 0 | 主轴上百分比 → Fill 权重（mapper:504-505）；交叉轴上钉成实测 px 并 warn（mapper:1137-1156） | 我们更好 | 保持；可选开关见 C3 |
| B8 | 文字测量 | Slate 现场算 + AutoWrapText（`text.ts:274-275`） | Chromium 实测 + 字号/行高换算（mapper:1562-1615，CONTEXT:40-41） | 我们更好 | 保持 |
| B9 | 两段式（测→建→再修正） | 仅 Overlay：布局后读 `GetWidgetScreenPixelSize`，`setTimeout` 轮询重试 ≤10 次（`overlay.ts:103-136`） | **完全没有**：已有 `Html2UMG.ImportRenderGeometry` 产出几何（`Html2UMGFidelity.cpp:51-111`），但没人把它回灌给 mapper；长文档只能靠 `--pin-flow` 冻结叶子（mapper:2625-2640） | **这是我们唯一明显落后的点** | **C1（最高价值）** |
| B10 | 控件选择 | 标签白名单 + display/position 二分（`converter.ts:142-196`，`container_converter.ts:54-72`） | `classify` + `classifyInput` + `childItems`（mapper:1259-1340），含 table/自定义控件/自绘控件识别 | 我们更全 | 保持 |
| B11 | 溢出滚动 | `overflow` 只声明不实现；ScrollBox 只能手写 `<ScrollBox>` | `wantsScroll` → ScrollBox（mapper:1236-1250） | 我们更好 | 保持 |
| B12 | 圆角 | `RoundedBox` outline；四角顺序映射错误（`brush_parser.ts:100-106`：X=top,Y=bottom,Z=left,W=right，Slate 实为 TL/TR/BR/BL） | `cornerRadii` 直接给 `FVector4`，并强制"有边框就 RoundedBox"（CONTEXT:58-62） | 我们更好 | 保持（D6） |
| B13 | 边框 | 仅 `FSlateBrush outline` 一圈；非实线/多色/单边无处理（`brush_parser.ts:96-138`） | 单边/不等宽/多色按条件烘焙，四边同宽走 outline（mapper:1690-1830） | 我们远超 | 保持（D6） |
| B14 | 渐变/阴影/模糊 | **全包 0 命中**（gradient / shadow / backdrop-filter） | 烘焙贴图 + 原生 BackgroundBlur（CONTEXT:51-56） | 我们远超 | 保持（D1） |
| B15 | 字体 | 插件内 `UFont` 资产按家族名查找，回退 `Roboto`（`UMGManager.cpp:185-204`）；字号原样塞 px（`css_font_parser.ts:189-191`）；行高原样塞倍数（`text.ts:179-185`） | px→pt（96/72）、行高 ÷1.0625、Typeface 名映射（CONTEXT:40-41） | 我们更好 | 保持（D2/D5） |
| B16 | 资产 | 运行时 `ImportFileAsTexture2D` 生成 **transient** 贴图（`UMGManager.cpp:314-343`），也支持 HTTP（`:345-377`）；无 .uasset 管线 | 内容寻址命名 + 强制格式 + 每次重导（CONTEXT:48-49） | 我们更适合"发布级 WBP" | 保持（D1） |
| B17 | 属性写入 | `puerts.merge(widget, props)` + `SynchronizeProperties()`（`native_widget_converter.ts:50-69`，`UMGManager.cpp:36-44`）：键名就是 UMG 属性名，**无类型校验** | JSON 反射写入 + 按目标属性类型解释 + 默认值归一（`Html2UMGPropertyApplier.cpp`，契约 §3） | 我们更稳（契约可 diff/可手写） | 保持（D9） |
| B18 | 中间格式 / 契约 | 无文件；TS 类型即契约（`index.d.ts:41-120`），不可 diff、不可手写 | `layout.json` + `contractVersion`（`Docs/Html2UMG_LayoutContract.md:13-30`） | 我们是对的方向 | 保持 |
| B19 | 组件复用 | 复用 = 复用 JS 组件（React 语义），产物里没有共享资产 | `data-ue-widget` / `data-ue-slot` / `data-ue-partial`（契约 §10） | 等价甚至更贴合 UMG | 保持 |
| B20 | 产品形态 | WBP 里存脚本路径，运行时跑 JS（`ReactorUIWidget.cpp:35-63`）；发货要打包 `JavaScript` 目录（README FAQ） | 原生 WBP 静态资产，运行期**零依赖**（CONTEXT:5） | 我们符合项目目标 | 保持（D1） |


---

## C. 可落地改进清单（按价值排序；由 lead 派单，本次不改代码）

> 通用说明：所有"预期收益"都给验证命令，不写死数字。`P=` 表示
> `node Plugins/Html2UMG/Resources/Converter/cli/convert.js`；`U=` 表示编辑器
> `-ExecCmds=Html2UMG.ImportRenderGeometry …`；审计用 `Resources/Tools/visual_audit.py`
> （完整流程见 `项目内的踩坑记录:7-19`）。

### C1（最高价值）布局实测回灌：convert → 渲染 → 读几何 → 二次修正

> **已落地离线原型（task-8）**：`Plugins/Html2UMG/Resources/Tools/residual_correct.py` +
> `Docs/Html2UMG_Residual_Correction.md`（输入输出格式、启发式判据、二次 convert 接入点、C2 补丁说明）。
> 下面是最初的设计描述，实际行为以那份文档为准。

- **动机（来自 ReactorUMG）**：它唯一有效的保真手段，就是布局完成后读回实测几何再改槽属性
  （`overlay.ts:103-168`）。我们有更强的静态管线，却没有这条闭环。
- **改哪里**
  1. 新增 `Plugins/Html2UMG/Resources/Tools/layout_calibrate.py`（新文件，不动现有工具）：
     - 输入：`layout.json`、几何 dump（`Html2UMG.ImportRenderGeometry` 的 `{name,parent,x,y,w,h,painted}`，
       结构见 `Html2UMGFidelity.cpp:82-96`）、以及转换期 snapshot（`src/snapshot.js` 的每元素 rect）。
     - 逐层比较 `slate.h vs browser.h`、`slate.y vs browser.y`；只接**同一父容器下、竖向流**的误差，
       并算**残差**而不是绝对值：`residual = browserBottom - slateBottom`。
     - 输出 `corrections.json`：`{"<nodeName>": {"pinHeight": 123.0, "padTop": -2.5, "textLineHeight": 1.29}}`。
  2. `src/mapper.js` 新增 `applyCorrections(corr)`，在 `readStyle()`（mapper:166-311）末尾消费：
     - `pinHeight` → 复用现有 `rec.h2uFlowHeight` 通道（mapper:243-245、2629-2640），但**只对残差超阈值的节点**置位，
       其余保持自动——这正是它优于 `--pin-flow`"全叶子冻结"的地方；
     - `padTop` → 叠加进 `boxSlot` 的 `Padding[1]`（mapper:488-490）；
     - `textLineHeight` → 覆盖 `lineHeightPercentage()`（mapper:1562-1576）的全局 1.0625 系数，改成 per-fontSize 表。
  3. `cli/convert.js` 增加 `--corrections <file>`，默认关（保证现有 0.38% 级别的页面不受影响）。
- **预期收益**：真实设计 `game-ui 1920x7081` 现在 7.97%（`--pin-flow` 4.81%）。回灌把"冻结叶子"换成
  "按残差选择性钉高"，应当 **≤ 4.81%** 且不再伤 flex 页面（`--pin-flow` 的副作用正是全页冻结，CONTEXT:94）；
  `03-dashboard 3.05%` 这类"长竖向流 + 若干 flex 子项"的页面最有希望进 2% 以内。
  **必须实测**：`P=…test/03-dashboard.html -o C:/out/a.json --corrections …` 前后各跑一次 `visual_audit.py`。
- **风险**：① 多一次 UE 渲染（每页约 +30s）；② 与 `--pin-flow` 同样只在设计尺寸精确（"用测量换响应性"的固有代价，
  要写进文档）；③ 几何 dump 对未绘制控件给 `painted:false`（`Html2UMGFidelity.cpp:93-95`），必须先过滤，
  否则会把 0 当实测值。
- **工作量**：2–3 天（工具 1 天 + mapper 0.5 天 + 10 个测试页回归 1 天）。

### C2 justify-content: center / flex-end 用实测首偏移落成槽 padding

- **动机**：`mapJustify` 把 center/end 映射成"每个子项的主轴对齐"（mapper:2855-2870 → boxSlot:515-544）。
  对自动尺寸子项，Slate 分到的就是 desired 尺寸，再对齐没有富余 → 整组不动。ReactorUMG 同样栽在这里（A.3），
  所以这是"它没解、我们能解"的项。
- **改哪里**：`buildFlowContainer`（mapper:2616-2623）现在只在 `justify` 以 `space` 开头时算 `measuredMainGaps`；
  扩成 `measureMainPlacement(items, vertical)`，额外返回 `leading = 首子项实测位置 - 容器内容起点`（和 `trailing`），
  在 `boxSlot` 里：首元素 `Padding[vertical?1:0] += leading`，末元素 `Padding[vertical?3:2] += trailing`。
  与现有 `measuredMainGaps` 同源（snapshot rect），不新增测量。
- **预期收益**：`01-flex`（1.49%）里居中/右对齐的块、`03-dashboard`（3.05%）的卡片组；预估 0.3–1.0 个百分点，
  面积占比决定。量化方式同上（改前/改后各跑一次 `visual_audit.py`）。
- **风险**：低。与 space-* 一样属于"设计尺寸下精确"的近似，且已有 `warnings` 可标注。
- **工作量**：0.5 天。

### C3 交叉轴百分比：从"钉 px"升级为"可选 Fill 权重 + SizeBox 钳制"

- **动机**：ReactorUMG 的 grid 把 px 轨道换成比例权重（`grid.ts:120-127`），方向对但换算错（D3）；
  我们相反——交叉轴百分比一律钉成实测 px 并 warn（mapper:1143-1153；CONTEXT:91 记了 4 次）。
- **改哪里**：`crossAxisPercentPx`（mapper:1137-1156）加分支：`--percent-fill` 开启时，对 `orientation==="v"` 的父容器，
  子项交叉轴用 `Fill`，并把百分比写成父容器的 `SizeBox` 宽度上限（`maxWidth = pct * parentWidth`），由 SizeBox 钳制。
  **注意**必须同时清掉 `explicitOnCross` 的反向逻辑（mapper:523-526），否则两条规则打架。
- **预期收益**：真实设计里 4 处横向百分比宽度；仅开关开启时生效，可 A/B。
- **风险**：中——Fill 与 SizeBox 的相互作用上次已踩过（CONTEXT:42）。需新测试页 `11-percent.html` 回归。
- **工作量**：1 天（含测试页）。

### C4 长文档"分段锚定"（C1 排不上时的止血方案）

- **改哪里**：`buildFlowContainer`（mapper:2629-2640）的 pin 循环加过滤：只钉**高度 ≥ 视口高度**的竖向流容器的直接子容器
  （通常 1–3 层足够），叶子继续自动。
- **预期收益**：比 `--pin-flow` 少冻结一个数量级的节点，预估落在 4.81%–6%；作为 C1 落地前的过渡。
- **风险**：低（复用现有通道，只加过滤条件）。**工作量**：0.5 天。

### C5 （远期，C++）自定义 `UHtmlFlexPanel`：真正实现 justify/align 分布

- **动机**：Slate 的 `SBoxPanel` 只有"每子项对齐"，没有"整组分布"，这是 B5/B6 以及 `space-around` 只能用近似的根因。
  ReactorUMG 也绕不过（折成 Fill 权重）。要彻底解决只能在 C++ 新写 panel，在 `ArrangeChildren` 里做 CSS 的分布。
- **改哪里**：新增 `Source/Html2UMG/Public/HtmlFlexPanel.h` + `.cpp`（含 `UHtmlFlexPanelSlot`），
  复用 `Html2UMGPropertyApplier` 反射链路；mapper 侧把 `CLASS.HORIZONTAL/VERTICAL` 换成新类，
  `slot` 写 `justify`/`align`/`gap`/`grow`/`shrink` 语义字段。
- **预期收益**：`01-flex`、`03-dashboard` 的分布类误差归零，从此不需要 `measuredMainGaps` 近似。
- **风险**：高（新控件 + 反射 + shipping 取舍）；**排在 C1/C2 之后**，定位为架构升级不是补丁。**工作量**：4–6 天。

### C6 文字行高的 per-字号校正表

- **动机**：`lineHeightPercentage` 用全局 1.0625 贴 Slate 的 1.417 行盒（CONTEXT:41），但行盒比例随字号/字体/字形变化。
  C1 的几何 dump 里每个 TextBlock 都有 `h`，可反解真实行盒。
- **改哪里**：`layout_calibrate.py` 顺带产出 `Resources/Converter/data/line_height.json`
  （`fontFamily|fontSize|weight → 实测倍数`），`mapper.lineHeightPercentage`（mapper:1562-1576）优先查表。
- **预期收益**：`06-cjk`（1.99%）、`04-form`（1.47%）这类文字密集页，以及真实设计正文区。
- **风险**：低；数据文件需随插件版本更新（写进 README 维护说明）。**工作量**：0.5–1 天（依赖 C1 的 dump）。

### C7 把"所有近似都留痕"升级为 CI 断言

- **动机**：ReactorUMG 的 warning 是零散 `console.warn`，不可机读；我们已有 `warnings` 数组（契约 §1）却没当门禁。
- **改哪里**：`Resources/Tools/run_acceptance.py` 增加断言：每个测试页 `warnings` 条数不得多于基线，
  且 `approximated:` 条目必须出现在验收报告里。
- **预期收益**：防止"某个补丁把 3% 换成 20%"悄悄通过（历史上出现过透明元素烘焙 0.57%→22%，CONTEXT:60-61）。
- **风险**：无。**工作量**：0.5 天。


---

## D. 明确不要抄的部分及原因

| # | 不要抄 | 证据 | 原因 |
|---|---|---|---|
| D1 | **运行时跑 JS 建树的整体架构** | `ReactorUIWidget.cpp:35-63`（每次 Initialize 换 transient WidgetTree）、`:73-123`（起 JS 环境）；README FAQ 要求打包 `JavaScript` 目录 | 我们卖点是"原生 WBP、运行期零依赖"（CONTEXT:5）。抄它等于把运行时 JS+Puerts 依赖引回来，且 Designer 里看不到静态树。 |
| D2 | **字号直塞 px、行高直塞倍数** | `css_font_parser.ts:189-191`（`font.Size = parseFontSize(...)` 返回 px）、`text.ts:179-185`（`LineHeightPercentage = 换算后的 px 值`） | 这两个正是我们已修掉的根因（CONTEXT:40-41）。抄回来字号放大约 1.33 倍、行高放大到 94 倍。 |
| D3 | **grid 的 px→fill 比例换算** | `grid.ts:120-127`：全 px 轨道时 `fill = px/Σpx × N` | 只保"比例"不保"绝对值"：200px 列在 800px 容器里会渲染成 160px。我们的 `h2uGridTrackWidth` 钉 px（mapper:2576-2578）对设计稿保真更高；要响应式应走 C3/C5。 |
| D4 | **grid 半 gap** | `grid.ts:443-450`（每格左右各 `gap/2`，仅内边） | 内部格子两侧各吃半个 gap，内容宽被吃掉一整个 gap（我们已实测，CONTEXT:65）。我们的"只在尾边加整 gap、末列不加"是正确解。 |
| D5 | **字体查找式资产** | `UMGManager.cpp:185-204`（家族名 → `/ReactorUMG/FontFamily/<Name>`，失败回退 Roboto） | 依赖插件自带 UFont，无法表达 weight/italic 文件级差异，CJK 只能撞运气；我们的 TTF 导入 + Typeface 映射更适合 CJK 设计稿。 |
| D6 | **brush 的四角映射与 outline 用法** | `brush_parser.ts:100-106`（CornerRadii X=top/Y=bottom/Z=left/W=right）、`:88-93`（`imageSize` 是自赋值空操作） | Slate 的 `FSlateBrushOutlineSettings::CornerRadii` 顺序是 TL/TR/BR/BL（我们契约 §4 已按此写）。按它们的顺序写，非对称圆角会转 90° 错位。 |
| D7 | **轮询式布局修正** | `overlay.ts:103-116`（`setTimeout` 2s × 10 次等尺寸有效） | 不确定、不可测，且必须运行时才有结果。应当用 C1 的"一次渲染 + 一次回灌"确定性替代。 |
| D8 | **百分比尺寸静默丢弃** | `container_converter.ts:149-159`（`if (widthPx !== 0) SetWidthOverride`）+ `css_length_parser.ts:79-85`（无参考尺寸返回 0） | 静默丢信息不可接受；我们至少 warn + 钉实测值（mapper:1143-1153）。 |
| D9 | **无校验的属性反射（puerts.merge）** | `native_widget_converter.ts:56-68`；`UMGManager.cpp:36-44` | 键名即 UMG 属性名，写错不报错、无类型归一、无默认值清理。我们的 JSON 反射有类型系统（契约 §3）。 |
| D10 | **hitTest/visibility 的 switch 写法** | `common_props_parser.ts:400-409`：三个 `case` 全缺 `break`，命中任一都在 default 落成 `Visible` | 照抄会得到"永远可命中"的行为（对 HUD 遮挡是致命的）。 |
| D11 | **overflow/textOverflow 只声明不实现** | `index.d.ts:103-105, 238` 有类型，全包无消费者 | 我们已有 `wantsScroll`（mapper:1236-1250）；不要为了"对齐参考实现"把功能砍掉。 |

---

## 附：一句话结论

ReactorUMG 值得抄的不是它的布局算法（它没有算法，只有槽位映射），而是**"布局是两段式的"这个意识**——
先让布局系统跑一遍，再把实测几何回灌到下一次生成。我们已经有 `Html2UMG.ImportRenderGeometry`
这个半边轮子（`Html2UMGFidelity.cpp:51-111`），缺的只是 C1 那条把几何写回 `layout.json` 的回路；
补上它，长文档累计高度（以及 center/end 分布这类"Slate 表达不了 CSS 意图"的问题）才有系统性解法。
其余所有样式/字体/资产/效果层面，我们已在它前面，**不要为了对齐参考实现而回退**。
