use crate::{Issue, validate::Limits};
use clap::Args;

/// Shared admission and retained-record limits. Domain checks remain in `Limits`.
#[derive(Clone, Debug, Args)]
pub struct LimitArgs {
    /// Maximum decoded OTLP request and retained raw body bytes.
    #[arg(long, env = "RECOUNT_MAX_REQUEST_BYTES", default_value_t = Limits::default().decoded_bytes as u32, value_parser = clap::value_parser!(u32).range(1..=i32::MAX as i64))]
    max_request_bytes: u32,
    /// Maximum observations per request.
    #[arg(long, env = "RECOUNT_MAX_POINTS", default_value_t = Limits::default().points as u32, value_parser = clap::value_parser!(u32).range(1..=i32::MAX as i64))]
    max_points: u32,
    /// Maximum expanded structural items per request.
    #[arg(long, env = "RECOUNT_MAX_EXPANDED_ITEMS", default_value_t = Limits::default().expanded_items as u32, value_parser = clap::value_parser!(u32).range(1..=i32::MAX as i64))]
    max_expanded_items: u32,
    /// Maximum distinct authority keys per request.
    #[arg(long, env = "RECOUNT_MAX_AUTHORITIES", default_value_t = Limits::default().distinct_authorities as u32, value_parser = clap::value_parser!(u32).range(1..=i32::MAX as i64))]
    max_authorities: u32,
    /// Maximum recursive attribute nodes per attribute set.
    #[arg(long, env = "RECOUNT_MAX_ATTRIBUTE_NODES", default_value_t = Limits::default().attributes_per_set as u32, value_parser = clap::value_parser!(u32).range(1..=i32::MAX as i64))]
    max_attribute_nodes: u32,
    /// Maximum bytes in one normalized Kafka body.
    #[arg(long, env = "RECOUNT_NORMALIZED_MAX_RECORD_BYTES", default_value_t = Limits::default().normalized_record_bytes as u32, value_parser = clap::value_parser!(u32).range(1..=i32::MAX as i64))]
    normalized_max_record_bytes: u32,
    /// Maximum total normalized bytes produced from one raw request.
    #[arg(long, env = "RECOUNT_NORMALIZED_MAX_OUTPUT_BYTES", default_value_t = Limits::default().normalized_batch_bytes as u32, value_parser = clap::value_parser!(u32).range(1..=i32::MAX as i64))]
    normalized_max_output_bytes: u32,
}

impl LimitArgs {
    pub fn limits(&self) -> Result<Limits, Issue> {
        Limits {
            decoded_bytes: self.max_request_bytes as usize,
            points: self.max_points as usize,
            expanded_items: self.max_expanded_items as usize,
            distinct_authorities: self.max_authorities as usize,
            attributes_per_set: self.max_attribute_nodes as usize,
            normalized_record_bytes: self.normalized_max_record_bytes as usize,
            normalized_batch_bytes: self.normalized_max_output_bytes as usize,
        }
        .validate()
    }
}

pub fn nonblank(value: &str) -> Result<String, &'static str> {
    if value.trim().is_empty() {
        Err("nonempty configuration required")
    } else {
        Ok(value.to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::{CommandFactory, FromArgMatches, Parser};

    #[derive(Parser)]
    struct Cli {
        #[command(flatten)]
        limits: LimitArgs,
    }

    fn parse(args: &[&str]) -> Result<Limits, String> {
        let matches = Cli::command()
            .mut_args(|arg| arg.env(None::<&str>))
            .try_get_matches_from(args)
            .map_err(|e| e.to_string())?;
        Cli::from_arg_matches(&matches)
            .unwrap()
            .limits
            .limits()
            .map_err(|e| e.to_string())
    }

    #[test]
    fn omitted_defaults_and_independent_overrides_use_domain_owner() {
        assert_eq!(parse(&["test"]).unwrap(), Limits::default());
        assert_eq!(
            parse(&["test", "--max-points", "17"]).unwrap(),
            Limits {
                points: 17,
                ..Limits::default()
            }
        );
        assert!(parse(&["test", "--max-points", "0"]).is_err());
        assert!(parse(&["test", "--normalized-max-output-bytes", "1048575"]).is_err());
        assert_eq!(
            parse(&[
                "test",
                "--max-request-bytes",
                "7000000",
                "--max-points",
                "17",
                "--max-expanded-items",
                "300000",
                "--max-authorities",
                "300",
                "--max-attribute-nodes",
                "100",
                "--normalized-max-record-bytes",
                "2000000",
                "--normalized-max-output-bytes",
                "19000000"
            ])
            .unwrap(),
            Limits {
                decoded_bytes: 7_000_000,
                points: 17,
                expanded_items: 300_000,
                distinct_authorities: 300,
                attributes_per_set: 100,
                normalized_record_bytes: 2_000_000,
                normalized_batch_bytes: 19_000_000
            }
        );
    }
}
