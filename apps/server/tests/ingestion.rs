mod common;
use common::*;
use opentelemetry_proto::tonic::metrics::v1::metric;
use std::sync::{Arc, atomic::Ordering};
use tonic::Code;
use uuid::Uuid;

#[tokio::test]
async fn gzip_ingestion_authenticates_and_retains_before_success() {
    let sink = Arc::new(TestSink::default());
    let (mut client, stop, task) = server(sink.clone()).await;
    let id = Uuid::now_v7().to_string();
    let response = client
        .export(export(request(), &id))
        .await
        .unwrap()
        .into_inner();
    assert!(response.partial_success.is_none());
    {
        let records = sink.records.lock().unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].project_id, "trusted-project");
        assert_eq!(records[0].source_id, "trusted-source");
        assert_eq!(records[0].client_batch_id, id);
    }
    sink.fail.store(true, Ordering::SeqCst);
    assert_eq!(
        client
            .export(export(request(), &Uuid::now_v7().to_string()))
            .await
            .unwrap_err()
            .code(),
        Code::Unavailable
    );
    assert_eq!(sink.records.lock().unwrap().len(), 1);
    let _ = stop.send(());
    task.await.unwrap();
}

#[tokio::test]
async fn rejects_invalid_batches_without_partial_publication() {
    let sink = Arc::new(TestSink::default());
    let (mut client, stop, task) = server(sink.clone()).await;
    assert_eq!(
        client.export(request()).await.unwrap_err().code(),
        Code::Unauthenticated
    );
    let mut invalid = request();
    invalid.resource_metrics[0]
        .resource
        .as_mut()
        .unwrap()
        .attributes[0] = attr("host.id", "other-node");
    assert_eq!(
        client.export(export(invalid, "")).await.unwrap_err().code(),
        Code::PermissionDenied
    );
    let mut invalid = request();
    let mut second = invalid.resource_metrics[0].scope_metrics[0].metrics[0].clone();
    let Some(metric::Data::Gauge(v)) = &mut second.data else {
        panic!()
    };
    v.data_points[0].time_unix_nano = 0;
    invalid.resource_metrics[0].scope_metrics[0]
        .metrics
        .push(second);
    assert_eq!(
        client.export(export(invalid, "")).await.unwrap_err().code(),
        Code::InvalidArgument
    );
    let mut invalid = export(request(), &Uuid::now_v7().to_string());
    invalid
        .metadata_mut()
        .insert("pfe-batch-created-unix-nano", "1".parse().unwrap());
    assert_eq!(
        client.export(invalid).await.unwrap_err().code(),
        Code::FailedPrecondition
    );
    let mut invalid = export(request(), &Uuid::now_v7().to_string());
    invalid.metadata_mut().insert(
        "pfe-batch-created-unix-nano",
        u64::MAX.to_string().parse().unwrap(),
    );
    assert_eq!(
        client.export(invalid).await.unwrap_err().code(),
        Code::InvalidArgument
    );
    for profile in ["compatibility", "external/1.1", "external/2.0"] {
        let mut invalid = export(request(), "");
        invalid
            .metadata_mut()
            .insert("pfe-collection-profile", profile.parse().unwrap());
        assert_eq!(
            client.export(invalid).await.unwrap_err().code(),
            Code::FailedPrecondition
        );
    }
    let mut invalid = export(request(), "");
    invalid
        .metadata_mut()
        .append("pfe-collection-profile", "external/1.0".parse().unwrap());
    invalid
        .metadata_mut()
        .append("pfe-collection-profile", "external/1.0".parse().unwrap());
    assert_eq!(
        client.export(invalid).await.unwrap_err().code(),
        Code::InvalidArgument
    );
    assert!(sink.records.lock().unwrap().is_empty());
    let _ = stop.send(());
    task.await.unwrap();
}

#[tokio::test]
async fn external_profile_requires_identity_and_correct_units() {
    let sink = Arc::new(TestSink::default());
    let (mut client, stop, task) = server(sink.clone()).await;
    let mut body = request();
    body.resource_metrics[0]
        .resource
        .as_mut()
        .unwrap()
        .attributes = vec![
        attr("host.id", "node1"),
        attr("pfe.host.boot_id", "boot"),
        attr("os.type", "linux"),
        attr("pfe.collection.scope", "node"),
        attr("pfe.collection.source", "test"),
        attr("pfe.collection.epoch_id", &Uuid::now_v7().to_string()),
    ];
    use opentelemetry_proto::tonic::common::v1::{AnyValue, KeyValue, any_value};
    body.resource_metrics[0]
        .resource
        .as_mut()
        .unwrap()
        .attributes
        .push(KeyValue {
            key: "pfe.collection.interval_ns".into(),
            value: Some(AnyValue {
                value: Some(any_value::Value::IntValue(1_000_000_000)),
            }),
            ..Default::default()
        });
    body.resource_metrics[0].scope_metrics[0].scope = Some(
        opentelemetry_proto::tonic::common::v1::InstrumentationScope {
            name: "test".into(),
            version: "1".into(),
            ..Default::default()
        },
    );
    let mut valid = export(body.clone(), &Uuid::now_v7().to_string());
    valid
        .metadata_mut()
        .insert("pfe-collection-profile", "external/1.0".parse().unwrap());
    client.export(valid).await.unwrap();
    body.resource_metrics[0].scope_metrics[0].metrics[0].unit = "bytes".into();
    let mut invalid = export(body, &Uuid::now_v7().to_string());
    invalid
        .metadata_mut()
        .insert("pfe-collection-profile", "external/1.0".parse().unwrap());
    assert_eq!(
        client.export(invalid).await.unwrap_err().code(),
        Code::InvalidArgument
    );
    assert_eq!(sink.records.lock().unwrap().len(), 1);
    let _ = stop.send(());
    task.await.unwrap();
}

#[tokio::test]
async fn oversized_requests_are_terminal_and_never_published() {
    let sink = Arc::new(TestSink::default());
    let (mut client, stop, task) = server(sink.clone()).await;
    let mut body = request();
    body.resource_metrics[0]
        .resource
        .as_mut()
        .unwrap()
        .attributes
        .push(attr("oversized", &"x".repeat(5 * 1024 * 1024)));
    assert_eq!(
        client.export(export(body, "")).await.unwrap_err().code(),
        Code::ResourceExhausted
    );
    assert!(sink.records.lock().unwrap().is_empty());
    let _ = stop.send(());
    task.await.unwrap();
}

#[tokio::test]
async fn response_waits_for_publication_confirmation() {
    use pfe_server::{Result, broker::Sink, envelope::Envelope};
    struct Delayed(tokio::sync::Semaphore);
    #[tonic::async_trait]
    impl Sink for Delayed {
        async fn publish(&self, _: &Envelope) -> Result<()> {
            let _permit = self.0.acquire().await?;
            Ok(())
        }
        async fn ready(&self) -> bool {
            true
        }
    }
    let sink = Arc::new(Delayed(tokio::sync::Semaphore::new(0)));
    let (mut client, stop, task) = server(sink.clone()).await;
    let response = tokio::spawn(async move { client.export(export(request(), "")).await });
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    assert!(!response.is_finished());
    sink.0.add_permits(1);
    response.await.unwrap().unwrap();
    let _ = stop.send(());
    task.await.unwrap();
}
