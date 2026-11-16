use super::*;
use crate::participants::settings::Settings;

fn label(bytes: &[u8]) -> Option<Label> {
    read(bytes, &Settings::default().scheduler_variables)
}

#[test]
fn explicit_precedence_and_invalid_keys_never_fall_back() {
    let result = label(b"SLURM_JOB_ID=123\0RECOUNT_EXECUTION=run:ABC/1\0").unwrap();
    assert_eq!(result.key, "run:ABC/1");
    assert_eq!(result.variable, "RECOUNT_EXECUTION");
    for key in [
        "",
        " run:1",
        "run:1 ",
        "é",
        "job=1",
        "-bad",
        &"x".repeat(129),
    ] {
        assert!(label(format!("SLURM_JOB_ID=123\0RECOUNT_EXECUTION={key}\0").as_bytes()).is_none());
    }
}

#[test]
fn scheduler_mapping_is_bytewise_and_preserves_values() {
    let settings = BTreeMap::from([
        ("SLURM_JOB_ID".into(), "slurm".into()),
        ("PBS_JOBID".into(), "pbs".into()),
        ("LSB_JOBID".into(), "lsf".into()),
    ]);
    let bytes =
        b"SLURM_JOB_ID=123\0PBS_JOBID=482.server\0LSB_JOBID=ABC\0RECOUNT_EXECUTION_NAME=ignored\0";
    let result = read(bytes.as_slice(), &settings).unwrap();
    assert_eq!(result.key, "lsf:ABC");
    assert_eq!(result.variable, "LSB_JOBID");
    assert!(result.metadata.is_none());
    assert!(read(b"LSB_JOBID= bad\0SLURM_JOB_ID=123\0".as_slice(), &settings).is_none());
    let result = label(b"SLURM_JOB_ID=123\0").unwrap();
    assert_eq!(result.key, "slurm:123");
}

#[test]
fn metadata_requires_valid_unique_string_parameters() {
    let result = label(b"RECOUNT_EXECUTION=run:1\0RECOUNT_EXECUTION_NAME=Example\0RECOUNT_EXECUTION_VERSION=1.2\0RECOUNT_EXECUTION_PARAMETERS={\"z\":\"\",\"a\":\"one\"}\0").unwrap();
    let metadata = result.metadata.unwrap();
    assert_eq!(metadata.name.as_deref(), Some("Example"));
    assert_eq!(metadata.workload_version.as_deref(), Some("1.2"));
    assert_eq!(metadata.parameters[0].key, "a");
    assert_eq!(metadata.parameters[1].value, "");
    for parameters in [
        r#"{"a":"1","a":"2"}"#,
        r#"{"a":3}"#,
        r#"{"a":null}"#,
        r#"{"a":[]}"#,
        r#"{"bad key":"x"}"#,
        r#"{"a":"\n"}"#,
        "[]",
        "null",
        &format!("{{\"a\":\"{}\"}}", "x".repeat(1025)),
        &format!(
            "{{{}}}",
            (0..33)
                .map(|i| format!("\"k{i}\":\"x\""))
                .collect::<Vec<_>>()
                .join(",")
        ),
    ] {
        assert!(
            label(
                format!("RECOUNT_EXECUTION=run:1\0RECOUNT_EXECUTION_PARAMETERS={parameters}\0")
                    .as_bytes()
            )
            .is_none()
        );
    }
    for field in ["NAME", "VERSION"] {
        for value in ["", " bad", "bad ", "bad\nvalue", &"x".repeat(257)] {
            assert!(
                label(
                    format!("RECOUNT_EXECUTION=run:1\0RECOUNT_EXECUTION_{field}={value}\0")
                        .as_bytes()
                )
                .is_none()
            );
        }
    }
}

#[test]
fn malformed_truncated_oversized_and_unreadable_are_unknown() {
    for bytes in [
        b"RECOUNT_EXECUTION=run:1".as_slice(),
        b"RECOUNT_EXECUTION=run:1\0broken\0",
        b"RECOUNT_EXECUTION=run:1\0=empty-name\0",
        b"RECOUNT_EXECUTION=run:1\0\0",
        b"RECOUNT_EXECUTION=run:1\0RECOUNT_EXECUTION=run:2\0",
        b"RECOUNT_EXECUTION=\xff\0",
        b"",
    ] {
        assert!(label(bytes).is_none());
    }
    let mut bytes = b"RECOUNT_EXECUTION=run:1\0PRIVATE=".to_vec();
    bytes.resize(MAX_ENVIRONMENT_BYTES - 1, b'x');
    bytes.push(0);
    assert!(label(&bytes).is_some());
    bytes.push(0);
    assert!(label(&bytes).is_none());
    struct Denied;
    impl Read for Denied {
        fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
            Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "secret",
            ))
        }
    }
    assert!(read(Denied, &Settings::default().scheduler_variables).is_none());
}

#[test]
fn bounded_read_discards_unrelated_non_utf8_and_never_reads_beyond_limit_plus_one() {
    assert!(label(b"PRIVATE_SECRET=\xff\0RECOUNT_EXECUTION=run:1\0").is_some());
    let mut remaining = std::io::Cursor::new(vec![b'x'; MAX_ENVIRONMENT_BYTES * 2]);
    assert!(read(&mut remaining, &Settings::default().scheduler_variables).is_none());
    assert_eq!(remaining.position(), (MAX_ENVIRONMENT_BYTES + 1) as u64);
}
