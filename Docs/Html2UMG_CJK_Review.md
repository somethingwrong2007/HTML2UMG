# Html2UMG CJK 改动独立审查

> 审查人：reactor-study（第二双眼睛，纯读码，不跑编辑器）
> 快照时间：2026-10-27 16:2x。**三个人的文件当时正在被改动**（`assets.js` 16:12、`mapper.js` 16:14、`Html2UMGAssetImport.cpp` 16:2x），所以本文用「符号名」定位，行号只是当时的近似值，复核请按符号搜索。
> 方法：读码 + 对照 UE 5.8 引擎源码（行号为 UE 5.8 本地拷贝，稳定）+ 跑了一次转换器（`test/11-typo.html`，输出在 `scratch/rl/`）拿真实数值。

---

## 0. 总览

| 编号 | 级别 | 问题 | 状态 |
|---|---|---|---|
| P0-1 | P0 | 主字体 face 资产名不含内容哈希，换字体文件后静默复用旧 UFontFace | **本轮已修**（`MakeFaceAssetName` 带 MD5 前 8 位，verify 实测 `Segoe_UI_400_eee43a6e`）；复现步骤见 §1 |
| P0-2 | P0 | 多个 fallback 共用同一套 CJK 区间 → 区间完全重叠，只有第 1 个会被咨询；顺序取自 TMap 哈希序；FallbackTypeface 粘滞 | **本轮已修/在途**（`coverage` 解析 + 按数组顺序 + FallbackTypeface 每次重设已落地，见 §2 复核）；遗留 3 个边界见 P1-4/5/6 |
| P0-3 | P0 | 复合字体只改内存对象、没 SavePackage → 删掉 fallbacks 重跑结果 md5 不变（渲染读磁盘旧资产） | **已派单**（lead 报告 verify 实测）；验证口径见 §3 |
| P1-1 | P1 | `fallbacks[]` 里只给 `key` 不给 `file` 的条目被解析期丢弃，C++ 里按 key 反查的分支是死代码 | 待修 |
| P1-2 | P1 | `--ttc-subfaces` / `--wrap-tolerance` / `--cjk-breaks` **是幽灵 flag**（args.js 没有，用了直接报错退出）；真实开关只有环境变量，且没写进 JSON | 待修 |
| P1-3 | P1 | `WrapTextAt` 对所有可换行文本发满内容宽（实测 22/22 单行元素都发），浏览器"裁切/溢出"的场景会被 Slate 多折一行 | 待评估+建议 §5 |
| P1-4 | P1 | `.ttc` 子面的行盒度量用了 face 0（`fontMetricsFor` 没传 subface），msyh 两子面差 3.9% 行高 | 待修 |
| P1-5 | P1 | `subface: 0` 无法表达（converter 只在 `> 0` 时写）；`PickSubFaceIndex` 在 `SubFaces.Num() <= 1` 时静默返回 0，连"声明了子面但文件只有一面"的告警都被短路 | 待修 |
| P2-1 | P2 | `UIScale` 是死选项（解析了但没人用） | 待修/删除 |
| P2-2 | P2 | `license` 只用于转换期告警，不写进 JSON 语义字段、C++ 不读 → 打包审计无法回查 | 待改进 |
| P2-3 | P2 | `platformFonts` 有 1500 节点上限与"只探父元素"两个边界；行内混排合并后只拿到父元素字体 | 记录 |
| P2-4 | P2 | 同一 family 多字重时 fallback chain 是"并集"，顺序 = 本条目在前 + 其他字重追加 | 记录 |

---

## 1. P0-1 换字体文件后静默复用旧面（已修，保留复现）

**原缺陷**（审查时版本）：`ImportFontFace()` 的资产名 = `<Family>_<Weight>[_Italic]`，无内容哈希；`ImportFontFaceAs()` 命中 `FindExistingAsset + IsAssetUpToDate` 就直接返回旧资产，而 `IsAssetUpToDate` 只比较"包 mtime >= 源文件 mtime"。同一个 family 换字体文件（最典型：Microsoft YaHei 从 NotoSansSC 换成 msyh.ttc）时源文件通常更旧 → 判定"已最新" → 用旧字面。

