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

/* tools:ignore 需要命名空间。
   ⚠ 必须放在「写入权限之后」判断：Capacitor 6.2 的模板根节点只有 xmlns:android，
   没有 xmlns:tools。之前这个判断写在了写权限之前，那时 xml 里还没有 tools:ignore，
   条件永远为假 → 命名空间永远补不上 → 构建时
   ManifestMerger2$MergeFailureException: Error parsing AndroidManifest.xml。
   （本地模拟工程的模板恰好带 tools，所以一直没复现出来。） */
if (xml.includes('tools:ignore') && !/xmlns:tools=/.test(xml)) {
  if (/<manifest[\s>]/.test(xml)) {
    xml = xml.replace(/<manifest(\s)/, '<manifest xmlns:tools="http://schemas.android.com/tools"$1');
  } else {
    xml = xml.replace('<manifest>', '<manifest xmlns:tools="http://schemas.android.com/tools">');
  }
  added.push('xmlns:tools');
}

/* Android 10（API 29）用 legacy 存储模型才能直接写公共文档目录；
   Android 11+ 该属性自动失效，由 MANAGE_EXTERNAL_STORAGE 接管，不冲突 */
if (!/android:requestLegacyExternalStorage=/.test(xml)) {
  xml = xml.replace('<application', '<application\n        android:requestLegacyExternalStorage="true"');
  added.push('requestLegacyExternalStorage');
}

/* FileProvider：openWithCalendar 要把 cache 里的 .ics 以 content:// 交给日历 App。
   Capacitor 模板默认就带一个 provider（authority = ${applicationId}.fileprovider），
   但 res/xml/file_paths.xml 只声明了 images 目录时 cache 里的文件会抛
   IllegalArgumentException: Failed to find configured root。
   这里做两件事：没有 provider 就补一个；有就确保 file_paths.xml 覆盖 cache。 */
const APP_ID_FOR_PROVIDER = (() => {
  try { return JSON.parse(fs.readFileSync('capacitor.config.json', 'utf8')).appId || 'com.shangantong.app'; }
  catch (e) { return 'com.shangantong.app'; }
})();
if (!/\.fileprovider/.test(xml)) {
  /* 按 </application> 前面的实际缩进对齐，生成出来的清单才像人手写的 */
  xml = xml.replace(/(\r?\n)([ \t]*)<\/application>/,
    (m, nl, ind) =>
      nl + ind + '    <provider' + nl +
      ind + '        android:name="androidx.core.content.FileProvider"' + nl +
      ind + '        android:authorities="' + APP_ID_FOR_PROVIDER + '.fileprovider"' + nl +
      ind + '        android:exported="false"' + nl +
      ind + '        android:grantUriPermissions="true">' + nl +
      ind + '        <meta-data' + nl +
      ind + '            android:name="android.support.FILE_PROVIDER_PATHS"' + nl +
      ind + '            android:resource="@xml/file_paths" />' + nl +
      ind + '    </provider>' + nl +
      ind + '</application>');
  added.push('FileProvider');
}
const XML_DIR = 'android/app/src/main/res/xml';
fs.mkdirSync(XML_DIR, { recursive: true });
const FILE_PATHS = '<?xml version="1.0" encoding="utf-8"?>\n' +
  '<!-- 由 native/patch-android.mjs 生成：FileProvider 可分享的目录白名单。\n' +
  '     cache 是导出日历用的临时目录，files 用于其它内部导出。 -->\n' +
  '<paths xmlns:android="http://schemas.android.com/apk/res/android">\n' +
  '    <cache-path name="cache" path="." />\n' +
  '    <files-path name="files" path="." />\n' +
  '    <external-files-path name="ext_files" path="." />\n' +
  '</paths>\n';
