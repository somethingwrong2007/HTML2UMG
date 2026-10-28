# Html2UMG 残差修正（离线回灌原型）

> 配套脚本：`Plugins/Html2UMG/Resources/Tools/residual_correct.py`（Python 3.8+，只用标准库）
> 上游研究：`Docs/ReactorUMG_Layout_Review.md` 的 C1（ReactorUMG 的"布局后读回实测几何再修正"）。
> 状态：**离线原型，未接进 `cli/convert.js`**。本文第 7 节写清怎么接，第 8 节是 C2 的可派单补丁说明。

---

## 1. 解决什么

我们的转换器只在 Chromium 里测一次，之后不再回头：每个元素几像素的尺寸差会沿竖向文档流累加
（真实设计 7081px 高，累计漂移 660px）。现有的 `--pin-flow` 能压住它，但它是"全叶子冻结"，
对 flex 页面有害（`项目内的踩坑记录:94`）。

本工具把闭环的**回灌半边**补上，而且不是凭感觉钉：

1. 拿 UMG 真正 arrange 出来的几何（`Html2UMG.ImportRenderGeometry` 的 geo.json）；
2. 和 Chromium 测到的矩形（converter 的快照 snap.json）逐元素对齐；
3. 只在**能证明是文档流累计误差**的地方产出钉高 / 槽位偏移；
4. 其余一律写进"跳过原因"，并单独列出"行数不符"这类**缺陷**——它们是给人看的，不是拿来钉的。

一句话：**它就是 `--pin-flow` 的"有判据版本"**，判据可复核、可复现、可 diff。

---

## 2. 数据流

```
design.html
   │  cli/convert.js --dump-snapshot
   ├──> layout.json ───────────────┐（控件树：name / class / source / properties）
   └──> snap.json  ────────────────┤（DOM 树：i / p / k / tag / cls / rect / cs / decl）
                                   │
   │  编辑器：Html2UMG.ImportRenderGeometry
   └──> geo.json ──────────────────┤（实测：name / class / parent / x / y / w / h / painted）
                                   ▼
                      residual_correct.py
                        │            │
             corrections.json    residual_report.md
             （机器可读）          （人读：Top N + 判据 + 跳过原因）
                                   │
                       --patch-layout（临时通道，仅 SizeBox）
                                   ▼
                          layout_patched.json ──> 再导入 ──> 再量差异
```

三份输入缺一不可：**geo 给"实际"，snap 给"期望"，layout 给"控件名与族"**。
`layout.json` 里没有 rect（契约本来就不带测量值），所以期望矩形只能来自 snapshot——
脚本会在 `layout.json` 同目录自动找 `snap.json` / `snapshot.json` / `measures.json`，也可以 `--snapshot` 指定。

---

## 3. 输入格式

### 3.1 geo.json（编辑器产物，只读）

```jsonc
{
  "blueprint": "/Game/UI/Html2UMGTest/WBP_WrapProbe",
  "width": 1920, "height": 1080,
  "widgets": [
    { "name": "Box_Size", "class": "SizeBox", "parent": "Root_Content",
      "x": 24, "y": 0, "w": 400, "h": 132, "painted": true }
  ]
}
```

| 字段 | 语义 | 本工具的用法 |
|---|---|---|
| `name` | 控件名（与 WBP 一致） | **与 layout 节点名精确匹配**，也是 corrections 的键 |
| `class` | 控件类 | 判断 pin 记录里的 kind（容器 / 文本） |
| `parent` | 父控件名 | 报表展示用 |
| `x,y,w,h` | Slate arrange 结果（视口绝对坐标） | 实测矩形 |
| `painted` | 是否真正绘制过 | **`false` 一律跳过**：零面积不等于"位于 0,0"（与 Html2UMGFidelity.cpp:93-95 同一个坑） |

### 3.2 snap.json（converter 产物，只读）

