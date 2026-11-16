use crate::{Error, Field, Value, decode};
#[path = "tests/a10.rs"]
mod a10;
#[path = "../../../tests/fixtures/gpu/a10/fixture.rs"]
mod a10_fixture;

#[test]
fn native_blanks_and_failures_are_not_zero_or_large_real_values() {
    for (offset, error) in [
        (0, Error::Unavailable),
        (1, Error::Unavailable),
        (2, Error::Unsupported),
        (3, Error::PermissionDenied),
    ] {
        let raw = (decode::DOUBLE_BLANK + offset as f64).to_ne_bytes();
        assert_eq!(
            decode::reading(Field::Tensor, 100, 0, b'd' as u16, &raw).value,
            Err(error)
        );
        let raw = (decode::INT_BLANK + offset).to_ne_bytes();
        assert_eq!(
            decode::reading(Field::MemoryUsed, 100, 0, b'i' as u16, &raw).value,
            Err(error)
        );
    }
    for (status, expected) in [
        (-17, Error::PermissionDenied),
        (-6, Error::Unsupported),
        (-14, Error::Unavailable),
        (-34, Error::Unavailable),
        (-18, Error::Disappeared),
    ] {
        assert_eq!(
            decode::reading(Field::Tensor, 100, status, b'd' as u16, &0f64.to_ne_bytes()).value,
            Err(expected)
        );
    }
}

#[test]
fn nvidia_published_recorded_profiling_example_preserves_ratios_and_zero() {
    for line in include_str!("../fixtures/nvidia-profiling-example.txt")
        .lines()
        .filter(|line| !line.starts_with('#') && !line.is_empty())
    {
        let values: Vec<f64> = line
            .split_whitespace()
            .map(|value| value.parse().unwrap())
            .collect();
        for (field, value) in [Field::Engine, Field::Tensor, Field::Dram]
            .into_iter()
            .zip(values)
        {
            // NVIDIA's text recording has no timestamps. This wrapper time is synthetic.
            let reading = decode::reading(field, 100, 0, b'd' as u16, &value.to_ne_bytes());
            assert_eq!(reading.time_ns, 100_000);
            assert_eq!(reading.value, Ok(Value::Double(value)));
        }
    }
}

#[test]
fn malformed_native_types_times_and_ranges_fail_closed() {
    for value in [f64::NAN, f64::INFINITY, -0.1, 1.1] {
        assert_eq!(
            decode::reading(Field::Tensor, 1, 0, b'd' as u16, &value.to_ne_bytes()).value,
            Err(Error::OutOfRange)
        );
    }
    for time in [0, -1, i64::MAX] {
        assert_eq!(
            decode::reading(Field::Tensor, time, 0, b'd' as u16, &0.5f64.to_ne_bytes()).value,
            Err(Error::OutOfRange)
        );
    }
    assert_eq!(
        decode::reading(Field::Tensor, 1, 0, b'i' as u16, &1i64.to_ne_bytes()).value,
        Err(Error::Invalid)
    );
    let exact = (1i64 << 53) + 1;
    assert_eq!(
        decode::reading(Field::EccCorrected, 1, 0, b'i' as u16, &exact.to_ne_bytes()).value,
        Ok(Value::Integer(exact))
    );
}

#[cfg(target_os = "linux")]
#[path = "tests/runtime.rs"]
mod runtime;
