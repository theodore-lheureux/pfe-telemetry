use std::{
    fs::{self, DirBuilder, OpenOptions},
    io::{self, Write},
    os::unix::fs::{DirBuilderExt, OpenOptionsExt},
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use ed25519_dalek::{Signer, SigningKey};
use serde::{Deserialize, Serialize};
use tokio::sync::{Notify, watch};
use tonic::metadata::{Ascii, MetadataValue};
use uuid::Uuid;

use crate::spool::Result;

const NODE_FILE: &str = "node.json";
const KEY_FILE: &str = "node.key";
/// Refresh this long before expiry so a slow web application does not interrupt uploads.
const REFRESH_MARGIN_SECONDS: u64 = 600;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_RETRY: Duration = Duration::from_secs(60);

/// Where and how this collector enrolls.
pub(crate) struct EnrollmentConfig {
    /// Web application base URL, ending in `/`.
    pub url: reqwest::Url,
    pub key_file: Option<PathBuf>,
    pub state_directory: PathBuf,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NodeFile {
    node_id: Uuid,
    project_id: Uuid,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Issued {
    node_id: Uuid,
    project_id: Uuid,
    token: String,
}

#[derive(Deserialize)]
struct Rejection {
    error: String,
}

#[derive(Deserialize)]
struct Expiry {
    exp: u64,
}

enum RequestError {
    /// The web application refused the request; retrying unchanged will not help.
    Rejected(String),
    Transient(String),
}

impl std::fmt::Display for RequestError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Rejected(code) => write!(f, "rejected with {code}"),
            Self::Transient(reason) => f.write_str(reason),
        }
    }
}

/// The current upload bearer token, renewed in the background.
#[derive(Clone)]
pub(crate) struct Authorization {
    token: watch::Receiver<Option<MetadataValue<Ascii>>>,
    stale: Arc<Notify>,
}

impl Authorization {
    #[cfg(test)]
    pub(crate) fn new(
        token: watch::Receiver<Option<MetadataValue<Ascii>>>,
        stale: Arc<Notify>,
    ) -> Self {
        Self { token, stale }
    }

    pub(crate) fn current(&self) -> Option<MetadataValue<Ascii>> {
        self.token.borrow().clone()
    }

    /// Waits for a different token, or forever once renewal has stopped.
    pub(crate) async fn changed(&mut self) {
        if self.token.changed().await.is_err() {
            std::future::pending::<()>().await;
        }
    }

    /// Reports that the ingestion service refused the current token.
    pub(crate) fn reject(&self) {
        self.stale.notify_one();
    }
}

struct Node {
    id: Uuid,
    signing: SigningKey,
    client: reqwest::Client,
    url: reqwest::Url,
}

/// Loads this node's identity, enrolling first if needed, and starts token renewal.
/// The first enrollment retries transient failures until it succeeds.
pub(crate) async fn start(
    config: EnrollmentConfig,
    machine_id: &str,
) -> Result<(Uuid, Authorization)> {
    // Another TLS user may already have installed the process-wide provider.
    let _ = rustls::crypto::ring::default_provider().install_default();
    DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&config.state_directory)?;
    let signing = signing_key(&config.state_directory.join(KEY_FILE))?;
    let client = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .user_agent(concat!("recount-collector/", env!("CARGO_PKG_VERSION")))
        .build()?;
    let node_path = config.state_directory.join(NODE_FILE);
    let (id, token) = match fs::read(&node_path) {
        Ok(contents) => {
            let node: NodeFile = serde_json::from_slice(&contents)
                .map_err(|_| io::Error::other(format!("Invalid {}", node_path.display())))?;
            tracing::info!(node_id = %node.node_id, project_id = %node.project_id, "Loaded collector node");
            (node.node_id, None)
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            let key_file = config.key_file.as_deref().ok_or_else(|| {
                io::Error::other("Enrolling this node requires --enrollment-key-file")
            })?;
            let issued = enroll(&client, &config.url, key_file, machine_id, &signing).await?;
            write_private(
                &node_path,
                &serde_json::to_vec(&NodeFile {
                    node_id: issued.node_id,
                    project_id: issued.project_id,
                })?,
            )?;
            tracing::info!(node_id = %issued.node_id, project_id = %issued.project_id, "Enrolled collector node");
            (issued.node_id, Some(issued.token))
        }
        Err(error) => return Err(error.into()),
    };
    let node = Node {
        id,
        signing,
        client,
        url: config.url,
    };
    let expires = token.as_deref().and_then(expiry).unwrap_or(0);
    let (sender, receiver) = watch::channel(token.as_deref().and_then(bearer));
    let stale = Arc::new(Notify::new());
    tokio::spawn(renew(node, sender, stale.clone(), expires));
    Ok((
        id,
        Authorization {
            token: receiver,
            stale,
        },
    ))
}

