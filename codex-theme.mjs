#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { mkdirSync, openSync, closeSync, readFileSync } from "node:fs";
import { promisify } from "node:util";
import { codexLaunchEnv } from "./script/codex-launch-env.mjs";

const execFileAsync = promisify(execFile);
const APP_PATH = "/Applications/ChatGPT.app";
const APP_EXECUTABLE = `${APP_PATH}/Contents/MacOS/ChatGPT`;
const BUNDLE_ID = "com.openai.codex";
const HOST = "127.0.0.1";
const PORT = 9341;
const STYLE_ID = "local-codex-readable-theme";
const SCALE = 0.90;
const THEME_NAME = "readable";
const command = process.argv[2] ?? "status";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function run(file, args) {
  const { stdout = "" } = await execFileAsync(file, args, {
    maxBuffer: 2 * 1024 * 1024,
    timeout: 15_000,
    env: codexLaunchEnv(),
  });
  return stdout.trim();
}

async function sidebarWallpaperDataUrl() {
  try {
    const source = await run("/usr/bin/osascript", [
      "-e", 'tell application "System Events" to get picture of current desktop',
    ]);
    if (!source) return "none";
    const output = new URL("./tmp/sidebar-wallpaper.jpg", import.meta.url);
    await run("/usr/bin/sips", [
      // Deliberately downsample the wallpaper so the sidebar keeps only broad
      // color fields instead of revealing recognizable image details.
      "-Z", "120", "-s", "format", "jpeg", "-s", "formatOptions", "68",
      source, "--out", output.pathname,
    ]);
    return `url("data:image/jpeg;base64,${readFileSync(output).toString("base64")}")`;
  } catch {
    return "none";
  }
}

async function verifyOfficialBundle() {
  const plist = `${APP_PATH}/Contents/Info.plist`;
  const identifier = await run("/usr/bin/plutil", [
    "-extract", "CFBundleIdentifier", "raw", "-o", "-", plist,
  ]).catch(() => "");
  if (identifier !== BUNDLE_ID) {
    throw new Error(`未找到可信的官方 Codex 应用：${APP_PATH}`);
  }
  const signature = await execFileAsync("/usr/bin/codesign", ["-dv", "--verbose=2", APP_PATH])
    .then(({ stderr = "" }) => stderr)
    .catch(() => "");
  if (!signature.includes("Authority=Developer ID Application: OpenAI OpCo, LLC (2DC432GLL2)") ||
      !signature.includes("TeamIdentifier=2DC432GLL2")) {
    throw new Error("Codex 不是预期的 OpenAI 官方签名，已停止操作。");
  }
}

async function mainPids() {
  const output = await run("/bin/ps", ["-axo", "pid=,command="]);
  return output.split("\n").map((line) => line.trim()).flatMap((line) => {
    const match = /^(\d+)\s+(.*)$/.exec(line);
    return match && match[2].startsWith(APP_EXECUTABLE) ? [Number(match[1])] : [];
  });
}

async function listenerPids() {
  const output = await run("/usr/sbin/lsof", [
    "-nP", `-iTCP:${PORT}`, "-sTCP:LISTEN", "-t",
  ]).catch(() => "");
  return [...new Set(output.split("\n").map(Number).filter((pid) => pid > 0))];
}

async function assertPortSafe() {
  const listeners = await listenerPids();
  if (!listeners.length) return;
  const codex = new Set(await mainPids());
  const belongsToCodex = async (pid) => {
    let current = pid;
    for (let depth = 0; current > 1 && depth < 24; depth += 1) {
      if (codex.has(current)) return true;
      const parent = Number(await run("/bin/ps", ["-p", String(current), "-o", "ppid="]).catch(() => "0"));
      if (!Number.isInteger(parent) || parent <= 1 || parent === current) return false;
      current = parent;
    }
    return false;
  };
  const ownership = await Promise.all(listeners.map(belongsToCodex));
  if (!ownership.every(Boolean)) {
    throw new Error(`本机端口 ${PORT} 已被其他程序占用，已停止操作。`);
  }
}

