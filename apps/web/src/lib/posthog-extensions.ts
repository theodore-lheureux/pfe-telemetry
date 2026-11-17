// posthog-js downloads these extensions at runtime unless they are already
// bundled, and content blockers often block those downloads by file name, even
// through our proxy. Bundle the ones this app uses; surveys are not used.
// The full session recorder (initSessionRecording plus rrweb), which the SDK
// otherwise downloads as lazy-recorder.js; dist/recorder is only rrweb.
import "posthog-js/dist/posthog-recorder";
import "posthog-js/dist/exception-autocapture";
import "posthog-js/dist/tracing-headers";
import "posthog-js/dist/web-vitals";
import "posthog-js/dist/dead-clicks-autocapture";