async fn enroll(
    client: &reqwest::Client,
    url: &reqwest::Url,
    key_file: &Path,
    machine_id: &str,
    signing: &SigningKey,
) -> Result<Issued> {
    let key = fs::read_to_string(key_file)?.trim().to_owned();
    let hostname = fs::read_to_string("/proc/sys/kernel/hostname")
        .map(|name| name.trim().to_owned())
        .ok()
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| machine_id.to_owned());
    let body = serde_json::json!({
        "enrollmentKey": key,
        "machineId": machine_id,
        "hostname": hostname,
        "publicKey": URL_SAFE_NO_PAD.encode(signing.verifying_key().as_bytes()),
        "collectorVersion": env!("CARGO_PKG_VERSION"),
    });
    let mut failures = 0;
    loop {
        match post(client, url, "api/collectors/enroll", &body).await {
            Ok(issued) => return Ok(issued),
            Err(RequestError::Rejected(code)) => {
                return Err(io::Error::other(format!("Enrollment was rejected: {code}")).into());
            }
            Err(error) => {
                failures += 1;
                let delay = retry_delay(failures);
                tracing::warn!(%error, retry_ms = delay.as_millis(), "Enrollment pending");
                tokio::time::sleep(delay).await;
            }
        }
    }
}

/// Keeps a valid token published: renews before expiry and whenever the ingestion
/// service refuses the current one.
async fn renew(
    node: Node,
    sender: watch::Sender<Option<MetadataValue<Ascii>>>,
    stale: Arc<Notify>,
    mut expires: u64,
) {
    let mut failures = 0;
    loop {
        if failures == 0 {
            let due = expires.saturating_sub(REFRESH_MARGIN_SECONDS);
            let now = unix_seconds();
            if due > now {
                tokio::select! {
                    () = tokio::time::sleep(Duration::from_secs(due - now)) => {}
                    () = stale.notified() => {}
                }
            }
        } else {
            tokio::time::sleep(retry_delay(failures)).await;
        }
        match node.token().await {
            Ok(token) => {
                failures = 0;
                expires = expiry(&token).unwrap_or(0);
                sender.send_replace(bearer(&token));
            }
            Err(error) => {
                failures += 1;
                if matches!(error, RequestError::Rejected(_)) {
                    tracing::error!(node_id = %node.id, %error, "Access token refused; the node may be revoked. Remove node.json to enroll again");
                } else {
                    tracing::warn!(%error, "Access token renewal pending");
                }
                // Stop offering an expired token so uploads wait instead of failing.
                if unix_seconds() >= expires {
                    sender.send_replace(None);
                }
            }
        }
        if sender.is_closed() {
            return;
        }
    }
}

impl Node {
    async fn token(&self) -> std::result::Result<String, RequestError> {
        let timestamp = unix_seconds();
        let message = format!("recount-collector-token\n{}\n{timestamp}", self.id);
        let signature = self.signing.sign(message.as_bytes());
        let body = serde_json::json!({
            "nodeId": self.id,
            "timestamp": timestamp,
            "signature": URL_SAFE_NO_PAD.encode(signature.to_bytes()),
        });
        let issued = post(&self.client, &self.url, "api/collectors/token", &body).await?;
        if issued.node_id != self.id {
            return Err(RequestError::Rejected("UNEXPECTED_NODE".into()));
        }
        Ok(issued.token)
    }
}

async fn post(
    client: &reqwest::Client,
    url: &reqwest::Url,
    path: &str,
    body: &serde_json::Value,
) -> std::result::Result<Issued, RequestError> {
    let url = url
        .join(path)
        .map_err(|error| RequestError::Transient(error.to_string()))?;
    let response = client
        .post(url)
        .json(body)
        .send()
        .await
        .map_err(|error| RequestError::Transient(error.without_url().to_string()))?;
    let status = response.status();
    if status.is_success() {
        return response.json().await.map_err(|_| {
            RequestError::Transient("Invalid response from the web application".into())
        });
    }
    if status.is_client_error() && status != reqwest::StatusCode::TOO_MANY_REQUESTS {
        let code = response
            .json::<Rejection>()
            .await
            .map_or_else(|_| status.to_string(), |rejection| rejection.error);
        return Err(RequestError::Rejected(code));
    }
    Err(RequestError::Transient(format!(
        "web application returned {status}"
    )))
}

