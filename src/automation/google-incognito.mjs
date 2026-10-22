import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import net from 'node:net';

function chromeExecutable() {
  if (process.env.GOOGLE_CHROME_PATH) return process.env.GOOGLE_CHROME_PATH;
  if (process.platform === 'darwin') return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (process.platform === 'win32') return process.env['PROGRAMFILES']
    ? join(process.env['PROGRAMFILES'], 'Google', 'Chrome', 'Application', 'chrome.exe')
    : 'chrome.exe';
  return 'google-chrome';
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function waitForDevTools(port, timeoutMilliseconds = 30000) {
  const deadline = Date.now() + timeoutMilliseconds;
  let lastError;
  while (Date.now() <= deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return response.json();
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`谷歌无痕浏览器调试端口未就绪${lastError ? `：${lastError.message}` : ''}`);
}

export async function startGoogleIncognitoBrowser() {
  const executable = chromeExecutable();
  const port = await freePort();
  const profileDirectory = await mkdtemp(join(tmpdir(), 'gpt-upgrade-incognito-'));
  const child = spawn(executable, [
    '--incognito',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDirectory}`,
    '--no-first-run',
    '--no-default-browser-check',
    'https://chatgpt.com/',
  ], { detached: false, stdio: 'ignore' });
  try {
    const version = await waitForDevTools(port);
    return {
      serialNumber: '',
      debugPort: String(port),
      browserWs: version.webSocketDebuggerUrl || '',
      process: child,
      profileDirectory,
    };
  } catch (error) {
    child.kill('SIGTERM');
    await rm(profileDirectory, { recursive: true, force: true });
    throw new Error(`无法启动谷歌无痕浏览器：${error.message}`);
  }
}

export async function stopGoogleIncognitoBrowser(profile) {
  try { profile?.process?.kill('SIGTERM'); } catch {}
  if (profile?.profileDirectory) {
    await rm(profile.profileDirectory, { recursive: true, force: true }).catch(() => {});
  }
}