```jsonc
{ "primary": { "viewport": { }, "elements": [
    { "i": 3, "p": 0, "k": [4, 5], "tag": "div", "id": "", "cls": ["box"],
      "rect": [24, 0, 400, 132],                       // 期望矩形（Chromium 布局，视口坐标）
      "cs":   { "display": "block", "flexDirection": "row", "height": "auto" },  // computed
      "decl": { "height": "132px", "padding": "8px" }                            // authored
    } ] } }
```

| 字段 | 语义 | 本工具的用法 |
|---|---|---|
| `i` / `p` / `k` | 元素序号 / 父序号 / 子序号表 | 重建 DOM 树，算"同父兄弟的累计位移" |
| `rect` | 期望矩形 | 期望值 |
| `cls` / `id` / `ue.name` | 命名来源 | 复刻 `names.js` 的 `baseName()` 找控件族 |
| `cs` | computed style | 只读 `display` / `flexDirection` / `position` / `flexGrow` |
| `decl` | authored style | **判"是否声明了 px 高度"只能用 decl**（cs 里 height 一定已被解析成 px） |

> 踩过的坑：第一版把 `cs.height` 也当成"作者声明的高度"，于是每个元素都被判成
> "已有显式高度却不符"，一个 pin 都不产出。判据必须只看 `decl`。

### 3.3 layout.json（converter 产物，只读）

只需要两件事：`root` 下的**控件树**（`name` / `class` / `children`），
以及每个节点是否 `class == "SizeBox"`（决定 `--patch-layout` 能不能直接改）。

---

## 4. 输出格式

### 4.1 corrections.json

```jsonc
{
  "version": 1,
  "generator": "html2umg-residual-correct/0.1.0",
  "inputs": { "layout": "...", "geometry": "...", "snapshot": "...",
              "blueprint": "/Game/...", "viewport": { "width": 1920, "height": 1080 } },
  "tolerance": { "absPx": 0.5, "minDriftPx": 2.0, "textPin": true },
  "summary": { "matched": 54, "pinned": 26, "slotOffsets": 5, "skipped": 27,
               "skippedByReason": { "table-flow-parent": 17, "...": 0 } },
  "nodes": {
    "Box_1_Size": {
      "pinHeight": 280.0,          // 期望高度（CSS px）—— 要钉的值
      "actualHeight": 171.7,       // 实测
      "deltaHeight": -108.3,
      "deltaY": -52.2,
      "kind": "container",         // container | text | other
      "widgetClass": "SizeBox",
      "source": "div.box",         // 对应的 DOM 元素（调试用）
      "reason": "cumulative-flow", // cumulative-flow | own-box-height | text-line-box
      "expectedRect": [24, 513, 448, 280],
      "actualRect": [24, 461, 448, 172]
    }
  },
  "slotOffsets": {
    "H2_2": { "padTop": -52.25, "deltaY": -52.25, "source": "h2", "reason": "first-child-offset" }
  },
  "skipped": [ { "name": "Td_3_Size", "reason": "table-flow-parent" } ]
}
```

| 键 | 语义 | 下游怎么用 |
|---|---|---|
| `nodes.<name>.pinHeight` | 该控件的**盒子高度**应被钉成多少 | 等价于 mapper 里的 `h2uFlowHeight`（mapper.js:243-245、2629-2640） |
| `slotOffsets.<name>.padTop` | 其父槽位在主轴上应补的 padding（正 = 下移） | boxSlot 的 `Padding[1]/[0]`（mapper.js:488-490） |
| `reason` | 判据来源，便于 review | 不接受某类判据时可按 reason 过滤 |
| `skipped[]` | 为什么不改 | 报表与 CI 用；**不要静默丢** |

### 4.2 residual_report.md

七节：结论 → 钉高表 → 槽位偏移表 → 累计判据证据（容器级）→ **4.1 文本行数不符（缺陷清单）** →
Top N 偏差元素（不含根）→ 跳过原因统计 → 怎么用。

