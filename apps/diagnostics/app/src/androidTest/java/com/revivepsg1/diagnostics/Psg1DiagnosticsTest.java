package com.revivepsg1.diagnostics;

import static org.junit.Assert.assertTrue;

import android.app.Instrumentation;
import android.content.Context;
import android.content.pm.PackageManager;
import android.hardware.biometrics.BiometricManager;
import android.hardware.input.InputManager;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.net.ConnectivityManager;
import android.net.NetworkCapabilities;
import android.net.wifi.WifiManager;
import android.os.Bundle;
import android.os.StatFs;
import android.view.InputDevice;
import android.view.KeyEvent;
import android.view.MotionEvent;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import java.util.ArrayList;
import java.util.List;

import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public final class Psg1DiagnosticsTest {
    private static final long MIN_FREE_STORAGE_BYTES = 512L * 1024L * 1024L;

    @Test
    public void reportRequiredCapabilities() throws Exception {
        Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        Context context = instrumentation.getTargetContext();

        InputReport input = inspectControls(context);
        boolean wifi = inspectWifi(context);
        boolean audio = inspectAudio(context);
        boolean storage = new StatFs(context.getDataDir().getAbsolutePath()).getAvailableBytes()
                >= MIN_FREE_STORAGE_BYTES;
        boolean packages = packageEnabled(context, "com.aurora.store")
                && packageEnabled(context, "com.retroarch.aarch64");
        boolean playCatalog = packages;
        boolean fingerprint = inspectFingerprint(context);

        DiagnosticEvaluation evaluation = new DiagnosticEvaluation(
                input.pass, wifi, audio, storage, packages, playCatalog, fingerprint);
        String report = evaluation.toMachineJson().replace("}",
                ",\"inputDevices\":" + input.deviceCount
                        + ",\"supportedControlKeys\":" + input.supportedKeyCount + "}");
        Bundle status = new Bundle();
        status.putString("stream", (evaluation.requiredCapabilitiesPass()
                ? "REVIVE_DIAGNOSTICS_PASS " : "REVIVE_DIAGNOSTICS_FAIL ") + report);
        status.putString("revive_report", report);
        instrumentation.sendStatus(2, status);

        assertTrue("Required PSG1 diagnostics failed: " + report, evaluation.requiredCapabilitiesPass());
    }

    private static InputReport inspectControls(Context context) {
        InputManager manager = context.getSystemService(InputManager.class);
        int[] requiredKeys = {
                KeyEvent.KEYCODE_BUTTON_A, KeyEvent.KEYCODE_BUTTON_B,
                KeyEvent.KEYCODE_BUTTON_X, KeyEvent.KEYCODE_BUTTON_Y,
                KeyEvent.KEYCODE_BUTTON_L1, KeyEvent.KEYCODE_BUTTON_R1,
                KeyEvent.KEYCODE_BUTTON_START, KeyEvent.KEYCODE_BUTTON_SELECT
        };
        boolean[] found = new boolean[requiredKeys.length];
        List<InputDevice> controllers = new ArrayList<>();
        for (int id : manager.getInputDeviceIds()) {
            InputDevice device = manager.getInputDevice(id);
            if (device == null || device.isVirtual()) continue;
            int sources = device.getSources();
            if ((sources & InputDevice.SOURCE_GAMEPAD) == InputDevice.SOURCE_GAMEPAD
                    || (sources & InputDevice.SOURCE_JOYSTICK) == InputDevice.SOURCE_JOYSTICK
                    || (sources & InputDevice.SOURCE_DPAD) == InputDevice.SOURCE_DPAD) {
                controllers.add(device);
                boolean[] deviceKeys = device.hasKeys(requiredKeys);
                for (int i = 0; i < found.length; i++) found[i] |= deviceKeys[i];
            }
        }
        int supported = 0;
        for (boolean value : found) if (value) supported++;
        boolean requiredAxes = false;
        for (InputDevice controller : controllers) {
            requiredAxes |= hasAxis(controller, MotionEvent.AXIS_HAT_X)
                    && hasAxis(controller, MotionEvent.AXIS_HAT_Y)
                    && hasAxis(controller, MotionEvent.AXIS_X)
                    && hasAxis(controller, MotionEvent.AXIS_Y)
                    && hasAxis(controller, MotionEvent.AXIS_Z)
                    && hasAxis(controller, MotionEvent.AXIS_RZ);
        }
        return new InputReport(!controllers.isEmpty() && supported == requiredKeys.length && requiredAxes,
                controllers.size(), supported);
    }

    private static boolean hasAxis(InputDevice device, int axis) {
        return device.getMotionRange(axis, InputDevice.SOURCE_JOYSTICK) != null
                || device.getMotionRange(axis) != null;
    }

    private static boolean inspectWifi(Context context) {
        WifiManager wifi = context.getSystemService(WifiManager.class);
        ConnectivityManager connectivity = context.getSystemService(ConnectivityManager.class);
        NetworkCapabilities capabilities = connectivity.getNetworkCapabilities(connectivity.getActiveNetwork());
        return context.getPackageManager().hasSystemFeature(PackageManager.FEATURE_WIFI)
                && wifi != null && wifi.isWifiEnabled() && capabilities != null
                && capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)
                && capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED);
    }

    private static boolean inspectAudio(Context context) {
        AudioManager audio = context.getSystemService(AudioManager.class);
        if (audio == null) return false;
        for (AudioDeviceInfo device : audio.getDevices(AudioManager.GET_DEVICES_OUTPUTS)) {
            if (device.isSink()) return true;
        }
        return false;
    }

    private static boolean inspectFingerprint(Context context) {
        try {
            if (!context.getPackageManager().hasSystemFeature(PackageManager.FEATURE_FINGERPRINT)) return false;
            BiometricManager manager = context.getSystemService(BiometricManager.class);
            return manager != null && manager.canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG)
                    != BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE;
        } catch (SecurityException optionalPermissionUnavailable) {
            return false;
        }
    }

    private static boolean packageEnabled(Context context, String name) {
        try {
            return context.getPackageManager().getApplicationInfo(name, 0).enabled;
        } catch (PackageManager.NameNotFoundException ignored) {
            return false;
        }
    }

    private static final class InputReport {
        final boolean pass;
        final int deviceCount;
        final int supportedKeyCount;

        InputReport(boolean pass, int deviceCount, int supportedKeyCount) {
            this.pass = pass;
            this.deviceCount = deviceCount;
            this.supportedKeyCount = supportedKeyCount;
        }
    }
}
