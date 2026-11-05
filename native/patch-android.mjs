/* 给生成的 Android 工程补权限。
   为什么不在仓库里放 android/ 目录：CI 每次 cap add android 重新生成，避免把
   几百个生成文件塞进仓库；所以权限只能在生成之后、编译之前打补丁。
   缺了这几条的表现：
   - POST_NOTIFICATIONS   → Android 13+ 通知被系统静默丢弃，计时结束不响
   - SCHEDULE_EXACT_ALARM → 定时通知被延迟到「下次醒屏」才响，不准点
   - RECEIVE_BOOT_COMPLETED → 重启手机后已排的通知全丢
   - VIBRATE              → 触感反馈无效 */
import fs from 'node:fs';
import path from 'node:path';

const P = 'android/app/src/main/AndroidManifest.xml';
const NEED = [
  'android.permission.POST_NOTIFICATIONS',
  'android.permission.SCHEDULE_EXACT_ALARM',
  'android.permission.RECEIVE_BOOT_COMPLETED',
  'android.permission.VIBRATE'
];

if (!fs.existsSync(P)) {
  console.error('[patch-android] 找不到 ' + P + '（cap add android 没先跑？）');
  process.exit(1);
}

let xml = fs.readFileSync(P, 'utf8');
const added = [];

for (const perm of NEED) {
  if (xml.includes(`android:name="${perm}"`)) continue;
  const tag = `    <uses-permission android:name="${perm}" />\n`;
  if (xml.includes('<application')) {
    xml = xml.replace('<application', tag + '    <application');
  } else {
    xml = xml.replace('</manifest>', tag + '</manifest>');
  }
  added.push(perm);
}

fs.writeFileSync(P, xml);
console.log('[patch-android] 新增权限 ' + (added.length ? added.join(', ') : '（无，已齐全）'));

/* 自检：必须全部在文件里，否则让 CI 红掉，而不是产出一个"装得上但不提醒"的包 */
const missing = NEED.filter(p => !xml.includes(`android:name="${p}"`));
if (missing.length) {
  console.error('[patch-android] 权限补丁失败: ' + missing.join(', '));
  process.exit(1);
}
console.log('[patch-android] ok');
