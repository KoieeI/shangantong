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
/* 权限清单：
   - POST_NOTIFICATIONS / SCHEDULE_EXACT_ALARM / RECEIVE_BOOT_COMPLETED / VIBRATE：通知与触感
   - READ_MEDIA_*（Android 13+ 媒体三件套）与 READ/WRITE_EXTERNAL_STORAGE（≤Android 12）：
     存储类权限。注意 Android 11+ 公共目录写入靠的是 scoped storage，
     App 导出走的是无需权限的 App 专属目录，这几条是给图片选择/系统文件器兜底 */
const NEED = [
  { name: 'android.permission.POST_NOTIFICATIONS' },
  { name: 'android.permission.SCHEDULE_EXACT_ALARM' },
  { name: 'android.permission.RECEIVE_BOOT_COMPLETED' },
  { name: 'android.permission.VIBRATE' },
  { name: 'android.permission.READ_MEDIA_IMAGES' },
  { name: 'android.permission.READ_MEDIA_VIDEO' },
  { name: 'android.permission.READ_MEDIA_AUDIO' },
  { name: 'android.permission.READ_EXTERNAL_STORAGE', maxSdk: 32 },
  { name: 'android.permission.WRITE_EXTERNAL_STORAGE', maxSdk: 29 }
];

if (!fs.existsSync(P)) {
  console.error('[patch-android] 找不到 ' + P + '（cap add android 没先跑？）');
  process.exit(1);
}

let xml = fs.readFileSync(P, 'utf8');
const added = [];

for (const perm of NEED) {
  if (xml.includes(`android:name="${perm.name}"`)) continue;
  const extra = perm.maxSdk ? ` android:maxSdkVersion="${perm.maxSdk}"` : '';
  const tag = `    <uses-permission android:name="${perm.name}"${extra} />\n`;
  if (xml.includes('<application')) {
    xml = xml.replace('<application', tag + '    <application');
  } else {
    xml = xml.replace('</manifest>', tag + '</manifest>');
  }
  added.push(perm.name + (perm.maxSdk ? '（≤API ' + perm.maxSdk + '）' : ''));
}

fs.writeFileSync(P, xml);
console.log('[patch-android] 新增权限 ' + (added.length ? added.join(', ') : '（无，已齐全）'));

/* 自检：必须全部在文件里，否则让 CI 红掉，而不是产出一个"装得上但不提醒"的包 */
const missing = NEED.filter(p => !xml.includes(`android:name="${p.name}"`));
if (missing.length) {
  console.error('[patch-android] 权限补丁失败: ' + missing.join(', '));
  process.exit(1);
}
console.log('[patch-android] ok');

/* 重跑标记 2026-11-06：上一轮 iOS 作业被运行器取消，Windows/Android 已通过 */