"文本行数不符"这一节是**副产品但很值钱**：它把"这段文字本该 2 行、只渲染了 1 行"直接列出来，
正是这次 CJK 换行调查要看的东西，而钉高只会把空行留在原地，所以这一类**永不产生修正**。

---

## 5. 启发式规则

### 5.1 配对：DOM 元素 ↔ 控件

转换器对一个元素会产出一**族**控件（`Card_Size` / `Card@@ / `Card_Content`），最外层那个才是元素的盒子。
规则（与 `names.js` 对齐）：

- 用 `data-ue-name > id > 第一个语义 class > tag`（跳过 `is-` / `has-` 等状态类）算 base name；
- 同名元素第 k 个（k≥1）的族根是 `Base_k`；
- 族的判定：节点名 `== Base` 或 `startswith(Base + "_")`，取**深度最小**的那个当盒子；
- `html` / `body` 统一映射到根控件，且**永不修正**（它的高度按设计就是视口高）。

真实 dump 上的命中率：cjk-after 54/54 个非根元素全部配对成功；wrap-probe 9/9。

### 5.2 什么可以钉（判定顺序）

| 顺序 | 判据 | 结果 |
|---|---|---|
| 1 | 根元素（html/body） | 跳过 `root-is-viewport-sized` |
| 2 | `position:absolute/fixed` | 跳过 `absolute-positioned@@（锚点负责，不属文档流） |
| 3 | 父的 `display` 是 `grid` | 跳过 `grid-parent@@ |
| 4 | 父是 `flex-direction:row` | 跳过 `horizontal-flow-parent@@（横向不累积高度） |
| 5 | 父是 `display:table*`（tr/td/th/tbody） | 跳过 `table-flow-parent@@（我们映射成 GridPanel/HBox） |
| 6 | 自身 `flex-grow > 0` 或高度是百分比 | 跳过 `flex-fill-or-percent-child@@（钉住会冻结响应式） |
| 7 | `decl` 里有 px 高度、但渲染不符 | 跳过 `explicit-height-mismatch@@（**这是转换缺陷，钉高会掩盖它**） |
| 8 | 文本且 `期望高 / 实测高` 接近整数 ≥2（±12%） | 跳过 `text-line-count-mismatch@@（行数不符，见 4.1） |
| 9 | `--no-text-pin@@ 且文本未声明 line-height | 跳过 `text-pin-disabled@@ |
| 10 | 其余且 `abs(Δh) > tolerance@@ | **钉高**：`pinHeight = 期望高` |
| 11 | `Δy` 无法被"前序兄弟的 Δh 之和"解释 | **槽位偏移** `padTop` |

判据 10 的理由分三档，写进 `reason`：

- `cumulative-flow`：本元素的 `Δy` 恰好等于前面兄弟 `Δh` 之和 → 它是被上游推下来的（钉它止住传播）；
- `own-box-height`：`Δy` ≈ 0 但自身高度不对 → 它是**源头**（钉它修正下游）；
- `text-line-box`：文本声明了 line-height，行盒已知，钉高有意义。

### 5.3 槽位偏移为什么要算"差分"

一个 8px 的整体下移如果对 9 个兄弟各发一次 `padTop=+8`，下游就会叠 72px。
所以只发 `Δ(unexplained)`：同父兄弟里"残余位移"相对前一个的变化量超过容差才发一条。
cjk-after 上这条规则把 17 条偏移收敛到 5 条（+8 / +35 / −52.25 / +35 / −36.9，都是组首那一个）。

### 5.4 明确不做的事

- 不改宽度（`Δw` 只进报表）：宽度问题来自 slot 交叉轴语义，钉宽度会毁掉响应式；
- 不钉 `explicit-height-mismatch`：那一类要修的是转换器，不是数据；
- 不猜缺失的控件：几何 dump 里没有 → 跳过并计数，不做插值。

---

## 6. 怎么在真实页面上跑

本机 `python` 不在 PATH 里时，用 DSH 自带解释器（任何 3.8+ 均可）：

```bat
set PY=C:\Users\ADMIN\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe
```

### 6.1 只出报告（不跑编辑器）

```bat
"%PY%" Plugins\Html2UMG\Resources\Tools\residual_correct.py ^
  --layout C:\out\cjk-after\layout.json ^
  --geo    C:\out\cjk-after\geo.json ^
  --out    C:\out\cjk-after\corrections.json ^
  --report C:\out\cjk-after\residual_report.md
