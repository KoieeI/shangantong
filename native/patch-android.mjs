/* 给生成的 Android 工程打补丁。
   为什么不在仓库里放 android/ 目录：CI 每次 cap add android 重新生成，避免把
   几百个生成文件塞进仓库；所以权限只能在生成之后、编译之前打补丁。

   本脚本做四件事：
   1) 补 uses-permission（通知 / 存储 / 录音 / 日历 / 所有文件访问）；
   2) 给 <application> 打开 requestLegacyExternalStorage（Android 10 写公共目录用）；
   3) 注入 NativeFixPlugin.java 并在 MainActivity 里注册（状态栏真实尺寸 + 所有文件访问授权页）；
   4) 在 styles.xml 里关闭 Android 15 的强制 edge-to-edge（否则顶栏压在状态栏下面点不到）。

   缺了对应项的表现：
   - POST_NOTIFICATIONS      → Android 13+ 通知被静默丢弃，计时结束不响
   - SCHEDULE_EXACT_ALARM    → 定时通知被延迟到「下次醒屏」才响
   - RECEIVE_BOOT_COMPLETED  → 重启手机后已排的通知全丢
   - VIBRATE                 → 触感反馈无效
   - RECORD_AUDIO            → 录音直接 NotAllowedError，连授权框都不弹
   - READ/WRITE_CALENDAR     → 「写入手机日历」失败
   - MANAGE_EXTERNAL_STORAGE → 导出只能落到 App 专属目录，「下载」里找不到文件 */
import fs from 'node:fs';
import path from 'node:path';

const P = 'android/app/src/main/AndroidManifest.xml';
const STYLES = 'android/app/src/main/res/values/styles.xml';

/* 权限清单：
   - POST_NOTIFICATIONS / SCHEDULE_EXACT_ALARM / RECEIVE_BOOT_COMPLETED / VIBRATE：通知与触感
   - READ_MEDIA_*（Android 13+ 媒体三件套）与 READ/WRITE_EXTERNAL_STORAGE（≤Android 12）
   - RECORD_AUDIO / MODIFY_AUDIO_SETTINGS：灵感速记录音
   - READ_CALENDAR / WRITE_CALENDAR：写入系统日历
   - MANAGE_EXTERNAL_STORAGE：「所有文件访问」。Android 11+ 写 /sdcard/Download
     的唯一正路；它属于特殊权限，装好后需用户在系统页手动开（App 内已做一键跳转）。
     自用分发不受 Play 商店「敏感权限」审核限制。 */
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
  { name: 'android.permission.WRITE_CALENDAR' },
  {
    name: 'android.permission.MANAGE_EXTERNAL_STORAGE',
    attrs: ' tools:ignore="ScopedStorage"'
  }
];

if (!fs.existsSync(P)) {
  console.error('[patch-android] 找不到 ' + P + '（cap add android 没先跑？）');
  process.exit(1);
}

let xml = fs.readFileSync(P, 'utf8');

/* tools:ignore 需要命名空间；cap 模板一般已带，缺了就补上 */
if (xml.includes('tools:ignore') && !/xmlns:tools=/.test(xml)) {
  xml = xml.replace('<manifest ', '<manifest xmlns:tools="http://schemas.android.com/tools" ');
}

const added = [];
for (const perm of NEED) {
  if (xml.includes(`android:name="${perm.name}"`)) continue;
  const extra = (perm.maxSdk ? ` android:maxSdkVersion="${perm.maxSdk}"` : '') + (perm.attrs || '');
  const tag = `    <uses-permission android:name="${perm.name}"${extra} />\n`;
  if (xml.includes('<application')) {
    xml = xml.replace('<application', tag + '    <application');
  } else {
    xml = xml.replace('</manifest>', tag + '</manifest>');
  }
  added.push(perm.name.replace('android.permission.', '') + (perm.maxSdk ? '（≤API ' + perm.maxSdk + '）' : ''));
}

