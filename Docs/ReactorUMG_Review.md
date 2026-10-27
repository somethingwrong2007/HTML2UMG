# ReactorUMG 参考综述：字体、CJK 回退与文本排版

> 参考项目：`ReactorUMG`（MIT，React + TypeScript + PuerTS 驱动 UMG，UE5.x）
> 本文件只覆盖 **字体与文本**。布局 / 槽位 / 资产管线见 `Docs/ReactorUMG_Layout_Review.md`（reactor-layout）。
> 结论都是实测出来的：uasset 用 python 解析 name-table 与内嵌 sfnt 表，引擎侧结论引 UE 5.8 源码行号。

---

## 0. 一句话结论

**ReactorUMG 里没有可抄的中文字体回退配置——它压根没配 SubTypefaces/CharacterRanges。** 它的中文字体策略是"挑一个覆盖全的字库"（Microsoft YaHei，一份 TTC 里 2 个子面、CJK 覆盖 100%），再加上一个 C++ 的**整字体级**家族名回退 `FindFontFamily(Names[])`。真正对我们有价值的是三件事：

1. 它**证明了 .ttc 能装进 UFontFace**（`Faces/MS_YaHei.uasset` 内嵌 `ttcf` v2.0，2 个子面），配合 `FFontData::SubFaceIndex` 取子面 —— 这直接支撑 conv-fonts 正在做的 `--ttc-subfaces`。
2. 它的字体资产是**"一个字重一个 typeface、一个家族一个 UFont"**，靠 `TypefaceFontName` 选字重（Default/Bold/Italic/Light/Blod…），不是"一个语言一个子字体"。
3. 反面教材同样有用：资产里出现 `"Blod"` 这种错拼的 typeface 名、以及 `CONSOLAS_Font` 的字重条目误指向 `Faces/ARIALBI` —— 说明 **typeface 名写错不会报错，只会静默落到 NAME_None**。我们 importer 保留 `NAME_None` 条目是对的，但对不上名时必须能输出告警。

文本测量 / 换行 / 行高：**本仓库里一行都没有**（0 处 measure/lineHeight/AutoWrapText 实现，只有生成出来的 `ue.d.ts` 声明），React 那层在外部 npm 包 `reactorumg` / 仓库 `ReactorUMG-TS`，没 clone。所以这部分**不要指望从这里抄**；我改为把 UE 5.8 侧的真值挖出来交给 typo-metrics（第 4 节）。

---

## 1. 研究方法（可复现）

```bash
# 1) 资产里的名字表 / 内嵌字体：没有 strings 命令，用逐行可打印串 + python 链式解析
cat Content/FontFamily/<X>.uasset | tr -c '[:print:]' '\n' | awk 'length>=4'
# 2) name-table 链式解析（FString + 4 字节哈希交替）
python scratch/reactor_uasset.py     # 头 + name table
python scratch/font_cov3.py          # 内嵌 sfnt/ttc → cmap format 4/12 → 码位覆盖
python scratch/metrics.py            # head/hhea/OS2 垂直度量
```

判定"是不是复合回退字体"的硬指标：`FCompositeFont` 的子字体字段全名是 `SubTypefaces`、元素字段是 `CharacterRanges` / `Cultures` / `Typeface`，兜底是 `FallbackTypeface`。**这 4 个名字在 8 个家族资产的 name-table 里出现次数 = 0**（`grep -c` 全部为 0）。同理 `bIsFallback` 在 UE 里根本不存在这个字段（Slate 用"子字体是否命中 CharacterRanges + Cultures 是否命中当前语言"来决定，见 §4.1）。

---

## 2. 它们的字体资产实测（8 个家族全扫）

`Content/FontFamily/*.uasset` 都是 `/Script/Engine.Font`（UFont）+ `CompositeFont` 属性，`FontCacheType = EFontCacheType::Runtime`、`Hinting = Default`、`LoadingPolicy = LazyLoad`。**SubTypefaces 全空**，`DefaultTypeface` 里按字重挂若干 `TypefaceEntry`。

