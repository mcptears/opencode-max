import { exec, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DIRNAME } from './paths.js';

const APP_NAME = 'opencode-max';
const APP_LABEL = 'com.opencode-max.autostart';

/**
 * Resolve the server entry point for autostart entries.
 * Prefers the built dist/index.js; falls back to src/index.ts (dev).
 */
export function getEntryPoint(): { node: string; script: string } | null {
  const here = DIRNAME;
  const distEntry = path.resolve(here, 'index.js');
  const srcEntry = path.resolve(here, '..', 'src', 'index.js');
  const tsEntry = path.resolve(here, '..', 'src', 'index.ts');
  for (const script of [distEntry, srcEntry, tsEntry]) {
    if (fs.existsSync(script)) return { node: process.execPath, script };
  }
  return null;
}

// ---------- macOS: LaunchAgent ----------
function macPlistPath(): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${APP_LABEL}.plist`);
}

function enableMacOS(): boolean {
  const entry = getEntryPoint();
  if (!entry) return false;
  const plist =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n` +
    `<plist version="1.0"><dict>\n` +
    `<key>Label</key><string>${APP_LABEL}</string>\n` +
    `<key>ProgramArguments</key><array><string>${entry.node}</string><string>${entry.script}</string><string>--tray</string></array>\n` +
    `<key>RunAtLoad</key><true/>\n<key>KeepAlive</key><true/>\n` +
    `<key>StandardOutPath</key><string>/tmp/opencode-max.log</string>\n` +
    `<key>StandardErrorPath</key><string>/tmp/opencode-max.log</string>\n` +
    `</dict></plist>\n`;
  try {
    fs.mkdirSync(path.dirname(macPlistPath()), { recursive: true });
    fs.writeFileSync(macPlistPath(), plist, { mode: 0o644 });
    exec(`launchctl load -w ${JSON.stringify(macPlistPath())}`, () => undefined);
    return true;
  } catch {
    return false;
  }
}

function disableMacOS(): boolean {
  try {
    exec(`launchctl unload -w ${JSON.stringify(macPlistPath())}`, () => undefined);
    if (fs.existsSync(macPlistPath())) fs.unlinkSync(macPlistPath());
    return true;
  } catch {
    return false;
  }
}

function isMacOSEnabled(): boolean {
  if (!fs.existsSync(macPlistPath())) return false;
  try {
    execSync(`launchctl list ${APP_LABEL}`, { stdio: 'ignore', timeout: 4000 });
    return true;
  } catch {
    return false;
  }
}

// ---------- Windows: Startup folder .vbs (hidden window) ----------
function winStartupPath(): string {
  const appData = process.env.APPDATA ?? '';
  return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', `${APP_NAME}.vbs`);
}

function enableWindows(): boolean {
  const entry = getEntryPoint();
  if (!entry) return false;
  const vbs =
    `Set ws = CreateObject("Wscript.Shell")\r\n` +
    `ws.Run "${entry.node} ${entry.script} --tray", 0, False\r\n`;
  try {
    fs.mkdirSync(path.dirname(winStartupPath()), { recursive: true });
    fs.writeFileSync(winStartupPath(), vbs, 'utf8');
    return true;
  } catch {
    return false;
  }
}

function disableWindows(): boolean {
  try {
    if (fs.existsSync(winStartupPath())) fs.unlinkSync(winStartupPath());
    return true;
  } catch {
    return false;
  }
}

// ---------- Linux: XDG autostart .desktop ----------
function linuxDesktopPath(): string {
  return path.join(os.homedir(), '.config', 'autostart', `${APP_NAME}.desktop`);
}

function enableLinux(): boolean {
  const entry = getEntryPoint();
  if (!entry) return false;
  const desktop =
    `[Desktop Entry]\nType=Application\nName=opencode-max\n` +
    `Comment=OpenCode Zen proxy (IP rotation + multi-account)\n` +
    `Exec=${entry.node} ${entry.script} --tray\n` +
    `Hidden=false\nX-GNOME-Autostart-enabled=true\n`;
  try {
    fs.mkdirSync(path.dirname(linuxDesktopPath()), { recursive: true });
    fs.writeFileSync(linuxDesktopPath(), desktop, { mode: 0o644 });
    return true;
  } catch {
    return false;
  }
}

function disableLinux(): boolean {
  try {
    if (fs.existsSync(linuxDesktopPath())) fs.unlinkSync(linuxDesktopPath());
    return true;
  } catch {
    return false;
  }
}

/** Enable run-on-login for the current OS. Returns true on success. */
export function enableAutoStart(): boolean {
  try {
    if (process.platform === 'darwin') return enableMacOS();
    if (process.platform === 'win32') return enableWindows();
    if (process.platform === 'linux') return enableLinux();
  } catch {
    /* autostart is best-effort */
  }
  return false;
}

export function disableAutoStart(): boolean {
  try {
    if (process.platform === 'darwin') return disableMacOS();
    if (process.platform === 'win32') return disableWindows();
    if (process.platform === 'linux') return disableLinux();
  } catch {
    /* ignore */
  }
  return false;
}

export function isAutoStartEnabled(): boolean {
  try {
    if (process.platform === 'darwin') return isMacOSEnabled();
    if (process.platform === 'win32') return fs.existsSync(winStartupPath());
    if (process.platform === 'linux') return fs.existsSync(linuxDesktopPath());
  } catch {
    /* ignore */
  }
  return false;
}

export function autostartSupported(): boolean {
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return false;
  return ['darwin', 'win32', 'linux'].includes(process.platform);
}

export function describeAutoStart(): string {
  if (process.platform === 'darwin') return `LaunchAgent ${APP_LABEL} (~/Library/LaunchAgents)`;
  if (process.platform === 'win32') return `Startup folder ${APP_NAME}.vbs (hidden window)`;
  if (process.platform === 'linux') return `XDG autostart ${APP_NAME}.desktop (~/.config/autostart)`;
  return 'unsupported on this OS';
}
