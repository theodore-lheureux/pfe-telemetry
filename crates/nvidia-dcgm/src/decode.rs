use crate::{Error, Field, Reading, Value, status};

pub(crate) const INT_BLANK: i64 = 0x7fff_ffff_ffff_fff0;
pub(crate) const DOUBLE_BLANK: f64 = 140_737_488_355_328.0;

fn blank(offset: i64) -> Error {
    match offset {
        2 => Error::Unsupported,
        3 => Error::PermissionDenied,
        _ => Error::Unavailable,
    }
}

pub(crate) fn reading(
    field: Field,
    timestamp_us: i64,
    native_status: i32,
    tag: u16,
    bytes: &[u8],
) -> Reading {
    let time_ns = u64::try_from(timestamp_us)
        .ok()
        .filter(|time| *time > 0)
        .and_then(|time| time.checked_mul(1000));
    let value = status(native_status).and_then(|()| {
        if time_ns.is_none() {
            return Err(Error::OutOfRange);
        }
        let raw: [u8; 8] = bytes
            .get(..8)
            .ok_or(Error::Invalid)?
            .try_into()
            .map_err(|_| Error::Invalid)?;
        if field.double() {
            if tag != u16::from(b'd') {
                return Err(Error::Invalid);
            }
            let value = f64::from_ne_bytes(raw);
            if !value.is_finite() {
                return Err(Error::OutOfRange);
            }
            if value >= DOUBLE_BLANK {
                return Err(blank((value - DOUBLE_BLANK) as i64));
            }
            if value < 0.0 || (field.profiling() && value > 1.0) {
                return Err(Error::OutOfRange);
            }
            Ok(Value::Double(value))
        } else {
            if tag != u16::from(b'i') {
                return Err(Error::Invalid);
            }
            let value = i64::from_ne_bytes(raw);
            if value >= INT_BLANK {
                return Err(blank(value - INT_BLANK));
            }
            if (value < 0 && field != Field::Temperature)
                || (matches!(field, Field::Utilization | Field::MemoryActivity) && value > 100)
            {
                return Err(Error::OutOfRange);
            }
            Ok(Value::Integer(value))
        }
    });
    Reading {
        field,
        time_ns: time_ns.unwrap_or(0),
        value,
    }
}
