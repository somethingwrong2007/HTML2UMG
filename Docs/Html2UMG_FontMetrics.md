# Html2UMG 字体度量、行高与断行

> **本轮结论（30 秒版）**
> 1. **问题**：文本行高用的是从 Segoe UI 推出来的一个全局常数（1.0625 修正），换字体就不成立；同时
>    `AutoWrapText` 没有配 `WrapTextAt`，Slate 首帧拿不到宽度，**整段文本根本不会折行**（中文无空格长句 4 行变 1 行，−66px）。
> 2. **修好**：行高改为逐字体现算（hhea 给 Slate、usWin+hheaGap 给 Chromium，normal 行高遇回退字体时用浏览器实测行盒）；
>    换行同时发 `WrapTextAt`（=内容盒宽，且只在浏览器真的折行时发）与 `WrappingPolicy: AllowPerCharacterWrapping`；
>    无 text-shadow 时清掉 `ShadowOffset` 默认的 1px。
> 3. **数字**：每行行高误差 0.91px → ≤0.05px；中文页 10-cjk 像素差异 17.12% → 8.58% → **3.82%**；
>    wrap 探针四组 22/44/44/22 全部对齐浏览器；11-typo 五个字号 17/19/20/24/29 全部命中；01..09 纯拉丁页逐元素 LHP 零变化。

本文件记录转换器如何把 CSS 的文字排版换成 UMG 的数值：为什么原来用一个全局常数是错的、每个字体
该用哪两个系数、断行要额外发什么、以及哪些情况仍然会偏。所有数字都能用
`Resources/Tools/font_metrics.js` 复现（它在本机 Chromium 里实测，再和字体文件里的度量对比）。

## 1. 结论先说

| 项目 | 改动前 | 改动后 | 依据 |
|---|---|---|---|
| 行高 | 全局 `1.3333 / 1.4167`，对所有字体一样 | 逐字体：CSS 行盒 / Slate 行盒，按字体文件度量现算 | `src/fontmetrics.js` + `mapper.lineHeightPercentage()` |
| 每行行高误差 | 均值 0.91px、最大 5.43px/行 | ≤ 0.05px/行（模型 vs Chromium 实测最大 1.12px，含 TTC 特例） | 见 §4 表 |
| 自动换行 | 只发 `AutoWrapText`，从不换行 | 发 `WrapTextAt` = CSS 内容盒宽度 | §5.1 |
| 中文无空格断行 | 不折行（Slate 的断行候选里没有断点） | `WrappingPolicy: AllowPerCharacterWrapping` | §5.2 |
| 每行多 1px | `ShadowOffset` 默认 (1,1) 被算进行盒 | 无 `text-shadow` 时显式写 `[0,0]` | §3.3 |

11-typo.html（400px 盒里的无空格中文段）改前 UMG 只有 1 行 22.2px，浏览器是 4 行 88px；改后
`WrapTextAt=352.67`（该页被 flex 压窄后的真实内容宽）+ 逐字断行策略，行数由 verify 复核。

## 2. 两条行盒定义（源码级）

UMG 侧（`E:/Epic Games/UE_5.8/Engine/Source/Runtime`）：

```
Slate/Private/Framework/Text/TextLayout.cpp:451   LineSize.Y = UnscaleLineHeight * LineHeightPercentage
TextLayout.cpp:344-345                            UnscaleLineHeight = MaxAboveBaseline + MaxBelowBaseline
Slate/Private/Framework/Text/SlateTextRun.cpp:34  GetMaxHeight = FontMeasure->GetMaxCharacterHeight(Font) + |ShadowOffset.Y|
SlateTextRun.cpp:27                               GetBaseLine  = FontMeasure->GetBaseline(Font)
SlateCore/Private/Fonts/SlateFontRenderer.cpp:200 GetMaxHeight = round26_6(GetScaledHeight(face))
SlateCore/Private/Fonts/FontCacheFreeType.cpp:257 GetScaledHeight = FT_MulFix(face->height, y_scale)
SlateCore/Private/Fonts/FontCacheFreeType.cpp:120 ComputeFontPixelSize: ppem = ((Size*RenderDPI)+36)/72 …  RenderDPI=96
```

代入后 MaxAboveBaseline + MaxBelowBaseline 正好等于 `round(face->height × ppem / upem)`，也就是：

> **Slate 行盒 = round( (hhea.ascender − hhea.descender + hhea.lineGap) / upem × ppem ) + |ShadowOffset.Y|**

`face->height` 由 FreeType（引擎内为 2.14.1）从 hhea 取；`fsSelection` 的 USE_TYPO_METRICS 位
(0x80) 置位时改用 OS/2 的 sTypo 三项。本机测试用到的字体（Segoe UI / Arial / 雅黑 / Noto Sans SC /
SimHei / DengXian）**都没有置这一位**，所以实际全部走 hhea。

CSS 侧（Chromium on Windows → DirectWrite → Skia）：

> **CSS normal 行盒 = (OS/2.usWinAscent + OS/2.usWinDescent + hhea.lineGap) / upem × font-size**

这是实测结论，不是文档推断：Arial 的 hhea 组合是 1.1499 而 usWin 组合是 1.1172，Chromium 给出的是
**1.15**；Noto Sans SC 的 hhea 是 1.2000 而 usWin 是 1.4480，Chromium 给出的是 **1.45**。两个方向
都只有 "usWin + hhea.lineGap" 说得通。0x80（USE_TYPO_METRICS）置位时改用 typo 三项。

于是换算系数：

```
LineHeightPercentage = CSS 行盒像素 / Slate 行盒像素
   CSS 行盒像素   = cssRatio(font) × font-size        （有显式 line-height 时直接用它的 px 值）
   Slate 行盒像素 = round( (hhea.asc − hhea.desc + hhea.gap) / upem × ppem )   ppem = round(font-size)
```

> 关键点：**两侧用的不是同一组表**。Slate=hhea，浏览器=usWin(+hhea.lineGap)。用同一组度量算两份，
> 中文行高会系统性偏小（Noto Sans SC 偏 1.45/1.20 = 21%）。

### 2.1 为什么旧的 1.0625 只在一种情况下对

12px Segoe UI：

- CSS：1.3301 × 12 = 15.96px → 旧代码假设 1.3333（16px）
- Slate：round(1.3301 × 12) = 16px，`ShadowOffset=(1,1)` 再加 1px → **17px**
- 17 / 16 = 1.0625，于是 `1.3333 / 1.4167` 恰好把 12px 的西文摆对。

它既依赖"字号正好 12px"，又依赖"字体 hhea 系数正好 1.3301"，还依赖那个 1px 阴影。
换成 14px、换成雅黑或 Noto Sans SC，就全都不成立。

## 3. 实现

### 3.1 `src/fontmetrics.js`（新文件，零依赖）

解析 sfnt（ttf/otf，含 .ttc 第 N 面）：

- `head.unitsPerEm`
- `hhea`: ascender / descender / lineGap
- `OS/2`: usWinAscent / usWinDescent / sTypo* / fsSelection(0x80)
- `name`（family，便于日志）、`cmap`（format 4/12，用于判断字形覆盖）

导出 `cssRatio / slateRatio / slatePixelEm / slateLineBox / cssLineBox / readFontFile / covers`。
`slateLineBox` 逐位复刻引擎的取整：`Size→ppem`（`((x*96)+36)/72`）、`y_scale` 16.16、
`FT_MulFix`、`26.6 → 整数`。

### 3.2 `mapper.lineHeightPercentage(style, fontProps, shadowOffsetY)`

字体文件来自 `fontProperties()` 已解析出的 `@font_N`：`assets.fonts` 里那条记录带文件路径
（复制到 assets 目录，字节一致，直接解析副本）。解析结果按 "font key" 和 "文件路径" 两级缓存。
读不到文件时退回内置的 Segoe UI 度量（`FALLBACK_FONT_METRICS`），用同一个公式而不是第二套魔数。

显式 `line-height` 时被除数直接用它的 px 值，所以 `line-height:30px` 这种写法一定得到 30px 行盒
（11-typo 的 `ZhLh30`：14px/30px → `LineHeightPercentage=1.7648`，Slate 行盒 17 → 30.0）。

**每个 TextBlock 都发**（旧代码在"单行且 line-height≈盒高"时会漏发，靠槽位居中近似，于是
"16px 标题设计 24px 渲染成 22px"）。

### 3.3 `ShadowOffset`

`UTextBlock` 构造函数把 `ShadowOffset` 默认成 `(1.0, 1.0)`、`ShadowColorAndOpacity` 默认透明
（`UMG/Private/Components/TextBlock.cpp:27-29`）。透明不等于不参与排版：
`FSlateTextRun::GetMaxHeight` 无条件加 `|ShadowOffset.Y|`，所以**每行被拉高 1px**，基线也下移 1px。
转换器现在对没有 `text-shadow` 的文字显式写 `ShadowOffset: [0,0]`，行盒回到字体自身的度量，
基线与浏览器一致。

## 4. 字体表（本机实测，Chromium + 字体文件）

`node Resources/Tools/font_metrics.js --sizes 12,14,16,20` 的输出（`factor` = CSS行盒/Slate行盒，
即无阴影时应发的 LineHeightPercentage；`+shadow` 是如果保留默认 1px 阴影时应发的值）：