**为什么它不是"理论问题"**：贴图侧早就踩过同一个坑并写进了注释（`ImportTextureFile`：内容寻址 + 每次重导，"ana reuse 3.14% → 4.47%"），fallback 面也做了内容寻址（`ImportFallbackFace`：`FB_<family>_<md5前8>`），**只有主面漏了**。差异是可疑的，不是设计。

**本轮修复**：主 face 名改成带 MD5 前 8 位（verify 实测日志 `Segoe_UI_400_eee43a6e`）。

**保留的复现/回归用例**（建议进验收脚本）：
```bash
# 1) 用默认字体链转一次，导入一次
node Plugins/Html2UMG/Resources/Converter/cli/convert.js test/11-typo.html -o C:/t/a.json --assets C:/t/assets ...
# 2) 只改字体来源（例如 HTML2UMG_TTC_SUBFACES=0/1，或换一份同名 family 的字体文件），转换 + 导入
# 3) 期望：Content 下出现 "MicrosoftYaHei_400_<hash8>" 两个不同资产名（旧名不再被引用）；
#    日志里 face 路径的 hash 后缀随文件内容变化。
#    反例（修复前）：资产名不变，渲染像素完全不动 → "改了没效果"。
```

---

## 2. P0-2 多 fallback 只有第一个生效（已修/在途，复核结论）

**原缺陷的机制**（UE 5.8 源码）：
* `FCachedCompositeFontData::NormalizeFontRanges` 把重叠区间归一化：**区间小的赢，区间等大时"先声明者"赢**（`FontCacheCompositeFont.cpp` 里 `FontRangeComparator`：`SizeA < SizeB`，等大时 `return A < B`，注释写明 "the range that came first in the user declaration"）。
* 一个码位只会拿到**一个** typeface：`GetTypefaceForCodepoint` → 命中区间者；该 face 缺字形时依次退到 default typeface（查字形）→ **FallbackTypeface（`bSkipCharacterCheck=true`，不查字形）**（`FontCacheCompositeFont.cpp` 660-690）。
* 所以：两个 sub-font 拿到同一套区间 = 第 2 个永远不会被问；第 1 个缺的字直接落到 FallbackTypeface；而旧代码把 `FallbackTypeface` 镜像成 `SubTypefaces[0]`，等于"缺字还是它自己"。
* 顺序来源：旧代码从 `Layout.Fonts`（TMap）迭代收集 → 哈希序，不是浏览器解析序。

**本轮已落地（我复核读到的现行代码，符合预期）**：
1. 顺序改为 `TArray<FH2UFontFallback> Fallbacks = Ref.Fallbacks;` 起头（本条目数组序），其他字重只做 **Append 追加**，不再从 TMap 取顺序。
2. `Composite.FallbackTypeface` **无条件重置**后再重建（修掉"粘滞"）。
3. 每个 fallback 优先用 `Fallback.Coverage`（`[[first,last],...]` 闭区间）生成 `CharacterRanges`：排序 + 合并相邻 + `Last + 1` 转半开区间（`FInt32Range` 是半开）。
4. 老 JSON（无 coverage）走"块级记账"：`ClaimedCjkBlocks` 保证两个 fallback 不会拿到完全相同的 16 个 CJK 块。

**仍建议补的三点**（见 P1-4 / P1-5 / P1-6）：子面度量、`subface:0` 表达、老 JSON 块级路径的告警。

---

## 3. P0-3 复合字体没落盘（lead 派单，验证口径）

