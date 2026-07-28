# Revive PSG1 diagnostics APK

This Android 15 instrumentation APK emits a machine-readable capability report
and fails closed when any required launch capability is missing. It checks the
physical controller face/shoulder/menu keys, D-pad HAT axes and both analog
sticks, validated Wi-Fi, audio output, free data storage, and the installed
Aurora Store and RetroArch packages. It does not require Google Mobile Services
or the Play Store. It reports fingerprint availability but does not require it.

It never reads an account name, email address, credential, wallet, factory
serial, Google Services Framework database, or account state.

Build prerequisites:

- JDK 17
- Android SDK platform 35
- Android build-tools 34.0.0 or newer
- Gradle 8.11.1 (use the checked-in wrapper)

Build and test:

```sh
export ANDROID_HOME=/path/to/android-sdk
./gradlew --no-daemon testDebugUnitTest assembleDebug assembleDebugAndroidTest
```

Run against an authorized PSG1:

```sh
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb install -r app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
adb shell am instrument -w com.revivepsg1.diagnostics.test/androidx.test.runner.AndroidJUnitRunner
```

Production CI must generate dependency locks, verify them with
`--write-locks`, sign the target APK with the offline release process, record
its signer SHA-256 in the release manifest, and reject an output containing a
debug certificate.
