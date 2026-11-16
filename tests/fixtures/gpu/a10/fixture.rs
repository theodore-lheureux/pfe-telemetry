// Test-only text replay. Native ABI tags, status and time are synthetic wrappers.
pub struct Sample {
    pub phase: &'static str,
    pub source_line: usize,
    pub fields: Vec<(u16, &'static str)>,
}

impl Sample {
    pub fn value(&self, id: u16) -> &'static str {
        self.fields
            .iter()
            .find(|(field, _)| *field == id)
            .unwrap()
            .1
    }
}

pub fn samples() -> Vec<Sample> {
    let mut lines = include_str!("dmon.txt")
        .lines()
        .filter(|line| !line.starts_with('#'));
    let header: Vec<u16> = lines
        .next()
        .unwrap()
        .split_whitespace()
        .skip(2)
        .map(|id| id.parse().unwrap())
        .collect();
    lines
        .map(|line| {
            let mut values = line.split_whitespace();
            let phase = values.next().unwrap();
            let source_line = values.next().unwrap().parse().unwrap();
            let values: Vec<_> = values.collect();
            assert_eq!(header.len(), values.len(), "Source line {source_line}");
            Sample {
                phase,
                source_line,
                fields: header.iter().copied().zip(values).collect(),
            }
        })
        .collect()
}

pub fn groups() -> Vec<(u16, u16, Vec<u16>)> {
    include_str!("profile-groups.txt")
        .lines()
        .filter(|line| !line.starts_with('#'))
        .map(|line| {
            let mut values = line.split_whitespace();
            let (major, minor) = values.next().unwrap().split_once('.').unwrap();
            let major = u16::from(major.as_bytes()[0] - b'A');
            (
                major,
                minor.parse().unwrap(),
                values.map(|id| id.parse().unwrap()).collect(),
            )
        })
        .collect()
}