| 字体 | 文件 | upem | hhea(asc/desc/gap) | OS/2 win / fsSel | browser 系数 | Slate 系数 | 用到的度量 | 12/14/16/20 的换算系数 |
|---|---|---|---|---|---|---|---|---|
| Segoe UI | segoeui.ttf | 2048 | 2210 / −514 / 0 | 2210,514 / 0x40 | 1.3301 | 1.3301 | browser=win+hheaGap, slate=hhea | 0.9976 / 0.9801 / 1.0134 / 0.9852 |
| Arial | arial.ttf | 2048 | 1854 / −434 / 67 | 1854,434 / 0x40 | 1.1499 | 1.1499 | 同上 | 0.9856 / 1.0062 / 1.0221 / 0.9999 |
| Microsoft YaHei | msyh.ttc (ttc 面 0 为 Light) | 2048 | 2167 / −536 / 0 | 2167,536 / 0x40 | 1.2773 | 1.3301 | 同上 | 0.9580 / 0.9412 / 0.9732 / 0.9462 |
| Noto Sans SC | NotoSansSC-VF.ttf | 1000 | 1000 / −200 / 0 | 1160,288 / 0x00 | **1.4480** | **1.2000** | 同上 | **1.2411 / 1.1925 / 1.2194 / 1.2067** |
| SimHei | simhei.ttf | 256 | 220 / −36 / 36 | 220,36 / 0x40 | 1.1406 | 1.1406 | 同上 | 0.9777 / 0.9980 / 1.0139 / 0.9918 |
| DengXian | Deng.ttf | 2048 | 1659 / −475 / 0 | 1659,475 / 0x40 | 1.0420 | 1.0420 | 同上 | 0.9618 / 0.9725 / 0.9807 / 0.9924 |
| Tahoma | tahoma.ttf | 2048 | 2049 / −423 / 0 | 2049,423 / 0x40 | 1.2070 | 1.2070 | 同上 | 1.0346 / 0.9940 / 1.0164 / 1.0059 |

- 模型 vs Chromium 实测行盒：**均值 |误差| 0.34px、最大 1.12px**（28 个探针；最大的那个是
  msyh.ttc，本工具取到的是 Light 面，而浏览器用的是 Regular 面 —— .ttc 本来也不允许导入 UE）。
- 旧全局常数造成的每行误差：**均值 0.91px、最大 5.43px**（Noto Sans SC 20px）。
- 全角框宽：Noto Sans SC 的 advance 是 1000/1000 em，浏览器与 Slate 都是 1em；实测 14px 中文串宽度
  差异见 §7。

## 5. 换行

### 5.1 `WrapTextAt` 是必须的，`AutoWrapText` 不够

```
UMG/Public/Components/TextWidgetTypes.h:112  InWidget.SetAutoWrapText(!!AutoWrapText)
TextWidgetTypes.h:113                        InWidget.SetWrapTextAt(WrapTextAt != 0 ? WrapTextAt : TAttribute<float>())
Slate/Private/Widgets/Text/SlateTextBlockLayout.cpp:398-406  WrappingWidth = CachedWrapTextAt;
                                                             if (bCachedAutoWrapText && CachedSize.X >= 1) …
SlateTextBlockLayout.cpp:240                 CachedSize 只在 OnPaint 里赋值
```

`WrapTextAt == 0` 时属性根本没绑定；自动换行要用的 `CachedSize` 只有在 paint 期间才有值，
所以**首帧（离屏渲染只有一帧）的 desired size 永远是无界宽度**，一行都折不出来。这和
`AutoWrapText=true` 并不矛盾：它只管"允许不允许"，不管"宽度在哪"。

因此转换器对每个可换行文本发 `WrapTextAt = 内容盒宽度`：

```
内容宽 = rec.rect[2]（浏览器实测 border-box 宽） − paddingL − paddingR − borderL − borderR
```

- 单位是 Slate 单位（1:1 像素），**不参与 96/72 磅换算**（磅只用于 `Font.Size`）。
- `white-space: nowrap` 不发（同时 `AutoWrapText:false`）：这类元素设计上就是溢出/裁切。
- 浏览器已溢出/裁切的盒子仍然发内容宽：Slate 会折行而不是溢出，这比"文字跑出面板"更接近设计稿；
  严格还原溢出需要额外发 `Clipping`，属另一个议题。
- 拿不到 `rec.rect` 或内容宽 ≤0 时不发（宁可不换行，也不给错误宽度）。
- `--wrap-tolerance` / `HTML2UMG_WRAP_TOLERANCE`：给 Slate 一点余量，用于"Slate 字宽比浏览器略宽
  导致多折一行"的情况。默认 0；verify 的 mean|Δw| 若 >1px 再考虑 +0.5/+1。

### 5.2 中文没有空格 → `WrappingPolicy: AllowPerCharacterWrapping`

Slate 默认的 `DefaultWrapping` 只用断行迭代器给的候选点。中文长句在没有 ICU 断行数据时整段只有
一个候选点，永远折不开（`!IsWrapping || BreakCandidates.Num() == 0` 直接不折）。UE 提供
`ETextWrappingPolicy::AllowPerCharacterWrapping`
（`Slate/Public/Framework/Text/TextLayout.h:65`）：某个候选整体放不下时，退化为按字素逐个切分
（`TextLayout.cpp:625-635` 用 GraphemeBreakIterator）。这正是 CJK 需要的语义，且：

- **不往字符串里塞 U+200B**，WBP 里的文案保持和设计稿逐字一致（美术/程序可读可改）；
- 拉丁文本只在"单个单词比盒子还宽"时才触发，等于 CSS 的 `overflow-wrap: break-word` 兜底；
- `--cjk-breaks=policy|none` / `HTML2UMG_CJK_BREAKS` 可关掉（默认 policy）。

已知取舍：逐字断行不遵守 UAX #14 的标点规则，行首可能出现"，"。若 ICU 断行数据可用，候选点是
逐字的正常候选，标点规则由 ICU 给出，不受影响。

## 6. 复现与验收

```bash
# 字体表 + 模型校验（会自己开一次无头 Chromium）
node Plugins/Html2UMG/Resources/Tools/font_metrics.js --sizes 12,13,14,16,20 --json out/metrics.json

# 排版夹具
node Plugins/Html2UMG/Resources/Converter/cli/convert.js \
     Plugins/Html2UMG/Resources/Converter/test/11-typo.html -o out/typo.json --viewport 1200x900
```

几何验证（唯一跑编辑器的人执行）：

```
UnrealEditor.exe <工程>.uproject "-ExecCmds=Html2UMG.ImportRenderGeometry C:/out/typo.json /Game/UI/WBP_Typo C:/out/typo.png C:/out/typo-geo.json 1200x900, QUIT_EDITOR" -unattended -windowed
```

判据（11-typo.html，1200x900；下表是浏览器实测值，逐元素按 `data-ue-name` 对几何）：

| 元素 | CSS 实测 h | 行数 | 内容宽 | 字号/行高 | 用途 |
|---|---|---|---|---|---|
| `ZhPlain` | **88** | 4 | 352.67 | 14/22 | 无空格中文长段，**最重要的判据** |
| `ZhLh30` | **90** | 3 | 352.66 | 14/30 | 显式 line-height |
| `MixText` | **66** | 3 | 352.67 | 14/22 | 中英数字混排 |
| `Size12` | **17** | 1 | | 12/normal | 逐字体系数（Segoe 12→16 + 舍入） |
| `Size13` | **19** | 1 | | 13/normal | |
| `Size14` | **20** | 1 | | 14/normal | |
| `Size16` | **24** | 1 | | 16/normal | |
| `Size20` | **29** | 1 | | 20/normal | |
| `TitleWrap` | **28** | 1 | 240 | 20/28 | 边界：12 字 × 20px = 240px 正好填满，验"不许过度折行" |
| `NowrapText` | **22** | 1 | 260 | 14/22 | `white-space:nowrap` 必须不折、且 JSON 里没有 WrapTextAt |
| `SpaceCjk` | **20** | 1 | | 14/normal | Noto Sans SC：20.27/17 → LHP 1.1925 |
| `Norm12/14/16` | **16 / 19 / 21** | 1 | | normal | Segoe UI 逐字号 |
| `GapA` + `GapB` | 44 + 44 | 2+2 | | 14/22 | 竖直累计偏移 |

注意 `TitleWrap` 不是折行用例而是**边界用例**：中文 12 字 × 20px 正好等于 240px，Slate 若把字宽
测宽一点就会多折一行，这一条能直接暴露"Slate 字宽 > 浏览器字宽"。真正的折行判据是 `ZhPlain`（4 行）
和 `GapA/GapB`。

## 7. 仍然可能偏的地方（已知，未修）

1. **可变字体默认实例**：`NotoSansSC-VF.ttf` 是可变字体，这里解析的是文件头里的静态度量
   （default instance）；UE 导入可变字体时取默认实例，理论上一致，实测行盒也确实按 1.2000 走
   （11-typo 的 `SpaceCjk` 14px → `LineHeightPercentage=1.1925`，正好 20.27/17）。若换成
   其他可变中文字体，先用本工具复核。
2. **复合字体（FCompositeFont）的 max 规则**：CJK 回退子字体的上升/下降**不参与**行盒 ——
   `SlateFontRenderer::GetMaxHeight` 用的是
   `CompositeFontCache->GetDefaultFontData(InFontInfo)`（主字体），不是逐字形取 max。
   所以"拉丁主字体 + 中文回退"的行高由主字体决定，和浏览器一致；两者的差异只体现在字形与字宽上。
   如果 imp-composite 将来把回退做进 `DefaultTypeface`，这条结论要重新验证。
3. **`.ttc` 与缺失字体**：UE 不能导入 .ttc，字体表里的雅黑一类会退回内置 Segoe UI 度量，
   行高按 Segoe UI 走 → 与浏览器用雅黑时差最多 1.12px/行（上表 MS YaHei 行）。正确做法是换单面
   字体（Noto Sans SC / SimHei），这也是 conv-fonts 在做的事。
