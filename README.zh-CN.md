# Codex Theme

<p align="center">
  <a href="./README.md">English</a> |
  <strong>简体中文</strong>
</p>

一套面向 Codex 桌面端的本地可读性主题，重点增强聊天区与 Markdown 文件编辑器的排版表现，并适当缩小左侧边栏字号，让信息密度与阅读体验更平衡。

![Codex Theme 效果预览](./cover.png)

## 功能亮点

- 同时覆盖聊天消息中的 Markdown 与右侧 Markdown 文件编辑器
- 同时兼容浅色与深色模式，并跟随 Codex 中选择的外观
- 为 H1–H6 提供清晰的字号层级和六级配色
- 优化正文、粗体、链接、分隔线与图片的显示效果
- 改善引用块、代码块、行内代码和表格的可读性
- 修正无序列表圆点与多位数有序列表的缩进、换行表现
- 让助手回复保持左对齐，并改善窄窗口下表格的滚动与换行
- 将左侧边栏缩放为 `90%`，在不改变整体布局的前提下提升信息密度
- 打开账户菜单时默认展开 `Usage remaining`，仍可点击折叠
- 支持随时查看状态或撤销主题

## 工作方式

主题通过本机 Chrome DevTools Protocol（CDP）向官方 Codex 应用注入 CSS：

- 不修改 Codex 应用安装包
- 不改写聊天内容或 Markdown 文件
- 只连接本机 `127.0.0.1:9341`
- 仅接受已验证的官方签名应用与 Codex 页面
- 主题只在当前页面生命周期内生效，不会常驻后台

注入的样式表会读取 Codex 的 `data-theme` 值。在浅色、深色和跟随系统三种外观之间切换时，会自动采用对应配色，无需重新运行 `apply`。

## 环境要求

- macOS
- 官方 Codex 桌面应用，安装于 `/Applications/ChatGPT.app`
- 支持内置 `WebSocket` 的 Node.js；当前已验证版本为 Node.js `v26.8.1`

> 主题依赖 Codex 当前的内部 DOM 与 CSS 结构。Codex 更新后，如果界面结构发生变化，部分样式可能需要同步调整。

## 使用方法

下载或克隆本仓库，在仓库目录中运行：

```sh
# 应用主题
node codex-theme.mjs apply

# 查看当前状态
node codex-theme.mjs status

# 撤销主题
node codex-theme.mjs restore
```

首次执行 `apply` 时，如果 Codex 尚未启用 CDP，脚本会请求正常退出应用，再使用本地调试端口重新启动。运行前请先保存正在编辑的内容。

如果 Codex 未能自动退出，请使用 <kbd>Command</kbd> + <kbd>Q</kbd> 手动退出，然后在系统终端中重新执行：

```sh
node codex-theme.mjs apply
```

启动日志会写入 `tmp/codex-launch-*.log`，便于排查启动问题。

### 从 Dock 一键启动（macOS）

仓库提供了 AppleScript 启动器 `script/Codex Theme.applescript`。它可以在不打开终端的情况下执行 `apply`，因此可以打包成 macOS App 并固定到 Dock。

1. 查询 Node.js 的绝对路径：

   ```sh
   command -v node
   ```

2. 打开 `script/Codex Theme.applescript`，根据自己的仓库位置和 Node.js 安装位置修改 `projectDirectory` 与 `nodeExecutable`。
3. 编译并安装启动器：

   ```sh
   osacompile -o "Codex Theme.app" "script/Codex Theme.applescript"
   mv "Codex Theme.app" /Applications/
   ```

4. 在 Finder 中打开“应用程序”，将 **Codex Theme** 拖到 Dock。

点击 Dock 图标后，启动器会在需要时使用本地调试端口启动 Codex，并自动应用主题。首次启动时，如果 Codex 已在运行，应用可能会退出后重新打开，请先保存正在编辑的内容。启动器日志写入 `tmp/codex-theme-dock-launch.log`；执行失败时会弹出错误提示。

此启动器是本仓库提供的本地便捷工具，不是 Codex 官方功能。如果移动了仓库或 Node.js 可执行文件，需要更新上述两个路径并重新编译 App。

## 状态说明

`status` 命令会输出 JSON，其中常用字段包括：

| 字段 | 含义 |
| --- | --- |
| `applied` | 当前页面是否存在主题样式表 |
| `observerInstalled` | 样式保留观察器是否已安装 |
| `themeVariant` | 主题检测到的当前 Codex 外观模式 |
| `markdownMounted` | 当前页面是否已挂载聊天 Markdown 或 Markdown 编辑器 |
| `chatRoots` | 当前检测到的聊天 Markdown 区域数量 |
| `markdownEditors` | 当前检测到的 Markdown 文件编辑器数量 |
| `editorComputed` | 编辑器正文、标题与表头的实际计算样式 |
| `targetKind` / `targetUrl` | 实际操作的 Codex 页面目标 |

`applied: true` 仅表示主题已经注入，不代表当前页面一定打开了 Markdown 内容。长文档由 CodeMirror 虚拟化渲染，因此节点统计也不等同于整份文档的元素总数。

## 已知限制

- 已支持浅色与深色配色；Codex 将来新增或自定义的外观模式可能需要补充颜色映射
- 应用重启、页面渲染进程重载或新增窗口后，需要重新运行 `apply`
- Markdown 文件编辑器中，Codex 当前会将 H5、H6 暴露为与 H4 相同的 DOM 类，因此三者可能显示为相同颜色；聊天 Markdown 仍可区分 H1–H6
- 脚本目前使用固定应用路径和本地端口，不适用于 Windows、Linux 或自定义安装位置

## 自定义主题

主题样式集中在 `codex-theme.mjs` 的 `themeCss` 与 `editorCss` 中。深色变量位于 `:root, [data-theme="dark"]`，浅色覆盖变量位于 `[data-theme="light"]`。你可以修改颜色变量、字号、内容宽度以及边栏缩放比例：

```js
const SCALE = 0.90;

// 浅色、深色配色与排版变量均位于 themeCss 中
```

修改后重新运行 `node codex-theme.mjs apply` 即可看到效果。

## 反馈与贡献

如果 Codex 更新后出现样式失效，欢迎提交 Issue，并附上：

- Codex 应用版本
- Node.js 版本
- `node codex-theme.mjs status` 的输出
- 问题截图与可复现的 Markdown 示例

也欢迎通过 Pull Request 改进选择器、兼容性或视觉细节。

## 免责声明

这是一个非官方的社区主题，与 OpenAI 无隶属或背书关系。请自行评估启用本地调试端口的风险，并仅在可信的本机环境中使用。
