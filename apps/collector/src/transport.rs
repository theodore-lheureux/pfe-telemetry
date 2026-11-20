use std::{
    io::{self, IoSlice},
    pin::Pin,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    task::{Context, Poll},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use hyper_util::{client::legacy::connect::HttpConnector, rt::TokioIo};
use opentelemetry_proto::tonic::collector::metrics::v1::{
    ExportMetricsServiceRequest, ExportMetricsServiceResponse,
    metrics_service_client::MetricsServiceClient,
};
use prost::Message;
use recount_telemetry_validation::{
    delivery::{self, CollectorConnection},
    metadata::{BATCH_CREATED, BATCH_ID, PROFILE},
};
use tokio::{
    io::{AsyncRead, AsyncWrite, ReadBuf},
    net::TcpStream,
};
use tonic::{
    Request, Response, Status,
    codec::CompressionEncoding,
    transport::{Channel, ClientTlsConfig, Endpoint},
};
use tower::Service;

use crate::Result as CollectorResult;

pub const TIMEOUT: Duration = Duration::from_secs(3);
pub const MAX_REQUEST_BYTES: usize = 1024 * 1024;
const INVENTORY_INTERVAL: Duration = Duration::from_secs(60);

pub fn unix_nanos() -> CollectorResult<u64> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)?
        .as_nanos()
        .try_into()?)
}

pub fn endpoint(url: String) -> CollectorResult<Endpoint> {
    let endpoint = Endpoint::from_shared(url)?;
    Ok(match endpoint.uri().scheme_str() {
        Some("https") => {
            let _ = rustls::crypto::ring::default_provider().install_default();
            endpoint.tls_config(ClientTlsConfig::new().with_enabled_roots())?
        }
        Some("http") => endpoint,
        _ => return Err(io::Error::other("OTLP export requires http or https").into()),
    })
}

pub fn batch_request(
    body: ExportMetricsServiceRequest,
    id: &str,
    created_ns: u64,
) -> CollectorResult<Request<ExportMetricsServiceRequest>> {
    let mut request = Request::new(body);
    request.metadata_mut().insert(BATCH_ID, id.parse()?);
    request
        .metadata_mut()
        .insert(BATCH_CREATED, created_ns.to_string().parse()?);
    request.metadata_mut().insert(PROFILE, "linux".parse()?);
    Ok(request)
}

pub struct Client {
    endpoint: Endpoint,
    connection: Option<Connection>,
    sent: Option<Arc<AtomicU64>>,
}

struct Connection {
    client: MetricsServiceClient<Channel>,
    diagnostics: Option<CollectorConnection>,
    inventory_at: Instant,
}

impl Client {
    #[cfg(target_os = "linux")]
    pub(crate) fn new(endpoint: Endpoint) -> Self {
        Self {
            endpoint,
            connection: None,
            sent: None,
        }
    }

    pub fn synthetic(endpoint: Endpoint, sent: Arc<AtomicU64>) -> Self {
        Self {
            endpoint,
            connection: None,
            sent: Some(sent),
        }
    }

    pub fn disconnect(&mut self) {
        self.connection = None;
    }

    pub async fn export(
        &mut self,
        mut request: Request<ExportMetricsServiceRequest>,
    ) -> Result<Response<ExportMetricsServiceResponse>, Status> {
        if self.connection.is_none() {
            self.connection = Some(
                tokio::time::timeout(TIMEOUT, connect(self.endpoint.clone(), self.sent.clone()))
                    .await
                    .map_err(|_| Status::unavailable("Connection timed out"))??,
            );
        }
        let connection = self.connection.as_mut().unwrap();
        if let Some(diagnostics) = &mut connection.diagnostics {
            if connection.inventory_at.elapsed() >= INVENTORY_INTERVAL {
                *diagnostics = inventory(diagnostics.clone()).await?;
                connection.inventory_at = Instant::now();
            }
            request.metadata_mut().insert_bin(
                delivery::HEADER,
                tonic::metadata::MetadataValue::from_bytes(&diagnostics.encode_to_vec()),
            );
        }
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
        #[cfg(target_os = "linux")]
        crate::network::refresh(&mut value, observed);
        #[cfg(not(target_os = "linux"))]
        {
            value.inventory_observed_unix_nano = observed;
        }
        delivery::validate_connection(&value)
            .map_err(|_| Status::internal("Invalid local connection diagnostics"))?;
        Ok(value)
    })
    .await
    .map_err(|_| Status::internal("Connection diagnostics failed"))?
}

async fn connect(endpoint: Endpoint, sent: Option<Arc<AtomicU64>>) -> Result<Connection, Status> {
    let mut connector = HttpConnector::new();
    // This connector only opens TCP; tonic wraps the observed socket in TLS for HTTPS.
    connector.enforce_http(false);
    connector.set_connect_timeout(Some(TIMEOUT));
    connector.set_nodelay(true);
    let socket = connector
        .call(endpoint.uri().clone())
        .await
        .map_err(|_| Status::unavailable("Connection failed"))?
        .into_inner();
    let diagnostics = if sent.is_none() {
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
        Some(
            inventory(CollectorConnection {
                connection_id: uuid::Uuid::new_v4().to_string(),
                connected_unix_nano,
                local_address,
                peer_address,
                ..Default::default()
            })
            .await?,
        )
    } else {
        None
    };
    let socket = MeasuredSocket { socket, sent };
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

struct MeasuredSocket {
    socket: TcpStream,
    sent: Option<Arc<AtomicU64>>,
}

impl MeasuredSocket {
    fn count(&self, result: Poll<io::Result<usize>>) -> Poll<io::Result<usize>> {
        if let (Poll::Ready(Ok(bytes)), Some(sent)) = (&result, &self.sent) {
            sent.fetch_add(*bytes as u64, Ordering::Relaxed);
        }
        result
    }
}

impl AsyncRead for MeasuredSocket {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.socket).poll_read(cx, buf)
    }
}

impl AsyncWrite for MeasuredSocket {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        let result = Pin::new(&mut self.socket).poll_write(cx, buf);
        self.count(result)
    }
    fn poll_write_vectored(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bufs: &[IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        let result = Pin::new(&mut self.socket).poll_write_vectored(cx, bufs);
        self.count(result)
    }
    fn is_write_vectored(&self) -> bool {
        self.socket.is_write_vectored()
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.socket).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.socket).poll_shutdown(cx)
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests;