| 家族资产 | DefaultTypeface 里的 typeface 名 | 指向的 Face 资产 | 备注 |
|---|---|---|---|
| Microsoft_YaHei_Font | Default, **Blod**, Light | Faces/MS_YaHei(ttcf×2), MSYH_Blod, MSYHL | 唯一的中文可用家族 |
| ARIBLHeiTi_Font | Default | Faces/ARIBLK | 名叫"黑体"，实测 **CJK 覆盖 0** |
| NotoSans_Japanese_Font | Thin, Extra Light, Light, Regular, Medium, Semi Bold, Bold, Extra Bold, Black（**9 个条目里没有叫 Default 的**） | Faces/NotoSansJP-*（9 个） | 日文字重阶梯；其余家族都带 Default 条目 |
| NotoSansJP-Medium_Font | Default | Faces/NotoSansJP-Medium | |
| ARIAL_Font | Default, Bold, Italic, Bold Italic, Black | ARIAL, ARIALBD, ARIALBI, ARIALI, ARIBLK | |
| CONSOLAS_Font | Default, **Blod**, Regular, Italic, Bold Italic | CONSOLA, CONSOLAB, CONSOLAI, CONSOLAZ, **ARIALBI** | 5 个条目 / 4 个 Consolas 面 + ARIALBI（Faces 里没有 CONSOLABI）→ 斜粗体串成了 Arial |
| ANIME_MATRIX_MB_EN_Font | Default | Faces/ANIME_MATRIX_MB_EN | 只有 11 KB 的装饰字体 |
| JAVANESE_TEXT_Font | Default | Faces/JAVATEXT | |

### 2.1 码位覆盖（实测，cmap format 12/4）

| Face（家族） | 文件内嵌 | 码位总数 | ASCII | CJK 4E00-9FFF | CJK ExtA | 假名 | Hangul | 39 个常用简体字缺字 |
|---|---|---|---|---|---|---|---|---|
| MS_YaHei f0（Microsoft YaHei） | ttcf，2 子面 | 29905 | 100% | **20992/20992 = 100%** | 100% | 98.4% | 0% | **0/39** |
| MS_YaHei f1（Microsoft YaHei UI） | 同上 | 29905 | 100% | 100% | 100% | 98.4% | 0% | 0/39 |
| NotoSansJP-Regular | sfnt | 16732 | 100% | **12747/20992 = 60.7%** | 3.1% | 98.4% | 0% | **10/39 = 25.6%** |
| ARIBLK（ARIBLHeiTi_Font） | sfnt | 667 | 100% | **0%** | 0% | 0% | 0% | **39/39** |
| ARIAL | sfnt | 3405 | 100% | 0% | 0% | 0% | 0% | 39/39 |

（39 字样本：`的一是不了人国中文字体测试这是一个段落标题按钮确定取消设置返回登录注册密码邮箱`）

两个可以直接拿去当规则的数：

* **日文字体不能当中文用**：NotoSansJP 在常用简体字上缺 25.6%，CJK 统一汉字只覆盖 60.7% —— 这正是"偶尔豆腐块/丢字"的典型来源（缺的字往往躲在长文案里）。
* **叫"黑体"不代表有汉字**：ARIBLHeiTi_Font 的 667 个码位里一个汉字都没有（ARIB 是日本广播用的拉丁/符号字库）。名字与覆盖无关，必须查 cmap。
* 它嵌入的 TTC 与我们本机 `C:/Windows/Fonts/msyh.ttc` 是同一份（19704352 vs uasset 内 19705852 字节，差的是 uasset 头）。

### 2.2 .ttc 的事实核对（推翻我们 CONTEXT 里的一条假设）

CONTEXT 写"msyh.ttc 是合体，UE 不能导入"。**这条至少对 UE 5.8 不成立**：