/* Android 10（API 29）用 legacy 存储模型才能直接写公共文档目录；
   Android 11+ 该属性自动失效，由 MANAGE_EXTERNAL_STORAGE 接管，不冲突 */
if (!/android:requestLegacyExternalStorage=/.test(xml)) {
  xml = xml.replace('<application', '<application\n        android:requestLegacyExternalStorage="true"');
  added.push('requestLegacyExternalStorage');
}

fs.writeFileSync(P, xml);
console.log('[patch-android] 新增：' + (added.length ? added.join(', ') : '（无，已齐全）'));

/* ------------------------- 1. 注入 NativeFix 插件 ------------------------- */
const cfgPath = 'capacitor.config.json';
let appId = 'com.shangantong.app';
try {
  appId = JSON.parse(fs.readFileSync(cfgPath, 'utf8')).appId || appId;
} catch (e) { }
const pkgDir = appId.replace(/\./g, '/');
const javaDir = path.join('android/app/src/main/java', pkgDir);
fs.mkdirSync(javaDir, { recursive: true });

const PLUGIN_JAVA = `package ${appId};

import android.content.Intent;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.Settings;
import android.view.View;
import android.view.WindowInsets;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 上岸通专用的小补丁插件（不依赖任何第三方 npm 包）。
 *
 * 解决两件 Web 层做不到的事：
 * 1) getInsets —— targetSdk 35 起 Android 15 强制 edge-to-edge，WebView 画到状态栏
 *    底下，而 Android WebView 不支持 env(safe-area-inset-top)，纯 CSS 修不好。
 *    这里把「状态栏高度」和「WebView 顶部的实际 y 坐标」一起交给 JS：
 *    y ≈ 状态栏高度说明已经避让，就不再加 padding，避免双重下移。
 * 2) 所有文件访问权限 —— Android 11+ 写 /sdcard/Download 必须由用户在系统页手动打开，
 *    只能靠原生 Intent 跳转（WebView 里的 intent:// 不被 Capacitor 解析）。
 */
@CapacitorPlugin(name = "NativeFix")
public class NativeFixPlugin extends Plugin {

    /** Android 11+：是否已授予「所有文件访问」。低版本用 legacy 存储，直接算有权限。 */
    private boolean granted() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            try {
                return Environment.isExternalStorageManager();
            } catch (Throwable t) {
                return false;
            }
        }
        return true;
    }

    @PluginMethod
    public void hasAllFilesAccess(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("granted", granted());
        ret.put("sdk", Build.VERSION.SDK_INT);
        call.resolve(ret);
    }

    @PluginMethod
    public void requestAllFilesAccess(PluginCall call) {
        if (granted()) {
            JSObject ret = new JSObject();
            ret.put("granted", true);
            call.resolve(ret);
            return;
        }

        String pkg = getContext().getPackageName();
        Intent intent = null;

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            // 首选：直接跳到本应用的「所有文件访问」页
            Intent appPage = new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION);
            appPage.setData(Uri.parse("package:" + pkg));
            if (appPage.resolveActivity(getContext().getPackageManager()) != null) {
                intent = appPage;
            } else {
                Intent list = new Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION);
                if (list.resolveActivity(getContext().getPackageManager()) != null) {
                    intent = list;
                }
            }
        }

        // 再退一步：应用详情页（国产 ROM 有些把入口收在这里）
        if (intent == null) {
            intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
            intent.setData(Uri.parse("package:" + pkg));
        }

        try {
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
        } catch (Throwable t) {
            call.reject("OPEN_SETTINGS_FAILED: " + t.getMessage());
            return;
        }

        JSObject ret = new JSObject();
        ret.put("granted", false);
        ret.put("opened", true);
        call.resolve(ret);
    }

    @PluginMethod
    public void getInsets(PluginCall call) {
        JSObject ret = new JSObject();
        float density = getContext().getResources().getDisplayMetrics().density;
        if (density <= 0) density = 1f;

        int statusBar = 0;
        int navBar = 0;
        try {
            View decor = getActivity().getWindow().getDecorView();
            WindowInsets insets = decor.getRootWindowInsets();
            if (insets != null) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    Insets i = insets.getInsets(
                        WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars()
                    );
                    statusBar = i.top;
                    navBar = i.bottom;
                } else {
                    statusBar = insets.getSystemWindowInsetTop();
                    navBar = insets.getSystemWindowInsetBottom();
                }
            }
        } catch (Throwable t) { }

        int webTop = 0;
        int webHeight = 0;
        try {
            View web = getBridge().getWebView();
            if (web != null) {
                int[] loc = new int[2];
                web.getLocationOnScreen(loc);
                webTop = loc[1];
                webHeight = web.getHeight();
            }
        } catch (Throwable t) { }

        ret.put("statusBar", Math.round(statusBar / density));
        ret.put("navBar", Math.round(navBar / density));
        ret.put("webTop", Math.round(webTop / density));
        ret.put("webHeight", Math.round(webHeight / density));
        ret.put("density", density);
        ret.put("allFiles", granted());
        ret.put("sdk", Build.VERSION.SDK_INT);
        call.resolve(ret);
    }

    /** 打开本应用系统设置页（权限被永久拒绝时的兜底入口） */
    @PluginMethod
    public void openAppSettings(PluginCall call) {
        try {
            Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
            i.setData(Uri.parse("package:" + getContext().getPackageName()));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
            call.resolve();
        } catch (Throwable t) {
            call.reject("OPEN_SETTINGS_FAILED: " + t.getMessage());
        }
    }
}
`;

