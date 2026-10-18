[English](README.md) | [简体中文](README.zh-CN.md)

# Papper Tools

**在 VS Code 中写作、预览和调整 Papper 论文。**

Papper Tools 将引用导航、公式预览、Word 排版设置和引文样式搜索放进 Markdown 编辑器。它是 [Papper](https://github.com/cesaryuan/papper) 的配套 VS Code 扩展，让你在生成 DOCX 之前更方便地修改和检查稿件。

界面跟随 VS Code 的显示语言，目前提供英文默认文案和简体中文翻译，命令统一使用 `Papper Tools:` 前缀。可通过 **Configure Display Language（配置显示语言）** 切换语言，并按提示重启 VS Code；本文中的命令示例使用英文名称。

[安装并配合 AI 使用](#安装并配合-ai-使用) · [写作工具](#写作工具) · [动手试一试](#动手试一试) · [文档导航](#文档导航)

## 安装并配合 AI 使用

从 [VS Code Marketplace 安装 Papper Tools](https://marketplace.visualstudio.com/items?itemName=cesaryuan.pandoc-manuscript-tools)。需要构建、HTML 预览和实际引用文本提示时，先安装 [uv](https://docs.astral.sh/uv/getting-started/installation/)，再安装 Papper：

```bash
uv tool install papper
```

在 VS Code 中打开稿件所在文件夹。在 Codex、Claude Code、Workbuddy 等 AI Agent 中，可以直接说：

- “请用 Papper 帮我把这个 DOCX 转成 Markdown。”
- “请将这个 MD 文件中的交叉引用、图片、表格、参考文献转换成 Papper 的格式。”
- “请帮我把这个 MD 用 Papper 转成 DOCX。”

AI 修改源文件后，你可以用扩展的导航、预览和排版工具检查结果。自己新建论文时，运行：

```bash
papper init my-paper
cd my-paper
```

用 VS Code 打开该文件夹，编辑 `manuscript.md` 即可。已经安装 uv 时，也可以在命令面板运行 **Papper Tools: Install or Update Papper** 安装或更新 Papper。

![Papper Tools 工作流示意：引用导航、样式设置和稿件预览。](docs/assets/papper-tools-workflow.png)

*上图为 AI 生成的工作流示意图，用于说明工具的用途，并非实际编辑器截图。*

## 写作工具

| 写作时要做的事 | 扩展提供的支持 |
| --- | --- |
| 查找图、表、公式和章节 | 跳转到标签、查找引用、输入 `@` 补全，并提示未定义引用和重复标签 |
| 检查引文与引用文字 | 在源文件旁显示 Papper 实际生成的编号和引文文本，包括合并引文 |
| 调整 Word 排版 | 在 **Papper Tools: Open Settings** 中修改 MathType、字体、表格、图片、页面和交叉引用，选择当前稿件、项目或审稿回复的设置 |
| 选择期刊参考文献格式 | 搜索 Zotero 官方与中文社区样式，对比正文引文和文后参考文献预览，再应用本地 CSL 文件 |
| 查看公式与图片 | 悬停预览公式和本地 SVG、EMF、WMF 图片；按网格、瀑布流或文件夹浏览图片目录 |
| 检查返修内容 | 折叠修订属性和行号引用摘录，从 `reply_to_reviewers.md` 跳转到工作区根目录 `manuscript.md` 的标签 |

配置键和值、表格属性以及 `[]{t="..."}` 插入语法也有补全和悬停说明。标题、正文、图片和表格上的样式操作，可以直接带你修改对应的 Word 格式。

## 动手试一试

将下面的内容保存为 Markdown 文件：

```markdown
# Methods {#sec:methods}

We minimize the objective in [@eq:loss].

$$
L = \frac{1}{N}\sum_{i=1}^{N}(y_i-\hat{y}_i)^2
$$ {#eq:loss}
```

- 输入 `@` 查看引用补全，或在 `@eq:loss` 上执行“转到定义”。
- 悬停在公式上查看渲染效果，打开大纲浏览章节和带标签的内容。
- 悬停在标题或段落上使用样式操作，或者直接运行 **Papper Tools: Open Settings**。
- 运行 **Papper Tools: Set Citation Style**，搜索期刊并比较引文样式。

Papper 项目中的 `style.yml` 保存可复用的排版设置，稿件 YAML 头部可以单独覆盖当前稿件的配置。设置窗口会将修改写回这些可编辑的文件。

## 预览和生成 Word

在命令面板中运行以下命令，也可以使用已保存 Markdown 文件上方的对应按钮：

| 命令 | 作用 |
| --- | --- |
| **Papper Tools: Preview Markdown (Papper HTML)** | 在侧边预览当前稿件，包括尚未保存的修改，并跟随源码导航 |
| **Papper Tools: Build DOCX and Open in Word** | 保存源文件、生成新的临时 DOCX，并在 Word 中打开 |
| **Papper Tools: Open Settings** | 修改排版和引用配置 |
| **Papper Tools: Set Citation Style** | 打开带期刊搜索与预览的参考文献设置 |

每次 Word 构建使用独立的临时文件，需要长期保留时，请在 Word 中“另存为”。要生成项目目录中的正式输出，可以运行：

```bash
papper build docx
```

HTML 方便写作时检查内容，最终分页请在 Word 中确认。[Papper 的真实 Word 示例](https://github.com/cesaryuan/papper/blob/main/README.zh-CN.md#实际输出)展示了主稿和审稿回复，也包含可编辑的 MathType 公式。

## 其他编辑辅助

右键点击图片文件夹，选择 **Papper Tools: View Images** 即可浏览其中的图片。SVG、EMF 和 WMF 文件也有专门的预览。

悬停英文段落或代码注释时可以查看翻译。翻译使用 Google Translate 或 Microsoft Translator；不需要时，可在设置中关闭 `pandocManuscriptTools.enableParagraphHoverTranslation`。

## 文档导航

| 想了解的内容 | 入口 |
| --- | --- |
| 编辑、配置提示、扩展设置和常见问题 | [编辑器使用指南](docs/editor-guide.md) |
| Papper 写作语法与 Word 排版 | [Papper 文档](https://github.com/cesaryuan/papper#documentation) |
| 扩展源码开发、检查和打包 | [开发指南](DEVELOPMENT.md) |
| 扫描、配置定义和预览的实现 | [实现说明](docs/editor-internals.md) |
| 版本变化 | [更新日志](CHANGELOG.md) |

遇到问题时，请[提交 issue](https://github.com/cesaryuan/vscode-pandoc-manuscript-tools/issues)，附扩展版本、相关的 Papper 版本和最小示例。构建与预览日志位于 **查看 → 输出 → Papper Tools**。

采用 [GPL-3.0-or-later 许可证](LICENSE)。