4. **EditableTextBox / ComboBox 的行高**：它们的字体在 `WidgetStyle.TextStyle.Font` 里，控件
   没有逐行 LineHeightPercentage 可用（单行输入框本来也只有一个行盒；ComboBox 行高改用
   `MenuRowPadding` 近似，仍是 `LINE_BOX_FACTOR` 旧算法）。多行文本框（textarea）的行距可能偏。
5. **letter-spacing 尾字间距**：`values.js: letterSpacingToSlate` 输出的是 1/1000 em 的整数
   （`FSlateFontInfo::LetterSpacing` 的单位），取整误差 ≤0.5‰ em ≈ 0.007px@14px，可忽略。
   但 CSS 在每个字后面都加间距（含最后一个字），会把行宽推大一个 spacing；Slate 的
   `FSlateFontInfo::LetterSpacing` 施加在字形推进上，尾字是否同样加宽取决于 shaping 路径，
   这里未验证 —— 2px 间距的 7 字中文串理论上有 2px 的宽度差。
6. **全角宽度**：中文 advance 都是 1em，浏览器与 Slate 一致；混排时差异来自西文字宽（字宽测量
   差异不在本文件范围，需要 verify 的 mean|Δw| 数据）。
7. **`text-shadow` 存在时**行盒会多出 `|dy|`：转换器已把它算进 LineHeightPercentage 的除数，
   但如果 CSS 的 shadow 有 blur，Slate 的行盒不会因为 blur 变大（浏览器也不会），保持一致。
## 8. 量化缺陷清单

两处缺陷必须分开看：**不换行**是"整段变一行"，**行高**是"每行差几像素"。前者在中文页面上吞掉整段高度，
后者逐行累计。

### 8.1 不换行（改前：整段 1 行）

| 元素（11-typo） | 浏览器 | 改前 UMG | 改后（本文） | 偏差 |
|---|---|---|---|---|
| `ZhPlain` 14px/22px 无空格中文 | 4 行 88px | 1 行 20.0px | 4×22 = 88 | 改前 **−68.0px** |
| `ZhLh30` 14px/30px | 3 行 90px | 1 行 ≈20px | 3×30 = 90 | 改前 −70px |
| `GapA`+`GapB`（各 2 行） | 44+44 | 20+20 | 44+44 | 改前 −48px |
| verify 400px 探针（中文无空格） | 2 行 44px | 1 行 22.2px | **44px（实测）** | 改前 −21.8px |

### 8.2 行高（模型计算，改前 = 全局常数，改后 = 逐字体）

"每行误差" = (CSS 行盒) − (该字体的 Slate 行盒 × 发出的 LineHeightPercentage)。旧公式对显式
`line-height` 和 `normal` 都把 `1.4167` 当作 Slate 系数，所以字体差多少就错多少。

| 字体 / 字号 | CSS 行盒 | Slate 行盒(hhea) | 旧每行误差 | 新每行误差 |
|---|---|---|---|---|
| Segoe UI 12px | 15.96 | 16（+1 阴影 17） | +0.04px | ≤0.05px |
| Segoe UI 16px | 21.28 | 21（+1 阴影 22） | −0.58px | ≤0.05px |
| Arial 16px | 18.40 | 18（+1 阴影 19） | −0.52px | ≤0.05px |
| Noto Sans SC 12px | 17.38 | 14（+1 阴影 15） | **−3.26px** | ≤0.05px |
| Noto Sans SC 16px | 23.17 | 19（+1 阴影 20） | **−4.35px** | ≤0.05px |
| Noto Sans SC 20px | 28.96 | 24（+1 阴影 25） | **−5.43px** | ≤0.05px |
| SimHei 12px | 13.69 | 14（+1 阴影 15） | +0.43px | ≤0.05px |
| DengXian 12px | 12.50 | 13（+1 阴影 14） | +0.67px | ≤0.05px |
| 显式 `line-height:22px` @14px Noto | 22.00 | 17（+1 阴影 18） | **−3.14px/行** | ≤0.05px |

旧常数在 28 个（字体 × 字号）探针上的每行误差：**均值 0.91px、最大 5.43px**。新模型的残差来自行盒
取整（≤0.5px，被 LineHeightPercentage 精确抵消）与系数四舍五入到 4 位（<0.001px）。

### 8.3 页面累计竖直偏移

按"Σ 行数 × 每行误差"算，文本总高（11-typo 27 个文本块、10-cjk 49 个）：

| 页面 | 旧模型文本总高 | 新模型文本总高 | 差值 |
|---|---|---|---|
| 11-typo（1200x900） | 704.6px | 734.8px | **+30.2px** |
| 10-cjk（1920x1080） | 1050.1px | 1103.7px | **+53.7px** |

最大的单项：`logo`（22px 中英混排）+6.4px、`H1`（32px，line-height:44px）+6.1px、`serif-note`
（16px/28px）+4.5px、`ZhPlain`（4 行）+8.1px、`ZhLh30`（3 行）+8.3px。这些块是流式堆叠的，所以在列的
方向上会累计成整块下移；旧实现把中文段落压扁，现在高度回到浏览器值。

### 8.4 基线 / 垂直居中偏移

清掉 `ShadowOffset` 之后，行盒内基线的位置差（Slate 基线 − CSS 基线，即 LHP 缩放后的 `hhea.asc+gap`
与 `usWinAsc + gap/2` 的差）：

| 字体 14px | CSS 基线 | 改前 Slate 基线 | 改后 Slate 基线 | 改前偏差 | 改后偏差 |
|---|---|---|---|---|---|
| Segoe UI | 15.11 | 15.15 | 14.81 | +0.04px | −0.30px |
| Noto Sans SC | 16.24 | 14.12 | 16.70 | **−2.12px** | +0.46px |
| SimHei | 15.23 | 15.23 | 15.06 | 0.00px | −0.17px |

改前中文字形整体偏高约 2px（1px 阴影 + 约 4% 行高偏小叠加），改后残差 <0.5px。

### 8.5 CJK 全角宽度与 letter-spacing（已实测）

`Resources/Tools/font_metrics.js --spacing 2` 实测（canvas measureText + 真实 span 宽度）：

| 字体 | CJK advance | Latin 'A' @14px | 12 字串无间距 | 加 2px 间距 | 增量 |
|---|---|---|---|---|---|
| Segoe UI 14px | **1.0000 em** | 9.03px | 121.59px | 145.59px | 24.00px = 12 × 2 |
| Noto Sans SC 14px | **1.0000 em** | 8.51px | 121.95px | 145.95px | 24.00px = 12 × 2 |
| Microsoft YaHei 14px | **1.0000 em** | 9.85px | 126.39px | 150.39px | 24.00px = 12 × 2 |

结论：

1. **CJK 全角 = 1.000em**，三家字体完全一致（12 个汉字 × 20px = 240px 也印证），所以 Slate 用同一份字形表时
   全角宽度误差为 0；整行宽度差只来自西文字形 advance。
2. **Chromium 在每个字符后面都加 letter-spacing，包括最后一个**（增量恰好 = 字数 × 间距，误差 0.00px）。
3. **Slate 不加在尾字上**：`SlateTextShaper.cpp:500-503` 在追加下一个字形时把间距加到**前一个**字形的
   `XAdvance`（`if (CurrentGlyphEntryIndex > 0 && bHasKerning)` 分支内），循环结束后没有补加。
   所以同一行 Slate 比浏览器**窄恰好 1 个间距**（`letter-spacing:2px` 时窄 2px）。

影响：只影响带 letter-spacing 的行；宽度差 1 个间距会让「居中/右对齐」整行偏移 spacing/2，也可能让本来
刚好放不下的一个字仍留在本行。**转换器侧无法补偿**（`LineHeightPercentage` 管不到宽度，往字符串里补空格
会污染文案）。`values.js` 的单位换算本身没有问题：取整误差 ≤0.5/1000 em = 0.007px/字@14px，20 字累计 0.14px。

## 9. 回归记录（改动后各页的数字从哪来）

### 9.1 01-flex：为什么数字变大了一点（legacy vs per-font）

`--line-height-model=legacy` 与默认 `per-font` 在同一页（1920x1080）上的对照，24 个 TextBlock 全部是单行：

| 指标 | legacy（旧全局常数） | per-font（本文件） |
|---|---|---|
| 平均 LineHeightPercentage | 0.9410 | 0.9989 |
| 文本总高（Σ 行盒） | 493.2px | 500.1px（**+7.0px**，最大单项 +1.5px，28px 数值文本） |
| 每行与浏览器的差 | 多为 −0.2 ~ −1.4px | ≤0.05px |
| ShadowOffset | 保留 UMG 默认 (1,1) | 无 text-shadow 时写 [0,0] |

**结论：per-font 让每行回到浏览器真实行盒，01-flex 的 +7px 是「改对了」而不是「改坏了」。**
单行文本的行盒变高（或变矮）会被行盒居中吸收掉一半左右，所以整页像素差异只会小幅波动；但页面里如果有
流式堆叠的文字，这 7px 会逐块累计——那是必须修的偏差，不是回归。

同一页上 `--text-shadow default`（保留 1px 阴影但把该像素算进行盒）与默认 `zero` 的差别：行盒高度几乎不变
（0.9480 × 28 = 26.54 对 0.9852 × 27 = 26.60），**主要影响是字形基线约 0.2px 的上移**。
所以 A/B 归因时，legacy → per-font（行盒正确性）和 zero → default（1px 基线）是两个独立的小量。

