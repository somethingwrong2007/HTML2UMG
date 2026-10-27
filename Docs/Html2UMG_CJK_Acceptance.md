# Html2UMG：中文字体回退与文本排版 —— 验收文档（最终版）

> 全部数字由 verify 在本机实测（<项目根>，UE 5.8，2026-10-27）。
> 每个数字都能用文末「如何复现」的命令重跑；没实测过的不写。

## 0. 这批数字对应的代码

| 组件 | 版本 |
|---|---|
| 转换器 `Resources/Converter/src/mapper.js` | **2026-10-27 18:28:42** |
| 编辑器模块 `Plugins/Html2UMG/Binaries/Win64/UnrealEditor-Html2UMG.dll` | **2026-10-27 16:31:45** |
| 引擎 | E:/Epic Games/UE_5.8 |

11 页全部用**同一份 DLL + 同一版转换器**跑；每页单进程、独立 `--assets`、无空格路径。

## 1. 一句话结论

中文豆腐块/丢字的根因**不是缺字体文件**，而是主字体族（Segoe UI / Inter）没有 CJK 字形、导入器又没建回退链；
排版问题的根因是 TextBlock 从来没有 `WrapTextAt`，且行盒按字体模型估算而不是按浏览器的真实行盒。
修复后：glyph 缺失 **1831 条 → 0**，同宽方框 **16 段 → 0**，中文复现页像素差异 **17.12% → 7.97%**（同一页），
仓库 10-cjk 页 **3.82%**（结构边 92.6%），11-typo 十项几何 **Δ 全部 0.00px**，
**9 个既有测试页全部不高于基线（无回归）**。

## 2. 9 页回归最终表（before = 上一轮 CONTEXT 基线；after = 本批；括号为结构边命中率）

| 页面 | before | after | Δpp | 判定 |
|---|---|---|---|---|
| 01-flex | 1.49% | **0.87%**（94.5%） | **-0.62** | 改善 |
| 02-absolute | 0.38% | **0.35%**（85.7%） | -0.03 | 改善 |
| 03-dashboard | 3.05% | **2.84%**（77.4%） | **-0.21** | 改善 |
| 04-form | 1.47% | **1.46%**（77.3%） | -0.01 | 持平/改善 |
| 05-controls | 2.55% | **2.53%**（72.5%） | -0.02 | 改善 |
| 06-native | 1.99% | **1.86%**（83.8%） | **-0.13** | 改善 |
| 07-anchors | 0.43% | **0.36%**（91.8%） | -0.07 | 改善 |
| 08-effects | 0.38% | **0.37%**（98.6%） | -0.01 | 持平 |
| 09-borders | 0.40% | **0.40%**（100.0%） | 0.00 | 持平 |

**判据「每页 ≤ before + 0.15pp」全部满足**：7 页改善、2 页持平，无任何页面变差。

## 3. 中文页

| 页面 | 起点 | 最终 | 结构边 | 说明 |
|---|---|---|---|---|
| 复现页 `scratch/cjk-repro.html`（1920×1080，37 个 TextBlock） | 17.12% | **7.97%** | 40.9% → **66.1%** | 同页同参数四阶段，见 §4 |
| 仓库 `test/10-cjk.html`（1920×1080，47 个 TextBlock） | 本轮只测最终值 | **3.82%** | **92.6%** | glyph 缺失 0，最差 \|dy\| 0px |
| 探针 `test/11-typo.html`（1200×900） | 15.02% | **11.23%** | 61.5% → **77.6%** | 15.02/11.23 为 typo 侧同尺寸记录；verify 在最终代码上实测整页 13.69%（页面收尾阶段有增补，两者不可直接相减），但**十项几何 verify 端实测 10/10、Δ 全 0.00px** |

## 4. 四阶段数字（cjk-repro 页，同页同参数）