```

输出形如：

```
matched 54 elements -> 26 pin(s), 5 slot offset(s), 27 skipped
wrote C:\out\cjk-after\corrections.json
wrote C:\out\cjk-after\residual_report.md
```

### 6.2 生成"改过的 layout.json"再回灌（临时通道）

```bat
"%PY%" Plugins\Html2UMG\Resources\Tools\residual_correct.py ^
  --layout C:\out\cjk-after\layout.json ^
  --geo    C:\out\cjk-after\geo.json ^
  --patch-layout C:\out\cjk-after\layout_patched.json
:: 然后照常导入/渲染，比较两次的 visual_audit
UnrealEditor.exe <工程>.uproject "-ExecCmds=Html2UMG.ImportRenderGeometry C:/out/cjk-after/layout_patched.json /Game/UI/Html2UMGTest/WBP_Residual C:/out/cjk-after/umg2.png C:/out/cjk-after/geo2.json 1920x1080, QUIT_EDITOR" -unattended -windowed
python Plugins\Html2UMG\Resources\Tools\visual_audit.py C:\out\cjk-after\browser.png C:\out\cjk-after\umg2.png --snapshot C:\out\cjk-after\snap.json
```

注意：`--patch-layout` 只能改 **class 是 SizeBox** 的节点（它有现成的 `HeightOverride`）；
cjk-after 上 26 个 pin 里只有 8 个是 SizeBox，其余 18 个（Row、TextBlock 等）必须由 mapper 钉 —— 这正是第 7 节要接的东西。

### 6.3 自测（不需要任何 dump）

```bat
"%PY%" Plugins\Html2UMG\Resources\Tools\residual_correct.py --self-test
:: self-test OK
```

自测会现搭一份最小 fixture（根 / 显式高 60 的表头 / 自动高但渲染矮了的卡片 / flex row 容器），断言：
自动高卡片被钉到 100、根不参与、row 子项不钉、`painted:false` 的控件被跳过、markdown 反引号没被吃掉。

---

## 7. 二次 convert：三条路，以及"下一步怎么接"

### 7.1 现在能做的（零改动）

`--patch-layout` + 手工确认。适合先看效果，不适合量产（只覆盖 SizeBox）。

### 7.2 推荐接入：`cli/convert.js` 加 `--corrections@@（由 lead 派单，不属于本任务）

改动点只有三处，都不碰现有分支逻辑：

```js
// 1) cli/convert.js：读文件 + 透传选项（与 opts.pinFlowHeights 同级）
const corrections = opts.corrections ? JSON.parse(fs.readFileSync(opts.corrections, 'utf8')) : null;
new Mapper(snapshot, { ...options, corrections });

// 2) src/mapper.js：readStyle() 末尾（约 290-300 行，h2uFlowHeight 消费处）追加
const corr = this.opts.corrections;
if (corr && corr.nodes && corr.nodes[rec.name]) {        // rec.name 由 names 注册表给出
  rec.h2uFlowHeight = corr.nodes[rec.name].pinHeight;    // 复用现有通道
}

// 3) src/mapper.js：boxSlot() 里（约 488-490 行，Padding 组装之后）
const off = corr && corr.slotOffsets && corr.slotOffsets[cmeta.name];
if (off) out.Padding[vertical ? 1 : 0] = V.round(out.Padding[vertical ? 1 : 0] + off.padTop, 2);
```