### 9.2 04-form：门控之后还剩 2 条误发（已知残差，未修）

| 元素 | WrapTextAt | 浏览器实际行数 | 误发原因 |
|---|---|---|---|
| `CancelButton_Label` | 40.47 | 1 | 按钮 `height:34px` 写死，行盒 17.3px → 34/17.3 = **1.96**，四舍五入成 2 行 |
| `SaveButton_Label` | 83.11 | 1 | 同上（`Save mission`） |

门控整体效果：01-flex 24 个 TextBlock 全不发（浏览器 0 个折行文本）；11-typo 27 个里发 5 个，正好是浏览器真的
折行的 5 个；10-cjk 47 个全不发（该页 1070px 宽，段落都 1 行）；04-form 13 个里发 2 个（就是上表两条误发）。

**根因**：`textLineCount()` 用 `contentHeight / lineBox` 推行数，只在高度由内容撑开时才成立。显式定高的盒子
（按钮、导航项、固定高标题栏）会把「单行居中」算成 2 行。

**建议补丁**（待定，需解冻）：`style.fixedHeight !== null` 时按 1 行处理，外加 `raw >= 1.75` 门槛。
代价是「显式定高且真的折行」的段落不再发 WrapTextAt（会溢出而不折），这符合「宁可单行溢出，也不要多折一行」的取舍。

### 9.3 表格单元格 Δh = −13px：不是竖向内边距丢了

10-cjk 的表头/表体 12 个单元格在几何 dump 里 `Th_Size/Td_Size` 的 h 恒为 **30**，而 TextBlock h=16、
Border 的 `Padding=[13,11,13,11]`（CSS padding 10 + border 1）也**确实**落到了容器上：16 + 22 = 38 ≠ 30。

真正的来源是**行高被均分**：`Table` 的 arrange 高度是 120px，4 行（1 表头 + 3 行）→ 每行 30px；
而浏览器里表头行 36.5px、表体行 41px（td 内容 20 + padding 20 + border 1）。30 = 120/4，与 padding 无关。

所以这条属于**表格/行高分配**（Table 的高度从哪来、行高如何分配），不是文本或内边距丢失：

- Border.Padding 生效（13/11/13/11 都在）；
- TextBlock 自身高度 16 与浏览器行盒 15.96 一致（差 0.04px）；
- 缺口全部在行容器的高度上，修它要动表格行高的推导，不在字体排版范围。

### 9.4 显式大行高：行盒高度精确，元素 y 偏移另算（LhNum 复核）

`line-height: 30px`、14px 字号的 LhNum / LhNum_1，最终批次实测：

| 元素 | DOM 行盒 | UMG 行盒 | 误差 | LHP |
|---|---|---|---|---|
| LhNum | 30.00px | 30.0029px | **+0.003px** | 1.5791 |
| LhNum_1 | 30.00px | 30.0024px | **+0.002px** | 1.6668 |

**结论：行盒高度与 CSS 的 line-height 一致，误差 <0.01px；LHP 换算在这类元素上没有误差。**
先前报的 Δtop −5/−6px 已作废——那是用「浏览器 DOM 盒子」和「UMG 盒子」各自裁剪找首行墨迹造成的测量假象
（两个盒子本身的 y 就差 +5.22px / −1.06px，且相邻文本会渗进裁剪区）。**元素 y 的偏移属于上方内容的累计位移，
不是行内基线偏移**；这两条的槽位是 VAlign=Top、Padding=[0,0,0,8]，不涉及垂直居中抵消。

理论上仍存在一项未量化的小差：CSS 把 `line-height − 自然行盒` 平分到基线上下，而 Slate 按升降部比例分配
（Latin ≈81% 在上方），静态推导是 0.1~0.2px 量级的首行基线差：

```
CSS   : baseline = usWinAsc/upem*px + (lineBox - cssBox)/2 + hheaGap/2
Slate : baseline = (asc+gap)/upem*ppem * LHP
```

这一项目前**没有可靠的测量证据**支撑符号与大小（见上），所以不写成缺陷，也不做补偿；
`LineHeightPercentage` 本身只能缩放总行盒、改变不了分配比例，真要动只能靠槽位偏移（布局侧）。
若以后要量化，建议直接量「同一行文本的墨迹质心」而不是裁剪框，并排除相邻文本渗入。

（附：`FTextLayout::SetMargin` 确实会把文本整体位移 `Margin.Left/Top`，见 `TextLayout.cpp:567-577`、
`2234-2247`。理论上可以用负的 `Margin.Top` 把基线推回去，但 UMG 的 `Margin` 同时参与期望尺寸，且负数是否被
上层 clamp 未验证——留作备选，不在本轮采用。）

### 9.5 最终批次实测（wrap-probe，400px 盒子，几何 dump 复核）

`Html2UMG.ImportRenderGeometry ... C:/out/final/wrap-probe/geo.json`，四个 400px 盒子（内容宽 382）：

| 元素 | 内容 | 浏览器 | 改前 UMG | 改后 UMG（geo.json） |
|---|---|---|---|---|
| En | 英文多词 | 66px / 3 行 | 22.2px / 1 行 | **66.0px** |
| Zh | 中文无空格 | 44px / 2 行 | 22.2px / 1 行 | **44.0px** |
| Zwsp | 中文 + U+200B | 44px / 2 行 | 22.2px / 1 行 | **44.0px** |
| Nowrap | white-space:nowrap | 22px / 1 行 | 22.2px / 1 行 | **22.0px** |

`WrapTextAt` + `WrappingPolicy: AllowPerCharacterWrapping` 同时解决英文与无空格中文的折行，且不需要往字符串里
注入 U+200B（Zwsp 组与 Zh 组结果一致）。同期整批数字：wrap-probe 4.89%、10-cjk **3.82%**（结构边匹配 92.6%）、
11-typo 10.27%。10-cjk 的轨迹是 17.12% → 8.58% → 3.82%。

### 9.6 表格单元格仍待办（范围外）

表格 12 个单元格的 Δh 由 §9.3 的行高均分造成（Table 120 / 4 = 30），与字体排版无关；
修它需要动表格行高的推导，属布局侧。

### 9.7 normal 行高遇回退字体：改用浏览器实测的 content box

根因：`line-height: normal` 的行盒高度取决于 Chromium **真正使用**的字形所属字体。主字体 Segoe UI 是 1.3301em，
而中文字形会被雅黑(1.42)/Noto(1.448) 之类接管，于是 `16px 中文` 在浏览器里是 24px 行盒，而只按主字体算出来是 21.31px，
LHP 就写成 ≈1.0（等于没下发）。同页 `Norm12/14/16`（纯 Segoe）反而全对，正好证明模型本身没错，缺的是「回退字体参与行盒」这一项。

因此 `cssLineBoxPx()` 的取值顺序是：**显式 line-height > 浏览器实测 content box > 字体模型**。

> **门控条件（五条必须同时成立才用实测值，缺一退回模型）**：
> ① `line-height` 是 `normal`；② 文本确有主字体 cmap 覆盖不到的码位；③ `fixedHeight === null`（高度不是作者写死）；
> ④ 不是 `table-cell/table/inline-table`；⑤ `|contentHeight/modelCssBox − round(raw)| ≤ 0.15`（盒子没被父级拉高）。
> 换句话说：**实测值不是"更好的测量"，只是补"回退字体参与行盒"这一项；不满足条件时模型值更可信。**

多行时 `cssLineBox = contentHeight / round(ratio)`。11-typo 第 04 组（`.s12/.s13/.s14/.s16/.s20`，文本含中文回退）改后：

| 元素 | 字号 | 新 LineHeightPercentage | Slate 行盒 | 推算高度 | 浏览器 |
|---|---|---|---|---|---|
| Size12 | 12px | 1.0625 | 16 | **17.00** | 17 |
| Size13 | 13px | 1.1176 | 17 | **19.00** | 19 |
| Size14 | 14px | 1.0526 | 19 | **20.00** | 20 |
| Size16 | 16px | 1.1429 | 21 | **24.00** | 24 |
| Size20 | 20px | 1.0741 | 27 | **29.00** | 29 |

对照组 `Norm12/14/16`（纯 Segoe，无回退）LHP 仍是 0.9976 / 0.9801 / 1.0134，与改动前**逐位相同**。
把 `C:/out/final/<page>/layout.json` 与改后版本逐元素比 LHP：01-flex / 02-absolute / 03-dashboard / 04-form 全部
**changed=0（maxD=0.0000）**；01..09 这九个页面的 HTML 里 CJK 字符数为 0，实测路径根本不会触发，所以纯拉丁页不受影响。
10-cjk（CJK 页）有 21 个元素 LHP 变化，最大 0.0944（Logo：1.009 → 1.1034，行盒 29 → 32 对上浏览器的 32），
其余多在 0.0002~0.005，方向都是朝浏览器实测值。

### 9.8 定高元素不再发 WrapTextAt（04-form 两条误发已修）

`textLineCount()` 现在先看 `style.fixedHeight`：**高度是作者写死的，就不能当行数证据**（34px 按钮 ÷ 17.3px 行盒 = 1.96
「行」，会骗过取整）。04-form 因此从 2 条误发变成 **0**，11-typo 仍是 5/5 命中真正折行的文本，10-cjk 0（该页全单行）。
代价：显式定高 + 真的折行的段落不再发 WrapTextAt（会溢出而不折），符合「宁可单行溢出，也不要多折一行」的取舍。

### 9.9 ShadowOffset=[0,0] 的 A/B 结论（决定是否保留为默认）

