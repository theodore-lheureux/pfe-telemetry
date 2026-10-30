mod common;

use common::*;
use pfe_server::envelope::digest;
use std::{sync::Arc, time::Duration};
use tonic::Code;

fn authorized(
    token: &str,
) -> tonic::Request<opentelemetry_proto::tonic::collector::metrics::v1::ExportMetricsServiceRequest>
{
    let mut request = export(request(), "");
    request
        .metadata_mut()
        .insert("authorization", format!("Bearer {token}").parse().unwrap());
    request
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "Requires disposable TEST_DATABASE_URL and web migrations"]
async fn web_management_lifecycle_authenticates_a_running_grpc_server() {
    use std::process::Stdio;
    use tokio::{
        io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
        process::Command,
    };
    let database = Database::new().await;
    let mut manager = Command::new("bun")
        .args(["--no-env-file", "tests/common/manage-credential.ts"])
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .env("DATABASE_URL", &database.management_url)
        .kill_on_drop(true)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = manager.stdin.take().unwrap();
    let mut output = BufReader::new(manager.stdout.take().unwrap());
    async fn response(output: &mut BufReader<tokio::process::ChildStdout>) -> serde_json::Value {
        let mut line = String::new();
        tokio::time::timeout(Duration::from_secs(10), output.read_line(&mut line))
            .await
            .expect("Credential manager response timed out")
            .unwrap();
        serde_json::from_str(&line).expect("Credential manager must return a private JSON result")
    }
    let created = response(&mut output).await;
    let token = created["token"].as_str().unwrap();
    let sink = Arc::new(TestSink::default());
    let (mut client, stop, task) = server_with_database(sink.clone(), database).await;
    client.export(authorized(token)).await.unwrap();
    {
        let records = sink.records.lock().unwrap();
        assert_eq!(
            records[0].project_id,
            created["projectId"].as_str().unwrap()
        );
        assert_eq!(records[0].source_id, "web-managed-source");
    }
    input.write_all(b"rotate\n").await.unwrap();
    let rotated = response(&mut output).await;
    let new_token = rotated["token"].as_str().unwrap();
    assert!(token != new_token);
    assert_eq!(
        client.export(authorized(token)).await.unwrap_err().code(),
        Code::Unauthenticated
    );
    client.export(authorized(new_token)).await.unwrap();
    input.write_all(b"revoke\n").await.unwrap();
    response(&mut output).await;
    assert_eq!(
        client
            .export(authorized(new_token))
            .await
            .unwrap_err()
            .code(),
        Code::Unauthenticated
    );
    assert_eq!(sink.records.lock().unwrap().len(), 2);
    input.write_all(b"stop\n").await.unwrap();
    drop(input);
    assert!(
        tokio::time::timeout(Duration::from_secs(10), manager.wait())
            .await
            .unwrap()
            .unwrap()
            .success()
    );
    let _ = stop.send(());
    task.await.unwrap();
}