const fpFile = path.join(XML_DIR, 'file_paths.xml');
const fpOld = fs.existsSync(fpFile) ? fs.readFileSync(fpFile, 'utf8') : '';
/* 只补缺失的条目：模板可能还声明了 images 之类，整体覆盖会连带干掉别的功能 */
let fpNew = fpOld;
if (!fpOld) {
  fpNew = FILE_PATHS;
} else {
  if (!/<cache-path/.test(fpNew)) {
    fpNew = fpNew.replace('</paths>', '    <cache-path name="cache" path="." />\n</paths>');
  }
  if (!/<files-path/.test(fpNew)) {
    fpNew = fpNew.replace('</paths>', '    <files-path name="files" path="." />\n</paths>');
  }
}
if (fpNew !== fpOld) {
  fs.writeFileSync(fpFile, fpNew);
  console.log('[patch-android] 更新 ' + fpFile);
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

    /* ------------------------------------------------------------------
       直接把 .ics 交给日历 App（ACTION_VIEW + FileProvider）
       ------------------------------------------------------------------
       用户真正的抱怨不是「文件没存下来」，而是「存下来了日历不认」：
       在文件管理器里点 .ics，系统给出的常常是「用文本编辑器打开」，
       甚至直接提示无法打开。原因是文件管理器只会按扩展名猜，
       而 Android 的日历并不注册 .ics 的文件关联。

       这里换一条路：把内容写进 cache，用 FileProvider 生成 content:// URI，
       再以 text/calendar 显式发起 ACTION_VIEW。系统只会列出真正能处理
       日历数据的应用（Google 日历 / 系统日历 / 各家 ROM 日历），
       用户点一下就直接导入，全程不经过「文件管理」。

       不依赖任何存储权限，也不产生用户需要清理的垃圾（cache 会被系统回收）。 */
    @PluginMethod
    public void openWithCalendar(PluginCall call) {
        String filename = call.getString("filename", "calendar.ics");
        String data = call.getString("data", "");
        if (filename == null || filename.length() == 0) filename = "calendar.ics";
        if (data == null) data = "";
        try {
            java.io.File dir = new java.io.File(getContext().getCacheDir(), "cal");
            if (!dir.exists() && !dir.mkdirs()) {
                throw new java.io.IOException("无法创建缓存目录");
            }
            java.io.File f = new java.io.File(dir, filename);
            java.io.FileOutputStream fos = new java.io.FileOutputStream(f);
            fos.write(data.getBytes("UTF-8"));
            fos.flush();
            fos.close();

            Uri uri = androidx.core.content.FileProvider.getUriForFile(
                getContext(), getContext().getPackageName() + ".fileprovider", f);

            Intent i = new Intent(Intent.ACTION_VIEW);
            i.setDataAndType(uri, "text/calendar");
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);

            JSObject r = new JSObject();
            try {
                getContext().startActivity(i);
            } catch (android.content.ActivityNotFoundException anf) {
                /* 手机上真没装日历（少见但不为零）：告诉上层，让 JS 退回「保存文件」 */
                r.put("ok", false);
                r.put("err", "NO_CALENDAR_APP");
                r.put("uri", uri.toString());
                call.resolve(r);
                return;
            }
            r.put("ok", true);
            r.put("uri", uri.toString());
            call.resolve(r);
        } catch (Throwable t) {
            call.reject("OPEN_CAL_FAILED: " + t.getMessage());
        }
    }

    /* ------------------------------------------------------------------
       系统「保存到…」对话框（SAF / ACTION_CREATE_DOCUMENT）
       ------------------------------------------------------------------
       WebView 里的 <a download> 在 Android 上是空操作，而直接往公共目录写文件
       又依赖「所有文件访问」这种特殊权限（用户开了也可能因 ROM 差异写不进去）。
       SAF 是 Google 从 Android 4.4 起就推荐的写法：用户自己选目录，
       系统负责落盘授权，写成功就一定能看见 —— 不看任何存储权限的脸色。

       回调在 onActivityResult，必须保留 pendingCall 等用户选完。 */
    private PluginCall pendingSave;
    private String pendingSaveContent;
    private static final int REQ_SAVE_DOC = 0x5A17;

    @PluginMethod
    public void saveToDownloads(PluginCall call) {
        String filename = call.getString("filename", "导出.txt");
        String data = call.getString("data", "");
        String mime = call.getString("mime", "application/octet-stream");
        if (filename == null || filename.length() == 0) filename = "导出.txt";
        if (data == null) data = "";
        this.pendingSave = call;
        this.pendingSaveContent = data;
        try {
            Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT);
            i.addCategory(Intent.CATEGORY_OPENABLE);
            i.setType(mime);
            i.putExtra(Intent.EXTRA_TITLE, filename);
            getActivity().startActivityForResult(i, REQ_SAVE_DOC);
        } catch (Throwable t) {
            PluginCall c = this.pendingSave;
            this.pendingSave = null;
            this.pendingSaveContent = null;
            if (c != null) c.reject("SAF_START_FAILED: " + t.getMessage());
        }
    }

    @Override
    public void handleOnActivityResult(int requestCode, int resultCode, Intent data) {
        super.handleOnActivityResult(requestCode, resultCode, data);
        if (requestCode != REQ_SAVE_DOC) return;
        PluginCall c = this.pendingSave;
        String content = this.pendingSaveContent;
        this.pendingSave = null;
        this.pendingSaveContent = null;
        if (c == null) return;

        JSObject ret = new JSObject();
        if (resultCode != android.app.Activity.RESULT_OK || data == null || data.getData() == null) {
            /* 用户按了返回：这是正常操作，不是错误 */
            ret.put("ok", false);
            ret.put("cancelled", true);
            ret.put("err", "已取消");
            c.resolve(ret);
            return;
        }
        Uri uri = data.getData();
        try {
            java.io.OutputStream os = getContext().getContentResolver().openOutputStream(uri);
            if (os == null) throw new java.io.IOException("openOutputStream 返回 null");
            os.write((content == null ? "" : content).getBytes("UTF-8"));
            os.flush();
            os.close();
            ret.put("ok", true);
            ret.put("uri", uri.toString());
            ret.put("where", "你刚才选择的文件夹（文件管理里能看到）");
            c.resolve(ret);
        } catch (Throwable t) {
            ret.put("ok", false);
            ret.put("err", "写入失败：" + t.getMessage());
            c.resolve(ret);
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

  /* Maven Central 对 GitHub runner 的共享出口限流，会返回
     "Received status code 429 from server: Too Many Requests"，
     导致 kotlin-stdlib / httpmime 之类的基础依赖都拉不下来，构建直接失败。
     在 google() / mavenCentral() 前面插一个镜像源（阿里云公共代理），
     命中镜像就不再走 Maven Central；镜像没有的条目仍会回落到原仓库。
     只插一次，幂等。 */
  const MIRROR = "        maven { url 'https://maven.aliyun.com/repository/public' }\n" +
                 "        maven { url 'https://maven.aliyun.com/repository/google' }\n" +
                 "        maven { url 'https://maven.aliyun.com/repository/gradle-plugin' }\n";
  if (!g.includes('maven.aliyun.com')) {
    // 两处 repositories { google() ... }：buildscript 与 allprojects
    g = g.replace(
      /repositories\s*\{\s*\n(\s*)google\(\)/g,
      (all, indent) => 'repositories {\n' + MIRROR + indent + 'google()'
    );
  }
  if (g !== before) fs.writeFileSync(ROOT_GRADLE, g);
  console.log('[patch-android] build.gradle AGP → 8.7.2' + (g.includes('maven.aliyun.com') ? ' + 阿里云镜像' : ''));
}

/* AGP 8.7.2 要求 Gradle ≥ 8.9，模板 wrapper 还是 8.2.1，不一起升会直接报
   "Minimum supported Gradle version is 8.9. Current version is 8.2.1"。
   这里改 distributionUrl 里的版本号（保留 -all 后缀）。 */
const WRAPPER = 'android/gradle/wrapper/gradle-wrapper.properties';
if (fs.existsSync(WRAPPER)) {
  let w = fs.readFileSync(WRAPPER, 'utf8');
  const before = w;
  w = w.replace(
    /(gradle-)(\d+\.\d+(?:\.\d+)?)(-(?:all|bin))?\.zip/,
    (all, a, ver, suffix) => a + '8.9' + (suffix || '-all') + '.zip'
  );
  if (w !== before) fs.writeFileSync(WRAPPER, w);
  console.log('[patch-android] gradle wrapper → 8.9');
}

/* -------------------- 3.5 版本号写进 APK -------------------- */
/* 每次构建的版本号来自仓库根目录的 version.json（CI 的 meta 作业就是读它）。
   必须落到 build.gradle，否则系统「应用信息」、崩溃日志、用户截图里
   永远显示模板默认的 1.0，出问题时根本分不清用户装的是哪一版。
   versionCode 要单调递增（Android 用它判断能否覆盖安装）：
   1.0.18 → 10018，1.1.0 → 10100。 */
const VER = (() => {
  try { return String(JSON.parse(fs.readFileSync('version.json', 'utf8')).version || '').trim(); }
  catch (e) { return ''; }
})();
const RG = 'android/app/build.gradle';
if (VER && /^\d+\.\d+\.\d+$/.test(VER) && fs.existsSync(RG)) {
  let g = fs.readFileSync(RG, 'utf8');
  const before = g;
  const [M, m2, p2] = VER.split('.').map(Number);
  const vcode = M * 10000 + m2 * 100 + p2;
  g = g.replace(/versionCode\s+\d+/, 'versionCode ' + vcode);
  g = g.replace(/versionName\s+"[^"]*"/, 'versionName "' + VER + '"');
  if (g !== before) fs.writeFileSync(RG, g);
  console.log('[patch-android] versionName ' + VER + ' / versionCode ' + vcode);
} else if (fs.existsSync(RG)) {
  console.warn('[patch-android] 未读到 version.json，跳过版本号写入');
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
if (VER && fs.existsSync(RG)) {
  const g2 = fs.readFileSync(RG, 'utf8');
  if (!g2.includes('versionName "' + VER + '"')) {
    console.error('[patch-android] versionName 未写入 build.gradle');
    fail = 1;
  }
}
/* 「添加到日历」依赖 FileProvider + cache 白名单，少一个就会在点按钮时
   IllegalArgumentException 崩掉，必须在这里卡住 */
if (!/\.fileprovider/.test(xml)) {
  console.error('[patch-android] AndroidManifest 缺少 FileProvider');
  fail = 1;
}
if (!fs.existsSync(fpFile) || !/<cache-path/.test(fs.readFileSync(fpFile, 'utf8'))) {
  console.error('[patch-android] file_paths.xml 缺少 cache-path');
  fail = 1;
}
if (!PLUGIN_JAVA.includes('openWithCalendar')) {
  console.error('[patch-android] 插件缺少 openWithCalendar 方法');
  fail = 1;
}
if (fail) process.exit(1);

console.log('[patch-android] 自检通过：' + NEED.length + ' 条权限 + NativeFix 插件 + legacy 存储 + 页面补丁');