`04-form`（1920x1080，无 CJK，13 个 TextBlock）同尺寸两次离屏渲染，唯一差别是 `--text-shadow default`
（保留 UMG 默认 (1,1) 并把该像素算进行盒）vs 默认 `zero`（写 `[0,0]`）：

| 配置 | 差异像素（严格逐像素口径） | 占画布 |
|---|---|---|
| `--text-shadow default` | 44,785 | 2.160% |
| 默认 `zero`（ShadowOffset=[0,0]） | 44,717 | 2.156% |

**差 68 像素 = 画布的 0.003%** —— 保留阴影与清掉阴影在这个文字密集页上**像素等价**。

结论：**保留 `ShadowOffset=[0,0]` 作为默认**，理由不是「像素更好」，而是它让行盒回到字体自身的度量：

- 保留 (1,1) 时 `FSlateTextRun::GetMaxHeight` 每行无条件多 1px，行盒只能靠 LHP 反向补偿，LHP 里就混进了一个
  与字体无关的常数（旧 1.0625 就是这么来的）；
- 清掉之后 LHP 只表达「CSS 行盒 / Slate 行盒」，公式与字体表一一对应，后人不必再猜那个 1px；
- 代价是基线在行盒内移动约 0.2px（A/B 已证明对像素无影响），而带 `text-shadow` 的设计仍然写出真实偏移。

### 9.10 03/04 两页 +0.2~0.35pp 归因（不是阴影，也不是行高错）

`04-form` 的 17 个文本元素，在「旧全局常数」与「逐字体 + 实测行盒」两套模型下的行盒（浏览器实测为基准）：

| 字号类别 | CSS 行盒 | 旧模型行盒 | 新模型行盒 | 旧误差 | 新误差 |
|---|---|---|---|---|---|
| 11px 标签 | 14.6 | 15.1 | 14.6 | +0.5 | 0.0 |
| 13px 选项/输入 | 17.3 | 16.9 | 17.3 | −0.4 | 0.0 |
| 18px 段落标题 | 23.9 | 23.5 | 23.9 | −0.4 | 0.0 |
| 13px 按钮文字 | 14.9 | 15.1 | 14.9 | +0.2 | 0.0 |
| **合计（17 个元素）** | — | 276.7px | 276.0px | — | — |

新模型让每行回到浏览器实测值（误差 0.0），但每行有 ±0.4px 的**位置**变化；在抗锯齿小字上，系统性的 0.2~0.4px
位移会改变大量字形边缘像素——这正是 04-form 像素差 +0.34pp 的量级来源，而同期**结构边匹配从 63.2% 提升到 75.3%**
（门控修掉多折行之前只有约 40.9%）。也就是说：结构更对，字位在 1px 内重排。

因此这两页的 +0.2~0.35pp 不构成回退理由；真正可归因的排版收益在中文页（10-cjk 17.12% → 3.82%）与折行类页面
（01-flex 1.49% → 0.88%、11-typo 同尺寸口径 15.02% → 11.23%）。

## 10. 行内垂直对齐：文本盒比行盒高时怎么摆

CSS 在一行里怎么摆文字，由 `align-items` / 行高 / 单元格默认值决定；Slate 的槽位只能「拉伸(Fill)」或「贴一边」。
两者不等价的地方全是**竖直位置错开 5~17px** 的大错，不是亚像素问题。

### 10.1 规则：用浏览器算出来的偏移，而不是猜对齐方式

当文本控件落在**横向流容器**（HorizontalBox / WrapBox）里、且它在浏览器里的盒子明显比父内容盒矮时，
转换器把槽位改成 `VerticalAlignment=Top` + `Padding.Top = 子盒 top − 父内容盒 top`：

```
offset = rec.rect[1] − (rec.prect[1] + parentPaddingTop + parentBorderTop)
父内容高 = prec[3] − padTop − padBottom − borderTop − borderBottom
触发条件：父是 HORIZONTAL/WRAP 且 ownHeight + 0.5 < 父内容高 且 0.01 < offset ≤ 父内容高 − ownHeight
```

这样 `align-items: baseline / center / flex-end` 三种都能**精确**复现（offset 就是浏览器算出来的结果），
不需要为每种对齐写一套逻辑。竖直流容器（VerticalBox）不动：那里的竖直方向是流轴，padding 会二次位移；
Border / Button / SizeBox 这些盒槽也不动（它们本身要么居中，要么已经在别处补偿）。

### 10.2 实测效果（03-dashboard `.statRow { align-items: baseline }`）

| 元素 | 浏览器盒 | UMG 盒（改前） | 墨迹 Δtop（改前） | 改后槽位 |
|---|---|---|---|---|
| StatUnit | 16.0 @140 | 34.6 @124.9 | **−11.4px** | Top + Padding[6,15,0,0] |
| StatUnit_1 | 16.0 @250 | 34.6 @234.1 | **−15.9px** | Top + Padding[6,15,0,0] |
| StatUnit_2 | 16.0 @360 | 34.6 | — | Top + Padding[6,15,0,0] |

`.statUnit` 与 26px 的数值按基线对齐，所以它距行首 15.14px；Slate 的行槽只能拉满（Fill）或在顶部，
于是差了 11~16px。用浏览器偏移后，文字盒落在 15px 处，与浏览器一致。

同类修正（都是"真实偏移"而不是新算法）：04-form `Label_5/6` +1px、05-controls `Check_*_Text` +23/52/81px
（父内容高 65、文本 42，浏览器本来就是底部对齐）、10-cjk `Logo` +19.5px（header 72 居中，位置不变）。
**其余 6 页 0 处改动；全 11 页的 LineHeightPercentage 与 WrapTextAt 均零变化。**

### 10.3 `--line-box-snap=exact|half|int`（A/B 开关，默认 exact）

换算目标行盒（仅 `line-height: normal`；作者写了行高就以它为准）：

| 模式 | 04-form 13 个 TextBlock 的 LHP | 说明 |
|---|---|---|
| exact（默认） | 0.9754 / 0.9976 / 1.0171 | 字体分数度量（Chromium 的 LayoutUnit 也是分数） |
| half | 0.9667 / 1.0 / 1.0294 | 取整到 0.5px，11px 反而更矮 |
| int | **全部 1.0000** | 11→15、12→16、13→17、18→24，与浏览器实测行盒一致 |

实测依据：Segoe UI 的 `line-height: normal` 在 11/12/13/14/16/18/20/28/32px 下的浏览器行盒依次是
15/16/17/19/21/24/27/37/43 px，等于 **round(1.3301 × px)**（分数度量依次是 14.63/15.96/17.29/18.62/21.28/
23.94/26.60/37.24/42.56）。也就是说 Chromium 在 **normal** 情况下把行盒落在整数像素上，而字体度量是分数。
所以 `int` 不是"近似"，而是更贴近浏览器的目标值；默认值是否切换等 A/B 渲染数据（03/04 的差异必须下降，
11-typo 十项几何不能变差）。

### 10.4 这条与 03/04 回归的关系

03/04 的 +0.2~0.4pp 已经确认**不在文本盒内**（04-form 文本盒只占全页差异 27.5%，03 占 18.5%）：
真正的原因是行盒高度的 ±0.2~0.4px 会**推动下游控件**，而下游里有烘焙贴图（滑块轨道、对话框底边、瓦片缩略图），
分数像素位置会触发贴图重采样。证据：浏览器 form 高 575.0，UMG legacy 574.8（−0.2），UMG per-font 573.06（−1.94）——
legacy 每行 +0.43px 的偏大恰好补上了总和，所以它"碰巧更准"。`--line-box-snap=int` 正是为这种情形准备的 A/B 开关。

## 11. 行盒取整与 03/04 回归的最终归因

### 11.1 实测：Chromium 的 normal 行盒是「三分量各自取整后相加」

Chromium 的 `line-height: normal` 行盒**不等于** `ratio × px`，也不等于 `round(ratio × px)`，而是：

```
lineBox = round(usWinAscent/upem × px) + round(usWinDescent/upem × px) + round(hhea.lineGap/upem × px)
```

对 Segoe UI / Arial / Noto Sans SC 在 11..32px 共 **33 个探针**验证：

| 公式 | 命中 | 最大误差 |
|---|---|---|
| 分数（旧 exact） | 0/33 | 0.61px（17px Segoe：22.61 vs 22） |
| round(ratio×px)（int） | 29/33 | 1px（Noto 16px：23 vs 24） |
| **三分量各自取整** | **33/33** | **0.00px** |

具体例子（都来自实机测量）：

| 字体/字号 | asc | desc | gap | 三分量模型 | 实测 | 分数版 | round 版 |
|---|---|---|---|---|---|---|---|
| Segoe UI 17px | 18.35 | 4.27 | 0 | 18+4 = **22** | 22 | 22.61 | 23 |
| Segoe UI 26px | 28.06 | 6.53 | 0 | 28+7 = **35** | 35 | 34.58 | 35 |
| Noto Sans SC 16px | 18.56 | 4.61 | 0 | 19+5 = **24** | 24 | 23.17 | 23 |
| Arial 16px | 14.48 | 3.39 | 0.52 | 14+3+1 = **18** | 18 | 18.40 | 18 |
| Consolas 12px | 11.04 | 3.01 | 2.05 | 11+3+2 = 16 | **14** | 16.10 | 16 |

（Consolas 是已知例外：Chrome 对它的 lineGap 不加。全 12 字体 × 14 字号的拟合里，三分量公式 112/168 精确、
 `round(asc)+round(desc)` 146/168 精确；两个公式在**无 lineGap 的字体上等价**，本项目页面用的 Segoe UI /
 Noto Sans SC / Courier 都是这一类。Consolas 这类大 lineGap 字体按 `round(asc)+round(desc)` 更准，记为已知残差。）