**关键约束**：corrections 的键是**控件名**，而 mapper 在 `readStyle()` 阶段还没分配名字（名字在 `mapChildren` 里
用 `names.unique()` 才产生）。两种收口方式，任选其一：

| 方式 | 做法 | 优点 / 代价 |
|---|---|---|
| A（推荐） | 在 `mapChildren` 里拿到 name 之后再回写 `rec.h2uFlowHeight@@ / `slot.padTop@@ | 名字准确；改 3 行 |
| B | corrections 里同时带 `expectedRect`，用 rect 匹配 `rec.rect@@ | 不改名字时序；但重叠元素可能撞车（脚本已把 rect 写进 corrections，仅供这种兜底） |

### 7.3 门禁化（可选）

把 `residual_correct.py` 接进 `Resources/Tools/run_acceptance.py`：每页先 convert → 导入渲染 → 出 corrections，
**断言 `summary.pinned` 与 `skippedByReason` 不劣化**（例如 `explicit-height-mismatch` 条数不得增长）。
它天然是个"哪里坏了"的回归探针，比像素差异更有定位力。

---

## 8. C2 补丁说明（可直接派单）：justify-content: center / flex-end 落成槽 padding

### 8.1 问题

`mapJustify()`（mapper.js:2855-2870）把 `center@@ / `flex-end@@ 映射成**每个子项的主轴对齐**，
再由 `boxSlot()`（mapper.js:515-544）写进 `VerticalAlignment` / `HorizontalAlignment`。
可 Slate 的箱式面板里，`SizeRule=Automatic` 的槽只分到子项的 desired 尺寸，**没有富余空间可供对齐** ——
于是整组不会居中、也不会靠右。这正是 ReactorUMG 同样栽的地方（Docs/ReactorUMG_Layout_Review.md §A.3）。

### 8.2 改法（3 处，约 40 行）

| 位置 | 改动 |
|---|---|
| `mapper.js.buildFlowContainer()`（2616-2623，紧邻 `measuredMainGaps` 那段） | 新增：当 `style.justify@@ ∈ {`center@@, `flex-end@@, `end@@, `right@@} 且容器是 VBox/HBox 时，调 `measureMainPlacement(items.map(i => i.rec), vertical)`，结果挂 `style.measuredMainPlacement` |
| 新增 `mapper.measureMainPlacement(childRecs, vertical)` | 返回 `{ leading, trailing }`：内容起点 = 父 rect 起点 + 父 border/padding；`leading = 首子项 rect 起点 − 内容起点@@；`trailing = 内容终点 − 末子项 rect 终点@@。数据只来自 snapshot rect（与 `measureMainGaps` 同源，不新增测量） |
| `mapper.boxSlot()`（488-490 组完 `Padding` 之后） | `index === 0` 时 `Padding[vertical ? 1 : 0] += leading`；`index === count - 1` 时 `Padding[vertical ? 3 : 2] += trailing` |

### 8.3 边界（必须一起实现，否则会引入新误差）

1. 容器里有任意 `flex-grow > 0` 的子项 → **不下发**（空闲空间已被 Fill 分配，再补 padding 会二次分配）；
2. `flex-wrap@@ 容器（WrapBox）→ 跳过（`InnerSlotPadding` 已经表达间距与换行）；
3. `grid@@ / `canvas@@ 容器 → 跳过；
4. 绝对定位子项先从序列里剔除，再算首/末；
5. 与 `measuredMainGaps` 互斥：`space-*` 已经用了 gap 方案，两套别同时挂；
6. `|leading| > 容器主轴尺寸 × 0.5` → `warn` 并丢弃（多半是测量错位，不是真的居中）；
7. 只对"主轴尺寸确定的容器"生效；容器本身是 auto 主轴尺寸时 `warn@@ 并跳过。

### 8.4 验收

