# Html2UMG 锚点与位置语义 —— 分析 + 方案（不改代码）

> 用户提出："锚点的设置也需要进一步思考"。本文回答三件事：**UMG 到底能用什么表达位置**、
> **这份固定尺寸稿应该怎么落**、**响应式稿的锚点该怎么推**；最后给可派清单并明确"默认要不要变"。
> 全文结论都有引擎源码或本项目 JSON 的出处，不靠记忆。

## 0. 结论先行

1. **UMG 里只有 CanvasPanel 槽**能同时表达"绝对定位 + 真居中 + 拉伸"。Overlay 槽能**真居中但不能定位**；
   HBox/VBox 槽的**主轴对齐在自动尺寸子项上没有任何余量可用**——所以 `justify-content:center` 在箱式容器里
   根本落不出来，只能烘焙像素或换容器。这就是本稿 `SettingsPanel_Size` 槽变成 `Padding[340,0,0,0] + HAlign=Left`
   的直接原因（mapper.js:625-663、:745）。
2. 本稿是**固定尺寸设计**（`html,body{width:1920px;height:1080px}`、`body{display:flex;align-items:center;justify-content:center}`）。
   正确落法是**根节点 ScaleBox**（`--scale-box fit`，已实现，mapper.js:381-393）或**项目 DPI 改 ScaleToFit +
   DesignScreenSize=1920×1080**，而不是把居中烘成像素。**当前项目 DPI 是 `ShortestSide` + 空曲线，算出的
   scale 恒为 1.0**（UserInterfaceSettings.cpp:159-160 的默认回退），等于完全没有 DPI 适配——这才是
   1280×720 下按 1280 布局、面板被裁的根因。
3. 响应式稿：`justify-center/end` 单子项用 **Overlay 包一层**可行（SOverlay 给每个子项整块 allotted，对齐有富余），
   但**当前 `rawSlot` 对 OVERLAY 子项硬编码 `Fill`**（mapper.js:588-595），不一起改就等于没做。
   绝对定位的"**双侧 inset → 拉伸锚**"**已经实现**（mapper.js:914-925），缺的是测试页与契约文档。
4. **默认行为建议：三条都不翻**（`--scale-box`、新的 `--anchor-center`、项目 DPI）。当前 0.38%–3.05% 的基线
   只衡量"设计尺寸"，翻默认不会改善这些数字、却会改变跨分辨率行为。先补 I1/I4/I5（文档 + 测试 + 契约，不动产物），
   跨分辨率基线由 verify 补三档色数后再定。

---

## 1. UMG 的位置语义机制矩阵

### 1.1 一览（能力 × 机制）

| 机制 | 绝对定位 | 真居中 | 比例 / 拉伸 | 缩放内容 | 随分辨率自适应 | 一句话限制 |
|---|---|---|---|---|---|---|
| **CanvasPanel 槽**（Anchors+Offsets+Alignment） | ✅ | ✅（点锚 0.5 + 枢轴 0.5） | ✅（Min≠Max 即拉伸） | ❌ | ✅ | 需要 CanvasPanel 父，且要人（或推导）给四元组 |
| **Overlay 槽**（HAlign/VAlign+Padding） | ❌（没有 position） | ✅ | ✅（Fill） | ❌ | ✅ | 子项全叠在一起，只适合"单内容层"或叠层 |
| **Box 槽·交叉轴**（HBox 的 V，VBox 的 H） | ❌ | ✅ | ✅ | ❌ | ✅ | 槽的交叉尺寸 = 面板尺寸，有富余 |
| **Box 槽·主轴**（HBox 的 H，VBox 的 V） | ❌ | ⚠️ **仅 SizeRule=Fill** | ✅（Fill 权重） | ❌ | ⚠️ | 自动尺寸子项的槽=desired，**对齐无余量** |
| **WrapBox 槽** | ❌ | ⚠️ 行内可对齐，整行不可推 | ✅ | ❌ | ⚠️ | 换行行为由 Box 级 HAlign/InnerSlotPadding 决定 |
| **Grid 槽** | ❌ | ❌（没有"剩余空间"概念） | ✅（Fill 系数） | ❌ | ✅ | 行列 + span + 对齐 |
| **SizeBox** | ❌ | ❌ | ✅（Over/Min/Max/Aspect） | ❌ | ✅ | 只改 **desired size**，不定位不缩放 |
| **ScaleBox** | ❌ | ⚠️（只在自己区域内对齐） | ✅ | ✅ | ✅ | 缩放整棵子树，不改布局坐标 |
| **视口槽**（WBP 根） | — | — | ✅ | — | ✅ | 锚点默认 (0,0)–(1,1)，根永远填满视口 |
| **DPI 曲线 / ScaleToFit** | — | — | — | — | ✅ | 全项目统一缩放，改的是"逻辑视口尺寸" |
| **SafeZone** | ❌ | ❌ | — | — | ✅ | 只按安全区加内边距 |

