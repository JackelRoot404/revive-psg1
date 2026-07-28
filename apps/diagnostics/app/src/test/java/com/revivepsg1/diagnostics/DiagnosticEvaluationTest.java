package com.revivepsg1.diagnostics;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class DiagnosticEvaluationTest {
    @Test
    public void fingerprintIsOptional() {
        DiagnosticEvaluation result = new DiagnosticEvaluation(true, true, true, true, true, true, false);
        assertTrue(result.requiredCapabilitiesPass());
        assertTrue(result.toMachineJson().contains("\"pass\":true"));
    }

    @Test
    public void missingConvenienceAppFailsClosed() {
        DiagnosticEvaluation result = new DiagnosticEvaluation(true, true, true, true, true, false, true);
        assertFalse(result.requiredCapabilitiesPass());
        assertTrue(result.toMachineJson().contains("\"playCatalog\":false"));
    }
}