- 新增 `Resources/Converter/test/11-justify.html`：三种 `justify-content@@（center / flex-end / space-between）各一行 + 一个含 `flex:1` 子项的对照组（验证边界 1）；
- 回归 10 页，**差异不得上升**（现状：02-absolute 0.38% / 08-effects 0.38% / 09-borders 0.40% / 07-anchors 0.43% / 04-form 1.47% / 01-flex 1.49% / 06-native 1.99% / 05-controls 2.55% / 03-dashboard 3.05%）；
- 预期 `01-flex`（1.49%）与 `03-dashboard`（3.05%）下降 0.3–1.0 个点，取决于页面里 center/end 容器的面积占比——**用 `visual_audit.py` 前后各跑一次量化，不要用估计值交差**。

### 8.5 风险与工作量

风险低：只影响 `justify-content@@ 为 center/end 的容器，且与既有 space-* 通路互斥。
工作量 0.5 天（含新测试页与 10 页回归）。

---

## 9. 预期收益与风险（C1 整体）

| 项 | 说明 |
|---|---|
| 收益上限 | 真实设计 `game-ui (1920x7081)` 现在 7.97%（`--pin-flow` 4.81%）。回灌应当 **≤ 4.81%**，且不像 `--pin-flow` 那样伤 flex 页 |
| 收益机制 | 只钉"残差可解释"的元素：源头的盒子尺寸 + 组首的偏移；不做全叶子冻结 |
| 主要风险 1 | **只在设计尺寸精确**：钉高是"用响应性换保真"，滚动/拉伸状态下会露馅（与 `--pin-flow` 同源问题，必须写进使用说明） |
| 主要风险 2 | 需要多一次编辑器渲染（每页约 +30s）；批量页要串行（CONTEXT.md 的"单页单次、独立 assets 目录"纪律不变） |
| 主要风险 3 | 配对依赖命名规则（`names.js`）。若有人改命名规则，本脚本要同步；出现 `no-widget-with-this-name` 就是信号 |
| 主要风险 4 | 行数不符（`text-line-count-mismatch`）**不会被修**——它需要字体度量/换行策略层面的修，工具只是把它指出来 |

---

## 10. 已验证记录（离线，未跑编辑器）

| 数据集 | 匹配 | 钉高 | 槽位偏移 | 跳过 | 备注 |
|---|---|---|---|---|---|
| `C:/out/wrap-probe` | 9 | 1 | 0 | 8 | 4 个盒子 Δh=0 → 工具**不凭空造修正**；3 个段落被判"行数不符"（En 3→1、Zh 2→1、Zwsp 2→1），正是这份 probe 想查的换行问题 |
| `C:/out/cjk-after` | 54 | 26 | 5 | 27 | 主要残差 Wrap 817→656（−160.5）；17 个表格单元按 `table-flow-parent` 跳过 |
| `C:/out/cjk-repro` | 54 | 25 | 5 | 28 | 与 cjk-after 基本一致（同一页的两次跑，稳定性验证） |
| `--patch-layout` | — | 8 | — | — | 26 个 pin 里 8 个是 SizeBox 可直接落地，18 个需要 mapper（第 7 节） |

复现：

```bat
"%PY%" Plugins\Html2UMG\Resources\Tools\residual_correct.py --self-test
"%PY%" Plugins\Html2UMG\Resources\Tools\residual_correct.py --layout C:\out\cjk-after\layout.json --geo C:\out\cjk-after\geo.json --report C:\out\cjk-after\residual_report.md
```

---

## 附：与 ReactorUMG 的关系

ReactorUMG 是**运行时**做这件事：布局跑完后 `GetWidgetScreenPixelSize` 读回实测，再改 `OverlaySlot` 的
`Padding`，而且是 `setTimeout` × 10 次轮询（`overlay.ts:103-136`）。
我们走**离线**：几何 dump 已经存在（`Html2UMGFidelity.cpp:51-111`），一次渲染、一次回灌、可 diff、可回归。
它那条路径我们明确不要抄（会引入运行时不确定性），但"布局是两段式的"这个判断是对的——
本工具就是把它落到我们管线上的形式。