实现：`--line-box-snap=font`（新增模式，**默认仍是 exact**，等 A/B 数据决定）。

### 11.2 modes × 页面（离屏渲染实测，1920x1080，结构边匹配）

| 页面 | exact | half | int | 备注 |
|---|---|---|---|---|
| 03-dashboard | 3.24% / 70.6% | 3.29% / 72.6% | 3.37% / 73.5% | exact 那一版跑在槽位修复**之前**（StatUnit 仍 Fill），不可直接比较 |
| 04-form | 1.86% / 75.3% | 1.86% / 75.3% | **1.46% / 77.3%** | int 比 before(1.47) 还好一点 |

结论：**int（以及等价的 font 模式）对块级竖直流有利**——04-form 的 13 个文本行盒变成整数像素后，整条竖直流
与浏览器对齐，烘焙贴图不再被分数像素重采样，差异 −0.40pp。03-dashboard 反向（+0.13pp），原因是它只有少数元素
随字号变化、而且 17px 的 `tv` 元素在 round 口径下会被高估 1px（22 → 23）；`font` 口径同时修好 17px 与 Noto 16px。

### 11.3 表格单元格：文字位置其实只差 1~3px（不要按"盒高差"去补）

10-cjk 每个单元格按自己的 y 裁剪、比**墨迹质心**（不是盒子）：

| 单元格 | 浏览器墨迹 y | UMG 墨迹 y | 差 |
|---|---|---|---|
| th ×4 | 567.6 ~ 568.7 | 565.7 ~ 566.0 | **−2.9 ~ −1.7px** |
| td ×2 | 602.6 / 622.2 | 602.9 / 623.9 | **+0.4 / +1.7px** |

而 TextBlock 盒高(19) 与 `td` 盒高(41) 的差 22px、以及与"文字框顶"的差 11px，全部是 `td` 的 padding(10)+border(1)，
已经由外层 Border 的 `Padding=[13,11,13,11]` 承担。**若按"文本盒高 > 行盒高 +2 就补 Padding.Top"去改，
文字会被整体推低 11px**，是新增错误而不是修复。

### 11.4 33 探针全表（Segoe UI / Arial / Noto Sans SC × 11 px，Chromium 实测）

复现：`node Resources/Tools/font_metrics.js --families "Segoe UI,Arial,Noto Sans SC" --sizes 11,12,13,14,15,16,17,18,20,26,32`。
asc / desc / gap 由 `fontmetrics.cssSidesRatio()` 给出（em × px），"三分量"是各自 `Math.round` 后相加。


| 字体 | px | asc | desc | gap | 三分量（各自取整） | 实测 | 分数 | round(总和) | 命中 |
|---|---|---|---|---|---|---|---|---|---|
| Segoe UI | 11 | 11.87 | 2.76 | 0.00 | 12+3+0 = **15** | 15 | 14.63 | 15 | ✓ |
| Segoe UI | 12 | 12.95 | 3.01 | 0.00 | 13+3+0 = **16** | 16 | 15.96 | 16 | ✓ |
| Segoe UI | 13 | 14.03 | 3.26 | 0.00 | 14+3+0 = **17** | 17 | 17.29 | 17 | ✓ |
| Segoe UI | 14 | 15.11 | 3.51 | 0.00 | 15+4+0 = **19** | 19 | 18.62 | 19 | ✓ |
| Segoe UI | 15 | 16.19 | 3.76 | 0.00 | 16+4+0 = **20** | 20 | 19.95 | 20 | ✓ |
| Segoe UI | 16 | 17.27 | 4.02 | 0.00 | 17+4+0 = **21** | 21 | 21.28 | 21 | ✓ |
| Segoe UI | 17 | 18.34 | 4.27 | 0.00 | 18+4+0 = **22** | 22 | 22.61 | 23 | ✓ |
| Segoe UI | 18 | 19.42 | 4.52 | 0.00 | 19+5+0 = **24** | 24 | 23.94 | 24 | ✓ |
| Segoe UI | 20 | 21.58 | 5.02 | 0.00 | 22+5+0 = **27** | 27 | 26.60 | 27 | ✓ |
| Segoe UI | 26 | 28.06 | 6.53 | 0.00 | 28+7+0 = **35** | 35 | 34.58 | 35 | ✓ |
| Segoe UI | 32 | 34.53 | 8.03 | 0.00 | 35+8+0 = **43** | 43 | 42.56 | 43 | ✓ |
| Arial | 11 | 9.96 | 2.33 | 0.36 | 10+2+0 = **12** | 12 | 12.65 | 13 | ✓ |
| Arial | 12 | 10.86 | 2.54 | 0.39 | 11+3+0 = **14** | 14 | 13.80 | 14 | ✓ |
| Arial | 13 | 11.77 | 2.75 | 0.43 | 12+3+0 = **15** | 15 | 14.95 | 15 | ✓ |
| Arial | 14 | 12.67 | 2.97 | 0.46 | 13+3+0 = **16** | 16 | 16.10 | 16 | ✓ |
| Arial | 15 | 13.58 | 3.18 | 0.49 | 14+3+0 = **17** | 17 | 17.25 | 17 | ✓ |
| Arial | 16 | 14.48 | 3.39 | 0.52 | 14+3+1 = **18** | 18 | 18.40 | 18 | ✓ |
| Arial | 17 | 15.39 | 3.60 | 0.56 | 15+4+1 = **20** | 20 | 19.55 | 20 | ✓ |
| Arial | 18 | 16.29 | 3.81 | 0.59 | 16+4+1 = **21** | 21 | 20.70 | 21 | ✓ |
| Arial | 20 | 18.11 | 4.24 | 0.65 | 18+4+1 = **23** | 23 | 23.00 | 23 | ✓ |
| Arial | 26 | 23.54 | 5.51 | 0.85 | 24+6+1 = **31** | 31 | 29.90 | 30 | ✓ |
| Arial | 32 | 28.97 | 6.78 | 1.05 | 29+7+1 = **37** | 37 | 36.80 | 37 | ✓ |
| Noto Sans SC | 11 | 12.76 | 3.17 | 0.00 | 13+3+0 = **16** | 16 | 15.93 | 16 | ✓ |
| Noto Sans SC | 12 | 13.92 | 3.46 | 0.00 | 14+3+0 = **17** | 17 | 17.38 | 17 | ✓ |
| Noto Sans SC | 13 | 15.08 | 3.74 | 0.00 | 15+4+0 = **19** | 19 | 18.82 | 19 | ✓ |
| Noto Sans SC | 14 | 16.24 | 4.03 | 0.00 | 16+4+0 = **20** | 20 | 20.27 | 20 | ✓ |
| Noto Sans SC | 15 | 17.40 | 4.32 | 0.00 | 17+4+0 = **21** | 21 | 21.72 | 22 | ✓ |
| Noto Sans SC | 16 | 18.56 | 4.61 | 0.00 | 19+5+0 = **24** | 24 | 23.17 | 23 | ✓ |
| Noto Sans SC | 17 | 19.72 | 4.90 | 0.00 | 20+5+0 = **25** | 25 | 24.62 | 25 | ✓ |
| Noto Sans SC | 18 | 20.88 | 5.18 | 0.00 | 21+5+0 = **26** | 26 | 26.06 | 26 | ✓ |
| Noto Sans SC | 20 | 23.20 | 5.76 | 0.00 | 23+6+0 = **29** | 29 | 28.96 | 29 | ✓ |
| Noto Sans SC | 26 | 30.16 | 7.49 | 0.00 | 30+7+0 = **37** | 37 | 37.65 | 38 | ✓ |
| Noto Sans SC | 32 | 37.12 | 9.22 | 0.00 | 37+9+0 = **46** | 46 | 46.34 | 46 | ✓ |

各自取整命中 **33/33**，分数命中 1/33，round(总和) 命中 27/33。

读法：**asc/desc/gap 必须各自取整再相加**——把三者先相加再取整（round 版）在 27/33 处对、6 处差 1px；不取整（分数版）只有 1/33 对。

### 11.5 落位规则的守卫（05-controls 误触发复盘）

第一版只按「元素盒高 + 0.5 < 父内容盒高」判断，结果在 05-controls 上把三个 `label.check` 误判成
「被行拉高、需要按浏览器偏移落位」，给它们补了 `Padding.Top = 23 / 52 / 81`，整页 2.53% → 4.77%。

**根因**：`label.check` 的 DOM 父其实是 **flex 列**（102px 高的 checks 列），23/52/81 相差 29px
正好是一个行距——那是它在列里的**累计位置**，不是行内对齐偏移。而在 UMG 里它的父是 label 自己的内层行，
两者根本不是同一个盒子，所以 `rec.prect` 参照的父级是错的。

现在的守卫（全部保留，缺一不可）：

| 守卫 | 作用 |
|---|---|
| 槽位 `VAlign === "Center"` → 跳过 | CSS 居中已表达，再加 padding 会推下去 |
| `textVerticalCenter`（line-height == 盒高的居中路径）→ 跳过 | 同上，避免双重偏移 |
| **DOM 父必须是横向容器**（flex/grid + row，或 inline 级） | 排除"DOM 父是列"导致把累计位置当偏移 |
| `offset > 父内容盒高 × 0.45` → 跳过 + info | 行内对齐不可能占近半行高 |
| 多行文本（自身高 > 行盒 × 1.6）→ 跳过 + info | 多行块由自身盒决定，不是单行标签对齐 |
| `0.01 < offset ≤ 父内容盒高 − 自身盒高` | 兜底边界 |

