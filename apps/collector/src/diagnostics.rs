use procfs::ProcError;

#[derive(Clone, Copy, PartialEq, Eq)]
#[repr(i64)]
pub(crate) enum ReadStatus {
    Read = 0,
    Unsupported = 1,
    PermissionDenied = 2,
    Disappeared = 3,
    Failed = 4,
    OutOfRange = 5,
    Unavailable = 6,
}

impl ReadStatus {
    pub(crate) fn from_error(error: &ProcError) -> Self {
        match error {
            ProcError::PermissionDenied(_) => Self::PermissionDenied,
            ProcError::NotFound(_) => Self::Disappeared,
            ProcError::Incomplete(_) => Self::Unavailable,
            ProcError::Io(error, _) => match error.kind() {
                std::io::ErrorKind::PermissionDenied => Self::PermissionDenied,
                std::io::ErrorKind::NotFound => Self::Disappeared,
                std::io::ErrorKind::WouldBlock
                | std::io::ErrorKind::TimedOut
                | std::io::ErrorKind::Interrupted => Self::Unavailable,
                _ => Self::Failed,
            },
            _ => Self::Failed,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_failures_have_contract_codes() {
        assert_eq!(ReadStatus::Read as i64, 0);
        assert_eq!(ReadStatus::Unsupported as i64, 1);
        assert_eq!(
            ReadStatus::from_error(&ProcError::PermissionDenied(None)) as i64,
            2
        );
        assert_eq!(ReadStatus::from_error(&ProcError::NotFound(None)) as i64, 3);
        assert_eq!(
            ReadStatus::from_error(&ProcError::Io(
                std::io::Error::from(std::io::ErrorKind::InvalidData),
                None,
            )) as i64,
            4
        );
        assert_eq!(ReadStatus::OutOfRange as i64, 5);
        assert_eq!(
            ReadStatus::from_error(&ProcError::Incomplete(None)) as i64,
            6
        );
    }
}
