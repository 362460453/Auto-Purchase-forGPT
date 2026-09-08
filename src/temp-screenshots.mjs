import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const screenshotDirectory = fileURLToPath(new URL('../data/screenshots/', import.meta.url));

export async function clearTemporaryScreenshots() {
  // 截图只给当前运行会话复制，关闭本地服务后立刻删掉，不进 git、不长期留 Billing 页面。
  await rm(screenshotDirectory, { recursive: true, force: true });
}
