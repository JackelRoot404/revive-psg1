use std::{
    collections::{BTreeMap, HashMap},
    fs,
    path::{Path, PathBuf},
    thread,
    time::Duration,
};

use base64::{engine::general_purpose::STANDARD, Engine};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use fs2::available_space;
use jsonwebtoken::{decode, Algorithm, DecodingKey, Validation};
use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    journal::{Journal, Stage},
    runner::{run, sanitize, wait_for_match},
};

const MIN_HOST_HEADROOM: u64 = 512 * 1024 * 1024;
const DEVICE_ID_DOMAIN: &str = "revive-psg1:v1";

#[derive(Debug, Deserialize)]
pub struct SignedDocument<T> {
    pub document: T,
    pub signature: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Profile {
    pub id: String,
    pub version: u32,
    #[serde(rename = "unlockCommand")]
    pub unlock_command: String,
    #[serde(rename = "partitionConstraints")]
    pub partition_constraints: HashMap<String, PartitionConstraint>,
    #[serde(rename = "diagnosticsCommand")]
    pub diagnostics_command: Vec<String>,
    #[serde(flatten)]
    pub signed_fields: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct PartitionConstraint {
    #[serde(rename = "minSize")]
    pub min_size: u64,
    #[serde(rename = "maxSize")]
    pub max_size: u64,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct Manifest {
    #[serde(rename = "releaseId")]
    pub release_id: String,
    #[serde(rename = "minimumInstallerVersion")]
    pub minimum_installer_version: String,
    #[serde(rename = "profileIds")]
    pub profile_ids: Vec<String>,
    pub artifacts: Vec<Artifact>,
    #[serde(flatten)]
    pub signed_fields: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct Artifact {
    pub id: String,
    pub kind: String,
    pub delivery: ArtifactDelivery,
    #[serde(rename = "objectKey")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub object_key: Option<String>,
    pub size: u64,
    pub sha256: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub component: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<CustomerArtifactSource>,
    #[serde(flatten)]
    pub signed_fields: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactDelivery {
    Private,
    CustomerSupplied,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct CustomerArtifactSource {
    pub label: String,
    #[serde(rename = "instructionsUrl")]
    pub instructions_url: String,
    #[serde(rename = "archiveFilenamePatterns")]
    pub archive_filename_patterns: Vec<String>,
    #[serde(rename = "archiveSize")]
    pub archive_size: u64,
    #[serde(rename = "archiveSha256")]
    pub archive_sha256: String,
    #[serde(rename = "extractedPath")]
    pub extracted_path: String,
}

#[derive(Debug, Deserialize)]
pub struct InstallRequest {
    pub device_id: String,
    pub license_token: String,
    pub confirmation: String,
    pub profile: SignedDocument<Profile>,
    pub manifest: SignedDocument<Manifest>,
    pub artifact_paths: HashMap<String, PathBuf>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PreflightReport {
    pub battery_percent: u8,
    pub charging: bool,
    pub host_bytes_available: u64,
    pub system_partition_bytes: u64,
    pub bootloader_already_unlocked: bool,
}

pub fn validate(request: &InstallRequest) -> Result<(), String> {
    if request.confirmation != "ERASE PSG1" {
        return Err("Exact wipe confirmation is required".into());
    }
    let release_key = option_env!("REVIVE_RELEASE_PUBLIC_KEY_B64").ok_or(
        "Production release verification key was not embedded; destructive commands remain locked",
    )?;
    verify_document(&request.profile, release_key)?;
    verify_document(&request.manifest, release_key)?;
    if !request
        .manifest
        .document
        .profile_ids
        .contains(&request.profile.document.id)
    {
        return Err("Release does not authorize this profile".into());
    }
    verify_license(&request.license_token, &request.device_id)?;
    ensure_minimum_installer_version(
        env!("CARGO_PKG_VERSION"),
        &request.manifest.document.minimum_installer_version,
    )?;
    for artifact in &request.manifest.document.artifacts {
        match artifact.delivery {
            ArtifactDelivery::Private if artifact.object_key.is_none() => {
                return Err(format!(
                    "Private artifact {} has no object key",
                    artifact.id
                ));
            }
            ArtifactDelivery::CustomerSupplied
                if artifact.kind != "system"
                    || artifact.component.as_deref() != Some("google_mobile_services")
                    || artifact.source.is_none()
                    || artifact.object_key.is_some() =>
            {
                return Err(format!(
                    "Customer-supplied artifact {} metadata is not allowlisted",
                    artifact.id
                ));
            }
            _ => {}
        }
        verify_artifact(artifact, artifact_path(request, artifact)?)?;
    }
    Ok(())
}

/// Run every check that can safely happen before the server closes the normal
/// refund window. This reboots through bootloader but never unlocks or flashes.
pub fn preflight(request: &InstallRequest) -> Result<PreflightReport, String> {
    validate(request)?;
    run("adb", &["version"]).map_err(|e| e.to_string())?;
    run("fastboot", &["--version"]).map_err(|e| e.to_string())?;
    wait_for_adb(Duration::from_secs(15), "authorized Android ADB")?;

    let devices = run("adb", &["devices"]).map_err(|e| e.to_string())?;
    let ready_devices = devices
        .lines()
        .filter(|line| line.ends_with("\tdevice"))
        .count();
    if ready_devices != 1 {
        return Err("Connect exactly one authorized Android device before continuing".into());
    }
    let serial_1 = run("adb", &["get-serialno"]).map_err(|e| e.to_string())?;
    thread::sleep(Duration::from_millis(750));
    let serial_2 = run("adb", &["get-serialno"]).map_err(|e| e.to_string())?;
    if serial_1.trim().is_empty() || serial_1.trim() != serial_2.trim() {
        return Err("USB identity was not stable during preflight".into());
    }
    verify_device_hash(serial_1.trim(), &request.device_id)?;

    let battery = run("adb", &["shell", "dumpsys", "battery"]).map_err(|e| e.to_string())?;
    let battery_percent = capture_number(&battery, r"(?m)^\s*level:\s*(\d+)")
        .unwrap_or(0)
        .min(100) as u8;
    let charging = capture_number(&battery, r"(?m)^\s*status:\s*(\d+)")
        .map(|status| status == 2 || status == 5)
        .unwrap_or(false);
    if battery_percent < 50 && !(charging && battery_percent >= 30) {
        return Err("PSG1 battery must be at least 50%, or at least 30% while charging".into());
    }
    run("adb", &["shell", "test", "-x", "/system/bin/reboot"]).map_err(|_| {
        "The installed recovery/Android environment cannot perform controlled reboots"
    })?;

    let artifact_directory = request
        .artifact_paths
        .values()
        .next()
        .and_then(|path| path.parent())
        .ok_or("Downloaded artifact directory is unavailable")?;
    let host_bytes_available = available_space(artifact_directory).map_err(|e| e.to_string())?;
    if host_bytes_available < MIN_HOST_HEADROOM {
        return Err(
            "The computer needs at least 512 MiB of free space for installation recovery data"
                .into(),
        );
    }

    let system = artifact(&request.manifest.document, "system")?;
    let limits = request
        .profile
        .document
        .partition_constraints
        .get("system")
        .ok_or("Signed profile lacks system partition constraints")?;
    if system.size < limits.min_size || system.size > limits.max_size {
        return Err("System image size violates the signed profile".into());
    }

    let bootloader_result: Result<(u64, bool), String> = (|| {
        run("adb", &["reboot", "bootloader"]).map_err(|e| e.to_string())?;
        wait_for_fastboot(Duration::from_secs(35), "PSG1 bootloader")?;
        verify_device_hash(&single_fastboot_serial()?, &request.device_id)?;
        let system_partition_bytes =
            read_partition_size("system").or_else(|_| read_partition_size("system_a"))?;
        if system_partition_bytes < limits.min_size || system_partition_bytes > limits.max_size {
            return Err("Current system partition size is outside the signed profile range".into());
        }
        Ok((system_partition_bytes, is_bootloader_unlocked()?))
    })();
    let reboot_result = run_single_fastboot(&["reboot"]);
    let (system_partition_bytes, bootloader_already_unlocked) = bootloader_result?;
    reboot_result?;
    wait_for_adb(Duration::from_secs(90), "Android after read-only preflight")?;

    Ok(PreflightReport {
        battery_percent,
        charging,
        host_bytes_available,
        system_partition_bytes,
        bootloader_already_unlocked,
    })
}

pub fn execute_prepared(request: InstallRequest, journal_path: &Path) -> Result<Journal, String> {
    let result = execute_inner(&request, journal_path);
    if let Err(error) = &result {
        if let Ok(Some(mut journal)) = Journal::load(journal_path) {
            if journal.stage != Stage::Complete {
                journal.mark_recovery_required(format!("Installation paused: {}", sanitize(error)));
                let _ = journal.save(journal_path);
                let _ = write_recovery_report(journal_path, &journal);
            }
        }
    }
    result
}

fn execute_inner(request: &InstallRequest, journal_path: &Path) -> Result<Journal, String> {
    let artifact_set_sha256 = artifact_set_sha256(&request.manifest.document.artifacts)?;
    let mut journal = match Journal::load(journal_path)? {
        Some(existing) if existing.device_id != request.device_id => {
            return Err("The recovery journal belongs to a different PSG1".into())
        }
        Some(existing) if existing.stage == Stage::Complete => {
            verify_journal_binding(&existing, request, &artifact_set_sha256)?;
            return Ok(existing);
        }
        Some(mut existing) => {
            verify_journal_binding(&existing, request, &artifact_set_sha256)?;
            existing.resume()?;
            existing
        }
        None => {
            let mut journal = Journal::new(request.device_id.clone());
            journal.release_id = Some(request.manifest.document.release_id.clone());
            journal.profile_id = Some(request.profile.document.id.clone());
            journal.profile_version = Some(request.profile.document.version);
            journal.artifact_set_sha256 = Some(artifact_set_sha256);
            journal
        }
    };

    advance_if(
        &mut journal,
        Stage::Detected,
        Stage::ProfileMatched,
        "Signed profile matched",
        journal_path,
    )?;
    advance_if(
        &mut journal,
        Stage::ProfileMatched,
        Stage::PreflightPassed,
        "Battery, host storage, USB, partition ranges, tools, and recovery passed",
        journal_path,
    )?;
    advance_if(
        &mut journal,
        Stage::PreflightPassed,
        Stage::Licensed,
        "Device-bound license verified",
        journal_path,
    )?;
    advance_if(
        &mut journal,
        Stage::Licensed,
        Stage::Confirmed,
        "Wipe confirmation accepted",
        journal_path,
    )?;
    verify_connected_device(&request.device_id)?;
    advance_if(
        &mut journal,
        Stage::Confirmed,
        Stage::ModificationStarted,
        "Destructive operation boundary reached",
        journal_path,
    )?;

    if journal.stage == Stage::ModificationStarted {
        ensure_fastboot()?;
        if !is_bootloader_unlocked()? {
            if request.profile.document.unlock_command != "fastboot oem at-unlock-vboot" {
                return Err("Profile unlock command is not allowlisted".into());
            }
            run_single_fastboot(&["oem", "at-unlock-vboot"])?;
        }
        // Verification is authoritative only after leaving and re-entering the
        // bootloader. This also makes an interrupted unlock safe to resume.
        run_single_fastboot(&["reboot"])?;
        wait_for_adb(Duration::from_secs(180), "Android after bootloader unlock")?;
        run("adb", &["reboot", "bootloader"]).map_err(|e| e.to_string())?;
        wait_for_fastboot(Duration::from_secs(35), "bootloader unlock verification")?;
        if !is_bootloader_unlocked()? {
            return Err("Bootloader did not report an unlocked state after reboot".into());
        }
        journal.advance(Stage::Unlocked, "Bootloader unlock verified across reboot")?;
        journal.save(journal_path)?;
    }

    if journal.stage == Stage::Unlocked {
        ensure_fastboot()?;
        let vbmeta = artifact(&request.manifest.document, "vbmeta")?;
        run_single_fastboot(&[
            "--disable-verity",
            "--disable-verification",
            "flash",
            "vbmeta",
            path(artifact_path(request, vbmeta)?)?,
        ])?;
        run_single_fastboot(&["reboot"])?;
        wait_for_adb(Duration::from_secs(120), "recovery/Android ADB")?;
        run("adb", &["reboot", "fastboot"]).map_err(|e| e.to_string())?;
        wait_for_fastboot(Duration::from_secs(60), "userspace fastbootd")?;
        let userspace = run_single_fastboot(&["getvar", "is-userspace"])?;
        if !parse_fastboot_bool(&userspace, "is-userspace") {
            return Err("Refusing to resize system outside fastbootd".into());
        }
        journal.advance(Stage::Fastbootd, "Userspace fastbootd verified")?;
        journal.save(journal_path)?;
    }

    advance_if(
        &mut journal,
        Stage::Fastbootd,
        Stage::ArtifactsVerified,
        "All signed release hashes verified",
        journal_path,
    )?;
    if journal.stage == Stage::ArtifactsVerified {
        ensure_fastbootd()?;
        let system = artifact(&request.manifest.document, "system")?;
        let system_limits = request
            .profile
            .document
            .partition_constraints
            .get("system")
            .ok_or("Signed profile lacks system partition constraints")?;
        if system.size < system_limits.min_size || system.size > system_limits.max_size {
            return Err("System image size violates signed profile".into());
        }
        run_single_fastboot(&[
            "resize-logical-partition",
            "system",
            &system.size.to_string(),
        ])?;
        run_single_fastboot(&["flash", "system", path(artifact_path(request, system)?)?])?;
        run_single_fastboot(&["-w"])?;
        run_single_fastboot(&["reboot"])?;
        journal.advance(Stage::Flashed, "System flashed and userdata wiped")?;
        journal.save(journal_path)?;
    }

    if journal.stage == Stage::Flashed {
        wait_for_adb(
            Duration::from_secs(360),
            "first Android boot and ADB reauthorization",
        )?;
        journal.advance(Stage::Booted, "First boot and ADB authorization completed")?;
        journal.save(journal_path)?;
    }

    if journal.stage == Stage::Booted {
        for apk in request
            .manifest
            .document
            .artifacts
            .iter()
            .filter(|artifact| artifact.kind == "apk")
        {
            run(
                "adb",
                &["install", "-r", path(artifact_path(request, apk)?)?],
            )
            .map_err(|e| e.to_string())?;
        }
        journal.advance(Stage::AppsInstalled, "Verified application set installed")?;
        journal.save(journal_path)?;
    }

    if journal.stage == Stage::AppsInstalled {
        for cold_boot in 1..=2 {
            run("adb", &["reboot"]).map_err(|e| e.to_string())?;
            wait_for_adb(
                Duration::from_secs(240),
                &format!("cold reboot {cold_boot}"),
            )?;
        }
        let command = &request.profile.document.diagnostics_command;
        if command.first().map(String::as_str) != Some("am")
            || command.get(1).map(String::as_str) != Some("instrument")
        {
            return Err("Diagnostics command is not allowlisted".into());
        }
        let mut args = vec!["shell"];
        args.extend(command.iter().map(String::as_str));
        let diagnostics = run("adb", &args).map_err(|e| e.to_string())?;
        if !(diagnostics.contains("OK (") || diagnostics.contains("REVIVE_DIAGNOSTICS_PASS")) {
            return Err("Hardware diagnostics did not report a pass".into());
        }
        run("adb", &["shell", "cmd", "wifi", "status"]).map_err(|e| e.to_string())?;
        run("adb", &["shell", "dumpsys", "audio"]).map_err(|e| e.to_string())?;
        run("adb", &["shell", "df", "/data"]).map_err(|e| e.to_string())?;
        let _optional_fingerprint = run("adb", &["shell", "dumpsys", "fingerprint"])
            .unwrap_or_else(|_| "optional-unavailable".into());
        journal.advance(
            Stage::Tested,
            "Two cold boots and signed hardware/application diagnostics passed",
        )?;
        journal.save(journal_path)?;
    }

    advance_if(
        &mut journal,
        Stage::Tested,
        Stage::Complete,
        "Installation complete",
        journal_path,
    )?;
    write_recovery_report(journal_path, &journal)?;
    Ok(journal)
}

fn advance_if(
    journal: &mut Journal,
    from: Stage,
    to: Stage,
    detail: &str,
    path: &Path,
) -> Result<(), String> {
    if journal.stage == from {
        journal.advance(to, detail)?;
        journal.save(path)?;
    }
    Ok(())
}

fn write_recovery_report(journal_path: &Path, journal: &Journal) -> Result<(), String> {
    let report_path = journal_path.with_file_name("recovery-report.json");
    fs::write(
        report_path,
        serde_json::to_vec_pretty(journal).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

fn wait_for_adb(timeout: Duration, description: &str) -> Result<String, String> {
    wait_for_match("adb", &["get-state"], description, timeout, |value| {
        value.trim() == "device"
    })
    .map_err(|e| e.to_string())
}

fn wait_for_fastboot(timeout: Duration, description: &str) -> Result<String, String> {
    wait_for_match("fastboot", &["devices"], description, timeout, |value| {
        fastboot_serials(value).len() == 1
    })
    .map_err(|e| e.to_string())
}

fn fastboot_serials(output: &str) -> Vec<&str> {
    output
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let serial = fields.next()?;
            if fields.next() == Some("fastboot") && fields.next().is_none() {
                Some(serial)
            } else {
                None
            }
        })
        .collect()
}

fn single_fastboot_serial() -> Result<String, String> {
    let output = run("fastboot", &["devices"]).map_err(|e| e.to_string())?;
    let serials = fastboot_serials(&output);
    if serials.len() != 1 {
        return Err("Connect exactly one PSG1 in Fastboot mode".into());
    }
    Ok(serials[0].to_string())
}

fn run_single_fastboot(args: &[&str]) -> Result<String, String> {
    let serial = single_fastboot_serial()?;
    let mut pinned = Vec::with_capacity(args.len() + 2);
    pinned.push("-s");
    pinned.push(serial.as_str());
    pinned.extend_from_slice(args);
    run("fastboot", &pinned).map_err(|e| e.to_string())
}

fn verify_device_hash(serial: &str, expected: &str) -> Result<(), String> {
    let normalized = serial
        .trim()
        .replace(['-', '_', ' '], "")
        .to_ascii_uppercase();
    if normalized.is_empty() {
        return Err("Connected device serial is empty".into());
    }
    let mut hasher = Sha256::new();
    hasher.update(DEVICE_ID_DOMAIN.as_bytes());
    hasher.update(normalized.as_bytes());
    if hex::encode(hasher.finalize()) != expected {
        return Err("Connected PSG1 does not match the licensed scanned device".into());
    }
    Ok(())
}

fn verify_connected_device(expected: &str) -> Result<(), String> {
    if run("adb", &["get-state"])
        .map(|state| state.trim() == "device")
        .unwrap_or(false)
    {
        let serial = run("adb", &["get-serialno"]).map_err(|e| e.to_string())?;
        return verify_device_hash(&serial, expected);
    }
    verify_device_hash(&single_fastboot_serial()?, expected)
}

fn artifact_set_sha256(artifacts: &[Artifact]) -> Result<String, String> {
    Ok(hex::encode(Sha256::digest(
        serde_jcs::to_vec(artifacts).map_err(|e| e.to_string())?,
    )))
}

fn verify_journal_binding(
    journal: &Journal,
    request: &InstallRequest,
    artifact_hash: &str,
) -> Result<(), String> {
    if !journal_binding_matches(
        journal,
        &request.manifest.document.release_id,
        &request.profile.document.id,
        request.profile.document.version,
        artifact_hash,
    ) {
        return Err("Recovery journal release/profile/artifact binding differs from this installation; refusing resume".into());
    }
    Ok(())
}

fn journal_binding_matches(
    journal: &Journal,
    release_id: &str,
    profile_id: &str,
    profile_version: u32,
    artifact_hash: &str,
) -> bool {
    journal.release_id.as_deref() == Some(release_id)
        && journal.profile_id.as_deref() == Some(profile_id)
        && journal.profile_version == Some(profile_version)
        && journal.artifact_set_sha256.as_deref() == Some(artifact_hash)
}

fn ensure_minimum_installer_version(current: &str, minimum: &str) -> Result<(), String> {
    let minimum = semver::Version::parse(minimum)
        .map_err(|_| "Signed minimum installer version is invalid")?;
    let current = semver::Version::parse(current).map_err(|_| "Desktop version is invalid")?;
    if current < minimum {
        return Err(format!(
            "Release requires Revive PSG1 Desktop {minimum} or newer"
        ));
    }
    Ok(())
}

fn ensure_fastboot() -> Result<(), String> {
    if wait_for_fastboot(Duration::from_secs(2), "bootloader").is_ok() {
        return Ok(());
    }
    wait_for_adb(Duration::from_secs(15), "ADB before bootloader transition")?;
    run("adb", &["reboot", "bootloader"]).map_err(|e| e.to_string())?;
    wait_for_fastboot(Duration::from_secs(35), "bootloader")?;
    Ok(())
}

fn ensure_fastbootd() -> Result<(), String> {
    wait_for_fastboot(Duration::from_secs(10), "userspace fastbootd")?;
    let userspace = run_single_fastboot(&["getvar", "is-userspace"])?;
    if !parse_fastboot_bool(&userspace, "is-userspace") {
        return Err(
            "Recovery journal expected userspace fastbootd; reconnect and retry recovery".into(),
        );
    }
    Ok(())
}

fn is_bootloader_unlocked() -> Result<bool, String> {
    let output = run_single_fastboot(&["getvar", "unlocked"])?;
    Ok(parse_fastboot_bool(&output, "unlocked"))
}

fn parse_fastboot_bool(output: &str, name: &str) -> bool {
    let pattern = format!(
        r"(?im)^\s*(?:\(bootloader\)\s*)?{}\s*:\s*(?:yes|true|1)\s*$",
        regex::escape(name)
    );
    Regex::new(&pattern)
        .map(|regex| regex.is_match(output))
        .unwrap_or(false)
}

fn read_partition_size(partition: &str) -> Result<u64, String> {
    let key = format!("partition-size:{partition}");
    let output = run_single_fastboot(&["getvar", &key])?;
    let pattern = format!(
        r"(?im)^\s*(?:\(bootloader\)\s*)?{}\s*:\s*(0x[0-9a-f]+|[0-9]+)\s*$",
        regex::escape(&key)
    );
    let value = Regex::new(&pattern)
        .map_err(|e| e.to_string())?
        .captures(&output)
        .and_then(|captures| captures.get(1))
        .map(|value| value.as_str())
        .ok_or_else(|| format!("Bootloader did not report {key}"))?;
    if let Some(hex) = value.strip_prefix("0x") {
        u64::from_str_radix(hex, 16).map_err(|e| e.to_string())
    } else {
        value.parse::<u64>().map_err(|e| e.to_string())
    }
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

pub fn verify_free_profile(profile: &Profile, signature: &str) -> Result<(), String> {
    let release_key = option_env!("REVIVE_RELEASE_PUBLIC_KEY_B64").ok_or(
        "Production release verification key was not embedded; compatibility profiles cannot be trusted",
    )?;
    verify_document(
        &SignedDocument {
            document: profile.clone(),
            signature: signature.to_owned(),
        },
        release_key,
    )
}

fn verify_document<T: Serialize>(signed: &SignedDocument<T>, key: &str) -> Result<(), String> {
    let bytes = serde_jcs::to_vec(&signed.document).map_err(|e| e.to_string())?;
    let key_bytes = STANDARD
        .decode(key)
        .map_err(|_| "Invalid release public key")?;
    let verifying = VerifyingKey::from_bytes(
        key_bytes
            .as_slice()
            .try_into()
            .map_err(|_| "Release key must be 32 bytes")?,
    )
    .map_err(|e| e.to_string())?;
    let signature = Signature::from_slice(
        &STANDARD
            .decode(&signed.signature)
            .map_err(|_| "Invalid document signature")?,
    )
    .map_err(|e| e.to_string())?;
    verifying
        .verify(&bytes, &signature)
        .map_err(|_| "Signed document verification failed".into())
}

fn verify_artifact(artifact: &Artifact, path: &Path) -> Result<(), String> {
    let metadata = fs::metadata(path).map_err(|e| format!("Artifact missing: {e}"))?;
    if metadata.len() != artifact.size {
        return Err(format!("{} size mismatch", artifact.kind));
    }
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    let actual = hex::encode(Sha256::digest(bytes));
    if actual != artifact.sha256 {
        return Err(format!("{} SHA-256 mismatch", artifact.kind));
    }
    Ok(())
}

fn artifact<'a>(manifest: &'a Manifest, kind: &str) -> Result<&'a Artifact, String> {
    manifest
        .artifacts
        .iter()
        .find(|artifact| artifact.kind == kind)
        .ok_or_else(|| format!("Manifest lacks {kind}"))
}

fn artifact_path<'a>(request: &'a InstallRequest, artifact: &Artifact) -> Result<&'a Path, String> {
    request
        .artifact_paths
        .get(&artifact.id)
        .map(PathBuf::as_path)
        .ok_or_else(|| format!("No downloaded path for artifact {}", artifact.id))
}

fn path(value: &Path) -> Result<&str, String> {
    value
        .to_str()
        .ok_or_else(|| "Artifact path is not UTF-8".into())
}

#[derive(Debug, Deserialize)]
struct LicenseClaims {
    #[serde(rename = "deviceId")]
    device_id: String,
    iss: String,
    aud: String,
}

fn verify_license(token: &str, device_id: &str) -> Result<(), String> {
    let pem = option_env!("REVIVE_LICENSE_PUBLIC_KEY_PEM").ok_or(
        "Production license verification key was not embedded; destructive commands remain locked",
    )?;
    let key =
        DecodingKey::from_ed_pem(pem.as_bytes()).map_err(|_| "Embedded license key is invalid")?;
    let mut validation = Validation::new(Algorithm::EdDSA);
    validation.set_issuer(&["revive-psg1-api"]);
    validation.set_audience(&["revive-psg1-desktop"]);
    validation.validate_exp = false;
    let claims = decode::<LicenseClaims>(token, &key, &validation)
        .map_err(|_| "License signature is invalid")?
        .claims;
    if claims.device_id != device_id
        || claims.iss != "revive-psg1-api"
        || claims.aud != "revive-psg1-desktop"
    {
        return Err("License belongs to a different PSG1".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn malformed_license_is_rejected() {
        assert!(verify_license("x", "d").is_err());
    }

    #[test]
    fn parses_fastboot_boolean_without_accepting_locked() {
        assert!(parse_fastboot_bool(
            "(bootloader) unlocked: yes\nOKAY",
            "unlocked"
        ));
        assert!(parse_fastboot_bool("unlocked: true", "unlocked"));
        assert!(!parse_fastboot_bool("unlocked: no", "unlocked"));
        assert!(!parse_fastboot_bool("secure: no", "unlocked"));
    }

    #[test]
    fn parses_hex_partition_size() {
        let output = "(bootloader) partition-size:system: 0x100000000";
        let pattern = Regex::new(r"(?im)partition-size:system:\s*(0x[0-9a-f]+)").unwrap();
        assert_eq!(
            pattern.captures(output).unwrap().get(1).unwrap().as_str(),
            "0x100000000"
        );
    }

    #[test]
    fn rejects_device_swap_and_multiple_fastboot_targets() {
        let synthetic = "PSG1-TEST-0001-A";
        let normalized = synthetic.replace(['-', '_', ' '], "").to_ascii_uppercase();
        let mut hasher = Sha256::new();
        hasher.update(DEVICE_ID_DOMAIN);
        hasher.update(normalized);
        let expected = hex::encode(hasher.finalize());
        assert!(verify_device_hash(synthetic, &expected).is_ok());
        assert!(verify_device_hash("PSG1-TEST-0002-B", &expected).is_err());
        assert_eq!(fastboot_serials("one\tfastboot\ntwo\tfastboot").len(), 2);
    }

    #[test]
    fn enforces_signed_minimum_installer_version() {
        assert!(ensure_minimum_installer_version("1.2.3", "1.2.3").is_ok());
        assert!(ensure_minimum_installer_version("1.2.3", "1.2.4").is_err());
        assert!(ensure_minimum_installer_version("invalid", "1.0.0").is_err());
    }

    #[test]
    fn journal_binding_rejects_release_or_artifact_drift() {
        let mut journal = Journal::new("a".repeat(64));
        journal.release_id = Some("release-a".into());
        journal.profile_id = Some("profile-a".into());
        journal.profile_version = Some(1);
        journal.artifact_set_sha256 = Some("b".repeat(64));
        assert!(journal_binding_matches(
            &journal,
            "release-a",
            "profile-a",
            1,
            &"b".repeat(64)
        ));
        assert!(!journal_binding_matches(
            &journal,
            "release-b",
            "profile-a",
            1,
            &"b".repeat(64)
        ));
        assert!(!journal_binding_matches(
            &journal,
            "release-a",
            "profile-a",
            1,
            &"c".repeat(64)
        ));
    }
}
