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
#[derive(Clone, Copy, Debug)]
pub struct Definition {
    pub name: &'static str,
    pub unit: &'static str,
    pub kind: Kind,
    pub value: Value,
}
macro_rules! catalogue {
    ($($name:literal => ($unit:literal,$kind:ident,$value:ident)),* $(,)?) => {
        pub const METRICS:&[Definition]=&[$(Definition{name:$name,unit:$unit,kind:Kind::$kind,value:Value::$value}),*];
    }
}
catalogue! {
    "recount.node.cpu.time"=>("s",CumulativeMonotonic,Float64),
    "recount.node.memory.total"=>("By",Gauge,Int64),
    "recount.node.memory.available"=>("By",Gauge,Int64),
    "system.disk.io"=>("By",CumulativeMonotonic,Int64),
    "process.cpu.time"=>("s",CumulativeMonotonic,Float64),
    "recount.process.memory.rss"=>("By",Gauge,Int64),
    "process.disk.io"=>("By",CumulativeMonotonic,Int64),
    "recount.collection.scan.duration"=>("s",Gauge,Float64),
    "recount.clock.status"=>("1",Gauge,Int64),
    "recount.clock.uncertainty"=>("ns",Gauge,Int64),
    "recount.collection.read.status"=>("1",Gauge,Int64),
    "recount.collection.discovery.status"=>("1",Gauge,Int64),
    "recount.collection.discovered.processes"=>("{process}",Gauge,Int64),
    "recount.collection.discarded.processes"=>("{process}",Gauge,Int64),
    "recount.collection.dropped.points"=>("{point}",CumulativeMonotonic,Int64),
    "DCGM_FI_PROF_GR_ENGINE_ACTIVE"=>("1",Gauge,Float64),
    "DCGM_FI_PROF_SM_ACTIVE"=>("1",Gauge,Float64),
    "DCGM_FI_PROF_SM_OCCUPANCY"=>("1",Gauge,Float64),
    "DCGM_FI_PROF_PIPE_TENSOR_ACTIVE"=>("1",Gauge,Float64),
    "DCGM_FI_PROF_PIPE_FP16_ACTIVE"=>("1",Gauge,Float64),
    "DCGM_FI_PROF_PIPE_FP32_ACTIVE"=>("1",Gauge,Float64),
    "DCGM_FI_PROF_PIPE_FP64_ACTIVE"=>("1",Gauge,Float64),
    "DCGM_FI_PROF_DRAM_ACTIVE"=>("1",Gauge,Float64),
    "DCGM_FI_PROF_PCIE_TX_BYTES"=>("By/s",Gauge,Float64),
    "DCGM_FI_PROF_PCIE_RX_BYTES"=>("By/s",Gauge,Float64),
    "DCGM_FI_PROF_NVLINK_TX_BYTES"=>("By/s",Gauge,Float64),
    "DCGM_FI_PROF_NVLINK_RX_BYTES"=>("By/s",Gauge,Float64),
}
pub fn definition(name: &str) -> Option<&'static Definition> {
    METRICS.iter().find(|m| m.name == name)
}

pub fn validate_collector_metric(
    metric: &recount_telemetry_schema::metrics::Metric,
) -> Result<(), crate::Issue> {
    use recount_telemetry_schema::{
        metrics::{metric::Data, number_data_point::Value as Number},
        point::{Observation, observations},
    };
    let invalid = || {
        crate::Issue::new(
            crate::Category::Invalid,
            "collector.metric",
            "collector catalogue semantics mismatch",
        )
    };
    let def = definition(&metric.name).ok_or_else(|| {
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
            (Value::Int64, Some(Number::AsInt(v))) if v >= 0 => {}
            (Value::Float64, Some(Number::AsDouble(v))) if v.is_finite() && v >= 0.0 => {
                if def.name.starts_with("DCGM_") && def.unit == "1" && v > 1.0 {
                    return Err(invalid());
                }
            }
            _ => return Err(invalid()),
        }
    }
    Ok(())
}