收紧后的实测（当前代码）：

| 页面 | slot 变化 | 明细 |
|---|---|---|
| 03-dashboard | **3** | StatUnit / StatUnit_1 / StatUnit_2 → `Top` + `Padding[6,15,0,0]`（墨迹 −11.40→+3.25、−15.87→+0.26） |
| 05-controls | **0** | Check_Text / Check_1_Text / Check_2_Text 回到 `Center` + `Padding[10,0,0,0]` |
| 10-cjk | 1 | Logo → `Top` + 19.5（位置等价） |
| 04-form | 2 | Label_5 / Label_6 → `Top` + 1px |
| 01-flex / 11-typo | 0 | — |

### 11.6 最终策略：实测行盒是默认路径，字体模型只是兜底

模型对整个字体族是准的，但**每个"例外字体"都会带来 0.3~2px 的系统偏差**，而这些偏差正好被下游的贴图重采样放大：

| 情形 | 模型给的行盒 | 浏览器实测 | 差 |
|---|---|---|---|
| Consolas 12px（Chrome 不加 lineGap） | 16.10 | **14** | −2.1px |
| 10px 小字（三分量取整边界） | 13.30 | **14** | +0.7px |
| 17px（round 边界） | 22.61 | **22** | −0.6px |
| `.ttc` 首面 / 可变字体默认实例 | 可能差 1~2px | 实测即可 | — |

因此 `measuredCssLineBox()` 现在是**默认路径**：只要 `line-height` 是 `normal`（作者写了行高就以作者为准）、
盒子不是定高、不是 `table-cell`，且 `contentBoxHeight / modelBox` 落在整数 ±0.15 内，就用
`contentBoxHeight / round(raw)` 作为 CSS 行盒；模型只在拿不到实测时兜底。

触发 info 的条件：实测与模型差 ≥ 0.5px（说明这个字体/字号的模型值不可信，值得记录）。本次 9 页里 03-dashboard
有 5 条（Consolas ×2、10px ×4 类、17px ×8 类合并成 5 条去重日志）、10-cjk 2 条、11-typo 5 条，01/04/05 各 0 条
（说明这几页模型本就准，实测只是把 0.2~0.5px 的零头归零）。

实测后的行盒（同一页面）：Consolas 12px `1.1501 → 1.0000`（16.10 → 14）、10px 标签 `1.0231 → 1.0769`
（13.30 → 14）、17px `0.9831 → 0.9565`（22.61 → 22）；11-typo 的 Size12…20 仍是 17/19/20/24/29，
显式行高的用例（22/30/28）完全不动。

### 11.7 实测路径的阈值与一次"守卫没生效"的事故

**阈值**：实测行盒只有在与模型值相差 ≥ **0.25px** 时才采用（`HTML2UMG_LINE_BOX_MEASURE_MIN` 可调，默认 0.25）。
原因是一个可复现的权衡：

| 页面 | 靠实测拿到的收益 | 说明 |
|---|---|---|
| 04-form | 1.86% → **1.46%** | 11px/13px 的实测=整数行盒（15/17），与模型差 0.37/0.29px |
| 06-native | 1.93% → 2.21%（若无阈值） | 该页模型本来就准，实测只把 0.2~0.4px 的零头带进来，扰动烘焙贴图 |

两页的差值幅度重叠（都在 0.2~0.4px），所以阈值只能折中：**0.25** 保住 04 的 0.37/0.29，同时把 06 大多数元素
留在模型值上。触发实测时会打一条 info，写清 `measured / model / Δ`，便于以后调这个数。

**事故**：这个守卫最初写的是 `if (slot && slot.VerticalAlignment === "Center") return null;`，但调用处写成了
`this.crossAxisTextOffset(parent, pmeta, cmeta)` —— **第 4 个参数 `slot` 没传**，于是 `slot` 恒为 `undefined`，
守卫永远不成立：任何"本来已经被 boxSlot 设成 Center"的槽位都会被改成 `Top + padding`。

- 05-controls 当时靠另外两条守卫（`textVerticalCenter`、offset > 45% 行高）侥幸挡住；
- 06-native 的 `Row_Text`（`VAlign=Center, Padding[10,0,0,0]`）没有这两条特征，被改成 `Top + 23`，整块文字下移，
  该页 1.93% → 2.21%；
- 修复即补上参数；修完 06-native 的 slot 变化回到 **0**。

教训写在这里：**带守卫的辅助函数，调用时漏传参数不会报错（JS 里 `undefined` 让 `&&` 短路），而守卫恰好是"安全网"**。
以后这类函数要么把 slot 放到参数首位并加断言，要么在函数内部自己从 `rawSlot` 的结果取。

## 12. flex 的 `justify-content: center/end` 空闲空间（C2）

这不是字体问题，但同一个文件里已经反复出现"浏览器算好了、UMG 没有对应表达"的形状，记在这里。

### 12.1 现象与根因

`body { display:flex; align-items:center; justify-content:center }` 里放一个 1240x672 的面板：
浏览器把面板放在 x=**340**，UMG 里 `SettingsPanel_Size` 的 x=**0**，整块左移 340px（该页差异 23.49%）。

根因：Slate 的 box 槽位**没有"分配空闲空间"的概念**。槽位的对齐（`HorizontalAlignment=Center`）只在
*分配给该子项的宽度*内起作用，而 `SizeRule=Automatic` 时分配宽 = 期望宽度，剩余空间被直接丢掉；
`space-between` 之前用 `measureMainGaps()` 把实测间距折进 padding 解决了，但 center/end 的**前导空闲**没有任何机制承载。

### 12.2 规则（`boxSlot` + `justifyLeadingOffset`）

```
触发：父 justify-content ∈ {center, end, flex-end, right, space-around, space-evenly}
     且父是 HorizontalBox / VerticalBox（WrapBox 的 boxSlot 走 orientation="w"，直接跳过）
     且子 index === 0 且该槽位不是 Fill（flex-grow 会自己撑满）
leading = 子 rect 主轴起点 − 父内容盒主轴起点
extra   = leading − 该槽位已有的主轴 padding（避免与 margin/gap 重复计）
落位：Padding[主轴] += extra，并把主轴对齐强制成 Left/Top
```

**为什么要改对齐**：padding 已经把位置写死，若再让槽位 `Center`，Slate 会在"减去 padding 后的区域"里
再居中一次，等于移两遍。

### 12.3 守卫：`end` 对齐不能被当成"累计偏移"

最初写的是 `leading > 父内容盒主轴 × 0.5 → 不落位`，结果把**右对齐**的控件也挡掉了：
`justify-content: flex-end` 的 380px 窄行里，一个 42px 的开关 `leading=338`，本来就在"剩余空间全在前头"的位置。

所以判据改成"预测 end 对齐的位置再看对不对得上"：

```
endOffset = 父内容盒主轴 − 子主轴尺寸
|leading − endOffset| ≤ 2px  →  end 对齐，落位
否则 leading > 父内容盒主轴 × 0.5  →  累计偏移，不落位 + info（打印 leading 与 endOffset）
```

| 元素（skyline-settings） | leading | 子尺寸 | endOffset | 判定 | 落位后 padding |
|---|---|---|---|---|---|
| `input.switch`（MotionBlur） | 338.0 | 42.0 | 338.0 | end 对齐 | **338** |
| `input`（VSync 勾选） | 363.0 | 17.0 | 363.0 | end 对齐 | **363** |
| 普通文本输入 | 0.0 | 304.5 | 75.5 | 本来就靠左 | 不加 |
| `SettingsPanel_Size`（center） | 340.0 | 1240 | — | center | **340** |

实测几何（`Html2UMG.ImportRenderGeometry`）：`SettingsPanel_Size x=340.0 y=205.0 w=1240 h=670`，
与浏览器一致；该页像素差异 23.49% → 1.52%（结构边 86.9%），end 对齐修好后进一步下降。

回归：9 个测试页 + 10-cjk 的 slot 变化为 0（除 02-absolute 的 `K` +9.5px、03-dashboard 的 `Label` +10px 两处**真实改善**）。

### 12.4 最终实测（含两处 end 对齐实例）

| 节点（slot） | 落位后主轴 padding | 浏览器 / 说明 |
|---|---|---|
| `SettingsPanel_Size`（SizeBox，父 `body` 是 flex-row + `justify-content:center`） | `Padding[**340**,0,0,0]` | 浏览器 #panel x=**340** ✓ 精确命中 |
| `MotionBlurSwitch_Size`（父行 `justify-content:flex-end`，子宽 42 / 行宽 380） | `Padding[**338**,0,0,0]` | `|338 − (380−42)| = 0` → end 对齐，落位 |
| `VSyncCheck_Size`（同上，子宽 17） | `Padding[**363**,0,0,0]` | `|363 − (380−17)| = 0` → end 对齐，落位 |

几何 dump：`SettingsPanel_Size x=340.0 y=205.0 w=1240 h=670`；浏览器 `#panel = [340, 204, 1240, 672]`。

- **x 精确命中**（这是本次修的东西：23.49% → **1.43%**，结构边 86.9% → **88.1%**，2026-10-27 19:30 批次）；
- **y 差 1px**：面板在 UMG 里 670 高、浏览器 672，而 `body` 是 `align-items:center`，
  居中结果 `(1080−670)/2 = 205` 对 `(1080−672)/2 = 204` → 整块低 1px（audit 报的 "(0,1) 平移"，补偿后 1.35%）。
  这 2px 的根子在 `#subtitle`：它 `data-ue-font-map` 指向工程内资产 `UAV-OSD-Mono_Font`，转换器**读不到字体文件**，
  LHP 只能用内置 Segoe 度量估算（该节点 15/15 = 1.0），而该资产的自然行盒是 13 → 少 2px。
  属于"映射到不可测量资产"的已知残差（本页 30 个 TextBlock 里有 **10 个**走这条路径），不在本次修复范围。

