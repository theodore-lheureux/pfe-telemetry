use std::{
    io,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use hyper_util::{client::legacy::connect::HttpConnector, rt::TokioIo};
use opentelemetry_proto::tonic::collector::metrics::v1::{
    ExportMetricsServiceRequest, ExportMetricsServiceResponse,
    metrics_service_client::MetricsServiceClient,
};
use prost::Message;
use recount_telemetry_validation::delivery::{self, CollectorConnection};
use tonic::{
    Request, Response, Status,
    codec::CompressionEncoding,
    transport::{Channel, Endpoint},
};
use tower::Service;

use crate::{
    network,
    spool::{MAX_REQUEST_BYTES, unix_nanos},
};

const TIMEOUT: Duration = Duration::from_secs(3);
const INVENTORY_INTERVAL: Duration = Duration::from_secs(60);

pub(crate) struct Client {
    endpoint: Endpoint,
    connection: Option<Connection>,
}

struct Connection {
    client: MetricsServiceClient<Channel>,
    diagnostics: CollectorConnection,
    inventory_at: Instant,
}

impl Client {
    pub(crate) fn new(endpoint: Endpoint) -> Self {
        Self {
            endpoint,
            connection: None,
        }
    }

    pub(crate) async fn export(
        &mut self,
        mut request: Request<ExportMetricsServiceRequest>,
    ) -> Result<Response<ExportMetricsServiceResponse>, Status> {
        if self.connection.is_none() {
            self.connection = Some(
                tokio::time::timeout(TIMEOUT, connect(self.endpoint.clone()))
                    .await
                    .map_err(|_| Status::unavailable("Connection timed out"))??,
            );
        }
        let connection = self.connection.as_mut().unwrap();
        if connection.inventory_at.elapsed() >= INVENTORY_INTERVAL {
            connection.diagnostics = inventory(connection.diagnostics.clone()).await?;
            connection.inventory_at = Instant::now();
        }
        request.metadata_mut().insert_bin(
            delivery::HEADER,
            tonic::metadata::MetadataValue::from_bytes(&connection.diagnostics.encode_to_vec()),
        );
        let result = connection.client.export(request).await;
        if result.is_err() {
            self.connection = None;
        }
        result
    }
}

async fn inventory(mut value: CollectorConnection) -> Result<CollectorConnection, Status> {
    tokio::task::spawn_blocking(move || {
        let observed =
            unix_nanos().map_err(|_| Status::unavailable("Diagnostics clock is unavailable"))?;
        network::refresh(&mut value, observed);
        delivery::validate_connection(&value)
            .map_err(|_| Status::internal("Invalid local connection diagnostics"))?;
        Ok(value)
    })
    .await
    .map_err(|_| Status::internal("Connection diagnostics failed"))?
}

async fn connect(endpoint: Endpoint) -> Result<Connection, Status> {
    let mut connector = HttpConnector::new();
    connector.set_connect_timeout(Some(TIMEOUT));
    connector.set_nodelay(true);
    let socket = connector
        .call(endpoint.uri().clone())
        .await
        .map_err(|_| Status::unavailable("Connection failed"))?
        .into_inner();
    let local_address = socket
        .local_addr()
        .map_err(|_| Status::unavailable("Local socket address unavailable"))?
        .to_string();
    let peer_address = socket
        .peer_addr()
        .map_err(|_| Status::unavailable("Peer socket address unavailable"))?
        .to_string();
    let connected_unix_nano =
        unix_nanos().map_err(|_| Status::unavailable("Diagnostics clock is unavailable"))?;
    let diagnostics = inventory(CollectorConnection {
        connection_id: uuid::Uuid::new_v4().to_string(),
        connected_unix_nano,
        local_address,
        peer_address,
        ..Default::default()
    })
    .await?;
    let socket = Arc::new(Mutex::new(Some(socket)));
    // A channel may retry its connector internally. Never silently replace this
    // socket: the next export attempt must obtain a new connection observation.
    let channel = endpoint
        .connect_timeout(TIMEOUT)
        .timeout(TIMEOUT)
        .connect_with_connector(tower::service_fn(move |_| {
            let socket = socket.lock().unwrap_or_else(|e| e.into_inner()).take();
            async move {
                socket.map(TokioIo::new).ok_or_else(|| {
                    io::Error::new(
                        io::ErrorKind::NotConnected,
                        "Connection observation expired",
                    )
                })
            }
        }))
        .await
        .map_err(|_| Status::unavailable("gRPC connection failed"))?;
    let client = MetricsServiceClient::new(channel)
        .send_compressed(CompressionEncoding::Gzip)
        .accept_compressed(CompressionEncoding::Gzip)
        .max_encoding_message_size(MAX_REQUEST_BYTES);
    Ok(Connection {
        client,
        diagnostics,
        inventory_at: Instant::now(),
    })
}