| 阶段 | 代码状态 | 像素差异 | 结构边 | 最差 \|dy\| | glyph 缺失 | 同宽方框 |
|---|---|---|---|---|---|---|
| 基线 | 未改 | 17.12% | 40.9% | 28px | 1831 条 / 184 码点 | 16 段 |
| + 复合字体 | FCompositeFont 子字体 + fallbacks | 15.86% | 38.3% | 28px | 0 | 1 段 |
| + 换行与行高 | WrapTextAt + WrappingPolicy + 逐字体行高 | 8.58% | 65.2% | 0px | 0 | 0 段 |
| + 门控与实测行盒 | 只在真折行时发 WrapTextAt + 浏览器实测行盒 | **7.97%** | **66.1%** | **0px** | **0** | **0 段** |

## 5. 豆腐判据（三条机器判据，不靠肉眼）

1. **日志**：`grep -c "Could not find Glyph Index"` = 1831 → **0**；`grep -o "codepoint U+[0-9a-f]*" | sort -u | wc -l` = 184 → **0**。
   基线每条都跟着 `getting last resort font data <同一个 Latin 字体文件>`——所谓 last resort 就是同一个没有中文的文件。
2. **像素**：H1 行（x 24..1896, y 24..52）做"同宽重复墨迹"检测（逐段墨迹像素签名哈希）：
   基线 28 段中 **16 段像素完全相同、段宽清一色 20px**（豆腐框）→ 仅复合字体 1 段 → 最终 **0 段**，段宽 17/18/19/20 各异。
3. **像素差异**：17.12% → 7.97%（同页）；10-cjk 页 3.82%。

## 6. 排版判据

### 6.1 折行（wrap-probe：4 个 400px 宽 × 132px 高盒子，14px / line-height 22px）

| 组 | 内容 | TextBlock arrange | 浏览器 DOM | 判定 |
|---|---|---|---|---|
| 1 | 英文多词长句 | 382.0 × **66.0**（3 行） | 382 × 66 | 逐像素一致 |
| 2 | 中文 40 字无空格 | 382.0 × **44.0**（2 行） | 382 × 44 | 逐像素一致 |
| 3 | 中文 + U+200B | 382.0 × **44.0**（2 行） | 382 × 44 | 逐像素一致 |
| 4 | `white-space:nowrap` | 382.0 × **22.0**（1 行） | 382 × 22 | 逐像素一致 |

→ Slate 的 `AllowPerCharacterWrapping` 在 CJK 字间可用，**不需要 U+200B 注入**。

### 6.2 字体度量 / 行高（11-typo，1200×900，10/10，Δ 全部 0.00px）

| 元素 | 目标 | 实测 | 元素 | 目标 | 实测 |
|---|---|---|---|---|---|
| TitleWrap | 28±1 | 28.00 | Size12 | 17±1 | 17.00 |
| ZhPlain | 88±2 | 88.00 | Size13 | 19±1 | 19.00 |
| ZhLh30 | 90±2 | 90.00 | Size14 | 20±1 | 20.00 |
| MixText | 66±2 | 66.00 | Size16 | 24±1 | 24.00 |
| NowrapText | 22±1 | 22.00 | Size20 | 29±1 | 29.00 |

改前 Size12..20 是 15.96 / 17.29 / 18.62 / 21.28 / 26.60（= 字体像素 × 1.330 整），系统性偏矮 1.0~2.7px。

### 6.3 文本盒高度与竖直位置

| 指标 | 基线 | 最终 |
|---|---|---|
| mean \|Δh\| | 15.01px | **5.40px** |
| median Δh | -17.00px | **0.00px** |
| Δh 精确为 0 的盒子 | — | **26/37** |
| 400px 长中文段落 | 88px(4 行) → 22.2px(1 行)，Δh -65.8 | Δh **0.0** |
| 竖直位置（10-cjk，盒内首行墨迹） | — | 中文 26 个 mean\|Δtop\| = **0.00px**、拉丁 18 个 = **0.00px** |

复合字体没有把拉丁基线带偏：cjk-repro 中文行 2.04px / 拉丁行 2.08px（差 0.04px），10-cjk 上两组都是 0.00px。