### 1.2 逐个机制的引擎语义

#### 1.2.1 CanvasPanel 槽：唯一"四元组齐全"的机制

`SConstraintCanvas::ArrangeLayeredChildren`（Slate/Private/Widgets/Layout/SConstraintCanvas.cpp:240-279）的四段公式：

```
AnchorPixels   = Anchors × 面板局部尺寸                      // :240-244
bStretch       = (Anchors.Min != Anchors.Max)  (逐轴)         // :246-247
Size           = bAutoSize ? CurWidget->GetDesiredSize() : (Offset.Right, Offset.Bottom)  // :249-251

拉伸轴:  LocalPos  = AnchorPixels.Min + Offset.Min
         LocalSize = AnchorPixels.Max - LocalPos - Offset.Max      // :260-264 / :272-276
非拉伸轴: LocalPos = AnchorPixels.Min + Offset.Min - Size × Alignment
         LocalSize = Size                                          // :265-269 / :277-280
```

由此得到三个**必须记住**的结论：

- **`Alignment` 是"枢轴"不是"对齐"**（CanvasPanelSlot.h:33-38 原话："Alignment is the pivot point of the widget"）。
  要"真居中"有两条写法：① 点锚 `(0.5,0.5)` + 枢轴 `(0.5,0.5)` + offset 0；② 双边拉伸 + 左右对称 offset。
- **拉伸轴上的 offset 是"到两个锚边的距离"**，不是尺寸——这正是"两侧都有 inset"的正确表达（见 3.3）。
- `bAutoSize=true` 时尺寸来自 desired size，offset 的 Right/Bottom 被忽略。

#### 1.2.2 Overlay 槽：能真居中，但不能定位

`SOverlay::OnArrangeChildren`（SlateCore/Private/Widgets/SOverlay.cpp:148-156）对**每个子项**都传入
整块 `AllottedGeometry.GetLocalSize()` 再做 `AlignChild`：

```
SlotPadding = child.Padding
X = AlignChild<H>(AllottedGeometry.Width,  child, SlotPadding)
Y = AlignChild<V>(AllottedGeometry.Height, child, SlotPadding)
```

所以 `HAlign=Center / VAlign=Center` 在 Overlay 里**是有效居中**（子项按 desired 尺寸放在中间）。
代价：没有 position/offset，只能用 Padding 当偏移；多个子项会**互相重叠**。

#### 1.2.3 HBox/VBox 槽：主轴与交叉轴不对称（本文最重要的一条）

`ArrangeChildrenInStack`（SlateCore/Public/Layout/LayoutUtils.h）：

- `:805-806` 注释原文："Allotted space will be given to fixed-size children first. Remaining space will be
  proportionately divided between stretch children."
- `:864-880` 自动尺寸子项先把 **desired size** 记成 `Item.Size`（并按 Min/Max 钳制）；
- `:1103-1109` 槽沿箱体轴的尺寸 = `Item.Size + Padding`；**交叉轴**直接用 `AllottedGeometry.GetLocalSize()`；
- `:1112-1119` 对齐只在**这个槽矩形内部**做；`:1144` 下一个子项按 `SlotSize` 顺移。

⇒ **主轴**：自动尺寸子项的槽宽恰好等于它自己要的宽度，**剩余空间为 0，`HAlign=Center` 无处可移**。
**交叉轴**：槽宽 = 面板宽，有富余，对齐有效。
这就是"为什么 `body{justify-content:center}` 折成了 padding，而 `align-items:center` 不用"的机制解释。

> 注意：主轴**不是完全不能居中**——把该子项设成 `Size={Fill,1}` 后再 `HAlign=Center`，子项会拿到全部剩余空间、
> 再在空间内居中。但 Fill 分配会**静默覆盖 SizeBox 的 WidthOverride**（本仓库已踩过，见 项目内的踩坑记录:42），
> 所以不能拿它当通用解法。

#### 1.2.4 WrapBox / Grid 槽

- WrapBox：槽有 HAlign/VAlign 与 `bSlotFillEmptySpace`（SWrapBox.h:66、:106-117），但"整行居中"是 Box 级
  `HAlign`（SWrapBox.h:143、:158）与 `InnerSlotPadding`；换行后的位置不可控。
- GridPanel：只有 `FillColumn/FillRow` 系数与行列/span（SGridPanel.h:215-232、:263-269），没有"剩余空间"。

#### 1.2.5 SizeBox：只改 desired size

SizeBox.h:31-58 —— `WidthOverride/HeightOverride` 覆盖 desired，`Min/MaxDesired*` 钳制，`Min/MaxAspectRatio`
约束比例；**没有任何定位或缩放语义**。所以"给根加 SizeBox(1920×1080)"不会缩放，只会把根钉死成 1920×1080
（在 1280 视口里就是溢出裁切）。

