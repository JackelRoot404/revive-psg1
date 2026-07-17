mod customer_artifact;
mod downloader;
mod installer;
mod journal;
mod runner;
mod scanner;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::{DateTime, Duration, Utc};
use ed25519_dalek::{Signer, SigningKey};
use fs2::available_space;
use journal::Journal;
use rand_core::{OsRng, RngCore};
use regex::Regex;
use scanner::ScanResult;
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, fs, path::PathBuf, sync::Mutex};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
use uuid::Uuid;

#[derive(Default)]
struct AppState {
    pairing: Mutex<Option<Pairing>>,
    desktop_token: Mutex<Option<String>>,
    license: Mutex<Option<LicenseEntitlement>>,
    last_scan: Mutex<Option<ScanResult>>,
    // Recovery credentials live in process memory only until the API confirms
    // the first claim. They are never written to the desktop data directory.
    pending_recovery: Mutex<HashMap<String, PendingRecovery>>,
}
struct Pairing {
    signing: SigningKey,
    session_id: String,
    device_id: String,
}
#[derive(Clone)]
struct LicenseEntitlement {
    id: String,
    token: String,
}

#[derive(Deserialize)]
struct SessionResponse {
    #[serde(rename = "sessionId")]
    session_id: String,
    #[serde(rename = "checkoutUrl")]
    checkout_url: String,
    #[serde(rename = "desktopToken")]
    desktop_token: String,
    supported: bool,
    #[serde(rename = "profileId")]
    profile_id: Option<String>,
    profile: Option<installer::Profile>,
    #[serde(rename = "profileSignature")]
    profile_signature: Option<String>,
}
#[derive(Serialize)]
struct CheckoutStart {
    #[serde(rename = "sessionId")]
    session_id: String,
    #[serde(rename = "checkoutUrl")]
    checkout_url: Option<String>,
    restored: bool,
    #[serde(rename = "recoveryRequired")]
    recovery_required: bool,
}
#[derive(Serialize)]
struct SessionRequest<'a> {
    #[serde(rename = "deviceId")]
    device_id: &'a str,
    #[serde(rename = "pairingPublicKey")]
    pairing_public_key: String,
    #[serde(rename = "pairingProof")]
    pairing_proof: String,
    #[serde(rename = "appVersion")]
    app_version: &'static str,
    #[serde(rename = "hostOs")]
    host_os: &'static str,
    #[serde(rename = "requestNonce")]
    request_nonce: String,
    #[serde(rename = "createdAt")]
    created_at: String,
    compatibility: Compatibility<'a>,
}
#[derive(Serialize)]
struct Compatibility<'a> {
    product: &'a str,
    model: &'a str,
    board: &'a str,
    hardware: &'a str,
    #[serde(rename = "buildFingerprint")]
    build_fingerprint: &'a str,
    #[serde(rename = "buildIncremental")]
    build_incremental: &'a str,
    #[serde(rename = "vendorApiLevel")]
    vendor_api_level: u32,
    #[serde(rename = "androidApiLevel")]
    android_api_level: u32,
    #[serde(rename = "batteryPercent")]
    battery_percent: u8,
    charging: bool,
}
#[derive(Serialize)]
struct ClaimRequest<'a> {
    #[serde(rename = "sessionId")]
    session_id: &'a str,
    #[serde(rename = "pairingProof")]
    pairing_proof: String,
    #[serde(rename = "recoveryCredential")]
    recovery_credential: &'a str,
}
#[derive(Deserialize)]
struct LicenseResponse {
    #[serde(rename = "licenseId")]
    license_id: String,
    #[serde(rename = "licenseToken")]
    license_token: String,
    #[serde(rename = "recoveryCredential")]
    recovery_credential: Option<String>,
}
#[derive(Deserialize)]
struct EntitlementStatus {
    licensed: bool,
}
#[derive(Serialize)]
struct RecoveryRequest<'a> {
    #[serde(rename = "recoveryCredential")]
    recovery_credential: &'a str,
}
#[derive(Serialize, Deserialize)]
struct StoredEntitlement {
    device_id: String,
    license_id: String,
    license_token: String,
}
#[derive(Clone)]
struct PendingRecovery {
    order_id: String,
    recovery_credential: String,
}
#[derive(Deserialize)]
struct ReleaseResponse {
    manifest: installer::Manifest,
    signature: String,
    profile: installer::Profile,
    #[serde(rename = "profileSignature")]
    profile_signature: String,
    #[serde(rename = "downloadUrls")]
    download_urls: std::collections::HashMap<String, String>,
}
#[derive(Serialize)]
struct CompatibilityReportRequest<'a> {
    #[serde(rename = "sessionId")]
    session_id: &'a str,
    #[serde(rename = "profileCandidate")]
    profile_candidate: HashMap<&'static str, serde_json::Value>,
    #[serde(rename = "consentToNotify")]
    consent_to_notify: bool,
}
#[derive(Deserialize)]
struct CompatibilityReportResponse {
    #[serde(rename = "reportId")]
    report_id: String,
}
#[derive(Serialize)]
struct BrowserProofVerify<'a> {
    #[serde(rename = "challengeId")]
    challenge_id: &'a str,
    signature: String,
}