#[tokio::test]
#[ignore = "Requires disposable TEST_DATABASE_URL and web migrations"]
async fn live_rotation_revocation_expiry_and_policy_use_authoritative_identity() {
    let database = Database::new().await;
    let control = database.client.clone();
    let sink = Arc::new(TestSink::default());
    let (mut client, stop, task) = server_with_database(sink.clone(), database).await;
    let mut spoofed = authorized(TOKEN);
    spoofed
        .metadata_mut()
        .insert("project-id", "spoofed-project".parse().unwrap());
    spoofed
        .metadata_mut()
        .insert("source-id", "spoofed-source".parse().unwrap());
    client.export(spoofed).await.unwrap();
    {
        let records = sink.records.lock().unwrap();
        assert_eq!(records[0].project_id, PROJECT_ID);
        assert_eq!(records[0].source_id, "trusted-source");
    }
    let mut duplicate = authorized(TOKEN);
    duplicate
        .metadata_mut()
        .append("authorization", format!("Bearer {TOKEN}").parse().unwrap());
    assert_eq!(
        client.export(duplicate).await.unwrap_err().code(),
        Code::InvalidArgument
    );
    for token in [
        "old-prototype-token-with-more-than-32-characters".to_owned(),
        TOKEN.replace(CREDENTIAL_ID, "019a4790-d1da-7000-8000-000000000099"),
        ROTATED_TOKEN.to_owned(),
        format!("{TOKEN}="),
    ] {
        assert_eq!(
            client.export(authorized(&token)).await.unwrap_err().code(),
            Code::Unauthenticated
        );
    }
    assert_eq!(sink.records.lock().unwrap().len(), 1);

    control
        .execute(
            "UPDATE ingestion.collector_credential SET token_sha256=$1, rotated_at=now()",
            &[&digest(ROTATED_TOKEN.as_bytes())],
        )
        .await
        .unwrap();
    assert_eq!(
        client.export(authorized(TOKEN)).await.unwrap_err().code(),
        Code::Unauthenticated
    );
    client.export(authorized(ROTATED_TOKEN)).await.unwrap();

    control
        .batch_execute("UPDATE ingestion.collector_credential SET hosts=ARRAY['other-node']")
        .await
        .unwrap();
    assert_eq!(
        client
            .export(authorized(ROTATED_TOKEN))
            .await
            .unwrap_err()
            .code(),
        Code::PermissionDenied
    );
    control.batch_execute("UPDATE ingestion.collector_credential SET hosts=ARRAY['node1'], maximum_submission_age=1, allowed_clock_skew=1").await.unwrap();
    let mut stale = export(request(), &uuid::Uuid::now_v7().to_string());
    stale.metadata_mut().insert(
        "authorization",
        format!("Bearer {ROTATED_TOKEN}").parse().unwrap(),
    );
    stale.metadata_mut().insert(
        "pfe-batch-created-unix-nano",
        (pfe_server::unix_nanos().unwrap() - 3_000_000_000)
            .to_string()
            .parse()
            .unwrap(),
    );
    assert_eq!(
        client.export(stale).await.unwrap_err().code(),
        Code::FailedPrecondition
    );

    control.batch_execute("UPDATE ingestion.collector_credential SET expires_at=statement_timestamp() + interval '500 milliseconds'").await.unwrap();
    client.export(authorized(ROTATED_TOKEN)).await.unwrap();
    tokio::time::sleep(Duration::from_millis(550)).await;
    assert_eq!(
        client
            .export(authorized(ROTATED_TOKEN))
            .await
            .unwrap_err()
            .code(),
        Code::Unauthenticated
    );
    control
        .batch_execute(
            "UPDATE ingestion.collector_credential SET expires_at=NULL, revoked_at=now()",
        )
        .await
        .unwrap();
    assert_eq!(
        client
            .export(authorized(ROTATED_TOKEN))
            .await
            .unwrap_err()
            .code(),
        Code::Unauthenticated
    );
    assert_eq!(sink.records.lock().unwrap().len(), 3);
    // Project cascade removes enrollment, not just application visibility.
    control
        .batch_execute("DELETE FROM app.project")
        .await
        .unwrap();
    assert_eq!(
        client
            .export(authorized(ROTATED_TOKEN))
            .await
            .unwrap_err()
            .code(),
        Code::Unauthenticated
    );
    drop(control);
    let _ = stop.send(());
    task.await.unwrap();
}

#[tokio::test]
#[ignore = "Requires disposable TEST_DATABASE_URL and web migrations"]
async fn same_source_credentials_have_independent_policies() {
    let database = Database::new().await;
    let token = TOKEN.replace(CREDENTIAL_ID, "019a4790-d1da-7000-8000-000000000003");
    database.client.execute(
        "INSERT INTO ingestion.collector_credential
         (id,organization_id,project_id,source_id,name,token_sha256,hosts,require_host_id)
         SELECT '019a4790-d1da-7000-8000-000000000003',organization_id,project_id,source_id,'Other',$1,ARRAY[]::text[],false
          FROM ingestion.collector_credential", &[&digest(token.as_bytes())]
    ).await.unwrap();
    let sink = Arc::new(TestSink::default());
    let (mut client, stop, task) = server_with_database(sink.clone(), database).await;
    let mut no_host = authorized(&token);
    no_host.get_mut().resource_metrics[0]
        .resource
        .as_mut()
        .unwrap()
        .attributes
        .clear();
    client.export(no_host).await.unwrap();
    // An optional host is not a wildcard permission for a supplied host.
    assert_eq!(
        client.export(authorized(&token)).await.unwrap_err().code(),
        Code::PermissionDenied
    );
    client.export(authorized(TOKEN)).await.unwrap();
    assert_eq!(sink.records.lock().unwrap().len(), 2);
    let _ = stop.send(());
    task.await.unwrap();
}

