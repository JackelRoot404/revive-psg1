use crate::runner::{run, wait_for};
use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{process::Command, time::Duration};

const DEVICE_ID_DOMAIN: &str = "revive-psg1:v1";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanResult {
    pub device_id: String,
    pub serial_verified: bool,
    pub product: String,
    pub model: String,
    pub board: String,
    pub hardware: String,
    pub build_fingerprint: String,
    pub build_incremental: String,
    pub android_api_level: u32,
    pub vendor_api_level: u32,
    pub battery_percent: u8,
    pub charging: bool,
    pub usb_stable: bool,
    pub host_bytes_available: u64,
    pub recovery_capable: bool,
    pub system_partition_bytes: u64,
}

pub fn scan() -> Result<ScanResult, String> {
    let adb_serial_1 = normalize(&run("adb", &["get-serialno"]).map_err(|e| e.to_string())?);
    if adb_serial_1.is_empty() || adb_serial_1 == "UNKNOWN" {
        return Err("ADB is not authorized on the PSG1".into());
    }
    let state = run("adb", &["get-state"]).map_err(|e| e.to_string())?;
    if !state.contains("device") {
        return Err("ADB device is not ready".into());
    }
    let props = Props::read()?;
    let battery = run("adb", &["shell", "dumpsys", "battery"]).map_err(|e| e.to_string())?;
    let battery_percent = capture_number(&battery, r"(?m)^\s*level:\s*(\d+)")
        .unwrap_or(0)
        .min(100) as u8;
    let charging = capture_number(&battery, r"(?m)^\s*status:\s*(\d+)")
        .map(|n| n == 2 || n == 5)
        .unwrap_or(false);
    let recovery_capable = run("adb", &["shell", "test", "-x", "/system/bin/reboot"]).is_ok();
    let host_path = std::env::current_exe().map_err(|e| e.to_string())?;
    let host_bytes_available = fs2::available_space(
        host_path
            .parent()
            .ok_or("Desktop executable path is invalid")?,
    )
    .map_err(|e| e.to_string())?;
    let usb_report = usb_report().unwrap_or_default();
    if !usb_report.to_ascii_uppercase().contains(&adb_serial_1) {
        return Err("USB descriptor serial could not be cross-checked with the ADB serial".into());
    }
    let adb_serial_2 = normalize(&run("adb", &["get-serialno"]).map_err(|e| e.to_string())?);
    let usb_stable = adb_serial_1 == adb_serial_2;
    if !usb_stable {
        return Err("USB serial changed during the scan".into());
    }

    run("adb", &["reboot", "bootloader"]).map_err(|e| e.to_string())?;
    let fastboot_output = wait_for(
        "fastboot",
        &["devices"],
        "PSG1 Fastboot",
        Duration::from_secs(35),
    )
    .map_err(|e| e.to_string())?;
    let fastboot_lines = fastboot_output
        .lines()
        .filter(|line| line.split_whitespace().nth(1) == Some("fastboot"))
        .collect::<Vec<_>>();
    if fastboot_lines.len() != 1 {
        let _ = run("fastboot", &["reboot"]);
        return Err("Connect exactly one PSG1 in Fastboot mode".into());
    }
    let fastboot_serial = normalize(
        fastboot_lines[0]
            .split_whitespace()
            .next()
            .unwrap_or_default(),
    );
    let system_partition_bytes = fastboot_partition_size("system")
        .or_else(|| fastboot_partition_size("system_a"))
        .unwrap_or(0);
    let serial_verified = adb_serial_1 == fastboot_serial;
    let reboot_result = run("fastboot", &["reboot"]);
    if !serial_verified {
        let _ = reboot_result;
        return Err("Fastboot, ADB, and USB serials do not match; licensing is blocked".into());
    }
    reboot_result.map_err(|e| e.to_string())?;
    let _ = wait_for(
        "adb",
        &["get-state"],
        "Android after read-only scan",
        Duration::from_secs(60),
    );

    let mut hasher = Sha256::new();
    hasher.update(DEVICE_ID_DOMAIN.as_bytes());
    hasher.update(fastboot_serial.as_bytes());
    Ok(ScanResult {
        device_id: hex::encode(hasher.finalize()),
        serial_verified,
        product: props.product,
        model: props.model,
        board: props.board,
        hardware: props.hardware,
        build_fingerprint: props.fingerprint,
        build_incremental: props.incremental,
        android_api_level: props.android_api_level,
        vendor_api_level: props.vendor_api_level,
        battery_percent,
        charging,
        usb_stable,
        host_bytes_available,
        recovery_capable,
        system_partition_bytes,
    })
}