#### 1.2.6 ScaleBox：只缩放，不改布局坐标

- Slate 层默认：`_HAlign(HAlign_Center)`、`_VAlign(VAlign_Center)`、`_Stretch(EStretch::None)`（SScaleBox.h:83-88）；
- UMG 层默认：`StretchDirection=Both`、`Stretch=ScaleToFit`（ScaleBox.cpp:21-22）；
- `Stretch` 九种语义见 SScaleBox.h:32-68（表在 2.2）；`StretchDirection` = Both/DownOnly/UpOnly（:18-29）。

#### 1.2.7 视口槽与 "Fill Screen" 的误解

- WBP 加到视口时的槽：`FGameViewportWidgetSlot::Anchors = FAnchors(0,0,1,1)`（GameViewportSubsystem.h:27）——
  **根永远填满视口**，所以 1280 视口里根 Border 就是 1280×720，子节点按 1280 的剩余空间布局。
- UMG Designer 里的 "Fill Screen" 是 `EDesignPreviewSizeMode::FillScreen`（UserWidget.h:244-252），
  **只是编辑器预览的尺寸模式**，不影响运行时锚点。二者常被混为一谈。

#### 1.2.8 DPI：改的是"逻辑视口尺寸"

- 规则枚举：ShortestSide / LongestSide / Horizontal / Vertical / **ScaleToFit** / Custom（UserInterfaceSettings.h:32-46）；
- `ScaleToFit` 公式：`min(W / DesignScreenSize.X, H / DesignScreenSize.Y)`（UserInterfaceSettings.cpp:156）；
- 其它规则走曲线：`UIScaleCurve.Eval(EvalPoint, 1.0f)`（:159-160）；
- 最终 `Scale = Max(Scale × ApplicationScale, 0.01)`（:109）；
- 本项目配置：`ApplicationScale=1.0`、`UIScaleRule=ShortestSide`、`DesignScreenSize=(4096,2160)`、`FontDPI=72`
  （Config/DefaultEngine.ini:88-94），且**没有 UIScaleCurve 段** → 曲线为空 → `Eval` 返回默认 1.0
  → **任何分辨率 scale 都是 1.0**。

#### 1.2.9 SafeZone

只按设备安全区给内容加内边距（SafeZone.h:47-59）；对桌面 16:9 无作用，本文不展开。

### 1.3 "谁真能居中"矩阵（判据版）

| 想表达 | CanvasPanel 槽 | Overlay 槽 | Box 主轴 | Box 交叉轴 | SizeBox | ScaleBox |
|---|---|---|---|---|---|---|
| 固定 px 位置 | ✅ 点锚+offset | ❌ | ❌ | ❌ | ❌ | ❌ |
| 相对父真居中（任意分辨率） | ✅ 点锚 0.5 | ✅ H/V=Center | ⚠️ 需 Fill | ✅ | ❌ | ⚠️ 只在自己框内 |
| 左右留白对称拉伸 | ✅ Min≠Max + 对称 offset | ✅ Fill+Padding | ✅ Fill | ✅ Fill | ❌ | ❌ |
| 按父百分比定位/定尺寸 | ✅ 比例锚 | ❌ | ✅ Fill 权重 | ✅ Fill | ✅（仅尺寸） | ❌ |
| 整体等比缩放 | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| 跨分辨率不改值 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

### 1.4 本稿的 `Padding[340,0,0,0]` 是怎么来的

事实（`/c/out/figma-ref/after4b/layout.json`）：

- 128 个节点、**0 个带 Anchors**、30 个槽带非零 Padding；
- 路径 `Root(Border) > Root_Content(HorizontalBox) > SettingsPanel_Size(SizeBox)`；
- `SettingsPanel_Size`：`properties={WidthOverride:1240}`，
  `slot={Padding:[340,0,0,0], Size:{SizeRule:Automatic}, HorizontalAlignment:Left, VerticalAlignment:Center}`。

代码路径：

1. `body{display:flex;justify-content:center}` → `buildFlowContainer` 选 `HorizontalBox`（mapper.js:3244-3262 的 flex 分支）；
2. `assignSlots` → `makeSlot` → `boxSlot`：主轴上没有 flex-grow / 百分比 → `Size={SizeRule:Automatic}`（:700-708）；
3. `justifyLeadingOffset()` 读出浏览器量到的首子项前导空间 340px（:625-663），写进槽 `Padding[0]`（:712-715）；
4. 因为 padding 已经把子项推到正确位置，**再居中会二次位移**，于是强制 `HorizontalAlignment=Left`（:745）。

这样做在**设计尺寸 1920** 下是精确的（现有 3.05% 那类数字就是这么来的）；但它把"1920 里剩下的 340"写死了：