async function cdpReady() {
  try {
    const response = await fetch(`http://${HOST}:${PORT}/json/version`, {
      signal: AbortSignal.timeout(1000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function appVersion() {
  return run("/usr/bin/plutil", [
    "-extract", "CFBundleShortVersionString", "raw", "-o", "-",
    `${APP_PATH}/Contents/Info.plist`,
  ]).catch(() => "unknown");
}

async function startWithCdp() {
  if ((await mainPids()).length) {
    console.error("正在正常退出 Codex，以直接启动方式启用 CDP……");
    await run("/usr/bin/osascript", ["-e", `tell application id "${BUNDLE_ID}" to quit`])
      .catch(() => { throw new Error("系统未允许脚本退出 Codex。请保存内容并用 Cmd+Q 退出 Codex，再在系统终端运行本脚本。"); });
    const deadline = Date.now() + 15_000;
    while ((await mainPids()).length && Date.now() < deadline) await sleep(250);
    if ((await mainPids()).length) throw new Error("Codex 尚未退出，已停止启动，请检查未保存内容或退出确认窗口。");
  }
  await assertPortSafe();
  const dir = new URL("./tmp/", import.meta.url);
  mkdirSync(dir, { recursive: true });
  const log = new URL(`codex-launch-${Date.now()}.log`, dir);
  const fd = openSync(log, "wx", 0o600);
  let child;
  try {
    child = spawn(APP_EXECUTABLE, [`--remote-debugging-port=${PORT}`], {
      detached: true, stdio: ["ignore", fd, fd], env: codexLaunchEnv(),
    });
  } finally { closeSync(fd); }
  let launchError;
  child.on("error", error => { launchError = error; });
  child.unref();
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (launchError || child.exitCode !== null || child.signalCode !== null) {
      // Recover the normal app once if this launch failed; never retry CDP.
      if (!(await mainPids()).length) await run("/usr/bin/open", ["-a", APP_PATH]).catch(() => {});
      throw new Error(`Codex 调试启动提前退出（${launchError?.message ?? child.signalCode ?? child.exitCode}）。日志：${log.pathname}`);
    }
    if (await cdpReady()) { await assertPortSafe(); return; }
    await sleep(300);
  }
  throw new Error(`Codex 已启动，但 9341 未就绪。未重复重启。日志：${log.pathname}`);
}

async function targets() {
  const response = await fetch(`http://${HOST}:${PORT}/json/list`, {
    signal: AbortSignal.timeout(2000),
  });
  if (!response.ok) throw new Error(`CDP 返回 HTTP ${response.status}`);
  const items = await response.json();
  return items.filter((item) => {
    if (!["page", "webview"].includes(item.type) || !item.webSocketDebuggerUrl) return false;
    try {
      // Only the signed app's shell windows; exclude checkout, sandbox and overlays.
      const page = new URL(item.url);
      if (page.protocol !== "app:" || page.hostname !== "-" ||
          !["/index.html", "/detached-window.html"].includes(page.pathname)) return false;
      const route = page.searchParams.get("initialRoute");
      if (route && !["/", "/detached-window"].includes(route)) return false;
      const socket = new URL(item.webSocketDebuggerUrl);
      return socket.protocol === "ws:" && socket.hostname === HOST && Number(socket.port) === PORT;
    } catch { return false; }
  });
}

async function evaluate(target, expression) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP WebSocket 连接超时")), 5000);
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("CDP WebSocket 连接失败")); }, { once: true });
    });
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP 页面操作超时")), 5000);
      socket.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data));
        if (message.id !== 1) return;
        clearTimeout(timer);
        if (message.error || message.result?.exceptionDetails) {
          reject(new Error(message.error?.message ?? message.result.exceptionDetails.text ?? "页面脚本执行失败"));
        } else resolve(message.result?.result?.value);
      });
      socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate",
        params: { expression, returnByValue: true, awaitPromise: true } }));
    });
  } finally { socket.close(); }
}

const STATE_KEY = "__localCodexReadableTheme";
const editorSelector = '.cm-content[data-language="markdown"]';

const markdownSelector = '[class*="MarkdownRoot"], [class*="markdown-root"], .markdown-body, .prose, [data-testid*="markdown"], main article';