## 13. 控件文字居中与"浏览器没折就别折"

### 13.1 按钮文字贴顶（VAlign=Fill 的代价）

`<button>` 的文字在 CSS 里是垂直居中的（UA 默认 `align-items:center`），而 Slate 的 `TextBlock` **永远从盒子顶部开始画**。
槽位是 `{HAlign:Fill, VAlign:Fill}` 时，label 被拉满按钮内容区（44px），文字就贴在顶部。

参考设计里实测（按钮 bbox `(1404,800,128,44)`，取内部 `1412..1524 / 806..842` 的墨迹行带）：

| 版本 | 墨迹行带 | 中心 | 与浏览器 |
|---|---|---|---|
| 浏览器 | 819–831 | 825.0 | — |
| 修前 | 809–820 | 814.5 | **−10.5px** |
| 修后（VAlign=Center） | 817–828 | 822.5 | **−2.5px** |

剩下的 2px 是行盒内的基线分配（Chrome 基线在 `asc + 半行距`，Slate 在 `asc`），
属 §9.4 记录的、无法通过 `LineHeightPercentage` 表达的那一项。

**规则**（`controlLabelCentering`，在 `makeSlot` 里优先于其它对齐分支）：

```
触发：TextBlock 的槽位两轴 Fill，且文本单行，且
      父是自绘控件（Button / CheckBox / RadioButton / EditableTextBox / ComboBox）
      或该元素 line-height ≈ 元素内容盒高（±2px，作者用它做垂直居中）
      且 父内容盒高 > 行盒 × 1.5
动作：VAlign = Center（HAlign 不动，水平居中仍由 Justification 决定）
```

多行文本不套用（会把段落推歪）；表格单元格的父是 Border，天然不走这条。

### 13.2 短标签被拆成竖排：`AutoWrapText=false`

`AutoWrapText=true` + `WrappingPolicy=AllowPerCharacterWrapping` + `Size=Automatic` 是个**结构性脆弱**组合：
只要 Slate 的分配宽度比它自己量出来的字宽少 0.1px（设计器预览、略窄的视口都算），中文短标签就会**一个字一行**。
离屏渲染宽度刚好够时看不出来，所以这类问题只在编辑器/其他分辨率下暴露。

**规则**：浏览器实测单行 + 该文本宽度是内容驱动（inline / inline-block / float / absolute-自动宽，
或"没有作者宽度、没有 flex-grow、且比父内容盒窄"这种弹性行里的 shrink-to-fit 子项）→ 直接
`AutoWrapText=false`，并且不再发 `WrappingPolicy`。真正折行的块级文本仍然 `true + WrapTextAt`。

它和 `WrapTextAt` 门控是互补的两件事：门控管"给不给折行宽度"，这条管"要不要允许折行"。

参考设计里被关掉折行的 8 个：`Title`、`Subtitle`、`Span`/`Span_1`/`Span_2`/`Span_3`（图形/音频/控制/视频）、`Unit`、`Unit_1`。

### 13.3 效果与回归

| 项目 | 改前 | 改后 |
|---|---|---|
| skyline-settings 像素差异 | 1.43% | **1.41%** |
| skyline 结构边匹配 | 88.1% | **89.9%** |
| 03-dashboard 像素差异 / 结构边 | 2.84% / 77.4% | **2.83% / 80.0%** |
| 01-flex | 0.87% | 0.87%（不变） |
| 按钮文字墨迹中心 | 814.5 | **822.5**（浏览器 825.0） |

11 页逐节点比对：`AutoWrapText` 变为 false 的元素都满足"浏览器单行 + 内容驱动"（01-flex 24、02 5、03 31、
04 6、05 9、06 5、07 3、08 3、09 16、10-cjk 26、11-typo 15），`WrapTextAt` **零变化**，
11-typo 的 5 个真折行段落（`ZhPlain`/`ZhLh30`/`MixText`/`GapA`/`GapB`）仍是 `true + 352.7`。
槽位变化只有 04-form 2 处、05-controls 2 处——都是按钮 label 的垂直居中，同类改善。

## 14. 字体来源策略：`--font-map` 与 `--font-policy=engine`

### 14.1 `--font-map=ignore|keep`（默认 ignore）

设计稿常用 `data-ue-font-map` 把 CSS 家族映射到**作者自己工程里的字体资产**，例如
`{"Cascadia Mono": "/Game/MenuSystem/HUD_Elements/Font/UAV-OSD-Mono_Font", ...}`。导入别人的设计时这有两个问题：
① 版权/归属不明；② 产物只能在那个工程里渲染。

默认 `ignore`：整条映射被丢弃（日志列家族与**资产名**，但不写 `/Game` 路径，避免产物里出现对方工程路径），
这些文本按 CSS 家族正常解析（`@font-face` → 系统字体表 → 引擎默认）。`keep` 恢复旧行为。

### 14.2 `--font-policy=engine`

在原有 `any` / `redistributable` 之外新增第三档：

| 档位 | 行为 |
|---|---|
| `any`（默认） | 设计要什么就嵌什么 |
| `redistributable` | 拒绝 proprietary，改用 OFL 候选（Noto/思源） |
| **`engine`** | **只嵌 `license=redistributable` 的文件**；proprietary / unknown 一律不嵌，对应 TextBlock 不写 `FontObject`（= UMG 默认字体），**也不为它们注册 CJK 回退子字体**；这些家族完全不进 `assets.fonts`（只进日志） |

`Cascadia`（MIT）已加入可再分发列表，机器上有文件就会嵌入；没有则自然走引擎默认。

### 14.3 参考稿实测（skyline-settings，`--font-policy=engine --font-map=ignore`）

| 指标 | 结果 |
|---|---|
| `grep -c "HUD_Elements"` | **0** |
| `assets.fonts` | 4 条，全是 redistributable（Noto Sans SC 700/500/400 + 1 条被提升的 Noto Serif SC，记在 family "Cascadia Mono" 名下） |
| 走引擎默认的 TextBlock | **9 / 30**（Subtitle、NavIdx×4、Val、Unit、Val_1、Unit_1） |
| 被忽略的映射家族 | Cascadia Mono、Consolas |
| `settings` | `{"fontPolicy":"engine","fontMap":"ignore",...}` |

### 14.4 `AutoWrapText` 判据放宽为「浏览器单行就关」

上一版还要求"宽度内容驱动"，结果漏掉了 `nav-idx`：它的宽度来自 16px 的 SizeBox，不是内容驱动，
可 `AutoWrapText + AllowPerCharacterWrapping` 一旦可用宽比字宽小一点点，`01` 就拆成两行。
现在只要浏览器实测是单行就 `AutoWrapText=false`（多行仍是 `true + WrapTextAt`）。

默认策略下 11 页的布局树逐节点不变，只有 `AutoWrapText` 在浏览器单行的短标签上翻成 false
（02:2、03:2、04:7、05:11、06:7、07:3、08:1、10-cjk:21、11-typo:6、01/09:0），
另外 `settings` 每页多一个 `fontMap` 字段（布局无关）。

### 14.5 `monospace` 泛型的 CJK 提升目标是**衬线**（Chrome → NSimSun）

这一条容易想当然地"修正"，实测必须尊重要浏览器的选择：

```
#footer-hint { font-family: var(--mono) }      --mono: "Cascadia Mono","Consolas",monospace
文本：ESC 返回 · 修改即时生效
platformFonts（CDP 实测）：[{family:"Cascadia Mono", glyphs:7}, {family:"NSimSun", glyphs:8}]
```

也就是说 **Chrome 把 `monospace` 泛型的 CJK 字形交给宋体（NSimSun）**，不是雅黑。
所以转换器把这段文本的 CJK 主面提升到 **Noto Serif SC** 是**忠实还原**，不应该改成 Noto Sans SC
（`CJK_FAMILY_ALIASES` 里 `nsimsun/simsun -> noto serif sc`、`microsoft yahei -> noto sans sc` 就是在表达这个事实）。

副作用（已接受、仅 1 个元素）：Cascadia Mono 本机没有可嵌入文件，于是这段文本的**拉丁字母**也跟着用衬线体。
最终条目：`font_3 = {family:"Cascadia Mono", file: font_3.ttf}`，文件 md5 `82f7ab38c892` = **NotoSerifSC-VF.ttf**。

### 14.6 参考稿最终字体清单（`--font-policy=engine --font-map=ignore`）

| 条目 | family | 文件（md5 前 12） | license |
|---|---|---|---|
| font_0 | Noto Sans SC (700) | `504abdda5454` NotoSansSC-VF | redistributable |
| font_1 | Noto Sans SC (500) | `504abdda5454` NotoSansSC-VF | redistributable |
| font_2 | Noto Sans SC (400) | `504abdda5454` NotoSansSC-VF | redistributable |
| font_3 | Cascadia Mono (400) | `82f7ab38c892` NotoSerifSC-VF（CJK 提升） | redistributable |

30 个 TextBlock 里 9 个走引擎默认字体（Subtitle、NavIdx×4、Val、Unit、Val_1、Unit_1），
`grep HUD_Elements` = 0（产物里没有任何指向原工程字体资产的引用）。
