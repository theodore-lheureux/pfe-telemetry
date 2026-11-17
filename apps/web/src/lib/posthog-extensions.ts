// posthog-js downloads these extensions at runtime unless they are already
// bundled, and content blockers often block those downloads by file name, even
// through our proxy. Bundle the ones this app uses; surveys are not used.
import "posthog-js/dist/recorder";
import "posthog-js/dist/exception-autocapture";
import "posthog-js/dist/tracing-headers";
import "posthog-js/dist/web-vitals";
import "posthog-js/dist/dead-clicks-autocapture";
