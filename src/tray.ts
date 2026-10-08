import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { disableAutoStart, enableAutoStart, isAutoStartEnabled } from './autostart.js';
import { projectRoot } from './paths.js';

export interface TrayOptions {
  port: number;
  onOpenDashboard: () => void;
  onRotate: () => void;
  onQuit: () => void;
}

export interface TrayHandle {
  kill: () => void;
  refreshAutostartItem: () => void;
}

const MENU = { STATUS: 0, DASHBOARD: 1, ROTATE: 2, AUTOSTART: 3, QUIT: 4 } as const;

function resourcePath(...parts: string[]): string {
  return path.resolve(projectRoot(), ...parts);
}

function iconBase64(): string {
  try {
    const p = resourcePath('public', 'icon.png');
    if (fs.existsSync(p)) return fs.readFileSync(p).toString('base64');
  } catch {
    /* fall through to embedded fallback */
  }
  // Fallback: 16x16 green dot PNG.
  return 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABGdBTUEAALGPC/xhBQAAAAlwSFlzAAALEwAACxMBAJqcGAAAAHpJREFUOE9jYBgFgwEwMjIy/Gdg+P8fyP4PxP8ZGBgEcBnGyMjIsICBgSEAhyH/gfgBUNN8XJoZsdkCVL8Ah+b/QPwbqvkBMvk/AwMDAzYX/GdgYAhAN+A/SICRWAMYGfFEJSMjzriEiwDR/xmIa2RkZCSqnZERb3QCAAo3KxzxbKe1AAAAAElFTkSuQmCC';
}

export function isTraySupported(): boolean {
  if (!['darwin', 'win32', 'linux'].includes(process.platform)) return false;
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return false;
  return true;
}

function handleClick(index: number, opts: TrayOptions, ui: { refreshAutostart: () => void }): void {
  if (index === MENU.DASHBOARD) opts.onOpenDashboard();
  else if (index === MENU.ROTATE) opts.onRotate();
  else if (index === MENU.AUTOSTART) {
    if (isAutoStartEnabled()) disableAutoStart();
    else enableAutoStart();
    ui.refreshAutostart();
  } else if (index === MENU.QUIT) opts.onQuit();
}

function menuItems(port: number): Array<{ title: string; tooltip: string; enabled: boolean; seqID: number }> {
  const auto = isAutoStartEnabled();
  return [
    { title: `opencode-max  :${port}`, tooltip: 'proxy is running', enabled: false, seqID: MENU.STATUS },
    { title: 'Open Dashboard', tooltip: 'open the web UI in your browser', enabled: true, seqID: MENU.DASHBOARD },
    { title: 'Rotate IP now', tooltip: 'switch to the next egress proxy', enabled: true, seqID: MENU.ROTATE },
    { title: auto ? '✓ Auto-start on login' : 'Enable auto-start on login', tooltip: 'run on OS startup', enabled: true, seqID: MENU.AUTOSTART },
    { title: 'Quit', tooltip: 'stop the proxy and exit', enabled: true, seqID: MENU.QUIT },
  ];
}

/** macOS / Linux tray via the `systray` package (pure Node, no Electron). */
function initUnixTray(opts: TrayOptions): TrayHandle | null {
  let SysTray: any;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    SysTray = require('systray').default ?? require('systray');
  } catch {
    return null;
  }
  const items = menuItems(opts.port).map((i) => ({ ...i, checked: false }));
  let tray: any;
  try {
    tray = new SysTray({
      menu: { icon: iconBase64(), title: 'opencode-max', tooltip: `opencode-max :${opts.port}`, items },
      debug: false,
      copyDir: true,
    });
  } catch {
    return null;
  }
  const ui = {
    refreshAutostart: () => {
      const auto = isAutoStartEnabled();
      const item = { title: auto ? '✓ Auto-start on login' : 'Enable auto-start on login', tooltip: 'run on OS startup', checked: false, enabled: true, seqID: MENU.AUTOSTART };
      try {
        tray.sendAction({ type: 'update-item', item, seqId: MENU.AUTOSTART });
      } catch {
        /* ignore */
      }
    },
  };
  tray.onClick((action: { seqID?: number }) => {
    if (typeof action?.seqID === 'number') handleClick(action.seqID, opts, ui);
  });
  tray.ready?.(() => undefined);
  return { kill: () => { try { tray.kill(); } catch { /* ignore */ } }, refreshAutostartItem: ui.refreshAutostart };
}

/** Windows tray via PowerShell NotifyIcon (no binaries, AV-safe). JSON protocol over stdio. */
function initWindowsTray(opts: TrayOptions): TrayHandle | null {
  const scriptPath = resourcePath('tray', 'win-tray.ps1');
  const iconPath = resourcePath('public', 'icon.png');
  if (!fs.existsSync(scriptPath)) return null;
  let ps: ChildProcess;
  try {
    ps = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', scriptPath, '-Tooltip', `opencode-max :${opts.port}`, '-IconPath', iconPath], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    return null;
  }
  const send = (cmd: unknown): void => {
    try {
      if (ps.stdin?.writable) ps.stdin.write(JSON.stringify(cmd) + '\n', 'utf8');
    } catch {
      /* ignore */
    }
  };
  const ui = {
    refreshAutostart: () => {
      const auto = isAutoStartEnabled();
      send({ action: 'update-item', index: MENU.AUTOSTART, title: auto ? '✓ Auto-start on login' : 'Enable auto-start on login', enabled: true });
    },
  };
  for (const item of menuItems(opts.port)) {
    send({ action: 'add-item', index: item.seqID, title: item.title, enabled: item.enabled });
  }
  const rl = readline.createInterface({ input: ps.stdout as NodeJS.ReadableStream });
  rl.on('line', (line: string) => {
    try {
      const evt = JSON.parse(line) as { type?: string; index?: number };
      if (evt.type === 'click' && typeof evt.index === 'number') handleClick(evt.index, opts, ui);
    } catch {
      /* ignore non-JSON lines */
    }
  });
  ps.on('error', () => undefined);
  ps.stderr?.on('data', () => undefined);
  return {
    kill: () => {
      send({ action: 'kill' });
      setTimeout(() => {
        try {
          if (!ps.killed) ps.kill();
        } catch {
          /* ignore */
        }
      }, 800);
    },
    refreshAutostartItem: ui.refreshAutostart,
  };
}

/**
 * Initialize the system tray. Returns null when unsupported (headless Linux,
 * missing deps, …) — the server keeps running in the terminal instead.
 */
export function initTray(opts: TrayOptions): TrayHandle | null {
  if (!isTraySupported()) return null;
  try {
    if (process.platform === 'win32') return initWindowsTray(opts);
    return initUnixTray(opts);
  } catch {
    return null;
  }
}