* 现象：删掉 `fallbacks` 重跑，输出 md5 不变 → 说明渲染读的是磁盘上的旧 UFont，内存里重建的 `SubTypefaces` 没被保存。
* 根因方向：`AddTypeface()` 里对 UFont 做了 `MarkPackageDirty()` 并把包加进 `TouchedPackages`，但**保存发生在导入流程末尾**；如果该 family 资产这一轮没有被 `EnsureFont` 走到（例如 fallback-only 的条目被 `ImportAll` 跳过、或走了 `Resolve()` 的懒路径），它就不在本次保存集合里。/ 另一种可能：保存发生在 `RebuildFallbacks` 之前。
* 我给 verify 的验收口径（3 条都要满足）：
  1. 重导日志出现重建条数（现在有 `+N CJK fallback sub-font(s)` 的信息行）；
  2. 保存阶段日志出现该 UFont 的包名（`TouchedPackages` 里应有它）；
  3. 关掉编辑器再重开（或换进程）渲染 → 与删除前**像素不同**（差异应集中在中文字形区域），然后恢复 → 再不同。
* 代码侧建议：`AddTypeface()` 结束处不要依赖"调用者记得存"，把 family 的包**显式**加进 `TouchedPackages`（已有）并在 `ImportAll` 末尾核对"每个 FontCache 里的 UFont 都在 TouchedPackages 中"，缺失就告警——这比等 md5 报错早一层。

---

## 4. P1-1 `key`-only 的 fallback 被解析期丢弃（死代码）

* `Html2UMGTypes.cpp` 解析 `fallbacks[]` 后有一道守卫：`if (!Fallback.File.IsEmpty()) Ref.Fallbacks.Add(Fallback);`。
* 而 `Html2UMGAssetImport.cpp` 的 `RebuildFallbacks` 里专门写了"fallback 只有 key 时，去 `Layout.Fonts` 反查 file/family/subface"的分支 —— **永远走不到**。
* 后果：手写 JSON 或未来 converter 只发 key 的写法会静默失去回退（无 error、无 warning）。
* 建议：解析守卫改成 `if (!Fallback.File.IsEmpty() || !Fallback.Key.IsEmpty())`，并在反查失败时给 warning。
* 契约来源：`Html2UMGTypes.h` 的 `FH2UFontFallback::Key` 注释写的就是"also declared as a normal assets.fonts[] entry"。

---

## 5. P1-3 `WrapTextAt` 的误伤面（lead 问题 b 的答案）

### 实测（`test/11-typo.html`，1200x900，本轮转换器）
* 27 个 TextBlock：**26 个拿到 `WrapTextAt`**，1 个（`white-space:nowrap` 的 `NowrapText`）正确没有。
* 快照里 27 个文本元素中 **22 个是单行**（rect 高 ≈ 1 个行盒），**这 22 个全部拿到了"内容宽"作为 WrapTextAt**（如标签类 `352.67`、标题 `240`）。也就是说**风险面 = 所有短标签**，不是"只有段落"。
* 快照元素里**没有** `scrollWidth/clientWidth/lines` 字段（已核对 `snapshot.js` 的元素表达式），所以"浏览器到底换行没有/有没有被裁切"目前在下游无法判断。

### 会不会误伤真实设计（结论：会，但可控）
触发条件只有一个：**浏览器没有换行，但文本的宽度超过内容盒**。分类：
1. `white-space:nowrap` → 已排除（不发 WrapTextAt）✓
2. `overflow:hidden` + 正常换行 → 浏览器本来就换行，Slate 在同样宽度下也换行，一致 ✓
3. **单个不可断词（长 URL、无空格串、`word-break:keep-all` 的中文串、letter-spacing 把词撑宽）** → 浏览器溢出/裁切（1 行），Slate 会按字符折断（我们同时发了 `WrappingPolicy=AllowPerCharacterWrapping`）→ **多 1 行**。
4. flex 收缩到 `min-width:auto` 以下的容器：内容盒宽度是"实测后"的，文本真实宽度可能更大 → 可能命中 3。

代价估算：1 行 = 1 个行盒（14px/22px 的行就是 22px）。这份 7081px 的长文档里若有 1% 的标签命中（约 4 个），纵向流累积 ≈ 88px；这与他们此前"累计高度 660px 漂移"是同一类误差，量级不可忽略。横向绝对定位的元素只会视觉溢出，不影响其它元素。

