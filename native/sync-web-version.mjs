#!/usr/bin/env node
/* 把网页端 version.json 的版本号同步到三端构建仓。
 *
 * 为什么需要：网页端每次 `python build_cf.py` 自动 +1，三端 CI 有自己的
 * version.json 自动 +1，两套自增会慢慢错开，用户反馈「装的是哪一版」就对不上。
 * 这个脚本让「网页端」成为唯一真相：拿到网页端的版本号，一次改好三处。
 *
 * 用法：
 *   node native/sync-web-version.mjs 1.0.36
 *   WEB_VERSION=1.0.36 node native/sync-web-version.mjs
 *   node native/sync-web-version.mjs              # 自动找 ../web/version.json、web-version.json
 *
 * 只改版本号，不改依赖、脚本与构建流程；可重复执行（幂等）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function findVersion() {
  const arg = (process.argv[2] || process.env.WEB_VERSION || '').trim();
  if (arg) return arg;
  const candidates = [
    path.join(ROOT, 'web-version.json'),
    path.join(ROOT, '..', 'web', 'version.json'),
    path.join(ROOT, '..', 'shangantong-web', 'version.json'),
    path.join(ROOT, '..', '2026-11-07-15-07-57', 'version.json')
  ];
  for (const p of candidates) {
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (j && /^\d+\.\d+\.\d+$/.test(String(j.version || ''))) {
        console.log('[sync] 读取网页端版本：' + p);
        return String(j.version);
      }
    } catch (e) { }
  }
  return '';
}

function writeJson(rel, mutate) {
  const p = path.join(ROOT, rel);
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  const before = j.version;
  mutate(j);
  fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n', 'utf8');
  console.log('[sync] ' + rel + ': ' + (before || '-') + ' → ' + j.version);
}

const v = findVersion();
if (!/^\d+\.\d+\.\d+$/.test(v)) {
  console.error('[sync] 没拿到合法的网页端版本号（需要 MAJOR.MINOR.PATCH）');
  console.error('       node native/sync-web-version.mjs 1.0.36');
  process.exit(1);
}

const now = new Date().toISOString();
writeJson('version.json', j => {
  j.version = v;
  j.updatedAt = now;
});
writeJson('package.json', j => { j.version = v; });
writeJson(path.join('desktop', 'package.json'), j => { j.version = v; });
console.log('[sync] 三端版本号已对齐 V' + v);
