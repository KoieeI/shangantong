#!/usr/bin/env node
/* 上岸通 · iOS 壳补齐（Info.plist 权限用途说明）
 *
 * 为什么必须有这个脚本：
 *   iOS 走的是「用途说明」而不是「清单权限」。录音、日历这类隐私能力
 *   一旦代码里发起申请而 Info.plist 缺对应的 NSxxxUsageDescription，
 *   系统不是弹窗询问，而是**直接杀掉进程**（TCC crash）。
 *   用户侧看到的现象就是「一点录音/导出日历 App 就闪退」。
 *
 * 覆盖的能力：
 *   NSMicrophoneUsageDescription              灵感速记录音
 *   NSCalendarsUsageDescription               iOS 16 及以前，读写日历
 *   NSCalendarsFullAccessUsageDescription     iOS 17+，完整访问日历
 *   NSCalendarsWriteOnlyAccessUsageDescription iOS 17+，仅写入（我们实际申请的就是这个，弹窗最轻）
 *   NSRemindersUsageDescription               iOS 16 及以前，提醒事项（插件 requestAllPermissions 会顺带申请）
 *   NSRemindersFullAccessUsageDescription     iOS 17+，同上
 *   UIFileSharingEnabled                      让「文件」App 能看到 App 的文稿目录（导出的备份就落在这里）
 *   LSSupportsOpeningDocumentsInPlace         允许在「文件」App 里就地打开/移动这些文件
 *
 * 幂等：重复执行只会更新文案，不会插入重复 key。
 * 用法：node native/patch-ios.mjs [Info.plist 路径]
 */
'use strict';

import fs from 'node:fs';
import path from 'node:path';

const PLIST =
  process.argv[2] || path.join('ios', 'App', 'App', 'Info.plist');

/* 文案要求：说清「用来做什么」+「数据留在哪」，审核和用户都看得懂。
   Apple 审核因为「描述过于笼统」被拒是很常见的，所以这里不写「需要权限」这种废话。 */
const STRINGS = {
  NSMicrophoneUsageDescription:
    '用于灵感速记的语音录入，把想到的内容直接说成文字笔记。录音只保存在本机，不会自动上传。',
  NSCalendarsUsageDescription:
    '用于把你添加的日程、重要日子和待办写入手机日历，并按设定的提前时间提醒。只写入你主动同步的条目。',
  NSCalendarsFullAccessUsageDescription:
    '用于把你添加的日程、重要日子和待办写入手机日历，并按设定的提前时间提醒。只写入你主动同步的条目。',
  NSCalendarsWriteOnlyAccessUsageDescription:
    '用于把你添加的日程、重要日子和待办写入手机日历，并按设定的提前时间提醒。不会读取你已有的日历内容。',
  NSRemindersUsageDescription:
    '用于把未完成的待办同步到提醒事项（可选功能，不使用不影响其它功能）。',
  NSRemindersFullAccessUsageDescription:
    '用于把未完成的待办同步到提醒事项（可选功能，不使用不影响其它功能）。'
};

const BOOLS = {
  UIFileSharingEnabled: true,
  LSSupportsOpeningDocumentsInPlace: true
};

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/* 已有 key 就替换值，没有就返回 null 交给调用方插入 */
function replaceValue(xml, key, valueXml) {
  const re = new RegExp(
    '(<key>' + key + '</key>\\s*)(<string>[\\s\\S]*?</string>|<true/>|<false/>|<array>[\\s\\S]*?</array>)'
  );
  if (!re.test(xml)) return null;
  return xml.replace(re, (_m, head) => head + valueXml);
}

function hasKey(xml, key) {
  return new RegExp('<key>' + key + '</key>').test(xml);
}

function main() {
  if (!fs.existsSync(PLIST)) {
    console.error(
      '[patch-ios] 找不到 ' + PLIST + '\n' +
      '  这个文件由 `npx cap add ios` 生成。请先执行：\n' +
      '    npx cap add ios && npx cap sync ios'
    );
    process.exit(1);
  }

  let xml = fs.readFileSync(PLIST, 'utf8');
  const before = xml;

  if (!/<plist[\s>]/.test(xml)) {
    console.error('[patch-ios] ' + PLIST + ' 看起来不是 XML 格式的 plist，已中止（避免改坏）');
    process.exit(1);
  }

  const added = [];
  const updated = [];

  for (const key of Object.keys(STRINGS)) {
    const valueXml = '<string>' + esc(STRINGS[key]) + '</string>';
    const replaced = replaceValue(xml, key, valueXml);
    if (replaced !== null) {
      if (replaced !== xml) updated.push(key);
      xml = replaced;
    } else {
      added.push(['<key>' + key + '</key>', valueXml]);
    }
  }

  for (const key of Object.keys(BOOLS)) {
    const valueXml = BOOLS[key] ? '<true/>' : '<false/>';
    const replaced = replaceValue(xml, key, valueXml);
    if (replaced !== null) {
      if (replaced !== xml) updated.push(key);
      xml = replaced;
    } else {
      added.push(['<key>' + key + '</key>', valueXml]);
    }
  }

  if (added.length) {
    /* 根 dict 的结束标签是文件里最后一个 </dict>（后面紧接 </plist>），
       用 rindex 定位，避免误插到嵌套 dict 里。 */
    const idx = xml.lastIndexOf('</dict>');
    if (idx < 0) {
      console.error('[patch-ios] 找不到根 <dict> 的结束标签，已中止');
      process.exit(1);
    }
    const lines = added
      .map(([k, v]) => '\t' + k + '\n\t' + v)
      .join('\n');
    xml = xml.slice(0, idx) + lines + '\n' + xml.slice(idx);
  }

  if (xml !== before) {
    fs.writeFileSync(PLIST, xml, 'utf8');
  }

  console.log('[patch-ios] ' + PLIST);
  if (added.length) console.log('  新增 ' + added.length + ' 项：' + added.map(a => a[0].replace(/<\/?key>/g, '')).join(', '));
  if (updated.length) console.log('  更新文案：' + updated.join(', '));
  if (!added.length && !updated.length) console.log('  已是目标状态，无需改动');

  /* 自检：缺任何一个都会在首次申请时闪退，宁可构建失败也不能出这种包 */
  const missing = [...Object.keys(STRINGS), ...Object.keys(BOOLS)].filter(k => !hasKey(xml, k));
  if (missing.length) {
    console.error('[patch-ios] 自检失败，仍缺少：' + missing.join(', '));
    process.exit(1);
  }
  console.log('  自检通过：' + (Object.keys(STRINGS).length + Object.keys(BOOLS).length) + ' 项全部就位');
}

main();