```
1280 视口：根宽 1280 -> 首子项 left=340 -> SizeBox 宽 1240 -> 右边缘 1580 > 1280
超出 300px，面板右侧被裁掉（与实测一致：x=340 处是面板左边、1279 处仍是面板内容）
```

注意 `VerticalAlignment=Center` 是**交叉轴**（HBox 的竖直方向），槽高 = 面板高，有富余 → 纵向仍然居中。
**错的只有主轴这一处**，正好印证 1.2.3 的机制分析。

---

## 2. 固定尺寸设计（本稿）的最佳实践

### 2.1 三条路线

| 路线 | 做法 | 现在能否直接用 | 1280×720 的结果 | 影响面 | 评审结论 |
|---|---|---|---|---|---|
| **A. 根 ScaleBox** | `--scale-box fit`（已实现） | ✅ 已有开关，默认关 | 整棵树按 2/3 缩放，**不裁切**；16:9→16:9 无留边 | 单 WBP | **推荐给固定尺寸稿** |
| **B. 项目 DPI ScaleToFit** | `UIScaleRule=ScaleToFit` + `DesignScreenSize=1920×1080` | ⚠️ 项目级配置改动 | 逻辑视口仍是 1920×1080，等于"设计尺寸永远成立" | 全项目所有 UI | 一行解决所有 WBP，但属项目决策 |
| **C. 保持烘焙 padding**（现状） | 不加东西 | ✅ | 裁切 300px | 单 WBP | 只在"确定只出一档尺寸"时可接受 |

### 2.2 路线 A：根 ScaleBox（推荐）

现状实现（mapper.js:381-393）：把整棵树包进
`ScaleBox{Stretch: <mode>, StretchDirection: Both}`，CLI 映射
`fit→ScaleToFit / fill→ScaleToFill / fitx→ScaleToFitX / fity→ScaleToFitY`（args.js:63-67）。

`EStretch` 语义（SScaleBox.h:32-68 原文注释）：

| 取值 | 行为 | 适合 |
|---|---|---|
| `None` | 不缩放 | 只在同分辨率用 |
| `Fill` | 非等比拉满 | 背景图/纯色面板（会变形） |
| `ScaleToFit` | 等比缩放到"不裁切"，可能留边 | **固定尺寸 UI 的默认选择** |
| `ScaleToFitX` | 等比直到贴满 X，Y 可能裁 | 竖屏/长列表 |
| `ScaleToFitY` | 等比直到贴满 Y，X 可能裁 | 横屏 HUD |
| `ScaleToFill` | 等比直到两边都≥区域，长边裁切 | 满屏背景 + 允许裁边 |
| `ScaleBySafeZone` | 按 SafeZone 缩放 | 移动/电视 |
| `UserSpecified` / `UserSpecifiedWithClipping` | 用 `UserSpecifiedScale` 定比例 | 调试、与 DPI 联动 |

`StretchDirection`（:18-29）：`Both`（可放大可缩小，默认）/ `DownOnly`（只缩不放）/ `UpOnly`（只放不缩）。

本稿的具体数字：1920×1080 → 1280×720，两边比例都是 `0.6667` → `ScaleToFit` 得到**精确 2/3、无留边、不裁切**；
1440×810、2560×1440 同理。

注意事项：

1. **背景与留边**：ScaleBox 只缩放它的子内容。根 Border 的 `#EDF1EE` 背景会被一起缩放 → 非 16:9 屏会出现
   未覆盖的边条。要么把底色放到 WBP 外面（父容器/HUD 层），要么在 Overlay 里放一个不缩放的背景 Border 与
   ScaleBox 并列。
2. **子项坐标不变**：ScaleBox 内仍是 1920×1080 逻辑空间，所有 SizeBox/WidthOverride（如 1240）继续有效——
   这正是我们要的"设计坐标 = 布局坐标"。
3. **命中测试**：Slate 的变换会一并作用于 hit test，不需要额外处理。
4. **文字渲染**：0.667 这类非整数缩放下字形栅格化会略软（Slate 按最终 transform 栅格化，但不保证像素对齐）；
   若在意，走路线 B（逻辑视口仍是 1920，字号与像素对齐都不变）。
5. **与 DPI 叠加**：见 2.3。

### 2.3 路线 B：项目 DPI `ScaleToFit`

- 改 `Config/DefaultEngine.ini` 的 `[/Script/Engine.UserInterfaceSettings]`：
  `UIScaleRule=ScaleToFit`、`DesignScreenSize=(X=1920,Y=1080)`（当前是 `ShortestSide` + `(4096,2160)`）。
- 效果：任何分辨率下 `scale = min(W/1920, H/1080)` → **逻辑视口恒为 1920×1080** → 设计坐标永远成立，
  `Padding[340,...]` 也就永远正确（剩余空间恒为 1920−1240−2×340 = 340）。