const themeCss = `
:root, [data-theme="dark"] { --md-text:#e9e9e9; --md-text-strong:#fff; --md-text-muted:#a5a5a5; --md-border:rgba(255,255,255,.11); --md-border-strong:rgba(255,255,255,.19); --md-accent:#8ab4ff; --md-accent-soft:rgba(138,180,255,.12); --md-heading-1:rgb(231,77,71); --md-heading-2:rgb(215,148,64); --md-heading-3:rgb(7,170,246); --md-heading-4:rgb(163,110,251); --md-heading-5:rgb(109,215,215); --md-heading-6:rgb(175,191,5); --md-code-bg:#0c0c0c; --md-code-text:#d9e5ff; --md-table-bg:#161616; --md-table-head-bg:#222; --md-radius-sm:6px; --md-radius-md:10px; --md-content-width:860px; }
[data-theme="light"] { --md-text:#242424; --md-text-strong:#111; --md-text-muted:#5f6368; --md-border:rgba(0,0,0,.12); --md-border-strong:rgba(0,0,0,.2); --md-accent:#0969da; --md-accent-soft:rgba(9,105,218,.08); --md-heading-1:#c9372c; --md-heading-2:#9a5700; --md-heading-3:#006b9f; --md-heading-4:#7047a8; --md-heading-5:#147879; --md-heading-6:#626c00; --md-code-bg:#f6f8fa; --md-code-text:#244a7c; --md-table-bg:#fff; --md-table-head-bg:#f1f3f5; }
/* One glass layer behind the title controls and sidebar prevents overlap seams. */
:root, [data-theme="dark"] { --local-sidebar-overlay:linear-gradient(180deg, rgba(28,27,32,.947), rgba(26,31,42,.923) 48%, rgba(29,27,33,.947)); }
[data-theme="light"] { --local-sidebar-overlay:linear-gradient(rgba(245,245,245,.927), rgba(238,242,248,.907)); }
[data-app-shell-frame] { background-color:var(--color-token-main-surface-primary) !important; }
[data-app-shell-frame]::before { content:""; position:absolute; inset:0 auto 0 0; z-index:0; width:calc(var(--codex-sidebar-preferred-width) * ${SCALE}); pointer-events:none; background-image:var(--local-sidebar-overlay), __LOCAL_SIDEBAR_WALLPAPER__; background-repeat:no-repeat; background-size:100% 100%, var(--local-screen-width, 100vw) var(--local-screen-height, 100vh); background-position:0 0, var(--local-wallpaper-x, 0) var(--local-wallpaper-y, 0); -webkit-backdrop-filter:blur(30px) saturate(1.15); backdrop-filter:blur(30px) saturate(1.15); }
[data-app-shell-frame][data-app-shell-sidebar-open="false"]::before { width:calc(var(--app-shell-navigation-rail-width) * ${SCALE}); }
aside.app-shell-left-panel, aside.app-shell-left-panel .sidebar-navigation { background:transparent !important; -webkit-backdrop-filter:none !important; backdrop-filter:none !important; }
aside.app-shell-left-panel .text-default { color:rgba(252,252,252,.68) !important; }
[data-theme="light"] aside.app-shell-left-panel .text-default { color:rgba(28,28,30,.68) !important; }
[data-app-shell-workspace-row] > [class*="_PageSurface_"] { box-shadow:none !important; }
[data-app-shell-main-titlebar] > .w-px.bg-border { display:none !important; }
[data-app-shell-main-surface] { border-left-color:transparent !important; }
aside.app-shell-left-panel .sidebar-resize-handle-line { transform:translateX(.5px); opacity:0 !important; transition:opacity 120ms ease; }
aside.app-shell-left-panel [role="separator"]:hover .sidebar-resize-handle-line,
aside.app-shell-left-panel [role="separator"]:active .sidebar-resize-handle-line { opacity:1 !important; }
aside.app-shell-left-panel, aside[data-app-shell-left-panel-appearance], [data-pip-home-surface="thread-summary-panel"] { zoom:${SCALE} !important; }
[class*="MarkdownRoot"], .markdown-body, .prose, [data-testid*="markdown"], main article { max-width:var(--md-content-width); margin-inline:auto; color:var(--md-text); font-size:15px; line-height:1.75; letter-spacing:.01em; }
[class~="group"][class~="flex"][class~="min-w-0"][class~="flex-col"] > [class*="MarkdownRoot"] { width:100% !important; max-width:100% !important; margin-inline:0 !important; text-align:left !important; }
[class*="MarkdownRoot"] p, .markdown-body p, .prose p, main article p { margin:0 0 1em; }
[class*="MarkdownRoot"] h1,.markdown-body h1,.prose h1,main article h1 { margin:2.2em 0 .8em; padding-bottom:.45em; border-bottom:1px solid var(--md-border-strong); color:var(--md-heading-1); font-size:2rem; line-height:1.25; font-weight:750; }
.markdown-body h2,.prose h2,main article h2 { margin:2em 0 .75em; padding-bottom:.35em; border-bottom:1px solid var(--md-border); color:var(--md-heading-2); font-size:1.45rem; font-weight:720; }
.markdown-body h3,.prose h3,main article h3 { margin:1.65em 0 .55em; color:var(--md-heading-3); font-size:1.15rem; font-weight:700; }
.markdown-body h4,.prose h4,main article h4 { margin:1.3em 0 .45em; color:var(--md-heading-4); font-weight:680; }
.markdown-body h5,.prose h5,main article h5 { margin:1.3em 0 .45em; color:var(--md-heading-5); font-weight:680; }
.markdown-body h6,.prose h6,main article h6 { margin:1.3em 0 .45em; color:var(--md-heading-6); font-weight:680; }
.markdown-body strong,.prose strong,main article strong { color:var(--md-heading-1); font-weight:750; }
.markdown-body a,.prose a,main article a { color:var(--md-accent); text-decoration:none; } .markdown-body a:hover,.prose a:hover,main article a:hover { text-decoration:underline; }
.markdown-body ul,.markdown-body ol,.prose ul,.prose ol,main article ul,main article ol { margin:1em 0; padding-left:1.55em; } .markdown-body li,.prose li,main article li { margin:.38em 0; } .markdown-body li::marker,.prose li::marker,main article li::marker { color:var(--md-accent); font-weight:700; }
.markdown-body blockquote,.prose blockquote,main article blockquote { margin:1.25em 0; padding:.85em 20px; border-left:1.5px solid var(--md-accent); border-radius:0 var(--md-radius-sm) var(--md-radius-sm) 0; background:var(--md-accent-soft); color:var(--md-text-muted); }
.markdown-body table,.prose table,main article table { width:100%; margin:1.4em 0; border:1px solid var(--md-border); border-radius:var(--md-radius-md); border-spacing:0; background:var(--md-table-bg); table-layout:auto; } .markdown-body thead,.prose thead,main article thead { background:var(--md-table-head-bg); }
.markdown-body th,.markdown-body td,.prose th,.prose td,main article th,main article td { padding:.75em .9em; border-right:1px solid var(--md-border); border-bottom:1px solid var(--md-border); text-align:left; vertical-align:middle; white-space:normal; overflow-wrap:anywhere; } .markdown-body th,.prose th,main article th { color:var(--md-text-strong); font-weight:720; }
.markdown-body pre,.prose pre,main article pre { margin:1.3em 0; padding:1em 20px !important; overflow-x:auto; border:1px solid var(--md-border); border-radius:var(--md-radius-md); background:var(--md-code-bg); } .markdown-body :not(pre)>code,.prose :not(pre)>code,main article :not(pre)>code { padding:.16em .4em; border:1px solid var(--md-border); border-radius:5px; background:var(--md-code-bg); color:var(--md-code-text); font-size:.9em; }
.markdown-body hr,.prose hr,main article hr { height:1px; margin:2.2em 0; border:0; background:var(--md-border-strong); } .markdown-body img,.prose img,main article img { display:block; max-width:100%; height:auto; margin:1.25em auto; border:1px solid var(--md-border); border-radius:var(--md-radius-md); }
[class*="MarkdownRoot"] h2 { margin:2em 0 .75em; padding-bottom:.35em; border-bottom:1px solid var(--md-border); color:var(--md-heading-2); font-size:1.45rem; font-weight:720; }
[class*="MarkdownRoot"] h3 { margin:1.65em 0 .55em; color:var(--md-heading-3); font-size:1.15rem; font-weight:700; }
[class*="MarkdownRoot"] h4 { color:var(--md-heading-4); }
[class*="MarkdownRoot"] h5 { color:var(--md-heading-5); }
[class*="MarkdownRoot"] h6 { color:var(--md-heading-6); }
[class*="MarkdownRoot"] strong { color:var(--md-heading-1); font-weight:750; }
[class*="MarkdownRoot"] blockquote { margin:1.25em 0; padding:.85em 20px; border-left:1.5px solid var(--md-accent); background:var(--md-accent-soft); color:var(--md-text-muted); }
[class*="MarkdownRoot"] blockquote::after { content:none !important; display:none !important; }
[class*="MarkdownRoot"] [class*="TableContainer"] { width:100% !important; max-width:100% !important; margin:1.4em 0 !important; }
[class*="MarkdownRoot"] [class*="TableScroller"] { display:block !important; width:100% !important; max-width:100% !important; overflow-x:auto !important; }
[class*="MarkdownRoot"] table { display:table !important; width:100% !important; min-width:0 !important; max-width:100% !important; table-layout:auto !important; border-collapse:separate; border-spacing:0; border:1px solid var(--md-border); border-radius:var(--md-radius-md); background:var(--md-table-bg); }
[class*="MarkdownRoot"] th,[class*="MarkdownRoot"] td { padding:.75em .9em; border-bottom:1px solid var(--md-border); text-align:left !important; vertical-align:middle !important; white-space:normal !important; overflow-wrap:anywhere; word-break:normal; }
[class*="MarkdownRoot"] th { background:var(--md-table-head-bg); color:var(--md-text-strong); font-weight:720; }
[class*="MarkdownRoot"] pre { margin:1.3em 0; padding:1em 20px !important; overflow-x:auto; border:1px solid var(--md-border); border-radius:var(--md-radius-md); background:var(--md-code-bg); }
main [class*="MarkdownRoot"] { color:var(--md-text) !important; font-size:15px !important; line-height:1.75 !important; }
main [class*="MarkdownRoot"] p { margin:0 0 1em !important; }
main [class*="MarkdownRoot"] strong { color:var(--md-heading-1) !important; font-weight:750 !important; }
main [class*="MarkdownRoot"] table { width:100% !important; border-collapse:separate !important; border-spacing:0 !important; }
main [class*="MarkdownRoot"] th { background:var(--md-table-head-bg) !important; color:var(--md-text-strong) !important; font-weight:720 !important; }
main [class*="MarkdownRoot"] td, main [class*="MarkdownRoot"] th { padding:.75em .9em !important; border-bottom:1px solid var(--md-border) !important; vertical-align:middle !important; }
[class*="MarkdownRoot"] > * { color:var(--md-text) !important; line-height:1.75 !important; }
[class*="MarkdownRoot"] > strong, [class*="MarkdownRoot"] strong { color:var(--md-heading-1) !important; font-weight:750 !important; }
[class*="MarkdownRoot"] [class*="Paragraph"], [class*="MarkdownRoot"] [class*="Heading"] { line-height:1.75 !important; }
[class*="MarkdownRoot"] [class*="TableHeaderCell"] { background:var(--md-table-head-bg) !important; color:var(--md-text-strong) !important; font-weight:720 !important; }
[class*="MarkdownRoot"] [class*="TableCell"], [class*="MarkdownRoot"] [class*="TableHeaderCell"] { padding:.75em .9em !important; text-align:left !important; vertical-align:middle !important; white-space:normal !important; overflow-wrap:anywhere; }
`;

