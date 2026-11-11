pub mod authority;
pub mod catalogue;
pub mod cli;
pub mod delivery;
pub mod linux_adapter;
pub mod metadata;
pub mod policy;
pub mod transport;
pub mod validate;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Category {
    Invalid,
    Unsupported,
    Forbidden,
    Limit,
    Expired,
    Poison,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Issue {
    pub category: Category,
    pub path: String,
    pub reason: &'static str,
}
impl Issue {
    pub fn new(category: Category, path: impl Into<String>, reason: &'static str) -> Self {
        Self {
            category,
            path: path.into(),
            reason,
        }
    }
}
impl std::fmt::Display for Issue {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}: {}: {}", self.category, self.path, self.reason)
    }
}
impl std::error::Error for Issue {}
