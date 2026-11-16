/// Fixed audited field set. Profiling fields are cache-only.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[repr(u16)]
pub enum Field {
    SmClock = 100,
    MemoryClock = 101,
    Temperature = 150,
    Power = 155,
    Utilization = 203,
    MemoryActivity = 204,
    Xid = 230,
    MemoryTotal = 250,
    MemoryUsed = 252,
    EccCorrected = 312,
    EccUncorrected = 313,
    Engine = 1001,
    SmActivity = 1002,
    SmOccupancy = 1003,
    Tensor = 1004,
    Dram = 1005,
    Fp64 = 1006,
    Fp32 = 1007,
    Fp16 = 1008,
    PcieTx = 1009,
    PcieRx = 1010,
    NvlinkTx = 1011,
    NvlinkRx = 1012,
}

pub const FIELDS: &[Field] = &[
    Field::SmClock,
    Field::MemoryClock,
    Field::Temperature,
    Field::Power,
    Field::Utilization,
    Field::MemoryActivity,
    Field::Xid,
    Field::MemoryTotal,
    Field::MemoryUsed,
    Field::EccCorrected,
    Field::EccUncorrected,
    Field::Engine,
    Field::SmActivity,
    Field::SmOccupancy,
    Field::Tensor,
    Field::Dram,
    Field::Fp64,
    Field::Fp32,
    Field::Fp16,
    Field::PcieTx,
    Field::PcieRx,
    Field::NvlinkTx,
    Field::NvlinkRx,
];

impl Field {
    pub fn profiling(self) -> bool {
        self as u16 >= 1000
    }

    /// Board-wide core metrics must never be copied onto a MIG child.
    pub fn instance_scoped(self) -> bool {
        self.profiling() && (self as u16) <= 1008
    }

    pub(crate) fn double(self) -> bool {
        self == Self::Power || (self.profiling() && (self as u16) <= 1008)
    }
}