fn data_path(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|p| p.join(name))
        .map_err(|e| e.to_string())
}

fn entitlement_path(app: &AppHandle, device_id: &str) -> Result<PathBuf, String> {
    data_path(app, &format!("entitlement-{device_id}.json"))
}

fn write_secret_json<T: Serialize>(path: &PathBuf, value: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let temporary = path.with_extension("tmp");
    fs::write(
        &temporary,
        serde_json::to_vec(value).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600))
            .map_err(|e| e.to_string())?;
    }
    fs::rename(temporary, path).map_err(|e| e.to_string())
}

fn read_secret_json<T: for<'de> Deserialize<'de>>(path: &PathBuf) -> Option<T> {
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

fn purge_legacy_recovery_cache(app: &AppHandle) -> Result<(), String> {
    let directory = app.path().app_data_dir().map_err(|e| e.to_string())?;
    if !directory.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(&directory).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if name.starts_with("pending-recovery-") && name.ends_with(".json") {
            fs::remove_file(path).map_err(|e| e.to_string())?;
            continue;
        }
        if name.starts_with("entitlement-") && name.ends_with(".json") {
            match read_secret_json::<StoredEntitlement>(&path) {
                Some(entitlement) => write_secret_json(&path, &entitlement)?,
                None => fs::remove_file(path).map_err(|e| e.to_string())?,
            }
        }
    }
    Ok(())
}

fn validate_free_profile(
    profile: &installer::Profile,
    expected_id: Option<&str>,
    scan: &ScanResult,
) -> Result<(), String> {
    if expected_id != Some(profile.id.as_str())
        || profile.unlock_command != "fastboot oem at-unlock-vboot"
    {
        return Err(
            "The signed compatibility profile does not match the authorized session".into(),
        );
    }
    let system = profile
        .partition_constraints
        .get("system")
        .ok_or("The signed profile lacks system partition constraints")?;
    if scan.system_partition_bytes < system.min_size
        || scan.system_partition_bytes > system.max_size
    {
        return Err("The PSG1 system partition is outside the signed profile range".into());
    }
    let field = |name: &str| {
        profile
            .signed_fields
            .get(name)
            .ok_or_else(|| format!("The signed profile lacks {name}"))
    };
    if field("product")?.as_str() != Some(scan.product.as_str()) {
        return Err("Product does not match the signed profile".into());
    }
    let contains_number = |name: &str, value: u32| -> Result<bool, String> {
        Ok(field(name)?
            .as_array()
            .ok_or_else(|| format!("Invalid {name}"))?
            .iter()
            .any(|item| item.as_u64() == Some(value as u64)))
    };
    if !contains_number("androidApiLevels", scan.android_api_level)?
        || !contains_number("vendorApiLevels", scan.vendor_api_level)?
    {
        return Err("Android/vendor API level does not match the signed profile".into());
    }
    let matches = |name: &str, values: &[&str]| -> Result<bool, String> {
        let patterns = field(name)?
            .as_array()
            .ok_or_else(|| format!("Invalid {name}"))?;
        Ok(patterns
            .iter()
            .filter_map(|item| item.as_str())
            .any(|pattern| {
                Regex::new(pattern)
                    .map(|regex| values.iter().any(|value| regex.is_match(value)))
                    .unwrap_or(false)
            }))
    };
    if !matches("modelPatterns", &[&scan.model])?
        || !matches("boardPatterns", &[&scan.board])?
        || !matches("hardwarePatterns", &[&scan.hardware])?
        || !matches(
            "firmwarePatterns",
            &[&scan.build_fingerprint, &scan.build_incremental],
        )?
    {
        return Err("Firmware or hardware does not match the signed compatibility profile".into());
    }
    Ok(())
}

