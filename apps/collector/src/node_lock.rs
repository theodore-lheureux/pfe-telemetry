//! Host-wide exclusion of collection runs that report the same node.
use std::{
    fs::{File, OpenOptions, TryLockError},
    io,
    os::unix::fs::OpenOptionsExt,
    path::Path,
    time::{Duration, Instant},
};

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};

use crate::spool::private_directory;

const RETRY: Duration = Duration::from_millis(100);

/// Waits up to `wait` for another run reporting `host_id` to stop. The lock lasts
/// until the returned file is dropped or the process exits.
pub(crate) async fn acquire(directory: &Path, host_id: &str, wait: Duration) -> io::Result<File> {
    let located = |error: io::Error| {
        io::Error::new(
            error.kind(),
            format!("Lock directory {}: {error}", directory.display()),
        )
    };
    private_directory(directory, "Lock").map_err(located)?;
    // Base64url keeps any valid host ID within one file-name component.
    let path = directory.join(format!("host-{}.lock", URL_SAFE_NO_PAD.encode(host_id)));
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .open(&path)
        .map_err(located)?;
    let deadline = Instant::now() + wait;
    let mut waiting = false;
    loop {
        match file.try_lock() {
            Ok(()) => return Ok(file),
            Err(TryLockError::Error(error)) => {
                return Err(io::Error::new(
                    error.kind(),
                    format!("Lock {}: {error}", path.display()),
                ));
            }
            Err(TryLockError::WouldBlock) if Instant::now() >= deadline => {
                return Err(io::Error::other(format!(
                    "Another collector is still reporting host {host_id} after {}s; stop it before starting this one (lock {})",
                    wait.as_secs_f32(),
                    path.display()
                )));
            }
            Err(TryLockError::WouldBlock) => {
                if !waiting {
                    waiting = true;
                    tracing::info!("Waiting for the previous collector of this host to stop");
                }
                tokio::time::sleep(RETRY).await;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, os::unix::fs::PermissionsExt};

    #[tokio::test]
    async fn one_run_per_host_waits_for_release_then_fails_clearly() {
        let directory =
            std::env::temp_dir().join(format!("recount-node-lock-{}", uuid::Uuid::now_v7()));
        let first = acquire(&directory, "node/1", Duration::ZERO).await.unwrap();
        let other_host = acquire(&directory, "node/2", Duration::ZERO).await.unwrap();

        let started = Instant::now();
        let refused = acquire(&directory, "node/1", Duration::from_millis(300))
            .await
            .unwrap_err();
        assert!(started.elapsed() >= Duration::from_millis(300));
        assert!(
            refused
                .to_string()
                .starts_with("Another collector is still reporting host node/1"),
            "{refused}"
        );

        let path = directory.clone();
        let waiting =
            tokio::spawn(async move { acquire(&path, "node/1", Duration::from_secs(10)).await });
        tokio::time::sleep(Duration::from_millis(250)).await;
        assert!(!waiting.is_finished());
        drop(first);
        let second = tokio::time::timeout(Duration::from_secs(5), waiting)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        drop((second, other_host));

        fs::set_permissions(&directory, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(acquire(&directory, "node/1", Duration::ZERO).await.is_err());
        fs::remove_dir_all(directory).unwrap();
    }
}
