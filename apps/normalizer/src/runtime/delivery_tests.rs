use super::await_deliveries;
use futures_util::poll;
use std::{cell::Cell, pin::pin, task::Poll};
use tokio::sync::oneshot;

#[tokio::test]
async fn waits_for_every_report_even_after_a_partial_failure() {
    for outcome in [Ok(()), Err("delivery failed")] {
        // More records than the old chunk limit. Leave the first delivery
        // pending and check that later deliveries have already been polled.
        let (send, receive): (Vec<_>, Vec<_>) = (0..129).map(|_| oneshot::channel()).unzip();
        let last_polled = Cell::new(false);
        let mut batch = pin!(await_deliveries(receive.into_iter().enumerate().map(
            |(index, r)| {
                let last_polled = &last_polled;
                async move {
                    if index == 128 {
                        last_polled.set(true);
                    }
                    r.await.unwrap()
                }
            }
        )));
        assert_eq!(poll!(&mut batch), Poll::Pending);
        assert!(last_polled.get());
        let mut send = send.into_iter();
        let first = send.next().unwrap();
        let last = send.next_back().unwrap();
        last.send(outcome).unwrap();
        for pending in send {
            pending.send(Ok(())).unwrap();
        }
        assert_eq!(poll!(&mut batch), Poll::Pending);
        first.send(Ok(())).unwrap();
        assert_eq!(batch.await, outcome);
    }
}
