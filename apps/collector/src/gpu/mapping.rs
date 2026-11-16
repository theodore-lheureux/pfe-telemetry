use opentelemetry_proto::tonic::{common::v1::KeyValue, metrics::v1::number_data_point};
use recount_nvidia_dcgm::{Error, Field, Value};
use recount_telemetry_validation::catalogue::{self as c, Definition};

use crate::{diagnostics::ReadStatus, metrics::string};

pub(super) fn definition(field: Field) -> (&'static Definition, Vec<KeyValue>) {
    use Field::*;
    match field {
        Engine => (&c::GPU_ENGINE_ACTIVITY, vec![]),
        SmActivity => (&c::GPU_SM_ACTIVITY, vec![]),
        SmOccupancy => (&c::GPU_SM_OCCUPANCY, vec![]),
        Dram => (&c::GPU_DRAM_ACTIVITY, vec![]),
        Tensor | Fp64 | Fp32 | Fp16 => {
            let pipe = match field {
                Tensor => "tensor",
                Fp64 => "fp64",
                Fp32 => "fp32",
                _ => "fp16",
            };
            (&c::GPU_PIPE_ACTIVITY, vec![string("gpu.pipe", pipe)])
        }
        SmClock | MemoryClock => {
            let domain = if field == SmClock { "sm" } else { "memory" };
            (&c::GPU_CLOCK, vec![string("gpu.clock.domain", domain)])
        }
        PcieTx | PcieRx | NvlinkTx | NvlinkRx => {
            let definition = if matches!(field, PcieTx | PcieRx) {
                &c::GPU_PCIE_THROUGHPUT
            } else {
                &c::GPU_NVLINK_THROUGHPUT
            };
            let direction = if matches!(field, PcieTx | NvlinkTx) {
                "tx"
            } else {
                "rx"
            };
            (definition, vec![string("gpu.io.direction", direction)])
        }
        EccCorrected | EccUncorrected => {
            let kind = if field == EccCorrected {
                "corrected"
            } else {
                "uncorrected"
            };
            (
                &c::GPU_ECC_ERRORS,
                vec![
                    string("gpu.error.type", kind),
                    string("gpu.error.scope", "aggregate"),
                ],
            )
        }
        MemoryTotal => (&c::GPU_MEMORY_TOTAL, vec![]),
        MemoryUsed => (&c::GPU_MEMORY_USED, vec![]),
        Temperature => (&c::GPU_TEMPERATURE, vec![]),
        Power => (&c::GPU_POWER, vec![]),
        Utilization => (&c::GPU_UTILIZATION, vec![]),
        MemoryActivity => (&c::GPU_MEMORY_ACTIVITY, vec![]),
        Xid => (&c::GPU_XID_LAST, vec![]),
    }
}

pub(super) fn value(field: Field, value: &Value) -> Result<number_data_point::Value, Error> {
    use Field::*;
    use number_data_point::Value::{AsDouble, AsInt};
    match (field, value) {
        (Utilization | MemoryActivity, Value::Integer(v)) if (0..=100).contains(v) => {
            Ok(AsDouble(*v as f64 / 100.0))
        }
        (MemoryTotal | MemoryUsed, Value::Integer(v)) => {
            v.checked_mul(1_048_576).map(AsInt).ok_or(Error::OutOfRange)
        }
        (SmClock | MemoryClock, Value::Integer(v)) => {
            v.checked_mul(1_000_000).map(AsInt).ok_or(Error::OutOfRange)
        }
        (PcieTx | PcieRx | NvlinkTx | NvlinkRx, Value::Integer(v)) if *v <= (1i64 << 53) => {
            Ok(AsDouble(*v as f64))
        }
        (PcieTx | PcieRx | NvlinkTx | NvlinkRx, Value::Integer(_)) => Err(Error::OutOfRange),
        (_, Value::Integer(v)) => Ok(AsInt(*v)),
        (_, Value::Double(v)) => Ok(AsDouble(*v)),
    }
}

pub(super) fn status(error: Error) -> ReadStatus {
    match error {
        Error::Absent | Error::Unsupported => ReadStatus::Unsupported,
        Error::PermissionDenied => ReadStatus::PermissionDenied,
        Error::Disappeared => ReadStatus::Disappeared,
        Error::Unavailable | Error::Disconnected => ReadStatus::Unavailable,
        Error::OutOfRange => ReadStatus::OutOfRange,
        Error::Invalid | Error::Native(_) => ReadStatus::Failed,
    }
}
