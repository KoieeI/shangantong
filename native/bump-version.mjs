#!/usr/bin/env node
/* 版本号唯一入口。
 *
 * 规则：MAJOR.MINOR.PATCH，每次自动 PATCH + 1；PATCH 满 100 进 MINOR。
 * 只在「构建成功之后」写盘，所以 version.json 里始终是「本次要发的版本」，
 * 下次构建自动用 +1 之后的版本 —— 不需要人工改，也不会出现两次发布同号覆盖。
 *
 * 用法：
 *   node native/bump-version.mjs           打印当前版本
 *   node native/bump-version.mjs --next    打印下一个版本（不写盘）
 *   node native/bump-version.mjs --bump    把 version.json 写成下一个版本
 *   node native/bump-version.mjs --quiet   静默模式（CI 用）
 *   node native/bump-version.mjs --names   打印三端产物文件名（便于本机对拍）
 *
 * CI 里还会把 version / next / 三端文件名写进 $GITHUB_OUTPUT，供其他 job 读取。 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(HERE, '..', 'version.json');
const ARGS = process.argv.slice(2);
const has = f => ARGS.includes(f);

function read() {
  const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const v = String(j.version || '').trim();
  if (!/^\d+\.\d+\.\d+$/.test(v)) {
    console.error('version.json 里的 version 不是 MAJOR.MINOR.PATCH：' + JSON.stringify(v));
    process.exit(1);
  }
  return { json: j, version: v };
}

function nextOf(v) {
  let [a, b, c] = v.split('.').map(Number);
  c += 1;
  if (c >= 100) { c = 0; b += 1; }
  if (b >= 100) { b = 0; a += 1; }
  return a + '.' + b + '.' + c;
}

/* 三端产物命名：统一小写、端名在前、版本带 v，扩展名保持各平台惯例。
   Release 里按文件名排序时，同一版本的三端会自动挨在一起。 */
function names(v) {
  return {
    web: 'shangantong-web-v' + v + '.zip',
    android: 'shangantong-android-v' + v + '.apk',
    ios: 'shangantong-ios-v' + v + '.ipa'
  };
}

const { json, version } = read();
const next = nextOf(version);

if (has('--bump')) {
  json.version = next;
  json.updatedAt = new Date().toISOString();
  fs.writeFileSync(FILE, JSON.stringify(json, null, 2) + '\n', 'utf8');
  if (!has('--quiet')) console.log('version.json: ' + version + ' → ' + next);
} else if (has('--next')) {
  console.log(next);
} else if (has('--names')) {
  const n = names(version);
  Object.keys(n).forEach(k => console.log(k + ': ' + n[k]));
} else if (!has('--quiet')) {
  console.log(version);
}

/* GitHub Actions：把结果写到 $GITHUB_OUTPUT，后续 job 用 needs.meta.outputs.version 取 */
if (process.env.GITHUB_OUTPUT) {
  const n = names(version);
  fs.appendFileSync(process.env.GITHUB_OUTPUT,
    'version=' + version + '\n' +
    'next=' + next + '\n' +
    'tag=v' + version + '\n' +
    'web_name=' + n.web + '\n' +
    'android_name=' + n.android + '\n' +
    'ios_name=' + n.ios + '\n', 'utf8');
}
