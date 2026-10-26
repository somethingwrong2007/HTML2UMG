// Copyright (c) 2026 FPVSkyline. MIT License.
// Launch a Chromium-based browser headless and hand back its CDP endpoint.
// Zero dependencies: process spawn + the built-in fetch.
'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const IS_WINDOWS = process.platform === 'win32';

/** Browser candidates, in the documented discovery order. */
const CANDIDATES = {
  edge: [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Microsoft/Edge/Application/msedge.exe'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Microsoft/Edge/Application/msedge.exe'),
  ],
  chrome: [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
  ],
  brave: [
    'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe',
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'BraveSoftware/Brave-Browser/Application/brave.exe'),
  ],
  vivaldi: [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Vivaldi/Application/vivaldi.exe'),
    'C:/Program Files/Vivaldi/Application/vivaldi.exe',
  ],
};

const ORDER = ['edge', 'chrome', 'brave', 'vivaldi'];

function usablePath(p) {
  if (!p) return null;
  try {
    const stat = fs.statSync(p);
    return stat.isFile() ? p : null;
  } catch (e) {
    return null;
  }
}

/**
 * Resolve the browser executable:
 *   --browser  >  HTML2UMG_BROWSER  >  Edge  >  Chrome  >  Brave  >  Vivaldi
 * Returns { exe, source } or throws a descriptive error.
 */
function findBrowser(explicitPath) {
  if (explicitPath) {
    const resolved = usablePath(path.resolve(explicitPath));
    if (!resolved) {
      throw new Error(`--browser: "${explicitPath}" does not exist or is not a file.`);
    }
    return { exe: resolved, source: '--browser' };
  }

  const envPath = process.env.HTML2UMG_BROWSER;
  if (envPath) {
    const resolved = usablePath(path.resolve(envPath));
    if (!resolved) {
      throw new Error(`HTML2UMG_BROWSER: "${envPath}" does not exist or is not a file.`);
    }
    return { exe: resolved, source: 'HTML2UMG_BROWSER' };
  }

  const tried = [];
  for (const name of ORDER) {
    for (const candidate of CANDIDATES[name]) {
      if (!candidate) continue;
      tried.push(candidate);
      const resolved = usablePath(candidate);
      if (resolved) return { exe: resolved, source: `${name} (auto)` };
    }
  }

  const unique = Array.from(new Set(tried));
  throw new Error(
    'No Chromium-based browser found. Install Edge/Chrome, pass --browser <exe>, or set HTML2UMG_BROWSER.\n' +
      `Looked in:\n  ${unique.join('\n  ')}`
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, timeoutMs) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs || 5000) });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.json();
}

/** Wait until <userDataDir>/DevToolsActivePort exists; returns {port, browserPath}. */
async function readDevToolsActivePort(userDataDir, timeoutMs, isAlive) {
  const portFile = path.join(userDataDir, 'DevToolsActivePort');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const text = await fsp.readFile(portFile, 'utf8');
      const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      if (lines.length >= 1) {
        const port = parseInt(lines[0], 10);
        if (Number.isFinite(port) && port > 0) {
          return { port, browserPath: lines[1] || `/devtools/browser/` };
        }
      }
    } catch (e) {
      // Not written yet.
    }
    if (isAlive && !isAlive()) {
      throw new Error('browser exited before exposing the DevTools port (check the launch arguments)');
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${portFile}`);
    }
    await sleep(50);
  }
}

/**
 * Launch the browser and connect information for a real page target.
 * The caller owns close().
 */
async function launchBrowser(options) {
  const opts = options || {};
  const timeoutMs = opts.timeoutMs || 30000;
  const { exe, source } = findBrowser(opts.browser);
  const viewport = opts.viewport || { width: 1920, height: 1080 };

  const userDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'html2umg-profile-'));
  const startedAt = Date.now();

  const args = [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--metrics-recording-only',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    `--window-size=${viewport.width},${viewport.height}`,
    '--allow-file-access-from-files',
    'about:blank',
  ];

  const child = spawn(exe, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let stderrTail = '';
  if (child.stderr) {
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk).slice(-8192);
    });
  }

  let exited = false;
  let exitInfo = null;
  child.on('exit', (code, signal) => {
    exited = true;
    exitInfo = { code, signal };
  });
  child.on('error', (err) => {
    exited = true;
    exitInfo = { code: null, signal: null, error: err.message };
  });

  const cleanup = async () => {
    await killTree(child);
    if (!opts.keepProfile) {
      await fsp.rm(userDataDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
    }
    return userDataDir;
  };

  const fail = async (err) => {
    await cleanup();
    const detail = stderrTail ? `\n--- browser stderr ---\n${stderrTail.trim()}` : '';
    throw new Error(`${err.message}${exitInfo ? `\n(browser exit: ${JSON.stringify(exitInfo)})` : ''}${detail}`);
  };

  let port;
  try {
    const info = await readDevToolsActivePort(userDataDir, timeoutMs, () => !exited);
    port = info.port;
  } catch (err) {
    return fail(err);
  }

  let pageWsUrl = null;
  let browserWsUrl = null;
  let version = null;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      version = await fetchJson(`http://127.0.0.1:${port}/json/version`, 3000);
      browserWsUrl = version.webSocketDebuggerUrl || null;
      const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`, 3000);
      const page = (targets || []).find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) {
        pageWsUrl = page.webSocketDebuggerUrl;
        break;
      }
    } catch (err) {
      // Server not up yet.
    }
    if (exited) {
      return fail(new Error('browser exited while waiting for a page target'));
    }
    if (Date.now() > deadline) {
      return fail(new Error(`timed out waiting for a page target on port ${port}`));
    }
    await sleep(50);
  }

  return {
    exe,
    source,
    port,
    userDataDir,
    browserWsUrl,
    pageWsUrl,
    version: version ? version['Browser'] || version.Browser : null,
    protocolVersion: version ? version['Protocol-Version'] || null : null,
    pid: child.pid,
    launchMs: Date.now() - startedAt,
    stderr: () => stderrTail,
    close: cleanup,
  };
}

/** Terminate the browser and every child process it spawned. */
function killTree(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.killed) {
      // Still attempt a tree kill when the pid is known: the parent can die
      // while renderer children linger.
      if (IS_WINDOWS && child && child.pid) {
        try {
          spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        } catch (e) { /* ignore */ }
      }
      resolve();
      return;
    }
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    child.once('exit', done);
    const timer = setTimeout(() => {
      if (IS_WINDOWS && child.pid) {
        try {
          spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        } catch (e) { /* ignore */ }
      }
      done();
    }, 1500);
    if (timer.unref) timer.unref();
    try {
      if (IS_WINDOWS) {
        // Graceful close first (lets the profile flush), then a tree kill if needed.
        spawn('taskkill', ['/PID', String(child.pid), '/T'], { stdio: 'ignore', windowsHide: true });
      } else {
        child.kill('SIGTERM');
      }
    } catch (e) {
      done();
    }
  });
}

module.exports = { findBrowser, launchBrowser, killTree, sleep, CANDIDATES, ORDER };
