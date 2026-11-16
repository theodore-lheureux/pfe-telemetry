use std::sync::atomic::{AtomicUsize, Ordering};

use clap::Parser;
use opentelemetry_proto::tonic::collector::metrics::v1::metrics_service_server::{
    MetricsService, MetricsServiceServer,
};
use rcgen::{BasicConstraints, CertificateParams, IsCa, Issuer, KeyPair, KeyUsagePurpose};
use tokio::net::TcpListener;
use tonic::transport::{Certificate, ClientTlsConfig, Identity, Server, ServerTlsConfig};

use super::*;
use crate::config::Config;

#[derive(Clone)]
struct Receiver(Arc<AtomicUsize>);

#[tonic::async_trait]
impl MetricsService for Receiver {
    async fn export(
        &self,
        request: Request<ExportMetricsServiceRequest>,
    ) -> Result<Response<ExportMetricsServiceResponse>, Status> {
        assert_eq!(
            request.metadata().get("authorization").unwrap(),
            "Bearer test"
        );
        let connection = delivery::decode_connection(
            &request
                .metadata()
                .get_bin(delivery::HEADER)
                .unwrap()
                .to_bytes()
                .unwrap(),
        )
        .unwrap();
        assert!(connection.local_address.starts_with("127.0.0.1:"));
        assert!(connection.peer_address.starts_with("127.0.0.1:"));
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(Response::new(ExportMetricsServiceResponse::default()))
    }
}

#[tokio::test]
async fn https_export_verifies_ca_and_hostname_and_preserves_connection_diagnostics() {
    let mut ca_params = CertificateParams::new(Vec::<String>::new()).unwrap();
    ca_params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    ca_params.key_usages.push(KeyUsagePurpose::KeyCertSign);
    let ca_key = KeyPair::generate().unwrap();
    let ca = ca_params.self_signed(&ca_key).unwrap();
    let issuer = Issuer::new(ca_params, ca_key);
    let server_key = KeyPair::generate().unwrap();
    let server_cert = CertificateParams::new(vec!["127.0.0.1".to_owned()])
        .unwrap()
        .signed_by(&server_key, &issuer)
        .unwrap();
    let receiver = Receiver(Arc::new(AtomicUsize::new(0)));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("https://{}", listener.local_addr().unwrap());
    let (stop, stopped) = tokio::sync::oneshot::channel();
    let server = Server::builder()
        .tls_config(ServerTlsConfig::new().identity(Identity::from_pem(
            server_cert.pem(),
            server_key.serialize_pem(),
        )))
        .unwrap()
        .add_service(
            MetricsServiceServer::new(receiver.clone())
                .accept_compressed(CompressionEncoding::Gzip)
                .send_compressed(CompressionEncoding::Gzip),
        );
    let server = tokio::spawn(server.serve_with_incoming_shutdown(
        tonic::transport::server::TcpIncoming::from(listener),
        async {
            let _ = stopped.await;
        },
    ));
    let config = Config::try_parse_from(["collector", "--endpoint", &url]).unwrap();
    let request = || {
        let mut request = Request::new(ExportMetricsServiceRequest::default());
        request
            .metadata_mut()
            .insert("authorization", "Bearer test".parse().unwrap());
        request
    };

    // The test CA is not in the production trust store.
    assert!(
        Client::new(config.export().unwrap().endpoint)
            .export(request())
            .await
            .is_err()
    );
    let trusted = ClientTlsConfig::new()
        .with_enabled_roots()
        .ca_certificate(Certificate::from_pem(ca.pem()));
    let wrong_hostname = config
        .export()
        .unwrap()
        .endpoint
        .tls_config(trusted.clone().domain_name("wrong.example"))
        .unwrap();
    assert!(Client::new(wrong_hostname).export(request()).await.is_err());
    let endpoint = config
        .export()
        .unwrap()
        .endpoint
        .tls_config(trusted)
        .unwrap();
    let mut client = Client::new(endpoint);
    client.export(request()).await.unwrap();
    assert_eq!(receiver.0.load(Ordering::SeqCst), 1);

    drop(client);
    stop.send(()).unwrap();
    server.await.unwrap().unwrap();
}