- 代价与风险：
  - **全项目生效**（其它 WBP、编辑器工具、任何依赖 `GetViewportSize` 的逻辑都会看到 1920×1080）；
  - 非 16:9 时等比缩到"装得下"，短边方向留白；`ApplicationScale` 再乘一次（:109）；
  - 与 ScaleBox **叠加就是双重缩放**（0.667 × 0.667 = 0.444）——两者只能选一个；
  - 我们的验收渲染跑在 1920×1080 时 scale=1.0，**现有 9 页数字不会变化**，所以这项改动无法用现有基线证明好坏，
    必须补多分辨率验收（附录 B）。
- 什么时候值得：项目整体就是"1920×1080 UI"，且希望所有 WBP 一次性获得跨分辨率正确性 → 应由用户拍板，
  不属于转换器职责。

### 2.4 路线 C 何时仍然正确

WBP 被当作"固定画布"嵌进已知尺寸的容器（例如 HUD 的 1920 逻辑区、或设计稿本来只给 1080p 出图），
或者交付目标就是单分辨率截图比对。此时烘焙 padding 是**最省事且像素最准**的做法。

### 2.5 推荐

- **对这份参考稿**：`--scale-box fit`。它不动项目配置、只影响这一个 WBP，且 16:9→16:9 无留边。
- **对项目长期**：若确认"全部 UI 都按 1920×1080 设计"，路线 B 更一劳永逸，但要作为独立决策 + 多分辨率验收。
- **两者互斥**，文档里必须写明：同时开会双重缩放。

---

## 3. 响应式设计怎么落锚点

### 3.1 CSS 情形 → 应该产出什么 → 我们现在产出什么

| CSS 情形 | 正确表达 | 我们现在的产出 | 判定 |
|---|---|---|---|
| 单子项 `justify-content:center`（flex 容器） | Overlay 槽 `HAlign/VAlign=Center`，或 Canvas 点锚 0.5+枢轴 0.5 | 烘焙 `Padding[0]=前导空间` + `HAlign=Left`（boxSlot :712-745） | ❌ **跨分辨率错**（本稿 1280 裁切） |
| 单子项 `justify-content:flex-end` | Overlay `HAlign=Right`，或 Canvas 右边点锚 1 | 同上（前导空间 = 剩余空间） | ❌ 同上 |
| 多子项 `justify-content:space-between/around/evenly` | 自定义 panel，或按实测 gap 折成槽 padding | 实测 gap（measureMainGaps，:672-690） | ✅ 设计尺寸内精确（已知近似） |
| 绝对定位 `left:24px` | 点锚 (0,…) + offset 24 | `axisPlacement` 分支 2（:927-941） | ✅ |
| 绝对定位 `right:24px` | 点锚 (1,…) + offset 24 | 分支 2（far 侧，锚点 1） | ✅ |
| 绝对定位 **`left:24px; right:24px`（无 width）** | **拉伸锚** Min=0/Max=1 + 左右 offset 24 | **分支 1（:914-925）已实现** | ✅ 缺测试 |
| 绝对定位 `left:50%` | 比例锚 0.5 + offset（偏移由测量反解，兼容 translate） | 分支 2（pct → 比例锚，:929-938） | ✅ |
| 绝对定位 `left:24px; right:24px; width:500px` | CSS 中 width 胜 → 点锚左 + 固定宽 500，right 忽略 | 落到分支 2（near 优先） | ✅ 符合 CSS |
| `width:60%` / `width:100%` | 拉伸锚 0–span（跨分辨率保持比例） | 分支 0（:894-912） | ✅ |
| 无 inset、靠 `transform:translate(-50%,-50%)` 居中 | 点锚 0.5 | 分支 3（:944-956） | ✅ |
| `display:grid` 定位 | GridSlot 行列/span + Fill 系数 | gridSlot（:1068 起） | ✅ |
| `overflow:auto` 滚动内容 | ScrollBox（内容天然靠上，无需锚点） | wantsScroll | ✅ |

结论：**响应式侧的锚点推导基本齐了**（就差测试与契约描述），真正缺的是"**flex 主轴分布类**"——
而它恰恰是 `justify-content:center/end` 这种单子项场景，本稿就踩在这里。

### 3.2 方案：单子项 `justify-center/end` 改成 Overlay 包一层

**可行性**：Overlay 给每个子项整块 allotted 再对齐（SOverlay.cpp:148-156），所以
`HAlign=Center/VAlign=Center` 是真居中；子项仍可用 SizeBox 固定宽（1240），任意分辨率都居中。

目标结构（以本稿为例）：