### 建议（按性价比）
1. **先补证据，再收紧**：在 `snapshot.js` 的元素表达式里加 3 个字段 `scrollWidth/clientWidth/textLines`（1 行 JS，无额外往返），然后只在下列条件发 WrapTextAt：
   ```
   emit = whiteSpace !== nowrap
        && contentW > 0
        && (textLines > 1                    // 浏览器确实换了行：必须保持
            || scrollWidth <= clientWidth+1) // 没溢出：发宽是安全的
   // 单行且溢出（scrollWidth > clientWidth）→ 不发，让它像浏览器一样溢出/被裁切
   ```
2. 过渡期可以**只对 CJK 正文发**（`cjkCodepoints(text).length > 0` 且不是单行溢出），因为出问题的正是"无空格中文长段 Slate 不会自己断行"这一类；拉丁标签暂不发，把回归面积压到最小。
3. `--wrap-tolerance` 的设计是反向的：多给的那点宽容度**只会更容易不换行**，对"误伤多折一行"帮助不大；真正需要的是上面那条门控。默认 0 保持。
4. 别忘了 `ApplyLineHeightToBottomLine`（默认 true，`TextWidgetTypes.h` 里跟着 `LineHeightPercentage` 一起下发）：最后一行也吃行高增量，文本块的底边会比浏览器多出 `(LHP-1)*行盒`，在纵向流里就是"每块多半个像素"。建议在 `PropertyApplier` 写 `LineHeightPercentage` 时一并写 `ApplyLineHeightToBottomLine = false` 做 A/B（如果 lead 要控风险，先只对 `nowrap/fillsBox` 的叶子文本关）。

### 单位确认（这题容易错，已核对引擎）
* `WrapTextAt` 是 **Slate 布局单位（= 设计 px，1:1）**，与 widget 几何同一坐标系；**不要**按 `FSlateFontInfo::Size` 的 96/72 折算。converter 现在发的就是内容宽（px），**正确**。
* `FSlateFontInfo::Size` 是 **pt**（`UUserInterfaceSettings` 的 `Native = Display * FontDisplayDPI / RenderDPI`，RenderDPI=96），converter 已经 `/PX_PER_POINT`，**正确**。
* `WrapTextAt == 0` 时 UMG **根本不绑定**该属性（`TextWidgetTypes.h` `SynchronizeTextLayoutProperties`：`SetWrapTextAt(WrapTextAt != 0 ? WrapTextAt : TAttribute<float>())`）→ "0 表示不换行"这个语义是对的。

---

## 6. P1-2 幽灵 flag（lead 问题 a 的答案）

**结论：是"args.js 没接"，而且不是静默忽略——直接用会报错退出。**

* `src/args.js` 的选项表里**没有** `--ttc-subfaces`、`--wrap-tolerance`、`--cjk-breaks`（只有 `--font-policy` 等）；未知 `--*` 走到 `throw new ArgError(\`unknown option: ...\`)` → 退出码 1。
* 而**源码注释在宣传它们**：`assets.js`（`allowTtc` 附近）写 "Switch on with --ttc-subfaces"、`mapper.js`（`wrapTextAt`/注释）写 "Set --wrap-tolerance (or HTML2UMG_WRAP_TOLERANCE)"。用户照着注释跑 → `unknown option`。
* 真实开关只有环境变量：`HTML2UMG_TTC_SUBFACES`、`HTML2UMG_WRAP_TOLERANCE`、`HTML2UMG_CJK_BREAKS`。
* **且 `allowTtc` 默认是开的**（`options.allowTtc === false ? false : process.env.HTML2UMG_TTC_SUBFACES !== '0'`），但同一文件里还留着一段"OFF by default"的旧注释 → 两段注释互相矛盾，是后续踩坑源。
* 更严重的是**可复现性**：这三个开关决定"同一份 HTML 会拿到哪个字体文件/哪种换行"，但都没写进 layout.json → 两次转换的差异无法归因（对像素审计很致命）。

