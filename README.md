# Codex Theme

<p align="center">
  <strong>English</strong> |
  <a href="./README.zh-CN.md">简体中文</a>
</p>

A local readability theme for the Codex desktop app. It improves Markdown rendering in chats and the file editor while slightly reducing the left sidebar scale for a denser, more balanced interface.

![Codex Theme preview](./cover.png)

## Highlights

- Styles Markdown in both chat messages and the right-side file editor
- Supports both light and dark modes and follows the appearance selected in Codex
- Gives H1–H6 distinct sizes and six-level color hierarchy
- Improves body text, bold text, links, horizontal rules, and images
- Refines blockquotes, code blocks, inline code, and tables
- Fixes unordered-list bullets and indentation for multi-digit ordered lists
- Keeps assistant responses left-aligned and improves table wrapping and scrolling in narrow windows
- Scales the left sidebar to `90%` for better information density
- Expands `Usage remaining` by default when the account menu opens while keeping it collapsible
- Supports status inspection and one-command removal

## How It Works

The theme uses the local Chrome DevTools Protocol (CDP) to inject CSS into the official Codex app:

- It does not modify the Codex application bundle
- It does not rewrite chats or Markdown files
- It connects only to `127.0.0.1:9341`
- It accepts only the verified, officially signed app and trusted Codex pages
- It applies only to the current page lifecycle and does not run as a background service

The injected stylesheet reads Codex's `data-theme` value, so switching between Light, Dark, and System appearance automatically selects the matching theme palette without running `apply` again.

## Requirements

- macOS
- The official Codex desktop app installed at `/Applications/ChatGPT.app`
- A Node.js version with built-in `WebSocket` support; currently verified with Node.js `v26.8.1`

> The theme depends on Codex's internal DOM and CSS structure. Some selectors may need to be updated after a Codex release changes the interface.

## Usage

Download or clone this repository, then run the following commands from its directory:

```sh
# Apply the theme
node codex-theme.mjs apply

# Inspect the current state
node codex-theme.mjs status

# Remove the theme
node codex-theme.mjs restore
```

When you run `apply` and CDP is not already enabled, the script asks Codex to quit normally and relaunches it with a local debugging port. Save any work in progress before running the command.

If Codex does not quit automatically, press <kbd>Command</kbd> + <kbd>Q</kbd> to quit it manually, then run this command again in your system terminal:

```sh
node codex-theme.mjs apply
```

Launch logs are written to `tmp/codex-launch-*.log` for troubleshooting.

### One-click launch from the Dock (macOS)

The repository includes an AppleScript launcher at `script/Codex Theme.applescript`. It runs `apply` without opening Terminal, so you can package it as a macOS app and keep it in the Dock.

1. Find the absolute path to Node.js:

   ```sh
   command -v node
   ```

2. Open `script/Codex Theme.applescript` and update `projectDirectory` and `nodeExecutable` to match your checkout and Node.js installation.
3. Compile and install the launcher:

   ```sh
   osacompile -o "Codex Theme.app" "script/Codex Theme.applescript"
   mv "Codex Theme.app" /Applications/
   ```

4. Open **Applications** in Finder and drag **Codex Theme** to the Dock.

Clicking the Dock icon launches Codex with the local debugging port when necessary and applies the theme. On the first launch, an already-running Codex app may quit and reopen; save any work in progress first. Launcher output is written to `tmp/codex-theme-dock-launch.log`, and failures are shown in a dialog.

This launcher is a local convenience provided by this repository, not an official Codex feature. If you move the repository or Node.js executable, update the two paths and rebuild the app.

## Status Output

The `status` command returns JSON. Common fields include:

| Field | Meaning |
| --- | --- |
| `applied` | Whether the theme stylesheet exists on the current page |
| `observerInstalled` | Whether the style-preservation observer is installed |
| `themeVariant` | The active Codex appearance detected by the theme |
| `markdownMounted` | Whether chat Markdown or a Markdown editor is currently mounted |
| `chatRoots` | Number of detected chat Markdown regions |
| `markdownEditors` | Number of detected Markdown file editors |
| `editorComputed` | Computed styles for editor text, headings, and table headers |
| `targetKind` / `targetUrl` | The Codex page target that was inspected or modified |

`applied: true` means that the theme was injected; it does not necessarily mean that Markdown content is currently open. CodeMirror virtualizes long documents, so DOM node counts do not represent the total number of elements in a file.

## Known Limitations

- Light and dark palettes are supported; custom or future Codex appearance modes may require additional color mappings
- You need to run `apply` again after restarting the app, reloading the renderer, or opening a new window
- In the Markdown file editor, the current Codex DOM exposes H5 and H6 with the same class as H4, so these headings may share a color; chat Markdown can still distinguish H1–H6
- The script currently uses a fixed application path and local port, so it does not support Windows, Linux, or custom installation locations

## Customization

The theme styles live in `themeCss` and `editorCss` inside `codex-theme.mjs`. Dark-mode variables are defined under `:root, [data-theme="dark"]`, while light-mode overrides are defined under `[data-theme="light"]`. You can customize the color variables, font sizes, content width, and sidebar scale:

```js
const SCALE = 0.90;

// Light and dark colors and typography variables are defined in themeCss
```

Run `node codex-theme.mjs apply` again after making changes.

## Feedback and Contributions

If a Codex update breaks part of the theme, please open an Issue and include:

- Your Codex app version
- Your Node.js version
- The output of `node codex-theme.mjs status`
- A screenshot and a reproducible Markdown example

Pull Requests improving selectors, compatibility, or visual details are also welcome.

## Disclaimer

This is an unofficial community theme and is not affiliated with or endorsed by OpenAI. Evaluate the risks of enabling a local debugging port and use it only in a trusted local environment.
