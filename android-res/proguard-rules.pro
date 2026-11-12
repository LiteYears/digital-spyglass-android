# R8 rules for release builds. Capacitor bridges plugin classes reflectively and
# via @CapacitorPlugin annotations, so those must survive shrinking.
-keep class com.getcapacitor.** { *; }
-keep @com.getcapacitor.annotation.CapacitorPlugin class * { *; }
-keep class * extends com.getcapacitor.Plugin { *; }
-keepclassmembers class * {
  @com.getcapacitor.PluginMethod public *;
}
-keep class com.whitestein.securestorage.** { *; }
-keep class io.ionic.** { *; }
-keepattributes *Annotation*, Signature, InnerClasses
-dontwarn org.slf4j.**
-dontwarn okhttp3.**

# Strip Android log calls from release binaries.
-assumenosideeffects class android.util.Log {
  public static *** d(...);
  public static *** v(...);
  public static *** i(...);
}
