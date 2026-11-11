pub(crate) fn same_incarnation(pid: i32, ticks: u64, current_pid: i32, current_ticks: u64) -> bool {
    pid > 0 && pid == current_pid && ticks == current_ticks
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn incarnation_requires_both_pid_and_start_ticks() {
        assert!(same_incarnation(42, 100, 42, 100));
        assert!(!same_incarnation(42, 100, 42, 101));
        assert!(!same_incarnation(42, 100, 43, 100));
        assert!(!same_incarnation(0, 100, 0, 100));
    }
}
