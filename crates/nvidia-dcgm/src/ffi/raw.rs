// Derived from NVIDIA DCGM v4.7.0 dcgm_structs.h, Apache-2.0.
// Copyright (c) 2025-2026 NVIDIA CORPORATION. All rights reserved.
// See the crate's NOTICE and LICENSE-APACHE.

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord)]
#[repr(C)]
pub(crate) struct Entity {
    pub group: i32,
    pub id: u32,
}

#[repr(C)]
pub(crate) struct Connect {
    pub version: u32,
    pub persist: u32,
    pub timeout_ms: u32,
    pub unix_socket: u32,
}

// The native union includes a 4096-byte blob. An aligned byte array avoids
// unchecked union reads while retaining the complete native output stride.
#[derive(Clone)]
#[repr(C, align(8))]
pub(crate) struct RawValue {
    pub version: u32,
    pub group: i32,
    pub id: u32,
    pub field: u16,
    pub tag: u16,
    pub status: i32,
    pub unused: u32,
    pub timestamp_us: i64,
    pub bytes: [u8; 4096],
}

impl Default for RawValue {
    fn default() -> Self {
        Self {
            version: 0,
            group: 0,
            id: 0,
            field: 0,
            tag: 0,
            status: -14,
            unused: 0,
            timestamp_us: 0,
            bytes: [0; 4096],
        }
    }
}

#[repr(C)]
#[derive(Clone, Copy)]
pub(crate) struct MetricGroup {
    pub major: u16,
    pub minor: u16,
    pub count: u32,
    pub fields: [u16; 64],
}

#[repr(C)]
pub(crate) struct MetricGroups {
    pub version: u32,
    pub unused: u32,
    pub gpu_id: u32,
    pub count: u32,
    pub groups: [MetricGroup; 10],
}

#[repr(C)]
#[derive(Clone)]
pub(crate) struct MigEntry {
    pub entity: Entity,
    pub parent: Entity,
    pub uuid: [u8; 128],
    pub nvml_index: u32,
    pub instance: u32,
    pub compute_instance: u32,
    pub profile: u32,
    pub slices: u32,
}

#[repr(C)]
pub(crate) struct MigHierarchy {
    pub version: u32,
    pub count: u32,
    pub entries: [MigEntry; 448],
}

const _: () = {
    assert!(size_of::<Entity>() == 8);
    assert!(size_of::<Connect>() == 16);
    assert!(size_of::<RawValue>() == 4128);
    assert!(align_of::<RawValue>() == 8);
    assert!(std::mem::offset_of!(RawValue, timestamp_us) == 24);
    assert!(std::mem::offset_of!(RawValue, bytes) == 32);
    assert!(size_of::<MigEntry>() == 164);
    assert!(size_of::<MigHierarchy>() == 73480);
    assert!(size_of::<MetricGroups>() == 1376);
};
