#[cfg(target_os = "linux")]
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use std::{error::Error, fmt, io};

const CLOCK_DISCONTINUITY_THRESHOLD_NS: i128 = 50_000_000;

#[derive(Debug)]
struct Discontinuity;

impl fmt::Display for Discontinuity {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("Sampling clock discontinuity or delayed clock read")
    }
}

impl Error for Discontinuity {}

pub(crate) fn is_discontinuity(error: &io::Error) -> bool {
    error
        .get_ref()
        .is_some_and(|source| source.is::<Discontinuity>())
}

#[cfg(target_os = "linux")]
pub(crate) struct SamplingClock {
    anchor_unix_nanos: u64,
    anchor_monotonic: Instant,
    last_unix_nanos: u64,
}

#[cfg(target_os = "linux")]
impl SamplingClock {
    pub(crate) fn new() -> io::Result<Self> {
        let (unix_nanos, monotonic) = read_clock_pair()?;
        Ok(Self {
            anchor_unix_nanos: unix_nanos,
            anchor_monotonic: monotonic,
            last_unix_nanos: unix_nanos,
        })
    }

    pub(crate) fn timestamp(&mut self) -> io::Result<u64> {
        let (unix_nanos, monotonic) = read_clock_pair()?;
        let expected_unix_nanos = i128::from(self.anchor_unix_nanos)
            + i128::try_from(monotonic.duration_since(self.anchor_monotonic).as_nanos())
                .map_err(|_| io::Error::other("Monotonic clock exceeds timestamp range"))?;
        if discontinuity(self.last_unix_nanos, unix_nanos, expected_unix_nanos) {
            return Err(io::Error::new(io::ErrorKind::Interrupted, Discontinuity));
        }
        self.last_unix_nanos = unix_nanos;
        Ok(unix_nanos)
    }
}

fn discontinuity(last: u64, unix_nanos: u64, expected_unix_nanos: i128) -> bool {
    unix_nanos < last
        || (i128::from(unix_nanos) - expected_unix_nanos).abs() > CLOCK_DISCONTINUITY_THRESHOLD_NS
}

#[cfg(target_os = "linux")]
fn read_clock_pair() -> io::Result<(u64, Instant)> {
    let before = Instant::now();
    let unix_nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| io::Error::other("System time precedes the Unix epoch"))?
        .as_nanos();
    let after = Instant::now();
    if after.duration_since(before).as_nanos() > CLOCK_DISCONTINUITY_THRESHOLD_NS as u128 {
        return Err(io::Error::new(io::ErrorKind::Interrupted, Discontinuity));
    }
    let unix_nanos = u64::try_from(unix_nanos)
        .map_err(|_| io::Error::other("System time exceeds OTLP timestamp range"))?;
    if unix_nanos == 0 {
        return Err(io::Error::other("Zero OTLP timestamp"));
    }
    Ok((unix_nanos, before + after.duration_since(before) / 2))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_backward_and_large_forward_steps() {
        assert!(!discontinuity(100, 200, 200));
        assert!(discontinuity(200, 100, 201));
        assert!(discontinuity(100, 100_000_200, 200));
    }

    #[test]
    fn interrupted_io_is_not_a_clock_discontinuity() {
        assert!(!is_discontinuity(&io::Error::from(
            io::ErrorKind::Interrupted
        )));
        assert!(is_discontinuity(&io::Error::new(
            io::ErrorKind::Interrupted,
            Discontinuity
        )));
    }
}
