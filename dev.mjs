import { spawn } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';

const PROJECT_DIRECTORY = new URL('.', import.meta.url);
const WATCHED_EXTENSIONS = new Set(['.mjs', '.js', '.html', '.css']);
const POLL_INTERVAL_MILLISECONDS = 600;

let serverProcess;
let restarting = false;
let previousSnapshot = new Map();

async function sourceSnapshot() {
  const entries = await readdir(PROJECT_DIRECTORY, { recursive: true, withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && WATCHED_EXTENSIONS.has(extname(entry.name)))
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((path) => !path.includes('/node_modules/') && !path.includes('/.git/'));
  const snapshot = new Map();
  await Promise.all(files.map(async (path) => {
    const fileStat = await stat(path);
    snapshot.set(path, `${fileStat.mtimeMs}:${fileStat.size}`);
  }));
  return snapshot;
}

function snapshotChanged(previous, current) {
  if (previous.size !== current.size) return true;
  return [...current].some(([path, signature]) => previous.get(path) !== signature);
}

function startServer() {
  serverProcess = spawn(process.execPath, ['server.mjs'], {
    cwd: PROJECT_DIRECTORY,
    env: process.env,
    stdio: 'inherit',
  });
  serverProcess.once('exit', (code, signal) => {
    if (!restarting && code && signal !== 'SIGTERM') {
      console.error(`本地服务异常退出：code=${code} signal=${signal || '-'}`);
    }
  });
}

async function restartServer() {
  if (restarting) return;
  restarting = true;
  console.log('检测到代码变化，正在热重载本地服务…');
  const oldProcess = serverProcess;
  if (oldProcess && oldProcess.exitCode === null) {
    await new Promise((resolve) => {
      oldProcess.once('exit', resolve);
      oldProcess.kill('SIGTERM');
    });
  }
  startServer();
  restarting = false;
}

async function pollChanges() {
  try {
    const currentSnapshot = await sourceSnapshot();
    if (previousSnapshot.size && snapshotChanged(previousSnapshot, currentSnapshot)) await restartServer();
    previousSnapshot = currentSnapshot;
  } catch (error) {
    console.error(`热更新检查失败：${error.message}`);
  }
}

async function shutdown() {
  if (serverProcess && serverProcess.exitCode === null) serverProcess.kill('SIGTERM');
  process.exit(0);
}

previousSnapshot = await sourceSnapshot();
startServer();
setInterval(pollChanges, POLL_INTERVAL_MILLISECONDS);
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
