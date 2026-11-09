/// Conservative space for the current keys, Kafka batch and protocol framing.
pub const FRAMING_RESERVE: usize = 65_536;
pub const RAW_BROKER_BYTES: u32 = 6 * 1024 * 1024;
pub const NORMALIZED_BROKER_BYTES: u32 = 2 * 1024 * 1024;
pub const OUTPUT_ROWS: u32 = 128;
pub const MAX_OUTPUT_ROWS: u32 = 16_384;
// librdkafka message.max.bytes / fetch.message.max.bytes upper bound.
pub const MAX_BROKER_BYTES: u32 = 1_000_000_000;
// Protocol receive ceilings include metadata and other control-plane responses.
// Preserve the existing native/local floors when record budgets are small.
const RAW_RECEIVE_FLOOR: usize = 100_000_000;
const NORMALIZED_RECEIVE_FLOOR: usize = 6 * 1024 * 1024;

pub fn body_fits(body: usize, topic: usize) -> Result<(), &'static str> {
    if !(1000..=MAX_BROKER_BYTES as usize).contains(&topic) {
        return Err("topic budget must be within librdkafka's 1000..=1000000000 byte range");
    }
    if body == 0 || body.checked_add(FRAMING_RESERVE).is_none_or(|n| n > topic) {
        return Err("body limits require broker capacity plus 64 KiB framing reserve");
    }
    Ok(())
}

/// Soft fetch/queue targets, not a bound on decoded memory or peak RSS.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ConsumerBudget {
    pub partition_bytes: usize,
    pub fetch_bytes: usize,
    pub receive_bytes: usize,
    pub queued_kib: usize,
}

impl ConsumerBudget {
    pub fn raw(topic: usize) -> Result<Self, &'static str> {
        Self::new(topic, 2, RAW_RECEIVE_FLOOR)
    }

    pub fn normalized(topic: usize) -> Result<Self, &'static str> {
        Self::new(topic, 1, NORMALIZED_RECEIVE_FLOOR)
    }

    pub fn with_receive_limit(mut self, receive: Option<usize>) -> Result<Self, &'static str> {
        if let Some(receive) = receive {
            if receive < (self.fetch_bytes + 512).max(1000) || receive > i32::MAX as usize {
                return Err("Kafka receive ceiling must cover fetch bytes plus 512 and fit Int32");
            }
            self.receive_bytes = receive;
        }
        Ok(self)
    }

    fn new(topic: usize, fetch_batches: usize, receive_floor: usize) -> Result<Self, &'static str> {
        if !(1000..=MAX_BROKER_BYTES as usize).contains(&topic) {
            return Err("topic budget must be within librdkafka's 1000..=1000000000 byte range");
        }
        let fetch_bytes = topic * fetch_batches;
        Ok(Self {
            partition_bytes: topic,
            fetch_bytes,
            // Explicit message.max.bytes must also equal topic, otherwise the
            // library can raise fetch.max.bytes above this receive allowance.
            receive_bytes: (fetch_bytes + 512).max(receive_floor),
            queued_kib: (topic * 2).div_ceil(1024),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn headroom_is_checked_without_overflow_or_equalizing_topics() {
        for (body, topic) in [
            (1, FRAMING_RESERVE + 1),
            (7_000_000, 7_065_536),
            (999_934_464, 1_000_000_000),
        ] {
            assert!(body_fits(body, topic).is_ok());
            assert!(body_fits(body + 1, topic).is_err());
        }
        for (body, topic) in [(0, 1000), (usize::MAX, 1000), (1, usize::MAX), (1, 999)] {
            assert!(body_fits(body, topic).is_err());
        }
    }

    #[test]
    fn consumer_allowances_cover_largest_permitted_batches_and_native_ranges() {
        for topic in [
            1000,
            65_537,
            NORMALIZED_BROKER_BYTES as usize,
            7_065_536,
            MAX_BROKER_BYTES as usize,
        ] {
            for (budget, batches, floor) in [
                (ConsumerBudget::raw(topic).unwrap(), 2, RAW_RECEIVE_FLOOR),
                (
                    ConsumerBudget::normalized(topic).unwrap(),
                    1,
                    NORMALIZED_RECEIVE_FLOOR,
                ),
            ] {
                assert_eq!(budget.partition_bytes, topic);
                assert_eq!(budget.fetch_bytes, batches * topic);
                assert_eq!(budget.receive_bytes, (budget.fetch_bytes + 512).max(floor));
                assert!(budget.receive_bytes <= i32::MAX as usize);
                assert_eq!(budget.queued_kib, (2 * topic).div_ceil(1024));
                assert!(budget.queued_kib <= 2_097_151);
            }
        }
        assert!(ConsumerBudget::raw(usize::MAX).is_err());
        assert!(ConsumerBudget::normalized(MAX_BROKER_BYTES as usize + 1).is_err());
    }

    #[test]
    fn protocol_receive_overrides_are_independent_of_soft_fetch_targets() {
        let budget = ConsumerBudget::normalized(65_537).unwrap();
        assert_eq!(budget.receive_bytes, 6 * 1024 * 1024);
        assert_eq!(
            ConsumerBudget::raw(65_537).unwrap().receive_bytes,
            100_000_000
        );
        let explicit = budget.with_receive_limit(Some(12 * 1024 * 1024)).unwrap();
        assert_eq!(explicit.fetch_bytes, budget.fetch_bytes);
        assert_eq!(explicit.receive_bytes, 12 * 1024 * 1024);
        assert_eq!(
            budget
                .with_receive_limit(Some(66_049))
                .unwrap()
                .receive_bytes,
            66_049
        );
        assert!(budget.with_receive_limit(Some(66_048)).is_err());
        assert!(budget.with_receive_limit(Some(usize::MAX)).is_err());
    }
}
