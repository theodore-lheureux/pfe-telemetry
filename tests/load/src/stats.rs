use serde::Serialize;

#[derive(Clone, Debug, Default, Serialize)]
pub struct Distribution {
    pub count: usize,
    pub min: f64,
    pub p50: f64,
    pub p95: f64,
    pub p99: f64,
    pub max: f64,
    pub mean: f64,
}

/// Nearest-rank percentiles of millisecond values.
pub fn distribution(values: &[f64]) -> Distribution {
    if values.is_empty() {
        return Distribution::default();
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    let rank =
        |q: f64| sorted[((q * sorted.len() as f64).ceil() as usize).clamp(1, sorted.len()) - 1];
    let round = |v: f64| (v * 1000.0).round() / 1000.0;
    Distribution {
        count: sorted.len(),
        min: round(sorted[0]),
        p50: round(rank(0.50)),
        p95: round(rank(0.95)),
        p99: round(rank(0.99)),
        max: round(sorted[sorted.len() - 1]),
        mean: round(sorted.iter().sum::<f64>() / sorted.len() as f64),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nearest_rank_percentiles() {
        let values: Vec<f64> = (1..=100).map(f64::from).collect();
        let d = distribution(&values);
        assert_eq!((d.p50, d.p95, d.p99, d.max), (50.0, 95.0, 99.0, 100.0));
        assert_eq!(distribution(&[]).count, 0);
    }
}