* `Runtime/SlateCore/Public/Fonts/FontData.h:283` 有 `int32 SubFaceIndex`，`:170/:173` 是 `Get/SetSubFaceIndex`；
* `Runtime/Engine/Private/FontFace.cpp:283 CacheSubFaces()` → `GetFontCache()->GetAvailableFontSubFaces(FontFaceData)`，结果放在 `FontFace.h:143 TArray<FString> SubFaces`；
* 真正取面：`Runtime/SlateCore/Private/Fonts/FontCacheFreeType.cpp:555 FT_New_Memory_Face(..., FaceIndex, ...)`；
* ReactorUMG 就是这么用的：`Microsoft_YaHei_Font` 的 3 个字重条目里至少一个是 `Faces/MS_YaHei`（ttcf，2 子面）。

所以"能不能导入"只是导入器/工厂那一层的问题，Slate 运行时是按子面取的。**需要 verify 实测一次**（第 6 节 Q1）。

---

## 3. 字体是怎么被选中 / 加载 / 命名的

全仓库跟字体有关的 C++ 只有 **一个函数**（`grep Font` 过滤掉 ThirdParty 与生成声明后）：

```cpp
// Source/ReactorUMG/Private/UMGManager.cpp:185
UObject* UUMGManager::FindFontFamily(const TArray<FString>& Names, UObject* InOuter)
{
    const FString FontDir = TEXT("/ReactorUMG/FontFamily");
    for (const FString& Name : Names)                       // 有序家族名列表
        if (UFont* Font = Cast<UFont>(StaticLoadObject(UFont::StaticClass(), InOuter,
                *(FontDir / Name + TEXT(".") + Name))))
            return Font;
    return StaticLoadObject(UFont::StaticClass(), InOuter, TEXT("/Engine/EngineFonts/Roboto.Roboto"));
}
```

要点与判读：

1. **命名约定**：家族名 = 资产名（`Microsoft_YaHei_Font` → `/ReactorUMG/FontFamily/Microsoft_YaHei_Font.Microsoft_YaHei_Font`）。CSS 的 family 字符串要人工映射到这些名字。
2. **回退粒度 = 整个字体，不是字形**：`Names` 里第一个能 `StaticLoadObject` 到的就赢；一旦赢了，那个 UFont 覆盖不到的码位**不会**再去试后面的家族，只会走它自己的 `FallbackTypeface`/引擎 .notdef。所以它**治不了**"拉丁字体 + 中文混排"的豆腐块 —— 那必须靠 `FCompositeFont::SubTypefaces`。
3. 最后一个兜底是 `/Engine/EngineFonts/Roboto`（无 CJK），也就是**失败即豆腐**。
4. **字号单位**：它不做任何 pt↔px 换算（`grep 96|72|Dpi` 在 ReactorUMG 的 C++ 里 0 处命中），TS 侧直接把数字塞进 `FSlateFontInfo::Size`。我们已有的 96/72 换算是必要且正确的，引擎里的权威换算式在 `Runtime/Engine/Private/UserInterfaceSettings.cpp:188-196`：
   ```
   DisplayedSize = NativeFontSize * RenderDPI / FontDisplayDPI      // RenderDPI = 96
   NativeSize    = DisplayFontSize * FontDisplayDPI / RenderDPI
   ```
   （UMG 编辑器面板显示的是 DisplayedSize；我们写反射时写的是 NativeSize。）
5. **它不碰 ascent/descent 覆盖**：`FCompositeFont::bEnableAscentDescentOverride` 在资产里没出现（0 处），即沿用字体源文件度量。我们的行高问题不该靠这个开关掩盖（见 §4.2）。
6. `FontCacheType = Runtime` 与我们 importer 一致（`Html2UMGAssetImport.cpp` 里 `FamilyFont->FontCacheType = EFontCacheType::Runtime;`），这点已经对齐，不用改。

---

## 4. 文本控件与排版（本仓库没有 → 改用引擎真值）

### 4.1 引擎侧：子字体是"按码位区间查表"，不是"按顺序试"

给 imp-composite 校准用的四条（UE 5.8 源码）：