const pluginPath = path.join(javaDir, 'NativeFixPlugin.java');
fs.writeFileSync(pluginPath, PLUGIN_JAVA);
console.log('[patch-android] 写入插件 ' + pluginPath);

/* --------------------- 2. MainActivity 注册插件 --------------------- */
/* 手动 registerPlugin 的插件同样会进 JS 侧 window.Capacitor.Plugins，
   因为 Capacitor 注入脚本时读的是运行时插件表，不是 capacitor.plugins.json。 */
const ACT_JAVA = path.join(javaDir, 'MainActivity.java');
const ACT_KT = path.join(javaDir, 'MainActivity.kt');

if (fs.existsSync(ACT_JAVA)) {
  const src = `package ${appId};

import android.os.Bundle;
import android.webkit.WebView;
import androidx.core.view.WindowCompat;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 必须早于 super.onCreate：Bridge 在 super 里就把插件表固化了
        registerPlugin(NativeFixPlugin.class);
        super.onCreate(savedInstanceState);
        // 双保险：让内容区避开系统栏。Android 15 上由 styles.xml 的 opt-out 兜住，
        // 这里对 14 及以下、以及部分国产 ROM 生效。
        try {
            WindowCompat.setDecorFitsSystemWindows(getWindow(), true);
        } catch (Throwable ignored) {
        }
        installWebPatch();
    }

    /**
     * 把 assets/public/patch.js 注入到每一个加载完成的页面。
     *
     * 为什么需要：App 用 server.url 远程加载网页，网页要更新得能写进那个域名；
     * 而该域名归属另一个运行时，当前账号改不动，换域名又会让 localStorage
     * （按 origin 隔离）里的打卡/笔记/待办全部读不到。所以把修复做成随包分发的
     * 补丁，在页面加载后注入：域名不变 → 数据不丢，补丁照样生效。
     *
     * patch.js 自带幂等与版本探测，远程站点将来更新了会自动让位。
     */
    private void installWebPatch() {
        try {
            final String patch = readAsset("public/patch.js");
            if (patch == null || patch.length() == 0) return;
            getBridge().addWebViewListener(new WebViewListener() {
                @Override
                public void onPageLoaded(WebView webView) {
                    try {
                        webView.evaluateJavascript(patch, null);
                    } catch (Throwable ignored) {
                    }
                }
            });
        } catch (Throwable ignored) {
        }
    }

    private String readAsset(String name) {
        InputStream is = null;
        try {
            is = getAssets().open(name);
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = is.read(buf)) > 0) bos.write(buf, 0, n);
            return new String(bos.toByteArray(), "UTF-8");
        } catch (Throwable t) {
            return null;
        } finally {
            try { if (is != null) is.close(); } catch (Throwable ignored) { }
        }
    }
}
`;
  fs.writeFileSync(ACT_JAVA, src);
  console.log('[patch-android] 重写 MainActivity.java（注册 NativeFix）');
} else if (fs.existsSync(ACT_KT)) {
  const src = `package ${appId}

import android.os.Bundle
import android.webkit.WebView
import androidx.core.view.WindowCompat
import com.getcapacitor.BridgeActivity
import com.getcapacitor.WebViewListener

class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(NativeFixPlugin::class.java)
        super.onCreate(savedInstanceState)
        try {
            WindowCompat.setDecorFitsSystemWindows(window, true)
        } catch (ignored: Throwable) {
        }
        installWebPatch()
    }

    private fun installWebPatch() {
        try {
            val patch = assets.open("public/patch.js").bufferedReader().use { it.readText() }
            if (patch.isEmpty()) return
            bridge.addWebViewListener(object : WebViewListener() {
                override fun onPageLoaded(webView: WebView) {
                    try { webView.evaluateJavascript(patch, null) } catch (ignored: Throwable) {}
                }
            })
        } catch (ignored: Throwable) {
        }
    }
}
`;
  fs.writeFileSync(ACT_KT, src);
  console.log('[patch-android] 重写 MainActivity.kt（注册 NativeFix）');
} else {
  console.error('[patch-android] 找不到 MainActivity.java / .kt');
  process.exit(1);
}

