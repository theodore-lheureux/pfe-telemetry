use sha2::{Digest, Sha256};

include!(concat!(env!("OUT_DIR"), "/pfe.ingestion.v1.rs"));

pub fn digest(bytes: &[u8]) -> String {
    hex(Sha256::digest(bytes))
}

fn hex(bytes: impl AsRef<[u8]>) -> String {
    bytes.as_ref().iter().map(|b| format!("{b:02x}")).collect()
}

impl Envelope {
    pub fn storage_key(&self) -> String {
        let identity = if self.client_batch_id.is_empty() {
            &self.record_id
        } else {
            &self.client_batch_id
        };
        let mut hash = Sha256::new();
        for part in [
            &self.project_id,
            &self.source_id,
            &self.payload_kind,
            identity,
        ] {
            hash.update((part.len() as u64).to_be_bytes());
            hash.update(part.as_bytes());
        }
        hex(hash.finalize())
    }

    pub fn content_digest(&self) -> String {
        let mut hash = Sha256::new();
        hash.update(self.client_created_unix_nano.to_be_bytes());
        hash.update((self.profile.len() as u64).to_be_bytes());
        hash.update(self.profile.as_bytes());
        hash.update(&self.payload);
        hex(hash.finalize())
    }
}
