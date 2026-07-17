use futures_util::StreamExt;
use reqwest::{
    header::{CONTENT_LENGTH, CONTENT_RANGE, RANGE},
    StatusCode,
};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    time::Duration,
};

pub async fn download(
    url: &str,
    destination: &Path,
    expected_size: u64,
    expected_sha256: &str,
) -> Result<PathBuf, String> {
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?
    }
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(30))
        .read_timeout(Duration::from_secs(90))
        .build()
        .map_err(|e| e.to_string())?;
    let mut last_error = "Download failed".to_string();
    for attempt in 0..3 {
        let existing = fs::metadata(destination).map(|m| m.len()).unwrap_or(0);
        if existing > expected_size {
            let _ = fs::remove_file(destination);
        }
        if existing == expected_size {
            if file_sha256(destination)? == expected_sha256 {
                return Ok(destination.to_path_buf());
            }
            let _ = fs::remove_file(destination);
        }
        let offset = fs::metadata(destination).map(|m| m.len()).unwrap_or(0);
        let response = client
            .get(url)
            .header(RANGE, format!("bytes={offset}-"))
            .send()
            .await;
        match response {
            Ok(response) if response.status().is_success() => {
                let append = response.status() == StatusCode::PARTIAL_CONTENT && offset > 0;
                let write_offset = if append { offset } else { 0 };
                let expected_response_bytes = expected_size.saturating_sub(write_offset);
                let content_length = response
                    .headers()
                    .get(CONTENT_LENGTH)
                    .and_then(|value| value.to_str().ok())
                    .and_then(|value| value.parse::<u64>().ok());
                if content_length != Some(expected_response_bytes) {
                    last_error =
                        "Artifact response Content-Length does not match the signed remaining size"
                            .into();
                    continue;
                }
                if append {
                    let content_range = response
                        .headers()
                        .get(CONTENT_RANGE)
                        .and_then(|value| value.to_str().ok());
                    if !content_range_matches(content_range, offset, expected_size) {
                        last_error =
                            "Artifact response Content-Range does not match the resume offset"
                                .into();
                        continue;
                    }
                }
                let mut file = OpenOptions::new()
                    .create(true)
                    .write(true)
                    .append(append)
                    .truncate(!append)
                    .open(destination)
                    .map_err(|e| e.to_string())?;
                let mut received = 0_u64;
                let mut stream = response.bytes_stream();
                let mut stream_error = None;
                while let Some(chunk) = stream.next().await {
                    match chunk {
                        Ok(chunk) => {
                            received = received
                                .checked_add(chunk.len() as u64)
                                .ok_or("Download size overflow")?;
                            if received > expected_response_bytes {
                                stream_error =
                                    Some("Artifact response exceeded the signed size".to_string());
                                break;
                            }
                            file.write_all(&chunk).map_err(|e| e.to_string())?;
                        }
                        Err(error) => {
                            stream_error = Some(error.to_string());
                            break;
                        }
                    }
                }
                file.sync_all().map_err(|e| e.to_string())?;
                if let Some(error) = stream_error {
                    last_error = error;
                    continue;
                }
                if received != expected_response_bytes {
                    last_error = "Artifact response ended before the signed size".into();
                    continue;
                }
                if fs::metadata(destination).map_err(|e| e.to_string())?.len() == expected_size
                    && file_sha256(destination)? == expected_sha256
                {
                    return Ok(destination.to_path_buf());
                }
                last_error = "Downloaded artifact did not match its signed size/hash".into();
            }
            Ok(response) => last_error = format!("Artifact server returned {}", response.status()),
            Err(error) => last_error = error.to_string(),
        }
        if attempt < 2 {
            tokio::time::sleep(Duration::from_secs(1 << attempt)).await;
        }
    }
    Err(last_error)
}

fn content_range_matches(value: Option<&str>, offset: u64, total: u64) -> bool {
    let Some(value) = value else { return false };
    let Some(rest) = value.strip_prefix("bytes ") else {
        return false;
    };
    let Some((range, total_text)) = rest.split_once('/') else {
        return false;
    };
    let Some((start, end)) = range.split_once('-') else {
        return false;
    };
    let (Ok(start), Ok(end), Ok(reported_total)) = (
        start.parse::<u64>(),
        end.parse::<u64>(),
        total_text.parse::<u64>(),
    ) else {
        return false;
    };
    start == offset && reported_total == total && end.checked_add(1) == Some(total) && end >= start
}

fn file_sha256(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 1024 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex::encode(hasher.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn hashes_streamed_files() {
        let file = tempfile::NamedTempFile::new().unwrap();
        fs::write(file.path(), b"revive").unwrap();
        assert_eq!(
            file_sha256(file.path()).unwrap(),
            "34f54b279dd0fa8b6fd6add091f024cdea7fc58afc62e3b3df1debd220082695"
        );
    }
    #[test]
    fn validates_exact_resume_content_range() {
        assert!(content_range_matches(Some("bytes 100-999/1000"), 100, 1000));
        assert!(!content_range_matches(Some("bytes 99-999/1000"), 100, 1000));
        assert!(!content_range_matches(
            Some("bytes 100-999/1001"),
            100,
            1000
        ));
    }
}
