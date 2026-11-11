use recount_ingestion_api::auth;
use recount_telemetry_validation::authority::identifier;
use serde_json::Value;

fn vectors() -> Value {
    serde_json::from_str(include_str!(
        "../../../tests/fixtures/credential-authority.json"
    ))
    .unwrap()
}

#[test]
fn credential_identifiers_preserve_valid_bytes_and_reject_controls() {
    for vector in vectors()["identifiers"].as_array().unwrap() {
        assert_eq!(
            identifier(vector["value"].as_str().unwrap()),
            vector["valid"].as_bool().unwrap(),
            "{}",
            vector["name"],
        );
    }
}

#[test]
fn credential_duration_conversion_preserves_seconds_and_rejects_overflow() {
    for vector in vectors()["durations"].as_array().unwrap() {
        let age = vector["maximumSubmissionAge"].as_i64().unwrap();
        let skew = vector["allowedClockSkew"].as_i64().unwrap();
        let actual = auth::policy_nanos(age, skew);
        assert_eq!(
            actual.is_some(),
            vector["valid"].as_bool().unwrap(),
            "{vector}"
        );
        if let Some((age_ns, skew_ns)) = actual {
            assert_eq!(u128::from(age_ns), age as u128 * 1_000_000_000, "{vector}");
            assert_eq!(
                u128::from(skew_ns),
                skew as u128 * 1_000_000_000,
                "{vector}"
            );
        }
    }
}