#[tokio::test]
#[ignore = "Requires disposable TEST_DATABASE_URL and web migrations"]
async fn authority_failures_are_bounded_fail_closed_and_recover() {
    let database = Database::new().await;
    let control = database.client.clone();
    let role = database.role.clone();
    let credentials = database.credentials();
    assert!(credentials.ready().await);
    let reader_config = database.credential_url.parse().unwrap();
    let (reader, connection) =
        tokio_postgres::Config::connect(&reader_config, tokio_postgres::NoTls)
            .await
            .unwrap();
    tokio::spawn(async move {
        let _ = connection.await;
    });
    reader
        .batch_execute("SET default_transaction_read_only=off")
        .await
        .unwrap();
    for sql in [
        "DELETE FROM ingestion.collector_credential",
        "SELECT * FROM app.user",
        "SELECT * FROM app.project",
    ] {
        assert_eq!(
            reader.batch_execute(sql).await.unwrap_err().code(),
            Some(&tokio_postgres::error::SqlState::INSUFFICIENT_PRIVILEGE)
        );
    }
    drop(reader);
    let sink = Arc::new(TestSink::default());
    let (mut client, stop, task) = server_with_database(sink.clone(), database).await;
    client.export(authorized(TOKEN)).await.unwrap();

    control
        .batch_execute(&format!(
            "REVOKE SELECT ON ingestion.collector_credential FROM {role}"
        ))
        .await
        .unwrap();
    assert!(!credentials.ready().await);
    assert_eq!(
        client.export(authorized(TOKEN)).await.unwrap_err().code(),
        Code::Unavailable
    );
    control
        .batch_execute(&format!(
            "GRANT SELECT ON ingestion.collector_credential TO {role}"
        ))
        .await
        .unwrap();
    assert!(credentials.ready().await);

    control
        .batch_execute("BEGIN; LOCK TABLE ingestion.collector_credential IN ACCESS EXCLUSIVE MODE")
        .await
        .unwrap();
    let started = std::time::Instant::now();
    let mut requests = Vec::new();
    for _ in 0..12 {
        let mut client = client.clone();
        requests.push(tokio::spawn(async move {
            client.export(authorized(TOKEN)).await.unwrap_err().code()
        }));
    }
    for request in requests {
        assert_eq!(request.await.unwrap(), Code::Unavailable);
    }
    assert!(started.elapsed() < Duration::from_secs(3));
    assert_eq!(sink.records.lock().unwrap().len(), 1);
    control.batch_execute("ROLLBACK").await.unwrap();
    client.export(authorized(TOKEN)).await.unwrap();
    assert_eq!(sink.records.lock().unwrap().len(), 2);

    control
        .batch_execute(&format!("ALTER ROLE {role} NOLOGIN"))
        .await
        .unwrap();
    control
        .query(
            "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename=$1",
            &[&role],
        )
        .await
        .unwrap();
    assert!(!credentials.ready().await);
    let started = std::time::Instant::now();
    assert_eq!(
        client.export(authorized(TOKEN)).await.unwrap_err().code(),
        Code::Unavailable
    );
    assert!(started.elapsed() < Duration::from_secs(3));
    assert_eq!(sink.records.lock().unwrap().len(), 2);
    control
        .batch_execute(&format!("ALTER ROLE {role} LOGIN"))
        .await
        .unwrap();
    client.export(authorized(TOKEN)).await.unwrap();

    control.batch_execute("ALTER TABLE ingestion.collector_credential DROP CONSTRAINT collector_credential_source; UPDATE ingestion.collector_credential SET source_id=''").await.unwrap();
    assert_eq!(
        client.export(authorized(TOKEN)).await.unwrap_err().code(),
        Code::Unavailable
    );
    control
        .batch_execute("UPDATE ingestion.collector_credential SET source_id='trusted-source'")
        .await
        .unwrap();

    control
        .batch_execute("DELETE FROM ingestion.collector_credential")
        .await
        .unwrap();
    assert!(
        credentials.ready().await,
        "An empty enrollment table is healthy"
    );
    assert_eq!(
        client.export(authorized(TOKEN)).await.unwrap_err().code(),
        Code::Unauthenticated
    );
    drop(credentials);
    drop(control);
    let _ = stop.send(());
    task.await.unwrap();
}