**建议**：args.js 加三个选项 → `convert.js` 的 `new AssetRegistry({...})` 传 `allowTtc`、`new Mapper({options:{...}})` 传 `wrapTolerance/cjkBreaks`（现在 options 里只有 `scaleBox/baked/pinFlowHeights`）→ layout.json 顶层记 `fonts:{ policy, ttcSubfaces, wrapTolerance, cjkBreaks }`；顺手删掉互相矛盾的旧注释。

---

## 7. P1-4 `.ttc` 子面度量用了错的面

* `fontmetrics.readFontFile(file, options)` 支持 `options.index`（`ttcf` 会读 `numFonts` 并夹取 index），但 `mapper.js` 的 `fontMetricsFor(fontProps)` 调的是 `fontmetrics.readFontFile(file)` —— **没有把 `record.subface` 传进去**。
* 后果：`msyh.ttc` 的两个面行盒比是 **1.3198（face0）/1.2700（face1）**，差 3.9%；如果某条字体记录用了 subface 1（YaHei UI），行高、基线换算全按 face0 算 → 每行差 3.9%，10 行差约 0.4 个行盒。
* 修法：`readFontFile(file, { index: record.subface || 0 })`；缓存 key 也要带 subface（`this._metricsByFile` 现在是纯路径）。

---

## 8. P1-5 `subface: 0` 不可表达 + 静默退化

* converter 只在 `subface > 0` 时写字段（为了让纯拉丁页面的 JSON 保持逐字节不变，理由正当），但契约上 `0` 是合法且**语义区别于 -1**（-1 = 按字重/斜体猜）。目前"我要 face 0"无法表达。
* `PickSubFaceIndex()` 的 `if (SubFaces.Num() <= 1) return 0;` 在**检查 RequestedIndex 之前**，所以"JSON 声明了 subface 1，但文件只有 1 个面"时不会走那条 warning，直接静默用 0。
* 建议：`if (RequestedIndex > 0 && !SubFaces.IsValidIndex(RequestedIndex)) warn(...)` 提前到 `Num() <= 1` 判断之前；converter 侧在"promoted/替换面"或者用户显式指定时允许写 `subface: 0`（用一个 `subfaceExplicit` 标记避免破坏拉丁页面的字节稳定性）。

---

## 9. P2 若干

* **P2-1 `UIScale` 死选项**：`FH2UImportOptions::UIScale` 解析了，但没有任何地方乘它。若有人填 2.0 期望整体放大，会得到"没变化"。要么实现（注意 `WrapTextAt`、`Font.Size`、槽位偏移都要一起乘），要么在 CLI 文档里标"reserved"。
* **P2-2 `license`**：只在 converter 侧用于 `--font-policy` 与警告汇总，C++ 不读、layout.json 里也不作为可审计字段。建议在 layout 顶层写 `fonts:{proprietary:[...]}` 之类，便于发布前审计（现在只能靠 stderr）。
* **P2-3 `platformFonts` 边界**：`maxNodes` 默认 1500（超出只警告并截断）；只探"元素自身拥有文本"的节点，所以行内混排被合并成一个 TextBlock 后，只有父元素的 `platformFonts` 可见（CONTEXT 里那条"行内混排小字号被合并"的缺口会因此拿不到正确回退）。
* **P2-4 chain 是并集**：同一 family 的 400/700 条目各自带 chain，`RebuildFallbacks` 会 `Append` 其他字重的 chain（保序但会追加）。若 Bold 需要 emoji 面而 Regular 不需要，Regular 也会注册它 → 无害但会让"为什么这个 family 有 emoji 面"难以追因。建议在日志里打出"chain 来自哪个 key"。

---

## 10. lead 问题 c：老 JSON 兼容性表