* `Runtime/SlateCore/Public/Fonts/CompositeFont.h:401-424`：`FCompositeSubFont { Typeface, ScalingFactor, TArray<FInt32Range> CharacterRanges, FString Cultures, FName EditorName }`；`:459-473`：`FCompositeFont { DefaultTypeface, FallbackTypeface, SubTypefaces, bEnableAscentDescentOverride }`。
* `Runtime/SlateCore/Private/Fonts/FontCacheCompositeFont.cpp:245-272`：遍历 `SubTypefaces`，把每个 `CharacterRanges` 里的区间登记成"区间→typeface"；**`Cultures` 非空且不属于当前语言 → 该子字体整条被忽略**（`CachedFontRangesPtr = nullptr`，:256），空 `Cultures` → 永远参与。语言相关的子字体另外进 `CachedPriorityFontRanges`（优先级更高）。
* 兜底 `:654-677`：默认 typeface 找不到字形时用 `FallbackTypeface`，且那条路径 **`bSkipCharacterCheck = true`**（不检查覆盖）——所以我们把"最后的救命字体"挂在 FallbackTypeface 是对的，但它的字形缺失不会有第二次机会。
* `ScalingFactor` 默认 1.0：中文字体与拉丁字体的 x-height/em 不同时，这个字段能免掉"中文看起来比英文大一号"的问题，**我们目前没用它**（见 §5 A4）。

### 4.2 引擎侧：行高到底怎么算（这条给 typo-metrics）

`Runtime/Slate/Private/Framework/Text/TextLayout.cpp:448-451`：

```cpp
UnscaleLineHeight = MaxAboveBaseline + MaxBelowBaseline;   // 来自字体度量，不是字号
LineSize.Y        = UnscaleLineHeight * LineHeightPercentage;
```

`MaxAboveBaseline/MaxBelowBaseline` 来自 `Run->GetBaseLine(Scale)` 与 measure，最终落到 `FSlateFontCache::GetMaxCharacterHeight` → `FontRenderer->GetMaxHeight`（`FontCache.cpp:1627`），FreeType/HarfBuzz 路径即 `GetAscender - GetDescender`（`FontCacheHarfBuzz.cpp:272`，26.6 定点向上取整，见 `:276-283`）。

**这意味着我们 CONTEXT 里"`Slate 行盒 ≈ 1.417 × 字号`、统一除 1.0625"是字体相关的常数近似**。我实测了几个字体的真实比例（`(hhea.asc - hhea.desc)/unitsPerEm`，就是 Slate 的行盒倍数）：

| 字体 | upem | hhea asc/desc/gap | Slate 行盒倍数 | hhea+gap 归一 | OS/2 usWin 归一 |
|---|---|---|---|---|---|
| msyh.ttc f0（YaHei） | 2048 | 2167 / -536 / 0 | **1.3198** | 1.3198 | 1.3198 |
| msyh.ttc f1（YaHei UI） | 2048 | 2080 / -521 / 0 | **1.2700** | 1.2700 | 1.2700 |
| NotoSansSC-VF.ttf | 1000 | 1000 / -200 / 0 | **1.2000** | 1.2000 | **1.4480** |
| simhei.ttf | 256 | 220 / -36 / 36 | **1.0000** | 1.1406 | 1.0000 |
| Deng.ttf（等线） | 2048 | 1659 / -475 / 0 | 1.0420 | 1.0420 | 1.0420 |
| seguiemj.ttf | 2048 | 1491 / -431 / 269 | 0.9385 | 1.0698 | 1.3301 |

要点：**同一个 `font-size`，不同字体的 Slate 行盒相差 41%**（0.9385 → 1.3198）。用固定 1.0625 去修，在 msyh 上会把行高抬成 1.40×，在 simhei 上又会少 6%。正确做法（A3）是把"每个字体的修正系数"算出来随 layout.json 下发，而不是写死。

### 4.3 引擎侧：断行 / 换行