#[tokio::test]
#[ignore = "Requires non-TLS disposable TEST_DATABASE_URL and web migrations"]
async fn required_database_tls_never_falls_back_to_plaintext() {
    let database = Database::new().await;
    let ssl: String = database
        .client
        .query_one("SHOW ssl", &[])
        .await
        .unwrap()
        .get(0);
    assert_eq!(ssl, "off", "This fixture requires a non-TLS test server");
    for url in [
        database
            .credential_url
            .replace("sslmode=disable", "sslmode=require"),
        database.credential_url.replace("?sslmode=disable", ""),
    ] {
        let credentials = pfe_server::auth::Credentials::new(&url).unwrap();
        assert!(!credentials.ready().await);
        assert_eq!(
            credentials
                .authenticate(authorized(TOKEN).metadata())
                .await
                .err()
                .unwrap()
                .code(),
            Code::Unavailable
        );
    }
    assert!(database.credentials().ready().await);
    database.close().await;
}

#[tokio::test]
#[ignore = "Requires disposable TEST_DATABASE_URL and web migrations"]
async fn grpc_readiness_tracks_database_access_and_recovers() {
    use tokio_stream::wrappers::TcpListenerStream;
    use tonic_health::pb::{
        HealthCheckRequest, health_check_response::ServingStatus, health_client::HealthClient,
    };
    let database = Database::new().await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let router =
        pfe_server::configured_router(database.credentials(), Arc::new(TestSink::default())).await;
    let (stop, stopped) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        router
            .serve_with_incoming_shutdown(TcpListenerStream::new(listener), async {
                let _ = stopped.await;
            })
            .await
            .unwrap();
    });
    let channel = tonic::transport::Channel::from_shared(format!("http://{address}"))
        .unwrap()
        .connect()
        .await
        .unwrap();
    let mut health = HealthClient::new(channel);
    async fn reaches(
        health: &mut HealthClient<tonic::transport::Channel>,
        expected: ServingStatus,
    ) {
        tokio::time::timeout(Duration::from_secs(8), async {
            loop {
                let response = health
                    .check(HealthCheckRequest {
                        service: "opentelemetry.proto.collector.metrics.v1.MetricsService".into(),
                    })
                    .await
                    .unwrap()
                    .into_inner();
                if response.status == expected as i32 {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .unwrap();
    }
    reaches(&mut health, ServingStatus::Serving).await;
    database
        .client
        .batch_execute(&format!(
            "REVOKE SELECT ON ingestion.collector_credential FROM {}",
            database.role
        ))
        .await
        .unwrap();
    reaches(&mut health, ServingStatus::NotServing).await;
    assert_eq!(
        health
            .check(HealthCheckRequest {
                service: pfe_server::HEALTH_SERVICE.into()
            })
            .await
            .unwrap()
            .into_inner()
            .status,
        ServingStatus::Serving as i32
    );
    database
        .client
        .batch_execute(&format!(
            "GRANT SELECT ON ingestion.collector_credential TO {}",
            database.role
        ))
        .await
        .unwrap();
    reaches(&mut health, ServingStatus::Serving).await;
    let _ = stop.send(());
    server.await.unwrap();
    database.close().await;
}