#[tauri::command]
async fn scan_device(state: State<'_, AppState>) -> Result<ScanResult, String> {
    let scan = tauri::async_runtime::spawn_blocking(scanner::scan)
        .await
        .map_err(|e| e.to_string())??;
    *state.last_scan.lock().map_err(|_| "State lock failed")? = Some(scan.clone());
    Ok(scan)
}
#[tauri::command]
fn match_embedded_profile(scan: ScanResult) -> bool {
    scan.serial_verified
        && scan.usb_stable
        && scan.product.eq_ignore_ascii_case("PSG1")
        && scan.board.to_ascii_uppercase().contains("RK3588S")
        && scan.vendor_api_level == 35
        && scan.recovery_capable
        && scan.host_bytes_available >= 5_u64 * 1024 * 1024 * 1024
        && scan.system_partition_bytes >= 2_000_000_000
        && scan.system_partition_bytes <= 4_294_967_296
        && scan.build_incremental.starts_with("playsolana-")
}

#[tauri::command]
async fn create_checkout_session(
    app: AppHandle,
    scan: ScanResult,
    state: State<'_, AppState>,
) -> Result<CheckoutStart, String> {
    // Pre-keychain beta builds cached recovery credentials on disk. Rewrite or
    // remove those legacy files before doing any network or licensing work.
    purge_legacy_recovery_cache(&app)?;
    let (session, signing) = request_session(&scan).await?;
    if !session.supported {
        return Err("The API has no active signed compatibility profile for this build".into());
    }
    let profile = session
        .profile
        .as_ref()
        .ok_or("The API omitted the signed compatibility profile")?;
    let profile_signature = session
        .profile_signature
        .as_deref()
        .ok_or("The API omitted the compatibility profile signature")?;
    installer::verify_free_profile(profile, profile_signature)?;
    validate_free_profile(profile, session.profile_id.as_deref(), &scan)?;
    *state.pairing.lock().map_err(|_| "State lock failed")? = Some(Pairing {
        signing,
        session_id: session.session_id.clone(),
        device_id: scan.device_id.clone(),
    });
    *state
        .desktop_token
        .lock()
        .map_err(|_| "State lock failed")? = Some(session.desktop_token.clone());
    let api = api_url()?;
    let entitlement = reqwest::Client::new()
        .get(format!("{api}/v1/devices/{}/entitlement", scan.device_id))
        .bearer_auth(&session.desktop_token)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if entitlement.status().is_success() {
        let status: EntitlementStatus = entitlement.json().await.map_err(|e| e.to_string())?;
        if !status.licensed {
            return Err("The entitlement response was inconsistent".into());
        }
        if let Some(stored) =
            read_secret_json::<StoredEntitlement>(&entitlement_path(&app, &scan.device_id)?)
        {
            if stored.device_id == scan.device_id {
                *state.license.lock().map_err(|_| "State lock failed")? =
                    Some(LicenseEntitlement {
                        id: stored.license_id,
                        token: stored.license_token,
                    });
                return Ok(CheckoutStart {
                    session_id: session.session_id,
                    checkout_url: None,
                    restored: true,
                    recovery_required: false,
                });
            }
        }
        return Ok(CheckoutStart {
            session_id: session.session_id,
            checkout_url: None,
            restored: false,
            recovery_required: true,
        });
    } else if entitlement.status() != reqwest::StatusCode::NOT_FOUND {
        return Err(format!(
            "Entitlement status check failed: {}",
            entitlement.status()
        ));
    }
    Ok(CheckoutStart {
        session_id: session.session_id,
        checkout_url: Some(session.checkout_url),
        restored: false,
        recovery_required: false,
    })
}