// The file panel is CodeMirror, not the chat MarkdownRoot renderer. Keep its
// line/widget structure intact: CodeMirror owns selection, wrapping and layout.
const editorCss = `
${editorSelector} { color:var(--md-text) !important; font-size:15px !important; line-height:1.75 !important; caret-color:var(--md-accent); }
${editorSelector} .file-editor-heading { font-weight:750 !important; line-height:1.4 !important; }
${editorSelector} .file-editor-heading-1 { font-size:28px !important; color:var(--md-heading-1) !important; }
${editorSelector} .file-editor-heading-2 { font-size:22px !important; color:var(--md-heading-2) !important; }
${editorSelector} .file-editor-heading-3 { font-size:18px !important; color:var(--md-heading-3) !important; }
${editorSelector} .file-editor-heading-4 { font-size:16px !important; color:var(--md-heading-4) !important; }
${editorSelector} .file-editor-heading-5 { font-size:15px !important; color:var(--md-heading-5) !important; }
${editorSelector} .file-editor-heading-6 { font-size:14px !important; color:var(--md-heading-6) !important; }
${editorSelector} .cm-markdown-table-row { background:var(--md-code-bg); border-inline:1px solid var(--md-border) !important; }
${editorSelector} .cm-markdown-table-header { background:var(--md-accent-soft) !important; border-top:1px solid var(--md-border-strong); border-radius:6px 6px 0 0; }
${editorSelector} .cm-markdown-table-header .cm-markdown-table-cell { color:var(--md-accent) !important; font-weight:750 !important; }
${editorSelector} .cm-markdown-table-cell { padding:8px 10px !important; border-bottom:1px solid var(--md-border); align-content:center !important; }
${editorSelector} .cm-markdown-table-cell ~ .cm-markdown-table-cell { border-inline-start:1px solid var(--md-border); }
${editorSelector} .cm-markdown-blockquote { background:var(--md-accent-soft) !important; border-inline-start:1.5px solid var(--md-accent) !important; padding-inline:20px !important; }
${editorSelector} .cm-markdown-list-item { line-height:1.8; padding-inline-start:var(--local-list-indent,1.35em) !important; }
${editorSelector} .cm-markdown-list-item > span:first-of-type { display:inline-block; width:var(--local-list-marker-width,16px); margin-inline-start:var(--local-list-marker-offset,-20px); margin-inline-end:3px; color:var(--md-accent) !important; font-weight:750; text-align:center; white-space:nowrap !important; }
${editorSelector} .cm-markdown-list-item[data-local-list-kind="unordered"] > span:first-of-type { font-size:0 !important; }
${editorSelector} .cm-markdown-list-item[data-local-list-kind="unordered"] > span:first-of-type::before { content:"•"; font-size:15px; line-height:inherit; }
${editorSelector} .cm-markdown-code-line { background:var(--md-code-bg) !important; font-size:13px !important; line-height:1.65 !important; border-inline:1px solid var(--md-border); padding-inline:20px !important; }
${editorSelector} .cm-markdown-code-line-first { border-top:1px solid var(--md-border); }
${editorSelector} .cm-markdown-code-line-last { border-bottom:1px solid var(--md-border); }
${editorSelector} .cm-markdown-horizontal-rule { background:linear-gradient(var(--md-border-strong),var(--md-border-strong)) center / 100% 1px no-repeat !important; }
`;

