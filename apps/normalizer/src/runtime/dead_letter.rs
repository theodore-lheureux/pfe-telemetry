use crate::config::Config;
use prost::Message;
use recount_telemetry_schema::{
    identity, identity_cache::IdentityCache, series::PreparedPoint, wire::RawRecord,
};
use recount_telemetry_validation::validate::{self, Limits};
use ruststream_rdkafka::prelude::HandlerOutcome;
use std::{future::Future, time::Duration};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Reason {
    RawTooLarge,
    InvalidEnvelope,
    RoutingKeyMismatch,
    InvalidOtlp,
    RetainedValidation,
    Projection,
    NormalizedRecordTooLarge,
}

impl Reason {
    fn code(self) -> &'static str {
        match self {
            Self::RawTooLarge => "raw_too_large",
            Self::InvalidEnvelope => "invalid_envelope",
            Self::RoutingKeyMismatch => "routing_key_mismatch",
            Self::InvalidOtlp => "invalid_otlp",
            Self::RetainedValidation => "retained_validation",
            Self::Projection => "projection",
            Self::NormalizedRecordTooLarge => "normalized_record_too_large",
        }
    }

    fn stage(self) -> &'static str {
        match self {
            Self::Projection | Self::NormalizedRecordTooLarge => "projection",
            _ => "validation",
        }
    }
}

#[derive(Debug)]
pub(super) struct Rejection {
    reason: Reason,
    scope: Option<Scope>,
}

#[derive(Debug)]
pub(super) struct Scope {
    project: String,
    source: String,
    received: u64,
}

impl Rejection {
    pub(super) fn new(reason: Reason, scope: Option<Scope>) -> Self {
        Self { reason, scope }
    }

    pub(super) fn body(
        &self,
        config: &Config,
        partition: u32,
        offset: u64,
        timestamp: Option<i64>,
        now: u64,
    ) -> Vec<u8> {
        let limits = config.limits;
        let (project, source, received) = self.scope.as_ref().map_or(
            (
                "",
                "",
                timestamp
                    .and_then(|ms| u64::try_from(ms).ok())
                    .and_then(|ms| ms.checked_mul(1_000_000))
                    .unwrap_or(0),
            ),
            |scope| {
                (
                    scope.project.as_str(),
                    scope.source.as_str(),
                    scope.received,
                )
            },
        );
        serde_json::to_vec(&serde_json::json!({
            "project_id": project, "source_id": source,
            "raw_topic": config.raw_topic, "raw_partition": partition, "raw_offset": offset,
            "received_unix_nano": received, "received_from_broker": self.scope.is_none(),
            "rejected_unix_nano": now, "reason": self.reason.code(), "stage": self.reason.stage(),
            "normalizer_build": env!("CARGO_PKG_VERSION"),
            "raw_max_bytes": limits.decoded_bytes,
            "normalized_record_max_bytes": limits.normalized_record_bytes,
            "normalized_batch_max_bytes": limits.normalized_batch_bytes,
            "normalized_broker_max_bytes": config.normalized_broker_max_bytes,
        }))
        .expect("serialize bounded dead-letter record")
    }
}

pub(super) fn prepare(
    payload: &[u8],
    key: Option<&[u8]>,
    limits: Limits,
    cache: &IdentityCache,
) -> Result<(Vec<PreparedPoint>, RawRecord), Rejection> {
    if payload.len() > limits.decoded_bytes {
        return Err(Rejection::new(Reason::RawTooLarge, None));
    }
    let raw =
        RawRecord::decode(payload).map_err(|_| Rejection::new(Reason::InvalidEnvelope, None))?;
    if !identity::raw_routing_key(&raw).is_ok_and(|expected| key == Some(expected.as_slice())) {
        return Err(Rejection::new(Reason::RoutingKeyMismatch, None));
    }
    // Only a role-authorized raw producer can establish ownership. Require the
    // validated, key-matched envelope and the API's canonical tenant/node IDs.
    match validate::retained_cached_delivery(&raw, limits, cache) {
        Ok(rows) => Ok((rows, raw)),
        Err(issue) => {
            if validate::envelope(&raw, limits).is_err() {
                return Err(Rejection::new(Reason::InvalidEnvelope, None));
            }
            Err(Rejection::new(
                match issue.path.as_str() {
                    "otlp" => Reason::InvalidOtlp,
                    "normalized" => Reason::Projection,
                    _ => Reason::RetainedValidation,
                },
                verified_scope(&raw),
            ))
        }
    }
}

pub(super) fn verified_scope(raw: &RawRecord) -> Option<Scope> {
    raw.security
        .as_ref()
        .filter(|s| canonical_uuid(&s.project_id) && canonical_uuid(&s.source_id))
        .map(|s| Scope {
            project: s.project_id.clone(),
            source: s.source_id.clone(),
            received: raw.received_unix_nano,
        })
}

fn canonical_uuid(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(|(i, b)| {
            if matches!(i, 8 | 13 | 18 | 23) {
                b == b'-'
            } else {
                b.is_ascii_digit() || (b'a'..=b'f').contains(&b)
            }
        })
}

pub(super) async fn settle<E, F: Future<Output = Result<(), E>>>(
    mut publish: impl FnMut() -> F,
    retry: Duration,
) -> HandlerOutcome {
    loop {
        if publish().await.is_ok() {
            return HandlerOutcome::ack();
        }
        tracing::warn!(target: "recount_dead_letter", "dead-letter publication failed; input remains unsettled");
        // RustStream's delayed retry can republish to a new raw offset.
        // Keep ownership of this input and its original coordinates instead.
        tokio::time::sleep(retry).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::poll;
    use std::{collections::VecDeque, pin::pin};
    use tokio::sync::oneshot;

    #[tokio::test]
    async fn settlement_waits_through_failure_for_confirmed_write() {
        let (fail, first) = oneshot::channel();
        let (confirm, second) = oneshot::channel();
        let mut reports = VecDeque::from([first, second]);
        let mut outcome = pin!(settle(
            || reports.pop_front().unwrap(),
            Duration::from_millis(1),
        ));
        assert!(poll!(&mut outcome).is_pending());
        drop(fail);
        assert!(poll!(&mut outcome).is_pending());
        confirm.send(()).unwrap();
        assert!(outcome.await.is_ack());
    }

    #[test]
    fn routing_mismatches_never_expose_scope_but_invalid_otlp_can_be_attributed() {
        let mut raw = super::super::cases::reader_raw();
        let scope = raw.security.as_mut().unwrap();
        scope.project_id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa".into();
        scope.source_id = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb".into();
        raw.otlp_request = vec![255];
        let key = identity::raw_routing_key(&raw).unwrap();
        let encoded = raw.encode_to_vec();
        let cache = IdentityCache::default();
        let limits = Limits::default();
        let Err(unscoped) = prepare(&encoded, Some(&[0; 32]), limits, &cache) else {
            panic!("mismatched key accepted");
        };
        assert_eq!(unscoped.reason, Reason::RoutingKeyMismatch);
        assert!(unscoped.scope.is_none());
        let Err(scoped) = prepare(&encoded, Some(&key), limits, &cache) else {
            panic!("invalid OTLP accepted");
        };
        assert_eq!(scoped.reason, Reason::InvalidOtlp);
        assert!(scoped.scope.is_some());
    }
}
