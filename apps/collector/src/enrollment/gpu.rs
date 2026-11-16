use super::{Authorization, unix_seconds};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};

impl Authorization {
    /// Conservative emission gate only; ingestion independently verifies authority.
    pub(crate) fn allows_gpu(&self) -> bool {
        self.allows_kinds(&[3])
    }

    pub(crate) fn allows_process_gpu(&self) -> bool {
        self.allows_kinds(&[3, 4])
    }

    fn allows_kinds(&self, required: &[u64]) -> bool {
        let Some(token) = self.current() else {
            return false;
        };
        let Ok(token) = token.to_str() else {
            return false;
        };
        if token.len() > 16_384 {
            return false;
        }
        let Some(payload) = token.split('.').nth(1) else {
            return false;
        };
        let Ok(payload) = URL_SAFE_NO_PAD.decode(payload) else {
            return false;
        };
        let Ok(claims) = serde_json::from_slice::<serde_json::Value>(&payload) else {
            return false;
        };
        claims["adapter"].as_str() == Some("linux")
            && claims["exp"]
                .as_u64()
                .is_some_and(|exp| exp > unix_seconds())
            && claims["localKinds"].as_array().is_some_and(|kinds| {
                required
                    .iter()
                    .all(|required| kinds.iter().any(|kind| kind.as_u64() == Some(*required)))
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use tokio::sync::{Notify, watch};

    #[test]
    fn gpu_grant_gate_tracks_renewal_expiry_and_explicit_exclusions() {
        let (sender, receiver) = watch::channel(None);
        let auth = Authorization::new(receiver, Arc::new(Notify::new()));
        assert!(!auth.allows_gpu());
        for (adapter, kinds, expires, expected) in [
            ("linux", vec![3, 4, 6], u64::MAX, true),
            ("linux", vec![3], u64::MAX, true),
            ("linux", vec![4, 6], u64::MAX, false),
            ("standard", vec![3], u64::MAX, false),
            ("linux", vec![3], 1, false),
        ] {
            let process_allowed = expected && kinds.contains(&4);
            let payload = URL_SAFE_NO_PAD.encode(
                serde_json::to_vec(&serde_json::json!({
                    "adapter": adapter, "localKinds": kinds, "exp": expires,
                }))
                .unwrap(),
            );
            sender.send_replace(Some(format!("header.{payload}.signature").parse().unwrap()));
            assert_eq!(auth.allows_gpu(), expected);
            assert_eq!(auth.allows_process_gpu(), process_allowed);
        }
        sender.send_replace(Some("malformed".parse().unwrap()));
        assert!(!auth.allows_gpu());
    }
}
