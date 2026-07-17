use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::{fs, path::Path};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Stage {
    Detected,
    ProfileMatched,
    PreflightPassed,
    Licensed,
    Confirmed,
    ModificationStarted,
    Unlocked,
    Fastbootd,
    ArtifactsVerified,
    Flashed,
    Booted,
    AppsInstalled,
    Tested,
    Complete,
    RecoveryRequired,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Event {
    pub stage: Stage,
    pub at: DateTime<Utc>,
    pub detail: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Journal {
    pub stage: Stage,
    pub device_id: String,
    pub updated_at: DateTime<Utc>,
    pub events: Vec<Event>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub release_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_version: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artifact_set_sha256: Option<String>,
    /// Last durable stage before an interrupted installation. Old journals do
    /// not have this field, so deserialization must remain backwards compatible.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume_stage: Option<Stage>,
}

impl Journal {
    pub fn new(device_id: String) -> Self {
        let now = Utc::now();
        Self {
            stage: Stage::Detected,
            device_id,
            updated_at: now,
            events: vec![Event {
                stage: Stage::Detected,
                at: now,
                detail: "Device detected".into(),
            }],
            release_id: None,
            profile_id: None,
            profile_version: None,
            artifact_set_sha256: None,
            resume_stage: None,
        }
    }
    pub fn advance(&mut self, next: Stage, detail: impl Into<String>) -> Result<(), String> {
        if !allowed(self.stage, next) {
            return Err(format!(
                "Invalid installer transition: {:?} → {:?}",
                self.stage, next
            ));
        }
        self.stage = next;
        self.updated_at = Utc::now();
        self.events.push(Event {
            stage: next,
            at: self.updated_at,
            detail: detail.into(),
        });
        Ok(())
    }
    pub fn save(&self, path: &Path) -> Result<(), String> {
        let parent = path.parent().ok_or("Journal path is invalid")?;
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        let temp = path.with_extension("tmp");
        fs::write(
            &temp,
            serde_json::to_vec_pretty(self).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        fs::rename(temp, path).map_err(|e| e.to_string())
    }
    pub fn load(path: &Path) -> Result<Option<Self>, String> {
        if !path.exists() {
            return Ok(None);
        };
        serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
            .map(Some)
            .map_err(|e| e.to_string())
    }
    pub fn mark_recovery_required(&mut self, detail: impl Into<String>) {
        let durable = if self.stage == Stage::RecoveryRequired {
            self.resume_stage
        } else {
            Some(self.stage)
        };
        self.resume_stage = durable;
        self.stage = Stage::RecoveryRequired;
        self.updated_at = Utc::now();
        self.events.push(Event {
            stage: Stage::RecoveryRequired,
            at: self.updated_at,
            detail: detail.into(),
        });
    }
    pub fn resume(&mut self) -> Result<(), String> {
        if self.stage != Stage::RecoveryRequired {
            return Ok(());
        }
        let stage = self
            .resume_stage
            .take()
            .ok_or("Recovery journal does not contain a safe resume stage")?;
        self.stage = stage;
        self.updated_at = Utc::now();
        self.events.push(Event {
            stage,
            at: self.updated_at,
            detail: "Installer resumed after reconnecting the PSG1".into(),
        });
        Ok(())
    }
}
fn allowed(from: Stage, to: Stage) -> bool {
    use Stage::*;
    matches!(
        (from, to),
        (Detected, ProfileMatched)
            | (ProfileMatched, PreflightPassed)
            | (PreflightPassed, Licensed)
            | (Licensed, Confirmed)
            | (Confirmed, ModificationStarted)
            | (ModificationStarted, Unlocked)
            | (Unlocked, Fastbootd)
            | (Fastbootd, ArtifactsVerified)
            | (ArtifactsVerified, Flashed)
            | (Flashed, Booted)
            | (Booted, AppsInstalled)
            | (AppsInstalled, Tested)
            | (Tested, Complete)
            | (_, RecoveryRequired)
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cannot_skip_license() {
        let mut j = Journal::new("a".repeat(64));
        assert!(j.advance(Stage::Unlocked, "bad").is_err());
    }
    #[test]
    fn interrupted_install_can_resume_from_durable_stage() {
        let mut journal = Journal::new("a".repeat(64));
        journal.advance(Stage::ProfileMatched, "profile").unwrap();
        journal.mark_recovery_required("USB disconnected");
        assert_eq!(journal.resume_stage, Some(Stage::ProfileMatched));
        journal.resume().unwrap();
        assert_eq!(journal.stage, Stage::ProfileMatched);
    }
}