#[tauri::command]
async fn submit_compatibility_report(
    scan: Option<ScanResult>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let scan = scan
        .or_else(|| state.last_scan.lock().ok()?.clone())
        .ok_or("Run a fresh device scan first")?;
    let (session, signing) = request_session(&scan).await?;
    *state.pairing.lock().map_err(|_| "State lock failed")? = Some(Pairing {
        signing,
        session_id: session.session_id.clone(),
        device_id: scan.device_id.clone(),
    });
    *state
        .desktop_token
        .lock()
        .map_err(|_| "State lock failed")? = Some(session.desktop_token.clone());
    let mut candidate = HashMap::new();
    candidate.insert("product", serde_json::json!(scan.product));
    candidate.insert("model", serde_json::json!(scan.model));
    candidate.insert("board", serde_json::json!(scan.board));
    candidate.insert("hardware", serde_json::json!(scan.hardware));
    candidate.insert(
        "buildFingerprint",
        serde_json::json!(scan.build_fingerprint),
    );
    candidate.insert(
        "buildIncremental",
        serde_json::json!(scan.build_incremental),
    );
    candidate.insert("vendorApiLevel", serde_json::json!(scan.vendor_api_level));
    candidate.insert("androidApiLevel", serde_json::json!(scan.android_api_level));
    let body = CompatibilityReportRequest {
        session_id: &session.session_id,
        profile_candidate: candidate,
        consent_to_notify: false,
    };
    let response = reqwest::Client::new()
        .post(format!("{}/v1/compatibility-reports", api_url()?))
        .bearer_auth(&session.desktop_token)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("API unavailable: {e}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "Compatibility report rejected: {}",
            response.status()
        ));
    }
    Ok(response
        .json::<CompatibilityReportResponse>()
        .await
        .map_err(|e| e.to_string())?
        .report_id)
}

#[tauri::command]
async fn complete_browser_proof(
    deep_link: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let parsed = parse_browser_proof_link(&deep_link, &state)?;
    let (signature, token) = {
        let pairing_guard = state.pairing.lock().map_err(|_| "State lock failed")?;
        let pairing = pairing_guard
            .as_ref()
            .ok_or("Desktop pairing has expired; restart checkout")?;
        let signature =
            bs58::encode(pairing.signing.sign(parsed.message.as_bytes()).to_bytes()).into_string();
        let token = state
            .desktop_token
            .lock()
            .map_err(|_| "State lock failed")?
            .clone()
            .ok_or("Desktop session has expired; restart checkout")?;
        (signature, token)
    };
    let response = reqwest::Client::new()
        .post(format!(
            "{}/v1/sessions/{}/browser-proof/verify",
            api_url()?,
            parsed.session_id
        ))
        .bearer_auth(token)
        .json(&BrowserProofVerify {
            challenge_id: &parsed.challenge_id,
            signature,
        })
        .send()
        .await
        .map_err(|e| format!("Could not return browser proof: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("Browser proof was rejected: {}", response.status()));
    }
    Ok(())
}
#[tauri::command]
async fn claim_license(
    app: AppHandle,
    order_id: String,
    session_id: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let scan = state
        .last_scan
        .lock()
        .map_err(|_| "State lock failed")?
        .clone()
        .ok_or("Run a fresh device scan first")?;
    let message = format!(
        "Revive PSG1 license claim\norder:{order_id}\nsession:{session_id}\ndevice:{}",
        scan.device_id
    );
    let signature = {
        let guard = state.pairing.lock().map_err(|_| "State lock failed")?;
        let pairing = guard.as_ref().ok_or("Checkout pairing expired")?;
        bs58::encode(pairing.signing.sign(message.as_bytes()).to_bytes()).into_string()
    };
    let token = state
        .desktop_token
        .lock()
        .map_err(|_| "State lock failed")?
        .clone()
        .ok_or("Desktop session expired")?;
    let recovery_credential = {
        let mut pending = state
            .pending_recovery
            .lock()
            .map_err(|_| "State lock failed")?;
        match pending.get(&scan.device_id) {
            Some(existing) if existing.order_id == order_id => existing.recovery_credential.clone(),
            _ => {
                let mut bytes = [0_u8; 32];
                OsRng.fill_bytes(&mut bytes);
                let credential = format!("rpr_{}", URL_SAFE_NO_PAD.encode(bytes));
                pending.insert(
                    scan.device_id.clone(),
                    PendingRecovery {
                        order_id: order_id.clone(),
                        recovery_credential: credential.clone(),
                    },
                );
                credential
            }
        }
    };
    let api = api_url()?;
    let response = reqwest::Client::new()
        .post(format!("{api}/v1/licenses/{order_id}/claim"))
        .bearer_auth(token)
        .json(&ClaimRequest {
            session_id: &session_id,
            pairing_proof: signature,
            recovery_credential: &recovery_credential,
        })
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("License claim failed: {}", response.status()));
    }
    let license: LicenseResponse = response.json().await.map_err(|e| e.to_string())?;
    if let Some(returned) = &license.recovery_credential {
        if returned != &recovery_credential {
            return Err("The API returned a mismatched recovery credential".into());
        }
    }
    write_secret_json(
        &entitlement_path(&app, &scan.device_id)?,
        &StoredEntitlement {
            device_id: scan.device_id.clone(),
            license_id: license.license_id.clone(),
            license_token: license.license_token.clone(),
        },
    )?;
    state
        .pending_recovery
        .lock()
        .map_err(|_| "State lock failed")?
        .remove(&scan.device_id);
    *state.license.lock().map_err(|_| "State lock failed")? = Some(LicenseEntitlement {
        id: license.license_id,
        token: license.license_token,
    });
    Ok(recovery_credential)
}