```
Root(Border)                              <- 背景，Fill
└─ Root_Content(Overlay)                  <- body 的 display:flex + justify/align center，且只有 1 个 in-flow 子项
   └─ SettingsPanel_Size(SizeBox 1240)    slot = { HAlign: Center, VAlign: Center, Padding: 0 }
```

**需要改的三处（缺一处就不生效）**：

| # | 位置 | 改动 |
|---|---|---|
| 1 | `mapper.buildFlowContainer()`（:3213 起的 flex 分支） | 判据命中时选 `CLASS.OVERLAY`（新增 nodeKind `overlay-center`），并把 `style.justify/align` 传给子项生成槽位 |
| 2 | `mapper.rawSlot()` 的 `case CLASS.OVERLAY`（:588/595） | 目前**硬编码** `{HorizontalAlignment:'Fill', VerticalAlignment:'Fill'}` → 改为按 CSS 映射（主轴取 `mapJustify`、交叉轴取 `mapAlign`）。这是方案能成立的前提 |
| 3 | `mapper.boxSlot()` / `justifyLeadingOffset()` | 父已是 Overlay 时**不要再烘焙 leading padding**（否则居中 + padding 二次位移）：判据加 `parent.class !== CLASS.OVERLAY` |

**边界**：

1. 子项多于 1 个 → Overlay 会重叠，**不适用**（保留现有实测 gap 方案）；
2. 子项有 `flex-grow` 或主轴百分比 → 它自己会占满，没有"居中"语义，跳过；
3. 容器有 `gap > 0` 且子项 > 1 → 不适用（同 1）；
4. Overlay 没有 padding 语义 → 容器自身 padding 仍由外层 Border 承载（现有 wrapper 链已如此）；
5. `flex-direction:column` 同理，只是主轴换成竖直（由 Overlay 的 VAlign 承担）；
6. 绝对定位子项要**先剔除**再数子项数（否则「1 个流内 + 1 个绝对」会误判成多子项）。

**与 CanvasPanel 方案的取舍**：CanvasPanel 点锚同样能真居中，还额外支持 z 序/叠层；但它要求父是 CanvasPanel，
而 CanvasPanel 的子项**默认不参与流布局**（每个子项都要自己写四元组），会把简单页面复杂化。
所以：**纯居中用 Overlay，混合了绝对定位的容器用 CanvasPanel**（现有 buildContainer 已在"流 + 绝对混合"时
自动建 CanvasPanel，:3180-3200）。

### 3.3 绝对定位：现状能力表与缺口

现有实现（`axisPlacement`，mapper.js:873-959）的分支与能力：

| 分支 | 条件 | 产出 | 跨分辨率行为 |
|---|---|---|---|
| 0 百分比尺寸 | `percent != null && fixed == null && max == null` | 拉伸锚 0–span | ✅ 比例保持 |
| 1 双边 inset + 无尺寸 | `near && far && !hasDeclaredSize` | 拉伸锚 (0,1) + 两侧 offset | ✅ **"两侧 inset → 拉伸锚"已实现** |
| 2 单边 inset | `near || far` | 点锚 0/1（px）或比例锚（%） | ✅ |
| 3 无 inset | — | 若测量中心≈0.5 或 `translate(-50%)` → 点锚 0.5 | ✅ |
| 4 兜底 | 以上都不满足 | `applyFixedAxis(_inferAxis(series))` 按多视口 probe 比例推断 | ⚠️ 比例锚，属估计 |

**缺口（要不要补）**：

1. **双边 inset + 显式尺寸**：CSS 里 `width` 胜、`right` 被忽略，现落分支 2（取 near）——**这是对的**。
   若设计意图是"最小宽度 + 可拉伸"（`min-width` + 双边 inset），则需要 SizeBox 的 `MinDesiredWidth`
   与拉伸锚并存；当前不会同时产出 → **低优先**（真实设计里没出现）。
2. **比例锚推断依赖 probe**：`--probe` 默认 0.75x / 1.25x（args.js 的 autoProbes）。对"无 inset 且中心不在 0.5"
   的元素只能给固定 px 偏移 → 换分辨率会歪。这是**已知近似**，应写进契约而不是悄悄用。
3. **测试空白**：6 种锚点情形没有任何回归页（test/ 下 01–10 只有 02-absolute、07-anchors 沾边）→ I4。

### 3.4 多子项居中怎么办（不推荐自定义 panel）

若确实要"多子项整组居中"且要跨分辨率：

- **可行解**：Overlay 里放一个内层 HBox，Overlay 槽 `HAlign=Center`，内层 HBox 宽度由内容决定
  （HBox 的 desired = 子项 desired 之和）→ 整组居中，子项间仍用实测 gap。**不需要自定义 panel**。
- 不推荐自定义 `UHtmlFlexPanel`（ReactorUMG 评审里的 C5）：成本 4–6 天，只覆盖这一种情形。

