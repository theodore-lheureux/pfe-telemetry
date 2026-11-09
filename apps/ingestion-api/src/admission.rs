use std::{
    future::Future,
    pin::Pin,
    sync::Arc,
    task::{Context, Poll},
    time::Duration,
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tonic::{
    Status,
    body::Body,
    codegen::http::{Request, Response},
};
use tower::{Layer, Service};

#[derive(Clone)]
pub struct AdmissionLayer {
    permits: Arc<Semaphore>,
}
#[derive(Clone)]
pub struct Admission<S> {
    inner: S,
    permits: Arc<Semaphore>,
}
#[derive(Clone)]
pub(crate) struct DecodePermit {
    _permit: Arc<OwnedSemaphorePermit>,
}

impl AdmissionLayer {
    pub fn new(max_in_flight: usize) -> Self {
        Self {
            permits: Arc::new(Semaphore::new(max_in_flight)),
        }
    }
}
impl<S> Layer<S> for AdmissionLayer {
    type Service = Admission<S>;
    fn layer(&self, inner: S) -> Self::Service {
        Admission {
            inner,
            permits: self.permits.clone(),
        }
    }
}
impl<S, B> Service<Request<B>> for Admission<S>
where
    S: Service<Request<B>, Response = Response<Body>>,
    S::Future: Send + 'static,
    S::Error: Send + 'static,
{
    type Response = Response<Body>;
    type Error = S::Error;
    type Future =
        Pin<Box<dyn Future<Output = std::result::Result<Self::Response, Self::Error>> + Send>>;
    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<std::result::Result<(), Self::Error>> {
        self.inner.poll_ready(cx)
    }
    fn call(&mut self, mut request: Request<B>) -> Self::Future {
        // Shared across connections, before Tonic reads, decompresses or decodes a body.
        let Ok(permit) = self.permits.clone().try_acquire_owned() else {
            return Box::pin(async {
                Ok(Status::unavailable("Ingestion is at capacity").into_http())
            });
        };
        let permit = DecodePermit {
            _permit: Arc::new(permit),
        };
        request.extensions_mut().insert(permit.clone());
        let future = self.inner.call(request);
        Box::pin(async move {
            let _permit = permit;
            let response = match tokio::time::timeout(Duration::from_secs(10), future).await {
                Ok(result) => result?,
                Err(_) => Status::unavailable("Ingestion request timed out").into_http(),
            };
            Ok(crate::limit_status(response))
        })
    }
}