#[tauri::command]
async fn recover_license(
    app: AppHandle,
    recovery_credential: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let scan = state
        .last_scan
        .lock()
        .map_err(|_| "State lock failed")?
        .clone()
        .ok_or("Run a fresh device scan first")?;
    let token = state
        .desktop_token
        .lock()
        .map_err(|_| "State lock failed")?
        .clone()
        .ok_or("Desktop session expired")?;
    let response = reqwest::Client::new()
        .post(format!(
            "{}/v1/devices/{}/entitlement/recover",
            api_url()?,
            scan.device_id
        ))
        .bearer_auth(token)
        .json(&RecoveryRequest {
            recovery_credential: recovery_credential.trim(),
        })
        .send()
        .await
        .map_err(|e| format!("Recovery API unavailable: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("License recovery failed: {}", response.status()));
    }
    let license: LicenseResponse = response.json().await.map_err(|e| e.to_string())?;
    write_secret_json(
        &entitlement_path(&app, &scan.device_id)?,
        &StoredEntitlement {
            device_id: scan.device_id.clone(),
            license_id: license.license_id.clone(),
            license_token: license.license_token.clone(),
        },
    )?;
    *state.license.lock().map_err(|_| "State lock failed")? = Some(LicenseEntitlement {
        id: license.license_id,
        token: license.license_token,
    });
    Ok(())
}
#[tauri::command]
fn load_journal(app: AppHandle) -> Result<Option<Journal>, String> {
    Journal::load(&data_path(&app, "install-journal.json")?)
}
#[tauri::command]
async fn begin_installation(
    app: AppHandle,
    confirmation: String,
    state: State<'_, AppState>,
) -> Result<Journal, String> {
    let scan = state
        .last_scan
        .lock()
        .map_err(|_| "State lock failed")?
        .clone()
        .ok_or("Run a fresh device scan first")?;
    let license = state
        .license
        .lock()
        .map_err(|_| "State lock failed")?
        .clone()
        .ok_or("Complete checkout and claim the device license first")?;
    let api = api_url()?;
    let response = reqwest::Client::new()
        .get(format!("{api}/v1/releases/stable"))
        .bearer_auth(&license.token)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "Release authorization failed: {}",
            response.status()
        ));
    }
    let release: ReleaseResponse = response
        .json()
        .await
        .map_err(|e| format!("Release metadata is invalid: {e}"))?;
    let required_bytes =
        release
            .manifest
            .artifacts
            .iter()
            .try_fold(512_u64 * 1024 * 1024, |total, artifact| {
                total
                    .checked_add(artifact.size)
                    .ok_or("Release size overflow")
            })?;
    let downloads = data_path(&app, "downloads")?;
    std::fs::create_dir_all(&downloads).map_err(|e| e.to_string())?;
    if available_space(&downloads).map_err(|e| e.to_string())? < required_bytes {
        return Err(
            "Not enough free host storage for the signed release and recovery headroom".into(),
        );
    }
    let mut artifact_paths = std::collections::HashMap::new();
    for artifact in &release.manifest.artifacts {
        let destination = data_path(&app, "downloads")?.join(&artifact.id);
        let path = match artifact.delivery {
            installer::ArtifactDelivery::Private => {
                let object_key = artifact.object_key.as_ref().ok_or_else(|| {
                    format!("Private artifact {} has no signed object key", artifact.id)
                })?;
                let url = release
                    .download_urls
                    .get(object_key)
                    .ok_or_else(|| format!("Release lacks URL for {}", artifact.id))?;
                downloader::download(url, &destination, artifact.size, &artifact.sha256).await?
            }
            installer::ArtifactDelivery::CustomerSupplied => {
                let source = artifact.source.as_ref().ok_or_else(|| {
                    format!(
                        "Customer artifact {} has no signed source metadata",
                        artifact.id
                    )
                })?;
                if !source.instructions_url.starts_with("https://") {
                    return Err("Customer artifact instructions must use HTTPS".into());
                }
                app.opener()
                    .open_url(source.instructions_url.clone(), None::<String>)
                    .map_err(|e| e.to_string())?;
                let dialog_app = app.clone();
                let label = source.label.clone();
                let selected = tauri::async_runtime::spawn_blocking(move || {
                    dialog_app
                        .dialog()
                        .file()
                        .set_title(format!("Select {label}"))
                        .add_filter("Signed source archive", &["zip", "xz"])
                        .blocking_pick_file()
                })
                .await
                .map_err(|e| e.to_string())?
                .ok_or("Customer-supplied archive selection was cancelled")?
                .into_path()
                .map_err(|e| e.to_string())?;
                customer_artifact::prepare(artifact, &selected, &destination)?
            }
        };
        artifact_paths.insert(artifact.id.clone(), path);
    }
    let request = installer::InstallRequest {
        device_id: scan.device_id,
        license_token: license.token.clone(),
        confirmation,
        profile: installer::SignedDocument {
            document: release.profile,
            signature: release.profile_signature,
        },
        manifest: installer::SignedDocument {
            document: release.manifest,
            signature: release.signature,
        },
        artifact_paths,
    };
    // All local signatures, identity, profile constraints, and hashes pass before closing the normal refund window.
    let request = tauri::async_runtime::spawn_blocking(move || {
        installer::preflight(&request).map(|_| request)
    })
    .await
    .map_err(|e| e.to_string())??;
    let boundary = reqwest::Client::new()
        .post(format!(
            "{api}/v1/licenses/{}/installation-started",
            license.id
        ))
        .bearer_auth(&license.token)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !boundary.status().is_success() {
        return Err(format!(
            "Could not record destructive-operation boundary: {}",
            boundary.status()
        ));
    }
    tauri::async_runtime::spawn_blocking(move || {
        installer::execute_prepared(request, &data_path(&app, "install-journal.json")?)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
fn open_recovery_report(app: AppHandle) -> Result<(), String> {
    let path = data_path(&app, "recovery-report.json")?;
    if !path.exists() {
        return Err("No recovery report exists yet".into());
    }
    app.opener()
        .open_path(path.to_string_lossy().into_owned(), None::<String>)
        .map_err(|e| e.to_string())
}
#[tauri::command]
async fn download_artifact(
    app: AppHandle,
    artifact_id: String,
    url: String,
    size: u64,
    sha256: String,
) -> Result<String, String> {
    if !artifact_id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        || artifact_id.len() > 100
    {
        return Err("Invalid artifact identifier".into());
    }
    if !url.starts_with("https://") {
        return Err("Artifact URL must use HTTPS".into());
    }
    let destination = data_path(&app, "downloads")?.join(artifact_id);
    downloader::download(&url, &destination, size, &sha256)
        .await?
        .to_str()
        .map(str::to_string)
        .ok_or_else(|| "Download path is not UTF-8".into())
}

fn api_url() -> Result<String, String> {
    let value = if cfg!(debug_assertions) {
        std::env::var("REVIVE_API_URL").unwrap_or_else(|_| "http://localhost:8080".into())
    } else {
        option_env!("REVIVE_API_URL")
            .ok_or("Production API URL was not embedded at build time")?
            .to_string()
    };
    validate_service_url(&value, !cfg!(debug_assertions))
}
fn web_host() -> Result<String, String> {
    let value = if cfg!(debug_assertions) {
        std::env::var("REVIVE_WEB_URL").unwrap_or_else(|_| "http://localhost:3000".into())
    } else {
        option_env!("REVIVE_WEB_URL")
            .ok_or("Production web URL was not embedded at build time")?
            .to_string()
    };
    let url = validate_service_url(&value, !cfg!(debug_assertions))?;
    tauri::Url::parse(&url)
        .map_err(|_| "REVIVE_WEB_URL is invalid")?
        .host_str()
        .map(str::to_string)
        .ok_or_else(|| "REVIVE_WEB_URL has no host".into())
}

fn validate_service_url(value: &str, require_https: bool) -> Result<String, String> {
    let parsed = tauri::Url::parse(value).map_err(|_| "Configured service URL is invalid")?;
    if require_https && parsed.scheme() != "https" {
        return Err("Production service URLs must use HTTPS".into());
    }
    if parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(
            "Configured service URL must contain only scheme, host, optional port, and path".into(),
        );
    }
    Ok(value.trim_end_matches('/').to_string())
}

async fn request_session(scan: &ScanResult) -> Result<(SessionResponse, SigningKey), String> {
    let signing = SigningKey::generate(&mut OsRng);
    let public = bs58::encode(signing.verifying_key().as_bytes()).into_string();
    let mut nonce_bytes = [0_u8; 24];
    OsRng.fill_bytes(&mut nonce_bytes);
    let request_nonce = URL_SAFE_NO_PAD.encode(nonce_bytes);
    let created_at = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let message = format!(
        "Revive PSG1 desktop pairing\ndevice:{}\npairing-key:{}\napp-version:0.1.0\nrequest-nonce:{}\ncreated-at:{}",
        scan.device_id, public, request_nonce, created_at
    );
    let signature = bs58::encode(signing.sign(message.as_bytes()).to_bytes()).into_string();
    let body = SessionRequest {
        device_id: &scan.device_id,
        pairing_public_key: public,
        pairing_proof: signature,
        app_version: "0.1.0",
        host_os: if cfg!(target_os = "windows") {
            "windows"
        } else {
            "macos"
        },
        request_nonce,
        created_at,
        compatibility: Compatibility {
            product: &scan.product,
            model: &scan.model,
            board: &scan.board,
            hardware: &scan.hardware,
            build_fingerprint: &scan.build_fingerprint,
            build_incremental: &scan.build_incremental,
            vendor_api_level: scan.vendor_api_level,
            android_api_level: scan.android_api_level,
            battery_percent: scan.battery_percent,
            charging: scan.charging,
        },
    };
    let response = reqwest::Client::new()
        .post(format!("{}/v1/sessions", api_url()?))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("API unavailable: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("Session rejected: {}", response.status()));
    }
    Ok((response.json().await.map_err(|e| e.to_string())?, signing))
}

struct ParsedBrowserProof {
    message: String,
    challenge_id: String,
    session_id: String,
}
fn parse_browser_proof_link(
    link: &str,
    state: &State<'_, AppState>,
) -> Result<ParsedBrowserProof, String> {
    let url = tauri::Url::parse(link).map_err(|_| "Browser proof link is invalid")?;
    if url.scheme() != "revive-psg1" || url.host_str() != Some("browser-proof") {
        return Err("Unexpected desktop callback".into());
    }
    let encoded = url
        .query_pairs()
        .find(|(key, _)| key == "message")
        .map(|(_, value)| value.into_owned())
        .ok_or("Browser proof message is missing")?;
    let message = String::from_utf8(
        URL_SAFE_NO_PAD
            .decode(encoded)
            .map_err(|_| "Browser proof message encoding is invalid")?,
    )
    .map_err(|_| "Browser proof message is not UTF-8")?;
    let lines = message.lines().collect::<Vec<_>>();
    if lines.len() != 10
        || lines[0] != "Revive PSG1 local browser proof"
        || lines[9] != "Only sign this after a checkout page on this computer requests it."
    {
        return Err("Browser proof message format is invalid".into());
    }
    let field = |index: usize, prefix: &str| {
        lines[index]
            .strip_prefix(prefix)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| format!("Browser proof {prefix} field is invalid"))
    };
    let domain = field(1, "domain:")?;
    let challenge_id = field(2, "challenge:")?.to_string();
    let session_id = field(3, "session:")?.to_string();
    let device_id = field(4, "device:")?;
    let desktop_key = field(5, "desktop-key:")?;
    let browser_nonce_hash = field(6, "browser-nonce-hash:")?;
    let nonce = field(7, "nonce:")?;
    let expires = field(8, "expires:")?;
    Uuid::parse_str(&challenge_id).map_err(|_| "Browser proof challenge ID is invalid")?;
    Uuid::parse_str(&session_id).map_err(|_| "Browser proof session ID is invalid")?;
    if device_id.len() != 64
        || !device_id.chars().all(|character| {
            character.is_ascii_hexdigit()
                && (!character.is_ascii_alphabetic() || character.is_ascii_lowercase())
        })
    {
        return Err("Browser proof device hash is invalid".into());
    }
    if browser_nonce_hash.len() != 64
        || !browser_nonce_hash.chars().all(|character| {
            character.is_ascii_hexdigit()
                && (!character.is_ascii_alphabetic() || character.is_ascii_lowercase())
        })
    {
        return Err("Browser proof browser nonce hash is invalid".into());
    }
    let nonce_bytes = URL_SAFE_NO_PAD
        .decode(nonce)
        .map_err(|_| "Browser proof nonce is invalid")?;
    if nonce_bytes.len() < 16 || nonce_bytes.len() > 64 {
        return Err("Browser proof nonce length is invalid".into());
    }
    let expiry = DateTime::parse_from_rfc3339(expires)
        .map_err(|_| "Browser proof expiration is invalid")?
        .with_timezone(&Utc);
    let now = Utc::now();
    if expiry <= now || expiry > now + Duration::minutes(5) {
        return Err("Browser proof has expired or exceeds the five-minute limit".into());
    }
    if domain != web_host()? {
        return Err("Browser proof came from an unexpected website".into());
    }
    let pairing = state.pairing.lock().map_err(|_| "State lock failed")?;
    let pairing = pairing
        .as_ref()
        .ok_or("Desktop pairing has expired; restart checkout")?;
    if session_id != pairing.session_id
        || device_id != pairing.device_id
        || desktop_key != bs58::encode(pairing.signing.verifying_key().as_bytes()).into_string()
    {
        return Err("Browser proof does not match this desktop session and PSG1".into());
    }
    let expected=format!("Revive PSG1 local browser proof\ndomain:{domain}\nchallenge:{challenge_id}\nsession:{session_id}\ndevice:{device_id}\ndesktop-key:{desktop_key}\nbrowser-nonce-hash:{browser_nonce_hash}\nnonce:{nonce}\nexpires:{expires}\nOnly sign this after a checkout page on this computer requests it.");
    if message != expected {
        return Err("Browser proof message was altered".into());
    }
    Ok(ParsedBrowserProof {
        message,
        challenge_id,
        session_id,
    })
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_deep_link::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            scan_device,
            match_embedded_profile,
            create_checkout_session,
            submit_compatibility_report,
            complete_browser_proof,
            claim_license,
            recover_license,
            load_journal,
            begin_installation,
            download_artifact,
            open_recovery_report
        ])
        .run(tauri::generate_context!())
        .expect("error while running Revive PSG1")
}

#[cfg(test)]
mod config_tests {
    use super::{validate_service_url, StoredEntitlement};

    #[test]
    fn production_service_urls_require_https_and_no_credentials() {
        assert_eq!(
            validate_service_url("https://api.example.com/", true).unwrap(),
            "https://api.example.com"
        );
        assert!(validate_service_url("http://api.example.com", true).is_err());
        assert!(validate_service_url("https://user:secret@api.example.com", true).is_err());
        assert!(validate_service_url("https://api.example.com#fragment", true).is_err());
    }

    #[test]
    fn entitlement_cache_never_serializes_recovery_credential() {
        let stored = StoredEntitlement {
            device_id: "d".repeat(64),
            license_id: "license-id".into(),
            license_token: "signed-license-token".into(),
        };
        let serialized = serde_json::to_string(&stored).unwrap();
        assert!(!serialized.contains("recovery"));
        assert!(serialized.contains("signed-license-token"));
    }
}