function themeStatus(styleId, stateKey, markdownSelector, editorSelector) {
  const roots = [...document.querySelectorAll(markdownSelector)];
  const editors = [...document.querySelectorAll(editorSelector)];
  const count = (containers, selector) => new Set(containers.flatMap(e => [...e.querySelectorAll(selector)])).size;
  const sample = (node) => {
    if (!node) return null;
    const css = getComputedStyle(node);
    return { fontSize: css.fontSize, fontWeight: css.fontWeight, color: css.color,
      background: css.backgroundColor, lineHeight: css.lineHeight };
  };
  return {
    applied: Boolean(document.getElementById(styleId)?.sheet),
    observerInstalled: Boolean(window[stateKey]?.observer),
    themeVariant: document.documentElement.dataset.theme ??
      document.querySelector('[data-theme]')?.dataset.theme ??
      getComputedStyle(document.documentElement).colorScheme,
    markdownMounted: roots.length + editors.length > 0,
    chatRoots: roots.length, markdownEditors: editors.length,
    headings: count(roots, 'h1,h2,h3,h4,h5,h6') + count(editors, '.file-editor-heading'),
    tables: count(roots, 'table,[class*="TableContainer"]:not(:has(table))') + count(editors, '.cm-markdown-table-header'),
    codeBlocks: count(roots, 'pre') + count(editors, '.cm-markdown-code-line-first'),
    editorComputed: editors.map(e => ({ body: sample(e),
      heading: sample(e.querySelector('.file-editor-heading')),
      tableHeader: sample(e.querySelector('.cm-markdown-table-header .cm-markdown-table-cell')) })),
    tokenRules: window[stateKey]?.tokenRules ?? 0,
  };
}