/* -------------------- 3. styles.xml 关闭强制 edge-to-edge -------------------- */
/* Android 15（API 35）对 targetSdk 35 的应用强制 edge-to-edge，WebView 直接铺到
   状态栏下面。windowOptOutEdgeToEdgeEnforcement 是官方给的退出开关（Android 16 起
   该开关会被移除，届时靠上面 getInsets 的像素补偿继续兜底）。 */
if (fs.existsSync(STYLES)) {
  let s = fs.readFileSync(STYLES, 'utf8');
  const before = s;
  if (!s.includes('windowOptOutEdgeToEdgeEnforcement')) {
    // 加到 AppTheme.NoActionBar 里（所有界面都继承它）
    const m = /<style\s+name="AppTheme\.NoActionBar"[^>]*>([\s\S]*?)<\/style>/.exec(s);
    if (m) {
      // 连 </style> 前面的换行缩进一起换掉，缩进才对得齐其它 <item>
      const block = m[0].replace(
        /\n\s*<\/style>$/,
        '\n        <item name="android:windowOptOutEdgeToEdgeEnforcement">true</item>\n    </style>'
      );
      s = s.replace(m[0], block);
    } else {
      s = s.replace('</resources>', '    <style name="AppTheme.NoActionBar">\n' + '        <item name="android:windowOptOutEdgeToEdgeEnforcement">true</item>\n' + '    </style>\n</resources>');
    }
  }
  if (s !== before) fs.writeFileSync(STYLES, s);
  console.log('[patch-android] styles.xml ' + (s !== before ? '已关闭强制 edge-to-edge' : '已是目标状态'));
}

/* -------------------- 3.5 提升 compileSdk 与 AGP -------------------- */
/* Capacitor 6.2 的 android 模板默认 compileSdk 34 + AGP 8.2.1，但它自己的运行时
   依赖 androidx.core:core / core-ktx 1.15.0，这两个 AAR 的 metadata 要求
   「编译目标 ≥ API 35」——版本对不上，Gradle 在 CheckAarMetadata 阶段直接失败：

     Dependency 'androidx.core:core:1.15.0' requires ... compile against version 35
     or later ... :app is currently compiled against android-34.

   这正是 CI 上 assembleDebug 挂掉的原因（本地无 Android SDK 复现不了）。
   一并把 AGP 升到 8.7.2（它是首个正式支持 compileSdk 35 的稳定版），
   compileSdk 提到 35；targetSdk 仍留 34，不为一个编译约束改变运行时行为。
   minSdk 22 不动。 */