* `TextLayout.cpp:1176-1191`：换行机会全部来自 `FBreakIterator::CreateLineBreakIterator()`（ICU 实现 `Runtime/Core/Private/Internationalization/ICULineBreakIterator.cpp`），Slate **没有 CJK 专门分支**（`bIsCJK`/`IsCJK` 在 SlateCore = 0 处）。中文是按字符断的，这一点与浏览器一致，不需要我们特殊处理；但 **CJK 禁则**（行首不留标点）也是 ICU 的行为，两边 ICU 版本不同就会有细节差异。
* 换行开关在 `STextBlock`：`AutoWrapText` / `WrapTextAt` / `WrappingPolicy` / `LineHeightPercentage` / `ApplyLineHeightToBottomLine`（`STextBlock.cpp:77-79, 526-537`）。注意 `ApplyLineHeightToBottomLine` 默认 **true**，会让最后一行也吃行高增量 —— 这正是文本块"底边比浏览器多出一截"的常见来源，转 CSS 时该按定位方式关掉它。ReactorUMG 这两个属性一个都没碰（0 处命中），所以也没有经验可抄。

### 4.4 它们的 CJK / 多语言策略

* **没有回退表**（0 个 CharacterRanges）、**没有 Cultures 用法**（资产里 Cultures 字段不存在）、**没有语言切换代码**（`grep Culture` 在 $Source = 0）。
* 策略就是"给中文设计稿指定 `Microsoft_YaHei_Font`"，靠该字库 100% 的 CJK 覆盖。日文另有 NotoSansJP 家族。混排（中英数字）不处理 —— 因为 YaHei 本身拉丁也全。
* 我们比它多出来的能力（per-codepoint SubTypefaces + cmap 校验）是对的路线，**不要为了"像它"而退化**。

---

## 5. 我们能抄什么（按价值排序）

### A1（高，已在路上）`.ttc` + `SubFaceIndex`：把 msyh.ttc 当作单个 UFontFace
* **依据**：ReactorUMG 的 `Faces/MS_YaHei.uasset` 就是内嵌 `ttcf` + `FFontData::SubFaceIndex`；Slate 运行时 `FT_New_Memory_Face(faceIndex)`。
* **改哪**：
  * 转换器 `Resources/Converter/src/assets.js` 的 CJK 候选表（`cjkFamilies`/`systemFonts`）与 `_copyFontFile` 里的 `.ttc` 拒绝分支 —— 已有 `--ttc-subfaces` 开关与 `subface` 字段，**保持默认关**，等 importer 支持后翻默认。
  * 导入器 `Source/Html2UMG/Private/Importer/Html2UMGAssetImport.cpp`：`ImportFontFaceAs` 的扩展名白名单加 `.ttc`；构造 `FFontData` 时用 `FFontData(FontFaceAsset, SubFaceIndex)`（`FFontData(const UObject*, int32 InSubFaceIndex = 0)`）而不是当前的 `FFontData(FontFace)`。
* **收益**：一份 msyh.ttc 同时给出 Regular/Bold/Light 三个面（subface 0/1/…）+ CJK 100% 覆盖；现在换 `NotoSansSC-VF.ttf`（1.2000 行盒）与伪粗，字重和行高都对不上设计稿。
* **风险**：① TTC 导入未实测（Q1）；② 资产里要塞 19.7 MB，包体与首次加载（LazyLoad 会摊到运行时）；③ 授权：msyh 不可随包分发，只能本机/研发用 —— 这个必须 lead 决策。
* **注意**：`ImportFallbackFace` 走同一路径，所以子面索引要跟着 `FH2UFontFallback` 一起进 layout.json。