const statusExpression = `(${themeStatus})(${JSON.stringify(STYLE_ID)}, ${JSON.stringify(STATE_KEY)}, ${JSON.stringify(markdownSelector)}, ${JSON.stringify(editorSelector)})`;

function installTheme(styleId, stateKey, css, editorSelector) {
  window[stateKey]?.observer?.disconnect();
  if (window[stateKey]?.positionTimer) clearInterval(window[stateKey].positionTimer);
  // CodeMirror highlight classes are generated. Discover semantic declarations
  // instead of pinning a session-specific class such as .ͼ8 or .ͼo.
  const tokenCss = () => {
    const rules = [];
    const visit = (entries) => {
      for (const rule of entries) {
        if (rule.selectorText && /^\.ͼ[\w-]+$/u.test(rule.selectorText)) {
          const selector = editorSelector + ' ' + rule.selectorText;
          if (rule.style.fontWeight === 'bold' || Number(rule.style.fontWeight) >= 600)
            rules.push(selector + ' { font-weight:750 !important; color:var(--md-heading-1) !important; }');
          if (rule.style.backgroundColor.includes('--color-codex-editor-inline-code-background'))
            rules.push(selector + ' { color:var(--md-code-text) !important; background:var(--md-code-bg) !important; border-radius:4px; }');
        }
        if (rule.cssRules) visit(rule.cssRules);
      }
    };
    for (const sheet of [...document.styleSheets, ...document.adoptedStyleSheets]) {
      if (sheet.ownerNode?.id === styleId) continue;
      try { visit(sheet.cssRules); } catch { /* Ignore inaccessible external sheets. */ }
    }
    state.tokenRules = rules.length;
    return rules.join('\n');
  };
  const state = { observer: null, positionTimer: null, tokenRules: 0, usageRowsInitialized: new WeakSet() };
  let style, lastSheetCount = -1, dynamic = '';
  const syncWallpaperPosition = () => {
    const root = document.documentElement;
    root.style.setProperty('--local-screen-width', screen.width + 'px');
    root.style.setProperty('--local-screen-height', screen.height + 'px');
    root.style.setProperty('--local-wallpaper-x', (-window.screenX) + 'px');
    root.style.setProperty('--local-wallpaper-y', (-window.screenY) + 'px');
  };
  const decorateLists = () => {
    for (const line of document.querySelectorAll(editorSelector + ' .cm-markdown-list-item')) {
      const marker = [...line.children].find(node =>
        node.tagName === 'SPAN' && /^([-+*]|[0-9]+[.)])$/.test(node.textContent.trim()));
      if (!marker) {
        delete line.dataset.localListKind;
        line.style.removeProperty('--local-list-indent');
        line.style.removeProperty('--local-list-marker-width');
        line.style.removeProperty('--local-list-marker-offset');
        continue;
      }
      const value = marker.textContent.trim();
      const unordered = /^[-+*]$/.test(value);
      const width = unordered ? 16 : Math.max(16, value.length * 10.2);
      line.dataset.localListKind = unordered ? 'unordered' : 'ordered';
      line.style.setProperty('--local-list-marker-width', width + 'px');
      line.style.setProperty('--local-list-indent', (width + 7) + 'px');
      line.style.setProperty('--local-list-marker-offset', -(width + 5) + 'px');
    }
  };
  const expandUsageRemaining = () => {
    for (const row of document.querySelectorAll('[role="menuitem"]')) {
      const label = row.textContent.trim().replace(/\s+/g, ' ');
      if (!label.startsWith('Usage remaining') ||
          state.usageRowsInitialized.has(row)) continue;
      state.usageRowsInitialized.add(row);
      if (row.getAttribute('aria-expanded') !== 'true') row.click();
    }
  };
  const ensure = () => {
    if (!document.documentElement) return;
    style = document.getElementById(styleId);
    if (!style) {
      style = document.createElement('style'); style.id = styleId;
      (document.head || document.documentElement).appendChild(style);
    }
    if (document.styleSheets.length !== lastSheetCount) {
      dynamic = tokenCss(); lastSheetCount = document.styleSheets.length;
    }
    const text = css + '\n' + dynamic;
    if (style.textContent !== text) style.textContent = text;
    syncWallpaperPosition();
    decorateLists();
    expandUsageRemaining();
  };
  ensure();
  state.observer = new MutationObserver(ensure);
  state.observer.observe(document, { childList: true, subtree: true, characterData: true });
  state.positionTimer = setInterval(syncWallpaperPosition, 250);
  window[stateKey] = state;
}