#[derive(Default)]
struct Props {
    product: String,
    model: String,
    board: String,
    hardware: String,
    fingerprint: String,
    incremental: String,
    android_api_level: u32,
    vendor_api_level: u32,
}
impl Props {
    fn read() -> Result<Self, String> {
        let soc = prop_first(&["ro.soc.model", "ro.board.platform"])?;
        let revision = prop_first(&["ro.vendor.sdkversion", "ro.tyzc.version"])?;
        let board = if soc.is_empty() && revision.is_empty() {
            prop_first(&["ro.product.board", "ro.boot.hardware"])?
        } else {
            format!("{soc} {revision}").trim().to_string()
        };
        Ok(Self {
            product: prop_first(&[
                "ro.product.vendor.device",
                "ro.product.odm.device",
                "ro.product.device",
            ])?,
            model: prop_first(&[
                "ro.product.vendor.model",
                "ro.product.odm.model",
                "ro.product.model",
            ])?,
            board,
            hardware: prop_first(&["ro.soc.model", "ro.hardware", "ro.boot.hardware"])?,
            fingerprint: prop("ro.build.fingerprint")?,
            incremental: prop("ro.build.version.incremental")?,
            android_api_level: prop("ro.build.version.sdk")?.parse().unwrap_or(0),
            vendor_api_level: prop("ro.vendor.build.version.sdk")?.parse().unwrap_or(0),
        })
    }
}
fn prop_first(names: &[&str]) -> Result<String, String> {
    for name in names {
        let value = prop(name)?;
        if !value.is_empty() {
            return Ok(value);
        }
    }
    Ok(String::new())
}
fn prop(name: &str) -> Result<String, String> {
    run("adb", &["shell", "getprop", name])
        .map(|v| v.trim().to_string())
        .map_err(|e| e.to_string())
}
fn normalize(value: &str) -> String {
    value
        .trim()
        .replace(['-', '_', ' '], "")
        .to_ascii_uppercase()
}
fn capture_number(value: &str, pattern: &str) -> Option<u32> {
    Regex::new(pattern)
        .ok()?
        .captures(value)?
        .get(1)?
        .as_str()
        .parse()
        .ok()
}
fn fastboot_partition_size(partition: &str) -> Option<u64> {
    let key = format!("partition-size:{partition}");
    let output = run("fastboot", &["getvar", &key]).ok()?;
    let pattern = format!(r"(?im){}\s*:\s*(0x[0-9a-f]+|[0-9]+)", regex::escape(&key));
    let value = Regex::new(&pattern)
        .ok()?
        .captures(&output)?
        .get(1)?
        .as_str();
    value
        .strip_prefix("0x")
        .map(|hex| u64::from_str_radix(hex, 16).ok())
        .unwrap_or_else(|| value.parse().ok())
}

fn usb_report() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    let output = Command::new("system_profiler")
        .args(["SPUSBDataType", "-detailLevel", "mini"])
        .output();
    #[cfg(target_os = "windows")]
    let output = Command::new("powershell").args(["-NoProfile", "-Command", "Get-CimInstance Win32_PnPEntity | Where-Object {$_.PNPDeviceID -match 'VID_2207'} | Select-Object -ExpandProperty PNPDeviceID"]).output();
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let output = Command::new("lsusb")
        .args(["-v", "-d", "2207:0006"])
        .output();
    let output = output.map_err(|e| e.to_string())?;
    Ok(format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    )
    .replace(['-', '_', ' '], ""))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn normalized_serial_is_stable() {
        assert_eq!(normalize(" PSG1-TEST-0001-A "), "PSG1TEST0001A");
    }
    #[test]
    fn device_hash_has_expected_shape() {
        let mut h = Sha256::new();
        h.update(DEVICE_ID_DOMAIN);
        h.update(normalize("PSG1-TEST-0001-A"));
        assert_eq!(hex::encode(h.finalize()).len(), 64);
    }
}