## 7. 机制（本轮真正的新知识）

1. **Chrome 的 `line-height:normal` 行盒 = round(ascent) + round(descent) + round(lineGap)**，三个分量**各自取整**
   （33/33 探针误差 0.00px）。这解释了一个长期困惑：为什么 10px 中文行盒是 14 而 12px 是 17——不是比例，是三分量分别取整再相加。
2. **字体模型的例外很大**：Consolas 16.10 vs 14、10px 13.30 vs 14、17px 22.61 vs 22、可变字体 / .ttc（子面度量与主面不同），
   单点误差 0.7~2.1px。这类误差会被**烘焙贴图重采样放大**：控件整体位移零点几像素，它的整条底边/缩略图/圆角都要重新采样，
   那块区域几百~几千像素全变成"差异"，在整页上表现为 0.2~0.4pp。
   实测：03-dashboard 的 +0.19pp 里 **98.6% 集中在单一个 304×328 热区**（右侧相机瓦片，文本盒内只占 11.3%）；
   04-form 的 +0.34pp 里 **72.8% 集中在 5 个热区**（滑块行、对话框底边、笔记框、下拉框），文本盒合计只贡献 3.5%。
3. **最终策略：浏览器实测 content box 优先、字体模型兜底**（`HTML2UMG_LINE_BOX_MEASURE_MIN`，默认 0.25px：实测与模型差 ≥0.25px 才采用实测）。
   03/04 的回归就是这么消掉的：03 **3.24 → 2.84**、04 **1.86 → 1.46**。
4. **槽位落位规则**：文本盒比行盒高时按实测落位（03 的 StatUnit 绝对墨迹 **−11.4 / −15.9px → +3.3 / +0.3px**），规则带 5 条守卫
   （交叉轴居中、定高、block 级、等）。
5. **两次误触发事故（反例，必须记住）**：
   - 05-controls：`Check_Text / Check_1_Text / Check_2_Text` 的 padding-top 被写成 **23 / 52 / 81px**（本应 0），像素 2.53% → **4.77%**；
   - 06-native：`Row_Text` 从 `Padding[10,0,0,0] + VAlign=Center` 被改成 `Padding[10,23,0,0] + VAlign=Top`，
     绝对墨迹偏移 **−78 / −116 / +241 / +254 / +228 / −182px**，像素 1.93% → **2.21%**；
     根因是 `crossAxisTextOffset` 漏传 slot 参数，Center 守卫从未生效；修好后 06 回到 **1.86%**、slot 变化 0。
   - 教训：**改完先做 JSON diff 计数再渲染**（"slot_changed / lhp_changed 各几个"），比看像素更早发现空转。

## 8. 已知残差

| 现象 | 证据 | 说明 |
|---|---|---|
| 表格单元格 | 10-cjk 上 Δh −21px、Δw −26px | **不修**：实测墨迹只差 1~3px，那 −21 是拿 UMG 内容盒比浏览器 border-box 的口径差；照它改会把表格整体推低 |
| 长文档累计高度 | 见 `Resources/Tools/residual_correct.py` | `--pin-flow` 可缓解，不通用 |
| letter-spacing 尾字 | 整行宽差 1 个间距 | Chromium 把间距加在末字之后，Slate 不加 |
| `lineGap` 非零字体（如 Consolas） | 实测 16.10 vs 模型 14 | 已被"实测优先"覆盖；若某环境测不到浏览器 content box 会退回模型，偏差 0.7~2.1px 才重现 |
| 抗锯齿微差 | 全页 0.2~0.4pp | 文字栅格化路径差异，非几何；见 §7.2 |

## 9. 开关清单（当前版本实际存在的）

CLI：`--font-policy`、`--ttc-subfaces` / `--no-ttc-subfaces`、`--wrap-tolerance`、`--cjk-breaks`、
`--line-height-model`（per-font / legacy）、`--text-shadow`（zero / default）、`--line-box-snap`（font / exact / half / int）、
`--pin-flow`、`--bake` / `--no-bake`、`--bake-scale`、`--bake-max`、`--viewport`、`--probe`、`--assets`、`--shot`、`--dump-snapshot`。

