use super::*;
use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use rcgen::{BasicConstraints, CertificateParams, IsCa, Issuer, KeyPair, KeyUsagePurpose};
use std::{path::Path, process::Command};

/// The Caddy release Ubuntu 24.04 packages for the ingestion host.
const CADDY_IMAGE: &str = "docker.io/library/caddy:2.6.2-alpine@sha256:25a0097607868fb05a89a5ab9fea2f2ea4cecdc89d887d7dcee8c778a21b9e1f";
const COLLECTOR_TEST: &str = "transport::tests::proxied_tls_export_and_credentials_are_live";

/// Removes the proxy container and fixture directory even when an assertion fails.
struct Proxy {
    container: String,
    directory: PathBuf,
}

impl Drop for Proxy {
    fn drop(&mut self) {
        let _ = Command::new("docker")
            .args(["rm", "--force", &self.container])
            .output();
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}

fn replace_once(text: &str, from: &str, to: &str) -> String {
    assert_eq!(text.matches(from).count(), 1, "Caddyfile changed: {from}");
    text.replacen(from, to, 1)
}

/// The production global options and ingestion site, with a local certificate, hostname and ports.
fn caddyfile(workspace: &Path, host: &str, port: u16, upstream: u16) -> String {
    let production =
        std::fs::read_to_string(workspace.join("infra/oci-ingestion/deploy/Caddyfile")).unwrap();
    let global = &production[..production.find("\n}\n").unwrap() + 3];
    let site_start = production.find("https://ingest.recount.cloud {").unwrap();
    let site_end = site_start + production[site_start..].find("\n}\n").unwrap() + 3;
    let site = &production[site_start..site_end];
    let tls_start = site.find("\ttls {").unwrap();
    let tls_end = tls_start + site[tls_start..].find("\n\t}\n").unwrap() + 4;
    let site = format!(
        "{}\ttls /fixture/server.pem /fixture/server.key\n{}",
        &site[..tls_start],
        &site[tls_end..]
    );
    let site = replace_once(
        &site,
        "https://ingest.recount.cloud",
        &format!("https://{host}:{port}"),
    );
    let site = replace_once(
        &site,
        "h2c://127.0.0.1:14317",
        &format!("h2c://127.0.0.1:{upstream}"),
    );
    format!("{global}\n{site}")
}

fn authority() -> (String, Issuer<'static, KeyPair>) {
    let mut params = CertificateParams::new(Vec::<String>::new()).unwrap();
    params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    params.key_usages.push(KeyUsagePurpose::KeyCertSign);
    let key = KeyPair::generate().unwrap();
    let pem = params.self_signed(&key).unwrap().pem();
    (pem, Issuer::new(params, key))
}

/// One collector export and the status it must receive through the proxy.
fn case(
    name: &str,
    token: Option<&str>,
    body: &ExportMetricsServiceRequest,
    code: Code,
) -> serde_json::Value {
    serde_json::json!({
        "name": name,
        "token": token,
        "body": STANDARD.encode(body.encode_to_vec()),
        "code": code as i32,
    })
}

#[tokio::test]
#[ignore = "requires PostgreSQL, Bun, Docker host networking and a Linux collector test executable"]
async fn collector_exports_through_the_production_tls_proxy() {
    let executable = std::env::var("RECOUNT_TLS_TEST_COLLECTOR_TESTS")
        .expect("The Linux recount-collector library test executable is required");
    let runner = std::env::var("RECOUNT_TLS_TEST_COLLECTOR_RUNNER").unwrap_or_default();
    let host = std::env::var("RECOUNT_TLS_TEST_HOST").unwrap_or_else(|_| "localhost".into());
    let workspace = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap();

    let db = Database::new().await;
    let public = URL_SAFE_NO_PAD.encode(signing().verifying_key().as_bytes());
    let tokens = Arc::new(auth::NodeTokens::new(&db.reader_url, &[public]).unwrap());
    db.client
        .execute(
            "UPDATE ingestion.collector_node SET revoked_at=statement_timestamp() WHERE id=$1",
            &[&db.other_node],
        )
        .await
        .unwrap();
    assert!(tokens.refresh_revocations().await);
    let sink = Arc::new(TestSink::default());
    let (_, upstream, stop, task) = server(tokens.clone(), sink.clone(), Limits::default()).await;
    let upstream = upstream.rsplit_once(':').unwrap().1.parse::<u16>().unwrap();

    let name = format!("recount-tls-test-{}", Uuid::now_v7().simple());
    let relative = format!(".state/{name}");
    let proxy = Proxy {
        container: name.clone(),
        directory: workspace.join(&relative),
    };
    std::fs::create_dir_all(&proxy.directory).unwrap();
    let (ca, issuer) = authority();
    let (other_ca, _) = authority();
    let server_key = KeyPair::generate().unwrap();
    let server_cert = CertificateParams::new(vec![host.clone()])
        .unwrap()
        .signed_by(&server_key, &issuer)
        .unwrap();
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    for (file, contents) in [
        ("ca.pem", ca),
        ("server.pem", server_cert.pem()),
        ("server.key", server_key.serialize_pem()),
        ("Caddyfile", caddyfile(&workspace, &host, port, upstream)),
    ] {
        std::fs::write(proxy.directory.join(file), contents).unwrap();
    }

    let mut impersonation = body();
    impersonation.resource_metrics[0].resource = Some(Resource {
        attributes: vec![
            string("recount.resource.id", "other"),
            string("recount.resource.kind", "host"),
        ],
        ..Default::default()
    });
    let foreign = ed25519_dalek::SigningKey::from_bytes(&[9; 32]);
    let current = token(&db, db.node, serde_json::json!({}));
    let expired = token(&db, db.node, serde_json::json!({ "iat": 1, "exp": 2 }));
    let revoked = token(&db, db.other_node, serde_json::json!({}));
    let untrusted = signed_token(&foreign, &db, db.node, serde_json::json!({}));
    let fixture = serde_json::json!({
        "endpoint": format!("https://{host}:{port}"),
        "upstream": format!("{host}:{upstream}"),
        "other_ca": other_ca,
        "cases": [
            case("missing", None, &body(), Code::Unauthenticated),
            case("expired", Some(&expired), &body(), Code::Unauthenticated),
            case("revoked", Some(&revoked), &body(), Code::Unauthenticated),
            case("untrusted signer", Some(&untrusted), &body(), Code::Unauthenticated),
            case("another machine", Some(&current), &impersonation, Code::PermissionDenied),
            case("accepted", Some(&current), &body(), Code::Ok),
        ],
    });
    std::fs::write(proxy.directory.join("fixture.json"), fixture.to_string()).unwrap();

    let status = Command::new("docker")
        .args([
            "run",
            "--detach",
            "--name",
            &name,
            "--label",
            "recount-tls-test",
            "--network",
            "host",
            "--volume",
        ])
        .arg(format!("{}:/fixture:ro", proxy.directory.display()))
        .args([
            CADDY_IMAGE,
            "caddy",
            "run",
            "--config",
            "/fixture/Caddyfile",
            "--adapter",
            "caddyfile",
        ])
        .stdout(std::process::Stdio::null())
        .status()
        .unwrap();
    assert!(status.success(), "Caddy did not start");
    let deadline = std::time::Instant::now() + Duration::from_secs(15);
    while tokio::net::TcpStream::connect(("127.0.0.1", port))
        .await
        .is_err()
    {
        assert!(
            std::time::Instant::now() < deadline,
            "Caddy is not listening: {}",
            String::from_utf8_lossy(
                &Command::new("docker")
                    .args(["logs", &name])
                    .output()
                    .unwrap()
                    .stderr
            )
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    let mut command = runner
        .split_whitespace()
        .map(str::to_owned)
        .collect::<Vec<_>>();
    command.extend([
        "env".into(),
        format!("SSL_CERT_FILE={relative}/ca.pem"),
        format!("RECOUNT_TLS_TEST_FIXTURE={relative}/fixture.json"),
        executable,
        COLLECTOR_TEST.into(),
        "--ignored".into(),
        "--exact".into(),
        "--nocapture".into(),
    ]);
    let status = tokio::task::spawn_blocking(move || {
        Command::new(&command[0])
            .args(&command[1..])
            .current_dir(workspace)
            .status()
    })
    .await
    .unwrap()
    .unwrap();
    assert!(status.success(), "Collector TLS checks failed");

    {
        let records = sink.records.lock().unwrap();
        assert_eq!(records.len(), 1);
        let security = records[0].security.as_ref().unwrap();
        assert_eq!(security.project_id, db.project.to_string());
        assert_eq!(security.source_id, db.node.to_string());
        assert!(records[0].delivery.is_some());
    }
    drop(proxy);
    stop.send(()).unwrap();
    task.await.unwrap();
    drop(tokens);
    db.close().await;
}
