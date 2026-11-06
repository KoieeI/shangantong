/* 给生成的 Android 工程补权限。
   为什么不在仓库里放 android/ 目录：CI 每次 cap add android 重新生成，避免把
   几百个生成文件塞进仓库；所以权限只能在生成之后、编译之前打补丁。
   缺了这几条的表现：
   - POST_NOTIFICATIONS   → Android 13+ 通知被系统静默丢弃，计时结束不响
   - SCHEDULE_EXACT_ALARM → 定时通知被延迟到「下次醒屏」才响，不准点
   - RECEIVE_BOOT_COMPLETED → 重启手机后已排的通知全丢
   - VIBRATE              → 触感反馈无效
   - RECORD_AUDIO         → 灵感速记录音拿不到权限（WebView 连弹窗都不弹）
   - READ/WRITE_CALENDAR  → 日程 / 重要日子 / 待办无法写进手机自带日历 */
import fs from 'node:fs';
import path from 'node:path';

const P = 'android/app/src/main/AndroidManifest.xml';
const G = 'android/variables.gradle';

/* 权限清单：
   - POST_NOTIFICATIONS / SCHEDULE_EXACT_ALARM / RECEIVE_BOOT_COMPLETED / VIBRATE：通知与触感
   - READ_MEDIA_*（Android 13+ 媒体三件套）与 READ/WRITE_EXTERNAL_STORAGE（≤Android 12）：
     存储类权限。注意 Android 11+ 公共目录写入靠的是 scoped storage，
     App 导出走的是无需权限的 App 专属目录，这几条是给图片选择/系统文件器兜底
   - RECORD_AUDIO / MODIFY_AUDIO_SETTINGS：录音
   - READ_CALENDAR / WRITE_CALENDAR：写系统日历 */
const NEED = [
  { name: 'android.permission.POST_NOTIFICATIONS' },
  { name: 'android.permission.SCHEDULE_EXACT_ALARM' },
  { name: 'android.permission.RECEIVE_BOOT_COMPLETED' },
  { name: 'android.permission.VIBRATE' },
  { name: 'android.permission.READ_MEDIA_IMAGES' },
  { name: 'android.permission.READ_MEDIA_VIDEO' },
  { name: 'android.permission.READ_MEDIA_AUDIO' },
  { name: 'android.permission.READ_EXTERNAL_STORAGE', maxSdk: 32 },
  { name: 'android.permission.WRITE_EXTERNAL_STORAGE', maxSdk: 29 },
  { name: 'android.permission.RECORD_AUDIO' },
  { name: 'android.permission.MODIFY_AUDIO_SETTINGS' },
  { name: 'android.permission.READ_CALENDAR' },
  { name: 'android.permission.WRITE_CALENDAR' }
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

/* compileSdk 对齐：
   @ebarooni/capacitor-calendar 6.x 用 compileSdk 35 编译并依赖 AGP 8.7，
   而 Capacitor 6 模板默认 compileSdk 34。库的 compileSdk 高于宿主时，
   AAPT/R8 会在合并资源阶段报错（AndroidManifest 里的 attribute 版本不足）。
   这里把宿主一起提到 35，两边版本一致，也让 AGP 走同一条 classpath。 */
const SDK = 35;
if (fs.existsSync(G)) {
  let g = fs.readFileSync(G, 'utf8');
  const before = g;
  g = g.replace(/(compileSdkVersion\s*=\s*)\d+/, `$1${SDK}`);
  g = g.replace(/(targetSdkVersion\s*=\s*)\d+/, (m, p1, off) => {
    const cur = Number((before.match(/targetSdkVersion\s*=\s*(\d+)/) || [])[1] || 0);
    return `${p1}${Math.max(cur, SDK)}`;
  });
  if (g !== before) {
    fs.writeFileSync(G, g);
    console.log('[patch-android] compileSdk/targetSdk 已对齐到 ' + SDK);
  } else {
    console.log('[patch-android] variables.gradle 无需调整');
  }
}

/* 自检：必须全部在文件里，否则让 CI 红掉，而不是产出一个"装得上但不提醒"的包 */
const missing = NEED.filter(p => !xml.includes(`android:name="${p.name}"`));
if (missing.length) {
  console.error('[patch-android] 权限补丁失败: ' + missing.join(', '));
  process.exit(1);
}
console.log('[patch-android] ok');
