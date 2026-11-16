use crate::{Ingestion, status, unix_nanos};
use recount_telemetry_schema::wire::{
    ClaimParticipantResponse, ParticipantFact, ResourceKind,
    execution_participants_server::ExecutionParticipants,
};
use recount_telemetry_validation::{execution, metadata};
use tonic::{Request, Response, Status};
use uuid::Uuid;

#[tonic::async_trait]
impl ExecutionParticipants for Ingestion {
    async fn claim(
        &self,
        request: Request<ParticipantFact>,
    ) -> Result<Response<ClaimParticipantResponse>, Status> {
        let _permit = request
            .extensions()
            .get::<crate::admission::DecodePermit>()
            .cloned()
            .ok_or_else(|| Status::internal("Missing admission context"))?;
        let source = self.authority.authenticate(request.metadata()).await?;
        let now =
            unix_nanos().map_err(|_| Status::unavailable("Ingestion clock is unavailable"))?;
        let fact = request.into_inner();
        execution::validate(&fact).map_err(status)?;
        if fact.project_id != source.security.project_id
            || fact.node_id != source.security.source_id
            || fact.host_id != source.root.id
            || source.root.kind != ResourceKind::Host as i32
            || source.adapter != "linux"
            || !source.local_kinds.contains(&ResourceKind::Process)
        {
            return Err(Status::permission_denied(
                "Participant is outside enrolled node scope",
            ));
        }
        metadata::age(
            &recount_telemetry_schema::wire::BatchIdentity {
                client_id: fact.fact_id.clone(),
                created_unix_nano: fact.last_seen_unix_nano,
            },
            now,
            source.maximum_age_ns,
            source.skew_ns,
        )
        .map_err(status)?;
        if fact
            .ended_unix_nano
            .is_some_and(|time| time > now.saturating_add(source.skew_ns))
        {
            return Err(Status::invalid_argument("Participant end is in the future"));
        }
        let row = execution::project(&fact, &Uuid::now_v7().to_string(), now).map_err(status)?;
        self.sink.publish_participant(&row).await.map_err(|_| {
            Status::unavailable("Durable participant publication was not confirmed")
        })?;
        Ok(Response::new(ClaimParticipantResponse {}))
    }
}
