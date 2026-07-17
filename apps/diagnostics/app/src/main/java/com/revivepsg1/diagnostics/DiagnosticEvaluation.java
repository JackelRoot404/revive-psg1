package com.revivepsg1.diagnostics;

/** Pure evaluation policy shared by instrumentation and local unit tests. */
public final class DiagnosticEvaluation {
    public final boolean controls;
    public final boolean wifi;
    public final boolean audio;
    public final boolean storage;
    public final boolean playStore;
    public final boolean playCatalog;
    public final boolean fingerprintAvailable;

    public DiagnosticEvaluation(
            boolean controls,
            boolean wifi,
            boolean audio,
            boolean storage,
            boolean playStore,
            boolean playCatalog,
            boolean fingerprintAvailable) {
        this.controls = controls;
        this.wifi = wifi;
        this.audio = audio;
        this.storage = storage;
        this.playStore = playStore;
        this.playCatalog = playCatalog;
        this.fingerprintAvailable = fingerprintAvailable;
    }

    public boolean requiredCapabilitiesPass() {
        return controls && wifi && audio && storage && playStore && playCatalog;
    }

    public String toMachineJson() {
        return "{\"schema\":1,\"pass\":" + requiredCapabilitiesPass()
                + ",\"controls\":" + controls
                + ",\"wifi\":" + wifi
                + ",\"audio\":" + audio
                + ",\"storage\":" + storage
                + ",\"playStore\":" + playStore
                + ",\"playCatalog\":" + playCatalog
                + ",\"fingerprintAvailable\":" + fingerprintAvailable + "}";
    }
}
