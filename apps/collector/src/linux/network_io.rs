use std::{
    collections::BTreeMap,
    fs::File,
    io::{self, BufRead, BufReader},
};

use opentelemetry_proto::tonic::metrics::v1::{Metric, NumberDataPoint, number_data_point::Value};
use recount_telemetry_validation::catalogue::NODE_NETWORK_IO;

use super::Collector;
use crate::{
    diagnostics::ReadStatus,
    metrics::{counter, string},
};

type Interfaces = BTreeMap<String, [u64; 2]>;

fn parse(input: impl BufRead) -> (Interfaces, ReadStatus) {
    let mut lines = input.lines();
    if !matches!(lines.next(), Some(Ok(line)) if line.contains("Receive") && line.contains("Transmit"))
        || !matches!(lines.next(), Some(Ok(line)) if line.contains("bytes"))
    {
        return (Interfaces::new(), ReadStatus::Failed);
    }
    let mut interfaces = Interfaces::new();
    let mut status = ReadStatus::Read;
    for line in lines {
        let Ok(line) = line else {
            return (interfaces, ReadStatus::Failed);
        };
        let Some((name, values)) = line.rsplit_once(':') else {
            status = ReadStatus::Failed;
            continue;
        };
        let name = name.trim();
        if name == "lo" {
            continue;
        }
        let mut fields = values.split_ascii_whitespace().map(str::parse::<u64>);
        let mut counters = [0; 16];
        if name.is_empty()
            || name.len() > 15
            || name.chars().any(|c| c.is_whitespace() || c.is_control())
            || !counters.iter_mut().all(|out| match fields.next() {
                Some(Ok(value)) => {
                    *out = value;
                    true
                }
                _ => false,
            })
        {
            status = ReadStatus::Failed;
            continue;
        }
        if interfaces.contains_key(name) {
            status = ReadStatus::Failed;
            continue;
        }
        interfaces.insert(name.into(), [counters[0], counters[8]]);
    }
    (interfaces, status)
}

impl Collector {
    pub(super) fn network_io(&mut self) -> io::Result<(Option<Metric>, NumberDataPoint)> {
        let (interfaces, mut status) = match File::open("/proc/net/dev") {
            Ok(file) => parse(BufReader::new(file)),
            Err(error) => (
                Interfaces::new(),
                ReadStatus::from_error(&procfs::ProcError::from(error)),
            ),
        };
        let time = self.clock.timestamp()?;
        let mut points = Vec::new();
        for (interface, bytes) in interfaces {
            for (direction, raw) in ["receive", "transmit"].into_iter().zip(bytes) {
                let Ok(value) = i64::try_from(raw) else {
                    if status == ReadStatus::Read {
                        status = ReadStatus::OutOfRange;
                    }
                    continue;
                };
                points.push(self.counter_point(
                    format!("node/{}/{interface}/{direction}", NODE_NETWORK_IO.name),
                    raw,
                    Value::AsInt(value),
                    time,
                    0,
                    vec![
                        string("network.interface.name", &interface),
                        string("network.io.direction", direction),
                    ],
                )?);
            }
        }
        Ok((
            (!points.is_empty()).then(|| counter(&NODE_NETWORK_IO, points)),
            self.read_status(&NODE_NETWORK_IO, status, time),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HEADER: &str = "Inter-| Receive | Transmit\n face |bytes |bytes\n";
    const ROW: &str = "42 1 2 3 4 5 6 7 81 9 10 11 12 13 14 15";

    #[test]
    fn parses_byte_columns_and_retains_non_loopback_interfaces() {
        let sample = format!("{HEADER} lo: {ROW}\n eth0: {ROW}\n ib0: {ROW}\n br-test: {ROW}\n");
        let (interfaces, status) = parse(sample.as_bytes());
        assert_eq!(status, ReadStatus::Read);
        assert_eq!(
            interfaces.keys().map(String::as_str).collect::<Vec<_>>(),
            ["br-test", "eth0", "ib0"]
        );
        assert!(interfaces.values().all(|bytes| *bytes == [42, 81]));
    }

    #[test]
    fn malformed_rows_report_failure_without_losing_valid_interfaces() {
        let sample = format!("{HEADER} bad: 1 2\n eth0: {ROW}\n");
        let (interfaces, status) = parse(sample.as_bytes());
        assert_eq!(status, ReadStatus::Failed);
        assert_eq!(interfaces.len(), 1);
    }

    #[test]
    fn unsigned_counter_wrap_starts_a_new_continuity_segment() {
        let sample = format!(
            "{HEADER} eth0: {} {}\n",
            u64::MAX,
            ROW.split_once(' ').unwrap().1
        );
        let (before, status) = parse(sample.as_bytes());
        assert_eq!(status, ReadStatus::Read);
        let sample = format!("{HEADER} eth0: {ROW}\n");
        let (after, _) = parse(sample.as_bytes());
        let mut continuity = crate::continuity::Continuity::default();
        let first = continuity.segment("eth0/receive".into(), before["eth0"][0], 1);
        assert_ne!(
            first,
            continuity.segment("eth0/receive".into(), after["eth0"][0], 2)
        );
    }
}
