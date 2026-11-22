/// Executables require a credential file; direct library fixtures may use an
/// isolated broker without authentication.
pub fn required(principal: &str) -> Result<(), &'static str> {
    settings(principal)?
        .is_some()
        .then_some(())
        .ok_or("RECOUNT_KAFKA_PASSWORD_FILE is required")
}

pub fn settings(principal: &str) -> Result<Option<[(&'static str, String); 4]>, &'static str> {
    let Some(path) = std::env::var_os("RECOUNT_KAFKA_PASSWORD_FILE") else {
        return Ok(None);
    };
    let secret = std::fs::read_to_string(path).map_err(|_| "Cannot read Kafka credential file")?;
    let password = secret.trim_end_matches('\n');
    if password.len() != 64 || !password.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("Invalid Kafka credential file");
    }
    Ok(Some([
        ("security.protocol", "SASL_PLAINTEXT".into()),
        ("sasl.mechanisms", "SCRAM-SHA-512".into()),
        ("sasl.username", principal.into()),
        ("sasl.password", password.into()),
    ]))
}
