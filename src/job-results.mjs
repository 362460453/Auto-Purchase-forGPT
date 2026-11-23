import { randomUUID } from 'node:crypto';

export function createJobResults() {
  const jobs = new Map();
  return {
    create(jobId) {
      const token = randomUUID();
      jobs.set(jobId, { token, rows: new Map() });
      return token;
    },
    capture(event) {
      const job = jobs.get(event.jobId);
      // 两种秘密分别合并，后续附加项状态更新不能清掉已取得的另一种结果。
      const sanitize = item => {
        const { twoFactorKey, cpaJson, invoiceFileName, ...safe } = item;
        const secrets = {};
        for (const [field, value] of Object.entries({twoFactorKey, cpaJson, invoiceFileName})) {
          if (typeof value !== 'string') continue;
          safe[`${field}Available`] = Boolean(value);
          secrets[field] = value;
        }
        if (job && Number.isInteger(item.index) && Object.keys(secrets).length) {
          job.rows.set(item.index, {...job.rows.get(item.index), index:item.index, ...secrets});
        }
        return safe;
      };
      // SSE 与日志只携带可用性；秘密仅凭当前批次随机令牌读取。
      const safe = sanitize(event);
      if (Array.isArray(safe.results)) safe.results = safe.results.map(sanitize);
      return safe;
    },
    read(jobId, token) {
      const job = jobs.get(jobId);
      if (!job || !token || token !== job.token) return null;
      return [...job.rows.values()];
    },
  };
}