---

## 4. 可派实现清单

| # | 改哪 | 判据 / 边界 | 风险 | 预期收益 | 默认变不变 | 工作量 |
|---|---|---|---|---|---|---|
| **I1** | 文档 + 验收清单（不改代码） | 固定尺寸稿（body 声明 px 宽高、无 %/vw/vh/absolute）必须配 `--scale-box fit` 或项目 DPI | 无 | 消除"只在设计尺寸正确"的误解；交付时知道怎么挂 | 不变 | 0.2 天 |
| **I2** | `mapper.buildFlowContainer` + `rawSlot` 的 OVERLAY 分支 + `justifyLeadingOffset` 守卫 | 单 in-flow 子项 + `justify ∈ {center,end,flex-end,right}` + 无 flex-grow/gap/主轴百分比 | 中：改容器类型选择，牵动全部页面基线 | 1280/1440/2560 不再裁切；本稿从"只在 1920 正确"变成"任意分辨率正确" | **默认 off**，走 `--anchor-center` 开关 | 1 天 |
| **I3** | `args.js` 的 `--scale-box` 增 `auto` 模式 | body/html 的 decl 宽高都是 px、且无「%/vw/vh/absolute」→ auto 选 fit | 低（只影响新开关） | 固定尺寸稿少一个手写参数 | **默认 off**（保持 null） | 0.5 天 |
| **I4** | 新增 `Resources/Converter/test/12-anchors.html` | 见 4.2 的 6 个用例 | 低 | 保护已实现的推导，防回归 | 不变 | 0.5 天 |
| **I5** | `Docs/Html2UMG_LayoutContract.md` §6 增「锚点推导规则」 | 把 3.3 的表写进契约，含"比例锚是近似"的声明 | 无 | 可 review、可对外 | 不变 | 0.3 天 |
| **I6** | 项目级：`Config/DefaultEngine.ini` 的 DPI 规则 | 见 2.3 | **高**（全项目 UI/编辑器） | 一行解决所有 WBP 的跨分辨率 | **建议不变**，另案评估 | — |

### 4.1 I2 的细化（最重要的一条）

- **文件 / 函数**：`Resources/Converter/src/mapper.js`
  - `buildFlowContainer`（:3213 起）：flex 分支内新增判据，命中则 `cls = CLASS.OVERLAY; nodeKind = 'overlay-center'`；
  - 新增 `buildCenteredContainer(rec, style, items, ctx, name)`：建 Overlay 节点 + 给唯一子项写
    `slot = {HorizontalAlignment: mapJustify(...), VerticalAlignment: mapAlign(...)}`；
  - `rawSlot`（:577-603）的 `case CLASS.OVERLAY`：从硬编码 Fill 改为读 `cmeta.style` 的 justify/align；
  - `boxSlot` / `justifyLeadingOffset`：加 `parent.class === CLASS.OVERLAY` 时短路（不烘焙 padding）。
- **判据（全部满足才换）**：① 父 `display:flex` 且方向已知；② `justify` 属 {center,end,flex-end,right}；
  ③ in-flow 子项恰好 1（绝对定位子项先剔除）；④ 该子项无 `flex-grow > 0` 且主轴无百分比；
  ⑤ 父无 `gap > 0`。
- **验收**：① 10 页回归差异**不得上升**；② 本稿在 1280×720 下：面板应居中，左边缘 ≈ `(1280−1240)/2 = 20`、
  右边缘 `1260 < 1280`，无裁切；③ 1920×1080 下差异与现状等价（±0.05%）。
- **风险**：换容器类型会改变依赖父类型的分支（`makeSlot` :525-573 里有 `parentClass === CLASS.HORIZONTAL`
  的路径），所以**必须开开关灰度**，不能直接翻默认。

### 4.2 I4 测试页的 6 个用例（可直接给 verify）

| 用例 | CSS | 期望 slot |
|---|---|---|
| a | `position:absolute; left:24px; top:16px; width:100px; height:40px` | 点锚 (0,0)，offset(24,16)，size(100,40) |
| b | `position:absolute; left:24px; right:24px; top:0; bottom:0` | 拉伸锚 (0,0)-(1,1)，offset(24,0,24,0) |
| c | `position:absolute; left:10%; right:10%` | 拉伸锚 (0.1,…)-(0.9,…)，offset 0 |
| d | `position:absolute; left:35%; width:30%` | 比例锚 0.35 + 拉伸 0.35–0.65 |
| e | `position:absolute; left:50%; top:50%; transform:translate(-50%,-50%)` | 点锚 (0.5,0.5)，offset 0（或测量反解） |
| f | 普通块 + 一个 `left:0; right:0` 叠层 | 父是 CanvasPanel，流子项为 Flow 组（:2516-2536） |

---

## 5. 默认行为要不要变（明确回答）