/// Loads the node's private key, creating it on first start.
fn signing_key(path: &Path) -> Result<SigningKey> {
    match fs::read(path) {
        Ok(seed) => {
            let seed: [u8; 32] = seed
                .try_into()
                .map_err(|_| io::Error::other(format!("Invalid {}", path.display())))?;
            Ok(SigningKey::from_bytes(&seed))
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            let mut seed = [0; 32];
            getrandom::fill(&mut seed).map_err(|_| io::Error::other("No system randomness"))?;
            write_private(path, &seed)?;
            Ok(SigningKey::from_bytes(&seed))
        }
        Err(error) => Err(error.into()),
    }
}

/// Atomically replaces `path` with an owner-only file.
fn write_private(path: &Path, contents: &[u8]) -> io::Result<()> {
    let temporary = path.with_extension("tmp");
    let _ = fs::remove_file(&temporary);
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temporary)?;
    file.write_all(contents)?;
    file.sync_all()?;
    fs::rename(&temporary, path)?;
    if let Some(parent) = path.parent() {
        fs::File::open(parent)?.sync_all()?;
    }
    Ok(())
}

fn bearer(token: &str) -> Option<MetadataValue<Ascii>> {
    let mut value: MetadataValue<Ascii> = format!("Bearer {token}").parse().ok()?;
    value.set_sensitive(true);
    Some(value)
}

/// Reads `exp` without verifying the token; the ingestion service verifies it.
fn expiry(token: &str) -> Option<u64> {
    let payload = token.split('.').nth(1)?;
    let expiry: Expiry = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload).ok()?).ok()?;
    Some(expiry.exp)
}

fn retry_delay(failures: u32) -> Duration {
    let ceiling = Duration::from_secs(1 << failures.min(6)).min(MAX_RETRY);
    // Equal jitter keeps a restarted fleet from renewing in lockstep.
    let random = Uuid::new_v4().as_u128() as u64;
    let half = ceiling.as_millis() as u64 / 2;
    Duration::from_millis(half + random % (half + 1))
}

