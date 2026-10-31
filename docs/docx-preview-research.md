# DOCX 分页预览可行性调研

调研日期：2026-10-30。范围：当前扩展、相邻 Papper Rust 工作区、
`sverrejb/docxide-pdf` 和 PDF.js。以下结论来自接入前的调研与隔离测速。

后续实现进度：已接入当前编辑缓冲区 → Papper 常驻 DOCX → 服务内置 Docxide 库 →
PDF.js，支持编辑防抖刷新、手动/保存后刷新、可见页绘制、缩放和位置保留。
使用方法见 [Editor guide](editor-guide.md#docx-builds)，内部机制见
[Editor implementation notes](editor-internals.md#rendering-translation-and-tool-installation)。
预览强制关闭原生 Word 交叉引用字段，保留 SVG PNG 备用图。启用 MathType 时，
预览内部使用 Rust 轮廓 WMF，正式导出仍遵循项目配置；关闭 MathType 时保留原生公式。
下文保留接入前的研究数据，
其中 CLI 安装方式和逐次进程启动耗时不代表当前实现。

## 1. 判断与建议

建议增加一个可选的 DOCX 分页预览入口，采用下面的链路：

```mermaid
flowchart LR
    A[当前 Markdown 编辑缓冲区] --> B[Papper 常驻 DOCX 构建]
    B --> C[完整 DOCX]
    C --> D[Docxide 原生转换]
    D --> E[完整 PDF]
    E --> F[Webview 中的 PDF.js]
    F --> G[只绘制可见页及邻页]
```

这条路线能让预览使用最终 DOCX 的样式、页眉页脚、表格、图片和公式数据。
本机实测表明，Docxide 转换和 PDF.js 首屏显示已具备交互预览的速度基础。
连续编辑是否能接近现有 HTML 体验，主要取决于 DOCX 构建端优化后的实际耗时。

当前还不能将它描述为与 Word 最终分页完全一致。已有同输入对照确认了换行、目录、字段、
表格和分页成组差异。产品名称宜使用“DOCX 分页预览（实验性）”，保留 HTML 快速预览与
在 Word 中检查最终文档的入口。

## 2. Docxide 究竟输出什么

本次核对的是 **docxide-pdf 0.20.1**，固定提交
[`c2fa4fa461d987653dc717d7327096e57afb4686`](https://github.com/sverrejb/docxide-pdf/tree/c2fa4fa461d987653dc717d7327096e57afb4686)。
调研中执行 `git ls-remote ... HEAD`，当时上游 HEAD 也是这个提交。

| 能力 | 当前结论 | 对本项目的影响 |
| --- | --- | --- |
| DOCX → PDF 文件 | 支持 | 可作为原型入口 |
| DOCX 字节 → PDF 字节 | 支持，公开函数 `convert_docx_bytes_to_pdf_bytes` | 后续可直接在 Papper 原生服务中集成 |
| DOCX → HTML | 没有公开输出接口 | 无法直接替换现有 HTML 内容生成器 |
| DOCX → PNG/JPEG/SVG 页面 | 没有公开输出接口 | 图片需要先生成 PDF，再用其他引擎栅格化 |
| 获取指定页、指定页数或页面完成回调 | 没有公开接口 | 不能直接请求“只排版前 3 页” |
| 修改段落后增量重排 | 没有公开接口 | 每次输入仍重新解析和排版 |
| 浏览器 JS/WASM SDK | 未发现现成 SDK 或浏览器字体接入契约 | 优先在 Papper 的原生 Rust 侧运行 |

上述输出结论来自固定版本的[公开库接口](https://github.com/sverrejb/docxide-pdf/blob/c2fa4fa461d987653dc717d7327096e57afb4686/src/lib.rs)
和 [CLI 实现](https://github.com/sverrejb/docxide-pdf/blob/c2fa4fa461d987653dc717d7327096e57afb4686/src/main.rs)。
`lib.rs` 中关于 wasm 的注释说明字节接口的用途，不能据此推断已有可直接使用的浏览器包。

PDF.js 可以将 PDF 页绘制到 HTML canvas，并添加文字层和链接层。这是在网页里展示 PDF，
不是把 DOCX 转成可重排的语义 HTML。保留 PDF 的固定坐标更适合分页预览。

当前 CLI 还会为已存在的输出自动增加 `(2)`、`(3)` 等后缀。
实时预览原型应使用唯一的版本文件名；正式服务宜使用内存接口和受控的缓存发布，
不能假设反复运行同一 CLI 命令会覆盖同一个 PDF。

## 3. 本次性能实测

### 3.1 环境与统计边界

- Windows 11 专业版，10.0.26300，x64；Intel Core i7-13700KF，24 个逻辑处理器。
- Docxide 为已有的 Cargo **Release** 安装，版本及提交如上。
- Docxide 二进制 SHA-256：`12ab451be691e6c2784383cec9fd5fb1017e1fa583f4c1c6e16eb41aaae2720d`。
- PDF.js **6.4.299**；Playwright 控制的 Chromium **156.0.8078.49**。
- DOCX 转换每次新建进程，包含进程创建、读取 DOCX、PDF 转换及写出；没有测常驻 Docxide。
- 字体磁盘索引及操作系统文件缓存已热。每个输入先预热一次，随后小文档记录 7 次、长文档记录 5 次。
- 全部正式样本保留。小样本报告中位数和最小/最大值，不将最大值包装成可靠的 p95。
- 不同阶段分别测量，未完成实际 VS Code Webview 中从按键到像素的端到端测速。

### 3.2 DOCX → PDF

前六项直接读取 Papper 已有视觉评估语料的 DOCX，没有重新生成或修改原件。

| 输入 | Docxide 页数 | 中位数 | 最小–最大 |
| --- | ---: | ---: | ---: |
| 英文模板 `template` | 9 | 197.7 ms | 197.0–200.7 ms |
| 中文模板 `template_cn` | 9 | 229.5 ms | 222.7–235.2 ms |
| 审稿回复 `reply` | 2 | 54.2 ms | 52.3–68.7 ms |
| 原生交叉引用 `native_crossrefs` | 3 | 70.4 ms | 69.1–80.9 ms |
| 目录与分节 `docx_directives` | 5 | 75.9 ms | 71.7–82.8 ms |
| 图片裁剪 `image_crops` | 1 | 54.1 ms | 50.6–61.1 ms |
| 合成中英混排纯文字 | 50 | 82.4 ms | 78.8–90.5 ms |
| 合成中英混排纯文字 | 200 | 156.2 ms | 154.7–159.1 ms |

长文档使用真实 reference DOCX 包、Times New Roman/SimSun、每页 12 个短段落及显式分页符，
不含图表、公式、脚注或复杂跨页表格。其页数已经用生成 PDF 验证。
这些数据证明已测纯文字文档的页数增长可控，不能外推为“200 页真实论文也是 156 ms”。

转换器自身日志提供了进一步线索：英文模板 `fonts/images/layout/assembly` 阶段中位数约为
10.3/132.4/4.9/3.7 ms，中文模板约为 36.5/133.6/4.6/2.5 ms。
当前模板的图片处理成本比正文排版明显高。阶段日志不覆盖全部外层开销，不能简单相加作为完整耗时。

这也说明上游 README 的“典型转换小于 100 ms”不适合直接当作本项目性能承诺。

### 3.3 完整 PDF → 浏览器首个 canvas

通过本地 HTTP 加载完整 PDF 字节，再创建 PDF.js 文档并绘制目标页。
每个文档预热一次，随后记录 5 次；每次只画第 1、2、最后一页。
CSS scale 为 1.5，输出像素倍率为 2，单页 canvas 为 1786 × 2526。

| 输入 | 从请求 PDF 到首个 canvas 完成，中位数 | 最小–最大 | 第一页绘制中位数 | 最后一页绘制中位数 |
| --- | ---: | ---: | ---: | ---: |
| 英文模板，9 页 | 115.6 ms | 115.1–120.9 ms | 37.1 ms | 18.7 ms |
| 中文模板，9 页 | 126.2 ms | 117.3–162.2 ms | 49.2 ms | 20.2 ms |
| 合成纯文字，50 页 | 109.6 ms | 102.1–111.4 ms | 26.4 ms | 6.7 ms |
| 合成纯文字，200 页 | 102.0 ms | 95.2–113.2 ms | 22.3 ms | 7.3 ms |

200 页文档只保留 3 个 canvas，197 页未绘制；直接获取最后一页成功。
后页数字是在同一文档已绘制前两页后得到，包含字体等资源复用，不能当作随机冷页延迟。

这些是浏览器可见页绘制能力的验证，不是完整滚动虚拟列表的产品实现。
不包含文字层、链接层、源码定位、VS Code 资源传输、CSP、最终屏幕合成或用户滚动测试。
PDF.js JS 模块加载在计时前完成，每轮重新创建文档/加载任务；这些小文件完整读取，未测试 Range 请求。
运行中没有 PDF.js 错误，但记录到 `TT: undefined function: 21` 字体警告；未做浏览器像素等价验收。

### 3.4 Markdown → DOCX

最初采样使用已安装的 Papper **0.11.6**。随后核对 `METADATA` 和 `direct_url.json`，
确认它是当前工作区的 editable 开发安装；`papper-dev build_editable` 使用 Debug 可执行文件。
因此以下数据只代表开发安装，不代表发布性能：

| 输入 | 修改正文后完整 CLI 构建 DOCX，中位数 | 最小–最大 |
| --- | ---: | ---: |
| 英文模板副本 | 1709.2 ms | 1693.8–1718.0 ms |
| 中文模板副本 | 1687.2 ms | 1672.8–1693.7 ms |

每种输入预热 1 次、正式 5 次，每次附加不同正文，引用和资源不变，使用 `--no-mathtype`。
输入副本和输出都在隔离目录，资源路径指回原模板目录；没有更改原稿。
开发安装二进制 SHA-256 为 `7b33ff5808fd6d4a8dae2fde9bfcb34d0ba83f74ee59375abb11a2602949e0ef`。

随后执行 `cargo build --locked --release -p papper-cli`，使用当前源码 **0.11.7** 做了独立补测。
构建在计时前完成，补测期间没有同时编译。每种输入同样预热 1 次、正式记录 5 次：

| 输入 | 源码 Release 完整 DOCX CLI，中位数 | 最小–最大 |
| --- | ---: | ---: |
| 英文模板副本 | 1495.4 ms | 1482.0–1520.1 ms |
| 中文模板副本 | 1461.8 ms | 1451.9–1470.1 ms |

该制品使用工作区资源和已构建的 Pandoc Worker，不是完整发布 wheel 的安装基准。
其二进制 SHA-256 为 `38fb3bc4315ec1c0ff7a61be6438b7859b860a2c4a928e80d7879ee9c5fce551`。
两组 Papper 的版本和构建方式不同，不能把两表差额严格解释为 Debug → Release 的优化收益。
Release 的第一个英文预热样本为 2343.5 ms，也完整保留；没有将它当作可靠的冷启动统计。

按英文模板的阶段中位数计算，现有 350 ms 防抖 + 1495.4 ms DOCX 构建 +
197.7 ms Docxide 转换 + 115.6 ms PDF.js 首屏，预算约 **2.16 秒**；中文模板约 **2.17 秒**。
这是分别采样后的延迟预算估算，不是同一请求的端到端观测，也不能由此估算端到端尾延迟。
目前一次性 DOCX 构建明显比后两段更慢，首版连续预览需要优先处理它。

## 4. 长 DOCX 的动态渲染能做到哪一层

需要区分两个不同的需求。

**浏览器只绘制当前可见的几页：可以。** PDF.js 提供 `getPage(n)` 和页级 `render()`。
其官方查看器已经有可见页优先队列、渲染取消和页面清理机制；官方 FAQ 也推荐只创建和绘制可见页。
本次 200 页抽页测速验证了基本能力。
参考 [PDF.js 示例](https://mozilla.github.io/pdf.js/examples/)、
[可见页队列](https://github.com/mozilla/pdf.js/blob/master/web/pdf_rendering_queue.js) 和
[内存说明](https://github.com/mozilla/pdf.js/wiki/Frequently-Asked-Questions)。

实现时建议显示当前页及前后 1–2 页，保留有界 LRU，离开窗口的页面取消任务并释放 canvas 像素。
页面占位尺寸仍然保留，避免滚动条跳变；混合横竖版和不同纸张尺寸需要分别记录页面几何。
大量页数时还应限制文字层和页面 DOM，不能只隐藏已经绘制好的 canvas。

本次尺寸的单个 RGBA canvas 原始像素约 17.21 MiB；200 页同时保留约 3.36 GiB，
还未包含文字层、解码图片和 PDF.js 内部缓存。因此动态绘制是必要的。

**Docxide 只排版前几页，滚动时继续排版后面：当前不能直接做到。**
公开接口返回完整 PDF 字节，内部渲染/组装并没有对外开放分页会话。
正文中的 PAGE/NUMPAGES 字段还可能触发第二次渲染。
参考[固定版本渲染实现](https://github.com/sverrejb/docxide-pdf/blob/c2fa4fa461d987653dc717d7327096e57afb4686/src/pdf/mod.rs)。

DOCX 是流式排版格式，任意页通常依赖前文的行高、分节、脚注、表格、编号和浮动对象状态。
前面加一行可能使后面全部页码移动；只构建“当前 Markdown 章节”会改变最终分页。
完整 PDF 的 Range 下载或流式网络传输，也不能自动把 Docxide 变成增量排版引擎。

如果以后确实遇到完整排版瓶颈，需要上游支持布局会话、分页检查点、脏区域传播、
页级绘制列表及全局字段重新收敛。这是另一项引擎工程，首版不应依赖它。

## 5. 如何将现有 HTML 优化经验用于 DOCX

### 5.1 现有代码的可复用部分

扩展的 `src/papperMarkdownPreview/controller.ts` 已有 350 ms 防抖、串行构建、合并最新请求、
版本校验和过期结果丢弃；`src/papperHtmlServer.ts` 通过 keep-alive HTTP 直接发送未保存文本。

Papper 的 `crates/papper-server/src/service.rs` 已有依赖摘要、元数据准备、结果缓存及常驻 Worker。
`scripts/pandoc-server/Papper/Citeproc.hs` 缓存引文样式、文献解析和引文求值，
正文变化但引文序列不变时可以复用求值结果，并应用到新文档。

当前 DOCX 构建则在 `crates/papper-cli/src/commands.rs::build_other` 中新建临时工作目录，
准备 reference、执行 `PandocCli::run`，然后调用 `finalize_docx`。
`--start-server` 目前只针对 HTML，现有 `/convert/raw` 的返回契约也是 `text/html`。
不能只给现有 HTTP 请求添加一个输出扩展名，就认为 DOCX 已经获得相同缓存与后处理。

### 5.2 优化优先级

| 优先级 | 工作 | 预期用途与约束 |
| --- | --- | --- |
| P0 | 给 DOCX 增加阶段计时 | 分开测配置、reference、Worker、滤镜、资源、ZIP/后处理、MathType、Docxide、传输、首屏，先找真实瓶颈 |
| P0 | 新增接受未保存文本的 DOCX/PDF 服务能力 | 复用项目生命周期和 keep-alive；不要每次编辑重新运行完整 CLI |
| P0 | 复用常驻 Pandoc Worker 和引文缓存 | 当前 Worker 基础具备通用转换能力，但 DOCX 默认参数、滤镜、环境变量和二进制输出需单独接入 |
| P0 | 复用完整 DOCX 后处理 | 保持样式、原生字段、题注、页眉页脚和最终包行为；不能把跳过处理当作等价优化 |
| P1 | 缓存有效 reference DOCX | 以模板字节、有效样式、页边距、语言和运行时版本为键；只改正文时复用 |
| P1 | 缓存项目依赖和最终结果 | 图片、Bib/CSL、滤镜、reference、字体、样式和 Papper/Docxide 版本变化必须失效 |
| P1 | 直接链接 Docxide 库或使用常驻转换子进程 | 省掉每次 CLI 启动；其 `OnceLock` 字体索引可复用，但不等于布局/图片/字体子集全部增量复用 |
| P1 | 每次只发布最新成功版本 | 旧请求在可中止阶段取消，否则丢弃结果；避免队列堆积及旧 PDF 覆盖新 PDF |
| P2 | 对稳定图片/字体解析做深层复用 | 目前模板图片阶段约 133 ms，可能有价值，但通常需要上游接口或受控补丁 |
| P2 | 优化 DOCX ZIP 和内存流转 | 先测量；现有 `finalize_docx` 已将后处理和 MathType 注入合并到同一个包，不能重复声称会消除已有中间步骤 |

Docxide 已有字体磁盘索引和进程内 `OnceLock`，见
[字体发现源码](https://github.com/sverrejb/docxide-pdf/blob/c2fa4fa461d987653dc717d7327096e57afb4686/src/fonts/discovery.rs)。
本次热磁盘索引读取约 1–2 ms，单靠常驻字体索引不太可能解释数量级提速。
字体列表在进程内长期固定时，安装字体或更换字体目录后还需明确重启/失效策略。

MathType 必须单独考虑。现有视觉语料主要使用原生 OMML，本次构建计时也禁用了 MathType。
如果最终导出使用 MathType，预览也应覆盖其真实 OLE 预览图、字体和尺寸；
不能无提示改用 OMML 后仍承诺版面一致。可另设明确标注的快速模式，并测其差异。

## 6. 与 Word 的一致性限制

Papper 已有比通用上游示例更相关的同输入 Word/Docxide 评估，见
[现有评估记录](../../papper/docs/DOCX_RENDERER_EVALUATION.md)。
它记录了 25 个完整案例：Word 合计 70 页，Docxide 67 页；页数差异来自目录案例。
两个后端各自的视觉基线通过，只说明各自产物稳定，不说明它们等价。

当前特别影响预览承诺的差异包括：

- 英文模板一处正文换行 Word 为 2 行、Docxide 为 3 行，后续内容位置会连带变化。
- 目录生成不完整：目录案例 Word 为 8 页、Docxide 为 5 页，后者保留更新字段占位缓存。
- 章节 STYLEREF 与 SEQ 等字段存在结果差异，可能让题注与正文引用显示不一致。
- `keepNext` 和嵌套表格分页可能将标题或成组子图拆开。
- 表格样式继承涉及居中、合并单元格垂直对齐等差异；部分段落边框线型也不同。

其中八类问题已有[上游 issue #145](https://github.com/sverrejb/docxide-pdf/issues/145)和独立复现输入。
此次沿用已有评估记录，没有重新导出 Word，也没有操作用户打开的 Office 文档。

字体一致性仍然重要。此次本机转换日志出现 Aptos → Calibri 替换，性能结果对应这个实际字体环境。
需要固定或清楚报告字体来源，再用同一字体环境判断差异；这也不意味着现有换行/字段问题全部由缺字体造成。

## 7. 现有编辑体验的额外成本

HTML 预览已有双向滚动和点击回源码。换成 PDF 后，页面画出来不等于这些功能自动保留。

- **刷新定位**：记录稳定内容锚点和页内位置。前文编辑可能使页码变化，仅恢复旧页码或滚动百分比不够稳定。
- **点击回源码**：PDF 文字层提供的是视觉文字和坐标，没有 Markdown 源码行号。
  首版可以只做页导航；后续增加 source-map sidecar，关联 Markdown 块、DOCX 稳定标识与 PDF 页坐标。
  文本匹配只能做退化方案，重复段落、公式、表格和引文容易歧义。
- **文字选择与链接**：需要 PDF.js 文字层和链接层。整页 PNG 更容易展示，但会增加这些交互能力的实现成本。
- **刷新与失败恢复**：保留上一份成功预览，后台显示构建状态；用 revision 关联 PDF、页尺寸和定位数据，防止混用不同版本。
- **运行位置**：扩展为 workspace 扩展；Remote SSH/WSL 中字体和 Docxide 运行环境在远端。
  不应假设远端生成 PDF 与本机 Word 使用同一套字体，也不应让 Webview 直接依赖远端 localhost。

正式集成还需把 PDF.js 主模块、Worker、字体/CMap/WASM 等资源打包到扩展，并验证 Webview 的
CSP、Worker 加载和二进制资源传输。当前扩展包未包含 PDF.js，本次只安装到忽略的研究目录。

## 8. 分阶段落地与验收建议

1. **独立的分页预览原型**：手动或保存后生成真实 DOCX → Docxide PDF → Webview PDF.js，
   实现可见页绘制、有界内存、缩放和刷新后保留位置。先验证真实稿件保真度和 Webview 成本。
2. **常驻 DOCX 构建**：在 Papper 内抽出与正式 CLI 共用的构建管线，为未保存文本提供服务接口，
   补齐 DOCX 依赖缓存、reference 缓存和引文复用，再打开连续编辑刷新。
3. **同步与扩展验证**：加入稳定源码映射，验证 MathType、长图文稿、跨页表格和远端环境，
   再决定何时从实验入口提升为常用预览。

建议把性能目标先定义为待验证的产品指标：普通 10–30 页真实稿件在服务已热、仅正文修改时，
停止输入后 0.5–1 秒出现新页面；冷启动单列；滚动不因后台排版长时间阻塞；
100–200 页图文稿的 canvas 和文字层内存有界。这些是建议验收线，不是本次已达到的保证。

更严格地要求与 Word 最终目录、字段和分页完全一致时，仍需要 Word 导出或等待上游差异修复。
目前推荐的定位是：HTML 服务于快速写作，Docxide 服务于更接近 DOCX 的分页检查，Word 服务于最终确认。

## 9. 可复核材料

所有测速材料都在相邻 Papper 仓库的忽略目录：
`output/docx-preview-research-20261030/`。

- `benchmark.py`：输入生成、Docxide 转换、开发安装 DOCX 构建计时。
- `results.json`：原始样本、stderr 阶段日志、输入哈希及工具哈希。
- `build-release-benchmark.py`、`release-results.json`：源码 Release 的独立构建测速及工具身份。
- `browser.html`、`browser-run.js`、`serve.py`：PDF.js 抽页绘制和浏览器计时入口。
- `browser-results.json`：每次浏览器采样及 Chromium 版本。
- `browser-console.txt`：浏览器控制台记录，包括字体警告。
- `text-50.docx`、`text-200.docx`、各次 PDF：长文档输入及实测产物。

本次先按仓库要求查询 Context7；未找到匹配的 Docxide 文档条目，因此以固定提交源码为依据。
PDF.js 使用 Context7 返回的 `/mozilla/pdf.js` 文档，并核对 Mozilla 官方示例与 FAQ。