**不建议现在就翻任何默认值**，理由与顺序：

1. **现有 9 页基线（0.38%–3.05%）只衡量"设计尺寸"**。I2 改的是跨分辨率行为，设计尺寸下的数字应当**不变**——
   这些数字既证明不了 I2 的好处，也拦不住它的风险。
2. 要翻默认，先建立**跨分辨率验收口径**：同一 WBP 在 1280×720 / 1920×1080 / 2560×1440 各渲一次，
   记录"面板左右边界 / 是否被裁 / 与同尺寸浏览器截图的差异率"（附录 B 给了具体要求）。
3. 顺序建议：**I1 + I4 + I5 立即做**（不动产物，0.2 + 0.5 + 0.3 天）→ 拿到跨分辨率基线 →
   再决定 I2 是否翻默认、I3 是否开 auto。
4. **I6（项目 DPI）不进本插件默认值**：属项目配置，收益大但影响面是全项目，应由用户拍板。

---

## 附录 A：本稿证据汇总

| 事实 | 数值 / 出处 |
|---|---|
| 设计稿固定尺寸 | `html,body{margin:0;padding:0;width:1920px;height:1080px}`（skyline-settings.html:15） |
| 居中意图来自 CSS | `body{display:flex;align-items:center;justify-content:center}`（同文件:16-17） |
| 面板声明宽度 | `#panel{width:1240px;display:flex;flex-direction:column}`（同文件:22-24） |
| 产物锚点数量 | 128 节点 / **0 个 Anchors** / 30 个槽带非零 Padding（after4b/layout.json） |
| 烘焙值 | `SettingsPanel_Size`：`WidthOverride=1240`，slot `Padding[340,0,0,0]`、`SizeRule=Automatic`、`HAlign=Left`、`VAlign=Center` |
| 1280 下的算术 | `340 + 1240 = 1580 > 1280` → 超出 300px（与实测裁切一致） |
| 视口根锚点 | `FGameViewportWidgetSlot::Anchors = FAnchors(0,0,1,1)`（GameViewportSubsystem.h:27） |
| 项目 DPI 现状 | `UIScaleRule=ShortestSide`、`ApplicationScale=1.0`、`DesignScreenSize=(4096,2160)`、无 UIScaleCurve 段（Config/DefaultEngine.ini:88-94） |
| 为什么 DPI 等于没生效 | 空曲线时 `DPICurve->Eval(x, 1.0f)` 返回 1.0（UserInterfaceSettings.cpp:159-160） |
| ScaleToFit 公式 | `min(W/DesignScreenSize.X, H/DesignScreenSize.Y)`（UserInterfaceSettings.cpp:156） |
| 主轴无余量 | LayoutUtils.h:1103-1119（槽尺寸 = child size + padding，对齐只在槽内）+ :1144（顺序推进） |
| Overlay 有富余 | SOverlay.cpp:148-156（整块 allotted 交给 AlignChild） |
| Canvas 四段公式 | SConstraintCanvas.cpp:240-279 |

## 附录 B：要 verify 出什么数字（若采纳 I2 / 路线 A）

1. **三档渲染**：同一个 WBP（本稿）在 1280×720、1920×1080、2560×1440 各渲一次，
   每档产出 `umg.png` + `geo.json`（用 `Html2UMG.ImportRenderGeometry` 一次到位）。
2. **从几何 dump 读三个数**（不用看图）：面板的 `x`、`w`、`x+w`，以及有没有 `painted=false` 的节点。
3. **对照组**：同一份 layout.json 再走一遍 `--scale-box fit` 重导，1280×720 下再取同样三个数。
4. **期望值**：
   - 现状（烘焙 padding）：`x=340, w=1240, x+w=1580` → 超出 1280，裁切；
   - 路线 A（ScaleBox fit，0.6667）：`x=226.7, w=826.7, x+w=1053.3` → 完整可见；
   - I2（Overlay 居中，无缩放）：`x=20, w=1240, x+w=1260` → 完整可见且保持 1:1 像素；
   - 1920×1080 三档对照应与现状一致（±0.05%）。
5. 顺手确认：1280 下是否有节点因 `painted=false` 变成零面积（把"裁切"和"未绘制"区分开）。

---

## 附：与 ReactorUMG 的关系（一句话）

ReactorUMG 的容器分派里 div 默认走 flex/HBox-VBox（container_converter.ts:54-72），
只有 `position:relative` 的父才变 Overlay（overlay.ts:56-86）——它同样**没有把 `justify-content:center` 表达出来**，
我们和它在同一条船上；差别是它跑在运行时、我们输出静态 WBP，所以**我们的锚点错误会被固化进资产**，
必须在这里修而不是等运行时兜。详见 `Docs/ReactorUMG_Layout_Review.md` §A.3。