fn unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signature, VerifyingKey};
    use std::{os::unix::fs::PermissionsExt, sync::Mutex};
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };

    #[derive(Default)]
    struct WebState {
        public_key: Option<VerifyingKey>,
        node: Uuid,
        project: Uuid,
        tokens: u64,
        refuse: bool,
        paths: Vec<String>,
    }

    fn token(serial: u64, exp: u64) -> String {
        let payload = URL_SAFE_NO_PAD.encode(format!(r#"{{"exp":{exp},"serial":{serial}}}"#));
        format!("e30.{payload}.c2ln")
    }

    /// A minimal stand-in for the web application's collector endpoints.
    async fn web(state: Arc<Mutex<WebState>>) -> reqwest::Url {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/", listener.local_addr().unwrap());
        tokio::spawn(async move {
            loop {
                let (mut stream, _) = listener.accept().await.unwrap();
                let state = state.clone();
                tokio::spawn(async move {
                    let mut buffer = Vec::new();
                    let (head, body) = loop {
                        let mut chunk = [0; 4096];
                        let read = stream.read(&mut chunk).await.unwrap();
                        buffer.extend_from_slice(&chunk[..read]);
                        let text = String::from_utf8_lossy(&buffer).to_string();
                        if let Some((head, body)) = text.split_once("\r\n\r\n") {
                            let length = head
                                .lines()
                                .find_map(|line| {
                                    line.to_ascii_lowercase()
                                        .strip_prefix("content-length: ")
                                        .map(|value| value.parse::<usize>().unwrap())
                                })
                                .unwrap_or(0);
                            if body.len() >= length {
                                break (head.to_owned(), body.to_owned());
                            }
                        }
                    };
                    let path = head.split(' ').nth(1).unwrap().to_owned();
                    let body: serde_json::Value = serde_json::from_str(&body).unwrap();
                    let (status, reply) = respond(&mut state.lock().unwrap(), &path, &body);
                    let reply = reply.to_string();
                    let response = format!(
                        "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{reply}",
                        reply.len()
                    );
                    stream.write_all(response.as_bytes()).await.unwrap();
                });
            }
        });
        reqwest::Url::parse(&url).unwrap()
    }

    fn respond(
        state: &mut WebState,
        path: &str,
        body: &serde_json::Value,
    ) -> (&'static str, serde_json::Value) {
        state.paths.push(path.to_owned());
        let issue = |state: &mut WebState| {
            state.tokens += 1;
            serde_json::json!({
                "nodeId": state.node,
                "projectId": state.project,
                "token": token(state.tokens, unix_seconds() + 3600),
            })
        };
        if state.refuse {
            return ("403 Forbidden", serde_json::json!({ "error": "FORBIDDEN" }));
        }
        match path {
            "/api/collectors/enroll" => {
                assert_eq!(body["enrollmentKey"], "recount_enroll_test");
                assert_eq!(body["machineId"], "machine-a");
                let key: [u8; 32] = URL_SAFE_NO_PAD
                    .decode(body["publicKey"].as_str().unwrap())
                    .unwrap()
                    .try_into()
                    .unwrap();
                state.public_key = Some(VerifyingKey::from_bytes(&key).unwrap());
                ("200 OK", issue(state))
            }
            "/api/collectors/token" => {
                let message = format!(
                    "recount-collector-token\n{}\n{}",
                    body["nodeId"].as_str().unwrap(),
                    body["timestamp"]
                );
                let signature: [u8; 64] = URL_SAFE_NO_PAD
                    .decode(body["signature"].as_str().unwrap())
                    .unwrap()
                    .try_into()
                    .unwrap();
                let valid = state
                    .public_key
                    .unwrap()
                    .verify_strict(message.as_bytes(), &Signature::from_bytes(&signature));
                if valid.is_err() {
                    return ("403 Forbidden", serde_json::json!({ "error": "FORBIDDEN" }));
                }
                ("200 OK", issue(state))
            }
            _ => ("404 Not Found", serde_json::json!({ "error": "NOT_FOUND" })),
        }
    }

    fn serial(authorization: &Authorization) -> Option<u64> {
        let value = authorization.current()?;
        let token = value.to_str().unwrap().strip_prefix("Bearer ").unwrap();
        let payload: serde_json::Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(token.split('.').nth(1)?).unwrap())
                .unwrap();
        payload["serial"].as_u64()
    }

    async fn until(mut condition: impl FnMut() -> bool) {
        tokio::time::timeout(Duration::from_secs(10), async {
            while !condition() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn nodes_enroll_once_then_renew_with_their_own_key() {
        let directory = std::env::temp_dir().join(format!("recount-enrollment-{}", Uuid::now_v7()));
        let state = Arc::new(Mutex::new(WebState {
            node: Uuid::now_v7(),
            project: Uuid::now_v7(),
            ..WebState::default()
        }));
        let url = web(state.clone()).await;
        let key_file = directory.join("enrollment-key");
        let state_directory = directory.join("state");
        fs::create_dir(&directory).unwrap();
        fs::write(&key_file, "recount_enroll_test\n").unwrap();
        let config = |key_file: Option<PathBuf>| EnrollmentConfig {
            url: url.clone(),
            key_file,
            state_directory: state_directory.clone(),
        };

        let (node, authorization) = start(config(Some(key_file.clone())), "machine-a")
            .await
            .unwrap();
        assert_eq!(node, state.lock().unwrap().node);
        assert_eq!(serial(&authorization), Some(1));
        assert!(authorization.current().unwrap().is_sensitive());
        for file in [NODE_FILE, KEY_FILE] {
            let mode = fs::metadata(state_directory.join(file))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }

        // The ingestion service refusing a token triggers an early renewal.
        authorization.reject();
        until(|| serial(&authorization) == Some(2)).await;

        // A restart reuses the stored identity without the enrollment key.
        fs::remove_file(&key_file).unwrap();
        let (restarted, mut authorization) = start(config(None), "machine-a").await.unwrap();
        assert_eq!(restarted, node);
        authorization.changed().await;
        assert_eq!(serial(&authorization), Some(3));
        assert_eq!(
            state.lock().unwrap().paths,
            [
                "/api/collectors/enroll",
                "/api/collectors/token",
                "/api/collectors/token"
            ]
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[tokio::test]
    async fn refused_enrollment_fails_and_missing_keys_are_reported() {
        let directory = std::env::temp_dir().join(format!("recount-enrollment-{}", Uuid::now_v7()));
        fs::create_dir(&directory).unwrap();
        let state = Arc::new(Mutex::new(WebState {
            refuse: true,
            ..WebState::default()
        }));
        let url = web(state).await;
        let key_file = directory.join("enrollment-key");
        fs::write(&key_file, "recount_enroll_test").unwrap();
        let config = |key_file: Option<PathBuf>| EnrollmentConfig {
            url: url.clone(),
            key_file,
            state_directory: directory.join("state"),
        };
        let refused = start(config(Some(key_file)), "machine-a").await;
        assert!(refused.err().unwrap().to_string().contains("FORBIDDEN"));
        assert!(!directory.join("state").join(NODE_FILE).exists());
        let missing = start(config(None), "machine-a").await;
        assert!(
            missing
                .err()
                .unwrap()
                .to_string()
                .contains("--enrollment-key-file")
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn expiry_is_read_from_the_token_payload() {
        assert_eq!(expiry(&token(1, 1_800_000_000)), Some(1_800_000_000));
        assert_eq!(expiry("not-a-token"), None);
        for failures in 1..20 {
            assert!(retry_delay(failures) <= MAX_RETRY);
        }
    }
}
