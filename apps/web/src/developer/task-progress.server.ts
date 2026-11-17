// Only static playbook labels are public. Never copy task arguments, host names,
// failure details, or arbitrary task titles from the runner's output.
const publicSteps = new Set([
	"Validate operation, lab ID and administrator limits",
	"Show the selected lab ID",
	"Read CPU instances in the demo name namespace",
	"Read GPU instances in the demo name namespace",
	"Validate owned cloud inventory",
	"Verify release provenance without a GitHub login",
	"Plan a new lab",
	"Apply the saved create plan once",
	"Read public collector outputs",
	"Wait for the selected connection",
	"Install the collector binary",
	"Install DCGM with profiling",
	"Enroll without sampling",
	"Require the selected project before sampling",
	"Start the collector",
	"Drain with the original binary and identity",
	"Destroy only validated lab resources",
	"Require complete lab cleanup",
	"Start the job without enabling restart on boot",
	"Stop only this lab's synthetic worker",
	"Validate and reduce the distributed results",
]);

export function publicTaskProgress(line: string): string | undefined {
	const title =
		/^[ \t]*TASK \[([a-zA-Z0-9 '()-]{1,100})\][ \t]+\*{3,}[ \t\r]*$/.exec(
			line,
		)?.[1];
	if (title && publicSteps.has(title)) return `TASK [${title}]`;
}