### A2（高，给 typo-metrics）行高改为"按字体度量算"，删掉常数 1.0625
* **依据**：§4.2，Slate 行盒 = `(hhea.asc - hhea.desc)/upem × Size`；浏览器的 `line-height: normal` 用的是另一套度量（Windows 上通常 usWinAscent+usWinDescent），两者比在不同字体上从 0.83 到 1.06 不等。
* **改哪**：`Resources/Converter/src/assets.js` 在 `parseFontCoverage` 旁边加 `parseFontVerticalMetrics(buffer)`（head.upem + hhea.asc/desc/gap + OS/2 usWin），把 `lineBoxRatio` 与 `cssLineBoxRatio` 写进 `assets.fonts[]`；`src/mapper.js` 里现在写 `LineHeightPercentage` 的那段改成 `cssLineHeight / slateLineBox`（缺度量时退回 1.0625 并在日志里标注 fallback）。
* **收益**：直接打死"中文行高偏大/偏小"这一类误差。以 NotoSansSC 为例，行盒 1.2 vs 浏览器 1.448 → 现在的常数近似让每行少 ~0.2 行高（`line-height:normal` 时累积 4 行就差 ~0.8 行）；simhei 则反向。
* **风险**：浏览器 `line-height: normal` 的具体度量与 ICU/HarfBuzz 取整有 1 px 级别差异，建议用转换器自带的 Chromium 实测一行（`font-size:100px` 单行 span 的 `offsetHeight`）来闭合，而不是纯靠读表。

### A3（高，给 conv-fonts）字体候选必须过 cmap 门槛，别信名字
* **依据**：§2.1 —— `ARIBLHeiTi_Font`（名字里带"黑体"）CJK 覆盖 0/20992；NotoSansJP 常用简体字缺 25.6%。
* **改哪**：`assets.js` 的 `fontCoverageForFile`/`addFont` 已经有 cmap 检查，加两条硬阈值：**CJK 区间抽样 ≥ 90% 且 39 字常用样本 ≥ 95%** 才允许作为 CJK 主字体；不达标时把它降级成 fallback-only，并在 JSON 里留 `coverage` 证据（便于事后审计）。
* **收益**："偶尔豆腐块"从"随机出现"变成"转换期就能报出来"；对一个出现 1 个字缺失的页面，像素差异通常是局部的，但用户感知极差，量化上根本看不出——所以必须在转换期拦。
* **风险**：阈值太严会把自定义 web 字体（子集化的 woff2）挡掉；应只对"承担 CJK 主字体"的那一个 face 生效，子集字体照常登记为 fallback。

### A4（中，给 imp-composite）子字体补 `ScalingFactor`，typeface 名要能对账
* **依据**：`CompositeFont.h:396-398` `ScalingFactor`（默认 1.0）专门解决"回退字体与原字体 em/x-height 不一致"。ReactorUMG 的资产里全是默认值，所以它没有经验；但我们的场景（YaHei 回退 NotoSansSC / Noto Color Emoji / 符号字体）必然遇到。
* **改哪**：`Html2UMGAssetImport.cpp` 的 `RebuildFallbacks` 填 `SubFont.ScalingFactor`（用两边的 `upem` 或 x-height 比，数据来自 A2 的度量解析）；同一函数里给每个子字体填 `EditorName`（editor-only，方便在资产编辑器里看出是谁）。
* **typeface 命名纪律**：ReactorUMG 的 `"Blod"`、`CONSOLAS_Font` 指向 `ARIALBI` 都是"名不对也不会报错"的实证。我们 `AddTypeface` 里应当：写入后回读 `DefaultTypeface.Fonts` 校验目标 `TypefaceName` 存在且 `Entry.Font` 有效，否则报 `warning`；`NotoSans_Japanese_Font` 那种**没有 NAME_None 条目**的资产，任何 `TypefaceFontName == NAME_None` 的 TextBlock 都会静默换字体 —— 我们保留 NAME_None 条目的做法要写进注释当规范。
* **收益**：中文回退后字号视觉一致（省掉"中文比英文大一号"的手工调字号）；命名错误从"运行期静默"变"导入期告警"。

### A5（不要抄的三件事）
1. **`FindFontFamily` 的整字体回退** —— 粒度太粗，治不了混排豆腐块；我们的 per-codepoint SubTypefaces 更强。只借它的"家族名有序列表 + 最后兜底"这个**报错思路**（找不到就明确告警，而不是静默用 Roboto）。
2. **"用一个大字体解决中文"** —— 那是他们没得选；我们已经有复合字体能力。
3. **字号/行高的常数换算** —— 它根本没有；不要拿它当参照，参照引擎公式（§4.2）。

