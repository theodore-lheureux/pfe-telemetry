use recount_telemetry_validation::delivery::{self, DeliveryObservation};
use tonic::{Request, Status};

pub fn observe<T>(request: &Request<T>) -> Result<DeliveryObservation, Status> {
    let mut values = request.metadata().get_all_bin(delivery::HEADER).iter();
    let collector = values.next();
    if values.next().is_some() {
        return Err(Status::invalid_argument("Duplicate connection diagnostics"));
    }
    let collector = collector
        .map(|value| {
            let bytes = value
                .to_bytes()
                .map_err(|_| Status::invalid_argument("Invalid binary connection diagnostics"))?;
            delivery::decode_connection(&bytes).map_err(crate::status)
        })
        .transpose()?;
    Ok(DeliveryObservation {
        collector,
        ingestion_peer_address: request.remote_addr().map(|address| address.to_string()),
    })
}
