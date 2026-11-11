use recount_telemetry_schema::{
    metrics::{Metric, metric::Data, number_data_point::Value as Number},
    point::{Observation, observations},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Gauge,
    CumulativeMonotonic,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Value {
    Int64,
    Float64,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Adapter {
    Linux,
    Dcgm,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Constraint {
    NonNegative,
    UnitInterval,
}
#[derive(Clone, Copy, Debug)]
pub struct Definition {
    pub name: &'static str,
    pub unit: &'static str,
    pub kind: Kind,
    pub value: Value,
    pub adapter: Adapter,
    pub constraint: Constraint,
}
macro_rules! catalogue {
    ($($id:ident => ($name:literal,$unit:literal,$kind:ident,$value:ident,$adapter:ident,$constraint:ident)),* $(,)?) => {
        $(pub const $id: Definition = Definition {
            name: $name, unit: $unit, kind: Kind::$kind, value: Value::$value,
            adapter: Adapter::$adapter, constraint: Constraint::$constraint,
        };)*
        pub const METRICS: &[Definition] = &[$($id),*];
    }
}
catalogue! {
    NODE_CPU_TIME => ("recount.node.cpu.time","s",CumulativeMonotonic,Float64,Linux,NonNegative),
    NODE_MEMORY_TOTAL => ("recount.node.memory.total","By",Gauge,Int64,Linux,NonNegative),
    NODE_MEMORY_AVAILABLE => ("recount.node.memory.available","By",Gauge,Int64,Linux,NonNegative),
    NODE_DISK_IO => ("system.disk.io","By",CumulativeMonotonic,Int64,Linux,NonNegative),
    PROCESS_CPU_TIME => ("process.cpu.time","s",CumulativeMonotonic,Float64,Linux,NonNegative),
    PROCESS_MEMORY_RSS => ("recount.process.memory.rss","By",Gauge,Int64,Linux,NonNegative),
    PROCESS_DISK_IO => ("process.disk.io","By",CumulativeMonotonic,Int64,Linux,NonNegative),
    SCAN_DURATION => ("recount.collection.scan.duration","s",Gauge,Float64,Linux,NonNegative),
    CLOCK_STATUS => ("recount.clock.status","1",Gauge,Int64,Linux,NonNegative),
    CLOCK_UNCERTAINTY => ("recount.clock.uncertainty","ns",Gauge,Int64,Linux,NonNegative),
    READ_STATUS => ("recount.collection.read.status","1",Gauge,Int64,Linux,NonNegative),
    DISCOVERY_STATUS => ("recount.collection.discovery.status","1",Gauge,Int64,Linux,NonNegative),
    DISCOVERED_PROCESSES => ("recount.collection.discovered.processes","{process}",Gauge,Int64,Linux,NonNegative),
    DISCARDED_PROCESSES => ("recount.collection.discarded.processes","{process}",Gauge,Int64,Linux,NonNegative),
    DROPPED_POINTS => ("recount.collection.dropped.points","{point}",CumulativeMonotonic,Int64,Linux,NonNegative),
    DCGM_GR_ENGINE_ACTIVE => ("DCGM_FI_PROF_GR_ENGINE_ACTIVE","1",Gauge,Float64,Dcgm,UnitInterval),
    DCGM_SM_ACTIVE => ("DCGM_FI_PROF_SM_ACTIVE","1",Gauge,Float64,Dcgm,UnitInterval),
    DCGM_SM_OCCUPANCY => ("DCGM_FI_PROF_SM_OCCUPANCY","1",Gauge,Float64,Dcgm,UnitInterval),
    DCGM_PIPE_TENSOR_ACTIVE => ("DCGM_FI_PROF_PIPE_TENSOR_ACTIVE","1",Gauge,Float64,Dcgm,UnitInterval),
    DCGM_PIPE_FP16_ACTIVE => ("DCGM_FI_PROF_PIPE_FP16_ACTIVE","1",Gauge,Float64,Dcgm,UnitInterval),
    DCGM_PIPE_FP32_ACTIVE => ("DCGM_FI_PROF_PIPE_FP32_ACTIVE","1",Gauge,Float64,Dcgm,UnitInterval),
    DCGM_PIPE_FP64_ACTIVE => ("DCGM_FI_PROF_PIPE_FP64_ACTIVE","1",Gauge,Float64,Dcgm,UnitInterval),
    DCGM_DRAM_ACTIVE => ("DCGM_FI_PROF_DRAM_ACTIVE","1",Gauge,Float64,Dcgm,UnitInterval),
    DCGM_PCIE_TX_BYTES => ("DCGM_FI_PROF_PCIE_TX_BYTES","By/s",Gauge,Float64,Dcgm,NonNegative),
    DCGM_PCIE_RX_BYTES => ("DCGM_FI_PROF_PCIE_RX_BYTES","By/s",Gauge,Float64,Dcgm,NonNegative),
    DCGM_NVLINK_TX_BYTES => ("DCGM_FI_PROF_NVLINK_TX_BYTES","By/s",Gauge,Float64,Dcgm,NonNegative),
    DCGM_NVLINK_RX_BYTES => ("DCGM_FI_PROF_NVLINK_RX_BYTES","By/s",Gauge,Float64,Dcgm,NonNegative),
}
pub fn definition(name: &str) -> Option<&'static Definition> {
    METRICS.iter().find(|m| m.name == name)
}

pub fn validate_adapter_metric(metric: &Metric, adapter: Adapter) -> Result<(), crate::Issue> {
    let invalid = || {
        crate::Issue::new(
            crate::Category::Invalid,
            "collector.metric",
            "collector catalogue semantics mismatch",
        )
    };
    let def = definition(&metric.name)
        .filter(|def| def.adapter == adapter)
        .ok_or_else(|| {
            crate::Issue::new(
                crate::Category::Unsupported,
                "collector.metric",
                "metric is not in this adapter catalogue",
            )
        })?;
    if metric.unit != def.unit {
        return Err(invalid());
    }
    match (def.kind, &metric.data) {
        (Kind::Gauge, Some(Data::Gauge(_))) => {}
        (Kind::CumulativeMonotonic, Some(Data::Sum(v)))
            if v.aggregation_temporality == 2 && v.is_monotonic => {}
        _ => return Err(invalid()),
    }
    for p in observations(metric) {
        let Observation::Number(p) = p else {
            return Err(invalid());
        };
        match (def.value, p.value) {
            (_, None) if p.flags & 1 != 0 => {}
            (Value::Int64, Some(Number::AsInt(v))) if v >= 0 => {
                if def.constraint == Constraint::UnitInterval && v > 1 {
                    return Err(invalid());
                }
            }
            (Value::Float64, Some(Number::AsDouble(v))) if v.is_finite() && v >= 0.0 => {
                if def.constraint == Constraint::UnitInterval && v > 1.0 {
                    return Err(invalid());
                }
            }
            _ => return Err(invalid()),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use recount_telemetry_schema::metrics::{
        Gauge, Metric, NumberDataPoint, metric::Data, number_data_point::Value as Number,
    };

    fn gauge(definition: &Definition, value: Number) -> Metric {
        Metric {
            name: definition.name.into(),
            unit: definition.unit.into(),
            data: Some(Data::Gauge(Gauge {
                data_points: vec![NumberDataPoint {
                    value: Some(value),
                    ..Default::default()
                }],
            })),
            ..Default::default()
        }
    }

    #[test]
    fn declared_ratios_are_bounded_but_rates_and_linux_durations_are_not_ratios() {
        for def in METRICS
            .iter()
            .filter(|def| def.constraint == Constraint::UnitInterval)
        {
            assert_eq!(def.adapter, Adapter::Dcgm);
            for value in [0.0, 1.0] {
                validate_adapter_metric(&gauge(def, Number::AsDouble(value)), def.adapter).unwrap();
            }
            for value in [-0.1, 1.1, f64::NAN, f64::INFINITY] {
                assert!(
                    validate_adapter_metric(&gauge(def, Number::AsDouble(value)), def.adapter)
                        .is_err()
                );
            }
        }
        for def in [&DCGM_PCIE_TX_BYTES, &SCAN_DURATION] {
            validate_adapter_metric(&gauge(def, Number::AsDouble(10.0)), def.adapter).unwrap();
            assert!(validate_adapter_metric(&gauge(def, Number::AsInt(10)), def.adapter).is_err());
        }
        let mut unknown = gauge(&SCAN_DURATION, Number::AsDouble(1.0));
        unknown.name = "application.arbitrary".into();
        assert!(validate_adapter_metric(&unknown, Adapter::Linux).is_err());
    }

    #[test]
    fn adapter_validation_enforces_applicability_without_removing_vendor_metrics() {
        for (definition, adapter, other) in [
            (&SCAN_DURATION, Adapter::Linux, Adapter::Dcgm),
            (&DCGM_SM_ACTIVE, Adapter::Dcgm, Adapter::Linux),
        ] {
            let metric = gauge(definition, Number::AsDouble(0.5));
            validate_adapter_metric(&metric, adapter).unwrap();
            let issue = validate_adapter_metric(&metric, other).unwrap_err();
            assert_eq!(issue.category, crate::Category::Unsupported);
        }
    }
}
