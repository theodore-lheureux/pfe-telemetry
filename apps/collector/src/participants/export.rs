use std::{io, sync::Arc, time::Duration};

use prost::Message;
use recount_telemetry_schema::{
    execution::MAX_CLAIM_BYTES,
    wire::{ParticipantFact, execution_participants_client::ExecutionParticipantsClient},
};
use tokio::sync::{Notify, watch};
use tonic::{
    Code, Request, Status,
    metadata::{Ascii, MetadataValue},
    transport::{Channel, Endpoint},
};

use super::SharedStore;
use crate::{enrollment::Authorization, spool::Result as CollectorResult};

#[cfg(test)]
mod tests;

pub(super) struct Client(ExecutionParticipantsClient<Channel>);

impl Client {
    pub fn new(endpoint: Endpoint) -> Self {
        let channel = endpoint
            .connect_timeout(Duration::from_secs(3))
            .timeout(Duration::from_secs(3))
            .connect_lazy();
        Self(ExecutionParticipantsClient::new(channel).max_encoding_message_size(MAX_CLAIM_BYTES))
    }

    pub async fn claim(
        &mut self,
        payload: &[u8],
        token: MetadataValue<Ascii>,
    ) -> Result<(), Status> {
        let fact = ParticipantFact::decode(payload)
            .map_err(|_| Status::internal("Corrupt queued participant"))?;
        let mut request = Request::new(fact);
        request.metadata_mut().insert("authorization", token);
        self.0.claim(request).await?;
        Ok(())
    }
}

fn retryable(status: &Status) -> bool {
    matches!(
        status.code(),
        Code::Unavailable | Code::DeadlineExceeded | Code::Cancelled
    ) || (status.code() == Code::Unknown && std::error::Error::source(status).is_some())
}

pub(super) async fn run(
    mut client: Client,
    store: SharedStore,
    mut authorization: Authorization,
    drain: bool,
    yield_after: usize,
    notify: Arc<Notify>,
    mut stopped: watch::Receiver<bool>,
) -> CollectorResult<()> {
    let mut attempt = 0u32;
    let mut sent = 0usize;
    loop {
        if *stopped.borrow() {
            return Ok(());
        }
        let pending = store.lock().await.front().await?;
        let Some(pending) = pending else {
            if drain {
                if store.lock().await.remaining().await? != 0 {
                    return Err(io::Error::other(
                        "Memberships blocked by rejected lifecycle; pending facts retained",
                    )
                    .into());
                }
                return Ok(());
            }
            tokio::select! { _ = stopped.changed() => return Ok(()), _ = notify.notified() => {} }
            continue;
        };
        let Some(token) = authorization.current() else {
            tokio::select! { _ = stopped.changed() => return Ok(()), _ = authorization.changed() => {} }
            continue;
        };
        let response = tokio::select! {
            biased;
            _ = stopped.changed() => return Ok(()),
            result = client.claim(&pending.payload, token) => result,
        };
        match response {
            Ok(()) => {
                store.lock().await.accept(&pending).await?;
                attempt = 0;
                sent += 1;
                if sent >= yield_after {
                    tokio::task::yield_now().await;
                    sent = 0;
                }
            }
            Err(status) if status.code() == Code::Unauthenticated => {
                authorization.reject();
                tokio::select! { _ = stopped.changed() => return Ok(()), _ = authorization.changed() => {} }
            }
            Err(status) if retryable(&status) => {
                let delay = crate::runtime::backoff(attempt);
                attempt = attempt.saturating_add(1);
                tracing::warn!(code=?status.code(), retry_ms=delay.as_millis(),
                    "Participant export pending; retaining identical fact");
                tokio::select! { _ = stopped.changed() => return Ok(()), _ = tokio::time::sleep(delay) => {} }
            }
            Err(status) => {
                store.lock().await.reject(&pending, status.code()).await?;
                attempt = 0;
            }
        }
    }
}