| 新增/变化字段 | 旧 JSON 缺它时 C++ 行为 | 是否安全 |
|---|---|---|
| `assets.fonts[].fallbacks[]` | `Ref.Fallbacks` 为空 → `RebuildFallbacks` 立即 return 0，family 资产与旧版完全一致 | 安全 |
| `fallbacks[].coverage` | 走"块级记账"老路径（`ClaimedCjkBlocks` 分块，避免两个 fallback 拿同一套区间） | 安全，但老路径仍是块粒度（同一块内部分覆盖会漏；建议加 warning） |
| `fallbacks[].key`（无 file） | 解析期就被丢弃（见 P1-1） | **不安全**（静默丢回退） |
| `assets.fonts[].subface` | 默认 -1 → 按 weight/italic 选面；单面文件 → 0，与旧版一致 | 安全 |
| `assets.fonts[].license` | C++ 不读 | 无影响 |
| `properties.WrapTextAt` | 缺省 0 → UMG 不绑定，退化为旧版（Slate 按几何宽度 + AutoWrapText） | 安全（视觉退化为"可能不换行"） |
| `properties.WrappingPolicy` | 缺省 `DefaultWrapping`（只在单词边界断） | 安全（CJK 长段可能不换行） |
| `properties.LineHeightPercentage` | 缺省 1.0 → Slate 自然行盒 | 安全（行高按 Slate 自然值，非 CSS 值） |
| `properties.ShadowOffset` | 缺省 UTextBlock 默认 (1,1)（透明色也会让行盒 +1px） | **注意**：旧 JSON 会带这 1px，新 JSON 显式写 (0,0) |
| `assets.fonts[].hasFile` | 只存在于 converter 内存，不进 JSON（JSON 用 `file:""` 表达） | 无影响 |
| `layout.contractVersion` | 仍为 1（只加可选字段，未 bump） | 安全；建议在 README 记"1.x 兼容策略" |

另：converter 侧对"纯英文页面"的承诺（`fallbacks` 字段整个省略、`subface` 为 0 时省略）**已核对成立**——`record.fallbacks` 只在非空时挂上；`license` 是新增必带字段，会让 `assets.fonts[]` 出现**逐字节差异**，如果验收脚本里比较 JSON 文本要留意（比较语义字段则无影响）。

---

## 11. ReactorUMG 侧「文本测量」结论（lead 问题 3）

**没有可抄的：该仓库 C++ 里 0 处文本测量/换行代码。** `measure`/`Measure` 在 `Source/` 下 0 命中；`AutoWrapText`/`WrapTextAt`/`LineHeightPercentage` 只出现在生成的 `ue.d.ts` 声明里。它的文本测量发生在**外部 npm 包**（`reactorumg` / `ReactorUMG-TS`），React 那层把 widget 建好交给 Slate，自己不做 text layout。

唯一值得借的是**思路对比**：
* 它的 `UUMGManager::GetWidgetGeometrySize` 用 `Widget->GetPaintSpaceGeometry()` —— **arrange 之后再测**，所以它从不预设文本宽高，也就天然不会犯"WrapTextAt 猜错"这类错（代价是布局完全交给 UMG，无法在生成期知道文本会不会溢出）。
* 我们的管线是"先测后生成"（Chromium 有真值），所以正确做法不是学它放弃约束，而是**把浏览器的换行事实一起采集下来**（`textLines`/`scrollWidth`），再决定是否施加 WrapTextAt —— 这正是 §5 的建议。

---

## 12. 建议的修复顺序

1. **P0-3**（落盘）——否则一切 A/B 都不可信，且 P0-1/P0-2 的修复无法被验证。
2. **P1-2**（幽灵 flag + 把开关写进 JSON）——直接决定"能不能复现别人的数字"。
3. **P1-1**（key-only fallback）——一行守卫，避免静默丢回退。
4. **P1-3**（WrapTextAt 门控 + `textLines/scrollWidth` 采集）——先补数据再收紧，避免把"多折一行"变成新的系统误差。
5. **P1-4**（子面度量）/ **P1-5**（subface:0 + 静默退化告警）。
6. P2 项择机。
