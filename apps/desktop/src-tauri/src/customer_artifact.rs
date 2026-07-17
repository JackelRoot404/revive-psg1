use std::{
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
};

use sha2::{Digest, Sha256};

use crate::installer::{Artifact, ArtifactDelivery};

/// Verify an owner-downloaded archive and extract exactly the signed member to
/// a bounded regular file. No archive path is ever joined to a destination.
pub fn prepare(
    artifact: &Artifact,
    archive_path: &Path,
    destination: &Path,
) -> Result<PathBuf, String> {
    if artifact.delivery != ArtifactDelivery::CustomerSupplied
        || artifact.kind != "system"
        || artifact.component.as_deref() != Some("google_mobile_services")
    {
        return Err(
            "Only the signed customer-supplied Play-enabled system image is accepted".into(),
        );
    }
    let source = artifact
        .source
        .as_ref()
        .ok_or("Customer artifact source metadata is missing")?;
    let filename = archive_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("Selected archive filename is invalid")?;
    if !source
        .archive_filename_patterns
        .iter()
        .any(|pattern| filename_matches(pattern, filename))
    {
        return Err(
            "Selected archive filename does not match the signed release instructions".into(),
        );
    }
    verify_file(
        archive_path,
        source.archive_size,
        &source.archive_sha256,
        "archive",
    )?;
    validate_member_path(&source.extracted_path)?;
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let temporary = destination.with_extension("customer.tmp");
    let result = extract_bounded(
        archive_path,
        &source.extracted_path,
        &temporary,
        artifact.size,
    )
    .and_then(|_| {
        verify_file(
            &temporary,
            artifact.size,
            &artifact.sha256,
            "extracted artifact",
        )
    });
    if let Err(error) = result {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    fs::rename(&temporary, destination).map_err(|e| e.to_string())?;
    Ok(destination.to_path_buf())
}

fn extract_bounded(
    archive: &Path,
    member: &str,
    destination: &Path,
    expected_size: u64,
) -> Result<(), String> {
    let mut magic = [0_u8; 6];
    let mut input = File::open(archive).map_err(|e| e.to_string())?;
    input
        .read_exact(&mut magic)
        .map_err(|_| "Customer archive is too short")?;
    drop(input);
    if magic.starts_with(b"PK\x03\x04") {
        let input = File::open(archive).map_err(|e| e.to_string())?;
        let mut zip = zip::ZipArchive::new(input).map_err(|_| "Customer ZIP archive is invalid")?;
        let entry = zip
            .by_name(member)
            .map_err(|_| "Signed artifact path is missing from the ZIP archive")?;
        if entry.is_dir() || entry.size() != expected_size {
            return Err("ZIP member type or expanded size does not match signed metadata".into());
        }
        copy_exact(entry, destination, expected_size)
    } else if magic == [0xfd, b'7', b'z', b'X', b'Z', 0x00] {
        let input = File::open(archive).map_err(|e| e.to_string())?;
        copy_exact(xz2::read::XzDecoder::new(input), destination, expected_size)
    } else {
        Err("Customer archive format is not allowlisted; only ZIP and XZ are supported".into())
    }
}

fn copy_exact(mut input: impl Read, destination: &Path, expected_size: u64) -> Result<(), String> {
    let mut output = File::create(destination).map_err(|e| e.to_string())?;
    let mut bounded = (&mut input).take(expected_size.saturating_add(1));
    let written = std::io::copy(&mut bounded, &mut output).map_err(|e| e.to_string())?;
    output.flush().map_err(|e| e.to_string())?;
    output.sync_all().map_err(|e| e.to_string())?;
    if written != expected_size {
        return Err("Expanded customer artifact size does not match signed metadata".into());
    }
    Ok(())
}

fn verify_file(
    path: &Path,
    expected_size: u64,
    expected_hash: &str,
    label: &str,
) -> Result<(), String> {
    let metadata =
        fs::symlink_metadata(path).map_err(|e| format!("Selected {label} is unavailable: {e}"))?;
    if !metadata.file_type().is_file() || metadata.len() != expected_size {
        return Err(format!(
            "Selected {label} type or size does not match signed metadata"
        ));
    }
    let mut input = File::open(path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 1024 * 1024];
    loop {
        let read = input.read(&mut buffer).map_err(|e| e.to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    if hex::encode(hasher.finalize()) != expected_hash {
        return Err(format!(
            "Selected {label} SHA-256 does not match signed metadata"
        ));
    }
    Ok(())
}

fn validate_member_path(member: &str) -> Result<(), String> {
    let path = Path::new(member);
    if member.is_empty()
        || path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        return Err("Signed archive member path is unsafe".into());
    }
    Ok(())
}

fn filename_matches(pattern: &str, filename: &str) -> bool {
    if pattern.is_empty()
        || pattern
            .chars()
            .any(|c| !(c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '*')))
    {
        return false;
    }
    let pieces = pattern.split('*').collect::<Vec<_>>();
    if pieces.len() == 1 {
        return pattern.eq_ignore_ascii_case(filename);
    }
    let lower = filename.to_ascii_lowercase();
    let mut offset = 0;
    for (index, piece) in pieces.iter().enumerate() {
        if piece.is_empty() {
            continue;
        }
        let piece = piece.to_ascii_lowercase();
        let Some(found) = lower[offset..].find(&piece) else {
            return false;
        };
        if index == 0 && found != 0 {
            return false;
        }
        offset += found + piece.len();
    }
    pattern.ends_with('*')
        || pieces
            .last()
            .map(|piece| lower.ends_with(&piece.to_ascii_lowercase()))
            .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::installer::CustomerArtifactSource;
    use std::{collections::BTreeMap, io::Write};
    #[test]
    fn filename_patterns_are_bounded() {
        assert!(filename_matches(
            "MindTheGapps-15.0.0-*.zip",
            "MindTheGapps-15.0.0-arm64.zip"
        ));
        assert!(!filename_matches("*.zip", "archive.xz"));
        assert!(!filename_matches("../*.zip", "safe.zip"));
    }
    #[test]
    fn archive_member_rejects_traversal() {
        assert!(validate_member_path("payload/system.apk").is_ok());
        assert!(validate_member_path("../system.apk").is_err());
        assert!(validate_member_path("/system.apk").is_err());
    }
    #[test]
    fn accepts_only_exact_signed_customer_system_xz() {
        let directory = tempfile::tempdir().unwrap();
        let archive = directory.path().join("lineage-test.img.xz");
        let destination = directory.path().join("system.img");
        let payload = b"synthetic system image";
        let mut encoder = xz2::write::XzEncoder::new(File::create(&archive).unwrap(), 6);
        encoder.write_all(payload).unwrap();
        encoder.finish().unwrap();
        let archive_bytes = fs::read(&archive).unwrap();
        let artifact = Artifact {
            id: "system".into(),
            kind: "system".into(),
            delivery: ArtifactDelivery::CustomerSupplied,
            object_key: None,
            size: payload.len() as u64,
            sha256: hex::encode(Sha256::digest(payload)),
            component: Some("google_mobile_services".into()),
            source: Some(CustomerArtifactSource {
                label: "Owner system".into(),
                instructions_url: "https://example.com".into(),
                archive_filename_patterns: vec!["lineage-*.img.xz".into()],
                archive_size: archive_bytes.len() as u64,
                archive_sha256: hex::encode(Sha256::digest(&archive_bytes)),
                extracted_path: "system.img".into(),
            }),
            signed_fields: BTreeMap::new(),
        };
        assert_eq!(
            fs::read(prepare(&artifact, &archive, &destination).unwrap()).unwrap(),
            payload
        );
        let mut apk = artifact;
        apk.kind = "apk".into();
        assert!(prepare(&apk, &archive, &destination).is_err());
    }
}