环境变量：`HTML2UMG_LINE_BOX_MEASURE_MIN`、`HTML2UMG_LINE_BOX_SNAP`、`HTML2UMG_LINE_HEIGHT_MODEL`、
`HTML2UMG_WRAP_TOLERANCE`、`HTML2UMG_TEXT_SHADOW`、`HTML2UMG_CJK_BREAKS`、`HTML2UMG_TTC_SUBFACES`、`HTML2UMG_BROWSER`。

**A/B 结论（防止后人误操作）**

- `--line-height-model legacy`（单一全局常数 1.0625）**不能回退**：01-flex 0.87% → **1.33%**、04-form 1.46% → 1.86%（两页方向相反，说明不存在统一常数）。
- `--line-box-snap` 的 half / int / font 在 03/04/01/05 上都没稳定优于默认 exact（03：exact 3.24 / half 3.29 / int 3.37 / font 3.37），**不要切默认**。
- `--text-shadow default` 与 zero 在 04-form 上等价（1.87% vs 1.86%）；保留 zero 的理由是"让行盒回到字体自身度量"。

## 10. 如何复现

```bash
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'   # 否则 /Game/... 会被 MSYS 改写成 C:/...

# 1) 转换（本机 Chromium 测量）
node Plugins/Html2UMG/Resources/Converter/cli/convert.js Plugins/Html2UMG/Resources/Converter/test/03-dashboard.html \
     -o C:/out/final4/03-dashboard/layout.json --assets C:/out/final4/03-dashboard/assets \
     --viewport 1920x1080 --shot C:/out/final4/03-dashboard/browser.png --dump-snapshot C:/out/final4/03-dashboard/snap.json

# 2) 导入 + 渲染 + 几何 dump（一轮三个产物；离屏渲染要真 RHI，不要加 -nullrhi）
"E:/Epic Games/UE_5.8/Engine/Binaries/Win64/UnrealEditor-Cmd.exe" "<项目根>/<工程>.uproject" \
  "-ExecCmds=Html2UMG.ImportRenderGeometry C:/out/final4/03-dashboard/layout.json /Game/UI/Html2UMGFinal4/WBP_03dashboard C:/out/final4/03-dashboard/umg.png C:/out/final4/03-dashboard/geo.json 1920x1080, QUIT_EDITOR" \
  -unattended -nosplash -windowed -NoSound -stdout -FullStdOutLogOutput -log

# 3) 审计
python Plugins/Html2UMG/Resources/Tools/visual_audit.py C:/out/final4/03-dashboard/browser.png C:/out/final4/03-dashboard/umg.png
```

**坑**

- `-ExecCmds` 里的路径**不能带空格**（`E:/Epic Games/...` 会被拆成两个参数，日志表现为 `importing 'E:/Epic' -> 'Games/...'` + `import FAILED`）。一律放 `C:/out/...`。
- `-ExecCmds` 用**逗号**分隔多条命令，不是分号。
- 每页 `--assets` 独立，否则贴图按位置命名会互相覆盖。
- 不要加 `-nullrhi`：离屏渲染需要真 RHI。
- 复现用新蓝图路径，避免复用旧 WidgetTree；一页一进程，多页连渲会互相影响。

## 11. 关键产物

- 9 页最终产物：`C:/out/final4/<page>/`；中文复现页：`C:/out/cjk-final3/`；10-cjk：`C:/out/final3/10-cjk/`；11-typo：`C:/out/final3/11-typo/`
- 基线三件套：`scratch/out/cjk/baseline/{browser,umg}.png`
- 结果汇总：`scratch/out/final4-results.txt`（以及 final3 / snap / snap2 / snap3 / snap4 各轮）
- 归因报告：`scratch/out/regress/REPORT.md`