---

## 6. 待验证清单（已收敛：Q0/Q1/Q3 本轮已验证，勿重复研究）

> **2026-10-27 收敛**：Q0、Q1、Q3 已由实现 + verify 实测闭合，保留结论与证据；只剩 Q2、Q4 未闭合。
> 每条都注明了"下次遇到问题该看哪里"，不要重开已经闭合的研究。

| # | 验证项 | 状态 | 证据 / 判定 | 失败时怎么办 |
|---|---|---|---|---|
| Q0 | CJK 候选字体的 cmap 门槛（常用简体字 ≥95%、CJK 抽样 ≥90%） | ✅ **已验证（已落地）** | `assets.js` 的 `sampleStatsForFile` + `SAMPLE_COMMON_THRESHOLD`/`SAMPLE_CJK_THRESHOLD`；转换日志打印 "rejected as a CJK fallback ... thresholds 95% / 90%"。本仓库实测 NotoSansJP 被拒（常用字 74.4%、CJK 60.7%），YaHei 通过（100%/100%） | 阈值过严会挡子集化 webfont → 门槛只对"承担 CJK 主字体"的 face 生效 |
| Q1 | `.ttc` 能否作为 UFontFace 使用、子面能否被选中 | ✅ **已验证** | 引擎：`FFontData::SubFaceIndex`（FontData.h）+ `UFontFace::SubFaces`（`CacheSubFaces`→`GetAvailableFontSubFaces`）+ `FT_New_Memory_Face(faceIndex)`。实现：`ImportFontFaceAs` 接受 ttc、`PickSubFaceIndex` 按 JSON `subface` 优先。verify 实测主 face 资产名带内容哈希（`Segoe_UI_400_eee43a6e`）并通过 | 子面选错时看日志 "uses layout subface N of M"；不要回退到"UE 不能导入 ttc"的老结论（已被推翻） |
| Q2 | 混排时拉丁字体缺的汉字是否真的落到 SubTypeface（而不是 FallbackTypeface） | ⬜ **未闭合** | 判定：中文走子字体、无 .notdef；注意 `Cultures` 写非空会被整条忽略 | 见 `Docs/Html2UMG_CJK_Review.md` 的 P0-2/P0-3 |
| Q3 | 行盒：按字体度量算出的 `LineHeightPercentage` 与浏览器实际行盒 | ✅ **已验证（系数层面）** | `fontmetrics.js` 的 `slateLineBox/cssLineBox` 已接进 `mapper.js lineHeightPercentage`；实测同一 fixture 内 LHP 随字体/字号变化（0.9754 / 1.1667 / 1.2938 …），不再是常数 0.943 | 残差仍是 ≤1px/行，用 `ImportRenderGeometry` 几何 dump 反推（另见 CJK Review 的 P1-4：ttc 子面度量未接） |
| Q4 | `ApplyLineHeightToBottomLine` 对最后一行的抬升 | ⬜ **未闭合** | 关掉后底边与浏览器对齐（默认 true → 最后一行也吃行高增量） | 在 PropertyApplier 里按需写 false；先只对 `nowrap`/`fillsBox` 叶子文本关 |

---

## 7. 附：我改了什么

* 新增本文件 `Docs/ReactorUMG_Review.md`。
* 未改动 ReactorUMG（只读）；未拷任何资产进本项目。
* 临时脚本（不属于交付物，可删）：`scratch/reactor_uasset.py`、`scratch/reactor_uasset2.py`、`scratch/ttc_probe.py`、`scratch/font_cov.py`、`scratch/font_cov2.py`、`scratch/font_cov3.py`、`scratch/metrics.py`、`scratch/names2.py`。

**如果还想继续挖文本排版**：本仓库没有实现，需要再拉 `https://github.com/Caleb196x/ReactorUMG-TS`（npm `reactorumg`），React→UMG 的 diff/measure/换行都在那边。我不建议在没有新信息的前提下再花时间读这个仓库的 `ue.d.ts`（12 MB，只有生成声明）。
