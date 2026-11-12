# R8 rules for release builds. Capacitor bridges plugin classes reflectively and
# via @CapacitorPlugin annotations, so those must survive shrinking.
-keep class com.getcapacitor.** { *; }
-keep @com.getcapacitor.annotation.CapacitorPlugin class * { *; }
-keep class * extends com.getcapacitor.Plugin { *; }
-keepclassmembers class * {
  @com.getcapacitor.PluginMethod public *;
}
-keep class io.ionic.** { *; }
-keepattributes *Annotation*, Signature, InnerClasses
-dontwarn org.slf4j.**
-dontwarn okhttp3.**

# Strip ALL Android log calls and standard stream stack traces from release
# binaries — prevents logcat from leaking search queries, .onion URLs,
# cookie values, or SOCKS5 auth details.
-assumenosideeffects class android.util.Log {
  public static boolean isLoggable(java.lang.String, int) return false;
  public static *** d(...);
  public static *** v(...);
  public static *** i(...);
  public static *** w(...);
  public static *** e(...);
  public static *** wtf(...);
  public static *** println(...);
}
-assumenosideeffects class java.lang.Throwable {
  public void printStackTrace();
}
-assumenosideeffects class java.io.PrintStream {
  public void println(...);
  public void print(...);
}
-assumenosideeffects class com.getcapacitor.Logger {
  public static *** verbose(...);
  public static *** debug(...);
  public static *** info(...);
  public static *** warn(...);
  public static *** error(...);
}