function applyExpression(css) {
  return `(() => {
    (${installTheme})(${JSON.stringify(STYLE_ID)}, ${JSON.stringify(STATE_KEY)}, ${JSON.stringify(css)}, ${JSON.stringify(editorSelector)});
    return { theme:${JSON.stringify(THEME_NAME)}, scale:${SCALE}, ...(${statusExpression}) };
  })()`;
}

const restoreExpression = `(() => {
  window[${JSON.stringify(STATE_KEY)}]?.observer?.disconnect();
  if (window[${JSON.stringify(STATE_KEY)}]?.positionTimer) clearInterval(window[${JSON.stringify(STATE_KEY)}].positionTimer);
  delete window[${JSON.stringify(STATE_KEY)}];
  for (const name of ['--local-screen-width','--local-screen-height','--local-wallpaper-x','--local-wallpaper-y']) document.documentElement.style.removeProperty(name);
  const style = document.getElementById(${JSON.stringify(STYLE_ID)});
  style?.remove();
  return { removed:Boolean(style), ...(${statusExpression}) };
})()`;

async function verifiedCodexTargets(timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pages = await targets();
    // A trusted shell does not need an already-mounted Markdown document.
    if (pages.length) return pages;
    await sleep(300);
  }
  throw new Error("没有找到可信的 Codex 主页面。");
}

