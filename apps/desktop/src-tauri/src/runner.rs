use std::{
    path::PathBuf,
    process::{Command, Output},
    thread,
    time::{Duration, Instant},
};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum RunnerError {
    #[error("Required tool '{0}' was not found. Install Android platform-tools or use a signed Revive bundle.")]
    MissingTool(String),
    #[error("{tool} failed: {detail}")]
    Failed { tool: String, detail: String },
    #[error("Timed out waiting for {0}")]
    Timeout(String),
}

pub fn run(tool: &str, args: &[&str]) -> Result<String, RunnerError> {
    let executable = resolve_tool(tool);
    let output = Command::new(&executable)
        .args(args)
        .output()
        .map_err(|_| RunnerError::MissingTool(tool.into()))?;
    output_text(tool, output)
}

pub fn wait_for(
    tool: &str,
    args: &[&str],
    description: &str,
    timeout: Duration,
) -> Result<String, RunnerError> {
    wait_for_match(tool, args, description, timeout, |value| {
        !value.trim().is_empty()
    })
}

pub fn wait_for_match<F>(
    tool: &str,
    args: &[&str],
    description: &str,
    timeout: Duration,
    ready: F,
) -> Result<String, RunnerError>
where
    F: Fn(&str) -> bool,
{
    let started = Instant::now();
    while started.elapsed() < timeout {
        if let Ok(value) = run(tool, args) {
            if ready(&value) {
                return Ok(value);
            }
        }
        thread::sleep(Duration::from_millis(500));
    }
    Err(RunnerError::Timeout(description.into()))
}

fn resolve_tool(tool: &str) -> PathBuf {
    if matches!(tool, "adb" | "fastboot") {
        if let Some(directory) = std::env::var_os("REVIVE_PLATFORM_TOOLS_DIR") {
            let filename = if cfg!(windows) {
                format!("{tool}.exe")
            } else {
                tool.to_string()
            };
            return PathBuf::from(directory).join(filename);
        }
    }
    PathBuf::from(tool)
}

fn output_text(tool: &str, output: Output) -> Result<String, RunnerError> {
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !output.status.success() {
        return Err(RunnerError::Failed {
            tool: tool.into(),
            detail: sanitize(&format!("{stdout}\n{stderr}")),
        });
    }
    Ok(format!("{stdout}\n{stderr}").trim().to_string())
}

pub fn sanitize(value: &str) -> String {
    let serial_pattern =
        regex::Regex::new(r"(?i)PS(?:G)?0?1[-_A-Z0-9]{8,}").expect("static serial pattern");
    value
        .lines()
        .take(12)
        .map(|line| if line.len() > 300 { &line[..300] } else { line })
        .map(|line| {
            serial_pattern
                .replace_all(line, "[REDACTED_DEVICE_SERIAL]")
                .into_owned()
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn diagnostic_output_redacts_psg1_serials() {
        let synthetic = "device PSG1-TEST-0001-A fastboot";
        assert!(!sanitize(synthetic).contains("PSG1-TEST-0001-A"));
    }
}
