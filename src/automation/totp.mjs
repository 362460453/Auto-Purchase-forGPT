import { createHmac } from 'node:crypto';

export function normalizeTotpSecret(value) {
  const secret = String(value || '').replace(/\s/g, '').toUpperCase();
  if (!/^[A-Z2-7]{16,128}={0,6}$/.test(secret)) throw new Error('2FA Key 格式无效');
  return secret.replace(/=+$/, '');
}

export function generateTotp(value, now = Date.now()) {
  const secret = normalizeTotpSecret(value);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let buffer = 0;
  const bytes = [];
  for (const character of secret) {
    buffer = (buffer << 5) | alphabet.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 255);
    }
  }
  if (!Number.isFinite(now) || now < 0) throw new Error('本机时间无效');
  // 标准 TOTP：SHA-1、30 秒周期、6 位；密钥和验证码只在内存计算，不向第三方发送。
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 30000)));
  const digest = createHmac('sha1', Buffer.from(bytes)).update(counter).digest();
  const offset = digest[digest.length - 1] & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, '0');
}