async function operate(expression) {
  const pages = await verifiedCodexTargets();
  const results = await Promise.all(pages.map(async (target) => {
    const identity = { targetId: target.id, targetKind: target.type, targetUrl: target.url };
    try { return { ...identity, ...await evaluate(target, expression) }; }
    catch (error) { return { ...identity, error: error.message }; }
  }));
  if (results.some(result => result.error)) process.exitCode = 1;
  return results;
}

async function main() {
  if (!["apply", "restore", "status"].includes(command)) {
    throw new Error("用法：codex-theme.mjs apply|restore|status（默认主题：readable）");
  }
  await verifyOfficialBundle();
  await assertPortSafe();

  if (command === "apply" && !(await cdpReady())) await startWithCdp();
  const cdpAvailable = await cdpReady();
  if (!cdpAvailable) {
    if (command === "restore") {
      console.log("Codex 当前未启用 CDP；页面重启后注入样式本身已不存在，无需恢复。");
      return;
    }
    const diagnosis = {
      command,
      cdpAvailable: false,
      codexVersion: await appVersion(),
      port: PORT,
      appRunning: (await mainPids()).length > 0,
      restartedApp: false,
      message: command === "status"
        ? "Codex 当前未启用本机 CDP；主题未注入。"
        : "Codex 当前未启用本机 CDP，已停止应用主题。为避免触发 Electron 启动崩溃，脚本不会自动退出或重启 Codex。",
    };
    console.log(JSON.stringify(diagnosis, null, 2));
    if (command === "apply") process.exitCode = 1;
    return;
  }

  const expression = command === "apply"
    ? applyExpression((themeCss + editorCss).replace("__LOCAL_SIDEBAR_WALLPAPER__", await sidebarWallpaperDataUrl()))
    : command === "restore" ? restoreExpression : statusExpression;
  const results = await operate(expression);
  console.log(JSON.stringify({ command, port: PORT, results }, null, 2));
}

main().catch((error) => {
  console.error(`失败：${error.message}`);
  process.exitCode = 1;
});