const VARS = 'android/variables.gradle';
const ROOT_GRADLE = 'android/build.gradle';
if (fs.existsSync(VARS)) {
  let v = fs.readFileSync(VARS, 'utf8');
  const before = v;
  // 模板里是 compileSdkVersion = 34
  v = v.replace(/(compileSdkVersion\s*=\s*)\d+/, '$1' + '35');
  // 兼容新模板写法 compileSdk 35 / compileSdk = 35（不带 Version 后缀的那种）
  v = v.replace(/(?<!Version\s{0,3}=\s{0,3})(\bcompileSdk\s*=?\s*)(\d+)(?![\d.])/g, (all, p1) =>
    /Version/.test(p1) ? all : p1 + '35'
  );
  if (v !== before) fs.writeFileSync(VARS, v);
  console.log('[patch-android] variables.gradle compileSdk → 35');
}
if (fs.existsSync(ROOT_GRADLE)) {
  let g = fs.readFileSync(ROOT_GRADLE, 'utf8');
  const before = g;
  g = g.replace(
    /com\.android\.tools\.build:gradle:8\.\d+\.\d+/,
    'com.android.tools.build:gradle:8.7.2'
  );
  if (g !== before) fs.writeFileSync(ROOT_GRADLE, g);
  console.log('[patch-android] build.gradle AGP → 8.7.2');
}

/* -------------------- 4. 补丁脚本放进 assets -------------------- */
/* 远程站点改不动时，App 靠这个文件在页面加载后注入修复（详见 patch.js 顶部说明） */
const patchSrc = path.join('native', 'patch.js');
const assetsDir = 'android/app/src/main/assets/public';
if (!fs.existsSync(patchSrc)) {
  console.error('[patch-android] 缺少 native/patch.js');
  process.exit(1);
}
fs.mkdirSync(assetsDir, { recursive: true });
fs.copyFileSync(patchSrc, path.join(assetsDir, 'patch.js'));
console.log('[patch-android] 补丁已放入 assets/public/patch.js');

/* ------------------------------ 自检 ------------------------------ */
let fail = 0;
const miss = NEED.filter(p => !xml.includes(`android:name="${p.name}"`));
if (miss.length) {
  console.error('[patch-android] 权限补丁失败: ' + miss.map(x => x.name).join(', '));
  fail = 1;
}
if (!fs.existsSync(pluginPath)) {
  console.error('[patch-android] NativeFixPlugin.java 未写入');
  fail = 1;
}
const actFile = fs.existsSync(ACT_JAVA) ? ACT_JAVA : ACT_KT;
const actSrc = fs.readFileSync(actFile, 'utf8');
if (!actSrc.includes('registerPlugin(NativeFixPlugin')) {
  console.error('[patch-android] MainActivity 未注册 NativeFix');
  fail = 1;
}
const patchOut = path.join(assetsDir, 'patch.js');
if (!fs.existsSync(patchOut)) {
  console.error('[patch-android] 补丁未放进 assets');
  fail = 1;
}
if (!actSrc.includes('installWebPatch')) {
  console.error('[patch-android] MainActivity 未安装页面补丁');
  fail = 1;
}
if (!xml.includes('android:requestLegacyExternalStorage="true"')) {
  console.error('[patch-android] 缺少 requestLegacyExternalStorage');
  fail = 1;
}
if (fail) process.exit(1);

console.log('[patch-android] 自检通过：' + NEED.length + ' 条权限 + NativeFix 插件 + legacy 存储 + 页面补丁');
